// Game engine — state machine ของบอร์ดเกม (เวอร์ชัน "สำรวจห้อง / ลงมือเอง / หาทางออกที่ซ่อนอยู่")
// เวลาในเกม: ทุกครั้งที่เข้าห้อง (รวมรอบเก็บหลักฐาน) = +1 ชั่วโมง, ตัดสินคดีเสร็จ = ขึ้นวันใหม่ ไม่มีเวลาจำกัด
// ตารางตัวเลข (โอกาสโจมตี สูตรคราฟ กับดัก ทางออก ภารกิจ) อยู่ใน rules.js — อ่านฉบับคนทั่วไปได้ใน BALANCE.md
import { CHARACTERS } from './characters.js';
import { ULTIMATE_POOL, TRAITS } from './mock.js';
import { makeObjective, objectiveOutcome, objectiveTargetZone, hasFood } from './objectives.js';
import { ATTACK, RECIPES, TRAP_TYPES, TRAP_TRIGGER_CHANCE, TRAP_DISARM_CHANCE, TRAP_FAIL_CHANCE, POISON_NOTICE, LOCKS, DOOR, ESCAPE, TRAIT_EFFECTS, KIND_LABEL, PORTABLE_KINDS, woundOf, tagsOf, attackBaseOf, partMatches, trapTexts, poisonNoticeChance, ammoOf, canBreachWith, TAG_LABEL, INVESTIGATION, PASSAGE, POWER, DURABILITY, breakable, tagSetOf, WOUND_LAY, materialOf, trapForensic, TRAP_BODY_POS, TRAP_SCENE, weaponTrace } from './rules.js';
import { buildExits, exitsIn, knowsExit, discoverExit, tryFindExit, onObtainItem, exitActions, doExitPower, resolveExits, exitView, craftAssemblyOptions, doCraftAssembly, doCraftMakeshift, exitReadyFor, exitUsefulFor, requirementText } from './escape.js';

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
  // ต้องมีคน "พบศพ" กี่คน (คนที่ลงมือฆ่าเองนับเป็นคนแรก คนวางกับดัก/ยาพิษไม่นับจนกว่าจะเดินมาเห็นศพเอง) ถึงจะประกาศและเข้าสู่รอบเก็บหลักฐาน
  BODY_DISCOVERERS: Number(process.env.BODY_DISCOVERERS || 3),
  // ล็อกการฆาตกรรม (ปิดโดยค่าเริ่มต้น) เปิดด้วย MURDER_LOCK=true: ถ้ามีศพที่ยังไม่ถูกพบ คนที่ไม่ใช่คนร้ายของคดีนั้นลงมือ/วางกับดัก/วางยาไม่ได้
  // ปิดอยู่ = ใครก็ลงมือได้ทุกเมื่อ มีฆาตกรหลายคนในคดีเดียวได้ → ตอนตัดสินไล่จับทีละคน (ระบบไม่บอกจำนวน)
  MURDER_LOCK: process.env.MURDER_LOCK === 'true',
  INVENTORY_MAX: Number(process.env.INVENTORY_MAX || 3),
  HOURS_PER_DAY: Number(process.env.HOURS_PER_DAY || 24), // ครบชั่วโมงนี้: มีศพที่ยังไม่ถูกพบ → ประกาศพบศพทันที · ไม่มี → ป็อปอัพขึ้นวันใหม่ (ทุกคนกลับห้องนอนรวม)
  // ห้องที่ล็อกไว้ตั้งแต่เริ่มเกม (-1 = อัตโนมัติ: ราว 1 ห้องต่อห้องสำรวจ 6 ห้อง ดู LOCKS.lockedZoneง)
  LOCKED_ZONES: process.env.LOCKED_ZONES !== undefined ? Number(process.env.LOCKED_ZONES) : -1,
  // โอกาสเจอของที่ซ่อนอยู่เมื่อ "สำรวจ" (ของทั่วไป / ของสำหรับทางออก) และโอกาสค้นพบทางออกที่ซ่อนในห้อง
  // ตั้งใน .env ได้เพื่อเทสต์/เดโม (เช่น FIND_EXIT_CHANCE=1 ให้สำรวจเจอทางออกทันที)
  FIND_HIDDEN_CHANCE: process.env.FIND_HIDDEN_CHANCE !== undefined ? Number(process.env.FIND_HIDDEN_CHANCE) : ESCAPE.FIND_HIDDEN_CHANCE,
  FIND_ROUTE_ITEM_CHANCE: process.env.FIND_ROUTE_ITEM_CHANCE !== undefined ? Number(process.env.FIND_ROUTE_ITEM_CHANCE) : ESCAPE.FIND_ROUTE_ITEM_CHANCE,
  FIND_EXIT_CHANCE: process.env.FIND_EXIT_CHANCE !== undefined ? Number(process.env.FIND_EXIT_CHANCE) : ESCAPE.FIND_EXIT_CHANCE,
  // ภารกิจย่อย (ปิดได้ด้วย OBJECTIVES=false) ระยะเวลาตามความยากอยู่ใน rules.js ครบแล้วระบบพาไปทำเอง (ไม่ตาย)
  OBJECTIVES: process.env.OBJECTIVES !== 'false',
  // เจ้าของ Ultimate ที่ถูกซ่อน (???) รู้ของจริงเสมอ
  KNOW_OWN_ULTIMATE_CHANCE: 1,
  // ขอของจาก "บอท" ที่อยู่ห้องเดียวกันได้ตอนพักชั่วโมง (ช่วยทดสอบเกม) ปิดด้วย BOT_REQUESTS=false
  BOT_REQUESTS: process.env.BOT_REQUESTS !== 'false',
  // ผีบอท: ทักทายผีคนใหม่และบ่นเหตุการณ์เด็ด ๆ ในแชทผี ให้คนที่ตายแล้วไม่เหงาแม้เล่นกับบอท (พูดเฉพาะเมื่อมีผีที่เป็นคนจริง) ปิดด้วย BOT_GHOST_CHAT=false
  BOT_GHOST_CHAT: process.env.BOT_GHOST_CHAT !== 'false',
  // ชีตทดสอบ: ปุ่ม "ตายทันที" สำหรับดูโหมดวิญญาณ เปิดด้วย DEBUG_CHEATS=true เท่านั้น
  DEBUG_CHEATS: process.env.DEBUG_CHEATS === 'true',
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
// left_behind = ฆาตกรที่ยังไม่ถูกจับตอนคนอื่นเปิดทางออกได้ — ประตูปิดใส่ นับว่าตายทันที
export const DEAD_FATES = ['victim', 'executed', 'punished', 'left_behind'];
export const SURVIVED_FATES = ['survivor', 'escaped'];
export const CAUSE_LABEL = {
  attack: 'ถูกฆ่า',
  wrongTarget: 'ถูกฆ่า (คนร้ายพลาดเป้า)',
  trap: 'โดนกับดัก',
  defense: 'ถูกสวนกลับขณะพยายามฆ่า',
  executed: 'ถูกประหาร',
  punished: 'ถูกประหารเพราะโหวตผิด',
  left_behind: 'ถูกทิ้งไว้ข้างในตอนคนอื่นหนีออกไป (ฆาตกรที่ยังไม่ถูกจับออกไม่ได้)',
};
// สาเหตุที่นับเป็น "ฆาตกรรม" สำหรับล็อกการฆาตกรรม (ใช้เฉพาะเมื่อ CONFIG.MURDER_LOCK เปิด) — การสวนกลับป้องกันตัวไม่นับ
export const MURDER_CAUSES = ['attack', 'wrongTarget', 'trap'];
export const MURDER_LOCK_MESSAGE = 'มีการฆาตกรรมเกิดขึ้นแล้ว ไม่สามารถทำการฆาตกรรมได้ จนกว่าศพจะถูกพบ';
// ตัดสินถูกแต่ยังมีคดีที่คนร้ายยังมีชีวิต: ระบบบอกข้อความนี้เสมอ (ไม่บอกว่าเหลือกี่คน) แล้วตามหาต่อในวันเดิม
export const MORE_KILLERS_MESSAGE = 'ยังมีฆาตกรอีก 1 คนซ่อนอยู่ในหมู่พวกคุณ';

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
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const sanitizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'ผู้เล่นนิรนาม';
const fill = (tpl, w) => String(tpl || '').replaceAll('{w}', w || 'ของหนัก');
const BLOOD_WOUNDS = ['sharp', 'blunt', 'pierce']; // แผลที่ทำให้ของที่ใช้เปื้อนเลือด (รัด/อุด/พิษ ไม่เปื้อน)

