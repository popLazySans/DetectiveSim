// ภารกิจย่อยประจำวัน — แต่ละคนได้ภารกิจลับ 1 ข้อต่อวัน ต้องทำให้ทันกำหนด ไม่งั้นตาย (คนอื่นไม่รู้สาเหตุ)
// ภารกิจทุกแบบบังคับให้ผู้เล่น "ไปอยู่ในที่ที่อาจดูน่าสงสัย" ซึ่งเป็นหัวใจของการสืบสวน

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// จำนวนวันที่ให้ทำ (deadlineDay = วันที่ได้รับ + ค่านี้ ตรวจตอนจบวันนั้น)
export const OBJECTIVE_DEADLINE = { visit: 1, take: 1, plant: 2, meet: 2 };

let seq = 0;
const nextId = () => `obj-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// game: Game instance (ใช้ zones, alivePlayers, charOf, location), player: ผู้เล่นที่จะได้ภารกิจ
export function makeObjective(game, player) {
  const zones = [...game.zones.values()].filter((z) => z.id !== game.location.sleepZoneId && z.id !== game.location.exitZoneId);
  if (!zones.length) return null;
  const others = game.alivePlayers().filter((o) => o.id !== player.id);
  const activeTargets = new Set(player.objectives.filter((o) => !o.done).map((o) => o.zoneId || o.itemId || o.targetId));
  const inv = player.inventory.filter((i) => !i.isPart);
  const weights = [['visit', 4], ['take', 3], ['meet', others.length ? 1 : 0], ['plant', inv.length ? 2 : 0]];
  const bag = weights.flatMap(([t, w]) => Array(w).fill(t));
  let type = pick(bag);
  const day = game.day;
  const deadline = (t) => day + OBJECTIVE_DEADLINE[t];

  if (type === 'take') {
    // ของที่ยังอยู่ในห้อง มองเห็นได้ พกพาได้ และไม่ใช่ของหนี
    const cands = zones.flatMap((z) => z.items.filter((i) => i.portable && !i.hidden && !i.isPart && !activeTargets.has(i.id)).map((i) => ({ item: i, zone: z })));
    if (!cands.length) type = 'visit';
    else {
      const { item, zone } = pick(cands);
      return { id: nextId(), type, itemId: item.id, itemName: item.name, zoneId: zone.id, deadlineDay: deadline(type), done: false, text: `หยิบ "${item.name}" (อยู่ที่${zone.name}) มาไว้กับตัวภายในวันที่ ${deadline(type)}` };
    }
  }
  if (type === 'plant') {
    const item = pick(inv);
    const zone = pick(zones.filter((z) => z.id !== player.zoneId)) || pick(zones);
    return { id: nextId(), type, itemId: item.id, itemName: item.name, zoneId: zone.id, deadlineDay: deadline(type), done: false, text: `นำ "${item.name}" ที่คุณถืออยู่ไปวางหรือซ่อนไว้ที่${zone.name} ภายในวันที่ ${deadline(type)}` };
  }
  if (type === 'meet') {
    const target = pick(others.filter((o) => !activeTargets.has(o.id))) || pick(others);
    const c = game.charOf(target);
    return { id: nextId(), type, targetId: target.id, deadlineDay: deadline(type), done: false, text: `ไปอยู่ห้องเดียวกับ ${c?.nickname || target.name} อย่างน้อยหนึ่งวัน ภายในวันที่ ${deadline(type)} (ห้องไหนก็ได้)` };
  }
  // visit
  const zone = pick(zones.filter((z) => z.id !== player.zoneId && !activeTargets.has(z.id))) || pick(zones);
  return { id: nextId(), type: 'visit', zoneId: zone.id, deadlineDay: deadline('visit'), done: false, text: `ไปที่${zone.name} ให้ได้ภายในวันที่ ${deadline('visit')}` };
}

// ตรวจผลภารกิจตอนถึงกำหนด: 'done' | 'forgiven' (เป้าหมายหายไปโดยไม่ใช่ความผิดผู้เล่น) | 'failed'
export function objectiveOutcome(game, player, o) {
  if (o.done) return 'done';
  const heldByOther = (itemId) => [...game.players.values()].some((p) => p.id !== player.id && p.alive && p.inventory.some((i) => i.id === itemId));
  if (o.type === 'take') {
    if (player.inventory.some((i) => i.id === o.itemId)) return 'done';
    if (heldByOther(o.itemId)) return 'forgiven';
    return 'failed';
  }
  if (o.type === 'plant') {
    const inZone = game.zones.get(o.zoneId)?.items.some((i) => i.id === o.itemId);
    if (inZone) return 'done';
    if (heldByOther(o.itemId)) return 'forgiven';
    return 'failed';
  }
  if (o.type === 'meet') {
    const t = game.players.get(o.targetId);
    if (!t || !t.alive) return 'forgiven';
    return 'failed';
  }
  return 'failed';
}
