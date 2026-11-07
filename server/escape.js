// ระบบทางออก — ทางออก 2 ทางต่อเกม ซ่อนอยู่ในห้องธรรมดา (ไม่มีใครรู้ว่าอยู่ไหนจนกว่าจะ "สำรวจ" เจอ หรือเจอแผนผัง)
// แต่ละทางมี "เส้นทาง" (route) และ "ขั้นตอน" (steps) 4 ข้อที่ต้องผ่านให้ครบถึงจะเปิดได้ (เส้นทางซ่อม = 5 เพราะต้องประกอบชิ้นส่วนก่อน):
//   key = ถือกุญแจของทางออก (หรือสะเดาะด้วยที่สะเดาะ/ช่างเทคนิค+เครื่องมือ) · code = จำเศษรหัสให้ครบ (หยิบแล้วจำได้ทันที) · assembly = ประกอบชิ้นส่วน 2 ชิ้น หรือดัดแปลงจากเครื่องมือ+วัสดุ แล้วติดตั้ง
//   ทุกขั้นเป็นแอ็กชันของตัวเอง (เลือกขั้นที่จะทำในชั่วโมงนั้น) ทำสำเร็จแล้วติดถาวร · ไม่ระบุขั้น (บอท/เทสต์เก่า) = ทำทุกขั้นที่ทำได้
//   power = เอาฟิวส์ไปใส่แผงไฟก่อน · tool = เครื่องมือช่าง (ถอดน็อต/เปิดฝา ทำครั้งเดียวติดถาวร) · cut = ของมีคม (ตัดโซ่/สายเคเบิล ครั้งเดียว)
//   force = ลงแรงสะสม (ของหนักหรืออาวุธมีคม นักสู้/ช่างเทคนิค 2 แต้มต่อครั้ง)
// ของที่ต้องใช้ถูกซ่อนตามห้องต่าง ๆ · ความรู้ว่าทางออกอยู่ไหนเป็นของแต่ละคน (discoveredBy) ส่วนความคืบหน้า (steps/powered/open) เป็นของจริงที่ทุกคนใช้ร่วมกัน
import { ESCAPE, ROUTES, tagsOf, canBreachWith, DURABILITY } from './rules.js';

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

export const ROUTE_KEYS = Object.keys(ROUTES);

// เทมเพลตสำรองเมื่อสถานที่ (AI/mock) ให้ทางออกมาไม่พอ
const GENERIC_EXITS = [
  { name: 'ประตูเหล็กด้านหลัง', description: 'ประตูเหล็กหนาที่ถูกล็อกด้วยแม่กุญแจใหญ่ มีรอยสนิมแต่ยังแข็งแรง', route: 'locked', itemNames: ['กุญแจประตูเหล็กด้านหลัง'] },
  { name: 'ช่องระบายอากาศหลัก', description: 'ตะแกรงเหล็กขนาดคนมุดได้ ยึดด้วยน็อตที่ขึ้นสนิมจนต้องงัด', route: 'breach', itemNames: [] },
  { name: 'ประตูนิรภัยแบบกดรหัส', description: 'ประตูเหล็กซ่อนหลังชั้นวาง มีแป้นกดรหัส 3 หลัก', route: 'code', itemNames: [] },
  { name: 'ลิฟต์ขนของ', description: 'ลิฟต์เก่าที่ไฟไม่เข้า ถ้ามีไฟน่าจะขึ้นไปถึงด้านบนได้', route: 'power', itemNames: ['ฟิวส์ลิฟต์ขนของ'] },
  { name: 'รถเก่าในโรงเก็บ', description: 'รถที่ถูกถอดชิ้นส่วนบางอย่างออก ถ้าซ่อมได้ก็ขับฝ่าออกไปได้', route: 'repair', itemNames: ['แบตเตอรี่รถ', 'กุญแจรถ'] },
];

const TOOL_HINT = 'เครื่องมือช่าง (ไขควง/ประแจ/ค้อน/คีม)';
const FORCE_HINT = 'ของหนักหรืออาวุธมีคม · นักสู้/ช่างเทคนิค 2 แต้มต่อครั้ง';

export function routeLabel(route) {
  return ROUTES[route]?.label || route;
}

const itemNamed = (exit, role) => exit.items.find((i) => i.role === role)?.name || '';

// ข้อความของขั้นตอนหนึ่ง ๆ
export function stepLabel(game, exit, s) {
  switch (s.kind) {
    case 'key':
      return `${s.verb || 'ไขกุญแจ'}: หา "${itemNamed(exit, 'key') || 'กุญแจของทางออกนี้'}" (ซ่อนอยู่ในห้องใดห้องหนึ่ง ต้องสำรวจถึงเจอ — ถ้ามีห้องที่ล็อกมักอยู่ในนั้น) หรือใช้ที่สะเดาะกลอน (ช่างเทคนิคใช้เครื่องมือช่างแทนได้) แล้วเลือกขั้นนี้ที่ห้องนี้ — ทำครั้งเดียวติดถาวร`;
    case 'code':
      return `กดรหัส: หาเศษกระดาษรหัสให้ครบ ${ESCAPE.CODE_NOTES} ชิ้น (ซ่อนตามห้อง ต้องสำรวจ) หยิบแล้ว "จำได้ทันที" ไม่ต้องถือไว้ — มาเลือกขั้นนี้ที่ห้องนี้ คนที่รู้คนละส่วนเลือกกดพร้อมกันนับรวมกันได้ · ช่างเทคนิคใช้แค่ ${ESCAPE.CODE_NOTES_TECH} ชิ้น`;
    case 'assembly': {
      const parts = exit.items.filter((i) => i.role === 'part').map((i) => i.name);
      return `ติดตั้ง "${exit.assembly?.name || 'ชุดชิ้นส่วน'}": หา ${parts.join(' และ ')} (ซ่อนตามห้อง) ถือครบ 2 ชิ้นแล้วเลือก "🛠 ประกอบ" (ใช้ 1 ชั่วโมง ทำที่ห้องไหนก็ได้) — หรือ "ดัดแปลง" จากเครื่องมือช่าง + เชือก/ของหนัก/สายไฟ แทน — แล้วถือมาเลือกขั้นนี้ที่ห้องนี้ (ชุดหมดไป ติดถาวร)`;
    }
    case 'power': {
      const powerZones = [...game.zones.values()].filter((z) => z.items.some((i) => i.kind === 'power')).map((z) => z.name);
      return exit.powered ? 'จ่ายไฟ: มีไฟแล้ว' : `จ่ายไฟ: หา "${itemNamed(exit, 'fuse') || 'ฟิวส์'}" (ซ่อนตามห้อง) หรือสายไฟ/ของนำไฟฟ้าแทน → ถือไปห้องที่มีแผงไฟ (${powerZones.join(', ') || '?'}) → เลือก "⚡ ใส่ฟิวส์" → ไฟเข้าแล้วขั้นนี้ติดถาวร`;
    }
    case 'tool':
      return `${s.verb || 'ถอดน็อต/เปิดฝา'}: ถือ${TOOL_HINT}มาที่ห้องนี้แล้วเลือกขั้นนี้ — ทำสำเร็จครั้งเดียวติดถาวร (เครื่องมืออาจพัง 20%)`;
    case 'cut':
      return `${s.verb || 'ตัดโซ่/สายเคเบิล'}: ถือของมีคม (มีด/ขวาน/กรรไกร/คีมตัด) มาที่ห้องนี้แล้วเลือกขั้นนี้ — ทำสำเร็จครั้งเดียวติดถาวร (ของอาจพัง 20%)`;
    case 'force':
      return `${s.verb || 'งัด/ทุบ'}: ถือ${FORCE_HINT}มาแล้วเลือกขั้นนี้ ได้ครั้งละ 1 แต้ม (นักสู้/ช่างเทคนิค 2) จนครบ ${s.needed} แต้ม — หลายคนลงแรงพร้อมกันนับรวม แต้มสะสมไม่หาย${s.loud ? ' · เสียงดัง คนห้องอื่นอาจได้ยิน' : ''}`;
    default:
      return s.kind;
  }
}

