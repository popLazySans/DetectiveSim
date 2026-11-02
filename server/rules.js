// ตารางกติกาที่ใช้ร่วมกันทั้งเอนจิน (game.js), ระบบทางออก (escape.js) และหน้าจอ (ส่งให้ client ผ่าน view.config)
// แก้ตัวเลขที่นี่ที่เดียว แล้วอ่านคำอธิบายฉบับคนทั่วไปได้ใน BALANCE.md

// ---------- ของ / ชนิดของ ----------
export const ITEM_KINDS = ['weapon', 'poison', 'tool', 'rope', 'food', 'key', 'lockpick', 'cloth', 'clue', 'part', 'trap', 'power', 'fixture'];
export const KIND_LABEL = {
  weapon: 'อาวุธ',
  poison: 'ยา/สารพิษ',
  tool: 'เครื่องมือ',
  rope: 'เชือก/สายไฟ',
  food: 'อาหาร/เครื่องดื่ม (ของกลางในห้อง)',
  key: 'กุญแจ',
  lockpick: 'ที่สะเดาะกุญแจ/ชุดไขควง',
  cloth: 'ผ้า',
  clue: 'แผนผัง/บันทึก',
  part: 'ชิ้นส่วนสำหรับทางออก',
  trap: 'กับดักที่ประกอบแล้ว',
  power: 'แผงไฟ/กล้อง (ติดตั้งถาวร)',
  fixture: 'ของติดตั้งถาวร',
};
// ชนิดที่ใช้พกพาได้ (power/fixture/food เป็นของกลางในห้อง)
export const PORTABLE_KINDS = new Set(['weapon', 'poison', 'tool', 'rope', 'key', 'lockpick', 'cloth', 'clue', 'part', 'trap']);

// สายที่นำไฟฟ้าได้จริง (ใช้ประกอบกับดักไฟช็อต) — ดูจากชื่อ: สายไฟ/สายพ่วง/เคเบิล ส่วนเชือก สายรัด และเทปพันสายไฟ (ฉนวน) ไม่นับ
export const isConductive = (item) => !!item && item.kind === 'rope' && /สายไฟ|สายพ่วง|เคเบิล|ไฟฟ้า|ทองแดง|สายชาร์จ/.test(String(item.name || '')) && !/เทป/.test(String(item.name || ''));

// ---------- ร่องรอยบนศพจากของที่ใช้ลงมือ ----------
// ใช้ตัวเดียวกันทั้งตอนตรวจศพ (game.js) และตอนเล่าคดีแบบ mock (mock.js) จะได้ไม่ขัดกันเอง · ตัดสินจากชนิดก่อน แล้วค่อยดูคำในชื่อของ
// pierce = ยิง/แทงทะลุ · sharp = ของมีคม/ปลายแหลม · ligature = รัดคอด้วยเส้น · smother = อุดปากจมูกด้วยผ้า · blunt = ของหนักทุบ · poison = วางยา · hands = มือเปล่า
export function woundOf(weapon) {
  if (!weapon) return 'hands';
  if (weapon.kind === 'poison') return 'poison';
  const n = String(weapon.name || '');
  const explicit = Array.isArray(weapon.tags); // อาวุธของคดีเก็บแท็กไว้แล้ว (เช่น ปืนที่กระสุนหมดแล้วใช้ด้ามฟาด = ไม่มีแท็ก firearm)
  const t = tagsOf(weapon);
  if (t.has('firearm') || (!explicit && /ปืน|ธนู|หน้าไม้|ฉมวก/.test(n))) return 'pierce';
  if (t.has('sharp') || (!explicit && /มีด|กรรไกร|ขวาน|แหลม|ผ่าตัด|ตัดเนื้อ|ไขควง|เปิดไวน์|ดาบ|หอก|เคียว|เลื่อย|สว่าน/.test(n))) return 'sharp';
  if (weapon.kind === 'rope' || /เชือก|สายไฟ|สาย|ม่าน|โซ่|เข็มขัด|เนคไท|ไฟฟ้า/.test(n)) return 'ligature';
  if (weapon.kind === 'cloth' || /ผ้า|หมอน|เบาะ/.test(n)) return 'smother';
  return 'blunt';
}

