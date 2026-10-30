// จำลองเกมเต็มรอบด้วย mock AI เพื่อตรวจ state machine, การซ่อนข้อมูล, โหวตรอบตัดสิน, อีเวนต์คืนชีพ และสรุปผล
// รัน: npm test
import { Game, PHASE, CONFIG, DEAD_FATES, SURVIVED_FATES, hiddenUltimateCap } from '../server/game.js';
import { createAI } from '../server/ai.js';

CONFIG.BOT_DELAY_SCALE = 0.02;

const quietLog = { info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERTION FAILED:', msg);
    process.exit(1);
  }
}

// voteStrategy: 'random' = ครึ่งหนึ่งโหวตถูก ครึ่งหนึ่งสุ่ม | 'split' = ตั้งใจแบ่งคะแนนให้เสมอในรอบแรก แล้วรอบตัดสินโหวตคนแรก
async function runGame({ humans, bots, label, voteStrategy = 'random', config = {} }) {
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

  let acting = false;
  let trials = 0;
  let runoffs = 0;
  let leakChecks = 0;
  let wrongVotes = 0;
  let rolesChecked = false;
  let roleStats = { hidden: 0, fakes: 0 };
  let usedUltimateCases = 0;
  let observationChecks = 0;

  const checkViews = () => {
    const N = game.players.size;
    for (const id of ids) {
      const v = game.viewFor(id);
      assert(v.players.length === N, 'view has all players');
      for (const p of v.players) {
        if (!p.character) continue;
        const realPlayer = game.players.get(p.id);
        const realChar = game.charOf(realPlayer);
        const isMe = p.id === id;
        const exposed = realChar.ultimateRevealed || game.phase === PHASE.ENDED;
        if (realChar.fakeRole && !exposed && !isMe) {
          // โรลปลอม: คนอื่นต้องเห็นชื่อปลอม และห้ามรู้ว่าเป็นของปลอม
          assert(p.character.ultimate === realChar.fakeUltimate.title, `fake role must show decoy to others (${p.id} → ${id})`);
          assert(p.character.ultimate !== realChar.ultimate.title, 'fake role leaked real title');
          assert(p.character.fakeUltimate == null && !p.character.fakeRoleExposed, 'fake role flag leaked to others');
        } else if (realChar.fakeRole) {
          assert(p.character.ultimate === realChar.ultimate.title, 'fake role owner/exposed view shows real title');
          assert(p.character.fakeUltimate === realChar.fakeUltimate.title, 'fake title visible to owner or after exposure');
          assert(realChar.fakeUltimate.title !== realChar.ultimate.title, 'decoy differs from real');
        } else {
          const mayShow = !realChar.ultimate.hidden || exposed || (isMe && realPlayer.knowsUltimate);
          if (!mayShow) {
            assert(p.character.ultimate === '???', `hidden ultimate leaked for ${p.id} to ${id}`);
            assert(p.character.ultimateDescription == null, 'hidden ultimate description leaked');
          } else {
            assert(p.character.ultimate === realChar.ultimate.title, 'visible ultimate shown');
          }
          assert(!p.character.fakeRoleExposed && p.character.fakeUltimate == null, 'non-fake char has no fake fields');
        }
        assert(!('rank' in p), 'rank field must not exist anymore');
      }
      if (game.phase === PHASE.INVESTIGATION) {
        const inc = game.incident;
        const json = JSON.stringify(v.incident);
        assert(!json.includes('culprit'), 'public incident leaks culprit field');
        assert(!json.includes(inc.culpritStory.slice(0, 20)), 'public incident leaks story');
        // โครงสร้างคดีแบบใหม่: วิธีการ + ตำแหน่งทุกคน + เส้นทางการไขคดี
        assert(inc.method && inc.method.cause && typeof inc.method.usedUltimate === 'boolean', 'incident has method');
        if (!inc.method.usedUltimate) assert(inc.method.ultimateUse === '', 'ultimateUse empty when not used');
        assert(Array.isArray(inc.deductionChain) && inc.deductionChain.length >= 2, 'incident has deduction chain');
        const present = [...game.players.values()].filter((p) => p.alive || p.id === inc.victimPlayerId);
        for (const p of present) assert(inc.whereabouts.some((w) => w.characterId === p.characterId), `whereabouts missing ${p.id}`);
        const culpritChar = game.charOf(game.players.get(inc.culpritPlayerId));
        const culpritWhere = inc.whereabouts.find((w) => w.characterId === culpritChar.id);
        assert(culpritWhere && culpritWhere.where, 'culprit has whereabouts truth');
        assert(v.incident.whereabouts === undefined && v.incident.observations === undefined, 'public incident must not carry whereabouts/observations');
        const viewJson = JSON.stringify(v);
        const myChar = game.charOf(game.players.get(id));
        const me = game.players.get(id);
        if (id !== inc.culpritPlayerId) {
          assert(!v.me.clues?.story && !v.me.clues?.method, `non-culprit ${id} sees culprit story/method`);
          assert(!viewJson.includes(culpritWhere.where.slice(0, 25)), `non-culprit ${id} view leaks culprit truth`);
          if (me.alive) {
            const mine = inc.whereabouts.find((w) => w.characterId === myChar.id);
            assert(v.me.clues?.myNight === mine.where, 'alive player sees own night truth');
          }
        } else {
          assert(v.me.clues?.role === 'culprit' && v.me.clues.story, 'culprit sees story');
          assert(v.me.clues.method?.cause === inc.method.cause, 'culprit sees method');
        }
        // เหตุการณ์ย่อย: เห็นเฉพาะคนใน knownBy เท่านั้น
        // ถ้าเหลือแค่คนร้ายกับเหยื่อ ไม่มีใครเห็นอะไรได้ จึงไม่มี observation
        assert(inc.observations.length >= 1 || present.length <= 2, 'incident has observations');
        for (const o of inc.observations) {
          assert(o.knownBy.length >= 1 && o.knownBy.length <= 3, 'observation known by 1-3 people');
          assert(o.knownBy.length < game.alivePlayers().length, 'observation must not be known by everyone');
          if (o.knownBy.includes(myChar.id) && me.alive) assert(v.me.clues?.observations?.includes(o.text), `member ${id} sees observation`);
          else if (me.alive) assert(!viewJson.includes(o.text), `non-member ${id} must not see observation "${o.text.slice(0, 30)}"`);
        }
        observationChecks += inc.observations.length;
        assert(v.lastResult === null, 'lastResult hidden during investigation');
        if (v.runoff) assert(v.runoff.candidates.length >= 2, 'runoff has at least 2 candidates');
        leakChecks++;
      }
      if (game.phase === PHASE.DAY && game.specialEvent) {
        if (id !== game.specialEvent.playerId) assert(v.me.eventPrivateNote == null, 'event private note leaked');
        else assert(typeof v.me.eventPrivateNote === 'string', 'revived player sees private note');
        assert(!JSON.stringify(v.specialEvent).includes('privateNote'), 'public event carries private note');
      }
    }
  };

  await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error(`${label}: watchdog timeout in phase ${game.phase}`)), 60_000);
    let pending = false;
    game.onChange = () => {
      pending = true;
      if (acting) return;
      acting = true;
      setImmediate(async function tick() {
        pending = false;
        try {
          checkViews();
          const alive = game.alivePlayers().filter((p) => !p.isBot);
          switch (game.phase) {
            case PHASE.DAY: {
              if (!rolesChecked) {
                rolesChecked = true;
                const n = game.characters.length;
                const hidden = game.characters.filter((c) => c.ultimate.hidden);
                const fakes = game.characters.filter((c) => c.fakeRole);
                assert(hidden.length >= 1 && hidden.length <= hiddenUltimateCap(n), `hidden ultimates ${hidden.length} within cap ${hiddenUltimateCap(n)} for ${n}`);
                assert(fakes.length === Math.min(CONFIG.FAKE_ROLES, n - 1), `exactly ${CONFIG.FAKE_ROLES} fake role(s), got ${fakes.length}`);
                for (const c of fakes) {
                  assert(!c.ultimate.hidden, 'fake role is never also hidden');
                  assert(c.fakeUltimate?.title && c.fakeUltimate.title !== c.ultimate.title, 'fake role has distinct decoy');
                  assert(!game.characters.some((o) => o !== c && o.ultimate.title === c.fakeUltimate.title), 'decoy title does not collide with a real title');
                  assert(game.playerOfChar(c.id).knowsUltimate, 'fake role owner always knows real ultimate');
                }
                roleStats = { hidden: hidden.length, fakes: fakes.length };
              }
              const pendingSleep = alive.filter((p) => !game.sleepConfirmed.has(p.id));
              if (pendingSleep.length) {
                try { game.sendChat(pendingSleep[0].id, `สวัสดีวันที่ ${game.round}`); } catch {}
                for (const p of pendingSleep) game.confirmSleep(p.id);
              }
              break;
            }
            case PHASE.NIGHT: {
              const m = game.players.get(game.night.murdererId);
              if (!m.isBot && !game.night.targetId) {
                const cands = game.alivePlayers().filter((p) => p.id !== m.id);
                await game.chooseTarget(m.id, pick(cands).id);
              }
              break;
            }
            case PHASE.INVESTIGATION: {
              if (game.runoff && game.runoff.number > runoffs) runoffs = game.runoff.number;
              const pendingVote = alive.filter((p) => !game.confirmedVotes.has(p.id));
              const culprit = game.players.get(game.incident.culpritPlayerId);
              pendingVote.forEach((p, i) => {
                const cands = game.voteCandidates(p.id);
                assert(cands.length > 0, 'voter always has a candidate');
                let target;
                if (voteStrategy === 'split' && !game.runoff) {
                  // โหวตแบบวงกลม (ทุกคนได้คนละ 1 คะแนน) → เสมอทุกคน → ต้องเกิดรอบตัดสินแน่นอน
                  const voters = game.alivePlayers();
                  const idx = voters.findIndex((v) => v.id === p.id);
                  target = voters[(idx + 1) % voters.length];
                } else if (voteStrategy === 'split') {
                  target = cands[0];
                } else if (voteStrategy === 'wrong') {
                  // ตั้งใจโหวตผิดเพื่อทดสอบเส้นทาง EXECUTE_WRONG_VOTE
                  const innocents = cands.filter((c) => c.id !== culprit.id);
                  target = innocents.length ? innocents[0] : cands[0];
                } else {
                  const culpritIsCandidate = cands.some((c) => c.id === culprit.id);
                  target = Math.random() < 0.5 && culpritIsCandidate ? culprit : pick(cands);
                }
                game.castVote(p.id, target.id);
                game.confirmVote(p.id);
              });
              break;
            }
            case PHASE.TRIAL_RESULT: {
              trials++;
              const r = game.lastResult;
              assert(r.method?.cause && r.deductionChain.length >= 2, 'result carries method + deduction chain');
              assert(r.whereabouts.length >= 2 && r.whereabouts.every((w) => 'truth' in w && w.characterName), 'result carries full whereabouts truth');
              assert(Array.isArray(r.observations) && r.observations.every((o) => o.text && o.knownBy.length), 'result carries observations with names');
              const rv = game.viewFor(ids[0]);
              assert(rv.lastResult?.whereabouts?.length === r.whereabouts.length, 'result whereabouts visible after trial');
              if (r.method.usedUltimate) usedUltimateCases++;
              const culprit = game.players.get(r.culpritId);
              assert(!culprit.alive, 'culprit leaves the game after trial');
              assert(culprit.fate === (r.correct ? 'executed' : 'escaped'), 'culprit fate matches vote');
              assert(!game.players.get(r.victimId).alive, 'victim dead');
              if (!r.correct) wrongVotes++;
              if (r.accusedExecuted) {
                assert(CONFIG.EXECUTE_WRONG_VOTE, 'accused executed only when enabled');
                assert(game.players.get(r.accusedId).fate === 'wrongly_executed', 'accused fate');
              } else if (!r.correct && r.accusedId && CONFIG.EXECUTE_WRONG_VOTE) {
                assert(false, 'wrong vote with EXECUTE_WRONG_VOTE must execute accused');
              }
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

  // ตรวจสรุปผล
  const all = [...game.players.values()];
  const o = game.outcome;
  assert(o && o.survived.length + o.died.length === all.length, 'every player appears in outcome exactly once');
  const seen = new Set([...o.survived, ...o.died].map((r) => r.playerId));
  assert(seen.size === all.length, 'no duplicate outcome rows');
  for (const r of o.survived) assert(SURVIVED_FATES.includes(r.fate), `survived fate valid (${r.fate})`);
  for (const r of o.died) assert(DEAD_FATES.includes(r.fate), `died fate valid (${r.fate})`);
  assert(all.filter((p) => p.fate === 'survivor').length <= 1, 'at most one final survivor');
  const revived = all.filter((p) => p.revived).length;

  Object.assign(CONFIG, saved);
  console.log(
    `✔ ${label}: ${all.length} players, ${trials} trials (${wrongVotes} wrong, ${usedUltimateCases} used Ultimate), ${runoffs} runoff(s), ${revived} revived, ${roleStats.hidden} hidden + ${roleStats.fakes} fake role(s), ${leakChecks} leak checks, ${observationChecks} observation checks`,
  );
  console.table(
    [...o.survived, ...o.died].map((r) => ({
      player: r.name,
      character: r.characterName,
      ultimate: r.ultimate,
      shownAs: r.fakeRole ? r.fakeUltimate : '',
      fate: r.fate,
      round: r.eliminatedRound,
      revived: r.revived,
    })),
  );
  return { trials, runoffs, revived, wrongVotes, usedUltimateCases, roleStats };
}

try {
  await runGame({ humans: 7, bots: 0, label: 'humans only', config: { REVIVE_CHANCE: 0 } });
  await runGame({ humans: 2, bots: 4, label: 'with bots', config: { REVIVE_CHANCE: 0 } });
  await runGame({ humans: 15, bots: 0, label: 'full 15', config: { REVIVE_CHANCE: 0 } });
  const exec = await runGame({ humans: 8, bots: 0, label: 'always wrong + execute wrong vote', voteStrategy: 'wrong', config: { REVIVE_CHANCE: 0, EXECUTE_WRONG_VOTE: true } });
  assert(exec.wrongVotes >= 1, 'wrong strategy must produce wrong votes');
  const split = await runGame({ humans: 6, bots: 0, label: 'forced ties → runoff', voteStrategy: 'split', config: { REVIVE_CHANCE: 0 } });
  assert(split.runoffs >= 1, 'split strategy must trigger at least one runoff');
  const revive = await runGame({ humans: 7, bots: 0, label: 'revive events (chance 100%)', config: { REVIVE_CHANCE: 1 } });
  assert(revive.revived >= 1, 'revive run must revive at least one player');
  const ten = await runGame({ humans: 10, bots: 0, label: 'ten players → 1-2 hidden + 1 fake', config: { REVIVE_CHANCE: 0 } });
  assert(ten.roleStats.hidden >= 1 && ten.roleStats.hidden <= 2 && ten.roleStats.fakes === 1, 'ten players must have 1-2 hidden and 1 fake role');
  const noFake = await runGame({ humans: 5, bots: 0, label: 'fake roles disabled', config: { REVIVE_CHANCE: 0, FAKE_ROLES: 0 } });
  assert(noFake.roleStats.fakes === 0, 'FAKE_ROLES=0 yields no fake role');
  console.log(`ALL SIMULATIONS PASSED (execute-wrong-vote run had ${exec.wrongVotes} wrong votes)`);
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
