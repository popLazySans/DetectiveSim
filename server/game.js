// Game engine — state machine ของบอร์ดเกม (เวอร์ชัน "สำรวจห้อง / ลงมือเอง / หาทางหนี")
import { CHARACTERS } from './characters.js';
import { ULTIMATE_POOL, TRAITS } from './mock.js';
import { makeObjective, objectiveOutcome } from './objectives.js';

export const PHASE = {
  LOBBY: 'lobby',
  GENERATING: 'generating',
  DAY: 'day', // สำรวจห้อง + ทำแอ็กชัน (step: move → act → report)
  INVESTIGATION: 'investigation', // รอบเก็บหลักฐานหลังพบศพ (step: move → act)
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
  // เวลาต่อจังหวะ (เลือกห้อง / เลือกแอ็กชัน) หมดเวลาแล้วระบบเลือกให้เอง (0 = ไม่จำกัด หัวห้องต้องกดบังคับ)
  STEP_TIMEOUT_MS: Number(process.env.STEP_TIMEOUT_MS || 240_000),
  // จำนวนวันสูงสุด (ครบแล้วเกมจบ ผู้ที่ยังอยู่ถือว่ารอด)
  MAX_DAYS: Number(process.env.MAX_DAYS || 10),
  // ต้องมีคน "พบศพ" กี่คน (ไม่นับคนฆ่า) ถึงจะประกาศและเข้าสู่รอบเก็บหลักฐาน
  BODY_DISCOVERERS: Number(process.env.BODY_DISCOVERERS || 3),
  INVENTORY_MAX: Number(process.env.INVENTORY_MAX || 3),
  // จำนวนของหนี (0 = อัตโนมัติ: ≤5 คนได้ 2 ชิ้น ไม่งั้น 3 ชิ้น)
  ESCAPE_PARTS: Number(process.env.ESCAPE_PARTS || 0),
  FIND_PART_CHANCE: 0.55,
  FIND_HIDDEN_CHANCE: 0.5,
  TRAP_TRIGGER_CHANCE: 0.6,
  // ภารกิจย่อยประจำวัน (ปิดได้ด้วย OBJECTIVES=false)
  OBJECTIVES: process.env.OBJECTIVES !== 'false',
  // โอกาสที่เจ้าของ Ultimate ที่ถูกซ่อนจะ "รู้ตัว" ตั้งแต่ต้นเกม
  KNOW_OWN_ULTIMATE_CHANCE: 0.5,
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

// fate: victim (ถูกฆ่า), perished (ตายเพราะทำภารกิจไม่ทัน — คนอื่นไม่รู้สาเหตุ), executed (คนร้ายถูกจับและประหาร),
// punished (โหวตผิด ทุกคนที่เหลือถูกประหาร), escaped (คนร้ายรอดเพราะโหวตผิด), survivor (รอดจนจบเกม)
export const DEAD_FATES = ['victim', 'perished', 'executed', 'punished'];
export const SURVIVED_FATES = ['survivor', 'escaped'];
export const CAUSE_LABEL = {
  attack: 'ถูกฆ่า',
  wrongTarget: 'ถูกฆ่า (คนร้ายพลาดเป้า)',
  trap: 'โดนกับดัก',
  defense: 'ถูกสวนกลับขณะพยายามฆ่า',
  objective: 'ทำภารกิจไม่ทัน',
};

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

const makePlayer = (id, name, isBot) => ({
  id,
  name,
  isBot,
  connected: true,
  joinedAt: Date.now(),
  ...freshPlayerState(),
});

const freshPlayerState = () => ({
  characterId: null,
  alive: true,
  knowsUltimate: false,
  fate: null,
  deathCause: null,
  eliminatedDay: null,
  revived: false,
  revivedDay: null,
  zoneId: null,
  inventory: [],
  objectives: [],
  log: [],
  evidence: [],
  knownBodies: new Set(),
  zoneMemory: {},
  stained: null,
  kills: 0,
});

const resetPlayerState = (p) => Object.assign(p, freshPlayerState());

// น้ำหนักอาวุธเวลาลงมือ (ค่าสูง = เลือกก่อน / โอกาสสำเร็จสูง)
const WEAPON_BASE = { weapon: 0.75, poison: 0.5, tool: 0.6, cloth: 0.55, key: 0.45, part: 0.45 };
const TRAP_DESC = {
  poison: 'ผสมลงในน้ำดื่มและของกินที่วางอยู่ในห้องนี้',
  weapon: 'ตั้งไว้ให้ตกใส่คนที่เปิดตู้หรือประตูในห้องนี้',
  tool: 'ขึงไว้ให้สะดุดล้มกระแทกของแข็งในห้องนี้',
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
    this.step = null;
    this.stepDeadline = null;
    this.day = 0;
    this.characters = [];
    this.location = null;
    this.zones = new Map();
    this.escape = null;
    this.bodies = new Map();
    this.cases = [];
    this.timeline = [];
    this.moves = new Map();
    this.actions = new Map();
    this.ready = new Set();
    this.designatedId = null;
    this.deadlinesCheckedDay = 0;
    this.lastTrialDay = 0;
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

  presentIn(zoneId) {
    return this.alivePlayers().filter((p) => p.zoneId === zoneId);
  }

  bodiesIn(zoneId) {
    return [...this.bodies.values()].filter((b) => !b.judged && b.zoneId === zoneId);
  }

  caseOf(id) {
    return this.cases.find((c) => c.id === id) || null;
  }

  pushChat(msg) {
    this.chat.push({ id: nextId(), ts: Date.now(), phase: this.phase, day: this.day, ...msg });
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
    p.log.push({ id: nextId(), day: this.day, phase: this.phase, text, kind, ts: Date.now() });
    if (p.log.length > 200) p.log.splice(0, p.log.length - 200);
  }

  // เหตุการณ์จริง (ใช้เฉลยตอนตัดสิน)
  recordEvent(text) {
    let t = this.timeline.at(-1);
    if (!t || t.day !== this.day || t.phase !== this.phase) {
      t = { day: this.day, phase: this.phase, positions: Object.fromEntries(this.alivePlayers().map((p) => [p.id, p.zoneId])), events: [] };
      this.timeline.push(t);
    }
    t.events.push(text);
  }

  makeEvidence(zoneId, text, hidden, caseId, kind) {
    return { id: nextId(), zoneId, text, hidden: !!hidden, caseId: caseId || null, kind, day: this.day };
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
        // โรลปลอม: เจ้าของต้องรู้ Ultimate จริงของตัวเองเสมอ / Ultimate ที่ซ่อน: รู้ 50/50
        p.knowsUltimate = chars[i].fakeRole ? true : chars[i].ultimate.hidden ? Math.random() < CONFIG.KNOW_OWN_ULTIMATE_CHANCE : true;
      });
      this.generating = 'กำลังจำลองสถานที่และซ่อนของสำหรับหนี...';
      this.emit();
      const loc = await this.ai.generateLocation({ playerCount: this.players.size });
      this.buildWorld(loc);
      this.day = 1;
      this.systemMessage(`เกมเริ่มแล้ว! ทุกคนตื่นขึ้นมาใน "${loc.name}" — หาของสำหรับหนี ${this.escape.total} ชิ้นให้เจอ... หรือจะเอาตัวรอดด้วยวิธีอื่นก็ได้`);
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

  buildWorld(loc) {
    this.location = loc;
    this.zones = new Map();
    for (const z of loc.zones) {
      this.zones.set(z.id, {
        id: z.id,
        name: z.name,
        description: z.description,
        items: z.items.map((it) => ({ ...it, originZoneId: z.id, hidden: false, isPart: false })),
        traps: [],
        evidence: [],
        dark: false,
      });
    }
    const n = CONFIG.ESCAPE_PARTS || (this.players.size <= 5 ? 2 : 3);
    const names = shuffle(loc.partNames).slice(0, n);
    const candidateZones = shuffle([...this.zones.keys()].filter((id) => id !== loc.exitZoneId && id !== loc.sleepZoneId));
    this.escape = { description: loc.exitDescription, exitZoneId: loc.exitZoneId, total: names.length, parts: [], achieved: false };
    names.forEach((name, i) => {
      const zid = candidateZones[i % candidateZones.length];
      const item = { id: `part_${i + 1}`, name, description: 'ของสำคัญสำหรับเปิดทางออก', kind: 'part', portable: true, isPart: true, hidden: true, originZoneId: zid };
      this.zones.get(zid).items.push(item);
      this.escape.parts.push({ id: item.id, name, zoneId: zid, found: false });
    });
    for (const p of this.players.values()) p.zoneId = loc.sleepZoneId;
  }

  // ---------- day loop ----------
  beginDay() {
    this.phase = PHASE.DAY;
    this.step = STEP.MOVE;
    this.generating = null;
    this.moves = new Map();
    this.actions = new Map();
    this.ready = new Set();
    for (const z of this.zones.values()) z.dark = false;
    const alive = this.alivePlayers();
    this.designatedId = alive.length >= 2 ? pick(alive).id : null;
    if (this.designatedId) {
      const d = this.players.get(this.designatedId);
      const hint = this.weaponHint(d);
      this.logTo(
        d,
        `🔪 วันนี้เกมเลือกคุณเป็น "ฆาตกร" — จะลงมือหรือไม่ก็ได้ ถ้าลงมือวันนี้ โอกาสสำเร็จจะสูงขึ้น${hint ? ` และคุณรู้ว่า${hint}` : ''} ถ้าคนอื่นลงมือก่อน คุณจะกลายเป็นแค่คนที่อยู่ในเหตุการณ์ มีแค่คุณที่รู้เรื่องนี้`,
        'designated',
      );
      this.notify(d.id, 'วันนี้เกมเลือกคุณเป็นฆาตกร — ดูรายละเอียดในสมุดบันทึก', 'reveal');
    }
    // ภารกิจค้างได้ทีละข้อ (วันละ 1 แอ็กชัน ทำหลายข้อพร้อมกันไม่ทัน)
    if (CONFIG.OBJECTIVES) for (const p of alive) if (p.objectives.every((o) => o.done)) this.assignObjective(p);
    this.systemMessage(`— วันที่ ${this.day}/${CONFIG.MAX_DAYS} — ทุกคนเลือกห้องที่จะไปวันนี้ (ไม่มีใครเห็นว่าใครเลือกอะไร) เมื่อครบทุกคนจะได้เห็นว่าใครอยู่ห้องเดียวกับคุณ`);
    this.emit();
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
    this.logTo(p, `📋 ภารกิจใหม่: ${o.text} — ทำไม่ทันจะมีผลถึงชีวิต`, 'objective');
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
    this.alivePlayer(playerId);
    if (!this.zones.has(zoneId)) throw new GameError('ไม่มีห้องนี้');
    this.moves.set(playerId, zoneId);
    this.emit();
    if (this.alivePlayers().every((p) => this.moves.has(p.id))) this.resolveMoves();
  }

  resolveMoves() {
    this.clearTimers();
    const alive = this.alivePlayers();
    const positions = {};
    for (const p of alive) {
      const zid = this.moves.get(p.id) || p.zoneId || this.location.sleepZoneId;
      p.zoneId = zid;
      positions[p.id] = zid;
    }
    this.timeline.push({ day: this.day, phase: this.phase, positions, events: [] });

    // กับดักทำงานตอนมีคนเข้าห้อง
    for (const z of this.zones.values()) {
      if (!z.traps.length) continue;
      for (const p of shuffle(alive.filter((x) => x.alive && x.zoneId === z.id))) {
        const trap = z.traps.find((t) => t.setterId !== p.id);
        if (!trap) continue;
        const r = Math.random();
        if (r < CONFIG.TRAP_TRIGGER_CHANCE) {
          this.triggerTrap(z, trap, p);
        } else if (r < CONFIG.TRAP_TRIGGER_CHANCE + 0.25) {
          z.traps.splice(z.traps.indexOf(trap), 1);
          z.items.push({ ...trap.item, hidden: false });
          z.evidence.push(this.makeEvidence(z.id, `${trap.item.name}ถูกตั้งไว้เป็นกับดักและมีคนปลดออกแล้ว`, false, null, 'trap'));
          this.logTo(p, `⚠ ทันทีที่เข้ามาใน${this.zn(z)} คุณสังเกตเห็น${trap.item.name}ถูกตั้งไว้เป็นกับดัก (${TRAP_DESC[trap.item.kind] || ''}) คุณปลดมันออกได้ทัน — มีคนตั้งใจจะฆ่าใครสักคนที่เข้ามาห้องนี้`, 'danger');
          this.recordEvent(`${this.nick(p)}พบและปลดกับดัก (${trap.item.name}) ที่${this.zn(z)}`);
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
      const lines = [`📍 คุณมาถึง${this.zn(z)}`];
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
        if (o.stained === this.day - 1 && chance(0.4)) lines.push(`👀 เสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่ยังไม่ได้ซัก`);
      }
      if (z.traps.some((t) => t.setterId === p.id)) lines.push(`🪤 กับดักของคุณยังอยู่ที่นี่`);
      p.zoneMemory[z.id] = {
        day: this.day,
        phase: this.phase,
        people: others.map((o) => this.nick(o)),
        items: visibleItems.map((i) => i.name),
        bodies: bodies.map((b) => this.nick(this.players.get(b.victimId))),
      };
      this.logTo(p, lines.join(' · '), 'move');
      this.checkObjectivesAfterMove(p);
    }

    if (this.alivePlayers().length <= 1) return this.endGame('last_one');
    if (this.checkBodyThreshold()) return;
    this.step = STEP.ACT;
    this.emit();
    this.armStepTimer();
    this.scheduleBots();
  }

  triggerTrap(z, trap, victim) {
    z.traps.splice(z.traps.indexOf(trap), 1);
    const setter = this.players.get(trap.setterId) || null;
    const kase = this.killPlayer(victim, { cause: 'trap', killerId: setter?.id || null, weapon: trap.item, zoneId: z.id, messy: false, witnesses: [] });
    z.evidence.push(
      this.makeEvidence(
        z.id,
        trap.item.kind === 'poison' ? `ภาชนะน้ำดื่มในห้องมีคราบและกลิ่นของ${trap.item.name}` : `${trap.item.name}ที่ตกลงมาถูกผูก/ตั้งไว้อย่างจงใจ ไม่ใช่อุบัติเหตุ`,
        false,
        kase.id,
        'trap',
      ),
    );
    z.items.push({ ...trap.item, hidden: false });
    const how = trap.item.kind === 'poison' ? `คุณดื่มน้ำในห้องแล้วรู้สึกชาไปทั้งตัว — มีคนผสม${trap.item.name}ไว้` : `${trap.item.name}ตกลงมาใส่คุณเต็มแรง — มีคนตั้งมันไว้`;
    this.logTo(victim, `💀 ทันทีที่คุณเข้ามาใน${this.zn(z)} ${how} คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
    for (const o of this.presentIn(z.id)) {
      o.knownBodies.add(victim.id);
      this.bodies.get(victim.id).discoveredBy.add(o.id);
      this.logTo(o, `😱 ต่อหน้าคุณ ${this.nick(victim)}ล้มลงที่${this.zn(z)}และเสียชีวิต ${trap.item.kind === 'poison' ? 'หลังดื่มน้ำในห้อง' : `หลัง${trap.item.name}ตกลงมาใส่`} ไม่มีใครแตะต้องเขาเลย — ต้องเป็นกับดักที่มีคนวางไว้ก่อน`, 'witness');
    }
    if (setter?.alive) this.logTo(setter, `🪤 กับดัก (${trap.item.name}) ที่คุณวางไว้ที่${this.zn(z)}ทำงานแล้ว — ${this.nick(victim)}ตาย คุณคือคนร้ายของคดีนี้`, 'culprit');
    this.recordEvent(`${this.nick(victim)}โดนกับดัก (${trap.item.name}) ของ${setter ? this.nick(setter) : '?'}ที่${this.zn(z)}และเสียชีวิต`);
  }

  // ฆ่าผู้เล่น: ศพอยู่ตรงนั้น ของที่ถือหล่นไว้ในห้อง สร้างคดี
  killPlayer(victim, info) {
    victim.alive = false;
    victim.fate = info.cause === 'objective' ? 'perished' : 'victim';
    victim.deathCause = info.cause;
    victim.eliminatedDay = this.day;
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
      phase: this.phase,
      victimId: victim.id,
      killerId: info.killerId || null,
      cause: info.cause,
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
  bestWeapon(p) {
    const trait = this.traitOf(p);
    let best = null;
    let bestScore = 0;
    for (const it of p.inventory) {
      let s = WEAPON_BASE[it.kind] || 0;
      if (it.kind === 'poison' && trait === 'medical') s = 0.8;
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    return best;
  }

  attackChance(p, target, weapon, witnessCount) {
    let base = weapon ? WEAPON_BASE[weapon.kind] || 0.5 : 0.4;
    if (weapon?.kind === 'poison') base = this.traitOf(p) === 'medical' ? 0.8 : 0.5;
    if (this.traitOf(p) === 'combat') base += 0.15;
    if (this.traitOf(target) === 'combat') base -= 0.15;
    if (this.phase === PHASE.DAY && this.designatedId === p.id) base += 0.1;
    base -= 0.08 * witnessCount;
    return clamp(base, 0.1, 0.95);
  }

  availableActions(p) {
    const z = this.zones.get(p.zoneId);
    if (!z || !p.alive) return [];
    const trait = this.traitOf(p);
    const others = this.presentIn(z.id).filter((o) => o.id !== p.id);
    const bodies = this.bodiesIn(z.id);
    const out = [];
    const inDay = this.phase === PHASE.DAY;
    out.push({ type: 'search', label: '🔍 สำรวจห้องอย่างละเอียด', desc: 'หาของที่ซ่อนอยู่ (รวมของหนี) หลักฐาน และสังเกตว่ามีอะไรหายไปจากห้อง' });
    const invFull = p.inventory.length >= CONFIG.INVENTORY_MAX;
    for (const it of z.items.filter((i) => !i.hidden && i.portable)) {
      out.push({ type: 'take', itemId: it.id, label: `🖐 หยิบ ${it.name}${it.isPart ? ' ⭐' : ''}`, desc: it.description, disabled: invFull, reason: invFull ? `ถือของได้สูงสุด ${CONFIG.INVENTORY_MAX} ชิ้น วางของก่อน` : '' });
    }
    for (const it of p.inventory) {
      out.push({ type: 'hide', itemId: it.id, label: `🫥 ซ่อน ${it.name} ไว้ในห้องนี้`, desc: 'คนอื่นต้องสำรวจละเอียดถึงจะเจอ' });
      out.push({ type: 'drop', itemId: it.id, label: `⬇ วาง ${it.name} ไว้ในห้องนี้`, desc: 'ใครเข้ามาก็เห็นทันที' });
    }
    if (inDay) {
      for (const o of others) {
        const w = this.bestWeapon(p);
        const pct = Math.round(this.attackChance(p, o, w, others.length - 1) * 100);
        out.push({
          type: 'attack',
          targetId: o.id,
          label: `🔪 ลงมือกับ ${this.nick(o)}${w ? ` ด้วย${w.name}` : ' ด้วยมือเปล่า'}`,
          desc: `โอกาสสำเร็จราว ${pct}%${others.length > 1 ? ` · มีคนอื่นในห้องอีก ${others.length - 1} คน (อาจเห็น หรือโดนลูกหลง)` : ''} · พลาดแล้วเขาจะรู้ตัว และอาจสวนกลับ`,
          danger: true,
        });
      }
      if (!z.traps.some((t) => t.setterId === p.id)) {
        for (const it of p.inventory.filter((i) => TRAP_DESC[i.kind])) {
          out.push({ type: 'trap', itemId: it.id, label: `🪤 วางกับดักด้วย ${it.name}`, desc: `${TRAP_DESC[it.kind]} — คนต่อไปที่เข้ามา (ที่ไม่ใช่คุณ) มีโอกาสโดน`, danger: true });
        }
      }
    }
    for (const b of bodies) {
      const v = this.players.get(b.victimId);
      out.push({ type: 'examine', victimId: b.victimId, label: `🔎 ตรวจศพของ ${this.nick(v)}`, desc: trait === 'medical' ? 'ความรู้ทางการแพทย์ของคุณจะบอกอาวุธ วันที่ตาย และว่าศพถูกย้ายหรือไม่' : 'ดูสภาพศพคร่าว ๆ (คนที่มีความรู้ทางการแพทย์จะเห็นมากกว่า)' });
      out.push({ type: 'moveBody', victimId: b.victimId, label: `🚚 ย้ายศพของ ${this.nick(v)} ไปห้องอื่น`, desc: 'ทิ้งรอยลากไว้ทั้งสองห้อง และคนในห้องอาจเห็น', needsZone: true, danger: true });
    }
    if (z.evidence.some((e) => !e.hidden)) {
      out.push({ type: 'clean', label: '🧹 เก็บกวาด/ทำลายร่องรอยในห้องนี้', desc: `ซ่อนหลักฐานที่มองเห็นได้ในห้องนี้${trait === 'stealth' || trait === 'medical' ? ' (คุณถนัดเรื่องนี้)' : ''} — ทำพลาดอาจยิ่งทิ้งร่องรอย`, danger: true });
    }
    if (trait === 'stealth') for (const o of others) out.push({ type: 'steal', targetId: o.id, label: `🕵 ล้วงกระเป๋า ${this.nick(o)}`, desc: 'ขโมยของ 1 ชิ้นจากเขา โดยที่เขาอาจไม่รู้ตัว' });
    if (trait === 'social') for (const o of others) out.push({ type: 'interrogate', targetId: o.id, label: `🗣 ซักถาม ${this.nick(o)}`, desc: 'รู้ความจริงเกี่ยวกับเขา 1 ข้อ (เขาจะรู้ว่าคุณซักถาม)' });
    if (trait === 'tech' && z.items.some((i) => i.kind === 'power') && !z.dark) out.push({ type: 'sabotage', label: '⚡ ตัดไฟ/กล้องในห้องนี้', desc: 'วันนี้พยานในห้องนี้จะจำหน้าคนลงมือไม่ได้ (รวมถึงสิ่งที่คุณทำด้วย)' });
    if (z.id === this.escape.exitZoneId) {
      const held = p.inventory.filter((i) => i.isPart).length;
      out.push({
        type: 'escape',
        label: '🚪 พยายามเปิดทางออก',
        desc: held
          ? `คุณถือของหนี ${held}/${this.escape.total} ชิ้น · ของที่คนอื่นในห้องนี้ถือและเลือก "เปิดทางออก" พร้อมกันจะนับรวม ถ้าครบทุกชิ้น ทุกคนที่ยังอยู่จะรอด`
          : 'คุณไม่มีของหนีเลย แต่ถ้าคนที่มีเลือกพร้อมกันในห้องนี้ก็นับรวมกันได้',
      });
    }
    out.push({ type: 'rest', label: '😶 ไม่ทำอะไร แค่สังเกตคนอื่น', desc: 'มีโอกาสเห็นว่าใครในห้องทำอะไรลับ ๆ ล่อ ๆ' });
    return out;
  }

  chooseAction(playerId, action) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    this.assertStep(STEP.ACT);
    const p = this.alivePlayer(playerId);
    action = action || {};
    const same = (a, k) => (a[k] ?? null) === (action[k] ?? null);
    const match = this.availableActions(p).find((a) => a.type === action.type && same(a, 'targetId') && same(a, 'itemId') && same(a, 'victimId'));
    if (!match) throw new GameError('ทำแอ็กชันนี้ไม่ได้');
    if (match.disabled) throw new GameError(match.reason || 'ทำแอ็กชันนี้ไม่ได้');
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
    const order = { sabotage: 0, attack: 1, steal: 2, trap: 3, clean: 4, moveBody: 5, interrogate: 6, take: 7, drop: 8, hide: 8, search: 9, examine: 9, escape: 10, rest: 11 };
    const list = shuffle([...this.actions.entries()]).sort((a, b) => (order[a[1].type] ?? 20) - (order[b[1].type] ?? 20));
    const escapers = [];
    for (const [pid, a] of list) {
      const p = this.players.get(pid);
      if (!p?.alive) continue;
      const fn = this[`do_${a.type}`];
      if (typeof fn !== 'function') continue;
      try {
        fn.call(this, p, a, escapers);
      } catch (err) {
        this.log.error(`[room ${this.code}] action ${a.type} failed`, err);
      }
    }
    this.resolveRest();
    this.resolveEscape(escapers);
    if (this.phase === PHASE.ENDED) return;

    // ก่อนแยกย้าย คนในห้องเดียวกันเห็นศพที่เพิ่งเกิดขึ้น และอาจสังเกตเสื้อผ้าเปื้อน
    for (const b of this.bodies.values()) {
      if (b.judged || b.day !== this.day) continue;
      for (const o of this.presentIn(b.zoneId)) {
        if (o.id === b.killerId || o.knownBodies.has(b.victimId)) continue;
        o.knownBodies.add(b.victimId);
        b.discoveredBy.add(o.id);
        this.logTo(o, `☠ ก่อนออกจาก${this.zn(b.zoneId)} คุณพบว่า${this.nick(this.players.get(b.victimId))}นอนไม่ขยับอยู่ — เขาตายแล้ว`, 'witness');
      }
    }
    for (const p of this.alivePlayers()) {
      for (const o of this.presentIn(p.zoneId)) {
        if (o.id !== p.id && o.stained === this.day && chance(0.5)) this.logTo(p, `👀 คุณสังเกตว่าเสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่เมื่อเช้ายังไม่มี`, 'witness');
      }
    }

    if (this.phase === PHASE.DAY) {
      this.checkDeadlines();
      if (this.alivePlayers().length <= 1) return this.endGame('last_one');
      if (this.checkBodyThreshold()) return;
      this.step = STEP.REPORT;
      this.ready = new Set();
      this.systemMessage('วันนี้จบลงแล้ว — อ่านสมุดบันทึกของตัวเอง คุยกันได้ แล้วกด "พร้อมไปวันถัดไป"');
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
    const pSucc = this.attackChance(p, target, w, others.length);
    const who = this.who(p, z);
    const r = Math.random();
    if (r < pSucc) {
      const messy = chance(this.traitOf(p) === 'combat' ? 0.2 : 0.4);
      const saw = others.filter(() => chance(messy ? 0.75 : 0.4));
      const kase = this.killPlayer(target, { cause: 'attack', killerId: p.id, weapon: w, zoneId: z.id, messy, witnesses: saw.map((o) => o.id) });
      this.addKillEvidence(z, kase, w, messy, p);
      if (messy) p.stained = this.day;
      if (w?.kind === 'poison') {
        p.inventory.splice(p.inventory.indexOf(w), 1);
        w.hidden = true;
        z.items.push(w);
      }
      this.logTo(
        p,
        `🔪 คุณลงมือกับ${this.nick(target)}${wtxt}สำเร็จ ${messy ? 'แต่ไม่เรียบร้อย: คราบเลือดกระจาย ของล้มระเนระนาด และเสื้อผ้าคุณเปื้อน' : 'อย่างเงียบเชียบ ทิ้งร่องรอยไว้น้อยมาก'}${
          saw.length ? ` — แย่แล้ว ${saw.map((o) => this.nick(o)).join(', ')}เห็นคุณลงมือ!` : others.length ? ` ไม่มีใครเห็นตอนลงมือ แต่คนในห้อง (${others.map((o) => this.nick(o)).join(', ')}) เห็นศพแน่นอน` : ' ไม่มีใครเห็น'
        }${kase.dropped.length ? ` ของที่${this.nick(target)}ถือหล่นอยู่ที่นี่: ${kase.dropped.join(', ')}` : ''} คุณคือคนร้ายของคดีนี้ — ศพจะอยู่ตรงนี้จนกว่าจะมีคนย้าย`,
        'culprit',
      );
      this.logTo(target, `💀 ${who}ลงมือกับคุณ${wtxt}ที่${this.zn(z)} คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
      for (const o of others) {
        o.knownBodies.add(target.id);
        this.bodies.get(target.id).discoveredBy.add(o.id);
        if (saw.includes(o)) this.logTo(o, `😱 คุณเห็น${who}ลงมือกับ${this.nick(target)}${wtxt}ต่อหน้าต่อตา!`, 'witness');
        else
          this.logTo(
            o,
            `😱 คุณหันไปอีกทีก็เห็น${this.nick(target)}นอนไม่ขยับอยู่ที่${this.zn(z)} คนที่อยู่ในห้องนี้ตอนนั้น: ${[p, ...others.filter((x) => x !== o)].map((x) => (z.dark ? 'เงาคน' : this.nick(x))).join(', ')}${z.dark ? ' (มืดจนแยกไม่ออก)' : ''}`,
            'witness',
          );
      }
      this.designatedHears(kase, p);
      this.recordEvent(`${this.nick(p)}ฆ่า${this.nick(target)}ที่${this.zn(z)}${wtxt}${messy ? ' แบบเลอะเทอะ' : ' อย่างเงียบเชียบ'}${saw.length ? ` (${saw.map((o) => this.nick(o)).join(', ')}เห็น)` : ''}`);
      return;
    }
    // พลาด
    if (chance(this.traitOf(target) === 'combat' ? 0.5 : 0.25)) {
      const kase = this.killPlayer(p, { cause: 'defense', killerId: target.id, weapon: null, zoneId: z.id, messy: true, witnesses: others.map((o) => o.id) });
      this.addKillEvidence(z, kase, null, true, target);
      target.stained = this.day;
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
    if (others.length && chance(0.3)) {
      const wrong = pick(others);
      const rest = others.filter((o) => o !== wrong);
      const kase = this.killPlayer(wrong, { cause: 'wrongTarget', killerId: p.id, weapon: w, zoneId: z.id, messy: true, witnesses: [target.id, ...rest.map((o) => o.id)] });
      this.addKillEvidence(z, kase, w, true, p);
      p.stained = this.day;
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
    const dropWeapon = w && w.kind !== 'poison' && chance(0.4);
    if (dropWeapon) {
      p.inventory.splice(p.inventory.indexOf(w), 1);
      w.hidden = false;
      z.items.push(w);
      z.evidence.push(this.makeEvidence(z.id, `${w.name}ตกอยู่กลางห้อง ไม่ใช่ที่ของมัน`, false, null, 'item'));
    }
    this.logTo(p, `❌ คุณพยายามลงมือกับ${this.nick(target)}${wtxt} แต่พลาด เขาตัวไวกว่าที่คิด${dropWeapon ? ` และคุณทำ${w.name}หล่นไว้ที่นั่น` : ''} ตอนนี้เขารู้แล้วว่ามีคนพยายามฆ่าเขา${z.dark ? ' (แต่มืด เขาอาจไม่รู้ว่าเป็นคุณ)' : ''}`, 'danger');
    this.logTo(target, `⚠ ${who}พยายามทำร้ายคุณที่${this.zn(z)}${wtxt}! คุณหลบได้ทัน${z.dark ? ' แต่มืดเกินกว่าจะเห็นว่าเป็นใคร' : ''}`, 'danger');
    for (const o of others) if (chance(0.6)) this.logTo(o, `👀 คุณเห็น${who}กับ${this.nick(target)}ปะทะกันชั่วครู่ที่${this.zn(z)} ${this.nick(target)}ดูตกใจมาก`, 'witness');
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
    this.logTo(d, `👂 คุณได้ยินเสียง${w?.kind === 'poison' ? 'แก้วแตก' : /ปืน|ธนู/.test(w?.name || '') ? 'ดังปัง' : 'ของหนักกระแทกพื้น'}ดังมาจากทาง${this.zn(kase.zoneId)} — คุณที่เกมเลือกเป็นฆาตกรวันนี้ไม่ได้ลงมือ แต่กลายเป็นคนที่อยู่ในเหตุการณ์ไปแล้ว คิดดูว่าจะเล่าให้ใครฟังดี`, 'witness');
    kase.designatedHeard = true;
  }

  do_trap(p, a) {
    const z = this.zones.get(p.zoneId);
    const idx = p.inventory.findIndex((i) => i.id === a.itemId);
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    const who = this.who(p, z);
    if (chance(0.15)) {
      it.hidden = false;
      z.items.push(it);
      z.evidence.push(this.makeEvidence(z.id, `${it.name}วางอยู่ในตำแหน่งแปลก ๆ เหมือนมีคนพยายามจัดวางให้ทำอะไรบางอย่าง`, false, null, 'trap'));
      this.logTo(p, `❌ คุณตั้งกับดักด้วย${it.name}ไม่สำเร็จ มันหล่นและวางเกะกะให้เห็นอยู่ใน${this.zn(z)}`, 'danger');
    } else {
      z.traps.push({ setterId: p.id, item: it, day: this.day });
      this.logTo(p, `🪤 คุณตั้งกับดักด้วย${it.name}ไว้ที่${this.zn(z)}แล้ว (${TRAP_DESC[it.kind]}) คนต่อไปที่เข้ามาที่ไม่ใช่คุณมีโอกาสโดน — ถ้าเขาตาย คุณคือคนร้าย`, 'culprit');
    }
    for (const o of this.witnessesOf(p, z)) if (chance(0.4)) this.logTo(o, `👀 คุณเห็น${who}ก้ม ๆ เงย ๆ ยุ่งอยู่กับ${it.name}ตรงมุมห้อง${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}วางกับดัก (${it.name}) ที่${this.zn(z)}`);
  }

  do_clean(p) {
    const z = this.zones.get(p.zoneId);
    const vis = z.evidence.filter((e) => !e.hidden);
    if (!vis.length) return this.logTo(p, `คุณมองหาร่องรอยใน${this.zn(z)} แต่ไม่มีอะไรให้เก็บ`, 'action');
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
    for (const o of this.witnessesOf(p, z)) if (chance(0.6)) this.logTo(o, `👀 คุณเห็น${who}ขัดถูพื้นและเก็บของใน${this.zn(z)}อย่างเร่งรีบ`, 'witness');
    this.recordEvent(`${this.nick(p)}พยายามทำลายหลักฐานที่${this.zn(z)}`);
  }

  do_moveBody(p, a) {
    const b = this.bodies.get(a.victimId);
    const from = this.zones.get(p.zoneId);
    const to = this.zones.get(a.toZoneId);
    if (!b || b.judged || b.zoneId !== from.id || !to) return this.logTo(p, 'ศพไม่ได้อยู่ตรงนี้แล้ว', 'danger');
    const v = this.players.get(b.victimId);
    b.zoneId = to.id;
    b.moved = true;
    const kase = this.caseOf(b.caseId);
    if (kase) kase.moved = true;
    from.evidence.push(this.makeEvidence(from.id, `รอยลากบนพื้นจากกลางห้องออกไปทางประตู`, false, b.caseId, 'drag'));
    to.evidence.push(this.makeEvidence(to.id, `รอยลากบนพื้นจากประตูเข้ามาถึงจุดที่ศพอยู่ ศพถูกย้ายมาจากที่อื่น`, false, b.caseId, 'drag'));
    if (chance(0.5)) p.stained = this.day;
    const who = this.who(p, from);
    this.logTo(p, `🚚 คุณลากศพของ${this.nick(v)}จาก${this.zn(from)}ไปไว้ที่${this.zn(to)} ทิ้งรอยลากไว้ทั้งสองห้อง${p.stained === this.day ? ' และเสื้อผ้าคุณเปื้อน' : ''}`, 'culprit');
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
    if (it.isPart) {
      const part = this.escape.parts.find((x) => x.id === it.id);
      if (part) part.found = true;
      this.logTo(p, `⭐ คุณได้${it.name}มาไว้กับตัว — ของสำคัญสำหรับหนี! (${this.escape.parts.filter((x) => x.found).length}/${this.escape.total} ชิ้นถูกพบแล้ว) ระวังคนที่อยากได้มันจากคุณ`, 'escape');
      this.recordEvent(`${this.nick(p)}หยิบของหนี (${it.name}) จาก${this.zn(z)}`);
    } else {
      this.logTo(p, `🖐 คุณหยิบ${it.name}มาไว้กับตัว`, 'action');
      this.recordEvent(`${this.nick(p)}หยิบ${it.name}จาก${this.zn(z)}`);
    }
    for (const o of this.witnessesOf(p, z)) if (chance(0.5)) this.logTo(o, `👀 คุณเห็น${who}หยิบ${it.name}ติดตัวไป`, 'witness');
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
    this.logTo(p, hidden ? `🫥 คุณซ่อน${it.name}ไว้ใน${this.zn(z)} คนอื่นต้องสำรวจละเอียดถึงจะเจอ` : `⬇ คุณวาง${it.name}ไว้ใน${this.zn(z)}`, 'action');
    for (const o of this.witnessesOf(p, z)) if (chance(hidden ? 0.3 : 0.5)) this.logTo(o, `👀 คุณเห็น${who}${hidden ? 'แอบซุก' : 'วาง'}${it.name}ไว้ใน${this.zn(z)}`, 'witness');
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
    const bonus = this.traitOf(p) === 'detective' ? 0.35 : 0;
    const lines = [];
    const foundItems = [];
    for (const it of z.items.filter((i) => i.hidden)) {
      if (chance((it.isPart ? CONFIG.FIND_PART_CHANCE : CONFIG.FIND_HIDDEN_CHANCE) + bonus)) {
        it.hidden = false;
        foundItems.push(it);
      }
    }
    for (const it of foundItems) {
      if (it.isPart && p.inventory.length < CONFIG.INVENTORY_MAX) {
        z.items.splice(z.items.indexOf(it), 1);
        p.inventory.push(it);
        const part = this.escape.parts.find((x) => x.id === it.id);
        if (part) part.found = true;
        lines.push(`⭐ คุณเจอ${it.name}ซ่อนอยู่! ของสำคัญสำหรับหนี — คุณเก็บมันไว้กับตัวแล้ว (${this.escape.parts.filter((x) => x.found).length}/${this.escape.total} ชิ้นถูกพบแล้ว)`);
        this.recordEvent(`${this.nick(p)}ค้นเจอของหนี (${it.name}) ที่${this.zn(z)}`);
      } else {
        lines.push(`🔍 คุณเจอ${it.name}${it.isPart ? ' ⭐ (ของหนี!)' : ''}ซ่อนอยู่ในห้องนี้ (ตอนนี้มันวางให้เห็นแล้ว${it.isPart ? ' คุณถือของเต็มมือจึงยังไม่ได้หยิบ' : ''})`);
      }
    }
    const newEv = z.evidence.filter((e) => !p.evidence.includes(e.id) && (!e.hidden || chance(CONFIG.FIND_HIDDEN_CHANCE + bonus)));
    for (const e of newEv) {
      p.evidence.push(e.id);
      lines.push(`🧩 หลักฐาน: ${e.text}`);
    }
    const orig = (this.location.zones.find((zz) => zz.id === z.id)?.items || []).filter((i) => i.portable);
    const missing = orig.filter((oi) => !z.items.some((i) => i.id === oi.id) && !p.inventory.some((i) => i.id === oi.id));
    if (missing.length) lines.push(`❓ ของที่ควรอยู่ในห้องนี้แต่หายไป: ${missing.map((i) => i.name).join(', ')}`);
    const trap = z.traps.find((t) => t.setterId !== p.id);
    if (trap && chance(0.3 + bonus)) lines.push(`⚠ คุณสังเกตเห็นว่า${trap.item.name}ถูกจัดวางไว้อย่างผิดปกติ เหมือนเป็นกับดัก (คุณไม่ได้แตะต้องมัน)`);
    if (!lines.length) lines.push('ไม่พบอะไรผิดปกติในห้องนี้');
    this.logTo(p, `🔍 สำรวจ${this.zn(z)}: ${lines.join(' · ')}`, 'evidence');
    if (p.zoneMemory[z.id]) p.zoneMemory[z.id].searched = this.day;
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
    if (kase.cause === 'objective') text = med ? 'ไม่พบบาดแผล ไม่พบร่องรอยสารพิษหรือการขาดอากาศ หัวใจเหมือนหยุดเต้นไปเองเฉียบพลัน — ในมุมมองแพทย์ นี่ไม่ใช่ฝีมือใคร' : 'ไม่มีบาดแผลภายนอกเลย ใบหน้าสงบ ไม่รู้ว่าตายเพราะอะไร';
    else if (w?.kind === 'poison') text = med ? `อาการตรงกับพิษจาก${w.name} ${kase.cause === 'trap' ? 'ได้รับผ่านน้ำดื่มในห้อง (กับดัก)' : 'ถูกวางยาโดยตรง'}` : 'ริมฝีปากเขียวคล้ำ ไม่มีบาดแผล น่าจะเป็นพิษอะไรสักอย่าง';
    else if (kase.cause === 'trap') text = med ? `แผลแตกที่ศีรษะจาก${w.name}ที่ตกลงมา — ทิศทางแผลบอกว่าไม่มีคนลงมือโดยตรง เป็นกับดัก` : `แผลที่ศีรษะ เหมือนโดน${w?.name || 'ของหนัก'}ตกใส่`;
    else if (kase.cause === 'defense') text = med ? 'รอยช้ำหลายแห่งและแผลที่ท้ายทอยจากการต่อสู้ ข้อนิ้วถลอก — เขาเป็นฝ่ายเปิดฉากต่อสู้ก่อนแล้วแพ้' : 'รอยช้ำเต็มตัว เหมือนผ่านการต่อสู้อย่างหนัก';
    else if (w) text = med ? `บาดแผลตรงกับ${w.name}แน่นอน ลงมือ${kase.messy ? 'แบบรีบร้อน มีแผลหลายจุด' : 'ครั้งเดียวแม่นยำ'}` : `บาดแผล${/มีด|กรรไกร|ขวาน|แหลม|ผ่าตัด/.test(w.name) ? 'จากของมีคม' : /ปืน|ธนู|ฉมวก/.test(w.name) ? 'ทะลุจากกระสุนหรือของแหลม' : /เชือก|ม่าน|ผ้า|สายไฟ/.test(w.name) ? 'รอยรัดรอบคอ' : 'จากของหนักทื่อ'}`;
    else text = med ? 'รอยช้ำที่ลำคอและท้ายทอยจากมือเปล่า คนลงมือต้องแข็งแรงพอสมควร' : 'รอยช้ำที่คอ ไม่เห็นอาวุธ';
    const time = med ? `ตายมาแล้ว${this.day - b.day === 0 ? 'ไม่กี่ชั่วโมง (วันนี้เอง)' : `ราว ${this.day - b.day} วัน (วันที่ ${b.day})`}` : this.day - b.day === 0 ? 'ร่างยังอุ่น ตายไม่นาน' : 'ร่างเย็นและแข็งแล้ว ตายมาอย่างน้อยหนึ่งวัน';
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
      this.logTo(p, `🕵 คุณล้วง${it.name}${it.isPart ? ' ⭐ (ของหนี!)' : ''}มาจาก${this.nick(t)}ได้โดยที่เขาไม่รู้ตัว`, 'culprit');
      this.recordEvent(`${this.nick(p)}ขโมย${it.name}จาก${this.nick(t)}`);
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
    const prev = [...this.timeline].reverse().find((tl) => tl.day < this.day || tl.phase !== this.phase);
    if (prev?.positions[t.id]) facts.push(`เมื่อวาน (วันที่ ${prev.day}) ${this.nick(t)}ไปที่${this.zn(prev.positions[t.id])}`);
    if (t.inventory.length) facts.push(`${this.nick(t)}พก${pick(t.inventory).name}อยู่กับตัว`);
    const obj = t.objectives.find((o) => !o.done);
    if (obj) facts.push(`ภารกิจลับของ${this.nick(t)}ตอนนี้คือ "${obj.text}"`);
    if (t.knownBodies.size) facts.push(`${this.nick(t)}รู้ว่า${this.nick(this.players.get([...t.knownBodies][0]))}ตายแล้ว`);
    if (t.kills) facts.push(`${this.nick(t)}หลบตาและเหงื่อแตกเมื่อคุณพูดถึง "คนตาย" — เขาปิดบังเรื่องใหญ่อยู่`);
    const fact = facts.length ? pick(facts) : `${this.nick(t)}ไม่ได้ปิดบังอะไรเป็นพิเศษ`;
    this.logTo(p, `🗣 คุณคุยซักไซ้${this.nick(t)}และอ่านท่าทางเขาออก: ${fact}`, 'evidence');
    this.logTo(t, `🗣 ${this.nick(p)}เข้ามาคุยและซักไซ้คุณนานผิดปกติที่${this.zn(z)} เหมือนพยายามล้วงอะไรบางอย่าง`, 'witness');
    this.recordEvent(`${this.nick(p)}ซักถาม${this.nick(t)}ที่${this.zn(z)}`);
  }

  do_sabotage(p) {
    const z = this.zones.get(p.zoneId);
    const power = z.items.find((i) => i.kind === 'power');
    z.dark = true;
    z.evidence.push(this.makeEvidence(z.id, `${power?.name || 'แผงไฟ'}ถูกสับ/ปิดด้วยมือคน ไม่ใช่ไฟตก`, false, null, 'power'));
    this.logTo(p, `⚡ คุณจัดการ${power?.name || 'แผงไฟ'} ไฟและกล้องใน${this.zn(z)}ดับสนิท วันนี้ใครทำอะไรในห้องนี้ จะไม่มีใครเห็นหน้า`, 'culprit');
    for (const o of this.witnessesOf(p, z)) this.logTo(o, `💡 ไฟใน${this.zn(z)}ดับวูบลง มองเห็นแค่เงา ๆ ของคนในห้อง`, 'witness');
    this.recordEvent(`${this.nick(p)}ตัดไฟที่${this.zn(z)}`);
  }

  do_escape(p, a, escapers) {
    escapers.push(p);
  }

  do_rest() {}

  // คนที่เลือก "สังเกต" มีโอกาสเห็นว่าใครในห้องทำอะไรลับ ๆ ล่อ ๆ
  resolveRest() {
    const shady = new Set(['attack', 'trap', 'clean', 'moveBody', 'hide', 'steal', 'sabotage']);
    for (const [pid, a] of this.actions) {
      if (a.type !== 'rest') continue;
      const p = this.players.get(pid);
      if (!p?.alive) continue;
      const z = this.zones.get(p.zoneId);
      for (const o of this.witnessesOf(p, z)) {
        const oa = this.actions.get(o.id);
        if (oa && shady.has(oa.type) && chance(0.5)) this.logTo(p, `👁 คุณสังเกตว่า${this.who(o, z)}ทำอะไรลับ ๆ ล่อ ๆ อยู่ตรงมุมห้อง${this.zn(z)} เหมือนไม่อยากให้ใครเห็น`, 'witness');
      }
      this.logTo(p, `😶 คุณอยู่เฉย ๆ ที่${this.zn(z)}และสังเกตคนรอบตัว`, 'action');
    }
  }

  resolveEscape(escapers) {
    if (!escapers.length) return;
    const atExit = escapers.filter((p) => p.alive && p.zoneId === this.escape.exitZoneId);
    if (!atExit.length) return;
    const held = new Set();
    for (const p of atExit) for (const it of p.inventory) if (it.isPart) held.add(it.id);
    const missing = this.escape.parts.filter((x) => !held.has(x.id));
    const names = atExit.map((p) => this.nick(p)).join(', ');
    if (!missing.length) {
      this.escape.achieved = true;
      this.systemMessage(`🚪 ${names} เปิดทางออกได้สำเร็จ! ทุกคนที่ยังมีชีวิตหนีออกจาก "${this.location.name}" ได้`);
      for (const p of atExit) this.logTo(p, `🚪 คุณใช้ของหนีครบทุกชิ้น ทางออกเปิดแล้ว!`, 'escape');
      this.recordEvent(`${names} เปิดทางออกสำเร็จ`);
      this.endGame('escape');
      return;
    }
    for (const p of atExit) this.logTo(p, `🚪 คุณพยายามเปิดทางออกที่${this.zn(this.escape.exitZoneId)} แต่ยังขาด: ${missing.map((m) => m.name).join(', ')} (${held.size}/${this.escape.total})`, 'escape');
    for (const o of this.presentIn(this.escape.exitZoneId)) if (!atExit.includes(o)) this.logTo(o, `👀 คุณเห็น${names}พยายามงัดแงะทางออก`, 'witness');
    this.recordEvent(`${names} พยายามเปิดทางออกแต่ยังขาด ${missing.length} ชิ้น`);
  }

  // ---------- objectives ----------
  checkObjectivesAfterMove(p) {
    for (const o of p.objectives) {
      if (o.done) continue;
      if (o.type === 'visit' && o.zoneId === p.zoneId) this.completeObjective(p, o);
      if (o.type === 'meet') {
        const t = this.players.get(o.targetId);
        if (t?.alive && t.zoneId === p.zoneId) this.completeObjective(p, o);
      }
    }
  }

  checkObjectivesAfterTake(p, it) {
    for (const o of p.objectives) if (!o.done && o.type === 'take' && o.itemId === it.id) this.completeObjective(p, o);
  }

  checkObjectivesAfterPlace(p, it, zoneId) {
    for (const o of p.objectives) if (!o.done && o.type === 'plant' && o.itemId === it.id && o.zoneId === zoneId) this.completeObjective(p, o);
  }

  completeObjective(p, o) {
    o.done = true;
    o.doneDay = this.day;
    this.logTo(p, `✅ ภารกิจสำเร็จ: ${o.text}`, 'objective');
  }

  checkDeadlines() {
    if (!CONFIG.OBJECTIVES || this.deadlinesCheckedDay >= this.day) return;
    this.deadlinesCheckedDay = this.day;
    for (const p of this.alivePlayers()) {
      let failed = null;
      for (const o of p.objectives.filter((x) => !x.done && x.deadlineDay <= this.day)) {
        const res = objectiveOutcome(this, p, o);
        if (res === 'done') this.completeObjective(p, o);
        else if (res === 'forgiven') {
          o.done = true;
          o.forgiven = true;
          this.logTo(p, `📋 ภารกิจ "${o.text}" ถูกยกเลิก เพราะเป้าหมายไม่อยู่ในสภาพที่ทำได้แล้ว`, 'objective');
        } else failed = o;
      }
      if (failed) {
        const zname = this.zn(p.zoneId);
        this.killPlayer(p, { cause: 'objective', killerId: null, weapon: null, zoneId: p.zoneId, messy: false, witnesses: [] });
        this.logTo(p, `💀 คุณทำภารกิจ "${failed.text}" ไม่ทันกำหนด... หลังจากทุกคนแยกย้าย ร่างกายของคุณทรุดลงที่${zname} ไม่มีใครรู้ว่าเกิดอะไรขึ้นกับคุณ`, 'death');
        this.recordEvent(`${this.nick(p)}ตายที่${zname}เพราะทำภารกิจไม่ทัน (ไม่มีใครเห็น)`);
      }
      p.objectives = p.objectives.filter((o) => !o.done || (o.doneDay ?? o.deadlineDay) >= this.day - 1);
    }
  }

  // ---------- investigation / trial ----------
  async startInvestigation() {
    this.phase = PHASE.INVESTIGATION;
    this.step = null;
    this.clearTimers();
    this.generating = 'มีคนพบศพ! กำลังประกาศ...';
    const newly = [...this.bodies.values()].filter((b) => !b.judged && !b.announced && b.discoveredBy.size >= 1);
    for (const b of newly) {
      b.announced = true;
      const c = this.caseOf(b.caseId);
      if (c) c.announced = true;
    }
    for (const z of this.zones.values()) z.dark = false;
    for (const p of this.players.values()) p.zoneMemory = {};
    this.emit();
    await this.narrateCases();
    this.announcement = { day: this.day, caseIds: newly.map((b) => b.caseId) };
    const names = newly.map((b) => `${this.nick(this.players.get(b.victimId))} (ที่${this.zn(b.zoneId)})`).join(', ');
    this.systemMessage(`🔔 ประกาศพบศพ! ${names} — เข้าสู่รอบเก็บหลักฐาน: ของในห้องถูกจัดใหม่ ทุกคนเลือกห้องที่จะไปสำรวจ 1 ห้องและทำได้ 1 อย่าง ก่อนเข้าสู่การตัดสิน (ไม่มีภารกิจในรอบนี้)`);
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
        weapon: c.weapon,
        zone: this.zones.get(c.zoneId),
        discoveredZone: this.zones.get(body?.zoneId || c.zoneId),
        day: c.day,
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
    this.systemMessage('⚖ การตัดสินเริ่มขึ้น! เล่าหลักฐานที่แต่ละคนเจอในแชท แล้วโหวต "คนร้าย" — หรือ "ไม่มีคนร้ายให้ลงโทษ" ถ้าเชื่อว่าไม่ใช่ฆาตกรรมหรือคนร้ายตายไปแล้ว · โหวตถูก: คนนั้นถูกประหาร · โหวตผิด: ทุกคนตาย คนร้ายรอด เกมจบ');
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
      timeline: this.timelineSince(this.lastTrialDay + 1),
      bodyThreshold: this.bodyThreshold(),
    };
    this.history.push({
      day: this.day,
      victims: judgedNow.map((c) => this.nick(this.players.get(c.victimId))),
      culprits: judgedNow.filter((c) => c.killerId).map((c) => this.nick(this.players.get(c.killerId))),
      votedName: votedId === NONE_VOTE ? 'ไม่มีคนร้ายให้ลงโทษ' : this.nick(this.players.get(votedId)),
      correct,
    });
    this.lastTrialDay = this.day;
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
      this.systemMessage(`โหวตผิด! ${escaped.length ? `คนร้ายตัวจริงคือ ${escaped.map((id) => this.nick(this.players.get(id))).join(', ')} และรอดไปได้` : 'คดีนี้ไม่มีคนร้าย'} — ทุกคนที่เหลือถูกประหาร เกมจบ`);
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
      victimName: this.charOf(v)?.name || v.name,
      victimPlayer: v.name,
      killerName: k ? this.charOf(k)?.name || k.name : null,
      killerPlayer: k?.name || null,
      killerUltimate: k ? this.charOf(k)?.ultimate?.title || null : null,
      killerFakeUltimate: k && this.charOf(k)?.fakeRole ? this.charOf(k).fakeUltimate?.title || null : null,
      killerAlive: !!k?.alive,
      cause: c.cause,
      causeLabel: CAUSE_LABEL[c.cause] || c.cause,
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

  timelineSince(day) {
    return this.timeline
      .filter((t) => t.day >= day)
      .map((t) => ({
        day: t.day,
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
    if (this.alivePlayers().every((p) => this.ready.has(p.id))) this.nextDay();
  }

  forceStep(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    if (!this.step) throw new GameError('กำลังประมวลผลอยู่');
    this.systemMessage('หัวห้องสั่งไปต่อ — คนที่ยังไม่เลือกจะถูกเลือกให้อัตโนมัติ');
    if (this.step === STEP.MOVE) this.resolveMoves();
    else if (this.step === STEP.ACT) this.resolveActions();
    else this.nextDay();
  }

  nextDay() {
    if (this.phase === PHASE.ENDED) return;
    this.checkDeadlines();
    if (this.escape?.achieved) return this.endGame('escape');
    if (this.alivePlayers().length <= 1) return this.endGame('last_one');
    if (this.day >= CONFIG.MAX_DAYS) return this.endGame('timeout');
    this.day++;
    for (const p of this.players.values()) if (p.stained !== null && p.stained < this.day - 1) p.stained = null;
    this.beginDay();
  }

  // อีเวนต์พิเศษ: ผู้ตายบางคนอาจ "ไม่ได้ตายจริง" และกลับเข้าเกม (เฉพาะคดีที่ตัดสินแล้ว)
  async maybeRevive() {
    const eligible = [...this.players.values()].filter((p) => !p.alive && ['victim', 'perished'].includes(p.fate) && !p.revived && this.bodies.get(p.id)?.judged);
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
    target.revived = true;
    target.revivedDay = this.day + 1;
    target.zoneId = this.location.sleepZoneId;
    target.inventory = [];
    target.objectives = [];
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
    this.computeOutcome();
    for (const c of this.characters) c.ultimateRevealed = true;
    this.phase = PHASE.ENDED;
    this.step = null;
    this.generating = null;
    const msg = {
      escape: '🚪 ทุกคนที่ยังอยู่หนีออกมาได้! เกมจบ',
      wrong_vote: '☠ โหวตผิด — คนร้ายรอด ทุกคนที่เหลือถูกประหาร เกมจบ',
      last_one: '🏁 เหลือผู้รอดชีวิตเพียงคนเดียว เกมจบ',
      timeout: '⏳ ครบกำหนดวัน — ผู้ที่ยังมีชีวิตรอดได้รับการช่วยเหลือ เกมจบ',
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
        fate: p.fate,
        deathCause: p.deathCause,
        deathCauseLabel: p.deathCause ? CAUSE_LABEL[p.deathCause] || null : null,
        eliminatedDay: p.eliminatedDay,
        revived: p.revived,
        kills: p.kills,
      };
    };
    this.outcome = {
      reason: this.endReason,
      survived: all.filter((p) => SURVIVED_FATES.includes(p.fate)).map(row),
      died: all
        .filter((p) => DEAD_FATES.includes(p.fate))
        .sort((a, b) => (a.eliminatedDay || 0) - (b.eliminatedDay || 0))
        .map(row),
      unsolved: this.cases.filter((c) => !c.judged).map((c) => this.caseReveal(c)),
      escapeFound: this.escape ? this.escape.parts.filter((x) => x.found).length : 0,
      escapeTotal: this.escape?.total || 0,
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
          if (inExplore && this.step === STEP.MOVE && !this.moves.has(b.id) && b.alive) this.chooseMove(b.id, this.botPickZone(b));
        }, delay(1500, 3000));
      }
    }
    if (inExplore && this.step === STEP.ACT) {
      for (const b of bots) {
        this.setTimer(() => {
          if ((this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION) && this.step === STEP.ACT && !this.actions.has(b.id) && b.alive) this.chooseAction(b.id, this.botPickAction(b));
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

  botPickZone(b) {
    const obj = b.objectives.find((o) => !o.done && o.zoneId && o.type !== 'plant');
    if (this.phase === PHASE.DAY && obj) {
      if (obj.type === 'take') {
        const z = this.zones.get(obj.zoneId);
        if (z?.items.some((i) => i.id === obj.itemId)) return obj.zoneId;
      } else return obj.zoneId;
    }
    const plant = b.objectives.find((o) => !o.done && o.type === 'plant' && b.inventory.some((i) => i.id === o.itemId));
    if (this.phase === PHASE.DAY && plant) return plant.zoneId;
    if (this.phase === PHASE.INVESTIGATION) {
      const bodyZones = [...this.bodies.values()].filter((x) => x.announced && !x.judged).map((x) => x.zoneId);
      if (bodyZones.length && chance(0.5)) return pick(bodyZones);
    }
    if (b.inventory.filter((i) => i.isPart).length === this.escape.total && chance(0.8)) return this.escape.exitZoneId;
    return pick([...this.zones.keys()].filter((id) => id !== this.location.sleepZoneId)) || this.location.sleepZoneId;
  }

  botPickAction(b) {
    const avail = this.availableActions(b).filter((a) => !a.disabled);
    const byType = (t) => avail.filter((a) => a.type === t);
    const take = byType('take');
    const obj = b.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take' && take.some((a) => a.itemId === o.itemId));
    if (t) return take.find((a) => a.itemId === t.itemId);
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === b.zoneId && b.inventory.some((i) => i.id === o.itemId));
    if (pl) return byType('hide').find((a) => a.itemId === pl.itemId) || byType('drop').find((a) => a.itemId === pl.itemId);
    const escapeAct = byType('escape')[0];
    if (escapeAct && b.inventory.some((i) => i.isPart)) return escapeAct;
    const partTake = take.find((a) => this.zones.get(b.zoneId).items.find((i) => i.id === a.itemId)?.isPart);
    if (partTake) return partTake;
    const examine = byType('examine');
    if (examine.length && chance(this.phase === PHASE.INVESTIGATION ? 0.6 : 0.4)) return pick(examine);
    const attacks = byType('attack');
    if (attacks.length === 1 && (this.designatedId === b.id || b.kills > 0) && this.bestWeapon(b) && chance(0.6)) return attacks[0];
    const weaponTake = take.find((a) => this.zones.get(b.zoneId).items.find((i) => i.id === a.itemId)?.kind === 'weapon');
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
      victim: { playerId: v.id, playerName: v.name, characterName: this.charOf(v)?.name || v.name, nickname: this.nick(v) },
      zoneName: this.zoneName(b?.zoneId || c.zoneId),
      title: c.narrative?.title || 'คดีที่ยังไม่มีชื่อ',
      bodyState: c.narrative?.bodyState || '',
      sceneNotes: c.narrative?.sceneNotes || '',
      judged: c.judged,
    };
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
              ultimate: showFake ? c.fakeUltimate.title : showUlt ? c.ultimate.title : '???',
              ultimateDescription: showFake ? c.fakeUltimate.description : showUlt ? c.ultimate.description : null,
              trait: showFake ? 'none' : showUlt ? c.ultimate.trait : null,
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
    const zonesPublic = this.location
      ? this.location.zones.map((z) => ({ id: z.id, name: z.name, description: z.description, isSleep: z.id === this.location.sleepZoneId, isExit: z.id === this.location.exitZoneId }))
      : [];
    const announced = this.cases.filter((c) => c.announced && (!c.judged || (showResult && this.lastResult?.cases.some((r) => r.id === c.id)))).map((c) => this.publicCase(c));
    const evidenceRows = me
      ? me.evidence
          .map((id) => {
            for (const z of this.zones.values()) {
              const e = z.evidence.find((x) => x.id === id);
              if (e) return { id, zoneName: z.name, text: e.text, day: e.day };
            }
            return null;
          })
          .filter(Boolean)
      : [];
    const myTrait = myChar ? this.traitOf(me) : 'none';
    return {
      code: this.code,
      phase: this.phase,
      step: this.step,
      stepDeadline: this.stepDeadline,
      day: this.day,
      hostId: this.hostId,
      generating: this.generating,
      aiMode: this.ai?.mode || 'mock',
      endReason: this.endReason,
      config: {
        minPlayers: CONFIG.MIN_PLAYERS,
        maxPlayers: CONFIG.MAX_PLAYERS,
        maxDays: CONFIG.MAX_DAYS,
        stepTimeoutMs: CONFIG.STEP_TIMEOUT_MS,
        bodyDiscoverers: CONFIG.BODY_DISCOVERERS,
        inventoryMax: CONFIG.INVENTORY_MAX,
        objectives: CONFIG.OBJECTIVES,
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
            deathCause: me.deathCause,
            deathCauseLabel: me.deathCause ? CAUSE_LABEL[me.deathCause] || null : null,
            revived: me.revived,
            knowsUltimate: me.knowsUltimate,
            ultimateIsHidden: !!myChar?.ultimate?.hidden,
            ultimateHiddenReason: myChar?.ultimate?.hiddenReason || null,
            fakeRole: !!myChar?.fakeRole,
            fakeUltimate: myChar?.fakeRole ? { title: myChar.fakeUltimate.title, description: myChar.fakeUltimate.description } : null,
            ultimateEffect: me.knowsUltimate ? myChar?.ultimate?.investigationEffect || null : null,
            trait: myChar ? { key: myTrait, label: TRAITS[myTrait].label, description: TRAITS[myTrait].description } : null,
            zoneId: me.zoneId,
            zoneName: me.zoneId ? this.zoneName(me.zoneId) : null,
            moveChoice: this.moves.get(me.id) || null,
            actionChoice: this.actions.get(me.id) ? { type: this.actions.get(me.id).type, label: this.actions.get(me.id).label || this.actions.get(me.id).type } : null,
            ready: this.ready.has(me.id),
            myVote: this.votes.get(me.id) || null,
            voteConfirmed: this.confirmedVotes.has(me.id),
            isDesignated: this.phase === PHASE.DAY && this.designatedId === me.id,
            inventory: me.inventory.map((i) => ({ id: i.id, name: i.name, kind: i.kind, isPart: i.isPart, description: i.description })),
            objectives: me.objectives.filter((o) => !o.done || o.doneDay === this.day).map((o) => ({ id: o.id, type: o.type, text: o.text, deadlineDay: o.deadlineDay, done: o.done, forgiven: !!o.forgiven })),
            log: me.log.slice(-120),
            evidence: evidenceRows,
            knownBodies: [...me.knownBodies].map((id) => ({ playerId: id, name: this.nick(this.players.get(id)), zoneName: this.zoneName(this.bodies.get(id)?.zoneId), announced: !!this.bodies.get(id)?.announced })),
            zoneMemory: me.zoneMemory,
            availableActions: me.alive && this.step === STEP.ACT ? this.availableActions(me) : [],
            zonePeople: me.alive && inZoneStep ? this.presentIn(me.zoneId).filter((o) => o.id !== me.id).map((o) => this.nick(o)) : [],
            eventPrivateNote: ev && ev.playerId === me.id ? ev.privateNote : null,
            notices: this.notices.get(me.id) || [],
            // ผู้ชม (ตายแล้ว) เห็นตำแหน่งทุกคนและศพทั้งหมด แต่ไม่เห็นว่าใครเป็นคนร้าย
            spectator: spectator
              ? {
                  positions: this.alivePlayers().map((p) => ({ name: this.nick(p), zoneName: this.zoneName(p.zoneId) })),
                  bodies: [...this.bodies.values()].filter((b) => !b.judged).map((b) => ({ name: this.nick(this.players.get(b.victimId)), zoneName: this.zoneName(b.zoneId), announced: b.announced })),
                }
              : null,
          }
        : null,
      players,
      location: this.location
        ? { name: this.location.name, description: this.location.description, exitDescription: this.location.exitDescription, zones: zonesPublic, sleepZoneId: this.location.sleepZoneId, exitZoneId: this.location.exitZoneId }
        : null,
      escape: this.escape ? { total: this.escape.total, found: this.escape.parts.filter((x) => x.found).length, achieved: this.escape.achieved, exitZoneName: this.zoneName(this.escape.exitZoneId) } : null,
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
