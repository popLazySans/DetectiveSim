// จำลองเกมเต็มรอบด้วย mock AI เพื่อตรวจ state machine, การซ่อนข้อมูล, ลูปชั่วโมง (สำรวจห้อง/ลงมือ/คราฟกับดัก/ภารกิจ/ให้ของ/ล็อกห้อง),
// การพบศพ → เก็บหลักฐาน → ตัดสิน (รวมโหวตผิด = จบเกม), ทางออกที่ซ่อนอยู่หลายแบบ และสรุปผล
// รัน: npm test
import { Game, PHASE, STEP, CONFIG, NONE_VOTE, DEAD_FATES, SURVIVED_FATES, hiddenUltimateCap, MURDER_CAUSES } from '../server/game.js';
import { createAI } from '../server/ai.js';
import { RECIPES, OBJECTIVE_HOURS } from '../server/rules.js';

CONFIG.BOT_DELAY_SCALE = 0.02;
CONFIG.STEP_TIMEOUT_MS = 0;
// เกมจริงไม่มีเวลาจำกัด แต่การจำลองต้องจบ จึงตั้งเพดานชั่วโมงไว้
CONFIG.MAX_HOURS = 36;

const quietLog = { info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };
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

  const stats = { hours: 0, days: 0, trials: 0, kills: 0, trapKills: 0, runoffs: 0, leakChecks: 0, wrongVotes: 0, escapes: 0, actionsChecked: 0, defenses: 0, wrongTargets: 0, noneVotes: 0, forced: 0, gives: 0, requests: 0, objectivesDone: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0, exitAttempts: 0 };
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
    return z && (!z.locked || game.hasKeyFor(p, id));
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
      const key = p.inventory.find((i) => i.kind === 'key' && i.unlocksZoneId);
      if (key && chance(0.7)) return key.unlocksZoneId;
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
                    const target = decideMove(p);
                    const z = game.zones.get(target);
                    if (z.locked && target !== p.zoneId && !game.hasKeyFor(p, target)) p.__expectBounce = { from: p.zoneId, target };
                    else p.__expectBounce = null;
                    game.chooseMove(p.id, target);
                  }
                }
              } else if (game.step === STEP.ACT) {
                for (const p of humansAlive()) {
                  if (p.__expectBounce) {
                    assert(p.zoneId === p.__expectBounce.from, 'player bounced off a locked door stays where they were');
                    assert(p.zoneMemory[p.__expectBounce.target]?.locked === true, 'bounced player remembers the room is locked');
                    stats.bounces++;
                    p.__expectBounce = null;
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
              for (const c of r.cases) assert(c.victimName && c.zoneName && c.causeLabel && c.killerName && c.hour >= 1, 'case reveal complete');
              if (r.votedId === NONE_VOTE) stats.noneVotes++;
              if (r.correct && r.executedId) assert(game.players.get(r.executedId).fate === 'executed', 'executed fate');
              const rv = game.viewFor(ids[0]);
              assert(rv.lastResult?.cases?.length === r.cases.length, 'result visible after trial');
              const dayBefore = game.day;
              await game.nextRound(host);
              if (game.phase !== PHASE.ENDED) assert(game.day === dayBefore + 1 && game.hour === 1, 'trial ends the day; new day starts at hour 1');
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
    for (const c of game.cases.filter((x) => x.killerId)) assert(['escaped', 'executed', 'victim'].includes(game.players.get(c.killerId).fate), `killer fate after wrong vote (${game.players.get(c.killerId).fate})`);
  }
  if (game.endReason === 'last_one') assert(all.filter((p) => p.alive).length <= 1, 'last_one leaves ≤1 alive');
  if (game.endReason === 'escape') assert([...game.exits.values()].some((x) => x.open) && all.filter((p) => p.fate === 'survivor').length >= 1, 'escape ends with an open exit and survivors');
  for (const b of game.bodies.values()) assert(!game.players.get(b.victimId).alive, 'body belongs to a dead player');

  Object.assign(CONFIG, saved);
  console.log(
    `✔ ${label}: ${all.length} players · end=${game.endReason} (day ${stats.days}, ${stats.hours} h) · ${stats.trials} trial(s) (${stats.wrongVotes} wrong, ${stats.noneVotes} none, ${stats.runoffs} runoff) · kills ${stats.kills} (trap ${stats.trapKills}, defense ${stats.defenses}, wrong-target ${stats.wrongTargets}) · crafts ${stats.crafts} traps ${stats.trapsPlaced} poison ${stats.poisonings} · locks ${stats.locks} bounces ${stats.bounces} murder-locks ${stats.lockBlocks} · objectives done ${stats.objectivesDone}, forced ${stats.forced} · gives ${stats.gives} requests ${stats.requests} · exits found ${stats.exitsFound}/2 attempts ${stats.exitAttempts} · ${roleStats.hidden} hidden + ${roleStats.fakes} fake · ${stats.leakChecks} leak checks, ${stats.actionsChecked} action checks`,
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
  const foodZone = zones.find((z) => z.items.some((i) => i.kind === 'food'));
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
  // 2) ล็อกการฆาตกรรม: c (ไม่ใช่คนร้าย) ลงมือไม่ได้ ส่วน a (คนร้าย) ลงมือได้
  game.phase = PHASE.DAY;
  game.step = STEP.ACT;
  game.actions = new Map();
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
  // 4) ล็อกห้อง: ไม่มีกุญแจเข้าไม่ได้ (เด้งกลับ) มีกุญแจเข้าได้ และออกโดยไม่มีกุญแจทำให้ประตูเปิดค้าง
  game.bodies = new Map(); // ล้างศพจากข้อก่อน ไม่ให้ประกาศพบศพมารบกวน
  game.cases = [];
  const locked = zones.find((z) => z.locked);
  const key = zones.flatMap((z) => z.items).find((i) => i.id === locked.keyItemId);
  assert(locked && key, 'a locked zone with its key exists');
  a.alive = true;
  b.alive = true;
  a.inventory = [];
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
  assert(a.zoneId === locked.id && locked.locked, 'with the key the player enters and the room stays locked');
  game.step = STEP.ACT;
  assert(game.availableActions(a).some((x) => x.type === 'unlock'), 'key holder inside can unlock');
  a.inventory = [];
  game.moves = new Map([[a.id, from.id], [b.id, from.id]]);
  game.resolveMoves();
  assert(!locked.locked, 'leaving a locked room without a key leaves the door unlocked');
  // 4b) ล็อกเงียบ ๆ: คนที่อยู่ในห้องตอนล็อกยังไม่รู้ จนต้นชั่วโมงถัดไปจึงสังเกตเห็นและได้ตัวเลือกปลดล็อก
  a.inventory = [key];
  b.inventory = [];
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves(); // ประตูเปิดค้างอยู่ ทั้งคู่เข้าได้
  assert(a.zoneId === locked.id && b.zoneId === locked.id && b.zoneMemory[locked.id]?.locked === false, 'both enter the now-unlocked room and remember it as unlocked');
  game.step = STEP.ACT;
  const bLogBefore = b.log.length;
  game.do_lock(a);
  assert(locked.locked && a.zoneMemory[locked.id]?.locked === true, 'locking takes effect at once and the locker knows');
  assert(b.log.length === bLogBefore && b.zoneMemory[locked.id]?.locked === false, 'others in the room are not told about the lock yet');
  b.inventory = [{ id: 'unit_master', name: 'กุญแจผู้ดูแล', description: '', kind: 'key', portable: true, master: true }];
  assert(!game.availableActions(b).some((x) => x.type === 'lock' || x.type === 'unlock'), 'a key holder who does not know about the lock gets no lock/unlock option yet');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves(); // ชั่วโมงถัดไป ทั้งคู่อยู่ต่อ
  assert(b.zoneMemory[locked.id]?.locked === true && /เพิ่งสังเกตว่าประตูห้องนี้ถูกล็อกไว้/.test(b.log.at(-1).text), 'next hour the roommate notices the door is locked');
  assert(!/ไขเข้ามาด้วยกุญแจ/.test(a.log.at(-1).text) && !/เพิ่งสังเกต/.test(a.log.at(-1).text), 'the locker who stays is not told they unlocked their way in');
  game.step = STEP.ACT;
  assert(game.availableActions(b).some((x) => x.type === 'unlock'), 'once aware, the key holder can unlock');
  game.do_unlock(b);
  assert(!locked.locked && b.zoneMemory[locked.id]?.locked === false && a.zoneMemory[locked.id]?.locked === true, 'unlocking is quiet too: the other key holder still believes it is locked');
  game.moves = new Map([[a.id, locked.id], [b.id, locked.id]]);
  game.resolveMoves();
  assert(a.zoneMemory[locked.id]?.locked === false && /ไม่ได้ล็อกแล้ว/.test(a.log.at(-1).text), 'next hour the other player notices the door is unlocked');
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
  Object.assign(CONFIG, saved);
  console.log('✔ unit tests: poison food, murder lock, craft+trap trigger, locked doors (quiet lock, noticed next hour), hidden exit discovery/opening, bot item requests');
}

try {
  await unitTests();
  const agg = { kills: 0, trapKills: 0, trials: 0, escapes: 0, wrongVotes: 0, defenses: 0, wrongTargets: 0, forced: 0, gives: 0, requests: 0, crafts: 0, trapsPlaced: 0, poisonings: 0, locks: 0, bounces: 0, lockBlocks: 0, exitsFound: 0 };
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
  assert(agg.lockBlocks >= 1, 'murder lock should block someone somewhere');
  console.log(`ALL SIMULATIONS PASSED — totals: ${JSON.stringify(agg)}`);
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
