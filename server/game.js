// Game engine — state machine ของบอร์ดเกม (เวอร์ชัน "สำรวจห้อง / ลงมือเอง / หาทางออกที่ซ่อนอยู่")
// เวลาในเกม: ทุกครั้งที่เข้าห้อง (รวมรอบเก็บหลักฐาน) = +1 ชั่วโมง, ตัดสินคดีเสร็จ = ขึ้นวันใหม่ ไม่มีเวลาจำกัด
// ตารางตัวเลข (โอกาสโจมตี สูตรคราฟ กับดัก ทางออก ภารกิจ) อยู่ใน rules.js — อ่านฉบับคนทั่วไปได้ใน BALANCE.md
import { CHARACTERS } from './characters.js';
import { ULTIMATE_POOL, TRAITS } from './mock.js';
import { makeObjective, objectiveOutcome, objectiveTargetZone, hasFood } from './objectives.js';
import { ATTACK, RECIPES, TRAP_TYPES, TRAP_TRIGGER_CHANCE, TRAP_DISARM_CHANCE, TRAP_FAIL_CHANCE, POISON_NOTICE, LOCKS, ESCAPE, TRAIT_EFFECTS, KIND_LABEL, PORTABLE_KINDS } from './rules.js';
import { buildExits, exitsIn, knowsExit, discoverExit, tryFindExit, onObtainItem, exitActions, doExitPower, resolveExits, exitView } from './escape.js';

export const PHASE = {
  LOBBY: 'lobby',
  GENERATING: 'generating',
  DAY: 'day', // สำรวจห้อง + ทำแอ็กชัน (step: move → act → report) หนึ่งรอบ = 1 ชั่วโมง
  INVESTIGATION: 'investigation', // รอบเก็บหลักฐานหลังพบศพ (step: move → act) = 1 ชั่วโมง
  TRIAL: 'trial', // อภิปราย + โหวต
  TRIAL_RESULT: 'trial_result',
  ENDED: 'ended',
};
export const STEP = { MOVE: 'move', ACT: 'act', REPORT: 'report' };
export const NONE_VOTE = 'none';

// ค่าเหล่านี้แก้ได้ตอนรัน (เช่นในเทสต์) ด้วย Object.assign(CONFIG, {...})
export const CONFIG = {
  MIN_PLAYERS: Number(process.env.MIN_PLAYERS || 3),
  MAX_PLAYERS: 15,
  MAX_CHAT: 300,
  // เวลาจริงต่อจังหวะ (0 = ไม่จำกัด ค่าเริ่มต้น; หัวห้องกด "บังคับไปต่อ" ได้เสมอ)
  STEP_TIMEOUT_MS: Number(process.env.STEP_TIMEOUT_MS || 0),
  // จำนวนชั่วโมงสูงสุดทั้งเกม (0 = ไม่จำกัด ค่าเริ่มต้น; ใช้ในเทสต์)
  MAX_HOURS: Number(process.env.MAX_HOURS || 0),
  // ต้องมีคน "พบศพ" กี่คน (ไม่นับคนฆ่า) ถึงจะประกาศและเข้าสู่รอบเก็บหลักฐาน
  BODY_DISCOVERERS: Number(process.env.BODY_DISCOVERERS || 3),
  INVENTORY_MAX: Number(process.env.INVENTORY_MAX || 3),
  // ห้องที่ล็อกไว้ตั้งแต่เริ่มเกม (-1 = อัตโนมัติ: 1 ห้องถ้าห้องสำรวจ ≤ 6 ไม่งั้น 2 ห้อง)
  LOCKED_ZONES: process.env.LOCKED_ZONES !== undefined ? Number(process.env.LOCKED_ZONES) : -1,
  // โอกาสเจอของที่ซ่อนอยู่เมื่อ "สำรวจ" (ของทั่วไป / ของสำหรับทางออก) และโอกาสค้นพบทางออกที่ซ่อนในห้อง
  FIND_HIDDEN_CHANCE: ESCAPE.FIND_HIDDEN_CHANCE,
  FIND_ROUTE_ITEM_CHANCE: ESCAPE.FIND_ROUTE_ITEM_CHANCE,
  FIND_EXIT_CHANCE: ESCAPE.FIND_EXIT_CHANCE,
  // ภารกิจย่อย (ปิดได้ด้วย OBJECTIVES=false) ระยะเวลาตามความยากอยู่ใน rules.js ครบแล้วระบบพาไปทำเอง (ไม่ตาย)
  OBJECTIVES: process.env.OBJECTIVES !== 'false',
  // เจ้าของ Ultimate ที่ถูกซ่อน (???) รู้ของจริงเสมอ
  KNOW_OWN_ULTIMATE_CHANCE: 1,
  // ตัวคูณความเร็วของบอท (ใช้ค่าน้อย ๆ ตอนเทสต์)
  BOT_DELAY_SCALE: Number(process.env.BOT_DELAY_SCALE || 1),
  // โหวตเสมอ → โหวตรอบตัดสินเฉพาะคนที่เสมอ ได้สูงสุดกี่รอบ ก่อนจะสุ่มตัดสิน
  MAX_RUNOFFS: Number(process.env.MAX_RUNOFFS || 2),
  // โอกาสเกิดอีเวนต์พิเศษ "คืนชีพ" ตอนเริ่มวันใหม่หลังการตัดสิน (เฉพาะผู้ตายที่คดีถูกตัดสินแล้ว และคนละครั้ง)
  REVIVE_CHANCE: process.env.REVIVE_CHANCE !== undefined ? Number(process.env.REVIVE_CHANCE) : 0.15,
  // จำนวน Ultimate ที่ถูกซ่อนเป็น ??? จริง ๆ = clamp(round(ผู้เล่น × RATIO), 1, MAX) → 10 คนได้ 2, 7 คนได้ 1
  HIDDEN_ULTIMATE_RATIO: Number(process.env.HIDDEN_ULTIMATE_RATIO || 0.15),
  HIDDEN_ULTIMATE_MAX: Number(process.env.HIDDEN_ULTIMATE_MAX || 2),
  // จำนวน "โรลปลอม": Ultimate ที่ประกาศให้คนอื่นเห็นไม่ใช่ของจริง (เจ้าของรู้ คนอื่นไม่รู้)
  FAKE_ROLES: Number(process.env.FAKE_ROLES !== undefined ? process.env.FAKE_ROLES : 1),
};

export const hiddenUltimateCap = (n) => Math.max(1, Math.min(CONFIG.HIDDEN_ULTIMATE_MAX, Math.round(n * CONFIG.HIDDEN_ULTIMATE_RATIO)));

// fate: victim (ถูกฆ่า), executed (คนร้ายถูกจับและประหาร), punished (โหวตผิด ทุกคนที่เหลือถูกประหาร),
// escaped (คนร้ายรอดเพราะโหวตผิด), survivor (รอดจนจบเกม)
export const DEAD_FATES = ['victim', 'executed', 'punished'];
export const SURVIVED_FATES = ['survivor', 'escaped'];
export const CAUSE_LABEL = {
  attack: 'ถูกฆ่า',
  wrongTarget: 'ถูกฆ่า (คนร้ายพลาดเป้า)',
  trap: 'โดนกับดัก',
  defense: 'ถูกสวนกลับขณะพยายามฆ่า',
  executed: 'ถูกประหาร',
  punished: 'ถูกประหารเพราะโหวตผิด',
};
// สาเหตุที่นับเป็น "ฆาตกรรม" (ล็อกไม่ให้คนอื่นลงมือซ้อนจนกว่าศพจะถูกพบ) — การสวนกลับป้องกันตัวไม่นับ
export const MURDER_CAUSES = ['attack', 'wrongTarget', 'trap'];
export const MURDER_LOCK_MESSAGE = 'มีการฆาตกรรมเกิดขึ้นแล้ว ไม่สามารถทำการฆาตกรรมได้ จนกว่าศพจะถูกพบ';

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
const chance = (p) => Math.random() < p;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const sanitizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'ผู้เล่นนิรนาม';
const fill = (tpl, w) => String(tpl || '').replaceAll('{w}', w || 'ของหนัก');

const freshPlayerState = () => ({
  characterId: null,
  alive: true,
  knowsUltimate: false,
  fate: null,
  deathCause: null,
  eliminatedDay: null,
  eliminatedHour: null,
  revived: false,
  revivedDay: null,
  zoneId: null,
  inventory: [],
  objectives: [],
  nextObjectiveTurn: 0,
  forced: null,
  log: [],
  evidence: [],
  knownBodies: new Set(),
  zoneMemory: {},
  stained: null,
  kills: 0,
});

const makePlayer = (id, name, isBot) => ({ id, name, isBot, connected: true, joinedAt: Date.now(), ...freshPlayerState() });
const resetPlayerState = (p) => Object.assign(p, freshPlayerState());

export class Game {
  constructor({ code, ai, onChange, log = console, portraits = new Map() }) {
    this.code = code;
    this.ai = ai;
    this.onChange = onChange || (() => {});
    this.log = log;
    this.portraits = portraits; // characterId → url ของรูปตัวละคร (ถ้ามีไฟล์ใน public/portraits)
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
    this.step = null;
    this.stepDeadline = null;
    this.day = 0;
    this.hour = 0; // ชั่วโมงในวันนี้ (นับจาก 1)
    this.turn = 0; // ชั่วโมงรวมทั้งเกม (ใช้คำนวณกำหนดภารกิจ)
    this.characters = [];
    this.location = null;
    this.zones = new Map();
    this.exits = new Map();
    this.escaped = false;
    this.bodies = new Map();
    this.cases = [];
    this.timeline = [];
    this.moves = new Map();
    this.actions = new Map();
    this.ready = new Set();
    this.designatedId = null;
    this.lastTrialTurn = 0;
    this.votes = new Map();
    this.confirmedVotes = new Set();
    this.runoff = null;
    this.runoffCount = 0;
    this.lastResult = null;
    this.history = [];
    this.outcome = null;
    this.endReason = null;
    this.specialEvent = null;
    this.generating = null;
    this.notices = new Map();
    this.announcement = null;
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
    this.stepDeadline = null;
  }

  assertHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('เฉพาะหัวห้องเท่านั้นที่ทำได้');
  }

  assertPhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('ไม่สามารถทำได้ในช่วงนี้ของเกม');
  }

  assertStep(step) {
    if (this.step !== step) throw new GameError('ไม่สามารถทำได้ในจังหวะนี้');
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

  nick(p) {
    if (!p) return '???';
    return this.charOf(p)?.nickname || p.name;
  }

  traitOf(p) {
    const t = this.charOf(p)?.ultimate?.trait;
    return TRAITS[t] ? t : 'none';
  }

  zoneName(zoneId) {
    return this.zones.get(zoneId)?.name || zoneId || '?';
  }

  // ชื่อห้องสำหรับใช้ในประโยค: เว้นวรรคท้ายถ้าลงท้ายด้วยตัวเลข/อักษรละติน ("ชั้น 1" + "ด้วย" → "ชั้น 1 ด้วย")
  zn(zoneOrId) {
    const name = typeof zoneOrId === 'string' ? this.zoneName(zoneOrId) : zoneOrId?.name || '?';
    return /[0-9A-Za-z]$/.test(name) ? `${name} ` : name;
  }

  timeLabel() {
    return `วันที่ ${this.day} ชั่วโมงที่ ${this.hour}`;
  }

  presentIn(zoneId) {
    return this.alivePlayers().filter((p) => p.zoneId === zoneId);
  }

  bodiesIn(zoneId) {
    return [...this.bodies.values()].filter((b) => !b.judged && b.zoneId === zoneId);
  }

  caseOf(id) {
    return this.cases.find((c) => c.id === id) || null;
  }

  // ถือกุญแจที่ไขห้องนี้ได้ไหม (กุญแจประจำห้อง หรือกุญแจผู้ดูแลที่ไขได้ทุกห้อง)
  hasKeyFor(p, zoneId) {
    return p.inventory.some((i) => i.kind === 'key' && (i.master || i.unlocksZoneId === zoneId));
  }

  // คดีฆาตกรรมที่ศพยังไม่ถูกพบ/ประกาศ — คนที่ไม่ใช่คนร้ายของคดีเหล่านั้นลงมือซ้อนไม่ได้
  openMurders() {
    return this.cases.filter((c) => MURDER_CAUSES.includes(c.cause) && !c.announced && !c.judged);
  }

  murderLockedFor(p) {
    return this.openMurders().some((c) => c.killerId !== p.id);
  }

  pushChat(msg) {
    this.chat.push({ id: nextId(), ts: Date.now(), phase: this.phase, day: this.day, hour: this.hour, ...msg });
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

  // บันทึกส่วนตัว (สมุดบันทึก) — สิ่งที่คนนี้รู้คนเดียว
  logTo(p, text, kind = 'info') {
    if (!p) return;
    p.log.push({ id: nextId(), day: this.day, hour: this.hour, turn: this.turn, phase: this.phase, text, kind, ts: Date.now() });
    if (p.log.length > 300) p.log.splice(0, p.log.length - 300);
  }

  // เหตุการณ์จริง (ใช้เฉลยตอนตัดสิน)
  recordEvent(text) {
    let t = this.timeline.at(-1);
    if (!t || t.turn !== this.turn || t.phase !== this.phase) {
      t = { day: this.day, hour: this.hour, turn: this.turn, phase: this.phase, positions: Object.fromEntries(this.alivePlayers().map((p) => [p.id, p.zoneId])), events: [] };
      this.timeline.push(t);
    }
    t.events.push(text);
  }

  makeEvidence(zoneId, text, hidden, caseId, kind) {
    return { id: nextId(), zoneId, text, hidden: !!hidden, caseId: caseId || null, kind, day: this.day, hour: this.hour };
  }

  fail(err) {
    this.log.error(`[room ${this.code}] game error:`, err);
    const msg = err instanceof GameError ? err.message : 'ระบบเกิดข้อผิดพลาด กรุณาลองใหม่';
    this.generating = null;
    this.systemMessage(`⚠ ${msg}`);
    if (this.phase === PHASE.GENERATING && this.day <= 1 && !this.location) {
      this.resetGameState();
    } else if (this.phase === PHASE.GENERATING) {
      // ล้มเหลวตอนเตรียมวันใหม่ → ให้หัวห้องกดไปต่อใหม่
      this.phase = PHASE.TRIAL_RESULT;
    } else if (this.phase === PHASE.INVESTIGATION && !this.step) {
      // ล้มเหลวระหว่างบรรยายคดี → เข้าสู่รอบเก็บหลักฐานต่อด้วยคำบรรยายสำรอง
      this.step = STEP.MOVE;
      this.armStepTimer();
      this.scheduleBots();
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
          trait: TRAITS[u.trait] ? u.trait : 'none',
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
        // เจ้าของรู้ Ultimate จริงของตัวเองเสมอ (ทั้งโรลปลอมและโรลที่ซ่อนเป็น ???)
        p.knowsUltimate = chars[i].fakeRole ? true : chars[i].ultimate.hidden ? Math.random() < CONFIG.KNOW_OWN_ULTIMATE_CHANCE : true;
      });
      this.generating = 'กำลังจำลองสถานที่ ซ่อนทางออก และล็อกบางห้อง...';
      this.emit();
      const loc = await this.ai.generateLocation({ playerCount: this.players.size });
      this.buildWorld(loc);
      this.day = 1;
      this.hour = 0;
      this.turn = 0;
      const lockedCount = [...this.zones.values()].filter((z) => z.locked).length;
      this.systemMessage(
        `เกมเริ่มแล้ว! ทุกคนตื่นขึ้นมาใน "${loc.name}" — ที่นี่มีทางออกซ่อนอยู่ ${this.exits.size} ทาง (ไม่มีใครรู้ว่าอยู่ห้องไหน) ต้อง "สำรวจ" ห้องให้ละเอียดหรือหาแผนผังให้เจอ แล้วหาของที่แต่ละทางต้องใช้${lockedCount ? ` · บางห้อง (${lockedCount}) ถูกล็อกไว้ ต้องหากุญแจ` : ''} · บางห้องมีอาหารกินได้ · หรือจะเอาตัวรอดด้วยวิธีอื่นก็ได้`,
      );
      this.beginDay();
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
        const spare = ULTIMATE_POOL.filter((u) => !u.hidden && u.trait === 'none' && !usedTitles.has(u.title));
        const alt = spare.length ? pick(spare) : null;
        decoy = alt ? { title: alt.title, description: alt.description } : { title: 'สุดยอดนักสะสมของเก่า', description: 'จำที่มาของของเก่าทุกชิ้นได้' };
      }
      usedTitles.add(decoy.title);
      c.fakeRole = true;
      c.fakeUltimate = decoy;
    }
    for (const c of queue.slice(0, hiddenCap)) c.ultimate.hidden = true;
    for (const c of chars) delete c.decoy;
  }

  // สร้างห้อง → ซ่อนทางออกและของที่ต้องใช้ (escape.js) → ล็อกบางห้องและวางกุญแจประจำห้องไว้ห้องอื่น
  buildWorld(loc) {
    this.location = loc;
    this.zones = new Map();
    for (const z of loc.zones) {
      this.zones.set(z.id, {
        id: z.id,
        name: z.name,
        description: z.description,
        items: z.items.map((it) => ({ ...it, portable: it.portable ?? PORTABLE_KINDS.has(it.kind), master: !!it.master || (it.kind === 'key' && it.master !== false), originZoneId: z.id, hidden: false, isPart: false })),
        traps: [],
        evidence: [],
        dark: false,
        lockable: z.id !== loc.sleepZoneId,
        locked: false,
        keyItemId: null,
      });
    }
    for (const p of this.players.values()) p.zoneId = loc.sleepZoneId;

    const explore = [...this.zones.values()].filter((z) => z.id !== loc.sleepZoneId);
    const want = CONFIG.LOCKED_ZONES >= 0 ? CONFIG.LOCKED_ZONES : explore.length <= 6 ? LOCKS.LOCKED_ZONES_SMALL : LOCKS.LOCKED_ZONES_LARGE;
    const toLock = shuffle(explore).slice(0, Math.min(want, Math.max(0, explore.length - 2)));
    toLock.forEach((z, i) => {
      z.locked = true;
      // กุญแจประจำห้อง วางให้เห็นในห้องที่ไม่ได้ล็อก (ไม่ใช่ที่นอนรวม) เพื่อไม่ให้ติดตาย
      const spots = explore.filter((o) => !toLock.includes(o));
      const spot = pick(spots) || this.zones.get(loc.sleepZoneId);
      const key = { id: `key_${z.id}`, name: `กุญแจ${z.name}`, description: `กุญแจเหล็กมีป้ายเขียนว่า "${z.name}" ใช้ล็อกและปลดล็อกประตูห้องนั้นได้`, kind: 'key', portable: true, hidden: false, isPart: false, unlocksZoneId: z.id, originZoneId: spot.id };
      spot.items.push(key);
      z.keyItemId = key.id;
      void i;
    });
    // ทางออกและของที่ต้องใช้ (ซ่อนหลังจากรู้แล้วว่าห้องไหนล็อก)
    buildExits(this, loc);
  }

  // ---------- day / hour loop ----------
  // วันใหม่: สุ่มฆาตกรประจำวัน แล้วเริ่มชั่วโมงแรก
  beginDay() {
    this.phase = PHASE.DAY;
    this.generating = null;
    this.hour = 0;
    const alive = this.alivePlayers();
    this.designatedId = alive.length >= 2 ? pick(alive).id : null;
    this.systemMessage(`— วันที่ ${this.day} — ทุกครั้งที่เข้าห้องนับเป็น 1 ชั่วโมง วันนี้จะจบลงเมื่อมีการตัดสินคดี`);
    if (this.designatedId) {
      const d = this.players.get(this.designatedId);
      const hint = this.weaponHint(d);
      this.logTo(
        d,
        `🔪 วันนี้เกมเลือกคุณเป็น "ฆาตกร" — จะลงมือหรือไม่ก็ได้ ถ้าลงมือในวันนี้ โอกาสสำเร็จจะสูงขึ้น${hint ? ` และคุณรู้ว่า${hint}` : ''} ถ้าคนอื่นลงมือก่อน คุณจะกลายเป็นแค่คนที่อยู่ในเหตุการณ์ มีแค่คุณที่รู้เรื่องนี้`,
        'designated',
      );
      this.notify(d.id, 'วันนี้เกมเลือกคุณเป็นฆาตกร — ดูรายละเอียดในสมุดบันทึก', 'reveal');
    }
    this.beginTurn();
  }

  // ชั่วโมงใหม่: ทุกคนเลือกห้อง
  beginTurn() {
    this.phase = PHASE.DAY;
    this.step = STEP.MOVE;
    this.hour++;
    this.turn++;
    this.moves = new Map();
    this.actions = new Map();
    this.ready = new Set();
    for (const z of this.zones.values()) z.dark = false;
    const alive = this.alivePlayers();
    // ภารกิจค้างได้ทีละข้อ และภารกิจใหม่จะมาเมื่อครบชั่วโมงของข้อเดิมเท่านั้น (ทำเสร็จก่อนก็ต้องรอ)
    if (CONFIG.OBJECTIVES) for (const p of alive) if (p.objectives.every((o) => o.done) && this.turn >= p.nextObjectiveTurn) this.assignObjective(p);
    this.enforceObjectives();
    this.systemMessage(`🕐 ${this.timeLabel()} — เลือกห้องที่จะไป (ไม่มีใครเห็นว่าใครเลือกอะไร)`);
    this.emit();
    if (alive.every((p) => this.moves.has(p.id))) return this.resolveMoves();
    this.armStepTimer();
    this.scheduleBots();
  }

  weaponHint(p) {
    const cands = [];
    for (const z of this.zones.values()) for (const it of z.items) if (it.kind === 'weapon' && !it.hidden) cands.push({ it, z });
    if (!cands.length) return '';
    const { it, z } = pick(cands);
    return `${it.name}อยู่ที่${this.zn(z)}`;
  }

  assignObjective(p) {
    const o = makeObjective(this, p);
    if (!o) return;
    p.objectives.push(o);
    if (p.objectives.length > 4) p.objectives.splice(0, p.objectives.length - 4);
    p.nextObjectiveTurn = o.deadlineTurn;
    this.logTo(p, `📋 ภารกิจใหม่ (${o.hours} ชั่วโมง): ${o.text} — ถ้าไม่ทำ เมื่อครบกำหนดระบบจะพาคุณไปทำเอง`, 'objective');
  }

  // ครบกำหนดภารกิจ → พาผู้เล่นไปทำเองในชั่วโมงนี้ (ล็อกห้อง และแอ็กชันถ้าจำเป็น) ไม่มีใครตายเพราะภารกิจ
  enforceObjectives() {
    for (const p of this.alivePlayers()) {
      p.forced = null;
      const due = p.objectives.find((o) => !o.done && o.deadlineTurn <= this.turn);
      if (!due) continue;
      const res = objectiveOutcome(this, p, due);
      if (res === 'done') {
        this.completeObjective(p, due);
        continue;
      }
      const forgive = (why) => {
        due.done = true;
        due.forgiven = true;
        due.doneTurn = this.turn;
        this.logTo(p, `📋 ภารกิจ "${due.text}" ถูกยกเลิก${why ? ` (${why})` : ''} ไม่มีบทลงโทษ`, 'objective');
      };
      if (res === 'forgiven') {
        forgive('เป้าหมายไม่อยู่ในสภาพที่ทำได้แล้ว');
        continue;
      }
      if (due.type === 'meet') {
        forgive('หมดเวลาสำหรับการนัดพบ');
        continue;
      }
      const zoneId = objectiveTargetZone(this, p, due);
      if (!zoneId) {
        forgive('ของถูกซ่อนหรือหายไป');
        continue;
      }
      const z = this.zones.get(zoneId);
      if (z.locked && !this.hasKeyFor(p, zoneId)) {
        forgive(`${z.name}ถูกล็อกอยู่`);
        continue;
      }
      let action = null;
      let actionText = '';
      if (due.type === 'take') {
        action = { type: 'take', itemId: due.itemId };
        actionText = `และบังคับให้หยิบ${due.itemName}`;
      } else if (due.type === 'plant') {
        action = { type: 'hide', itemId: due.itemId };
        actionText = `และบังคับให้ซ่อน${due.itemName}`;
      } else if (due.type === 'visit_eat') {
        action = { type: 'eat' };
        actionText = 'และบังคับให้กินอาหารที่นั่น';
      }
      p.forced = { zoneId, objectiveId: due.id, action };
      this.moves.set(p.id, zoneId);
      this.logTo(p, `⏰ ครบกำหนดภารกิจ "${due.text}" — ชั่วโมงนี้ระบบพาคุณไปที่${this.zn(zoneId)}${actionText}เอง`, 'objective');
    }
  }

  armStepTimer() {
    this.clearTimers();
    if (!CONFIG.STEP_TIMEOUT_MS || (this.step !== STEP.MOVE && this.step !== STEP.ACT)) return;
    const phase = this.phase;
    const step = this.step;
    this.stepDeadline = Date.now() + CONFIG.STEP_TIMEOUT_MS;
    this.setTimer(() => {
      if (this.phase !== phase || this.step !== step) return;
      this.systemMessage('หมดเวลา — ระบบเลือกให้คนที่ยังไม่เลือก');
      if (step === STEP.MOVE) this.resolveMoves();
      else this.resolveActions();
    }, CONFIG.STEP_TIMEOUT_MS);
  }

  chooseMove(playerId, zoneId) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    this.assertStep(STEP.MOVE);
    const p = this.alivePlayer(playerId);
    if (!this.zones.has(zoneId)) throw new GameError('ไม่มีห้องนี้');
    if (p.forced && p.forced.zoneId !== zoneId) throw new GameError(`ชั่วโมงนี้ภารกิจบังคับให้คุณไปที่${this.zoneName(p.forced.zoneId)}`);
    this.moves.set(playerId, zoneId);
    this.emit();
    if (this.alivePlayers().every((a) => this.moves.has(a.id))) this.resolveMoves();
  }

  resolveMoves() {
    this.clearTimers();
    const alive = this.alivePlayers();
    const positions = {};
    const prevZone = new Map(alive.map((p) => [p.id, p.zoneId]));
    const bounced = new Set();
    for (const p of alive) {
      let zid = this.moves.get(p.id) || p.zoneId || this.location.sleepZoneId;
      const target = this.zones.get(zid);
      // ห้องที่ล็อกอยู่: เข้าได้เฉพาะคนที่มีกุญแจ (หรืออยู่ข้างในอยู่แล้ว) คนอื่นชนประตูแล้วต้องอยู่ที่เดิม
      if (target.locked && zid !== p.zoneId && !this.hasKeyFor(p, zid)) {
        bounced.add(p.id);
        p.zoneMemory[zid] = { ...(p.zoneMemory[zid] || {}), day: this.day, hour: this.hour, phase: this.phase, locked: true, lockedSeenTurn: this.turn };
        this.logTo(p, `🔒 คุณเดินไปถึง${this.zn(target)}แต่ประตูล็อกอยู่ เข้าไม่ได้ — ต้องหากุญแจของห้องนี้หรือกุญแจผู้ดูแล คุณจึงยังอยู่ที่${this.zn(p.zoneId || this.location.sleepZoneId)}ต่อ`, 'danger');
        zid = p.zoneId || this.location.sleepZoneId;
      }
      p.zoneId = zid;
      positions[p.id] = zid;
    }
    // คนที่ออกจากห้องที่ล็อกอยู่โดยไม่มีใครถือกุญแจ → ประตูถูกเปิดค้างไว้ (ล็อกจากข้างนอกไม่ได้)
    for (const z of this.zones.values()) {
      if (!z.locked) continue;
      const leavers = alive.filter((p) => prevZone.get(p.id) === z.id && p.zoneId !== z.id);
      if (leavers.length && !leavers.some((p) => this.hasKeyFor(p, z.id))) {
        z.locked = false;
        for (const p of leavers) this.logTo(p, `🔓 คุณออกจาก${this.zn(z)}โดยไม่มีกุญแจ ประตูจึงถูกเปิดค้างไว้ ใครก็เข้าได้แล้ว`, 'info');
        this.recordEvent(`${leavers.map((p) => this.nick(p)).join(', ')}ออกจาก${this.zn(z)}ที่ล็อกอยู่โดยไม่มีกุญแจ ประตูจึงไม่ล็อกอีกต่อไป`);
      }
    }
    this.timeline.push({ day: this.day, hour: this.hour, turn: this.turn, phase: this.phase, positions, events: [] });

    // กับดักทำงานตอนมีคนเข้าห้อง (คนที่เพิ่งเข้ามาเท่านั้น คนที่อยู่ในห้องอยู่แล้วไม่โดน)
    for (const z of this.zones.values()) {
      if (!z.traps.length) continue;
      for (const p of shuffle(alive.filter((x) => x.alive && x.zoneId === z.id && prevZone.get(x.id) !== z.id))) {
        const trap = z.traps.find((t) => t.setterId !== p.id);
        if (!trap) continue;
        const disarm = TRAP_DISARM_CHANCE + (this.traitOf(p) === 'detective' ? 0.2 : 0);
        const r = Math.random();
        if (r < disarm) {
          z.traps.splice(z.traps.indexOf(trap), 1);
          z.items.push({ ...trap.item, hidden: false });
          z.evidence.push(this.makeEvidence(z.id, `${trap.item.name}ถูกตั้งไว้เป็นกับดักที่ทางเข้า และมีคนปลดออกแล้ว`, false, null, 'trap'));
          this.logTo(p, `⚠ ทันทีที่จะเข้า${this.zn(z)}คุณสังเกตเห็น${trap.item.name}ตั้งไว้เป็นกับดัก (${TRAP_TYPES[trap.item.trapType]?.label || ''}) คุณปลดมันออกได้ทัน — มีคนตั้งใจจะฆ่าใครสักคนที่เข้ามาห้องนี้`, 'danger');
          this.recordEvent(`${this.nick(p)}พบและปลดกับดัก (${trap.item.name}) ที่${this.zn(z)}`);
        } else if (r < disarm + TRAP_TRIGGER_CHANCE) {
          this.triggerTrap(z, trap, p);
        }
      }
    }

    // ใครอยู่ที่ไหนกับใคร เห็นของอะไร เจอศพไหม
    for (const p of alive) {
      if (!p.alive) continue;
      const z = this.zones.get(p.zoneId);
      const others = this.presentIn(z.id).filter((o) => o.id !== p.id);
      const bodies = this.bodiesIn(z.id);
      const visibleItems = z.items.filter((i) => !i.hidden);
      const lines = [bounced.has(p.id) ? `📍 คุณยังอยู่ที่${this.zn(z)}` : `📍 คุณมาถึง${this.zn(z)}${z.locked ? ' (ประตูล็อกอยู่ คุณไขเข้ามาด้วยกุญแจ)' : ''}`];
      lines.push(others.length ? `คนที่อยู่ที่นี่ด้วย: ${others.map((o) => this.nick(o)).join(', ')}` : 'ไม่มีใครอยู่ที่นี่นอกจากคุณ');
      lines.push(visibleItems.length ? `ของที่เห็น: ${visibleItems.map((i) => (i.isPart ? `${i.name} ⭐` : i.name)).join(', ')}` : 'ไม่เห็นของอะไรเป็นพิเศษ');
      for (const b of bodies) {
        const v = this.players.get(b.victimId);
        const first = !p.knownBodies.has(b.victimId);
        p.knownBodies.add(b.victimId);
        if (b.killerId !== p.id) b.discoveredBy.add(p.id);
        lines.push(first ? `☠ คุณพบศพของ${this.nick(v)}อยู่ที่นี่!${b.announced ? '' : ' ยังไม่มีการประกาศ — คุณจะบอกใครหรือไม่ก็ได้'}` : `☠ ศพของ${this.nick(v)}ยังอยู่ที่นี่`);
      }
      for (const o of others) {
        if (o.stained === this.turn - 1 && chance(0.4)) lines.push(`👀 เสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่ยังไม่ได้ซัก`);
      }
      if (z.traps.some((t) => t.setterId === p.id)) lines.push(`🪤 กับดักของคุณยังอยู่ที่นี่`);
      const known = exitsIn(this, z.id).filter((x) => knowsExit(p, x));
      if (known.length) lines.push(`🚪 ทางออกที่คุณรู้จักในห้องนี้: ${known.map((x) => x.name).join(', ')}`);
      p.zoneMemory[z.id] = {
        day: this.day,
        hour: this.hour,
        phase: this.phase,
        people: others.map((o) => this.nick(o)),
        items: visibleItems.map((i) => i.name),
        bodies: bodies.map((b) => this.nick(this.players.get(b.victimId))),
        locked: z.locked,
        food: hasFood(z),
        searched: p.zoneMemory[z.id]?.searched,
      };
      this.logTo(p, lines.join(' · '), 'move');
      this.checkObjectivesAfterMove(p);
    }

    if (this.alivePlayers().length <= 1) return this.endGame('last_one');
    if (this.checkBodyThreshold()) return;
    this.step = STEP.ACT;
    // ภารกิจที่ครบกำหนดบังคับแอ็กชันด้วย
    for (const p of this.alivePlayers()) {
      if (!p.forced?.action) continue;
      const fa = p.forced.action;
      const match = this.availableActions(p).find((a) => a.type === fa.type && (fa.itemId ?? null) === (a.itemId ?? null) && !a.disabled);
      if (match && p.zoneId === p.forced.zoneId) this.actions.set(p.id, { ...match, forced: true });
      else {
        const o = p.objectives.find((x) => x.id === p.forced.objectiveId);
        if (o && !o.done) {
          o.done = true;
          o.forgiven = true;
          o.doneTurn = this.turn;
          this.logTo(p, `📋 ภารกิจ "${o.text}" ถูกยกเลิก (ทำไม่ได้แล้ว เช่น ของหาย ถือของเต็มมือ หรือเข้าห้องไม่ได้) ไม่มีบทลงโทษ`, 'objective');
        }
        p.forced = null;
      }
    }
    this.emit();
    if (this.alivePlayers().every((p) => this.actions.has(p.id))) return this.resolveActions();
    this.armStepTimer();
    this.scheduleBots();
  }

  triggerTrap(z, trap, victim) {
    z.traps.splice(z.traps.indexOf(trap), 1);
    const setter = this.players.get(trap.setterId) || null;
    const tt = TRAP_TYPES[trap.item.trapType] || TRAP_TYPES.fall;
    const w = trap.item.weaponName || trap.item.name;
    const kase = this.killPlayer(victim, { cause: 'trap', trapType: trap.item.trapType, killerId: setter?.id || null, weapon: { name: trap.item.name, kind: tt.weaponKind }, zoneId: z.id, messy: false, witnesses: [] });
    z.evidence.push(this.makeEvidence(z.id, fill(tt.evidence, w), false, kase.id, 'trap'));
    z.items.push({ ...trap.item, hidden: false, sprung: true });
    this.logTo(victim, `💀 ${fill(tt.trigger, w)} ที่${this.zn(z)}คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
    for (const o of this.presentIn(z.id)) {
      o.knownBodies.add(victim.id);
      this.bodies.get(victim.id).discoveredBy.add(o.id);
      this.logTo(o, `😱 ต่อหน้าคุณ ${this.nick(victim)}ล้มลงที่ทางเข้า${this.zn(z)}และเสียชีวิต — ${tt.label} ไม่มีใครแตะต้องเขาเลย ต้องเป็นกับดักที่มีคนวางไว้ก่อน`, 'witness');
    }
    if (setter?.alive) this.logTo(setter, `🪤 กับดัก (${trap.item.name}) ที่คุณวางไว้ที่${this.zn(z)}ทำงานแล้ว — ${this.nick(victim)}ตาย คุณคือคนร้ายของคดีนี้`, 'culprit');
    this.recordEvent(`${this.nick(victim)}โดนกับดัก (${trap.item.name}) ของ${setter ? this.nick(setter) : '?'}ที่${this.zn(z)}และเสียชีวิต`);
  }

  // ฆ่าผู้เล่น: ศพอยู่ตรงนั้น ของที่ถือหล่นไว้ในห้อง สร้างคดี
  killPlayer(victim, info) {
    victim.alive = false;
    victim.fate = 'victim';
    victim.deathCause = info.cause;
    victim.eliminatedDay = this.day;
    victim.eliminatedHour = this.hour;
    victim.forced = null;
    const z = this.zones.get(info.zoneId);
    const dropped = victim.inventory.map((i) => i.name);
    for (const it of victim.inventory) {
      it.hidden = false;
      z.items.push(it);
    }
    victim.inventory = [];
    for (const o of victim.objectives) o.done = true;
    const kase = {
      id: nextId(),
      day: this.day,
      hour: this.hour,
      turn: this.turn,
      phase: this.phase,
      victimId: victim.id,
      killerId: info.killerId || null,
      cause: info.cause,
      trapType: info.trapType || null,
      weapon: info.weapon ? { name: info.weapon.name, kind: info.weapon.kind } : null,
      zoneId: info.zoneId,
      messy: !!info.messy,
      moved: false,
      witnesses: info.witnesses || [],
      present: this.presentIn(info.zoneId).map((p) => p.id),
      designatedId: this.phase === PHASE.DAY ? this.designatedId : null,
      dropped,
      judged: false,
      announced: false,
      narrative: null,
    };
    this.cases.push(kase);
    this.bodies.set(victim.id, {
      victimId: victim.id,
      caseId: kase.id,
      killerId: kase.killerId,
      zoneId: info.zoneId,
      day: this.day,
      hour: this.hour,
      turn: this.turn,
      discoveredBy: new Set(),
      examinedBy: new Set(),
      moved: false,
      announced: false,
      judged: false,
    });
    if (kase.killerId) {
      const k = this.players.get(kase.killerId);
      if (k) k.kills++;
    }
    return kase;
  }

  bodyThreshold() {
    return Math.max(1, Math.min(CONFIG.BODY_DISCOVERERS, this.alivePlayers().length - 1));
  }

  checkBodyThreshold() {
    if (this.phase !== PHASE.DAY) return false;
    const hit = [...this.bodies.values()].some((b) => !b.judged && !b.announced && b.discoveredBy.size >= this.bodyThreshold());
    if (!hit) return false;
    this.startInvestigation().catch((e) => this.fail(e));
    return true;
  }

  // ---------- actions ----------
  // ของที่ใช้ลงมือได้ดีที่สุดในมือ (กุญแจ/ชิ้นส่วน/แผนผัง/กับดัก ใช้ลงมือไม่ได้)
  bestWeapon(p) {
    const trait = this.traitOf(p);
    let best = null;
    let bestScore = 0;
    for (const it of p.inventory) {
      let s = ATTACK.WEAPON_BASE[it.kind] || 0;
      if (it.kind === 'poison' && trait === 'medical') s = ATTACK.POISON_MEDICAL;
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    return best;
  }

  // โอกาสลงมือสำเร็จ พร้อมรายละเอียดการคำนวณ (แสดงให้ผู้เล่นเห็นตอนเลือก)
  attackBreakdown(p, target, weapon, witnessCount, zone) {
    const parts = [];
    const trait = this.traitOf(p);
    let base;
    if (!weapon) {
      base = ATTACK.UNARMED;
      parts.push({ label: 'มือเปล่า', value: base });
    } else if (weapon.kind === 'poison') {
      base = trait === 'medical' ? ATTACK.POISON_MEDICAL : ATTACK.WEAPON_BASE.poison;
      parts.push({ label: trait === 'medical' ? `วางยา (สายการแพทย์)` : 'วางยา', value: base });
    } else {
      base = ATTACK.WEAPON_BASE[weapon.kind] || 0.5;
      parts.push({ label: `${KIND_LABEL[weapon.kind] || weapon.kind}`, value: base });
    }
    let total = base;
    const add = (label, v) => {
      if (!v) return;
      total += v;
      parts.push({ label, value: v });
    };
    if (trait === 'combat') add(weapon ? 'นักสู้ (ถืออาวุธ)' : 'นักสู้ (มือเปล่า)', weapon ? ATTACK.COMBAT_ARMED_BONUS : ATTACK.COMBAT_UNARMED_BONUS);
    if (this.traitOf(target) === 'combat') add('เป้าหมายเป็นนักสู้', -ATTACK.TARGET_COMBAT_PENALTY);
    if (this.phase === PHASE.DAY && this.designatedId === p.id) add('ฆาตกรประจำวัน', ATTACK.DESIGNATED_BONUS);
    if (witnessCount) add(`คนอื่นในห้อง ${witnessCount} คน`, -ATTACK.WITNESS_PENALTY * witnessCount);
    if (zone?.dark) add('ห้องมืด', ATTACK.DARK_BONUS);
    const chanceValue = clamp(total, ATTACK.MIN, ATTACK.MAX);
    return { chance: chanceValue, parts, text: parts.map((x, i) => `${i ? (x.value >= 0 ? ' + ' : ' − ') : ''}${x.label} ${Math.round(Math.abs(x.value) * 100)}%`).join('') };
  }

  attackChance(p, target, weapon, witnessCount, zone) {
    return this.attackBreakdown(p, target, weapon, witnessCount, zone || this.zones.get(p.zoneId)).chance;
  }

  // สูตรคราฟที่ทำได้จากของในมือ (คืน action ละสูตร โดยเลือกของชิ้นแรกที่เข้าเงื่อนไข)
  craftOptions(p, z) {
    const out = [];
    const trait = this.traitOf(p);
    for (const r of RECIPES) {
      if (r.trait && trait !== r.trait) continue;
      const a = p.inventory.find((i) => i.kind === r.needs[0]);
      const b = p.inventory.find((i) => i.kind === r.needs[1] && i !== a);
      if (!a || !b) continue;
      const placeOk = !r.placeNeeds || z.items.some((i) => i.kind === r.placeNeeds);
      out.push({ type: 'craft', recipeId: r.id, itemId: a.id, itemId2: b.id, label: `🛠 ประกอบ "${r.name}" จาก${a.name} + ${b.name}`, desc: `${r.desc} — ใช้เวลา 1 ชั่วโมง ของทั้งสองชิ้นจะถูกใช้ไป ได้กับดัก 1 ชิ้นไว้วางทีหลัง${placeOk ? '' : ` (วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]})`}` });
    }
    return out;
  }

  availableActions(p) {
    const z = this.zones.get(p.zoneId);
    if (!z || !p.alive) return [];
    const trait = this.traitOf(p);
    const others = this.presentIn(z.id).filter((o) => o.id !== p.id);
    const bodies = this.bodiesIn(z.id);
    const out = [];
    const inDay = this.phase === PHASE.DAY;
    out.push({ type: 'search', label: '🔍 สำรวจห้องอย่างละเอียด', desc: 'หาของที่ซ่อนอยู่ ทางออกที่ซ่อนอยู่ หลักฐาน และสังเกตว่ามีอะไรหายไปจากห้อง' });
    const invFull = p.inventory.length >= CONFIG.INVENTORY_MAX;
    for (const it of z.items.filter((i) => !i.hidden && i.portable)) {
      out.push({ type: 'take', itemId: it.id, label: `🖐 หยิบ ${it.name}${it.isPart ? ' ⭐' : ''}`, desc: it.description, disabled: invFull, reason: invFull ? `ถือของได้สูงสุด ${CONFIG.INVENTORY_MAX} ชิ้น วางของก่อน` : '' });
    }
    for (const it of p.inventory) {
      out.push({ type: 'hide', itemId: it.id, label: `🫥 ซ่อน ${it.name} ไว้ในห้องนี้`, desc: 'คนอื่นต้องสำรวจละเอียดถึงจะเจอ' });
      out.push({ type: 'drop', itemId: it.id, label: `⬇ วาง ${it.name} ไว้ในห้องนี้`, desc: 'ใครเข้ามาก็เห็นทันที' });
    }
    const food = z.items.find((i) => i.kind === 'food');
    if (food) out.push({ type: 'eat', label: `🍞 กินอาหาร/ดื่มน้ำ (${food.name})`, desc: 'พักกินอะไรสักหน่อย — ใช้ทำภารกิจ "ไปกินอาหาร" ได้ · ระวัง ถ้ามีคนผสมยาพิษไว้คุณอาจไม่รู้ตัว' });
    if (z.lockable) {
      const key = p.inventory.find((i) => i.kind === 'key' && (i.master || i.unlocksZoneId === z.id));
      if (key && !z.locked) out.push({ type: 'lock', label: `🔒 ล็อกประตูห้องนี้ (ด้วย${key.name})`, desc: 'ชั่วโมงถัดไปคนที่ไม่มีกุญแจจะเข้าห้องนี้ไม่ได้ · คนข้างในออกได้เสมอ แต่ถ้าคนออกไม่มีกุญแจ ประตูจะถูกเปิดค้างไว้' });
      if (key && z.locked) out.push({ type: 'unlock', label: `🔓 ปลดล็อกประตูห้องนี้ (ด้วย${key.name})`, desc: 'เปิดให้ใครก็เข้าได้' });
    }
    if (inDay) {
      for (const o of others) {
        const w = this.bestWeapon(p);
        const bd = this.attackBreakdown(p, o, w, others.length - 1, z);
        out.push({
          type: 'attack',
          targetId: o.id,
          label: `🔪 ลงมือกับ ${this.nick(o)}${w ? ` ด้วย${w.name}` : ' ด้วยมือเปล่า'}`,
          desc: `โอกาสสำเร็จราว ${Math.round(bd.chance * 100)}% (${bd.text})${others.length > 1 ? ` · มีคนอื่นในห้องอีก ${others.length - 1} คน (อาจเห็น หรือโดนลูกหลง)` : ''} · พลาดแล้วเขาจะรู้ตัว และอาจสวนกลับ${this.traitOf(o) === 'combat' ? ' (เขาเป็นนักสู้ สวนกลับ 50%)' : ' (25%)'}`,
          danger: true,
        });
      }
      out.push(...this.craftOptions(p, z));
      if (!z.traps.some((t) => t.setterId === p.id)) {
        for (const it of p.inventory.filter((i) => i.kind === 'trap')) {
          const r = RECIPES.find((x) => x.trapType === it.trapType);
          const ok = !r?.placeNeeds || z.items.some((i) => i.kind === r.placeNeeds);
          out.push({ type: 'trap', itemId: it.id, label: `🪤 วางกับดัก "${it.name}" ที่ทางเข้าห้องนี้`, desc: `${TRAP_TYPES[it.trapType]?.label || ''} — คนต่อไปที่เข้ามา (ที่ไม่ใช่คุณ) มีโอกาสโดน ${Math.round(TRAP_TRIGGER_CHANCE * 100)}% ถ้าเขาตาย คุณคือคนร้าย`, danger: true, disabled: !ok, reason: ok ? '' : `วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]}` });
        }
      }
      if (food && !food.poisoned) {
        for (const it of p.inventory.filter((i) => i.kind === 'poison')) {
          out.push({ type: 'poisonFood', itemId: it.id, label: `☠ ผสม${it.name}ลงใน${food.name}`, desc: `ใครก็ตามที่มากินอาหารในห้องนี้มีโอกาสตาย (สายการแพทย์/ช่างสังเกตอาจรู้ทัน 50% คนทั่วไป 15%) ถ้าเขาตาย คุณคือคนร้าย${trait === 'medical' ? ' · คุณเป็นสายการแพทย์ ผสมได้เนียน' : ''}`, danger: true });
        }
      }
    }
    for (const b of bodies) {
      const v = this.players.get(b.victimId);
      out.push({ type: 'examine', victimId: b.victimId, label: `🔎 ตรวจศพของ ${this.nick(v)}`, desc: trait === 'medical' ? 'ความรู้ทางการแพทย์ของคุณจะบอกอาวุธ เวลาตาย และว่าศพถูกย้ายหรือไม่' : 'ดูสภาพศพคร่าว ๆ (คนที่มีความรู้ทางการแพทย์จะเห็นมากกว่า)' });
      out.push({ type: 'moveBody', victimId: b.victimId, label: `🚚 ย้ายศพของ ${this.nick(v)} ไปห้องอื่น`, desc: 'ทิ้งรอยลากไว้ทั้งสองห้อง และคนในห้องอาจเห็น', needsZone: true, danger: true });
    }
    if (z.evidence.some((e) => !e.hidden)) {
      out.push({ type: 'clean', label: '🧹 เก็บกวาด/ทำลายร่องรอยในห้องนี้', desc: `ซ่อนหลักฐานที่มองเห็นได้ในห้องนี้${trait === 'stealth' || trait === 'medical' ? ' (คุณถนัดเรื่องนี้ 75%)' : ' (สำเร็จ 50%)'} — ทำพลาดอาจยิ่งทิ้งร่องรอย`, danger: true });
    }
    if (trait === 'stealth') for (const o of others) out.push({ type: 'steal', targetId: o.id, label: `🕵 ล้วงกระเป๋า ${this.nick(o)}`, desc: 'ขโมยของ 1 ชิ้นจากเขา (สำเร็จ 70%) โดยที่เขาอาจไม่รู้ตัว' });
    if (trait === 'social') for (const o of others) out.push({ type: 'interrogate', targetId: o.id, label: `🗣 ซักถาม ${this.nick(o)}`, desc: 'รู้ความจริงเกี่ยวกับเขา 1 ข้อ (เขาจะรู้ว่าคุณซักถาม)' });
    if (trait === 'tech' && z.items.some((i) => i.kind === 'power') && !z.dark) out.push({ type: 'sabotage', label: '⚡ ตัดไฟ/กล้องในห้องนี้', desc: 'ชั่วโมงนี้พยานในห้องนี้จะจำหน้าคนลงมือไม่ได้ (รวมถึงสิ่งที่คุณทำด้วย)' });
    out.push(...exitActions(this, p, z));
    out.push({ type: 'rest', label: '😶 ไม่ทำอะไร แค่สังเกตคนอื่น', desc: 'มีโอกาสเห็นว่าใครในห้องทำอะไรลับ ๆ ล่อ ๆ' });
    return out;
  }

  chooseAction(playerId, action) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    this.assertStep(STEP.ACT);
    const p = this.alivePlayer(playerId);
    if (this.actions.get(playerId)?.forced) throw new GameError('ชั่วโมงนี้ภารกิจบังคับการกระทำของคุณแล้ว');
    action = action || {};
    const same = (a, k) => (a[k] ?? null) === (action[k] ?? null);
    const match = this.availableActions(p).find((a) => a.type === action.type && same(a, 'targetId') && same(a, 'itemId') && same(a, 'victimId') && same(a, 'recipeId') && same(a, 'exitId'));
    if (!match) throw new GameError('ทำแอ็กชันนี้ไม่ได้');
    if (match.disabled) throw new GameError(match.reason || 'ทำแอ็กชันนี้ไม่ได้');
    // ล็อกการฆาตกรรม: ถ้ามีศพที่ยังไม่ถูกพบ คนที่ไม่ใช่คนร้ายของคดีนั้นลงมือซ้อนไม่ได้ (ระบบบอกคนที่พยายามเท่านั้น)
    if (['attack', 'trap', 'poisonFood'].includes(match.type) && this.murderLockedFor(p)) {
      this.logTo(p, `🔒 คุณพยายามจะ${match.type === 'attack' ? 'ลงมือ' : 'วางกับดัก'} แต่ระบบของที่นี่แจ้งว่า: ${MURDER_LOCK_MESSAGE} — แปลว่าตอนนี้มีศพซ่อนอยู่ที่ไหนสักแห่ง`, 'danger');
      this.emit();
      throw new GameError(`🔒 ${MURDER_LOCK_MESSAGE}`);
    }
    const chosen = { ...match };
    if (match.needsZone) {
      if (!this.zones.has(action.toZoneId) || action.toZoneId === p.zoneId) throw new GameError('เลือกห้องปลายทางที่ไม่ใช่ห้องนี้');
      chosen.toZoneId = action.toZoneId;
    }
    this.actions.set(playerId, chosen);
    this.emit();
    if (this.alivePlayers().every((a) => this.actions.has(a.id))) this.resolveActions();
  }

  resolveActions() {
    this.clearTimers();
    for (const p of this.alivePlayers()) if (!this.actions.has(p.id)) this.actions.set(p.id, { type: 'rest', auto: true });
    const order = { sabotage: 0, lock: 1, unlock: 1, attack: 2, steal: 3, poisonFood: 4, trap: 4, craft: 5, clean: 6, moveBody: 7, interrogate: 8, take: 9, drop: 10, hide: 10, exit_power: 11, search: 12, examine: 12, eat: 13, exit: 14, rest: 15 };
    const list = shuffle([...this.actions.entries()]).sort((a, b) => (order[a[1].type] ?? 20) - (order[b[1].type] ?? 20));
    const exitAttempts = [];
    for (const [pid, a] of list) {
      const p = this.players.get(pid);
      if (!p?.alive) continue;
      const fn = this[`do_${a.type}`];
      if (typeof fn !== 'function') continue;
      try {
        fn.call(this, p, a, exitAttempts);
      } catch (err) {
        this.log.error(`[room ${this.code}] action ${a.type} failed`, err);
      }
    }
    this.resolveRest();
    if (resolveExits(this, exitAttempts)) return;
    if (this.phase === PHASE.ENDED) return;

    // ก่อนแยกย้าย คนในห้องเดียวกันเห็นศพที่เพิ่งเกิดขึ้น และอาจสังเกตเสื้อผ้าเปื้อน
    for (const b of this.bodies.values()) {
      if (b.judged || b.turn !== this.turn) continue;
      for (const o of this.presentIn(b.zoneId)) {
        if (o.id === b.killerId || o.knownBodies.has(b.victimId)) continue;
        o.knownBodies.add(b.victimId);
        b.discoveredBy.add(o.id);
        this.logTo(o, `☠ ก่อนออกจาก${this.zn(b.zoneId)}คุณพบว่า${this.nick(this.players.get(b.victimId))}นอนไม่ขยับอยู่ — เขาตายแล้ว`, 'witness');
      }
    }
    for (const p of this.alivePlayers()) {
      for (const o of this.presentIn(p.zoneId)) {
        if (o.id !== p.id && o.stained === this.turn && chance(0.5)) this.logTo(p, `👀 คุณสังเกตว่าเสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่เมื่อครู่ยังไม่มี`, 'witness');
      }
    }
    for (const p of this.alivePlayers()) p.forced = null;

    if (this.phase === PHASE.DAY) {
      if (this.alivePlayers().length <= 1) return this.endGame('last_one');
      if (this.checkBodyThreshold()) return;
      this.step = STEP.REPORT;
      this.ready = new Set();
      this.systemMessage(`ชั่วโมงที่ ${this.hour} จบลง — อ่านสมุดบันทึก ให้ของกับคนในห้องเดียวกันได้ แล้วกด "พร้อมไปชั่วโมงถัดไป"`);
      this.emit();
      this.scheduleBots();
    } else {
      this.beginTrial().catch((e) => this.fail(e));
    }
  }

  witnessesOf(p, z) {
    return this.presentIn(z.id).filter((o) => o.id !== p.id);
  }

  who(p, z) {
    return z.dark ? 'ใครบางคน (มืดเกินกว่าจะเห็นหน้า)' : this.nick(p);
  }

  // โอกาสที่คนในห้องเห็นสิ่งที่คุณทำ (สายเงียบเชียบเห็นยากขึ้นครึ่งหนึ่ง)
  seen(p, base) {
    return chance(this.traitOf(p) === 'stealth' ? base / 2 : base);
  }

  do_attack(p, a) {
    const target = this.players.get(a.targetId);
    const z = this.zones.get(p.zoneId);
    if (!target || target.zoneId !== z.id) return this.logTo(p, `คุณมองหา${this.nick(target)}แต่เขาไม่ได้อยู่ตรงนี้แล้ว`, 'danger');
    if (!target.alive) {
      this.logTo(p, `คุณย่องเข้าไปหา${this.nick(target)} แต่พบว่าเขาตายไปแล้วก่อนที่คุณจะลงมือ`, 'danger');
      p.knownBodies.add(target.id);
      this.bodies.get(target.id)?.discoveredBy.add(p.id);
      return;
    }
    const w = this.bestWeapon(p);
    const wtxt = w ? `ด้วย${w.name}` : 'ด้วยมือเปล่า';
    const others = this.presentIn(z.id).filter((o) => o.id !== p.id && o.id !== target.id);
    const pSucc = this.attackChance(p, target, w, others.length, z);
    const who = this.who(p, z);
    const r = Math.random();
    if (r < pSucc) {
      const messy = chance(this.traitOf(p) === 'combat' ? ATTACK.MESSY_COMBAT : ATTACK.MESSY);
      const saw = others.filter(() => chance(messy ? 0.75 : 0.4));
      const kase = this.killPlayer(target, { cause: 'attack', killerId: p.id, weapon: w, zoneId: z.id, messy, witnesses: saw.map((o) => o.id) });
      this.addKillEvidence(z, kase, w, messy, p);
      if (messy) p.stained = this.turn;
      if (w?.kind === 'poison') {
        p.inventory.splice(p.inventory.indexOf(w), 1);
        w.hidden = true;
        z.items.push(w);
      }
      this.logTo(
        p,
        `🔪 คุณลงมือกับ${this.nick(target)}${wtxt}สำเร็จ ${messy ? 'แต่ไม่เรียบร้อย: คราบเลือดกระจาย ของล้มระเนระนาด และเสื้อผ้าคุณเปื้อน' : 'อย่างเงียบเชียบ ทิ้งร่องรอยไว้น้อยมาก'}${
          saw.length ? ` — แย่แล้ว ${saw.map((o) => this.nick(o)).join(', ')}เห็นคุณลงมือ!` : others.length ? ` ไม่มีใครเห็นตอนลงมือ แต่คนในห้อง (${others.map((o) => this.nick(o)).join(', ')}) เห็นศพแน่นอน` : ' ไม่มีใครเห็น'
        }${kase.dropped.length ? ` ของที่${this.nick(target)}ถือหล่นอยู่ที่นี่: ${kase.dropped.join(', ')}` : ''} คุณคือคนร้ายของคดีนี้ — ศพจะอยู่ตรงนี้จนกว่าจะมีคนย้าย และจนกว่าศพจะถูกพบ คนอื่นจะลงมือฆ่าใครไม่ได้ มีแต่คุณที่ทำได้`,
        'culprit',
      );
      this.logTo(target, `💀 ${who}ลงมือกับคุณ${wtxt}ที่${this.zn(z)}คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
      for (const o of others) {
        o.knownBodies.add(target.id);
        this.bodies.get(target.id).discoveredBy.add(o.id);
        if (saw.includes(o)) this.logTo(o, `😱 คุณเห็น${who}ลงมือกับ${this.nick(target)}${wtxt}ต่อหน้าต่อตา!`, 'witness');
        else
          this.logTo(
            o,
            `😱 คุณหันไปอีกทีก็เห็น${this.nick(target)}นอนไม่ขยับอยู่ที่${this.zn(z)}คนที่อยู่ในห้องนี้ตอนนั้น: ${[p, ...others.filter((x) => x !== o)].map((x) => (z.dark ? 'เงาคน' : this.nick(x))).join(', ')}${z.dark ? ' (มืดจนแยกไม่ออก)' : ''}`,
            'witness',
          );
      }
      this.designatedHears(kase, p);
      this.recordEvent(`${this.nick(p)}ฆ่า${this.nick(target)}ที่${this.zn(z)}${wtxt}${messy ? ' แบบเลอะเทอะ' : ' อย่างเงียบเชียบ'}${saw.length ? ` (${saw.map((o) => this.nick(o)).join(', ')}เห็น)` : ''}`);
      return;
    }
    // พลาด
    if (chance(this.traitOf(target) === 'combat' ? ATTACK.COUNTER_KILL_COMBAT : ATTACK.COUNTER_KILL)) {
      const kase = this.killPlayer(p, { cause: 'defense', killerId: target.id, weapon: null, zoneId: z.id, messy: true, witnesses: others.map((o) => o.id) });
      this.addKillEvidence(z, kase, null, true, target);
      target.stained = this.turn;
      this.logTo(target, `⚔ ${who}จู่โจมคุณ${wtxt}ที่${this.zn(z)}! คุณสู้กลับสุดชีวิต และ... ${this.nick(p)}ล้มลงไม่ขยับ เขาตายแล้ว ตามกติกาของที่นี่ คุณคือ "คนร้าย" ของคดีนี้ แม้จะเป็นการป้องกันตัว`, 'culprit');
      this.logTo(p, `💀 คุณจู่โจม${this.nick(target)} แต่เขาสวนกลับได้ คุณเป็นฝ่ายตายเสียเอง...`, 'death');
      for (const o of others) {
        o.knownBodies.add(p.id);
        this.bodies.get(p.id).discoveredBy.add(o.id);
        this.logTo(o, `😱 ${who}จู่โจม${this.nick(target)}ต่อหน้าคุณ แต่${this.nick(target)}สวนกลับจน${this.nick(p)}ล้มลงและไม่ลุกขึ้นมาอีก`, 'witness');
      }
      this.recordEvent(`${this.nick(p)}พยายามฆ่า${this.nick(target)}ที่${this.zn(z)}แต่ถูกสวนกลับจนตาย`);
      return;
    }
    if (others.length && chance(ATTACK.WRONG_TARGET)) {
      const wrong = pick(others);
      const rest = others.filter((o) => o !== wrong);
      const kase = this.killPlayer(wrong, { cause: 'wrongTarget', killerId: p.id, weapon: w, zoneId: z.id, messy: true, witnesses: [target.id, ...rest.map((o) => o.id)] });
      this.addKillEvidence(z, kase, w, true, p);
      p.stained = this.turn;
      this.logTo(p, `💥 คุณพุ่งเข้าใส่${this.nick(target)} แต่เขาหลบทัน และ${w ? w.name : 'แรงของคุณ'}ไปลง${this.nick(wrong)}เต็ม ๆ... ${this.nick(wrong)}ตายทันที ทุกคนในห้องเห็นหมด คุณคือคนร้ายของคดีนี้`, 'culprit');
      this.logTo(wrong, `💀 ${who}ตั้งใจเล่นงาน${this.nick(target)} แต่พลาดมาโดนคุณ... คุณเสียชีวิต`, 'death');
      this.logTo(target, `😱 ${who}พุ่งเข้าใส่คุณ${wtxt}! คุณหลบทัน แต่${this.nick(wrong)}ที่อยู่ข้าง ๆ รับไปเต็ม ๆ และตายต่อหน้าคุณ`, 'witness');
      for (const o of [target, ...rest]) {
        o.knownBodies.add(wrong.id);
        this.bodies.get(wrong.id).discoveredBy.add(o.id);
        if (o !== target) this.logTo(o, `😱 ${who}พุ่งเข้าใส่${this.nick(target)}แต่พลาดไปโดน${this.nick(wrong)} ${this.nick(wrong)}ตายต่อหน้าคุณ`, 'witness');
      }
      this.recordEvent(`${this.nick(p)}ตั้งใจฆ่า${this.nick(target)}ที่${this.zn(z)}แต่พลาดไปโดน${this.nick(wrong)}`);
      return;
    }
    const dropWeapon = w && w.kind !== 'poison' && chance(ATTACK.DROP_WEAPON);
    if (dropWeapon) {
      p.inventory.splice(p.inventory.indexOf(w), 1);
      w.hidden = false;
      z.items.push(w);
      z.evidence.push(this.makeEvidence(z.id, `${w.name}ตกอยู่กลางห้อง ไม่ใช่ที่ของมัน`, false, null, 'item'));
    }
    this.logTo(p, `❌ คุณพยายามลงมือกับ${this.nick(target)}${wtxt} แต่พลาด เขาตัวไวกว่าที่คิด${dropWeapon ? ` และคุณทำ${w.name}หล่นไว้ที่นั่น` : ''} ตอนนี้เขารู้แล้วว่ามีคนพยายามฆ่าเขา${z.dark ? ' (แต่มืด เขาอาจไม่รู้ว่าเป็นคุณ)' : ''}`, 'danger');
    this.logTo(target, `⚠ ${who}พยายามทำร้ายคุณที่${this.zn(z)}${wtxt}! คุณหลบได้ทัน${z.dark ? ' แต่มืดเกินกว่าจะเห็นว่าเป็นใคร' : ''}`, 'danger');
    for (const o of others) if (chance(0.6)) this.logTo(o, `👀 คุณเห็น${who}กับ${this.nick(target)}ปะทะกันชั่วครู่ที่${this.zn(z)}${this.nick(target)}ดูตกใจมาก`, 'witness');
    this.recordEvent(`${this.nick(p)}พยายามฆ่า${this.nick(target)}ที่${this.zn(z)}แต่ล้มเหลว`);
  }

  addKillEvidence(z, kase, w, messy, killer) {
    const v = this.players.get(kase.victimId);
    if (messy) {
      z.evidence.push(this.makeEvidence(z.id, `คราบเลือดกระจายและของล้มระเนระนาดใกล้จุดที่${this.nick(v)}ล้มลง — มีการต่อสู้`, false, kase.id, 'struggle'));
      if (chance(0.35)) {
        const look = this.charOf(killer)?.appearance || 'เสื้อผ้าของใครบางคน';
        z.evidence.push(this.makeEvidence(z.id, `เศษผ้าขาดเกี่ยวติดอยู่กับขอบตู้ — ดูเหมือนมาจากเสื้อผ้าแบบ "${look.split(' ').slice(-3).join(' ')}"`, false, kase.id, 'cloth'));
      }
      if (w) z.evidence.push(this.makeEvidence(z.id, `รอยเลือดบนพื้นมีรูปทรงตรงกับ${w.name}`, true, kase.id, 'weapon'));
    } else {
      z.evidence.push(this.makeEvidence(z.id, `รอยเลือดหยดเล็ก ๆ ที่ถูกเช็ดอย่างรีบร้อนใกล้จุดที่พบศพ`, true, kase.id, 'blood'));
      if (w) z.evidence.push(this.makeEvidence(z.id, `รอยเปื้อนจาง ๆ บนพื้นรูปทรงคล้าย${w.name}`, true, kase.id, 'weapon'));
    }
  }

  // ฆาตกรที่เกมเลือกแต่ไม่ได้ลงมือ → กลายเป็น "คนในเหตุการณ์": ได้ยินเสียงจากทางห้องที่เกิดเหตุ
  designatedHears(kase, killer) {
    if (this.phase !== PHASE.DAY || !this.designatedId) return;
    const d = this.players.get(this.designatedId);
    if (!d?.alive || d.id === killer.id || d.id === kase.victimId || d.zoneId === kase.zoneId) return;
    const w = kase.weapon;
    this.logTo(d, `👂 คุณได้ยินเสียง${w?.kind === 'poison' ? 'แก้วแตก' : /ปืน|ธนู/.test(w?.name || '') ? 'ดังปัง' : 'ของหนักกระแทกพื้น'}ดังมาจากทาง${this.zn(kase.zoneId)}— คุณที่เกมเลือกเป็นฆาตกรวันนี้ไม่ได้ลงมือ แต่กลายเป็นคนที่อยู่ในเหตุการณ์ไปแล้ว คิดดูว่าจะเล่าให้ใครฟังดี`, 'witness');
    kase.designatedHeard = true;
  }

  // คราฟกับดัก: ใช้ของ 2 ชิ้นตามสูตร ได้ "กับดักที่ประกอบแล้ว" 1 ชิ้น (ยังไม่ได้วาง)
  do_craft(p, a) {
    const r = RECIPES.find((x) => x.id === a.recipeId);
    const z = this.zones.get(p.zoneId);
    const ia = p.inventory.findIndex((i) => i.id === a.itemId);
    const ib = p.inventory.findIndex((i) => i.id === a.itemId2);
    if (!r || ia < 0 || ib < 0 || ia === ib) return this.logTo(p, 'ของสำหรับประกอบไม่ครบ', 'danger');
    const [first, second] = ia < ib ? [ib, ia] : [ia, ib];
    const itemB = p.inventory.splice(first, 1)[0];
    const itemA = p.inventory.splice(second, 1)[0];
    const [weaponPart, ropePart] = itemA.kind === r.needs[0] ? [itemA, itemB] : [itemB, itemA];
    const trap = {
      id: `trap_${nextId()}`,
      name: `${weaponPart.name}ผูก${ropePart.name}`,
      description: `${r.name} (${r.desc})`,
      kind: 'trap',
      trapType: r.trapType,
      weaponName: weaponPart.name,
      ingredients: [weaponPart.name, ropePart.name],
      portable: true,
      hidden: false,
      isPart: false,
      originZoneId: z.id,
    };
    p.inventory.push(trap);
    const who = this.who(p, z);
    this.logTo(p, `🛠 คุณประกอบ "${trap.name}" (${r.name}) เสร็จแล้ว — เลือก "วางกับดัก" ในห้องที่ต้องการเมื่อพร้อม${r.placeNeeds ? ` (วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]})` : ''} ถ้ามีคนตายเพราะมัน คุณคือคนร้าย`, 'culprit');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.4)) this.logTo(o, `👀 คุณเห็น${who}นั่งประกอบอะไรบางอย่างจาก${weaponPart.name}และ${ropePart.name}อยู่ตรงมุมห้อง${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ประกอบกับดัก "${trap.name}" ที่${this.zn(z)}`);
  }

  // วางกับดักที่ประกอบแล้วไว้ที่ทางเข้าห้องนี้
  do_trap(p, a) {
    const z = this.zones.get(p.zoneId);
    const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.kind === 'trap');
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    const who = this.who(p, z);
    if (chance(TRAP_FAIL_CHANCE)) {
      it.hidden = false;
      z.items.push(it);
      z.evidence.push(this.makeEvidence(z.id, `${it.name}วางเกะกะอยู่ใกล้ทางเข้า เหมือนมีคนพยายามติดตั้งอะไรบางอย่างแล้วไม่สำเร็จ`, false, null, 'trap'));
      this.logTo(p, `❌ คุณติดตั้ง${it.name}ไม่สำเร็จ เชือกหลุดและมันหล่นเกะกะให้เห็นอยู่ใน${this.zn(z)}`, 'danger');
    } else {
      z.traps.push({ setterId: p.id, item: it, turn: this.turn });
      this.logTo(p, `🪤 คุณตั้ง${it.name}ไว้ที่ทางเข้า${this.zn(z)}แล้ว (${TRAP_TYPES[it.trapType]?.label || ''}) คนต่อไปที่เข้ามาที่ไม่ใช่คุณมีโอกาสโดน — ถ้าเขาตาย คุณคือคนร้าย`, 'culprit');
    }
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.4)) this.logTo(o, `👀 คุณเห็น${who}ก้ม ๆ เงย ๆ ยุ่งอยู่กับ${it.name}ตรงทางเข้า${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}วางกับดัก (${it.name}) ที่${this.zn(z)}`);
  }

  // ผสมยาพิษลงในอาหารกลางห้อง
  do_poisonFood(p, a) {
    const z = this.zones.get(p.zoneId);
    const food = z.items.find((i) => i.kind === 'food');
    const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.kind === 'poison');
    if (!food || idx < 0) return this.logTo(p, 'ผสมยาไม่ได้ที่นี่', 'danger');
    if (food.poisoned) return this.logTo(p, `${food.name}มีคนผสมอะไรไว้ก่อนแล้ว คุณเลยไม่ได้ทำอะไร`, 'danger');
    const poison = p.inventory.splice(idx, 1)[0];
    food.poisoned = { setterId: p.id, poisonName: poison.name, turn: this.turn };
    z.evidence.push(this.makeEvidence(z.id, `ขอบภาชนะของ${food.name}มีคราบผงและกลิ่นเคมีจาง ๆ`, true, null, 'poison'));
    const who = this.who(p, z);
    this.logTo(p, `☠ คุณผสม${poison.name}ลงใน${food.name}ที่${this.zn(z)}แล้ว ใครมากินมีโอกาสตาย — ถ้าเขาตาย คุณคือคนร้าย (อย่าเผลอกินเอง)`, 'culprit');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.35)) this.logTo(o, `👀 คุณเห็น${who}ยืนบังอะไรบางอย่างอยู่หน้า${food.name}นานผิดปกติ`, 'witness');
    this.recordEvent(`${this.nick(p)}ผสม${poison.name}ลงใน${food.name}ที่${this.zn(z)}`);
  }

  // กินอาหารในห้อง (ทำภารกิจ "ไปกินอาหาร" / เสี่ยงโดนยาพิษ)
  do_eat(p) {
    const z = this.zones.get(p.zoneId);
    const food = z.items.find((i) => i.kind === 'food');
    if (!food) return this.logTo(p, 'ไม่มีอะไรให้กินที่นี่', 'danger');
    const who = this.who(p, z);
    if (food.poisoned && food.poisoned.setterId !== p.id) {
      const trait = this.traitOf(p);
      const notice = POISON_NOTICE[trait] ?? POISON_NOTICE.default;
      if (chance(notice)) {
        z.evidence.push(this.makeEvidence(z.id, `${food.name}ถูกคายทิ้งไว้ครึ่งคำ มีกลิ่นและรสขมผิดปกติ — มีคนผสมอะไรลงไป`, false, null, 'poison'));
        this.logTo(p, `🤢 คุณกัด${food.name}ไปคำเดียวแล้วรู้สึกถึงรสขมและกลิ่นเคมี คุณคายทิ้งทันที — มีคนผสมยาพิษไว้ในอาหารห้องนี้!`, 'danger');
        for (const o of this.witnessesOf(p, z)) this.logTo(o, `👀 ${this.nick(p)}คายอาหารทิ้งแล้วหน้าซีด บอกว่ามันมีรสแปลก ๆ`, 'witness');
        this.recordEvent(`${this.nick(p)}เกือบกินอาหารมีพิษที่${this.zn(z)}แต่รู้ทัน`);
        return;
      }
      const setter = this.players.get(food.poisoned.setterId) || null;
      const kase = this.killPlayer(p, { cause: 'trap', trapType: 'poison', killerId: setter?.id || null, weapon: { name: food.poisoned.poisonName, kind: 'poison' }, zoneId: z.id, messy: false, witnesses: [] });
      z.evidence.push(this.makeEvidence(z.id, fill(TRAP_TYPES.poison.evidence, food.poisoned.poisonName), false, kase.id, 'trap'));
      this.logTo(p, `💀 ${fill(TRAP_TYPES.poison.trigger, food.poisoned.poisonName)} คุณเสียชีวิตที่${this.zn(z)}... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
      for (const o of this.presentIn(z.id)) {
        o.knownBodies.add(p.id);
        this.bodies.get(p.id).discoveredBy.add(o.id);
        this.logTo(o, `😱 ${this.nick(p)}กิน${food.name}ไปได้ไม่กี่คำก็ล้มลงชักและเสียชีวิตต่อหน้าคุณ — อาหารในห้องนี้มีพิษ!`, 'witness');
      }
      if (setter?.alive) this.logTo(setter, `☠ ยาพิษที่คุณผสมใน${food.name}ที่${this.zn(z)}ทำงานแล้ว — ${this.nick(p)}ตาย คุณคือคนร้ายของคดีนี้`, 'culprit');
      food.poisoned = null; // อาหารชุดนั้นถูกทิ้ง/รู้แล้วว่ามีพิษ
      this.recordEvent(`${this.nick(p)}กินอาหารมีพิษ (${kase.weapon.name}) ของ${setter ? this.nick(setter) : '?'}ที่${this.zn(z)}และเสียชีวิต`);
      return;
    }
    this.logTo(p, `🍞 คุณกิน${food.name}และพักสักครู่ที่${this.zn(z)}${food.poisoned ? ' (คุณรู้ว่าต้องเลี่ยงส่วนไหน)' : ''}`, 'action');
    for (const o of this.witnessesOf(p, z)) if (chance(0.5)) this.logTo(o, `👀 คุณเห็น${who}นั่งกินอาหารอยู่ที่${this.zn(z)}`, 'witness');
    this.checkObjectivesAfterEat(p);
  }

  do_lock(p) {
    const z = this.zones.get(p.zoneId);
    if (!z.lockable || z.locked || !this.hasKeyFor(p, z.id)) return this.logTo(p, 'ล็อกห้องนี้ไม่ได้', 'danger');
    z.locked = true;
    this.logTo(p, `🔒 คุณล็อกประตู${this.zn(z)}แล้ว ชั่วโมงถัดไปคนที่ไม่มีกุญแจจะเข้าไม่ได้ (คนข้างในออกได้ แต่ถ้าคนออกไม่มีกุญแจ ประตูจะเปิดค้าง)`, 'action');
    for (const o of this.witnessesOf(p, z)) if (chance(0.8)) this.logTo(o, `👀 ${this.nick(p)}ล็อกประตู${this.zn(z)}จากข้างใน`, 'witness');
    this.recordEvent(`${this.nick(p)}ล็อก${this.zn(z)}`);
  }

  do_unlock(p) {
    const z = this.zones.get(p.zoneId);
    if (!z.locked || !this.hasKeyFor(p, z.id)) return this.logTo(p, 'ปลดล็อกไม่ได้', 'danger');
    z.locked = false;
    this.logTo(p, `🔓 คุณปลดล็อกประตู${this.zn(z)}แล้ว ใครก็เข้าได้`, 'action');
    for (const o of this.witnessesOf(p, z)) if (chance(0.8)) this.logTo(o, `👀 ${this.nick(p)}ปลดล็อกประตู${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ปลดล็อก${this.zn(z)}`);
  }

  do_clean(p) {
    const z = this.zones.get(p.zoneId);
    const vis = z.evidence.filter((e) => !e.hidden);
    if (!vis.length) return this.logTo(p, `คุณมองหาร่องรอยใน${this.zn(z)}แต่ไม่มีอะไรให้เก็บ`, 'action');
    const trait = this.traitOf(p);
    const pSucc = 0.5 + (trait === 'stealth' || trait === 'medical' ? 0.25 : 0);
    const r = Math.random();
    const who = this.who(p, z);
    if (r < pSucc) {
      for (const e of vis) e.hidden = true;
      this.logTo(p, `🧹 คุณเก็บกวาดร่องรอยใน${this.zn(z)}ได้เรียบร้อย (${vis.length} อย่าง) คนที่สำรวจละเอียดมากยังอาจเจอได้`, 'culprit');
    } else if (r < pSucc + 0.3) {
      for (const e of vis) if (chance(0.5)) e.hidden = true;
      z.evidence.push(this.makeEvidence(z.id, `ผ้าเปียกมีคราบจาง ๆ ยัดอยู่ในมุมห้อง`, true, null, 'clean'));
      z.evidence.push(this.makeEvidence(z.id, `พื้นบางส่วนถูกเช็ดเป็นทาง และมีกลิ่นน้ำยาทำความสะอาด`, false, null, 'clean'));
      this.logTo(p, `🧹 คุณเก็บกวาดได้ครึ่ง ๆ กลาง ๆ บางอย่างยังเห็นอยู่ และรอยเช็ดของคุณเองก็กลายเป็นร่องรอยใหม่`, 'danger');
    } else {
      z.evidence.push(this.makeEvidence(z.id, `มีร่องรอยว่าใครบางคนพยายามเช็ดคราบแต่กลับยิ่งเลอะ`, false, null, 'clean'));
      this.logTo(p, `❌ คุณพยายามเก็บกวาดแต่ยิ่งทำยิ่งเลอะ ร่องรอยยังอยู่และเพิ่มขึ้นอีก`, 'danger');
    }
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.6)) this.logTo(o, `👀 คุณเห็น${who}ขัดถูพื้นและเก็บของใน${this.zn(z)}อย่างเร่งรีบ`, 'witness');
    this.recordEvent(`${this.nick(p)}พยายามทำลายหลักฐานที่${this.zn(z)}`);
  }

  do_moveBody(p, a) {
    const b = this.bodies.get(a.victimId);
    const from = this.zones.get(p.zoneId);
    const to = this.zones.get(a.toZoneId);
    if (!b || b.judged || b.zoneId !== from.id || !to) return this.logTo(p, 'ศพไม่ได้อยู่ตรงนี้แล้ว', 'danger');
    if (to.locked && !this.hasKeyFor(p, to.id)) return this.logTo(p, `คุณลากศพไปถึง${this.zn(to)}แต่ประตูล็อกอยู่ จึงต้องลากกลับมาที่เดิม`, 'danger');
    const v = this.players.get(b.victimId);
    b.zoneId = to.id;
    b.moved = true;
    const kase = this.caseOf(b.caseId);
    if (kase) kase.moved = true;
    from.evidence.push(this.makeEvidence(from.id, `รอยลากบนพื้นจากกลางห้องออกไปทางประตู`, false, b.caseId, 'drag'));
    to.evidence.push(this.makeEvidence(to.id, `รอยลากบนพื้นจากประตูเข้ามาถึงจุดที่ศพอยู่ ศพถูกย้ายมาจากที่อื่น`, false, b.caseId, 'drag'));
    if (chance(0.5)) p.stained = this.turn;
    const who = this.who(p, from);
    this.logTo(p, `🚚 คุณลากศพของ${this.nick(v)}จาก${this.zn(from)}ไปไว้ที่${this.zn(to)}ทิ้งรอยลากไว้ทั้งสองห้อง${p.stained === this.turn ? ' และเสื้อผ้าคุณเปื้อน' : ''}`, 'culprit');
    for (const o of this.witnessesOf(p, from)) if (chance(0.8)) this.logTo(o, `👀 คุณเห็น${who}ลากร่างของ${this.nick(v)}ออกไปจาก${this.zn(from)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ย้ายศพของ${this.nick(v)}จาก${this.zn(from)}ไป${this.zn(to)}`);
  }

  do_take(p, a) {
    const z = this.zones.get(p.zoneId);
    const idx = z.items.findIndex((i) => i.id === a.itemId && !i.hidden);
    if (idx < 0) return this.logTo(p, `ของที่คุณจะหยิบหายไปแล้ว — มีคนเอาไปก่อน`, 'danger');
    if (p.inventory.length >= CONFIG.INVENTORY_MAX) return this.logTo(p, `คุณถือของเต็มมือแล้ว`, 'danger');
    const it = z.items.splice(idx, 1)[0];
    p.inventory.push(it);
    const who = this.who(p, z);
    this.logTo(p, `🖐 คุณหยิบ${it.name}${it.isPart ? ' ⭐' : ''}มาไว้กับตัว${it.kind === 'key' && it.unlocksZoneId ? ` — ใช้ล็อก/ปลดล็อก${this.zoneName(it.unlocksZoneId)}ได้` : it.kind === 'key' && it.master ? ' — ไขประตูห้องได้ทุกห้อง' : ''}`, it.isPart ? 'escape' : 'action');
    onObtainItem(this, p, it);
    this.recordEvent(`${this.nick(p)}หยิบ${it.name}จาก${this.zn(z)}`);
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.5)) this.logTo(o, `👀 คุณเห็น${who}หยิบ${it.name}ติดตัวไป`, 'witness');
    this.checkObjectivesAfterTake(p, it);
  }

  placeItem(p, a, hidden) {
    const z = this.zones.get(p.zoneId);
    const idx = p.inventory.findIndex((i) => i.id === a.itemId);
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    it.hidden = hidden;
    z.items.push(it);
    const who = this.who(p, z);
    this.logTo(p, hidden ? `🫥 คุณซ่อน${it.name}ไว้ใน${this.zn(z)}คนอื่นต้องสำรวจละเอียดถึงจะเจอ` : `⬇ คุณวาง${it.name}ไว้ใน${this.zn(z)}`, 'action');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, hidden ? 0.3 : 0.5)) this.logTo(o, `👀 คุณเห็น${who}${hidden ? 'แอบซุก' : 'วาง'}${it.name}ไว้ใน${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}${hidden ? 'ซ่อน' : 'วาง'}${it.name}ไว้ที่${this.zn(z)}`);
    this.checkObjectivesAfterPlace(p, it, z.id);
  }

  do_hide(p, a) {
    this.placeItem(p, a, true);
  }

  do_drop(p, a) {
    this.placeItem(p, a, false);
  }

  do_search(p) {
    const z = this.zones.get(p.zoneId);
    const det = this.traitOf(p) === 'detective';
    const bonus = det ? ESCAPE.DETECTIVE_SEARCH_BONUS : 0;
    const lines = [];
    const foundItems = [];
    for (const it of z.items.filter((i) => i.hidden)) {
      if (chance((it.isPart || it.kind === 'clue' ? CONFIG.FIND_ROUTE_ITEM_CHANCE : CONFIG.FIND_HIDDEN_CHANCE) + bonus)) {
        it.hidden = false;
        foundItems.push(it);
      }
    }
    for (const it of foundItems) {
      if ((it.isPart || it.kind === 'clue') && p.inventory.length < CONFIG.INVENTORY_MAX) {
        z.items.splice(z.items.indexOf(it), 1);
        p.inventory.push(it);
        lines.push(`${it.kind === 'clue' ? '🗺' : '⭐'} คุณเจอ${it.name}ซ่อนอยู่! คุณเก็บมันไว้กับตัวแล้ว`);
        onObtainItem(this, p, it);
        this.recordEvent(`${this.nick(p)}ค้นเจอ${it.name}ที่${this.zn(z)}`);
      } else {
        lines.push(`🔍 คุณเจอ${it.name}${it.isPart ? ' ⭐' : ''}ซ่อนอยู่ในห้องนี้ (ตอนนี้มันวางให้เห็นแล้ว${it.isPart || it.kind === 'clue' ? ' คุณถือของเต็มมือจึงยังไม่ได้หยิบ' : ''})`);
      }
    }
    const exitsFound = tryFindExit(this, p, z, det ? ESCAPE.FIND_EXIT_DETECTIVE_BONUS : 0);
    if (exitsFound.length) lines.push(`🚪 ค้นพบทางออกที่ซ่อนอยู่: ${exitsFound.map((x) => x.name).join(', ')} (รายละเอียดอยู่ในบันทึกอีกบรรทัด)`);
    const newEv = z.evidence.filter((e) => !p.evidence.includes(e.id) && (!e.hidden || chance(CONFIG.FIND_HIDDEN_CHANCE + bonus)));
    for (const e of newEv) {
      p.evidence.push(e.id);
      lines.push(`🧩 หลักฐาน: ${e.text}`);
    }
    const orig = (this.location.zones.find((zz) => zz.id === z.id)?.items || []).filter((i) => i.portable);
    const missing = orig.filter((oi) => !z.items.some((i) => i.id === oi.id) && !p.inventory.some((i) => i.id === oi.id));
    if (missing.length) lines.push(`❓ ของที่ควรอยู่ในห้องนี้แต่หายไป: ${missing.map((i) => i.name).join(', ')}`);
    const trap = z.traps.find((t) => t.setterId !== p.id);
    if (trap && chance(0.3 + bonus)) lines.push(`⚠ คุณสังเกตเห็นว่า${trap.item.name}ถูกติดตั้งไว้ที่ทางเข้าอย่างผิดปกติ เหมือนเป็นกับดัก (คุณไม่ได้แตะต้องมัน)`);
    const food = z.items.find((i) => i.kind === 'food');
    if (food?.poisoned && food.poisoned.setterId !== p.id && chance((det ? 0.6 : 0.25) + (this.traitOf(p) === 'medical' ? 0.35 : 0))) lines.push(`☠ ${food.name}มีกลิ่นเคมีจาง ๆ และคราบผงที่ขอบภาชนะ — อย่ากินอะไรในห้องนี้`);
    if (!lines.length) lines.push('ไม่พบอะไรผิดปกติในห้องนี้');
    this.logTo(p, `🔍 สำรวจ${this.zn(z)}: ${lines.join(' · ')}`, 'evidence');
    if (p.zoneMemory[z.id]) p.zoneMemory[z.id].searched = this.turn;
  }

  do_examine(p, a) {
    const b = this.bodies.get(a.victimId);
    if (!b || b.judged || b.zoneId !== p.zoneId) return this.logTo(p, 'ศพไม่ได้อยู่ตรงนี้แล้ว', 'danger');
    const kase = this.caseOf(b.caseId);
    const v = this.players.get(b.victimId);
    b.examinedBy.add(p.id);
    const med = this.traitOf(p) === 'medical';
    const w = kase.weapon;
    let text;
    if (kase.cause === 'trap') {
      const tt = TRAP_TYPES[kase.trapType] || TRAP_TYPES.fall;
      text = med ? `${fill(tt.body, w?.name)} — เป็นกับดักที่เตรียมไว้ล่วงหน้า ไม่มีคนลงมือโดยตรง` : kase.trapType === 'poison' ? 'ริมฝีปากเขียวคล้ำ ไม่มีบาดแผล มีเศษอาหารติดมุมปาก' : kase.trapType === 'shock' ? 'ฝ่ามือไหม้เกรียม ไม่มีบาดแผลอื่น' : `แผล${kase.trapType === 'blade' ? 'ลึกที่ลำคอ' : 'แตกที่ศีรษะ'} เหมือนโดน${w?.name || 'ของหนัก'}`;
    } else if (w?.kind === 'poison') text = med ? `อาการตรงกับพิษจาก${w.name} ถูกวางยาโดยตรง` : 'ริมฝีปากเขียวคล้ำ ไม่มีบาดแผล น่าจะเป็นพิษอะไรสักอย่าง';
    else if (kase.cause === 'defense') text = med ? 'รอยช้ำหลายแห่งและแผลที่ท้ายทอยจากการต่อสู้ ข้อนิ้วถลอก — เขาเป็นฝ่ายเปิดฉากต่อสู้ก่อนแล้วแพ้' : 'รอยช้ำเต็มตัว เหมือนผ่านการต่อสู้อย่างหนัก';
    else if (w) text = med ? `บาดแผลตรงกับ${w.name}แน่นอน ลงมือ${kase.messy ? 'แบบรีบร้อน มีแผลหลายจุด' : 'ครั้งเดียวแม่นยำ'}` : `บาดแผล${/มีด|กรรไกร|ขวาน|แหลม|ผ่าตัด|ตัดเนื้อ/.test(w.name) ? 'จากของมีคม' : /ปืน|ธนู|ฉมวก/.test(w.name) ? 'ทะลุจากกระสุนหรือของแหลม' : w.kind === 'rope' || w.kind === 'cloth' || /เชือก|ม่าน|ผ้า|สายไฟ/.test(w.name) ? 'รอยรัดรอบคอ' : 'จากของหนักทื่อ'}`;
    else text = med ? 'รอยช้ำที่ลำคอและท้ายทอยจากมือเปล่า คนลงมือต้องแข็งแรงพอสมควร' : 'รอยช้ำที่คอ ไม่เห็นอาวุธ';
    const ago = this.turn - b.turn;
    const time = med ? `ตายมาแล้วราว ${Math.max(1, ago)} ชั่วโมง (วันที่ ${b.day} ชั่วโมงที่ ${b.hour})` : ago <= 1 ? 'ร่างยังอุ่น ตายไม่นาน' : ago <= 3 ? 'ร่างเริ่มเย็น ตายมาหลายชั่วโมงแล้ว' : 'ร่างเย็นและแข็งแล้ว ตายมานานมาก';
    const moved = b.moved ? (med ? 'รอยเลือดตกค้างไม่ตรงกับท่าศพ — ศพถูกย้ายมาแน่นอน' : 'ท่าทางศพดูไม่เป็นธรรมชาติ') : med ? 'ศพไม่ได้ถูกย้าย ตายตรงนี้' : '';
    this.logTo(p, `🔎 ตรวจศพ${this.nick(v)}ที่${this.zn(b.zoneId)}: ${text} · ${time}${moved ? ` · ${moved}` : ''}`, 'evidence');
    this.recordEvent(`${this.nick(p)}ตรวจศพของ${this.nick(v)}`);
  }

  do_steal(p, a) {
    const t = this.players.get(a.targetId);
    const z = this.zones.get(p.zoneId);
    if (!t?.alive || t.zoneId !== z.id) return this.logTo(p, 'เป้าหมายไม่อยู่แล้ว', 'danger');
    if (!t.inventory.length) return this.logTo(p, `🕵 คุณล้วงกระเป๋า${this.nick(t)} แต่เขาไม่ได้พกอะไรเลย`, 'action');
    if (p.inventory.length >= CONFIG.INVENTORY_MAX) return this.logTo(p, 'คุณถือของเต็มมือ ล้วงมาก็เก็บไม่ได้', 'danger');
    if (chance(0.7)) {
      const it = t.inventory.splice(Math.floor(Math.random() * t.inventory.length), 1)[0];
      p.inventory.push(it);
      this.logTo(p, `🕵 คุณล้วง${it.name}${it.isPart ? ' ⭐' : ''}มาจาก${this.nick(t)}ได้โดยที่เขาไม่รู้ตัว`, 'culprit');
      onObtainItem(this, p, it);
      this.recordEvent(`${this.nick(p)}ขโมย${it.name}จาก${this.nick(t)}`);
      this.checkObjectivesAfterTake(p, it);
    } else {
      this.logTo(p, `❌ คุณพยายามล้วงกระเป๋า${this.nick(t)} แต่เขารู้ตัวและปัดมือคุณออก`, 'danger');
      this.logTo(t, `⚠ ${this.who(p, z)}พยายามล้วงกระเป๋าคุณที่${this.zn(z)}!`, 'danger');
    }
  }

  do_interrogate(p, a) {
    const t = this.players.get(a.targetId);
    const z = this.zones.get(p.zoneId);
    if (!t?.alive || t.zoneId !== z.id) return this.logTo(p, 'เป้าหมายไม่อยู่แล้ว', 'danger');
    const facts = [];
    const prev = [...this.timeline].reverse().find((tl) => tl.turn < this.turn);
    if (prev?.positions[t.id]) facts.push(`ชั่วโมงก่อน (วันที่ ${prev.day} ชั่วโมงที่ ${prev.hour}) ${this.nick(t)}อยู่ที่${this.zn(prev.positions[t.id])}`);
    if (t.inventory.length) facts.push(`${this.nick(t)}พก${pick(t.inventory).name}อยู่กับตัว`);
    const obj = t.objectives.find((o) => !o.done);
    if (obj) facts.push(`ภารกิจลับของ${this.nick(t)}ตอนนี้คือ "${obj.text}"`);
    if (t.knownBodies.size) facts.push(`${this.nick(t)}รู้ว่า${this.nick(this.players.get([...t.knownBodies][0]))}ตายแล้ว`);
    const knownExits = [...this.exits.values()].filter((x) => knowsExit(t, x));
    if (knownExits.length) facts.push(`${this.nick(t)}รู้ว่าทางออก "${knownExits[0].name}" อยู่ที่${this.zn(knownExits[0].zoneId)}`);
    if (t.kills) facts.push(`${this.nick(t)}หลบตาและเหงื่อแตกเมื่อคุณพูดถึง "คนตาย" — เขาปิดบังเรื่องใหญ่อยู่`);
    const fact = facts.length ? pick(facts) : `${this.nick(t)}ไม่ได้ปิดบังอะไรเป็นพิเศษ`;
    this.logTo(p, `🗣 คุณคุยซักไซ้${this.nick(t)}และอ่านท่าทางเขาออก: ${fact}`, 'evidence');
    this.logTo(t, `🗣 ${this.nick(p)}เข้ามาคุยและซักไซ้คุณนานผิดปกติที่${this.zn(z)}เหมือนพยายามล้วงอะไรบางอย่าง`, 'witness');
    this.recordEvent(`${this.nick(p)}ซักถาม${this.nick(t)}ที่${this.zn(z)}`);
  }

  do_sabotage(p) {
    const z = this.zones.get(p.zoneId);
    const power = z.items.find((i) => i.kind === 'power');
    z.dark = true;
    z.evidence.push(this.makeEvidence(z.id, `${power?.name || 'แผงไฟ'}ถูกสับ/ปิดด้วยมือคน ไม่ใช่ไฟตก`, false, null, 'power'));
    this.logTo(p, `⚡ คุณจัดการ${power?.name || 'แผงไฟ'} ไฟและกล้องใน${this.zn(z)}ดับสนิท ชั่วโมงนี้ใครทำอะไรในห้องนี้ จะไม่มีใครเห็นหน้า`, 'culprit');
    for (const o of this.witnessesOf(p, z)) this.logTo(o, `💡 ไฟใน${this.zn(z)}ดับวูบลง มองเห็นแค่เงา ๆ ของคนในห้อง`, 'witness');
    this.recordEvent(`${this.nick(p)}ตัดไฟที่${this.zn(z)}`);
  }

  do_exit(p, a, exitAttempts) {
    exitAttempts.push({ p, a });
  }

  do_exit_power(p, a) {
    doExitPower(this, p, a);
  }

  do_rest() {}

  // คนที่เลือก "สังเกต" มีโอกาสเห็นว่าใครในห้องทำอะไรลับ ๆ ล่อ ๆ
  resolveRest() {
    const shady = new Set(['attack', 'trap', 'poisonFood', 'craft', 'clean', 'moveBody', 'hide', 'steal', 'sabotage']);
    for (const [pid, a] of this.actions) {
      if (a.type !== 'rest') continue;
      const p = this.players.get(pid);
      if (!p?.alive) continue;
      const z = this.zones.get(p.zoneId);
      for (const o of this.witnessesOf(p, z)) {
        const oa = this.actions.get(o.id);
        if (oa && shady.has(oa.type) && chance(this.traitOf(o) === 'stealth' ? 0.25 : 0.5)) this.logTo(p, `👁 คุณสังเกตว่า${this.who(o, z)}ทำอะไรลับ ๆ ล่อ ๆ อยู่ตรงมุมห้อง${this.zn(z)}เหมือนไม่อยากให้ใครเห็น`, 'witness');
      }
      this.logTo(p, `😶 คุณอยู่เฉย ๆ ที่${this.zn(z)}และสังเกตคนรอบตัว`, 'action');
    }
  }

  // ---------- give (ช่วงพักหลังจบชั่วโมง) ----------
  giveItem(playerId, targetId, itemId) {
    this.assertPhase(PHASE.DAY);
    this.assertStep(STEP.REPORT);
    const p = this.alivePlayer(playerId);
    const t = this.players.get(targetId);
    if (!t || !t.alive || t.id === p.id) throw new GameError('เลือกผู้รับไม่ถูกต้อง');
    if (t.zoneId !== p.zoneId) throw new GameError('ให้ของได้เฉพาะคนที่อยู่ห้องเดียวกันตอนนี้');
    const idx = p.inventory.findIndex((i) => i.id === itemId);
    if (idx < 0) throw new GameError('คุณไม่มีของชิ้นนี้');
    if (t.inventory.length >= CONFIG.INVENTORY_MAX) throw new GameError(`${this.nick(t)}ถือของเต็มมือแล้ว`);
    const it = p.inventory.splice(idx, 1)[0];
    t.inventory.push(it);
    const z = this.zones.get(p.zoneId);
    this.logTo(p, `🎁 คุณให้${it.name}${it.isPart ? ' ⭐' : ''}แก่${this.nick(t)}`, 'action');
    this.logTo(t, `🎁 ${this.nick(p)}ให้${it.name}${it.isPart ? ' ⭐' : ''}แก่คุณ`, 'action');
    onObtainItem(this, t, it);
    for (const o of this.presentIn(z.id)) if (o.id !== p.id && o.id !== t.id) this.logTo(o, `👀 คุณเห็น${this.nick(p)}ยื่น${chance(0.5) ? it.name : 'อะไรบางอย่าง'}ให้${this.nick(t)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ให้${it.name}แก่${this.nick(t)}ที่${this.zn(z)}`);
    this.checkObjectivesAfterTake(t, it);
    this.emit();
  }

  // ---------- objectives ----------
  checkObjectivesAfterMove(p) {
    for (const o of p.objectives) {
      if (o.done) continue;
      if (o.type === 'visit' && o.zoneId === p.zoneId) this.completeObjective(p, o);
      if (o.type === 'visit2' && o.zoneIds.includes(p.zoneId) && !o.visited.includes(p.zoneId)) {
        o.visited.push(p.zoneId);
        if (o.visited.length >= o.zoneIds.length) this.completeObjective(p, o);
        else this.logTo(p, `📋 ภารกิจคืบหน้า: ถึง${this.zn(p.zoneId)}แล้ว เหลืออีกห้อง (${this.zoneName(o.zoneIds.find((id) => !o.visited.includes(id)))})`, 'objective');
      }
      if (o.type === 'meet') {
        const t = this.players.get(o.targetId);
        if (t?.alive && t.zoneId === p.zoneId) this.completeObjective(p, o);
      }
    }
  }

  checkObjectivesAfterEat(p) {
    for (const o of p.objectives) if (!o.done && o.type === 'visit_eat' && o.zoneId === p.zoneId) this.completeObjective(p, o);
  }

  checkObjectivesAfterTake(p, it) {
    for (const o of p.objectives) if (!o.done && o.type === 'take' && o.itemId === it.id) this.completeObjective(p, o);
  }

  checkObjectivesAfterPlace(p, it, zoneId) {
    for (const o of p.objectives) if (!o.done && o.type === 'plant' && o.itemId === it.id && o.zoneId === zoneId) this.completeObjective(p, o);
  }

  completeObjective(p, o) {
    o.done = true;
    o.doneTurn = this.turn;
    const wait = Math.max(0, o.deadlineTurn - this.turn);
    this.logTo(p, `✅ ภารกิจสำเร็จ: ${o.text}${wait ? ` — ภารกิจถัดไปจะมาในอีก ${wait} ชั่วโมง` : ''}`, 'objective');
  }

  // ---------- investigation / trial ----------
  async startInvestigation() {
    this.phase = PHASE.INVESTIGATION;
    this.step = null;
    this.clearTimers();
    this.hour++;
    this.turn++;
    this.generating = 'มีคนพบศพ! กำลังประกาศ...';
    const newly = [...this.bodies.values()].filter((b) => !b.judged && !b.announced && b.discoveredBy.size >= 1);
    for (const b of newly) {
      b.announced = true;
      const c = this.caseOf(b.caseId);
      if (c) c.announced = true;
    }
    for (const z of this.zones.values()) z.dark = false;
    for (const p of this.players.values()) {
      p.zoneMemory = {};
      p.forced = null;
    }
    this.emit();
    await this.narrateCases();
    this.announcement = { day: this.day, hour: this.hour, turn: this.turn, caseIds: newly.map((b) => b.caseId) };
    const names = newly.map((b) => `${this.nick(this.players.get(b.victimId))} (ที่${this.zoneName(b.zoneId)})`).join(', ');
    this.systemMessage(`🔔 ประกาศพบศพ! ${names} — ${this.timeLabel()}: รอบเก็บหลักฐาน ของในห้องถูกจัดใหม่ ทุกคนเลือกห้องที่จะไปสำรวจ 1 ห้องและทำได้ 1 อย่าง ก่อนเข้าสู่การตัดสิน (ภารกิจพักไว้ก่อน)`);
    this.generating = null;
    this.step = STEP.MOVE;
    this.moves = new Map();
    this.actions = new Map();
    this.emit();
    this.armStepTimer();
    this.scheduleBots();
  }

  async narrateCases() {
    for (const c of this.cases) {
      if (!c.announced || c.narrative) continue;
      const victim = this.charOf(this.players.get(c.victimId));
      const killer = c.killerId ? this.charOf(this.players.get(c.killerId)) : null;
      const body = this.bodies.get(c.victimId);
      c.narrative = await this.ai.narrateCase({
        location: this.location,
        victim,
        killer,
        cause: c.cause,
        trapType: c.trapType,
        weapon: c.weapon,
        zone: this.zones.get(c.zoneId),
        discoveredZone: this.zones.get(body?.zoneId || c.zoneId),
        day: c.day,
        hour: c.hour,
        messy: c.messy,
        moved: c.moved,
        witnesses: c.witnesses.map((id) => this.nick(this.players.get(id))),
      });
    }
  }

  async beginTrial() {
    this.phase = PHASE.TRIAL;
    this.step = null;
    this.clearTimers();
    // ศพที่เพิ่งถูกพบระหว่างเก็บหลักฐานก็เข้าสู่การตัดสินด้วย
    const extra = [...this.bodies.values()].filter((b) => !b.judged && !b.announced && b.discoveredBy.size >= 1);
    if (extra.length) {
      this.generating = 'พบศพเพิ่ม...';
      this.emit();
      for (const b of extra) {
        b.announced = true;
        const c = this.caseOf(b.caseId);
        if (c) c.announced = true;
      }
      await this.narrateCases();
      this.systemMessage(`🔔 พบศพเพิ่มระหว่างเก็บหลักฐาน: ${extra.map((b) => this.nick(this.players.get(b.victimId))).join(', ')}`);
      this.generating = null;
    }
    this.votes = new Map();
    this.confirmedVotes = new Set();
    this.runoff = null;
    this.runoffCount = 0;
    this.systemMessage('⚖ การตัดสินเริ่มขึ้น! เล่าหลักฐานที่แต่ละคนเจอในแชท แล้วโหวต "คนร้าย" — หรือ "ไม่มีคนร้ายให้ลงโทษ" ถ้าเชื่อว่าคนร้ายตายไปแล้ว · โหวตถูก: คนนั้นถูกประหาร · โหวตผิด: ทุกคนตาย คนร้ายรอด เกมจบ');
    this.emit();
    this.scheduleBots();
  }

  voteCandidates(voterId) {
    const ids = this.runoff ? this.runoff.candidates : [...this.alivePlayers().map((p) => p.id), NONE_VOTE];
    return ids.filter((id) => id !== voterId);
  }

  castVote(playerId, targetId) {
    this.assertPhase(PHASE.TRIAL);
    this.alivePlayer(playerId);
    if (this.confirmedVotes.has(playerId)) throw new GameError('คุณยืนยันโหวตไปแล้ว');
    if (!this.voteCandidates(playerId).includes(targetId)) throw new GameError(this.runoff ? 'รอบตัดสินโหวตได้เฉพาะตัวเลือกที่คะแนนเสมอกัน' : 'โหวตไม่ถูกต้อง');
    this.votes.set(playerId, targetId);
    this.emit();
  }

  confirmVote(playerId) {
    this.assertPhase(PHASE.TRIAL);
    this.alivePlayer(playerId);
    if (!this.votes.has(playerId)) throw new GameError('เลือกก่อนยืนยัน');
    this.confirmedVotes.add(playerId);
    this.emit();
    if (this.alivePlayers().every((p) => this.confirmedVotes.has(p.id))) this.resolveTrial();
  }

  forceVote(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.TRIAL);
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

  openCases() {
    return this.cases.filter((c) => c.announced && !c.judged);
  }

  resolveTrial() {
    const tally = this.tallyVotes();
    const top = tally[0]?.count || 0;
    const tied = tally.filter((t) => t.count === top);
    const tie = tied.length > 1;
    if (tie && this.runoffCount < CONFIG.MAX_RUNOFFS) {
      this.runoffCount++;
      this.runoff = { number: this.runoffCount, candidates: tied.map((t) => t.targetId), previousTally: tally };
      this.votes = new Map();
      this.confirmedVotes = new Set();
      const names = this.runoff.candidates.map((id) => (id === NONE_VOTE ? '"ไม่มีคนร้ายให้ลงโทษ"' : this.nick(this.players.get(id)))).join(', ');
      this.systemMessage(`คะแนนเสมอกัน! โหวตรอบตัดสินครั้งที่ ${this.runoffCount} ระหว่าง ${names}`);
      this.emit();
      this.scheduleBots();
      return;
    }
    const randomTiebreak = tie;
    const votedId = tied.length ? pick(tied).targetId : NONE_VOTE;
    const open = this.openCases();
    // คดีฆาตกรรมที่คนร้ายยังมีชีวิต (คดีที่คนร้ายตายไปแล้ว ไม่มีใครให้โหวต → ปิดไปพร้อมกัน)
    const murders = open.filter((c) => c.killerId && this.players.get(c.killerId)?.alive);
    const correct = votedId === NONE_VOTE ? murders.length === 0 : murders.some((c) => c.killerId === votedId);
    const executed = [];
    const punished = [];
    const escaped = [];
    if (correct) {
      if (votedId !== NONE_VOTE) {
        const k = this.players.get(votedId);
        k.alive = false;
        k.fate = 'executed';
        k.deathCause = 'executed';
        k.eliminatedDay = this.day;
        k.eliminatedHour = this.hour;
        executed.push(k.id);
        const sleep = this.zones.get(this.location.sleepZoneId);
        for (const it of k.inventory) {
          it.hidden = false;
          sleep.items.push(it);
        }
        k.inventory = [];
        this.charOf(k).ultimateRevealed = true;
        for (const c of murders) if (c.killerId === k.id) c.judged = true;
      }
      for (const c of open) if (!c.killerId || !this.players.get(c.killerId)?.alive) c.judged = true;
    } else {
      for (const c of murders) {
        const k = this.players.get(c.killerId);
        if (k.alive) {
          k.alive = false;
          k.fate = 'escaped';
          escaped.push(k.id);
          this.charOf(k).ultimateRevealed = true;
        }
        c.judged = true;
      }
      for (const p of this.alivePlayers()) {
        p.alive = false;
        p.fate = 'punished';
        p.deathCause = 'punished';
        p.eliminatedDay = this.day;
        p.eliminatedHour = this.hour;
        punished.push(p.id);
      }
      for (const c of open) c.judged = true;
    }
    for (const b of this.bodies.values()) {
      const c = this.caseOf(b.caseId);
      if (c?.judged) {
        b.judged = true;
        const vc = this.charOf(this.players.get(b.victimId));
        if (vc) vc.ultimateRevealed = true;
      }
    }
    this.clearTimers();
    const judgedNow = open.filter((c) => c.judged);
    this.lastResult = {
      day: this.day,
      hour: this.hour,
      turn: this.turn,
      tally,
      votedId,
      tie,
      randomTiebreak,
      runoffs: this.runoffCount,
      correct,
      executedId: executed[0] || null,
      punished,
      escaped,
      cases: judgedNow.map((c) => this.caseReveal(c)),
      stillOpen: open.filter((c) => !c.judged).map((c) => this.nick(this.players.get(c.victimId))),
      timeline: this.timelineSince(this.lastTrialTurn + 1),
      bodyThreshold: this.bodyThreshold(),
    };
    this.history.push({
      day: this.day,
      hour: this.hour,
      victims: judgedNow.map((c) => this.nick(this.players.get(c.victimId))),
      culprits: judgedNow.filter((c) => c.killerId).map((c) => this.nick(this.players.get(c.killerId))),
      votedName: votedId === NONE_VOTE ? 'ไม่มีคนร้ายให้ลงโทษ' : this.nick(this.players.get(votedId)),
      correct,
    });
    this.lastTrialTurn = this.turn;
    this.runoff = null;
    if (correct) {
      this.systemMessage(
        votedId === NONE_VOTE
          ? judgedNow.some((c) => c.killerId)
            ? `โหวตถูกต้อง! คนร้ายของคดีนี้ตายไปก่อนแล้ว จึงไม่มีใครให้ลงโทษ`
            : `โหวตถูกต้อง! ไม่มีคนร้ายในคดีนี้ — ไม่มีใครถูกประหาร`
          : `โหวตถูกต้อง! คนร้ายคือ ${this.nick(this.players.get(votedId))} (${this.players.get(votedId).name}) และถูกประหาร`,
      );
      this.phase = PHASE.TRIAL_RESULT;
      this.emit();
    } else {
      this.systemMessage(`โหวตผิด! ${escaped.length ? `คนร้ายตัวจริงคือ ${escaped.map((id) => this.nick(this.players.get(id))).join(', ')} และรอดไปได้` : 'คดีนี้ไม่มีคนร้ายให้ลงโทษ'} — ทุกคนที่เหลือถูกประหาร เกมจบ`);
      this.endGame('wrong_vote');
    }
  }

  caseReveal(c) {
    const v = this.players.get(c.victimId);
    const k = c.killerId ? this.players.get(c.killerId) : null;
    const d = c.designatedId ? this.players.get(c.designatedId) : null;
    return {
      id: c.id,
      day: c.day,
      hour: c.hour,
      victimName: this.charOf(v)?.name || v.name,
      victimPlayer: v.name,
      killerName: k ? this.charOf(k)?.name || k.name : null,
      killerPlayer: k?.name || null,
      killerUltimate: k ? this.charOf(k)?.ultimate?.title || null : null,
      killerFakeUltimate: k && this.charOf(k)?.fakeRole ? this.charOf(k).fakeUltimate?.title || null : null,
      killerAlive: !!k?.alive,
      cause: c.cause,
      causeLabel: CAUSE_LABEL[c.cause] || c.cause,
      trapLabel: c.trapType ? TRAP_TYPES[c.trapType]?.label || null : null,
      weaponName: c.weapon?.name || null,
      zoneName: this.zoneName(c.zoneId),
      messy: c.messy,
      moved: c.moved,
      witnesses: c.witnesses.map((id) => this.nick(this.players.get(id))),
      present: c.present.filter((id) => id !== c.killerId && id !== c.victimId).map((id) => this.nick(this.players.get(id))),
      designatedName: d ? this.nick(d) : null,
      designatedHeard: !!c.designatedHeard,
      title: c.narrative?.title || '',
      truthSummary: c.narrative?.truthSummary || '',
    };
  }

  timelineSince(turn) {
    return this.timeline
      .filter((t) => t.turn >= turn)
      .map((t) => ({
        day: t.day,
        hour: t.hour,
        phase: t.phase,
        positions: Object.entries(t.positions).map(([pid, zid]) => {
          const p = this.players.get(pid);
          return { playerName: p?.name || pid, characterName: this.charOf(p)?.nickname || '?', zoneName: this.zoneName(zid) };
        }),
        events: t.events,
      }));
  }

  async nextRound(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.TRIAL_RESULT);
    this.phase = PHASE.GENERATING;
    this.generating = 'กำลังเตรียมวันใหม่...';
    this.emit();
    try {
      await this.maybeRevive();
      this.nextDay();
    } catch (err) {
      this.fail(err);
    }
  }

  markReady(playerId) {
    this.assertPhase(PHASE.DAY);
    this.assertStep(STEP.REPORT);
    this.alivePlayer(playerId);
    this.ready.add(playerId);
    this.emit();
    if (this.alivePlayers().every((p) => this.ready.has(p.id))) this.nextTurn();
  }

  forceStep(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    if (!this.step) throw new GameError('กำลังประมวลผลอยู่');
    this.systemMessage('หัวห้องสั่งไปต่อ — คนที่ยังไม่เลือกจะถูกเลือกให้อัตโนมัติ');
    if (this.step === STEP.MOVE) this.resolveMoves();
    else if (this.step === STEP.ACT) this.resolveActions();
    else this.nextTurn();
  }

  // จบชั่วโมง → ชั่วโมงถัดไปในวันเดิม
  nextTurn() {
    if (this.phase === PHASE.ENDED) return;
    if (this.alivePlayers().length <= 1) return this.endGame('last_one');
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    for (const p of this.players.values()) if (p.stained !== null && p.stained < this.turn - 1) p.stained = null;
    this.beginTurn();
  }

  // หลังตัดสิน → วันใหม่
  nextDay() {
    if (this.phase === PHASE.ENDED) return;
    if (this.alivePlayers().length <= 1) return this.endGame('last_one');
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    this.day++;
    for (const p of this.players.values()) p.stained = null;
    this.beginDay();
  }

  // อีเวนต์พิเศษ: ผู้ตายบางคนอาจ "ไม่ได้ตายจริง" และกลับเข้าเกม (เฉพาะคดีที่ตัดสินแล้ว)
  async maybeRevive() {
    const eligible = [...this.players.values()].filter((p) => !p.alive && p.fate === 'victim' && !p.revived && this.bodies.get(p.id)?.judged);
    if (!eligible.length || Math.random() >= CONFIG.REVIVE_CHANCE) return null;
    const target = pick(eligible);
    const c = this.charOf(target);
    this.generating = 'มีบางอย่างผิดปกติเกิดขึ้น...';
    this.emit();
    const kase = this.cases.find((x) => x.victimId === target.id && x.judged);
    const ev = await this.ai.generateReviveEvent({
      round: this.day + 1,
      location: this.location,
      character: c,
      deathSummary: kase?.narrative?.truthSummary || '',
      aliveCharacters: this.alivePlayers().map((p) => this.charOf(p)),
    });
    this.bodies.delete(target.id);
    target.alive = true;
    target.fate = null;
    target.deathCause = null;
    target.eliminatedDay = null;
    target.eliminatedHour = null;
    target.revived = true;
    target.revivedDay = this.day + 1;
    target.zoneId = this.location.sleepZoneId;
    target.inventory = [];
    target.objectives = [];
    target.nextObjectiveTurn = 0;
    target.forced = null;
    this.specialEvent = {
      type: 'revive',
      day: this.day + 1,
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
  endGame(reason) {
    this.clearTimers();
    this.endReason = reason;
    if (reason === 'escape') this.escaped = true;
    this.computeOutcome();
    for (const c of this.characters) c.ultimateRevealed = true;
    this.phase = PHASE.ENDED;
    this.step = null;
    this.generating = null;
    const msg = {
      escape: '🚪 ทุกคนที่ยังอยู่หนีออกมาได้! เกมจบ',
      wrong_vote: '☠ โหวตผิด — คนร้ายรอด ทุกคนที่เหลือถูกประหาร เกมจบ',
      last_one: '🏁 เหลือผู้รอดชีวิตเพียงคนเดียว เกมจบ',
      timeout: '⏳ ครบกำหนดชั่วโมงสูงสุด — ผู้ที่ยังมีชีวิตรอดได้รับการช่วยเหลือ เกมจบ',
    }[reason] || 'เกมจบแล้ว';
    this.systemMessage(msg);
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
        trait: c?.ultimate?.trait || 'none',
        fakeRole: !!c?.fakeRole,
        fakeUltimate: c?.fakeRole ? c.fakeUltimate?.title || null : null,
        portrait: c ? this.portraits.get(c.id) || null : null,
        fate: p.fate,
        deathCause: p.deathCause,
        deathCauseLabel: p.deathCause ? CAUSE_LABEL[p.deathCause] || null : null,
        eliminatedDay: p.eliminatedDay,
        eliminatedHour: p.eliminatedHour,
        revived: p.revived,
        kills: p.kills,
      };
    };
    const exits = [...this.exits.values()];
    this.outcome = {
      reason: this.endReason,
      survived: all.filter((p) => SURVIVED_FATES.includes(p.fate)).map(row),
      died: all
        .filter((p) => DEAD_FATES.includes(p.fate))
        .sort((a, b) => (a.eliminatedDay || 0) * 1000 + (a.eliminatedHour || 0) - ((b.eliminatedDay || 0) * 1000 + (b.eliminatedHour || 0)))
        .map(row),
      unsolved: this.cases.filter((c) => !c.judged).map((c) => this.caseReveal(c)),
      exits: exits.map((x) => ({ name: x.name, zoneName: this.zoneName(x.zoneId), route: x.route, discovered: x.discoveredBy.size, open: x.open, openedBy: x.openedBy.map((id) => this.nick(this.players.get(id))) })),
      days: this.day,
      hours: this.turn,
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
    if (this.phase === PHASE.GENERATING) throw new GameError('ตอนนี้ยังคุยไม่ได้');
    const c = this.charOf(p);
    this.pushChat({ playerId, name: p.name, characterName: c?.name || null, text });
    this.emit();
  }

  // ---------- bots ----------
  scheduleBots() {
    const bots = this.alivePlayers().filter((p) => p.isBot);
    const delay = (a, b) => (a + Math.random() * b) * CONFIG.BOT_DELAY_SCALE;
    const inExplore = this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION;
    if (inExplore && this.step === STEP.MOVE) {
      for (const b of bots) {
        this.setTimer(() => {
          if ((this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION) && this.step === STEP.MOVE && !this.moves.has(b.id) && b.alive) this.chooseMove(b.id, this.botPickZone(b));
        }, delay(1500, 3000));
      }
    }
    if (inExplore && this.step === STEP.ACT) {
      for (const b of bots) {
        this.setTimer(() => {
          if ((this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION) && this.step === STEP.ACT && !this.actions.has(b.id) && b.alive) {
            try {
              this.chooseAction(b.id, this.botPickAction(b));
            } catch {
              this.chooseAction(b.id, { type: 'search' });
            }
          }
        }, delay(1500, 3000));
      }
    }
    if (this.phase === PHASE.DAY && this.step === STEP.REPORT) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase === PHASE.DAY && this.step === STEP.REPORT && !this.ready.has(b.id) && b.alive) this.markReady(b.id);
        }, delay(1000, 2000));
      }
    }
    if (this.phase === PHASE.TRIAL) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase !== PHASE.TRIAL || this.confirmedVotes.has(b.id) || !b.alive) return;
          const target = this.botPickVote(b);
          if (!target) return;
          this.castVote(b.id, target);
          this.confirmVote(b.id);
        }, delay(3000, 5000));
      }
    }
  }

  // ทางออกที่บอทรู้จักและน่าจะเปิดได้ด้วยของในมือ
  botExitTarget(b) {
    for (const x of this.exits.values()) {
      if (x.open || !knowsExit(b, x)) continue;
      const mine = b.inventory.filter((i) => i.exitId === x.id);
      if (x.route === 'locked' && mine.some((i) => i.role === 'key')) return x;
      if (x.route === 'power' && x.powered) return x;
      if (x.route === 'breach' && b.inventory.some((i) => i.kind === 'weapon' || i.kind === 'tool')) return x;
      if ((x.route === 'code' || x.route === 'repair') && mine.length >= x.items.length) return x;
    }
    return null;
  }

  botPickZone(b) {
    if (b.forced) return b.forced.zoneId;
    const canEnter = (id) => {
      const z = this.zones.get(id);
      return z && (!z.locked || this.hasKeyFor(b, id)) && !(b.zoneMemory[id]?.locked && b.zoneMemory[id]?.lockedSeenTurn >= this.turn - 3 && !this.hasKeyFor(b, id));
    };
    const obj = b.objectives.find((o) => !o.done);
    if (this.phase === PHASE.DAY && obj) {
      const zid = objectiveTargetZone(this, b, obj);
      if (zid && canEnter(zid) && (obj.type !== 'plant' || b.inventory.some((i) => i.id === obj.itemId))) return zid;
    }
    if (this.phase === PHASE.INVESTIGATION) {
      const bodyZones = [...this.bodies.values()].filter((x) => x.announced && !x.judged).map((x) => x.zoneId);
      if (bodyZones.length && chance(0.5)) return pick(bodyZones);
    }
    const fuse = b.inventory.find((i) => i.role === 'fuse');
    if (fuse) {
      const pz = [...this.zones.values()].filter((z) => z.items.some((i) => i.kind === 'power') && canEnter(z.id));
      if (pz.length && chance(0.7)) return pick(pz).id;
    }
    const xt = this.botExitTarget(b);
    if (xt && canEnter(xt.zoneId) && chance(0.5)) return xt.zoneId;
    const cands = [...this.zones.keys()].filter((id) => id !== this.location.sleepZoneId && canEnter(id));
    return pick(cands) || this.location.sleepZoneId;
  }

  botPickAction(b) {
    const avail = this.availableActions(b).filter((a) => !a.disabled);
    const byType = (t) => avail.filter((a) => a.type === t);
    const take = byType('take');
    const z = this.zones.get(b.zoneId);
    const obj = b.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take' && take.some((a) => a.itemId === o.itemId));
    if (t) return take.find((a) => a.itemId === t.itemId);
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === b.zoneId && b.inventory.some((i) => i.id === o.itemId));
    if (pl) return byType('hide').find((a) => a.itemId === pl.itemId) || byType('drop').find((a) => a.itemId === pl.itemId);
    const eatObj = obj.find((o) => o.type === 'visit_eat' && o.zoneId === b.zoneId);
    if (eatObj && byType('eat').length) return byType('eat')[0];
    const power = byType('exit_power')[0];
    if (power) return power;
    const exitAct = byType('exit')[0];
    if (exitAct && this.botExitTarget(b) && chance(0.7)) return exitAct;
    const partTake = take.find((a) => {
      const it = z.items.find((i) => i.id === a.itemId);
      return it && (it.isPart || it.kind === 'clue' || it.kind === 'key');
    });
    if (partTake && chance(0.6)) return partTake;
    const examine = byType('examine');
    if (examine.length && chance(this.phase === PHASE.INVESTIGATION ? 0.6 : 0.4)) return pick(examine);
    const locked = this.murderLockedFor(b);
    const attacks = byType('attack');
    if (!locked && attacks.length === 1 && (this.designatedId === b.id || b.kills > 0) && this.bestWeapon(b) && chance(0.6)) return attacks[0];
    const trapPlace = byType('trap');
    if (!locked && trapPlace.length && chance(0.7)) return trapPlace[0];
    const craft = byType('craft');
    if (craft.length && this.designatedId === b.id && chance(0.5)) return craft[0];
    const weaponTake = take.find((a) => z.items.find((i) => i.id === a.itemId)?.kind === 'weapon');
    if (weaponTake && chance(0.4)) return weaponTake;
    if (chance(0.8)) return byType('search')[0];
    return byType('rest')[0] || avail[0];
  }

  botPickVote(b) {
    const cands = this.voteCandidates(b.id);
    if (!cands.length) return null;
    if (this.runoff) return pick(cands);
    const murders = this.openCases().filter((c) => c.killerId && this.players.get(c.killerId)?.alive);
    const culpritIds = murders.map((c) => c.killerId);
    if (culpritIds.includes(b.id)) return pick(cands.filter((id) => id !== NONE_VOTE && id !== b.id)) || pick(cands);
    if (!murders.length) return chance(0.5) && cands.includes(NONE_VOTE) ? NONE_VOTE : pick(cands);
    const known = culpritIds.filter((id) => cands.includes(id));
    if (known.length && chance(0.35)) return pick(known);
    if (chance(0.15) && cands.includes(NONE_VOTE)) return NONE_VOTE;
    return pick(cands.filter((id) => id !== NONE_VOTE)) || pick(cands);
  }

  // ---------- views ----------
  publicCase(c) {
    const v = this.players.get(c.victimId);
    const b = this.bodies.get(c.victimId);
    return {
      id: c.id,
      day: c.day,
      hour: c.hour,
      victim: { playerId: v.id, playerName: v.name, characterName: this.charOf(v)?.name || v.name, nickname: this.nick(v) },
      zoneName: this.zoneName(b?.zoneId || c.zoneId),
      title: c.narrative?.title || 'คดีที่ยังไม่มีชื่อ',
      bodyState: c.narrative?.bodyState || '',
      sceneNotes: c.narrative?.sceneNotes || '',
      judged: c.judged,
    };
  }

  itemView(i) {
    return { id: i.id, name: i.name, kind: i.kind, isPart: !!i.isPart, description: i.description, trapType: i.trapType || null, unlocksZoneName: i.unlocksZoneId ? this.zoneName(i.unlocksZoneId) : null, master: !!i.master, exitName: i.exitId ? this.exits.get(i.exitId)?.name || null : null };
  }

  viewFor(playerId) {
    const me = this.players.get(playerId) || null;
    const ended = this.phase === PHASE.ENDED;
    const spectator = !!me && !me.alive && !ended;
    const showResult = this.phase === PHASE.TRIAL_RESULT || ended;
    const inZoneStep = this.step === STEP.ACT || this.step === STEP.REPORT;
    const players = [...this.players.values()].map((p) => {
      const c = this.charOf(p);
      const isMe = p.id === playerId;
      const exposed = !!c && (c.ultimateRevealed || ended);
      const showFake = !!c?.fakeRole && !exposed && !isMe;
      const showUlt = c && !showFake && (!c.ultimate.hidden || exposed || (isMe && p.knowsUltimate));
      const body = this.bodies.get(p.id);
      const deathKnown = !p.alive && (ended || isMe || spectator || body?.announced || ['executed', 'punished', 'escaped'].includes(p.fate) || (!!me && me.knownBodies.has(p.id)));
      const sameZone = !!me && me.alive && p.alive && inZoneStep && p.zoneId === me.zoneId;
      return {
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.connected,
        isHost: p.id === this.hostId,
        alive: deathKnown ? p.alive : true,
        knownDead: deathKnown && !p.alive,
        fate: deathKnown ? p.fate : null,
        eliminatedDay: deathKnown ? p.eliminatedDay : null,
        eliminatedHour: deathKnown ? p.eliminatedHour : null,
        revived: p.revived,
        moved: this.moves.has(p.id),
        acted: this.actions.has(p.id),
        ready: this.ready.has(p.id),
        voteConfirmed: this.confirmedVotes.has(p.id),
        hasVoted: this.votes.has(p.id),
        zoneId: isMe || spectator || ended || sameZone ? p.zoneId : null,
        character: c
          ? {
              id: c.id,
              name: c.name,
              nickname: c.nickname,
              gender: c.gender,
              age: c.age,
              appearance: c.appearance,
              personality: c.personality,
              portrait: this.portraits.get(c.id) || null,
              ultimate: showFake ? c.fakeUltimate.title : showUlt ? c.ultimate.title : '???',
              ultimateDescription: showFake ? c.fakeUltimate.description : showUlt ? c.ultimate.description : null,
              trait: showFake ? 'none' : showUlt ? c.ultimate.trait : null,
              // ของตัวเอง: บอกชัดว่าคนอื่นเห็นเป็นอะไร (??? หรือชื่อปลอม)
              shownToOthers: isMe ? (c.fakeRole && !exposed ? c.fakeUltimate.title : c.ultimate.hidden && !exposed ? '???' : null) : null,
              ultimateHidden: c.ultimate.hidden,
              ultimateRevealed: c.ultimateRevealed,
              fakeRoleExposed: !!c.fakeRole && exposed,
              fakeUltimate: c.fakeRole && (exposed || isMe) ? c.fakeUltimate.title : null,
            }
          : null,
      };
    });

    const myChar = this.charOf(me);
    const ev = this.specialEvent;
    const zonesPublic = this.location ? this.location.zones.map((z) => ({ id: z.id, name: z.name, description: z.description, isSleep: z.id === this.location.sleepZoneId })) : [];
    const announced = this.cases.filter((c) => c.announced && (!c.judged || (showResult && this.lastResult?.cases.some((r) => r.id === c.id)))).map((c) => this.publicCase(c));
    const evidenceRows = me
      ? me.evidence
          .map((id) => {
            for (const z of this.zones.values()) {
              const e = z.evidence.find((x) => x.id === id);
              if (e) return { id, zoneName: z.name, text: e.text, day: e.day, hour: e.hour };
            }
            return null;
          })
          .filter(Boolean)
      : [];
    const myTrait = myChar ? this.traitOf(me) : 'none';
    const myAction = me ? this.actions.get(me.id) : null;
    const forcedLabel = (fa) => (!fa ? null : fa.type === 'take' ? 'หยิบของตามภารกิจ' : fa.type === 'hide' ? 'ซ่อนของตามภารกิจ' : fa.type === 'eat' ? 'กินอาหารตามภารกิจ' : 'ทำตามภารกิจ');
    const knownExits = me ? [...this.exits.values()].filter((x) => knowsExit(me, x) || ended || spectator).map((x) => exitView(this, me, x)) : [];
    const activeObj = me ? me.objectives.find((o) => !o.done) : null;
    return {
      code: this.code,
      phase: this.phase,
      step: this.step,
      stepDeadline: this.stepDeadline,
      day: this.day,
      hour: this.hour,
      turn: this.turn,
      hostId: this.hostId,
      generating: this.generating,
      aiMode: this.ai?.mode || 'mock',
      endReason: this.endReason,
      config: {
        minPlayers: CONFIG.MIN_PLAYERS,
        maxPlayers: CONFIG.MAX_PLAYERS,
        stepTimeoutMs: CONFIG.STEP_TIMEOUT_MS,
        maxHours: CONFIG.MAX_HOURS,
        bodyDiscoverers: CONFIG.BODY_DISCOVERERS,
        inventoryMax: CONFIG.INVENTORY_MAX,
        objectives: CONFIG.OBJECTIVES,
        maxRunoffs: CONFIG.MAX_RUNOFFS,
        hiddenUltimates: hiddenUltimateCap(this.players.size || CONFIG.MIN_PLAYERS),
        fakeRoles: Math.min(CONFIG.FAKE_ROLES, Math.max(0, this.players.size - 1)),
        exitsPerGame: ESCAPE.EXITS_PER_GAME,
        recipes: RECIPES.map((r) => ({ id: r.id, name: r.name, how: r.how, desc: r.desc, trait: r.trait, traitLabel: r.trait ? TRAITS[r.trait]?.label || r.trait : null })),
        traitEffects: TRAIT_EFFECTS,
      },
      me: me
        ? {
            id: me.id,
            name: me.name,
            isHost: me.id === this.hostId,
            alive: me.alive,
            fate: me.fate,
            deathCause: me.deathCause,
            deathCauseLabel: me.deathCause ? CAUSE_LABEL[me.deathCause] || null : null,
            revived: me.revived,
            knowsUltimate: me.knowsUltimate,
            ultimateIsHidden: !!myChar?.ultimate?.hidden,
            ultimateHiddenReason: myChar?.ultimate?.hiddenReason || null,
            fakeRole: !!myChar?.fakeRole,
            fakeUltimate: myChar?.fakeRole ? { title: myChar.fakeUltimate.title, description: myChar.fakeUltimate.description } : null,
            ultimateEffect: me.knowsUltimate ? myChar?.ultimate?.investigationEffect || null : null,
            trait: myChar ? { key: myTrait, label: TRAITS[myTrait].label, description: TRAITS[myTrait].description, effects: TRAIT_EFFECTS[myTrait] || [] } : null,
            zoneId: me.zoneId,
            zoneName: me.zoneId ? this.zoneName(me.zoneId) : null,
            moveChoice: this.moves.get(me.id) || null,
            actionChoice: myAction ? { type: myAction.type, label: myAction.label || myAction.type, forced: !!myAction.forced } : null,
            forced: me.forced ? { zoneId: me.forced.zoneId, zoneName: this.zoneName(me.forced.zoneId), actionLabel: forcedLabel(me.forced.action) } : null,
            ready: this.ready.has(me.id),
            myVote: this.votes.get(me.id) || null,
            voteConfirmed: this.confirmedVotes.has(me.id),
            isDesignated: this.phase === PHASE.DAY && this.designatedId === me.id,
            inventory: me.inventory.map((i) => this.itemView(i)),
            objectives: me.objectives
              .filter((o) => !o.done || this.turn < me.nextObjectiveTurn || o.doneTurn === this.turn)
              .slice(-2)
              .map((o) => ({ id: o.id, type: o.type, text: o.text, hours: o.hours, remainingHours: Math.max(0, o.deadlineTurn - this.turn), done: o.done, forgiven: !!o.forgiven })),
            nextObjectiveIn: CONFIG.OBJECTIVES && me.alive && !activeObj ? Math.max(0, me.nextObjectiveTurn - this.turn) : null,
            exits: knownExits,
            log: me.log.slice(-150),
            evidence: evidenceRows,
            knownBodies: [...me.knownBodies].map((id) => ({ playerId: id, name: this.nick(this.players.get(id)), zoneName: this.zoneName(this.bodies.get(id)?.zoneId), announced: !!this.bodies.get(id)?.announced })),
            zoneMemory: me.zoneMemory,
            availableActions: me.alive && this.step === STEP.ACT ? this.availableActions(me) : [],
            zonePeople: me.alive && inZoneStep ? this.presentIn(me.zoneId).filter((o) => o.id !== me.id).map((o) => ({ id: o.id, name: this.nick(o), invFull: o.inventory.length >= CONFIG.INVENTORY_MAX })) : [],
            eventPrivateNote: ev && ev.playerId === me.id ? ev.privateNote : null,
            notices: this.notices.get(me.id) || [],
            // ผู้ชม (ตายแล้ว) เห็นตำแหน่งทุกคน ศพ และทางออกทั้งหมด แต่ไม่เห็นว่าใครเป็นคนร้าย
            spectator: spectator
              ? {
                  positions: this.alivePlayers().map((p) => ({ name: this.nick(p), zoneName: this.zoneName(p.zoneId) })),
                  bodies: [...this.bodies.values()].filter((b) => !b.judged).map((b) => ({ name: this.nick(this.players.get(b.victimId)), zoneName: this.zoneName(b.zoneId), announced: b.announced })),
                  lockedZones: [...this.zones.values()].filter((z) => z.locked).map((z) => z.name),
                }
              : null,
          }
        : null,
      players,
      location: this.location ? { name: this.location.name, description: this.location.description, zones: zonesPublic, sleepZoneId: this.location.sleepZoneId } : null,
      exitsTotal: this.location ? this.exits.size : 0,
      bodyThreshold: this.location ? this.bodyThreshold() : null,
      announcedCases: announced,
      announcement: this.announcement,
      runoff: this.runoff ? { number: this.runoff.number, candidates: this.runoff.candidates, previousTally: this.runoff.previousTally } : null,
      specialEvent: ev ? { type: ev.type, day: ev.day, playerId: ev.playerId, playerName: ev.playerName, characterName: ev.characterName, title: ev.title, story: ev.story } : null,
      lastResult: showResult ? this.lastResult : null,
      history: this.history,
      outcome: ended ? this.outcome : null,
      chat: this.chat.slice(-150),
    };
  }
}