// ขั้นตอนของแต่ละเส้นทาง (4 ข้อ · ซ่อม = ต้องหาชิ้นส่วน 2 ชิ้น + ประกอบก่อน จึงนับเป็น 5)
function stepsFor(route) {
  const S = (kind, extra = {}) => ({ id: kind, kind, done: false, progress: 0, needed: 0, ...extra });
  switch (route) {
    case 'locked':
      return [S('cut', { verb: 'ตัดโซ่ที่ล่ามประตู' }), S('key', { verb: 'ไขแม่กุญแจ' }), S('tool', { verb: 'ถอดบานพับ/สลัก' }), S('force', { verb: 'งัดบานประตูที่บวมติดกรอบ', needed: 3 })];
    case 'code':
      return [S('cut', { verb: 'ตัดสายเคเบิลสัญญาณเตือน' }), S('tool', { verb: 'เปิดฝาครอบแป้นรหัส' }), S('code'), S('force', { verb: 'ดันประตูที่ติดขัด', needed: 2 })];
    case 'repair':
      return [S('assembly'), S('key', { verb: 'สตาร์ต/ปลดล็อก' }), S('tool', { verb: 'ติดตั้งชิ้นส่วนที่ประกอบแล้ว' }), S('force', { verb: 'งัดฝาครอบ/ประตูที่ติดขัด', needed: 2 })];
    case 'power':
      return [S('power'), S('tool', { verb: 'เปิดตู้ควบคุม' }), S('key', { verb: 'ปลดล็อกตู้ควบคุม' }), S('force', { verb: 'ง้างบานประตูที่ค้าง', needed: 3 })];
    case 'breach':
    default:
      return [S('cut', { verb: 'ตัดลวด/สายเคเบิลที่รัดอยู่' }), S('tool', { verb: 'ถอดน็อตที่ขึ้นสนิม' }), S('key', { verb: 'ไขแม่กุญแจที่คล้องไว้' }), S('force', { verb: 'ทุบ/งัดให้ขาด', needed: ESCAPE.BREACH_PROGRESS, loud: true })];
  }
}

// ข้อความบอกว่าต้องทำอะไรบ้าง (ทุกขั้นตอน)
export function requirementText(game, exit) {
  const st = exitStatus(game, exit, []);
  return st.map((s, i) => `${i + 1}) ${s.done ? '✅ ' : ''}${s.label}`).join(' · ');
}

