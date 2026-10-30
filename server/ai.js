// AI module — ใช้ Claude API (Anthropic SDK) เจน Ultimate / สถานที่ / คดี
// ถ้าไม่มี API key หรือเรียกไม่สำเร็จ จะ fallback ไปใช้ mock.js อัตโนมัติ
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { mockUltimates, mockLocation, mockIncident, mockReviveEvent } from './mock.js';

const UltimatesSchema = z.object({
  ultimates: z.array(
    z.object({
      characterId: z.string(),
      title: z.string().describe('ชื่อ Ultimate ภาษาไทย ขึ้นต้นด้วย "สุดยอด"'),
      description: z.string().describe('คำอธิบายความสามารถ 1-2 ประโยค'),
      hidden: z.boolean().describe('true ถ้ามีผลต่อการสืบสวนคดี หรือเพิ่ม/ลดความเชื่อใจของผู้คน (ระบบจะเลือกซ่อนจริงแค่บางคน)'),
      hiddenReason: z.string().describe('เหตุผลสั้น ๆ ว่าทำไมถึงควรซ่อน (ว่างได้ถ้าไม่ซ่อน)'),
      investigationEffect: z.string().describe('ผลต่อคดีฆาตกรรม 1 ประโยค หรือ "ไม่มีผลโดยตรง"'),
      decoyTitle: z.string().describe('Ultimate "ฉากบังหน้า" ที่ดูไม่มีพิษภัยและเข้ากับตัวละคร ใช้เมื่อระบบสุ่มให้คนนี้ได้โรลปลอม ห้ามซ้ำกับ title ของใคร'),
      decoyDescription: z.string().describe('คำอธิบายของ decoyTitle 1 ประโยค'),
    }),
  ),
});

const LocationSchema = z.object({
  name: z.string(),
  description: z.string(),
  items: z.array(
    z.object({
      id: z.string().describe('item_1, item_2, ...'),
      name: z.string(),
      description: z.string(),
      where: z.string().describe('อยู่ตรงไหนของสถานที่'),
    }),
  ),
});

const IncidentSchema = z.object({
  title: z.string(),
  victimId: z.string(),
  culpritId: z.string(),
  method: z.object({
    cause: z.string().describe('สาเหตุการตายจริง: ฆ่าอย่างไร ด้วยอะไร (อ้างอิงอุปกรณ์ในสถานที่) 1-2 ประโยค เป็นรูปธรรม'),
    concealment: z.string().describe('การกระทำจริง ๆ ที่คนร้ายทำเพื่อปกปิด เช่น เช็ดคราบด้วยผ้า ลากศพ ปิดไฟ ล็อกประตู จัดฉาก หรือ "ไม่ได้ปกปิด"'),
    concealmentTrace: z.string().describe('ร่องรอยที่การปกปิดนั้นทิ้งไว้ให้สังเกตได้ (ทุกการปกปิดมีร่องรอย) หรือ "" ถ้าไม่ได้ปกปิด'),
    usedUltimate: z.boolean().describe('true เฉพาะเมื่อ Ultimate ของคนร้ายมีกลไกที่ใช้กับคดีนี้ได้จริงและอธิบายได้'),
    ultimateUse: z.string().describe('ถ้า usedUltimate: อธิบายว่าใช้ Ultimate ทำอะไรอย่างเป็นรูปธรรม (กลไกจริง ไม่ใช่เวทมนตร์) ถ้าไม่ใช้ให้ ""'),
  }),
  whereabouts: z.array(
    z.object({
      characterId: z.string(),
      where: z.string().describe('ความจริง: ช่วงเกิดเหตุคนนี้อยู่ที่ไหน ทำอะไร เขียนแบบไม่มีประธาน เช่น "นั่งอ่านหนังสือที่ห้องสมุดจนตีหนึ่ง แล้วกลับไปนอน" (ระบบส่งให้เจ้าตัวเท่านั้น)'),
    }),
  ),
  observations: z.array(
    z.object({
      knownBy: z.array(z.string()).describe('characterId ของคนที่รู้เรื่องนี้ 1-3 คน: คนที่เห็น/ได้ยินเอง และคนที่อยู่ในเหตุการณ์นั้นด้วยกัน เท่านั้น'),
      text: z.string().describe('สิ่งที่เกิดขึ้น เขียนเป็นบุรุษที่สามด้วยชื่อเล่น 1-2 ประโยค เช่น "มิโอะเห็นเรนเดินกลับมาจากทางห้องครัวตอนใกล้สว่าง"'),
    }),
  ),
  publicReport: z.object({
    discovery: z.string(),
    bodyState: z.string(),
    suspiciousItems: z.array(z.object({ itemId: z.string(), observation: z.string() })),
    sceneNotes: z.string(),
  }),
  privateClues: z.array(z.object({ characterId: z.string(), clue: z.string() })),
  ultimateInsights: z.array(z.object({ characterId: z.string(), insight: z.string() })),
  culpritStory: z.string(),
  involvedCharacterIds: z.array(z.string()),
  deductionChain: z.array(z.string()).describe('ลำดับการหาเหตุผล 3-5 ข้อที่นำไปสู่คนร้าย โดยใช้เฉพาะข้อมูลที่ผู้เล่นเข้าถึงได้'),
  truthSummary: z.string(),
});

