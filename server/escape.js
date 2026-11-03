// ระบบทางออก — ทางออก 2 ทางต่อเกม ซ่อนอยู่ในห้องธรรมดา (ไม่มีใครรู้ว่าอยู่ไหนจนกว่าจะ "สำรวจ" เจอ หรือเจอแผนผัง)
// แต่ละทางมี "เส้นทาง" (route) และ "ขั้นตอน" (steps) 4 ข้อที่ต้องผ่านให้ครบถึงจะเปิดได้ (เส้นทางซ่อม = 5 เพราะต้องประกอบชิ้นส่วนก่อน):
//   key = ถือกุญแจของทางออก · code = รวบรวมเศษรหัส · assembly = ประกอบชิ้นส่วน 2 ชิ้นเป็นชุดเดียว (แอ็กชันประกอบ) แล้วถือมา
//   power = เอาฟิวส์ไปใส่แผงไฟก่อน · tool = เครื่องมือช่าง (ถอดน็อต/เปิดฝา ทำครั้งเดียวติดถาวร) · cut = ของมีคม (ตัดโซ่/สายเคเบิล ครั้งเดียว)
//   force = ลงแรงสะสม (ของหนักหรืออาวุธมีคม นักสู้/ช่างเทคนิค 2 แต้มต่อครั้ง)
// ของที่ต้องใช้ถูกซ่อนตามห้องต่าง ๆ · ความรู้ว่าทางออกอยู่ไหนเป็นของแต่ละคน (discoveredBy) ส่วนความคืบหน้า (steps/powered/open) เป็นของจริงที่ทุกคนใช้ร่วมกัน
import { ESCAPE, ROUTES, tagsOf, canBreachWith } from './rules.js';

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
      return `${s.verb || 'ไขกุญแจ'}ด้วย "${itemNamed(exit, 'key') || 'กุญแจของทางออกนี้'}"`;
    case 'code':
      return `กดรหัส: รวบรวมเศษกระดาษรหัสทั้ง ${ESCAPE.CODE_NOTES} ชิ้นมาพร้อมกัน (คนที่อยู่ในห้องนี้และเลือกลงมือพร้อมกันนับของรวมกัน · ช่างเทคนิคใช้ ${ESCAPE.CODE_NOTES_TECH})`;
    case 'assembly': {
      const parts = exit.items.filter((i) => i.role === 'part').map((i) => i.name);
      return `ประกอบ "${exit.assembly?.name || 'ชุดชิ้นส่วน'}" จาก ${parts.join(' + ')} (ถือครบทั้งสองแล้วเลือก "ประกอบ" ใช้ 1 ชั่วโมง) แล้วถือมาด้วย`;
    }
    case 'power': {
      const powerZones = [...game.zones.values()].filter((z) => z.items.some((i) => i.kind === 'power')).map((z) => z.name);
      return exit.powered ? 'มีไฟแล้ว' : `จ่ายไฟ: เอา "${itemNamed(exit, 'fuse') || 'ฟิวส์'}" ไปใส่แผงไฟ (ห้องที่มีแผงไฟ: ${powerZones.join(', ') || '?'}) ก่อน`;
    }
    case 'tool':
      return `${s.verb || 'ถอดน็อต/เปิดฝา'}ด้วย${TOOL_HINT}`;
    case 'cut':
      return `${s.verb || 'ตัดโซ่/สายเคเบิล'}ด้วยของมีคม`;
    case 'force':
      return `${s.verb || 'งัด/ทุบ'} ลงแรงรวม ${s.needed} แต้ม (${FORCE_HINT}${s.loud ? ' · เสียงดัง คนห้องอื่นอาจได้ยิน' : ''})`;
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
    const partHint = item.role === 'part' && x.assembly ? ` (ต้องประกอบกับอีกชิ้นเป็น "${x.assembly.name}" ก่อนใช้)` : '';
    game.logTo(p, knowsExit(p, x) ? `⭐ ${item.name}ใช้กับทางออก "${x.name}" ที่${game.zn(x.zoneId)}${partHint}` : `⭐ ${item.name}ดูเป็นของสำคัญสำหรับทางออก "${x.name}"${partHint} — แต่คุณยังไม่รู้ว่าทางออกนี้อยู่ตรงไหน`, 'escape');
  }
}

const holdsHeavy = (p) => p.inventory.some(canBreachWith); // ของหนักหรืออาวุธมีคม (ดูแท็ก) — ไขควง สมุด ไฟฉาย ใช้ทุบไม่ได้
const holdsSharp = (p) => p.inventory.some((i) => tagsOf(i).has('sharp'));
const holdsTool = (p) => p.inventory.some((i) => tagsOf(i).has('fastener'));