// สร้างทางออกจากเทมเพลตของสถานที่ และซ่อนของที่ต้องใช้ตามห้องต่าง ๆ (เรียกจาก Game.buildWorld หลังสร้าง zones แล้ว)
export function buildExits(game, loc) {
  game.exits = new Map();
  const zones = [...game.zones.values()];
  const explore = zones.filter((z) => z.id !== loc.sleepZoneId);
  const templates = shuffle([...(loc.exits || [])].filter((e) => ROUTES[e.route]));
  const hasPower = zones.some((z) => z.items.some((i) => i.kind === 'power'));
  const chosen = [];
  const usedRoutes = new Set();
  const usedZones = new Set();
  const consider = [...templates, ...shuffle(GENERIC_EXITS)];
  for (const t of consider) {
    if (chosen.length >= ESCAPE.EXITS_PER_GAME) break;
    if (usedRoutes.has(t.route)) continue;
    if (t.route === 'power' && !hasPower) continue;
    usedRoutes.add(t.route);
    chosen.push(t);
  }
  chosen.forEach((t, idx) => {
    let zone = explore.find((z) => t.zoneName && z.name === t.zoneName && !usedZones.has(z.id));
    if (!zone) zone = pick(explore.filter((z) => !usedZones.has(z.id))) || pick(explore);
    usedZones.add(zone.id);
    const id = `x${idx + 1}`;
    const steps = stepsFor(t.route);
    const force = steps.find((s) => s.kind === 'force');
    const exit = {
      id,
      zoneId: zone.id,
      name: t.name,
      description: t.description || '',
      route: t.route,
      items: [],
      steps,
      assembly: null,
      powered: false,
      progress: 0,
      progressNeeded: force?.needed || 0,
      open: false,
      openedBy: [],
      discoveredBy: new Set(),
      clueItemId: null,
    };
    const names = t.itemNames || [];
    const specs = [];
    // ของที่ต้องใช้ตามขั้นตอน
    if (steps.some((s) => s.kind === 'key')) {
      const keyName = t.route === 'locked' ? names[0] || `กุญแจ${t.name}` : t.route === 'repair' ? names[1] || `กุญแจสตาร์ต${t.name}` : t.route === 'power' ? `กุญแจตู้ควบคุม${t.name}` : `กุญแจแม่กุญแจ${t.name}`;
      specs.push({ role: 'key', kind: 'key', name: keyName, description: `กุญแจที่น่าจะใช้กับ${t.name}` });
    }
    if (steps.some((s) => s.kind === 'code')) for (let i = 1; i <= ESCAPE.CODE_NOTES; i++) specs.push({ role: 'code', kind: 'part', name: `เศษกระดาษรหัสชิ้นที่ ${i} (${t.name})`, description: `เศษกระดาษเขียนตัวเลขหนึ่งหลักและคำว่า "${t.name}"` });
    if (steps.some((s) => s.kind === 'assembly')) {
      const partName = t.route === 'repair' && names.length >= 1 ? names[0] : `ชิ้นส่วนที่หายไปของ${t.name}`;
      const n = [partName, `ชิ้นส่วนสำคัญของ${t.name}`];
      for (const nm of n) specs.push({ role: 'part', kind: 'part', name: nm, description: `ชิ้นส่วนที่ถูกถอดออกจาก${t.name} ต้องประกอบเข้ากับอีกชิ้นก่อนใช้` });
      exit.assembly = { name: `ชุดชิ้นส่วน${t.name} (ประกอบแล้ว)`, itemId: `${id}_assembly`, partIds: [] };
    }
    if (steps.some((s) => s.kind === 'power')) specs.push({ role: 'fuse', kind: 'part', name: (t.route === 'power' && names[0]) || `ฟิวส์ของ${t.name}`, description: `ฟิวส์ที่ถูกถอดออก ถ้าใส่เข้าแผงไฟ ${t.name}น่าจะมีไฟ` });
    const hideZones = shuffle(explore.filter((z) => z.id !== zone.id));
    // กุญแจของประตูทางออก ถ้ามีห้องที่ล็อกอยู่ให้ซ่อนไว้ในนั้น (ต้องหากุญแจห้องก่อนถึงจะได้กุญแจทางออก)
    const lockedZones = shuffle(explore.filter((z) => z.locked && z.id !== zone.id));
    specs.forEach((s, i) => {
      const hz = (s.role === 'key' && lockedZones[0]) || hideZones[i % hideZones.length] || zone;
      const item = { id: `${id}_${s.role}${i + 1}`, name: s.name, description: s.description, kind: s.kind, portable: true, hidden: true, isPart: true, exitId: id, role: s.role, originZoneId: hz.id };
      hz.items.push(item);
      exit.items.push({ id: item.id, name: item.name, role: s.role });
      if (s.role === 'part' && exit.assembly) exit.assembly.partIds.push(item.id);
    });
    // แผนผัง/บันทึกที่บอกตำแหน่งทางออก ซ่อนอยู่ห้องอื่น
    const cz = pick(hideZones) || zone;
    const clue = { id: `${id}_clue`, name: pick([`แผนผังที่วงไว้ตรง${t.name}`, `บันทึกเก่าที่พูดถึง${t.name}`]), description: `บอกว่า${t.name}อยู่ที่${zone.name} และต้องทำอย่างไรถึงจะออกได้`, kind: 'clue', portable: true, hidden: true, isPart: false, revealsExitId: id, originZoneId: cz.id };
    cz.items.push(clue);
    exit.clueItemId = clue.id;
    game.exits.set(id, exit);
  });
}

export function exitsIn(game, zoneId) {
  return [...game.exits.values()].filter((x) => x.zoneId === zoneId);
}

export function knowsExit(p, exit) {
  return exit.discoveredBy.has(p.id);
}

// ผู้เล่นค้นพบทางออก (จากการสำรวจ / แผนผัง / คนในห้องชี้ให้ดู)
export function discoverExit(game, p, exit, how) {
  if (exit.discoveredBy.has(p.id)) return false;
  exit.discoveredBy.add(p.id);
  const where = `${game.zn(exit.zoneId)}`;
  game.logTo(p, `🚪 ${how}: ทางออก "${exit.name}" อยู่ที่${where}— ${exit.description} · ${routeLabel(exit.route)} ต้องผ่าน ${exit.steps.length} ขั้น: ${requirementText(game, exit)}`, 'escape');
  return true;
}

// สำรวจห้อง: มีโอกาสเจอทางออกที่ซ่อนอยู่ในห้องนี้
export function tryFindExit(game, p, zone, bonus = 0) {
  const found = [];
  for (const x of exitsIn(game, zone.id)) {
    if (knowsExit(p, x)) continue;
    if (chance(ESCAPE.FIND_EXIT_CHANCE + bonus)) {
      discoverExit(game, p, x, 'คุณค้นพบสิ่งที่ซ่อนอยู่ในห้องนี้');
      game.recordEvent(`${game.nick(p)}ค้นพบทางออก "${x.name}" ที่${game.zn(zone)}`);
      found.push(x);
    }
  }
  return found;
}

// ได้ของที่เกี่ยวกับทางออกมาไว้กับตัว (หยิบ/ล้วง/รับ) → บอกว่ามันคืออะไร และแผนผังเปิดเผยตำแหน่งทางออก
export function onObtainItem(game, p, item) {
  if (item.revealsExitId) {
    const x = game.exits.get(item.revealsExitId);
    if (x) discoverExit(game, p, x, `คุณอ่าน${item.name}`);
    return;
  }
  if (item.exitId) {
    const x = game.exits.get(item.exitId);
    if (!x) return;
    if (item.role === 'code') {
      // หยิบเศษรหัสแล้วจำได้ทันที — วาง/ให้/ซ่อนกระดาษทีหลังก็ยังจำได้ (ยึดกระดาษกันไม่ได้)
      p.knownCodes ||= {};
      (p.knownCodes[x.id] ||= new Set()).add(item.id);
      game.logTo(p, `🧠 คุณจำตัวเลขบน${item.name}ได้แล้ว — รู้รหัสของ "${x.name}" ${codeKnownBy(p, x).size}/${ESCAPE.CODE_NOTES} ส่วน (ช่างเทคนิคใช้ ${ESCAPE.CODE_NOTES_TECH}) · จะวาง/ให้/ซ่อนกระดาษก็ได้ คุณยังจำได้อยู่`, 'escape');
    }
    const partHint = item.role === 'part' && x.assembly ? ` (ต้องประกอบกับอีกชิ้นเป็น "${x.assembly.name}" ก่อนใช้)` : '';
    game.logTo(p, knowsExit(p, x) ? `⭐ ${item.name}ใช้กับทางออก "${x.name}" ที่${game.zn(x.zoneId)}${partHint}` : `⭐ ${item.name}ดูเป็นของสำคัญสำหรับทางออก "${x.name}"${partHint} — แต่คุณยังไม่รู้ว่าทางออกนี้อยู่ตรงไหน`, 'escape');
  }
}