// ---------- การลงมือ (attack) ----------
// โอกาสพื้นฐานตามของที่ใช้ลงมือ — ของชนิดอื่น (กุญแจ ชิ้นส่วน แผนผัง กับดัก) ใช้ลงมือไม่ได้ · ตัวตัดสินจริงคือ attackBaseOf() ข้างล่าง ซึ่งดูแท็กของด้วย (เครื่องมือที่ไม่หนักไม่แหลมใช้ลงมือไม่ได้)
export const ATTACK = {
  UNARMED: 0.35,
  WEAPON_BASE: { weapon: 0.7, tool: 0.55, cloth: 0.5, rope: 0.5, poison: 0.5 },
  POISON_MEDICAL: 0.8, // สายการแพทย์วางยาได้แม่น (ไม่ต้องมีเข็ม)
  POISON_INJECT: 0.65, // คนทั่วไปวางยาตรงได้ก็ต่อเมื่อมีเข็มฉีดยา (แท็ก injector) ในมือ
  FIREARM: 0.85, // อาวุธปืนที่ยังมีกระสุน (ยิงแล้วทั้งตึกได้ยิน)
  WEAPON_LIGHT: 0.5, // อาวุธที่ไม่หนักไม่มีคม (ด้ามอะลูมิเนียม ปืนที่กระสุนหมด)
  COMBAT_UNARMED_BONUS: 0.35, // นักสู้มือเปล่า 0.35 + 0.35 = 0.70
  COMBAT_ARMED_BONUS: 0.15,
  TARGET_COMBAT_PENALTY: 0.15, // เป้าหมายเป็นนักสู้ หลบ/ต้านได้
  DESIGNATED_BONUS: 0.1, // ฆาตกรประจำวันที่เกมเลือก
  WITNESS_PENALTY: 0.08, // ต่อคนอื่นในห้อง 1 คน (ลงมือยากขึ้นเมื่อมีคนเยอะ)
  DARK_BONUS: 0.05, // ห้องถูกตัดไฟ
  MIN: 0.1,
  MAX: 0.95,
  // เมื่อพลาด
  COUNTER_KILL: 0.25, // เป้าหมายสวนกลับจนคนลงมือตาย
  COUNTER_KILL_COMBAT: 0.5, // ถ้าเป้าหมายเป็นนักสู้
  WRONG_TARGET: 0.3, // มีคนอื่นในห้อง → พลาดไปโดนคนอื่น
  DROP_WEAPON: 0.4,
  MESSY: 0.4, // สำเร็จแต่เลอะเทอะ
  MESSY_COMBAT: 0.2,
};

