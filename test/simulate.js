// จำลองเกมเต็มรอบด้วย mock AI เพื่อตรวจ state machine, การซ่อนข้อมูล, ลูปชั่วโมง (สำรวจห้อง/ลงมือ/คราฟกับดัก/ภารกิจ/ให้ของ/ล็อกห้อง),
// การพบศพ → เก็บหลักฐาน → ตัดสิน (รวมโหวตผิด = จบเกม), ทางออกที่ซ่อนอยู่หลายแบบ และสรุปผล
// รัน: npm test
import { Game, PHASE, STEP, CONFIG, NONE_VOTE, DEAD_FATES, SURVIVED_FATES, hiddenUltimateCap, MURDER_CAUSES } from '../server/game.js';
import { createAI } from '../server/ai.js';
import { resolveExits, exitReadyFor, exitUsefulFor } from '../server/escape.js';
import { RECIPES, OBJECTIVE_HOURS, LOCKS, ATTACK, ROOMS, roomCountFor, woundOf, isConductive, tagsOf, attackBaseOf, parseAmmo, poisonNoticeChance, canBreachWith } from '../server/rules.js';
import { LOCATIONS, EXTRA_ROOMS, mockLocation, mockNarrateCase } from '../server/mock.js';

CONFIG.BOT_DELAY_SCALE = 0.02;
CONFIG.STEP_TIMEOUT_MS = 0;
// เกมจริงไม่มีเวลาจำกัด แต่การจำลองต้องจบ จึงตั้งเพดานชั่วโมงไว้
CONFIG.MAX_HOURS = 36;

const quietLog = { info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };

// ผังกุญแจ: 1–2 ดอกทั้งเกม ดอกละ 1–3 ห้อง ห้องหนึ่งมีกุญแจที่ไขได้ไม่เกินดอกเดียว บางห้องไม่มีกุญแจ · ตอนเริ่ม: ห้องที่ล็อกมีกุญแจเสมอ และกุญแจวางในห้องเปิดที่มันไม่ได้ไข
function assertKeyLayout(game, atStart) {
  const zones = [...game.zones.values()];
  const allItems = zones.flatMap((z) => z.items);
  const keys = allItems.filter((i) => i.kind === 'key' && i.unlocksZoneIds);
  assert(!allItems.some((i) => i.master), 'no master keys exist');
  const maxKeys = LOCKS.maxKeys(zones.length - 1);
  assert(keys.length >= 1 && keys.length <= maxKeys, `1–${maxKeys} room keys exist (${keys.length})`);
  for (const k of keys) assert(k.unlocksZoneIds.length >= LOCKS.ROOMS_PER_KEY[0] && k.unlocksZoneIds.length <= LOCKS.ROOMS_PER_KEY[1], `key opens ${LOCKS.ROOMS_PER_KEY.join('–')} rooms (${k.unlocksZoneIds.length})`);
  for (const z of zones) {
    const openers = keys.filter((k) => k.unlocksZoneIds.includes(z.id));
    assert(openers.length <= 1, `at most one key opens ${z.name}`);
    assert((z.keyItemId || null) === (openers[0]?.id || null), `keyItemId matches the key for ${z.name}`);
    if (!z.lockable) assert(openers.length === 0, 'the sleep zone has no key');
    if (atStart && z.locked) assert(openers.length === 1, `start-locked ${z.name} has a key`);
  }
  assert(zones.some((z) => z.lockable && !z.keyItemId), 'at least one room has no key at all');
  if (atStart) {
    for (const k of keys) {
      const spot = zones.find((z) => z.items.includes(k));
      assert(spot && !spot.locked && (!k.unlocksZoneIds.includes(spot.id) || spot.id === game.location.sleepZoneId), `${k.name} placed visible in an unlocked room it does not open`);
    }
  }
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERTION FAILED:', msg);
    process.exit(1);
  }
}