const holdsHeavy = (p) => p.inventory.some(canBreachWith); // ของหนักหรืออาวุธมีคม (ดูแท็ก) — ไขควง สมุด ไฟฉาย ใช้ทุบไม่ได้
const holdsSharp = (p) => p.inventory.some((i) => !i.broken && tagsOf(i).has('sharp'));
const holdsTool = (p) => p.inventory.some((i) => !i.broken && tagsOf(i).has('fastener'));
// ของที่ใช้ในขั้นนั้น (ไว้สุ่มพัง)
const sharpOf = (p) => p.inventory.find((i) => !i.broken && tagsOf(i).has('sharp'));
const toolOf = (p) => p.inventory.find((i) => !i.broken && tagsOf(i).has('fastener'));
const heavyOf = (p) => p.inventory.find(canBreachWith);
const keyOf = (p, x) => p.inventory.find((i) => i.exitId === x.id && i.role === 'key');
const pickOf = (game, p) => p.inventory.find((i) => i.kind === 'lockpick' && !i.broken) || (game.traitOf(p) === 'tech' ? toolOf(p) : null); // ของทดแทนกุญแจ: ที่สะเดาะ หรือช่างเทคนิค+เครื่องมือช่าง
const asmOf = (p, x) => p.inventory.find((i) => i.exitId === x.id && i.role === 'assembly' && !i.broken); // ชุดจริงหรือชิ้นส่วนดัดแปลง
const STEP_VERB = { key: 'ไขกุญแจ', code: 'กดรหัส', assembly: 'ติดตั้งชิ้นส่วน', power: 'จ่ายไฟ', tool: 'ถอดน็อต/เปิดฝา', cut: 'ตัดโซ่/สายเคเบิล', force: 'งัด/ทุบ' };
const STEP_ICON = { key: '🔑', code: '🔢', assembly: '🔩', power: '⚡', tool: '🔧', cut: '✂️', force: '💪' };
const forceGain = (game, p) => (['combat', 'tech'].includes(game.traitOf(p)) ? 2 : 1);

// รหัสที่คนนี้ "รู้": ที่จำไว้ (p.knownCodes[exitId]) รวมกับกระดาษที่ถืออยู่
export function codeKnownBy(p, exit) {
  const s = new Set(p.knownCodes?.[exit.id] || []);
  for (const i of p.inventory) if (i.exitId === exit.id && i.role === 'code') s.add(i.id);
  return s;
}
export function codeNeedFor(game, people) {
  return people.some((p) => game.traitOf(p) === 'tech') ? ESCAPE.CODE_NOTES_TECH : ESCAPE.CODE_NOTES;
}
const codeKnownByAll = (people, exit) => {
  const known = new Set();
  for (const p of people) for (const id of codeKnownBy(p, exit)) known.add(id);
  return known;
};

// สถานะแต่ละขั้นตอนเมื่อกลุ่ม people (คนที่ลงมือพร้อมกันในห้อง) ลองทำ — ไม่เปลี่ยนสถานะจริง (ใช้แสดงผล/ตัดสินใจ)
// people ว่าง = ดูเฉพาะสถานะถาวร (ขั้นที่ทำไปแล้ว) · ทุกขั้นติดถาวรเมื่อทำสำเร็จ
export function exitStatus(game, exit, people = []) {
  return exit.steps.map((s) => {
    let done = !!s.done;
    switch (s.kind) {
      case 'key':
        done = done || people.some((p) => keyOf(p, exit) || pickOf(game, p));
        break;
      case 'code':
        done = done || (people.length > 0 && codeKnownByAll(people, exit).size >= codeNeedFor(game, people));
        break;
      case 'assembly':
        done = done || people.some((p) => asmOf(p, exit));
        break;
      case 'power':
        done = done || !!exit.powered;
        break;
      case 'tool':
        done = done || people.some(holdsTool);
        break;
      case 'cut':
        done = done || people.some(holdsSharp);
        break;
      case 'force':
        done = done || s.progress >= s.needed;
        break;
      default:
        break;
    }
    return { id: s.id, kind: s.kind, label: stepLabel(game, exit, s), done, progress: s.progress || 0, needed: s.needed || 0, persistent: true };
  });
}

// ผู้เล่นคนเดียวพร้อมเปิดทางออกนี้ไหม (ทำขั้นที่เหลือทั้งหมดได้เอง) — ใช้ให้บอท/ตัวจำลองตัดสินใจ
export function exitReadyFor(game, p, exit) {
  if (!exit || exit.open) return false;
  return exitStatus(game, exit, [p]).every((s) => s.done || (s.kind === 'force' && holdsHeavy(p)));
}

// ผู้เล่นคนนี้ไปลงมือแล้วมีอะไรคืบหน้าไหม: ทำขั้นที่ยังไม่เสร็จได้อย่างน้อยหนึ่งขั้น — ใช้ให้บอท/ตัวจำลองตัดสินใจไปที่ทางออก
export function exitUsefulFor(game, p, exit) {
  if (!exit || exit.open) return false;
  if (exitReadyFor(game, p, exit)) return true;
  return exit.steps.some((s) => !s.done && ((s.kind === 'tool' && holdsTool(p)) || (s.kind === 'cut' && holdsSharp(p)) || (s.kind === 'force' && s.progress < s.needed && holdsHeavy(p)) || (s.kind === 'key' && (keyOf(p, exit) || pickOf(game, p))) || (s.kind === 'assembly' && asmOf(p, exit)) || (s.kind === 'code' && codeKnownBy(p, exit).size >= codeNeedFor(game, [p]))));
}