// ประโยคของผีบอทในแชทผี ({n} = ชื่อผีคนใหม่, {e} = เหตุการณ์จริงของชั่วโมงนี้)
const GHOST_WELCOME = [
  'ยินดีต้อนรับสู่ฝั่งนี้ {n} มานั่งดูด้วยกัน ที่นี่ไม่มีใครฆ่าใครได้แล้ว',
  'โอ๊ะ {n} มาแล้วเหรอ นึกว่าจะอยู่ได้นานกว่านี้ซะอีก',
  '{n} เสียใจด้วยนะ แต่ข้างล่างนี้เห็นทุกอย่างเลย สนุกกว่าข้างบนอีก',
  'มาแล้ว {n}! ข้างบนยังไม่รู้เลยว่าใครทำ มาดูกันว่าพวกเขาจะหาเจอไหม',
];
const GHOST_ARRIVE = ['เฮ้ย ฉันก็มาอยู่ฝั่งนี้แล้ว… ข้างบนโหดจริง', 'ตายแล้วเหรอเนี่ย ไม่ทันตั้งตัวเลย ขอนั่งดูด้วยคน', 'โอเค ฉันมาแล้ว ใครเป็นคนทำ เล่าหน่อยสิ'];
const GHOST_REACT = [
  'เมื่อกี้เห็นไหม — {e}',
  'โอ้โห {e} …ข้างบนไม่มีใครรู้เรื่องเลย',
  '{e} ถ้าฉันยังอยู่คงเตือนไปแล้ว',
  'ลุ้นเลย {e} การตัดสินรอบหน้าจะหาเจอไหมนะ',
  'ดูสิ {e} แล้วทำหน้าไม่รู้ไม่ชี้ซะด้วย',
];

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
  outside: false, // ยืนรออยู่หน้าประตูห้อง zoneId (ข้างนอก) เพราะประตูล็อก — ทำอะไรกับห้องไม่ได้ เห็น/ทำได้เฉพาะคนที่อยู่หน้าประตูด้วยกัน
  inventory: [],
  objectives: [],
  nextObjectiveTurn: 0,
  forced: null,
  ko: null, // สลบอยู่ { hours: ชั่วโมงที่เหลือ, since: turn, cause, by } — เลือกห้อง/แอ็กชันไม่ได้ ไม่รับรู้รอบตัว และใครลงมือกับคนสลบสำเร็จแน่นอน
  log: [],
  evidence: [],
  knownBodies: new Set(),
  knownPassages: new Set(), // ทางลับที่ค้นพบแล้ว (id)
  knownCodes: {}, // เศษรหัสที่จำได้ { exitId: Set(id กระดาษ) } — หยิบแล้วจำ วางทิ้งก็ยังจำ
  repairWork: null, // งานซ่อมของค้างอยู่ { itemId, need, progress }
  buffs: { questPlus: 0, koResist: 0 }, // บัฟจากยาที่ผสมในอาหาร: ภารกิจถัดไป +ชั่วโมง · ต้านทานสลบ (ครั้ง)
  powerWork: null, // งานซ่อมเครื่องปั่นไฟค้างอยู่ { need, progress }
  zoneMemory: {},
  stained: null,
  doorWork: null, // งานค้างที่ประตูที่ล็อก { zoneId, method: 'pick'|'break', need, progress }
  caseJudged: false, // คดีที่ตัวเองเป็นเหยื่อถูกตัดสินแล้ว (ใช้กับอีเวนต์คืนชีพ หลังศพถูกเก็บไปแล้ว)
  kills: 0,
  follow: null, // ผี: id ของคนเป็นที่กำลังตามดู (โหมดวิญญาณ)
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
    this.passages = []; // ทางลับ [{ id, a, b }]
    this.dayPopup = null; // ป็อปอัพขึ้นวันใหม่ (ครบ 24 ชั่วโมงโดยไม่มีศพ)
    this.searchedThisHour = new Set();
    this.dayRolledByClock = false; // นาฬิกาข้ามเที่ยงคืนระหว่างรอบเก็บหลักฐาน/ตัดสิน (ขึ้นเลขวันแล้ว ไม่บวกซ้ำตอนเช้าวันใหม่)
    this.powerCooldownUntil = 0; // หลังซ่อมเครื่องปั่นไฟ พังซ้ำไม่ได้จนถึง turn นี้
    this.blackout = null; // ไฟดับทั้งตึก { since, by } จนกว่าจะมีคนซ่อมเครื่องปั่นไฟ
    this.escaped = false;
    this.bodies = new Map();
    this.cases = [];
    this.timeline = [];
    this.ghostWelcomed = new Set(); // ผีที่ผีบอทรับรู้แล้ว (ใช้ทักทายผีคนใหม่)
    this.moves = new Map();
    this.actions = new Map();
    this.presetKoMoves();
    this.ready = new Set();
    this.designatedId = null;
    this.lastTrialTurn = 0;
    this.huntRound = 0; // การตัดสินรอบที่เท่าไรของวันนี้ (ฆาตกรหลายคน → ไล่จับทีละคน)
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

  // คนที่อยู่ "จุดเดียวกัน": ห้องเดียวกันและฝั่งเดียวกันของประตู (ข้างในห้อง / ยืนรอหน้าประตูข้างนอก)
  presentIn(zoneId, outside = false) {
    return this.alivePlayers().filter((p) => p.zoneId === zoneId && !!p.outside === !!outside);
  }

  presentWith(p) {
    return this.presentIn(p.zoneId, p.outside);
  }

  // คนที่รู้สึกตัว (ไม่สลบ) ในจุดนั้น — ใช้กับการเป็นพยาน/การพบศพ · คนสลบยังอยู่ในห้อง (presentIn) และถูกลงมือได้
  awakeIn(zoneId, outside = false) {
    return this.presentIn(zoneId, outside).filter((p) => !p.ko);
  }

  awakeWith(p) {
    return this.awakeIn(p.zoneId, p.outside);
  }

  koHours() {
    return randInt(ATTACK.KO_HOURS[0], ATTACK.KO_HOURS[1]);
  }

  // ทำให้สลบ: เลือกอะไรไม่ได้ (อยู่ที่เดิม ไม่ทำอะไร) ของราวครึ่งหนึ่งหล่นในห้อง และใครลงมือกับคนสลบสำเร็จแน่นอน
  // ถ้าสลบอยู่แล้ว = ต่อเวลา (ไม่ทำของหล่นซ้ำ) · คืนรายชื่อของที่หล่น
  knockOut(p, hours, { cause = 'attack', by = null } = {}) {
    const z = this.zones.get(p.zoneId);
    const dropped = [];
    if (p.buffs?.koResist > 0 && !p.ko) {
      // ยารักษาที่กินไว้: ฝืนไม่สลบ 1 ครั้ง (ของไม่หล่น)
      p.buffs.koResist--;
      this.logTo(p, '💊 ยาที่คุณกินไว้ช่วยให้คุณฝืนไม่สลบ — ตัวยังชา แต่ยังขยับได้', 'action');
      for (const o of this.awakeWith(p)) if (o.id !== p.id) this.logTo(o, `👀 ${this.nick(p)}โซเซไปครู่หนึ่งแล้วตั้งหลักได้ ไม่สลบ`, 'witness');
      this.recordEvent(`${this.nick(p)}ฝืนไม่สลบได้เพราะยาที่กินไว้`);
      return dropped;
    }
    if (!p.ko) {
      const n = Math.ceil(p.inventory.length / 2);
      for (const it of shuffle(p.inventory).slice(0, n)) {
        p.inventory.splice(p.inventory.indexOf(it), 1);
        it.hidden = false;
        z?.items.push(it);
        dropped.push(it.name);
      }
    }
    p.ko = { hours: (p.ko?.hours || 0) + hours, since: this.turn, cause, by };
    p.doorWork = null;
    for (const o of p.objectives) if (!o.done) o.deadlineTurn += hours; // เวลาภารกิจหยุดเดินตอนสลบ
    p.nextObjectiveTurn += hours; // ภารกิจถัดไปก็เลื่อนตาม
    if (this.step === STEP.MOVE) this.moves.set(p.id, p.zoneId);
    if (this.step === STEP.ACT && !this.actions.has(p.id)) this.actions.set(p.id, { type: 'rest', ko: true, auto: true, label: 'สลบอยู่' });
    if (this.step === STEP.REPORT) this.ready.add(p.id);
    return dropped;
  }

  wakeUp(p) {
    p.ko = null;
    this.logTo(p, `🌤 คุณฟื้นขึ้นมาที่${this.spotName(p.zoneId, p.outside)} ตัวยังชาไปหมด แต่ขยับได้แล้ว`, 'action');
  }

  // คนที่สลบอยู่ไม่เลือกห้อง (อยู่ที่เดิม) — เรียกทุกครั้งที่เริ่มขั้นเลือกห้อง
  presetKoMoves() {
    if (!this.players) return; // ยังอยู่ใน constructor
    for (const p of this.alivePlayers()) if (p.ko) this.moves.set(p.id, p.zoneId);
  }

  // โอกาสที่เป้าหมายสวนกลับเมื่อลงมือพลาด (นักสู้ 50% คนทั่วไป 25% · ถืออาวุธ +15% · คนสลบสวนกลับไม่ได้)
  counterChance(target) {
    if (!target?.alive || target.ko) return 0;
    let c = this.traitOf(target) === 'combat' ? ATTACK.COUNTER_COMBAT : ATTACK.COUNTER;
    if (this.bestWeapon(target)) c += ATTACK.COUNTER_ARMED_BONUS;
    return Math.min(0.9, c);
  }

  sameSpot(a, b) {
    return !!a && !!b && a.zoneId === b.zoneId && !!a.outside === !!b.outside;
  }

  bodiesIn(zoneId, outside = false) {
    return [...this.bodies.values()].filter((b) => !b.judged && b.zoneId === zoneId && !!b.outside === !!outside);
  }

  // ชื่อตำแหน่ง: ในห้อง หรือหน้าประตูห้อง
  spotName(zoneId, outside) {
    return outside ? `หน้าประตู${this.zoneName(zoneId)}` : this.zoneName(zoneId);
  }

  // ตำแหน่งในไทม์ไลน์: 'z3' = ในห้อง · 'z3@out' = หน้าประตูข้างนอก
  posKey(p) {
    return p.outside ? `${p.zoneId}@out` : p.zoneId;
  }

  posName(key) {
    const [zid, out] = String(key || '').split('@');
    return this.spotName(zid, !!out);
  }

  caseOf(id) {
    return this.cases.find((c) => c.id === id) || null;
  }

  // ถือกุญแจที่ไขห้องนี้ได้ไหม (กุญแจประจำห้อง หรือกุญแจผู้ดูแลที่ไขได้ทุกห้อง)
  // ของที่ใช้ฆ่าแล้วเกิดแผลมีเลือด (มีคม/ทุบ/ยิง) ติดคราบเลือด — ใครเห็นในมือหรือในห้องก็รู้ จนกว่าจะเอาไปล้างที่ห้องที่มีน้ำ
  stainWeapon(w, rec) {
    if (w && BLOOD_WOUNDS.includes(woundOf(rec || w))) w.bloody = true;
  }

  // ใช้ของแล้วมีโอกาสพัง (ของมีคม/หนัก/เครื่องมือ — ปืน ยา ผ้า เชือกไม่พัง): ของที่พังใช้ลงมือ/คราฟ/งัด/ตัด/ถอดไม่ได้ จนกว่าจะซ่อม
  breakItemMaybe(p, item, prob, context) {
    if (!breakable(item) || !chance(prob)) return false;
    item.broken = true;
    this.logTo(p, `💔 ${item.name}พังระหว่าง${context} — ใช้ไม่ได้จนกว่าจะซ่อม (เลือก "ซ่อม" ตอนถือเชือก/เทป หรือเครื่องมือช่าง)`, 'danger');
    this.recordEvent(`${item.name}ของ${this.nick(p)}พังระหว่าง${context}`);
    return true;
  }

  // ถือของได้กี่ชิ้น: สายนักแบกถือได้ 5 คนอื่นตาม INVENTORY_MAX
  invMax(p) {
    return this.traitOf(p) === 'porter' ? CONFIG.INVENTORY_MAX + 2 : CONFIG.INVENTORY_MAX;
  }

  hasKeyFor(p, zoneId) {
    return p.inventory.some((i) => i.kind === 'key' && i.unlocksZoneIds?.includes(zoneId));
  }

  // คดีฆาตกรรมที่ศพยังไม่ถูกพบ/ประกาศ — คนที่ไม่ใช่คนร้ายของคดีเหล่านั้นลงมือซ้อนไม่ได้
  // วิธีผ่านประตูที่ล็อกโดยไม่มีกุญแจ: ที่สะเดาะกุญแจ (ช่างเทคนิคใช้เครื่องมือช่าง เช่น ไขควง/ประแจ แทนได้) หรือนักสู้พังประตูมือเปล่า
  doorMeans(p, door = this.zones.get(p.zoneId)) {
    const trait = this.traitOf(p);
    const pickItem = p.inventory.find((i) => i.kind === 'lockpick' && !i.broken) || (trait === 'tech' ? p.inventory.find((i) => i.kind === 'tool' && !i.broken && tagsOf(i).has('fastener')) : null);
    if (pickItem && !door?.bar) return { method: 'pick', item: pickItem, hours: DOOR.PICK_HOURS }; // ประตูที่ถูกค้ำสะเดาะไม่ได้ ต้องพัง
    return { method: 'break', item: null, hours: trait === 'combat' ? DOOR.BREAK_HOURS : DOOR.BREAK_HOURS_OTHERS }; // ใครก็พังประตูได้ นักสู้เร็วกว่า
  }

  // บอกวิธีผ่านประตูที่ล็อก (ใช้ตอนเดินชนประตู): มีกุญแจ = ไขทันที · ไม่มี = สะเดาะ/พังเป็นแอ็กชันของชั่วโมง
  doorMeansText(p) {
    const z = this.zones.get(p.zoneId);
    if (z?.bar && !p.outside) return '🚧 ประตูถูกค้ำอยู่จากข้างใน — กด "เอาที่ค้ำออก" ได้ทันที แล้วชั่วโมงถัดไปค่อยออก';
    if (z?.bar) return '🚧 ประตูถูกค้ำจากข้างใน กุญแจ/ที่สะเดาะใช้ไม่ได้ — ในขั้นเลือกแอ็กชัน เลือก 💥 พังประตู ทำซ้ำทุกชั่วโมงจนพัง';
    if (z && this.hasKeyFor(p, z.id)) return 'คุณมีกุญแจ — กด 🔑 ไขกุญแจได้ทันที (ไม่กินชั่วโมง) แล้วชั่วโมงถัดไปค่อยเลือกห้องนี้เพื่อเข้า/ออก';
    const m = this.doorMeans(p, z);
    return m.method === 'break'
      ? `ไม่มีกุญแจ — ในขั้นเลือกแอ็กชัน เลือก 💥 พังประตู (${m.hours[0]}–${m.hours[1]} ชั่วโมง เสียงดัง) ทำซ้ำทุกชั่วโมงจนพัง`
      : `คุณมี${m.item.name} — ในขั้นเลือกแอ็กชัน เลือก 🪛 สะเดาะกลอน (${m.hours[0]}–${m.hours[1]} ชั่วโมง) ทำซ้ำทุกชั่วโมงจนเปิด`;
  }

  // ประตูที่ขวางการย้ายจากห้องปัจจุบันไป zid: ออกจากห้องที่ล็อก (inside) หรือเข้าห้องที่ล็อก (outside) — null ถ้าผ่านได้
  doorBlocking(p, zid) {
    if (!zid) return null;
    // ประตูที่ล็อก/ถูกค้ำขวางทุกคน แม้มีกุญแจ — ต้องกดไขกุญแจ/เอาที่ค้ำออกเอง (doorActions) ก่อน แล้วชั่วโมงถัดไปค่อยเดินผ่าน · ทางลับที่รู้จักไม่ผ่านประตู
    if (!p.outside) {
      if (zid === p.zoneId) return null;
      if (this.passageTo(p, zid)) return null;
      const cur = this.zones.get(p.zoneId);
      if (cur?.locked || cur?.bar) return { zone: cur, side: 'inside' };
    }
    // คนที่ยืนรอหน้าประตูอยู่แล้วเลือกห้องเดิม = พยายามเข้าอีกครั้ง
    const target = this.zones.get(zid);
    if (target?.locked || target?.bar) return { zone: target, side: 'outside' };
    return null;
  }

  // ถูกขังอยู่ในห้องที่ล็อก (คนที่ยืนรอหน้าประตูข้างนอกไม่นับ)
  lockedIn(p) {
    const z = this.zones.get(p.zoneId);
    return !!(z?.locked && !p.outside && !this.hasKeyFor(p, z.id));
  }

  // ถูกขังและ "รู้ตัวแล้ว" (เพิ่งสังเกตตอนต้นชั่วโมง หรือชนประตูมาแล้ว)
  knowsLockedIn(p) {
    return this.lockedIn(p) && p.zoneMemory[p.zoneId]?.locked === true;
  }

  openMurders() {
    return this.cases.filter((c) => MURDER_CAUSES.includes(c.cause) && !c.announced && !c.judged);
  }

  murderLockedFor(p) {
    if (!CONFIG.MURDER_LOCK) return false;
    return this.openMurders().some((c) => c.killerId !== p.id);
  }

  pushChat(msg) {
    this.chat.push({ id: nextId(), ts: Date.now(), phase: this.phase, day: this.day, hour: this.hour, ...msg });
    if (this.chat.length > CONFIG.MAX_CHAT) this.chat.splice(0, this.chat.length - CONFIG.MAX_CHAT);
  }

  systemMessage(text) {
    this.pushChat({ system: true, text });
  }

  notify(playerId, text, kind = 'info', extra = {}) {
    const p = this.players.get(playerId);
    if (!p || p.isBot) return;
    if (!this.notices.has(playerId)) this.notices.set(playerId, []);
    this.notices.get(playerId).push({ id: nextId(), text, kind, ts: Date.now(), ...extra });
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
      t = { day: this.day, hour: this.hour, turn: this.turn, phase: this.phase, positions: Object.fromEntries(this.alivePlayers().map((p) => [p.id, this.posKey(p)])), events: [] };
      this.timeline.push(t);
    }
    t.events.push(text);
  }

  makeEvidence(zoneId, text, hidden, caseId, kind, outside = false) {
    return { id: nextId(), zoneId, text, hidden: !!hidden, caseId: caseId || null, kind, day: this.day, hour: this.hour, outside: !!outside };
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
        `เกมเริ่มแล้ว! ทุกคนตื่นขึ้นมาใน "${loc.name}" — ที่นี่มีทางออกซ่อนอยู่ ${this.exits.size} ทาง (ไม่มีใครรู้ว่าอยู่ห้องไหน) ต้อง "สำรวจ" ห้องให้ละเอียดหรือหาแผนผังให้เจอ แล้วผ่านให้ครบ 4–5 ขั้นต่อทาง (ของที่ซ่อนอยู่ เครื่องมือช่าง ของมีคม และลงแรง)${lockedCount ? ` · บางห้อง (${lockedCount}) ถูกล็อกไว้ ต้องหากุญแจ` : ''} · บางห้องมีอาหารกินได้ · หรือจะเอาตัวรอดด้วยวิธีอื่นก็ได้`,
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
        // กุญแจจากสถานที่ (AI/mock รุ่นเก่า) ถูกตัดทิ้ง — ระบบสร้างกุญแจประจำห้องให้เอง 1 ดอกต่อห้อง ไม่มีกุญแจผู้ดูแล
        items: z.items.filter((it) => it.kind !== 'key').map((it) => ({ ...it, ammo: ammoOf(it), portable: it.portable ?? PORTABLE_KINDS.has(it.kind), master: false, originZoneId: z.id, hidden: false, isPart: false })),
        traps: [],
        evidence: [],
        dark: false,
        water: /ห้องน้ำ|ครัว|อ่าง|ซักล้าง|ซักรีด|สระ|น้ำพุ|พยาบาล|แล็บ|ล้างฟิล์ม|ห้องเครื่อง/.test(z.name), // มีน้ำใช้ล้างคราบเลือดออกจากของได้
        lockable: z.id !== loc.sleepZoneId,
        locked: false,
        broken: false, // ประตูถูกพังแล้ว ล็อกไม่ได้อีก
        keyItemId: null,
      });
    }
    for (const p of this.players.values()) p.zoneId = loc.sleepZoneId;

    const explore = [...this.zones.values()].filter((z) => z.id !== loc.sleepZoneId);
    const want = CONFIG.LOCKED_ZONES >= 0 ? CONFIG.LOCKED_ZONES : LOCKS.lockedZones(explore.length); // ราว 1 ห้องต่อห้องสำรวจ 6 ห้อง
    const toLock = shuffle(explore).slice(0, Math.min(want, Math.max(0, explore.length - 2)));
    for (const z of toLock) z.locked = true;
    // ทางลับ: จับคู่ห้องสำรวจแบบสุ่ม 1 คู่ต่อ 8 ห้อง (อย่างน้อย 1) เดินทะลุกันได้แม้ประตูล็อก/ค้ำ ไม่ผ่านประตู (กับดักประตูไม่ทำงาน) ต้องสำรวจถึงเจอ
    this.passages = [];
    const pz = shuffle(explore.map((z) => z.id));
    const nPass = Math.max(1, Math.floor(explore.length / PASSAGE.PER_ROOMS));
    for (let i = 0; i + 1 < pz.length && this.passages.length < nPass; i += 2) this.passages.push({ id: `pass_${i / 2 + 1}`, a: pz[i], b: pz[i + 1] });
    // ของส่องสว่างสำหรับระบบไฟดับ: อย่างน้อย 2 ชิ้นต่อสถานที่ + แว่นมองกลางคืน 1 ชิ้น (เติมในห้องสำรวจแบบสุ่มถ้าสถานที่ไม่มี)
    const LIGHTS = [['เทียนไขและไม้ขีด', 'จุดส่องสว่างได้นานหลายชั่วโมง'], ['ไฟแช็กเก่า', 'จุดติดยากแต่ยังใช้ได้ ส่องสว่างได้นิดหน่อย'], ['ตะเกียงน้ำมัน', 'น้ำมันยังเหลือครึ่งหนึ่ง จุดส่องสว่างได้']];
    const allItems = () => [...this.zones.values()].flatMap((z) => z.items);
    let lights = allItems().filter((i) => tagsOf(i).has('light')).length;
    for (const [name, description] of shuffle(LIGHTS)) {
      if (lights >= 2) break;
      if (allItems().some((i) => i.name === name)) continue;
      pick(explore).items.push({ id: `it_${nextId()}`, name, description, kind: 'tool', portable: true, hidden: false, isPart: false });
      lights++;
    }
    // ยาบำรุง/ยารักษา (ผสมอาหารเพื่อบัฟ): อย่างน้อยอย่างละ 1 ชิ้นต่อสถานที่
    const MEDS = [['ยาบำรุงกำลัง', 'ขวดสีเหลือง ดื่มแล้วกระปรี้กระเปร่า'], ['ยาแก้ปวดสามัญ', 'แผงยาสามัญประจำบ้าน ช่วยให้ทนอาการมึนงง']];
    for (const [name, description] of MEDS) if (!allItems().some((i) => i.kind === 'medicine' && tagsOf(i).has(tagsOf({ name, description, kind: 'medicine' }).values().next().value))) pick(explore).items.push({ id: `it_${nextId()}`, name, description, kind: 'medicine', portable: true, hidden: false, isPart: false });
    if (!allItems().some((i) => tagsOf(i).has('nightvision'))) pick(explore).items.push({ id: `it_${nextId()}`, name: 'แว่นมองกลางคืน', description: 'มองเห็นในที่มืดได้ — เฉพาะคนที่ใส่', kind: 'tool', portable: true, hidden: true, isPart: false });
    // กุญแจ: ทั้งเกมมี 1–2 ดอก (LOCKS.MAX_KEYS) ดอกหนึ่งไขได้ 1–3 ห้อง (LOCKS.ROOMS_PER_KEY) แต่ละห้องมีกุญแจที่ไขได้ไม่เกินดอกเดียว
    // ห้องที่ล็อกตั้งแต่เริ่มมีกุญแจเสมอ ห้องอื่นบางห้องไม่มีกุญแจเลย (ล็อกไม่ได้ เข้าได้เสมอ) · กุญแจวางให้เห็นในห้องที่ไม่ได้ล็อกและไม่ใช่ห้องที่มันไข
    const openZones = explore.filter((o) => !o.locked);
    const [minRooms, maxRooms] = LOCKS.ROOMS_PER_KEY;
    const lockedNow = explore.filter((z) => z.locked).length;
    // กุญแจต้องพอครอบคลุมห้องที่ล็อกตั้งแต่เริ่ม (ดอกละไม่เกิน maxRooms ห้อง) · เพดานตามขนาดแผนที่
    const keyCount = Math.max(1, Math.min(randInt(Math.max(1, Math.ceil(lockedNow / maxRooms)), LOCKS.maxKeys(explore.length)), explore.length));
    const startLocked = shuffle(explore.filter((z) => z.locked));
    const rest = shuffle(explore.filter((z) => !z.locked));
    const low = Math.max(keyCount * minRooms, startLocked.length);
    const high = Math.max(low, Math.min(keyCount * maxRooms, explore.length - 1)); // เหลืออย่างน้อย 1 ห้องที่ไม่มีกุญแจถ้าทำได้
    const covered = [...startLocked, ...rest].slice(0, randInt(low, high));
    const groups = Array.from({ length: keyCount }, () => []);
    covered.forEach((z, i) => (i < keyCount ? groups[i] : pick(groups.filter((g) => g.length < maxRooms)) || groups[i % keyCount]).push(z));
    groups.forEach((group, i) => {
      if (!group.length) return;
      const names = group.map((z) => z.name);
      const spot = pick(openZones.filter((o) => !group.includes(o))) || this.zones.get(loc.sleepZoneId);
      const key = {
        id: `key_${i + 1}`,
        name: group.length === 1 ? `กุญแจ${names[0]}` : `พวงกุญแจ ${group.length} ดอก`,
        description: `กุญแจเหล็ก${group.length > 1 ? ` ${group.length} ดอกร้อยพวงเดียวกัน` : ''} มีป้ายเขียนว่า "${names.join(' / ')}" — ชุดเดียวในที่นี้ที่ใช้ล็อกและปลดล็อกประตูห้องเหล่านั้นได้`,
        kind: 'key',
        portable: true,
        hidden: false,
        isPart: false,
        unlocksZoneIds: group.map((z) => z.id),
        originZoneId: spot.id,
      };
      spot.items.push(key);
      for (const z of group) z.keyItemId = key.id;
    });
    // ที่สะเดาะกุญแจอย่างน้อย 1 ชิ้นต่อสถานที่ (ถ้าสถานที่ไม่ได้ให้มา)
    if (![...this.zones.values()].some((z) => z.items.some((i) => i.kind === 'lockpick'))) {
      const spot = pick(openZones) || this.zones.get(loc.sleepZoneId);
      spot.items.push({ id: 'lockpick_1', name: 'ชุดไขควงและเหล็กงัดกลอน', description: 'ไขควงปากแบนหลายขนาดกับเหล็กงอปลายแหลม ใช้สะเดาะกลอนประตูที่ล็อกได้ (ใช้เวลา 2–3 ชั่วโมง)', kind: 'lockpick', portable: true, hidden: false, isPart: false, originZoneId: spot.id });
    }
    // ทางออกและของที่ต้องใช้ (ซ่อนหลังจากรู้แล้วว่าห้องไหนล็อก)
    buildExits(this, loc);
  }

  // ---------- day / hour loop ----------
  // วันใหม่: สุ่มฆาตกรประจำวัน แล้วเริ่มชั่วโมงแรก
  beginDay() {
    this.phase = PHASE.DAY;
    this.generating = null;
    this.hour = this.dayRolledByClock ? this.hour : 0; // ข้ามเที่ยงคืนมาแล้ว → นับชั่วโมงต่อจากเดิม
    this.dayRolledByClock = false;
    this.huntRound = 0;
    const alive = this.alivePlayers();
    this.designatedId = alive.length >= 2 ? pick(alive).id : null;
    this.systemMessage(`— วันที่ ${this.day} — ทุกครั้งที่เข้าห้องนับเป็น 1 ชั่วโมง วันนี้จะจบลงเมื่อการตัดสินปิดคดีครบทุกคดี`);
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
  // เดินนาฬิกา 1 ชั่วโมง — เลยชั่วโมงสุดท้ายของวัน (24) แล้วขึ้นเลขวันใหม่โดยไม่รีเซ็ต (ใช้เมื่อรอบเก็บหลักฐาน/ตัดสินคร่อมเที่ยงคืน)
  advanceHour() {
    this.hour++;
    this.turn++;
    if (this.hour > CONFIG.HOURS_PER_DAY) {
      this.day++;
      this.hour = 1;
      this.dayRolledByClock = true;
      this.systemMessage(`🕛 เที่ยงคืน — เข้าสู่วันที่ ${this.day} (นับชั่วโมงใหม่ แต่เหตุการณ์ยังดำเนินต่อ)`);
    }
  }

  beginTurn() {
    this.phase = PHASE.DAY;
    this.step = STEP.MOVE;
    this.advanceHour();
    this.moves = new Map();
    this.actions = new Map();
    this.presetKoMoves();
    this.ready = new Set();
    for (const z of this.zones.values()) z.dark = false;
    const alive = this.alivePlayers();
    // ภารกิจค้างได้ทีละข้อ และภารกิจใหม่จะมาเมื่อครบชั่วโมงของข้อเดิมเท่านั้น (ทำเสร็จก่อนก็ต้องรอ)
    if (CONFIG.OBJECTIVES) for (const p of alive) if (!p.ko && p.objectives.every((o) => o.done) && this.turn >= p.nextObjectiveTurn) this.assignObjective(p); // คนสลบยังไม่ได้ภารกิจใหม่
    this.enforceObjectives();
    this.systemMessage(`🕐 ${this.timeLabel()} — เลือกห้องที่จะไป (ไม่มีใครเห็นว่าใครเลือกอะไร)`);
    this.emit();
    if (alive.every((p) => this.moves.has(p.id))) return this.resolveMoves();
    this.armStepTimer();
    this.scheduleBots();
  }

  weaponHint(p) {
    const cands = [];
    for (const z of this.zones.values()) for (const it of z.items) if (it.kind === 'weapon' && !it.hidden && (attackBaseOf(it, null)?.base || 0) >= ATTACK.WEAPON_BASE.weapon) cands.push({ it, z });
    if (!cands.length) return '';
    const { it, z } = pick(cands);
    return `${it.name}อยู่ที่${this.zn(z)}`;
  }

  assignObjective(p) {
    const o = makeObjective(this, p);
    if (!o) return;
    if (p.buffs?.questPlus) {
      o.hours += p.buffs.questPlus;
      o.deadlineTurn += p.buffs.questPlus;
      this.logTo(p, `💊 ยาบำรุงที่กินไว้ให้เวลาภารกิจเพิ่ม ${p.buffs.questPlus} ชั่วโมง`, 'objective');
      p.buffs.questPlus = 0;
    }
    p.objectives.push(o);
    if (p.objectives.length > 4) p.objectives.splice(0, p.objectives.length - 4);
    p.nextObjectiveTurn = o.deadlineTurn;
    this.logTo(p, `📋 ภารกิจใหม่ (${o.hours} ชั่วโมง): ${o.text} — ละเลยได้ แต่ถ้าครบกำหนดแล้วยังไม่ทำ จะโดนลงโทษ: สลบ 1–3 ชั่วโมง ของบางชิ้นหล่น และระหว่างสลบใครลงมือกับคุณก็สำเร็จแน่นอน`, 'objective');
  }

  // ครบกำหนดภารกิจแล้วยังไม่ทำ → ไม่บังคับทำ แต่โดนลงโทษ: สลบ 1–3 ชั่วโมง ของบางชิ้นหล่นในห้อง และระหว่างสลบใครลงมือกับคนนั้นสำเร็จแน่นอน
  // ภารกิจที่ทำไม่ได้แล้วโดยไม่ใช่ความผิดผู้เล่น (ของหาย เป้าหมายตาย ถูกขัง สลบอยู่) ถูกยกเลิกโดยไม่มีโทษ
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
        forgive(due.forgiveReason || 'เป้าหมายไม่อยู่ในสภาพที่ทำได้แล้ว');
        continue;
      }
      if (this.lockedIn(p)) {
        forgive('คุณถูกล็อกอยู่ในห้อง');
        continue;
      }
      if (p.ko) {
        forgive('คุณสลบอยู่');
        continue;
      }
      due.done = true;
      due.failed = true;
      due.doneTurn = this.turn;
      const hours = this.koHours();
      const dropped = this.knockOut(p, hours, { cause: 'objective' });
      p.ko.since = this.turn - 1; // สลบตั้งแต่ต้นชั่วโมง ชั่วโมงนี้นับด้วย
      this.logTo(p, `⏰ ครบกำหนดภารกิจ "${due.text}" แล้วคุณยังไม่ทำ — ระบบลงโทษ: แก๊สพ่นออกจากช่องแอร์ใส่คุณ คุณหมดสติที่${this.spotName(p.zoneId, p.outside)} ${hours} ชั่วโมง${dropped.length ? ` ของหล่นจากมือ: ${dropped.join(', ')}` : ''} — ระหว่างนี้คุณทำอะไรไม่ได้ และใครลงมือกับคุณก็สำเร็จแน่นอน`, 'danger');
      for (const o of this.awakeWith(p)) if (o.id !== p.id) this.logTo(o, `😵 ${this.nick(p)}ล้มลงหมดสติอยู่ตรงหน้าคุณ (ระบบลงโทษเรื่องภารกิจ)${dropped.length ? ` ของหล่นกระจาย: ${dropped.join(', ')}` : ''}`, 'witness');
      this.recordEvent(`${this.nick(p)}ถูกลงโทษเพราะละเลยภารกิจ สลบ ${hours} ชม. ที่${this.zn(p.zoneId)}`);
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
    if (p.ko) throw new GameError('😵 คุณสลบอยู่ ขยับไม่ได้จนกว่าจะฟื้น');
    if (zoneId !== p.zoneId && !this.passageTo(p, zoneId) && this.knowsLockedIn(p)) throw new GameError(`🔒 คุณถูกล็อกอยู่ใน${this.zoneName(p.zoneId)} ออกไม่ได้ — เลือกอยู่ห้องนี้ต่อ แล้วในขั้นเลือกแอ็กชันค่อยสะเดาะ/พังประตู (หรือรอคนมาเปิด)`);
    if (zoneId !== p.zoneId && !p.outside && !this.passageTo(p, zoneId) && this.zones.get(p.zoneId)?.bar) throw new GameError('🚧 ประตูห้องนี้ถูกค้ำอยู่ — กด "เอาที่ค้ำออก" (ทันที) ก่อนแล้วค่อยเลือกห้อง');
    this.moves.set(playerId, zoneId);
    this.emit();
    if (this.alivePlayers().every((a) => this.moves.has(a.id))) this.resolveMoves();
  }

  // ผ่านประตู: ห้องที่ล็อกขวางทั้งคนนอก (เข้าไม่ได้ → ยืนรอหน้าประตูข้างนอก ไม่เด้งกลับห้องเดิม) และคนใน (ออกไม่ได้) ถ้าไม่มีกุญแจ — มีที่สะเดาะ/เป็นนักสู้จึง "ทำงานกับประตู" ได้ทีละชั่วโมง
  // คืนตำแหน่งที่ไปถึงจริงในชั่วโมงนี้ { zoneId, outside } · openers = คนที่เปิดประตูที่ล็อกอยู่ในชั่วโมงนี้ (ผ่านด้วยกุญแจ หรือสะเดาะ/พังสำเร็จ) ใช้ให้กับดักประตูเล่นงานคนนี้ก่อน
  passDoor(p, zid, alive, bounced, busy, openers = new Set()) {
    const block = this.doorBlocking(p, zid);
    if (!block) {
      p.doorWork = null; // ไปทางอื่นแล้ว งานค้างที่ประตูเดิมเริ่มใหม่
      // คนที่เพิ่งไขกุญแจ/สะเดาะ/พังประตูบานนี้ (ชั่วโมงนี้หรือชั่วโมงก่อน) แล้วเดินผ่าน = "คนเปิดประตู" (กับดักประตูเล่นงานคนนี้ก่อน)
      const opened = (zone) => !!zone?.unlockedBy && zone.unlockedBy.id === p.id && zone.unlockedBy.turn >= this.turn - 1;
      const entering = zid !== p.zoneId || p.outside;
      if (entering && opened(this.zones.get(zid))) openers.add(p.id);
      if (!p.outside && zid !== p.zoneId && opened(this.zones.get(p.zoneId))) openers.add(p.id);
      return { zoneId: zid, outside: false };
    }
    const door = block.zone;
    p.zoneMemory[door.id] = { ...(p.zoneMemory[door.id] || {}), day: this.day, hour: this.hour, phase: this.phase, locked: true, lockedSeenTurn: this.turn };
    bounced.add(p.id);
    // ไม่มีการทำงานกับประตูอัตโนมัติ: ไขกุญแจ (ทันที) / สะเดาะ / พัง เป็นสิ่งที่ผู้เล่นต้องกดเองในขั้นเลือกแอ็กชัน
    const how = this.doorMeansText({ ...p, zoneId: door.id });
    this.logTo(
      p,
      block.side === 'inside'
        ? `🔒 คุณจะออกจาก${this.zn(door)}แต่พบว่าประตูถูกล็อกไว้ — ${how}`
        : `🔒 คุณเดินไปถึง${this.zn(door)}แต่ประตูล็อกอยู่ เข้าไม่ได้ — คุณยืนรออยู่หน้าประตู (ข้างนอก) ทำอะไรกับห้องไม่ได้ และเห็น/ทำได้เฉพาะคนที่ยืนอยู่หน้าประตูด้วยกัน · ${how}`,
      'danger',
    );
    return { zoneId: door.id, outside: block.side === 'outside' };
  }

  resolveMoves() {
    this.clearTimers();
    const alive = this.alivePlayers();
    const positions = {};
    const prevPos = new Map(alive.map((p) => [p.id, { zoneId: p.zoneId, outside: !!p.outside }]));
    const openers = new Set(); // คนที่เปิดประตูที่ล็อกอยู่ในชั่วโมงนี้ (กับดักประตูเล่นงานคนนี้ก่อน)
    const bounced = new Set();
    const busy = new Map(); // pid → ข้อความแอ็กชันของคนที่ใช้ชั่วโมงนี้ไปกับประตู
    const viaPassage = new Set(); // คนที่เดินผ่านทางลับ (ไม่ผ่านประตู กับดักประตูไม่ทำงาน)
    for (const p of alive) {
      const target = this.moves.get(p.id) || p.zoneId || this.location.sleepZoneId;
      if (target !== p.zoneId && this.passageTo(p, target)) viaPassage.add(p.id);
      const pos = this.passDoor(p, target, alive, bounced, busy, openers);
      p.zoneId = pos.zoneId;
      p.outside = !!pos.outside;
      positions[p.id] = this.posKey(p);
    }
    this.timeline.push({ day: this.day, hour: this.hour, turn: this.turn, phase: this.phase, positions, events: [] });
    const wasInside = (p, zid) => {
      const pp = prevPos.get(p.id);
      return !!pp && pp.zoneId === zid && !pp.outside;
    };

    // กับดักประตู: ทำงานทันทีที่ประตูห้องนั้นถูกเปิดในทิศที่วางไว้ (ไม่มีโอกาสรอด) — วางข้างใน: คนที่เปิดประตูเข้ามาโดน · วางข้างนอก: คนที่เปิดประตูออกไปโดน
    // คนที่ปลดล็อกประตูในชั่วโมงนี้โดนก่อนเสมอ ถ้าหลายคนผ่านพร้อมกันสุ่ม 1 คน · คนวางไม่โดนกับดักของตัวเอง
    // กับดักทำงานเฉพาะกลางวัน — ช่วงเก็บหลักฐานไม่มีใครตาย
    if (this.phase === PHASE.DAY) for (const z of this.zones.values()) {
      for (const trap of z.traps.filter((t) => t.item.trapType === 'door')) {
        const entered = alive.filter((p) => p.alive && p.zoneId === z.id && !p.outside && !wasInside(p, z.id) && !viaPassage.has(p.id));
        const left = alive.filter((p) => p.alive && wasInside(p, z.id) && !(p.zoneId === z.id && !p.outside) && !viaPassage.has(p.id));
        const pool = (trap.side === 'outside' ? left : entered).filter((p) => p.id !== trap.setterId);
        if (!pool.length) continue;
        const victim = pool.find((p) => openers.has(p.id)) || pick(pool);
        this.triggerTrap(z, trap, victim);
      }
    }

    // กับดักทั่วไปทำงานตอนมีคนเข้าห้อง (คนที่เพิ่งเข้ามาเท่านั้น คนที่อยู่ในห้องอยู่แล้วไม่โดน · คนที่ยืนรอหน้าประตูข้างนอกยังไม่ได้เข้า)
    if (this.phase === PHASE.DAY) for (const z of this.zones.values()) {
      if (!z.traps.some((t) => t.item.trapType !== 'door')) continue;
      for (const p of shuffle(alive.filter((x) => x.alive && x.zoneId === z.id && !x.outside && !wasInside(x, z.id)))) {
        const trap = z.traps.find((t) => t.setterId !== p.id && t.item.trapType !== 'door');
        if (!trap) continue;
        const blind = !this.canSee(p); // มืดและไม่มีแสง: มองไม่เห็นกับดัก โดนแน่นอน
        const disarm = blind ? 0 : TRAP_DISARM_CHANCE + (this.traitOf(p) === 'detective' ? 0.2 : 0);
        const r = blind ? 0 : Math.random();
        if (!blind && r < disarm) {
          z.traps.splice(z.traps.indexOf(trap), 1);
          z.items.push({ ...trap.item, hidden: false });
          z.evidence.push(this.makeEvidence(z.id, `${trap.item.name}ถูกตั้งไว้เป็นกับดักที่ทางเข้า และมีคนปลดออกแล้ว`, false, null, 'trap'));
          this.logTo(p, `⚠ ทันทีที่จะเข้า${this.zn(z)}คุณสังเกตเห็น${trap.item.name}ตั้งไว้เป็นกับดัก (${TRAP_TYPES[trap.item.trapType]?.label || ''}) คุณปลดมันออกได้ทัน — มีคนตั้งใจจะฆ่าใครสักคนที่เข้ามาห้องนี้`, 'danger');
          this.recordEvent(`${this.nick(p)}พบและปลดกับดัก (${trap.item.name}) ที่${this.zn(z)}`);
        } else if (blind || r < disarm + TRAP_TRIGGER_CHANCE) {
          this.triggerTrap(z, trap, p);
        }
      }
    }

    // ใครอยู่ที่ไหนกับใคร เห็นของอะไร เจอศพไหม
    for (const p of alive) {
      if (!p.alive) continue;
      const z = this.zones.get(p.zoneId);
      if (p.ko) {
        // สลบอยู่: ไม่รับรู้อะไรรอบตัว (ไม่เห็นคน ของ ศพ หรือร่องรอย)
        this.logTo(p, `😵 คุณยังสลบอยู่ที่${this.spotName(p.zoneId, p.outside)} (ฟื้นในอีก ${p.ko.hours} ชั่วโมง) ไม่รู้ว่ารอบตัวเกิดอะไรขึ้น`, 'move');
        continue;
      }
      // ยืนรอหน้าประตูห้องที่ล็อก (ข้างนอก): มองไม่เห็นในห้อง เห็นเฉพาะคนและศพที่อยู่หน้าประตูด้วยกัน
      if (p.outside) {
        const mates = this.canSee(p) ? this.presentWith(p).filter((o) => o.id !== p.id) : []; // มืด = ไม่เห็นใคร
        const lines = [`📍 คุณอยู่หน้าประตู${this.zn(z)}(ข้างนอก) — ประตูล็อกอยู่ เข้าไม่ได้ สำรวจ/หยิบ/วางของในห้องไม่ได้ และทำได้เฉพาะกับคนที่ยืนอยู่หน้าประตูด้วยกัน`];
        lines.push(mates.length ? `คนที่ยืนอยู่หน้าประตูด้วย: ${mates.map((o) => `${this.nick(o)}${o.ko ? ' (สลบอยู่)' : ''}`).join(', ')}` : 'ไม่มีใครอยู่หน้าประตูนอกจากคุณ');
        const means = this.doorMeansText(p);
        if (means) lines.push(means);
        for (const b of this.bodiesIn(z.id, true)) {
          const v = this.players.get(b.victimId);
          const first = !p.knownBodies.has(b.victimId);
          p.knownBodies.add(b.victimId);
          b.discoveredBy.add(p.id); // คนวางกับดัก/ยาพิษที่เดินมาเห็นศพเองก็นับ
          lines.push(first ? `☠ คุณพบศพของ${this.nick(v)}อยู่หน้าประตูนี้!${b.announced ? '' : ' ยังไม่มีการประกาศ — คุณจะบอกใครหรือไม่ก็ได้'}` : `☠ ศพของ${this.nick(v)}ยังอยู่หน้าประตูนี้`);
        }
        for (const e of z.evidence.filter((x) => x.outside && !x.hidden && !x.gone && !p.evidence.includes(x.id))) {
          p.evidence.push(e.id);
          lines.push(`🧩 ร่องรอยหน้าประตู: ${e.text}`);
        }
        for (const o of mates) if (o.stained === this.turn - 1 && chance(0.4)) lines.push(`👀 เสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่ยังไม่ได้ซัก`);
        if (z.traps.some((t) => t.setterId === p.id && t.side === 'outside')) lines.push('🪤 กับดักประตูของคุณยังติดอยู่หน้าประตูนี้');
        p.zoneMemory[z.id] = { ...(p.zoneMemory[z.id] || {}), day: this.day, hour: this.hour, phase: this.phase, locked: true, lockedSeenTurn: this.turn };
        this.logTo(p, lines.join(' · '), 'move');
        continue;
      }
      if (!this.canSee(p)) {
        // มืด: ไม่เห็นคน ของ ศพ หรือร่องรอย (เว้นคนใส่แว่นมองกลางคืน) — คลำหาของได้ (แอ็กชัน) แต่เทรดกันไม่ได้
        this.logTo(p, `📍 คุณมาถึง${this.zn(z)}${viaPassage.has(p.id) ? ' (ผ่านทางลับ)' : ''} — 🌑 มืดสนิท มองไม่เห็นใครและไม่เห็นของในห้อง${this.hasLight(p) ? '' : ' (ต้องมีเทียน/ไฟฉาย/ไฟแช็กถึงจะเห็น)'}`, 'move');
        p.zoneMemory[z.id] = { day: this.day, hour: this.hour, phase: this.phase, dark: true, people: [], items: [], bodies: [], locked: z.locked, broken: z.broken, barred: !!z.bar, food: false, searched: p.zoneMemory[z.id]?.searched };
        this.checkObjectivesAfterMove(p);
        continue;
      }
      const others = this.presentIn(z.id).filter((o) => o.id !== p.id);
      const bodies = this.bodiesIn(z.id);
      const visibleItems = z.items.filter((i) => !i.hidden);
      const stayed = bounced.has(p.id) || wasInside(p, z.id);
      const knewLocked = p.zoneMemory[z.id]?.locked === true;
      const lines = [bounced.has(p.id) ? `📍 คุณยังอยู่ที่${this.zn(z)}` : stayed ? `📍 คุณอยู่ที่${this.zn(z)}ต่อ` : `📍 คุณมาถึง${this.zn(z)}${viaPassage.has(p.id) ? ' (ผ่านทางลับ ไม่ได้ผ่านประตู)' : ''}${z.bar ? ' · 🚧 ประตูห้องนี้ถูกค้ำจากข้างใน' : ''}`];
      // การล็อก/ปลดล็อกทำเงียบ ๆ — คนที่อยู่ในห้องอยู่แล้วเพิ่งสังเกตเห็นสถานะประตูตอนต้นชั่วโมงถัดไป
      if (stayed && z.locked && !knewLocked) lines.push(this.hasKeyFor(p, z.id) ? '🔒 คุณเพิ่งสังเกตว่าประตูห้องนี้ถูกล็อกไว้ — คุณมีกุญแจ จะปลดล็อกหรือเดินออกไปก็ได้' : `🔒 คุณเพิ่งสังเกตว่าประตูห้องนี้ถูกล็อกไว้จากข้างนอก — คุณถูกขังอยู่ ${this.doorMeansText(p) || 'ออกไม่ได้จนกว่าจะมีกุญแจ ที่สะเดาะกุญแจ หรือมีคนมาเปิดให้'}`);
      if (stayed && !z.locked && knewLocked) lines.push('🔓 คุณสังเกตว่าประตูห้องนี้ไม่ได้ล็อกแล้ว');
      lines.push(others.length ? `คนที่อยู่ที่นี่ด้วย: ${others.map((o) => `${this.nick(o)}${o.ko ? ' (นอนสลบอยู่ — ใครลงมือกับเขาสำเร็จแน่นอน)' : ''}`).join(', ')}` : 'ไม่มีใครอยู่ที่นี่นอกจากคุณ');
      lines.push(visibleItems.length ? `ของที่เห็น: ${visibleItems.map((i) => `${i.name}${i.isPart ? ' ⭐' : ''}${i.broken ? ' 💔พัง' : ''}${i.bloody ? ' 🩸เปื้อนเลือด' : ''}${this.tagText(i) ? ` (${this.tagText(i)})` : ''}`).join(', ')}` : 'ไม่เห็นของอะไรเป็นพิเศษ');
      for (const b of bodies) {
        const v = this.players.get(b.victimId);
        const first = !p.knownBodies.has(b.victimId);
        p.knownBodies.add(b.victimId);
        b.discoveredBy.add(p.id); // คนวางกับดัก/ยาพิษที่เดินมาเห็นศพเองก็นับ
        lines.push(first ? `☠ คุณพบศพของ${this.nick(v)}อยู่ที่นี่!${this.bodyPosText(b)}${b.announced ? '' : ' ยังไม่มีการประกาศ — คุณจะบอกใครหรือไม่ก็ได้'}` : `☠ ศพของ${this.nick(v)}ยังอยู่ที่นี่`);
      }
      for (const o of others) {
        if (o.stained === this.turn - 1 && chance(0.4)) lines.push(`👀 เสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่ยังไม่ได้ซัก`);
      }
      if (z.traps.some((t) => t.setterId === p.id && t.side !== 'outside')) lines.push(`🪤 กับดักของคุณยังอยู่ที่นี่`);
      const known = exitsIn(this, z.id).filter((x) => knowsExit(p, x));
      if (known.length) lines.push(`🚪 ทางออกที่คุณรู้จักในห้องนี้: ${known.map((x) => x.name).join(', ')}`);
      p.zoneMemory[z.id] = {
        day: this.day,
        hour: this.hour,
        phase: this.phase,
        people: others.map((o) => `${this.nick(o)}${o.ko ? ' (สลบ)' : ''}`),
        items: visibleItems.map((i) => `${i.name}${i.bloody ? ' 🩸' : ''}`),
        bodies: bodies.map((b) => this.nick(this.players.get(b.victimId))),
        locked: z.locked,
        broken: z.broken,
        barred: !!z.bar,
        food: hasFood(z),
        searched: p.zoneMemory[z.id]?.searched,
      };
      this.logTo(p, lines.join(' · '), 'move');
      this.checkObjectivesAfterMove(p);
    }

    if (this.checkEarlyEnd()) return;
    if (this.checkBodyThreshold()) return;
    this.step = STEP.ACT;
    // คนที่ใช้ชั่วโมงนี้ไปกับประตู (สะเดาะ/พัง) ทำอย่างอื่นไม่ได้
    for (const [pid, label] of busy) if (this.players.get(pid)?.alive) this.actions.set(pid, { type: 'doorwork', label, busy: true, auto: true });
    // คนที่สลบอยู่ไม่ทำอะไรในชั่วโมงนี้
    for (const p of this.alivePlayers()) if (p.ko && !this.actions.has(p.id)) this.actions.set(p.id, { type: 'rest', ko: true, auto: true, label: 'สลบอยู่' });
    this.emit();
    if (this.alivePlayers().every((p) => this.actions.has(p.id))) return this.resolveActions();
    this.armStepTimer();
    this.scheduleBots();
  }

  // กับดักทำงาน · กับดักประตูที่วางข้างนอกเล่นงานคนที่กำลังออกมา → ศพอยู่หน้าประตู (ข้างนอก) และคนนั้นไปไม่ถึงปลายทาง
  triggerTrap(z, trap, victim) {
    z.traps.splice(z.traps.indexOf(trap), 1);
    const setter = this.players.get(trap.setterId) || null;
    const tt = trapTexts(trap.item.trapType, trap.item.wound);
    const w = trap.item.weaponName || trap.item.name;
    const outside = trap.item.trapType === 'door' && trap.side === 'outside';
    if (outside) {
      victim.zoneId = z.id;
      victim.outside = true;
    }
    const where = outside ? `หน้าประตู${this.zn(z)}` : this.zn(z);
    const kase = this.killPlayer(victim, { cause: 'trap', trapType: trap.item.trapType, killerId: setter?.id || null, weapon: { name: w, kind: tt.weaponKind, tags: trap.item.strikerTags || [] }, zoneId: z.id, outside, messy: false, witnesses: [] }); // อาวุธของคดี = ชิ้นที่ทำร้ายจริง ไม่ใช่ชื่อกับดักทั้งชุด
    // ร่องรอยในห้อง (ต้องสำรวจถึงเจอ): เลือด/รอยไหม้ตรงประตู + ตัวอุปกรณ์ที่ยังค้างอยู่ตรงนั้น — กับดักที่ทำงานแล้วเหลือแค่ "ของชิ้นที่ทำร้าย" เป็นของธรรมดาในห้อง
    // (ตอนเข้าห้องเห็นแค่ "ขวานดับเพลิง" ไม่ใช่ "กับดักประตู") ใครเก็บมันไปจะเหลือเศษร่องรอยแทน ดู markDeviceTaken
    const scene = TRAP_SCENE[trap.item.trapType];
    const device = { id: `it_${nextId()}`, name: w, description: trap.item.strikerDesc || '', kind: trap.item.strikerKind || 'weapon', portable: true, hidden: false, isPart: false, originZoneId: z.id, deviceOf: { caseId: kase.id, trapType: trap.item.trapType }, bloody: BLOOD_WOUNDS.includes(trap.item.wound) };
    if (Number.isInteger(trap.item.strikerAmmo)) device.ammo = Math.max(0, trap.item.strikerAmmo - (trap.item.wound === 'pierce' ? 1 : 0)); // ปืนที่ลั่นไปแล้วเสียกระสุน 1 นัด
    z.items.push(device);
    // เครื่องมือที่ใช้ยึดกลไก (ไขควง/ประแจ) ยังตกอยู่ตรงนั้น — เชือก/สายถือว่าถูกตัด/ใช้ไปกับกลไก
    if (trap.item.otherPart?.kind === 'tool') z.items.push({ id: `it_${nextId()}`, name: trap.item.otherPart.name, description: trap.item.otherPart.description || '', kind: 'tool', portable: true, hidden: false, isPart: false, originZoneId: z.id });
    if (scene) {
      z.evidence.push(this.makeEvidence(z.id, scene.blood, false, kase.id, 'blood', outside));
      z.evidence.push({ ...this.makeEvidence(z.id, fill(scene.device, w), false, kase.id, 'trap', outside), deviceItemId: device.id });
    }
    this.logTo(victim, `💀 ${fill(tt.trigger, w)} ที่${where}คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
    for (const o of this.awakeIn(z.id, outside)) {
      o.knownBodies.add(victim.id);
      this.bodies.get(victim.id).discoveredBy.add(o.id);
      this.logTo(o, `😱 ต่อหน้าคุณ ${this.nick(victim)}ล้มลงที่${outside ? 'หน้าประตู' : 'ทางเข้า'}${this.zn(z)}และเสียชีวิต — ${tt.label} ไม่มีใครแตะต้องเขาเลย ต้องเป็นกับดักที่มีคนวางไว้ก่อน`, 'witness');
    }
    if (setter?.alive) this.logTo(setter, `🪤 ${trap.item.trapType === 'door' ? 'กับดักประตู' : 'กับดัก'} (${trap.item.name}) ที่คุณวางไว้ที่${where}ทำงานแล้ว — ${this.nick(victim)}ตาย คุณคือคนร้ายของคดีนี้`, 'culprit');
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
    victim.ko = null;
    victim.doorWork = null;
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
      weapon: info.weapon ? { name: info.weapon.name, kind: info.weapon.kind, tags: Array.isArray(info.weapon.tags) ? info.weapon.tags : [...tagsOf(info.weapon)] } : null,
      zoneId: info.zoneId,
      outside: !!info.outside,
      messy: !!info.messy,
      moved: false,
      witnesses: info.witnesses || [],
      present: this.presentIn(info.zoneId, info.outside).map((p) => p.id),
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
      outside: !!info.outside,
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
      // คนที่ลงมือฆ่าเอง (ไม่ใช่กับดัก/ยาพิษ) เห็นศพเป็นคนแรก — นับเป็นผู้พบศพคนที่ 1 ของการประกาศ
      if (k && info.cause !== 'trap') {
        this.bodies.get(victim.id).discoveredBy.add(k.id);
        k.knownBodies.add(victim.id);
      }
    }
    return kase;
  }

  // ตำแหน่งศพที่เห็นได้ทันทีตอนพบ (ไม่บอกกลไก): ศพจากกับดักประตูนอนอยู่ตรงธรณีประตู ฯลฯ ถ้าถูกย้ายแล้วไม่มีเบาะแสนี้
  bodyPosText(b) {
    const c = this.caseOf(b.caseId);
    if (!c || c.cause !== 'trap' || b.moved) return '';
    const pos = TRAP_BODY_POS[c.trapType];
    return pos ? ` ร่างนอนอยู่${pos}` : '';
  }

  // จบเกมก่อนกำหนด: เหลือคนเดียว · เหลือน้อยกว่า ⌊ผู้เล่นทั้งหมด/3⌋ · หรือคนที่เหลือทุกคนล้วนเคยฆ่า → ผู้ที่เหลือรอดทันที
  earlyEndReason() {
    const alive = this.alivePlayers();
    if (alive.length <= 1) return 'last_one';
    if (alive.length <= Math.floor(this.players.size / 3)) return 'few_left';
    if (alive.every((p) => p.kills > 0)) return 'only_killers';
    return null;
  }

  checkEarlyEnd() {
    const reason = this.earlyEndReason();
    if (!reason) return false;
    this.endGame(reason);
    return true;
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
    const hasInjector = !!this.injectorOf(p);
    let best = null;
    let bestScore = 0;
    for (const it of p.inventory) {
      const s = attackBaseOf(it, trait, hasInjector)?.base || 0; // ดูแท็กของ: สมุด/วิทยุ/ไฟฉาย = 0 · ยาพิษต้องมีเข็มหรือเป็นสายการแพทย์
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    return best;
  }

  // เข็มฉีดยาในมือ (พาหะสำหรับวางยาตรง)
  injectorOf(p) {
    return p.inventory.find((i) => tagsOf(i).has('injector')) || null;
  }

  // โอกาสลงมือสำเร็จ พร้อมรายละเอียดการคำนวณ (แสดงให้ผู้เล่นเห็นตอนเลือก)
  attackBreakdown(p, target, weapon, witnessCount, zone) {
    const parts = [];
    const trait = this.traitOf(p);
    let base;
    const ab = attackBaseOf(weapon, trait, !!this.injectorOf(p));
    const lethal = weapon && ab ? ab.lethal : trait === 'combat' ? ATTACK.LETHALITY.unarmedCombat : ATTACK.LETHALITY.unarmed; // โอกาสฆ่าเมื่อสำเร็จ (ที่เหลือ = สลบ) · นักสู้ต่อยฆ่าได้ 5%
    if (target?.ko) return { chance: ATTACK.KO_SURE, lethal, parts: [{ label: 'เป้าหมายสลบอยู่ ต้านไม่ได้', value: ATTACK.KO_SURE }], text: 'เป้าหมายสลบอยู่ 100%' };
    if (!weapon || !ab) {
      base = ATTACK.UNARMED;
      parts.push({ label: trait === 'combat' ? 'มือเปล่า (นักสู้ ฆ่าได้ 5%)' : 'มือเปล่า (ทำให้สลบเท่านั้น)', value: base });
    } else {
      base = ab.base;
      parts.push({ label: ab.label, value: base });
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
    if (zone && this.darkAt(zone.id, p.outside)) add('มืด', ATTACK.DARK_BONUS);
    const chanceValue = clamp(total, ATTACK.MIN, ATTACK.MAX);
    return { chance: chanceValue, lethal, parts, text: parts.map((x, i) => `${i ? (x.value >= 0 ? ' + ' : ' − ') : ''}${x.label} ${Math.round(Math.abs(x.value) * 100)}%`).join('') };
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
      const a = p.inventory.find((i) => partMatches(i, r, 0)); // เช็กแท็ก: ใบมีดเหวี่ยงต้องมีคม/หนัก ของหนักหล่นต้องหนัก ไฟช็อตต้องเครื่องมือช่าง+สายไฟจริง กับดักประตูต้องปืนมีกระสุน/มีคม/หนัก + เครื่องมือช่าง
      const b = p.inventory.find((i) => i !== a && partMatches(i, r, 1));
      if (!a || !b) continue;
      const placeOk = !r.placeNeeds || z.items.some((i) => i.kind === r.placeNeeds);
      out.push({ type: 'craft', recipeId: r.id, itemId: a.id, itemId2: b.id, label: `🛠 ประกอบ "${r.name}" จาก${a.name} + ${b.name}`, desc: `${r.desc} — ใช้เวลา 1 ชั่วโมง ของทั้งสองชิ้นจะถูกใช้ไป ได้กับดัก 1 ชิ้นไว้วางทีหลัง${placeOk ? '' : ` (วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]})`}` });
    }
    out.push(...craftAssemblyOptions(this, p)); // ชุดชิ้นส่วนของทางออก (ถือชิ้นส่วนครบ 2 ชิ้น)
    return out;
  }

  // หยิบ/วาง/ซ่อนของ ทำได้ทันทีไม่กินชั่วโมง (ทั้งตอนเลือกแอ็กชันและตอนพักชั่วโมง) แล้วยังเลือกแอ็กชันหลักได้อีก 1 อย่าง · ยืนรอหน้าประตูข้างนอกทำไม่ได้
  itemActions(p) {
    const z = this.zones.get(p.zoneId);
    if (!z || !p.alive || p.ko || p.outside || !this.canSee(p)) return []; // มืด: หยิบได้แค่คลำ (แอ็กชัน)
    const out = [];
    const invFull = p.inventory.length >= this.invMax(p);
    for (const it of z.items.filter((i) => !i.hidden && i.portable)) {
      out.push({ type: 'take', itemId: it.id, label: `🖐 หยิบ ${it.name}${it.isPart ? ' ⭐' : ''}`, desc: it.description, disabled: invFull, reason: invFull ? `ถือของได้สูงสุด ${this.invMax(p)} ชิ้น วางของก่อน` : '' });
    }
    // ซ่อนของเป็นแอ็กชันของชั่วโมง (availableActions: ซ่อนได้หลายชิ้นในครั้งเดียว) — ตรงนี้มีแค่หยิบ/วาง
    for (const it of p.inventory) out.push({ type: 'drop', itemId: it.id, label: `⬇ วาง ${it.name} ไว้ในห้องนี้`, desc: 'ใครเข้ามาก็เห็นทันที' });
    return out;
  }

  // ทำทันที (ไม่รอประมวลผลชั่วโมง): หยิบ/วาง/ซ่อน — คนในห้องอาจเห็นเหมือนเดิม
  instantItemAction(playerId, action) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    if (this.step !== STEP.ACT && this.step !== STEP.REPORT) throw new GameError('หยิบ/วางของได้ตอนอยู่ในห้องแล้ว (ช่วงเลือกแอ็กชันหรือพักชั่วโมง)');
    const p = this.alivePlayer(playerId);
    if (p.ko) throw new GameError('😵 คุณสลบอยู่ ทำอะไรไม่ได้จนกว่าจะฟื้น');
    const match = this.itemActions(p).find((a) => a.type === action?.type && a.itemId === action?.itemId);
    if (!match) throw new GameError('ทำแอ็กชันนี้ไม่ได้');
    if (match.disabled) throw new GameError(match.reason || 'ทำแอ็กชันนี้ไม่ได้');
    this[`do_${match.type}`](p, match);
    this.emit();
    return match;
  }

  availableActions(p) {
    const z = this.zones.get(p.zoneId);
    if (!z || !p.alive || p.ko) return [];
    const trait = this.traitOf(p);
    const outside = !!p.outside; // ยืนรอหน้าประตูห้องที่ล็อก: ทำอะไรกับห้องไม่ได้ ทำได้เฉพาะกับคนที่อยู่หน้าประตูด้วยกัน
    const dark = !this.canSee(p); // ไฟดับและไม่มีแสง: เห็นแค่เงา ทำได้ไม่กี่อย่าง
    const others = this.presentWith(p).filter((o) => o.id !== p.id);
    const bodies = outside || dark ? [] : this.bodiesIn(z.id);
    let out = [];
    const inDay = this.phase === PHASE.DAY;
    if (!outside) out.push({ type: 'search', label: '🔍 สำรวจห้องอย่างละเอียด', desc: 'หาของที่ซ่อนอยู่ ทางออกที่ซ่อนอยู่ หลักฐาน และสังเกตว่ามีอะไรหายไปจากห้อง' });
    // หยิบ/วางของทำได้ทันทีผ่าน itemActions()/instantItemAction() · ซ่อนของใช้ชั่วโมง แต่ซ่อนจากกระเป๋ากี่ชิ้นก็ได้ในครั้งเดียว
    if (!outside && z.water && p.inventory.some((i) => i.bloody)) out.push({ type: 'wash', label: '🚿 ล้างคราบเลือดออกจากของที่ถือ', desc: 'ใช้ทั้งชั่วโมง ล้างทุกชิ้นที่เปื้อน — อ่าง/ร่องท่ออาจเหลือคราบจาง ๆ ให้คนที่สำรวจละเอียดเจอ (50%) และคนในห้องอาจเห็นคุณล้าง', danger: true });
    // ซ่อมของที่พัง: ต้องถือเชือก/เทป (หมดไป 1 ชิ้น) หรือเครื่องมือช่าง (ไม่หมด) ใช้ 1–2 ชั่วโมง (ช่างเทคนิค 1) ทำซ้ำจนเสร็จ
    const fixer = p.inventory.find((i) => !i.broken && tagsOf(i).has('fastener')) || p.inventory.find((i) => !i.broken && (i.kind === 'rope' || tagsOf(i).has('cord')));
    if (!outside && fixer) {
      for (const it of p.inventory.filter((i) => i.broken)) {
        const prog = p.repairWork?.itemId === it.id ? ` (ทำไปแล้ว ${p.repairWork.progress} ชม.)` : '';
        out.push({ type: 'repairItem', itemId: it.id, label: `🔧 ซ่อม${it.name}${prog}`, desc: `ใช้ทั้งชั่วโมง ราว ${trait === 'tech' ? DURABILITY.REPAIR_HOURS_TECH[0] : `${DURABILITY.REPAIR_HOURS[0]}–${DURABILITY.REPAIR_HOURS[1]}`} ชั่วโมง ด้วย${fixer.name}${tagsOf(fixer).has('fastener') ? ' (เครื่องมือไม่หมด)' : ' (ใช้หมดไป 1 ชิ้น)'}` });
      }
    }
    if (!outside && p.inventory.length) out.push({ type: 'hide', multiItems: true, label: '🫥 ซ่อนของไว้ในห้องนี้ (เลือกได้หลายชิ้น)', desc: 'ใช้ทั้งชั่วโมง ซ่อนของจากกระเป๋ากี่ชิ้นก็ได้ — คนอื่นต้องสำรวจละเอียดถึงจะเจอ (คนในห้องอาจเห็นคุณซ่อน 30%)' });
    const food = outside ? null : z.items.find((i) => i.kind === 'food');
    if (food && inDay) out.push({ type: 'eat', label: `🍞 กินอาหาร/ดื่มน้ำ (${food.name})`, desc: 'พักกินอะไรสักหน่อย — ใช้ทำภารกิจ "ไปกินอาหาร" ได้ · ระวัง ถ้ามีคนผสมยาพิษไว้คุณอาจไม่รู้ตัว' });
    // ล็อก/ปลดล็อกด้วยกุญแจทำได้ทันที (doorActions) · สะเดาะ/พังประตูที่ล็อกเป็นแอ็กชันของชั่วโมง ทำซ้ำทุกชั่วโมงจนสำเร็จ
    const doorTarget = outside ? (z.locked || z.bar ? z : null) : z.locked && !this.hasKeyFor(p, z.id) && p.zoneMemory[z.id]?.locked === true ? z : null;
    if (doorTarget) {
      const m = this.doorMeans(p, doorTarget);
      const w = doorTarget.doorWork?.[m.method] || null; // ความคืบหน้ารวมของทุกคนที่ทำประตูบานนี้
      const prog = w ? ` (คืบหน้ารวม ${w.progress})` : '';
      if (m.method === 'pick') out.push({ type: 'doorwork', label: `🪛 สะเดาะกลอน${this.zn(doorTarget)}ด้วย${m.item.name}${prog}`, desc: `ใช้ทั้งชั่วโมง ราว ${m.hours[0]}–${m.hours[1]} ชั่วโมง (สุ่มตอนเริ่ม) เสร็จแล้วประตูเปิด (ล็อกใหม่ได้) ชั่วโมงถัดไปค่อยเลือกห้องเพื่อเข้า/ออก · คนอีกฝั่งอาจได้ยินเสียงแกรกกราก` });
      else out.push({ type: 'doorwork', label: `💥 พังประตู${this.zn(doorTarget)}${doorTarget.bar ? 'ที่ถูกค้ำ' : ''}ด้วยมือเปล่า${prog}`, desc: `ใช้ทั้งชั่วโมง ราว ${m.hours[0]}–${m.hours[1]} ชั่วโมง (สุ่มตอนเริ่ม · นักสู้ ${DOOR.BREAK_HOURS[0]}–${DOOR.BREAK_HOURS[1]} ชม.) ประตูพังแล้วล็อกไม่ได้อีก · เสียงดัง คนอีกฝั่งได้ยินแน่ คนห้องอื่นอาจได้ยิน`, danger: true });
    }
    if (inDay) {
      for (const o of others) {
        const w = this.bestWeapon(p);
        const bd = this.attackBreakdown(p, o, w, others.length - 1, z);
        const sure = !!(w && (attackBaseOf(w, trait, !!this.injectorOf(p))?.lethal || 0) > 0); // ของฆ่าได้ → คนสลบตายแน่
        if (o.ko && !sure) {
          // ต่อยคนสลบไม่มีประโยชน์ (ไม่ให้วนสลบซ้ำ) — คนสลบโดนได้เฉพาะของที่ฆ่าได้
          out.push({ type: 'attack', targetId: o.id, label: `🔪 ลงมือกับ ${this.nick(o)} (สลบอยู่)`, desc: '', disabled: true, reason: 'เขาสลบอยู่แล้ว — มือเปล่า/ยาสลบทำอะไรเขาไม่ได้อีก ต้องถือของที่ฆ่าได้ถึงจะลงมือกับคนสลบได้', danger: true });
          continue;
        }
        out.push({
          type: 'attack',
          targetId: o.id,
          label: `🔪 ลงมือกับ ${this.nick(o)}${o.ko ? ' (สลบอยู่)' : ''}${w ? ` ด้วย${w.name}${w.kind === 'poison' && this.injectorOf(p) ? ` (ฉีดด้วย${this.injectorOf(p).name})` : ''}${tagsOf(w).has('firearm') ? ` (เหลือ ${w.ammo ?? 0} นัด ทั้งตึกจะได้ยินเสียง)` : ''}` : ' ด้วยมือเปล่า'}`,
          desc: o.ko
            ? `เขาสลบอยู่ ต้านไม่ได้ — สำเร็จแน่นอน: ${sure ? 'ของที่คุณถือฆ่าได้ เขาจะตาย' : bd.lethal > 0 ? `มือเปล่า: ฆ่า ${Math.round(bd.lethal * 100)}% ไม่งั้นสลบต่ออีก 1–3 ชั่วโมง` : 'มือเปล่า/ยาสลบฆ่าไม่ได้ จะทำให้เขาสลบต่ออีก 1–3 ชั่วโมง'}`
            : `โอกาสสำเร็จราว ${Math.round(bd.chance * 100)}% (${bd.text}) · ถ้าสำเร็จ: ${bd.lethal > 0 ? `ฆ่า ${Math.round(bd.lethal * 100)}% / สลบ ${100 - Math.round(bd.lethal * 100)}%` : 'ทำให้สลบเท่านั้น ไม่ตาย'}${others.length > 1 ? ` · มีคนอื่นในห้องอีก ${others.length - 1} คน (อาจเห็น หรือโดนลูกหลง)` : ''} · พลาดแล้วเขาจะรู้ตัว และอาจสวนกลับ ${Math.round(this.counterChance(o) * 100)}%${this.bestWeapon(o) ? ' (เขาถืออาวุธ ผลตามอาวุธของเขา: ฆ่าหรือทำให้คุณสลบ)' : ' (เขามือเปล่า = ทำให้คุณสลบ)'}`,
          danger: true,
        });
      }
      out.push(...this.craftOptions(p, z));
      // วางกับดักได้ฝั่งละ 1 ชิ้นต่อคน · ข้างนอก (หน้าประตูห้องที่ล็อก) วางได้เฉพาะกับดักประตู
      const mySide = outside ? 'outside' : 'inside';
      if (!z.traps.some((t) => t.setterId === p.id && (t.side || 'inside') === mySide)) {
        for (const it of p.inventory.filter((i) => i.kind === 'trap' && (!outside || i.trapType === 'door'))) {
          const r = RECIPES.find((x) => x.trapType === it.trapType);
          const ok = !r?.placeNeeds || z.items.some((i) => i.kind === r.placeNeeds);
          if (it.trapType === 'door') {
            out.push({ type: 'trap', itemId: it.id, label: `🪤 ติดตั้ง "${it.name}" ที่ประตูห้องนี้ทาง${outside ? 'ข้างนอก' : 'ข้างใน'}`, desc: `${outside ? 'ใครก็ตามที่เปิดประตูออกมาจากห้องนี้จะโดน' : 'ใครก็ตามที่เปิดประตูเข้ามาจะโดน'} (ไม่มีโอกาสรอด · คนที่ปลดล็อกประตูโดนก่อน ถ้าหลายคนพร้อมกันสุ่ม 1 คน · คุณเองไม่โดน) ถ้าเขาตาย คุณคือคนร้าย`, danger: true });
            continue;
          }
          out.push({ type: 'trap', itemId: it.id, label: `🪤 วางกับดัก "${it.name}" ที่ทางเข้าห้องนี้`, desc: `${TRAP_TYPES[it.trapType]?.label || ''} — คนต่อไปที่เข้ามา (ที่ไม่ใช่คุณ) มีโอกาสโดน ${Math.round(TRAP_TRIGGER_CHANCE * 100)}% ถ้าเขาตาย คุณคือคนร้าย`, danger: true, disabled: !ok, reason: ok ? '' : `วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]}` });
        }
      }
      if (food && !food.buff) {
        for (const it of p.inventory.filter((i) => i.kind === 'medicine')) {
          const tonic = tagsOf(it).has('tonic');
          out.push({ type: 'mixFood', itemId: it.id, label: `💊 ผสม${it.name}ลงใน${food.name}`, desc: tonic ? 'ใครมากินอาหารนี้จะได้เวลาภารกิจถัดไป +1 ชั่วโมง (รวมตัวคุณเองถ้ากิน)' : 'ใครมากินอาหารนี้จะต้านทานการสลบได้ 1 ครั้ง (รวมตัวคุณเองถ้ากิน)' });
        }
      }
      if (food && !food.poisoned) {
        for (const it of p.inventory.filter((i) => i.kind === 'poison' && !tagsOf(i).has('bloodOnly'))) {
          // พิษที่ต้องเข้ากระแสเลือด (พิษแมงกะพรุน) ผสมอาหารไม่ได้ · ยากลิ่นฉุนสังเกตง่าย ยาไร้สีไร้รสสังเกตยาก
          const pt = [...tagsOf(it)];
          out.push({ type: 'poisonFood', itemId: it.id, label: `☠ ผสม${it.name}ลงใน${food.name}`, desc: `ใครก็ตามที่มากินอาหารในห้องนี้${pt.includes('sedative') ? 'จะสลบ 1–3 ชั่วโมง (ยานอนหลับ/ยาสลบไม่ฆ่าใคร)' : 'มีโอกาสตาย'} (คนทั่วไปสังเกตทัน ${Math.round(poisonNoticeChance('none', pt) * 100)}% สายการแพทย์/ช่างสังเกต ${Math.round(poisonNoticeChance('medical', pt) * 100)}%${pt.includes('pungent') ? ' — กลิ่นฉุน สังเกตง่าย' : pt.includes('tasteless') ? ' — ไร้สีไร้รส สังเกตยาก' : ''}) ถ้าเขาตาย คุณคือคนร้าย${trait === 'medical' ? ' · คุณเป็นสายการแพทย์ ผสมได้เนียน' : ''}`, danger: true });
        }
      }
    }
    for (const b of bodies) {
      const v = this.players.get(b.victimId);
      out.push({ type: 'examine', victimId: b.victimId, label: `🔎 ตรวจศพของ ${this.nick(v)}`, desc: trait === 'medical' ? 'ความรู้ทางการแพทย์ของคุณจะบอกชนิดของที่ใช้ ทิศทางแผล เวลาตายที่แน่นอน และว่าศพถูกย้ายหรือไม่ (ไม่บอกชื่อของ)' : 'ดูชนิดบาดแผล ตำแหน่งศพ และเวลาตายคร่าว ๆ (สายการแพทย์เห็นละเอียดกว่า) — ของที่ใช้ต้องหาในห้องเอง' });
      out.push({ type: 'moveBody', victimId: b.victimId, label: `🚚 ย้ายศพของ ${this.nick(v)} ไปห้องอื่น`, desc: 'ทิ้งรอยลากไว้ทั้งสองห้อง และคนในห้องอาจเห็น', needsZone: true, danger: true });
    }
    if (!outside && z.evidence.some((e) => !e.hidden && !e.outside && !e.gone && !['door', 'power'].includes(e.kind))) {
      out.push({ type: 'clean', label: '🧹 เก็บกวาด/ทำลายร่องรอยในห้องนี้', desc: `ซ่อนหลักฐานที่มองเห็นได้ในห้องนี้${trait === 'stealth' || trait === 'medical' ? ' (คุณถนัดเรื่องนี้ 75%)' : ' (สำเร็จ 50%)'} — ทำพลาดอาจยิ่งทิ้งร่องรอย`, danger: true });
    }
    if (trait === 'stealth') for (const o of others) out.push({ type: 'steal', targetId: o.id, label: `🕵 ล้วงกระเป๋า ${this.nick(o)}`, desc: 'ขโมยของ 1 ชิ้นจากเขา (สำเร็จ 70%) โดยที่เขาอาจไม่รู้ตัว' });
    if (trait === 'social') for (const o of others) out.push({ type: 'interrogate', targetId: o.id, label: `🗣 ซักถาม ${this.nick(o)}`, desc: 'รู้ความจริงเกี่ยวกับเขา 1 ข้อ (เขาจะรู้ว่าคุณซักถาม)' });
    if (!outside && trait === 'tech' && z.items.some((i) => i.kind === 'power') && !z.dark) out.push({ type: 'sabotage', label: '⚡ ตัดไฟ/กล้องในห้องนี้', desc: 'ชั่วโมงนี้พยานในห้องนี้จะจำหน้าคนลงมือไม่ได้ (รวมถึงสิ่งที่คุณทำด้วย)' });
    if (!outside) out.push(...exitActions(this, p, z));
    out.push({ type: 'rest', label: '😶 ไม่ทำอะไร แค่สังเกตคนอื่น', desc: 'มีโอกาสเห็นว่าใครในห้องทำอะไรลับ ๆ ล่อ ๆ' });
    // ไฟดับ: ซ่อมเครื่องปั่นไฟได้ที่ห้องที่มีแผงไฟ (ใช้ชั่วโมง) · ในความมืดทำได้แค่ลงมือ ล้วงกระเป๋า ซ่อนของ กินอาหาร ทำประตู ซ่อมไฟ หรือคลำหาของ
    if (this.blackout && !outside && z.items.some((i) => i.kind === 'power')) {
      const need = trait === 'tech' ? POWER.REPAIR_HOURS_TECH : POWER.REPAIR_HOURS;
      out.push({ type: 'repairPower', label: `🔧 ซ่อมเครื่องปั่นไฟ${z.powerWork ? ` (คืบหน้ารวม ${z.powerWork.progress})` : ''}`, desc: `ใช้ทั้งชั่วโมง ราว ${need[0]}–${need[1]} ชั่วโมง (ช่างเทคนิคเสร็จในชั่วโมงเดียว) ทำซ้ำจนเสร็จ — หลายคนซ่อมพร้อมกันแรงจะรวมกัน แล้วไฟติดทั้งตึก` });
    }
    if (dark) {
      const allowed = new Set(['steal', 'hide', 'eat', 'poisonFood', 'mixFood', 'doorwork', 'repairPower', 'rest']);
      out = out.filter((a) => allowed.has(a.type));
      // ลงมือในความมืด: ไม่เห็นว่าใครเป็นใคร → สุ่มโดนใครสักคน ไม่มีชื่อในบันทึกของทั้งคนลงมือและคนโดน
      const wDark = this.bestWeapon(p);
      const sureDark = !!(wDark && (attackBaseOf(wDark, trait, !!this.injectorOf(p))?.lethal || 0) > 0);
      const victims = others.filter((o) => !o.ko || sureDark);
      if (inDay && victims.length) out.push({ type: 'attack', targetId: 'random', label: '🔪 ลงมือกับคนในห้องอย่างสุ่ม (มืด)', desc: `มองไม่เห็นว่าใครเป็นใคร — จะไปโดนใครสักคนในห้องนี้ ไม่มีใครรู้ว่าใครทำ และคุณก็ไม่รู้ว่าโดนใคร${wDark ? ` · ใช้${wDark.name}` : ' · มือเปล่า (ทำให้สลบเท่านั้น)'}`, danger: true });
      if (!outside && z.items.some((i) => !i.hidden && i.portable) && p.inventory.length < this.invMax(p)) out.push({ type: 'grope', label: '🖐 คลำหาของในความมืด', desc: 'ได้ของสุ่ม 1 ชิ้นจากห้องนี้แล้วจบชั่วโมง — รู้ว่าได้อะไรก็ต่อเมื่อคลำดูแล้ว' });
    }
    return out;
  }

  chooseAction(playerId, action) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    this.assertStep(STEP.ACT);
    const p = this.alivePlayer(playerId);
    if (p.ko) throw new GameError('😵 คุณสลบอยู่ ทำอะไรไม่ได้จนกว่าจะฟื้น');
    if (this.actions.get(playerId)?.busy) throw new GameError('ชั่วโมงนี้คุณใช้เวลาไปกับประตูแล้ว ทำอย่างอื่นไม่ได้');
    action = action || {};
    const same = (a, k) => (a[k] ?? null) === (action[k] ?? null);
    const match = this.availableActions(p).find((a) => a.type === action.type && same(a, 'targetId') && same(a, 'itemId') && same(a, 'victimId') && same(a, 'recipeId') && same(a, 'exitId') && same(a, 'step'));
    if (!match) throw new GameError('ทำแอ็กชันนี้ไม่ได้');
    if (match.disabled) throw new GameError(match.reason || 'ทำแอ็กชันนี้ไม่ได้');
    // ล็อกการฆาตกรรม: ถ้ามีศพที่ยังไม่ถูกพบ คนที่ไม่ใช่คนร้ายของคดีนั้นลงมือซ้อนไม่ได้ (ระบบบอกคนที่พยายามเท่านั้น)
    if (['attack', 'trap', 'poisonFood'].includes(match.type) && this.murderLockedFor(p)) {
      this.logTo(p, `🔒 คุณพยายามจะ${match.type === 'attack' ? 'ลงมือ' : 'วางกับดัก'} แต่ระบบของที่นี่แจ้งว่า: ${MURDER_LOCK_MESSAGE} — แปลว่าตอนนี้มีศพซ่อนอยู่ที่ไหนสักแห่ง`, 'danger');
      this.emit();
      throw new GameError(`🔒 ${MURDER_LOCK_MESSAGE}`);
    }
    const chosen = { ...match };
    if (match.multiItems) {
      const ids = [...new Set((Array.isArray(action.itemIds) ? action.itemIds : [action.itemId]).map(String))].filter((id) => p.inventory.some((i) => i.id === id));
      if (!ids.length) throw new GameError('เลือกของที่จะซ่อนอย่างน้อย 1 ชิ้น');
      chosen.itemIds = ids;
    }
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
    this.searchedThisHour = new Set();
    for (const p of this.alivePlayers()) if (!this.actions.has(p.id)) this.actions.set(p.id, { type: 'rest', auto: true });
    const order = { sabotage: 0, lock: 1, unlock: 1, doorwork: 1, attack: 2, mixFood: 4, repairItem: 5, wash: 6, grope: 9, repairPower: 11, steal: 3, poisonFood: 4, trap: 4, craft: 5, clean: 6, moveBody: 7, interrogate: 8, take: 9, drop: 10, hide: 10, exit_power: 11, search: 12, examine: 12, eat: 13, exit: 14, rest: 15 };
    const list = shuffle([...this.actions.entries()]).sort((a, b) => (order[a[1].type] ?? 20) - (order[b[1].type] ?? 20));
    const exitAttempts = [];
    for (const [pid, a] of list) {
      const p = this.players.get(pid);
      if (!p?.alive) continue;
      if (p.ko) {
        // สลบ (ก่อนหรือระหว่างชั่วโมงนี้) = ไม่ได้ทำอะไร
        if (!a.ko && !a.auto) this.logTo(p, '😵 คุณสลบไปก่อนจะได้ทำสิ่งที่ตั้งใจในชั่วโมงนี้', 'danger');
        continue;
      }
      const fn = this[`do_${a.type}`];
      if (typeof fn !== 'function') continue;
      try {
        fn.call(this, p, a, exitAttempts);
      } catch (err) {
        this.log.error(`[room ${this.code}] action ${a.type} failed`, err);
      }
    }
    this.shareDiscoveries(); // สำรวจร่วมกัน: คนที่อยู่ด้วยชี้ทางออก/ทางลับให้
    this.settleFood(); // ยาในอาหารที่ถูกกินครบจำนวนแล้วหมดไป (ท้ายชั่วโมง เพื่อให้คนที่กินพร้อมกันโดนทุกคน)
    this.resolveRest();
    if (resolveExits(this, exitAttempts)) return;
    if (this.phase === PHASE.ENDED) return;

    // ก่อนแยกย้าย คนในห้องเดียวกันเห็นศพที่เพิ่งเกิดขึ้น และอาจสังเกตเสื้อผ้าเปื้อน
    for (const b of this.bodies.values()) {
      if (b.judged || b.turn !== this.turn) continue;
      for (const o of this.awakeIn(b.zoneId, b.outside)) {
        if (o.id === b.killerId || o.knownBodies.has(b.victimId)) continue;
        o.knownBodies.add(b.victimId);
        b.discoveredBy.add(o.id);
        this.logTo(o, `☠ ก่อนออกจาก${this.zn(b.zoneId)}คุณพบว่า${this.nick(this.players.get(b.victimId))}นอนไม่ขยับอยู่ — เขาตายแล้ว`, 'witness');
      }
    }
    for (const p of this.alivePlayers()) {
      if (p.ko) continue;
      for (const o of this.presentWith(p)) {
        if (o.id !== p.id && o.stained === this.turn && chance(0.5)) this.logTo(p, `👀 คุณสังเกตว่าเสื้อผ้าของ${this.nick(o)}มีรอยเปื้อนสีคล้ำที่เมื่อครู่ยังไม่มี`, 'witness');
      }
    }
    for (const p of this.alivePlayers()) p.forced = null;
    this.tickKo();
    this.botGhostChat(); // ผีบอททักทายผีใหม่/บ่นเหตุการณ์ของชั่วโมงนี้

    if (this.phase === PHASE.DAY) {
      if (this.checkEarlyEnd()) return;
      if (this.checkBodyThreshold()) return;
      this.step = STEP.REPORT;
      this.ready = new Set();
      this.systemMessage(`ชั่วโมงที่ ${this.hour} จบลง — อ่านสมุดบันทึก ให้ของกับคนในห้องเดียวกันได้ แล้วกด "พร้อมไปชั่วโมงถัดไป"`);
      this.emit();
      // ทุกคนที่ยังอยู่สลบหมด → ไม่มีใครกดพร้อมได้ ให้เวลาเดินต่อเอง
      if (this.alivePlayers().every((p) => p.ko)) {
        this.systemMessage('😵 ทุกคนที่ยังอยู่สลบหมด — เวลาผ่านไปอีกหนึ่งชั่วโมง');
        return this.nextTurn();
      }
      this.scheduleBots();
    } else if (this.investigation && this.investigation.hour < this.investigation.total) {
      this.nextInvestigationHour();
    } else {
      this.beginTrial().catch((e) => this.fail(e));
    }
  }

  witnessesOf(p) {
    return this.awakeWith(p).filter((o) => o.id !== p.id && this.canSee(o)); // คนสลบไม่เห็นอะไร · ในความมืดไม่มีพยาน (เว้นคนใส่แว่นมองกลางคืน)
  }

  // จบชั่วโมง: คนที่สลบมาตั้งแต่ชั่วโมงก่อนนับเวลาลง 1 ชั่วโมง ครบแล้วฟื้น (ชั่วโมงที่โดนทำให้สลบไม่นับ)
  tickKo() {
    for (const p of this.alivePlayers()) {
      if (!p.ko || p.ko.since >= this.turn) continue;
      p.ko.hours -= 1;
      if (p.ko.hours <= 0) this.wakeUp(p);
    }
  }

  // สำรวจร่วมกัน: คนที่สำรวจห้องนี้ในชั่วโมงนี้จะรู้ทางออก/ทางลับของห้องที่คนที่อยู่ด้วย (และมองเห็นกัน) รู้อยู่แล้วหรือเพิ่งเจอ — ไม่ต้องกระซิบบอกกันนอกเกม
  shareDiscoveries() {
    for (const id of this.searchedThisHour || []) {
      const p = this.players.get(id);
      if (!p?.alive || p.ko || p.outside || !this.canSee(p)) continue;
      const z = this.zones.get(p.zoneId);
      if (!z) continue;
      const mates = this.awakeWith(p).filter((o) => o.id !== p.id && this.canSee(o));
      if (!mates.length) continue;
      for (const x of exitsIn(this, z.id)) {
        if (x.open || knowsExit(p, x)) continue;
        const guide = mates.find((o) => knowsExit(o, x));
        if (!guide) continue;
        discoverExit(this, p, x, `${this.nick(guide)}ที่สำรวจอยู่ด้วยกันชี้ให้คุณดู`);
        this.recordEvent(`${this.nick(guide)}ชี้ทางออก "${x.name}" ให้${this.nick(p)}ที่${this.zn(z)}`);
      }
      for (const ps of this.passages.filter((x) => (x.a === z.id || x.b === z.id) && !p.knownPassages.has(x.id))) {
        const guide = mates.find((o) => o.knownPassages.has(ps.id));
        if (!guide) continue;
        p.knownPassages.add(ps.id);
        const other = ps.a === z.id ? ps.b : ps.a;
        this.logTo(p, `🕳 ${this.nick(guide)}ที่สำรวจอยู่ด้วยกันชี้ให้คุณดูทางลับที่เชื่อมไป${this.zn(other)}`, 'escape');
        this.recordEvent(`${this.nick(guide)}ชี้ทางลับให้${this.nick(p)}ที่${this.zn(z)}`);
      }
    }
    this.searchedThisHour = new Set();
  }

  // ---------- แสงสว่าง / ไฟดับ ----------
  hasLight(p) {
    return p.inventory.some((i) => tagsOf(i).has('light'));
  }

  hasNightVision(p) {
    return p.inventory.some((i) => tagsOf(i).has('nightvision'));
  }

  // จุดนี้มืดไหม: ไฟดับทั้งตึก (หรือห้องถูกตัดไฟ) และไม่มีใครที่อยู่ตรงนั้นถือของส่องสว่าง
  darkAt(zoneId, outside = false) {
    const z = this.zones.get(zoneId);
    if (!z || (!this.blackout && !z.dark)) return false;
    return !this.presentIn(zoneId, outside).some((o) => !o.ko && this.hasLight(o));
  }

  // คนนี้มองเห็นรอบตัวไหม (แว่นมองกลางคืนเห็นคนเดียว คนอื่นไม่ได้ประโยชน์)
  canSee(p) {
    return !this.darkAt(p.zoneId, p.outside) || this.hasNightVision(p);
  }

  // ทางลับที่ "รู้จัก" จากห้องปัจจุบันไป zid (เดินทะลุได้แม้ประตูล็อก/ค้ำ ไม่ผ่านประตู)
  passageTo(p, zid) {
    if (p.outside) return null;
    return this.passages.find((ps) => p.knownPassages.has(ps.id) && ((ps.a === p.zoneId && ps.b === zid) || (ps.b === p.zoneId && ps.a === zid))) || null;
  }

  who(p, z) {
    return this.darkAt(z.id, p.outside) ? 'ใครบางคน (มืดเกินกว่าจะเห็นหน้า)' : this.nick(p);
  }

  // โอกาสที่คนในห้องเห็นสิ่งที่คุณทำ (สายเงียบเชียบเห็นยากขึ้นครึ่งหนึ่ง)
  seen(p, base) {
    return chance(this.traitOf(p) === 'stealth' ? base / 2 : base);
  }

  do_attack(p, a) {
    const z = this.zones.get(p.zoneId);
    const anonymous = a.targetId === 'random'; // มืด: สุ่มโดนใครสักคน ไม่มีชื่อในบันทึกของทั้งสองฝ่าย
    let target = anonymous ? null : this.players.get(a.targetId);
    if (anonymous) {
      const wA = this.bestWeapon(p);
      const sureA = !!(wA && (attackBaseOf(wA, this.traitOf(p), !!this.injectorOf(p))?.lethal || 0) > 0);
      const cands = this.presentWith(p).filter((o) => o.id !== p.id && o.alive && (!o.ko || sureA));
      if (!cands.length) return this.logTo(p, 'คุณคว้าไปในความมืดแต่ไม่โดนใครเลย', 'danger');
      target = pick(cands);
    }
    const tname = anonymous ? 'ใครสักคนในความมืด' : this.nick(target);
    if (!target || !this.sameSpot(p, target)) return this.logTo(p, `คุณมองหา${tname}แต่เขาไม่ได้อยู่ตรงนี้แล้ว`, 'danger');
    if (this.phase !== PHASE.DAY) return this.logTo(p, '🔎 ช่วงเก็บหลักฐานลงมือทำร้ายใครไม่ได้', 'danger');
    if (!target.alive) {
      this.logTo(p, `คุณย่องเข้าไปหา${tname} แต่พบว่าเขาตายไปแล้วก่อนที่คุณจะลงมือ`, 'danger');
      p.knownBodies.add(target.id);
      this.bodies.get(target.id)?.discoveredBy.add(p.id);
      return;
    }
    const w = this.bestWeapon(p);
    const inj = w?.kind === 'poison' ? this.injectorOf(p) : null; // วางยาตรงด้วยเข็มฉีดยา
    const sureKill = !!(w && (attackBaseOf(w, this.traitOf(p), !!inj)?.lethal || 0) > 0); // ของที่ฆ่าได้ → คนสลบตายแน่ (มือเปล่า/ยาสลบไม่นับ นักสู้ต่อยคนสลบก็ยังสุ่ม 5%)
    if (target.ko && !sureKill) return this.logTo(p, `😵 ${tname}สลบอยู่แล้ว — มือเปล่า/ยาสลบทำอะไรเขาไม่ได้อีก (ต้องใช้ของที่ฆ่าได้)`, 'danger');
    const shot = !!w && tagsOf(w).has('firearm') && (w.ammo ?? 0) > 0; // ยิงปืน: กระสุนลดทุกครั้ง ทั้งตึกได้ยิน
    const wtxt = w ? `ด้วย${w.name}${inj ? ` (ฉีดด้วย${inj.name})` : ''}` : 'ด้วยมือเปล่า';
    // อาวุธของคดี: ชื่อบอกวิธี (ฉีดด้วย...) และแท็กบอกชนิดแผล (ปืนที่กระสุนหมดแล้วใช้ด้ามฟาดไม่นับว่า "ยิง")
    const wrec = w ? { name: inj ? `${w.name} (ฉีดด้วย${inj.name})` : w.name, kind: w.kind, tags: [...tagsOf(w)].filter((t) => t !== 'firearm' || shot) } : null;
    const others = this.presentWith(p).filter((o) => o.id !== p.id && o.id !== target.id);
    const awake = others.filter((o) => !o.ko && this.canSee(o)); // คนสลบ/คนที่มองไม่เห็น (มืด) ไม่เป็นพยาน (แต่โดนลูกหลงได้)
    const bd = this.attackBreakdown(p, target, w, others.length, z);
    const pSucc = bd.chance;
    const lethal = bd.lethal; // โอกาสฆ่าเมื่อสำเร็จ · 0 = มือเปล่า/ยาสลบ ทำให้สลบเท่านั้น
    const who = this.who(p, z);
    const names = (list) => list.map((o) => this.nick(o)).join(', ');
    const consumePoison = () => {
      if (w?.kind !== 'poison') return;
      p.inventory.splice(p.inventory.indexOf(w), 1);
      w.hidden = true;
      z.items.push(w);
    };
    if (shot) {
      w.ammo -= 1;
      for (const o of this.alivePlayers()) if (o.id !== p.id && !o.ko && !this.sameSpot(o, p)) this.logTo(o, `🔫 เสียงปืนดังสนั่นมาจากทาง${this.zn(z)} — ทั้งตึกได้ยิน`, 'witness');
    }
    if (w && w.kind !== 'poison') this.breakItemMaybe(p, w, DURABILITY.BREAK_ON_ATTACK, 'การลงมือ'); // ใช้แล้วมีโอกาสพัง (ครั้งนี้ยังใช้ได้)
    const r = Math.random();
    if (r < pSucc) {
      const messy = chance(this.traitOf(p) === 'combat' ? ATTACK.MESSY_COMBAT : ATTACK.MESSY);
      const saw = awake.filter(() => chance(messy ? 0.75 : 0.4));
      const kills = target.ko && sureKill ? true : chance(lethal); // คนสลบต้านไม่ได้: ของฆ่าได้ = ตายแน่ · มือเปล่า/ยาสลบ = สลบต่อ (นักสู้ 5%)
      consumePoison();
      if (kills) {
        const kase = this.killPlayer(target, { cause: 'attack', killerId: p.id, weapon: wrec, zoneId: z.id, outside: p.outside, messy, witnesses: saw.map((o) => o.id) });
        this.addKillEvidence(z, kase, wrec, messy, p);
        this.stainWeapon(w, wrec);
        if (messy) p.stained = this.turn;
        this.logTo(
          p,
          `🔪 คุณลงมือกับ${tname}${wtxt}สำเร็จ ${messy ? 'แต่ไม่เรียบร้อย: คราบเลือดกระจาย ของล้มระเนระนาด และเสื้อผ้าคุณเปื้อน' : 'อย่างเงียบเชียบ ทิ้งร่องรอยไว้น้อยมาก'}${
            saw.length ? ` — แย่แล้ว ${names(saw)}เห็นคุณลงมือ!` : awake.length ? ` ไม่มีใครเห็นตอนลงมือ แต่คนในห้อง (${names(awake)}) เห็นศพแน่นอน` : ' ไม่มีใครเห็น'
          }${kase.dropped.length ? ` ของที่เขาถือหล่นอยู่ที่นี่: ${kase.dropped.join(', ')}` : ''} คุณคือคนร้ายของคดีนี้ — ศพจะอยู่ตรงนี้จนกว่าจะมีคนย้าย${CONFIG.MURDER_LOCK ? ' และจนกว่าศพจะถูกพบ คนอื่นจะลงมือฆ่าใครไม่ได้ มีแต่คุณที่ทำได้' : ''}`,
          'culprit',
        );
        this.logTo(target, `💀 ${who}ลงมือกับคุณ${wtxt}ที่${this.zn(z)}คุณเสียชีวิต... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
        for (const o of awake) {
          o.knownBodies.add(target.id);
          this.bodies.get(target.id).discoveredBy.add(o.id);
          if (saw.includes(o)) this.logTo(o, `😱 คุณเห็น${who}ลงมือกับ${this.nick(target)}${wtxt}ต่อหน้าต่อตา!`, 'witness');
          else
            this.logTo(
              o,
              `😱 คุณหันไปอีกทีก็เห็น${this.nick(target)}นอนไม่ขยับอยู่ที่${this.zn(z)}คนที่อยู่ในห้องนี้ตอนนั้น: ${[p, ...awake.filter((x) => x !== o)].map((x) => (z.dark ? 'เงาคน' : this.nick(x))).join(', ')}${z.dark ? ' (มืดจนแยกไม่ออก)' : ''}`,
              'witness',
            );
        }
        if (!shot) this.designatedHears(kase, p); // ถ้ายิงปืน ทุกคนได้ยินอยู่แล้ว
        this.recordEvent(`${this.nick(p)}ฆ่า${this.nick(target)}ที่${this.zn(z)}${wtxt}${messy ? ' แบบเลอะเทอะ' : ' อย่างเงียบเชียบ'}${saw.length ? ` (${names(saw)}เห็น)` : ''}`);
        return;
      }
      // สำเร็จแต่ไม่ตาย → สลบ 1–3 ชั่วโมง (หรือสลบต่อถ้าสลบอยู่แล้ว)
      const already = !!target.ko;
      const hours = this.koHours();
      const dropped = this.knockOut(target, hours, { cause: 'attack', by: p.id });
      if (messy) {
        p.stained = this.turn;
        z.evidence.push(this.makeEvidence(z.id, `ร่องรอยการต่อสู้ใกล้จุดที่${this.nick(target)}ล้มลง ของกระจัดกระจาย`, false, null, 'struggle', p.outside));
      }
      this.logTo(
        p,
        `🥊 คุณลงมือกับ${tname}${wtxt} เขาล้มลง${already ? 'และยังไม่ฟื้น' : 'หมดสติ'} (สลบอีก ${hours} ชั่วโมง) แต่ยังไม่ตาย${lethal > 0 ? ' — ครั้งนี้ไม่ถึงตาย' : ' (มือเปล่า/ยาสลบทำให้สลบเท่านั้น)'}${dropped.length ? ` ของที่หล่นจากมือเขา: ${dropped.join(', ')}` : ''}${
          saw.length ? ` — ${names(saw)}เห็นคุณลงมือ!` : awake.length ? ` คนในห้อง (${names(awake)}) เห็นว่าเขาล้มลง` : ' ไม่มีใครเห็น'
        } ระหว่างที่เขาสลบ ใครลงมือกับเขาก็สำเร็จแน่นอน`,
        'culprit',
      );
      this.logTo(target, `😵 ${who}ลงมือกับคุณ${wtxt}ที่${this.zn(z)} คุณหมดสติ จะฟื้นในอีก ${hours} ชั่วโมง${dropped.length ? ` ของหล่นจากมือ: ${dropped.join(', ')}` : ''} — ระหว่างนี้คุณทำอะไรไม่ได้ และใครลงมือกับคุณก็สำเร็จแน่นอน`, 'danger');
      for (const o of awake) {
        if (saw.includes(o)) this.logTo(o, `😱 คุณเห็น${who}ลงมือกับ${this.nick(target)}${wtxt}จน${this.nick(target)}ล้มลงหมดสติ!`, 'witness');
        else this.logTo(o, `😱 คุณหันไปอีกทีก็เห็น${this.nick(target)}นอนหมดสติอยู่ที่${this.zn(z)} คนที่อยู่ในห้องนี้ตอนนั้น: ${[p, ...awake.filter((x) => x !== o)].map((x) => (z.dark ? 'เงาคน' : this.nick(x))).join(', ')}`, 'witness');
      }
      this.recordEvent(`${this.nick(p)}ทำให้${this.nick(target)}สลบที่${this.zn(z)}${wtxt} (${hours} ชม.)`);
      return;
    }
    // พลาด → เป้าหมายอาจสวนกลับ (ผลตามของที่เป้าหมายถือ: ฆ่า หรือทำให้คนลงมือสลบ · มือเปล่า = สลบเท่านั้น)
    if (chance(this.counterChance(target))) {
      const tw = this.bestWeapon(target);
      const tab = attackBaseOf(tw, this.traitOf(target), !!this.injectorOf(target));
      const tLethal = tw && tab ? tab.lethal : this.traitOf(target) === 'combat' ? ATTACK.LETHALITY.unarmedCombat : ATTACK.LETHALITY.unarmed;
      const twtxt = tw ? `ด้วย${tw.name}` : 'ด้วยมือเปล่า';
      const twrec = tw ? { name: tw.name, kind: tw.kind, tags: [...tagsOf(tw)] } : null;
      if (chance(tLethal)) {
        const kase = this.killPlayer(p, { cause: 'defense', killerId: target.id, weapon: twrec, zoneId: z.id, outside: p.outside, messy: true, witnesses: awake.map((o) => o.id) });
        this.addKillEvidence(z, kase, twrec, true, target);
        this.stainWeapon(tw, twrec);
        target.stained = this.turn;
        this.logTo(target, `⚔ ${who}จู่โจมคุณ${wtxt}ที่${this.zn(z)}! คุณสวนกลับ${twtxt}สุดชีวิต และ... ${this.nick(p)}ล้มลงไม่ขยับ เขาตายแล้ว ตามกติกาของที่นี่ คุณคือ "คนร้าย" ของคดีนี้ แม้จะเป็นการป้องกันตัว`, 'culprit');
        this.logTo(p, `💀 คุณจู่โจม${tname} แต่เขาสวนกลับ${twtxt} คุณเป็นฝ่ายตายเสียเอง...`, 'death');
        for (const o of awake) {
          o.knownBodies.add(p.id);
          this.bodies.get(p.id).discoveredBy.add(o.id);
          this.logTo(o, `😱 ${who}จู่โจม${this.nick(target)}ต่อหน้าคุณ แต่${this.nick(target)}สวนกลับ${twtxt}จน${this.nick(p)}ล้มลงและไม่ลุกขึ้นมาอีก`, 'witness');
        }
        this.recordEvent(`${this.nick(p)}พยายามฆ่า${this.nick(target)}ที่${this.zn(z)}แต่ถูกสวนกลับ${twtxt}จนตาย`);
        return;
      }
      const hours = this.koHours();
      const dropped = this.knockOut(p, hours, { cause: 'counter', by: target.id });
      this.logTo(target, `⚔ ${who}จู่โจมคุณ${wtxt}ที่${this.zn(z)}! คุณสวนกลับ${twtxt}จน${this.nick(p)}ล้มลงหมดสติ (${hours} ชั่วโมง) — เขายังไม่ตาย${dropped.length ? ` ของหล่นจากมือเขา: ${dropped.join(', ')}` : ''} ระหว่างนี้จะทำอะไรเขาก็ได้`, 'action');
      this.logTo(p, `😵 คุณจู่โจม${tname} แต่เขาสวนกลับ${twtxt} คุณหมดสติ จะฟื้นในอีก ${hours} ชั่วโมง${dropped.length ? ` ของหล่นจากมือ: ${dropped.join(', ')}` : ''} — ระหว่างนี้ใครลงมือกับคุณก็สำเร็จแน่นอน`, 'danger');
      for (const o of awake) this.logTo(o, `😱 ${who}จู่โจม${this.nick(target)}ต่อหน้าคุณ แต่${this.nick(target)}สวนกลับ${twtxt}จน${this.nick(p)}ล้มลงหมดสติ`, 'witness');
      this.recordEvent(`${this.nick(p)}พยายามทำร้าย${this.nick(target)}ที่${this.zn(z)}แต่ถูกสวนกลับ${twtxt}จนสลบ (${hours} ชม.)`);
      return;
    }
    const wrongCands = others.filter((o) => !o.ko || sureKill); // คนสลบไม่โดนลูกหลงจากมือเปล่า/ยาสลบ
    if (wrongCands.length && chance(ATTACK.WRONG_TARGET)) {
      const wrong = pick(wrongCands);
      const wname = anonymous ? 'อีกคนหนึ่งในความมืด' : this.nick(wrong);
      const rest = awake.filter((o) => o !== wrong);
      const kills = wrong.ko && sureKill ? true : chance(lethal);
      consumePoison();
      p.stained = this.turn;
      if (kills) {
        const kase = this.killPlayer(wrong, { cause: 'wrongTarget', killerId: p.id, weapon: wrec, zoneId: z.id, outside: p.outside, messy: true, witnesses: [target.id, ...rest.map((o) => o.id)] });
        this.addKillEvidence(z, kase, wrec, true, p);
        this.stainWeapon(w, wrec);
        this.logTo(p, `💥 คุณพุ่งเข้าใส่${tname} แต่เขาหลบทัน และ${w ? w.name : 'แรงของคุณ'}ไปลง${wname}เต็ม ๆ... ${wname}ตายทันที ทุกคนในห้องเห็นหมด คุณคือคนร้ายของคดีนี้`, 'culprit');
        this.logTo(wrong, `💀 ${who}ตั้งใจเล่นงาน${tname} แต่พลาดมาโดนคุณ... คุณเสียชีวิต`, 'death');
        this.logTo(target, `😱 ${who}พุ่งเข้าใส่คุณ${wtxt}! คุณหลบทัน แต่${wname}ที่อยู่ข้าง ๆ รับไปเต็ม ๆ และตายต่อหน้าคุณ`, 'witness');
        for (const o of [target, ...rest]) {
          o.knownBodies.add(wrong.id);
          this.bodies.get(wrong.id).discoveredBy.add(o.id);
          if (o !== target) this.logTo(o, `😱 ${who}พุ่งเข้าใส่${this.nick(target)}แต่พลาดไปโดน${this.nick(wrong)} ${this.nick(wrong)}ตายต่อหน้าคุณ`, 'witness');
        }
        this.recordEvent(`${this.nick(p)}ตั้งใจฆ่า${this.nick(target)}ที่${this.zn(z)}แต่พลาดไปโดน${this.nick(wrong)}`);
        return;
      }
      const hours = this.koHours();
      const dropped = this.knockOut(wrong, hours, { cause: 'attack', by: p.id });
      this.logTo(p, `💥 คุณพุ่งเข้าใส่${tname} แต่เขาหลบทัน และ${w ? w.name : 'แรงของคุณ'}ไปลง${wname}จนล้มลงหมดสติ (${hours} ชั่วโมง) ทุกคนในห้องเห็นหมด${dropped.length ? ` ของหล่นจากมือเขา: ${dropped.join(', ')}` : ''}`, 'danger');
      this.logTo(wrong, `😵 ${who}ตั้งใจเล่นงาน${tname} แต่พลาดมาโดนคุณ คุณหมดสติ จะฟื้นในอีก ${hours} ชั่วโมง${dropped.length ? ` ของหล่นจากมือ: ${dropped.join(', ')}` : ''}`, 'danger');
      this.logTo(target, `😱 ${who}พุ่งเข้าใส่คุณ${wtxt}! คุณหลบทัน แต่${wname}ที่อยู่ข้าง ๆ โดนแทนจนล้มลงหมดสติ`, 'witness');
      for (const o of rest) this.logTo(o, `😱 ${who}พุ่งเข้าใส่${this.nick(target)}แต่พลาดไปโดน${this.nick(wrong)}จนล้มลงหมดสติ`, 'witness');
      this.recordEvent(`${this.nick(p)}ตั้งใจทำร้าย${this.nick(target)}ที่${this.zn(z)}แต่พลาดไปโดน${this.nick(wrong)}จนสลบ`);
      return;
    }
    const dropWeapon = w && w.kind !== 'poison' && chance(ATTACK.DROP_WEAPON);
    if (dropWeapon) {
      p.inventory.splice(p.inventory.indexOf(w), 1);
      w.hidden = false;
      z.items.push(w);
      z.evidence.push(this.makeEvidence(z.id, `${w.name}ตกอยู่กลางห้อง ไม่ใช่ที่ของมัน`, false, null, 'item'));
    }
    this.logTo(p, `❌ คุณพยายามลงมือกับ${tname}${wtxt} แต่พลาด เขาตัวไวกว่าที่คิด${dropWeapon ? ` และคุณทำ${w.name}หล่นไว้ที่นั่น` : ''} ตอนนี้เขารู้แล้วว่ามีคนพยายามทำร้ายเขา${z.dark ? ' (แต่มืด เขาอาจไม่รู้ว่าเป็นคุณ)' : ''}`, 'danger');
    this.logTo(target, `⚠ ${who}พยายามทำร้ายคุณที่${this.zn(z)}${wtxt}! คุณหลบได้ทัน${z.dark ? ' แต่มืดเกินกว่าจะเห็นว่าเป็นใคร' : ''}`, 'danger');
    for (const o of awake) if (chance(0.6)) this.logTo(o, `👀 คุณเห็น${who}กับ${this.nick(target)}ปะทะกันชั่วครู่ที่${this.zn(z)}${this.nick(target)}ดูตกใจมาก`, 'witness');
    this.recordEvent(`${this.nick(p)}พยายามทำร้าย${this.nick(target)}ที่${this.zn(z)}แต่ล้มเหลว`);
  }

  addKillEvidence(z, kase, w, messy, killer) {
    const v = this.players.get(kase.victimId);
    if (messy) {
      z.evidence.push(this.makeEvidence(z.id, `คราบเลือดกระจายและของล้มระเนระนาดใกล้จุดที่${this.nick(v)}ล้มลง — มีการต่อสู้`, false, kase.id, 'struggle', kase.outside));
      if (chance(0.35)) {
        const look = this.charOf(killer)?.appearance || 'เสื้อผ้าของใครบางคน';
        z.evidence.push(this.makeEvidence(z.id, `เศษผ้าขาดเกี่ยวติดอยู่กับขอบตู้ — ดูเหมือนมาจากเสื้อผ้าแบบ "${look.split(' ').slice(-3).join(' ')}"`, false, kase.id, 'cloth', kase.outside));
      }
      if (w) z.evidence.push(this.makeEvidence(z.id, weaponTrace(w, true), true, kase.id, 'weapon', kase.outside)); // ไม่เอ่ยชื่อของ บอกแค่ชนิด
    } else {
      z.evidence.push(this.makeEvidence(z.id, `รอยเลือดหยดเล็ก ๆ ที่ถูกเช็ดอย่างรีบร้อนใกล้จุดที่พบศพ`, true, kase.id, 'blood', kase.outside));
      if (w) z.evidence.push(this.makeEvidence(z.id, weaponTrace(w, false), true, kase.id, 'weapon', kase.outside));
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
    if (a.recipeId === 'assembly') return doCraftAssembly(this, p, a); // ชิ้นส่วนทางออก
    if (a.recipeId === 'makeshift') return doCraftMakeshift(this, p, a); // ชิ้นส่วนดัดแปลงแทนชุดจริง
    const r = RECIPES.find((x) => x.id === a.recipeId);
    const z = this.zones.get(p.zoneId);
    const ia = p.inventory.findIndex((i) => i.id === a.itemId);
    const ib = p.inventory.findIndex((i) => i.id === a.itemId2);
    if (!r || ia < 0 || ib < 0 || ia === ib) return this.logTo(p, 'ของสำหรับประกอบไม่ครบ', 'danger');
    const [first, second] = ia < ib ? [ib, ia] : [ia, ib];
    const itemB = p.inventory.splice(first, 1)[0];
    const itemA = p.inventory.splice(second, 1)[0];
    const bFirst = partMatches(itemB, r, 0) && partMatches(itemA, r, 1) && !(partMatches(itemA, r, 0) && partMatches(itemB, r, 1));
    const [partA, partB] = bFirst ? [itemB, itemA] : [itemA, itemB]; // ชิ้นแรกของสูตร = ชิ้นที่ตรงลำดับแรก (ถ้าไม่ตรงทั้งคู่ คงลำดับที่ส่งมา)
    const striker = r.striker === 1 ? partB : partA; // ชิ้นที่ทำร้ายจริง (ใบมีด/ของหนัก/สายไฟ) = "อาวุธ" ของคดี
    const other = striker === partA ? partB : partA; // ชิ้นประกอบอีกชิ้น: เครื่องมือจะตกอยู่ที่เดิมหลังกับดักทำงาน เชือก/สายถูกใช้ไป
    const trap = {
      id: `trap_${nextId()}`,
      name: (r.nameTpl || '{a}ผูก{b}').replace('{a}', partA.name).replace('{b}', partB.name),
      description: `${r.name} (${r.desc})`,
      kind: 'trap',
      trapType: r.trapType,
      weaponName: striker.name,
      strikerTags: [...tagsOf(striker)],
      strikerKind: striker.kind, // ไว้ทิ้งชิ้นที่ทำร้ายกลับเป็นของธรรมดาหลังกับดักทำงาน (ร่องรอยต้องสำรวจถึงเจอ)
      strikerDesc: striker.description || '',
      strikerAmmo: Number.isInteger(striker.ammo) ? striker.ammo : null,
      otherPart: { name: other.name, kind: other.kind, description: other.description || '' },
      wound: woundOf(striker), // ชนิดแผลที่กับดักนี้ทำ (ปืน = ยิง, มีคม = บาด, หนัก = กระแทก) ใช้เลือกข้อความตอนทำงาน
      ingredients: [partA.name, partB.name],
      portable: true,
      hidden: false,
      isPart: false,
      originZoneId: z.id,
    };
    p.inventory.push(trap);
    const who = this.who(p, z);
    this.logTo(p, `🛠 คุณประกอบ "${trap.name}" (${r.name}) เสร็จแล้ว — เลือก "วางกับดัก" ในห้องที่ต้องการเมื่อพร้อม${r.placeNeeds ? ` (วางได้เฉพาะห้องที่มี${KIND_LABEL[r.placeNeeds]})` : ''} ถ้ามีคนตายเพราะมัน คุณคือคนร้าย`, 'culprit');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.4)) this.logTo(o, `👀 คุณเห็น${who}นั่งประกอบอะไรบางอย่างจาก${partA.name}และ${partB.name}อยู่ตรงมุมห้อง${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ประกอบกับดัก "${trap.name}" ที่${this.zn(z)}`);
  }

  // วางกับดักที่ประกอบแล้วไว้ที่ทางเข้าห้องนี้
  do_trap(p, a) {
    const z = this.zones.get(p.zoneId);
    const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.kind === 'trap');
    if (idx < 0) return;
    const it = p.inventory.splice(idx, 1)[0];
    const who = this.who(p, z);
    const isDoor = it.trapType === 'door';
    const side = p.outside ? 'outside' : 'inside';
    if (chance(TRAP_FAIL_CHANCE)) {
      if (p.outside) {
        p.inventory.push(it);
        this.logTo(p, `❌ คุณติดตั้ง${it.name}ที่ประตู${this.zn(z)}จากข้างนอกไม่สำเร็จ กลไกหลุด คุณเก็บมันกลับไว้ก่อน`, 'danger');
      } else {
        it.hidden = false;
        z.items.push(it);
        z.evidence.push(this.makeEvidence(z.id, `${it.name}วางเกะกะอยู่ใกล้ทางเข้า เหมือนมีคนพยายามติดตั้งอะไรบางอย่างแล้วไม่สำเร็จ`, false, null, 'trap'));
        this.logTo(p, `❌ คุณติดตั้ง${it.name}ไม่สำเร็จ ${isDoor ? 'กลไกหลุด' : 'เชือกหลุด'}และมันหล่นเกะกะให้เห็นอยู่ใน${this.zn(z)}`, 'danger');
      }
    } else {
      z.traps.push({ setterId: p.id, item: it, turn: this.turn, side });
      if (isDoor) this.logTo(p, `🪤 คุณติดตั้ง${it.name}ไว้ที่ประตู${this.zn(z)}ทาง${p.outside ? 'ข้างนอกแล้ว — ใครก็ตามที่เปิดประตูออกมาจากห้องนี้จะโดน' : 'ข้างในแล้ว — ใครก็ตามที่เปิดประตูเข้ามาจะโดน'} (คนที่ปลดล็อกประตูโดนก่อน ถ้าหลายคนพร้อมกันสุ่ม 1 คน ไม่มีโอกาสรอด) — ถ้าเขาตาย คุณคือคนร้าย`, 'culprit');
      else this.logTo(p, `🪤 คุณตั้ง${it.name}ไว้ที่ทางเข้า${this.zn(z)}แล้ว (${TRAP_TYPES[it.trapType]?.label || ''}) คนต่อไปที่เข้ามาที่ไม่ใช่คุณมีโอกาสโดน — ถ้าเขาตาย คุณคือคนร้าย`, 'culprit');
    }
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.4)) this.logTo(o, `👀 คุณเห็น${who}ก้ม ๆ เงย ๆ ยุ่งอยู่กับ${it.name}ตรงทางเข้า${this.zn(z)}`, 'witness');
    this.recordEvent(`${this.nick(p)}วางกับดัก (${it.name}) ที่${this.zn(z)}`);
  }

  // ผสมยาพิษลงในอาหารกลางห้อง
  // ผสมยาบำรุง/ยารักษาลงอาหารกลางห้อง: ใครกินได้บัฟ (ยาบำรุง = ภารกิจถัดไป +1 ชม. · ยารักษา = ต้านทานสลบ 1 ครั้ง)
  do_mixFood(p, a) {
    const z = this.zones.get(p.zoneId);
    const food = z.items.find((i) => i.kind === 'food');
    const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.kind === 'medicine');
    if (!food || idx < 0) return this.logTo(p, 'ผสมยาไม่ได้ที่นี่', 'danger');
    if (food.buff) return this.logTo(p, `${food.name}มีคนผสมยาไว้ก่อนแล้ว`, 'danger');
    const med = p.inventory.splice(idx, 1)[0];
    const kind = tagsOf(med).has('remedy') ? 'remedy' : 'tonic';
    food.buff = { setterId: p.id, name: med.name, kind, turn: this.turn, usesLeft: 3 }; // พอสำหรับคนกิน 3 คน
    const who = this.who(p, z);
    this.logTo(p, `💊 คุณผสม${med.name}ลงใน${food.name}ที่${this.zn(z)} — ใครมากิน${kind === 'tonic' ? 'จะได้เวลาภารกิจถัดไป +1 ชั่วโมง' : 'จะต้านทานการสลบได้ 1 ครั้ง'}`, 'action');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.35)) this.logTo(o, `👀 คุณเห็น${who}ใส่อะไรบางอย่างลงใน${food.name}`, 'witness');
    this.recordEvent(`${this.nick(p)}ผสม${med.name}ลงใน${food.name}ที่${this.zn(z)}`);
  }

  do_poisonFood(p, a) {
    const z = this.zones.get(p.zoneId);
    const food = z.items.find((i) => i.kind === 'food');
    const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.kind === 'poison');
    if (!food || idx < 0) return this.logTo(p, 'ผสมยาไม่ได้ที่นี่', 'danger');
    if (food.poisoned) return this.logTo(p, `${food.name}มีคนผสมอะไรไว้ก่อนแล้ว คุณเลยไม่ได้ทำอะไร`, 'danger');
    const poison = p.inventory.splice(idx, 1)[0];
    food.poisoned = { setterId: p.id, poisonName: poison.name, poisonTags: [...tagsOf(poison)], turn: this.turn, usesLeft: 1 }; // พอสำหรับคนกิน 1 คน (คนที่กินพร้อมกันในชั่วโมงนั้นโดนทุกคน)
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
      const notice = poisonNoticeChance(trait, food.poisoned.poisonTags || []); // ยากลิ่นฉุนสังเกตง่าย ไร้สีไร้รสสังเกตยาก
      if (chance(notice)) {
        z.evidence.push(this.makeEvidence(z.id, `${food.name}ถูกคายทิ้งไว้ครึ่งคำ มีกลิ่นและรสขมผิดปกติ — มีคนผสมอะไรลงไป`, false, null, 'poison'));
        this.logTo(p, `🤢 คุณกัด${food.name}ไปคำเดียวแล้วรู้สึกถึงรสขมและกลิ่นเคมี คุณคายทิ้งทันที — มีคนผสมยาพิษไว้ในอาหารห้องนี้!`, 'danger');
        for (const o of this.witnessesOf(p, z)) this.logTo(o, `👀 ${this.nick(p)}คายอาหารทิ้งแล้วหน้าซีด บอกว่ามันมีรสแปลก ๆ`, 'witness');
        this.recordEvent(`${this.nick(p)}เกือบกินอาหารมีพิษที่${this.zn(z)}แต่รู้ทัน`);
        return;
      }
      const setter = this.players.get(food.poisoned.setterId) || null;
      if ((food.poisoned.poisonTags || []).includes('sedative')) {
        // ยานอนหลับ/ยาสลบในอาหาร = สลบ 1–3 ชั่วโมง ไม่ตาย ไม่เป็นคดี
        const hours = this.koHours();
        const dropped = this.knockOut(p, hours, { cause: 'sedative', by: setter?.id || null });
        z.evidence.push(this.makeEvidence(z.id, `ขอบภาชนะของ${food.name}มีคราบผง — มีคนผสมยาทำให้สลบไว้`, false, null, 'poison'));
        this.logTo(p, `😵 คุณกิน${food.name}ไปได้ไม่กี่คำก็เวียนหัวแล้วหมดสติ — มีคนผสม${food.poisoned.poisonName}ไว้ คุณจะฟื้นในอีก ${hours} ชั่วโมง${dropped.length ? ` ของหล่นจากมือ: ${dropped.join(', ')}` : ''} ระหว่างนี้ใครลงมือกับคุณก็สำเร็จแน่นอน`, 'danger');
        for (const o of this.awakeIn(z.id)) if (o.id !== p.id) this.logTo(o, `😱 ${this.nick(p)}กิน${food.name}แล้วล้มลงหมดสติต่อหน้าคุณ — อาหารในห้องนี้มีคนผสมยาไว้!`, 'witness');
        if (setter?.alive) this.logTo(setter, `💤 ยาที่คุณผสมใน${food.name}ที่${this.zn(z)}ออกฤทธิ์ — ${this.nick(p)}สลบ ${hours} ชั่วโมง (ยานอนหลับ/ยาสลบไม่ฆ่าใคร)`, 'culprit');
        food.poisoned.usesLeft = (food.poisoned.usesLeft ?? 1) - 1; // หมดท้ายชั่วโมง (settleFood) คนที่กินพร้อมกันยังโดน
        this.recordEvent(`${this.nick(p)}กินอาหารผสมยาสลบ (${food.name}) ของ${setter ? this.nick(setter) : '?'}ที่${this.zn(z)}และสลบ ${hours} ชม.`);
        return;
      }
      const kase = this.killPlayer(p, { cause: 'trap', trapType: 'poison', killerId: setter?.id || null, weapon: { name: food.poisoned.poisonName, kind: 'poison' }, zoneId: z.id, messy: false, witnesses: [] });
      const ptags = food.poisoned.poisonTags || [];
      z.evidence.push(this.makeEvidence(z.id, `ภาชนะของ${food.name}มี${ptags.includes('pungent') ? 'กลิ่นฉุนของสารเคมี' : ptags.includes('tasteless') ? 'คราบผงจาง ๆ ที่ไม่มีกลิ่น' : 'คราบและกลิ่นเคมีจาง ๆ'}ติดอยู่ที่ขอบ`, false, kase.id, 'trap')); // ไม่บอกชื่อยา
      this.logTo(p, `💀 ${fill(TRAP_TYPES.poison.trigger, food.poisoned.poisonName)} คุณเสียชีวิตที่${this.zn(z)}... ตอนนี้ทำได้เพียงเฝ้าดู`, 'death');
      for (const o of this.awakeIn(z.id)) {
        o.knownBodies.add(p.id);
        this.bodies.get(p.id).discoveredBy.add(o.id);
        this.logTo(o, `😱 ${this.nick(p)}กิน${food.name}ไปได้ไม่กี่คำก็ล้มลงชักและเสียชีวิตต่อหน้าคุณ — อาหารในห้องนี้มีพิษ!`, 'witness');
      }
      if (setter?.alive) this.logTo(setter, `☠ ยาพิษที่คุณผสมใน${food.name}ที่${this.zn(z)}ทำงานแล้ว — ${this.nick(p)}ตาย คุณคือคนร้ายของคดีนี้`, 'culprit');
      food.poisoned.usesLeft = (food.poisoned.usesLeft ?? 1) - 1; // หมดท้ายชั่วโมง (settleFood)
      this.recordEvent(`${this.nick(p)}กินอาหารมีพิษ (${kase.weapon.name}) ของ${setter ? this.nick(setter) : '?'}ที่${this.zn(z)}และเสียชีวิต`);
      return;
    }
    if (food.buff) {
      // ยาที่ผสมไว้ออกฤทธิ์กับคนกิน — พอสำหรับ 3 คน (คนที่กินพร้อมกันในชั่วโมงเดียวได้ทุกคน แล้วค่อยหมด)
      food.buff.usesLeft = (food.buff.usesLeft ?? 3) - 1;
      if (food.buff.kind === 'tonic') {
        p.buffs.questPlus = Math.min(2, (p.buffs.questPlus || 0) + 1);
        this.logTo(p, `💊 กินแล้วรู้สึกกระปรี้กระเปร่าผิดปกติ — ภารกิจถัดไปของคุณจะมีเวลาเพิ่ม ${p.buffs.questPlus} ชั่วโมง`, 'action');
      } else {
        p.buffs.koResist = 1;
        this.logTo(p, '💊 กินแล้วรู้สึกหัวโล่งแจ่มใส — คุณจะฝืนไม่สลบได้ 1 ครั้ง', 'action');
      }
    }
    this.logTo(p, `🍞 คุณกิน${food.name}และพักสักครู่ที่${this.zn(z)}${food.poisoned ? ' (คุณรู้ว่าต้องเลี่ยงส่วนไหน)' : ''}`, 'action');
    for (const o of this.witnessesOf(p, z)) if (chance(0.5)) this.logTo(o, `👀 คุณเห็น${who}นั่งกินอาหารอยู่ที่${this.zn(z)}`, 'witness');
    this.checkObjectivesAfterEat(p);
  }

  do_lock(p) {
    const z = this.zones.get(p.zoneId);
    if (!z.lockable || z.locked || !this.hasKeyFor(p, z.id)) return this.logTo(p, 'ล็อกห้องนี้ไม่ได้', 'danger');
    z.locked = true;
    p.zoneMemory[z.id] = { ...(p.zoneMemory[z.id] || {}), locked: true };
    // ล็อกเงียบ ๆ: คนอื่นในห้องยังไม่รู้ จะสังเกตเห็นตอนต้นชั่วโมงถัดไป (ใน resolveMoves)
    this.logTo(p, `🔒 คุณล็อกประตู${this.zn(z)}แล้ว ชั่วโมงถัดไปคนที่ไม่มีกุญแจจะเข้าไม่ได้และคนข้างในออกไม่ได้ · คนอื่นในห้องยังไม่ทันสังเกต จะรู้ตอนชั่วโมงถัดไป`, 'action');
    this.recordEvent(`${this.nick(p)}ล็อก${this.zn(z)}`);
  }

  do_unlock(p) {
    const z = this.zones.get(p.zoneId);
    if (!z.locked || !this.hasKeyFor(p, z.id)) return this.logTo(p, 'ปลดล็อกไม่ได้', 'danger');
    z.locked = false;
    z.unlockedBy = { id: p.id, turn: this.turn }; // คนเปิดประตู (กับดักประตูเล่นงานคนนี้ก่อนเมื่อเดินผ่าน)
    p.zoneMemory[z.id] = { ...(p.zoneMemory[z.id] || {}), locked: false };
    this.logTo(p, `🔓 คุณปลดล็อกประตู${this.zn(z)}แล้ว ใครก็เข้าได้${p.outside ? ' — ชั่วโมงถัดไปเลือกห้องนี้เพื่อเข้าไป' : ''} · คนอื่นในห้องจะสังเกตเห็นตอนชั่วโมงถัดไป`, 'action');
    this.recordEvent(`${this.nick(p)}ปลดล็อก${this.zn(z)}`);
  }

  // ล้างคราบเลือดออกจากของที่ถือ (ห้องที่มีน้ำ) — อ่างเก็บคราบจาง ๆ ไว้ (ซ่อนอยู่ สำรวจละเอียดถึงเจอ)
  do_wash(p) {
    const z = this.zones.get(p.zoneId);
    const dirty = p.inventory.filter((i) => i.bloody);
    if (!z?.water || !dirty.length) return this.logTo(p, 'ไม่มีอะไรให้ล้างที่นี่', 'action');
    for (const i of dirty) i.bloody = false;
    z.evidence.push(this.makeEvidence(z.id, 'คราบเลือดจาง ๆ ติดอยู่ตามขอบอ่างและร่องท่อ เหมือนเพิ่งมีคนล้างอะไรสักอย่าง', true, null, 'wash'));
    const who = this.who(p, z);
    this.logTo(p, `🚿 คุณล้าง${dirty.map((i) => i.name).join(', ')}จนไม่เหลือคราบเลือด — แต่อ่างอาจเก็บคราบจาง ๆ ไว้ให้คนสำรวจละเอียดเจอ`, 'culprit');
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.6)) this.logTo(o, `👀 คุณเห็น${who}ขัดล้างอะไรบางอย่างที่อ่างอย่างเร่งรีบ น้ำที่ไหลออกมามีสีคล้ำ`, 'witness');
    this.recordEvent(`${this.nick(p)}ล้างคราบเลือดจาก${dirty.map((i) => i.name).join(', ')}ที่${this.zn(z)}`);
  }

  // ท้ายชั่วโมง: ยาที่ผสมในอาหารซึ่งถูกกินครบจำนวนคน (พิษ/ยาสลบ 1 คน · บัฟ 3 คน) หมดไป
  settleFood() {
    for (const z of this.zones.values()) {
      for (const f of z.items) {
        if (f.kind !== 'food') continue;
        if (f.poisoned && (f.poisoned.usesLeft ?? 1) <= 0) f.poisoned = null;
        if (f.buff && (f.buff.usesLeft ?? 3) <= 0) f.buff = null;
      }
    }
  }

  // ซ่อมของที่พัง (แอ็กชันทำซ้ำ): เสร็จแล้วใช้ได้ตามเดิม — ใช้เครื่องมือช่าง (ไม่หมด) หรือเชือก/เทป (หมดไป 1 ชิ้น)
  do_repairItem(p, a) {
    const it = p.inventory.find((i) => i.id === a.itemId && i.broken);
    const fixer = p.inventory.find((i) => !i.broken && tagsOf(i).has('fastener')) || p.inventory.find((i) => !i.broken && (i.kind === 'rope' || tagsOf(i).has('cord')));
    if (!it || !fixer) return this.logTo(p, 'ไม่มีของให้ซ่อม หรือไม่มีเชือก/เทป/เครื่องมือช่าง', 'danger');
    const hours = this.traitOf(p) === 'tech' ? DURABILITY.REPAIR_HOURS_TECH : DURABILITY.REPAIR_HOURS;
    if (p.repairWork?.itemId !== it.id) p.repairWork = { itemId: it.id, need: randInt(hours[0], hours[1]), progress: 0 };
    p.repairWork.progress++;
    if (p.repairWork.progress < p.repairWork.need) return this.logTo(p, `🔧 คุณซ่อม${it.name}ไปได้บางส่วน (ทำไปแล้ว ${p.repairWork.progress} ชั่วโมง) — เลือกซ่อมอีกครั้งชั่วโมงหน้า`, 'action');
    p.repairWork = null;
    it.broken = false;
    if (!tagsOf(fixer).has('fastener')) p.inventory.splice(p.inventory.indexOf(fixer), 1);
    this.logTo(p, `🔧 คุณซ่อม${it.name}เสร็จแล้ว${tagsOf(fixer).has('fastener') ? ` ด้วย${fixer.name}` : ` ใช้${fixer.name}หมดไป`} ใช้ได้ตามเดิม`, 'action');
    this.recordEvent(`${this.nick(p)}ซ่อม${it.name}`);
  }

  // ---------- ประตู (ทำเอง) ----------
  // ไขกุญแจ/ล็อกด้วยกุญแจที่ตรง ทำได้ทันที ไม่กินชั่วโมง ทำได้ทุกขั้น — ทั้งจากในห้องและตอนยืนรอหน้าประตู (ทำเงียบ ๆ คนอื่นสังเกตเห็นตอนต้นชั่วโมงถัดไป)
  doorActions(p) {
    const z = this.zones.get(p.zoneId);
    if (!z || !p.alive || p.ko) return [];
    const out = [];
    const key = z.lockable ? p.inventory.find((i) => i.kind === 'key' && i.unlocksZoneIds?.includes(z.id)) : null;
    if (p.outside) {
      if (key && z.locked) out.push({ type: 'unlockDoor', label: `🔑 ไขกุญแจเปิดประตู${this.zn(z)} (ทันที)`, desc: `ประตูเปิดให้ใครก็เข้าได้ — ชั่วโมงถัดไปเลือกห้องนี้เพื่อเข้าไป${z.bar ? ' (แต่ประตูยังถูกค้ำจากข้างใน ต้องพัง)' : ''}` });
      else if (key) out.push({ type: 'lockDoor', label: `🔒 ล็อกประตู${this.zn(z)}จากข้างนอก (ทันที)`, desc: 'คนข้างในออกไม่ได้ถ้าไม่มีกุญแจ ต้องสะเดาะหรือพังประตู' });
      return out;
    }
    const knownLocked = p.zoneMemory[z.id]?.locked === true;
    if (key && z.locked && knownLocked) out.push({ type: 'unlockDoor', label: `🔓 ปลดล็อกประตูห้องนี้ (ด้วย${key.name} · ทันที)`, desc: 'เปิดให้ใครก็เข้า-ออกได้ · คนอื่นในห้องจะสังเกตเห็นตอนชั่วโมงถัดไป' });
    if (key && !z.locked && !knownLocked) out.push({ type: 'lockDoor', label: `🔒 ล็อกประตูห้องนี้ (ด้วย${key.name} · ทันที)`, desc: 'ชั่วโมงถัดไปคนที่ไม่มีกุญแจเข้าไม่ได้และคนข้างในออกไม่ได้ · คนในห้องตอนนี้ยังไม่ทันสังเกต' });
    // ค้ำประตูจากข้างในด้วยแท่งเหล็ก/ท่อนไม้: กุญแจและที่สะเดาะจากข้างนอกใช้ไม่ได้ ต้องพัง · คนข้างในเอาออกได้ทันที
    if (z.id !== this.location.sleepZoneId && !z.broken) {
      if (z.bar) out.push({ type: 'removeBar', label: `🚧 เอา${z.bar.item.name}ที่ค้ำประตูออก (ทันที)`, desc: 'ประตูกลับมาเปิดได้ตามปกติ ที่ค้ำจะวางอยู่ในห้อง' });
      else for (const it of p.inventory.filter((i) => tagsOf(i).has('rod'))) out.push({ type: 'barDoor', itemId: it.id, label: `🚧 ค้ำประตูห้องนี้ด้วย${it.name} (ทันที)`, desc: 'คนข้างนอกเข้าไม่ได้แม้มีกุญแจ ต้องพังประตู (เสียงดัง) · คนในห้องเห็นคุณทำ · คนข้างในเอาที่ค้ำออกได้ทันที' });
    }
    // พังเครื่องปั่นไฟ (ทันที): ไฟดับทั้งตึกจนกว่าจะมีคนซ่อม (แอ็กชัน 2–3 ชม. ช่างเทคนิค 1)
    if (!this.blackout && this.turn >= (this.powerCooldownUntil || 0) && z.items.some((i) => i.kind === 'power')) out.push({ type: 'breakPower', label: '⚡ พังเครื่องปั่นไฟ (ทันที) — ไฟดับทั้งตึก', desc: 'ทุกห้องมืด ใครไม่มีของส่องสว่างจะมองไม่เห็นคนและของ (หยิบได้แค่คลำสุ่ม 1 ชิ้นต่อชั่วโมง เทรดไม่ได้) จนกว่าจะมีคนมาซ่อมที่นี่ · คนในห้องนี้เห็นคุณทำ', danger: true });
    return out;
  }

  instantDoorAction(playerId, type, itemId) {
    this.assertPhase(PHASE.DAY, PHASE.INVESTIGATION);
    if (!this.step) throw new GameError('กำลังประมวลผลอยู่');
    const p = this.alivePlayer(playerId);
    if (p.ko) throw new GameError('😵 คุณสลบอยู่ ทำอะไรไม่ได้จนกว่าจะฟื้น');
    const match = this.doorActions(p).find((a) => a.type === type && (!a.itemId || !itemId || a.itemId === itemId));
    if (!match) throw new GameError('ทำแอ็กชันนี้ไม่ได้');
    if (type === 'unlockDoor') this.do_unlock(p);
    else if (type === 'lockDoor') this.do_lock(p);
    else if (type === 'barDoor') this.barDoor(p, match.itemId);
    else if (type === 'removeBar') this.removeBar(p);
    else if (type === 'breakPower') this.breakPower(p);
    this.emit();
    return match;
  }

  barDoor(p, itemId) {
    const z = this.zones.get(p.zoneId);
    const idx = p.inventory.findIndex((i) => i.id === itemId);
    if (idx < 0 || z.bar) return;
    const it = p.inventory.splice(idx, 1)[0];
    z.bar = { item: it, by: p.id, turn: this.turn };
    const who = this.who(p, z);
    this.logTo(p, `🚧 คุณเอา${it.name}ค้ำประตู${this.zn(z)}ไว้จากข้างใน — คนข้างนอกเข้าไม่ได้แม้มีกุญแจ ต้องพังประตู (ใครในห้องก็เอาที่ค้ำออกได้)`, 'action');
    for (const o of this.witnessesOf(p)) this.logTo(o, `👀 คุณเห็น${who}เอา${it.name}ค้ำประตู${this.zn(z)}ไว้`, 'witness');
    this.recordEvent(`${this.nick(p)}ค้ำประตู${this.zn(z)}ด้วย${it.name}`);
  }

  removeBar(p) {
    const z = this.zones.get(p.zoneId);
    if (!z.bar) return;
    const it = z.bar.item;
    z.bar = null;
    it.hidden = false;
    z.items.push(it);
    z.unlockedBy = { id: p.id, turn: this.turn };
    const who = this.who(p, z);
    this.logTo(p, `🚧 คุณเอา${it.name}ที่ค้ำประตู${this.zn(z)}ออกแล้ว (วางไว้ในห้อง) ประตูเปิดได้ตามปกติ`, 'action');
    for (const o of this.witnessesOf(p)) this.logTo(o, `👀 คุณเห็น${who}เอา${it.name}ที่ค้ำประตูออก`, 'witness');
    this.recordEvent(`${this.nick(p)}เอาที่ค้ำประตู${this.zn(z)}ออก`);
  }

  // พังเครื่องปั่นไฟ: ไฟดับทั้งตึกทันที — ทุกคนรู้ว่าไฟดับ คนในห้องนั้นเห็นว่าใครทำ (ถ้ายังมองเห็น)
  breakPower(p) {
    const z = this.zones.get(p.zoneId);
    const power = z.items.find((i) => i.kind === 'power');
    const who = this.who(p, z);
    for (const o of this.witnessesOf(p)) this.logTo(o, `👀 คุณเห็น${who}พัง${power?.name || 'เครื่องปั่นไฟ'} แล้วไฟก็ดับวูบ`, 'witness');
    this.blackout = { since: this.turn, by: p.id, zoneId: z.id };
    for (const o of this.players.values()) if (o.alive && !o.ko) this.logTo(o, `💡 ไฟทั้งอาคารดับวูบลงพร้อมกัน — ใครไม่มีของส่องสว่าง (เทียน/ไฟฉาย/ไฟแช็ก) จะมองไม่เห็นคนและของรอบตัว จนกว่าจะมีคนซ่อมเครื่องปั่นไฟ`, 'danger');
    z.evidence.push(this.makeEvidence(z.id, `${power?.name || 'เครื่องปั่นไฟ'}ถูกทำให้หยุดทำงานด้วยมือคน สายไฟถูกดึงหลุดและสวิตช์ถูกสับทิ้ง`, false, null, 'power'));
    this.logTo(p, `⚡ คุณพัง${power?.name || 'เครื่องปั่นไฟ'} ไฟทั้งอาคารดับสนิท — ซ่อมได้ที่ห้องนี้ (2–3 ชั่วโมง ช่างเทคนิค 1)`, 'culprit');
    this.recordEvent(`${this.nick(p)}พังเครื่องปั่นไฟที่${this.zn(z)} ไฟดับทั้งตึก`);
  }

  // ซ่อมเครื่องปั่นไฟ (แอ็กชันของชั่วโมง ทำซ้ำจนครบ) — เสร็จแล้วไฟติดทั้งตึก
  do_repairPower(p) {
    const z = this.zones.get(p.zoneId);
    if (!this.blackout || !z.items.some((i) => i.kind === 'power')) return this.logTo(p, 'ไม่มีอะไรให้ซ่อมที่นี่', 'action');
    // ความคืบหน้าอยู่ที่เครื่อง: ทุกคนที่ซ่อมพร้อมกันบวกรวม (คนทั่วไป +1/ชม. ช่างเทคนิคซ่อมเสร็จในชั่วโมงเดียว) และไม่มีใครถูกบอกว่าใครซ่อมด้วย
    z.powerWork ||= { need: randInt(POWER.REPAIR_HOURS[0], POWER.REPAIR_HOURS[1]), progress: 0 };
    z.powerWork.progress += this.traitOf(p) === 'tech' ? z.powerWork.need : 1;
    if (z.powerWork.progress < z.powerWork.need) return this.logTo(p, `🔧 คุณซ่อมเครื่องปั่นไฟไปได้บางส่วน (คืบหน้ารวม ${z.powerWork.progress} — ถ้ามีคนซ่อมพร้อมกันแรงจะรวมกัน) — เลือกแอ็กชันนี้อีกครั้งชั่วโมงหน้า`, 'action');
    z.powerWork = null;
    this.blackout = null;
    this.powerCooldownUntil = this.turn + randInt(POWER.BREAK_COOLDOWN[0], POWER.BREAK_COOLDOWN[1]); // เพิ่งซ่อม พังซ้ำไม่ได้ 2–5 ชั่วโมง
    this.logTo(p, '🔧 คุณซ่อมเครื่องปั่นไฟสำเร็จ ไฟทั้งอาคารกลับมาติด', 'action');
    for (const o of this.players.values()) if (o.alive && !o.ko && o.id !== p.id) this.logTo(o, '💡 ไฟทั้งอาคารกลับมาติดแล้ว — มีคนซ่อมเครื่องปั่นไฟ', 'witness');
    this.recordEvent(`${this.nick(p)}ซ่อมเครื่องปั่นไฟที่${this.zn(z)} ไฟกลับมาติด`);
  }

  // คลำหาของในความมืด: ได้ของสุ่ม 1 ชิ้นที่วางอยู่ แล้วจบชั่วโมง
  do_grope(p) {
    const z = this.zones.get(p.zoneId);
    const cands = z.items.filter((i) => !i.hidden && i.portable);
    if (!cands.length || p.inventory.length >= this.invMax(p)) return this.logTo(p, '🖐 คุณคลำไปทั่วห้องแต่ไม่ได้อะไรติดมือมา', 'action');
    const it = pick(cands);
    z.items.splice(z.items.indexOf(it), 1);
    p.inventory.push(it);
    this.markDeviceTaken(p, z, it);
    this.logTo(p, `🖐 คุณคลำไปในความมืดแล้วหยิบอะไรบางอย่างติดมือมา — พอคลำดูก็รู้ว่าเป็น${it.name}`, 'action');
    onObtainItem(this, p, it);
    this.recordEvent(`${this.nick(p)}คลำได้${it.name}ในความมืดที่${this.zn(z)}`);
    this.checkObjectivesAfterTake(p, it);
  }

  // สะเดาะ/พังประตูที่ล็อก (แอ็กชันของชั่วโมง) ทำซ้ำทุกชั่วโมงจนครบ — เสร็จแล้วประตูเปิด แต่ยังยืนอยู่ที่เดิม (ชั่วโมงถัดไปค่อยเลือกห้องเพื่อเข้า/ออก)
  do_doorwork(p) {
    const door = this.zones.get(p.zoneId);
    if (!door?.locked && !door?.bar) return this.logTo(p, 'ประตูไม่ได้ล็อกแล้ว', 'action');
    const means = this.doorMeans(p, door);
    // ความคืบหน้าอยู่ที่ประตู (ไม่ใช่ที่คน): ใครทำพร้อมกันก็บวกรวม — นักสู้พัง +3 แต้ม/ชม. คนอื่น +1 · สะเดาะ +1
    door.doorWork ||= {};
    const w = (door.doorWork[means.method] ||= { need: randInt(means.method === 'break' ? DOOR.BREAK_HOURS_OTHERS[0] : means.hours[0], means.method === 'break' ? DOOR.BREAK_HOURS_OTHERS[1] : means.hours[1]), progress: 0, startedTurn: this.turn });
    const gain = means.method === 'break' && this.traitOf(p) === 'combat' ? 3 : 1; // นักสู้ +3/ชม. (คนเดียว 1–2 ชม. เท่าเดิม) คนอื่น +1
    w.progress += gain;
    p.doorWork = { zoneId: door.id, method: means.method };
    const icon = w.method === 'break' || means.method === 'break' ? '💥' : '🪛';
    const verb = means.method === 'break' ? 'พังประตู' : 'สะเดาะกลอน';
    const withTool = means.item ? `ด้วย${means.item.name}` : 'ด้วยมือเปล่า';
    const fromSide = p.outside ? 'ข้างนอก' : 'ข้างใน';
    // เสียงไปถึงอีกฝั่งของประตู/ห้องอื่น — คนที่ทำพร้อมกันไม่ถูกบอกว่าใครทำด้วย
    for (const o of this.alivePlayers()) {
      if (o.id === p.id || o.ko) continue;
      if (o.zoneId === door.id && !!o.outside === !!p.outside) continue;
      if (o.zoneId === door.id) {
        if (means.method === 'break') this.logTo(o, `💥 มีเสียงทุบกระแทกประตู${this.zn(door)}ดังสนั่นจาก${fromSide} — ใครบางคนกำลังพยายามพังประตู`, 'danger');
        else if (chance(DOOR.PICK_HEARD)) this.logTo(o, `👂 คุณได้ยินเสียงแกรกกรากเบา ๆ ที่กลอนประตู${this.zn(door)}`, 'witness');
      } else if (means.method === 'break' && chance(DOOR.BREAK_HEARD_FAR)) this.logTo(o, `👂 คุณได้ยินเสียงทุบกระแทกดังมาจากทาง${this.zn(door)}`, 'witness');
    }
    if (w.progress < w.need) {
      this.logTo(p, `${icon} คุณใช้ชั่วโมงนี้${verb}${this.zn(door)}${withTool} ยังไม่สำเร็จ (คืบหน้ารวม ${w.progress} — ถ้ามีคนทำพร้อมกันแรงจะรวมกัน) — เลือกแอ็กชันนี้อีกครั้งชั่วโมงหน้าเพื่อทำต่อ`, 'action');
      return;
    }
    door.locked = false;
    door.doorWork = null;
    door.unlockedBy = { id: p.id, turn: this.turn };
    if (means.method === 'break') {
      if (door.bar) {
        door.bar.item.hidden = false;
        door.items.push(door.bar.item); // ที่ค้ำหลุดตกอยู่ในห้อง
        door.bar = null;
      }
      door.broken = true;
      door.lockable = false;
      door.evidence.push(this.makeEvidence(door.id, `ประตู${door.name}ถูกพังจนบานเบี้ยวและกลอนหลุด ล็อกไม่ได้อีกแล้ว`, false, null, 'door'));
      this.logTo(p, `💥 ประตู${this.zn(door)}พังสำเร็จ${withTool} บานประตูพังจนล็อกไม่ได้อีก — ชั่วโมงถัดไปเลือกห้องเพื่อ${p.outside ? 'เข้าไป' : 'ออกไป'}`, 'action');
      this.recordEvent(`${this.nick(p)}พังประตู${this.zn(door)}`);
    } else {
      this.logTo(p, `🪛 กลอนประตู${this.zn(door)}เปิดออกสำเร็จ${withTool} ประตูเปิดแล้ว (ไม่ได้ล็อกอีก จนกว่าจะมีคนล็อกใหม่) — ชั่วโมงถัดไปเลือกห้องเพื่อ${p.outside ? 'เข้าไป' : 'ออกไป'}`, 'action');
      this.recordEvent(`${this.nick(p)}สะเดาะกลอน${this.zn(door)}ได้สำเร็จ`);
    }
    for (const o of this.alivePlayers()) {
      if (o.id === p.id || o.zoneId !== door.id) continue;
      o.zoneMemory[door.id] = { ...(o.zoneMemory[door.id] || {}), locked: false, broken: door.broken };
      if (!o.ko) this.logTo(o, `🚪 ประตู${this.zn(door)}เปิดออก — ${means.method === 'break' ? 'ถูกพังจาก' : 'มีคนสะเดาะกลอนจาก'}${fromSide}`, 'danger');
    }
    p.doorWork = null;
    p.zoneMemory[door.id] = { ...(p.zoneMemory[door.id] || {}), locked: false, broken: door.broken };
  }

  do_clean(p) {
    const z = this.zones.get(p.zoneId);
    const vis = z.evidence.filter((e) => !e.hidden && !e.outside && !e.gone && !['door', 'power'].includes(e.kind)); // ประตูพัง/แผงไฟ ไม่ใช่ร่องรอยที่เก็บกวาดได้
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
    if (p.inventory.length >= this.invMax(p)) return this.logTo(p, `คุณถือของเต็มมือแล้ว`, 'danger');
    const it = z.items.splice(idx, 1)[0];
    p.inventory.push(it);
    this.markDeviceTaken(p, z, it);
    const who = this.who(p, z);
    this.logTo(p, `🖐 คุณหยิบ${it.name}${it.isPart ? ' ⭐' : ''}มาไว้กับตัว${it.kind === 'key' && it.unlocksZoneIds?.length ? ` — ใช้ล็อก/ปลดล็อก${it.unlocksZoneIds.map((id) => this.zoneName(id)).join(', ')}ได้` : ''}`, it.isPart ? 'escape' : 'action');
    onObtainItem(this, p, it);
    this.recordEvent(`${this.nick(p)}หยิบ${it.name}จาก${this.zn(z)}`);
    for (const o of this.witnessesOf(p, z)) if (this.seen(p, 0.5)) this.logTo(o, `👀 คุณเห็น${who}หยิบ${it.name}ติดตัวไป`, 'witness');
    this.checkObjectivesAfterTake(p, it);
  }

  // เก็บอุปกรณ์กับดักที่ทำงานแล้วออกจากที่เกิดเหตุ: หลักฐาน "อุปกรณ์ยังค้างอยู่" หายไป เหลือเศษร่องรอยแทน
  // สายเงียบเชียบเก็บเนียน = เศษถูกซ่อน (ต้องสำรวจละเอียดถึงเจอ) · คนอื่นเก็บแล้วเศษเห็นชัด
  markDeviceTaken(p, z, it) {
    if (!it.deviceOf) return;
    const { caseId, trapType } = it.deviceOf;
    it.deviceOf = null;
    for (const e of z.evidence) if (e.deviceItemId === it.id) e.gone = true;
    const scene = TRAP_SCENE[trapType];
    if (!scene) return;
    const sneaky = this.traitOf(p) === 'stealth';
    z.evidence.push(this.makeEvidence(z.id, scene.residue, sneaky, caseId, 'residue', false));
    this.logTo(p, sneaky ? `🤫 คุณแกะ${it.name}ออกจากกลไกอย่างเนียน เหลือร่องรอยน้อยมาก` : `⚠ คุณแกะ${it.name}ออกจากกลไกที่ประตู แต่เศษเชือก/รอยยึดยังเหลืออยู่ให้คนสังเกตเห็น`, 'danger');
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

  // ซ่อนของหลายชิ้นในชั่วโมงเดียว (คนในห้องอาจเห็นแต่ละชิ้น)
  do_hide(p, a) {
    for (const id of a.itemIds || [a.itemId]) this.placeItem(p, { ...a, itemId: id }, true);
  }

  do_drop(p, a) {
    this.placeItem(p, a, false);
  }

  do_search(p) {
    const z = this.zones.get(p.zoneId);
    (this.searchedThisHour ||= new Set()).add(p.id);
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
      if ((it.isPart || it.kind === 'clue') && p.inventory.length < this.invMax(p)) {
        z.items.splice(z.items.indexOf(it), 1);
        p.inventory.push(it);
        lines.push(`${it.kind === 'clue' ? '🗺' : '⭐'} คุณเจอ${it.name}ซ่อนอยู่! คุณเก็บมันไว้กับตัวแล้ว`);
        onObtainItem(this, p, it);
        this.recordEvent(`${this.nick(p)}ค้นเจอ${it.name}ที่${this.zn(z)}`);
      } else {
        lines.push(`🔍 คุณเจอ${it.name}${it.isPart ? ' ⭐' : ''}ซ่อนอยู่ในห้องนี้ (ตอนนี้มันวางให้เห็นแล้ว${it.isPart || it.kind === 'clue' ? ' คุณถือของเต็มมือจึงยังไม่ได้หยิบ' : ''})`);
      }
    }
    const exitsFound = tryFindExit(this, p, z, (det ? ESCAPE.FIND_EXIT_DETECTIVE_BONUS : 0) + (CONFIG.FIND_EXIT_CHANCE - ESCAPE.FIND_EXIT_CHANCE)); // CONFIG ปรับได้จาก .env/เทสต์
    for (const ps of this.passages.filter((x) => (x.a === z.id || x.b === z.id) && !p.knownPassages.has(x.id))) {
      if (!chance(det ? PASSAGE.FIND_DETECTIVE : PASSAGE.FIND)) continue;
      p.knownPassages.add(ps.id);
      const other = ps.a === z.id ? ps.b : ps.a;
      lines.push(`🕳 คุณพบทางลับ! หลังตู้/ใต้พรมมีช่องเชื่อมไป${this.zn(other)} — เลือกห้องนั้นจากแผนที่ได้เลย เดินผ่านได้แม้ประตูล็อกหรือถูกค้ำ และไม่ผ่านประตู (กับดักประตูไม่ทำงาน)`);
      this.recordEvent(`${this.nick(p)}พบทางลับ ${this.zn(z)} ↔ ${this.zn(other)}`);
    }
    if (exitsFound.length) lines.push(`🚪 ค้นพบทางออกที่ซ่อนอยู่: ${exitsFound.map((x) => x.name).join(', ')} (รายละเอียดอยู่ในบันทึกอีกบรรทัด)`);
    const newEv = z.evidence.filter((e) => !e.outside && !e.gone && !p.evidence.includes(e.id) && (!e.hidden || chance(CONFIG.FIND_HIDDEN_CHANCE + bonus)));
    for (const e of newEv) {
      p.evidence.push(e.id);
      lines.push(`🧩 หลักฐาน: ${e.text}`);
    }
    const orig = (this.location.zones.find((zz) => zz.id === z.id)?.items || []).filter((i) => i.portable);
    const missing = orig.filter((oi) => !z.items.some((i) => i.id === oi.id) && !p.inventory.some((i) => i.id === oi.id));
    if (missing.length) lines.push(`❓ ของที่ควรอยู่ในห้องนี้แต่หายไป: ${missing.map((i) => i.name).join(', ')}`);
    const trap = z.traps.find((t) => t.setterId !== p.id && t.side !== 'outside');
    if (trap && chance(0.3 + bonus)) lines.push(`⚠ คุณสังเกตเห็นว่า${trap.item.name}ถูกติดตั้งไว้ที่ทางเข้าอย่างผิดปกติ เหมือนเป็นกับดัก (คุณไม่ได้แตะต้องมัน)`);
    const food = z.items.find((i) => i.kind === 'food');
    if (food?.poisoned && food.poisoned.setterId !== p.id && chance((det ? 0.6 : 0.25) + (this.traitOf(p) === 'medical' ? 0.35 : 0))) lines.push(`☠ ${food.name}มีกลิ่นเคมีจาง ๆ และคราบผงที่ขอบภาชนะ — อย่ากินอะไรในห้องนี้`);
    if (!lines.length) lines.push('ไม่พบอะไรผิดปกติในห้องนี้');
    this.logTo(p, `🔍 สำรวจ${this.zn(z)}: ${lines.join(' · ')}`, 'evidence');
    if (p.zoneMemory[z.id]) p.zoneMemory[z.id].searched = this.turn;
  }

  // ตรวจศพ — ไม่เอ่ยชื่อของ: คนทั่วไปเห็นชนิดบาดแผล ตำแหน่งศพ และเวลาตายคร่าว ๆ · สายการแพทย์เห็นชนิดวัสดุ จำนวน/ทิศทางแผล เวลาตายแน่นอน และว่าศพถูกย้ายไหม
  // ตัวอุปกรณ์ (ขวาน ปืน เชือก) ต้องไปเจอในห้องเองด้วยการสำรวจ
  do_examine(p, a) {
    const b = this.bodies.get(a.victimId);
    if (!b || b.judged || b.zoneId !== p.zoneId || !!b.outside !== !!p.outside) return this.logTo(p, 'ศพไม่ได้อยู่ตรงนี้แล้ว', 'danger');
    const kase = this.caseOf(b.caseId);
    const v = this.players.get(b.victimId);
    b.examinedBy.add(p.id);
    const med = this.traitOf(p) === 'medical';
    const w = kase.weapon;
    const tags = tagSetOf(w);
    const isTrap = kase.cause === 'trap';
    const wound = isTrap && kase.trapType === 'shock' ? 'burn' : (isTrap && kase.trapType === 'poison') || w?.kind === 'poison' ? 'poison' : w ? woundOf(w) : 'hands';
    const injected = w?.kind === 'poison' && /ฉีดด้วย/.test(w.name || '');
    const parts = [];
    let lay = WOUND_LAY[wound] || WOUND_LAY.blunt;
    if (wound === 'pierce' && tags.has('firearm')) lay = 'บาดแผลทะลุที่หน้าอก รอบแผลมีคราบดำไหม้ เหมือนถูกยิงระยะใกล้';
    if (wound === 'poison' && injected) lay += ' มีรอยเข็มเล็ก ๆ ที่ข้างลำคอ';
    if (kase.cause === 'defense') lay = `รอยช้ำเต็มตัว ข้อนิ้วถลอก เหมือนผ่านการต่อสู้อย่างหนัก และ${lay}`;
    parts.push(lay);
    if (isTrap && !b.moved && TRAP_BODY_POS[kase.trapType]) parts.push(`ร่างนอนอยู่${TRAP_BODY_POS[kase.trapType]}`);
    if (med) {
      parts.push(`ชนิดของที่ทำ: ${materialOf(w, wound)}`);
      if (isTrap) parts.push(`${trapForensic(kase.trapType, wound)} ไม่มีร่องรอยการต่อสู้ — เหมือนไม่มีใครยืนอยู่ตรงหน้าเขาตอนเกิดเหตุ`);
      else if (kase.cause === 'defense') parts.push('ลำดับแผลบอกว่าเขาเป็นฝ่ายเปิดฉากต่อสู้ก่อนแล้วแพ้');
      else if (wound !== 'poison') parts.push(kase.messy ? 'หลายแผล ลงมือแบบรีบร้อน' : 'แผลเดียว ลงมือครั้งเดียวแม่นยำ');
    }
    const ago = this.turn - b.turn;
    parts.push(med ? `ตายมาแล้วราว ${Math.max(1, ago)} ชั่วโมง (วันที่ ${b.day} ชั่วโมงที่ ${b.hour})` : ago <= 1 ? 'ร่างยังอุ่น ตายไม่นาน' : ago <= 3 ? 'ร่างเริ่มเย็น ตายมาหลายชั่วโมงแล้ว' : 'ร่างเย็นและแข็งแล้ว ตายมานานมาก');
    if (b.moved) parts.push(med ? 'รอยเลือดตกค้างไม่ตรงกับท่าศพ — ศพถูกย้ายมาแน่นอน' : 'ท่าทางศพดูไม่เป็นธรรมชาติ เหมือนถูกจัดท่าหรือย้ายมา');
    else if (med) parts.push('ศพไม่ได้ถูกย้าย ตายตรงนี้');
    this.logTo(p, `🔎 ตรวจศพ${this.nick(v)}ที่${this.zn(b.zoneId)}: ${parts.join(' · ')}`, 'evidence');
    this.recordEvent(`${this.nick(p)}ตรวจศพของ${this.nick(v)}`);
  }

  do_steal(p, a) {
    const t = this.players.get(a.targetId);
    const z = this.zones.get(p.zoneId);
    if (!t?.alive || !this.sameSpot(p, t)) return this.logTo(p, 'เป้าหมายไม่อยู่แล้ว', 'danger');
    if (!t.inventory.length) return this.logTo(p, `🕵 คุณล้วงกระเป๋า${this.nick(t)} แต่เขาไม่ได้พกอะไรเลย`, 'action');
    if (p.inventory.length >= this.invMax(p)) return this.logTo(p, 'คุณถือของเต็มมือ ล้วงมาก็เก็บไม่ได้', 'danger');
    if (chance(0.7)) {
      const it = t.inventory.splice(Math.floor(Math.random() * t.inventory.length), 1)[0];
      p.inventory.push(it);
      this.logTo(p, `🕵 คุณล้วง${it.name}${it.isPart ? ' ⭐' : ''}${it.bloody ? ' (เปื้อนเลือด!)' : ''}มาจาก${this.nick(t)}ได้โดยที่เขาไม่รู้ตัว`, 'culprit');
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
    if (!t?.alive || !this.sameSpot(p, t)) return this.logTo(p, 'เป้าหมายไม่อยู่แล้ว', 'danger');
    if (t.ko) {
      // คนสลบตอบอะไรไม่ได้ และไม่รู้ว่าถูกซักถาม
      this.logTo(p, `🗣 คุณพยายามซักถาม${this.nick(t)} แต่เขาสลบอยู่ ไม่ได้คำตอบอะไรเลย`, 'action');
      this.recordEvent(`${this.nick(p)}พยายามซักถาม${this.nick(t)}ที่สลบอยู่ที่${this.zn(z)}`);
      return;
    }
    const facts = [];
    const prev = [...this.timeline].reverse().find((tl) => tl.turn < this.turn);
    if (prev?.positions[t.id]) facts.push(`ชั่วโมงก่อน (วันที่ ${prev.day} ชั่วโมงที่ ${prev.hour}) ${this.nick(t)}อยู่ที่${this.posName(prev.positions[t.id])}`);
    if (t.inventory.length) {
      const pk = pick(t.inventory);
      facts.push(`${this.nick(t)}พก${pk.name}${pk.bloody ? 'ที่เปื้อนเลือด' : ''}อยู่กับตัว`);
    }
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
      if (a.type !== 'rest' || a.ko) continue;
      const p = this.players.get(pid);
      if (!p?.alive || p.ko) continue;
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
    if (!this.sameSpot(p, t)) throw new GameError('ให้ของได้เฉพาะคนที่อยู่จุดเดียวกันตอนนี้ (ห้องเดียวกัน หรือยืนหน้าประตูเดียวกัน)');
    if (this.darkAt(p.zoneId, p.outside)) throw new GameError('🌑 มืดเกินกว่าจะยื่นของให้กัน — ต้องมีของส่องสว่างในห้อง');
    const idx = p.inventory.findIndex((i) => i.id === itemId);
    if (idx < 0) throw new GameError('คุณไม่มีของชิ้นนี้');
    if (t.inventory.length >= this.invMax(t)) throw new GameError(`${this.nick(t)}ถือของเต็มมือแล้ว`);
    const it = p.inventory.splice(idx, 1)[0];
    t.inventory.push(it);
    const z = this.zones.get(p.zoneId);
    this.logTo(p, `🎁 คุณให้${it.name}${it.isPart ? ' ⭐' : ''}แก่${this.nick(t)}`, 'action');
    this.logTo(t, `🎁 ${this.nick(p)}ให้${it.name}${it.isPart ? ' ⭐' : ''}แก่คุณ`, 'action');
    onObtainItem(this, t, it);
    for (const o of this.awakeWith(p)) if (o.id !== p.id && o.id !== t.id) this.logTo(o, `👀 คุณเห็น${this.nick(p)}ยื่น${chance(0.5) ? it.name : 'อะไรบางอย่าง'}ให้${this.nick(t)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ให้${it.name}แก่${this.nick(t)}ที่${this.zn(z)}`);
    this.checkObjectivesAfterTake(t, it);
    this.emit();
  }

  // ขอของจากบอทที่อยู่ห้องเดียวกัน (บอทให้เสมอ) — มีไว้ให้ทดสอบเกมง่ายขึ้น
  requestItem(playerId, botId, itemId) {
    if (!CONFIG.BOT_REQUESTS) throw new GameError('ระบบขอของจากบอทถูกปิดอยู่');
    this.assertPhase(PHASE.DAY);
    this.assertStep(STEP.REPORT);
    const p = this.alivePlayer(playerId);
    const t = this.players.get(botId);
    if (!t || !t.alive || t.id === p.id) throw new GameError('เลือกผู้ให้ไม่ถูกต้อง');
    if (!t.isBot) throw new GameError('ขอของได้เฉพาะจากบอท');
    if (!this.sameSpot(p, t)) throw new GameError('ขอของได้เฉพาะบอทที่อยู่จุดเดียวกันตอนนี้');
    if (this.darkAt(p.zoneId, p.outside)) throw new GameError('🌑 มืดเกินกว่าจะขอของกัน');
    const idx = t.inventory.findIndex((i) => i.id === itemId);
    if (idx < 0) throw new GameError('บอทไม่มีของชิ้นนี้');
    if (p.inventory.length >= this.invMax(p)) throw new GameError(`คุณถือของเต็มมือแล้ว (สูงสุด ${this.invMax(p)} ชิ้น)`);
    const it = t.inventory.splice(idx, 1)[0];
    p.inventory.push(it);
    const z = this.zones.get(p.zoneId);
    this.logTo(p, `🙏 คุณขอ${it.name}${it.isPart ? ' ⭐' : ''}จาก${this.nick(t)} เขายื่นให้ทันที`, 'action');
    onObtainItem(this, p, it);
    for (const o of this.awakeWith(p)) if (o.id !== p.id && o.id !== t.id) this.logTo(o, `👀 คุณเห็น${this.nick(t)}ยื่น${chance(0.5) ? it.name : 'อะไรบางอย่าง'}ให้${this.nick(p)}`, 'witness');
    this.recordEvent(`${this.nick(p)}ขอ${it.name}จาก${this.nick(t)}ที่${this.zn(z)}`);
    this.checkObjectivesAfterTake(p, it);
    this.emit();
  }

  // ---------- objectives ----------
  checkObjectivesAfterMove(p) {
    for (const o of p.objectives) {
      if (o.done) continue;
      if (o.type === 'visit' && o.zoneId === p.zoneId && !p.outside) this.completeObjective(p, o);
      if (o.type === 'visit2' && !p.outside && o.zoneIds.includes(p.zoneId) && !o.visited.includes(p.zoneId)) {
        o.visited.push(p.zoneId);
        if (o.visited.length >= o.zoneIds.length) this.completeObjective(p, o);
        else this.logTo(p, `📋 ภารกิจคืบหน้า: ถึง${this.zn(p.zoneId)}แล้ว เหลืออีกห้อง (${this.zoneName(o.zoneIds.find((id) => !o.visited.includes(id)))})`, 'objective');
      }
      if (o.type === 'meet') {
        const t = this.players.get(o.targetId);
        if (t?.alive && this.sameSpot(t, p)) this.completeObjective(p, o);
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
    this.advanceHour();
    this.generating = 'มีคนพบศพ! กำลังประกาศ...';
    this.huntRound = 1;
    // พบศพร่างเดียวก็พอ — ศพทุกร่างในสถานที่ถูกเปิดเผยพร้อมกัน (รวมร่างที่ยังไม่มีใครเคยเห็น) แล้วไล่จับฆาตกรทีละคนจนคดีปิดหมดในวันเดียว จึงไม่มีศพค้างข้ามวัน
    const newly = [...this.bodies.values()].filter((b) => !b.judged && !b.announced);
    const unseen = this.announceBodies(newly);
    // รอบเก็บหลักฐานยาว 1 ชั่วโมง + 1 ต่อศพที่ประกาศ (2 ศพ = 3 ชั่วโมง)
    this.investigation = { hour: 1, total: INVESTIGATION.BASE_HOURS + INVESTIGATION.PER_BODY * newly.length };
    for (const z of this.zones.values()) z.dark = false;
    for (const p of this.players.values()) {
      p.zoneMemory = {};
      p.forced = null;
    }
    this.emit();
    await this.narrateCases();
    this.announcement = { day: this.day, hour: this.hour, turn: this.turn, caseIds: newly.map((b) => b.caseId) };
    const names = newly.map((b) => `${this.nick(this.players.get(b.victimId))} (ที่${this.spotName(b.zoneId, b.outside)})`).join(', ');
    const extraNote = newly.length > 1 ? ` (ศพทุกร่างในสถานที่ถูกเปิดเผยพร้อมกัน${unseen.length ? ` รวมถึง ${unseen.length} ร่างที่ยังไม่มีใครเคยเห็น` : ''})` : '';
    this.systemMessage(`🔔 ประกาศพบศพ! ${names}${extraNote} — ${this.timeLabel()}: รอบเก็บหลักฐาน ${this.investigation.total} ชั่วโมง (1 + ศพ ${newly.length} ร่าง · ช่วงนี้ไม่มีใครลงมือหรือโดนกับดักได้ · คนที่สลบอยู่ยังสลบต่อ) ของในห้องถูกจัดใหม่ ทุกคนเลือกห้องที่จะไปสำรวจ 1 ห้องและทำได้ 1 อย่าง ก่อนเข้าสู่การตัดสิน (ภารกิจพักไว้ก่อน)`);
    this.generating = null;
    this.step = STEP.MOVE;
    this.moves = new Map();
    this.actions = new Map();
    this.presetKoMoves();
    this.emit();
    this.armStepTimer();
    this.scheduleBots();
  }

  // ประกาศศพ: ทุกคนรู้ว่าใครตายและศพอยู่ห้องไหน (คืนรายชื่อร่างที่ยังไม่มีใครเคยเห็นมาก่อน)
  announceBodies(list) {
    const unseen = list.filter((b) => b.discoveredBy.size === 0);
    for (const b of list) {
      b.announced = true;
      const c = this.caseOf(b.caseId);
      if (c) {
        c.announced = true;
        c.announcedDay = this.day;
        c.announcedHour = this.hour;
      }
      for (const p of this.players.values()) p.knownBodies.add(b.victimId);
    }
    return unseen;
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
    // คนที่สลบอยู่โหวตไม่ได้ — ถ้าทุกคนที่ยังอยู่สลบหมด เสียงประกาศจะปลุกทุกคน
    if (this.alivePlayers().length && this.alivePlayers().every((p) => p.ko)) {
      for (const p of this.alivePlayers()) this.wakeUp(p);
      this.systemMessage('📢 เสียงประกาศดังสนั่นจนทุกคนที่สลบอยู่ตื่นขึ้นมาทันการตัดสิน');
    }
    // ศพที่เพิ่งถูกพบระหว่างเก็บหลักฐานก็เข้าสู่การตัดสินด้วย
    const extra = [...this.bodies.values()].filter((b) => !b.judged && !b.announced);
    if (extra.length) {
      this.generating = 'พบศพเพิ่ม...';
      this.emit();
      this.announceBodies(extra);
      await this.narrateCases();
      this.systemMessage(`🔔 พบศพเพิ่มระหว่างเก็บหลักฐาน: ${extra.map((b) => this.nick(this.players.get(b.victimId))).join(', ')}`);
      this.generating = null;
    }
    this.votes = new Map();
    this.confirmedVotes = new Set();
    this.runoff = null;
    this.runoffCount = 0;
    const openNames = this.openCases().map((c) => this.nick(this.players.get(c.victimId))).join(', ');
    this.systemMessage(
      `⚖ ${this.huntRound > 1 ? `การตัดสินรอบที่ ${this.huntRound} ของวันนี้เริ่มขึ้น! (คดีที่ยังเปิดอยู่: ${openNames})` : 'การตัดสินเริ่มขึ้น!'} เล่าหลักฐานที่แต่ละคนเจอในแชท แล้วโหวต "คนร้าย" — หรือ "ไม่มีคนร้ายให้ลงโทษ" ถ้าเชื่อว่าคนร้ายตายไปแล้ว · โหวตถูก: คนนั้นถูกประหาร (ถ้ายังมีฆาตกรเหลือ ระบบจะบอก แต่ไม่บอกว่ากี่คน แล้วตามหาต่อ) · โหวตผิด: ทุกคนตาย คนร้ายรอด เกมจบ`,
    );
    this.emit();
    this.scheduleBots();
  }

  voteCandidates(voterId) {
    const ids = this.runoff ? this.runoff.candidates : [...this.alivePlayers().map((p) => p.id), NONE_VOTE];
    return ids.filter((id) => id !== voterId);
  }

  castVote(playerId, targetId) {
    this.assertPhase(PHASE.TRIAL);
    if (this.alivePlayer(playerId).ko) throw new GameError('😵 คุณสลบอยู่ โหวตไม่ได้จนกว่าจะฟื้น');
    if (this.confirmedVotes.has(playerId)) throw new GameError('คุณยืนยันโหวตไปแล้ว');
    if (!this.voteCandidates(playerId).includes(targetId)) throw new GameError(this.runoff ? 'รอบตัดสินโหวตได้เฉพาะตัวเลือกที่คะแนนเสมอกัน' : 'โหวตไม่ถูกต้อง');
    this.votes.set(playerId, targetId);
    this.emit();
  }

  confirmVote(playerId) {
    this.assertPhase(PHASE.TRIAL);
    if (this.alivePlayer(playerId).ko) throw new GameError('😵 คุณสลบอยู่ โหวตไม่ได้จนกว่าจะฟื้น');
    if (!this.votes.has(playerId)) throw new GameError('เลือกก่อนยืนยัน');
    this.confirmedVotes.add(playerId);
    this.emit();
    if (this.alivePlayers().every((p) => this.confirmedVotes.has(p.id) || p.ko)) this.resolveTrial(); // คนสลบไม่ต้องโหวต
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
      // คดีที่คนร้ายตายไปแล้ว/ไม่มีคนร้าย: ไม่มีใครให้โหวต → ปิดไปพร้อมกัน
      for (const c of open) if (!c.killerId || !this.players.get(c.killerId)?.alive) c.judged = true;
      // คดีที่เหลือ (คนร้ายยังมีชีวิตและยังไม่ถูกจับ) ยังเปิดอยู่ → ระบบบอกแค่ว่า "ยังมีฆาตกรอีก 1 คน" (ไม่บอกจำนวนจริง) แล้วเก็บหลักฐาน-ตัดสินต่อในวันเดิมจนกว่าคดีจะปิดหมด (continueHunt)
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
        const vp = this.players.get(b.victimId);
        if (vp) vp.caseJudged = true;
        const vc = this.charOf(vp);
        if (vc) vc.ultimateRevealed = true;
      }
    }
    this.clearTimers();
    this.botGhostChat(); // ผีบอททักทายคนที่เพิ่งถูกประหาร
    const judgedNow = open.filter((c) => c.judged);
    const remaining = open.filter((c) => !c.judged);
    const moreKillers = correct && remaining.length > 0;
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
      round: this.huntRound,
      moreKillers,
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
      round: this.huntRound,
      victims: judgedNow.map((c) => this.nick(this.players.get(c.victimId))),
      culprits: [...new Set(judgedNow.filter((c) => c.killerId).map((c) => this.nick(this.players.get(c.killerId))))],
      votedName: votedId === NONE_VOTE ? 'ไม่มีคนร้ายให้ลงโทษ' : this.nick(this.players.get(votedId)),
      correct,
      moreKillers,
    });
    this.lastTrialTurn = this.turn;
    this.runoff = null;
    if (correct) {
      const remainingNames = remaining.map((c) => this.nick(this.players.get(c.victimId)));
      this.systemMessage(
        (votedId === NONE_VOTE
          ? judgedNow.some((c) => c.killerId)
            ? `โหวตถูกต้อง! คนร้ายของคดีนี้ตายไปก่อนแล้ว จึงไม่มีใครให้ลงโทษ`
            : `โหวตถูกต้อง! ไม่มีคนร้ายในคดีนี้ — ไม่มีใครถูกประหาร`
          : `โหวตถูกต้อง! คนร้ายคือ ${this.nick(this.players.get(votedId))} (${this.players.get(votedId).name}) และถูกประหาร`) +
          (moreKillers
            ? ` · 📢 แต่เสียงประกาศดังต่อ: "${MORE_KILLERS_MESSAGE}" — คดีของ ${remainingNames.join(', ')} ยังไม่ปิด การตามหาจะดำเนินต่อในวันนี้`
            : ' · คดีทั้งหมดของวันนี้ปิดแล้ว ไม่มีฆาตกรเหลืออยู่'),
      );
      this.phase = PHASE.TRIAL_RESULT;
      if (this.checkEarlyEnd()) return; // หลังประหาร: เหลือน้อยเกินไป/มีแต่คนที่เคยฆ่า → จบเกมทันที (หน้าจบยังโชว์เฉลยรอบนี้)
      this.emit();
    } else {
      this.systemMessage(`โหวตผิด! ${escaped.length ? `คนร้ายตัวจริงคือ ${escaped.map((id) => this.nick(this.players.get(id))).join(', ')} และรอดไปได้` : 'คดีนี้ไม่มีคนร้ายให้ลงโทษ'} — ทุกคนที่เหลือถูกประหาร เกมจบ`);
      this.endGame('wrong_vote');
    }
  }

  // เฉลยคดี (เรียกเฉพาะคดีที่ปิดแล้ว หรือทุกคดีตอนเกมจบ)
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
      killerFate: k?.fate || null, // escaped = รอดเพราะโหวตผิด · executed = ถูกประหารรอบนี้ · อื่น ๆ = ตายไปก่อนการตัดสิน
      cause: c.cause,
      causeLabel: CAUSE_LABEL[c.cause] || c.cause,
      trapLabel: c.trapType ? TRAP_TYPES[c.trapType]?.label || null : null,
      weaponName: c.weapon?.name || null,
      zoneName: this.spotName(c.zoneId, c.outside),
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
          return { playerName: p?.name || pid, characterName: this.charOf(p)?.nickname || '?', zoneName: this.posName(zid) };
        }),
        events: t.events,
      }));
  }

  async nextRound(hostId) {
    this.assertHost(hostId);
    this.assertPhase(PHASE.TRIAL_RESULT);
    // ยังมีฆาตกรที่ยังไม่ถูกจับ → ไม่ขึ้นวันใหม่ แต่เก็บหลักฐานอีก 1 ชั่วโมงแล้วตัดสินใหม่ (วนจนกว่าคดีจะปิดหมด)
    if (this.lastResult?.moreKillers && this.openCases().length) return this.continueHunt();
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
    if (this.alivePlayers().every((p) => this.ready.has(p.id) || p.ko)) this.nextTurn();
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
    if (this.checkEarlyEnd()) return;
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    if (this.hour >= CONFIG.HOURS_PER_DAY) {
      // ครบชั่วโมงสุดท้ายของวัน: มีศพที่ยังไม่ถูกพบ → ทุกคนรู้ว่ามีคนหายไป ศพถูกพบทันที (เข้ารอบเก็บหลักฐาน) · ไม่มีศพ → ป็อปอัพขึ้นวันใหม่
      if ([...this.bodies.values()].some((b) => !b.judged && !b.announced)) {
        this.systemMessage(`🌙 ครบ ${CONFIG.HOURS_PER_DAY} ชั่วโมงแล้ว — ตอนนับคนก่อนนอน พบว่ามีคนหายไป ทุกคนออกตามหาและพบศพทันที`);
        this.startInvestigation().catch((e) => this.fail(e));
        return;
      }
      return this.rolloverDay();
    }
    for (const p of this.players.values()) if (p.stained !== null && p.stained < this.turn - 1) p.stained = null;
    this.beginTurn();
  }

  // ครบ HOURS_PER_DAY ชั่วโมงโดยไม่มีการตัดสิน → ขึ้นวันใหม่เอง: ทุกคนกลับห้องนอนรวม ฟื้นจากสลบ ร่องรอยทั่วไปถูกเก็บกวาด
  // แต่ศพที่ยังไม่ถูกพบและหลักฐานของคดีที่ยังเปิดอยู่คงอยู่ (ประกาศได้ในวันถัดไป)
  rolloverDay() {
    if (this.phase === PHASE.ENDED) return;
    this.day++;
    const trapsReset = this.resetTrapsAndFood();
    this.collectJudgedCases(true);
    for (const p of this.players.values()) {
      p.stained = null;
      p.doorWork = null;
      p.ko = null;
      p.zoneMemory = {};
      if (p.alive) {
        p.zoneId = this.location.sleepZoneId;
        p.outside = false;
      }
    }
    const text = `ครบ ${CONFIG.HOURS_PER_DAY} ชั่วโมงแล้วและไม่มีใครพบศพ ทุกคนกลับไปนอนที่ห้องนอนรวม — วันที่ ${this.day} เริ่มขึ้น ทุกคนฟื้นจากสลบ ร่องรอยทั่วไปถูกเก็บกวาด${trapsReset ? ` กับดักทุกชิ้น (${trapsReset}) ถูกถอดเป็นของธรรมดาวางไว้ที่เดิม` : ''} อาหารทุกห้องเป็นชุดใหม่ (ยาที่ผสมไว้หมดฤทธิ์) ประตูที่พังยังพังอยู่`;
    this.dayPopup = { day: this.day, turn: this.turn + 1, text };
    this.systemMessage(`🌙 ${text}`);
    this.beginDay();
  }

  // หลังตัดสิน → วันใหม่
  nextDay() {
    if (this.phase === PHASE.ENDED) return;
    if (this.checkEarlyEnd()) return;
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    if (!this.dayRolledByClock) this.day++; // ถ้านาฬิกาข้ามเที่ยงคืนไปแล้วระหว่างตัดสิน ไม่บวกซ้ำ
    this.resetAfterTrial();
    this.beginDay();
  }

  // เก็บศพและหลักฐานของคดีที่ตัดสินแล้ว (ความจำเรื่องศพเหล่านั้นหายไปด้วย) · wipeScene = ล้างร่องรอยทั่วไปของวันด้วย (ใช้ตอนขึ้นวันใหม่)
  collectJudgedCases(wipeScene) {
    const removed = [...this.bodies.values()].filter((b) => b.judged);
    for (const b of removed) this.bodies.delete(b.victimId);
    for (const z of this.zones.values()) {
      z.evidence = z.evidence.filter((e) => {
        if (e.caseId) return !this.caseOf(e.caseId)?.judged;
        if (!wipeScene) return true;
        if (e.kind === 'door') return true;
        if (e.kind === 'poison') return z.items.some((i) => i.kind === 'food' && i.poisoned);
        return false;
      });
    }
    const liveEvidence = new Set([...this.zones.values()].flatMap((z) => z.evidence.map((e) => e.id)));
    for (const p of this.players.values()) {
      for (const b of removed) p.knownBodies.delete(b.victimId);
      p.evidence = p.evidence.filter((id) => liveEvidence.has(id));
    }
    return removed;
  }

  // ตัดสินถูกแต่ยังมีคดีที่คนร้ายยังมีชีวิต: เก็บศพ/หลักฐานของคดีที่ปิดแล้ว แล้วเข้ารอบเก็บหลักฐานอีก 1 ชั่วโมงในวันเดิม ก่อนตัดสินรอบถัดไป
  // (ระบบบอกแค่ว่า "ยังมีฆาตกรอีก 1 คน" ไม่ว่าจริง ๆ จะเหลือกี่คน) วนไปจนคดีปิดหมดจึงขึ้นวันใหม่
  // ชั่วโมงถัดไปของรอบเก็บหลักฐาน (ยาวตามจำนวนศพ)
  nextInvestigationHour() {
    if (this.phase === PHASE.ENDED) return;
    if (this.checkEarlyEnd()) return;
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    this.investigation.hour++;
    this.advanceHour();
    this.moves = new Map();
    this.actions = new Map();
    this.presetKoMoves();
    this.ready = new Set();
    for (const z of this.zones.values()) z.dark = false;
    this.systemMessage(`🔎 ${this.timeLabel()} — รอบเก็บหลักฐานชั่วโมงที่ ${this.investigation.hour}/${this.investigation.total} เลือกห้องที่จะไปเก็บหลักฐานต่อ`);
    this.step = STEP.MOVE;
    this.emit();
    this.armStepTimer();
    this.scheduleBots();
  }

  continueHunt() {
    if (this.phase === PHASE.ENDED) return;
    if (this.checkEarlyEnd()) return;
    if (CONFIG.MAX_HOURS && this.turn >= CONFIG.MAX_HOURS) return this.endGame('timeout');
    this.collectJudgedCases(false);
    this.phase = PHASE.INVESTIGATION;
    this.huntRound++;
    this.investigation = { hour: 1, total: 1 }; // รอบตามหาฆาตกรที่เหลือ = 1 ชั่วโมง
    this.advanceHour();
    this.generating = null;
    this.moves = new Map();
    this.actions = new Map();
    this.presetKoMoves();
    this.ready = new Set();
    for (const z of this.zones.values()) z.dark = false;
    for (const p of this.players.values()) p.forced = null;
    const names = this.openCases().map((c) => `${this.nick(this.players.get(c.victimId))} (ที่${this.spotName(this.bodies.get(c.victimId)?.zoneId || c.zoneId, this.bodies.get(c.victimId)?.outside ?? c.outside)})`).join(', ');
    this.systemMessage(`🔎 ${this.timeLabel()} — การตามหาฆาตกรที่เหลือ (รอบที่ ${this.huntRound}): ศพและหลักฐานของคดีที่ปิดแล้วถูกเก็บไป คดีที่ยังเปิดอยู่: ${names} · เก็บหลักฐานอีก 1 ชั่วโมง ทุกคนเลือกห้องที่จะไปและทำได้ 1 อย่าง แล้วตัดสินอีกครั้ง`);
    this.step = STEP.MOVE;
    this.emit();
    this.armStepTimer();
    this.scheduleBots();
  }

  // วันใหม่หลังคดีปิดครบ: ทุกอย่างที่เกี่ยวกับคดีหายไปเหมือนไม่เคยเกิดขึ้น (ศพ หลักฐาน รอยเปื้อน ความจำเรื่องศพ)
  // ของของผู้ตายยังตกอยู่ตรงจุดที่ตาย (ถูกวางไว้ตั้งแต่ตอนตาย) ของในมือคนเป็นยังอยู่ ทุกคนกลับไปเริ่มที่ห้องนอนรวม
  // ขึ้นวันใหม่ได้ต่อเมื่อทุกคดีของวันถูกตัดสินแล้ว (ไล่จับฆาตกรทีละคน) จึงไม่มีศพเหลือข้ามวัน · อาหารที่ยังมีพิษและประตูที่พังคงอยู่
  // ขึ้นวันใหม่: กับดักทุกชิ้น (ที่วางไว้ รวมกับดักประตู และที่ประกอบแล้วแต่ยังไม่วาง ทั้งในห้องและในกระเป๋า) ถูกถอดเป็นของธรรมดาวางไว้ตรงที่เดิม
  // (ชิ้นที่ทำร้ายกลับเข้ากระเป๋าคนถือ ส่วนเครื่องมือ/เชือกวางในห้องนั้น) และยาที่ผสมในอาหารหมดฤทธิ์ — ฆาตกรเมื่อวานเอาแผนเดิมมาฆ่าคนวันนี้ไม่ได้ · คืนจำนวนกับดักที่ถอด
  resetTrapsAndFood() {
    const dismantle = (trap, z, holder) => {
      const striker = { id: `it_${nextId()}`, name: trap.weaponName || trap.name, description: trap.strikerDesc || '', kind: trap.strikerKind || 'weapon', portable: true, hidden: false, isPart: false, originZoneId: z.id };
      if (Number.isInteger(trap.strikerAmmo)) striker.ammo = trap.strikerAmmo;
      const other = trap.otherPart ? { id: `it_${nextId()}`, name: trap.otherPart.name, description: trap.otherPart.description || '', kind: trap.otherPart.kind || 'tool', portable: true, hidden: false, isPart: false, originZoneId: z.id } : null;
      if (holder) holder.inventory.push(striker);
      else z.items.push(striker);
      if (other) z.items.push(other);
    };
    let n = 0;
    for (const z of this.zones.values()) {
      z.doorWork = null; // งานประตู/ไฟที่ค้างเริ่มใหม่ในวันใหม่
      z.powerWork = null;
      for (const t of z.traps) {
        dismantle(t.item, z, null);
        n++;
      }
      z.traps = [];
      for (const it of z.items.filter((i) => i.kind === 'trap')) {
        z.items.splice(z.items.indexOf(it), 1);
        dismantle(it, z, null);
        n++;
      }
      for (const f of z.items) {
        if (f.kind !== 'food') continue;
        f.poisoned = null;
        f.buff = null;
      }
    }
    for (const p of this.players.values()) {
      for (const it of p.inventory.filter((i) => i.kind === 'trap')) {
        p.inventory.splice(p.inventory.indexOf(it), 1);
        dismantle(it, this.zones.get(p.zoneId) || this.zones.get(this.location.sleepZoneId), p);
        n++;
      }
    }
    return n;
  }

  resetAfterTrial() {
    const trapsReset = this.resetTrapsAndFood(); // กับดักทุกชิ้นถูกถอด ยาในอาหารหมดฤทธิ์ — ฆาตกรเมื่อวานใช้แผนเดิมในวันนี้ไม่ได้
    this.collectJudgedCases(true);
    for (const p of this.players.values()) {
      p.stained = null;
      p.doorWork = null;
      p.ko = null; // เช้าวันใหม่ทุกคนฟื้น
      p.zoneMemory = {};
      if (p.alive) {
        p.zoneId = this.location.sleepZoneId;
        p.outside = false;
      }
    }
    this.systemMessage(`🌅 เช้าวันใหม่ ทุกคนตื่นขึ้นที่ห้องนอนรวม — ร่องรอยของคดีเมื่อวานถูกเก็บกวาดจนเหมือนไม่เคยเกิดขึ้น ของของผู้เสียชีวิตยังตกอยู่ตรงจุดที่เขาล้มลง${trapsReset ? ` · กับดักทุกชิ้น (${trapsReset}) ถูกถอดเป็นของธรรมดาวางไว้ที่เดิม` : ''} อาหารทุกห้องเป็นชุดใหม่ (ยาที่ผสมไว้หมดฤทธิ์)`);
  }

  // อีเวนต์พิเศษ: ผู้ตายบางคนอาจ "ไม่ได้ตายจริง" และกลับเข้าเกม (เฉพาะคดีที่ตัดสินแล้ว)
  async maybeRevive() {
    const eligible = [...this.players.values()].filter((p) => !p.alive && p.fate === 'victim' && !p.revived && (p.caseJudged || this.bodies.get(p.id)?.judged));
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
    target.outside = false;
    target.inventory = [];
    target.objectives = [];
    target.nextObjectiveTurn = 0;
    target.forced = null;
    target.ko = null;
    target.follow = null;
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
      few_left: '🏁 เหลือคนน้อยเกินกว่าจะเล่นต่อ (น้อยกว่าหนึ่งในสามของผู้เล่น) — ผู้ที่เหลือรอดชีวิต เกมจบ',
      only_killers: '🩸 คนที่เหลือทุกคนล้วนเคยฆ่า ไม่มีใครให้สืบอีก — ผู้ที่เหลือรอดชีวิต เกมจบ',
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
      // คดีที่ยังไม่ได้ตัดสินตอนเกมจบ — เฉลยทั้งหมด
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

  // ---------- ขอตรวจกระเป๋า (ตอนตัดสิน) ----------
  // ใครก็ขอตรวจกระเป๋าคนอื่นได้ตอนตัดสิน เจ้าของต้องยอม ผล (ของทุกชิ้น รวมคราบเลือด) ประกาศในแชทให้ทุกคนเห็น · บอทตอบเอง
  requestBagCheck(playerId, targetId) {
    this.assertPhase(PHASE.TRIAL);
    const p = this.alivePlayer(playerId);
    if (p.ko) throw new GameError('😵 คุณสลบอยู่');
    const t = this.players.get(targetId);
    if (!t?.alive || t.id === p.id) throw new GameError('เลือกคนที่ยังอยู่ในเกม');
    if ((this.notices.get(t.id) || []).some((n) => n.kind === 'bagRequest' && n.fromId === p.id)) throw new GameError('คุณขอไปแล้ว รอเขาตอบ');
    this.systemMessage(`👜 ${this.nick(p)}ขอตรวจกระเป๋าของ${this.nick(t)}ต่อหน้าทุกคน — รอ${this.nick(t)}ตอบ`);
    this.recordEvent(`${this.nick(p)}ขอตรวจกระเป๋า${this.nick(t)}`);
    if (t.isBot) {
      const suspicious = t.inventory.some((i) => i.bloody || i.kind === 'poison' || i.kind === 'trap');
      this.answerBagCheck(t, p, suspicious ? chance(0.3) : chance(0.85));
    } else this.notify(t.id, `${this.nick(p)}ขอตรวจกระเป๋าของคุณต่อหน้าทุกคน — จะยอมให้ดูไหม?`, 'bagRequest', { fromId: p.id });
    this.emit();
  }

  replyBagCheck(playerId, noticeId, accept) {
    this.assertPhase(PHASE.TRIAL);
    const t = this.alivePlayer(playerId);
    const list = this.notices.get(t.id) || [];
    const n = list.find((x) => x.id === noticeId && x.kind === 'bagRequest');
    if (!n) throw new GameError('ไม่มีคำขอนี้แล้ว');
    list.splice(list.indexOf(n), 1);
    this.answerBagCheck(t, this.players.get(n.fromId), !!accept);
    this.emit();
  }

  answerBagCheck(t, from, accept) {
    const who = from ? this.nick(from) : 'ใครบางคน';
    if (!accept) {
      this.systemMessage(`🙅 ${this.nick(t)}ไม่ยอมให้${who}ตรวจกระเป๋า`);
      this.recordEvent(`${this.nick(t)}ไม่ยอมให้ตรวจกระเป๋า`);
      return;
    }
    const items = t.inventory.map((i) => `${i.name}${i.bloody ? ' 🩸เปื้อนเลือด' : ''}${i.kind === 'trap' ? ' (กับดักที่ประกอบแล้ว)' : ''}`);
    this.systemMessage(`👜 ${this.nick(t)}เปิดกระเป๋าให้ทุกคนดู: ${items.length ? items.join(', ') : 'ไม่มีของเลย'}`);
    this.recordEvent(`${this.nick(t)}เปิดกระเป๋าให้ตรวจ: ${items.join(', ') || 'ว่าง'}`);
  }

  // ---------- คำสั่งตรวจสอบ (DEBUG_CHEATS=true) ----------
  // พิมพ์ในแชท: /help /rooms /players /items /bodies /exits /find <คำ> — คำตอบเห็นเฉพาะคนพิมพ์ (ใช้ทดสอบ/ตามหาของ)
  debugCommand(p, text) {
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    const q = rest.join(' ');
    const name = (id) => this.nick(this.players.get(id));
    const itemTxt = (i) => `${i.name}${i.hidden ? ' (ซ่อน)' : ''}${i.bloody ? ' 🩸' : ''}${i.poisoned ? ' ☠' : ''}${i.isPart || i.role ? ' ⭐' : ''}${Number.isInteger(i.ammo) ? ` [${i.ammo} นัด]` : ''}`;
    const where = (id) => {
      for (const z of this.zones.values()) {
        const it = z.items.find((i) => i.id === id);
        if (it) return `${z.name}${it.hidden ? ' (ซ่อน)' : ''}`;
      }
      for (const o of this.players.values()) if (o.inventory.some((i) => i.id === id)) return `ในมือ ${this.nick(o)}${o.alive ? '' : ' (ตายแล้ว)'}`;
      return '— ไม่พบ —';
    };
    let out = '';
    switch ((cmd || '').toLowerCase()) {
      case 'rooms':
        out = [...this.zones.values()]
          .map((z) => {
            const people = this.alivePlayers().filter((o) => o.zoneId === z.id).map((o) => `${this.nick(o)}${o.outside ? '(หน้าประตู)' : ''}${o.ko ? '(สลบ)' : ''}`);
            const bodies = [...this.bodies.values()].filter((b) => b.zoneId === z.id).map((b) => `☠${name(b.victimId)}${b.announced ? '' : '(ยังไม่ประกาศ)'}`);
            const flags = [z.locked ? '🔒ล็อก' : '', z.broken ? 'ประตูพัง' : '', z.dark ? '🌑ไฟดับ' : '', z.water ? '🚿น้ำ' : ''].filter(Boolean).join(' ');
            const ev = z.evidence.filter((e) => !e.gone);
            return `▪ ${z.name} ${flags}\n   คน: ${people.join(', ') || '-'}${bodies.length ? `\n   ศพ: ${bodies.join(', ')}` : ''}\n   ของ: ${z.items.map(itemTxt).join(', ') || '-'}${z.traps.length ? `\n   กับดัก: ${z.traps.map((t) => `${t.item.name} (${name(t.setterId)}, ${t.side || 'inside'})`).join(', ')}` : ''}${ev.length ? `\n   ร่องรอย ${ev.length}: ${ev.map((e) => `${e.kind}${e.hidden ? '(ซ่อน)' : ''}`).join(', ')}` : ''}`;
          })
          .join('\n');
        break;
      case 'players':
        out = [...this.players.values()]
          .map((o) => `▪ ${o.name} = ${this.nick(o)} [${this.traitOf(o)}] ${o.alive ? `อยู่ที่ ${this.spotName(o.zoneId, o.outside)}${o.ko ? ` สลบ ${o.ko.hours} ชม.` : ''}` : `ตายแล้ว (${o.fate})`} · ฆ่า ${o.kills}\n   ของ: ${o.inventory.map(itemTxt).join(', ') || '-'}${o.objectives.filter((x) => !x.done).length ? `\n   ภารกิจ: ${o.objectives.filter((x) => !x.done).map((x) => x.text).join(' · ')}` : ''}`)
          .join('\n');
        break;
      case 'items': {
        const rows = [];
        for (const z of this.zones.values()) for (const i of z.items) rows.push(`${itemTxt(i)} → ${z.name}`);
        for (const o of this.players.values()) for (const i of o.inventory) rows.push(`${itemTxt(i)} → ในมือ ${this.nick(o)}${o.alive ? '' : ' (ตายแล้ว)'}`);
        out = rows.sort().join('\n');
        break;
      }
      case 'bodies':
        out = [...this.bodies.values()].map((b) => `☠ ${name(b.victimId)} ที่ ${this.spotName(b.zoneId, b.outside)} · ตายวันที่ ${b.day} ชม. ${b.hour} · ${b.announced ? 'ประกาศแล้ว' : 'ยังไม่ประกาศ'} · ${b.judged ? 'ตัดสินแล้ว' : 'ยังเปิดอยู่'} · คนร้าย: ${b.killerId ? name(b.killerId) : '-'} · ผู้พบ: ${[...b.discoveredBy].map(name).join(', ') || '-'}`).join('\n') || 'ไม่มีศพ';
        break;
      case 'exits':
        out = [...this.exits.values()].map((x) => `🚪 ${x.name} ที่ ${this.zoneName(x.zoneId)} [${x.route}]${x.open ? ' เปิดแล้ว' : ''}\n   ของ: ${x.items.map((i) => `${i.name} (${i.role}) → ${where(i.id)}${i.assembled ? ' ประกอบแล้ว' : ''}`).join(', ')}\n   ขั้น: ${requirementText(this, x)}`).join('\n') || 'ไม่มีทางออก';
        break;
      case 'find': {
        const rx = q.toLowerCase();
        if (!rx) {
          out = 'ใช้: /find <คำ>';
          break;
        }
        const rows = [];
        for (const z of this.zones.values()) for (const i of z.items) if (i.name.toLowerCase().includes(rx)) rows.push(`${itemTxt(i)} → ${z.name}`);
        for (const o of this.players.values()) for (const i of o.inventory) if (i.name.toLowerCase().includes(rx)) rows.push(`${itemTxt(i)} → ในมือ ${this.nick(o)}${o.alive ? '' : ' (ตายแล้ว)'}`);
        for (const z of this.zones.values()) if (z.name.toLowerCase().includes(rx)) rows.push(`ห้อง ${z.name}: ${z.items.map(itemTxt).join(', ') || '-'}`);
        for (const o of this.players.values()) if (o.name.toLowerCase().includes(rx) || this.nick(o).toLowerCase().includes(rx)) rows.push(`${this.nick(o)} (${o.name}) อยู่ที่ ${this.spotName(o.zoneId, o.outside)} ของ: ${o.inventory.map(itemTxt).join(', ') || '-'}`);
        out = rows.join('\n') || `ไม่พบ "${q}"`;
        break;
      }
      default:
        out = 'คำสั่งตรวจสอบ (เห็นเฉพาะคุณ): /rooms ทุกห้อง · /players ทุกคน · /items ของทุกชิ้นอยู่ไหน · /bodies ศพ · /exits ทางออก · /find <คำ> ค้นหาของ/ห้อง/คน';
    }
    this.pushChat({ system: true, debug: true, to: p.id, text: `🛠 /${cmd || 'help'}\n${out}` });
    this.emit();
  }

  // ---------- chat ----------
  sendChat(playerId, text) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('ไม่พบผู้เล่น');
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const openPhase = this.phase === PHASE.LOBBY || this.phase === PHASE.ENDED;
    if (this.phase === PHASE.GENERATING) throw new GameError('ตอนนี้ยังคุยไม่ได้');
    if (text.startsWith('/') && CONFIG.DEBUG_CHEATS && this.location) return this.debugCommand(p, text); // คำสั่งตรวจสอบ (เฉพาะโหมดทดสอบ)
    const c = this.charOf(p);
    // ผี (ตายแล้ว ระหว่างเกม) พิมพ์ได้เป็น "แชทผี" — คนเป็นมองไม่เห็นจนกว่าเกมจบ
    this.pushChat({ playerId, name: p.name, characterName: c?.name || null, text, ghost: !openPhase && !p.alive });
    this.emit();
  }

  // ---------- spectator (ghost) ----------
  // โหมดวิญญาณ: ผีตามดูคนเป็นได้ทีละคน (เห็นสมุดบันทึก ของ ภารกิจ และสิ่งที่เขาเลือกในชั่วโมงนี้) · ตามดูตัวเอง/ผีด้วยกันไม่ได้ · คนเป็นใช้ไม่ได้
  setFollow(playerId, targetId) {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('ไม่พบผู้เล่น');
    if (p.alive) throw new GameError('คนที่ยังมีชีวิตอยู่ตามดูคนอื่นไม่ได้');
    if ([PHASE.LOBBY, PHASE.ENDED, PHASE.GENERATING].includes(this.phase)) throw new GameError('ตอนนี้ยังตามดูไม่ได้');
    if (!targetId) {
      p.follow = null;
      this.emit();
      return;
    }
    const t = this.players.get(targetId);
    if (!t || !t.alive) throw new GameError('ตามดูได้เฉพาะคนที่ยังมีชีวิตอยู่');
    p.follow = t.id;
    this.emit();
  }

  // สิ่งที่ผีเห็น: ทุกห้อง (คน ศพ ของ ของที่ซ่อน กับดักและคนวาง) · เหตุการณ์จริงที่เกิดขึ้น · ผีด้วยกัน · คนที่กำลังตามดู
  spectatorView(me) {
    const alive = this.alivePlayers();
    const bodies = [...this.bodies.values()].filter((b) => !b.judged);
    const watched = me.follow ? this.players.get(me.follow) : null;
    const w = watched?.alive ? watched : null;
    const wc = w ? this.charOf(w) : null;
    return {
      ghosts: [...this.players.values()].filter((p) => !p.alive && p.id !== me.id).map((p) => ({ id: p.id, name: this.nick(p), isBot: p.isBot })),
      positions: alive.map((p) => ({ id: p.id, name: `${this.nick(p)}${p.ko ? ' (สลบ)' : ''}`, zoneName: this.spotName(p.zoneId, p.outside) })),
      bodies: bodies.map((b) => ({ name: this.nick(this.players.get(b.victimId)), zoneName: this.spotName(b.zoneId, b.outside), announced: b.announced })),
      lockedZones: [...this.zones.values()].filter((z) => z.locked).map((z) => z.name),
      rooms: [...this.zones.values()].map((z) => ({
        id: z.id,
        name: z.name,
        isSleep: z.id === this.location.sleepZoneId,
        locked: z.locked,
        broken: z.broken,
        dark: this.darkAt(z.id),
        barred: !!z.bar,
        people: alive.filter((p) => p.zoneId === z.id).map((p) => `${this.nick(p)}${p.outside ? ' (หน้าประตู)' : ''}${p.ko ? ' (สลบ)' : ''}`),
        bodies: bodies.filter((b) => b.zoneId === z.id).map((b) => `${this.nick(this.players.get(b.victimId))}${b.announced ? '' : ' (ยังไม่มีใครประกาศ)'}`),
        items: z.items.map((i) => ({ name: i.name, hidden: !!i.hidden, poisoned: !!i.poisoned, bloody: !!i.bloody })),
        traps: z.traps.map((t) => ({ name: t.item.name, setter: this.nick(this.players.get(t.setterId)), door: t.item.trapType === 'door' })),
        evidence: z.evidence.length,
      })),
      blackout: !!this.blackout,
      passages: this.passages.map((x) => ({ aName: this.zoneName(x.a), bName: this.zoneName(x.b) })),
      feed: this.timeline.slice(-12).flatMap((t) => t.events.map((text) => ({ day: t.day, hour: t.hour, phase: t.phase, text }))).slice(-60),
      watching: w
        ? {
            id: w.id,
            name: this.nick(w),
            playerName: w.name,
            characterName: wc?.name || null,
            zoneName: this.spotName(w.zoneId, w.outside),
            ko: !!w.ko,
            kills: w.kills,
            moveChoice: this.moves.has(w.id) ? this.zoneName(this.moves.get(w.id)) : null,
            actionChoice: this.actions.get(w.id)?.label || null,
            inventory: w.inventory.map((i) => this.itemView(i)),
            objectives: w.objectives.filter((o) => !o.done).map((o) => ({ text: o.text, remainingHours: Math.max(0, o.deadlineTurn - this.turn) })),
            exitsKnown: [...this.exits.values()].filter((x) => knowsExit(w, x)).map((x) => x.name),
            log: w.log.slice(-40),
          }
        : null,
    };
  }

  // ผีบอท: ทักทายผีคนใหม่ที่เป็นคนจริง บอกว่าตัวเองมาถึงฝั่งนี้แล้ว และบ่นเหตุการณ์เด็ด ๆ ของชั่วโมงนี้ในแชทผี — ให้คนที่ตายแล้วมีเพื่อนคุยแม้เล่นกับบอท
  botGhostChat() {
    if (!CONFIG.BOT_GHOST_CHAT || this.phase === PHASE.ENDED || this.phase === PHASE.LOBBY) return;
    const dead = [...this.players.values()].filter((p) => !p.alive);
    const oldBots = dead.filter((p) => p.isBot && this.ghostWelcomed.has(p.id));
    const oldHumans = dead.filter((p) => !p.isBot && this.ghostWelcomed.has(p.id));
    const newcomers = dead.filter((p) => !this.ghostWelcomed.has(p.id));
    for (const p of newcomers) this.ghostWelcomed.add(p.id);
    if (!dead.some((p) => !p.isBot)) return; // ไม่มีผีที่เป็นคนจริง ไม่ต้องพูด
    const say = (bot, text) => this.pushChat({ playerId: bot.id, name: bot.name, characterName: this.charOf(bot)?.name || null, text, ghost: true });
    for (const p of newcomers) {
      if (!p.isBot && oldBots.length) say(pick(oldBots), pick(GHOST_WELCOME).replace('{n}', this.nick(p)));
      else if (p.isBot && oldHumans.length) say(p, pick(GHOST_ARRIVE));
    }
    const bots = dead.filter((p) => p.isBot);
    const last = this.timeline.at(-1);
    if (!bots.length || !last || last.turn !== this.turn || last.phase !== this.phase) return;
    const juicy = last.events.filter((e) => /ฆ่า|สลบ|กับดัก|พิษ|สวนกลับ|เสียชีวิต|ย้ายศพ/.test(e));
    if (juicy.length && chance(0.6)) say(pick(bots), pick(GHOST_REACT).replace('{e}', pick(juicy)));
  }

  // ชีตทดสอบ (DEBUG_CHEATS=true เท่านั้น): ตายทันทีตรงที่ยืนอยู่ เพื่อดูโหมดวิญญาณ
  debugDie(playerId) {
    if (!CONFIG.DEBUG_CHEATS) throw new GameError('ปิดชีตทดสอบอยู่');
    const p = this.players.get(playerId);
    if (!p?.alive || !this.location || [PHASE.LOBBY, PHASE.ENDED, PHASE.GENERATING].includes(this.phase)) throw new GameError('ตอนนี้ตายไม่ได้');
    this.killPlayer(p, { cause: 'attack', killerId: null, weapon: { name: 'สิ่งลึกลับ', kind: 'weapon', tags: [] }, zoneId: p.zoneId, outside: p.outside, messy: false, witnesses: [] });
    this.moves.delete(p.id);
    this.actions.delete(p.id);
    this.ready.delete(p.id);
    this.recordEvent(`${this.nick(p)}ตายกะทันหันที่${this.zn(p.zoneId)} (ชีตทดสอบ)`);
    this.systemMessage(`💀 (ทดสอบ) ${p.name} ตายกะทันหัน`);
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
          if ((this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION) && this.step === STEP.MOVE && !this.moves.has(b.id) && b.alive && !b.ko) {
            // ความผิดพลาดใน timer ของบอทต้องไม่ทำให้เซิร์ฟเวอร์ล้ม — เลือกห้องพลาดให้อยู่ห้องเดิม
            try {
              this.chooseMove(b.id, this.botPickZone(b));
            } catch (err) {
              this.log.error(`[room ${this.code}] bot move failed`, err);
              try { this.chooseMove(b.id, b.zoneId); } catch {}
            }
          }
        }, delay(1500, 3000));
      }
    }
    if (inExplore && this.step === STEP.ACT) {
      for (const b of bots) {
        this.setTimer(() => {
          if ((this.phase === PHASE.DAY || this.phase === PHASE.INVESTIGATION) && this.step === STEP.ACT && !this.actions.has(b.id) && b.alive && !b.ko) {
            try {
              this.botDoors(b); // ไขกุญแจทันทีถ้ามี
              this.botFreeItems(b); // หยิบ/วางของทันที ไม่กินชั่วโมง
              this.chooseAction(b.id, this.botPickAction(b));
            } catch {
              this.chooseAction(b.id, { type: 'rest' });
            }
          }
        }, delay(1500, 3000));
      }
    }
    if (this.phase === PHASE.DAY && this.step === STEP.REPORT) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase === PHASE.DAY && this.step === STEP.REPORT && !this.ready.has(b.id) && b.alive && !b.ko) this.markReady(b.id);
        }, delay(1000, 2000));
      }
    }
    if (this.phase === PHASE.TRIAL) {
      for (const b of bots) {
        this.setTimer(() => {
          if (this.phase !== PHASE.TRIAL || this.confirmedVotes.has(b.id) || !b.alive || b.ko) return;
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
    // ทางออกที่บอทรู้จักและพร้อมเปิด (ถือของครบ ขั้นที่เหลือทำเองได้) หรืออย่างน้อยไปทำขั้นถาวรให้คืบหน้าได้
    for (const x of this.exits.values()) if (!x.open && knowsExit(b, x) && exitReadyFor(this, b, x)) return x;
    for (const x of this.exits.values()) if (!x.open && knowsExit(b, x) && exitUsefulFor(this, b, x) && chance(0.5)) return x;
    return null;
  }

  botPickZone(b) {
    if (b.ko) return b.zoneId;
    if (this.lockedIn(b) || (!b.outside && this.zones.get(b.zoneId)?.bar)) {
      const ps = this.passages.find((x) => b.knownPassages.has(x.id) && (x.a === b.zoneId || x.b === b.zoneId));
      return ps ? (ps.a === b.zoneId ? ps.b : ps.a) : b.zoneId; // ถูกขัง: ออกทางลับถ้ารู้จัก ไม่งั้นอยู่ต่อแล้วสะเดาะ/พังในขั้นแอ็กชัน
    }
    const canEnter = (id) => {
      const z = this.zones.get(id);
      if (!z) return false;
      if (this.passageTo(b, id)) return true;
      return (!z.locked || this.hasKeyFor(b, id)) && !z.bar && !(b.zoneMemory[id]?.locked && b.zoneMemory[id]?.lockedSeenTurn >= this.turn - 3 && !this.hasKeyFor(b, id));
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

  // บอทหยิบ/วาง/ซ่อนของทันที (ไม่กินชั่วโมง) ก่อนเลือกแอ็กชันหลัก: ของตามภารกิจ ของทางออก กุญแจ แผนผัง และอาวุธถ้ายังไม่มี
  botFreeItems(b) {
    const z = this.zones.get(b.zoneId);
    if (!z || b.ko || b.outside) return;
    const run = (a) => {
      if (!a || a.disabled) return false;
      try {
        this.instantItemAction(b.id, a);
        return true;
      } catch {
        return false;
      }
    };
    const acts = () => this.itemActions(b);
    const obj = b.objectives.filter((o) => !o.done);
    const t = obj.find((o) => o.type === 'take');
    if (t) run(acts().find((a) => a.type === 'take' && a.itemId === t.itemId));
    const pl = obj.find((o) => o.type === 'plant' && o.zoneId === b.zoneId);
    if (pl) run(acts().find((a) => (a.type === 'hide' || a.type === 'drop') && a.itemId === pl.itemId));
    for (const a of acts().filter((x) => x.type === 'take')) {
      const it = z.items.find((i) => i.id === a.itemId);
      if (it && (it.isPart || it.kind === 'clue' || it.kind === 'key') && chance(0.6)) run(a);
    }
    const wt = acts().find((a) => a.type === 'take' && z.items.find((i) => i.id === a.itemId)?.kind === 'weapon');
    if (wt && !this.bestWeapon(b) && chance(0.4)) run(wt);
  }

  // บอทไขกุญแจทันที (ไม่กินชั่วโมง) เมื่อยืนรอหน้าประตูที่ล็อกหรือถูกขังอยู่แล้วมีกุญแจ
  botDoors(b) {
    const acts = this.doorActions(b);
    const a = acts.find((x) => x.type === 'unlockDoor') || acts.find((x) => x.type === 'removeBar') || (b.id === this.designatedId && chance(0.1) ? acts.find((x) => x.type === 'breakPower') : null);
    if (!a) return;
    try {
      this.instantDoorAction(b.id, a.type, a.itemId);
    } catch {}
  }

  botPickAction(b) {
    const avail = this.availableActions(b).filter((a) => !a.disabled);
    const byType = (t) => avail.filter((a) => a.type === t);
    const dw = byType('doorwork')[0];
    if (dw && (b.outside || this.lockedIn(b))) return dw; // ติดประตู: ทำงานกับประตูต่อ
    const fix = byType('repairPower')[0];
    if (fix && chance(0.6)) return fix; // ไฟดับ: บอทที่มาถึงเครื่องปั่นไฟช่วยซ่อม
    const grope = byType('grope')[0];
    if (grope && chance(0.4)) return grope;
    const obj = b.objectives.filter((o) => !o.done);
    const eatObj = obj.find((o) => o.type === 'visit_eat' && o.zoneId === b.zoneId);
    if (eatObj && byType('eat').length) return byType('eat')[0];
    const power = byType('exit_power')[0];
    if (power) return power;
    const exitAct = byType('exit').find((a) => !a.partial) || byType('exit')[0]; // ขั้นที่ทำได้จริงก่อน (กดรหัสทั้งที่รู้ไม่ครบไว้ท้ายสุด)
    if (exitAct && this.botExitTarget(b) && chance(0.7)) return exitAct;
    const examine = byType('examine');
    if (examine.length && chance(this.phase === PHASE.INVESTIGATION ? 0.6 : 0.4)) return pick(examine);
    const locked = this.murderLockedFor(b);
    const attacks = byType('attack');
    if (!locked && attacks.length === 1 && (this.designatedId === b.id || b.kills > 0) && this.bestWeapon(b) && chance(0.6)) return attacks[0];
    const trapPlace = byType('trap');
    if (!locked && trapPlace.length && chance(0.7)) return trapPlace[0];
    const asm = byType('craft').find((a) => a.recipeId === 'assembly');
    if (asm) return asm; // ประกอบชิ้นส่วนทางออกทันทีที่ถือครบ
    const craft = byType('craft');
    if (craft.length && this.designatedId === b.id && chance(0.5)) return craft[0];
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
      // ประกาศบอกแค่ใครตายและพบที่ไหน (เวลาตายต้องตรวจศพ) · announcedDay/Hour = เวลาที่ประกาศ
      announcedDay: c.announcedDay ?? null,
      announcedHour: c.announcedHour ?? null,
      victim: { playerId: v.id, playerName: v.name, characterName: this.charOf(v)?.name || v.name, nickname: this.nick(v) },
      zoneName: this.spotName(b?.zoneId || c.zoneId, b ? b.outside : c.outside),
      title: c.narrative?.title || 'คดีที่ยังไม่มีชื่อ',
      // สภาพศพ/ความผิดปกติรอบศพจากผู้บรรยายเป็น "เฉลย" หลังคดีถูกตัดสินเท่านั้น — ระหว่างเกมต้องตรวจศพ/สำรวจห้องเอง
      bodyState: c.judged ? c.narrative?.bodyState || '' : '',
      sceneNotes: c.judged ? c.narrative?.sceneNotes || '' : '',
      judged: c.judged,
    };
  }

  doorView(me) {
    const m = this.doorMeans(me);
    return {
      outside: !!me.outside,
      lockedIn: this.knowsLockedIn(me),
      hasKeyHere: this.hasKeyFor(me, me.zoneId),
      barred: !!this.zones.get(me.zoneId)?.bar,
      barItem: this.zones.get(me.zoneId)?.bar?.item?.name || null,
      means: m ? { method: m.method, label: m.method === 'break' ? `พังประตูด้วยมือเปล่าได้ (${m.hours[0]}–${m.hours[1]} ชม.)` : `สะเดาะกลอนด้วย${m.item.name}ได้ (${m.hours[0]}–${m.hours[1]} ชม.)` } : null,
      work: me.doorWork && this.zones.get(me.doorWork.zoneId)?.doorWork?.[me.doorWork.method] ? { zoneId: me.doorWork.zoneId, zoneName: this.zoneName(me.doorWork.zoneId), method: me.doorWork.method, progress: this.zones.get(me.doorWork.zoneId).doorWork[me.doorWork.method].progress } : null,
    };
  }

  // ป้ายแท็กของ (หนัก · มีคม · ยิงได้ …) ให้ผู้เล่นรู้ว่าของชิ้นนี้ทำอะไรได้
  tagText(i) {
    return [i.broken ? '💔 พัง (ซ่อมก่อนใช้)' : '', ...[...tagsOf(i)].map((t) => TAG_LABEL[t])].filter(Boolean).join(' · ');
  }

  itemView(i) {
    return { id: i.id, name: i.name, kind: i.kind, isPart: !!i.isPart, bloody: !!i.bloody, broken: !!i.broken, description: i.description, trapType: i.trapType || null, ammo: Number.isInteger(i.ammo) ? i.ammo : null, tagText: this.tagText(i), unlocksZoneNames: (i.unlocksZoneIds || []).map((id) => this.zoneName(id)), exitName: i.exitId ? this.exits.get(i.exitId)?.name || null : null };
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
      // คนที่คดีถูกตัดสินแล้วยังแสดงว่าตายเสมอ (ศพถูกเก็บไปแล้วแต่ทุกคนรู้ว่าเขาตาย)
      const deathKnown = !p.alive && (ended || isMe || spectator || body?.announced || p.caseJudged || ['executed', 'punished', 'escaped', 'left_behind'].includes(p.fate) || (!!me && me.knownBodies.has(p.id)));
      const sameZone = !!me && me.alive && p.alive && inZoneStep && this.sameSpot(p, me) && this.canSee(me); // มืด = ไม่รู้ว่าใครอยู่ด้วย
      const showProgress = isMe || spectator || ended; // ใครเลือกแล้ว/ยังไม่เลือก เห็นเฉพาะของตัวเอง — ไม่งั้นคนตายที่ยังไม่ถูกพบจะถูกสังเกตว่าไม่ขยับ
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
        moved: showProgress && this.moves.has(p.id),
        acted: showProgress && this.actions.has(p.id),
        ready: showProgress && this.ready.has(p.id),
        voteConfirmed: this.confirmedVotes.has(p.id) || (this.phase === PHASE.TRIAL && !!p.ko),
        hasVoted: this.votes.has(p.id),
        vote: spectator && this.phase === PHASE.TRIAL ? this.votes.get(p.id) || null : null, // ผีเห็นว่าใครโหวตใคร
        ko: isMe || spectator || ended || sameZone ? !!p.ko : false,
        zoneId: isMe || spectator || ended || sameZone ? p.zoneId : null,
        outside: isMe || spectator || ended || sameZone ? !!p.outside : false,
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
    const zonesPublic = this.location ? this.location.zones.map((z) => ({ id: z.id, name: z.name, description: z.description, isSleep: z.id === this.location.sleepZoneId, water: !!this.zones.get(z.id)?.water, power: !!this.zones.get(z.id)?.items.some((i) => i.kind === 'power') })) : [];
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
      investigation: this.phase === PHASE.INVESTIGATION && this.investigation ? { hour: this.investigation.hour, total: this.investigation.total } : null,
      config: {
        minPlayers: CONFIG.MIN_PLAYERS,
        maxPlayers: CONFIG.MAX_PLAYERS,
        stepTimeoutMs: CONFIG.STEP_TIMEOUT_MS,
        maxHours: CONFIG.MAX_HOURS,
        bodyDiscoverers: CONFIG.BODY_DISCOVERERS,
        murderLock: CONFIG.MURDER_LOCK,
        inventoryMax: CONFIG.INVENTORY_MAX,
        objectives: CONFIG.OBJECTIVES,
        maxRunoffs: CONFIG.MAX_RUNOFFS,
        hiddenUltimates: hiddenUltimateCap(this.players.size || CONFIG.MIN_PLAYERS),
        fakeRoles: Math.min(CONFIG.FAKE_ROLES, Math.max(0, this.players.size - 1)),
        exitsPerGame: ESCAPE.EXITS_PER_GAME,
        botRequests: CONFIG.BOT_REQUESTS,
        recipes: RECIPES.map((r) => ({ id: r.id, name: r.name, how: r.how, desc: r.desc, trait: r.trait, traitLabel: r.trait ? TRAITS[r.trait]?.label || r.trait : null })),
        traitEffects: TRAIT_EFFECTS,
        debugCheats: CONFIG.DEBUG_CHEATS, // ปุ่ม "ตายทันที" สำหรับทดสอบโหมดวิญญาณ
        door: { pickHours: DOOR.PICK_HOURS, breakHours: DOOR.BREAK_HOURS },
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
            outside: !!me.outside,
            moveChoice: this.moves.get(me.id) || null,
            actionChoice: myAction ? { type: myAction.type, label: myAction.label || myAction.type, forced: !!myAction.forced, busy: !!myAction.busy, ko: !!myAction.ko } : null,
            ko: me.ko ? { hours: me.ko.hours, cause: me.ko.cause } : null,
            forced: me.forced ? { zoneId: me.forced.zoneId, zoneName: this.zoneName(me.forced.zoneId), actionLabel: forcedLabel(me.forced.action) } : null,
            // ประตู: ถูกขังอยู่ไหม (เฉพาะที่รู้ตัวแล้ว) มีวิธีผ่านประตูที่ล็อกไหม และงานค้างที่ประตู (ไม่บอกว่าต้องอีกกี่ชั่วโมง — แล้วแต่ดวง)
            door: me.alive && me.zoneId ? this.doorView(me) : null,
            ready: this.ready.has(me.id),
            myVote: this.votes.get(me.id) || null,
            voteConfirmed: this.confirmedVotes.has(me.id),
            isDesignated: this.phase === PHASE.DAY && this.designatedId === me.id,
            inventory: me.inventory.map((i) => this.itemView(i)),
            inventoryMax: this.invMax(me),
            buffs: { questPlus: me.buffs?.questPlus || 0, koResist: me.buffs?.koResist || 0 },
            objectives: me.objectives
              .filter((o) => !o.done || this.turn < me.nextObjectiveTurn || o.doneTurn === this.turn)
              .slice(-2)
              .map((o) => ({ id: o.id, type: o.type, text: o.text, hours: o.hours, remainingHours: Math.max(0, o.deadlineTurn - this.turn), done: o.done, forgiven: !!o.forgiven })),
            nextObjectiveIn: CONFIG.OBJECTIVES && me.alive && !activeObj ? Math.max(0, me.nextObjectiveTurn - this.turn) : null,
            exits: knownExits,
            log: me.log.slice(-150),
            evidence: evidenceRows,
            knownBodies: [...me.knownBodies].map((id) => ({ playerId: id, name: this.nick(this.players.get(id)), zoneName: this.zoneName(this.bodies.get(id)?.zoneId), outside: !!this.bodies.get(id)?.outside, announced: !!this.bodies.get(id)?.announced })),
            zoneMemory: me.zoneMemory,
            availableActions: me.alive && this.step === STEP.ACT ? this.availableActions(me) : [],
            itemActions: me.alive && (this.step === STEP.ACT || this.step === STEP.REPORT) ? this.itemActions(me) : [], // หยิบ/วางทันที ไม่กินชั่วโมง
            doorActions: me.alive && this.step ? this.doorActions(me) : [], // ไขกุญแจ/ล็อก/ค้ำประตู/พังไฟ ทันที ไม่กินชั่วโมง
            blackout: !!this.blackout,
            canSee: me.alive ? this.canSee(me) : true,
            passages: [...me.knownPassages].map((id) => this.passages.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x.id, a: x.a, b: x.b, aName: this.zoneName(x.a), bName: this.zoneName(x.b) })),
            zonePeople: me.alive && inZoneStep && this.canSee(me)
              ? this.presentWith(me)
                  .filter((o) => o.id !== me.id)
                  .map((o) => ({ id: o.id, name: this.nick(o), isBot: o.isBot, ko: !!o.ko, invFull: o.inventory.length >= this.invMax(o), items: o.isBot && CONFIG.BOT_REQUESTS ? o.inventory.map((i) => ({ id: i.id, name: i.name, kind: i.kind, isPart: !!i.isPart })) : undefined }))
              : [],
            eventPrivateNote: ev && ev.playerId === me.id ? ev.privateNote : null,
            notices: this.notices.get(me.id) || [],
            // ผี (ตายแล้ว) เห็นทุกอย่าง: ทุกห้อง ทุกคน เหตุการณ์จริง ผีด้วยกัน และคนที่กำลังตามดู (spectatorView)
            spectator: spectator ? this.spectatorView(me) : null,
          }
        : null,
      players,
      location: this.location ? { name: this.location.name, description: this.location.description, zones: zonesPublic, sleepZoneId: this.location.sleepZoneId } : null,
      exitsTotal: this.location ? this.exits.size : 0,
      bodyThreshold: this.location ? this.bodyThreshold() : null,
      announcedCases: announced,
      announcement: this.announcement,
      dayPopup: this.dayPopup,
      huntRound: this.huntRound,
      runoff: this.runoff ? { number: this.runoff.number, candidates: this.runoff.candidates, previousTally: this.runoff.previousTally } : null,
      specialEvent: ev ? { type: ev.type, day: ev.day, playerId: ev.playerId, playerName: ev.playerName, characterName: ev.characterName, title: ev.title, story: ev.story } : null,
      lastResult: showResult ? this.lastResult : null,
      history: this.history,
      outcome: ended ? this.outcome : null,
      chat: this.chat.filter((m) => (!m.ghost || spectator || ended) && (!m.to || m.to === playerId)).slice(-150), // แชทผีเห็นเฉพาะผี (ทุกคนเห็นเมื่อเกมจบ) · คำตอบคำสั่งตรวจสอบเห็นเฉพาะคนพิมพ์
    };
  }
}