// strategy:
//  'explore'  = สำรวจ/หยิบของ ใครถืออาวุธและอยู่กับคนอื่นแค่คนเดียวจะลงมือ 50%
//  'peaceful' = ไม่มีใครลงมือ (ทดสอบภารกิจ/การบังคับ/ให้ของ/หมดเวลา)
//  'escape'   = ทุกคนรู้ตำแหน่งทางออก (omniscient) มุ่งหาของและเปิดทางออก
//  'trap'     = คราฟกับดักจากของในมือแล้ววาง / ผสมยาในอาหาร
//  'camp'     = ทุกคนไปห้องเดียวกันตลอด (ทดสอบว่าภารกิจบังคับแยกคนออกจากกัน)
//  'locks'    = หยิบกุญแจแล้วล็อกห้อง คนอื่นพยายามเข้าห้องที่ล็อก
// voteStrategy: 'smart' = โหวตถูกเสมอ (ถ้ารู้) | 'wrong' = โหวตผิดเสมอ | 'random' | 'split'
async function runGame({ humans, bots = 0, label, strategy = 'explore', voteStrategy = 'smart', config = {}, maxTicks = 8000 }) {
  const saved = { ...CONFIG };
  Object.assign(CONFIG, config);
  const ai = createAI({ forceMock: true, log: quietLog });
  const game = new Game({ code: 'TEST', ai, log: quietLog });
  const ids = [];
  for (let i = 0; i < humans; i++) {
    const id = `human-${i + 1}-xxxxxxxx`;
    ids.push(id);
    game.addPlayer({ id, name: `คน ${i + 1}` });
  }
  const host = ids[0];
  if (bots) game.setBots(host, bots);

  const stats = { itemsMoved: 0, kos: 0, hours: 0, days: 0, trials: 0, huntRounds: 0, kills: 0, trapKills: 0, runoffs: 0, leakChecks: 0, wrongVotes: 0, escapes: 0, actionsChecked: 0, defenses: 0, wrongTargets: 0, noneVotes: 0, forced: 0, gives: 0, requests: 0, objectivesDone: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0, exitAttempts: 0, doorWorks: 0, lockedIn: 0, breaks: 0 };
  let rolesChecked = false;
  let roleStats = { hidden: 0, fakes: 0 };
  let ticks = 0;
  let lastTurnSeen = 0;
  let lastAutoHours = 0;
  const objectiveSeen = new Map(); // playerId → { id, deadlineTurn } ของภารกิจล่าสุดที่เห็น

  const checkViews = () => {
    const N = game.players.size;
    for (const id of ids) {
      const v = game.viewFor(id);
      const me = game.players.get(id);
      assert(v.players.length === N, 'view has all players');
      const json = JSON.stringify(v);
      for (const p of v.players) {
        if (!p.character) continue;
        const realPlayer = game.players.get(p.id);
        const realChar = game.charOf(realPlayer);
        const isMe = p.id === id;
        const exposed = realChar.ultimateRevealed || game.phase === PHASE.ENDED;
        if (realChar.fakeRole && !exposed && !isMe) {
          assert(p.character.ultimate === realChar.fakeUltimate.title, `fake role must show decoy to others (${p.id} → ${id})`);
          assert(p.character.ultimate !== realChar.ultimate.title, 'fake role leaked real title');
          assert(p.character.fakeUltimate == null && !p.character.fakeRoleExposed && p.character.shownToOthers == null, 'fake role flag leaked to others');
          assert(p.character.trait === 'none', 'fake role shows no trait');
        } else if (realChar.fakeRole) {
          assert(p.character.ultimate === realChar.ultimate.title, 'fake role owner/exposed view shows real title');
          if (isMe && !exposed) assert(p.character.shownToOthers === realChar.fakeUltimate.title, 'owner is told what others see (decoy)');
        } else {
          const mayShow = !realChar.ultimate.hidden || exposed || (isMe && realPlayer.knowsUltimate);
          if (!mayShow) {
            assert(p.character.ultimate === '???', `hidden ultimate leaked for ${p.id} to ${id}`);
            assert(p.character.ultimateDescription == null && p.character.trait == null, 'hidden ultimate details leaked');
          } else assert(p.character.ultimate === realChar.ultimate.title, 'visible ultimate shown');
          if (isMe && realChar.ultimate.hidden && !exposed) assert(p.character.ultimate === realChar.ultimate.title && p.character.shownToOthers === '???', 'hidden-role owner sees real title + ??? marker');
          if (!isMe) assert(p.character.shownToOthers == null, 'shownToOthers only for self');
        }
        if (!isMe && me.alive && game.phase !== PHASE.ENDED) {
          const sameZone = realPlayer.alive && (game.step === STEP.ACT || game.step === STEP.REPORT) && game.sameSpot(realPlayer, me);
          if (!sameZone) assert(p.zoneId == null, `position of ${p.id} leaked to ${id}`);
          else assert(p.zoneId === realPlayer.zoneId, 'same-zone position visible');
        }
        if (!isMe && !realPlayer.alive && me.alive && game.phase !== PHASE.ENDED) {
          const body = game.bodies.get(p.id);
          const known = body?.announced || realPlayer.caseJudged || ['executed', 'punished', 'escaped', 'left_behind'].includes(realPlayer.fate) || me.knownBodies.has(p.id);
          if (!known) assert(p.alive === true && p.fate == null && !p.knownDead, `unknown death of ${p.id} leaked to ${id}`);
          else assert(p.knownDead, 'known death shown');
        }
      }
      if (me.alive && game.phase !== PHASE.ENDED && game.phase !== PHASE.TRIAL_RESULT) {
        assert(!json.includes('"killerId"') && !json.includes('"culpritId"'), `killer field leaked to ${id}`);
        assert(!json.includes('"designatedId"'), 'designatedId leaked');
        assert(!json.includes('exitZoneId') && !json.includes('"isExit"'), 'exit zone leaked via location view');
        for (const o of game.players.values()) {
          if (o.id === id) continue;
          const botVisible = o.isBot && CONFIG.BOT_REQUESTS && me.alive && (game.step === STEP.ACT || game.step === STEP.REPORT) && game.sameSpot(o, me);
          if (!botVisible) for (const it of o.inventory) assert(!json.includes(`"id":"${it.id}"`), `inventory item ${it.id} of ${o.id} leaked to ${id}`);
          for (const l of o.log) assert(!json.includes(`"${l.id}"`), `private log entry of ${o.id} leaked to ${id}`);
          for (const ob of o.objectives) assert(!json.includes(`"${ob.id}"`), `objective of ${o.id} leaked to ${id}`);
        }
        for (const z of game.zones.values()) for (const it of z.items) if (it.hidden) assert(!json.includes(`"${it.id}"`), `hidden item "${it.name}" leaked to ${id}`);
        // ทางออกที่ยังไม่รู้จัก ต้องไม่โผล่ใน view
        for (const x of game.exits.values()) {
          if (x.discoveredBy.has(id)) assert(v.me.exits.some((e) => e.id === x.id && e.zoneName === game.zoneName(x.zoneId)), 'known exit visible with zone');
          else assert(!v.me.exits.some((e) => e.id === x.id) && !json.includes(`"${x.id}"`), `unknown exit ${x.id} leaked to ${id}`);
        }
        // ภารกิจใหม่ต้องไม่มาก่อนครบชั่วโมงของภารกิจเดิม และระยะเวลาตรงตารางความยาก
        const active = me.objectives.find((o) => !o.done);
        const seen = objectiveSeen.get(id);
        if (active && seen && active.id !== seen.id) assert(active.assignedTurn >= seen.deadlineTurn, `objective assigned before previous deadline (${active.assignedTurn} < ${seen.deadlineTurn})`);
        if (active) {
          assert(active.hours === OBJECTIVE_HOURS[active.type], 'objective hours match difficulty table');
          objectiveSeen.set(id, { id: active.id, deadlineTurn: active.deadlineTurn });
        }
      }
      if (game.step === STEP.ACT && me.alive) {
        assert(Array.isArray(v.me.availableActions) && (me.ko ? v.me.availableActions.length === 0 : v.me.availableActions.some((a) => a.type === (me.outside ? 'rest' : 'search'))), 'alive player has actions (none while knocked out)');
        if (me.outside) assert(!v.me.availableActions.some((a) => ['search', 'take', 'drop', 'hide', 'eat', 'examine', 'moveBody', 'clean', 'exit', 'lock', 'unlock'].includes(a.type)), 'outside a locked door: no room actions');
        for (const a of v.me.availableActions) if (a.type === 'trap') assert(me.inventory.find((i) => i.id === a.itemId)?.kind === 'trap', 'only crafted traps can be placed');
        stats.actionsChecked++;
      }
      if (game.step === STEP.REPORT && me.alive) {
        for (const zp of v.me.zonePeople) assert(game.sameSpot(game.players.get(zp.id), me), 'zonePeople are really co-located');
      }
      if (game.phase === PHASE.TRIAL) {
        assert(v.announcedCases.length >= 1, 'trial has announced cases');
        for (const c of v.announcedCases) assert(c.bodyState && c.title, 'announced case has narrative');
        assert(v.lastResult === null, 'lastResult hidden during trial');
      }
      assert(v.hour === game.hour && v.day === game.day, 'view carries day/hour');
      stats.leakChecks++;
    }
  };

  const humansAlive = () => game.alivePlayers().filter((p) => !p.isBot);
  const campZone = () => [...game.zones.keys()][2];
  const canEnter = (p, id) => {
    const z = game.zones.get(id);
    return z && !game.doorBlocking(p, id); // รวมกรณีถูกขังอยู่ในห้องที่ล็อก
  };
  const exitFor = (p) => {
    // พร้อมเปิด (ถือของครบ + ทำขั้นที่เหลือได้เอง) ก่อน ไม่งั้นไปทำขั้นถาวรให้คืบหน้า
    for (const x of game.exits.values()) if (!x.open && exitReadyFor(game, p, x)) return x;
    for (const x of game.exits.values()) if (!x.open && exitUsefulFor(game, p, x)) return x;
    return null;
  };

  const decideMove = (p) => {
    const zones = [...game.zones.keys()];
    if (strategy === 'camp') return campZone();
    if (strategy === 'locks') {
      // คนที่มีกุญแจไปห้องของกุญแจนั้น คนอื่นพยายามเข้าห้องที่ล็อก (ทดสอบการชนประตู)
      const key = p.inventory.find((i) => i.kind === 'key' && i.unlocksZoneIds?.length);
      if (key && chance(0.7)) return pick(key.unlocksZoneIds);
      const locked = [...game.zones.values()].filter((z) => z.locked);
      if (locked.length && chance(0.5)) return pick(locked).id;
    }
    const obj = p.objectives.find((o) => !o.done);
    if (obj && chance(0.6)) {
      const zid = obj.type === 'visit2' ? obj.zoneIds.find((id) => !obj.visited.includes(id)) : obj.zoneId;
      if (zid && canEnter(p, zid)) return zid;
    }
    if (strategy === 'escape') {
      // omniscient: รู้ว่าของสำหรับทางออกอยู่ห้องไหน และทางออกอยู่ไหน
      const fuse = p.inventory.find((i) => i.role === 'fuse');
      if (fuse) {
        const pz = [...game.zones.values()].filter((z) => z.items.some((i) => i.kind === 'power') && canEnter(p, z.id));
        if (pz.length) return pick(pz).id;
      }
      const x = exitFor(p);
      if (x && canEnter(p, x.zoneId)) return x.zoneId;
      const wanted = [...game.zones.values()].filter((z) => canEnter(p, z.id) && z.items.some((i) => (i.isPart || i.kind === 'clue') && !game.exits.get(i.exitId || i.revealsExitId)?.open));
      if (wanted.length && p.inventory.length < CONFIG.INVENTORY_MAX) return pick(wanted).id;
      const keys = [...game.zones.values()].filter((z) => canEnter(p, z.id) && z.items.some((i) => i.kind === 'key' && !i.hidden));
      if (keys.length && chance(0.5)) return pick(keys).id;
    }
    if (game.phase === PHASE.INVESTIGATION) {
      const bz = [...game.bodies.values()].filter((b) => b.announced && !b.judged).map((b) => b.zoneId);
      if (bz.length && chance(0.5)) return pick(bz);
    }
    const open = zones.filter((id) => canEnter(p, id));
    return pick(chance(0.8) ? open : zones);
  };

  const decideAction = (p) => {
    const avail = game.availableActions(p).filter((a) => !a.disabled);
    const byType = (t) => avail.filter((a) => a.type === t);
    const z = game.zones.get(p.zoneId);
    const itemActs = game.itemActions(p).filter((a) => !a.disabled); // หยิบ/วาง/ซ่อนทำได้ทันที (ไม่กินชั่วโมง)
    const take = itemActs.filter((a) => a.type === 'take');
    const obj = p.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take' && take.some((a) => a.itemId === o.itemId));
    if (t && chance(0.7)) return take.find((a) => a.itemId === t.itemId);
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === p.zoneId && p.inventory.some((i) => i.id === o.itemId));
    const plantAct = pl ? itemActs.filter((a) => a.type === 'hide').find((a) => a.itemId === pl.itemId) : null; // ไม่มีให้ซ่อนตอนยืนรอหน้าประตู
    if (plantAct && chance(0.7)) return plantAct;
    const eatObj = obj.find((o) => o.type === 'visit_eat' && o.zoneId === p.zoneId);
    if (eatObj && byType('eat').length && chance(0.8)) return byType('eat')[0];
    if (strategy === 'escape') {
      if (byType('exit_power').length) return byType('exit_power')[0];
      const asm = byType('craft').find((a) => a.recipeId === 'assembly');
      if (asm) return asm;
      const x = exitFor(p);
      const ex = byType('exit').find((a) => a.exitId === x?.id);
      if (ex) return ex;
      const routeTake = take.find((a) => {
        const it = z.items.find((i) => i.id === a.itemId);
        return it && (it.isPart || it.kind === 'clue' || it.kind === 'key');
      });
      if (routeTake) return routeTake;
      // ของที่ทางออกต้องใช้: เครื่องมือช่าง (ถอดน็อต) ของมีคม (ตัด) ของหนัก/อาวุธมีคม (ลงแรง)
      const roles = (it) => (!it ? [] : [tagsOf(it).has('fastener') && 'tool', tagsOf(it).has('sharp') && 'cut', canBreachWith(it) && 'force'].filter(Boolean));
      const haveRoles = new Set(p.inventory.flatMap(roles));
      const toolTake = take.find((a) => roles(z.items.find((i) => i.id === a.itemId)).some((r) => !haveRoles.has(r)));
      if (toolTake && p.inventory.length < CONFIG.INVENTORY_MAX) return toolTake;
      if (p.inventory.length >= CONFIG.INVENTORY_MAX && itemActs.filter((a) => a.type === 'drop').length) {
        const junk = itemActs.filter((a) => a.type === 'drop').find((a) => { const it = p.inventory.find((i) => i.id === a.itemId); return it && !it.isPart && !roles(it).length; });
        if (junk) return junk;
      }
      return (byType('search')[0] || byType('rest')[0]);
    }
    if (strategy === 'locks') {
      if (byType('lock').length && chance(0.7)) return byType('lock')[0];
      const keyTake = take.find((a) => z.items.find((i) => i.id === a.itemId)?.kind === 'key');
      if (keyTake) return keyTake;
    }
    if (game.phase === PHASE.INVESTIGATION) {
      const ex = byType('examine');
      if (ex.length && chance(0.5)) return pick(ex);
      if (byType('clean').length && p.kills > 0) return byType('clean')[0];
      const mb = byType('moveBody');
      if (mb.length && p.kills > 0 && chance(0.3)) return { ...mb[0], toZoneId: pick([...game.zones.keys()].filter((id) => id !== p.zoneId)) };
      return (byType('search')[0] || byType('rest')[0]);
    }
    if (strategy === 'trap') {
      const place = byType('trap');
      if (place.length && chance(0.8)) return place[0];
      const craft = byType('craft');
      if (craft.length && chance(0.8)) return pick(craft);
      const poison = byType('poisonFood');
      if (poison.length && chance(0.6)) return poison[0];
      const ingredientTake = take.find((a) => ['weapon', 'rope', 'tool', 'poison'].includes(z.items.find((i) => i.id === a.itemId)?.kind));
      if (ingredientTake) return ingredientTake;
      // full hands with no craftable pair (objectives may have forced keys/junk on us): drop junk or duplicates to make room for the missing ingredient
      if (p.inventory.length >= CONFIG.INVENTORY_MAX && !p.inventory.some((i) => i.kind === 'trap')) {
        const kinds = p.inventory.map((i) => i.kind);
        const canCraft = kinds.includes('rope') && (kinds.includes('weapon') || kinds.includes('tool'));
        const junk = itemActs.filter((a) => a.type === 'drop').find((a) => {
          const k = p.inventory.find((i) => i.id === a.itemId)?.kind;
          return !['weapon', 'rope', 'tool'].includes(k) || kinds.filter((x) => x === k).length > 1;
        });
        if (!canCraft && junk) return junk;
      }
      if (byType('eat').length && chance(0.3)) return byType('eat')[0];
    }
    if (strategy === 'explore' || strategy === 'trap') {
      const attacks = byType('attack');
      if (attacks.length && game.bestWeapon(p) && chance(attacks.length === 1 ? 0.5 : 0.2)) return pick(attacks);
      const weaponTake = take.find((a) => z.items.find((i) => i.id === a.itemId)?.kind === 'weapon');
      if (weaponTake && chance(0.5)) return weaponTake;
    }
    if (strategy === 'camp' || strategy === 'peaceful') {
      if (take.length && p.inventory.length < CONFIG.INVENTORY_MAX && chance(0.5)) return pick(take);
    }
    const mb = byType('moveBody');
    if (mb.length && chance(0.2)) return { ...mb[0], toZoneId: pick([...game.zones.keys()].filter((id) => id !== p.zoneId)) };
    const ex = byType('examine');
    if (ex.length && chance(0.4)) return pick(ex);
    const special = [...byType('steal'), ...byType('interrogate'), ...byType('sabotage')];
    if (special.length && chance(0.3)) return pick(special);
    if (byType('clean').length && chance(0.2)) return byType('clean')[0];
    if (byType('eat').length && chance(0.15)) return byType('eat')[0];
    const stash = [...itemActs.filter((a) => a.type === 'hide'), ...itemActs.filter((a) => a.type === 'drop')];
    if (stash.length && chance(0.1)) return pick(stash);
    if (chance(0.75)) return (byType('search')[0] || byType('rest')[0]);
    return byType('rest')[0];
  };

  // ช่วงพัก: ให้ของกับคนในห้องเดียวกัน (ถ้ามี) เพื่อทดสอบระบบให้ของ
  const tryGive = (p) => {
    const mates = game.presentWith(p).filter((o) => o.id !== p.id && o.inventory.length < CONFIG.INVENTORY_MAX);
    if (!mates.length || !p.inventory.length || !chance(strategy === 'camp' || strategy === 'peaceful' ? 0.6 : 0.2)) return;
    const target = pick(mates);
    const it = pick(p.inventory);
    const before = target.inventory.length;
    game.giveItem(p.id, target.id, it.id);
    assert(target.inventory.length === before + 1 && target.inventory.includes(it) && !p.inventory.includes(it), 'give transfers item');
    stats.gives++;
  };

  // ช่วงพัก: ขอของจากบอทที่อยู่ห้องเดียวกัน (บอทให้เสมอ)
  const tryRequest = (p) => {
    const bots = game.presentWith(p).filter((o) => o.isBot && o.inventory.length);
    if (!bots.length || p.inventory.length >= CONFIG.INVENTORY_MAX) return;
    const v = game.viewFor(p.id);
    const bot = pick(bots);
    const shown = v.me.zonePeople.find((zp) => zp.id === bot.id);
    const it = pick(bot.inventory);
    if (!CONFIG.BOT_REQUESTS) {
      assert(shown?.isBot && shown.items === undefined, 'bot inventory hidden when requests are disabled');
      let blocked = false;
      try { game.requestItem(p.id, bot.id, it.id); } catch { blocked = true; }
      assert(blocked && bot.inventory.includes(it), 'requests rejected when disabled');
      return;
    }
    assert(shown?.isBot && Array.isArray(shown.items) && shown.items.length === bot.inventory.length, 'co-located bot inventory is visible for requests');
    game.requestItem(p.id, bot.id, it.id);
    assert(p.inventory.includes(it) && !bot.inventory.includes(it), 'request transfers the item from the bot');
    let threw = false;
    const human = game.alivePlayers().find((o) => !o.isBot && o.id !== p.id && game.sameSpot(o, p) && o.inventory.length);
    if (human) {
      try { game.requestItem(p.id, human.id, human.inventory[0].id); } catch { threw = true; }
      assert(threw, 'cannot request items from humans');
    }
    stats.requests++;
  };

  const decideVote = (p) => {
    const cands = game.voteCandidates(p.id);
    assert(cands.length > 0, 'voter has candidates');
    const murders = game.openCases().filter((c) => c.killerId && game.players.get(c.killerId)?.alive);
    if (voteStrategy === 'split' && !game.runoff) {
      const voters = game.alivePlayers();
      const idx = voters.findIndex((v) => v.id === p.id);
      const target = voters[(idx + 1) % voters.length].id;
      return cands.includes(target) ? target : cands[0];
    }
    if (voteStrategy === 'split') return cands[0];
    if (voteStrategy === 'wrong') {
      const innocents = cands.filter((id) => id !== NONE_VOTE && !murders.some((c) => c.killerId === id));
      if (murders.length === 0) return innocents[0] || cands.find((id) => id !== NONE_VOTE) || cands[0];
      return innocents[0] || (cands.includes(NONE_VOTE) ? NONE_VOTE : cands[0]);
    }
    if (voteStrategy === 'smart') {
      if (!murders.length) return cands.includes(NONE_VOTE) ? NONE_VOTE : cands[0];
      const k = murders.find((c) => cands.includes(c.killerId));
      return k ? k.killerId : cands[0];
    }
    return pick(cands);
  };

  // ก่อนเลือกแอ็กชัน: ถ้ามีศพซ่อนอยู่ คนที่ไม่ใช่คนร้ายต้องลงมือไม่ได้ (ระบบปฏิเสธ)
  const checkMurderLock = (p) => {
    if (!CONFIG.MURDER_LOCK) return;
    const open = game.cases.filter((c) => MURDER_CAUSES.includes(c.cause) && !c.announced && !c.judged);
    if (!open.length || open.every((c) => c.killerId === p.id)) return;
    const attack = game.availableActions(p).find((a) => a.type === 'attack' && !a.disabled);
    if (!attack) return;
    let threw = false;
    try {
      game.chooseAction(p.id, attack);
    } catch (e) {
      threw = /ฆาตกรรม/.test(e.message);
    }
    assert(threw, 'non-culprit attack is blocked while a body is undiscovered');
    assert(!game.actions.has(p.id), 'blocked action is not recorded');
    stats.lockBlocks++;
  };

  await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error(`${label}: watchdog timeout in phase ${game.phase}/${game.step} day ${game.day} hour ${game.hour}`)), 60_000);
    let acting = false;
    let pending = false;
    game.onChange = () => {
      pending = true;
      if (acting) return;
      acting = true;
      setImmediate(async function tick() {
        pending = false;
        ticks++;
        if (ticks > maxTicks) {
          clearTimeout(watchdog);
          reject(new Error(`${label}: too many ticks (stuck in ${game.phase}/${game.step})`));
          return;
        }
        try {
          checkViews();
          if (game.turn !== lastTurnSeen) {
            // ชั่วโมงเดินเองได้ทีละหลายชั่วโมงเฉพาะตอนทุกคนที่ยังอยู่สลบหมด (ระบบประกาศทุกครั้ง)
            const autoHours = game.chat.filter((m) => m.system && /ทุกคนที่ยังอยู่สลบหมด/.test(m.text)).length;
            assert(game.turn === lastTurnSeen + 1 + (autoHours - lastAutoHours) || lastTurnSeen === 0, `turn advances by one (${lastTurnSeen} → ${game.turn}, auto-advanced ${autoHours - lastAutoHours})`);
            lastAutoHours = autoHours;
            lastTurnSeen = game.turn;
            stats.hours = game.turn;
            stats.days = game.day;
          }
          switch (game.phase) {
            case PHASE.DAY:
            case PHASE.INVESTIGATION: {
              if (game.phase === PHASE.INVESTIGATION) assert([...game.bodies.values()].every((b) => b.announced || b.turn === game.turn), 'all bodies are announced together once one is found (a trap death this very hour joins the next trial)');
              if (!rolesChecked && game.characters.length) {
                rolesChecked = true;
                const n = game.characters.length;
                const hidden = game.characters.filter((c) => c.ultimate.hidden);
                const fakes = game.characters.filter((c) => c.fakeRole);
                assert(hidden.length >= 1 && hidden.length <= hiddenUltimateCap(n), `hidden ultimates ${hidden.length} within cap`);
                assert(fakes.length === Math.min(CONFIG.FAKE_ROLES, n - 1), `exactly ${CONFIG.FAKE_ROLES} fake role(s)`);
                for (const c of game.characters) assert(game.playerOfChar(c.id).knowsUltimate, 'every owner knows their real ultimate');
                roleStats = { hidden: hidden.length, fakes: fakes.length };
                assert(game.exits.size === 2, 'two hidden exits per game');
                const routes = new Set([...game.exits.values()].map((x) => x.route));
                assert(routes.size === 2, 'exits use different routes');
                for (const x of game.exits.values()) {
                  assert(x.zoneId !== game.location.sleepZoneId && x.discoveredBy.size === 0, 'exit hidden in an explore zone, unknown at start');
                  for (const it of x.items) {
                    const z = [...game.zones.values()].find((zz) => zz.items.some((i) => i.id === it.id));
                    assert(z && z.id !== x.zoneId && z.items.find((i) => i.id === it.id).hidden, `route item ${it.name} hidden in another zone`);
                  }
                  assert(x.clueItemId && [...game.zones.values()].some((zz) => zz.items.some((i) => i.id === x.clueItemId && i.hidden)), 'clue item hidden');
                }
                const locked = [...game.zones.values()].filter((z) => z.locked);
                const expectLocked = CONFIG.LOCKED_ZONES >= 0 ? CONFIG.LOCKED_ZONES : LOCKS.lockedZones(game.zones.size - 1);
                assert(game.zones.size === roomCountFor(game.players.size), `rooms = players × 2 (${game.zones.size} rooms for ${game.players.size} players)`);
                assert(locked.length === Math.min(expectLocked, game.zones.size - 3), `locked zones at start (${locked.length})`);
                for (const z of locked) {
                  const keyZone = [...game.zones.values()].find((zz) => zz.items.some((i) => i.id === z.keyItemId));
                  assert(keyZone && !keyZone.locked && keyZone.id !== z.id, `key for ${z.name} placed in an unlocked other zone`);
                }
                const allItems = [...game.zones.values()].flatMap((z) => z.items);
                assertKeyLayout(game, true);
                assert(allItems.some((i) => i.kind === 'lockpick'), 'a lockpick exists somewhere');
                assert([...game.zones.values()].some((z) => z.items.some((i) => i.kind === 'food')), 'location has food');
                assert(game.day === 1 && game.hour === 1 && game.turn === 1, 'game starts at day 1 hour 1');
              }
              if (!game.step) break;
              if (game.step === STEP.MOVE) {
                const pendingMove = humansAlive().filter((p) => !game.moves.has(p.id));
                if (pendingMove.length) {
                  try { game.sendChat(pendingMove[0].id, `${game.timeLabel()} ไปไหนกันดี`); } catch {}
                  for (const p of pendingMove) {
                    assert(!p.ko, 'knocked-out players are pre-moved by the engine');
                    let target = decideMove(p);
                    const block = game.doorBlocking(p, target);
                    const means = block ? game.doorMeans(p) : null;
                    p.__expectBounce = block && !means ? { from: p.zoneId, target: block.zone.id, side: block.side } : null;
                    p.__expectWork = block && means ? { zoneId: block.zone.id } : null;
                    try {
                      game.chooseMove(p.id, target);
                    } catch (e) {
                      if (!/ถูกล็อกอยู่ใน/.test(e.message)) throw e;
                      assert(block && block.side === 'inside' && !means, 'move rejected only for a known lock-in without a way out');
                      stats.lockedIn++;
                      target = p.zoneId;
                      p.__expectBounce = null;
                      p.__expectWork = null;
                      game.chooseMove(p.id, target);
                    }
                  }
                }
              } else if (game.step === STEP.ACT) {
                for (const p of humansAlive()) {
                  if (game.step !== STEP.ACT) break; // ชั่วโมงจบไปแล้วตอนคนก่อนหน้าเลือก (คนสลบมีแอ็กชันอัตโนมัติ)
                  if (p.__expectBounce) {
                    const door = game.zones.get(p.__expectBounce.target);
                    const eb = p.__expectBounce;
                    if (eb.side === 'inside') assert((p.zoneId === eb.from && !p.outside) || !door.locked, 'a locked-in player without means stays inside unless someone unlocked the door this hour');
                    else if (p.zoneId === eb.target && p.outside) {
                      assert(p.zoneMemory[eb.target]?.locked === true, 'a player without a key waits outside the locked door and remembers the lock'); // ประตูอาจถูกเปิดโดยคนที่ประมวลผลทีหลังในชั่วโมงเดียวกัน
                      stats.bounces++;
                    } else assert(!door.locked && p.zoneId === eb.target, 'a player passes an expected locked door only when someone else opened it in the same hour');
                    p.__expectBounce = null;
                  }
                  if (p.__expectWork) {
                    const cur = game.actions.get(p.id);
                    const door = game.zones.get(p.__expectWork.zoneId);
                    if (cur?.type === 'doorwork') {
                      assert(cur.busy, 'door work is marked busy');
                      stats.doorWorks++;
                    } else assert(!door.locked, 'no door work only when someone else opened the door first');
                    p.__expectWork = null;
                  }
                  const cur = game.actions.get(p.id);
                  if (cur?.ko) {
                    let threw = false;
                    try { game.chooseAction(p.id, { type: 'search' }); } catch { threw = true; }
                    assert(threw && p.ko, 'a knocked-out player cannot act');
                    continue;
                  }
                  if (cur) continue;
                  checkMurderLock(p);
                  if (game.actions.has(p.id)) continue;
                  // หยิบ/วาง/ซ่อนของทำได้ทันที ไม่กินชั่วโมง — ทำก่อน แล้วค่อยเลือกแอ็กชันหลัก
                  let a = decideAction(p);
                  for (let k = 0; k < 3 && a && ['take', 'hide', 'drop'].includes(a.type); k++) {
                    const before = p.inventory.length;
                    game.instantItemAction(p.id, a);
                    assert(game.step === STEP.ACT && !game.actions.has(p.id), 'instant item actions do not spend the hour');
                    assert(p.inventory.length === before + (a.type === 'take' ? 1 : -1), 'instant item action moves the item');
                    stats.itemsMoved++;
                    a = decideAction(p);
                  }
                  if (a && ['take', 'hide', 'drop'].includes(a.type)) a = game.availableActions(p).find((x) => x.type === 'search') || game.availableActions(p).find((x) => x.type === 'rest');
                  assert(a, `action chosen for ${p.id}`);
                  try {
                    game.chooseAction(p.id, a);
                  } catch (e) {
                    if (!/ฆาตกรรม/.test(e.message)) throw e;
                    stats.lockBlocks++;
                    a = game.availableActions(p).find((x) => x.type === 'search');
                    game.chooseAction(p.id, a);
                  }
                }
              } else if (game.step === STEP.REPORT) {
                // คนสลบนับว่าพร้อมแล้ว: ชั่วโมงใหม่อาจเริ่มทันทีที่คนสุดท้ายที่ไม่สลบกดพร้อม จึงต้องหยุดลูปเมื่อขั้นเปลี่ยน
                for (const p of humansAlive().filter((x) => !game.ready.has(x.id) && !x.ko)) {
                  if (game.step !== STEP.REPORT) break;
                  const v = game.viewFor(p.id);
                  // ตอนพักชั่วโมงก็หยิบของได้ทันที
                  const restTake = game.itemActions(p).find((x) => x.type === 'take' && !x.disabled);
                  if (restTake && chance(0.3)) {
                    const before = p.inventory.length;
                    game.instantItemAction(p.id, restTake);
                    assert(p.inventory.length === before + 1 && game.step === STEP.REPORT, 'taking during the rest step is instant');
                    stats.itemsMoved++;
                  }
                  assert(v.me.log.some((l) => l.day === game.day && l.hour === game.hour && l.kind === 'move'), `player has a move log entry for this hour (hour=${game.hour} turn=${game.turn} phase=${game.phase} step=${game.step} moved=${game.moves.has(p.id)} acted=${JSON.stringify(game.actions.get(p.id))} ko=${JSON.stringify(p.ko)} alive=${p.alive} zone=${p.zoneId} out=${p.outside} last=${JSON.stringify(v.me.log.slice(-4).map((l) => [l.day, l.hour, l.kind, l.text.slice(0, 50)]))})`);
                  tryGive(p);
                  tryRequest(p);
                  game.markReady(p.id);
                }
              }
              break;
            }
            case PHASE.TRIAL: {
              assert([...game.bodies.values()].every((b) => b.announced), 'every body is part of the trial');
              if (game.runoff && game.runoff.number > stats.runoffs) stats.runoffs = game.runoff.number;
              const pendingVote = humansAlive().filter((p) => !game.confirmedVotes.has(p.id) && !p.ko); // คนสลบโหวตไม่ได้
              for (const p of pendingVote) {
                const t = decideVote(p);
                game.castVote(p.id, t);
                game.confirmVote(p.id);
              }
              break;
            }
            case PHASE.TRIAL_RESULT: {
              const r = game.lastResult;
              assert(r && Array.isArray(r.cases) && r.cases.length >= 1, 'result has judged cases');
              assert(Array.isArray(r.timeline) && r.timeline.length >= 1 && r.timeline.every((t) => t.positions.length && t.positions.every((x) => x.zoneName) && t.hour >= 1), 'result has timeline positions with hours');
              for (const c of r.cases) assert(c.victimName && c.zoneName && c.causeLabel && (c.killerName || !game.caseOf(c.id).killerId) && c.hour >= 1, 'case reveal complete');
              for (const c of r.cases) if (game.caseOf(c.id).killerId) assert(!game.players.get(game.caseOf(c.id).killerId).alive, 'a revealed case never has a living culprit');
              const stillOpenCases = game.openCases();
              if (r.moreKillers) {
                assert(r.correct && stillOpenCases.length >= 1 && stillOpenCases.every((c) => c.killerId && game.players.get(c.killerId).alive), 'open cases after a correct vote all have a living culprit');
                assert(r.stillOpen.length === stillOpenCases.length, 'result lists the still-open cases by victim');
                for (const c of stillOpenCases) assert(!r.cases.some((x) => x.killerPlayer === game.players.get(c.killerId).name), 'result does not name a still-living culprit');
                const verdict = game.chat.at(-1).text;
                assert(/ยังมีฆาตกรอีก 1 คน/.test(verdict) && stillOpenCases.every((c) => !verdict.includes(game.nick(game.players.get(c.killerId)))), 'verdict says one more killer remains, never how many or who');
                assert(game.history.at(-1).moreKillers === true, 'history marks the hunt as unfinished');
              } else {
                assert(!r.stillOpen?.length && stillOpenCases.length === 0 && game.cases.filter((c) => c.announced).every((c) => c.judged), 'every announced case is closed by the final verdict of the day');
              }
              if (r.votedId === NONE_VOTE) stats.noneVotes++;
              if (r.correct && r.executedId) assert(game.players.get(r.executedId).fate === 'executed', 'executed fate');
              const rv = game.viewFor(ids[0]);
              assert(rv.lastResult?.cases?.length === r.cases.length, 'result visible after trial');
              const dayBefore = game.day;
              const invBefore = new Map(game.alivePlayers().map((p) => [p.id, p.inventory.map((i) => i.id).join(',')]));
              const autoAll = () => game.chat.filter((m) => m.system && /ทุกคนที่ยังอยู่สลบหมด/.test(m.text)).length;
              const autoBefore = autoAll();
              await game.nextRound(host);
              // a revived player starts objectives over, so the pacing check must forget their old deadline
              for (const p of game.players.values()) if (p.revived && p.revivedDay === game.day) objectiveSeen.delete(p.id);
              if (game.phase !== PHASE.ENDED) {
                if (r.moreKillers) {
                  stats.huntRounds++;
                  assert(game.phase === PHASE.INVESTIGATION && game.step === STEP.MOVE && game.day === dayBefore && game.huntRound >= 2, 'hunt continues in the same day with another evidence hour');
                  assert([...game.bodies.values()].every((b) => !b.judged && !game.caseOf(b.caseId).judged) && game.bodies.size === stillOpenCases.length, 'bodies of closed cases are collected, open-case bodies stay');
                  for (const z of game.zones.values()) for (const e of z.evidence) assert(!e.caseId || !game.caseOf(e.caseId)?.judged, 'evidence of closed cases is wiped');
                } else {
                  // ถ้าทุกคนที่ยังอยู่ถูกลงโทษจนสลบพร้อมกันตอนเริ่มวัน เวลาจะเดินเองต่อจากชั่วโมง 1
                  assert(game.day === dayBefore + 1 && (game.hour === 1 || autoAll() > autoBefore), `trial ends the day; new day starts at hour 1 (hour ${game.hour})`);
                  assert(game.bodies.size === 0, 'no bodies remain after the final verdict (all cases of the day closed)');
                  for (const z of game.zones.values()) for (const e of z.evidence) assert(!e.caseId || !game.caseOf(e.caseId)?.judged, 'evidence of judged cases is wiped');
                  // ทุกคนตื่นที่ห้องนอนรวม — เว้นชั่วโมงแรกที่ทุกคนถูกภารกิจบังคับพาไปพร้อมกัน (เอนจินประมวลผลการย้ายทันที)
                  if (game.step === STEP.MOVE) for (const p of game.alivePlayers()) if (!game.moves.has(p.id)) assert(p.zoneId === game.location.sleepZoneId && !p.outside, 'everyone restarts the day in the sleep zone');
                }
                // คนที่เพิ่งถูกลงโทษเรื่องภารกิจตอนเริ่มวัน (สลบ) ทำของหล่นได้
                // คนที่ถูกลงโทษเรื่องภารกิจตอนเริ่มวัน (สลบ ของหล่น) — รวมคนที่สลบแล้วฟื้นในชั่วโมงที่เวลาเดินเองเพราะทุกคนสลบ
                const koToday = (p) => p.ko || p.log.some((l) => l.day === game.day && /หมดสติ|ฟื้นขึ้นมา/.test(l.text));
                for (const p of game.alivePlayers()) if (invBefore.has(p.id) && !koToday(p)) assert(p.inventory.map((i) => i.id).join(',') === invBefore.get(p.id), 'survivors keep their items');
                for (const p of game.players.values()) if (!p.alive) assert(p.inventory.length === 0, 'dead players hold nothing (dropped where they died)');
              }
              break;
            }
            case PHASE.ENDED: {
              clearTimeout(watchdog);
              resolve();
              return;
            }
            default:
              break;
          }
        } catch (err) {
          clearTimeout(watchdog);
          acting = false;
          reject(err);
          return;
        }
        if (pending) setImmediate(tick);
        else acting = false;
      });
    };
    game.start(host).catch(reject);
  });

  for (const c of game.cases) {
    stats.kills++;
    if (c.cause === 'trap') {
      stats.trapKills++;
      assert(c.trapType && ['blade', 'fall', 'shock', 'poison', 'door'].includes(c.trapType), `trap case has a trap type (${c.trapType})`);
    }
    if (c.cause === 'defense') stats.defenses++;
    if (c.cause === 'wrongTarget') stats.wrongTargets++;
  }
  stats.trials = game.history.length;
  stats.wrongVotes = game.history.filter((h) => !h.correct).length;
  stats.exitsFound = [...game.exits.values()].filter((x) => x.discoveredBy.size > 0).length;
  if (game.endReason === 'escape') stats.escapes++;
  for (const p of game.players.values()) {
    stats.forced += p.log.filter((l) => l.text.startsWith('⏰')).length; // ตอนนี้ = ถูกลงโทษเพราะละเลยภารกิจ (สลบ)
    stats.kos += p.log.filter((l) => l.text.startsWith('😵') && !/ยังสลบอยู่|สลบไปก่อน/.test(l.text)).length;
    stats.objectivesDone += p.log.filter((l) => l.text.startsWith('✅')).length;
    stats.crafts += p.log.filter((l) => l.text.startsWith('🛠')).length;
    stats.trapsPlaced += p.log.filter((l) => l.text.startsWith('🪤 คุณตั้ง') || l.text.startsWith('🪤 คุณติดตั้ง')).length; // รวมกับดักประตู
    stats.poisonings += p.log.filter((l) => l.text.startsWith('☠ คุณผสม')).length;
    stats.locks += p.log.filter((l) => l.text.startsWith('🔒 คุณล็อก')).length;
    stats.breaks += p.log.filter((l) => l.text.startsWith('💥 คุณพังประตู')).length;
    stats.exitAttempts += p.log.filter((l) => l.text.startsWith('🚪 พยายามเปิด')).length;
  }
  for (const z of game.zones.values()) for (const t of z.traps) assert(t.item.kind === 'trap' && RECIPES.some((r) => r.trapType === t.item.trapType), 'placed traps are crafted traps');

  const all = [...game.players.values()];
  const o = game.outcome;
  assert(o && o.survived.length + o.died.length === all.length, 'every player appears in outcome exactly once');
  for (const r of o.survived) assert(SURVIVED_FATES.includes(r.fate), `survived fate valid (${r.fate})`);
  for (const r of o.died) assert(DEAD_FATES.includes(r.fate), `died fate valid (${r.fate})`);
  assert(Array.isArray(o.exits) && o.exits.length === 2, 'outcome lists exits');
  assert(all.every((p) => p.fate !== 'perished' && p.deathCause !== 'objective'), 'nobody dies from objectives');
  if (game.endReason === 'wrong_vote') {
    assert(all.every((p) => !p.alive), 'wrong vote kills everyone');
    // only culprits of cases that reached a trial escape; a killer whose body was never found is punished with everyone else
    for (const c of game.cases.filter((x) => x.killerId && x.announced)) {
      const k = game.players.get(c.killerId);
      assert(['escaped', 'executed', 'victim'].includes(k.fate) || k.revived, `killer fate after wrong vote (${k.fate})`);
    }
  }
  if (game.endReason === 'last_one') assert(all.filter((p) => p.alive).length <= 1, 'last_one leaves ≤1 alive');
  if (game.endReason === 'escape') {
    const uncaught = (p) => game.cases.some((c) => c.killerId === p.id && !c.judged);
    const survivors = all.filter((p) => p.fate === 'survivor');
    const left = all.filter((p) => p.fate === 'left_behind');
    assert([...game.exits.values()].some((x) => x.open) && survivors.length + left.length >= 1, 'escape ends with an open exit and someone who reached it');
    assert(survivors.every((p) => !uncaught(p)) && left.every((p) => uncaught(p) && p.deathCause === 'left_behind'), 'uncaught killers never escape: they are left behind; survivors are not uncaught killers');
    if (left.length) stats.leftBehind = left.length;
  }
  for (const b of game.bodies.values()) assert(!game.players.get(b.victimId).alive, 'body belongs to a dead player');

  Object.assign(CONFIG, saved);
  console.log(
    `✔ ${label}: ${all.length} players · end=${game.endReason} (day ${stats.days}, ${stats.hours} h) · ${stats.trials} trial(s) (${stats.huntRounds} hunt rounds, ${stats.wrongVotes} wrong, ${stats.noneVotes} none, ${stats.runoffs} runoff) · kills ${stats.kills} (trap ${stats.trapKills}, defense ${stats.defenses}, wrong-target ${stats.wrongTargets}) · crafts ${stats.crafts} traps ${stats.trapsPlaced} poison ${stats.poisonings} · locks ${stats.locks} waits-outside ${stats.bounces} door-work ${stats.doorWorks} (breaks ${stats.breaks}) locked-in ${stats.lockedIn} murder-locks ${stats.lockBlocks} · objectives done ${stats.objectivesDone}, forced ${stats.forced} · gives ${stats.gives} requests ${stats.requests} · exits found ${stats.exitsFound}/2 attempts ${stats.exitAttempts} · ${roleStats.hidden} hidden + ${roleStats.fakes} fake · ${stats.leakChecks} leak checks, ${stats.actionsChecked} action checks`,
  );
  return { ...stats, endReason: game.endReason, roleStats, game };
}