// ตัวเลือก "ประกอบชิ้นส่วนทางออก" เมื่อถือชิ้นส่วนครบทั้งสองชิ้น (ปรากฏใน craftOptions ของ game.js) + "ดัดแปลง" ชิ้นส่วนแทนชุดจริง
export function craftAssemblyOptions(game, p) {
  const out = [];
  for (const x of game.exits.values()) {
    if (!x.assembly || x.open) continue;
    const parts = x.assembly.partIds.map((id) => p.inventory.find((i) => i.id === id)).filter(Boolean);
    if (parts.length !== x.assembly.partIds.length) continue;
    // ไม่ใส่ exitId ในแอ็กชัน (คนที่ยังไม่รู้จักทางออกต้องไม่เห็น id ของมัน) — ตอนประกอบหาทางออกจาก id ของชิ้นส่วนแทน
    out.push({ type: 'craft', recipeId: 'assembly', itemId: parts[0].id, itemId2: parts[1].id, label: `🛠 ประกอบ "${x.assembly.name}" จาก ${parts.map((i) => i.name).join(' + ')}`, desc: `ชิ้นส่วนของทางออก "${x.name}" — ใช้เวลา 1 ชั่วโมง ได้ชุดชิ้นส่วนที่ประกอบแล้ว 1 ชิ้น (ขั้นตอนหนึ่งของการเปิดทางออกนี้)` });
  }
  // ดัดแปลงแทนชุดจริง (กันคนกักตุนชิ้นส่วน): เครื่องมือช่าง (ไม่หมด แต่อาจพัง) + เชือก/ของหนัก/สายไฟ 1 ชิ้น (หมดไป) — เฉพาะทางออกที่รู้จักและยังไม่ติดตั้ง
  const tool = toolOf(p);
  const mat = tool ? p.inventory.find((i) => i !== tool && !i.isPart && !i.broken && i.kind !== 'trap' && (i.kind === 'rope' || tagsOf(i).has('heavy') || tagsOf(i).has('conductive'))) : null;
  if (tool && mat) {
    for (const x of game.exits.values()) {
      if (!x.assembly || x.open || !knowsExit(p, x) || x.steps.find((s) => s.kind === 'assembly')?.done || asmOf(p, x)) continue;
      out.push({ type: 'craft', recipeId: 'makeshift', exitId: x.id, itemId: tool.id, itemId2: mat.id, label: `🛠 ดัดแปลง "ชิ้นส่วนดัดแปลงสำหรับ${x.name}" จาก ${tool.name} + ${mat.name}`, desc: `ใช้แทน "${x.assembly.name}" ที่หาไม่ได้ — ใช้เวลา 1 ชั่วโมง ${mat.name}หมดไป (${tool.name}ยังอยู่ แต่อาจพัง 20%)` });
    }
  }
  return out;
}

export function doCraftAssembly(game, p, a) {
  const x = [...game.exits.values()].find((e) => e.assembly && e.assembly.partIds.includes(a.itemId) && e.assembly.partIds.includes(a.itemId2));
  if (!x?.assembly) return game.logTo(p, 'ของสำหรับประกอบไม่ครบ', 'danger');
  const parts = x.assembly.partIds.map((id) => p.inventory.find((i) => i.id === id)).filter(Boolean);
  if (parts.length !== x.assembly.partIds.length) return game.logTo(p, 'ของสำหรับประกอบไม่ครบ', 'danger');
  for (const it of parts) p.inventory.splice(p.inventory.indexOf(it), 1);
  const asm = { id: x.assembly.itemId, name: x.assembly.name, description: `ชิ้นส่วนของ${x.name}ที่ประกอบเข้าด้วยกันแล้ว พร้อมติดตั้ง`, kind: 'part', portable: true, hidden: false, isPart: true, exitId: x.id, role: 'assembly', originZoneId: p.zoneId };
  p.inventory.push(asm);
  if (!x.items.some((i) => i.role === 'assembly')) x.items.push({ id: asm.id, name: asm.name, role: 'assembly' });
  for (const it of x.items) if (it.role === 'part') it.assembled = true;
  const z = game.zones.get(p.zoneId);
  const who = game.who(p, z);
  game.logTo(p, `🛠 คุณประกอบ "${asm.name}" เสร็จแล้ว — เอาไปติดตั้งที่ "${x.name}"${knowsExit(p, x) ? ` ที่${game.zn(x.zoneId)}` : ' (ยังไม่รู้ว่าอยู่ห้องไหน)'}`, 'escape');
  for (const o of game.witnessesOf(p, z)) if (game.seen(p, 0.4)) game.logTo(o, `👀 คุณเห็น${who}นั่งประกอบชิ้นส่วนอะไรบางอย่างอยู่ตรงมุมห้อง${game.zn(z)}`, 'witness');
  game.recordEvent(`${game.nick(p)}ประกอบ "${asm.name}" ที่${game.zn(z)}`);
}

// ดัดแปลงชิ้นส่วนแทนชุดจริง: เครื่องมือช่างยังอยู่ (อาจพัง) วัสดุหมดไป ได้ของ role 'assembly' ของทางออกนั้น
export function doCraftMakeshift(game, p, a) {
  const x = game.exits.get(a.exitId);
  const tool = p.inventory.find((i) => i.id === a.itemId && !i.broken && tagsOf(i).has('fastener'));
  const mat = p.inventory.find((i) => i.id === a.itemId2 && i !== tool);
  if (!x?.assembly || x.open || !knowsExit(p, x) || !tool || !mat) return game.logTo(p, 'ของสำหรับดัดแปลงไม่ครบ', 'danger');
  p.inventory.splice(p.inventory.indexOf(mat), 1);
  const asm = { id: `${x.id}_makeshift_${game.turn}_${String(p.id).slice(0, 4)}`, name: `ชิ้นส่วนดัดแปลงสำหรับ${x.name}`, description: `ของดัดแปลงจาก${mat.name} พอใช้แทน${x.assembly.name}ได้`, kind: 'part', portable: true, hidden: false, isPart: true, exitId: x.id, role: 'assembly', makeshift: true, originZoneId: p.zoneId };
  p.inventory.push(asm);
  game.breakItemMaybe(p, tool, DURABILITY.BREAK_ON_EXIT, 'ดัดแปลงชิ้นส่วน');
  const z = game.zones.get(p.zoneId);
  game.logTo(p, `🛠 คุณดัดแปลง${mat.name}ด้วย${tool.name}จนได้ "${asm.name}" — เอาไปติดตั้งที่ "${x.name}" ที่${game.zn(x.zoneId)}ได้`, 'escape');
  for (const o of game.witnessesOf(p, z)) if (game.seen(p, 0.4)) game.logTo(o, `👀 คุณเห็น${game.who(p, z)}นั่งดัดแปลงอะไรบางอย่างอยู่ตรงมุมห้อง${game.zn(z)}`, 'witness');
  game.recordEvent(`${game.nick(p)}ดัดแปลง "${asm.name}" ที่${game.zn(z)}`);
}