// ---------- กับดัก (ต้องคราฟก่อน) ----------
// recipe: needs = ชนิดของ 2 ชิ้นที่ใช้ประกอบ (ถูกใช้หมดไป), trait = ต้องมีสายความสามารถนี้ (ถ้ามี), placeNeeds = ห้องต้องมีของชนิดนี้ถึงจะวางได้,
// nameTpl = แม่แบบชื่อกับดักที่ได้ ({a} = ชิ้นชนิดแรก {b} = ชิ้นชนิดที่สอง), striker = ลำดับชิ้นที่ทำร้ายจริง (เป็น "อาวุธ" ของคดี),
// partTags = แท็กที่ชิ้นนั้นต้องมีอย่างน้อย 1 อย่าง (ดู tagsOf) — needs รับชนิดเดียวหรืออาร์เรย์ของชนิดก็ได้ · ตัวเช็กจริงคือ partMatches()
export const RECIPES = [
  {
    id: 'blade',
    name: 'อาวุธผูกเชือกขึงที่ประตู',
    needs: ['weapon', 'rope'],
    trait: null,
    placeNeeds: null,
    trapType: 'blade',
    nameTpl: '{a}ผูก{b}',
    striker: 0,
    partTags: [['sharp', 'heavy'], null],
    desc: 'ผูกอาวุธกับเชือกแล้วขึงไว้ที่กรอบประตู ใครเปิดประตูเข้ามาจะโดนเหวี่ยงใส่เต็มแรง (ของมีคม = บาดลึก · ของหนัก = กระแทกศีรษะ)',
    how: 'อาวุธที่มีคมหรือหนัก + เชือก/สายไฟ (ของเบา ๆ หรือปืนใช้ไม่ได้)',
  },
  {
    id: 'fall',
    name: 'สายสะดุดโยงของหนัก',
    needs: [['tool', 'weapon'], 'rope'],
    trait: null,
    placeNeeds: null,
    trapType: 'fall',
    nameTpl: '{a}โยง{b}',
    striker: 0,
    partTags: [['heavy'], null],
    desc: 'ขึงสายสะดุดไว้ที่ทางเข้า โยงกับของหนักให้หล่นใส่คนที่สะดุด',
    how: 'ของหนัก (เครื่องมือหรืออาวุธที่หนัก) + เชือก/สายไฟ',
  },
  {
    id: 'shock',
    name: 'สายไฟเปลือยดัดแปลง',
    needs: ['tool', 'rope'],
    trait: 'tech',
    placeNeeds: 'power',
    trapType: 'shock',
    nameTpl: '{b}ปอกเปลือยด้วย{a}',
    striker: 1,
    partTags: [['fastener'], ['conductive']],
    desc: 'ปอกสายไฟให้เปลือยแล้วต่อเข้ากับลูกบิดประตู ต้องใช้สายไฟจริง (เชือก สายรัด หรือเทปไม่นำไฟฟ้า) วางได้เฉพาะห้องที่มีแผงไฟ (เฉพาะช่างเทคนิค)',
    how: 'เครื่องมือช่าง (ไขควง/ประแจ/คีม) + สายไฟที่นำไฟฟ้าได้ (ช่างเทคนิคเท่านั้น วางได้เฉพาะห้องที่มีแผงไฟ)',
  },
  {
    id: 'door',
    name: 'กับดักประตู',
    needs: ['weapon', 'tool'],
    trait: null,
    placeNeeds: null,
    trapType: 'door',
    nameTpl: '{a}ยึดกลไกประตูด้วย{b}',
    striker: 0,
    partTags: [['firearm', 'sharp', 'heavy'], ['fastener']],
    desc: 'ยึดอาวุธเข้ากับกลไกบานประตูด้วยเครื่องมือช่าง (ปืนที่มีกระสุน = ลั่นใส่ · ของมีคม = พุ่งใส่ · ของหนัก = หล่นใส่ศีรษะ) ทำงานทันทีที่ประตูถูกเปิด (ไม่มีโอกาสรอด) วางข้างในห้อง = คนที่เปิดประตูเข้ามาตาย · วางข้างนอก (ตอนยืนรอหน้าประตูห้องที่ล็อก) = คนที่เปิดประตูออกมาตาย · คนที่ปลดล็อกประตูโดนก่อนเสมอ ถ้าหลายคนผ่านพร้อมกันสุ่ม 1 คน',
    how: 'อาวุธ (ปืนที่มีกระสุน ของมีคม หรือของหนัก) + เครื่องมือช่าง (ไขควง/ประแจ/ค้อน) วางได้ทั้งข้างในและข้างนอกประตู',
  },
];

