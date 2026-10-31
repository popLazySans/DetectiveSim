// จำลองเกมเต็มรอบด้วย mock AI เพื่อตรวจ state machine, การซ่อนข้อมูล, ลูปชั่วโมง (สำรวจห้อง/ลงมือ/คราฟกับดัก/ภารกิจ/ให้ของ/ล็อกห้อง),
// การพบศพ → เก็บหลักฐาน → ตัดสิน (รวมโหวตผิด = จบเกม), ทางออกที่ซ่อนอยู่หลายแบบ และสรุปผล
// รัน: npm test
import { Game, PHASE, STEP, CONFIG, NONE_VOTE, DEAD_FATES, SURVIVED_FATES, hiddenUltimateCap, MURDER_CAUSES } from '../server/game.js';
import { createAI } from '../server/ai.js';
import { RECIPES, OBJECTIVE_HOURS, LOCKS } from '../server/rules.js';

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
  assert(keys.length >= 1 && keys.length <= LOCKS.MAX_KEYS, `1–${LOCKS.MAX_KEYS} room keys exist (${keys.length})`);
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

  const stats = { hours: 0, days: 0, trials: 0, huntRounds: 0, kills: 0, trapKills: 0, runoffs: 0, leakChecks: 0, wrongVotes: 0, escapes: 0, actionsChecked: 0, defenses: 0, wrongTargets: 0, noneVotes: 0, forced: 0, gives: 0, requests: 0, objectivesDone: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0, exitAttempts: 0, doorWorks: 0, lockedIn: 0, breaks: 0 };
  let rolesChecked = false;
  let roleStats = { hidden: 0, fakes: 0 };
  let ticks = 0;
  let lastTurnSeen = 0;
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
          const sameZone = realPlayer.alive && (game.step === STEP.ACT || game.step === STEP.REPORT) && realPlayer.zoneId === me.zoneId;
          if (!sameZone) assert(p.zoneId == null, `position of ${p.id} leaked to ${id}`);
          else assert(p.zoneId === realPlayer.zoneId, 'same-zone position visible');
        }
        if (!isMe && !realPlayer.alive && me.alive && game.phase !== PHASE.ENDED) {
          const body = game.bodies.get(p.id);
          const known = body?.announced || ['executed', 'punished', 'escaped'].includes(realPlayer.fate) || me.knownBodies.has(p.id);
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
          const botVisible = o.isBot && CONFIG.BOT_REQUESTS && me.alive && (game.step === STEP.ACT || game.step === STEP.REPORT) && o.zoneId === me.zoneId;
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
        assert(Array.isArray(v.me.availableActions) && v.me.availableActions.some((a) => a.type === 'search'), 'alive player has actions');
        for (const a of v.me.availableActions) if (a.type === 'trap') assert(me.inventory.find((i) => i.id === a.itemId)?.kind === 'trap', 'only crafted traps can be placed');
        stats.actionsChecked++;
      }
      if (game.step === STEP.REPORT && me.alive) {
        for (const zp of v.me.zonePeople) assert(game.players.get(zp.id)?.zoneId === me.zoneId, 'zonePeople are really co-located');
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
    for (const x of game.exits.values()) {
      if (x.open) continue;
      const mine = p.inventory.filter((i) => i.exitId === x.id);
      if (x.route === 'locked' && mine.some((i) => i.role === 'key')) return x;
      if (x.route === 'power' && x.powered) return x;
      if (x.route === 'breach' && p.inventory.some((i) => i.kind === 'weapon' || i.kind === 'tool')) return x;
      if ((x.route === 'code' || x.route === 'repair') && mine.length >= x.items.length && (x.route !== 'repair' || p.inventory.some((i) => i.kind === 'tool'))) return x;
    }
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
    const take = byType('take');
    const obj = p.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take' && take.some((a) => a.itemId === o.itemId));
    if (t && chance(0.7)) return take.find((a) => a.itemId === t.itemId);
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === p.zoneId && p.inventory.some((i) => i.id === o.itemId));
    if (pl && chance(0.7)) return byType('hide').find((a) => a.itemId === pl.itemId);
    const eatObj = obj.find((o) => o.type === 'visit_eat' && o.zoneId === p.zoneId);
    if (eatObj && byType('eat').length && chance(0.8)) return byType('eat')[0];
    if (strategy === 'escape') {
      if (byType('exit_power').length) return byType('exit_power')[0];
      const x = exitFor(p);
      const ex = byType('exit').find((a) => a.exitId === x?.id);
      if (ex) return ex;
      const routeTake = take.find((a) => {
        const it = z.items.find((i) => i.id === a.itemId);
        return it && (it.isPart || it.kind === 'clue' || it.kind === 'key');
      });
      if (routeTake) return routeTake;
      const toolTake = take.find((a) => ['tool', 'weapon'].includes(z.items.find((i) => i.id === a.itemId)?.kind));
      if (toolTake && !p.inventory.some((i) => i.kind === 'tool' || i.kind === 'weapon')) return toolTake;
      if (p.inventory.length >= CONFIG.INVENTORY_MAX && byType('drop').length) {
        const junk = byType('drop').find((a) => !p.inventory.find((i) => i.id === a.itemId)?.isPart);
        if (junk) return junk;
      }
      return byType('search')[0];
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
      return byType('search')[0];
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
        const junk = byType('drop').find((a) => {
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
    if (p.inventory.length && chance(0.1)) return pick([...byType('hide'), ...byType('drop')]);
    if (chance(0.75)) return byType('search')[0];
    return byType('rest')[0];
  };

  // ช่วงพัก: ให้ของกับคนในห้องเดียวกัน (ถ้ามี) เพื่อทดสอบระบบให้ของ
  const tryGive = (p) => {
    const mates = game.presentIn(p.zoneId).filter((o) => o.id !== p.id && o.inventory.length < CONFIG.INVENTORY_MAX);
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
    const bots = game.presentIn(p.zoneId).filter((o) => o.isBot && o.inventory.length);
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
    const human = game.alivePlayers().find((o) => !o.isBot && o.id !== p.id && o.zoneId === p.zoneId && o.inventory.length);
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
            assert(game.turn === lastTurnSeen + 1 || lastTurnSeen === 0, `turn advances by one (${lastTurnSeen} → ${game.turn})`);
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
                const expectLocked = CONFIG.LOCKED_ZONES >= 0 ? CONFIG.LOCKED_ZONES : game.zones.size - 1 <= 6 ? 1 : 2;
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
                    assert(!p.forced, 'forced players are pre-moved by the engine');
                    let target = decideMove(p);
                    const block = game.doorBlocking(p, target);
                    const means = block ? game.doorMeans(p) : null;
                    p.__expectBounce = block && !means ? { from: p.zoneId, target: block.zone.id } : null;
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
                  if (p.__expectBounce) {
                    const door = game.zones.get(p.__expectBounce.target);
                    if (p.zoneId === p.__expectBounce.from) {
                      assert(p.zoneMemory[p.__expectBounce.target]?.locked === true, 'bounced player remembers the room is locked');
                      stats.bounces++;
                    } else assert(!door.locked, 'a player passes an expected locked door only when someone else opened it in the same hour');
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
                  if (cur?.forced) {
                    let threw = false;
                    try { game.chooseAction(p.id, { type: 'search' }); } catch { threw = true; }
                    assert(threw, 'forced action cannot be overridden');
                    continue;
                  }
                  if (cur) continue;
                  checkMurderLock(p);
                  if (game.actions.has(p.id)) continue;
                  let a = decideAction(p);
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
                for (const p of humansAlive().filter((x) => !game.ready.has(x.id))) {
                  const v = game.viewFor(p.id);
                  assert(v.me.log.some((l) => l.day === game.day && l.hour === game.hour && l.kind === 'move'), 'player has a move log entry for this hour');
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
              const pendingVote = humansAlive().filter((p) => !game.confirmedVotes.has(p.id));
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
                  assert(game.day === dayBefore + 1 && game.hour === 1, 'trial ends the day; new day starts at hour 1');
                  assert(game.bodies.size === 0, 'no bodies remain after the final verdict (all cases of the day closed)');
                  for (const z of game.zones.values()) for (const e of z.evidence) assert(!e.caseId || !game.caseOf(e.caseId)?.judged, 'evidence of judged cases is wiped');
                  for (const p of game.alivePlayers()) assert(p.zoneId === game.location.sleepZoneId, 'everyone restarts the day in the sleep zone');
                }
                for (const p of game.alivePlayers()) if (invBefore.has(p.id)) assert(p.inventory.map((i) => i.id).join(',') === invBefore.get(p.id), 'survivors keep their items');
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
      assert(c.trapType && ['blade', 'fall', 'shock', 'poison'].includes(c.trapType), `trap case has a trap type (${c.trapType})`);
    }
    if (c.cause === 'defense') stats.defenses++;
    if (c.cause === 'wrongTarget') stats.wrongTargets++;
  }
  stats.trials = game.history.length;
  stats.wrongVotes = game.history.filter((h) => !h.correct).length;
  stats.exitsFound = [...game.exits.values()].filter((x) => x.discoveredBy.size > 0).length;
  if (game.endReason === 'escape') stats.escapes++;
  for (const p of game.players.values()) {
    stats.forced += p.log.filter((l) => l.text.startsWith('⏰')).length;
    stats.objectivesDone += p.log.filter((l) => l.text.startsWith('✅')).length;
    stats.crafts += p.log.filter((l) => l.text.startsWith('🛠')).length;
    stats.trapsPlaced += p.log.filter((l) => l.text.startsWith('🪤 คุณตั้ง')).length;
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
  if (game.endReason === 'escape') assert([...game.exits.values()].some((x) => x.open) && all.filter((p) => p.fate === 'survivor').length >= 1, 'escape ends with an open exit and survivors');
  for (const b of game.bodies.values()) assert(!game.players.get(b.victimId).alive, 'body belongs to a dead player');

  Object.assign(CONFIG, saved);
  console.log(
    `✔ ${label}: ${all.length} players · end=${game.endReason} (day ${stats.days}, ${stats.hours} h) · ${stats.trials} trial(s) (${stats.huntRounds} hunt rounds, ${stats.wrongVotes} wrong, ${stats.noneVotes} none, ${stats.runoffs} runoff) · kills ${stats.kills} (trap ${stats.trapKills}, defense ${stats.defenses}, wrong-target ${stats.wrongTargets}) · crafts ${stats.crafts} traps ${stats.trapsPlaced} poison ${stats.poisonings} · locks ${stats.locks} bounces ${stats.bounces} door-work ${stats.doorWorks} (breaks ${stats.breaks}) locked-in ${stats.lockedIn} murder-locks ${stats.lockBlocks} · objectives done ${stats.objectivesDone}, forced ${stats.forced} · gives ${stats.gives} requests ${stats.requests} · exits found ${stats.exitsFound}/2 attempts ${stats.exitAttempts} · ${roleStats.hidden} hidden + ${roleStats.fakes} fake · ${stats.leakChecks} leak checks, ${stats.actionsChecked} action checks`,
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
  const poison = zones.flatMap((z) => z.items).find((i) => i.kind === 'poison');
  const rope = zones.flatMap((z) => z.items).find((i) => i.kind === 'rope');
  const weapon = zones.flatMap((z) => z.items).find((i) => i.kind === 'weapon');
  assert(foodZone && poison && rope && weapon, 'unit world has food, poison, rope and weapon');
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
  const from = zones.find((z) => z.id !== locked.id && !z.locked);
  a.zoneId = from.id;
  b.zoneId = from.id;
  game.phase = PHASE.DAY;
  game.moves = new Map([[a.id, locked.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(a.zoneId === from.id && a.zoneMemory[locked.id]?.locked === true, 'without a key the player bounces and remembers the lock');
  a.inventory = [key];
  game.moves = new Map([[a.id, locked.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && locked.locked && /ไขเข้ามาด้วยกุญแจ/.test(a.log.at(-1).text), 'with the key the player enters, is told the door is locked, and the room stays locked');
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
  const aTrait0 = game.charOf(a).ultimate.trait;
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
  const lockpick = allItems.find((i) => i.kind === 'lockpick');
  a.inventory = [lockpick];
  assert(game.doorMeans(a)?.method === 'pick', 'a lockpick lets anyone work on a locked door');
  Math.random = () => 0; // need = 2 และคนข้างในได้ยิน
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  const bHeard = b.log.length;
  game.resolveMoves();
  Math.random = realRandom;
  assert(a.zoneId === from.id && a.doorWork?.progress === 1 && a.doorWork.need === 2 && locked.locked, 'first hour of lockpicking: still outside, progress 1 of 2');
  assert(game.actions.get(a.id)?.type === 'doorwork' && game.actions.get(a.id).busy, 'lockpicking consumes the hour');
  assert(b.log.length > bHeard && b.log.slice(bHeard).some((l) => /แกรกกราก/.test(l.text)), 'the person inside may hear the lockpick');
  let overridden = false;
  try { game.chooseAction(a.id, { type: 'search' }); } catch { overridden = true; }
  assert(overridden, 'a busy player cannot pick another action');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneId === locked.id && !locked.locked && !a.doorWork, 'second hour: lock picked, door unlocked, player enters');
  assert(b.zoneMemory[locked.id]?.locked === false && b.log.slice(-3).some((l) => /ประตู.*เปิดออก/.test(l.text)), 'people inside see the door open');
  // 4d) นักสู้พังประตูมือเปล่า 1–2 ชั่วโมง (บังคับให้เป็น 1) เสียงดัง ประตูพังแล้วล็อกไม่ได้อีก
  game.step = STEP.ACT;
  game.do_lock(b);
  a.zoneId = from.id;
  a.inventory = [];
  const aChar = game.charOf(a);
  const realTrait = aChar.ultimate.trait;
  aChar.ultimate.trait = 'combat';
  assert(game.doorMeans(a)?.method === 'break', 'a combat ultimate can break doors barehanded');
  Math.random = () => 0; // need = 1
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  Math.random = realRandom;
  assert(a.zoneId === locked.id && locked.broken && !locked.locked && !locked.lockable, 'combat breaks the door in one hour and enters; the door cannot be locked again');
  assert(b.log.slice(-4).some((l) => /ทุบกระแทก/.test(l.text)), 'people inside hear the door being broken');
  assert(locked.evidence.some((e) => e.kind === 'door'), 'a broken door leaves visible evidence');
  game.step = STEP.ACT;
  assert(!game.availableActions(b).some((x) => x.type === 'lock'), 'a broken door cannot be locked');
  aChar.ultimate.trait = 'tech';
  a.inventory = [weapon];
  assert(!game.doorMeans(a), 'tech needs a tool, not a weapon');
  const toolItem = allItems.find((i) => i.kind === 'tool');
  a.inventory = [toolItem];
  assert(game.doorMeans(a)?.method === 'pick' && game.doorMeans(a).item === toolItem, 'tech uses any tool as a lockpick');
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
    const keyItem = zones.flatMap((z) => z.items).find((i) => i.exitId === lockedExit.id && i.role === 'key');
    a.inventory = [keyItem];
    const act = game.availableActions(a).find((x) => x.type === 'exit' && x.exitId === lockedExit.id);
    assert(act && !act.disabled, 'exit action enabled when holding the exit key');
    game.phase = PHASE.DAY;
    game.step = STEP.ACT;
    game.actions = new Map([[a.id, act]]);
    for (const p of game.alivePlayers()) if (p.id !== a.id) game.actions.set(p.id, { type: 'rest', auto: true });
    game.resolveActions();
    assert(lockedExit.open && game.phase === PHASE.ENDED && game.endReason === 'escape', 'using the key opens the exit and ends the game');
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
    assert([s1, s2, k1, k2].every((p) => p.knownBodies.has(v1.id) && p.knownBodies.has(v2.id)), 'everyone now knows where both bodies are');
    const ann = g4.chat.at(-1).text;
    assert(/ศพทุกร่างในสถานที่ถูกเปิดเผยพร้อมกัน/.test(ann) && /ยังไม่มีใครเคยเห็น/.test(ann), 'announcement mentions the never-seen body');
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
  }
  Object.assign(CONFIG, saved);
  console.log('✔ unit tests: poison food, murder lock, craft+trap trigger, locked doors (≤2 keys per game, quiet lock, lock-in, lockpick 2–3 h, combat break), hidden exit discovery/opening, bot item requests, post-trial scene reset, all bodies announced together / multi-killer hunt (execute one, "one more remains", evidence hour, next trial, new day only when all cases closed)');
}

try {
  await unitTests();
  const agg = { kills: 0, trapKills: 0, trials: 0, huntRounds: 0, escapes: 0, wrongVotes: 0, defenses: 0, wrongTargets: 0, forced: 0, gives: 0, requests: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0, doorWorks: 0, lockedIn: 0, breaks: 0 };
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
  const locks = await runGame({ humans: 8, label: 'locks (keys, locked doors, bounces)', strategy: 'locks', config: { REVIVE_CHANCE: 0, LOCKED_ZONES: 2 } });
  add(locks);
  assert(locks.bounces >= 1, 'someone bounced off a locked door');
  const camp = await runGame({ humans: 6, label: 'campers (objectives force them apart)', strategy: 'camp', config: { REVIVE_CHANCE: 0, MAX_HOURS: 24 } });
  add(camp);
  assert(camp.kills === 0 && camp.forced >= 1, 'camping run has no kills and objectives force moves');
  assert(camp.gives >= 1, 'campers in the same room can give items');
  const peaceful = await runGame({ humans: 6, label: 'peaceful (no kills, timeout cap)', strategy: 'peaceful', config: { REVIVE_CHANCE: 0, MAX_HOURS: 20 } });
  add(peaceful);
  assert(peaceful.kills === 0 && peaceful.endReason === 'timeout', 'peaceful run ends by hour cap');
  let escapes = 0;
  for (let i = 0; i < 3; i++) {
    const esc = await runGame({ humans: 6, label: `escape-focused #${i + 1}`, strategy: 'escape', config: { REVIVE_CHANCE: 0, OBJECTIVES: false, MAX_HOURS: 60, FIND_EXIT_CHANCE: 0.9, FIND_ROUTE_ITEM_CHANCE: 0.9 } });
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
  assert(noObj.forced === 0 && noObj.roleStats.fakes === 0, 'no forced moves / no fake role when disabled');

  assert(agg.kills >= 3, `simulations should produce kills (got ${agg.kills})`);
  assert(agg.trials >= 2, `simulations should reach trials (got ${agg.trials})`);
  assert(agg.forced >= 1, 'objective enforcement should trigger somewhere');
  assert(agg.gives >= 1, 'item giving should happen somewhere');
  assert(agg.huntRounds >= 1, 'a multi-killer hunt (second trial in one day) should occur somewhere');
  console.log(`ALL SIMULATIONS PASSED — totals: ${JSON.stringify(agg)}`);
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