// แอ็กชันเกี่ยวกับทางออกที่ผู้เล่นทำได้ในห้องนี้ — แยกเป็นขั้น ๆ (ขั้นที่ทำไม่ได้ขึ้นเป็นปุ่มปิดพร้อมเหตุผล) · partial = กดรหัสทั้งที่ยังรู้ไม่ครบ (หวังพึ่งคนอื่นกดพร้อมกัน)
export function exitActions(game, p, z) {
  const out = [];
  for (const x of exitsIn(game, z.id)) {
    // ทำได้เฉพาะทางออกที่ "คุณ" รู้จัก (คนอื่นในห้องจะรู้ตามเมื่อเห็นคุณลงมือ)
    if (x.open || !knowsExit(p, x)) continue;
    const st = exitStatus(game, x, []);
    const doneN = st.filter((s) => s.done).length;
    const tail = ` · ${x.name} (สำเร็จแล้ว ${doneN}/${st.length})`;
    for (const s of x.steps) {
      if (s.done || (s.kind === 'power' && x.powered) || (s.kind === 'force' && s.progress >= s.needed)) continue;
      const base = { type: 'exit', exitId: x.id, step: s.id, exitName: x.name };
      const verb = s.verb || STEP_VERB[s.kind];
      const icon = STEP_ICON[s.kind] || '🚪';
      switch (s.kind) {
        case 'key': {
          const key = keyOf(p, x);
          const pk = key ? null : pickOf(game, p);
          out.push({ ...base, label: `${icon} ${verb}${tail}`, desc: key ? `ใช้${key.name} (กุญแจยังอยู่กับคุณ) — ทำเสร็จแล้วติดถาวร` : pk ? `ไม่มีกุญแจ แต่สะเดาะด้วย${pk.name}แทนได้ (เครื่องมืออาจพัง 20%) — ทำเสร็จแล้วติดถาวร` : '', disabled: !key && !pk, reason: key || pk ? '' : `ต้องถือ "${itemNamed(x, 'key') || 'กุญแจของทางออกนี้'}" หรือที่สะเดาะกลอน (ช่างเทคนิคใช้เครื่องมือช่างแทนได้)` });
          break;
        }
        case 'code': {
          const k = codeKnownBy(p, x).size;
          const need = codeNeedFor(game, [p]);
          out.push({ ...base, label: `${icon} กดรหัส (รู้รหัสแล้ว ${k}/${need})${tail}`, desc: k >= need ? 'คุณรู้รหัสครบแล้ว — กดแล้วติดถาวร' : `รู้รหัสแค่ ${k}/${need} ส่วน — ถ้าคนที่รู้ส่วนที่เหลือเลือกกดรหัสพร้อมกันในชั่วโมงนี้จะนับรวมกัน (กดไม่ครบ คนห้องอื่นอาจได้ยินสัญญาณเตือน)`, partial: k < need, disabled: k === 0, reason: k === 0 ? `ยังไม่รู้รหัสเลย — หาเศษกระดาษรหัส ${ESCAPE.CODE_NOTES} ชิ้น (หยิบแล้วจำได้ทันที ช่างเทคนิคใช้ ${ESCAPE.CODE_NOTES_TECH})` : '' });
          break;
        }
        case 'assembly': {
          const asm = asmOf(p, x);
          const asmName = x.assembly?.name || 'ชุดชิ้นส่วน';
          out.push({ ...base, label: `${icon} ติดตั้ง${asmName}${tail}`, desc: asm ? `ใช้${asm.name} (หมดไป) — ติดตั้งแล้วติดถาวร` : '', disabled: !asm, reason: asm ? '' : `ต้องถือ "${asmName}" — ประกอบจากชิ้นส่วน 2 ชิ้น หรือ "ดัดแปลง" จากเครื่องมือช่าง + เชือก/ของหนัก/สายไฟ (ในหมวดประกอบ)` });
          break;
        }
        case 'power': {
          const powerZones = [...game.zones.values()].filter((zz) => zz.items.some((i) => i.kind === 'power')).map((zz) => zz.name);
          out.push({ ...base, label: `${icon} ${verb}${tail}`, desc: '', disabled: true, reason: `ทำที่ห้องนี้ไม่ได้ — ถือ "${itemNamed(x, 'fuse') || 'ฟิวส์'}" (หรือสายไฟ/ของนำไฟฟ้าแทน) ไปห้องที่มีแผงไฟ (${powerZones.join(', ') || '?'}) แล้วกด "⚡ ใส่ฟิวส์"` });
          break;
        }
        case 'tool': {
          const t = toolOf(p);
          out.push({ ...base, label: `${icon} ${verb}${tail}`, desc: t ? `ใช้${t.name} (อาจพัง 20%) — ทำเสร็จแล้วติดถาวร` : '', disabled: !t, reason: t ? '' : `ต้องถือ${TOOL_HINT}` });
          break;
        }
        case 'cut': {
          const c = sharpOf(p);
          out.push({ ...base, label: `${icon} ${verb}${tail}`, desc: c ? `ใช้${c.name} (อาจพัง 20%) — ทำเสร็จแล้วติดถาวร` : '', disabled: !c, reason: c ? '' : 'ต้องถือของมีคม (มีด/ขวาน/กรรไกร/คีมตัด)' });
          break;
        }
        case 'force': {
          const h = heavyOf(p);
          out.push({ ...base, label: `${icon} ${verb} (${s.progress}/${s.needed})${tail}`, desc: h ? `ใช้${h.name} ได้ +${forceGain(game, p)} แต้ม (ของอาจพัง 20%) — หลายคนลงแรงพร้อมกันนับรวม แต้มสะสมไม่หาย${s.loud ? ' · เสียงดัง คนห้องอื่นอาจได้ยิน' : ''}` : '', disabled: !h, reason: h ? '' : `ต้องถือ${FORCE_HINT}` });
          break;
        }
        default:
          break;
      }
    }
  }
  // ใส่ฟิวส์ให้ทางออกแบบใช้ไฟ: ทำได้ในห้องที่มีแผงไฟ ถ้าถือฟิวส์อยู่ — หรือใช้สายไฟ/ของนำไฟฟ้าแทนกับทางออกที่รู้จัก
  if (z.items.some((i) => i.kind === 'power')) {
    for (const fuse of p.inventory.filter((i) => i.role === 'fuse' && i.exitId)) {
      const x = game.exits.get(fuse.exitId);
      if (!x || x.powered || x.open) continue;
      out.push({ type: 'exit_power', itemId: fuse.id, exitName: x.name, label: `⚡ ใส่${fuse.name}เข้าแผงไฟที่นี่`, desc: `จ่ายไฟให้ "${x.name}" — ไฟทั้งอาคารจะกะพริบ คนอื่นอาจสังเกตได้` });
    }
    const cable = p.inventory.find((i) => !i.isPart && !i.broken && tagsOf(i).has('conductive'));
    if (cable) {
      for (const x of game.exits.values()) {
        if (x.open || x.powered || !knowsExit(p, x) || !x.steps.some((s) => s.kind === 'power') || p.inventory.some((i) => i.role === 'fuse' && i.exitId === x.id)) continue;
        out.push({ type: 'exit_power', itemId: cable.id, exitId: x.id, exitName: x.name, label: `⚡ ต่อ${cable.name}แทนฟิวส์ให้${x.name}`, desc: `ใช้${cable.name}ต่อแทนฟิวส์ที่หาไม่ได้ (หมดไป) — จ่ายไฟให้ "${x.name}" ไฟทั้งอาคารจะกะพริบ` });
      }
    }
  }
  return out;
}

