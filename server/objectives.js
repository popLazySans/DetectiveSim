// ภารกิจย่อย — แต่ละคนมีภารกิจลับค้างได้ทีละข้อ ระยะเวลาขึ้นกับความยาก (ดู OBJECTIVE_HOURS ใน rules.js)
// จุดประสงค์คือ "กันแคมป์" (ไม่ให้ทุกคนอยู่ห้องเดียวกันตลอด) ไม่ใช่การลงโทษ:
// ถ้าครบกำหนดแล้วยังไม่ทำ ระบบจะพาผู้เล่นไปทำเองในชั่วโมงนั้น (ล็อกห้อง/แอ็กชัน) ไม่มีใครตายเพราะภารกิจ
// ทำเสร็จก่อนกำหนดก็ยังไม่ได้ภารกิจใหม่ จนกว่าจะครบชั่วโมงของภารกิจเดิม (Game.beginTurn ใช้ player.nextObjectiveTurn)
import { OBJECTIVE_HOURS, OBJECTIVE_WEIGHTS } from './rules.js';

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
const nextId = () => `obj-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const hasFood = (zone) => zone.items.some((i) => i.kind === 'food');

// game: Game instance, player: ผู้เล่นที่จะได้ภารกิจ
export function makeObjective(game, player) {
  const zones = [...game.zones.values()].filter((z) => z.id !== game.location.sleepZoneId);
  if (!zones.length) return null;
  const others = game.alivePlayers().filter((o) => o.id !== player.id);
  const inv = player.inventory.filter((i) => !i.isPart && i.kind !== 'clue');
  const foodZones = zones.filter((z) => hasFood(z) && z.id !== player.zoneId);
  const weights = { ...OBJECTIVE_WEIGHTS };
  if (!foodZones.length) weights.visit_eat = 0;
  if (zones.length < 3) weights.visit2 = 0;
  if (!others.length) weights.meet = 0;
  if (!inv.length) weights.plant = 0;
  const bag = Object.entries(weights).flatMap(([t, w]) => Array(w).fill(t));
  let type = pick(bag);
  const mk = (t, extra) => {
    const hours = OBJECTIVE_HOURS[t];
    return { id: nextId(), type: t, done: false, forgiven: false, hours, deadlineTurn: game.turn + hours, assignedTurn: game.turn, ...extra };
  };
  const within = (t) => `ภายใน ${OBJECTIVE_HOURS[t]} ชั่วโมง`;

  if (type === 'take') {
    // ของที่ยังอยู่ในห้อง มองเห็นได้ พกพาได้ และไม่ใช่ของสำหรับทางออก
    const cands = zones.flatMap((z) => z.items.filter((i) => i.portable && !i.hidden && !i.isPart && i.kind !== 'clue' && i.kind !== 'trap').map((i) => ({ item: i, zone: z })));
    if (!cands.length) type = 'visit';
    else {
      const { item, zone } = pick(cands);
      return mk('take', { itemId: item.id, itemName: item.name, zoneId: zone.id, text: `หยิบ "${item.name}" (อยู่ที่${zone.name}) มาไว้กับตัว${within('take')} — รับจากคนอื่นก็ได้` });
    }
  }
  if (type === 'plant') {
    const item = pick(inv);
    const zone = pick(zones.filter((z) => z.id !== player.zoneId)) || pick(zones);
    return mk('plant', { itemId: item.id, itemName: item.name, zoneId: zone.id, text: `นำ "${item.name}" ที่คุณถืออยู่ไปวางหรือซ่อนไว้ที่${zone.name}${within('plant')}` });
  }
  if (type === 'meet') {
    const target = pick(others);
    const c = game.charOf(target);
    return mk('meet', { targetId: target.id, text: `ไปอยู่ห้องเดียวกับ ${c?.nickname || target.name} อย่างน้อยหนึ่งชั่วโมง${within('meet')} (ห้องไหนก็ได้)` });
  }
  if (type === 'visit_eat') {
    const zone = pick(foodZones);
    return mk('visit_eat', { zoneId: zone.id, ate: false, text: `ไปที่${zone.name} แล้วกินอาหาร/ดื่มน้ำที่นั่น${within('visit_eat')}` });
  }
  if (type === 'visit2') {
    const two = shuffle(zones.filter((z) => z.id !== player.zoneId)).slice(0, 2);
    if (two.length === 2) return mk('visit2', { zoneIds: two.map((z) => z.id), visited: [], text: `ไปที่${two[0].name} และ${two[1].name} (ลำดับไหนก็ได้)${within('visit2')}` });
    type = 'visit';
  }
  const zone = pick(zones.filter((z) => z.id !== player.zoneId)) || pick(zones);
  return mk('visit', { zoneId: zone.id, text: `ไปที่${zone.name}${within('visit')}` });
}

// สถานะภารกิจเมื่อถึงกำหนด: 'done' | 'forgiven' (เป้าหมายหายไปโดยไม่ใช่ความผิดผู้เล่น) | 'pending'
export function objectiveOutcome(game, player, o) {
  if (o.done) return 'done';
  const heldByOther = (itemId) => [...game.players.values()].some((p) => p.id !== player.id && p.alive && p.inventory.some((i) => i.id === itemId));
  // forgiveReason = เหตุผลที่บอกผู้เล่นตอนยกเลิก (ทำไมถึงทำไม่ได้แล้ว)
  const forgive = (why) => {
    o.forgiveReason = why;
    return 'forgiven';
  };
  if (o.type === 'take') {
    if (player.inventory.some((i) => i.id === o.itemId)) return 'done';
    const holder = [...game.players.values()].find((p) => p.id !== player.id && p.alive && p.inventory.some((i) => i.id === o.itemId));
    if (holder) return forgive(`${game.nick(holder)}หยิบของชิ้นนั้นไปถือไว้ก่อนแล้ว`);
    const hiddenSomewhere = [...game.zones.values()].some((z) => z.items.some((i) => i.id === o.itemId && i.hidden));
    const visibleSomewhere = [...game.zones.values()].some((z) => z.items.some((i) => i.id === o.itemId && !i.hidden));
    if (visibleSomewhere) return 'pending';
    return forgive(hiddenSomewhere ? 'มีคนเอาของชิ้นนั้นไปซ่อนไว้แล้ว' : 'ของชิ้นนั้นหายไปจากที่เดิมแล้ว');
  }
  if (o.type === 'plant') {
    if (game.zones.get(o.zoneId)?.items.some((i) => i.id === o.itemId)) return 'done';
    if (!player.inventory.some((i) => i.id === o.itemId)) return forgive('ของที่ต้องเอาไปวางไม่ได้อยู่ในมือคุณแล้ว');
    return 'pending';
  }
  if (o.type === 'meet') {
    const t = game.players.get(o.targetId);
    if (!t || !t.alive) return forgive('คนที่ต้องไปอยู่ด้วยไม่อยู่ในเกมแล้ว');
    return 'pending';
  }
  if (o.type === 'visit_eat') {
    const z = game.zones.get(o.zoneId);
    if (!z || !hasFood(z)) return forgive('ห้องนั้นไม่มีอาหารให้กินแล้ว');
    return 'pending';
  }
  return 'pending';
}

// ห้องเป้าหมายถัดไปของภารกิจ (ใช้ตอนบังคับ และให้บอทเลือกห้อง) — null ถ้าไม่มี
export function objectiveTargetZone(game, player, o) {
  if (o.done) return null;
  if (o.type === 'visit' || o.type === 'visit_eat' || o.type === 'plant') return o.zoneId;
  if (o.type === 'visit2') return o.zoneIds.find((id) => !o.visited.includes(id)) || null;
  if (o.type === 'take') {
    const z = [...game.zones.values()].find((zz) => zz.items.some((i) => i.id === o.itemId && !i.hidden));
    return z?.id || null;
  }
  return null;
}
