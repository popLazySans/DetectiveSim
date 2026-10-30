// จำลองเกมเต็มรอบด้วย mock AI เพื่อตรวจ state machine, การซ่อนข้อมูล, ลูปสำรวจห้อง/ลงมือ/กับดัก/ภารกิจ,
// การพบศพ → เก็บหลักฐาน → ตัดสิน (รวมโหวตผิด = จบเกม), การหนี และสรุปผล
// รัน: npm test
import { Game, PHASE, STEP, CONFIG, NONE_VOTE, DEAD_FATES, SURVIVED_FATES, hiddenUltimateCap } from '../server/game.js';
import { createAI } from '../server/ai.js';

CONFIG.BOT_DELAY_SCALE = 0.02;
CONFIG.STEP_TIMEOUT_MS = 0;

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
//  'explore'  = ผู้เล่นสำรวจ/หยิบของ และใครที่ถืออาวุธและอยู่กับคนอื่นแค่คนเดียวจะลงมือ 50%
//  'peaceful' = ไม่มีใครลงมือ (ทดสอบภารกิจ/หนี/หมดเวลา)
//  'escape'   = ทุกคนมุ่งหาของหนีและไปทางออก
//  'trap'     = หยิบยา/อาวุธมาวางกับดัก
// voteStrategy: 'smart' = โหวตถูกเสมอ (ถ้ารู้) | 'wrong' = โหวตผิดเสมอ | 'random' | 'split'
async function runGame({ humans, bots = 0, label, strategy = 'explore', voteStrategy = 'smart', config = {}, maxTicks = 5000 }) {
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

  const stats = { days: 0, trials: 0, kills: 0, traps: 0, trapKills: 0, objectiveDeaths: 0, runoffs: 0, leakChecks: 0, wrongVotes: 0, partsFound: 0, escapes: 0, actionsChecked: 0, defenses: 0, wrongTargets: 0, noneVotes: 0 };
  let rolesChecked = false;
  let roleStats = { hidden: 0, fakes: 0 };
  let ticks = 0;

  const checkViews = () => {
    const N = game.players.size;
    for (const id of ids) {
      const v = game.viewFor(id);
      const me = game.players.get(id);
      const myChar = game.charOf(me);
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
          assert(p.character.fakeUltimate == null && !p.character.fakeRoleExposed, 'fake role flag leaked to others');
          assert(p.character.trait === 'none', 'fake role shows no trait');
        } else if (realChar.fakeRole) {
          assert(p.character.ultimate === realChar.ultimate.title, 'fake role owner/exposed view shows real title');
        } else {
          const mayShow = !realChar.ultimate.hidden || exposed || (isMe && realPlayer.knowsUltimate);
          if (!mayShow) {
            assert(p.character.ultimate === '???', `hidden ultimate leaked for ${p.id} to ${id}`);
            assert(p.character.ultimateDescription == null && p.character.trait == null, 'hidden ultimate details leaked');
          } else assert(p.character.ultimate === realChar.ultimate.title, 'visible ultimate shown');
        }
        // ตำแหน่งของคนอื่น: เห็นเฉพาะคนที่อยู่ห้องเดียวกันหลังเลือกห้องแล้ว (หรือเมื่อเราตาย/เกมจบ)
        if (!isMe && me.alive && game.phase !== PHASE.ENDED) {
          const sameZone = realPlayer.alive && (game.step === STEP.ACT || game.step === STEP.REPORT) && realPlayer.zoneId === me.zoneId;
          if (!sameZone) assert(p.zoneId == null, `position of ${p.id} leaked to ${id}`);
          else assert(p.zoneId === realPlayer.zoneId, 'same-zone position visible');
        }
        // คนตายที่ยังไม่มีใครรู้ ต้องดูเหมือนยังมีชีวิตสำหรับคนที่ไม่รู้
        if (!isMe && !realPlayer.alive && me.alive && game.phase !== PHASE.ENDED) {
          const body = game.bodies.get(p.id);
          const known = body?.announced || ['executed', 'punished', 'escaped'].includes(realPlayer.fate) || me.knownBodies.has(p.id);
          if (!known) assert(p.alive === true && p.fate == null && !p.knownDead, `unknown death of ${p.id} leaked to ${id}`);
          else assert(p.knownDead, 'known death shown');
        }
      }
      // ความลับของเกมไม่หลุดไปในมุมมองของผู้เล่นที่ยังมีชีวิต
      if (me.alive && game.phase !== PHASE.ENDED && game.phase !== PHASE.TRIAL_RESULT) {
        assert(!json.includes('"killerId"') && !json.includes('"culpritId"'), `killer field leaked to ${id}`);
        assert(!json.includes('"designatedId"'), 'designatedId leaked');
        for (const o of game.players.values()) {
          if (o.id === id) continue;
          for (const it of o.inventory) assert(!json.includes(`"id":"${it.id}"`), `inventory item ${it.id} of ${o.id} leaked to ${id}`);
        }
        // ของหนีที่ยังซ่อนอยู่ ห้ามปรากฏในมุมมอง
        // ของที่ซ่อนอยู่ (รวมของหนี) ห้ามหยิบได้และห้ามปรากฏ id ในมุมมอง (ชื่ออาจอยู่ในความทรงจำ/บันทึกจากตอนที่ยังเห็นได้)
        for (const z of game.zones.values()) for (const it of z.items) if (it.hidden) assert(!json.includes(`"${it.id}"`), `hidden item "${it.name}" leaked to ${id}`);
        // บันทึกส่วนตัวของคนอื่นไม่หลุด
        for (const o of game.players.values()) {
          if (o.id === id) continue;
          for (const l of o.log) assert(!json.includes(`"${l.id}"`), `private log entry of ${o.id} leaked to ${id}`);
          for (const ob of o.objectives) assert(!json.includes(`"${ob.id}"`), `objective of ${o.id} leaked to ${id}`);
        }
      }
      if (game.step === STEP.ACT && me.alive) {
        assert(Array.isArray(v.me.availableActions) && v.me.availableActions.some((a) => a.type === 'search'), 'alive player has actions');
        stats.actionsChecked++;
      }
      if (game.phase === PHASE.TRIAL) {
        assert(v.announcedCases.length >= 1, 'trial has announced cases');
        for (const c of v.announcedCases) assert(c.bodyState && c.title, 'announced case has narrative');
        assert(v.lastResult === null, 'lastResult hidden during trial');
      }
      stats.leakChecks++;
    }
  };

  const humansAlive = () => game.alivePlayers().filter((p) => !p.isBot);

  const decideMove = (p) => {
    const zones = [...game.zones.keys()];
    const obj = p.objectives.find((o) => !o.done && o.zoneId && o.type !== 'plant');
    if (obj && chance(0.8)) return obj.zoneId;
    const plant = p.objectives.find((o) => !o.done && o.type === 'plant');
    if (plant && chance(0.8)) return plant.zoneId;
    if (strategy === 'escape' && p.inventory.some((i) => i.isPart) && chance(0.7)) return game.escape.exitZoneId;
    if (game.phase === PHASE.INVESTIGATION) {
      const bz = [...game.bodies.values()].filter((b) => b.announced && !b.judged).map((b) => b.zoneId);
      if (bz.length && chance(0.5)) return pick(bz);
    }
    return pick(zones);
  };

  const decideAction = (p) => {
    const avail = game.availableActions(p).filter((a) => !a.disabled);
    const byType = (t) => avail.filter((a) => a.type === t);
    const z = game.zones.get(p.zoneId);
    const take = byType('take');
    const obj = p.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take' && take.some((a) => a.itemId === o.itemId));
    if (t) return take.find((a) => a.itemId === t.itemId);
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === p.zoneId && p.inventory.some((i) => i.id === o.itemId));
    if (pl) return byType('hide').find((a) => a.itemId === pl.itemId);
    const partTake = take.find((a) => z.items.find((i) => i.id === a.itemId)?.isPart);
    if (partTake) return partTake;
    if (byType('escape').length && p.inventory.some((i) => i.isPart)) return byType('escape')[0];
    if (game.phase === PHASE.INVESTIGATION) {
      const ex = byType('examine');
      if (ex.length && chance(0.5)) return pick(ex);
      if (byType('clean').length && p.kills > 0) return byType('clean')[0];
      const mb = byType('moveBody');
      if (mb.length && p.kills > 0 && chance(0.3)) return { ...mb[0], toZoneId: pick([...game.zones.keys()].filter((id) => id !== p.zoneId)) };
      return byType('search')[0];
    }
    if (strategy === 'trap') {
      const tr = byType('trap');
      if (tr.length && chance(0.7)) return pick(tr);
      const poisonTake = take.find((a) => ['poison', 'weapon'].includes(z.items.find((i) => i.id === a.itemId)?.kind));
      if (poisonTake) return poisonTake;
    }
    if (strategy === 'explore' || strategy === 'trap') {
      const attacks = byType('attack');
      if (attacks.length && game.bestWeapon(p) && chance(attacks.length === 1 ? 0.5 : 0.2)) return pick(attacks);
      const weaponTake = take.find((a) => z.items.find((i) => i.id === a.itemId)?.kind === 'weapon');
      if (weaponTake && chance(0.5)) return weaponTake;
    }
    const mb = byType('moveBody');
    if (mb.length && chance(0.2)) return { ...mb[0], toZoneId: pick([...game.zones.keys()].filter((id) => id !== p.zoneId)) };
    const ex = byType('examine');
    if (ex.length && chance(0.4)) return pick(ex);
    const special = [...byType('steal'), ...byType('interrogate'), ...byType('sabotage')];
    if (special.length && chance(0.3)) return pick(special);
    if (byType('clean').length && chance(0.2)) return byType('clean')[0];
    if (p.inventory.length && chance(0.1)) return pick([...byType('hide'), ...byType('drop')]);
    if (chance(0.75)) return byType('search')[0];
    return byType('rest')[0];
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

  await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error(`${label}: watchdog timeout in phase ${game.phase}/${game.step} day ${game.day}`)), 60_000);
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
                for (const c of fakes) assert(game.playerOfChar(c.id).knowsUltimate && !c.ultimate.hidden, 'fake role owner knows, not hidden');
                roleStats = { hidden: hidden.length, fakes: fakes.length };
                assert(game.escape.total >= 2 && game.escape.parts.every((x) => game.zones.get(x.zoneId).items.some((i) => i.id === x.id && i.hidden)), 'escape parts hidden in zones');
                assert(game.zones.get(game.location.exitZoneId).items.length === 0, 'exit zone starts empty');
              }
              if (game.phase === PHASE.DAY && game.step === STEP.MOVE) stats.days = Math.max(stats.days, game.day);
              if (!game.step) break; // กำลังบรรยายคดี
              if (game.step === STEP.MOVE) {
                const pendingMove = humansAlive().filter((p) => !game.moves.has(p.id));
                if (pendingMove.length) {
                  try { game.sendChat(pendingMove[0].id, `วันที่ ${game.day} ไปไหนกันดี`); } catch {}
                  for (const p of pendingMove) game.chooseMove(p.id, decideMove(p));
                }
              } else if (game.step === STEP.ACT) {
                const pendingAct = humansAlive().filter((p) => !game.actions.has(p.id));
                for (const p of pendingAct) {
                  const a = decideAction(p);
                  assert(a, `action chosen for ${p.id}`);
                  game.chooseAction(p.id, a);
                }
              } else if (game.step === STEP.REPORT) {
                for (const p of humansAlive().filter((x) => !game.ready.has(x.id))) {
                  const v = game.viewFor(p.id);
                  assert(v.me.log.some((l) => l.day === game.day && l.kind === 'move'), 'player has a move log entry for today');
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
              stats.trials++;
              const r = game.lastResult;
              assert(r && Array.isArray(r.cases) && r.cases.length >= 1, 'result has judged cases');
              assert(Array.isArray(r.timeline) && r.timeline.length >= 1 && r.timeline.every((t) => t.positions.length && t.positions.every((x) => x.zoneName)), 'result has timeline positions');
              for (const c of r.cases) assert(c.victimName && c.zoneName && c.causeLabel && (c.killerName || c.cause === 'objective'), 'case reveal complete');
              if (!r.correct) stats.wrongVotes++;
              if (r.votedId === NONE_VOTE) stats.noneVotes++;
              if (r.correct && r.executedId) assert(game.players.get(r.executedId).fate === 'executed', 'executed fate');
              const rv = game.viewFor(ids[0]);
              assert(rv.lastResult?.cases?.length === r.cases.length, 'result visible after trial');
              await game.nextRound(host);
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

  // สรุปสถิติจาก state จริง
  for (const c of game.cases) {
    if (c.cause === 'objective') stats.objectiveDeaths++;
    else stats.kills++;
    if (c.cause === 'trap') stats.trapKills++;
    if (c.cause === 'defense') stats.defenses++;
    if (c.cause === 'wrongTarget') stats.wrongTargets++;
  }
  stats.trials = game.history.length;
  stats.wrongVotes = game.history.filter((h) => !h.correct).length;
  stats.traps = game.timeline.reduce((n, t) => n + t.events.filter((e) => e.includes('วางกับดัก')).length, 0);
  stats.partsFound = game.escape.parts.filter((x) => x.found).length;
  if (game.endReason === 'escape') stats.escapes++;

  const all = [...game.players.values()];
  const o = game.outcome;
  assert(o && o.survived.length + o.died.length === all.length, 'every player appears in outcome exactly once');
  for (const r of o.survived) assert(SURVIVED_FATES.includes(r.fate), `survived fate valid (${r.fate})`);
  for (const r of o.died) assert(DEAD_FATES.includes(r.fate), `died fate valid (${r.fate})`);
  if (game.endReason === 'wrong_vote') {
    assert(all.every((p) => !p.alive), 'wrong vote kills everyone');
    // คนร้ายที่ยังมีชีวิตตอนตัดสินต้อง "รอด" (escaped); คนร้ายที่ตายไปก่อนแล้วคง fate เดิม
    for (const c of game.cases.filter((x) => x.killerId)) assert(['escaped', 'executed', 'victim', 'perished'].includes(game.players.get(c.killerId).fate), `killer fate after wrong vote (${game.players.get(c.killerId).fate})`);
  }
  if (game.endReason === 'last_one') assert(all.filter((p) => p.alive).length <= 1, 'last_one leaves ≤1 alive');
  if (game.endReason === 'escape') assert(game.escape.achieved && all.filter((p) => p.fate === 'survivor').length >= 1, 'escape ends with survivors');
  // ศพทุกศพอยู่ในห้องที่ถูกต้อง และคดีทุกคดีมีเหยื่อตายจริง
  for (const b of game.bodies.values()) assert(!game.players.get(b.victimId).alive, 'body belongs to a dead player');
  for (const c of game.cases) assert(!game.players.get(c.victimId).alive || game.players.get(c.victimId).revived, 'case victim dead (or revived)');

  Object.assign(CONFIG, saved);
  console.log(
    `✔ ${label}: ${all.length} players · end=${game.endReason} day ${game.day} · ${stats.trials} trial(s) (${stats.wrongVotes} wrong, ${stats.noneVotes} none, ${stats.runoffs} runoff) · kills ${stats.kills} (trap ${stats.trapKills}, defense ${stats.defenses}, wrong-target ${stats.wrongTargets}) · objective deaths ${stats.objectiveDeaths} · traps set ${stats.traps} · parts ${stats.partsFound}/${game.escape.total} · ${roleStats.hidden} hidden + ${roleStats.fakes} fake · ${stats.leakChecks} leak checks, ${stats.actionsChecked} action checks`,
  );
  return { ...stats, endReason: game.endReason, roleStats, game };
}

try {
  const agg = { kills: 0, trapKills: 0, objectiveDeaths: 0, trials: 0, escapes: 0, wrongVotes: 0, defenses: 0, wrongTargets: 0 };
  const add = (r) => { for (const k of Object.keys(agg)) agg[k] += r[k] || 0; };

  for (let i = 0; i < 4; i++) add(await runGame({ humans: 8, label: `explore #${i + 1}`, strategy: 'explore', config: { REVIVE_CHANCE: 0 } }));
  add(await runGame({ humans: 3, bots: 4, label: 'with bots', strategy: 'explore', config: { REVIVE_CHANCE: 0 } }));
  add(await runGame({ humans: 15, label: 'full 15', strategy: 'explore', config: { REVIVE_CHANCE: 0 } }));
  const wrong = await runGame({ humans: 8, label: 'always wrong vote → game over', strategy: 'explore', voteStrategy: 'wrong', config: { REVIVE_CHANCE: 0 } });
  add(wrong);
  if (wrong.trials) assert(wrong.endReason === 'wrong_vote' && wrong.wrongVotes === 1, 'wrong vote ends the game immediately');
  const trap = await runGame({ humans: 8, label: 'trap-heavy', strategy: 'trap', config: { REVIVE_CHANCE: 0 } });
  add(trap);
  const peaceful = await runGame({ humans: 6, label: 'peaceful (objectives + timeout)', strategy: 'peaceful', config: { REVIVE_CHANCE: 0, MAX_DAYS: 6 } });
  add(peaceful);
  assert(peaceful.kills === 0, 'peaceful run has no kills');
  const esc = await runGame({ humans: 6, label: 'escape-focused', strategy: 'escape', config: { REVIVE_CHANCE: 0, OBJECTIVES: false, MAX_DAYS: 14, FIND_PART_CHANCE: 0.9 } });
  add(esc);
  const split = await runGame({ humans: 6, label: 'forced ties → runoff', strategy: 'explore', voteStrategy: 'split', config: { REVIVE_CHANCE: 0 } });
  add(split);
  const revive = await runGame({ humans: 7, label: 'revive events (chance 100%)', strategy: 'explore', config: { REVIVE_CHANCE: 1 } });
  add(revive);
  const noObj = await runGame({ humans: 5, label: 'objectives disabled', strategy: 'explore', config: { REVIVE_CHANCE: 0, OBJECTIVES: false, FAKE_ROLES: 0 } });
  add(noObj);
  assert(noObj.objectiveDeaths === 0 && noObj.roleStats.fakes === 0, 'no objective deaths / no fake role when disabled');

  assert(agg.kills >= 3, `simulations should produce kills (got ${agg.kills})`);
  assert(agg.trials >= 2, `simulations should reach trials (got ${agg.trials})`);
  assert(agg.objectiveDeaths >= 1, 'objective deadline deaths should occur');
  console.log(`ALL SIMULATIONS PASSED — totals: ${JSON.stringify(agg)}`);
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