// ใส่ฟิวส์ หรือต่อสายไฟแทน (ทำทันทีตอนประมวลผลแอ็กชัน) — ขั้นจ่ายไฟติดถาวร
export function doExitPower(game, p, a) {
  const z = game.zones.get(p.zoneId);
  const idx = p.inventory.findIndex((i) => i.id === a.itemId && (i.role === 'fuse' || tagsOf(i).has('conductive')));
  const it = idx >= 0 ? p.inventory[idx] : null;
  const x = it ? game.exits.get(it.role === 'fuse' ? it.exitId : a.exitId) : null;
  if (!x || x.powered || x.open || !z.items.some((i) => i.kind === 'power') || (it.role !== 'fuse' && (!knowsExit(p, x) || !x.steps.some((s) => s.kind === 'power')))) return game.logTo(p, 'ใส่ฟิวส์ไม่ได้ที่นี่', 'danger');
  const fuse = p.inventory.splice(idx, 1)[0];
  x.powered = true;
  const ps = x.steps.find((s) => s.kind === 'power');
  if (ps) ps.done = true;
  if (!knowsExit(p, x)) discoverExit(game, p, x, 'เมื่อไฟเข้า คุณได้ยินเสียงกลไกและรู้ทันทีว่าทางออกอยู่ที่ไหน');
  const how = fuse.role === 'fuse' ? `ใส่${fuse.name}` : `ต่อ${fuse.name}แทนฟิวส์`;
  game.logTo(p, `⚡ คุณ${how}เข้าแผงไฟที่${game.zn(z)}— ไฟกะพริบทั้งอาคาร "${x.name}" ที่${game.zn(x.zoneId)}มีไฟแล้ว (ผ่านไปอีกขั้น)`, 'escape');
  for (const o of game.alivePlayers()) if (o.id !== p.id && !o.ko) game.logTo(o, `💡 ไฟทั้งอาคารกะพริบวูบหนึ่ง แล้วมีเสียงเครื่องจักรครางดังมาจากทาง${game.zn(x.zoneId)}— มีคนทำอะไรกับระบบไฟ`, 'witness');
  game.recordEvent(`${game.nick(p)}${how}จ่ายไฟให้ "${x.name}"`);
}

