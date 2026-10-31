# รูปตัวละคร (Portraits)

วางไฟล์รูปในโฟลเดอร์นี้ชื่อตาม id ของตัวละคร: `c01.png` … `c15.png` (รองรับ .png / .jpg / .webp)
เซิร์ฟเวอร์จะตรวจหาไฟล์ตอนเริ่ม (`npm start`) แล้วแสดงบนการ์ดผู้เล่น การ์ดของคุณ และหน้าสรุปผลอัตโนมัติ
ถ้าไม่มีไฟล์ จะแสดงวงกลมตัวอักษรแรกของชื่อเล่นแทน

แนะนำ: รูปสี่เหลี่ยมจัตุรัส 512×512 ครอปครึ่งตัวบน (bust) พื้นหลังเรียบ ขนาดไฟล์ไม่เกิน 300 KB ต่อรูป

## Prompt สำหรับเจนรูป (สไตล์ลายเส้นอนิเมะ)

ใช้กับ image generator ใดก็ได้ (Midjourney, Stable Diffusion/NovelAI, DALL·E, Imagen ฯลฯ)
ขึ้นต้นทุก prompt ด้วย style prefix เดียวกันเพื่อให้ทั้ง 15 รูปดูเป็นชุดเดียว:

```
anime line art character portrait, clean ink linework, flat cel shading, bust shot facing slightly left, neutral dark background, mystery visual-novel style, consistent art style, high detail face, no text, no watermark
```

ต่อท้ายด้วยรายละเอียดของแต่ละตัว (ภาษาอังกฤษ):

| ไฟล์ | ตัวละคร | รายละเอียดต่อท้าย prompt |
|---|---|---|
| c01.png | ฮายาชิ ฮินาตะ (ฮินะ) — หญิง 19 | young woman, black bob haircut with a star-shaped hair clip, oversized denim jacket over a school uniform, cheerful talkative expression, bright eyes |
| c02.png | คุโรซาวะ เรน (เรน) — ชาย 21 | tall young man, buzz cut, black-rimmed glasses, perfectly pressed dress shirt, calm composed expression, logical and quiet |
| c03.png | ฟูจิวาระ มิโอะ (มิโอะ) — หญิง 20 | young woman, long light-brown hair in a side braid, dress with cherry blossom pattern, gentle soft smile, quietly stubborn eyes |
| c04.png | ไซโต้ เรียว (เรียว) — ชาย 18 | teenage boy, silver-dyed hair, multiple ear piercings, headphones around neck, cold sarcastic smirk, distrustful eyes |
| c05.png | ทาคาฮาชิ อายาเนะ (อายะ) — หญิง 22 | young woman, high top-knot bun, bold heavy makeup, bright red nails, confident loud personality, hand on hip |
| c06.png | โอกาวะ ไดกิ (ไดกิ) — ชาย 20 | big muscular tanned young man, tank top, hachimaki headband, kind honest face, slightly hot-headed |
| c07.png | โมริ โคโตฮะ (โคโตะ) — หญิง 17 | petite teenage girl, two low pigtails, hugging a rabbit plush, shy nervous expression, observant eyes |
| c08.png | นากามูระ โชตะ (โชตะ) — ชาย 23 | young man, long curly hair in a half-up bun, thin beard, loud colorful Hawaiian shirt, flirty easygoing grin |
| c09.png | คิริชิมะ อาโออิ (อาโออิ) — หญิง 21 | young woman, short layered haircut, small wrist tattoo, leather jacket, sharp direct gaze, fierce sense of justice |
| c10.png | ซาคุไร ฮารุโตะ (ฮารุ) — ชาย 19 | thin tall young man, long bangs covering one eye, grey hoodie, holding a small notebook, withdrawn suspicious look |
| c11.png | โทโดะ คาเอเดะ (คาเอเดะ) — หญิง 24 | elegant woman, long straight jet-black hair, navy business suit, poised graceful posture, knowing confident smile |
| c12.png | มิยาซากิ โซตะ (โซตะ) — ชาย 18 | pale teenage boy, messy brown hair, cartoon-print t-shirt, holding a film camera, dreamy innocent expression |
| c13.png | อามามิยะ ซึกิ (ซึกิ) — หญิง 20 | young woman, pastel blue hair, streetwear-modified kimono, serene mysterious expression, holding a teacup |
| c14.png | คาเนชิโร่ เลออน (เลออน) — ชาย 22 | mixed-heritage young man, green eyes, blond hair, deep red suit, overly polite constant smile, unreadable |
| c15.png | ฮิมุระ ซายะ (ซายะ) — หญิง 25 | woman, traditional low chignon, dark hakama, scar through left eyebrow, stern quiet protective expression |

ตัวอย่าง prompt เต็มสำหรับ c01:

```
anime line art character portrait, clean ink linework, flat cel shading, bust shot facing slightly left, neutral dark background, mystery visual-novel style, consistent art style, high detail face, no text, no watermark, young woman, black bob haircut with a star-shaped hair clip, oversized denim jacket over a school uniform, cheerful talkative expression, bright eyes
```

Negative prompt (ถ้าเครื่องมือรองรับ): `text, watermark, logo, extra fingers, blurry, photo-realistic, 3d render, multiple people`

หมายเหตุ: ข้อมูลรูปลักษณ์ต้นทางอยู่ใน `server/characters.js` ถ้าแก้ตัวละครให้แก้ prompt ตามด้วย
