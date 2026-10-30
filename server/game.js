// Game engine — state machine ของบอร์ดเกม
import { CHARACTERS } from './characters.js';
import { ULTIMATE_POOL } from './mock.js';

export const PHASE = {
  LOBBY: 'lobby',
  GENERATING: 'generating',
  DAY: 'day',
  NIGHT: 'night',
  INCIDENT: 'incident',
  INVESTIGATION: 'investigation',
  TRIAL_RESULT: 'trial_result',
  ENDED: 'ended',
};

// ค่าเหล่านี้แก้ได้ตอนรัน (เช่นในเทสต์) ด้วย Object.assign(CONFIG, {...})
export const CONFIG = {
  MIN_PLAYERS: Number(process.env.MIN_PLAYERS || 3),
  MAX_PLAYERS: 15,
  NIGHT_TIMEOUT_MS: Number(process.env.NIGHT_TIMEOUT_MS || 120_000),
  MAX_CHAT: 300,
  // โอกาสที่เจ้าของ Ultimate ที่ถูกซ่อนจะ "รู้ตัว" ตั้งแต่ต้นเกม
  KNOW_OWN_ULTIMATE_CHANCE: 0.5,
  // โอกาสที่เจ้าของจะรู้ตัวหลังเกิดคดี (ถ้าไม่ได้เกี่ยวข้องโดยตรง)
  LEARN_AFTER_CASE_CHANCE: 0.4,
  // ตัวคูณความเร็วของบอท (ใช้ค่าน้อย ๆ ตอนเทสต์)
  BOT_DELAY_SCALE: Number(process.env.BOT_DELAY_SCALE || 1),
  // โหวตเสมอ → โหวตรอบตัดสินเฉพาะคนที่เสมอ ได้สูงสุดกี่รอบ ก่อนจะสุ่มตัดสิน
  MAX_RUNOFFS: Number(process.env.MAX_RUNOFFS || 2),
  // โหวตผิด: ถ้า true คนที่ถูกโหวตผิดจะถูกประหารด้วย (ค่าเริ่มต้น false = คนร้ายหนีรอด ไม่มีใครตายเพิ่ม)
  EXECUTE_WRONG_VOTE: process.env.EXECUTE_WRONG_VOTE === 'true',
  // โอกาสเกิดอีเวนต์พิเศษ "คืนชีพ" ตอนเริ่มวันใหม่ (เฉพาะเหยื่อ และคนละครั้ง)
  REVIVE_CHANCE: process.env.REVIVE_CHANCE !== undefined ? Number(process.env.REVIVE_CHANCE) : 0.2,
  // จำนวน Ultimate ที่ถูกซ่อนเป็น ??? จริง ๆ = clamp(round(ผู้เล่น × RATIO), 1, MAX) → 10 คนได้ 2, 7 คนได้ 1
  HIDDEN_ULTIMATE_RATIO: Number(process.env.HIDDEN_ULTIMATE_RATIO || 0.15),
  HIDDEN_ULTIMATE_MAX: Number(process.env.HIDDEN_ULTIMATE_MAX || 2),
  // จำนวน "โรลปลอม": Ultimate ที่ประกาศให้คนอื่นเห็นไม่ใช่ของจริง (เจ้าของรู้ คนอื่นไม่รู้)
  FAKE_ROLES: Number(process.env.FAKE_ROLES !== undefined ? process.env.FAKE_ROLES : 1),
};

export const hiddenUltimateCap = (n) => Math.max(1, Math.min(CONFIG.HIDDEN_ULTIMATE_MAX, Math.round(n * CONFIG.HIDDEN_ULTIMATE_RATIO)));

// fate ที่เป็นไปได้: victim (ถูกฆ่า), executed (คนร้ายถูกจับและประหาร), escaped (คนร้ายหนีรอด),
// wrongly_executed (ถูกโหวตผิดและถูกประหาร — เฉพาะเมื่อเปิด EXECUTE_WRONG_VOTE), survivor (รอดจนจบเกม)
export const DEAD_FATES = ['victim', 'executed', 'wrongly_executed'];
export const SURVIVED_FATES = ['survivor', 'escaped'];

export class GameError extends Error {}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const sanitizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'ผู้เล่นนิรนาม';

const makePlayer = (id, name, isBot) => ({
  id,
  name,
  isBot,
  connected: true,
  characterId: null,
  alive: true,
  knowsUltimate: false,
  fate: null,
  eliminatedRound: null,
  revived: false,
  revivedRound: null,
  joinedAt: Date.now(),
});

const resetPlayerState = (p) => {
  p.characterId = null;
  p.alive = true;
  p.knowsUltimate = false;
  p.fate = null;
  p.eliminatedRound = null;
  p.revived = false;
  p.revivedRound = null;
};

export class Game {
  constructor({ code, ai, onChange, log = console }) {
    this.code = code;
    this.ai = ai;
    this.onChange = onChange || (() => {});
    this.log = log;
    this.players = new Map();
    this.hostId = null;
    this.chat = [];
    this.timers = new Set();
    this.lastActivity = Date.now();
    this.resetGameState();
  }