// ประมวลผลคนที่เลือกทำอะไรกับทางออกในชั่วโมงนี้ — แต่ละคนทำเฉพาะขั้นที่เลือก (ไม่ระบุขั้น = ทุกขั้นที่ทำได้) · คนที่เลือกขั้นเดียวกันนับของ/แรงรวมกัน · ทำสำเร็จแล้วติดถาวร · คืน true ถ้าเกมจบด้วยการหนี
export function resolveExits(game, attempts) {
  const byExit = new Map();
  for (const { p, a } of attempts) {
    if (!p.alive || p.ko) continue;
    const x = game.exits.get(a.exitId);
    if (!x || x.open || p.zoneId !== x.zoneId || p.outside) continue;
    if (!byExit.has(x.id)) byExit.set(x.id, []);
    byExit.get(x.id).push({ p, step: a.step || null });
  }
  for (const [xid, group] of byExit) {
    const x = game.exits.get(xid);
    const people = group.map((g) => g.p);
    for (const p of people) if (!knowsExit(p, x)) discoverExit(game, p, x, 'คนในห้องชี้ให้คุณดู');
    const names = people.map((p) => game.nick(p)).join(', ');
    const progressed = [];
    let codeShort = null;
    for (const s of x.steps) {
      if (s.done) continue;
      const crew = group.filter((g) => !g.step || g.step === s.id).map((g) => g.p);
      if (!crew.length) continue;
      const verb = s.verb || STEP_VERB[s.kind];
      switch (s.kind) {
        case 'tool':
          if (crew.some(holdsTool)) {
            s.done = true;
            progressed.push(verb);
            for (const p of crew.filter(holdsTool)) game.breakItemMaybe(p, toolOf(p), DURABILITY.BREAK_ON_EXIT, 'ถอด/เปิดทางออก');
          }
          break;
        case 'cut':
          if (crew.some(holdsSharp)) {
            s.done = true;
            progressed.push(verb);
            for (const p of crew.filter(holdsSharp)) game.breakItemMaybe(p, sharpOf(p), DURABILITY.BREAK_ON_EXIT, 'ตัดทางออก');
          }
          break;
        case 'force': {
          let gain = 0;
          for (const p of crew) if (holdsHeavy(p)) gain += forceGain(game, p);
          if (gain) {
            s.progress = Math.min(s.needed, s.progress + gain);
            x.progress = s.progress;
            progressed.push(`${verb} +${gain} (${s.progress}/${s.needed})`);
            if (s.loud) for (const o of game.alivePlayers()) if (!people.includes(o) && !o.ko && chance(ESCAPE.BREACH_NOISE_CHANCE)) game.logTo(o, `🔊 ได้ยินเสียงโลหะกระแทกดังสนั่นมาจากทาง${game.zn(x.zoneId)}เหมือนมีคนทุบหรืองัดอะไรบางอย่าง`, 'witness');
            for (const p of crew) if (holdsHeavy(p)) game.breakItemMaybe(p, heavyOf(p), DURABILITY.BREAK_ON_EXIT, 'งัด/ทุบทางออก');
          }
          if (s.progress >= s.needed) s.done = true;
          break;
        }
        case 'key': {
          const kp = crew.find((p) => keyOf(p, x));
          if (kp) {
            s.done = true;
            progressed.push(`${verb} (${keyOf(kp, x).name})`);
          } else {
            const pp = crew.find((p) => pickOf(game, p));
            if (pp) {
              const tool = pickOf(game, pp);
              s.done = true;
              progressed.push(`สะเดาะแทนกุญแจด้วย${tool.name}`);
              game.breakItemMaybe(pp, tool, DURABILITY.BREAK_ON_EXIT, 'สะเดาะทางออก');
            }
          }
          break;
        }
        case 'code': {
          const known = codeKnownByAll(crew, x);
          const need = codeNeedFor(game, crew);
          if (known.size >= need) {
            s.done = true;
            progressed.push(`กดรหัสถูก (${known.size}/${need})`);
          } else {
            codeShort = `${known.size}/${need}`;
            for (const o of game.alivePlayers()) if (o.zoneId !== x.zoneId && !o.ko && chance(0.4)) game.logTo(o, `🔊 ได้ยินเสียงสัญญาณเตือนสั้น ๆ ดังมาจากทาง${game.zn(x.zoneId)}`, 'witness');
          }
          break;
        }
        case 'assembly': {
          const ap = crew.find((p) => asmOf(p, x));
          if (ap) {
            const asm = asmOf(ap, x);
            ap.inventory.splice(ap.inventory.indexOf(asm), 1);
            s.done = true;
            progressed.push(`ติดตั้ง${asm.name}`);
          }
          break;
        }
        default:
          break;
      }
    }
    const st = exitStatus(game, x, []);
    const missing = st.filter((s) => !s.done);
    if (!missing.length) {
      x.open = true;
      x.openedBy = people.map((p) => p.id);
      // ฆาตกรที่ยังไม่ถูกจับ (เป็นคนร้ายของคดีที่ยังไม่ได้ตัดสิน) ออกไปไม่ได้ — ที่นี่ปิดประตูใส่และนับว่าตายทันที
      const shutIn = game.alivePlayers().filter((p) => game.cases.some((c) => c.killerId === p.id && !c.judged));
      for (const k of shutIn) {
        k.alive = false;
        k.fate = 'left_behind';
        k.deathCause = 'left_behind';
        k.eliminatedDay = game.day;
        k.eliminatedHour = game.hour;
        const kz = game.zones.get(k.zoneId);
        for (const it of k.inventory) {
          it.hidden = false;
          kz?.items.push(it);
        }
        k.inventory = [];
        const kc = game.charOf(k);
        if (kc) kc.ultimateRevealed = true;
        game.logTo(k, `⛓ ${x.name}เปิดออก แต่ทันทีที่คุณจะก้าวตามคนอื่นไป ประตูก็ปิดใส่หน้าคุณ — ที่นี่ไม่ปล่อยคนที่มีเลือดติดมือออกไป คุณถูกทิ้งไว้ข้างใน...`, 'death');
      }
      const shutNames = shutIn.map((p) => game.nick(p)).join(', ');
      for (const p of people) if (p.alive) game.logTo(p, `🚪 ${x.name}เปิดออก! แสงจากข้างนอกสาดเข้ามา — ทุกคนที่ยังมีชีวิตหนีออกจากที่นี่ได้แล้ว`, 'escape');
      game.systemMessage(`🚪 ${names} เปิด "${x.name}" ที่${game.zoneName(x.zoneId)}ได้สำเร็จ! ${game.alivePlayers().length ? `ทุกคนที่ยังมีชีวิตหนีออกจาก "${game.location.name}" ได้` : 'แต่ไม่เหลือใครที่ออกไปได้'}${shutIn.length ? ` · ⛓ ${shutNames} เป็นฆาตกรที่ยังไม่ถูกจับ ประตูจึงปิดใส่หน้าและถูกทิ้งไว้ข้างใน — นับว่าตายทันที` : ''}`);
      if (shutIn.length) game.recordEvent(`${shutNames} ถูกทิ้งไว้ข้างในตอนทางออกเปิด (ฆาตกรที่ยังไม่ถูกจับ)`);
      game.recordEvent(`${names} เปิดทางออก "${x.name}" สำเร็จ`);
      game.endGame('escape');
      return true;
    }
    const doneN = st.length - missing.length;
    const failText = `สำเร็จแล้ว ${doneN}/${st.length} ขั้น${progressed.length ? ` · ทำชั่วโมงนี้: ${progressed.join(', ')}` : ''}${codeShort ? ` · รหัสยังไม่ครบ (${codeShort})` : ''} · ยังขาด: ${missing.map((s) => s.label).join(' · ')}`;
    for (const p of people) game.logTo(p, `🚪 ${x.name}ที่${game.zn(x.zoneId)}: ${failText}`, 'escape');
    for (const o of game.awakeIn(x.zoneId)) {
      if (people.includes(o)) continue;
      game.logTo(o, `👀 คุณเห็น${names}ยุ่งอยู่กับ${x.name} เหมือนพยายามเปิดทางออก`, 'witness');
      discoverExit(game, o, x, `คุณเห็น${names}พยายามเปิดมัน`);
    }
    game.recordEvent(`${names} ลงมือกับทางออก "${x.name}" (${failText})`);
  }
  return false;
}

export function exitView(game, p, x) {
  const st = exitStatus(game, x, []); // ขั้นที่ทำสำเร็จจริง (ติดถาวร)
  const ready = p ? exitStatus(game, x, [p]) : st; // ขั้นที่คนนี้ทำได้ตอนนี้ (ถือของพอ)
  const known = p ? codeKnownBy(p, x) : new Set();
  return {
    id: x.id,
    zoneId: x.zoneId,
    zoneName: game.zoneName(x.zoneId),
    name: x.name,
    description: x.description,
    route: x.route,
    routeLabel: routeLabel(x.route),
    requirement: requirementText(game, x),
    steps: st.map((s, i) => ({ kind: s.kind, label: s.label, done: s.done, ready: !s.done && !!ready[i]?.done, progress: s.progress, needed: s.needed })),
    stepsDone: st.filter((s) => s.done).length,
    codeKnown: x.steps.some((s) => s.kind === 'code') ? known.size : 0,
    codeNeed: x.steps.some((s) => s.kind === 'code') ? (p ? codeNeedFor(game, [p]) : ESCAPE.CODE_NOTES) : 0,
    assemblyHeld: !!(p && asmOf(p, x)),
    // ไม่ส่ง id ของของที่ซ่อนอยู่ให้ client (รู้แค่ชื่อและว่าถืออยู่/จำได้ไหม)
    items: x.items.map((i) => ({ name: i.name, role: i.role, assembled: !!i.assembled, held: p ? p.inventory.some((h) => h.id === i.id) : false, known: i.role === 'code' && known.has(i.id) })),
    progress: x.progress,
    progressNeeded: x.progressNeeded,
    powered: x.powered,
    open: x.open,
  };
}
