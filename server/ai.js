// AI module — ใช้ Claude API (Anthropic SDK) เจน Ultimate / สถานที่ / คำบรรยายคดี / อีเวนต์คืนชีพ
// ถ้าไม่มี API key หรือเรียกไม่สำเร็จ จะ fallback ไปใช้ mock.js อัตโนมัติ
// กลไกเกม (ใครอยู่ไหน ใครฆ่าใคร สำเร็จหรือพลาด) คำนวณใน game.js — AI มีหน้าที่ "บรรยาย" ข้อเท็จจริงเหล่านั้นให้สมจริงเท่านั้น
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { mockUltimates, mockLocation, mockReviveEvent, mockNarrateCase, extraRooms, TRAIT_KEYS } from './mock.js';
import { isConductive, tagsOf, roomCountFor } from './rules.js';

const UltimatesSchema = z.object({
  ultimates: z.array(
    z.object({
      characterId: z.string(),
      title: z.string().describe('ชื่อ Ultimate ภาษาไทย ขึ้นต้นด้วย "สุดยอด"'),
      description: z.string().describe('คำอธิบายความสามารถ 1-2 ประโยค'),
      hidden: z.boolean().describe('true ถ้ามีผลต่อการสืบสวนคดี หรือเพิ่ม/ลดความเชื่อใจของผู้คน (ระบบจะเลือกซ่อนจริงแค่บางคน)'),
      hiddenReason: z.string().describe('เหตุผลสั้น ๆ ว่าทำไมถึงควรซ่อน (ว่างได้ถ้าไม่ซ่อน)'),
      investigationEffect: z.string().describe('ผลต่อคดีฆาตกรรม 1 ประโยค หรือ "ไม่มีผลโดยตรง"'),
      trait: z.enum(TRAIT_KEYS).describe('สายความสามารถที่มีผลกับแอ็กชันในเกม: porter (นักแบก/นักเดินป่า/คนส่งของ → ถือของได้ 5 ชิ้น), combat (สู้/ป้องกันตัว), stealth (ขโมย/ซ่อนหลักฐาน), medical (ตรวจศพ/ยา), tech (ตัดไฟ/กล้อง), social (ซักถาม), detective (ค้นหาเก่ง), none'),
      decoyTitle: z.string().describe('Ultimate "ฉากบังหน้า" ที่ดูไม่มีพิษภัยและเข้ากับตัวละคร ใช้เมื่อระบบสุ่มให้คนนี้ได้โรลปลอม ห้ามซ้ำกับ title ของใคร'),
      decoyDescription: z.string().describe('คำอธิบายของ decoyTitle 1 ประโยค'),
    }),
  ),
});

