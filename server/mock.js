// Mock generators — ใช้เมื่อไม่มี ANTHROPIC_API_KEY หรือเมื่อเรียก AI ไม่สำเร็จ
// ทุกฟังก์ชันคืนค่าในรูปแบบเดียวกับที่ ai.js คาดหวังจาก Claude

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

// hidden = true  → Ultimate ที่มีผลกับการสืบสวน หรือเพิ่ม/ลดความเชื่อใจ (ระบบจะเลือกซ่อนจริงแค่ 1-2 คน และทำโรลปลอม 1 คน)
export const ULTIMATE_POOL = [
  { title: 'สุดยอดนักสืบ', hidden: true, description: 'มองเห็นรายละเอียดเล็ก ๆ ในที่เกิดเหตุที่คนอื่นมองข้าม', investigationEffect: 'สังเกตร่องรอยการจัดฉากและการปกปิดได้' },
  { title: 'สุดยอดนักฆ่า', hidden: true, description: 'ฝึกฝนการสังหารอย่างเงียบเชียบและแม่นยำ', investigationEffect: 'ลงมือได้เงียบและทิ้งร่องรอยการต่อสู้น้อยมาก' },
  { title: 'สุดยอดความหวัง', hidden: true, description: 'คำพูดจุดประกายให้คนรอบข้างเชื่อใจโดยไม่รู้ตัว', investigationEffect: 'ผู้คนมีแนวโน้มเชื่อคำพูดของเขามากกว่าปกติ' },
  { title: 'สุดยอดผู้นำ', hidden: true, description: 'ชักจูงกลุ่มให้เดินตามแนวทางที่ตนต้องการได้', investigationEffect: 'โน้มน้าวความคิดเห็นส่วนรวมได้ง่าย' },
  { title: 'สุดยอดแฮกเกอร์', hidden: true, description: 'เจาะระบบอิเล็กทรอนิกส์ได้ทุกชนิดในเวลาไม่กี่นาที', investigationEffect: 'เข้าถึงและลบบันทึกกล้อง/ระบบประตูได้โดยไม่ต้องใช้รหัส' },
  { title: 'สุดยอดช่างไฟ', hidden: true, description: 'รู้ทุกอย่างเกี่ยวกับวงจรไฟฟ้าและแผงควบคุม', investigationEffect: 'รู้ว่าเบรกเกอร์ตัวไหนคุมโซนไหน และดูออกว่าไฟดับเพราะคนสับหรือไฟตก' },
  { title: 'สุดยอดนักนิติเวช', hidden: true, description: 'อ่านสภาพศพและระบุเวลาตาย สาเหตุการตายได้แม่นยำ', investigationEffect: 'รู้สาเหตุและเวลาตายจริงจากการดูศพ' },
  { title: 'สุดยอดนักจิตวิทยา', hidden: true, description: 'อ่านสีหน้าและจับโกหกได้จากท่าทางเล็ก ๆ', investigationEffect: 'รู้ว่าใครกำลังปิดบังบางอย่าง' },
  { title: 'สุดยอดนักต้มตุ๋น', hidden: true, description: 'พูดโกหกได้เนียนจนตัวเองยังเชื่อ', investigationEffect: 'คำโกหกของเขาน่าเชื่อถือผิดปกติ' },
  { title: 'สุดยอดนักเคมี', hidden: true, description: 'ปรุงสารเคมีจากของใช้ในบ้านได้ทุกชนิด', investigationEffect: 'ผสมน้ำยาล้างคราบหรือยาพิษจากสารที่มีได้ และรู้จักกลิ่นสารเคมี' },
  { title: 'สุดยอดสายลับ', hidden: true, description: 'แอบฟังและแทรกซึมโดยไม่มีใครสังเกต', investigationEffect: 'รู้จักทางลัดและเส้นทางที่ไม่มีใครผ่าน รู้ความเคลื่อนไหวของคนอื่น' },
  { title: 'สุดยอดนักแสดง', hidden: true, description: 'ปลอมตัวและเลียนแบบเสียงคนอื่นได้เหมือนเป๊ะ', investigationEffect: 'ล่อคนออกมาด้วยเสียงของคนอื่นได้' },
  { title: 'สุดยอดพยาบาล', hidden: true, description: 'รู้เรื่องยา บาดแผล และร่างกายมนุษย์อย่างลึกซึ้ง', investigationEffect: 'รู้ขนาดยาและจุดฉีดที่อันตราย ประเมินบาดแผลและชนิดอาวุธได้' },
  { title: 'สุดยอดนักล้วงกระเป๋า', hidden: true, description: 'หยิบและคืนของจากตัวคนอื่นโดยไม่มีใครรู้สึก', investigationEffect: 'ขโมยกุญแจหรือย้ายหลักฐานไปไว้กับคนอื่นได้' },
  { title: 'สุดยอดนักเจรจา', hidden: true, description: 'ทำให้ฝ่ายตรงข้ามยอมตามได้แม้ในสถานการณ์คับขัน', investigationEffect: 'ลดความสงสัยที่คนอื่นมีต่อเขาได้' },
  { title: 'สุดยอดนักทำขนม', hidden: false, description: 'อบขนมได้อร่อยจนคนกินน้ำตาไหล', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักดนตรี', hidden: false, description: 'เล่นเครื่องดนตรีได้ทุกชนิด หูไวต่อเสียงมาก', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักว่ายน้ำ', hidden: false, description: 'กลั้นหายใจใต้น้ำได้นานกว่าห้านาที', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดช่างภาพ', hidden: false, description: 'ถ่ายภาพได้สวยทุกสภาพแสง พกกล้องตลอดเวลา', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักจัดสวน', hidden: false, description: 'รู้จักพืชทุกชนิดและดูแลมันราวกับลูก', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักเต้น', hidden: false, description: 'ร่างกายยืดหยุ่นและเคลื่อนไหวได้สง่างาม', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดเชฟ', hidden: false, description: 'ทำอาหารจากวัตถุดิบอะไรก็ได้ให้เป็นมื้อหรู', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักเขียนนิยาย', hidden: false, description: 'แต่งเรื่องราวซับซ้อนได้ในหัวภายในไม่กี่นาที', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักออกแบบแฟชั่น', hidden: false, description: 'จำเสื้อผ้าและเนื้อผ้าทุกชิ้นที่เคยเห็นได้', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดเกมเมอร์', hidden: false, description: 'ปฏิกิริยาไวและชอบวิเคราะห์กลยุทธ์', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดจิตรกร', hidden: false, description: 'วาดภาพจากความทรงจำได้แม่นยำทุกรายละเอียด', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักพากย์', hidden: false, description: 'เปลี่ยนเสียงได้หลายสิบแบบ', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักกายกรรม', hidden: false, description: 'ปีนป่ายและทรงตัวบนที่สูงได้อย่างง่ายดาย', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักโหราศาสตร์', hidden: false, description: 'ทำนายดวงจากดวงดาว คนเชื่อครึ่งไม่เชื่อครึ่ง', investigationEffect: 'ไม่มีผลโดยตรง' },
  { title: 'สุดยอดนักบัญชี', hidden: false, description: 'จำตัวเลขและลำดับเหตุการณ์ได้แม่นยำ', investigationEffect: 'ไม่มีผลโดยตรง' },
];

export function mockUltimates(characters) {
  // ให้มี Ultimate ที่มีผลต่อคดี (hidden=true) ประมาณ 40% — game.js จะเลือกซ่อนจริง/ทำโรลปลอมเองทีหลัง
  const hiddenPool = shuffle(ULTIMATE_POOL.filter((u) => u.hidden));
  const openPool = shuffle(ULTIMATE_POOL.filter((u) => !u.hidden));
  const hiddenCount = Math.max(1, Math.round(characters.length * 0.4));
  const chosen = shuffle([...hiddenPool.slice(0, hiddenCount), ...openPool.slice(0, characters.length - hiddenCount)]);
  const usedTitles = new Set(chosen.map((u) => u.title));
  const decoys = shuffle(openPool.filter((u) => !usedTitles.has(u.title)));
  return characters.map((c, i) => {
    const u = chosen[i % chosen.length];
    const decoy = decoys[i % Math.max(1, decoys.length)] || openPool.find((o) => o.title !== u.title) || openPool[0];
    return {
      characterId: c.id,
      hiddenReason: u.hidden ? 'มีผลต่อการสืบสวนหรือความเชื่อใจ' : '',
      ...u,
      decoyTitle: decoy.title,
      decoyDescription: decoy.description,
    };
  });
}

const LOCATIONS = [
  {
    name: 'โรงเรียนประจำร้างกลางหุบเขา',
    description: 'อาคารเรียนสามชั้นที่ถูกทิ้งร้างมานานหลายปี หมอกหนาปกคลุมตลอดวัน ไฟฟ้ายังใช้ได้บางส่วนจากเครื่องปั่นไฟเก่า',
    items: [
      ['ขวานดับเพลิง', 'แขวนอยู่ในตู้กระจกหน้าห้องพยาบาล', 'โถงทางเดินชั้น 1'],
      ['ชุดเคมีในห้องแล็บ', 'ขวดสารเคมีหลายขวด ฉลากซีดจางอ่านแทบไม่ออก', 'ห้องวิทยาศาสตร์ ชั้น 2'],
      ['เครื่องปั่นไฟดีเซล', 'เสียงดังครืน ๆ จ่ายไฟให้ทั้งอาคาร', 'ห้องใต้ดิน'],
      ['เชือกกระโดดยาว', 'ม้วนอยู่ในตะกร้าหน้าโรงยิม', 'โรงยิม'],
      ['ตู้ยาเก่า', 'มียานอนหลับและยาแก้ปวดหมดอายุ', 'ห้องพยาบาล ชั้น 1'],
      ['ถ้วยรางวัลทองเหลือง', 'หนักอึ้ง ตั้งอยู่บนตู้โชว์', 'ห้องประชุมใหญ่'],
      ['กุญแจผู้คุมอาคาร', 'พวงกุญแจไขได้ทุกห้อง แขวนอยู่ในห้องธุรการ', 'ห้องธุรการ'],
      ['เปียโนเก่า', 'บางคีย์เสียงเพี้ยน ฝาเปียโนหนักมาก', 'ห้องดนตรี ชั้น 3'],
      ['กล้องวงจรปิดรุ่นเก่า', 'ยังบันทึกภาพได้แต่คุณภาพแย่ เทปอยู่ในห้องธุรการ', 'ทางเดินทุกชั้น'],
    ],
  },
  {
    name: 'เรือสำราญลอยลำกลางทะเล',
    description: 'เรือสำราญหรูที่เครื่องยนต์ดับกลางมหาสมุทร ไม่มีสัญญาณวิทยุ มีแค่คลื่นลมและเสียงเรือเอียงไปมา',
    items: [
      ['ฉมวกยิงปลา', 'ปืนฉมวกสำหรับดำน้ำ เก็บในห้องอุปกรณ์กีฬาทางน้ำ', 'ดาดฟ้าท้ายเรือ'],
      ['ถังดับเพลิง', 'ตั้งอยู่ทุกมุมทางเดิน หนักและแข็ง', 'ทางเดินทุกชั้น'],
      ['ตู้ควบคุมไฟหลัก', 'แผงสวิตช์ควบคุมไฟของทั้งเรือ ประตูล็อกด้วยรหัส', 'ห้องเครื่อง'],
      ['ไวน์แดงล็อตพิเศษ', 'ขวดไวน์ราคาแพงหลายสิบขวด', 'ห้องเก็บไวน์'],
      ['มีดเชฟชุดใหญ่', 'มีดคมกริบเรียงในซองหนัง', 'ครัวหลัก'],
      ['กุญแจห้องพักหลัก', 'คีย์การ์ดที่เปิดได้ทุกห้องพัก', 'เคาน์เตอร์ต้อนรับ'],
      ['เสื้อชูชีพ', 'กองอยู่ในตู้ข้างเรือชูชีพ ขาดหายไปหนึ่งตัว', 'ดาดฟ้าเรือชูชีพ'],
      ['สระว่ายน้ำบนดาดฟ้า', 'น้ำเค็มกระเพื่อมตามการเอียงของเรือ ไฟใต้น้ำกะพริบ', 'ดาดฟ้าชั้นบนสุด'],
    ],
  },
  {
    name: 'คฤหาสน์เก่าบนเกาะร้าง',
    description: 'คฤหาสน์สไตล์โคโลเนียลที่มีเพียงเรือลำเดียวเข้าถึง พายุกำลังพัดเข้าฝั่ง และสะพานไม้สู่ท่าเรือถูกคลื่นซัดขาด',
    items: [
      ['ปืนลูกซองโบราณ', 'แขวนเหนือเตาผิง ไม่แน่ใจว่ายังยิงได้', 'ห้องรับแขก'],
      ['เชิงเทียนทองเหลือง', 'หนักและมีปลายแหลม ตั้งอยู่บนโต๊ะอาหารยาว', 'ห้องอาหาร'],
      ['ลิฟต์ส่งอาหาร', 'ช่องลิฟต์เล็กจากครัวขึ้นไปชั้นสอง เสียงดังเวลาเคลื่อน', 'ครัว'],
      ['ตู้ยาพิษสำหรับหนู', 'กล่องยาเบื่อหนูเปิดอยู่ หายไปครึ่งกล่อง', 'ห้องเก็บของใต้บันได'],
      ['นาฬิกาตั้งพื้นโบราณ', 'ตีระฆังทุกชั่วโมง หยุดเดินเวลา 02:14', 'โถงกลาง'],
      ['สวนเขาวงกตไม้พุ่ม', 'พุ่มไม้สูงท่วมหัว มีศาลาอยู่ตรงกลาง', 'สวนหลังบ้าน'],
      ['กุญแจห้องใต้หลังคา', 'กุญแจเหล็กขึ้นสนิมเพียงดอกเดียว แขวนในห้องพ่อบ้าน', 'ห้องพ่อบ้าน'],
      ['ฟิวส์บ็อกซ์หลัก', 'แผงฟิวส์เก่าที่ควบคุมไฟทั้งคฤหาสน์', 'ห้องใต้ดิน'],
      ['ผ้าม่านกำมะหยี่หนัก', 'เชือกรูดม่านยาวถักเป็นเกลียว', 'ห้องสมุด'],
    ],
  },
  {
    name: 'โรงแรมหิมะบนยอดดอย',
    description: 'รีสอร์ตไม้สนบนยอดเขาที่หิมะปิดถนนทุกเส้นทาง เครื่องทำความร้อนทำงานเสียงดัง และข้างนอกอุณหภูมิติดลบ',
    items: [
      ['ขวานผ่าฟืน', 'ปักอยู่ที่ตอไม้ข้างกองฟืนหลังโรงแรม', 'ลานหลังโรงแรม'],
      ['ไม้สกีและไม้ค้ำ', 'เรียงอยู่ในห้องเก็บอุปกรณ์ ปลายแหลม', 'ห้องเก็บอุปกรณ์สกี'],
      ['เครื่องทำความร้อนส่วนกลาง', 'หม้อไอน้ำเก่าที่มีวาล์วควบคุมหลายตัว', 'ห้องเครื่องใต้ดิน'],
      ['อ่างน้ำร้อนกลางแจ้ง', 'น้ำร้อนจัดควันขึ้นตลอด ฝาปิดหนัก', 'ระเบียงชั้น 1'],
      ['ชุดชงชาและกาต้มน้ำ', 'กาต้มน้ำไฟฟ้าและชาสมุนไพรหลายชนิด', 'ล็อบบี้'],
      ['กล้องส่องทางไกล', 'ติดตั้งบนขาตั้งที่ระเบียงชมวิว', 'ระเบียงชั้น 3'],
      ['กุญแจแม่บ้าน', 'พวงกุญแจไขได้ทุกห้องพัก', 'ห้องซักรีด'],
      ['ตู้เบรกเกอร์ไฟ', 'ตู้เบรกเกอร์แยกแต่ละชั้น ไม่มีกุญแจล็อก', 'ทางเดินชั้น 2'],
    ],
  },
  {
    name: 'ห้างสรรพสินค้าปิดตาย',
    description: 'ห้างขนาดใหญ่ที่ประตูทุกบานถูกเชื่อมปิด ไฟในห้างเปิดเป็นบางโซน เสียงเพลงจากลำโพงเล่นวนซ้ำไม่หยุด',
    items: [
      ['ไม้เบสบอลจากร้านกีฬา', 'ไม้เบสบอลอะลูมิเนียมหลายอัน', 'ร้านกีฬา ชั้น 2'],
      ['ตู้ควบคุมลิฟต์และบันไดเลื่อน', 'แผงควบคุมที่ล็อกด้วยกุญแจ', 'ห้องช่าง ชั้นใต้ดิน'],
      ['ชุดมีดจากร้านเครื่องครัว', 'มีดทำครัววางโชว์เรียงเป็นแถว', 'ร้านเครื่องครัว ชั้น 3'],
      ['ยาจากร้านขายยา', 'ยาหลายชนิดบนชั้น มีทั้งยานอนหลับและยาลดความดัน', 'ร้านขายยา ชั้น 1'],
      ['หุ่นโชว์เสื้อผ้า', 'หุ่นเท่าตัวจริงหลายสิบตัว', 'ร้านเสื้อผ้า ชั้น 2'],
      ['ห้องควบคุมกล้องวงจรปิด', 'จอมอนิเตอร์หลายสิบจอ บางกล้องถูกปิด', 'ห้องรักษาความปลอดภัย'],
      ['น้ำพุกลางห้าง', 'น้ำพุใหญ่ลึกถึงเอว มีเหรียญก้นสระ', 'โถงกลาง ชั้น 1'],
      ['ลำโพงประกาศ', 'ระบบประกาศทั่วห้าง เปิดเพลงวนอยู่', 'ห้องรักษาความปลอดภัย'],
      ['กุญแจช่างห้าง', 'พวงกุญแจใหญ่ไขห้องช่างและห้องควบคุม', 'ห้องช่าง ชั้นใต้ดิน'],
    ],
  },
  {
    name: 'สถานีวิจัยใต้ทะเล',
    description: 'สถานีวิจัยลึกสามร้อยเมตรใต้ผิวน้ำ ผนังโลหะส่งเสียงครางเมื่อถูกแรงดัน ลิฟต์ขึ้นสู่ผิวน้ำถูกล็อกไว้',
    items: [
      ['ถังออกซิเจนสำรอง', 'ถังออกซิเจนหลายถัง บางถังวาล์วเปิดอยู่', 'ห้องเตรียมดำน้ำ'],
      ['ประแจท่อขนาดใหญ่', 'ประแจเหล็กหนักสำหรับซ่อมท่อ', 'ห้องซ่อมบำรุง'],
      ['แผงควบคุมแรงดันห้อง', 'ปรับแรงดันและล็อกประตูแต่ละโซนได้', 'ห้องควบคุมกลาง'],
      ['ตู้แช่ตัวอย่างสัตว์ทะเล', 'มีแมงกะพรุนและปลาพิษหลายชนิดในโหลแก้ว', 'ห้องแล็บชีววิทยา'],
      ['ชุดดำน้ำแรงดันสูง', 'ชุดหนักแขวนเรียงกัน หายไปหนึ่งชุด', 'ห้องเตรียมดำน้ำ'],
      ['ชุดยาและเข็มฉีดยา', 'ตู้ยาฉุกเฉิน มียาสลบสำหรับสัตว์ทดลอง', 'ห้องพยาบาล'],
      ['ระบบไฟฉุกเฉิน', 'สวิตช์ตัดไฟหลักและไฟฉุกเฉินสีแดง', 'ห้องควบคุมกลาง'],
      ['หน้าต่างสังเกตการณ์', 'กระจกหนาบานใหญ่มองเห็นทะเลมืดสนิท', 'ห้องพักผ่อน'],
    ],
  },
];

export function mockLocation({ round = 1, previousNames = [] } = {}) {
  const avail = LOCATIONS.filter((l) => !previousNames.includes(l.name));
  const base = pick(avail.length ? avail : LOCATIONS);
  return {
    name: base.name,
    description: base.description,
    items: base.items.map(([name, description, where], i) => ({ id: `item_${i + 1}`, name, description, where })),
  };
}

// อีเวนต์พิเศษ "คืนชีพ": แต่งเหตุผลว่าทำไมเหยื่อถึงไม่ได้ตายจริง
// ctx: { character, deathSummary, location }
export function mockReviveEvent({ character, location }) {
  const nick = character.nickname;
  const item = location?.items?.length ? pick(location.items) : null;
  const where = item ? item.where : 'ห้องเก็บของ';
  const variants = [
    {
      title: 'ชีพจรที่ไม่มีใครสังเกต',
      story: `ก่อนที่ทุกคนจะออกเดินทาง มีคนได้ยินเสียงไอแผ่ว ๆ จากใต้ผ้าที่คลุมร่างของ${nick}ไว้ เมื่อเปิดออกดูก็พบว่า${nick}ยังหายใจอยู่ ปรากฏว่าสิ่งที่ทุกคนคิดว่าเป็นความตาย แท้จริงคือฤทธิ์ของยาที่ทำให้ชีพจรอ่อนจนแทบจับไม่ได้ ${nick}ฟื้นขึ้นมาอย่างงุนงง ร่างกายอ่อนแรงแต่ยังมีชีวิต และกลับเข้าร่วมกับทุกคนอีกครั้ง`,
      privateNote: `คุณจำได้แค่ความมืด เสียงฝีเท้า และกลิ่นยาฉุน ๆ ก่อนจะหมดสติ ความทรงจำช่วงที่ทุกคนคิดว่าคุณ "ตาย" ขาดหายไปทั้งหมด`,
    },
    {
      title: `เสียงเคาะจาก${where}`,
      story: `ระหว่างเก็บข้าวของ มีเสียงเคาะดังมาจากทาง${where} เมื่อตามไปดูก็พบ${nick}นอนขดอยู่ในสภาพอิดโรย บาดแผลที่เห็นในคืนนั้นดูน่ากลัวกว่าความเป็นจริง และมีคนแอบย้ายร่างมาซ่อนไว้ที่นี่เพื่อให้ทุกคนเชื่อว่า${nick}ตายแล้ว ${nick}ยังตอบคำถามไม่ได้มากนัก แต่ยืนยันว่าจะไม่ยอมถูกทิ้งไว้ข้างหลังอีก`,
      privateNote: `คุณตื่นขึ้นมาใน${where}โดยไม่รู้ว่ามาอยู่ตรงนี้ได้อย่างไร ร่างกายเจ็บไปหมด แต่ที่เจ็บกว่าคือความรู้สึกว่ามีใครบางคนตั้งใจให้ทุกคนเชื่อว่าคุณตายแล้ว`,
    },
    {
      title: 'ร่างที่หายไป',
      story: `เช้าวันใหม่ ทุกคนพบว่าร่างของ${nick}ที่วางไว้หายไป มีเพียงรอยลากยาวไปจนถึงประตูด้านนอก ไม่นานนัก ${nick}ก็เดินโซเซกลับมาด้วยตัวเอง โดยเล่าว่าฟื้นขึ้นมากลางดึกท่ามกลางความมืดและใช้เวลาทั้งคืนหาทางกลับ ไม่มีใครอธิบายได้ว่า${nick}รอดมาได้อย่างไร แต่ที่แน่ ๆ คือ${nick}ยังมีชีวิตอยู่`,
      privateNote: `คุณจำได้ว่ามีมือเย็น ๆ ประคองคุณขึ้นในความมืดและพูดเบา ๆ ว่า "ยังไม่ถึงเวลา" ก่อนจะหายไป คุณไม่รู้ว่าเป็นใคร`,
    },
  ];
  return pick(variants);
}


// ---------- คดีฆาตกรรม ----------
const findItem = (items, re, fallback) => items.find((i) => re.test(i.name + ' ' + i.description)) || fallback;
const zonesOf = (items) => [...new Set(items.map((i) => i.where))];

// Ultimate ที่มี "กลไกจริง" ใช้ก่อ/ปกปิดคดีได้ — Ultimate อื่นใช้ไม่ได้ (usedUltimate=false) และต้องใช้วิธีธรรมดา
// ถ้าสถานที่ไม่มีอุปกรณ์ที่กลไกนั้นต้องใช้ (เช่น ไม่มีสารเคมี ไม่มีกล้อง ไม่มีกุญแจ) จะคืน null → ใช้วิธีธรรมดา
function ultimateMethod(title, k) {
  const { weapon, scene, key, chem, power, camera, redHerring, victim, decoyPerson } = k;
  switch (title) {
    case 'สุดยอดนักเคมี':
      if (!chem) return null;
      if (weapon === chem) {
        return {
          use: `ผสมสารจาก${chem.name}ให้เป็นยาพิษไร้กลิ่นใส่ในน้ำดื่มของ${victim.nickname}`,
          concealment: `ล้างแก้วให้สะอาดและคืนขวดสารเข้าที่${chem.where}`,
          trace: `แก้วใกล้ศพสะอาดผิดปกติทั้งที่ของอื่นมีฝุ่นจับ และ${chem.name}มีขวดหนึ่งถูกเปิดแล้วปิดไม่สนิท`,
          narrowing: `คนที่รู้ว่าสารไหนใน${chem.name}ผสมกันแล้วเป็นพิษ`,
        };
      }
      return {
        use: `ผสมน้ำยาจากสารใน${chem.name}เพื่อล้างคราบเลือดบน${weapon.name}และพื้นรอบจุดที่ลงมือ`,
        concealment: `ล้างคราบเลือดบน${weapon.name}และพื้นด้วยน้ำยาที่ผสมเองจากสารใน${chem.name}`,
        trace: `กลิ่นฉุนคล้ายน้ำยาล้างห้องน้ำลอยอยู่แถว${scene.where} และสารใน${chem.name}พร่องไปหนึ่งขวด`,
        narrowing: `คนที่รู้ว่าสารไหนผสมกันแล้วล้างคราบเลือดได้`,
      };
    case 'สุดยอดช่างไฟ':
      if (!power) return null;
      return {
        use: `สับสวิตช์ที่${power.name}ให้โซน${scene.where}มืดสนิทช่วงลงมือ แล้วสับกลับก่อนกลับห้อง`,
        concealment: `ทำให้โซน${scene.where}มืดด้วยการสับสวิตช์ที่${power.name} เพื่อไม่ให้ใครเห็นตอนลงมือ`,
        trace: `${power.name}มีรอยนิ้วมือใหม่บนสวิตช์ที่คุมโซน${scene.where} และนาฬิกาดิจิทัลในโซนนั้นรีเซ็ตเป็น 00:00`,
        narrowing: `คนที่รู้ว่าสวิตช์ตัวไหนคุมโซนไหน`,
      };
    case 'สุดยอดแฮกเกอร์':
      if (!camera) return null;
      return {
        use: `เข้าระบบ${camera.name}แล้วลบบันทึกช่วงตีสองถึงตีสามโดยไม่ต้องใช้รหัสผู้ดูแล`,
        concealment: `ลบบันทึกของ${camera.name}ช่วงที่ตัวเองเดินไป${scene.where}`,
        trace: `บันทึกของ${camera.name}มีช่วงเวลาหายไปพอดีหนึ่งชั่วโมง ทั้งที่ระบบไม่เคยดับ`,
        narrowing: `คนที่เข้าระบบได้โดยไม่มีรหัสผู้ดูแล`,
      };
    case 'สุดยอดพยาบาล':
      if (!chem || !/ยา|เข็ม|เคมี|พิษ/.test(chem.name)) return null;
      return {
        cause: `ฉีดยาจาก${chem.name}เข้าที่ซอกคอของ${victim.nickname}ขณะหลับ ในปริมาณที่ทำให้หัวใจหยุดเต้นภายในไม่กี่นาที`,
        body: `${victim.nickname}นอนอยู่บนที่นอนราวกับหลับ ใบหน้าซีดและริมฝีปากเขียวคล้ำ ไม่มีบาดแผลภายนอกที่เห็นได้ชัด`,
        use: `รู้ขนาดยาและจุดฉีดที่ทำให้ดูเหมือนหัวใจวายเฉียบพลัน`,
        concealment: `จัดท่าให้${victim.nickname}ดูเหมือนตายขณะหลับ และคืนเข็มฉีดยาเข้าตู้ยาให้ครบ`,
        trace: `รอยเข็มเล็ก ๆ ที่ซอกคอซึ่งต้องเพ่งถึงจะเห็น และ${chem.name}ถูกจัดเรียงใหม่ผิดจากตอนกลางวัน`,
        narrowing: `คนที่รู้ขนาดยาและจุดฉีดที่อันตราย`,
      };
    case 'สุดยอดนักนิติเวช':
      return {
        use: `ลงมือที่จุดที่รู้ว่าทำให้ตายทันทีและเลือดออกน้อย`,
        concealment: `จัดท่าศพให้ดูเหมือน${victim.nickname}ล้มกระแทก${scene.name}เอง`,
        trace: `ท่าทางศพเป็นธรรมชาติเกินไปสำหรับคนที่ล้ม และรอยช้ำไม่ตรงกับทิศทางที่ล้ม`,
        narrowing: `คนที่รู้เรื่องกายวิภาคและสภาพศพ`,
      };
    case 'สุดยอดนักแสดง':
      return {
        use: `เลียนเสียง${decoyPerson.nickname}เรียก${victim.nickname}ออกจากที่นอนไปที่${scene.where}`,
        concealment: `ล่อเหยื่อออกมาด้วยเสียงของ${decoyPerson.nickname} เพื่อให้ความสงสัยตกไปที่${decoyPerson.nickname}`,
        trace: `ที่นอนของ${victim.nickname}ถูกเปิดผ้าห่มออกเหมือนลุกไปกะทันหันโดยไม่มีร่องรอยถูกลาก และรองเท้าแตะยังอยู่ข้างเตียง`,
        narrowing: `คนที่เลียนเสียงคนอื่นได้เหมือน`,
      };
    case 'สุดยอดสายลับ':
      return {
        use: `ใช้ทางเดินด้านหลังที่ไม่มีใครใช้ไปถึง${scene.where}โดยไม่ผ่านโซนที่คนอื่นนอน`,
        concealment: `เดินอ้อมทางลับเพื่อไม่ให้ใครเห็นว่าออกจากห้อง`,
        trace: `รอยฝุ่นบนทางเดินด้านหลังถูกปัดเป็นทางยาวไปถึง${scene.where}`,
        narrowing: `คนที่รู้จักทางลัดที่ไม่มีใครใช้`,
      };
    case 'สุดยอดนักล้วงกระเป๋า':
      if (!key) return null;
      return {
        use: `หยิบ${key.name}จากตัวคนที่เก็บไว้ แล้วคืนก่อนเช้าโดยไม่มีใครรู้สึกตัว`,
        concealment: `ล็อก${scene.where}หลังลงมือด้วย${key.name} แล้วคืนกุญแจเข้าที่เดิม`,
        trace: `${key.name}อยู่ที่เดิมแต่ถูกคล้องกลับด้าน และ${scene.where}ถูกล็อกจากด้านนอกทั้งที่ศพอยู่ข้างใน`,
        narrowing: `คนที่เข้าใกล้ผู้เก็บ${key.name}ได้โดยไม่ถูกสังเกต`,
      };
    case 'สุดยอดนักฆ่า':
      return {
        use: `ลงมือเงียบและเร็วจน${victim.nickname}ไม่ทันส่งเสียง`,
        concealment: `ลงมือในจังหวะเดียวและไม่แตะต้องสิ่งของอื่นในที่เกิดเหตุเลย`,
        trace: `แผลเดียวแม่นยำ ไม่มีร่องรอยการต่อสู้ ไม่มีของล้มสักชิ้น`,
        narrowing: `คนที่ฝึกการสังหารมาอย่างดี`,
      };
    case 'สุดยอดนักสืบ':
      return {
        use: `จัดฉากให้ดูเหมือน${victim.nickname}ถูกทำร้ายด้วย${redHerring.name} เพราะรู้ว่าคนจะมองหาอะไรเป็นอย่างแรก`,
        concealment: `วาง${redHerring.name}เปื้อนคราบไว้ใกล้ศพ และเช็ด${weapon.name}แล้ววางคืนที่เดิม`,
        trace: `คราบบน${redHerring.name}ดูจงใจเกินไป และไม่ตรงกับลักษณะแผลจริง`,
        narrowing: `คนที่รู้ว่านักสืบจะมองหาอะไร`,
      };
    default:
      return null;
  }
}

// วิธีปกปิดธรรมดาที่ใครก็ทำได้ (ใช้เมื่อ Ultimate ของคนร้ายไม่มีกลไกเกี่ยวกับคดี หรือสุ่มไม่ใช้ Ultimate)
function ordinaryMethod(k) {
  const { weapon, scene, key, cloth, victim, zones } = k;
  const hideZone = pick(zones.filter((z) => z !== scene.where)) || scene.where;
  const options = [
    {
      concealment: `เช็ดคราบบน${weapon.name}ด้วย${cloth.name} แล้วเอาผ้าไปซ่อนไว้ที่${hideZone}`,
      trace: `${cloth.name}หายไปจากที่เดิม และพบผ้าเปียกชื้นมีคราบจาง ๆ ยัดอยู่ที่${hideZone}`,
      narrowing: `คนที่ไปถึง${hideZone}ได้ในคืนนั้นโดยไม่มีใครเห็น`,
    },
    {
      concealment: `ลากร่างของ${victim.nickname}จาก${weapon.where}มาไว้ที่${scene.where} เพื่อให้คิดว่าเกิดเหตุที่นี่`,
      trace: `รอยลากจาง ๆ บนพื้นจาก${weapon.where}มายัง${scene.where} และฝุ่นที่พื้น${weapon.where}มีรอยเท้าสองคู่`,
      narrowing: `คนที่แข็งแรงพอจะลากคนตัวเท่า${victim.nickname}ได้ และหายไปจากที่นอนนานพอ`,
    },
    {
      concealment: `ปิดสวิตช์ไฟโซน${scene.where}ก่อนลงมือ แล้วเปิดกลับตอนเดินกลับที่นอน`,
      trace: `หลอดไฟใน${scene.where}ยังอุ่น ทั้งที่หลายคนจำได้ว่าโซนนั้นมืดอยู่ช่วงหนึ่ง`,
      narrowing: `คนที่รู้ว่าสวิตช์ของโซนนั้นอยู่ตรงไหน`,
    },
  ];
  if (key) {
    options.push({
      concealment: `ล็อก${scene.where}จากด้านนอกด้วย${key.name} แล้วเอากุญแจไปคืนที่${key.where}`,
      trace: `${key.name}อยู่ที่เดิมแต่ห้อยกลับด้าน และมีรอยนิ้วมือเปื้อนบนพวง`,
      narrowing: `คนที่รู้ว่า${key.name}เก็บอยู่ที่${key.where}`,
    });
  }
  return pick(options);
}

// ตัดสินจาก "ชื่อ" อุปกรณ์เท่านั้น (คำในคำบรรยายและคำที่บังเอิญมี "ยา" อยู่ข้างใน เช่น "ยาว" ทำให้ผิดพลาดได้)
function causeFor(weapon, victim, isPoison) {
  const t = weapon.name;
  if (isPoison) {
    return {
      cause: `ถูกวางยาจาก${weapon.name}ในเครื่องดื่มก่อนนอน ทำให้หมดสติและหยุดหายใจ`,
      body: `${victim.nickname}นั่งพิงผนังตาเบิกโพลง ริมฝีปากเขียวคล้ำ ไม่มีบาดแผลภายนอก มีแก้วน้ำล้มอยู่ข้างตัว`,
    };
  }
  if (/ปืน/.test(t)) {
    return {
      cause: `ถูกยิงด้วย${weapon.name}ในระยะประชิดหนึ่งนัด เสียงถูกกลบด้วยเสียงรอบตัวในคืนนั้น`,
      body: `${victim.nickname}นอนหงาย มีบาดแผลกระสุนที่หน้าอกและคราบเขม่าดำรอบแผล`,
    };
  }
  if (/มีด|ฉมวก|ขวาน|สกี|เชิงเทียน/.test(t)) {
    return {
      cause: `ถูกแทง/ฟันด้วย${weapon.name}ที่ชายโครงหนึ่งครั้ง เสียเลือดจนเสียชีวิตภายในไม่กี่นาที`,
      body: `${victim.nickname}นอนตะแคงอยู่ มีบาดแผลลึกที่ชายโครงและคราบเลือดแห้งเป็นวงกว้างใต้ตัว`,
    };
  }
  if (/เชือก|ม่าน|ชูชีพ|ผ้า/.test(t)) {
    return {
      cause: `ถูกรัดคอจากด้านหลังด้วย${weapon.name}จนขาดอากาศ`,
      body: `${victim.nickname}นอนหงาย มีรอยรัดเป็นเส้นรอบลำคอ และปลายนิ้วมีรอยถลอกราวกับพยายามดึงอะไรออก`,
    };
  }
  return {
    cause: `ถูกตีที่ท้ายทอยด้วย${weapon.name}จากด้านหลัง ล้มลงและไม่ได้สติอีกเลย`,
    body: `${victim.nickname}นอนคว่ำหน้า มีรอยช้ำและแผลแตกที่ท้ายทอย เลือดไหลเป็นทางสั้น ๆ`,
  };
}

// ctx: { location, characters:[{id,name,nickname,ultimate:{title,hidden,...},fakeRole,fakeUltimate,...}], murdererId, targetId, round }
export function mockIncident(ctx) {
  const { location, characters, murdererId, targetId } = ctx;
  const byId = Object.fromEntries(characters.map((c) => [c.id, c]));
  const others = characters.filter((c) => c.id !== murdererId && c.id !== targetId);

  // เลือกเหยื่อ: ส่วนใหญ่เป็นเป้าหมาย บางครั้งฆาตกรเองหรือคนนอก
  let victimId;
  const r = Math.random();
  if (r < 0.6 || !others.length) victimId = targetId;
  else if (r < 0.75) victimId = murdererId;
  else victimId = pick(others).id;

  // เลือกคนร้ายตัวจริง (ต้องยังมีชีวิตและไม่ใช่เหยื่อ)
  let culpritId;
  const candidates = characters.filter((c) => c.id !== victimId);
  if (victimId === targetId) culpritId = chance(0.8) ? murdererId : pick(candidates).id;
  else if (victimId === murdererId) culpritId = chance(0.7) ? targetId : pick(candidates).id;
  else culpritId = chance(0.6) ? murdererId : pick(candidates).id;
  if (culpritId === victimId) culpritId = pick(candidates).id;

  const victim = byId[victimId];
  const culprit = byId[culpritId];
  const murderer = byId[murdererId];
  const target = byId[targetId];
  // เว้นวรรคหลังโซนที่ลงท้ายด้วยตัวเลข/อักษรละติน ("ชั้น 2" + "ตอน" → "ชั้น 2 ตอน")
  const sp = (s) => (/[0-9A-Za-z]$/.test(s) ? `${s} ` : s);
  const items = shuffle(location.items).map((i) => ({ ...i, where: sp(i.where) }));
  const zones = zonesOf(items);
  const culpritUlt = culprit.ultimate?.title || '';

  // อุปกรณ์ประกอบคดี (จับคู่จาก "ชื่อ" เท่านั้น เพื่อไม่ให้คำในคำบรรยาย เช่น "ห้องพยาบาล" ทำให้ขวานกลายเป็นสารเคมี)
  // ของที่ไม่มีในสถานที่นี้เป็น null → กลไกของ Ultimate ที่ต้องใช้ของชิ้นนั้นจะใช้ไม่ได้
  const byName = (re) => items.find((i) => re.test(i.name)) || null;
  const chem = byName(/เคมี|ตู้ยา|ชุดยา|ยาจาก|ยาพิษ|ยาเบื่อ|พิษ|ตัวอย่างสัตว์|ออกซิเจน/);
  const key = byName(/กุญแจ|คีย์การ์ด/);
  const power = byName(/ไฟ|เบรกเกอร์|ฟิวส์|ควบคุม/);
  const camera = byName(/กล้องวงจรปิด|ควบคุมกล้อง|มอนิเตอร์/);
  const cloth = byName(/ผ้า|ม่าน|เสื้อ|ชูชีพ/) || { name: 'ผ้าขนหนูจากห้องน้ำ', where: 'ห้องน้ำ' };
  const utility = new Set([chem, key, power, camera, cloth].filter(Boolean));
  // ของติดตั้งถาวร (อ่าง สระ ตู้ เครื่องจักร) ใช้เป็นอาวุธพกพาหรือหลักฐานที่ "ถูกย้าย" ไม่ได้
  const fixture = /อ่าง|สระ|น้ำพุ|เครื่องทำ|เครื่องปั่น|เครื่องจักร|เครื่องยนต์|ตู้|แผง|ระบบ|ลิฟต์|หน้าต่าง|นาฬิกา|ลำโพง|หุ่น|สวน|เปียโน|ห้อง|ประตู|ปั่นไฟ|เบรกเกอร์|ฟิวส์|กล้องวงจรปิด|บันได/;
  const portable = items.filter((i) => !utility.has(i) && !fixture.test(i.name));
  const weaponish = portable.filter((i) => /ขวาน|มีด|ฉมวก|เทียน|ถ้วยรางวัล|ไม้|ประแจ|เชือก|ปืน|ถัง|ฟืน|สกี|เบสบอล/.test(i.name));
  const poisonCulprit = culpritUlt === 'สุดยอดพยาบาล' || culpritUlt === 'สุดยอดนักเคมี';
  let weapon;
  if (culpritUlt === 'สุดยอดพยาบาล' && chem) weapon = chem;
  else if (poisonCulprit && chem && chance(0.5)) weapon = chem;
  else weapon = weaponish[0] || portable[0] || items.find((i) => !utility.has(i)) || items[0];
  const redHerring =
    portable.find((i) => i !== weapon) ||
    items.find((i) => i !== weapon && i !== cloth && !fixture.test(i.name)) ||
    items.find((i) => i !== weapon) ||
    items[0];
  const sceneCands = items.filter((i) => i !== weapon && i !== redHerring);
  const scene = sceneCands.find((i) => !/ทุกชั้น|ทุกมุม/.test(i.where)) || sceneCands[0] || weapon;

  // คนรอบข้าง: หลักฐานลวง (คนบริสุทธิ์ที่ตำแหน่งดูน่าสงสัย), พยานต่าง ๆ, คู่ที่ยืนยันกันเอง
  const bystanders = shuffle(characters.filter((c) => c.id !== culpritId && c.id !== victimId));
  const preferred = bystanders.filter((c) => c.id !== murdererId && c.id !== targetId);
  const pool = preferred.length >= 2 ? preferred : bystanders;
  const redHerringPerson = pool[0] || null;
  const alibiWitness = pool[1] || bystanders.find((c) => c !== redHerringPerson) || null;
  // เกมเล็กมาก (3 คน) อาจมีคนนอกแค่คนเดียว → คนนั้นเป็นทั้งหลักฐานลวงและพยานของจุดอ่อนคนร้าย
  const bedWitness = pool[2] || bystanders.find((c) => c !== redHerringPerson && c !== alibiWitness) || alibiWitness || redHerringPerson || null;
  const pair = pool.length >= 5 ? [pool[3], pool[4]] : null;
  const decoyPerson = redHerringPerson || bystanders[0] || murderer;

  // วิธีการ: ใช้ Ultimate ได้เฉพาะเมื่อมีกลไกจริง และถึงมีก็ไม่จำเป็นต้องใช้เสมอไป
  const k = { weapon, scene, key, chem, power, camera, cloth, redHerring, victim, decoyPerson, zones };
  const ultMethod = ultimateMethod(culpritUlt, k);
  const useUltimate = !!ultMethod && chance(0.75);
  const base = useUltimate ? ultMethod : ordinaryMethod(k);
  const cb = base.cause ? { cause: base.cause, body: base.body } : causeFor(weapon, victim, weapon === chem);
  const method = {
    cause: cb.cause,
    concealment: base.concealment,
    concealmentTrace: base.trace,
    usedUltimate: useUltimate,
    ultimateUse: useUltimate ? `${culpritUlt}: ${base.use}` : '',
  };

  // ตำแหน่งของทุกคน: "ความจริง" ที่เจ้าตัวเท่านั้นรู้ + "เหตุการณ์" ที่รู้เฉพาะคนที่อยู่ด้วยหรือเห็นเอง (ไม่มีอะไรที่ทุกคนรู้)
  const rhZone = pick(zones.filter((z) => z !== scene.where)) || scene.where;
  const pairZone = pick(zones.filter((z) => z !== scene.where && z !== rhZone)) || rhZone;
  const rhReason = pick(['ออกไปสูบบุหรี่', 'ไปหาของกินเพราะหิว', 'เดินแก้เครียดเพราะนอนไม่หลับ', 'ไปตามหาของที่ลืมไว้']);
  const inPair = (c) => !!pair && (c === pair[0] || c === pair[1]);
  const sighter = pool.find((c) => c !== redHerringPerson && c !== alibiWitness && c !== bedWitness && !inPair(c)) || bedWitness || alibiWitness || null;
  const extraObserver = bystanders.find((c) => c !== bedWitness && c !== redHerringPerson && !inPair(c)) || null;
  const bw = bedWitness?.nickname || 'ใครบางคน';
  const weakness = pick([
    {
      obs: `${bw}ตื่นขึ้นมาราวตีสอง เห็นเตียงของ${culprit.nickname}ว่าง และยังว่างอยู่นานกว่ายี่สิบนาที`,
      knownBy: [bedWitness],
      short: `เตียงว่างตอนตีสองนานกว่าจะเข้าห้องน้ำ (${bw}เห็น)`,
      culpritHint: `ตอนคุณย่องกลับเข้ามา คุณรู้สึกเหมือนมีคนพลิกตัวบนเตียงฝั่ง${bw} แต่ไม่แน่ใจว่าเขาตื่นหรือเปล่า`,
    },
    {
      obs: `ตอนเช้า ${bw}${extraObserver ? `กับ${extraObserver.nickname}` : ''}สังเกตว่ารองเท้าของ${culprit.nickname}มีคราบ${/ยา|พิษ|เคมี/.test(weapon.name) ? 'ของเหลว' : 'ฝุ่นจาก' + scene.where}ติดอยู่ ทั้งที่เมื่อคืนเข้านอนพร้อมทุกคน`,
      knownBy: [bedWitness, extraObserver],
      short: `รองเท้ามีคราบจาก${scene.where}ทั้งที่เข้านอนพร้อมทุกคน (${bw}สังเกตเห็น)`,
      culpritHint: `คุณไม่แน่ใจว่าเช็ดรองเท้าสะอาดพอหรือยัง และตอนเช้ามีคนมองรองเท้าคุณนานผิดปกติ`,
    },
    {
      obs: `${bw}เห็น${culprit.nickname}เดินกลับมาจากทาง${scene.where}ตอนใกล้สว่าง มือเปียกและสั่นเล็กน้อย`,
      knownBy: [bedWitness],
      short: `ถูกเห็นเดินกลับมาจากทาง${scene.where}ตอนใกล้สว่าง ซึ่งไม่มีเหตุผลต้องไปตรงนั้น`,
      culpritHint: `ตอนเดินกลับใกล้สว่าง คุณเหมือนเห็นใครบางคนลืมตาอยู่ แต่มืดเกินกว่าจะแน่ใจว่าใคร`,
    },
  ]);

  // พยานรายย่อย (คำนวณก่อน เพื่อให้ "ความจริง" ของแต่ละคนสอดคล้องกับเหตุการณ์ที่เขาเห็น)
  const casual = shuffle(bystanders.filter((c) => c !== bedWitness && c !== redHerringPerson && c !== sighter && c !== alibiWitness && !inPair(c)));
  const tiredWitness = murdererId !== culpritId && murdererId !== victimId && casual[0] && casual[0].id !== murdererId && chance(0.6) ? casual[0] : null;
  const returnWitness = targetId !== culpritId && targetId !== victimId && targetId !== murdererId ? casual.find((c) => c.id !== targetId && c !== tiredWitness) || null : null;
  const voiceWitness = useUltimate && culpritUlt === 'สุดยอดนักแสดง' ? casual.find((c) => c !== decoyPerson && c !== tiredWitness && c !== returnWitness) || sighter || bedWitness : null;

  const whereabouts = characters.map((c) => {
    if (c.id === victimId) return { characterId: c.id, where: `ออกไปที่${scene.where}ราวตีสอง และเสียชีวิตที่นั่น` };
    if (c.id === culpritId) {
      return {
        characterId: c.id,
        where: `แอบออกจากที่นอนราวตีสอง ไปที่${scene.where} ลงมือกับ${victim.nickname} ${method.concealment} แล้วกลับมานอนก่อนสว่าง`,
      };
    }
    if (redHerringPerson && c.id === redHerringPerson.id) {
      return { characterId: c.id, where: `${rhReason}ที่${rhZone}ตอนตีหนึ่ง อยู่คนเดียวราวครึ่งชั่วโมงแล้วกลับมานอน ไม่ได้เข้าใกล้${scene.where}เลย` };
    }
    if (inPair(c)) {
      const other = c === pair[0] ? pair[1] : pair[0];
      return { characterId: c.id, where: `นั่งคุยกับ${other.nickname}ที่${pairZone}ตั้งแต่ก่อนเที่ยงคืนจนราวตีสาม แล้วกลับไปนอนพร้อมกัน` };
    }
    if (c.id === murdererId) return { characterId: c.id, where: `พก${weapon.name}ไปดักรอ${target.nickname}ที่${weapon.where} แต่ไม่ได้ลงมือ` };
    if (c.id === targetId) return { characterId: c.id, where: `รู้สึกว่ามีคนตามจึงไปซ่อนตัวอยู่ที่${rhZone}พักใหญ่ แล้วกลับมานอนตอนตีสามกว่า` };
    if (bedWitness && c.id === bedWitness.id) return { characterId: c.id, where: `หลับ ๆ ตื่น ๆ อยู่ที่ที่นอนทั้งคืน ตื่นมาราวตีสองครั้งหนึ่ง` };
    if (redHerringPerson && alibiWitness && c === alibiWitness) return { characterId: c.id, where: `นอนไม่หลับเลยออกมาเดินแถว${rhZone}ตอนตีหนึ่ง เจอ${redHerringPerson.nickname}ที่นั่น แล้วกลับไปนอน` };
    if (redHerringPerson && sighter && c === sighter) return { characterId: c.id, where: `ตื่นมาเข้าห้องน้ำตอนตีหนึ่ง เห็น${redHerringPerson.nickname}เดินออกไปทาง${rhZone} แล้วกลับไปนอน` };
    if (returnWitness && c === returnWitness) return { characterId: c.id, where: `สะดุ้งตื่นตอนตีสามกว่า เห็น${target.nickname}กลับมาที่ที่นอน แล้วหลับต่อ` };
    if (voiceWitness && c === voiceWitness) return { characterId: c.id, where: `สะลึมสะลือตอนตีสอง ได้ยินเสียงใครสักคนเรียกชื่อ${victim.nickname} แล้วหลับต่อ` };
    return { characterId: c.id, where: 'หลับอยู่ที่ที่นอนทั้งคืน ไม่ได้ยินอะไรเลย' };
  });

  // เหตุการณ์ย่อย: รู้เฉพาะคนที่อยู่ในเหตุการณ์นั้น
  const observations = [];
  const addObs = (knownBy, text) => {
    const ids = [...new Set(knownBy.filter(Boolean).map((c) => c.id))].filter((id) => id !== victimId);
    if (ids.length && text) observations.push({ knownBy: ids, text });
  };
  addObs(weakness.knownBy, weakness.obs);
  if (redHerringPerson) {
    if (sighter && sighter !== redHerringPerson) addObs([sighter], `${sighter.nickname}เห็น${redHerringPerson.nickname}เดินออกไปทาง${rhZone}ตอนตีหนึ่ง และกว่าจะกลับมาก็นานผิดปกติ`);
    if (alibiWitness && alibiWitness !== redHerringPerson) {
      addObs([alibiWitness, redHerringPerson], `${alibiWitness.nickname}นอนไม่หลับเลยออกมาเดิน และเห็น${redHerringPerson.nickname}${rhReason}อยู่คนเดียวที่${rhZone}ตอนตีหนึ่ง ทั้งคู่พยักหน้าให้กันก่อน${redHerringPerson.nickname}เดินกลับไปนอน`);
    }
  }
  if (pair) addObs(pair, `${pair[0].nickname}กับ${pair[1].nickname}นั่งคุยกันที่${pairZone}ตั้งแต่ก่อนเที่ยงคืนจนราวตีสาม แล้วแยกย้ายกลับไปนอนพร้อมกัน`);
  if (tiredWitness) addObs([tiredWitness], `${tiredWitness.nickname}สังเกตว่า${murderer.nickname}ตาแดงก่ำและมือสั่นตอนเช้า เหมือนไม่ได้นอนทั้งคืน`);
  if (returnWitness) addObs([returnWitness, target], `${returnWitness.nickname}เห็น${target.nickname}กลับมาที่ที่นอนตอนตีสามกว่าในสภาพเสื้อผ้ายับและเหงื่อท่วม`);
  if (voiceWitness) addObs([voiceWitness], `${voiceWitness.nickname}สะลึมสะลือได้ยินเสียงคล้าย${decoyPerson.nickname}เรียกชื่อ${victim.nickname}เบา ๆ ตอนตีสอง`);

  // เบาะแสส่วนตัว (สิ่งที่รับรู้คนเดียว)
  const privateClues = [];
  const used = new Set();
  const add = (c, clue) => {
    if (!c || used.has(c.id) || c.id === culpritId || c.id === victimId) return;
    used.add(c.id);
    privateClues.push({ characterId: c.id, clue });
  };
  if (redHerringPerson) {
    add(redHerringPerson, `ตอนที่คุณ${rhReason}อยู่ที่${rhZone} คุณได้ยินเสียง${/ยา|พิษ/.test(method.cause) ? 'แก้วกระทบกัน' : 'ของหนักตกดังโครม'}จากทาง${scene.where} แต่คิดว่าเป็นเสียงลม`);
  }
  if (murdererId !== culpritId && murdererId !== victimId) {
    add(
      murderer,
      `คืนนี้คุณแอบไปดักรอ${target.nickname}ที่${weapon.where}โดยพก${weapon.name}ไปด้วย แต่ก่อนจะลงมือ คุณได้ยินเสียงผิดปกติจากทาง${scene.where} และเห็นว่ามีบางอย่างเกิดขึ้นก่อนหน้าคุณแล้ว คุณจึงรีบหนีกลับที่นอน`,
    );
  }
  if (targetId !== culpritId && targetId !== victimId && targetId !== murdererId) {
    add(target, `คืนนี้คุณรู้สึกเหมือนมีใครสะกดรอยตามคุณไปจนถึง${weapon.where} คุณวิ่งหนีไปซ่อนที่${rhZone}อยู่พักใหญ่ ระหว่างนั้นได้ยินเสียงกรีดร้องสั้น ๆ จากทาง${scene.where}`);
  }
  for (const c of bystanders) {
    if (privateClues.length >= 4) break;
    add(c, pick([
      `คุณเห็นเงาคนเดินผ่านไปทาง${scene.where}ราวตีสอง มองไม่เห็นหน้า แต่เงานั้นเดินตรงไปโดยไม่ลังเลเหมือนรู้ทางดี`,
      `คุณสังเกตว่า${redHerring.name}ถูกย้ายไปจากที่เดิมตั้งแต่ก่อนทุกคนเข้านอน แต่ตอนเช้ามันไปอยู่ใกล้ศพ`,
      `คุณได้ยินเสียงคนสองคนพูดกันเบา ๆ ใกล้${scene.where} หนึ่งในนั้นเสียงคล้าย${victim.nickname} อีกเสียงเบามากจนจับไม่ได้ว่าเป็นใคร`,
      `ตอนตีสองกว่า ๆ คุณได้ยินเสียง${/ไฟ|สวิตช์|เบรกเกอร์/.test(method.concealment) ? 'คลิกเหมือนสวิตช์' : 'ประตูปิดเบา ๆ'}จากทาง${scene.where}`,
    ]));
  }

  // สัญชาตญาณจาก Ultimate (เฉพาะคนที่กลไกของ Ultimate ทำให้รู้มากกว่าจริง ๆ)
  const insightMap = {
    'สุดยอดนักสืบ': `คุณสังเกตว่า${method.concealmentTrace} นี่ไม่ใช่เรื่องบังเอิญ แต่เป็นการปกปิดโดยตั้งใจ และ${redHerring.name}ใกล้ศพถูกวางทีหลัง`,
    'สุดยอดนักนิติเวช': `${victim.nickname}ตายราวตีสอง ไม่ใช่ตอนที่พบศพ และสาเหตุจริงคือ${method.cause}`,
    'สุดยอดพยาบาล': `ลักษณะบาดแผล/อาการบอกคุณว่าเกิดจาก${weapon.name} ไม่ใช่${redHerring.name}อย่างที่คนอื่นอาจคิด`,
    'สุดยอดช่างไฟ': /ไฟ|สวิตช์|เบรกเกอร์|มืด/.test(method.concealment)
      ? `${power?.name || 'สวิตช์ไฟ'}ถูกสับด้วยมือคนไม่ใช่ไฟตก คนที่ทำต้องรู้ว่าสวิตช์ตัวไหนคุมโซน${scene.where}`
      : `${power?.name || 'แผงไฟ'}ไม่ถูกแตะต้องเลยคืนนี้ แปลว่าคนร้ายไม่ได้อาศัยความมืด ใครที่อ้างว่าโซน${scene.where}มืดจนมองไม่เห็นกำลังพูดไม่จริง`,
    ...(camera
      ? { 'สุดยอดแฮกเกอร์': `คุณเช็ก${camera.name}: ${/กล้อง|บันทึก/.test(method.concealment) ? 'บันทึกช่วงตีสองถูกลบโดยคนที่เข้าระบบได้โดยไม่ใช้รหัส' : `ช่วงตีสองมีคนเดินเข้า${scene.where}เพียงคนเดียวและออกมาราวยี่สิบนาทีต่อมา`}` }
      : {}),
    'สุดยอดนักเคมี': chem && /น้ำยา|สาร|เคมี|ยา|พิษ/.test(method.concealmentTrace + method.cause)
      ? `กลิ่นที่${scene.where}คือสารที่ผสมจาก${chem.name} ไม่ใช่สารทำความสะอาดทั่วไป คนผสมต้องรู้สูตร`
      : `คุณได้กลิ่นเหงื่อและเหล็กจาง ๆ บน${weapon.name} แปลว่ามันถูกจับด้วยมือเปล่าเมื่อไม่กี่ชั่วโมงก่อน`,
    'สุดยอดสายลับ': `คุณแอบเห็นคนหนึ่งเดินออกจาก${scene.where}ตอนตีสอง มืดจนไม่เห็นหน้า แต่ท่าเดินคล้าย${culprit.nickname} คุณไม่แน่ใจนัก`,
    'สุดยอดนักจิตวิทยา': `เช้านี้มีคนหนึ่งที่สีหน้านิ่งผิดปกติเวลาพูดถึง${victim.nickname} และหลบตาเมื่อมีคนพูดถึง${scene.where}`,
  };
  const ultimateInsights = characters
    .filter((c) => c.id !== culpritId && c.id !== victimId && insightMap[c.ultimate?.title])
    .map((c) => ({ characterId: c.id, insight: insightMap[c.ultimate.title] }));

  const involved = new Set([culpritId, murdererId, targetId, ...ultimateInsights.map((u) => u.characterId)]);

  const culpritStory = [
    `คืนนี้${culprit.nickname}คือคนที่ทำให้${victim.nickname}ตาย`,
    culpritId === murdererId
      ? `คุณถูกเลือกให้เป็นฆาตกรและตั้งใจกำจัด${target.nickname} คุณพก${weapon.name}ไปดักรอที่${weapon.where}`
      : `คุณไม่ได้วางแผนมาก่อน แต่สถานการณ์ที่${murderer.nickname}สร้างขึ้นในคืนนี้ทำให้คุณต้องลงมือ`,
    victimId === targetId
      ? `${victim.nickname}เดินมาถึงพอดี ${method.cause}`
      : victimId === murdererId
        ? `${murderer.nickname}เข้ามาทำร้าย${target.nickname}ด้วย${weapon.name} แต่เกิดการต่อสู้ และสุดท้าย${murderer.nickname}กลับเป็นฝ่ายตาย: ${method.cause}`
        : `${victim.nickname}บังเอิญมาเห็นเหตุการณ์ คุณจึงปิดปาก: ${method.cause}`,
    `จากนั้นคุณ${method.concealment}`,
    useUltimate ? `ความสามารถของคุณช่วยได้จริง: ${base.use}` : `คุณไม่ได้ใช้ Ultimate เลย ทุกอย่างทำด้วยมือเปล่าและความใจเย็น`,
    `ร่องรอยที่คุณทิ้งไว้: ${method.concealmentTrace}`,
    `จุดที่คุณอาจพลาด: ${weakness.culpritHint} — ไม่มีใครรู้ทุกอย่าง แต่ถ้าทุกคนเอาสิ่งที่เห็นมาต่อกัน คุณอาจถูกจับได้ เตรียมคำอธิบายไว้`,
  ].join(' ');

  const deductionChain = [
    `สาเหตุการตายจริง: ${method.cause} → อาวุธคือ${weapon.name} (อยู่ที่${weapon.where}) ไม่ใช่${redHerring.name}ที่ถูกวางไว้ใกล้ศพ`,
    `ร่องรอยการปกปิด: ${method.concealmentTrace} → คนทำต้องเป็น${base.narrowing}`,
    `เมื่อทุกคนเล่าสิ่งที่ตัวเองเห็น: ${redHerringPerson && sighter && sighter !== redHerringPerson ? `${sighter.nickname}เห็น${redHerringPerson.nickname}ออกไปทาง${rhZone}ตอนตีหนึ่ง และ` : ''}${weakness.short} → ผู้ต้องสงสัยคือ${redHerringPerson ? ` ${redHerringPerson.nickname} กับ` : ''} ${culprit.nickname}${pair ? ` ส่วน${pair[0].nickname}กับ${pair[1].nickname}ยืนยันกันเอง` : ''}`,
    ...(redHerringPerson && alibiWitness && alibiWitness !== redHerringPerson
      ? [`${redHerringPerson.nickname}มีพยาน: ${alibiWitness.nickname}เห็นเขา${rhReason}ที่${rhZone}จริง → ตัดออกได้`]
      : []),
    `เหลือ${culprit.nickname}: ${weakness.short} → ${culprit.nickname}คือคนร้าย`,
  ];

  const truthSummary = `${culprit.name} (${culpritUlt || 'ไม่ทราบ Ultimate'}) คือคนร้ายตัวจริง ${method.cause} ที่${scene.where} ปกปิดโดย${method.concealment} ซึ่งทิ้งร่องรอยคือ${method.concealmentTrace} ${redHerring.name}ใกล้ศพ${redHerringPerson ? `และการหายตัวไปของ${redHerringPerson.nickname}` : ''}เป็นเพียงหลักฐานลวง ฆาตกรที่ระบบเลือกคืนนี้คือ${murderer.name} และเป้าหมายคือ${target.name}`;

  const discoverer = bystanders[0] || murderer;
  return {
    title: pick(['คดีกลางสายหมอก', 'เสียงกรีดร้องตอนตีสอง', 'รอยเท้าที่หายไป', 'ศพในความเงียบ', 'คืนที่ไม่มีใครหลับ', 'เตียงที่ว่างเปล่า']),
    victimId,
    culpritId,
    method,
    whereabouts,
    observations,
    publicReport: {
      discovery: `เช้ามืด ${discoverer.nickname}พบศพของ${victim.nickname}ที่${scene.where} และตะโกนเรียกทุกคนมารวมตัว`,
      bodyState: cb.body,
      suspiciousItems: [
        { itemId: weapon.id, observation: `${weapon.name}ถูกวางไว้ผิดที่ และดูสะอาดผิดปกติเหมือนเพิ่งถูกเช็ด` },
        { itemId: redHerring.id, observation: `${redHerring.name}ตกอยู่ใกล้ศพ มีรอยเปื้อนแปลก ๆ` },
        ...(key && method.concealmentTrace.includes(key.name) ? [{ itemId: key.id, observation: `${key.name}ห้อยกลับด้านจากที่เคยเห็นตอนกลางวัน` }] : []),
        ...(chem && chem !== weapon && method.concealmentTrace.includes(chem.name) ? [{ itemId: chem.id, observation: `${chem.name}ถูกเปิดใช้และจัดเรียงใหม่` }] : []),
        ...(power && method.concealmentTrace.includes(power.name) ? [{ itemId: power.id, observation: `${power.name}มีรอยนิ้วมือใหม่บนสวิตช์` }] : []),
      ],
      sceneNotes: `${method.concealmentTrace} นอกจากนี้ประตูของ${scene.where}เปิดแง้มอยู่ทั้งที่ปกติจะปิดสนิท`,
    },
    privateClues,
    ultimateInsights,
    culpritStory,
    involvedCharacterIds: [...involved],
    deductionChain,
    truthSummary,
  };
}
