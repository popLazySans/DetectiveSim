// ภารกิจย่อย — แต่ละคนมีภารกิจลับค้างได้ทีละข้อ มีเวลา OBJECTIVE_HOURS ชั่วโมง
// จุดประสงค์คือ "กันแคมป์" (ไม่ให้ทุกคนอยู่ห้องเดียวกันตลอด) ไม่ใช่การลงโทษ:
// ถ้าครบกำหนดแล้วยังไม่ทำ ระบบจะพาผู้เล่นไปทำเองในชั่วโมงนั้น (ล็อกห้อง/แอ็กชัน) ไม่มีใครตายเพราะภารกิจ

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let seq = 0;
const nextId = () => `obj-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// game: Game instance (ใช้ zones, alivePlayers, charOf, location, turn), player: ผู้เล่นที่จะได้ภารกิจ, hours: จำนวนชั่วโมงที่ให้
export function makeObjective(game, player, hours) {
  const zones = [...game.zones.values()].filter((z) => z.id !== game.location.sleepZoneId && z.id !== game.location.exitZoneId);
  if (!zones.length) return null;
  const others = game.alivePlayers().filter((o) => o.id !== player.id);
  const inv = player.inventory.filter((i) => !i.isPart);
  const weights = [['visit', 4], ['take', 3], ['meet', others.length ? 2 : 0], ['plant', inv.length ? 2 : 0]];
  const bag = weights.flatMap(([t, w]) => Array(w).fill(t));
  let type = pick(bag);
  const base = { id: nextId(), done: false, hours, deadlineTurn: game.turn + hours, assignedTurn: game.turn };
  const within = `ภายใน ${hours} ชั่วโมง`;

  if (type === 'take') {
    // ของที่ยังอยู่ในห้อง มองเห็นได้ พกพาได้ และไม่ใช่ของหนี
    const cands = zones.flatMap((z) => z.items.filter((i) => i.portable && !i.hidden && !i.isPart).map((i) => ({ item: i, zone: z })));
    if (!cands.length) type = 'visit';
    else {
      const { item, zone } = pick(cands);
      return { ...base, type, itemId: item.id, itemName: item.name, zoneId: zone.id, text: `หยิบ "${item.name}" (อยู่ที่${zone.name}) มาไว้กับตัว${within} — รับจากคนอื่นก็ได้` };
    }
  }
  if (type === 'plant') {
    const item = pick(inv);
    const zone = pick(zones.filter((z) => z.id !== player.zoneId)) || pick(zones);
    return { ...base, type, itemId: item.id, itemName: item.name, zoneId: zone.id, text: `นำ "${item.name}" ที่คุณถืออยู่ไปวางหรือซ่อนไว้ที่${zone.name}${within}` };
  }
  if (type === 'meet') {
    const target = pick(others);
    const c = game.charOf(target);
    return { ...base, type, targetId: target.id, text: `ไปอยู่ห้องเดียวกับ ${c?.nickname || target.name} อย่างน้อยหนึ่งชั่วโมง${within} (ห้องไหนก็ได้)` };
  }
  const zone = pick(zones.filter((z) => z.id !== player.zoneId)) || pick(zones);
  return { ...base, type: 'visit', zoneId: zone.id, text: `ไปที่${zone.name}${within}` };
}

// สถานะภารกิจเมื่อถึงกำหนด: 'done' | 'forgiven' (เป้าหมายหายไปโดยไม่ใช่ความผิดผู้เล่น) | 'pending'
export function objectiveOutcome(game, player, o) {
  if (o.done) return 'done';
  const heldByOther = (itemId) => [...game.players.values()].some((p) => p.id !== player.id && p.alive && p.inventory.some((i) => i.id === itemId));
  if (o.type === 'take') {
    if (player.inventory.some((i) => i.id === o.itemId)) return 'done';
    if (heldByOther(o.itemId)) return 'forgiven';
    const visibleSomewhere = [...game.zones.values()].some((z) => z.items.some((i) => i.id === o.itemId && !i.hidden));
    return visibleSomewhere ? 'pending' : 'forgiven';
  }
  if (o.type === 'plant') {
    if (game.zones.get(o.zoneId)?.items.some((i) => i.id === o.itemId)) return 'done';
    if (!player.inventory.some((i) => i.id === o.itemId)) return 'forgiven';
    return 'pending';
  }
  if (o.type === 'meet') {
    const t = game.players.get(o.targetId);
    if (!t || !t.alive) return 'forgiven';
    return 'pending';
  }
  return 'pending';
}