// กับดักแบบ "วางยาในอาหารกลางห้อง" ไม่ต้องคราฟ: ถือยาพิษไปที่ห้องที่มีอาหาร แล้วเลือก "ผสมยาพิษ"
export const TRAP_TYPES = {
  blade: { label: 'อาวุธผูกเชือกที่ประตู', weaponKind: 'weapon', trigger: 'ทันทีที่คุณเปิดประตูเข้ามา {w}ที่ผูกเชือกไว้เหวี่ยงใส่คุณเต็มแรง', evidence: '{w}ผูกเชือกห้อยอยู่ที่กรอบประตู ถูกตั้งใจติดตั้งไว้ ไม่ใช่อุบัติเหตุ', body: 'บาดแผลลึกที่ลำคอและหน้าอกจาก{w}ที่เหวี่ยงมาจากระดับประตู', byWound: { blunt: { trigger: 'ทันทีที่คุณเปิดประตูเข้ามา {w}ที่ผูกเชือกไว้เหวี่ยงมากระแทกศีรษะคุณเต็มแรง', body: 'กะโหลกด้านข้างแตกจาก{w}ที่เหวี่ยงมาจากระดับประตู' } } },
  fall: { label: 'สายสะดุดโยงของหนัก', weaponKind: 'tool', trigger: 'คุณสะดุดเชือกที่ขึงไว้ต่ำ ๆ และ{w}หล่นลงมาใส่ศีรษะคุณเต็มแรง', evidence: 'เศษเชือกขึงอยู่ที่ทางเข้า และ{w}ตกอยู่ในตำแหน่งที่ไม่ใช่ที่ของมัน', body: 'แผลแตกที่ศีรษะจาก{w}ที่ตกลงมา ทิศทางแผลบอกว่าไม่มีคนลงมือโดยตรง' },
  shock: { label: 'สายไฟเปลือยที่ลูกบิดประตู', weaponKind: 'power', trigger: 'ทันทีที่คุณจับลูกบิดประตู กระแสไฟแล่นผ่านตัวคุณ', evidence: 'สายไฟเปลือยพันอยู่ที่ลูกบิดประตูและต่อเข้ากับแผงไฟ ถูกดัดแปลงด้วยมือคน', body: 'รอยไหม้ที่ฝ่ามือและหัวใจหยุดเต้นเฉียบพลัน ตรงกับการถูกไฟช็อต' },
  door: { label: 'กับดักประตู', weaponKind: 'weapon', trigger: 'ทันทีที่บานประตูขยับ {w}ที่ยึดไว้กับกลไกประตูพุ่งใส่คุณเต็มแรง', evidence: '{w}ถูกยึดไว้กับกลไกบานประตูด้วยเครื่องมือ ถูกตั้งใจติดตั้งไว้ให้ทำงานตอนเปิดประตู', body: 'บาดแผลฉกรรจ์จาก{w}ในระดับประตู ตรงกับการโดนกับดักที่ประตูขณะเปิด', byWound: { pierce: { trigger: 'ทันทีที่บานประตูขยับ {w}ที่ยึดไว้กับกลไกประตูลั่นใส่คุณในระยะประชิด', evidence: '{w}ถูกยึดไว้กับกลไกบานประตูด้วยเครื่องมือ ไกถูกโยงให้ลั่นตอนเปิดประตู', body: 'บาดแผลทะลุที่หน้าอกจาก{w}ในระดับประตู ถูกยิงตอนเปิดประตู' }, blunt: { trigger: 'ทันทีที่บานประตูขยับ {w}ที่ยึดไว้เหนือประตูหล่นใส่ศีรษะคุณเต็มแรง', evidence: '{w}ถูกยึดไว้เหนือบานประตูด้วยเครื่องมือ ให้หล่นลงมาตอนเปิดประตู', body: 'กะโหลกแตกจาก{w}ที่หล่นจากเหนือประตู' } } },
  poison: { label: 'ยาพิษในอาหาร', weaponKind: 'poison', trigger: 'คุณกินอาหารในห้องนี้แล้วรู้สึกชาไปทั้งตัว — มีคนผสม{w}ไว้', evidence: 'ภาชนะอาหารในห้องมีคราบและกลิ่นของ{w}', body: 'ริมฝีปากเขียวคล้ำ ไม่มีบาดแผล ตรงกับพิษจาก{w}ที่ได้รับผ่านอาหาร' },
};
export const TRAP_TRIGGER_CHANCE = 0.6; // กับดักทั่วไปทำงานเมื่อมีคนเข้าห้อง (กับดักประตูทำงานเสมอ ไม่มีโอกาสปลด)
export const TRAP_DISARM_CHANCE = 0.25; // คนเข้าห้องสังเกตเห็นและปลดได้ทัน (ช่างสังเกต +0.2)
export const TRAP_FAIL_CHANCE = 0.15; // วางกับดักพลาด (ของหล่นเกะกะ)
export const POISON_NOTICE = { medical: 0.5, detective: 0.5, default: 0.15 }; // โอกาสสังเกตว่าอาหารมีพิษก่อนกิน