// ---------- เทสต์เชิงกำหนดของกลไกใหม่ (เรียกเมธอดตรง ๆ) ----------
async function unitTests() {
  const ai = createAI({ forceMock: true, log: quietLog });
  const game = new Game({ code: 'UNIT', ai, log: quietLog });
  const ids = ['u1-xxxxxxxx', 'u2-xxxxxxxx', 'u3-xxxxxxxx'];
  for (const [i, id] of ids.entries()) game.addPlayer({ id, name: `ยูนิต ${i + 1}` });
  game.onChange = () => {};
  const saved = { ...CONFIG };
  Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 1 });
  await game.start(ids[0]);
  game.clearTimers();
  const [a, b, c] = ids.map((id) => game.players.get(id));
  const zones = [...game.zones.values()];
  // unit test 3 moves a player into the food zone, so it must not be the zone locked at start (relock another zone if it is)
  let foodZone = zones.find((z) => z.items.some((i) => i.kind === 'food') && !z.locked);
  if (!foodZone) {
    foodZone = zones.find((z) => z.items.some((i) => i.kind === 'food'));
    foodZone.locked = false;
    zones.find((z) => z.lockable && z.id !== foodZone.id).locked = true;
  }
  // ยาพิษสำหรับเทสต์ต้องฆ่าได้ (ยานอนหลับ/ยาสลบทำให้สลบเท่านั้น และพิษที่ต้องเข้ากระแสเลือดผสมอาหารไม่ได้)
  let poison = zones.flatMap((z) => z.items).find((i) => i.kind === 'poison' && !tagsOf(i).has('sedative') && !tagsOf(i).has('bloodOnly'));
  if (!poison) {
    poison = { id: 'poison_test', name: 'ยาเบื่อหนูทดสอบ', description: 'กล่องเปิดอยู่', kind: 'poison', portable: true, hidden: false, isPart: false };
    zones[1].items.push(poison);
  }
  const rope = zones.flatMap((z) => z.items).find((i) => i.kind === 'rope');
  const weapon = zones.flatMap((z) => z.items).find((i) => i.kind === 'weapon' && (tagsOf(i).has('sharp') || tagsOf(i).has('heavy')));
  assert(foodZone && poison && rope && weapon, 'unit world has food, poison, rope and a sharp or heavy weapon');
  // 1) วางยาในอาหาร → คนกินตาย (บังคับไม่ให้สังเกตเห็น) และคดีเป็น trap/poison
  for (const p of [a, b, c]) p.zoneId = foodZone.id;
  a.inventory = [poison];
  game.do_poisonFood(a, { itemId: poison.id });
  const food = foodZone.items.find((i) => i.kind === 'food');
  assert(food.poisoned?.setterId === a.id && !a.inventory.includes(poison), 'food is poisoned and poison consumed');
  assert(game.availableActions(a).every((x) => x.type !== 'poisonFood'), 'cannot poison the same food twice');
  const realRandom = Math.random;
  Math.random = () => 0.99; // ไม่สังเกตเห็น
  game.do_eat(b, {});
  Math.random = realRandom;
  assert(!b.alive && b.deathCause === 'trap' && game.cases.at(-1).trapType === 'poison' && game.cases.at(-1).killerId === a.id, 'eater dies from poisoned food, poisoner is culprit');
  assert(!food.poisoned, 'poisoned batch is gone after a death');
  // 2) ล็อกการฆาตกรรม (ตัวเลือก MURDER_LOCK ปิดโดยค่าเริ่มต้น): เปิดแล้ว c (ไม่ใช่คนร้าย) ลงมือไม่ได้ ส่วน a (คนร้าย) ลงมือได้
  game.phase = PHASE.DAY;
  game.step = STEP.ACT;
  game.actions = new Map();
  assert(!CONFIG.MURDER_LOCK && !game.murderLockedFor(c), 'murder lock is off by default: anyone may act while a body is hidden');
  CONFIG.MURDER_LOCK = true;
  assert(game.murderLockedFor(c) && !game.murderLockedFor(a), 'murder lock applies to non-culprits only');
  const atkC = game.availableActions(c).find((x) => x.type === 'attack' && x.targetId === a.id);
  let threw = false;
  try { game.chooseAction(c.id, atkC); } catch (e) { threw = /ฆาตกรรม/.test(e.message); }
  assert(threw && !game.actions.has(c.id), 'non-culprit attack rejected with murder-lock message');
  assert(c.log.at(-1).text.includes('มีการฆาตกรรมเกิดขึ้นแล้ว'), 'non-culprit is told a murder already happened');
  const atkA = game.availableActions(a).find((x) => x.type === 'attack' && x.targetId === c.id);
  game.actions = new Map();
  game.chooseAction(a.id, atkA);
  assert(game.actions.get(a.id)?.type === 'attack', 'culprit can still attack');
  CONFIG.MURDER_LOCK = false;
  game.actions = new Map();
  // 3) คราฟกับดัก → วาง → คนเข้าห้องโดน
  a.inventory = [weapon, rope];
  const craft = game.craftOptions(a, foodZone).find((x) => x.recipeId === 'blade');
  assert(craft, 'blade recipe available from weapon + rope');
  game.do_craft(a, craft);
  const trapItem = a.inventory.find((i) => i.kind === 'trap');
  assert(trapItem && trapItem.trapType === 'blade' && a.inventory.length === 1, 'craft consumes both ingredients and yields one trap item');
  assert(game.availableActions(a).some((x) => x.type === 'trap' && x.itemId === trapItem.id), 'crafted trap can be placed');
  Math.random = () => 0.5; // ไม่พลาดตอนวาง
  game.do_trap(a, { itemId: trapItem.id });
  Math.random = realRandom;
  assert(foodZone.traps.length === 1 && foodZone.traps[0].item.trapType === 'blade', 'trap placed at the room entrance');
  const other = zones.find((z) => z.id !== foodZone.id && !z.locked);
  c.zoneId = other.id;
  a.zoneId = other.id;
  game.moves = new Map([[c.id, foodZone.id], [a.id, other.id]]);
  Math.random = () => 0.5; // ไม่ปลด (0.5 > 0.25) และอยู่ในช่วงกับดักทำงาน (< 0.25 + 0.6)
  game.resolveMoves();
  Math.random = realRandom;
  assert(!c.alive && c.deathCause === 'trap' && game.cases.at(-1).trapType === 'blade' && game.cases.at(-1).killerId === a.id, 'entering a trapped room triggers the blade trap');
  // 4) ล็อกห้อง: ไม่มีกุญแจเข้าไม่ได้ (เด้งกลับ) มีกุญแจเข้าได้ และคนข้างในที่ไม่มีกุญแจออกไม่ได้ (ถูกขัง) · กุญแจทั้งเกม ≤2 ดอก ห้องละไม่เกินดอกเดียว
  game.bodies = new Map(); // ล้างศพจากข้อก่อน ไม่ให้ประกาศพบศพมารบกวน
  game.cases = [];
  const allItems = zones.flatMap((z) => z.items);
  assertKeyLayout(game, false);
  assert(allItems.some((i) => i.kind === 'lockpick'), 'a lockpick exists in the world');
  let locked = zones.find((z) => z.locked && z.keyItemId);
  if (!locked) {
    locked = zones.find((z) => z.lockable && z.keyItemId);
    locked.locked = true;
  }
  const key = allItems.find((i) => i.id === locked.keyItemId);
  assert(locked && key && key.unlocksZoneIds.includes(locked.id), 'a locked zone with its key exists');
  const keyless = zones.find((z) => z.lockable && !z.keyItemId);
  assert(keyless && !game.hasKeyFor({ inventory: [key] }, keyless.id), 'a room without a key cannot be opened by the existing key');
  a.alive = true;
  b.alive = true;
  a.inventory = [];
  b.inventory = [];
  const aTrait0 = game.charOf(a).ultimate.trait;
  game.charOf(a).ultimate.trait = 'none'; // ตัด trait สุ่มออกตลอดเทสต์ประตู (นักสู้พังประตูได้ใน 1 ชม. จะเข้าห้องแทนที่จะยืนรอ)
  const from = zones.find((z) => z.id !== locked.id && !z.locked);
  a.zoneId = from.id;
  a.outside = false;
  b.zoneId = from.id;
  game.phase = PHASE.DAY;
  game.moves = new Map([[a.id, locked.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && a.outside && a.zoneMemory[locked.id]?.locked === true, 'without a key the player waits outside the locked door and remembers the lock');
  assert(!game.presentIn(locked.id).includes(a) && game.presentIn(locked.id, true).includes(a) && !game.lockedIn(a), 'waiting outside is a separate spot and is not being locked in');
  a.inventory = [key];
  game.moves = new Map([[a.id, locked.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && !a.outside && locked.locked && /ไขเข้ามาด้วยกุญแจ/.test(a.log.at(-1).text), 'with the key the player enters, is told the door is locked, and the room stays locked');
  game.step = STEP.ACT;
  assert(game.availableActions(a).some((x) => x.type === 'unlock'), 'key holder inside can unlock');
  game.moves = new Map([[a.id, from.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(a.zoneId === from.id && locked.locked, 'a key holder can leave and the door stays locked behind them');
  // 4b) ล็อกเงียบ ๆ: คนที่อยู่ในห้องตอนล็อกยังไม่รู้ จนต้นชั่วโมงถัดไปจึงสังเกตเห็น และถูกขังถ้าไม่มีกุญแจ
  game.step = STEP.ACT;
  a.zoneId = locked.id;
  game.do_unlock(a);
  assert(!locked.locked, 'unlock opens the door');
  a.zoneId = from.id;
  a.outside = false;
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && b.zoneId === locked.id && b.zoneMemory[locked.id]?.locked === false, 'both enter the unlocked room and remember it as unlocked');
  game.step = STEP.ACT;
  const bLogBefore = b.log.length;
  game.do_lock(a);
  assert(locked.locked && a.zoneMemory[locked.id]?.locked === true, 'locking takes effect at once and the locker knows');
  assert(b.log.length === bLogBefore && b.zoneMemory[locked.id]?.locked === false, 'others in the room are not told about the lock yet');
  b.inventory = [key]; // ส่งกุญแจให้ b: ถือกุญแจแต่ยังไม่รู้ว่าล็อก → ยังไม่มีตัวเลือกปลดล็อก
  a.inventory = [];
  assert(!game.availableActions(b).some((x) => x.type === 'lock' || x.type === 'unlock'), 'a key holder who does not know about the lock gets no lock/unlock option yet');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves(); // ชั่วโมงถัดไป ทั้งคู่อยู่ต่อ
  assert(b.zoneMemory[locked.id]?.locked === true && /เพิ่งสังเกตว่าประตูห้องนี้ถูกล็อกไว้/.test(b.log.at(-1).text), 'next hour the roommate notices the door is locked');
  assert(/ถูกขังอยู่/.test(a.log.at(-1).text) === false && !/ไขเข้ามาด้วยกุญแจ/.test(a.log.at(-1).text), 'the locker who stays is not told they unlocked their way in');
  game.step = STEP.ACT;
  assert(game.availableActions(b).some((x) => x.type === 'unlock'), 'once aware, the key holder can unlock');
  // a ไม่มีกุญแจแล้วและรู้ว่าล็อก → ถูกขัง: เลือกห้องอื่นไม่ได้ และถ้าหลุดไปถึง resolve ก็ยังอยู่ที่เดิม
  game.step = STEP.MOVE;
  game.moves = new Map();
  game.charOf(a).ultimate.trait = 'none'; // a combat trait could break out of the room; the lock-in check needs a player with no way out
  let stuck = false;
  try { game.chooseMove(a.id, from.id); } catch (e) { stuck = /ถูกล็อกอยู่ใน/.test(e.message); }
  assert(stuck && game.lockedIn(a) && !game.doorMeans(a) && !game.moves.has(a.id), 'a locked-in player without key or tools cannot choose another room');
  game.moves = new Map([[a.id, from.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && locked.locked && a.log.slice(-2).some((l) => /ถูกล็อกไว้จากข้างนอก/.test(l.text)), 'forcing a move out of a locked room fails and the door stays locked');
  game.step = STEP.ACT;
  game.do_unlock(b);
  assert(!locked.locked && b.zoneMemory[locked.id]?.locked === false && a.zoneMemory[locked.id]?.locked === true, 'unlocking is quiet too: the other player still believes it is locked');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneMemory[locked.id]?.locked === false && /ไม่ได้ล็อกแล้ว/.test(a.log.at(-1).text), 'next hour the other player notices the door is unlocked');
  // 4c) สะเดาะกลอนจากข้างนอก: ใช้เวลา 2–3 ชั่วโมง (บังคับให้เป็น 2) ระหว่างนั้นทำอย่างอื่นไม่ได้ คนข้างในอาจได้ยิน
  game.step = STEP.ACT;
  game.do_lock(b);
  a.zoneId = from.id;
  a.outside = false;
  const lockpick = allItems.find((i) => i.kind === 'lockpick');
  a.inventory = [lockpick];
  assert(game.doorMeans(a)?.method === 'pick', 'a lockpick lets anyone work on a locked door');
  Math.random = () => 0; // need = 2 และคนข้างในได้ยิน
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  const bHeard = b.log.length;
  game.resolveMoves();
  Math.random = realRandom;
  assert(a.zoneId === locked.id && a.outside && a.doorWork?.progress === 1 && a.doorWork.need === 2 && locked.locked, 'first hour of lockpicking: waiting outside the door, progress 1 of 2');
  assert(game.actions.get(a.id)?.type === 'doorwork' && game.actions.get(a.id).busy, 'lockpicking consumes the hour');
  assert(b.log.length > bHeard && b.log.slice(bHeard).some((l) => /แกรกกราก/.test(l.text)), 'the person inside may hear the lockpick');
  let overridden = false;
  try { game.chooseAction(a.id, { type: 'search' }); } catch { overridden = true; }
  assert(overridden, 'a busy player cannot pick another action');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && !a.outside && !locked.locked && !a.doorWork, 'second hour: lock picked, door unlocked, player enters');
  assert(b.zoneMemory[locked.id]?.locked === false && b.log.slice(-3).some((l) => /ประตู.*เปิดออก/.test(l.text)), 'people inside see the door open');
  // 4d) นักสู้พังประตูมือเปล่า 1–2 ชั่วโมง (บังคับให้เป็น 1) เสียงดัง ประตูพังแล้วล็อกไม่ได้อีก
  game.step = STEP.ACT;
  game.do_lock(b);
  a.zoneId = from.id;
  a.outside = false;
  a.inventory = [];
  const aChar = game.charOf(a);
  const realTrait = aChar.ultimate.trait;
  aChar.ultimate.trait = 'combat';
  assert(game.doorMeans(a)?.method === 'break', 'a combat ultimate can break doors barehanded');
  Math.random = () => 0; // need = 1
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  Math.random = realRandom;
  assert(a.zoneId === locked.id && !a.outside && locked.broken && !locked.locked && !locked.lockable, 'combat breaks the door in one hour and enters; the door cannot be locked again');
  assert(b.log.slice(-4).some((l) => /ทุบกระแทก/.test(l.text)), 'people inside hear the door being broken');
  assert(locked.evidence.some((e) => e.kind === 'door'), 'a broken door leaves visible evidence');
  game.step = STEP.ACT;
  assert(!game.availableActions(b).some((x) => x.type === 'lock'), 'a broken door cannot be locked');
  aChar.ultimate.trait = 'tech';
  a.inventory = [weapon];
  assert(!game.doorMeans(a), 'tech needs a tool, not a weapon');
  const toolItem = allItems.find((i) => i.kind === 'tool' && tagsOf(i).has('fastener'));
  a.inventory = [toolItem];
  assert(toolItem && game.doorMeans(a)?.method === 'pick' && game.doorMeans(a).item === toolItem, 'tech uses a hand tool (screwdriver/wrench/hammer) as a lockpick');
  a.inventory = [{ id: 'junk_tool', name: 'สมุดลงทะเบียนทดสอบ', description: '', kind: 'tool', portable: true, hidden: false }];
  assert(!game.doorMeans(a), 'tech cannot pick a lock with a tool that is not a hand tool');
  aChar.ultimate.trait = 'none';
  assert(!game.doorMeans(a), 'ordinary people need a real lockpick');
  aChar.ultimate.trait = aTrait0;
  a.inventory = [];
  b.inventory = [];
  // 5) ทางออก: ไม่รู้จัก → ไม่มีแอ็กชัน, ค้นพบแล้วจึงมี, เส้นทางแบบกุญแจเปิดได้เมื่อถือกุญแจ
  const exit = [...game.exits.values()][0];
  a.zoneId = exit.zoneId;
  assert(!game.availableActions(a).some((x) => x.type === 'exit'), 'no exit action before discovering the exit');
  Math.random = () => 0.01;
  game.do_search(a, {});
  Math.random = realRandom;
  assert(exit.discoveredBy.has(a.id), 'searching the exit room reveals the hidden exit');
  assert(game.viewFor(a.id).me.exits.some((x) => x.id === exit.id && x.zoneName === game.zoneName(exit.zoneId)), 'known exit appears in the view with its zone');
  const lockedExit = [...game.exits.values()].find((x) => x.route === 'locked');
  if (lockedExit) {
    lockedExit.discoveredBy.add(a.id);
    a.zoneId = lockedExit.zoneId;
    // การสำรวจข้างบนหยิบของทางออกที่เจอเข้ากระเป๋าอัตโนมัติ กุญแจของทางออกนี้อาจอยู่ในมือ a แล้ว (ไม่งั้น inventory = [undefined] แล้วพังแบบสุ่ม)
    const keyItem = [...zones.flatMap((z) => z.items), ...a.inventory].find((i) => i && i.exitId === lockedExit.id && i.role === 'key');
    assert(keyItem, 'the locked exit has a key item somewhere');
    a.inventory = [keyItem, { id: 'tool_x', name: 'ไขควงทดสอบ', description: 'ปลายแหลม', kind: 'tool', portable: true, hidden: false, isPart: false }, { id: 'axe_x', name: 'ขวานทดสอบ', description: 'คมกริบ', kind: 'weapon', portable: true, hidden: false, isPart: false }];
    const act = game.availableActions(a).find((x) => x.type === 'exit' && x.exitId === lockedExit.id);
    assert(act && !act.disabled && /ขั้น/.test(act.label) && lockedExit.steps.length >= 4, 'exit action lists the steps (4 or more)');
    const view5 = game.viewFor(a.id).me.exits.find((x) => x.id === lockedExit.id);
    assert(view5 && view5.steps.length === lockedExit.steps.length && view5.steps.some((s) => s.kind === 'key' && s.done) && view5.steps.some((s) => s.kind === 'force' && !s.done), 'the view shows a step checklist with the key already satisfied');
    game.phase = PHASE.DAY;
    game.step = STEP.ACT;
    game.charOf(a).ultimate.trait = 'none'; // คนทั่วไปลงแรงได้ 1 แต้มต่อครั้ง
    let tries = 0;
    while (!lockedExit.open && tries < 6) {
      game.actions = new Map([[a.id, act]]);
      for (const p of game.alivePlayers()) if (p.id !== a.id) game.actions.set(p.id, { type: 'rest', auto: true });
      game.resolveActions();
      tries++;
      if (!lockedExit.open) {
        assert(lockedExit.steps.find((s) => s.kind === 'cut').done && lockedExit.steps.find((s) => s.kind === 'tool').done, 'cutting and unbolting stick after the first attempt');
        assert(a.log.at(-1).text.includes('ยังไม่สำเร็จ') && /ยังขาด/.test(a.log.at(-1).text), 'a failed attempt reports which steps are missing');
        game.step = STEP.ACT;
      }
    }
    assert(lockedExit.open && game.phase === PHASE.ENDED && game.endReason === 'escape', `key + hand tool + blade + force open the locked exit (${tries} attempts)`);
    assert(tries === 3, `the force step (3 points) takes exactly 3 attempts for an ordinary player (${tries})`);
  }
  // 6) ขอของจากบอท (เฉพาะบอท เฉพาะช่วงพัก ห้องเดียวกัน)
  {
    const g2 = new Game({ code: 'UNIT2', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    g2.addPlayer({ id: 'h-xxxxxxxx', name: 'คน' });
    g2.addPlayer({ id: 'h2-xxxxxxxx', name: 'คนสอง' });
    g2.setBots('h-xxxxxxxx', 1);
    g2.onChange = () => {};
    await g2.start('h-xxxxxxxx');
    g2.clearTimers();
    const h = g2.players.get('h-xxxxxxxx');
    const h2 = g2.players.get('h2-xxxxxxxx');
    const bot = g2.players.get('bot-1');
    const item = [...g2.zones.values()].flatMap((z) => z.items).find((i) => i.portable);
    bot.inventory = [item];
    h2.inventory = [];
    g2.phase = PHASE.DAY;
    g2.step = STEP.ACT;
    let threw = false;
    try { g2.requestItem(h.id, bot.id, item.id); } catch { threw = true; }
    assert(threw, 'requests only during the rest step');
    g2.step = STEP.REPORT;
    bot.zoneId = h.zoneId;
    const v = g2.viewFor(h.id);
    const zp = v.me.zonePeople.find((x) => x.id === bot.id);
    assert(zp?.isBot && zp.items?.some((i) => i.id === item.id), 'bot items visible to co-located human at rest');
    assert(!v.me.zonePeople.find((x) => x.id === h2.id)?.items, 'human items are not listed');
    g2.requestItem(h.id, bot.id, item.id);
    assert(h.inventory.includes(item) && !bot.inventory.length, 'bot hands over the requested item');
    threw = false;
    try { g2.requestItem(h.id, h2.id, 'x'); } catch (e) { threw = /เฉพาะจากบอท|ไม่ถูกต้อง|ไม่มีของ/.test(e.message); }
    assert(threw, 'cannot request from a human');
    const saved2 = CONFIG.BOT_REQUESTS;
    CONFIG.BOT_REQUESTS = false;
    bot.inventory = [item];
    h.inventory = [];
    threw = false;
    try { g2.requestItem(h.id, bot.id, item.id); } catch { threw = true; }
    assert(threw && !g2.viewFor(h.id).me.zonePeople.find((x) => x.id === bot.id)?.items, 'BOT_REQUESTS=false disables requests and hides bot items');
    CONFIG.BOT_REQUESTS = saved2;
  }
  // 7) หลังตัดสิน: ศพ/หลักฐาน/รอยเปื้อน/ความจำเรื่องศพหายหมด ของของผู้ตายตกอยู่ที่จุดที่ตาย ของคนเป็นยังอยู่ ทุกคนกลับไปเริ่มที่ห้องนอนรวม
  {
    const g3 = new Game({ code: 'UNIT3', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids3 = ['r1-xxxxxxxx', 'r2-xxxxxxxx', 'r3-xxxxxxxx'];
    for (const [i, id] of ids3.entries()) g3.addPlayer({ id, name: `รีเซ็ต ${i + 1}` });
    g3.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g3.start(ids3[0]);
    g3.clearTimers();
    const [x, y, w] = ids3.map((id) => g3.players.get(id));
    const zs = [...g3.zones.values()];
    const scene = zs.find((z) => z.id !== g3.location.sleepZoneId);
    const wItem = zs.flatMap((z) => z.items).find((i) => i.kind === 'weapon');
    const yItems = zs.flatMap((z) => z.items).filter((i) => i.kind === 'tool').slice(0, 2);
    for (const it of [wItem, ...yItems]) {
      const z = zs.find((zz) => zz.items.includes(it));
      z.items.splice(z.items.indexOf(it), 1);
    }
    x.inventory = [wItem];
    y.inventory = yItems;
    for (const p of [x, y, w]) p.zoneId = scene.id;
    g3.phase = PHASE.DAY;
    g3.step = STEP.ACT;
    Math.random = () => 0; // ลงมือสำเร็จแบบเลอะเทอะ มีพยาน
    g3.do_attack(x, { targetId: y.id });
    Math.random = realRandom;
    assert(!y.alive && g3.bodies.has(y.id) && y.inventory.length === 0 && yItems.every((i) => scene.items.includes(i)), 'victim dies and drops items at the death spot');
    assert(scene.evidence.length > 0 && x.stained !== null, 'the kill leaves evidence and a stain');
    g3.cases.at(-1).judged = true;
    g3.bodies.get(y.id).judged = true;
    y.caseJudged = true;
    const xInv = x.inventory.map((i) => i.id).join(',');
    g3.resetAfterTrial();
    assert(!g3.bodies.has(y.id) && zs.every((z) => z.evidence.length === 0), 'judged body and its evidence are gone');
    assert(x.stained === null && !x.knownBodies.has(y.id) && !w.knownBodies.has(y.id), 'stains and body knowledge are cleared');
    assert(yItems.every((i) => scene.items.includes(i)) && x.inventory.map((i) => i.id).join(',') === xInv, 'dead player items stay where they died, survivors keep theirs');
    assert([x, w].every((p) => p.zoneId === g3.location.sleepZoneId), 'survivors restart at the sleep zone');
  }
  // 8) ฆาตกรหลายคน: พบศพร่างเดียว → เปิดเผยทุกร่าง · ตัดสินถูก → ประหารคนนั้น บอกแค่ "ยังมีอีก 1 คน" · เก็บหลักฐานต่อในวันเดิม → ตัดสินรอบ 2 · ปิดครบแล้วค่อยขึ้นวันใหม่โดยไม่มีศพเหลือ
  {
    const g4 = new Game({ code: 'UNIT4', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids4 = ['m1-xxxxxxxx', 'm2-xxxxxxxx', 'm3-xxxxxxxx', 'm4-xxxxxxxx', 'm5-xxxxxxxx', 'm6-xxxxxxxx'];
    for (const [i, id] of ids4.entries()) g4.addPlayer({ id, name: `หลายศพ ${i + 1}` });
    g4.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g4.start(ids4[0]);
    g4.clearTimers();
    const [k1, v1, k2, v2, s1, s2] = ids4.map((id) => g4.players.get(id));
    const rooms = [...g4.zones.values()].filter((z) => z.id !== g4.location.sleepZoneId);
    k1.zoneId = v1.zoneId = rooms[0].id;
    k2.zoneId = v2.zoneId = rooms[1].id;
    s1.zoneId = s2.zoneId = rooms[2].id;
    g4.phase = PHASE.DAY;
    g4.step = STEP.ACT;
    Math.random = () => 0;
    for (const kk of [k1, k2]) if (!g4.bestWeapon(kk)) kk.inventory.push({ id: `kn_${kk.id}`, name: 'มีดทดสอบ', description: 'คมกริบ', kind: 'weapon', portable: true, hidden: false, isPart: false }); // มือเปล่าทำให้สลบเท่านั้น
    g4.do_attack(k1, { targetId: v1.id });
    assert(!g4.murderLockedFor(k2), 'with the lock off a second person may still kill while a body is hidden');
    g4.do_attack(k2, { targetId: v2.id });
    Math.random = realRandom;
    assert(!v1.alive && !v2.alive && g4.bodies.size === 2 && g4.cases.length === 2, 'two murders by two different killers');
    // มีแค่ s1 ที่เดินมาเจอศพ v1 — ศพ v2 ยังไม่มีใครเห็น
    g4.bodies.get(v1.id).discoveredBy.add(s1.id);
    s1.knownBodies.add(v1.id);
    await g4.startInvestigation();
    assert(g4.phase === PHASE.INVESTIGATION && g4.huntRound === 1 && [...g4.bodies.values()].every((b) => b.announced) && g4.cases.every((c) => c.announced), 'finding one body announces every body');
    assert(g4.investigation.total === 3 && g4.investigation.hour === 1 && /3 ชั่วโมง/.test(g4.chat.at(-1).text), 'two bodies make a 3-hour investigation (1 + 1 per body)');
    assert(!g4.availableActions(s2).some((x) => ['attack', 'eat', 'poisonFood', 'trap'].includes(x.type)) && g4.availableActions(s2).some((x) => x.type === 'search'), 'no killing or eating during the investigation');
    assert([s1, s2, k1, k2].every((p) => p.knownBodies.has(v1.id) && p.knownBodies.has(v2.id)), 'everyone now knows where both bodies are');
    const ann = g4.chat.at(-1).text;
    assert(/ศพทุกร่างในสถานที่ถูกเปิดเผยพร้อมกัน/.test(ann) && /ยังไม่มีใครเคยเห็น/.test(ann), 'announcement mentions the never-seen body');
    // รอบเก็บหลักฐาน 3 ชั่วโมง: เล่นชั่วโมงที่ 1 และ 2 ให้ผ่าน → ถึงชั่วโมงที่ 3/3 (ส่วนทดสอบเดิมเรียก beginTrial ต่อ)
    const invTurn = g4.turn;
    for (let h = 1; h <= 2; h++) {
      for (const p of g4.alivePlayers()) g4.chooseMove(p.id, p.zoneId);
      for (const p of g4.alivePlayers()) if (g4.step === STEP.ACT) g4.chooseAction(p.id, { type: 'search' });
      assert(g4.phase === PHASE.INVESTIGATION && g4.step === STEP.MOVE && g4.investigation.hour === h + 1 && g4.turn === invTurn + h, `investigation continues to hour ${h + 1}/3 instead of going to trial`);
    }
    await g4.beginTrial();
    assert(!/รอบที่/.test(g4.chat.at(-1).text), 'first trial of the day is not numbered');
    for (const p of g4.alivePlayers()) {
      g4.castVote(p.id, p.id === k1.id ? k2.id : k1.id); // โหวตตัวเองไม่ได้
      g4.confirmVote(p.id);
    }
    const c1 = g4.cases.find((c) => c.victimId === v1.id);
    const c2 = g4.cases.find((c) => c.victimId === v2.id);
    const r1 = g4.lastResult;
    assert(g4.phase === PHASE.TRIAL_RESULT && r1.correct && k1.fate === 'executed' && k2.alive, 'first verdict executes the voted killer; the other stays alive');
    assert(c1.judged && !c2.judged && r1.moreKillers === true && r1.round === 1 && r1.stillOpen.length === 1 && r1.stillOpen[0] === g4.nick(v2), "the other killer's case stays open and the result says more remain");
    assert(r1.cases.length === 1 && r1.cases[0].id === c1.id && r1.cases.every((c) => c.killerPlayer !== k2.name), 'only the closed case is revealed; the living killer is not named');
    const verdict1 = g4.chat.at(-1).text;
    assert(/ยังมีฆาตกรอีก 1 คน/.test(verdict1) && !verdict1.includes(g4.nick(k2)), 'announcement says one more killer remains without naming or counting');
    assert(g4.history.at(-1).culprits.join() === g4.nick(k1) && g4.history.at(-1).moreKillers && g4.history.at(-1).round === 1, 'history records round 1 with the hunt unfinished');
    const view1 = g4.viewFor(s1.id);
    assert(view1.lastResult.moreKillers && view1.lastResult.cases.every((c) => c.killerPlayer !== k2.name) && view1.announcedCases.some((c) => c.id === c2.id && !c.judged), 'client sees the open case but not the hidden killer');
    const hourBefore = g4.hour;
    await g4.nextRound(ids4[0]);
    assert(g4.phase === PHASE.INVESTIGATION && g4.step === STEP.MOVE && g4.day === 1 && g4.hour === hourBefore + 1 && g4.huntRound === 2, 'hunt continues: another evidence hour in the same day');
    assert(g4.viewFor(s2.id).players.find((p) => p.id === v1.id).knownDead === true && g4.viewFor(s2.id).players.find((p) => p.id === v1.id).alive === false, 'a victim whose case is closed stays visibly dead after the body is collected');
    assert(g4.bodies.size === 1 && g4.bodies.has(v2.id) && !g4.bodies.has(v1.id) && !s1.knownBodies.has(v1.id) && s1.knownBodies.has(v2.id), 'body of the closed case is collected; the open case keeps its body');
    assert([...g4.zones.values()].every((z) => z.evidence.every((e) => e.caseId !== c1.id)), 'evidence of the closed case is wiped');
    const huntMsg = g4.chat.at(-1).text;
    assert(/การตามหาฆาตกรที่เหลือ/.test(huntMsg) && /รอบที่ 2/.test(huntMsg) && huntMsg.includes(g4.nick(v2)) && !huntMsg.includes(g4.nick(k2)), 'hunt message announces round 2 and the open case, not the killer');
    for (const p of g4.alivePlayers()) g4.chooseMove(p.id, p.zoneId);
    assert(g4.phase === PHASE.INVESTIGATION && g4.step === STEP.ACT, 'hunt hour proceeds to actions');
    for (const p of g4.alivePlayers()) if (g4.phase === PHASE.INVESTIGATION && g4.step === STEP.ACT) g4.chooseAction(p.id, { type: 'search' });
    assert(g4.phase === PHASE.TRIAL && /รอบที่ 2/.test(g4.chat.at(-1).text), 'after the evidence hour the second trial begins');
    for (const p of g4.alivePlayers()) {
      g4.castVote(p.id, p.id === k2.id ? s1.id : k2.id);
      g4.confirmVote(p.id);
    }
    const r2 = g4.lastResult;
    assert(g4.phase === PHASE.TRIAL_RESULT && r2.correct && k2.fate === 'executed' && !r2.moreKillers && r2.round === 2 && c2.judged && r2.cases.some((c) => c.id === c2.id && c.killerPlayer === k2.name), 'second verdict catches the last killer, reveals the case, and the hunt ends');
    assert(/ไม่มีฆาตกรเหลืออยู่/.test(g4.chat.at(-1).text) && g4.history.length === 2 && g4.history.at(-1).round === 2 && !g4.history.at(-1).moreKillers, 'final verdict says no killer remains');
    await g4.nextRound(ids4[0]);
    assert(g4.phase === PHASE.DAY && g4.day === 2 && g4.bodies.size === 0 && g4.huntRound === 0, 'only then does a new day start, with no bodies left');
    assert([v1, v2].every((v) => g4.viewFor(s1.id).players.find((p) => p.id === v.id).knownDead), 'closed-case victims still show as dead on the new day');
  }
  // 9) ประตูล็อก = ยืนรอหน้าประตู (ข้างนอก) ฝั่งใครฝั่งมัน · กับดักประตู (ข้างนอกเล่นงานคนออก / ข้างในเล่นงานคนเข้า คนปลดล็อกโดนก่อน) · ฆาตกรที่ยังไม่ถูกจับหนีออกไม่ได้
  {
    const g5 = new Game({ code: 'UNIT5', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids5 = ['d1-xxxxxxxx', 'd2-xxxxxxxx', 'd3-xxxxxxxx', 'd4-xxxxxxxx', 'd5-xxxxxxxx'];
    for (const [i, id] of ids5.entries()) g5.addPlayer({ id, name: `ประตู ${i + 1}` });
    g5.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 1 });
    await g5.start(ids5[0]);
    g5.clearTimers();
    const [a, b, c, d, e] = ids5.map((id) => g5.players.get(id));
    const zones5 = [...g5.zones.values()];
    const L = zones5.find((z) => z.locked && z.keyItemId);
    const key5 = zones5.flatMap((z) => z.items).find((i) => i.id === L?.keyItemId);
    const R = zones5.find((z) => z.id !== L?.id && !z.locked && z.id !== g5.location.sleepZoneId);
    assert(L && key5 && R, 'unit world has a locked room with a key and an open room');
    for (const p of [a, b, c, d, e]) g5.charOf(p).ultimate.trait = 'none'; // ตัดคุณสมบัติสุ่มที่กวนเทสต์
    // (i) a กับ c ไม่มีกุญแจเดินไปห้องที่ล็อก → ยืนรอหน้าประตูทั้งคู่ · b อยู่ข้างในพร้อมกุญแจ
    for (const z of zones5) z.items = z.items.filter((i) => i.id !== key5.id);
    b.zoneId = L.id;
    b.inventory = [key5];
    for (const p of [a, c, d, e]) p.zoneId = R.id;
    g5.phase = PHASE.DAY;
    g5.moves = new Map([[a.id, L.id], [c.id, L.id], [b.id, L.id], [d.id, R.id], [e.id, R.id]]);
    g5.resolveMoves();
    assert(a.zoneId === L.id && a.outside && c.zoneId === L.id && c.outside && !b.outside, 'without a key you wait outside the locked door instead of bouncing back');
    assert(a.log.some((l) => /ยืนรออยู่หน้าประตู/.test(l.text)) && /หน้าประตู/.test(a.log.at(-1).text), 'the player is told they are waiting outside');
    assert(g5.presentIn(L.id).map((p) => p.id).join() === b.id && g5.presentWith(a).length === 2 && g5.presentWith(a).includes(c), 'inside and outside are separate spots');
    g5.step = STEP.ACT;
    const outActs = g5.availableActions(a);
    assert(!outActs.some((x) => ['search', 'take', 'drop', 'hide', 'eat', 'examine', 'moveBody', 'lock', 'unlock', 'exit', 'exit_power', 'clean', 'sabotage'].includes(x.type)), 'outside: no room actions');
    assert(outActs.some((x) => x.type === 'attack' && x.targetId === c.id) && !outActs.some((x) => x.type === 'attack' && x.targetId === b.id) && outActs.some((x) => x.type === 'rest'), 'outside: can only act on people outside');
    assert(!g5.availableActions(b).some((x) => x.type === 'attack'), 'inside: people outside are not targets');
    const va = g5.viewFor(a.id);
    assert(va.me.outside === true && va.players.find((p) => p.id === c.id).zoneId === L.id && va.players.find((p) => p.id === b.id).zoneId == null, 'view: outsiders see each other, not the person inside');
    assert(g5.viewFor(b.id).players.find((p) => p.id === a.id).zoneId == null && g5.viewFor(b.id).me.zonePeople.length === 0, 'view: the person inside does not see people outside');
    g5.step = STEP.REPORT;
    a.inventory = [{ id: 'junk_a', name: 'ของทดสอบ', description: '', kind: 'cloth', portable: true, hidden: false }];
    let crossGive = false;
    try { g5.giveItem(a.id, b.id, 'junk_a'); } catch { crossGive = true; }
    assert(crossGive, 'cannot hand items through a locked door');
    g5.giveItem(a.id, c.id, 'junk_a');
    assert(c.inventory.some((i) => i.id === 'junk_a'), 'people waiting outside together can trade items');
    // (ii) กับดักประตูวางข้างนอก: a ประกอบจากอาวุธ+เครื่องมือ ติดตั้งหน้าประตู → b ที่มีกุญแจเปิดประตูออกมาโดน
    g5.step = STEP.ACT;
    a.inventory = [
      { id: 'w_a', name: 'ขวานทดสอบ', description: '', kind: 'weapon', portable: true, hidden: false },
      { id: 't_a', name: 'ประแจทดสอบ', description: '', kind: 'tool', portable: true, hidden: false },
    ];
    const doorCraft = g5.craftOptions(a, L).find((x) => x.recipeId === 'door');
    assert(doorCraft, 'door trap recipe: weapon + tool');
    g5.do_craft(a, doorCraft);
    const doorTrap = a.inventory.find((i) => i.kind === 'trap');
    assert(doorTrap?.trapType === 'door' && a.inventory.length === 1, 'crafted a door trap');
    const place = g5.availableActions(a).find((x) => x.type === 'trap' && x.itemId === doorTrap.id);
    assert(place && /ข้างนอก/.test(place.label), 'a door trap can be installed from outside');
    Math.random = () => 0.5;
    g5.do_trap(a, { itemId: doorTrap.id });
    Math.random = realRandom;
    assert(L.traps.some((t) => t.item.trapType === 'door' && t.side === 'outside' && t.setterId === a.id), 'door trap armed on the outside');
    g5.moves = new Map([[b.id, R.id], [a.id, L.id], [c.id, L.id], [d.id, R.id], [e.id, R.id]]);
    Math.random = () => 0.5;
    g5.resolveMoves();
    Math.random = realRandom;
    const cb = g5.cases.at(-1);
    assert(!b.alive && b.deathCause === 'trap' && cb.trapType === 'door' && cb.killerId === a.id && cb.outside && g5.bodies.get(b.id)?.outside, 'the key holder opening the door from inside dies at the doorstep; the setter is the culprit');
    assert(a.alive && c.alive && c.knownBodies.has(b.id) && g5.bodiesIn(L.id, true).length === 1 && g5.bodiesIn(L.id).length === 0, 'people outside find the body at the door; it is not inside the room');
    assert(L.traps.every((t) => t.item.trapType !== 'door') && L.locked, 'a door trap is used up; the door stays locked behind the dead key holder');
    assert(g5.viewFor(c.id).me.knownBodies.some((kb) => kb.playerId === b.id && kb.outside), 'the body is reported as lying at the door');
    // (iii) กับดักประตูวางข้างใน + คนปลดล็อกโดนก่อน: d (ข้างใน) ติดตั้ง · c สะเดาะกลอนสำเร็จชั่วโมงนี้ แล้ว e ตามเข้ามาด้วย → c โดน ไม่ใช่ e
    g5.bodies = new Map();
    g5.cases = [];
    d.zoneId = L.id;
    d.outside = false;
    d.inventory = [{ id: 'trap_in', name: 'กับดักประตูทดสอบ', description: '', kind: 'trap', trapType: 'door', portable: true, hidden: false }];
    g5.step = STEP.ACT;
    const placeIn = g5.availableActions(d).find((x) => x.type === 'trap' && x.itemId === 'trap_in');
    assert(placeIn && /ข้างใน/.test(placeIn.label), 'a door trap can be installed from inside');
    Math.random = () => 0.5;
    g5.do_trap(d, { itemId: 'trap_in' });
    Math.random = realRandom;
    assert(L.traps.some((t) => t.item.trapType === 'door' && t.side === 'inside'), 'door trap armed on the inside');
    const lockpick5 = zones5.flatMap((z) => z.items).find((i) => i.kind === 'lockpick') || { id: 'lp5', name: 'ที่สะเดาะทดสอบ', description: '', kind: 'lockpick', portable: true, hidden: false };
    c.inventory = [lockpick5];
    c.zoneId = L.id;
    c.outside = true;
    c.doorWork = { zoneId: L.id, method: 'pick', need: 2, progress: 1, startedTurn: g5.turn };
    e.zoneId = L.id;
    e.outside = true;
    e.inventory = [];
    a.zoneId = R.id;
    a.outside = false;
    g5.moves = new Map([[c.id, L.id], [e.id, L.id], [a.id, R.id], [d.id, L.id]]);
    Math.random = () => 0.99; // ถ้าสุ่มจะได้คนท้ายสุด (e) — แต่กติกาให้คนปลดล็อกโดนก่อน
    g5.resolveMoves();
    Math.random = realRandom;
    assert(!L.locked && !c.alive && c.deathCause === 'trap' && g5.cases.at(-1).killerId === d.id && !g5.cases.at(-1).outside, 'the lockpicker who opened the door dies first, inside the room');
    assert(e.alive && e.zoneId === L.id && !e.outside && d.alive, 'the follower who did not open the door enters alive; the setter is unharmed');
    g5.clearTimers();
    // (iv) ฆาตกรที่ยังไม่ถูกจับหนีออกไม่ได้: ทางออกเปิด → คนอื่นรอด ฆาตกรถูกทิ้งไว้และนับว่าตายทันที
    const g6 = new Game({ code: 'UNIT6', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids6 = ['e1-xxxxxxxx', 'e2-xxxxxxxx', 'e3-xxxxxxxx', 'e4-xxxxxxxx'];
    for (const [i, id] of ids6.entries()) g6.addPlayer({ id, name: `หนี ${i + 1}` });
    g6.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g6.start(ids6[0]);
    g6.clearTimers();
    const [k6, v6, s6, t6] = ids6.map((id) => g6.players.get(id));
    const room6 = [...g6.zones.values()].find((z) => z.id !== g6.location.sleepZoneId);
    k6.zoneId = v6.zoneId = room6.id;
    g6.phase = PHASE.DAY;
    g6.step = STEP.ACT;
    Math.random = () => 0;
    if (!g6.bestWeapon(k6)) k6.inventory.push({ id: 'kn_k6', name: 'มีดทดสอบ', description: 'คมกริบ', kind: 'weapon', portable: true, hidden: false, isPart: false });
    g6.do_attack(k6, { targetId: v6.id });
    Math.random = realRandom;
    assert(!v6.alive && k6.kills === 1, 'k6 is an uncaught killer');
    const x6 = [...g6.exits.values()][0];
    // ทำทุกขั้นให้ครบ: ขั้นถาวรติดไว้ ของที่ต้องถือให้ s6 ถือ
    for (const s of x6.steps) {
      s.done = true;
      if (s.kind === 'force') s.progress = s.needed;
    }
    x6.powered = true;
    for (const it of x6.items) {
      const zz = [...g6.zones.values()].find((z) => z.items.some((i) => i.id === it.id));
      if (zz) s6.inventory.push(zz.items.splice(zz.items.findIndex((i) => i.id === it.id), 1)[0]);
    }
    if (x6.assembly) s6.inventory.push({ id: x6.assembly.itemId, name: x6.assembly.name, description: '', kind: 'part', role: 'assembly', exitId: x6.id, isPart: true, portable: true, hidden: false });
    for (const p of [k6, s6, t6]) {
      p.zoneId = x6.zoneId;
      p.outside = false;
    }
    const ended6 = resolveExits(g6, [{ p: s6, a: { exitId: x6.id } }]);
    assert(ended6 && x6.open && g6.phase === PHASE.ENDED && g6.endReason === 'escape', 'the exit opens and the game ends');
    assert(!k6.alive && k6.fate === 'left_behind' && k6.deathCause === 'left_behind' && s6.fate === 'survivor' && t6.fate === 'survivor', 'the uncaught killer is left behind and dies; the others survive');
    assert(g6.outcome.died.some((r) => r.playerId === k6.id && r.fate === 'left_behind') && g6.outcome.survived.every((r) => r.playerId !== k6.id), 'the outcome lists the killer among the dead');
    assert(g6.chat.some((m) => m.system && /ปิดใส่หน้า/.test(m.text) && m.text.includes(g6.nick(k6))), 'the announcement names the killer who was shut in');
    assert(k6.log.some((l) => l.kind === 'death' && /ปิดใส่หน้า/.test(l.text)), 'the killer is told the door shut on them');
  }
  // 10) ความสมจริงของของผสม: ชื่อกับดักตามสูตร · อาวุธของคดีคือชิ้นที่ทำร้ายจริง · กับดักประตูเล่าคดีถูกสูตร · ร่องรอยบนศพตรงกันทั้งตอนตรวจและตอนเล่า · ไฟช็อตต้องใช้สายไฟจริง
  {
    const mk = (name, kind) => ({ id: `it_${name}_${kind}`, name, description: '', kind, portable: true, hidden: false, isPart: false });
    assert(woundOf(mk('เชิงเทียนเล็ก', 'weapon')) === 'blunt' && woundOf(mk('เชิงเทียนทองเหลืองใหญ่', 'weapon')) === 'blunt', 'candlesticks are blunt weapons');
    assert(woundOf(mk('ไขควงชุดใหญ่', 'tool')) === 'sharp' && woundOf(mk('ที่เปิดไวน์', 'tool')) === 'sharp', 'screwdriver and corkscrew stab');
    assert(woundOf(mk('ผ้าห่มขนสัตว์', 'cloth')) === 'smother' && woundOf(mk('ผ้าห่มไฟฟ้า', 'cloth')) === 'ligature', 'cloth smothers, an electric blanket strangles with its cord');
    assert(woundOf(mk('เชือกกระโดดยาว', 'rope')) === 'ligature' && woundOf(mk('ปืนลูกซองโบราณ', 'weapon')) === 'pierce' && woundOf(mk('ค้อนปอนด์', 'tool')) === 'blunt' && woundOf(mk('ยาเบื่อหนู', 'poison')) === 'poison' && woundOf(null) === 'hands', 'rope, gun, hammer, poison and bare hands classify as expected');
    assert(isConductive(mk('สายไฟพ่วงยาว', 'rope')) && isConductive(mk('สายไฟเก่าม้วนใหญ่', 'rope')) && !isConductive(mk('เชือกกระโดดยาว', 'rope')) && !isConductive(mk('เทปพันท่อและสายไฟ', 'rope')) && !isConductive(mk('สายไฟพ่วงยาว', 'tool')), 'only real cables conduct; tape and plain rope do not');
    for (const loc of LOCATIONS) {
      const items = loc.zones.flatMap((z) => z.items.map(([name, description, kind]) => ({ name, description, kind })));
      assert(!items.some((i) => i.kind === 'power') || items.some(isConductive), `mock location "${loc.name}" with a power panel has a real cable for the shock trap`);
    }
    const door = mockNarrateCase({ victim: { nickname: 'เหยื่อ' }, killer: { nickname: 'คนวาง' }, cause: 'trap', trapType: 'door', weapon: { name: 'ขวานดับเพลิง', kind: 'weapon' }, zone: { name: 'ห้องทดสอบ' }, day: 1, hour: 2, messy: false, moved: false, witnesses: [] });
    assert(/กลไกบานประตู/.test(door.bodyState) && !/สะดุด/.test(door.bodyState) && door.bodyState.includes('ขวานดับเพลิง'), 'the mock narrator describes a door trap as a door mechanism, not a trip wire');
    const direct = (weapon) => mockNarrateCase({ victim: { nickname: 'เหยื่อ' }, killer: { nickname: 'คนร้าย' }, cause: 'attack', trapType: null, weapon, zone: { name: 'ห้องทดสอบ' }, day: 1, hour: 2, messy: false, moved: false, witnesses: [] }).bodyState;
    assert(/ท้ายทอย/.test(direct(mk('เชิงเทียนเล็ก', 'weapon'))) && /ชายโครง/.test(direct(mk('ไขควงชุดใหญ่', 'tool'))) && /ปากและจมูก/.test(direct(mk('ผ้าห่มขนสัตว์', 'cloth'))) && !/รอยรัด/.test(direct(mk('ผ้าห่มขนสัตว์', 'cloth'))) && /รอยรัด/.test(direct(mk('ผ้าห่มไฟฟ้า', 'cloth'))), 'narrated bodies match the wound classifier');

    const g7 = new Game({ code: 'UNIT7', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids7 = ['w1-xxxxxxxx', 'w2-xxxxxxxx', 'w3-xxxxxxxx', 'w4-xxxxxxxx'];
    for (const [i, id] of ids7.entries()) g7.addPlayer({ id, name: `ของผสม ${i + 1}` });
    g7.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 1 });
    await g7.start(ids7[0]);
    g7.clearTimers();
    const [a7, b7, c7, d7] = ids7.map((id) => g7.players.get(id));
    const R7 = [...g7.zones.values()].find((z) => !z.locked && z.id !== g7.location.sleepZoneId && !z.items.some((i) => i.kind === 'power'));
    let P7 = [...g7.zones.values()].find((z) => !z.locked && z.items.some((i) => i.kind === 'power'));
    if (!P7) {
      P7 = [...g7.zones.values()].find((z) => z.items.some((i) => i.kind === 'power'));
      if (P7) P7.locked = false;
    }
    assert(R7 && P7, 'unit world has an open room without and one with a power panel');
    for (const p of [a7, b7, c7, d7]) {
      g7.charOf(p).ultimate.trait = 'none';
      p.zoneId = R7.id;
      p.outside = false;
    }
    g7.phase = PHASE.DAY;
    g7.step = STEP.ACT;
    // ชื่อกับดักตามสูตร + อาวุธของคดีคือชิ้นที่ทำร้ายจริง
    const axe = mk('ขวานดับเพลิง', 'weapon');
    const driver7 = { ...mk('ไขควงชุดใหญ่', 'tool'), description: 'ปลายแหลม' };
    a7.inventory = [axe, driver7];
    g7.do_craft(a7, { recipeId: 'door', itemId: axe.id, itemId2: driver7.id });
    const doorTrap = a7.inventory.find((i) => i.kind === 'trap');
    assert(doorTrap && doorTrap.name === 'ขวานดับเพลิงยึดกลไกประตูด้วยไขควงชุดใหญ่' && !/ผูก/.test(doorTrap.name) && doorTrap.weaponName === 'ขวานดับเพลิง', 'a door trap is named after its recipe, not "tied with"');
    R7.traps.push({ setterId: a7.id, item: a7.inventory.splice(a7.inventory.indexOf(doorTrap), 1)[0], turn: g7.turn, side: 'inside' });
    g7.triggerTrap(R7, R7.traps[0], d7);
    assert(!d7.alive && g7.cases.at(-1).trapType === 'door' && g7.cases.at(-1).weapon.name === 'ขวานดับเพลิง', 'the case weapon is the striking item, not the whole trap name');
    // กับดักไฟช็อต: ช่างเทคนิคกับเชือกธรรมดาประกอบไม่ได้ กับสายไฟจริงประกอบได้ และสายไฟคืออาวุธของคดี
    g7.charOf(a7).ultimate.trait = 'tech';
    const wrench = mk('ประแจเหล็กใหญ่', 'tool');
    const jumpRope = mk('เชือกกระโดดยาว', 'rope');
    const cable = mk('สายไฟพ่วงยาว', 'rope');
    a7.inventory = [wrench, jumpRope];
    const optsRope = g7.craftOptions(a7, P7);
    assert(optsRope.some((o) => o.recipeId === 'fall') && !optsRope.some((o) => o.recipeId === 'shock'), 'a plain rope cannot become a shock trap');
    a7.inventory = [wrench, cable];
    const optsCable = g7.craftOptions(a7, P7);
    assert(optsCable.some((o) => o.recipeId === 'shock') && optsCable.some((o) => o.recipeId === 'fall'), 'a real cable can become a shock trap (and still a trip wire)');
    g7.do_craft(a7, { recipeId: 'shock', itemId: wrench.id, itemId2: cable.id });
    const shock = a7.inventory.find((i) => i.kind === 'trap');
    assert(shock && shock.trapType === 'shock' && shock.name === 'สายไฟพ่วงยาวปอกเปลือยด้วยประแจเหล็กใหญ่' && shock.weaponName === 'สายไฟพ่วงยาว', 'a shock trap is named after the cable and the cable is its weapon');
    // ตรวจศพกับเล่าคดีใช้ตัวจำแนกเดียวกัน: เชิงเทียน = ของหนักทื่อ · ผ้าห่ม = อุดหายใจ
    g7.charOf(a7).ultimate.trait = 'none';
    const candle = mk('เชิงเทียนเล็ก', 'weapon');
    g7.killPlayer(b7, { cause: 'attack', killerId: a7.id, weapon: candle, zoneId: R7.id, outside: false, messy: false, witnesses: [] });
    g7.do_examine(a7, { victimId: b7.id });
    assert(/ของหนักทื่อ/.test(a7.log.at(-1).text) && !/มีคม/.test(a7.log.at(-1).text), 'examining a candlestick victim reports a blunt wound');
    const blanket = mk('ผ้าห่มขนสัตว์', 'cloth');
    g7.killPlayer(c7, { cause: 'attack', killerId: a7.id, weapon: blanket, zoneId: R7.id, outside: false, messy: false, witnesses: [] });
    g7.do_examine(a7, { victimId: c7.id });
    assert(/อุดหายใจ/.test(a7.log.at(-1).text) && !/รอยรัด/.test(a7.log.at(-1).text), 'examining a smothered victim reports suffocation, not a ligature');
  }
  // 11) แท็กย่อยของ: ของตัดสินจากสิ่งที่ทำได้จริง · ปืนมีกระสุนและเสียง · เข็มฉีดยาเป็นพาหะวางยา · ยาพิษฉุน/ไร้รส/เข้ากระแสเลือด · ทางออก/สะเดาะต้องใช้เครื่องมือจริง
  {
    const mk = (name, kind, description = '', extra = {}) => ({ id: `it_${name}_${kind}_${Math.random().toString(36).slice(2, 6)}`, name, description, kind, portable: true, hidden: false, isPart: false, ...extra });
    const has = (item, ...tags) => tags.every((t) => tagsOf(item).has(t));
    const none = (item) => tagsOf(item).size === 0;
    assert(has(mk('ขวานดับเพลิง', 'weapon'), 'sharp', 'heavy') && has(mk('ไขควงชุดใหญ่', 'tool', 'ปลายแหลม'), 'sharp', 'fastener') && has(mk('ปืนลูกซองโบราณ', 'weapon', 'ยังมีกระสุนสองนัด'), 'firearm') && has(mk('เข็มฉีดยา', 'tool'), 'injector'), 'axe, screwdriver, shotgun and syringe get the right tags');
    assert(none(mk('ไฟฉายเก่า', 'tool', 'แสงอ่อน ๆ แต่ยังใช้ได้')) && none(mk('สมุดลงทะเบียนผู้โดยสาร', 'tool', 'มีรายชื่อและเลขห้อง')) && none(mk('วิทยุภายในสถานี', 'tool')) && none(mk('กุญแจมือ', 'tool')) && none(mk('ไม้สกิมเมอร์ตักใบไม้', 'weapon', 'ด้ามอะลูมิเนียมยาว เบา')), 'flashlight, ledger, radio, handcuffs and a light pole carry no capability tags');
    assert(has(mk('สายไฟพ่วงยาว', 'rope'), 'conductive', 'cord') && has(mk('เทปพันท่อและสายไฟ', 'rope'), 'cord') && !has(mk('เทปพันท่อและสายไฟ', 'rope'), 'conductive'), 'cables conduct, tape only ties');
    assert(has(mk('น้ำยาฟอกขาว', 'poison'), 'pungent') && has(mk('น้ำยากันเยือกแข็ง', 'poison', 'รสหวาน ไม่มีสี'), 'tasteless') && has(mk('พิษแมงกะพรุนสกัด', 'poison'), 'bloodOnly'), 'poisons are tagged pungent / tasteless / blood-only');
    assert(parseAmmo('ยังมีกระสุนสองนัด') === 2 && parseAmmo('มีลูกฉมวก 3 ดอก') === 3 && parseAmmo('') === 2, 'ammo is read from the description');
    assert(attackBaseOf(mk('สมุดบันทึกเจ้าของบ้าน', 'tool'), 'none') === null && attackBaseOf(mk('ไม้สกิมเมอร์ตักใบไม้', 'weapon', 'ด้ามอะลูมิเนียมยาว เบา'), 'none').base === ATTACK.WEAPON_LIGHT && attackBaseOf(mk('ปืนลูกซองโบราณ', 'weapon', '', { ammo: 2 }), 'none').base === ATTACK.FIREARM && attackBaseOf(mk('ปืนลูกซองโบราณ', 'weapon', '', { ammo: 0 }), 'none').base === ATTACK.WEAPON_LIGHT && attackBaseOf(mk('ค้อนปอนด์', 'tool'), 'none').base === ATTACK.WEAPON_BASE.tool, 'attack odds follow the tags: junk cannot attack, light weapons 50%, loaded gun 85%, empty gun is a club');
    const poisonItem = mk('ยาสลบสัตว์ทดลอง', 'poison');
    assert(attackBaseOf(poisonItem, 'none', false) === null && attackBaseOf(poisonItem, 'none', true).base === ATTACK.POISON_INJECT && attackBaseOf(poisonItem, 'medical', false).base === ATTACK.POISON_MEDICAL, 'direct poisoning needs a syringe unless you are medical');
    assert(poisonNoticeChance('none', ['pungent']) === 0.6 && poisonNoticeChance('medical', ['tasteless']) === 0.4 && poisonNoticeChance('none', []) === 0.15 && poisonNoticeChance('detective', ['pungent']) === 0.9, 'poison notice chance depends on the poison');
    for (const loc of LOCATIONS) {
      const items = loc.zones.flatMap((z) => z.items.map(([name, description, kind]) => ({ name, description, kind })));
      assert(items.some((i) => i.kind === 'tool' && tagsOf(i).has('fastener')), `mock location "${loc.name}" has a hand tool for door traps, repairs and tech lockpicking`);
      assert(items.some((i) => tagsOf(i).has('heavy')), `mock location "${loc.name}" has something heavy`);
      assert(!items.some((i) => i.name === 'เครื่องตัดเนื้อ' && i.kind !== 'fixture'), 'the meat slicer is bolted down');
    }
    assert(/รอยเข็ม/.test(mockNarrateCase({ victim: { nickname: 'เหยื่อ' }, killer: { nickname: 'คนร้าย' }, cause: 'attack', trapType: null, weapon: { name: 'ยาสลบสัตว์ทดลอง (ฉีดด้วยเข็มฉีดยา)', kind: 'poison' }, zone: { name: 'ห้องทดสอบ' }, day: 1, hour: 1, messy: false, moved: false, witnesses: [] }).bodyState), 'an injected victim shows a needle mark');

    const g8 = new Game({ code: 'UNIT8', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids8 = ['t1-xxxxxxxx', 't2-xxxxxxxx', 't3-xxxxxxxx', 't4-xxxxxxxx', 't5-xxxxxxxx'];
    for (const [i, id] of ids8.entries()) g8.addPlayer({ id, name: `แท็ก ${i + 1}` });
    g8.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 1 });
    await g8.start(ids8[0]);
    g8.clearTimers();
    const [a8, b8, c8, d8, e8] = ids8.map((id) => g8.players.get(id));
    const zones8 = [...g8.zones.values()];
    let F8 = zones8.find((z) => !z.locked && z.items.some((i) => i.kind === 'food'));
    if (!F8) {
      F8 = zones8.find((z) => z.items.some((i) => i.kind === 'food'));
      F8.locked = false;
    }
    const open8 = zones8.filter((z) => !z.locked && z.id !== g8.location.sleepZoneId && z.id !== F8.id);
    const R8 = open8.find((z) => !z.items.some((i) => i.kind === 'power')) || open8[0];
    const far8 = open8.find((z) => z.id !== R8.id) || g8.zones.get(g8.location.sleepZoneId);
    assert(R8 && F8 && far8 && far8.id !== R8.id, 'unit world has an open room, a food room and a third room');
    for (const p of [a8, b8, c8, d8, e8]) {
      g8.charOf(p).ultimate.trait = 'none';
      p.zoneId = R8.id;
      p.outside = false;
    }
    e8.zoneId = far8.id;
    g8.phase = PHASE.DAY;
    g8.step = STEP.ACT;
    const gunsInWorld = zones8.flatMap((z) => z.items).filter((i) => tagsOf(i).has('firearm'));
    assert(gunsInWorld.every((i) => Number.isInteger(i.ammo) && i.ammo > 0), 'every firearm starts with ammo');
    // สูตรดูแท็ก ไม่ใช่แค่ชนิด
    const notebook = mk('สมุดบันทึกเจ้าของบ้าน', 'tool');
    const rope8 = mk('เชือกปีนเขา', 'rope');
    const ball = mk('ลูกบอลโบว์ลิ่งเก่า', 'weapon', 'หนักมาก');
    const driver = mk('ไขควงชุดใหญ่', 'tool', 'ปลายแหลม');
    const torch8 = mk('ไฟฉายเก่า', 'tool');
    const skimmer = mk('ไม้สกิมเมอร์ตักใบไม้', 'weapon', 'ด้ามอะลูมิเนียมยาว เบา');
    const gun = mk('ปืนลูกซองโบราณ', 'weapon', 'ยังมีกระสุนสองนัด', { ammo: 2 });
    const recipes = (inv) => {
      a8.inventory = inv;
      return g8.craftOptions(a8, R8).map((o) => o.recipeId);
    };
    assert(recipes([notebook, rope8]).length === 0, 'a notebook and a rope make nothing');
    assert(recipes([ball, rope8]).includes('blade') && recipes([ball, rope8]).includes('fall'), 'a bowling ball and a rope can swing or drop');
    assert(recipes([gun, driver]).includes('door') && recipes([gun, rope8]).length === 0, 'a loaded gun can be rigged to a door but not swung on a rope');
    assert(recipes([mk('ปืนลูกซองโบราณ', 'weapon', '', { ammo: 0 }), driver]).length === 0, 'an empty gun cannot be rigged');
    assert(recipes([skimmer, driver]).length === 0 && recipes([ball, torch8]).length === 0, 'a light pole or a flashlight cannot make a door trap');
    // กับดักประตูด้วยปืน: ลั่นใส่คนเปิด อาวุธของคดีมีแท็กปืน ตรวจศพบอกว่าถูกยิง
    a8.inventory = [gun, driver];
    g8.do_craft(a8, { recipeId: 'door', itemId: gun.id, itemId2: driver.id });
    const gunTrap = a8.inventory.find((i) => i.kind === 'trap');
    assert(gunTrap && gunTrap.wound === 'pierce' && gunTrap.strikerTags.includes('firearm') && gunTrap.weaponName === gun.name, 'a gun door trap remembers that it shoots');
    R8.traps.push({ setterId: a8.id, item: a8.inventory.splice(a8.inventory.indexOf(gunTrap), 1)[0], turn: g8.turn, side: 'inside' });
    g8.triggerTrap(R8, R8.traps[0], d8);
    assert(!d8.alive && /ลั่น/.test(d8.log.at(-1).text) && g8.cases.at(-1).weapon.tags.includes('firearm'), 'the gun trap fires at the victim');
    g8.do_examine(a8, { victimId: d8.id });
    assert(/ยิง/.test(a8.log.at(-1).text), 'examining the victim of a gun trap reports a gunshot');
    // ลงมือด้วยปืน: กระสุนลดทุกครั้ง และคนห้องอื่นได้ยิน (บังคับให้พลาด จะได้ไม่มีใครตาย)
    const gun2 = mk('ปืนลูกซองสำรอง', 'weapon', '', { ammo: 2 });
    a8.inventory = [gun2];
    assert(g8.bestWeapon(a8) === gun2 && g8.attackBreakdown(a8, b8, gun2, 0, R8).parts[0].value === ATTACK.FIREARM, 'a loaded gun is the best weapon at 85%');
    const e8Logs = e8.log.length;
    const rr8 = Math.random;
    Math.random = () => 0.99;
    g8.do_attack(a8, { targetId: b8.id });
    Math.random = rr8;
    assert(a8.alive && b8.alive && gun2.ammo === 1 && e8.log.length > e8Logs && /เสียงปืน/.test(e8.log.at(-1).text), 'a shot spends a round and is heard in other rooms');
    // ยาพิษ: ไม่มีเข็ม = ลงมือตรงไม่ได้ · มีเข็ม = ฉีด
    const sleep8 = mk('ยาสลบสัตว์ทดลอง', 'poison');
    const needle = mk('เข็มฉีดยา', 'tool');
    a8.inventory = [sleep8];
    assert(g8.bestWeapon(a8) === null, 'without a syringe an ordinary player cannot poison someone directly');
    a8.inventory = [sleep8, needle];
    assert(g8.bestWeapon(a8) === sleep8 && /ฉีด/.test(g8.attackBreakdown(a8, c8, sleep8, 0, R8).parts[0].label), 'with a syringe the poison is injected');
    g8.killPlayer(c8, { cause: 'attack', killerId: a8.id, weapon: { name: 'ยาสลบสัตว์ทดลอง (ฉีดด้วยเข็มฉีดยา)', kind: 'poison' }, zoneId: R8.id, outside: false, messy: false, witnesses: [] });
    g8.do_examine(a8, { victimId: c8.id });
    assert(/รอยเข็ม/.test(a8.log.at(-1).text), 'examining an injected victim shows the needle mark');
    // อาหาร: พิษที่ต้องเข้ากระแสเลือดผสมไม่ได้ · ยาฉุนผสมได้แต่สังเกตง่าย
    a8.zoneId = F8.id;
    a8.inventory = [mk('พิษแมงกะพรุนสกัด', 'poison')];
    assert(!g8.availableActions(a8).some((x) => x.type === 'poisonFood'), 'blood-only venom cannot be mixed into food');
    a8.inventory = [mk('น้ำยาฟอกขาว', 'poison')];
    const bleachOpt = g8.availableActions(a8).find((x) => x.type === 'poisonFood');
    assert(bleachOpt && /60%/.test(bleachOpt.desc), 'bleach can be mixed but the option warns it is easy to notice');
    g8.do_poisonFood(a8, { itemId: a8.inventory[0].id });
    assert(F8.items.find((i) => i.kind === 'food')?.poisoned?.poisonTags?.includes('pungent'), 'the poisoned food remembers the poison tags');
    // สะเดาะด้วยเครื่องมือ (ช่างเทคนิค) ต้องเป็นเครื่องมือช่าง · ทางออก: ทุบต้องของหนัก/อาวุธมีคม
    g8.charOf(a8).ultimate.trait = 'tech';
    a8.inventory = [notebook];
    assert(!g8.doorMeans(a8), 'a tech cannot pick a lock with a notebook');
    a8.inventory = [driver];
    assert(g8.doorMeans(a8)?.method === 'pick', 'a tech picks a lock with a screwdriver');
    assert(canBreachWith(ball) && canBreachWith(mk('ขวานดับเพลิง', 'weapon')) && !canBreachWith(notebook) && !canBreachWith(driver) && !canBreachWith(skimmer), 'only heavy things or sharp weapons can breach an exit');
  }
  // 12) ระบบสลบ: มือเปล่า = สลบ · คนสลบเลือกอะไรไม่ได้ ของหล่น ถูกลงมือสำเร็จแน่นอน · ยาสลบในอาหาร = สลบ · สวนกลับด้วยมือเปล่า = คนลงมือสลบ · ละเลยภารกิจ = สลบ · ฟื้นตามชั่วโมง
  {
    const mk = (name, kind, description = '', extra = {}) => ({ id: `ko_${name}_${Math.random().toString(36).slice(2, 6)}`, name, description, kind, portable: true, hidden: false, isPart: false, ...extra });
    const g9 = new Game({ code: 'UNIT9', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids9 = ['k1-xxxxxxxx', 'k2-xxxxxxxx', 'k3-xxxxxxxx', 'k4-xxxxxxxx', 'k5-xxxxxxxx'];
    for (const [i, id] of ids9.entries()) g9.addPlayer({ id, name: `สลบ ${i + 1}` });
    g9.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g9.start(ids9[0]);
    g9.clearTimers();
    const [a9, b9, c9, d9, e9] = ids9.map((id) => g9.players.get(id));
    const zones9 = [...g9.zones.values()];
    let F9 = zones9.find((z) => !z.locked && z.items.some((i) => i.kind === 'food'));
    if (!F9) { F9 = zones9.find((z) => z.items.some((i) => i.kind === 'food')); F9.locked = false; }
    const R9 = zones9.find((z) => z.id !== g9.location.sleepZoneId && z.id !== F9.id && !z.locked);
    for (const p of [a9, b9, c9, d9, e9]) { g9.charOf(p).ultimate.trait = 'none'; p.zoneId = R9.id; p.outside = false; }
    e9.zoneId = F9.id;
    g9.phase = PHASE.DAY;
    g9.step = STEP.ACT;
    const rr9 = Math.random;
    const seq = (vals) => { let i = 0; Math.random = () => (i < vals.length ? vals[i++] : 0.5); };
    // (i) มือเปล่าสำเร็จ → สลบ ไม่ตาย ของหล่นครึ่งหนึ่ง
    a9.inventory = [];
    b9.inventory = [mk('ขวานทดสอบ', 'weapon', 'คมกริบ'), mk('เชือกทดสอบ', 'rope')];
    const bd9 = g9.attackBreakdown(a9, b9, null, 0, R9);
    assert(bd9.lethal === 0 && /มือเปล่า/.test(bd9.parts[0].label), 'bare hands have zero lethality');
    seq([0, 0.99, 0.99, 0]); // สำเร็จ · ไม่เลอะเทอะ · (lethal 0 → ไม่ต้องสุ่ม) · สลบ 1 ชม.
    g9.do_attack(a9, { targetId: b9.id });
    Math.random = rr9;
    assert(b9.alive && b9.ko && b9.ko.hours >= 1 && b9.ko.hours <= 3 && !g9.bodies.has(b9.id), 'a bare-handed hit knocks the target out instead of killing');
    assert(b9.inventory.length === 1 && R9.items.some((i) => /ทดสอบ/.test(i.name)), 'half of the victim\'s items drop in the room');
    assert(b9.log.some((l) => /หมดสติ/.test(l.text)) && a9.log.some((l) => /สลบ/.test(l.text)), 'both sides are told about the knockout');
    // (ii) คนสลบเลือกอะไรไม่ได้ และมีแอ็กชันว่างเปล่า
    g9.step = STEP.MOVE;
    let threw9 = false;
    try { g9.chooseMove(b9.id, R9.id); } catch { threw9 = true; }
    assert(threw9, 'a knocked-out player cannot choose a room');
    g9.step = STEP.ACT;
    threw9 = false;
    try { g9.chooseAction(b9.id, { type: 'rest' }); } catch { threw9 = true; }
    assert(threw9 && g9.availableActions(b9).length === 0, 'a knocked-out player cannot act and has no actions');
    // (iii) ลงมือกับคนสลบด้วยของฆ่าได้ = ตายแน่ (ไม่ต้องสุ่ม) · ด้วยมือเปล่า = สลบต่อ
    const atkB = g9.availableActions(c9).find((x) => x.type === 'attack' && x.targetId === b9.id);
    assert(atkB && /สลบอยู่/.test(atkB.label) && /สำเร็จแน่นอน/.test(atkB.desc), 'attacking a knocked-out player is shown as a sure thing');
    const hoursBefore = b9.ko.hours;
    c9.inventory = [];
    seq([0.99, 0.99, 0.99, 0.99]);
    g9.do_attack(c9, { targetId: b9.id });
    Math.random = rr9;
    assert(b9.alive && b9.ko.hours > hoursBefore, 'bare hands on a knocked-out player just extend the knockout');
    c9.inventory = [mk('มีดทดสอบ', 'weapon', 'คมกริบ')];
    seq([0.99, 0.99, 0.99, 0.99]);
    g9.do_attack(c9, { targetId: b9.id });
    Math.random = rr9;
    assert(!b9.alive && g9.cases.at(-1).killerId === c9.id && g9.cases.at(-1).victimId === b9.id, 'a blade on a knocked-out player kills without a roll');
    // (iv) สวนกลับด้วยมือเปล่า → คนลงมือสลบ (ไม่เป็นคดี) · สวนกลับด้วยมีด → คนลงมือตาย (คดีป้องกันตัว อาวุธ = มีด)
    d9.inventory = [];
    a9.inventory = [];
    seq([0.99, 0, 0.99, 0]); // พลาด · สวนกลับ · (lethal 0) · สลบ 1 ชม.
    g9.do_attack(a9, { targetId: d9.id });
    Math.random = rr9;
    assert(a9.alive && a9.ko && !g9.cases.some((c) => c.victimId === a9.id), 'an unarmed counter knocks the attacker out without a case');
    a9.ko = null;
    d9.inventory = [mk('มีดสวนกลับ', 'weapon', 'คมกริบ')];
    assert(g9.counterChance(d9) === Math.min(0.9, ATTACK.COUNTER + ATTACK.COUNTER_ARMED_BONUS), 'an armed target counters more often');
    seq([0.99, 0, 0]); // พลาด · สวนกลับ · ฆ่า
    g9.do_attack(a9, { targetId: d9.id });
    Math.random = rr9;
    const def9 = g9.cases.at(-1);
    assert(!a9.alive && def9.cause === 'defense' && def9.killerId === d9.id && def9.weapon?.name === 'มีดสวนกลับ', 'an armed counter can kill and the case records the defender\'s weapon');
    // (v) ยาสลบในอาหาร = สลบ ไม่ตาย ไม่เป็นคดี
    e9.inventory = [mk('ยานอนหลับขนาดแรง', 'poison')];
    const cases9 = g9.cases.length;
    g9.do_poisonFood(e9, { itemId: e9.inventory[0].id });
    c9.zoneId = F9.id;
    seq([0.99, 0]); // ไม่สังเกตเห็น · สลบ 1 ชม.
    g9.do_eat(c9);
    Math.random = rr9;
    assert(c9.alive && c9.ko && g9.cases.length === cases9 && c9.log.some((l) => /หมดสติ/.test(l.text)), 'sedative-laced food knocks the eater out instead of killing');
    // (vi) ละเลยภารกิจ = สลบ (ไม่บังคับทำ) · ฟื้นเมื่อครบชั่วโมง
    c9.ko = null;
    Object.assign(CONFIG, { OBJECTIVES: true });
    c9.objectives = [{ id: 'obj-test', type: 'visit', zoneId: R9.id, done: false, forgiven: false, hours: 3, deadlineTurn: g9.turn, assignedTurn: g9.turn - 3, text: 'ไปที่ห้องทดสอบ' }];
    g9.step = STEP.MOVE;
    seq([0]);
    g9.enforceObjectives();
    Math.random = rr9;
    assert(c9.ko && c9.objectives[0].done && c9.objectives[0].failed && !c9.forced && g9.moves.get(c9.id) === c9.zoneId, 'an ignored objective knocks the player out and keeps them in place');
    assert(c9.ko.since === g9.turn - 1, 'a punishment at the start of the hour counts that hour as unconscious');
    // เวลาภารกิจหยุดเดินตอนสลบ และคนสลบไม่ได้ภารกิจใหม่
    e9.ko = null;
    e9.objectives = [{ id: 'obj-e', type: 'visit', zoneId: R9.id, done: false, forgiven: false, hours: 3, deadlineTurn: g9.turn + 2, assignedTurn: g9.turn - 1, text: 'ไปที่ห้องทดสอบ' }];
    g9.knockOut(e9, 2, { cause: 'attack' });
    assert(e9.objectives[0].deadlineTurn === g9.turn + 4, 'objective deadlines are pushed back by the knockout hours');
    c9.ko = { hours: 1, since: g9.turn - 1, cause: 'attack', by: null };
    g9.tickKo();
    assert(!c9.ko && c9.log.some((l) => /ฟื้นขึ้นมา/.test(l.text)), 'the knockout wears off after its hours');
    // (vii) นักสู้ต่อยฆ่าได้ 5% · คนสลบโหวตไม่ได้
    e9.ko = null;
    c9.ko = null;
    c9.zoneId = e9.zoneId;
    c9.outside = e9.outside = false;
    g9.phase = PHASE.DAY;
    g9.step = STEP.ACT;
    g9.charOf(e9).ultimate.trait = 'combat';
    e9.inventory = [];
    const bdC = g9.attackBreakdown(e9, c9, null, 0, g9.zones.get(e9.zoneId));
    assert(bdC.lethal === ATTACK.LETHALITY.unarmedCombat && /ฆ่าได้ 5%/.test(bdC.parts[0].label), 'a combat trait can kill bare-handed at 5%');
    seq([0, 0.99, 0.04, 0.5]); // สำเร็จ · ไม่เลอะเทอะ · โชคร้าย 4% < 5% → ตาย
    g9.do_attack(e9, { targetId: c9.id });
    Math.random = rr9;
    assert(!c9.alive && g9.cases.at(-1).killerId === e9.id && g9.cases.at(-1).weapon === null, 'a 5% bare-handed kill by a fighter is recorded without a weapon');
    e9.ko = { hours: 1, since: g9.turn, cause: 'attack', by: null };
    g9.phase = PHASE.TRIAL;
    g9.votes = new Map();
    g9.confirmedVotes = new Set();
    let threwV = false;
    try { g9.castVote(e9.id, d9.id); } catch { threwV = true; }
    assert(threwV, 'a knocked-out player cannot vote');
    assert(g9.viewFor(e9.id).players.find((p) => p.id === e9.id).voteConfirmed === true, 'a knocked-out player counts as done voting');
    Object.assign(CONFIG, { OBJECTIVES: false });
  }
  // 13) ห้อง = ผู้เล่น × 2: โหมด mock ตัด/เติมห้องให้พอดี ของชนิดจำเป็นยังครบ ชื่อห้อง/ของไม่ซ้ำ
  {
    assert(roomCountFor(3) === 6 && roomCountFor(6) === 12 && roomCountFor(15) === 30 && roomCountFor(40) === ROOMS.MAX, 'room count is players × 2 within 6–30');
    const required = ['food', 'power', 'lockpick', 'rope', 'tool', 'weapon', 'poison'];
    for (const n of [6, 8, 12, 20, 30]) {
      const loc = mockLocation({ zoneCount: n });
      assert(loc.zones.length === n, `mock location has ${n} rooms (${loc.zones.length})`);
      const names = loc.zones.map((z) => z.name);
      assert(new Set(names).size === names.length, 'room names are unique');
      const items = loc.zones.flatMap((z) => z.items);
      const itemNames = items.map((i) => i.name);
      assert(new Set(itemNames).size === itemNames.length, `item names are unique in a ${n}-room map`);
      for (const k of required) assert(items.some((i) => i.kind === k), `${n}-room map still has a ${k}`);
      assert(loc.sleepZoneId === 'z1' && loc.zones[0].id === 'z1' && loc.zones.every((z, i) => z.id === `z${i + 1}`), 'zone ids stay sequential');
    }
    assert(EXTRA_ROOMS.length >= 22, 'the extra room pool can fill a 30-room map from an 8-room template');
    for (const r of EXTRA_ROOMS) for (const [name, description, kind] of r.items) assert(['weapon', 'tool', 'poison', 'rope', 'cloth', 'food', 'power', 'fixture', 'lockpick'].includes(kind), `extra room item kind valid (${name}: ${kind})`);
    assert(EXTRA_ROOMS.flatMap((r) => r.items).some(([name, description, kind]) => kind === 'poison' && tagsOf({ name, description, kind }).has('sedative')), 'the extra pool has a sedative');
    assert(EXTRA_ROOMS.flatMap((r) => r.items).some(([name, description, kind]) => kind === 'tool' && tagsOf({ name, description, kind }).has('fastener')), 'the extra pool has hand tools');
    assert(LOCKS.lockedZones(5) === 1 && LOCKS.lockedZones(11) === 2 && LOCKS.lockedZones(29) === 4 && LOCKS.maxKeys(7) === 2 && LOCKS.maxKeys(29) === 4, 'locked rooms and keys scale with the map');
  }
  // 14) ทางออก 4–5 ขั้น: เส้นทางซ่อมต้องประกอบชิ้นส่วนก่อน (แอ็กชันประกอบ) · ขั้นถาวรติดไว้ · คนที่ลงมือพร้อมกันนับของรวมกัน · บอท/ตัวจำลองรู้ว่าพร้อมเมื่อไร
  {
    const g10 = new Game({ code: 'UNIT10', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids10 = ['r1-xxxxxxxx', 'r2-xxxxxxxx', 'r3-xxxxxxxx'];
    for (const [i, id] of ids10.entries()) g10.addPlayer({ id, name: `ซ่อม ${i + 1}` });
    g10.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g10.start(ids10[0]);
    g10.clearTimers();
    const [a10, b10] = ids10.map((id) => g10.players.get(id));
    for (const id of ids10) g10.charOf(g10.players.get(id)).ultimate.trait = 'none'; // แต้มลงแรง 1 ต่อครั้ง
    for (const x of g10.exits.values()) assert(x.steps.length >= 4 && x.steps.length <= 5 && x.steps.filter((s) => s.kind === 'force').length === 1, `every exit has 4–5 steps incl. one force step (${x.route}: ${x.steps.length})`);
    // บังคับให้มีทางออกแบบซ่อม (ถ้าสุ่มไม่ได้ สร้างขึ้นมาเอง)
    let rx = [...g10.exits.values()].find((x) => x.route === 'repair');
    if (!rx) {
      rx = [...g10.exits.values()][0];
      rx.route = 'repair';
      rx.steps = [{ id: 'assembly', kind: 'assembly', done: false, progress: 0, needed: 0 }, { id: 'key', kind: 'key', done: false, progress: 0, needed: 0 }, { id: 'tool', kind: 'tool', done: false, progress: 0, needed: 0 }, { id: 'force', kind: 'force', done: false, progress: 0, needed: 2 }];
      rx.items = rx.items.filter((i) => i.role === 'key');
      if (!rx.items.length) {
        const k = { id: `${rx.id}_key9`, name: 'กุญแจทดสอบ', description: '', kind: 'key', portable: true, hidden: false, isPart: true, exitId: rx.id, role: 'key' };
        g10.zones.get(rx.zoneId).items.push(k);
        rx.items.push({ id: k.id, name: k.name, role: 'key' });
      }
      rx.assembly = { name: 'ชุดชิ้นส่วนทดสอบ (ประกอบแล้ว)', itemId: `${rx.id}_assembly`, partIds: [] };
      for (const n of [1, 2]) {
        const part = { id: `${rx.id}_part9${n}`, name: `ชิ้นส่วนทดสอบ ${n}`, description: '', kind: 'part', portable: true, hidden: false, isPart: true, exitId: rx.id, role: 'part' };
        g10.zones.get(rx.zoneId).items.push(part);
        rx.items.push({ id: part.id, name: part.name, role: 'part' });
        rx.assembly.partIds.push(part.id);
      }
    }
    const allItems10 = [...g10.zones.values()].flatMap((z) => z.items);
    const parts = rx.assembly.partIds.map((id) => allItems10.find((i) => i.id === id));
    const key10 = allItems10.find((i) => i.exitId === rx.id && i.role === 'key');
    assert(parts.every(Boolean) && key10, 'the repair exit has two parts and a key hidden somewhere');
    for (const it of [...parts, key10]) { const zz = [...g10.zones.values()].find((z) => z.items.includes(it)); zz.items.splice(zz.items.indexOf(it), 1); }
    a10.zoneId = rx.zoneId;
    a10.outside = false;
    rx.discoveredBy.add(a10.id);
    g10.phase = PHASE.DAY;
    g10.step = STEP.ACT;
    a10.inventory = [parts[0]];
    assert(!g10.availableActions(a10).some((x) => x.type === 'craft' && x.recipeId === 'assembly'), 'one part alone cannot be assembled');
    a10.inventory = [parts[0], parts[1]];
    const asmAct = g10.availableActions(a10).find((x) => x.type === 'craft' && x.recipeId === 'assembly');
    assert(asmAct && !asmAct.exitId && rx.assembly.partIds.includes(asmAct.itemId) && rx.assembly.partIds.includes(asmAct.itemId2), 'holding both parts offers the assembly craft (without leaking the exit id)');
    assert(!exitReadyFor(g10, a10, rx), 'not ready before assembling');
    g10.do_craft(a10, asmAct);
    const asm = a10.inventory.find((i) => i.role === 'assembly');
    assert(asm && a10.inventory.length === 1 && rx.items.some((i) => i.role === 'assembly'), 'assembling consumes both parts and yields one assembled item');
    // ลงมือครั้งแรกด้วยเครื่องมือ (ถอดน็อต + ลงแรง) แล้วค่อยเอากุญแจมา
    const tool10 = { id: 'tool10', name: 'ประแจทดสอบ', description: 'เครื่องมือช่างหนัก', kind: 'tool', portable: true, hidden: false, isPart: false };
    b10.zoneId = rx.zoneId;
    b10.outside = false;
    b10.inventory = [tool10];
    assert(exitUsefulFor(g10, b10, rx) && !exitReadyFor(g10, b10, rx), 'a player with only a hand tool can make progress but is not ready');
    assert(!resolveExits(g10, [{ p: b10, a: { exitId: rx.id } }]) && rx.steps.find((s) => s.kind === 'tool').done && rx.steps.find((s) => s.kind === 'force').progress === 1, 'the first attempt unbolts and adds one force point');
    assert(resolveExits(g10, [{ p: b10, a: { exitId: rx.id } }]) === false && rx.steps.find((s) => s.kind === 'force').done, 'the second attempt completes the force step');
    a10.inventory = [asm, key10];
    assert(exitReadyFor(g10, a10, rx), 'assembly + key with the permanent steps done = ready');
    const ended10 = resolveExits(g10, [{ p: a10, a: { exitId: rx.id } }]);
    assert(ended10 && rx.open && g10.endReason === 'escape', 'assembly + key open the repaired exit');
  }
  // 15) หยิบ/วาง/ซ่อนของทำได้ทันที ไม่กินชั่วโมง (ช่วงเลือกแอ็กชันและช่วงพัก) · ไม่อยู่ในรายการแอ็กชันหลัก · ข้างนอก/สลบ/ขั้นเลือกห้องทำไม่ได้
  {
    const g11 = new Game({ code: 'UNIT11', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids11 = ['i1-xxxxxxxx', 'i2-xxxxxxxx', 'i3-xxxxxxxx'];
    for (const [i, id] of ids11.entries()) g11.addPlayer({ id, name: `ของ ${i + 1}` });
    g11.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0 });
    await g11.start(ids11[0]);
    g11.clearTimers();
    const [a11, b11] = ids11.map((id) => g11.players.get(id));
    const room11 = [...g11.zones.values()].find((z) => z.id !== g11.location.sleepZoneId && z.items.some((i) => i.portable && !i.hidden));
    for (const p of [a11, b11]) {
      p.zoneId = room11.id;
      p.outside = false;
      p.inventory = [];
    }
    g11.phase = PHASE.DAY;
    g11.step = STEP.MOVE;
    let threw11 = false;
    try { g11.instantItemAction(a11.id, g11.itemActions(a11)[0]); } catch { threw11 = true; }
    assert(threw11, 'items cannot be taken before entering the room (move step)');
    g11.step = STEP.ACT;
    const main = g11.availableActions(a11);
    assert(!main.some((x) => ['take', 'hide', 'drop'].includes(x.type)) && main.some((x) => x.type === 'search'), 'take/hide/drop are no longer hour-spending actions');
    const takeAct = g11.itemActions(a11).find((x) => x.type === 'take' && !x.disabled);
    assert(takeAct, 'the room offers an instant take');
    g11.instantItemAction(a11.id, takeAct);
    assert(a11.inventory.length === 1 && a11.inventory[0].id === takeAct.itemId && !g11.actions.has(a11.id), 'taking is instant and does not count as the hour\'s action');
    const dropAct = g11.itemActions(a11).find((x) => x.type === 'drop');
    g11.instantItemAction(a11.id, dropAct);
    assert(a11.inventory.length === 0 && room11.items.some((i) => i.id === dropAct.itemId && !i.hidden), 'dropping is instant too');
    g11.instantItemAction(a11.id, g11.itemActions(a11).find((x) => x.type === 'take' && !x.disabled));
    g11.chooseAction(a11.id, { type: 'search' });
    assert(g11.actions.get(a11.id)?.type === 'search' && a11.inventory.length === 1, 'after taking, the player still chooses a main action');
    g11.chooseAction(b11.id, { type: 'rest' });
    for (const p of g11.alivePlayers()) if (!g11.actions.has(p.id)) g11.chooseAction(p.id, { type: 'rest' });
    assert(g11.step === STEP.REPORT, 'the hour resolved into the rest step');
    const hideAct = g11.itemActions(a11).find((x) => x.type === 'hide');
    assert(hideAct, 'items can still be handled during the rest step');
    const invBefore11 = a11.inventory.length; // การสำรวจเมื่อครู่อาจหยิบของทางออกให้อัตโนมัติ
    g11.instantItemAction(a11.id, hideAct);
    assert(a11.inventory.length === invBefore11 - 1 && room11.items.some((i) => i.id === hideAct.itemId && i.hidden), 'hiding during the rest step is instant');
    a11.ko = { hours: 1, since: g11.turn, cause: 'attack', by: null };
    assert(g11.itemActions(a11).length === 0, 'a knocked-out player has no item actions');
    a11.ko = null;
    a11.outside = true;
    assert(g11.itemActions(a11).length === 0, 'waiting outside a locked door offers no item actions');
    a11.outside = false;
  }
  // 16) โหมดวิญญาณ: ผีคุยแชทผีกันได้ (คนเป็นไม่เห็นจนเกมจบ) · ตามดูคนเป็นได้ทีละคน (สมุดบันทึก ของ ภารกิจ) · เห็นทุกห้องและเหตุการณ์จริง · คนเป็นตามดูไม่ได้ ผีตามดูผีไม่ได้ · ผีบอททักทายและบ่นเหตุการณ์
  {
    const g12 = new Game({ code: 'UNIT12', ai: createAI({ forceMock: true, log: quietLog }), log: quietLog });
    const ids12 = ['s1-xxxxxxxx', 's2-xxxxxxxx', 's3-xxxxxxxx'];
    for (const [i, id] of ids12.entries()) g12.addPlayer({ id, name: `ผี ${i + 1}` });
    g12.setBots(ids12[0], 1);
    g12.onChange = () => {};
    Object.assign(CONFIG, { REVIVE_CHANCE: 0, OBJECTIVES: false, LOCKED_ZONES: 0, BOT_GHOST_CHAT: true });
    await g12.start(ids12[0]);
    g12.clearTimers();
    const [a12, b12, c12] = ids12.map((id) => g12.players.get(id));
    const bot12 = [...g12.players.values()].find((p) => p.isBot);
    g12.phase = PHASE.DAY;
    g12.step = STEP.ACT;
    let threw12 = false;
    try { g12.setFollow(b12.id, c12.id); } catch { threw12 = true; }
    assert(threw12, 'a living player cannot follow anyone');
    assert(!g12.viewFor(b12.id).me.spectator, 'the living get no ghost view');
    // บอทตายก่อน (ผีบอทรับรู้ตัวเอง) แล้ว a12 ตายตามมา
    bot12.alive = false; bot12.fate = 'victim'; bot12.deathCause = 'attack';
    g12.botGhostChat();
    assert(!g12.chat.some((m) => m.ghost), 'bot ghosts stay silent while no human ghost exists');
    a12.alive = false; a12.fate = 'victim'; a12.deathCause = 'attack';
    g12.sendChat(a12.id, 'บูว์');
    const ghostMsg = g12.chat.at(-1);
    assert(ghostMsg.ghost && ghostMsg.playerId === a12.id, 'a dead player sends ghost chat');
    g12.sendChat(b12.id, 'ใครพูดน่ะ');
    const lv = g12.viewFor(b12.id);
    assert(!lv.chat.some((m) => m.ghost) && lv.chat.some((m) => m.playerId === b12.id), 'the living see normal chat but not ghost chat');
    const gv = g12.viewFor(a12.id);
    assert(gv.chat.some((m) => m.ghost) && gv.chat.some((m) => m.playerId === b12.id) && gv.me.spectator, 'ghosts see both ghost chat and normal chat');
    threw12 = false;
    try { g12.setFollow(a12.id, bot12.id); } catch { threw12 = true; }
    assert(threw12 && !a12.follow, 'ghosts cannot follow another dead player');
    g12.setFollow(a12.id, b12.id);
    const sp12 = g12.viewFor(a12.id).me.spectator;
    assert(sp12.watching?.id === b12.id && Array.isArray(sp12.watching.log) && Array.isArray(sp12.watching.inventory) && Array.isArray(sp12.watching.objectives) && Array.isArray(sp12.watching.exitsKnown), 'following a living player shows their notebook, items, objectives and known exits');
    assert(sp12.rooms.length === g12.zones.size && sp12.rooms.some((r) => r.people.some((n) => n.includes(g12.nick(b12)))), 'the ghost map lists every room and who is in it');
    assert(sp12.ghosts.some((x) => x.id === bot12.id) && !sp12.ghosts.some((x) => x.id === a12.id), 'other ghosts are listed (not yourself)');
    g12.recordEvent(`${g12.nick(b12)}ฆ่า${g12.nick(c12)}ที่ห้องทดสอบ`);
    assert(g12.viewFor(a12.id).me.spectator.feed.some((e) => /ฆ่า/.test(e.text)), 'ghosts see the true event feed');
    Math.random = () => 0; // pick แรก + chance ผ่าน
    g12.botGhostChat();
    Math.random = realRandom;
    const botMsgs = g12.chat.filter((m) => m.ghost && m.playerId === bot12.id);
    assert(botMsgs.some((m) => m.text.includes(g12.nick(a12))) && botMsgs.some((m) => /ฆ่า/.test(m.text)), 'a bot ghost greets the new ghost and comments on the hour\'s events');
    assert(!g12.viewFor(b12.id).chat.some((m) => m.ghost), 'bot ghost chat is hidden from the living too');
    g12.phase = PHASE.TRIAL;
    g12.votes.set(b12.id, c12.id);
    assert(g12.viewFor(a12.id).players.find((p) => p.id === b12.id).vote === c12.id && g12.viewFor(c12.id).players.find((p) => p.id === b12.id).vote === null, 'ghosts see live votes, the living do not');
    g12.phase = PHASE.DAY;
    b12.alive = false; b12.fate = 'victim';
    assert(g12.viewFor(a12.id).me.spectator.watching === null, 'the watch ends when the watched player dies');
    g12.phase = PHASE.ENDED;
    assert(g12.viewFor(c12.id).chat.some((m) => m.ghost), 'once the game ends everyone sees the ghost chat');
  }
  Object.assign(CONFIG, saved);
  console.log('✔ unit tests: poison food, murder lock, craft+trap trigger, locked doors (≤2 keys per game, quiet lock, lock-in, lockpick 2–3 h, combat break), hidden exit discovery/opening, bot item requests, post-trial scene reset, all bodies announced together / multi-killer hunt (execute one, "one more remains", evidence hour, next trial, new day only when all cases closed), waiting outside locked doors / door traps / uncaught killers cannot escape / closed-case victims stay dead, combo realism (recipe-based trap names, striking item is the case weapon, door-trap narration, wound text shared by examine and narrator, shock trap needs a real cable), item tags (junk cannot attack or craft, loaded guns 85% + ammo + gunshot heard everywhere + gun door traps, syringe as poison vector, pungent/tasteless/blood-only poisons, repairs/breach/tech lockpicking need real tools), knockouts (bare hands and sedatives only stun, lethality per item, sure hits on the unconscious, armed counters, objective punishment, waking up), rooms = players × 2 (mock trim/pad keeps required item kinds, unique names, locks/keys scale), exits need 4–5 steps (assembly craft, persistent tool/cut/force steps, pooled attempts), investigation = 1 h + 1 per body with no kills, fighters kill bare-handed 5%, knocked-out players cannot vote, take/drop/hide are instant and free, ghost mode (ghost chat hidden from the living until the end, follow a living player, full map + true-event feed, live votes, bot ghosts greet and comment)');
}

try {
  await unitTests();
  const agg = { itemsMoved: 0, kos: 0, kills: 0, trapKills: 0, trials: 0, huntRounds: 0, escapes: 0, wrongVotes: 0, defenses: 0, wrongTargets: 0, forced: 0, gives: 0, requests: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0, doorWorks: 0, lockedIn: 0, breaks: 0 };
  const add = (r) => { for (const k of Object.keys(agg)) agg[k] += r[k] || 0; };

  for (let i = 0; i < 4; i++) add(await runGame({ humans: 8, label: `explore #${i + 1}`, strategy: 'explore', config: { REVIVE_CHANCE: 0 } }));
  const withBots = await runGame({ humans: 3, bots: 4, label: 'with bots', strategy: 'explore', config: { REVIVE_CHANCE: 0 } });
  add(withBots);
  const noReq = await runGame({ humans: 3, bots: 4, label: 'with bots (requests disabled)', strategy: 'peaceful', config: { REVIVE_CHANCE: 0, BOT_REQUESTS: false, MAX_HOURS: 16 } });
  add(noReq);
  assert(noReq.requests === 0, 'no requests when BOT_REQUESTS is off');
  add(await runGame({ humans: 15, label: 'full 15', strategy: 'explore', config: { REVIVE_CHANCE: 0 } }));
  const wrong = await runGame({ humans: 8, label: 'always wrong vote → game over', strategy: 'explore', voteStrategy: 'wrong', config: { REVIVE_CHANCE: 0 } });
  add(wrong);
  if (wrong.trials) assert(wrong.endReason === 'wrong_vote' && wrong.wrongVotes === 1, 'wrong vote ends the game immediately');
  const trapTotal = { crafts: 0, trapsPlaced: 0, poisonings: 0, trapKills: 0 };
  for (let i = 0; i < 3; i++) {
    const trap = await runGame({ humans: 8, label: `trap-heavy #${i + 1}`, strategy: 'trap', config: { REVIVE_CHANCE: 0 } });
    add(trap);
    for (const k of Object.keys(trapTotal)) trapTotal[k] += trap[k];
  }
  assert(trapTotal.crafts >= 1 && trapTotal.trapsPlaced >= 1, `trap runs craft and place traps (${JSON.stringify(trapTotal)})`);
  const locks = await runGame({ humans: 8, label: 'locks (keys, locked doors, waiting outside)', strategy: 'locks', config: { REVIVE_CHANCE: 0, LOCKED_ZONES: 2 } });
  add(locks);
  assert(locks.bounces >= 1, 'someone waited outside a locked door');
  const camp = await runGame({ humans: 6, label: 'campers (objectives force them apart)', strategy: 'camp', config: { REVIVE_CHANCE: 0, MAX_HOURS: 24 } });
  add(camp);
  assert(camp.kills === 0 && camp.forced >= 1 && camp.kos >= 1, 'camping run has no kills and ignored objectives knock campers out');
  // การให้ของถูกเช็กรวมใน agg.gives (ตอนนี้คนแคมป์ไม่ถูกพาไปหยิบของห้องอื่น ของในห้องเดียวมีน้อย)
  const peaceful = await runGame({ humans: 6, label: 'peaceful (no kills, timeout cap)', strategy: 'peaceful', config: { REVIVE_CHANCE: 0, MAX_HOURS: 20 } });
  add(peaceful);
  assert(peaceful.kills === 0 && peaceful.endReason === 'timeout', 'peaceful run ends by hour cap');
  let escapes = 0;
  for (let i = 0; i < 3; i++) {
    const esc = await runGame({ humans: 6, label: `escape-focused #${i + 1}`, strategy: 'escape', config: { REVIVE_CHANCE: 0, OBJECTIVES: false, MAX_HOURS: 80, FIND_EXIT_CHANCE: 1, FIND_ROUTE_ITEM_CHANCE: 1, FIND_HIDDEN_CHANCE: 1 } }); // ทางออก 4–5 ขั้นใช้เวลา: ให้หาของเจอแน่และมีเวลาพอ
    add(esc);
    escapes += esc.escapes;
  }
  assert(escapes >= 1, 'escape-focused runs open an exit at least once');
  const split = await runGame({ humans: 6, label: 'forced ties → runoff', strategy: 'explore', voteStrategy: 'split', config: { REVIVE_CHANCE: 0 } });
  add(split);
  const revive = await runGame({ humans: 7, label: 'revive events (chance 100%)', strategy: 'explore', config: { REVIVE_CHANCE: 1 } });
  add(revive);
  const noObj = await runGame({ humans: 5, label: 'objectives disabled', strategy: 'explore', config: { REVIVE_CHANCE: 0, OBJECTIVES: false, FAKE_ROLES: 0 } });
  add(noObj);
  assert(noObj.forced === 0 && noObj.roleStats.fakes === 0, 'no objective punishment / no fake role when disabled');

  assert(agg.kills >= 3, `simulations should produce kills (got ${agg.kills})`);
  assert(agg.trials >= 2, `simulations should reach trials (got ${agg.trials})`);
  assert(agg.forced >= 1, 'objective punishment should trigger somewhere');
  assert(agg.kos >= 1, 'someone should get knocked out somewhere');
  assert(agg.itemsMoved >= 5, 'items get taken/dropped instantly without spending hours');
  assert(agg.gives >= 1, 'item giving should happen somewhere');
  assert(agg.huntRounds >= 1, 'a multi-killer hunt (second trial in one day) should occur somewhere');
  console.log(`ALL SIMULATIONS PASSED — totals: ${JSON.stringify(agg)}`);
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