  // ---------- helpers ----------
  resetGameState() {
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.characters = [];
    this.location = null;
    this.previousLocations = [];
    this.night = null;
    this.incident = null;
    this.votes = new Map();
    this.confirmedVotes = new Set();
    this.sleepConfirmed = new Set();
    this.runoff = null;
    this.runoffCount = 0;
    this.lastResult = null;
    this.history = [];
    this.outcome = null;
    this.specialEvent = null;
    this.generating = null;
    this.notices = new Map();
    this.clearTimers();
    for (const p of this.players.values()) resetPlayerState(p);
  }

  emit() {
    this.lastActivity = Date.now();
    try {
      this.onChange(this);
    } catch (err) {
      this.log.error('onChange failed', err);
    }
  }

  setTimer(fn, ms) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') r.catch((e) => this.fail(e));
      } catch (e) {
        this.fail(e);
      }
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  assertHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('เฉพาะหัวห้องเท่านั้นที่ทำได้');
  }

  assertPhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('ไม่สามารถทำได้ในช่วงนี้ของเกม');
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  humans() {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  alivePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('ไม่พบผู้เล่น');
    if (!p.alive) throw new GameError('คุณไม่ได้อยู่ในเกมแล้ว ทำได้แค่ดูเท่านั้น');
    return p;
  }

  charOf(player) {
    if (!player?.characterId) return null;
    return this.characters.find((c) => c.id === player.characterId) || null;
  }

  playerOfChar(characterId) {
    return [...this.players.values()].find((p) => p.characterId === characterId) || null;
  }

  pushChat(msg) {
    this.chat.push({ id: nextId(), ts: Date.now(), phase: this.phase, round: this.round, ...msg });
    if (this.chat.length > CONFIG.MAX_CHAT) this.chat.splice(0, this.chat.length - CONFIG.MAX_CHAT);
  }

  systemMessage(text) {
    this.pushChat({ system: true, text });
  }

  notify(playerId, text, kind = 'info') {
    const p = this.players.get(playerId);
    if (!p || p.isBot) return;
    if (!this.notices.has(playerId)) this.notices.set(playerId, []);
    this.notices.get(playerId).push({ id: nextId(), text, kind, ts: Date.now() });
  }

  dismissNotice(playerId, noticeId) {
    const list = this.notices.get(playerId);
    if (!list) return;
    this.notices.set(playerId, list.filter((n) => n.id !== noticeId));
    this.emit();
  }

  fail(err) {
    this.log.error(`[room ${this.code}] game error:`, err);
    const msg = err instanceof GameError ? err.message : 'ระบบเกิดข้อผิดพลาดระหว่างสร้างเหตุการณ์ กรุณาลองใหม่';
    this.generating = null;
    this.systemMessage(`⚠ ${msg}`);
    if (this.phase === PHASE.GENERATING && this.round <= 1 && !this.location) {
      this.resetGameState();
    } else if (this.phase === PHASE.INCIDENT || this.phase === PHASE.NIGHT) {
      // กลับไปช่วงกลางวันเพื่อให้ลองเข้านอนใหม่
      this.night = null;
      this.sleepConfirmed = new Set();
      this.phase = PHASE.DAY;
      this.scheduleBots();
    } else if (this.phase === PHASE.GENERATING) {
      this.phase = PHASE.TRIAL_RESULT;
    }
    this.emit();
  }

  // ---------- lobby ----------
  addPlayer({ id, name }) {
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      if (name && this.phase === PHASE.LOBBY) existing.name = sanitizeName(name);
      this.emit();
      return existing;
    }
    if (this.phase !== PHASE.LOBBY) throw new GameError('เกมในห้องนี้เริ่มไปแล้ว ไม่สามารถเข้าร่วมได้');
    if (this.players.size >= CONFIG.MAX_PLAYERS) throw new GameError(`ห้องเต็มแล้ว (สูงสุด ${CONFIG.MAX_PLAYERS} คน)`);
    const player = makePlayer(id, sanitizeName(name), false);
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.systemMessage(`${player.name} เข้าร่วมห้อง`);
    this.emit();
    return player;
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.phase === PHASE.LOBBY) {
      this.players.delete(playerId);
      this.systemMessage(`${p.name} ออกจากห้อง`);
    }
    if (playerId === this.hostId && !connected) {
      const next = this.humans().find((h) => h.connected && h.id !== playerId);
      if (next) {
        this.hostId = next.id;
        this.systemMessage(`${next.name} กลายเป็นหัวห้องคนใหม่`);
      }
    }
    if (connected && !this.hostId) this.hostId = playerId;
    this.emit();
  }

  setBots(hostId, count) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.LOBBY);
    count = Math.max(0, Math.floor(Number(count) || 0));
    for (const p of [...this.players.values()]) if (p.isBot) this.players.delete(p.id);
    const room = CONFIG.MAX_PLAYERS - this.players.size;
    count = Math.min(count, room);
    for (let i = 1; i <= count; i++) {
      const id = `bot-${i}`;
      this.players.set(id, makePlayer(id, `บอท ${i}`, true));
    }
    this.emit();
  }

  // ---------- start ----------
  async start(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.LOBBY);
    if (this.players.size < CONFIG.MIN_PLAYERS) throw new GameError(`ต้องมีผู้เล่นอย่างน้อย ${CONFIG.MIN_PLAYERS} คน (รวมบอท)`);
    this.resetGameState();
    this.phase = PHASE.GENERATING;
    this.generating = 'กำลังสุ่ม Ultimate ให้ทุกคน...';
    this.emit();
    try {
      const chars = shuffle(CHARACTERS)
        .slice(0, this.players.size)
        .map((c) => ({ ...c, ultimate: null, ultimateRevealed: false, fakeRole: false, fakeUltimate: null }));
      const ults = await this.ai.generateUltimates(chars);
      for (const c of chars) {
        const u = ults.find((x) => x.characterId === c.id) || ults.shift();
        c.ultimate = {
          title: u.title,
          description: u.description,
          hidden: !!u.hidden,
          hiddenReason: u.hiddenReason || '',
          investigationEffect: u.investigationEffect || '',
          relevant: !!u.hidden,
        };
        c.decoy = u.decoyTitle ? { title: u.decoyTitle, description: u.decoyDescription || '' } : null;
      }
      this.assignSecretRoles(chars);
      this.characters = chars;
      const players = shuffle([...this.players.values()]);
      players.forEach((p, i) => {
        p.characterId = chars[i].id;
        p.alive = true;
        // โรลปลอม: เจ้าของต้องรู้ Ultimate จริงของตัวเองเสมอ / Ultimate ที่ซ่อน: รู้ 50/50
        p.knowsUltimate = chars[i].fakeRole ? true : chars[i].ultimate.hidden ? Math.random() < CONFIG.KNOW_OWN_ULTIMATE_CHANCE : true;
      });
      this.round = 1;
      await this.newLocation();
      this.systemMessage('เกมเริ่มแล้ว! ทุกคนได้รับตัวละครและ Ultimate ของตัวเองแล้ว');
      this.enterDay();
    } catch (err) {
      this.fail(err);
    }
  }

  // จาก Ultimate ที่ AI บอกว่า "มีผลต่อคดี" (hidden=true) เลือกซ่อนจริงแค่ 1-2 คน และทำโรลปลอม 1 คน ที่เหลือเปิดเผยตามปกติ
  assignSecretRoles(chars) {
    const relevant = shuffle(chars.filter((c) => c.ultimate.relevant));
    const fallback = shuffle(chars.filter((c) => !c.ultimate.relevant));
    const queue = [...relevant, ...fallback];
    const fakeCount = Math.min(CONFIG.FAKE_ROLES, Math.max(0, chars.length - 1));
    const hiddenCap = hiddenUltimateCap(chars.length);
    for (const c of chars) c.ultimate.hidden = false;

    const usedTitles = new Set(chars.map((c) => c.ultimate.title));
    const fakes = queue.splice(0, fakeCount);
    for (const c of fakes) {
      let decoy = c.decoy;
      if (!decoy || !decoy.title || usedTitles.has(decoy.title)) {
        const spare = ULTIMATE_POOL.filter((u) => !u.hidden && !usedTitles.has(u.title));
        const alt = spare.length ? pick(spare) : null;
        decoy = alt ? { title: alt.title, description: alt.description } : { title: 'สุดยอดนักสะสมของเก่า', description: 'จำที่มาของของเก่าทุกชิ้นได้' };
      }
      usedTitles.add(decoy.title);
      c.fakeRole = true;
      c.fakeUltimate = decoy;
    }
    // ซ่อนจริง: เลือกจากที่เหลือ (ให้ความสำคัญกับ Ultimate ที่มีผลต่อคดี)
    for (const c of queue.slice(0, hiddenCap)) c.ultimate.hidden = true;
    for (const c of chars) delete c.decoy;
  }

  async newLocation() {
    this.generating = 'กำลังจำลองสถานที่และอุปกรณ์...';
    this.emit();
    const loc = await this.ai.generateLocation({ round: this.round, previousNames: this.previousLocations });
    this.location = loc;
    this.previousLocations.push(loc.name);
  }

  enterDay() {
    this.phase = PHASE.DAY;
    this.generating = null;
    this.sleepConfirmed = new Set();
    this.night = null;
    this.incident = null;
    this.votes = new Map();
    this.confirmedVotes = new Set();
    this.runoff = null;
    this.runoffCount = 0;
    this.systemMessage(`— วันที่ ${this.round} — ทุกคนมาถึง "${this.location.name}" พูดคุยกันได้ตามสบาย เมื่อพร้อมแล้วกด "เข้านอน"`);
    this.emit();
    this.scheduleBots();
  }

  // ---------- day ----------
  confirmSleep(playerId) {
    this.assertPhase(PHASE.DAY);
    this.alivePlayer(playerId);
    this.sleepConfirmed.add(playerId);
    this.emit();
    if (this.alivePlayers().every((p) => this.sleepConfirmed.has(p.id))) this.beginNight();
  }

  cancelSleep(playerId) {
    this.assertPhase(PHASE.DAY);
    this.sleepConfirmed.delete(playerId);
    this.emit();
  }

  forceSleep(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.DAY);
    this.systemMessage('หัวห้องสั่งให้ทุกคนเข้านอน');
    this.beginNight();
  }

  // ---------- night ----------
  beginNight() {
    const alive = this.alivePlayers();
    if (alive.length < 2) {
      this.endGame();
      return;
    }
    this.phase = PHASE.NIGHT;
    this.specialEvent = null;
    const murderer = pick(alive);
    this.night = { murdererId: murderer.id, targetId: null, deadline: Date.now() + CONFIG.NIGHT_TIMEOUT_MS, auto: false };
    this.systemMessage('ทุกคนเข้านอนแล้ว... คืนนี้เงียบผิดปกติ');
    this.emit();
    const autoPick = () => {
      if (this.phase !== PHASE.NIGHT || !this.night || this.night.targetId) return;
      const cands = this.alivePlayers().filter((p) => p.id !== murderer.id);
      return this.chooseTarget(murderer.id, pick(cands).id, true);
    };
    this.setTimer(autoPick, CONFIG.NIGHT_TIMEOUT_MS);
    if (murderer.isBot) this.setTimer(autoPick, (2000 + Math.random() * 2000) * CONFIG.BOT_DELAY_SCALE);
  }

  async chooseTarget(playerId, targetId, auto = false) {
    this.assertPhase(PHASE.NIGHT);
    if (!this.night || playerId !== this.night.murdererId) throw new GameError('คุณไม่ใช่ฆาตกรของคืนนี้');
    if (this.night.targetId) throw new GameError('เลือกเป้าหมายไปแล้ว');
    const target = this.players.get(targetId);
    if (!target || !target.alive || targetId === playerId) throw new GameError('เป้าหมายไม่ถูกต้อง');
    this.night.targetId = targetId;
    this.night.auto = auto;
    this.clearTimers();
    await this.runIncident();
  }

  async runIncident() {
    this.phase = PHASE.INCIDENT;
    this.generating = 'เหตุการณ์กำลังเกิดขึ้นในความมืด...';
    this.emit();
    try {
      const alive = this.alivePlayers();
      const murdererP = this.players.get(this.night.murdererId);
      const targetP = this.players.get(this.night.targetId);
      const ctx = {
        round: this.round,
        location: this.location,
        characters: alive.map((p) => {
          const c = this.charOf(p);
          return { ...c, ownerKnows: p.knowsUltimate, revived: p.revived };
        }),
        murdererId: this.charOf(murdererP).id,
        targetId: this.charOf(targetP).id,
        previousCases: this.history.map((h) => h.summary),
      };
      const inc = await this.ai.generateIncident(ctx);
      const victimP = this.playerOfChar(inc.victimId);
      const culpritP = this.playerOfChar(inc.culpritId);
      if (!victimP?.alive || !culpritP?.alive || victimP.id === culpritP.id) {
        throw new Error(`AI returned invalid victim/culprit (${inc.victimId}/${inc.culpritId})`);
      }
      this.incident = {
        ...inc,
        round: this.round,
        victimPlayerId: victimP.id,
        culpritPlayerId: culpritP.id,
        murdererPlayerId: murdererP.id,
        targetPlayerId: targetP.id,
      };
      victimP.alive = false;
      victimP.fate = 'victim';
      victimP.eliminatedRound = this.round;

      // เจ้าของ Ultimate ที่ถูกซ่อนอาจ "รู้ตัว" หลังเกิดคดี
      for (const p of this.alivePlayers()) {
        const c = this.charOf(p);
        if (c.ultimate.hidden && !p.knowsUltimate) {
          const involved = (inc.involvedCharacterIds || []).includes(c.id);
          if (involved || Math.random() < CONFIG.LEARN_AFTER_CASE_CHANCE) {
            p.knowsUltimate = true;
            this.notify(p.id, `เหตุการณ์คืนนี้ทำให้คุณตระหนักถึงความสามารถที่แท้จริงของตัวเอง: ${c.ultimate.title}`, 'reveal');
          }
        }
      }
      this.systemMessage(`พบศพ! ${this.charOf(victimP).name} (${victimP.name}) ถูกพบเสียชีวิตแล้ว เริ่มการสืบสวน`);
      this.generating = null;
      if (this.alivePlayers().length <= 1) {
        this.endGame();
        return;
      }
      this.phase = PHASE.INVESTIGATION;
      this.emit();
      this.scheduleBots();
    } catch (err) {
      this.fail(err);
    }
  }

  // ---------- investigation / vote ----------
  voteCandidates(voterId) {
    const base = this.runoff ? this.runoff.candidates.map((id) => this.players.get(id)).filter(Boolean) : this.alivePlayers();
    return base.filter((p) => p.alive && p.id !== voterId);
  }

  castVote(playerId, targetId) {
    this.assertPhase(PHASE.INVESTIGATION);
    this.alivePlayer(playerId);
    if (this.confirmedVotes.has(playerId)) throw new GameError('คุณยืนยันโหวตไปแล้ว');
    const t = this.players.get(targetId);
    if (!t || !t.alive || t.id === playerId) throw new GameError('โหวตไม่ถูกต้อง');
    if (this.runoff && !this.runoff.candidates.includes(targetId)) throw new GameError('รอบตัดสินโหวตได้เฉพาะคนที่คะแนนเสมอกัน');
    this.votes.set(playerId, targetId);
    this.emit();
  }

  confirmVote(playerId) {
    this.assertPhase(PHASE.INVESTIGATION);
    this.alivePlayer(playerId);
    if (!this.votes.has(playerId)) throw new GameError('เลือกผู้ต้องสงสัยก่อนยืนยัน');
    this.confirmedVotes.add(playerId);
    this.emit();
    if (this.alivePlayers().every((p) => this.confirmedVotes.has(p.id))) this.resolveTrial();
  }

  forceVote(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.INVESTIGATION);
    if (this.votes.size === 0) throw new GameError('ยังไม่มีใครโหวตเลย');
    this.systemMessage('หัวห้องสั่งปิดโหวต');
    this.resolveTrial();
  }

  tallyVotes() {
    const tallyMap = new Map();
    for (const [voter, target] of this.votes) {
      if (!tallyMap.has(target)) tallyMap.set(target, []);
      tallyMap.get(target).push(voter);
    }
    return [...tallyMap.entries()]
      .map(([targetId, voters]) => ({ targetId, count: voters.length, voters }))
      .sort((a, b) => b.count - a.count);
  }

  resolveTrial() {
    const tally = this.tallyVotes();
    const top = tally[0]?.count || 0;
    const tied = tally.filter((t) => t.count === top);
    const tie = tied.length > 1;

    // คะแนนเสมอ → โหวตรอบตัดสินเฉพาะคนที่เสมอ
    if (tie && this.runoffCount < CONFIG.MAX_RUNOFFS) {
      this.runoffCount++;
      this.runoff = { number: this.runoffCount, candidates: tied.map((t) => t.targetId), previousTally: tally };
      this.votes = new Map();
      this.confirmedVotes = new Set();
      const names = this.runoff.candidates.map((id) => this.charOf(this.players.get(id))?.name).join(', ');
      this.systemMessage(`คะแนนเสมอกัน! โหวตรอบตัดสินครั้งที่ ${this.runoffCount} ระหว่าง ${names}`);
      this.emit();
      this.scheduleBots();
      return;
    }

    const randomTiebreak = tie;
    const votedId = tied.length ? pick(tied).targetId : null;
    const culprit = this.players.get(this.incident.culpritPlayerId);
    const victim = this.players.get(this.incident.victimPlayerId);
    const accused = votedId ? this.players.get(votedId) : null;
    const correct = votedId === culprit.id;

    culprit.alive = false;
    culprit.eliminatedRound = this.round;
    let accusedExecuted = false;
    if (correct) {
      culprit.fate = 'executed';
    } else {
      culprit.fate = 'escaped';
      if (CONFIG.EXECUTE_WRONG_VOTE && accused && accused.alive) {
        accused.alive = false;
        accused.fate = 'wrongly_executed';
        accused.eliminatedRound = this.round;
        accusedExecuted = true;
      }
    }
    this.charOf(culprit).ultimateRevealed = true;
    this.charOf(victim).ultimateRevealed = true;
    this.clearTimers();

    const culpritChar = this.charOf(culprit);
    this.lastResult = {
      round: this.round,
      tally,
      votedId,
      tie,
      randomTiebreak,
      runoffs: this.runoffCount,
      correct,
      culpritId: culprit.id,
      victimId: victim.id,
      culpritFate: culprit.fate,
      culpritFakeRole: !!culpritChar.fakeRole,
      culpritFakeUltimate: culpritChar.fakeRole ? culpritChar.fakeUltimate?.title || null : null,
      accusedId: votedId,
      accusedExecuted,
      truthSummary: this.incident.truthSummary,
      culpritStory: this.incident.culpritStory,
      method: this.incident.method,
      deductionChain: this.incident.deductionChain || [],
      whereabouts: this.resolvedWhereabouts(),
      observations: this.resolvedObservations(),
      murdererId: this.incident.murdererPlayerId,
      targetId: this.incident.targetPlayerId,
    };
    this.history.push({
      round: this.round,
      locationName: this.location.name,
      title: this.incident.title,
      victimName: this.charOf(victim).name,
      culpritName: culpritChar.name,
      correct,
      summary: this.incident.truthSummary,
    });
    this.systemMessage(
      correct
        ? `โหวตถูกต้อง! คนร้ายคือ ${culpritChar.name} (${culprit.name}) และถูกประหาร`
        : `โหวตผิด! คนร้ายตัวจริงคือ ${culpritChar.name} (${culprit.name}) และหลบหนีไปได้${accusedExecuted ? ` ส่วน ${this.charOf(accused).name} ถูกประหารทั้งที่บริสุทธิ์` : ''}`,
    );
    this.runoff = null;
    this.phase = PHASE.TRIAL_RESULT;
    this.emit();
  }

  async nextRound(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.TRIAL_RESULT);
    this.phase = PHASE.GENERATING;
    this.generating = 'กำลังเตรียมวันใหม่...';
    this.round++;
    this.emit();
    try {
      await this.maybeRevive();
      if (this.alivePlayers().length <= 1) {
        this.round--;
        this.endGame();
        return;
      }
      await this.newLocation();
      this.enterDay();
    } catch (err) {
      this.fail(err);
    }
  }

  // อีเวนต์พิเศษ: เหยื่อบางคนอาจ "ไม่ได้ตายจริง" และกลับเข้าเกม (AI แต่งเหตุผลประกอบ)
  async maybeRevive() {
    const eligible = [...this.players.values()].filter((p) => !p.alive && p.fate === 'victim' && !p.revived);
    if (!eligible.length || Math.random() >= CONFIG.REVIVE_CHANCE) return null;
    const target = pick(eligible);
    const c = this.charOf(target);
    this.generating = 'มีบางอย่างผิดปกติเกิดขึ้น...';
    this.emit();
    const caseInfo = this.history.find((h) => h.round === target.eliminatedRound);
    const ev = await this.ai.generateReviveEvent({
      round: this.round,
      location: this.location,
      character: c,
      deathSummary: caseInfo?.summary || '',
      aliveCharacters: this.alivePlayers().map((p) => this.charOf(p)),
    });
    target.alive = true;
    target.fate = null;
    target.eliminatedRound = null;
    target.revived = true;
    target.revivedRound = this.round;
    this.specialEvent = {
      type: 'revive',
      round: this.round,
      playerId: target.id,
      playerName: target.name,
      characterName: c.name,
      title: ev.title,
      story: ev.story,
      privateNote: ev.privateNote || '',
    };
    this.systemMessage(`อีเวนต์พิเศษ! ${c.name} (${target.name}) กลับมามีชีวิตอีกครั้ง — ${ev.title}`);
    if (ev.privateNote) this.notify(target.id, ev.privateNote, 'reveal');
    return this.specialEvent;
  }

  // ---------- end ----------
  endGame() {
    this.clearTimers();
    this.computeOutcome();
    for (const c of this.characters) c.ultimateRevealed = true;
    this.phase = PHASE.ENDED;
    this.generating = null;
    this.systemMessage('เกมจบแล้ว! สรุปว่าใครรอด ใครไม่รอด');
    this.emit();
  }

  computeOutcome() {
    const all = [...this.players.values()];
    for (const p of all) if (p.alive) p.fate = 'survivor';
    const row = (p) => {
      const c = this.charOf(p);
      return {
        playerId: p.id,
        name: p.name,
        isBot: p.isBot,
        characterName: c?.name || null,
        ultimate: c?.ultimate?.title || null,
        fakeRole: !!c?.fakeRole,
        fakeUltimate: c?.fakeRole ? c.fakeUltimate?.title || null : null,
        fate: p.fate,
        eliminatedRound: p.eliminatedRound,
        revived: p.revived,
      };
    };
    this.outcome = {
      survived: all.filter((p) => SURVIVED_FATES.includes(p.fate)).map(row),
      died: all
        .filter((p) => DEAD_FATES.includes(p.fate))
        .sort((a, b) => (a.eliminatedRound || 0) - (b.eliminatedRound || 0))
        .map(row),
    };
  }

  restart(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.ENDED, PHASE.LOBBY);
    this.resetGameState();
    this.chat = [];
    this.systemMessage('กลับสู่ล็อบบี้ พร้อมเริ่มเกมใหม่');
    this.emit();
  }

  // ---------- chat ----------
  sendChat(playerId, text) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('ไม่พบผู้เล่น');
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const openPhase = this.phase === PHASE.LOBBY || this.phase === PHASE.ENDED;
    if (!openPhase && !p.alive) throw new GameError('ผู้ที่ออกจากเกมแล้วไม่สามารถพูดได้');
    if ([PHASE.NIGHT, PHASE.INCIDENT, PHASE.GENERATING].includes(this.phase)) throw new GameError('ตอนนี้ยังคุยไม่ได้');
    const c = this.charOf(p);
    this.pushChat({ playerId, name: p.name, characterName: c?.name || null, text });
    this.emit();
  }

  // ---------- bots ----------
  scheduleBots() {
    const bots = this.alivePlayers().filter((p) => p.isBot);
    if (this.phase === PHASE.DAY) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase === PHASE.DAY && !this.sleepConfirmed.has(b.id)) this.confirmSleep(b.id);
        }, (3000 + Math.random() * 5000) * CONFIG.BOT_DELAY_SCALE);
      }
    }
    if (this.phase === PHASE.INVESTIGATION) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase !== PHASE.INVESTIGATION || this.confirmedVotes.has(b.id)) return;
          const culpritId = this.incident.culpritPlayerId;
          const cands = this.voteCandidates(b.id);
          if (!cands.length) return;
          let target;
          const culpritIsCandidate = cands.some((p) => p.id === culpritId);
          if (b.id === culpritId) target = pick(cands);
          else target = Math.random() < 0.35 && culpritIsCandidate ? this.players.get(culpritId) : pick(cands);
          if (!target || !target.alive || target.id === b.id) target = pick(cands);
          this.castVote(b.id, target.id);
          this.confirmVote(b.id);
        }, (4000 + Math.random() * 6000) * CONFIG.BOT_DELAY_SCALE);
      }
    }
  }

  // ---------- views ----------
  cluesFor(playerId) {
    const inc = this.incident;
    const p = this.players.get(playerId);
    const c = this.charOf(p);
    if (!inc || !p || !c) return null;
    const resolved = this.phase === PHASE.TRIAL_RESULT || this.phase === PHASE.ENDED;
    const out = {
      role: 'none',
      wasMurderer: inc.murdererPlayerId === playerId,
      wasTarget: inc.targetPlayerId === playerId,
      isVictim: inc.victimPlayerId === playerId,
    };
    if (out.isVictim) {
      out.role = 'victim';
      return out;
    }
    if (inc.culpritPlayerId === playerId) {
      out.role = 'culprit';
      out.story = inc.culpritStory;
      out.method = inc.method;
      out.myPublicInfo = inc.whereabouts?.find((w) => w.characterId === c.id)?.publicKnowledge || '';
    }
    const clue = inc.privateClues.find((x) => x.characterId === c.id);
    if (clue) {
      out.clue = clue.clue;
      if (out.role === 'none') out.role = 'witness';
    }
    const ins = inc.ultimateInsights.find((x) => x.characterId === c.id);
    if (ins) out.insight = ins.insight;
    // ทุกคนรู้เฉพาะสิ่งที่ตัวเองทำคืนนี้ และเหตุการณ์ที่ตัวเองอยู่ด้วย/เห็นเอง
    const mine = (inc.whereabouts || []).find((w) => w.characterId === c.id);
    if (mine?.where && out.role !== 'culprit') out.myNight = mine.where;
    out.observations = (inc.observations || []).filter((o) => o.knownBy.includes(c.id)).map((o) => o.text);
    if (out.role === 'none' && out.observations.length) out.role = 'witness';
    if (out.wasMurderer && !resolved) {
      const t = this.players.get(inc.targetPlayerId);
      out.murdererNote = `คืนนี้ระบบเลือกให้คุณเป็นฆาตกร และคุณเลือก ${this.charOf(t)?.name} (${t?.name}) เป็นเป้าหมาย`;
    }
    return out;
  }

  // ตำแหน่งจริงของทุกคน (ใช้เฉพาะตอนเฉลยหลังตัดสิน ระหว่างสืบสวนแต่ละคนเห็นแค่ของตัวเอง)
  resolvedWhereabouts() {
    const inc = this.incident;
    if (!inc?.whereabouts) return [];
    const rows = [];
    for (const w of inc.whereabouts) {
      const c = this.characters.find((x) => x.id === w.characterId);
      const p = this.playerOfChar(w.characterId);
      if (!c) continue;
      rows.push({ characterId: c.id, playerId: p?.id || null, characterName: c.name, nickname: c.nickname, playerName: p?.name || null, truth: w.where || '' });
    }
    return rows;
  }

  // เหตุการณ์ย่อยทั้งหมดพร้อมชื่อคนที่รู้ (ใช้เฉพาะตอนเฉลย)
  resolvedObservations() {
    const inc = this.incident;
    return (inc?.observations || []).map((o) => ({
      text: o.text,
      knownBy: o.knownBy.map((id) => this.characters.find((c) => c.id === id)?.nickname || id),
    }));
  }

  publicIncident() {
    const inc = this.incident;
    if (!inc) return null;
    const victimP = this.players.get(inc.victimPlayerId);
    const items = this.location?.items || [];
    return {
      round: inc.round,
      title: inc.title,
      victim: { playerId: victimP.id, playerName: victimP.name, characterName: this.charOf(victimP)?.name },
      publicReport: {
        ...inc.publicReport,
        suspiciousItems: (inc.publicReport.suspiciousItems || []).map((si) => ({
          ...si,
          itemName: items.find((i) => i.id === si.itemId)?.name || si.itemId,
        })),
      },
    };
  }

  viewFor(playerId) {
    const me = this.players.get(playerId) || null;
    const ended = this.phase === PHASE.ENDED;
    const players = [...this.players.values()].map((p) => {
      const c = this.charOf(p);
      const isMe = p.id === playerId;
      const exposed = !!c && (c.ultimateRevealed || ended);
      // โรลปลอม: คนอื่นเห็น Ultimate ปลอมจนกว่าจะถูกเปิดโปง (คนร้าย/เหยื่อหลังตัดสิน หรือจบเกม) เจ้าของเห็นของจริง
      const showFake = !!c?.fakeRole && !exposed && !isMe;
      const showUlt = c && !showFake && (!c.ultimate.hidden || exposed || (isMe && p.knowsUltimate));
      return {
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.connected,
        isHost: p.id === this.hostId,
        alive: p.alive,
        fate: p.fate,
        eliminatedRound: p.eliminatedRound,
        revived: p.revived,
        sleepConfirmed: this.sleepConfirmed.has(p.id),
        voteConfirmed: this.confirmedVotes.has(p.id),
        hasVoted: this.votes.has(p.id),
        character: c
          ? {
              id: c.id,
              name: c.name,
              nickname: c.nickname,
              gender: c.gender,
              age: c.age,
              appearance: c.appearance,
              personality: c.personality,
              ultimate: showFake ? c.fakeUltimate.title : showUlt ? c.ultimate.title : '???',
              ultimateDescription: showFake ? c.fakeUltimate.description : showUlt ? c.ultimate.description : null,
              ultimateHidden: c.ultimate.hidden,
              ultimateRevealed: c.ultimateRevealed,
              // เปิดโปงแล้วว่าโรลที่ประกาศเป็นของปลอม (ทุกคนเห็น) / เจ้าของเห็นเสมอว่าตัวเองถือโรลปลอม
              fakeRoleExposed: !!c.fakeRole && exposed,
              fakeUltimate: c.fakeRole && (exposed || isMe) ? c.fakeUltimate.title : null,
            }
          : null,
      };
    });

    const myChar = this.charOf(me);
    const showResult = this.phase === PHASE.TRIAL_RESULT || ended;
    const ev = this.specialEvent;
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      generating: this.generating,
      aiMode: this.ai?.mode || 'mock',
      config: {
        minPlayers: CONFIG.MIN_PLAYERS,
        maxPlayers: CONFIG.MAX_PLAYERS,
        nightTimeoutMs: CONFIG.NIGHT_TIMEOUT_MS,
        executeWrongVote: CONFIG.EXECUTE_WRONG_VOTE,
        maxRunoffs: CONFIG.MAX_RUNOFFS,
        hiddenUltimates: hiddenUltimateCap(this.players.size || CONFIG.MIN_PLAYERS),
        fakeRoles: Math.min(CONFIG.FAKE_ROLES, Math.max(0, this.players.size - 1)),
      },
      me: me
        ? {
            id: me.id,
            name: me.name,
            isHost: me.id === this.hostId,
            alive: me.alive,
            fate: me.fate,
            revived: me.revived,
            knowsUltimate: me.knowsUltimate,
            sleepConfirmed: this.sleepConfirmed.has(me.id),
            myVote: this.votes.get(me.id) || null,
            voteConfirmed: this.confirmedVotes.has(me.id),
            ultimateIsHidden: !!myChar?.ultimate?.hidden,
            ultimateHiddenReason: myChar?.ultimate?.hiddenReason || null,
            fakeRole: !!myChar?.fakeRole,
            fakeUltimate: myChar?.fakeRole ? { title: myChar.fakeUltimate.title, description: myChar.fakeUltimate.description } : null,
            ultimateEffect: me.knowsUltimate ? myChar?.ultimate?.investigationEffect || null : null,
            nightRole:
              this.phase === PHASE.NIGHT && this.night ? (this.night.murdererId === me.id ? 'murderer' : 'sleeping') : null,
            nightDeadline: this.phase === PHASE.NIGHT && this.night ? this.night.deadline : null,
            clues: this.cluesFor(me.id),
            eventPrivateNote: ev && ev.playerId === me.id ? ev.privateNote : null,
            notices: this.notices.get(me.id) || [],
          }
        : null,
      players,
      location: this.location,
      incident: this.publicIncident(),
      runoff: this.runoff ? { number: this.runoff.number, candidates: this.runoff.candidates, previousTally: this.runoff.previousTally } : null,
      specialEvent: ev
        ? { type: ev.type, round: ev.round, playerId: ev.playerId, playerName: ev.playerName, characterName: ev.characterName, title: ev.title, story: ev.story }
        : null,
      lastResult: showResult ? this.lastResult : null,
      history: this.history.map(({ summary, ...h }) => ({ ...h, summary: showResult || h.round < this.round ? summary : null })),
      outcome: ended ? this.outcome : null,
      chat: this.chat.slice(-150),
    };
  }
}