// ---------- แท็กย่อยของ ----------
// บอกว่าของชิ้นนั้น "ทำอะไรได้จริง" ดูจากชนิด + คำในชื่อ/คำบรรยาย (หรือ item.tags ที่ระบุมาเอง เช่น อาวุธของคดี)
// สูตรกับดัก การลงมือ ทางออก และการสะเดาะเช็กจากแท็กเหล่านี้ ไม่ใช่แค่ชนิดของ — สมุด วิทยุ ไฟฉาย กล้อง กุญแจมือ จึงเป็นแค่ของประกอบฉาก
// heavy = หนักพอจะทุบ/ถ่วง · sharp = มีคม/ปลายแหลม · firearm = ยิงได้ (กระสุนจำกัด) · fastener = เครื่องมือช่างที่ยึด/ขัน/ตอก/ปอกสายได้
// conductive = สายไฟที่นำไฟฟ้า · cord = เส้นที่ผูก/ขึงได้ (เชือกทุกเส้น) · injector = เข็มฉีดยา (พาหะวางยาตรง)
// pungent = ยากลิ่น/รสชัด (คนกินสังเกตง่าย) · tasteless = ไร้สีไร้รส (สังเกตยาก) · bloodOnly = พิษที่ต้องเข้ากระแสเลือด (ผสมอาหารไม่ได้)
export const TAG_LABEL = { heavy: 'หนัก', sharp: 'มีคม', firearm: 'ยิงได้', fastener: 'เครื่องมือช่าง', conductive: 'นำไฟฟ้า', injector: 'ฉีดได้', pungent: 'กลิ่นฉุน', tasteless: 'ไร้สีไร้รส', bloodOnly: 'ต้องเข้ากระแสเลือด' };
const TAG_RX = {
  heavy: /ถัง|ประแจ|ค้อน|กระทะ|พลั่ว|ฟืน|ท่อน|เครื่องเงิน|กาน้ำ|ลูกบอล|โคมไฟ|เบสบอล|ที่เขี่ย|ขวด|เชิงเทียน|ขวาน|หิน|ตุ้ม|ดัมเบล|สมอ|แท่ง|ไม้กอล์ฟ|ตะบอง|กระบอง|หนัก/,
  sharp: /มีด|กรรไกร|ขวาน|แหลม|ผ่าตัด|ตัดเนื้อ|ไขควง|เปิดไวน์|ดาบ|หอก|เคียว|เลื่อย|สว่าน|ง่าม|คมกริบ|คมมาก|คมและ|มีคม|ใบคม|ปลายคม|สิ่ว|ตะขอ/, // ไม่ใช้ "คม" เดี่ยว ๆ เพราะจะไปจับ "โคมไฟ"
  firearm: /ปืน|ธนู|หน้าไม้|ยิง/,
  fastener: /ไขควง|ประแจ|ค้อน|คีม|ตะปู|สว่าน|เครื่องมือช่าง|กล่องเครื่องมือ|ชุดเครื่องมือ|เครื่องมือซ่อม/,
  injector: /เข็ม|ไซริงค์|กระบอกฉีด/,
  pungent: /ฟอกขาว|ล้างจาน|ปุ๋ย|ฉุน|แอมโมเนีย|ทินเนอร์|กรด|น้ำมัน|คลอรีน|ฆ่าแมลง/,
  tasteless: /ไม่มีสี|ไม่มีกลิ่น|ไม่มีรส|รสหวาน|กันเยือกแข็ง|เบื่อหนู|นอนหลับ|ยาสลบ|ความดัน|ไซยาไนด์|สารหนู/,
  bloodOnly: /แมงกะพรุน|พิษงู|แมงป่อง|ปักเป้า|เซรุ่ม|พิษ.*สกัด/,
};
export function tagsOf(item) {
  if (!item) return new Set();
  if (Array.isArray(item.tags)) return new Set(item.tags);
  const text = `${item.name || ''} ${item.description || ''}`;
  const out = new Set();
  const test = (tag) => TAG_RX[tag].test(text) && out.add(tag);
  if (item.kind === 'weapon' || item.kind === 'tool') {
    if (!/เบา/.test(text)) test('heavy'); // "เบาแต่แข็ง" ไม่นับว่าหนัก
    test('sharp');
    test('firearm');
    if (item.kind === 'tool') test('fastener');
    test('injector');
  }
  if (item.kind === 'rope') {
    out.add('cord');
    if (isConductive(item)) out.add('conductive');
  }
  if (item.kind === 'poison') {
    test('pungent');
    test('tasteless');
    test('bloodOnly');
    if (out.has('pungent')) out.delete('tasteless');
  }
  return out;
}