const ReviveSchema = z.object({
  title: z.string().describe('ชื่ออีเวนต์สั้น ๆ'),
  story: z.string().describe('เรื่องราวที่ทุกคนรับรู้ 3-6 ประโยค อธิบายว่าทำไมถึงไม่ได้ตายจริง'),
  privateNote: z.string().describe('ข้อความส่วนตัวถึงผู้ที่ฟื้น 1-3 ประโยค เล่าสิ่งที่จำได้'),
});

const SYSTEM_PROMPT = `คุณคือ "Game Master" ของบอร์ดเกมสืบสวนฆาตกรรมแนว social deduction ภาษาไทย
ผู้เล่นแต่ละคนรับบทตัวละครที่มี "Ultimate" (ความสามารถสุดยอดเฉพาะตัว) และถูกขังอยู่ในสถานที่ปิดตาย
ทุกคืนจะมีฆาตกรรมเกิดขึ้น ผู้เล่นต้องสืบสวนและโหวตหาคนร้าย

กติกาการเขียนของคุณ:
- เขียนทุกอย่างเป็นภาษาไทยที่อ่านลื่น ใช้ชื่อเล่นของตัวละครเป็นหลัก
- ต้องเป็นเนื้อหาออริจินัล ห้ามอ้างอิงชื่อตัวละคร สถานที่ หรือ Ultimate จากเกม/อนิเมะที่มีอยู่จริง
- ความรุนแรงระดับ PG-13: บรรยายสภาพศพได้แต่ไม่โหดเลือดสาดเกินจำเป็น
- คดีต้องสมจริงแบบนิยายสืบสวน: ทุกการกระทำมีกลไกทางกายภาพที่อธิบายได้ และทุกการปกปิดทิ้งร่องรอย Ultimate ไม่ใช่เวทมนตร์
- ตอบเป็น JSON ตาม schema ที่กำหนดเท่านั้น`;