// สถานะแต่ละขั้นตอนเมื่อกลุ่ม people (คนที่ลงมือพร้อมกันในห้อง) ลองเปิด — ไม่เปลี่ยนสถานะจริง (ใช้แสดงผล/ตัดสินใจ)
// people ว่าง = ดูเฉพาะสถานะถาวร (ขั้นที่ทำไปแล้ว)
export function exitStatus(game, exit, people = []) {
  const held = new Map();
  for (const p of people) for (const it of p.inventory) if (it.exitId === exit.id) held.set(it.id, it);
  return exit.steps.map((s) => {
    let done = false;
    switch (s.kind) {
      case 'key':
        done = [...held.values()].some((i) => i.role === 'key');
        break;
      case 'code': {
        const notes = [...held.values()].filter((i) => i.role === 'code').length;
        const need = people.some((p) => game.traitOf(p) === 'tech') ? ESCAPE.CODE_NOTES_TECH : ESCAPE.CODE_NOTES;
        done = notes >= need;
        break;
      }
      case 'assembly':
        done = [...held.values()].some((i) => i.role === 'assembly');
        break;
      case 'power':
        done = !!exit.powered;
        break;
      case 'tool':
        done = s.done || people.some(holdsTool);
        break;
      case 'cut':
        done = s.done || people.some(holdsSharp);
        break;
      case 'force':
        done = s.progress >= s.needed;
        break;
      default:
        break;
    }
    return { id: s.id, kind: s.kind, label: stepLabel(game, exit, s), done, progress: s.progress || 0, needed: s.needed || 0, persistent: ['tool', 'cut', 'force', 'power'].includes(s.kind) };
  });
}

// ผู้เล่นคนเดียวพร้อมเปิดทางออกนี้ไหม (ถือของครบ และทำขั้นถาวรที่เหลือได้เอง) — ใช้ให้บอท/ตัวจำลองตัดสินใจ
export function exitReadyFor(game, p, exit) {
  if (!exit || exit.open) return false;
  return exitStatus(game, exit, [p]).every((s) => s.done || (s.kind === 'force' && holdsHeavy(p)));
}

// ผู้เล่นคนนี้ไปลงมือแล้วมีอะไรคืบหน้าไหม: พร้อมเปิดเลย หรือทำขั้นถาวรที่ยังไม่เสร็จได้ (ถอดน็อต ตัด ลงแรง) — ใช้ให้บอท/ตัวจำลองตัดสินใจไปที่ทางออก
export function exitUsefulFor(game, p, exit) {
  if (!exit || exit.open) return false;
  if (exitReadyFor(game, p, exit)) return true;
  return exit.steps.some((s) => (s.kind === 'tool' && !s.done && holdsTool(p)) || (s.kind === 'cut' && !s.done && holdsSharp(p)) || (s.kind === 'force' && s.progress < s.needed && holdsHeavy(p)));
}