// กระสุนของอาวุธปืน อ่านจากคำบรรยาย ("ยังมีกระสุนสองนัด", "มีลูกฉมวก 3 ดอก") ไม่บอก = 2
const THAI_NUM = { หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10 };
export function parseAmmo(description = '') {
  const d = String(description || '');
  const m = d.match(/(\d+)\s*(นัด|ดอก|ลูก|ตลับ)/);
  if (m) return Math.max(1, Math.min(12, parseInt(m[1], 10)));
  const w = d.match(/(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*(นัด|ดอก|ลูก)/);
  if (w) return THAI_NUM[w[1]];
  return 2;
}
export const ammoOf = (item) => (item && tagsOf(item).has('firearm') ? parseAmmo(item.description) : undefined);

// ของชิ้นนี้ใช้ลงมือได้ไหม และโอกาสพื้นฐานเท่าไร (null = ใช้ลงมือไม่ได้) · hasInjector = มีเข็มฉีดยาในมือ (สำหรับวางยาตรง)
export function attackBaseOf(item, trait, hasInjector = false) {
  if (!item) return null;
  const t = tagsOf(item);
  switch (item.kind) {
    case 'weapon':
      if (t.has('firearm')) {
        if ((item.ammo ?? 0) > 0) return { base: ATTACK.FIREARM, label: 'อาวุธปืน' };
        return t.has('heavy') || t.has('sharp') ? { base: ATTACK.WEAPON_BASE.weapon, label: 'อาวุธ (กระสุนหมด ใช้ฟาด)' } : { base: ATTACK.WEAPON_LIGHT, label: 'ด้ามปืนเปล่า' };
      }
      if (t.has('sharp') || t.has('heavy')) return { base: ATTACK.WEAPON_BASE.weapon, label: t.has('sharp') ? 'อาวุธมีคม' : 'อาวุธหนัก' };
      return { base: ATTACK.WEAPON_LIGHT, label: 'อาวุธเบา' };
    case 'tool':
      if (t.has('sharp') || t.has('heavy')) return { base: ATTACK.WEAPON_BASE.tool, label: t.has('sharp') ? 'เครื่องมือปลายแหลม' : 'เครื่องมือ/ของหนัก' };
      return null;
    case 'cloth':
      return { base: ATTACK.WEAPON_BASE.cloth, label: 'ผ้า (อุดหายใจ)' };
    case 'rope':
      return { base: ATTACK.WEAPON_BASE.rope, label: 'เชือก/สาย (รัดคอ)' };
    case 'poison':
      if (trait === 'medical') return { base: ATTACK.POISON_MEDICAL, label: hasInjector ? 'ฉีดยา (สายการแพทย์)' : 'วางยา (สายการแพทย์)' };
      if (hasInjector) return { base: ATTACK.POISON_INJECT, label: 'ฉีดยาด้วยเข็ม' };
      return null;
    default:
      return null;
  }
}

// ของชิ้นนี้ใช้เป็นส่วนผสมลำดับ idx ของสูตรได้ไหม (ชนิดตรง + มีแท็กที่ต้องการ · ปืนเปล่าลั่นไม่ได้)
export function partMatches(item, recipe, idx) {
  if (!item || !recipe) return false;
  const kinds = [].concat(recipe.needs[idx]);
  if (!kinds.includes(item.kind)) return false;
  const want = recipe.partTags?.[idx];
  if (!want) return true;
  const t = tagsOf(item);
  const ok = want.filter((x) => t.has(x));
  if (!ok.length) return false;
  if (ok.every((x) => x === 'firearm') && !((item.ammo ?? 0) > 0)) return false;
  return true;
}

// ข้อความกับดักตามชนิดแผลของชิ้นที่ทำร้าย (เช่น กับดักประตูด้วยปืน = ลั่นใส่, ด้วยของหนัก = หล่นใส่ศีรษะ)
export function trapTexts(trapType, wound) {
  const tt = TRAP_TYPES[trapType] || TRAP_TYPES.fall;
  return { ...tt, ...(tt.byWound?.[wound] || {}) };
}

// โอกาสที่คนกินสังเกตว่าอาหารมีพิษ ขึ้นกับชนิดยา: กลิ่นฉุนสังเกตง่าย ไร้สีไร้รสสังเกตยาก (trained = สายการแพทย์/ช่างสังเกต)
export const POISON_NOTICE_BY_TAG = { pungent: { default: 0.6, trained: 0.9 }, tasteless: { default: 0.05, trained: 0.4 } };
export function poisonNoticeChance(trait, tags = []) {
  const trained = trait === 'medical' || trait === 'detective';
  const list = tags instanceof Set ? [...tags] : tags;
  if (list.includes('pungent')) return POISON_NOTICE_BY_TAG.pungent[trained ? 'trained' : 'default'];
  if (list.includes('tasteless')) return POISON_NOTICE_BY_TAG.tasteless[trained ? 'trained' : 'default'];
  return POISON_NOTICE[trait] ?? POISON_NOTICE.default;
}

// ทุบ/งัดทางออกได้ด้วยของหนัก หรืออาวุธมีคม (ไขควง สมุด ไฟฉาย ใช้ไม่ได้)
export const canBreachWith = (i) => !!i && (tagsOf(i).has('heavy') || (i.kind === 'weapon' && tagsOf(i).has('sharp')));

// ---------- การล็อกห้อง ----------
export const LOCKS = {
  LOCKED_ZONES_SMALL: 1, // ห้องที่ล็อกไว้ตั้งแต่เริ่ม (สถานที่ ≤ 6 ห้องสำรวจ)
  LOCKED_ZONES_LARGE: 2,
  MAX_KEYS: 2, // กุญแจทั้งเกมมีไม่เกิน 2 ดอก (สุ่ม 1–2) ไม่มีกุญแจผู้ดูแล (ระบบสร้างให้เองแทนของจากสถานที่)
  ROOMS_PER_KEY: [1, 3], // กุญแจดอกหนึ่งไขได้กี่ห้อง · แต่ละห้องมีกุญแจที่ไขได้ไม่เกินดอกเดียว · ห้องที่ล็อกตั้งแต่เริ่มมีกุญแจเสมอ · ห้องที่เหลือบางห้องไม่มีกุญแจเลย (ล็อกไม่ได้)
};

// ---------- ผ่านประตูที่ล็อกโดยไม่มีกุญแจ ----------
// ใช้เวลาเป็นชั่วโมง (สุ่มในช่วงตอนเริ่มทำ "แล้วแต่ดวง") เลือกห้องนั้นซ้ำทุกชั่วโมงจนสำเร็จ ระหว่างนั้นทำอย่างอื่นไม่ได้
export const DOOR = {
  PICK_HOURS: [2, 3], // ที่สะเดาะกุญแจ (ใครก็ใช้ได้) · ช่างเทคนิคใช้เครื่องมือช่าง (แท็ก fastener: ไขควง/ประแจ/คีม) แทน → ประตูเปิด (ล็อกใหม่ได้)
  BREAK_HOURS: [1, 2], // นักสู้พังประตูมือเปล่า → ประตูพัง ล็อกไม่ได้อีก
  PICK_HEARD: 0.25, // โอกาสต่อชั่วโมงที่คนในห้องได้ยินเสียงสะเดาะ
  BREAK_HEARD_FAR: 0.3, // โอกาสต่อชั่วโมงที่คนห้องอื่นได้ยินเสียงพังประตู (คนในห้องนั้นได้ยินเสมอ)
};

// ---------- ทางออก ----------
export const ROUTES = {
  locked: { label: 'ประตูล็อก', needs: 'ต้องหากุญแจของประตูนี้มาไข' },
  code: { label: 'แป้นรหัส', needs: 'ต้องรวบรวมเศษกระดาษรหัสทั้ง 3 ชิ้นมากดพร้อมกัน (ช่างเทคนิคใช้แค่ 2 ชิ้น)' },
  repair: { label: 'ซ่อมเครื่องยนต์/กลไก', needs: 'ต้องมีชิ้นส่วนที่หายไปครบ และมีเครื่องมือช่าง (ไขควง/ประแจ/ค้อน/คีม) ในมือ' },
  power: { label: 'ประตูไฟฟ้า/ลิฟต์', needs: 'ไม่มีไฟ: ต้องเอาฟิวส์ไปใส่ที่ห้องที่มีแผงไฟก่อน แล้วค่อยกลับมาเปิด' },
  breach: { label: 'ทุบ/งัด', needs: 'ต้องถือของหนักหรืออาวุธมีคม (ไขควง สมุด ไฟฉาย ใช้ไม่ได้) แล้วลงแรงรวม 5 แต้ม (คนละ 1 ต่อครั้ง นักสู้/ช่างเทคนิค 2) เสียงดังคนอื่นได้ยิน' },
};
export const ESCAPE = {
  EXITS_PER_GAME: 2,
  FIND_EXIT_CHANCE: 0.25, // สำรวจห้องที่มีทางออกซ่อนอยู่แล้วเจอ (ช่างสังเกต 0.55)
  FIND_EXIT_DETECTIVE_BONUS: 0.3,
  FIND_HIDDEN_CHANCE: 0.5, // ของที่ซ่อนอยู่ทั่วไป
  FIND_ROUTE_ITEM_CHANCE: 0.4, // ของสำหรับทางออก (กุญแจ/ชิ้นส่วน/เศษรหัส/แผนผัง)
  DETECTIVE_SEARCH_BONUS: 0.35,
  BREACH_PROGRESS: 5,
  BREACH_NOISE_CHANCE: 0.6, // คนที่อยู่ห้องอื่นได้ยิน
  CODE_NOTES: 3,
  CODE_NOTES_TECH: 2,
};

// ---------- ภารกิจลับ (กันแคมป์) ----------
// ระยะเวลาตามความยาก: ไป 1 ห้อง 3 ชม. · ไป 1 ห้อง + กินอาหาร 4 ชม. · ไป 2 ห้อง 5 ชม. · หยิบของ 4 ชม. · เอาของไปวาง 4 ชม. · นัดพบ 5 ชม.
export const OBJECTIVE_HOURS = { visit: 3, visit_eat: 4, visit2: 5, take: 4, plant: 4, meet: 5 };
export const OBJECTIVE_WEIGHTS = { visit: 3, visit_eat: 2, visit2: 2, take: 2, plant: 1, meet: 1 };

// ---------- ผลของสายความสามารถ (trait) ที่ระบบใช้จริง ----------
export const TRAIT_EFFECTS = {
  combat: ['ลงมือมือเปล่า 35% → 70%, ถืออาวุธ +15%', 'เมื่อถูกจู่โจม สวนกลับจนคนลงมือตาย 50% (คนทั่วไป 25%) และคนที่จะลงมือกับคุณโดนหัก 15%', 'ลงมือแล้วเลอะเทอะแค่ 20% (คนทั่วไป 40%)', 'ทุบ/งัดทางออกได้ 2 แต้มต่อครั้ง (ต้องการ 5 แต้ม)', 'พังประตูห้องที่ล็อกได้ด้วยมือเปล่า ใช้เวลา 1–2 ชั่วโมง (เสียงดัง คนในห้องได้ยินทุกชั่วโมง ประตูพังแล้วล็อกไม่ได้อีก)'],
  stealth: ['ล้วงกระเป๋าคนในห้องเดียวกันได้ (สำเร็จ 70%)', 'ทำลายหลักฐานสำเร็จ 75% (คนทั่วไป 50%)', 'คนในห้องเห็นคุณซ่อนของ/วางกับดัก/หยิบของน้อยลงครึ่งหนึ่ง'],
  medical: ['ตรวจศพเห็นอาวุธ เวลาตาย และว่าศพถูกย้ายไหม', 'วางยาโดยตรงได้โดยไม่ต้องมีเข็มฉีดยา สำเร็จ 80% (คนทั่วไปต้องมีเข็มฉีดยา 65%)', 'สังเกตอาหารมีพิษก่อนกิน 50% (คนทั่วไป 15%)', 'ทำลายหลักฐานสำเร็จ 75%'],
  tech: ['ตัดไฟ/กล้องในห้องที่มีแผงไฟ (พยานจำหน้าไม่ได้ และคนลงมือได้ +5%)', 'คราฟกับดักไฟช็อตได้ (ต้องใช้สายไฟจริง เชือกไม่นำไฟฟ้า)', 'กดรหัสทางออกด้วยเศษรหัสแค่ 2 ใน 3 ชิ้น', 'ทุบ/งัดทางออกได้ 2 แต้มต่อครั้ง', 'ใช้เครื่องมือช่าง (ไขควง/ประแจ/คีม) สะเดาะกลอนประตูที่ล็อกแทนที่สะเดาะกุญแจ (2–3 ชั่วโมง)'],
  social: ['ซักถามคนในห้องเดียวกัน รู้ความจริง 1 ข้อ (เขารู้ว่าถูกซักถาม)'],
  detective: ['สำรวจเจอของซ่อน/หลักฐาน +35%', 'ค้นพบทางออกที่ซ่อนอยู่ +30%', 'สังเกตเห็นกับดักก่อนโดน +20% และอาหารมีพิษ 50%'],
  none: ['ไม่มีผลพิเศษ ใช้แอ็กชันพื้นฐานได้ทุกอย่าง'],
};