const LocationSchema = z.object({
  name: z.string(),
  description: z.string().describe('บรรยากาศ 2-3 ประโยค และบอกว่าทำไมออกไปไม่ได้'),
  exits: z
    .array(
      z.object({
        name: z.string().describe('ชื่อทางออก เช่น "ประตูเหล็กด้านหลัง" "ลิฟต์ขนของ" "เรือยนต์ที่ท่า"'),
        description: z.string().describe('บรรยาย 1-2 ประโยค ว่าทางออกนี้คืออะไร และทำไมถึงยังออกไม่ได้'),
        zoneName: z.string().describe('ชื่อห้อง (ตรงกับ zones[].name) ที่ทางออกนี้ซ่อนอยู่ ห้ามเป็นห้องแรก'),
        route: z.enum(['locked', 'code', 'repair', 'power', 'breach']).describe('วิธีเปิด: locked=ต้องหากุญแจ, code=แป้นรหัส 3 หลัก (ระบบซ่อนเศษรหัส 3 ชิ้น), repair=ต้องหาชิ้นส่วน 2 ชิ้น+เครื่องมือ, power=ต้องเอาฟิวส์ไปใส่แผงไฟก่อน, breach=ทุบ/งัดด้วยของหนัก'),
        itemNames: z.array(z.string()).describe('ชื่อของที่ต้องใช้: locked → [ชื่อกุญแจ], repair → [ชิ้นส่วน 2 ชื่อ], power → [ชื่อฟิวส์], code/breach → []'),
      }),
    )
    .describe('ทางออกที่เป็นไปได้ 4-5 ทาง route ไม่ซ้ำกัน (ระบบจะสุ่มใช้ 2 ทางต่อเกม)'),
  zones: z.array(
    z.object({
      name: z.string(),
      description: z.string().describe('บรรยายห้อง 1 ประโยค'),
      items: z.array(
        z.object({
          name: z.string(),
          description: z.string().describe('1 ประโยค บอกใบ้ว่าใช้ทำอะไรได้'),
          kind: z
            .enum(['weapon', 'poison', 'tool', 'rope', 'food', 'lockpick', 'key', 'cloth', 'power', 'fixture', 'medicine'])
            .describe('medicine=ยาบำรุง/ยารักษา (ชื่อมีคำว่า บำรุง/วิตามิน หรือ ยาแก้/ยารักษา — ผสมอาหารแล้วคนกินได้บัฟ), weapon=อาวุธ, poison=ยา/สารพิษ, tool=เครื่องมือ/ของหนัก, rope=เชือก/สายไฟ/เทป (ใช้ประกอบกับดัก), food=อาหาร/เครื่องดื่มกลางห้อง (กินได้ วางยาได้ ไม่ใช่ของพกพา), lockpick=ที่สะเดาะกุญแจ/ชุดไขควงช่างกุญแจ (ใช้สะเดาะกลอนประตูห้องที่ล็อก ใส่ 1 ชิ้น), key=ห้ามใช้ (ระบบสร้างกุญแจประจำห้องให้เอง), cloth=ผ้า, power=แผงไฟ/กล้อง (ติดตั้งถาวร ใช้ตัดไฟ/ใส่ฟิวส์), fixture=ของติดตั้งถาวรอื่น ๆ'),
        }),
      ),
    }),
  ),
});

const NarrativeSchema = z.object({
  title: z.string().describe('ชื่อคดีสั้น ๆ น่าสนใจ'),
  bodyState: z.string().describe('สภาพศพ (ใช้เป็นเฉลยหลังตัดสินเท่านั้น ระหว่างเกมผู้เล่นต้องตรวจศพเอง) 2-3 ประโยค สอดคล้องกับสาเหตุการตายที่ให้มา ห้ามเอ่ยชื่อหรือบอกใบ้คนร้าย'),
  sceneNotes: z.string().describe('ความผิดปกติรอบศพ (เฉลยหลังตัดสิน) 1-2 ประโยค สอดคล้องกับข้อเท็จจริง (ถูกย้าย/เลอะเทอะ/เรียบร้อย) ห้ามบอกใบ้คนร้าย'),
  truthSummary: z.string().describe('สรุปความจริงทั้งหมด 2-4 ประโยคสำหรับเฉลยหลังตัดสิน: ใครทำ อย่างไร ที่ไหน วันไหน'),
});

const ReviveSchema = z.object({
  title: z.string().describe('ชื่ออีเวนต์สั้น ๆ'),
  story: z.string().describe('เรื่องราวที่ทุกคนรับรู้ 3-6 ประโยค อธิบายว่าทำไมถึงไม่ได้ตายจริง'),
  privateNote: z.string().describe('ข้อความส่วนตัวถึงผู้ที่ฟื้น 1-3 ประโยค เล่าสิ่งที่จำได้'),
});

const SYSTEM_PROMPT = `คุณคือ "Game Master" ของบอร์ดเกมสืบสวนฆาตกรรมแนว social deduction ภาษาไทย
ผู้เล่นแต่ละคนรับบทตัวละครที่มี "Ultimate" (ความสามารถสุดยอดเฉพาะตัว) และถูกขังอยู่ในสถานที่ปิดตายที่มีหลายห้อง
ผู้เล่นสำรวจห้อง หาของสำหรับหนี ทำภารกิจลับ และบางคนอาจลงมือฆ่า — กลไกทั้งหมดคำนวณโดยระบบ คุณมีหน้าที่เขียนบรรยายให้สมจริง

กติกาการเขียนของคุณ:
- เขียนทุกอย่างเป็นภาษาไทยที่อ่านลื่น ใช้ชื่อเล่นของตัวละครเป็นหลัก
- ต้องเป็นเนื้อหาออริจินัล ห้ามอ้างอิงชื่อตัวละคร สถานที่ หรือ Ultimate จากเกม/อนิเมะที่มีอยู่จริง
- ความรุนแรงระดับ PG-13: บรรยายสภาพศพได้แต่ไม่โหดเลือดสาดเกินจำเป็น
- ทุกอย่างต้องสมจริงทางกายภาพ Ultimate ไม่ใช่เวทมนตร์
- ตอบเป็น JSON ตาม schema ที่กำหนดเท่านั้น`;