// ตัวเลือก "ประกอบชิ้นส่วนทางออก" เมื่อถือชิ้นส่วนครบทั้งสองชิ้น (ปรากฏใน craftOptions ของ game.js)
export function craftAssemblyOptions(game, p) {
  const out = [];
  for (const x of game.exits.values()) {
    if (!x.assembly || x.open) continue;
    const parts = x.assembly.partIds.map((id) => p.inventory.find((i) => i.id === id)).filter(Boolean);
    if (parts.length !== x.assembly.partIds.length) continue;
    // ไม่ใส่ exitId ในแอ็กชัน (คนที่ยังไม่รู้จักทางออกต้องไม่เห็น id ของมัน) — ตอนประกอบหาทางออกจาก id ของชิ้นส่วนแทน
    out.push({ type: 'craft', recipeId: 'assembly', itemId: parts[0].id, itemId2: parts[1].id, label: `🛠 ประกอบ "${x.assembly.name}" จาก ${parts.map((i) => i.name).join(' + ')}`, desc: `ชิ้นส่วนของทางออก "${x.name}" — ใช้เวลา 1 ชั่วโมง ได้ชุดชิ้นส่วนที่ประกอบแล้ว 1 ชิ้น (ขั้นตอนหนึ่งของการเปิดทางออกนี้)` });
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
  game.logTo(p, `🛠 คุณประกอบ "${asm.name}" เสร็จแล้ว — เอาไปใช้ที่ "${x.name}"${knowsExit(p, x) ? ` ที่${game.zn(x.zoneId)}` : ' (ยังไม่รู้ว่าอยู่ห้องไหน)'}`, 'escape');
  for (const o of game.witnessesOf(p, z)) if (game.seen(p, 0.4)) game.logTo(o, `👀 คุณเห็น${who}นั่งประกอบชิ้นส่วนอะไรบางอย่างอยู่ตรงมุมห้อง${game.zn(z)}`, 'witness');
  game.recordEvent(`${game.nick(p)}ประกอบ "${asm.name}" ที่${game.zn(z)}`);
}

// แอ็กชันเกี่ยวกับทางออกที่ผู้เล่นทำได้ในห้องนี้
export function exitActions(game, p, z) {
  const out = [];
  for (const x of exitsIn(game, z.id)) {
    // ทำได้เฉพาะทางออกที่ "คุณ" รู้จัก (คนอื่นในห้องจะรู้ตามเมื่อเห็นคุณลงมือ)
    if (x.open || !knowsExit(p, x)) continue;
    const st = exitStatus(game, x, [p]);
    const done = st.filter((s) => s.done).length;
    const missing = st.filter((s) => !s.done).map((s) => s.label);
    out.push({
      type: 'exit',
      exitId: x.id,
      exitName: x.name,
      label: `🚪 ลงมือเปิด${x.name} (${done}/${st.length} ขั้น)`,
      desc: missing.length ? `ยังขาด: ${missing.join(' · ')} — คนที่เลือกลงมือพร้อมกันในห้องนี้นับของรวมกัน ขั้นที่ทำได้จะถูกทำในชั่วโมงนี้ (ถอดน็อต ตัด ลงแรง ติดถาวร)` : 'ครบทุกขั้นแล้ว — ถ้าเปิดได้ ทุกคนที่ยังมีชีวิตจะหนีออกไปได้ (ฆาตกรที่ยังไม่ถูกจับถูกทิ้งไว้)',
    });
  }
  // ใส่ฟิวส์ให้ทางออกแบบใช้ไฟ: ทำได้ในห้องที่มีแผงไฟ ถ้าถือฟิวส์อยู่
  if (z.items.some((i) => i.kind === 'power')) {
    for (const fuse of p.inventory.filter((i) => i.role === 'fuse' && i.exitId)) {
      const x = game.exits.get(fuse.exitId);
      if (!x || x.powered || x.open) continue;
      out.push({ type: 'exit_power', itemId: fuse.id, exitName: x.name, label: `⚡ ใส่${fuse.name}เข้าแผงไฟที่นี่`, desc: `จ่ายไฟให้ "${x.name}" — ไฟทั้งอาคารจะกะพริบ คนอื่นอาจสังเกตได้` });
    }
  }
  return out;
}

// ใส่ฟิวส์ (ทำทันทีตอนประมวลผลแอ็กชัน)
export function doExitPower(game, p, a) {
  const z = game.zones.get(p.zoneId);
  const idx = p.inventory.findIndex((i) => i.id === a.itemId && i.role === 'fuse');
  const x = idx >= 0 ? game.exits.get(p.inventory[idx].exitId) : null;
  if (!x || x.powered || !z.items.some((i) => i.kind === 'power')) return game.logTo(p, 'ใส่ฟิวส์ไม่ได้ที่นี่', 'danger');
  const fuse = p.inventory.splice(idx, 1)[0];
  x.powered = true;
  if (!knowsExit(p, x)) discoverExit(game, p, x, 'เมื่อไฟเข้า คุณได้ยินเสียงกลไกและรู้ทันทีว่าทางออกอยู่ที่ไหน');
  game.logTo(p, `⚡ คุณใส่${fuse.name}เข้าแผงไฟที่${game.zn(z)}— ไฟกะพริบทั้งอาคาร "${x.name}" ที่${game.zn(x.zoneId)}มีไฟแล้ว (ผ่านไปอีกขั้น)`, 'escape');
  for (const o of game.alivePlayers()) if (o.id !== p.id && !o.ko) game.logTo(o, `💡 ไฟทั้งอาคารกะพริบวูบหนึ่ง แล้วมีเสียงเครื่องจักรครางดังมาจากทาง${game.zn(x.zoneId)}— มีคนทำอะไรกับระบบไฟ`, 'witness');
  game.recordEvent(`${game.nick(p)}ใส่${fuse.name}จ่ายไฟให้ "${x.name}"`);
}

// ประมวลผลคนที่เลือกทำอะไรกับทางออกในชั่วโมงนี้ (รวมของกัน) — ขั้นถาวรที่ทำได้จะติดไว้ · คืน true ถ้าเกมจบด้วยการหนี
export function resolveExits(game, attempts) {
  const byExit = new Map();
  for (const { p, a } of attempts) {
    if (!p.alive || p.ko) continue;
    const x = game.exits.get(a.exitId);
    if (!x || x.open || p.zoneId !== x.zoneId || p.outside) continue;
    if (!byExit.has(x.id)) byExit.set(x.id, []);
    byExit.get(x.id).push(p);
  }
  for (const [xid, people] of byExit) {
    const x = game.exits.get(xid);
    for (const p of people) if (!knowsExit(p, x)) discoverExit(game, p, x, 'คนในห้องชี้ให้คุณดู');
    const names = people.map((p) => game.nick(p)).join(', ');
    const progressed = [];
    // ขั้นถาวร: ทำได้ก็ติดไว้เลย
    for (const s of x.steps) {
      if (s.kind === 'tool' && !s.done && people.some(holdsTool)) {
        s.done = true;
        progressed.push(stepLabel(game, x, s));
      }
      if (s.kind === 'cut' && !s.done && people.some(holdsSharp)) {
        s.done = true;
        progressed.push(stepLabel(game, x, s));
      }
      if (s.kind === 'force' && s.progress < s.needed) {
        let gain = 0;
        for (const p of people) if (holdsHeavy(p)) gain += ['combat', 'tech'].includes(game.traitOf(p)) ? 2 : 1;
        if (gain) {
          s.progress = Math.min(s.needed, s.progress + gain);
          x.progress = s.progress;
          progressed.push(`${s.verb || 'ลงแรง'} +${gain} (${s.progress}/${s.needed})`);
          if (s.loud) for (const o of game.alivePlayers()) if (!people.includes(o) && !o.ko && chance(ESCAPE.BREACH_NOISE_CHANCE)) game.logTo(o, `🔊 ได้ยินเสียงโลหะกระแทกดังสนั่นมาจากทาง${game.zn(x.zoneId)}เหมือนมีคนทุบหรืองัดอะไรบางอย่าง`, 'witness');
        }
        if (s.progress >= s.needed) s.done = true;
      }
    }
    const st = exitStatus(game, x, people);
    const missing = st.filter((s) => !s.done);
    const codeStep = st.find((s) => s.kind === 'code');
    if (codeStep && !codeStep.done && people.some((p) => p.inventory.some((i) => i.exitId === x.id && i.role === 'code'))) {
      for (const o of game.alivePlayers()) if (o.zoneId !== x.zoneId && !o.ko && chance(0.4)) game.logTo(o, `🔊 ได้ยินเสียงสัญญาณเตือนสั้น ๆ ดังมาจากทาง${game.zn(x.zoneId)}`, 'witness');
    }
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
    const failText = `${progressed.length ? `ทำไปแล้ว: ${progressed.join(', ')} · ` : ''}ยังขาด: ${missing.map((s) => s.label).join(' · ')}`;
    for (const p of people) game.logTo(p, `🚪 พยายามเปิด${x.name}ที่${game.zn(x.zoneId)}แต่ยังไม่สำเร็จ (${st.filter((s) => s.done).length}/${st.length} ขั้น) — ${failText}`, 'escape');
    for (const o of game.awakeIn(x.zoneId)) {
      if (people.includes(o)) continue;
      game.logTo(o, `👀 คุณเห็น${names}ยุ่งอยู่กับ${x.name} เหมือนพยายามเปิดทางออก`, 'witness');
      discoverExit(game, o, x, `คุณเห็น${names}พยายามเปิดมัน`);
    }
    game.recordEvent(`${names} พยายามเปิดทางออก "${x.name}" (${failText})`);
  }
  return false;
}

export function exitView(game, p, x) {
  const st = exitStatus(game, x, p ? [p] : []);
  return {
    id: x.id,
    zoneId: x.zoneId,
    zoneName: game.zoneName(x.zoneId),
    name: x.name,
    description: x.description,
    route: x.route,
    routeLabel: routeLabel(x.route),
    requirement: requirementText(game, x),
    steps: st.map((s) => ({ kind: s.kind, label: s.label, done: s.done, progress: s.progress, needed: s.needed })),
    stepsDone: st.filter((s) => s.done).length,
    // ไม่ส่ง id ของของที่ซ่อนอยู่ให้ client (รู้แค่ชื่อและว่าถืออยู่ไหม)
    items: x.items.map((i) => ({ name: i.name, role: i.role, assembled: !!i.assembled, held: p ? p.inventory.some((h) => h.id === i.id) : false })),
    progress: x.progress,
    progressNeeded: x.progressNeeded,
    powered: x.powered,
    open: x.open,
  };
}
