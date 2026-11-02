// ระบบทางออก — ทางออก 2 ทางต่อเกม ซ่อนอยู่ในห้องธรรมดา (ไม่มีใครรู้ว่าอยู่ไหนจนกว่าจะ "สำรวจ" เจอ หรือเจอแผนผัง)
// แต่ละทางมี "เส้นทาง" (route) ต่างกัน: ประตูล็อก / แป้นรหัส / ซ่อมเครื่อง / ประตูไฟฟ้า / ทุบงัด — ของที่ต้องใช้ถูกซ่อนตามห้องต่าง ๆ
// ความรู้ว่าทางออกอยู่ไหนเป็นของแต่ละคน (discoveredBy) ส่วนความคืบหน้าของตัวประตู (powered/progress/open) เป็นของจริงที่ทุกคนใช้ร่วมกัน
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

export function routeLabel(route) {
  return ROUTES[route]?.label || route;
}

// ข้อความบอกว่าต้องใช้อะไร (เจาะจงชื่อของจริง)
export function requirementText(game, exit) {
  const names = exit.items.map((i) => i.name);
  switch (exit.route) {
    case 'locked':
      return `ต้องใช้ "${names[0]}" มาไข`;
    case 'code':
      return `ต้องรวบรวม${names.length ? `เศษกระดาษรหัสทั้ง ${names.length} ชิ้น (${names.join(', ')})` : 'เศษรหัสให้ครบ'} — คนที่อยู่ในห้องนี้และเลือก "กดรหัส" พร้อมกันจะนับรวมกัน (ช่างเทคนิคใช้แค่ ${ESCAPE.CODE_NOTES_TECH} ชิ้น)`;
    case 'repair':
      return `ต้องมี ${names.join(' และ ')} ครบ (นับรวมของคนที่เลือก "ซ่อม" พร้อมกันในห้องนี้) และมีเครื่องมือสักชิ้นในมือ`;
    case 'power': {
      const powerZones = [...game.zones.values()].filter((z) => z.items.some((i) => i.kind === 'power')).map((z) => z.name);
      return exit.powered ? 'มีไฟแล้ว — เปิดได้เลย' : `ไม่มีไฟ: ต้องเอา "${names[0]}" ไปใส่ที่แผงไฟ (ห้องที่มีแผงไฟ: ${powerZones.join(', ') || '?'}) ก่อน แล้วค่อยกลับมาเปิด`;
    }
    case 'breach':
      return `ต้องถืออาวุธหนักหรือเครื่องมือแล้วลงแรง ${exit.progressNeeded} ครั้ง (ตอนนี้ ${exit.progress}/${exit.progressNeeded}) นักสู้/ช่างเทคนิคนับ 2 ต่อครั้ง · เสียงดัง คนห้องอื่นอาจได้ยิน`;
    default:
      return ROUTES[exit.route]?.needs || '';
  }
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
    const exit = {
      id,
      zoneId: zone.id,
      name: t.name,
      description: t.description || '',
      route: t.route,
      items: [],
      powered: false,
      progress: 0,
      progressNeeded: ESCAPE.BREACH_PROGRESS,
      open: false,
      openedBy: [],
      discoveredBy: new Set(),
      clueItemId: null,
    };
    const names = t.itemNames || [];
    const specs = [];
    if (t.route === 'locked') specs.push({ role: 'key', kind: 'key', name: names[0] || `กุญแจ${t.name}`, description: `กุญแจที่น่าจะใช้ไข${t.name}` });
    if (t.route === 'code') for (let i = 1; i <= ESCAPE.CODE_NOTES; i++) specs.push({ role: 'code', kind: 'part', name: `เศษกระดาษรหัสชิ้นที่ ${i} (${t.name})`, description: `เศษกระดาษเขียนตัวเลขหนึ่งหลักและคำว่า "${t.name}"` });
    if (t.route === 'repair') {
      const n = names.length >= 2 ? names.slice(0, 2) : [names[0] || `ชิ้นส่วนที่หายไปของ${t.name}`, `ชิ้นส่วนสำคัญของ${t.name}`];
      for (const nm of n) specs.push({ role: 'part', kind: 'part', name: nm, description: `ชิ้นส่วนที่ถูกถอดออกจาก${t.name}` });
    }
    if (t.route === 'power') specs.push({ role: 'fuse', kind: 'part', name: names[0] || `ฟิวส์ของ${t.name}`, description: `ฟิวส์ที่ถูกถอดออก ถ้าใส่เข้าแผงไฟ ${t.name}น่าจะมีไฟ` });
    const hideZones = shuffle(explore.filter((z) => z.id !== zone.id));
    // กุญแจของประตูทางออก ถ้ามีห้องที่ล็อกอยู่ให้ซ่อนไว้ในนั้น (ต้องหากุญแจห้องก่อนถึงจะได้กุญแจทางออก)
    const lockedZones = shuffle(explore.filter((z) => z.locked && z.id !== zone.id));
    specs.forEach((s, i) => {
      const hz = (s.role === 'key' && lockedZones[0]) || hideZones[i % hideZones.length] || zone;
      const item = { id: `${id}_${s.role}${i + 1}`, name: s.name, description: s.description, kind: s.kind, portable: true, hidden: true, isPart: true, exitId: id, role: s.role, originZoneId: hz.id };
      hz.items.push(item);
      exit.items.push({ id: item.id, name: item.name, role: s.role });
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
  game.logTo(p, `🚪 ${how}: ทางออก "${exit.name}" อยู่ที่${where}— ${exit.description} · ${routeLabel(exit.route)}: ${requirementText(game, exit)}`, 'escape');
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
    game.logTo(p, knowsExit(p, x) ? `⭐ ${item.name}ใช้กับทางออก "${x.name}" ที่${game.zn(x.zoneId)}` : `⭐ ${item.name}ดูเป็นของสำคัญสำหรับทางออก "${x.name}" — แต่คุณยังไม่รู้ว่าทางออกนี้อยู่ตรงไหน`, 'escape');
  }
}

const holdsHeavy = (p) => p.inventory.some(canBreachWith); // ของหนักหรืออาวุธมีคม (ดูแท็ก) — ไขควง สมุด ไฟฉาย ใช้ทุบไม่ได้

// แอ็กชันเกี่ยวกับทางออกที่ผู้เล่นทำได้ในห้องนี้
export function exitActions(game, p, z) {
  const out = [];
  for (const x of exitsIn(game, z.id)) {
    // ทำได้เฉพาะทางออกที่ "คุณ" รู้จัก (คนอื่นในห้องจะรู้ตามเมื่อเห็นคุณลงมือ)
    if (x.open || !knowsExit(p, x)) continue;
    const base = { type: 'exit', exitId: x.id, exitName: x.name };
    const req = requirementText(game, x);
    switch (x.route) {
      case 'locked': {
        const key = p.inventory.find((i) => i.exitId === x.id && i.role === 'key');
        out.push({ ...base, label: `🚪 ไข${x.name}${key ? `ด้วย${key.name}` : ''}`, desc: key ? 'ถ้าไขได้ ทุกคนที่ยังมีชีวิตจะหนีออกไปได้ทันที' : req, disabled: !key, reason: key ? '' : req });
        break;
      }
      case 'code':
        out.push({ ...base, label: `🔢 กดรหัสที่${x.name}`, desc: `${req} · ถ้ารหัสครบ ทุกคนที่ยังมีชีวิตจะหนีออกไปได้` });
        break;
      case 'repair':
        out.push({ ...base, label: `🔧 ซ่อม${x.name}แล้วลองใช้งาน`, desc: `${req} · ถ้าสำเร็จ ทุกคนที่ยังมีชีวิตจะหนีออกไปได้` });
        break;
      case 'power':
        out.push({ ...base, label: `🚪 เปิด${x.name}${x.powered ? '' : ' (ยังไม่มีไฟ)'}`, desc: x.powered ? 'มีไฟแล้ว ถ้าเปิดได้ ทุกคนที่ยังมีชีวิตจะหนีออกไปได้' : req, disabled: !x.powered, reason: x.powered ? '' : req });
        break;
      case 'breach': {
        const ok = holdsHeavy(p);
        out.push({ ...base, label: `🔨 ทุบ/งัด${x.name} (${x.progress}/${x.progressNeeded})`, desc: req, disabled: !ok, reason: ok ? '' : 'ต้องถือของหนักหรืออาวุธมีคม' });
        break;
      }
      default:
        break;
    }
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
  game.logTo(p, `⚡ คุณใส่${fuse.name}เข้าแผงไฟที่${game.zn(z)}— ไฟกะพริบทั้งอาคาร "${x.name}" ที่${game.zn(x.zoneId)}มีไฟแล้ว ไปเปิดได้เลย`, 'escape');
  for (const o of game.alivePlayers()) if (o.id !== p.id) game.logTo(o, `💡 ไฟทั้งอาคารกะพริบวูบหนึ่ง แล้วมีเสียงเครื่องจักรครางดังมาจากทาง${game.zn(x.zoneId)}— มีคนทำอะไรกับระบบไฟ`, 'witness');
  game.recordEvent(`${game.nick(p)}ใส่${fuse.name}จ่ายไฟให้ "${x.name}"`);
}

// ประมวลผลคนที่เลือกทำอะไรกับทางออกในชั่วโมงนี้ (รวมของกัน) — คืน true ถ้าเกมจบด้วยการหนี
export function resolveExits(game, attempts) {
  const byExit = new Map();
  for (const { p, a } of attempts) {
    if (!p.alive) continue;
    const x = game.exits.get(a.exitId);
    if (!x || x.open || p.zoneId !== x.zoneId || p.outside) continue;
    if (!byExit.has(x.id)) byExit.set(x.id, []);
    byExit.get(x.id).push(p);
  }
  for (const [xid, people] of byExit) {
    const x = game.exits.get(xid);
    for (const p of people) if (!knowsExit(p, x)) discoverExit(game, p, x, 'คนในห้องชี้ให้คุณดู');
    const names = people.map((p) => game.nick(p)).join(', ');
    const held = new Map();
    for (const p of people) for (const it of p.inventory) if (it.exitId === x.id) held.set(it.id, it);
    let opened = false;
    let failText = '';
    switch (x.route) {
      case 'locked':
        opened = [...held.values()].some((i) => i.role === 'key');
        failText = `ไม่มีใครในกลุ่มถือกุญแจของ${x.name}`;
        break;
      case 'code': {
        const notes = [...held.values()].filter((i) => i.role === 'code').length;
        const need = people.some((p) => game.traitOf(p) === 'tech') ? ESCAPE.CODE_NOTES_TECH : ESCAPE.CODE_NOTES;
        opened = notes >= need;
        failText = `เศษรหัสยังไม่ครบ (มี ${notes}/${need} ชิ้น) รหัสที่กดผิด แป้นส่งเสียงเตือนดังลั่น`;
        if (!opened) for (const o of game.alivePlayers()) if (o.zoneId !== x.zoneId && chance(0.4)) game.logTo(o, `🔊 ได้ยินเสียงสัญญาณเตือนสั้น ๆ ดังมาจากทาง${game.zn(x.zoneId)}`, 'witness');
        break;
      }
      case 'repair': {
        const parts = x.items.filter((i) => i.role === 'part');
        const missing = parts.filter((i) => !held.has(i.id));
        const tool = people.some((p) => p.inventory.some((i) => tagsOf(i).has('fastener'))); // ต้องเป็นเครื่องมือช่างจริง (ไขควง/ประแจ/ค้อน/คีม)
        opened = !missing.length && tool;
        failText = missing.length ? `ยังขาด: ${missing.map((m) => m.name).join(', ')}` : 'มีชิ้นส่วนครบแต่ไม่มีเครื่องมือช่าง (ไขควง/ประแจ/ค้อน) ประกอบไม่ได้';
        break;
      }
      case 'power':
        opened = x.powered;
        failText = 'ยังไม่มีไฟ ประตูไม่ขยับ';
        break;
      case 'breach': {
        let gain = 0;
        for (const p of people) if (holdsHeavy(p)) gain += ['combat', 'tech'].includes(game.traitOf(p)) ? 2 : 1;
        x.progress = Math.min(x.progressNeeded, x.progress + gain);
        opened = x.progress >= x.progressNeeded;
        failText = `ลงแรงไปแล้ว ${x.progress}/${x.progressNeeded} ยังไม่ขาด`;
        for (const o of game.alivePlayers()) if (!people.includes(o) && chance(ESCAPE.BREACH_NOISE_CHANCE)) game.logTo(o, `🔊 ได้ยินเสียงโลหะกระแทกดังสนั่นมาจากทาง${game.zn(x.zoneId)}เหมือนมีคนทุบหรืองัดอะไรบางอย่าง`, 'witness');
        if (!gain) failText = 'ไม่มีใครถือของหนักพอจะทุบ';
        break;
      }
      default:
        break;
    }
    if (opened) {
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
    for (const p of people) game.logTo(p, `🚪 พยายามเปิด${x.name}ที่${game.zn(x.zoneId)}แต่ยังไม่สำเร็จ — ${failText}`, 'escape');
    for (const o of game.presentIn(x.zoneId)) {
      if (people.includes(o)) continue;
      game.logTo(o, `👀 คุณเห็น${names}ยุ่งอยู่กับ${x.name} เหมือนพยายามเปิดทางออก`, 'witness');
      discoverExit(game, o, x, `คุณเห็น${names}พยายามเปิดมัน`);
    }
    game.recordEvent(`${names} พยายามเปิดทางออก "${x.name}" (${failText})`);
  }
  return false;
}

export function exitView(game, p, x) {
  return {
    id: x.id,
    zoneId: x.zoneId,
    zoneName: game.zoneName(x.zoneId),
    name: x.name,
    description: x.description,
    route: x.route,
    routeLabel: routeLabel(x.route),
    requirement: requirementText(game, x),
    // ไม่ส่ง id ของของที่ซ่อนอยู่ให้ client (รู้แค่ชื่อและว่าถืออยู่ไหม)
    items: x.items.map((i) => ({ name: i.name, role: i.role, held: p ? p.inventory.some((h) => h.id === i.id) : false })),
    progress: x.progress,
    progressNeeded: x.progressNeeded,
    powered: x.powered,
    open: x.open,
  };
}