function fmtCharacter(c) {
  const tags = [];
  if (c.ultimate?.hidden) tags.push('ซ่อนจากคนอื่น (เห็นเป็น ???)');
  if (c.fakeRole && c.fakeUltimate) tags.push(`โรลปลอม: คนอื่นเข้าใจว่าเป็น "${c.fakeUltimate.title}"`);
  const ult = c.ultimate ? `Ultimate: ${c.ultimate.title}${tags.length ? ` [${tags.join(' | ')}]` : ''} — ${c.ultimate.description}` : '';
  return `- id=${c.id} | ${c.name} (ชื่อเล่น: ${c.nickname}) | ${c.gender} อายุ ${c.age} | รูปลักษณ์: ${c.appearance} | นิสัย: ${c.personality}${ult ? ' | ' + ult : ''}`;
}

export function createAI({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  forceMock = process.env.AI_MODE === 'mock',
  log = console,
} = {}) {
  let client = null;
  let mode = 'mock';
  let lastError = null;

  if (!forceMock) {
    try {
      client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
      mode = 'claude';
    } catch (err) {
      log.warn('[ai] ไม่พบ credentials ของ Anthropic → ใช้โหมด mock', err?.message || err);
      client = null;
    }
  }

  // ตรวจ credentials ตอนเริ่มระบบด้วย request ที่ไม่เสียโทเค็น ถ้า auth ไม่ผ่านให้สลับเป็น mock ทันที
  const ready = (async () => {
    if (mode !== 'claude') return;
    try {
      await client.models.list({ limit: 1 });
      log.info(`[ai] เชื่อมต่อ Claude สำเร็จ (model ${model})`);
    } catch (err) {
      const msg = err?.message || String(err);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || /api key|auth/i.test(msg)) {
        log.warn(`[ai] ใช้ Claude ไม่ได้ (${msg}) → ใช้โหมด mock`);
        mode = 'mock';
        lastError = msg;
      } else {
        log.warn(`[ai] ตรวจสอบการเชื่อมต่อ Claude ไม่สำเร็จ (${msg}) จะลองใหม่เมื่อถึงเวลาใช้งาน`);
      }
    }
  })();

  // server-side refusal fallback ใช้ได้กับ Opus 5 / Fable / Sonnet 5.5 (ปิดได้ด้วย AI_FALLBACKS=off)
  const useFallbacks = process.env.AI_FALLBACKS !== 'off' && /^claude-(opus-5|fable|sonnet-5-5)/.test(model);

  async function callJson({ user, schema, effort = 'medium', maxTokens = 16000, label }) {
    const params = {
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
    };
    if (useFallbacks) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const started = Date.now();
    const res = await client.beta.messages.parse(params);
    if (res.stop_reason === 'refusal') {
      throw new Error(`Claude refused (${res.stop_details?.category || 'unknown'}): ${res.stop_details?.explanation || ''}`);
    }
    if (!res.parsed_output) throw new Error(`no parsed output (stop_reason=${res.stop_reason})`);
    log.info(
      `[ai] ${label} ok in ${((Date.now() - started) / 1000).toFixed(1)}s (in=${res.usage?.input_tokens} out=${res.usage?.output_tokens} model=${res.model})`,
    );
    return res.parsed_output;
  }

  async function withFallback(label, claudeFn, mockFn) {
    if (mode !== 'claude') return mockFn();
    try {
      return await claudeFn();
    } catch (err) {
      lastError = err?.message || String(err);
      if (err instanceof Anthropic.AuthenticationError) {
        log.error('[ai] API key ไม่ถูกต้อง → สลับไปโหมด mock ถาวร');
        mode = 'mock';
      } else if (err instanceof Anthropic.APIError) {
        log.error(`[ai] ${label} API error ${err.status}: ${err.message} → ใช้ mock แทนรอบนี้`);
      } else {
        log.error(`[ai] ${label} failed: ${lastError} → ใช้ mock แทนรอบนี้`);
      }
      return mockFn();
    }
  }

  return {
    get mode() {
      return mode;
    },
    get lastError() {
      return lastError;
    },
    model,
    ready,

    // characters: [{id,name,nickname,gender,age,appearance,personality}]
    async generateUltimates(characters) {
      return withFallback(
        'ultimates',
        async () => {
          const user = `สร้าง Ultimate ให้ตัวละครทั้ง ${characters.length} คนนี้ (ตัวละครละ 1 Ultimate ห้ามซ้ำกัน):
${characters.map(fmtCharacter).join('\n')}

ข้อกำหนด:
1. ชื่อ Ultimate เป็นภาษาไทย ขึ้นต้นด้วย "สุดยอด" เช่น สุดยอดนักสืบ สุดยอดนักเคมี สุดยอดช่างไฟ สุดยอดแฮกเกอร์ สุดยอดพยาบาล สุดยอดนักทำขนม สุดยอดนักเต้น (คิดใหม่ให้หลากหลายและเข้ากับนิสัย/รูปลักษณ์ของแต่ละคน)
2. hidden = true เมื่อ Ultimate นั้น (ก) มีผลต่อการสืบสวนคดีอย่างมี "กลไกจริง" เช่น รู้เรื่องศพ/ยา/สารเคมี/ไฟฟ้า/ระบบคอมพิวเตอร์ ฆ่าคนเก่ง ปลอมเสียง ขโมยของ ทำลายหรือย้ายหลักฐาน หรือ (ข) เพิ่มหรือลดความเชื่อใจของผู้คน เช่น ผู้นำ นักต้มตุ๋น นักจิตวิทยา นักเจรจา — ให้มีประมาณ 30-40% ของทั้งหมด (ระบบจะสุ่มเลือกซ่อนจริงเพียง 1-2 คน และให้อีก 1 คนเป็น "โรลปลอม")
3. trait = สายความสามารถที่ระบบใช้จริงในเกม: porter (นักแบก/นักเดินป่า/คนส่งของ → ถือของได้ 5 ชิ้น), combat (นักสู้/นักกีฬาต่อสู้/นักกายกรรม → ลงมือและป้องกันตัวได้ดี), stealth (สายลับ/นักล้วงกระเป๋า/นักแสดง → ขโมยของจากคนในห้อง ซ่อนหลักฐานเนียน), medical (หมอ/พยาบาล/นักเคมี/นิติเวช → ตรวจศพละเอียด วางยาแม่น), tech (แฮกเกอร์/ช่างไฟ → ตัดไฟห้อง), social (ผู้นำ/นักจิตวิทยา/นักเจรจา/นักต้มตุ๋น → ซักถามล้วงความจริง), detective (นักสืบ/ช่างภาพ/ช่างสังเกต → ค้นหาของซ่อนเก่ง), none (ที่เหลือ เช่น นักทำขนม นักดนตรี นักเต้น) — ประมาณครึ่งหนึ่งควรเป็น none
4. investigationEffect อธิบาย 1 ประโยคว่า Ultimate นี้ช่วยอะไรในคดีได้จริง ๆ ทางกายภาพ (ถ้าไม่มีผลให้ตอบ "ไม่มีผลโดยตรง") ห้ามอ้างความสามารถที่ไม่มีกลไก
5. decoyTitle/decoyDescription = Ultimate ธรรมดา (trait none) ที่ดูไม่มีพิษภัยและเข้ากับรูปลักษณ์/นิสัยของคนนั้น เพื่อใช้เป็น "ฉากบังหน้า" ถ้าคนนี้ถูกสุ่มให้ได้โรลปลอม ต้องไม่ซ้ำกับ title ของตัวเองหรือของคนอื่น
6. ใส่ characterId ให้ตรงกับ id ที่ให้มาทุกตัว`;
          const out = await callJson({ user, schema: UltimatesSchema, effort: 'medium', label: 'ultimates' });
          const byId = new Map(out.ultimates.map((u) => [u.characterId, u]));
          const missing = characters.filter((c) => !byId.has(c.id));
          if (missing.length) {
            const fill = mockUltimates(missing);
            for (const f of fill) byId.set(f.characterId, f);
          }
          return characters.map((c) => byId.get(c.id));
        },
        () => mockUltimates(characters),
      );
    },

    // สถานที่เดียวทั้งเกม: 8 ห้อง (ห้องแรก = ที่นอนรวม) + เทมเพลตทางออก 4-5 ทาง (ระบบสุ่มใช้ 2 ทาง ซ่อนในห้องธรรมดา)
    async generateLocation({ playerCount = 6 } = {}) {
      return withFallback(
        'location',
        async () => {
          const roomsWanted = roomCountFor(playerCount);
          const user = `สร้าง "สถานที่ปิดตาย" สำหรับเกมที่มีผู้เล่น ${playerCount} คน ผู้เล่นต้องสำรวจห้องต่าง ๆ เพื่อหา "ทางออกที่ซ่อนอยู่" และของที่ต้องใช้เปิดมัน

ข้อกำหนด:
1. name: ชื่อสถานที่สั้น ๆ น่าสนใจ / description: บรรยากาศ 2-3 ประโยค บอกว่าทำไมออกไปไม่ได้ (ห้ามเอ่ยถึงทางออกที่ซ่อนอยู่)
2. zones: ห้อง ${roomsWanted} ห้อง (ผู้เล่น × 2) — ห้องแรกคือ "ที่นอนรวม" ที่ทุกคนนอน (มีของธรรมดา 1-2 ชิ้น เช่น ผ้า ไฟฉาย) ห้องที่ 2-${roomsWanted} คือห้องสำรวจ แต่ละห้องมีของ 2-3 ชิ้น ชื่อห้องห้ามซ้ำกัน
3. ของในห้องสำรวจรวมกันต้องมี: อาวุธ (weapon) อย่างน้อย ${Math.max(5, Math.ceil(roomsWanted / 2))} ชิ้น, ยา/สารพิษ (poison) ${Math.max(3, Math.ceil(roomsWanted / 4))} ชิ้น (อย่างน้อย 1 ชิ้นเป็นยานอนหลับ/ยาสลบ), เชือก/สายไฟ (rope) ${Math.max(3, Math.ceil(roomsWanted / 4))} ชิ้น (อย่างน้อย 1 เส้นเป็นสายไฟจริง), เครื่องมือ/ของหนัก (tool) ${Math.max(3, Math.ceil(roomsWanted / 4))} ชิ้น (อย่างน้อย 1 ชิ้นเป็นเครื่องมือช่าง เช่น ไขควง ประแจ ค้อน · ถ้ามีอาวุธปืนให้บอกจำนวนกระสุนในคำบรรยาย), แผงไฟหรือกล้อง (power) ${2 + Math.floor(roomsWanted / 10)}-${3 + Math.floor(roomsWanted / 10)} ชิ้น, อาหารกลางห้อง (food) ${2 + Math.floor(roomsWanted / 10)} ชิ้นในคนละห้อง, ที่สะเดาะกุญแจ (lockpick) 1 ชิ้น (ห้ามสร้างกุญแจ ระบบจะสร้างกุญแจประจำห้องให้เอง), ผ้า (cloth) 1-2 ชิ้น และของติดตั้งถาวร (fixture) ไม่เกิน ${1 + Math.floor(roomsWanted / 8)} ชิ้น ชื่อของห้ามซ้ำกัน
4. exits: ทางออกที่เป็นไปได้ 5 ทาง route ครบทั้ง locked, code, repair, power, breach อย่างละ 1 แต่ละทาง "ซ่อน" อยู่ในห้องสำรวจคนละห้อง (zoneName ต้องตรงกับชื่อห้อง) ชื่อและคำบรรยายต้องสมเหตุสมผลกับสถานที่ และ itemNames ต้องสอดคล้องกับ route (ของพวกนี้ระบบจะซ่อนตามห้องเอง ไม่ต้องใส่ใน zones)
5. ทุกอย่างสมจริง ของทุกชิ้นต้องมีเหตุผลว่าทำไมถึงอยู่ในห้องนั้น`;
          const loc = await callJson({ user, schema: LocationSchema, effort: 'medium', label: 'location' });
          if (!loc.zones || loc.zones.length < 5) throw new Error('location has too few zones');
          const nonPortable = new Set(['fixture', 'power', 'food']);
          const zones = loc.zones.map((z, zi) => ({
            id: `z${zi + 1}`,
            name: z.name,
            description: z.description,
            items: (z.items || []).map((it, ii) => ({ id: `z${zi + 1}_i${ii + 1}`, name: it.name, description: it.description, kind: it.kind, portable: !nonPortable.has(it.kind), master: false })),
          }));
          // ห้องต้องครบ ผู้เล่น × 2 — ถ้า Claude ให้มาน้อยกว่านั้น เติมห้องเสริมจากคลัง (ชื่อไม่ซ้ำ)
          for (const r of extraRooms(Math.max(0, roomsWanted - zones.length), zones.map((z) => z.name), zones.flatMap((z) => z.items.map((i) => i.name)))) {
            const zi = zones.length;
            zones.push({ id: `z${zi + 1}`, name: r.name, description: r.description, items: r.items.map(([name, description, kind], ii) => ({ id: `z${zi + 1}_i${ii + 1}`, name, description, kind, portable: !nonPortable.has(kind), master: false })) });
          }
          const explore = zones.slice(1);
          const all = () => zones.flatMap((z) => z.items);
          const inject = (kind, name, description) => {
            const z = explore[Math.floor(Math.random() * explore.length)];
            z.items.push({ id: `${z.id}_x${z.items.length + 1}`, name, description, kind, portable: !nonPortable.has(kind), master: false });
          };
          // กันขาด: ของที่กลไกเกมต้องมี
          if (!all().some((i) => i.kind === 'food')) inject('food', 'ตู้เสบียงสำรอง', 'อาหารกระป๋อง ขนมปัง และน้ำดื่ม');
          if (!all().some((i) => i.kind === 'rope')) inject('rope', 'เชือกไนลอนม้วนใหญ่', 'เหนียวและยาวหลายเมตร');
          if (all().some((i) => i.kind === 'power') && !all().some(isConductive)) inject('rope', 'สายไฟพ่วงยาว', 'ม้วนใหญ่ ฉนวนลอกบางช่วง'); // กับดักไฟช็อตต้องมีสายไฟจริง
          if (!all().some((i) => i.kind === 'power')) inject('power', 'ตู้เบรกเกอร์ไฟ', 'ควบคุมไฟของทั้งอาคาร');
          if (!all().some((i) => i.kind === 'tool')) inject('tool', 'ค้อนปอนด์', 'หนักและแข็ง');
          if (!all().some((i) => i.kind === 'tool' && tagsOf(i).has('fastener'))) inject('tool', 'กล่องเครื่องมือช่าง', 'ไขควง คีม ประแจเล็ก และค้อน'); // กับดักประตู/ซ่อมทางออก/ช่างสะเดาะต้องมีเครื่องมือช่าง
          if (!all().some((i) => i.kind === 'lockpick')) inject('lockpick', 'ชุดไขควงและเหล็กงัดกลอน', 'ใช้สะเดาะกลอนประตูที่ล็อกได้');
          if (all().filter((i) => i.kind === 'weapon').length < 3) inject('weapon', 'ท่อนเหล็ก', 'ท่อนเหล็กยาวหนักมือ');
          const portableCount = all().filter((i) => i.portable).length;
          if (portableCount < 6) throw new Error('location has too few portable items');
          const exits = (loc.exits || []).filter((e) => e && e.name && e.route).map((e) => ({ name: e.name, description: e.description || '', zoneName: e.zoneName || null, route: e.route, itemNames: Array.isArray(e.itemNames) ? e.itemNames.filter(Boolean) : [] }));
          return { name: loc.name, description: loc.description, zones, sleepZoneId: zones[0].id, exits };
        },
        () => mockLocation({ zoneCount: roomCountFor(playerCount) }),
      );
    },

    // บรรยายคดีจากข้อเท็จจริงที่เอนจินคำนวณแล้ว (ไม่เปลี่ยนข้อเท็จจริง)
    // ctx: { location, victim, killer|null, cause, weapon|null, zone, discoveredZone, day, messy, moved, witnesses:[nick] }
    async narrateCase(ctx) {
      return withFallback(
        'narrative',
        async () => {
          const causeText = {
            attack: `${ctx.killer?.nickname}ลงมือฆ่า${ctx.victim.nickname}โดยตรง${ctx.weapon ? `ด้วย${ctx.weapon.name} (${ctx.weapon.kind})` : 'ด้วยมือเปล่า'} ${ctx.messy ? 'แบบเลอะเทอะ มีการต่อสู้' : 'อย่างเงียบเชียบ แทบไม่มีร่องรอยการต่อสู้'}`,
            wrongTarget: `${ctx.killer?.nickname}ตั้งใจฆ่าคนอื่นแต่พลาดไปโดน${ctx.victim.nickname}${ctx.weapon ? `ด้วย${ctx.weapon.name}` : ''} ต่อหน้าคนในห้อง`,
            trap: `${ctx.victim.nickname}โดนกับดักที่${ctx.killer?.nickname}เตรียมไว้ล่วงหน้า: ${
              { poison: `ยาพิษ (${ctx.weapon?.name}) ที่ผสมไว้ในอาหารกลางห้อง`, blade: `${ctx.weapon?.name} (อาวุธผูกเชือกขึงไว้ที่ประตู เหวี่ยงใส่คนที่เปิดประตู)`, fall: `${ctx.weapon?.name} (สายสะดุดโยงของหนักให้หล่นใส่)`, shock: `${ctx.weapon?.name} (สายไฟเปลือยต่อกับลูกบิดประตู ไฟช็อต)` }[ctx.trapType] || ctx.weapon?.name || 'กลไกที่ตั้งไว้'
            } คนวางไม่ได้อยู่ในห้องตอนตาย`,
            defense: `${ctx.victim.nickname}เป็นฝ่ายจู่โจม${ctx.killer?.nickname}ก่อน แต่ถูกสวนกลับจนตายด้วยมือเปล่า มีร่องรอยการต่อสู้ชัดเจน`,
          }[ctx.cause] || ctx.cause;
          const user = `จงเขียนคำบรรยายคดีจาก "ข้อเท็จจริง" ต่อไปนี้ (ห้ามเปลี่ยนข้อเท็จจริง ห้ามเพิ่มพยานหรือหลักฐานใหม่)

## สถานที่: ${ctx.location?.name}
## ห้องที่เกิดเหตุ: ${ctx.zone?.name} — ${ctx.zone?.description}
## ห้องที่พบศพ: ${ctx.discoveredZone?.name}${ctx.moved ? ' (ศพถูกย้ายมาจากห้องที่เกิดเหตุ)' : ' (ไม่ได้ถูกย้าย)'}
## เวลาเกิดเหตุ: วันที่ ${ctx.day}${ctx.hour ? ` ชั่วโมงที่ ${ctx.hour}` : ''}
## ผู้ตาย
${fmtCharacter(ctx.victim)}
${ctx.killer ? `## คนร้าย (ความลับ ห้ามหลุดใน title/bodyState/sceneNotes)\n${fmtCharacter(ctx.killer)}` : '## ไม่มีคนร้าย'}
## สิ่งที่เกิดขึ้นจริง
${causeText}
${ctx.witnesses?.length ? `## คนที่เห็นเหตุการณ์ตอนลงมือ: ${ctx.witnesses.join(', ')} (ระบบแจ้งพวกเขาเองแล้ว ไม่ต้องเขียนถึง)` : ''}

ข้อกำหนด:
1. title = ชื่อคดีสั้น ๆ
2. bodyState = สภาพศพ (โชว์เป็นเฉลยหลังตัดสินเท่านั้น) 2-3 ประโยค สอดคล้องกับอาวุธ/สาเหตุ (ของมีคม→แผลบาด, ของหนัก→รอยช้ำ, เชือก/ผ้า→รอยรัด, ปืน/ธนู→แผลทะลุ, ยาพิษ→ริมฝีปากเขียวไม่มีแผล, ไฟช็อต→รอยไหม้ที่มือ) ห้ามเอ่ยชื่อคนร้าย ห้ามบอกใบ้ลักษณะเฉพาะของคนร้าย
3. sceneNotes = ความผิดปกติรอบศพ 1-2 ประโยค: ถ้าถูกย้ายให้มีรอยลาก ถ้าเลอะเทอะให้มีของล้ม/คราบ ถ้าเรียบร้อยให้บอกว่าเรียบร้อยผิดปกติ ห้ามเพิ่มหลักฐานที่ชี้ตัวคน
4. truthSummary = สรุปความจริง 2-4 ประโยคสำหรับเฉลยหลังตัดสิน บอกชื่อคนร้าย (ถ้ามี) วิธี ที่ไหน วันไหน`;
          const out = await callJson({ user, schema: NarrativeSchema, effort: 'medium', maxTokens: 4000, label: 'narrative' });
          const leak = ctx.killer && [out.title, out.bodyState, out.sceneNotes].some((t) => t.includes(ctx.killer.nickname) || t.includes(ctx.killer.name));
          if (leak) throw new Error('narrative leaks killer name');
          return out;
        },
        () => mockNarrateCase(ctx),
      );
    },

    // ctx: { round, location, character (ผู้ที่จะฟื้น), deathSummary, aliveCharacters }
    async generateReviveEvent(ctx) {
      return withFallback(
        'revive',
        async () => {
          const c = ctx.character;
          const user = `เกิด "อีเวนต์พิเศษ" ตอนเริ่มวันที่ ${ctx.round}: ผู้ที่ทุกคนคิดว่าตายไปแล้วกลับมามีชีวิต จงแต่งสถานการณ์ประกอบให้สมเหตุสมผล

## ผู้ที่จะกลับมา
${fmtCharacter(c)}

## สิ่งที่เกิดขึ้นกับเขาตอนนั้น (คดีนี้ถูกเฉลยและตัดสินไปแล้ว)
${ctx.deathSummary || 'ไม่มีรายละเอียด'}

## สถานที่: ${ctx.location?.name || '-'}
${ctx.location?.description || ''}
ห้องต่าง ๆ: ${(ctx.location?.zones || []).map((z) => z.name).join(', ')}

## ผู้ที่ยังอยู่ในเกม
${(ctx.aliveCharacters || []).map((x) => `- ${x.name} (${x.nickname})`).join('\n')}

ข้อกำหนด:
1. story = เรื่องราวที่ทุกคนรับรู้ 3-6 ประโยค ต้อง "สอดคล้อง" กับวิธีที่เขาตาย (ถูกวางยา → ขนาดยาไม่ถึงตาย, ถูกแทง → แผลพลาดจุดสำคัญ ฯลฯ) และจบด้วยการที่เขากลับเข้าร่วมกับทุกคน
2. ห้ามเปิดเผยหรือเปลี่ยนข้อเท็จจริงของคดีที่ตัดสินไปแล้ว และห้ามชี้ว่าใครในกลุ่มเป็นคนร้ายรายต่อไป
3. privateNote = ข้อความถึงผู้ที่ฟื้น 1-3 ประโยค เป็นบุรุษที่สอง เล่าสิ่งที่เขาจำได้เลือนราง
4. title = ชื่ออีเวนต์สั้น ๆ น่าสนใจ`;
          return callJson({ user, schema: ReviveSchema, effort: 'medium', maxTokens: 4000, label: 'revive' });
        },
        () => mockReviveEvent(ctx),
      );
    },
  };
}