function fmtCharacter(c) {
  const tags = [];
  if (c.ultimate?.hidden) tags.push('ซ่อนจากคนอื่น (เห็นเป็น ???)');
  if (c.fakeRole && c.fakeUltimate) tags.push(`โรลปลอม: คนอื่นเข้าใจว่าเป็น "${c.fakeUltimate.title}"`);
  if (c.ownerKnows === false) tags.push('เจ้าของยังไม่รู้ตัว');
  const ult = c.ultimate ? `Ultimate จริง: ${c.ultimate.title}${tags.length ? ` [${tags.join(' | ')}]` : ''} — ${c.ultimate.description}` : '';
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
3. investigationEffect อธิบาย 1 ประโยคว่า Ultimate นี้ช่วยอะไรในคดีได้จริง ๆ ทางกายภาพ (ถ้าไม่มีผลให้ตอบ "ไม่มีผลโดยตรง") ห้ามอ้างความสามารถที่ไม่มีกลไก เช่น นักเต้นปกปิดร่องรอยไม่ได้ นักทำขนมไม่รู้เรื่องยาพิษ
4. decoyTitle/decoyDescription = Ultimate ธรรมดาที่ดูไม่มีพิษภัยและเข้ากับรูปลักษณ์/นิสัยของคนนั้น เพื่อใช้เป็น "ฉากบังหน้า" ถ้าคนนี้ถูกสุ่มให้ได้โรลปลอม ต้องไม่ซ้ำกับ title ของตัวเองหรือของคนอื่น
5. ใส่ characterId ให้ตรงกับ id ที่ให้มาทุกตัว`;
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

    async generateLocation({ round = 1, previousNames = [] } = {}) {
      return withFallback(
        'location',
        async () => {
          const user = `สร้าง "สถานที่ปิดตาย" สำหรับรอบที่ ${round} ของเกม (ผู้เล่นหนีออกไปไม่ได้)
${previousNames.length ? `ห้ามซ้ำกับสถานที่ก่อนหน้า: ${previousNames.join(', ')}` : ''}

ข้อกำหนด:
1. name: ชื่อสถานที่สั้น ๆ น่าสนใจ
2. description: บรรยายบรรยากาศ 2-3 ประโยค บอกว่าทำไมออกไปไม่ได้ และบอกคร่าว ๆ ว่าทุกคนนอนที่ไหน (ห้องรวม/ห้องแยก) เพื่อใช้สืบเรื่องตำแหน่งตอนกลางคืน
3. items: อุปกรณ์/สิ่งของในสถานที่ 7-10 ชิ้น id เป็น item_1, item_2, ... แต่ละชิ้นมี name, description (บอกใบ้ว่าอาจใช้เป็นอาวุธ เครื่องมือ หรือหลักฐานได้อย่างไร), where (อยู่โซนไหนของสถานที่ ใช้ชื่อโซนสั้น ๆ ซ้ำกันได้เพื่อให้สถานที่มี 4-6 โซนชัดเจน)
4. ผสมของอันตราย (อาวุธ ยา สารเคมี) กับของธรรมดา (ระบบไฟ กุญแจ กล้อง เครื่องจักร ผ้า น้ำ) และควรมีของที่ "จำกัดการเข้าถึง" อย่างน้อย 1 ชิ้น (เช่น กุญแจที่มีคนถือ ห้องที่ล็อก) เพื่อใช้จำกัดวงผู้ต้องสงสัย`;
          const loc = await callJson({ user, schema: LocationSchema, effort: 'medium', label: 'location' });
          loc.items = loc.items.map((it, i) => ({ ...it, id: `item_${i + 1}` }));
          if (loc.items.length < 5) throw new Error('location has too few items');
          return loc;
        },
        () => mockLocation({ round, previousNames }),
      );
    },

    // ctx: { round, location, character (เหยื่อที่จะฟื้น), deathSummary, aliveCharacters }
    async generateReviveEvent(ctx) {
      return withFallback(
        'revive',
        async () => {
          const c = ctx.character;
          const user = `เกิด "อีเวนต์พิเศษ" ตอนเริ่มวันที่ ${ctx.round}: เหยื่อที่ทุกคนคิดว่าตายไปแล้วกลับมามีชีวิต จงแต่งสถานการณ์ประกอบให้สมเหตุสมผล

## ผู้ที่จะกลับมา
${fmtCharacter(c)}

## สิ่งที่เกิดขึ้นกับเขาตอนนั้น (คดีนี้ถูกเฉลยและตัดสินไปแล้ว)
${ctx.deathSummary || 'ไม่มีรายละเอียด'}

## สถานที่ที่กลุ่มกำลังจะออกเดินทางจาก: ${ctx.location?.name || '-'}
${ctx.location?.description || ''}
${(ctx.location?.items || []).map((i) => `- ${i.name} (${i.where})`).join('\n')}

## ผู้ที่ยังอยู่ในเกม
${(ctx.aliveCharacters || []).map((x) => `- ${x.name} (${x.nickname})`).join('\n')}

ข้อกำหนด:
1. story = เรื่องราวที่ทุกคนรับรู้ 3-6 ประโยค ต้อง "สอดคล้อง" กับวิธีที่เขาตายในสรุปคดี (เช่น ถูกวางยา → ขนาดยาไม่ถึงตาย/ยาทำให้ดูเหมือนตาย, ถูกแทง → แผลพลาดจุดสำคัญและมีคนแอบช่วย, ตกจากที่สูง → ร่างที่พบไม่ใช่สภาพจริง ฯลฯ) และจบด้วยการที่เขากลับเข้าร่วมกับทุกคน
2. ห้ามเปิดเผยหรือเปลี่ยนข้อเท็จจริงของคดีที่ตัดสินไปแล้ว และห้ามชี้ว่าใครในกลุ่มเป็นคนร้ายรายต่อไป
3. privateNote = ข้อความถึงผู้ที่ฟื้น 1-3 ประโยค เป็นบุรุษที่สอง เล่าสิ่งที่เขาจำได้เลือนราง (ให้บรรยากาศลึกลับ ไม่ใช่เบาะแสคดีใหม่)
4. title = ชื่ออีเวนต์สั้น ๆ น่าสนใจ`;
          return callJson({ user, schema: ReviveSchema, effort: 'medium', label: 'revive' });
        },
        () => mockReviveEvent(ctx),
      );
    },

    // ctx: { round, location, characters(alive, with ultimate+ownerKnows+fakeRole), murdererId, targetId, previousCases }
    async generateIncident(ctx) {
      const ids = new Set(ctx.characters.map((c) => c.id));
      const validate = (inc) => {
        if (!ids.has(inc.victimId)) return 'victimId ไม่อยู่ในรายชื่อผู้มีชีวิต';
        if (!ids.has(inc.culpritId)) return 'culpritId ไม่อยู่ในรายชื่อผู้มีชีวิต';
        if (inc.victimId === inc.culpritId) return 'victimId กับ culpritId ต้องไม่ใช่คนเดียวกัน';
        const covered = new Set((inc.whereabouts || []).map((w) => w.characterId));
        const missing = ctx.characters.filter((c) => !covered.has(c.id));
        if (missing.length > Math.ceil(ctx.characters.length / 3)) return `whereabouts ขาดตัวละคร: ${missing.map((m) => m.nickname).join(', ')}`;
        if (!inc.method?.cause) return 'method.cause ว่าง';
        if ((inc.deductionChain || []).length < 2) return 'deductionChain ต้องมีอย่างน้อย 2 ข้อ';
        // ถ้ามีแค่คนร้ายกับเหยื่อ ไม่มีพยานให้ตรวจ
        if (ctx.characters.length <= 2) return null;
        const obs = (inc.observations || []).filter((o) => o.text && (o.knownBy || []).some((id) => ids.has(id)));
        if (obs.length < 2) return 'observations ต้องมีอย่างน้อย 2 รายการที่ระบุ knownBy ถูกต้อง';
        if (ctx.characters.length >= 4 && obs.some((o) => o.knownBy.filter((id) => ids.has(id)).length >= ctx.characters.length - 1)) {
          return 'observations ห้ามมีรายการที่แทบทุกคนรู้ ให้รู้เฉพาะคนในเหตุการณ์ (1-3 คน)';
        }
        const culprit = ctx.characters.find((c) => c.id === inc.culpritId);
        const weakness = obs.some((o) => o.text.includes(culprit.nickname) && o.knownBy.some((id) => id !== inc.culpritId && id !== inc.victimId && ids.has(id)));
        if (!weakness) return `คนร้าย (${culprit.nickname}) ต้องมี observation อย่างน้อย 1 รายการที่คนอื่นรู้และเอ่ยถึงเขา`;
        return null;
      };
      const clean = (inc) => {
        const itemIds = new Set(ctx.location.items.map((i) => i.id));
        inc.publicReport.suspiciousItems = inc.publicReport.suspiciousItems.filter((s) => itemIds.has(s.itemId));
        inc.privateClues = inc.privateClues.filter((c) => ids.has(c.characterId) && c.characterId !== inc.culpritId && c.characterId !== inc.victimId);
        inc.ultimateInsights = inc.ultimateInsights.filter((c) => ids.has(c.characterId) && c.characterId !== inc.culpritId && c.characterId !== inc.victimId);
        inc.involvedCharacterIds = [...new Set([inc.culpritId, ctx.murdererId, ctx.targetId, ...inc.involvedCharacterIds.filter((id) => ids.has(id))])];
        const seen = new Set();
        inc.whereabouts = (inc.whereabouts || []).filter((w) => {
          if (!ids.has(w.characterId) || seen.has(w.characterId)) return false;
          seen.add(w.characterId);
          return true;
        });
        for (const c of ctx.characters) {
          if (!seen.has(c.id)) inc.whereabouts.push({ characterId: c.id, where: 'คุณหลับอยู่ที่ที่นอนทั้งคืนโดยไม่รู้สึกตัว' });
        }
        inc.whereabouts = inc.whereabouts.map((w) => ({ characterId: w.characterId, where: w.where || '' }));
        inc.observations = (inc.observations || [])
          .map((o) => ({ knownBy: [...new Set((o.knownBy || []).filter((id) => ids.has(id)))].slice(0, 3), text: String(o.text || '').trim() }))
          .filter((o) => o.knownBy.length && o.text);
        inc.method = {
          cause: inc.method?.cause || '',
          concealment: inc.method?.concealment || 'ไม่ได้ปกปิด',
          concealmentTrace: inc.method?.concealmentTrace || '',
          usedUltimate: !!inc.method?.usedUltimate,
          ultimateUse: inc.method?.usedUltimate ? inc.method.ultimateUse || '' : '',
        };
        inc.deductionChain = (inc.deductionChain || []).filter((s) => typeof s === 'string' && s.trim());
        return inc;
      };
      return withFallback(
        'incident',
        async () => {
          const murderer = ctx.characters.find((c) => c.id === ctx.murdererId);
          const target = ctx.characters.find((c) => c.id === ctx.targetId);
          const user = `คืนนี้เกิดเหตุฆาตกรรมในรอบที่ ${ctx.round} จงสร้างเหตุการณ์ทั้งหมด

## สถานที่: ${ctx.location.name}
${ctx.location.description}
อุปกรณ์ในสถานที่:
${ctx.location.items.map((i) => `- ${i.id}: ${i.name} — ${i.description} (${i.where})`).join('\n')}

## ตัวละครที่ยังมีชีวิต
${ctx.characters.map(fmtCharacter).join('\n')}

## สิ่งที่ระบบสุ่มไว้ (ความลับ)
- ฆาตกรที่ระบบเลือกคืนนี้: ${murderer.nickname} (id=${murderer.id})
- เป้าหมายที่ฆาตกรเลือกจะฆ่า: ${target.nickname} (id=${target.id})
${ctx.previousCases?.length ? `\n## คดีก่อนหน้า (เพื่อความต่อเนื่อง)\n${ctx.previousCases.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : ''}

## กติกาการสร้างเหตุการณ์ (สำคัญมาก)

### ก. ใครตาย ใครทำ
1. victimId = ผู้ตาย เป็นใครก็ได้ที่ยังมีชีวิต: ส่วนใหญ่ควรเป็นเป้าหมาย (${target.nickname}) แต่บางครั้งอาจเป็นฆาตกรเอง (แผนย้อนศร/ถูกป้องกันตัว) หรือคนอื่นที่บังเอิญมาเห็น
2. culpritId = คนร้ายตัวจริงที่ทำให้เหยื่อตาย ต้องยังมีชีวิตและไม่ใช่ victimId โดยปกติคือฆาตกรที่ระบบเลือก แต่อาจเป็นเป้าหมายที่สู้กลับ หรือบุคคลที่สามที่ฉวยโอกาสก็ได้
3. เหตุการณ์ต้องเกี่ยวข้องกับทั้ง ${murderer.nickname} และ ${target.nickname} อย่างมีนัยสำคัญเสมอ

### ข. ความสมจริงของวิธีการ (method)
4. method.cause = ฆ่าอย่างไรด้วยอะไร ต้องทำได้จริงด้วยอุปกรณ์ในสถานที่นี้ (อ้างชื่ออุปกรณ์)
5. method.concealment = สิ่งที่คนร้าย "ทำจริง ๆ" เพื่อปกปิด ต้องเป็นการกระทำทางกายภาพที่คนธรรมดาทำได้ เช่น เช็ดคราบด้วยผ้าแล้วเอาผ้าไปซ่อน ลากศพไปอีกโซน ปิดเบรกเกอร์ ล็อกประตูแล้วคืนกุญแจ วางอุปกรณ์อื่นไว้ใกล้ศพให้เข้าใจผิด ถ้าไม่ปกปิดเลยให้ตอบ "ไม่ได้ปกปิด"
6. method.concealmentTrace = ทุกการปกปิดทิ้งร่องรอย: ผ้าหาย/เปียก กลิ่นน้ำยา เบรกเกอร์ถูกสับ รอยลาก กุญแจห้อยผิดด้าน ฯลฯ ร่องรอยนี้ต้องปรากฏใน publicReport หรือ privateClues หรือ ultimateInsights อย่างน้อย 1 แห่ง แต่ต้อง "ไม่ชี้ตัวคนเดียวทันที" ให้มันจำกัดวงเหลือ 2-3 คน (เช่น ต้องเป็นคนที่เข้าถึงห้องนั้นได้ / รู้เรื่องสารเคมี / ตัวสูงพอ)
7. Ultimate ของคนร้ายใช้ได้ "เฉพาะเมื่อมีกลไกจริง" ตัวอย่างที่ใช้ได้: นักเคมีผสมน้ำยาจากสารในแล็บมาล้างคราบเลือด (ทิ้งกลิ่นฉุน ขวดพร่อง), ช่างไฟสับเบรกเกอร์โซนนั้นให้มืด (เบรกเกอร์ถูกสับ), แฮกเกอร์ลบไฟล์กล้อง (log มีช่วงหาย), พยาบาลรู้ขนาดยาที่ทำให้หัวใจหยุด (รอยเข็ม), นักแสดงเลียนเสียงคนอื่นเรียกเหยื่อออกมา (มีคนได้ยินเสียงนั้น), นักล้วงกระเป๋าขโมยกุญแจแล้วคืน (กุญแจอยู่ผิดตำแหน่งเล็กน้อย)
   ห้ามเด็ดขาด: ให้ Ultimate ที่ไม่มีกลไกเกี่ยวข้อง (นักเต้น นักทำขนม เกมเมอร์ จิตรกร นักดนตรี ฯลฯ) มา "ปกปิดร่องรอย" หรือทำสิ่งที่อธิบายไม่ได้ ถ้า Ultimate ของคนร้ายไม่มีประโยชน์กับคดีนี้จริง ๆ ให้ usedUltimate=false และใช้วิธีธรรมดา (ไม่จำเป็นต้องใช้ Ultimate เลยก็ได้ และหลาย ๆ คดีควรเป็นแบบนั้น)

### ค. ตำแหน่งและการเคลื่อนไหว (หัวใจของการสืบสวน) — ความรู้เป็น "ส่วนตัว" ไม่มีใครรู้ทุกอย่าง
8. whereabouts ต้องมีครบ "ทุกตัวละครที่มีชีวิต" (รวม culprit และ victim): where = ความจริงว่าช่วงเกิดเหตุคนนี้อยู่ที่ไหน ทำอะไร ระบบจะส่งให้ "เจ้าตัวเท่านั้น" (ทุกคนรู้ว่าตัวเองทำอะไรคืนนี้) ห้ามคนอื่นรู้โดยอัตโนมัติ
9. observations = เหตุการณ์ย่อย 4-7 รายการที่มีคนเห็น/ได้ยิน/อยู่ด้วย แต่ละรายการระบุ knownBy = เฉพาะคนที่อยู่ในเหตุการณ์นั้น (คนเห็น 1-2 คน และถ้าเป็นเหตุการณ์ร่วม เช่น สองคนนั่งคุยกัน ให้ทั้งคู่รู้) ไม่มีใครนอกเหตุการณ์รู้ และไม่มีรายการไหนที่ทุกคนรู้ เขียน text เป็นบุรุษที่สามด้วยชื่อเล่น ระบุเวลาและสถานที่ ห้ามใส่คำพูด/ข้ออ้างของตัวละครที่ถูกเห็น (ผู้เล่นจะแก้ตัวเองในแชท)
10. ให้มี 2-3 คนที่ถ้าเอา observations มาต่อกันแล้วดู "น่าสงสัย" (ไปอยู่ในที่ที่ไม่ควรอยู่ หรือหายจากที่ที่ควรอยู่) หนึ่งในนั้นคือคนร้าย ที่เหลือเป็นหลักฐานลวงที่มีเหตุผลบริสุทธิ์ และเหตุผลนั้นต้อง "ตรวจสอบได้" จาก observation อีกรายการที่คนอื่นรู้ (เช่น มีคนเห็นเขาที่ห้องน้ำจริงตอนนั้น) หรือจากการจับคู่พยาน (สองคนอยู่ด้วยกัน รู้ร่วมกัน)
11. คนร้ายต้องมีจุดอ่อน 1 จุดที่เป็น observation ซึ่ง "คนอื่นอย่างน้อย 1 คน" รู้ (เช่น มีคนตื่นมาเห็นเตียงว่าง มีคนเห็นเดินกลับมาจากทางที่เกิดเหตุ) คนร้ายเองไม่รู้แน่ชัดว่าถูกเห็นหรือไม่ ให้สื่อใน culpritStory แบบไม่ฟันธง ("คุณรู้สึกเหมือนมีคนขยับตัวตอนคุณเดินกลับเข้ามา")
12. ถ้ามีตัวละคร [โรลปลอม] หรือ [ซ่อน] ให้ใช้ประโยชน์ได้ เช่น หลักฐานชี้ว่า "ต้องเป็นคนรู้เคมี" แต่ไม่มีใครที่เปิดเผยว่าเป็นนักเคมี ผู้เล่นต้องสงสัยคนที่ Ultimate เป็น ??? หรือคนที่โรลอาจปลอม — แต่ห้ามเปิดเผย Ultimate จริงของคนเหล่านี้ใน publicReport / observations / privateClues ของคนอื่น

### ง. ข้อมูลที่แจกให้ผู้เล่น
13. publicReport = สิ่งที่ "ทุกคน" เห็นด้วยตาเปล่าที่จุดพบศพตอนเช้าเท่านั้น: discovery (ใครพบศพ ที่ไหน เมื่อไหร่), bodyState (สภาพศพที่คนธรรมดาเห็นได้ ต้องสอดคล้องกับ method.cause), suspiciousItems (2-4 ชิ้น อ้างอิง itemId พร้อมสิ่งที่สังเกตเห็น), sceneNotes (ความผิดปกติอื่นในที่เกิดเหตุ รวมร่องรอยการปกปิดถ้าเห็นได้ด้วยตา) ห้ามใส่ว่าใครเห็นใครที่ไหน (นั่นต้องเป็น observations) และห้ามบอกใบ้ชื่อคนร้ายตรง ๆ
14. privateClues = เบาะแสส่วนตัว 2-4 รายการ สำหรับตัวละครที่ไม่ใช่ culprit และ victim เขียนเป็นบุรุษที่สอง ("คุณ...") เป็นสิ่งที่คนนั้นรับรู้คนเดียว: เห็นเงา ได้ยินเสียง สังเกตของถูกย้าย
   - ถ้า ${murderer.nickname} ไม่ใช่ culprit และยังมีชีวิต ต้องมี privateClue ของ ${murderer.nickname} เล่าว่าแผนฆ่าของตัวเองเป็นอย่างไร/ล้มเหลวอย่างไร
   - ถ้า ${target.nickname} ไม่ใช่ culprit และยังมีชีวิต ต้องมี privateClue ของ ${target.nickname} เล่าสิ่งที่เจอมา
15. ultimateInsights = 1-3 รายการ สำหรับตัวละครที่ Ultimate ของตนทำให้รู้มากกว่าคนอื่นอย่างมีกลไก (ช่างไฟรู้ว่าเบรกเกอร์ถูกสับด้วยมือ นักเคมีรู้ว่ากลิ่นคือน้ำยาอะไร นิติเวชรู้เวลาตายจริง) ห้ามให้ culprit หรือ victim และถ้าเจ้าของ "ยังไม่รู้ตัว" ให้เขียนเป็นสัญชาตญาณ ("คุณรู้สึกได้โดยไม่รู้ว่าทำไม...")
16. culpritStory = ความจริงทั้งหมดเล่าให้คนร้ายฟังเป็นบุรุษที่สอง 4-8 ประโยค: ทำอะไร ปกปิดอย่างไร ทิ้งร่องรอยอะไรไว้ และปิดท้ายด้วยจุดที่อาจพลาดแบบไม่ฟันธง (ตามข้อ 11)
17. involvedCharacterIds = id ของตัวละครที่ Ultimate ของตนถูกใช้หรือมีบทบาทจริงในเหตุการณ์ (รวม culprit)
18. deductionChain = 3-5 ข้อ ลำดับเหตุผลที่ผู้เล่นใช้ได้จริง "ถ้าทุกคนเล่าสิ่งที่ตัวเองรู้ในแชท": เริ่มจากสาเหตุการตาย → ร่องรอยการปกปิดจำกัดวงเหลือใครบ้าง → observations ของแต่ละคนตัดใครออกได้ → เหลือคนร้าย
19. truthSummary = สรุปความจริง 3-5 ประโยคสำหรับเฉลยหลังโหวต: ใครทำ ทำอย่างไร ปกปิดอย่างไร อะไรเป็นหลักฐานลวง และ ${murderer.nickname} กับ ${target.nickname} เกี่ยวข้องอย่างไร
20. คดีต้อง "ไขได้": publicReport + observations (เมื่อทุกคนเล่า) + privateClues + ultimateInsights รวมกันแล้วชี้ไปที่ culprit ได้ตาม deductionChain แต่ไม่ง่ายเกินไป และคนร้ายต้องมีช่องให้โกหกได้ (ไม่มีใครเห็นตอนลงมือตรง ๆ)`;
          let inc = await callJson({ user, schema: IncidentSchema, effort: 'high', label: 'incident' });
          let problem = validate(inc);
          if (problem) {
            log.warn(`[ai] incident invalid (${problem}) → retry once`);
            inc = await callJson({
              user: `${user}\n\n## ข้อผิดพลาดจากรอบก่อน (ต้องแก้)\n${problem}`,
              schema: IncidentSchema,
              effort: 'high',
              label: 'incident-retry',
            });
            problem = validate(inc);
            if (problem) throw new Error(`incident still invalid: ${problem}`);
          }
          return clean(inc);
        },
        () => mockIncident(ctx),
      );
    },
  };
}
