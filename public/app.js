(() => {
  'use strict';

  // ---------- utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  const PHASE_LABEL = {
    lobby: 'ล็อบบี้',
    generating: 'กำลังสร้างโลก...',
    day: 'กลางวัน',
    investigation: 'รอบเก็บหลักฐาน',
    trial: 'การตัดสิน',
    trial_result: 'ผลการตัดสิน',
    ended: 'จบเกม',
  };
  const STEP_LABEL = { move: 'เลือกห้องที่จะไป', act: 'เลือกสิ่งที่จะทำ', report: 'พักชั่วโมง — อ่านบันทึก / ให้ของ' };
  const FATE_LABEL = { victim: 'ถูกฆ่า', executed: 'ถูกประหาร', punished: 'ถูกประหาร (โหวตผิด)', escaped: 'คนร้ายรอด', survivor: 'รอดชีวิต', left_behind: 'ถูกทิ้งไว้ (ฆาตกรหนีไม่ได้)' };
  const FATE_ICON = { victim: '☠', executed: '⛓', punished: '⚖', escaped: '🏃', survivor: '🏁', left_behind: '🚫' };
  const FATE_CLASS = { victim: 'purple', executed: 'red', punished: 'red', escaped: 'yellow', survivor: 'green', left_behind: 'red' };
  const END_LABEL = {
    escape: '🚪 หนีออกมาได้สำเร็จ',
    wrong_vote: '☠ โหวตผิด — คนร้ายชนะ',
    last_one: '🏁 เหลือผู้รอดชีวิตคนเดียว',
    few_left: '🏁 เหลือคนน้อยเกินกว่าจะเล่นต่อ — ผู้ที่เหลือรอดชีวิต',
    only_killers: '🩸 คนที่เหลือล้วนเคยฆ่า — ผู้ที่เหลือรอดชีวิต',
    timeout: '⏳ ครบกำหนดชั่วโมงสูงสุด — ผู้ที่เหลือได้รับการช่วยเหลือ',
  };
  const TRAIT_LABEL = { combat: 'นักสู้', stealth: 'เงียบเชียบ', medical: 'การแพทย์', tech: 'ช่างเทคนิค', social: 'นักพูด', detective: 'ช่างสังเกต', none: '' };
  const KIND_ICON = { weapon: '🔪', poison: '🧪', tool: '🧰', rope: '🪢', food: '🍞', key: '🗝', cloth: '🧣', clue: '🗺', part: '⭐', trap: '🪤', power: '⚡', fixture: '🪑', lockpick: '🪛', medicine: '💊' };
  const ROUTE_ICON = { locked: '🗝', code: '🔢', repair: '🔧', power: '⚡', breach: '🔨' };

  const store = {
    get playerId() {
      let id = localStorage.getItem('dr_playerId');
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        localStorage.setItem('dr_playerId', id);
      }
      return id;
    },
    get name() { return localStorage.getItem('dr_name') || ''; },
    set name(v) { localStorage.setItem('dr_name', v); },
    get code() { return localStorage.getItem('dr_code') || ''; },
    set code(v) { if (v) localStorage.setItem('dr_code', v); else localStorage.removeItem('dr_code'); },
  };

  const socket = io();
  let state = null;
  let currentScreen = null;
  let countdownTimer = null;
  const ui = { joinError: '', selectedZone: null, selectedAction: null, moveBodyTo: '', notebookOpen: true, ghostTab: 'watch', seenAnnouncement: '', seenEventDay: 0, seenResultTurn: 0, seenDayPopup: 0 };

  const send = (event, payload = {}) =>
    new Promise((resolve) => {
      socket.emit(event, payload, (ack) => resolve(ack || { ok: true }));
    });
  const act = async (event, payload) => (await send(event, payload)).ok;

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function mount(screen, html) {
    if (currentScreen === screen) return false;
    currentScreen = screen;
    $('#app').innerHTML = html;
    return true;
  }

  // อัปเดต innerHTML เฉพาะเมื่อเนื้อหาเปลี่ยนจริง ลดการกะพริบและไม่ทำลาย DOM โดยไม่จำเป็น
  function setHtml(sel, html) {
    const el = $(sel);
    if (!el) return;
    if (el.dataset.lastHtml === html) return;
    el.dataset.lastHtml = html;
    el.innerHTML = html;
  }

  const playerById = (id) => state.players.find((p) => p.id === id);
  const displayName = (id) => {
    if (id === 'none') return 'ไม่มีคนร้ายให้ลงโทษ';
    const p = playerById(id);
    if (!p) return '???';
    return p.character ? `${p.character.name} (${p.name})` : p.name;
  };
  const zoneById = (id) => state.location?.zones.find((z) => z.id === id);
  const zoneName = (id) => zoneById(id)?.name || '?';
  const actionKey = (a) => `${a.type}|${a.itemId || ''}|${a.targetId || ''}|${a.victimId || ''}|${a.recipeId || ''}|${a.exitId || ''}`;
  const timeText = (day, hour) => `วันที่ ${day}${hour ? ` ชั่วโมงที่ ${hour}` : ''}`;

  // รูปตัวละคร: ถ้ามีไฟล์ใน public/portraits ใช้รูป ไม่งั้นใช้วงกลมตัวอักษรแรกของชื่อเล่น
  function avatarHtml(c, size = 'sm') {
    if (!c) return '';
    if (c.portrait) return `<img class="avatar ${size}" src="${esc(c.portrait)}" alt="${esc(c.nickname)}" loading="lazy">`;
    const hue = [...c.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);
    return `<span class="avatar ${size} initial" style="--hue:${hue}">${esc((c.nickname || '?').slice(0, 1))}</span>`;
  }

  // ---------- socket ----------
  const connBanner = $('#conn-banner');
  const showBanner = (text) => {
    if (!connBanner) return;
    connBanner.textContent = text;
    connBanner.hidden = false;
  };
  const hideBanner = () => {
    clearTimeout(bannerTimer);
    if (connBanner) connBanner.hidden = true;
  };
  let bannerTimer = setTimeout(() => {
    if (!socket.connected) showBanner('⏳ กำลังเชื่อมต่อเซิร์ฟเวอร์... ถ้าเซิร์ฟเวอร์หลับอยู่ อาจต้องรอปลุกราว 1 นาที');
  }, 2500);

  socket.on('connect', () => {
    hideBanner();
    if (store.code && store.name) rejoin();
    else if (!state) renderJoin();
  });
  socket.on('state', (s) => {
    state = s;
    onState();
  });
  socket.on('error:msg', ({ message }) => toast(message, 'error'));
  socket.on('disconnect', () => {
    toast('หลุดจากเซิร์ฟเวอร์ กำลังเชื่อมต่อใหม่...', 'warn');
    showBanner('⚠ หลุดจากเซิร์ฟเวอร์ กำลังเชื่อมต่อใหม่อัตโนมัติ... (ห้องและตัวละครของคุณยังอยู่)');
  });
  setInterval(() => fetch('/health', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  async function rejoin() {
    const ack = await send('room:join', { code: store.code, name: store.name, playerId: store.playerId });
    if (!ack.ok) {
      store.code = '';
      state = null;
      ui.joinError = ack.error || '';
      renderJoin();
    }
  }

  function onState() {
    const s = state;
    if (!s.me) return renderJoin();
    if (s.phase === 'lobby') return renderLobby();
    if (s.phase === 'ended') return renderEnd();
    if (s.step !== 'move') ui.selectedZone = null;
    if (s.step !== 'act') {
      ui.selectedAction = null;
      ui.moveBodyTo = '';
    }
    renderGame();
    const annKey = s.announcement ? `${s.announcement.turn}:${(s.announcement.caseIds || []).join(',')}` : '';
    if (s.phase === 'investigation' && annKey && annKey !== ui.seenAnnouncement) {
      ui.seenAnnouncement = annKey;
      openModal(`<h2 style="color:var(--red)">🔔 ประกาศพบศพ!</h2>${casesHtml(s)}<p class="muted">ของในทุกห้องถูกจัดใหม่ — เลือกห้องที่จะไปเก็บหลักฐาน 1 ห้อง ทำได้ 1 อย่าง แล้วเข้าสู่การตัดสิน</p>`, 'เริ่มเก็บหลักฐาน');
    }
    if (s.dayPopup && s.dayPopup.day === s.day && s.hour <= 1 && s.dayPopup.turn !== ui.seenDayPopup) {
      ui.seenDayPopup = s.dayPopup.turn;
      openModal(`<h2>🌙 ขึ้นวันใหม่ — วันที่ ${s.day}</h2><p>${esc(s.dayPopup.text)}</p>`, 'รับทราบ');
    }
    if (s.phase === 'day' && s.step === 'move' && s.specialEvent && s.specialEvent.day === s.day && s.specialEvent.day !== ui.seenEventDay) {
      ui.seenEventDay = s.specialEvent.day;
      openModal(eventHtml(s), 'รับทราบ');
    }
    if (s.phase === 'trial_result' && s.lastResult && s.lastResult.turn !== ui.seenResultTurn) {
      ui.seenResultTurn = s.lastResult.turn;
      openModal(resultHtml(s), 'ปิด');
    }
    if (s.stepDeadline && !countdownTimer) countdownTimer = setInterval(updateCountdown, 1000);
    if (!s.stepDeadline && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // ---------- join ----------
  function renderJoin() {
    currentScreen = 'join';
    $('#app').innerHTML = `
      <div class="screen join">
        <div class="hero">
          <h1>DESPAIR BOARD<span>บอร์ดเกมสืบสวนฆาตกรรม</span></h1>
          <p class="muted">3–15 ผู้เล่น · สำรวจห้อง · หาทางหนี · ใครก็เป็นฆาตกรได้ · โหวตผิด = ทุกคนตาย</p>
        </div>
        <form id="join-form" class="card">
          <label>ชื่อของคุณ<input id="name" maxlength="24" required placeholder="เช่น ยูกิ" value="${esc(store.name)}"></label>
          <div class="row">
            <button type="submit" class="primary" data-action="create">สร้างห้องใหม่</button>
          </div>
          <div class="divider">— หรือเข้าร่วมด้วยรหัสห้อง —</div>
          <div class="row">
            <input id="code" class="code-input" maxlength="4" placeholder="AB12" autocomplete="off" value="${esc(ui.inviteCode || '')}">
            <button type="submit" data-action="join">เข้าร่วมห้อง</button>
          </div>
          <p class="error">${esc(ui.joinError)}</p>
        </form>
        <div class="card rules">
          <h3>กติกาย่อ</h3>
          <ul class="short">
            <li>ทุกคนถูกขังในสถานที่ที่มีหลายห้อง หาทางออกให้เจอแล้วทำครบทุกขั้นเพื่อหนี</li>
            <li>เข้าห้อง 1 ครั้ง = 1 ชั่วโมง ทุกคนเลือกห้องพร้อมกัน แล้วทำได้ 1 อย่างต่อชั่วโมง</li>
            <li>ใครก็ฆ่าได้ แต่มือเปล่าทำได้แค่สลบ ต้องใช้ของจริง: อาวุธ กับดัก ยาพิษ ไฟดับ ทางลับ</li>
            <li>พบศพครบ 3 คน (คนลงมือนับด้วย) → เก็บหลักฐาน → โหวต: ถูก = ประหาร · ผิด = ทุกคนตาย</li>
            <li>ประกาศบอกแค่ใครตายที่ไหน สภาพศพต้องตรวจเอง ร่องรอยต้องสำรวจห้อง ไม่มีใครบอกชื่อของ</li>
            <li>ภารกิจลับละเลยได้ แต่ครบกำหนดแล้วไม่ทำ = สลบ 1–3 ชั่วโมง</li>
            <li>Ultimate ให้ความสามารถจริง บางคนถูกซ่อนเป็น ??? หรือถือโรลปลอม</li>
            <li>ตายแล้วเป็นผี คุยกับผีด้วยกันและตามดูคนเป็นได้</li>
          </ul>
          <details><summary>กติกาเต็ม (กดเพื่อดู)</summary>
          <ol>
            <li><b>เป้าหมายหลัก:</b> ทุกคนถูกขังในสถานที่เดียวที่มีหลายห้อง ห้องมี = ผู้เล่น × 2 · ทางออกแต่ละทางต้องผ่าน <b>4–5 ขั้น</b> (กุญแจ/เศษรหัส/ชิ้นส่วนที่ต้องประกอบก่อน · เครื่องมือช่าง · ของมีคม · ลงแรง) ของพวกนี้ถูกสุ่มซ่อนไว้ตามห้อง ขั้นที่ทำแล้วติดถาวร คนที่ลงมือพร้อมกันในห้องนับของรวมกัน → ทุกคนที่ยังอยู่รอด — ยกเว้น<b>ฆาตกรที่ยังไม่ถูกจับ</b>: ประตูจะปิดใส่หน้าและนับว่าตายทันที</li>
            <li><b>เวลา:</b> ทุกครั้งที่เข้าห้อง = 1 ชั่วโมง (รวมรอบเก็บหลักฐาน) ตัดสินคดีเสร็จจึงขึ้นวันใหม่ ไม่มีเวลาจำกัดทั้งในเกมและเวลาจริง</li>
            <li><b>แต่ละชั่วโมง:</b> ทุกคนเลือกห้องพร้อมกัน (ไม่มีใครรู้ว่าใครเลือกอะไร) → เห็นว่าใครอยู่ห้องเดียวกับคุณ เห็นของในห้อง → <b>หยิบ/วาง/ซ่อนของทำได้ทันทีไม่กินชั่วโมง</b> (ทั้งตอนเลือกแอ็กชันและตอนพัก) แล้วเลือกทำได้อีก 1 อย่าง: สำรวจ ลงมือฆ่า วางกับดัก ย้ายศพ ทำลายหลักฐาน ตรวจศพ… ทุกอย่างมีโอกาสสำเร็จ/พลาด/สำเร็จแบบเลอะเทอะ → พักชั่วโมง: อ่านบันทึก และ<b>ให้ของ</b>กับคนในห้องเดียวกันได้ · เดินไปเจอห้องที่ล็อก = <b>ยืนรอหน้าประตู (ข้างนอก)</b> ทำอะไรกับห้องไม่ได้ ทำได้แค่กับคนที่ยืนอยู่หน้าประตูด้วยกัน · <b>กับดักประตู</b> (อาวุธ+เครื่องมือ) วางข้างใน = คนที่เปิดประตูเข้ามาตาย วางข้างนอก = คนที่เปิดประตูออกมาตาย คนที่ปลดล็อกโดนก่อน</li>
            <li><b>ของแต่ละชิ้นทำอะไรได้ดูจากป้ายกำกับ</b> (หนัก · มีคม · ยิงได้ · เครื่องมือช่าง · นำไฟฟ้า · ฉีดได้): ลงมือด้วยปืน 85% (กระสุนจำกัด ยิงแล้วทั้งตึกได้ยิน) · อาวุธมีคม/หนัก 70% · อาวุธเบา 50% · เครื่องมือที่หนักหรือปลายแหลม 55% · ผ้า (อุดหายใจ) / เชือก (รัดคอ) 50% · ยาพิษลงมือตรงต้องมี<b>เข็มฉีดยา</b> (65%) หรือเป็นสายการแพทย์ (80%) ไม่งั้นผสมอาหารได้อย่างเดียว · สมุด วิทยุ ไฟฉาย กล้อง กุญแจมือ ใช้ฆ่าหรือประกอบกับดักไม่ได้ · ยากลิ่นฉุนคนกินสังเกตง่าย (60%) ยาไร้สีไร้รสสังเกตยาก (5%) พิษที่ต้องเข้ากระแสเลือดผสมอาหารไม่ได้ · สูตรกับดักดูแท็ก: ใบมีดเหวี่ยง = อาวุธมีคม/หนัก + เชือก · ของหนักหล่น = ของหนัก + เชือก · ไฟช็อต = เครื่องมือช่าง + สายไฟจริง · กับดักประตู = ปืนมีกระสุน/มีคม/หนัก + เครื่องมือช่าง · ซ่อมทางออกและช่างเทคนิคสะเดาะต้องใช้เครื่องมือช่าง ทุบ/งัดต้องของหนักหรืออาวุธมีคม</li>
            <li><b>ประตูที่ล็อก:</b> มีกุญแจต้องกด 🔑 ไขเอง (ทันที ไม่กินชั่วโมง) แล้วชั่วโมงถัดไปค่อยเข้า/ออก · ไม่มีกุญแจ: 🪛 สะเดาะ (ที่สะเดาะกุญแจ หรือช่างเทคนิค+เครื่องมือช่าง 2–3 ชม.) หรือ 💥 พังประตู (ใครก็ได้ 3–4 ชม. นักสู้ 1–2 ชม. เสียงดัง) เป็นแอ็กชันที่ต้องเลือกซ้ำทุกชั่วโมงจนสำเร็จ · 🫥 ซ่อนของใช้ 1 ชั่วโมงแต่ซ่อนได้หลายชิ้น (หยิบ/วางทำได้ทันที) · ไม่มีใครเห็นว่าใครเลือกแล้วหรือยัง · ครบ 23 ชั่วโมงโดยไม่มีการตัดสิน = ขึ้นวันใหม่เอง · ต่อยคนที่สลบอยู่ไม่ได้ (ต้องใช้ของที่ฆ่าได้) · สุดยอดนักเดินป่าถือของได้ 5 ชิ้น</li>
            <li><b>🩸 อาวุธเปื้อนเลือด:</b> ของที่ใช้ฆ่าจนเกิดแผล (ของมีคม/ของหนัก/ปืน) จะติดคราบเลือด ใครเห็นในมือ ในห้อง หรือตอนตรวจกระเป๋าก็รู้ · ต้องไปห้องที่มีน้ำ (ห้องน้ำ ครัว ซักล้าง สระ ฯลฯ) แล้วเลือก "ล้าง" (ใช้ชั่วโมง) แต่อ่างอาจเก็บคราบจาง ๆ ไว้ · ตอนตัดสิน <b>ขอตรวจกระเป๋า</b>คนอื่นได้ ถ้าเจ้าของยอม ของทั้งหมดจะถูกประกาศในแชท</li>
            <li><b>🚧 ค้ำประตู · 🕳 ทางลับ · 🌑 ไฟดับ:</b> ถือแท่งเหล็ก/ท่อนไม้/ไม้เบสบอลแล้วกด "ค้ำประตู" (ทันที) จากข้างใน — คนนอกเข้าไม่ได้แม้มีกุญแจ ต้องพังประตู ส่วนคนในเอาออกได้ทันที · ทุกเกมสุ่มคู่ห้องที่มีทางลับถึงกัน (1 คู่ต่อ 8 ห้อง) สำรวจเจอ 20% (ช่างสังเกต 50%) เดินทะลุได้แม้ประตูล็อก/ค้ำ และไม่โดนกับดักประตู · ที่ห้องเครื่องปั่นไฟกด "พังเครื่องปั่นไฟ" (ทันที) = ไฟดับทั้งตึก: ใครไม่มีของส่องสว่าง (เทียน/ไฟฉาย/ไฟแช็ก) จะมองไม่เห็นคนและของ หยิบได้แค่ "คลำ" สุ่ม 1 ชิ้นต่อชั่วโมง เทรดไม่ได้ ไม่มีพยาน · มีของส่องสว่างในห้อง = ทุกคนในห้องเห็นปกติ · แว่นมองกลางคืนเห็นเฉพาะคนใส่ · ซ่อมที่เครื่องปั่นไฟ 2–3 ชั่วโมง (ช่างเทคนิค 1)</li>
            <li><b>💊 ยาในอาหาร:</b> ยาพิษ = ตาย · ยานอนหลับ/ยาสลบ = สลบ · ยาบำรุง (บำรุง/วิตามิน) = คนกินได้เวลาภารกิจถัดไป +1 ชั่วโมง · ยารักษา (ยาแก้/ยาสามัญ) = ต้านทานการสลบ 1 ครั้ง — ผสมแล้วอยู่ในอาหารทั้งวัน ใครกินก็ได้ผล</li>
            <li><b>🤝 สำรวจร่วมกัน:</b> ถ้าคนที่อยู่ในห้องเดียวกัน (และมองเห็นกัน) รู้ทางออก/ทางลับของห้องนั้นอยู่แล้ว หรือสำรวจพร้อมกันแล้วเจอ คุณที่กดสำรวจจะเจอด้วยแน่นอน ไม่ต้องกระซิบบอกกัน · <b>จบเกมทันที</b>เมื่อเหลือคนไม่เกินหนึ่งในสามของผู้เล่น หรือคนที่เหลือทุกคนล้วนเคยฆ่า (ผู้ที่เหลือรอด) · <b>ครบ 24 ชั่วโมง</b>: ถ้ามีศพที่ยังไม่ถูกพบจะประกาศพบศพทันที ถ้าไม่มีจะขึ้นวันใหม่</li>
            <li><b>ใครก็เป็นฆาตกรได้:</b> คนที่ลงมือคือคนร้าย เกมจะสุ่ม "ฆาตกรประจำวัน" ให้โบนัส แต่ถ้าคนอื่นลงมือก่อน คนนั้นก็เป็นแค่พยาน</li>
            <li><b>ภารกิจลับ:</b> ทุกคนมีภารกิจทีละข้อ (ไปห้อง X / หยิบของ Y / ไปอยู่กับ Z) มีเวลา 3–5 ชั่วโมง <b>ละเลยได้</b> แต่ถ้าครบกำหนดแล้วยังไม่ทำ จะโดนลงโทษ: <b>สลบ 1–3 ชั่วโมง</b> (ทำอะไรไม่ได้ ไม่รู้ว่ารอบตัวเกิดอะไรขึ้น) ของบางชิ้นหล่นในห้อง และระหว่างสลบใครลงมือกับคุณก็สำเร็จแน่นอน · ภารกิจที่ทำไม่ได้แล้วโดยไม่ใช่ความผิดคุณถูกยกเลิกโดยไม่มีโทษ</li>
            <li><b>ลงมือสำเร็จไม่ได้แปลว่าตาย:</b> โอกาสฆ่าขึ้นกับของ (ปืน 90% · มีคม 70% · หนัก 55% · เชือก 60% · ผ้า 35% · ยาพิษ 85% · ของเบา 25%) ที่เหลือเป้าหมายแค่ <b>สลบ 1–3 ชั่วโมง</b> · <b>มือเปล่า ยานอนหลับ ยาสลบ ทำให้สลบเท่านั้น</b> ฆ่าไม่ได้ (ยกเว้นนักสู้ต่อยฆ่าได้ 5%) · คนที่สลบอยู่ถูกลงมือสำเร็จแน่นอน (ของฆ่าได้ = ตาย) · ลงมือพลาดแล้วเป้าหมายสวนกลับได้ 25% (นักสู้ 50% · ถืออาวุธ +15%) ผลของการสวนกลับขึ้นกับของที่เขาถือ: ฆ่าคุณหรือทำให้คุณสลบ</li>
            <li><b>ศพอยู่ที่ตาย:</b> จนกว่าจะมีคนย้าย เมื่อมีคนพบศพครบ 3 คน (คนที่ลงมือฆ่าเองนับเป็นคนแรก คนวางกับดัก/ยาพิษไม่นับจนกว่าจะเดินมาเห็นศพเอง) จะประกาศและเข้าสู่รอบเก็บหลักฐาน <b>1 ชั่วโมง + 1 ชั่วโมงต่อศพ</b> (2 ศพ = 3 ชั่วโมง) ช่วงนี้ไม่มีใครตาย: ลงมือ วางกับดัก วางยา กินอาหารไม่ได้ และกับดักที่ตั้งไว้ไม่ทำงาน · คนที่สลบอยู่ตอนพบศพจะยังสลบต่อ (สืบสวนและโหวตไม่ได้จนกว่าจะฟื้น เวลาสลบนับตามปกติ) แล้วตัดสิน · ประกาศบอกแค่ใครตายและพบที่ไหน: สภาพศพต้อง \"ตรวจศพ\" (ไม่บอกชื่อของ บอกแค่ชนิดแผล) ร่องรอยและอุปกรณ์กับดักที่ทิ้งไว้ต้อง \"สำรวจห้อง\"</li>
            <li><b>การตัดสิน:</b> เล่าหลักฐานที่แต่ละคนเจอในแชท แล้วโหวต — โหวตถูก: คนนั้นถูกประหาร (ใครก็เป็นฆาตกรได้พร้อมกันหลายคน ถ้ายังมีฆาตกรเหลือ ระบบบอกแค่ว่า "ยังมีอีก 1 คน" ไม่บอกจำนวน แล้วเก็บหลักฐาน-ตัดสินต่อในวันเดิมจนจับครบ) · โหวตผิด: คนร้ายรอด ทุกคนที่เหลือตาย เกมจบ · มีตัวเลือก "ไม่มีคนร้ายให้ลงโทษ" ถ้าคนร้ายตายไปแล้ว</li>
            <li>ทุกคนมี Ultimate ที่ให้ "trait" ใช้ได้จริง · 1–2 คนถูกซ่อนเป็น ??? และ 1 คนถือโรลปลอม — เจ้าตัวรู้ของจริงเสมอ และการ์ดของคุณจะบอกชัดว่าคนอื่นเห็นคุณเป็นอะไร</li>
            <li><b>👻 ตายแล้วไม่เหงา:</b> ผีพิมพ์ในแชทได้เป็น \"แชทผี\" (คนเป็นมองไม่เห็นจนเกมจบ) เห็นทุกห้อง ทุกคน กับดัก ของที่ซ่อน เหตุการณ์จริง และโหวตของทุกคน · กด \"ตามดู\" คนเป็นทีละคนเพื่ออ่านสมุดบันทึกของเขา</li>
          </ol>
          </details>
        </div>
      </div>`;
  }

  // ---------- lobby ----------
  function chatFormHtml() {
    return `<form id="chat-form" class="chat-form"><input id="chat-input" maxlength="500" placeholder="พิมพ์ข้อความ..." autocomplete="off"><button type="submit">ส่ง</button></form>`;
  }

  function aiBadge(s) {
    return `<span class="badge ${s.aiMode === 'claude' ? 'cyan' : 'yellow'}" title="${s.aiMode === 'claude' ? 'เนื้อหาถูกเจนโดย Claude' : 'โหมดสำรอง: ใช้ข้อมูลตัวอย่างในเครื่อง'}">AI: ${s.aiMode === 'claude' ? 'Claude' : 'Mock'}</span>`;
  }

  const inviteLink = (code) => `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
  const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  function renderLobby() {
    const s = state;
    mount(
      'lobby',
      `<div class="screen lobby">
        <header>
          <div><div class="muted">รหัสห้อง</div><div class="code-big">${esc(s.code)}</div></div>
          <button class="small" data-action="copy-code">คัดลอกรหัส</button>
          <button class="small" data-action="copy-link" title="${esc(inviteLink(s.code))}">🔗 คัดลอกลิงก์เชิญ</button>
          ${aiBadge(s)}
          <div class="spacer"></div>
          <button class="small ghost" data-action="leave">ออกจากห้อง</button>
        </header>
        <div class="card players"><h3>ผู้เล่นในห้อง</h3><ul id="lobby-players"></ul></div>
        <div class="card" id="lobby-controls"></div>
        <div class="card chat"><h3>แชท</h3><div id="chat-log" class="chat-log"></div>${chatFormHtml()}</div>
      </div>`,
    );
    setHtml('#lobby-players', s.players
      .map(
        (p) => `<li class="${p.connected ? '' : 'offline'}">
          ${p.isHost ? '👑' : '•'} <b>${esc(p.name)}</b>
          ${p.isBot ? '<span class="badge">บอท</span>' : ''}
          ${p.id === s.me.id ? '<span class="badge cyan">คุณ</span>' : ''}
          ${!p.connected ? '<span class="badge">ออฟไลน์</span>' : ''}
        </li>`,
      )
      .join(''));
    const humans = s.players.filter((p) => !p.isBot).length;
    const bots = s.players.filter((p) => p.isBot).length;
    const maxBots = Math.max(0, s.config.maxPlayers - humans);
    setHtml('#lobby-controls', s.me.isHost
      ? `<h3>ตั้งค่าเกม (หัวห้อง)</h3>
        <div class="row">
          <label>จำนวนบอท <select id="bot-count">${range(0, maxBots).map((n) => `<option value="${n}" ${n === bots ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <span class="muted">ผู้เล่นทั้งหมด ${s.players.length}/${s.config.maxPlayers} (ขั้นต่ำ ${s.config.minPlayers})</span>
        </div>
        <p class="muted">บอทจะเดินสำรวจ ทำภารกิจ และโหวตเอง (บางครั้งก็ลงมือฆ่า) · ไม่มีเวลาจำกัด · ประกาศศพเมื่อมีคนพบ ${s.config.bodyDiscoverers} คน · ภารกิจมีเวลา 3–5 ชั่วโมง</p>
        <p class="muted">ชวนเพื่อน: ส่งลิงก์ <code>${esc(inviteLink(s.code))}</code> หรือรหัส <b>${esc(s.code)}</b> ${isLocalHost() ? '<br><span class="warn">⚠ ลิงก์นี้เป็น localhost เพื่อนเครื่องอื่นเปิดไม่ได้ — เปิดเว็บผ่าน IP ในวง Wi-Fi หรือ URL จาก npm run share แล้วค่อยคัดลอกลิงก์ (ดู README หัวข้อ "เล่นกับเพื่อน")</span>' : ''}</p>
        <button class="primary" data-action="start" ${s.players.length < s.config.minPlayers ? 'disabled' : ''}>เริ่มเกม</button>`
      : `<h3>รอหัวห้องเริ่มเกม</h3><p class="muted">ผู้เล่น ${s.players.length}/${s.config.maxPlayers} · ชวนเพื่อนเพิ่มด้วยลิงก์ <code>${esc(inviteLink(s.code))}</code> หรือรหัส <b>${esc(s.code)}</b></p>`);
    renderChat();
  }

  // ---------- game ----------
  function renderGame() {
    const s = state;
    mount(
      'game',
      `<div class="screen game">
        <header id="topbar" class="topbar"></header>
        <div class="layout">
          <aside id="roster" class="roster"></aside>
          <section class="center">
            <div id="main" class="main"></div>
            <div class="card chat"><div id="chat-log" class="chat-log"></div>${chatFormHtml()}</div>
          </section>
          <aside id="side" class="side"></aside>
        </div>
      </div>`,
    );
    const alive = s.players.filter((p) => p.alive).length;
    const phaseText = s.step && (s.phase === 'day' || s.phase === 'investigation') ? `${PHASE_LABEL[s.phase]} · ${STEP_LABEL[s.step]}` : PHASE_LABEL[s.phase] || s.phase;
    setHtml('#topbar', `
      <span class="logo">DESPAIR BOARD</span>
      <span class="badge">ห้อง ${esc(s.code)}</span>
      <span class="badge pink">🕐 วันที่ ${s.day} · ชั่วโมงที่ ${s.hour}</span>
      ${s.me?.blackout ? '<span class="badge red" title="เครื่องปั่นไฟถูกพัง ซ่อมได้ที่ห้องที่มีแผงไฟ">🌑 ไฟดับทั้งตึก</span>' : ''}
      <span class="phase">${esc(phaseText)}</span>
      ${s.location ? `<span class="loc">📍 ${esc(s.location.name)}</span>` : ''}
      ${s.stepDeadline ? `<span class="badge yellow">⏱ <span id="step-countdown">--</span></span>` : ''}
      <span class="spacer"></span>
      ${s.location && s.me?.exits ? `<span class="badge ${s.me.exits.length ? 'yellow' : ''}" title="ทางออกที่คุณค้นพบแล้ว (คนอื่นไม่รู้ว่าคุณรู้)">🚪 ทางออกที่คุณรู้จัก ${s.me.exits.length}/${s.exitsTotal}</span>` : ''}
      ${aiBadge(s)}
      <span class="badge" title="นับเฉพาะคนที่รู้แน่ว่าตายแล้ว">ยังอยู่ ${alive}/${s.players.length}</span>`);
    setHtml('#roster', s.players.map((p) => playerCard(s, p)).join(''));
    renderMain(s);
    renderSide(s);
    renderChat();
    if (s.stepDeadline) updateCountdown();
  }

  function traitBadge(trait) {
    if (!trait || trait === 'none') return '';
    return `<span class="badge cyan" title="สายความสามารถที่ใช้ได้จริงในเกม">${esc(TRAIT_LABEL[trait] || trait)}</span>`;
  }

  // Ultimate ที่แสดงบนการ์ด: ของคนอื่นเห็นตามที่เกมให้เห็น ของตัวเองบอกชัดว่า "คนอื่นเห็นเป็นอะไร"
  function ultimateLine(c, isMe) {
    if (!c) return '<div class="ult muted">กำลังสุ่ม...</div>';
    if (isMe && c.shownToOthers === '???') return `<div class="ult"><span class="unknown">???</span> <span class="real">(โรลจริง: ${esc(c.ultimate)})</span> ${traitBadge(c.trait)}</div><div><span class="badge purple">คนอื่นเห็นคุณเป็น ???</span></div>`;
    if (isMe && c.shownToOthers) return `<div class="ult">${esc(c.shownToOthers)} <span class="real">(ปลอม — โรลจริง: ${esc(c.ultimate)})</span> ${traitBadge(c.trait)}</div><div><span class="badge purple">โรลปลอม · คนอื่นเห็นว่าคุณคือ ${esc(c.shownToOthers)}</span></div>`;
    if (c.ultimate === '???') return '<div class="ult unknown" title="Ultimate ถูกซ่อน">???</div>';
    return `<div class="ult">${esc(c.ultimate)} ${traitBadge(c.trait)}</div>${c.fakeRoleExposed ? `<div><span class="badge purple" title="Ultimate ที่ประกาศไว้เป็นของปลอม">โรลปลอม · ประกาศว่า ${esc(c.fakeUltimate || '?')}</span></div>` : ''}`;
  }

  function playerCard(s, p) {
    const me = s.me;
    const isMe = p.id === me.id;
    const c = p.character;
    const votable = s.phase === 'trial' && !me.voteConfirmed && (!s.runoff || s.runoff.candidates.includes(p.id));
    const clickable = p.alive && !isMe && me.alive && votable;
    const selected = s.phase === 'trial' && me.myVote === p.id;
    const marks = [];
    if (p.isHost) marks.push('<span class="mark host" title="หัวห้อง">👑</span>');
    if (!p.connected && !p.isBot) marks.push('<span class="mark off" title="ออฟไลน์">⚡</span>');
    if ((s.phase === 'day' || s.phase === 'investigation') && p.alive && (isMe || !me.alive)) { // คนอื่นไม่เห็นว่าใครเลือกแล้ว — ไม่งั้นคนตายที่ยังไม่ถูกพบจะถูกสังเกตว่าไม่ขยับ (ผีเห็น)
      if (s.step === 'move') marks.push(`<span class="mark ${p.moved ? 'ok' : ''}" title="เลือกห้อง">${p.moved ? '🚶' : '…'}</span>`);
      if (s.step === 'act') marks.push(`<span class="mark ${p.acted ? 'ok' : ''}" title="เลือกแอ็กชัน">${p.acted ? '✔' : '…'}</span>`);
      if (s.step === 'report') marks.push(`<span class="mark ${p.ready ? 'ok' : ''}" title="พร้อมไปต่อ">${p.ready ? '✔' : '…'}</span>`);
    }
    if (s.phase === 'trial' && p.alive) marks.push(`<span class="mark ${p.voteConfirmed ? 'ok' : ''}" title="โหวต">${p.voteConfirmed ? '🗳️' : '…'}</span>`);
    if (p.knownDead) marks.push(`<span class="mark" title="${FATE_LABEL[p.fate] || 'เสียชีวิต'}">${FATE_ICON[p.fate] || '✝'}</span>`);
    const sameZone = !isMe && p.zoneId && me.alive && p.zoneId === me.zoneId && !!p.outside === !!me.outside && (s.step === 'act' || s.step === 'report');
    return `<div class="pcard ${p.knownDead ? 'dead' : ''} ${isMe ? 'me' : ''} ${clickable ? 'clickable' : ''} ${selected ? 'selected' : ''}"
        ${clickable ? `data-action="vote" data-id="${esc(p.id)}"` : ''} title="${c ? esc(`${c.appearance} — ${c.personality}`) : ''}">
      <div class="marks">${marks.join('')}</div>
      <div class="phead">${avatarHtml(c)}<div>
        <div class="pname">${esc(p.name)}${p.isBot ? ' <span class="badge">บอท</span>' : ''}${isMe ? ' <span class="badge cyan">คุณ</span>' : ''}</div>
        ${c ? `<div class="cname">${esc(c.name)} (${esc(c.nickname)})</div>` : ''}
      </div></div>
      ${ultimateLine(c, isMe)}
      ${sameZone ? `<div><span class="badge green">${me.outside ? 'ยืนหน้าประตูด้วยกัน' : 'อยู่ห้องเดียวกับคุณ'}</span></div>` : !isMe && p.zoneId && !me.alive ? `<div class="muted" style="font-size:.8rem">📍 ${esc(zoneName(p.zoneId))}</div>` : ''}
      ${p.knownDead && p.fate ? `<div class="muted" style="font-size:.8rem">${FATE_LABEL[p.fate]} · ${esc(timeText(p.eliminatedDay, p.eliminatedHour))}</div>` : ''}
      ${p.alive && p.ko ? '<div><span class="badge red">😵 สลบอยู่</span></div>' : ''}
      ${!me.alive && s.phase === 'trial' && p.alive && p.vote ? `<div class="muted" style="font-size:.8rem">🗳 → ${esc(displayName(p.vote))}</div>` : ''}
      ${p.alive && p.revived ? '<div><span class="badge yellow">คืนชีพ</span></div>' : ''}
      ${s.runoff && p.alive && s.runoff.candidates.includes(p.id) ? '<div><span class="badge red">รอบตัดสิน</span></div>' : ''}
    </div>`;
  }

  function renderMain(s) {
    if (!$('#main')) return;
    let html = '';
    const explore = s.phase === 'day' || s.phase === 'investigation';
    if (s.phase === 'generating' || (explore && !s.step)) html = loadingHtml(s.generating || 'กำลังโหลด...');
    else if (explore) {
      if (!s.me.alive) html = spectatorHtml(s) + (s.phase === 'investigation' ? casesHtml(s) : '');
      else if (s.step === 'move') html = (s.phase === 'day' ? eventHtml(s) + dayIntroHtml(s) : casesHtml(s)) + zoneMapHtml(s);
      else if (s.step === 'act') html = zonePanelHtml(s) + actionPickerHtml(s);
      else if (s.step === 'report') html = reportHtml(s);
    } else if (s.phase === 'trial') html = (s.me.alive ? '' : spectatorHtml(s)) + trialIntroHtml(s) + casesHtml(s) + evidenceHtml(s);
    else if (s.phase === 'trial_result') html = resultHtml(s) + casesHtml(s);
    setHtml('#main', html);
  }

  const loadingHtml = (label) => `<div class="card loading"><div class="spinner"></div><h2>${esc(label)}</h2><p class="muted">กรุณารอสักครู่...</p></div>`;

  function updateCountdown() {
    const el = $('#step-countdown');
    if (!el || !state?.stepDeadline) return;
    const left = Math.max(0, Math.round((state.stepDeadline - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function eventHtml(s) {
    const ev = s.specialEvent;
    if (!ev || ev.day !== s.day) return '';
    const mine = ev.playerId === s.me.id;
    return `<div class="card event">
      <h2>✨ อีเวนต์พิเศษ — ${esc(ev.title)}</h2>
      <p><b>${esc(ev.characterName)} (${esc(ev.playerName)})</b> กลับมามีชีวิตอีกครั้ง!</p>
      <p>${esc(ev.story)}</p>
      ${mine && s.me.eventPrivateNote ? `<div class="clue insight"><span class="ctag">สิ่งที่คุณจำได้ (คนอื่นมองไม่เห็น)</span>${esc(s.me.eventPrivateNote)}</div>` : ''}
    </div>`;
  }

  function objectiveBadge(o) {
    if (o.done) return o.forgiven ? '<span class="badge">ยกเลิก</span>' : '<span class="badge green">สำเร็จ</span>';
    if (o.remainingHours <= 0) return '<span class="badge red">ครบกำหนด — โดนลงโทษ</span>';
    return `<span class="badge ${o.remainingHours <= 1 ? 'red' : ''}">เหลือ ${o.remainingHours} ชม.</span>`;
  }

  function dayIntroHtml(s) {
    const me = s.me;
    const alive = s.players.filter((p) => p.alive);
    const moved = alive.filter((p) => p.moved).length;
    return `<div class="card">
      <div class="row"><h2>🕐 วันที่ ${s.day} · ชั่วโมงที่ ${s.hour}</h2><span class="spacer"></span><span class="muted">ไม่มีใครเห็นว่าใครเลือกอะไร</span></div>
      <p class="muted">${esc(s.location.description)}</p>
      ${me.isDesignated ? `<div class="clue culprit"><span class="ctag">🔪 วันนี้เกมเลือกคุณเป็น "ฆาตกร" (มีแค่คุณที่รู้)</span>จะลงมือหรือไม่ก็ได้ — ถ้าลงมือในวันนี้โอกาสสำเร็จสูงขึ้น ดูรายละเอียดในสมุดบันทึก ถ้าคนอื่นลงมือก่อน คุณจะเป็นแค่คนที่อยู่ในเหตุการณ์</div>` : ''}
      ${me.ko ? `<div class="clue culprit"><span class="ctag">😵 คุณสลบอยู่</span>ฟื้นในอีก ${me.ko.hours} ชั่วโมง — ชั่วโมงนี้คุณอยู่ที่เดิมและทำอะไรไม่ได้ ไม่รู้ว่ารอบตัวเกิดอะไรขึ้น และใครลงมือกับคุณก็สำเร็จแน่นอน</div>` : ''}
      ${me.door?.lockedIn ? `<div class="clue culprit"><span class="ctag">🔒 คุณถูกล็อกอยู่ใน${esc(me.zoneName || '')}</span>ออกตามปกติไม่ได้ — เลือกอยู่ห้องนี้ต่อ แล้วในขั้นเลือกแอ็กชันเลือก ${esc(me.door.means?.label || 'สะเดาะ/พังประตู')} (ทำซ้ำทุกชั่วโมงจนสำเร็จ${me.door.work ? ` · ทำไปแล้ว ${me.door.work.progress} ชม.` : ''}) หรือรอให้คนข้างนอกมาเปิด</div>` : ''}
      ${me.outside ? `<div class="clue culprit"><span class="ctag">🚪 คุณยืนรออยู่หน้าประตู${esc(me.zoneName || '')} (ข้างนอก)</span>ประตูล็อกอยู่ เข้าไม่ได้ — ทำอะไรกับห้องไม่ได้ (ไม่มีสำรวจ/หยิบ/วาง) ทำได้เฉพาะกับคนที่ยืนอยู่หน้าประตูด้วยกัน · ${me.door?.hasKeyHere ? 'คุณมีกุญแจ: กด 🔑 ไขกุญแจได้ทันที แล้วชั่วโมงถัดไปเลือกห้องนี้เพื่อเข้า' : `ในขั้นเลือกแอ็กชัน เลือก ${esc(me.door?.means?.label || 'สะเดาะ/พังประตู')} ทำซ้ำทุกชั่วโมงจนเปิด`} · หรือจะเดินไปห้องอื่นก็ได้</div>` : ''}
      ${me.door?.work ? `<div class="clue night-self"><span class="ctag">${me.door.work.method === 'break' ? '💥' : '🪛'} งานค้างที่ประตู</span>คุณกำลัง${me.door.work.method === 'break' ? 'พังประตู' : 'สะเดาะกลอน'}<b>${esc(me.door.work.zoneName)}</b> (ทำไปแล้ว ${me.door.work.progress} ชม.) — เลือกแอ็กชันเดิมอีกครั้งชั่วโมงหน้าเพื่อทำต่อ ย้ายไปประตูอื่นแล้วต้องเริ่มใหม่</div>` : ''}
      ${me.objectives.filter((o) => !o.done).map((o) => `<div class="clue night-self"><span class="ctag">📋 ภารกิจลับ (ละเลยได้ แต่ครบกำหนดแล้วไม่ทำ = สลบ 1–3 ชม.)</span>${esc(o.text)} ${objectiveBadge(o)}</div>`).join('')}
      ${s.config.objectives && me.nextObjectiveIn != null && !me.objectives.some((o) => !o.done) ? `<p class="muted" style="font-size:.85rem">📋 ภารกิจถัดไปจะมาใน${me.nextObjectiveIn ? `อีก ${me.nextObjectiveIn} ชั่วโมง` : 'ชั่วโมงหน้า'}</p>` : ''}
      <p class="muted" style="font-size:.85rem">เลือกห้องจากแผนที่ด้านล่าง — ไม่มีใครเห็นว่าใครเลือกอะไร จนกว่าจะเข้าห้องแล้วเจอกัน</p>
    </div>`;
  }

  function zoneMapHtml(s) {
    const me = s.me;
    const zones = s.location.zones;
    const chosen = me.moveChoice;
    const sel = chosen || ui.selectedZone;
    const alive = s.players.filter((p) => p.alive);
    const moved = alive.filter((p) => p.moved).length;
    const stuck = !!(me.door?.lockedIn || me.door?.barred); // ถูกขัง/ประตูถูกค้ำ → เลือกได้แค่ห้องนี้ (หรือห้องที่มีทางลับไป)
    const passTargets = new Set((me.passages || []).flatMap((x) => (x.a === me.zoneId ? [x.b] : x.b === me.zoneId ? [x.a] : [])));
    return `<div class="card">
      ${doorNowHtml(s)}
      <div class="row"><h3>🗺 แผนที่ — ${esc(s.location.name)}</h3><span class="spacer"></span>${s.phase === 'investigation' ? `<span class="badge red">รอบเก็บหลักฐาน${s.investigation ? ` ชั่วโมงที่ ${s.investigation.hour}/${s.investigation.total}` : ''}</span>` : ''}</div>
      <div class="zones">${zones
        .map((z) => {
          const mem = me.zoneMemory?.[z.id];
          const here = me.zoneId === z.id;
          const tags = [];
          if (z.isSleep) tags.push('<span class="badge">ที่นอนรวม</span>');
          const exitsHere = (me.exits || []).filter((x) => x.zoneId === z.id);
          for (const x of exitsHere) tags.push(`<span class="badge yellow" title="${esc(x.requirement)}">🚪 ${esc(x.name)}${x.open ? ' (เปิดแล้ว)' : ''}</span>`);
          if (mem?.broken) tags.push('<span class="badge" title="ประตูถูกพังแล้ว ล็อกไม่ได้อีก">🚪 ประตูพัง</span>');
          else if (mem?.locked) {
            const hasKey = me.inventory.some((i) => i.kind === 'key' && (i.unlocksZoneNames || []).includes(z.name));
            const hint = hasKey ? 'คุณมีกุญแจ — ไปยืนหน้าประตูแล้วกด 🔑 ไขกุญแจ (ทันที) ชั่วโมงถัดไปค่อยเข้า' : me.door?.means ? me.door.means.label : 'ต้องมีกุญแจหรือที่สะเดาะกุญแจ';
            tags.push(`<span class="badge red" title="ครั้งล่าสุดที่คุณเจอ ประตูล็อกอยู่ (อาจเปลี่ยนไปแล้ว) · ${esc(hint)}">🔒 ล็อกอยู่ · ${esc(hint)}</span>`);
          }
          if (mem?.food) tags.push('<span class="badge">🍞 มีอาหาร</span>');
          if (mem?.barred) tags.push('<span class="badge red" title="ครั้งล่าสุดที่คุณเจอ ประตูถูกค้ำจากข้างใน กุญแจ/ที่สะเดาะใช้ไม่ได้ ต้องพัง">🚧 ถูกค้ำ</span>');
          if (mem?.dark) tags.push('<span class="badge" title="ครั้งล่าสุดที่เข้าไป มืดจนมองไม่เห็นอะไร">🌑 มืด</span>');
          for (const x of (me.passages || []).filter((x) => x.a === z.id || x.b === z.id)) tags.push(`<span class="badge purple" title="ทางลับ: เดินทะลุได้แม้ประตูล็อก/ถูกค้ำ ไม่ผ่านประตู (กับดักประตูไม่ทำงาน)">🕳 ทางลับ ↔ ${esc(x.a === z.id ? x.bName : x.aName)}</span>`);
          if (here) tags.push(`<span class="badge cyan">${me.outside ? 'คุณยืนรออยู่หน้าประตู (ข้างนอก)' : 'คุณอยู่ที่นี่ล่าสุด'}</span>`);
          const bodiesHere = me.knownBodies.filter((b) => b.zoneName === z.name);
          return `<div class="zone ${sel === z.id ? 'selected' : ''} ${exitsHere.length ? 'exit' : ''} ${chosen ? 'locked' : ''} ${stuck && !here && !passTargets.has(z.id) ? 'disabled' : ''}" data-action="pick-zone" data-id="${esc(z.id)}">
            <div class="zname">${esc(z.name)}</div>
            <div class="ztags">${tags.join(' ')}</div>
            <div class="zdesc">${esc(z.description)}</div>
            ${mem && !mem.people ? `<div class="zmem muted">ยังไม่เคยเข้าไป — ${esc(timeText(mem.day, mem.hour))} ยืนรอหน้าประตูที่ล็อกอยู่</div>` : mem ? `<div class="zmem">ครั้งล่าสุด (${esc(timeText(mem.day, mem.hour))}): ${mem.people?.length ? `คน: ${esc(mem.people.join(', '))}` : 'ไม่มีใคร'} · ${mem.items?.length ? `ของ: ${esc(mem.items.join(', '))}` : 'ไม่เห็นของ'}${mem.searched ? ' · สำรวจแล้ว' : ''}</div>` : '<div class="zmem muted">ยังไม่เคยเข้าไป (หรือของถูกจัดใหม่)</div>'}
            ${bodiesHere.length ? `<div class="zbody">☠ ศพ: ${esc(bodiesHere.map((b) => `${b.name}${b.outside ? ' (หน้าประตู)' : ''}`).join(', '))}</div>` : ''}
          </div>`;
        })
        .join('')}</div>
      <div class="row" style="margin-top:.8rem">
        ${chosen
          ? `<p class="status">${me.ko ? '😵 คุณสลบอยู่ที่' : 'คุณเลือกไป'} <b>${esc(zoneName(chosen))}</b> ${me.ko ? '— ขยับไม่ได้' : 'แล้ว'} รอคนอื่น</p>`
          : `<button class="primary" data-action="confirm-move" ${sel ? '' : 'disabled'}>${sel ? `🚶 ไป${esc(zoneName(sel))}` : 'เลือกห้องก่อน'}</button><span class="muted">ไม่มีใครเห็นว่าใครเลือกอะไร</span>`}
      </div>
    </div>`;
  }

  function zonePanelHtml(s) {
    const me = s.me;
    const z = zoneById(me.zoneId);
    const mem = me.zoneMemory?.[me.zoneId] || {};
    const bodies = me.knownBodies.filter((b) => b.zoneName === z?.name);
    const people = (me.zonePeople || []).map((p) => p.name);
    return `<div class="card zone-panel">
      <div class="row"><h2>📍 ${me.outside ? 'หน้าประตู' : ''}${esc(z?.name || '?')}${me.outside ? ' <span class="badge red">ข้างนอก · ประตูล็อก</span>' : ''}</h2><span class="spacer"></span><span class="badge ${s.phase === 'investigation' ? 'red' : 'pink'}">${s.phase === 'investigation' ? 'เก็บหลักฐาน' : `วันที่ ${s.day} ชั่วโมงที่ ${s.hour}`}</span></div>
      <p class="muted">${esc(z?.description || '')}</p>
      <div class="zone-facts">
        ${mem.dark || me.canSee === false ? '<div class="danger-text">🌑 <b>มืดสนิท</b> — มองไม่เห็นคนและของในห้อง (ต้องมีเทียน/ไฟฉาย/ไฟแช็ก) หยิบได้แค่ "คลำหาของ" และเทรดของกันไม่ได้</div>' : ''}
        ${me.door?.barred ? `<div class="danger-text">🚧 ประตูห้องนี้ถูกค้ำจากข้างใน${me.door.barItem ? ` (${esc(me.door.barItem)})` : ''} — คนข้างนอกต้องพังประตู คนข้างในเอาออกได้ทันที</div>` : ''}
        <div><b>${me.outside ? 'คนที่ยืนหน้าประตูด้วย' : 'คนที่อยู่ที่นี่'}:</b> ${me.canSee === false ? '<span class="muted">มืด — มองไม่เห็นว่ามีใครอยู่บ้าง</span>' : people.length ? esc(people.join(', ')) : '<span class="muted">ไม่มีใครนอกจากคุณ</span>'}</div>
        <div><b>ของที่เห็น:</b> ${me.canSee === false ? '<span class="muted">มืด — มองไม่เห็น</span>' : me.outside ? '<span class="muted">มองไม่เห็นข้างใน — ประตูล็อกอยู่</span>' : mem.items?.length ? esc(mem.items.join(', ')) : '<span class="muted">ไม่เห็นของเป็นพิเศษ</span>'}</div>
        ${z?.water ? '<div class=\"muted\" style=\"font-size:.8rem\">🚿 ห้องนี้มีน้ำ — ล้างคราบเลือดออกจากของที่ถือได้ (ใช้ชั่วโมง อ่างอาจเก็บคราบไว้)</div>' : ''}
        ${bodies.length ? `<div class="danger-text">☠ <b>ศพ:</b> ${esc(bodies.map((b) => b.name).join(', '))}</div>` : ''}
      </div>
      ${recentLogHtml(s, 'สิ่งที่เกิดขึ้นตอนเข้ามา')}
    </div>`;
  }

  const ACTION_GROUPS = [
    ['ทางออก', ['exit', 'exit_power']],
    ['ทั่วไป', ['search', 'grope', 'hide', 'eat', 'mixFood', 'rest']],
    ['ประตู/ไฟ', ['doorwork', 'repairPower']],
    ['ตรวจศพ', ['examine']],
    ['ความสามารถพิเศษ', ['steal', 'interrogate', 'sabotage']],
    ['ประกอบกับดัก', ['craft']],
    ['อันตราย', ['attack', 'trap', 'poisonFood', 'moveBody', 'clean']],
  ];

  // หยิบ/วาง/ซ่อนของ ทำได้ทันที ไม่กินชั่วโมง (ทั้งตอนเลือกแอ็กชันและตอนพักชั่วโมง)
  // ไขกุญแจ/ล็อกประตูด้วยกุญแจ ทำได้ทันที ไม่กินชั่วโมง (ทุกขั้น) — สะเดาะ/พังอยู่ในรายการแอ็กชัน "ประตู"
  function doorNowHtml(s) {
    const list = s.me.doorActions || [];
    if (!s.me.alive || !list.length) return '';
    return `<div class="agroup itemnow"><div class="agtitle">⚡ ประตู/ไฟ — ทำได้ทันที ไม่กินชั่วโมง</div><div class="alist">${list.map((a) => `<button class="act small ${a.danger ? 'danger' : ''}" data-action="door-now" data-type="${esc(a.type)}" data-id="${esc(a.itemId || '')}" title="${esc(a.desc || '')}">${esc(a.label)}</button>`).join('')}</div></div>`;
  }

  function itemNowHtml(s) {
    const me = s.me;
    const list = me.itemActions || [];
    if (!me.alive || !list.length) return '';
    const takes = list.filter((a) => a.type === 'take');
    const mine = list.filter((a) => a.type !== 'take');
    const btn = (a) => `<button class="act small ${a.type === 'take' ? '' : 'ghost'}" data-action="item-now" data-type="${esc(a.type)}" data-id="${esc(a.itemId)}" ${a.disabled ? 'disabled' : ''} title="${esc(a.reason || a.desc || '')}">${esc(a.label)}</button>`;
    return `<div class="agroup itemnow"><div class="agtitle">⚡ หยิบ/วางของ — ทำได้ทันที ไม่กินชั่วโมง แล้วยังเลือกแอ็กชันหลักได้ (ซ่อนของอยู่ในรายการ "ทั่วไป": ใช้ชั่วโมง แต่ซ่อนได้หลายชิ้น)</div>
      ${takes.length ? `<div class="alist">${takes.map(btn).join('')}</div>` : '<p class="muted" style="font-size:.8rem">ไม่มีของให้หยิบในห้องนี้</p>'}
      ${mine.length ? `<div class="alist" style="margin-top:.3rem">${mine.map(btn).join('')}</div>` : ''}
    </div>`;
  }

  function actionPickerHtml(s) {
    const me = s.me;
    const alive = s.players.filter((p) => p.alive);
    const acted = alive.filter((p) => p.acted).length;
    if (me.actionChoice) {
      return `<div class="card"><h3>${me.actionChoice.busy ? '🪛 ชั่วโมงนี้คุณใช้เวลาไปกับประตู' : me.actionChoice.ko ? '😵 คุณสลบอยู่ — ชั่วโมงนี้ทำอะไรไม่ได้' : 'คุณเลือกแล้ว'}</h3><p class="status">${esc(me.actionChoice.label)} — รอคนอื่น</p><p class="muted">${me.actionChoice.busy ? 'สะเดาะ/พังประตูใช้ทั้งชั่วโมง ทำอย่างอื่นไม่ได้ — ถ้ายังไม่สำเร็จ เลือกห้องนั้นอีกครั้งชั่วโมงหน้า' : 'ผลจะปรากฏในสมุดบันทึกเมื่อทุกคนเลือกครบ'}</p>${itemNowHtml(s)}${doorNowHtml(s)}</div>`;
    }
    const list = me.availableActions || [];
    const selected = list.find((a) => actionKey(a) === ui.selectedAction) || null;
    const groups = ACTION_GROUPS.map(([title, types]) => [title, list.filter((a) => types.includes(a.type))]).filter(([, arr]) => arr.length);
    const zonesOther = s.location.zones.filter((z) => z.id !== me.zoneId);
    return `<div class="card">
      <div class="row"><h3>เลือกสิ่งที่จะทำ (1 อย่าง)</h3></div>
      ${itemNowHtml(s)}${doorNowHtml(s)}
      ${groups
        .map(
          ([title, arr]) => `<div class="agroup"><div class="agtitle">${esc(title)}</div><div class="alist">${arr
            .map((a) => `<button class="act ${a.danger ? 'danger' : ''} ${actionKey(a) === ui.selectedAction ? 'selected' : ''}" data-action="pick-action" data-key="${esc(actionKey(a))}" ${a.disabled ? 'disabled' : ''} title="${esc(a.reason || a.desc || '')}">${esc(a.label)}</button>`)
            .join('')}</div></div>`,
        )
        .join('')}
      <div class="apreview">
        ${selected
          ? `<div class="clue ${selected.danger ? 'culprit' : ''}"><span class="ctag">${esc(selected.label)}</span>${esc(selected.desc || '')}
              ${selected.multiItems ? `<div class="hidepick">${(me.inventory || []).map((i) => `<label><input type="checkbox" class="hide-item" value="${esc(i.id)}" checked> ${esc(i.name)}</label>`).join('')}</div>` : ''}
              ${selected.needsZone ? `<p><label>ย้ายไปที่ <select id="move-body-to">${zonesOther.map((z) => `<option value="${esc(z.id)}" ${ui.moveBodyTo === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label></p>` : ''}
            </div>
            <button class="primary" data-action="confirm-action">ยืนยัน: ${esc(selected.label)}</button>`
          : '<p class="muted">แตะแอ็กชันเพื่อดูรายละเอียด แล้วกดยืนยัน</p>'}
      </div>
    </div>`;
  }

  // บันทึกของชั่วโมงปัจจุบัน
  function recentLogHtml(s, title, phase = s.phase) {
    const entries = (s.me.log || []).filter((l) => l.day === s.day && l.hour === s.hour && l.phase === phase);
    if (!entries.length) return '';
    return `<div class="todaylog"><div class="agtitle">${esc(title)}</div>${entries.map(logEntryHtml).join('')}</div>`;
  }

  const logEntryHtml = (l) => `<div class="logent k-${esc(l.kind)}">${esc(l.text)}</div>`;

  // ขอของจากบอทที่อยู่ห้องเดียวกัน (ช่วยทดสอบเกม) — เลือกคู่ "บอท: ของ" แล้วกดขอ
  function requestHtml(s) {
    const me = s.me;
    if (!s.config.botRequests || !me.alive) return '';
    const bots = (me.zonePeople || []).filter((p) => p.isBot);
    if (!bots.length) return '';
    const pairs = bots.flatMap((b) => (b.items || []).map((i) => ({ value: `${b.id}|${i.id}`, label: `${b.name}: ${KIND_ICON[i.kind] || '•'} ${i.name}${i.isPart ? ' ⭐' : ''}` })));
    const full = me.inventory.length >= (me.inventoryMax || s.config.inventoryMax);
    return `<div class="give request">
      <div class="agtitle">🙏 ขอของจากบอทในห้องนี้ (บอทให้เสมอ — มีไว้ช่วยทดสอบเกม)</div>
      ${pairs.length
        ? `<div class="row"><select id="request-pair">${pairs.map((p) => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('')}</select><button data-action="request" ${full ? 'disabled title="คุณถือของเต็มมือ"' : ''}>ขอเลย</button>${full ? '<span class="muted" style="font-size:.8rem">คุณถือของเต็มมือ วางของก่อน</span>' : ''}</div>`
        : `<p class="muted" style="font-size:.8rem">บอทในห้องนี้ (${esc(bots.map((b) => b.name).join(', '))}) ไม่ได้ถือของอะไรเลย</p>`}
    </div>`;
  }

  function giveHtml(s) {
    const me = s.me;
    const people = me.zonePeople || [];
    if (!me.alive || !people.length) return `<p class="muted" style="font-size:.85rem">🎁 ให้ของได้เฉพาะคนที่อยู่ห้องเดียวกันตอนนี้${people.length ? '' : ' — ชั่วโมงนี้ไม่มีใครอยู่กับคุณ'}</p>`;
    if (!me.inventory.length) return `<p class="muted" style="font-size:.85rem">🎁 คนในห้องนี้: ${esc(people.map((p) => p.name).join(', '))} — คุณไม่มีของให้</p>` + requestHtml(s);
    return `<div class="give">
      <div class="agtitle">🎁 ให้ของกับคนในห้องเดียวกัน (ก่อนเริ่มชั่วโมงถัดไป)</div>
      <div class="row">
        <select id="give-item">${me.inventory.map((i) => `<option value="${esc(i.id)}">${KIND_ICON[i.kind] || '•'} ${esc(i.name)}</option>`).join('')}</select>
        <span>ให้</span>
        <select id="give-to">${people.map((p) => `<option value="${esc(p.id)}" ${p.invFull ? 'disabled' : ''}>${esc(p.name)}${p.invFull ? ' (ถือเต็ม)' : ''}</option>`).join('')}</select>
        <button data-action="give">ให้เลย</button>
      </div>
      <p class="muted" style="font-size:.8rem">คนอื่นในห้องจะเห็นว่าคุณยื่นของให้ (อาจไม่เห็นว่าเป็นอะไร) · ใช้ช่วยกันทำภารกิจ "หยิบของ" ได้</p>
    </div>` + requestHtml(s);
  }

  function reportHtml(s) {
    const me = s.me;
    const alive = s.players.filter((p) => p.alive);
    const ready = alive.filter((p) => p.ready).length;
    const entries = (me.log || []).filter((l) => l.day === s.day && l.hour === s.hour && l.phase === 'day');
    return `<div class="card">
      <div class="row"><h2>📓 บันทึก วันที่ ${s.day} ชั่วโมงที่ ${s.hour}</h2><span class="spacer"></span><span class="muted">รอทุกคนกดพร้อม</span></div>
      <p class="muted">สิ่งที่คุณเห็นและทำในชั่วโมงนี้ — มีแค่คุณที่รู้ จะเล่าให้ใครฟังหรือเก็บไว้ก็ได้</p>
      <div class="report-log">${entries.map(logEntryHtml).join('') || '<p class="muted">ไม่มีอะไรเกิดขึ้น</p>'}</div>
      ${giveHtml(s)}
      ${itemNowHtml(s)}${doorNowHtml(s)}
      ${me.alive ? (me.ready ? `<p class="status">คุณพร้อมแล้ว รอคนอื่น</p>` : `<button class="primary" data-action="ready">พร้อมไปชั่วโมงถัดไป</button>`) : ''}
    </div>`;
  }

  // โหมดวิญญาณ: ผีเห็นทุกห้อง ทุกคน เหตุการณ์จริง ตามดูคนเป็นได้ทีละคน และคุยแชทผีกับผีด้วยกัน (คนเป็นมองไม่เห็น)
  function spectatorHtml(s) {
    const sp = s.me.spectator;
    if (!sp) return '';
    const w = sp.watching;
    const tab = ui.ghostTab;
    const tabBtn = (id, label) => `<button class="small ${tab === id ? 'selected' : 'ghost'}" data-action="ghost-tab" data-id="${id}">${label}</button>`;
    const ghosts = sp.ghosts.map((g) => `${g.name}${g.isBot ? ' (บอท)' : ''}`).join(', ');
    let body = '';
    if (tab === 'watch') {
      const btns = sp.positions.map((p) => `<button class="small ${w?.id === p.id ? 'selected' : 'ghost'}" data-action="follow" data-id="${esc(p.id)}" title="${esc(p.zoneName)}">${w?.id === p.id ? '👁 ' : ''}${esc(p.name)}</button>`).join('');
      body = `<div class="followlist">${btns || '<span class="muted">ไม่มีใครเหลือให้ตามดู</span>'}</div>`;
      body += w
        ? `<div class="watchbox">
            <div class="row"><b>👁 ${esc(w.name)}</b><span class="muted">(${esc(w.playerName)}${w.characterName ? ` · ${esc(w.characterName)}` : ''})</span><span class="spacer"></span><span class="badge">📍 ${esc(w.zoneName)}</span>${w.ko ? '<span class="badge red">😵 สลบ</span>' : ''}${w.kills ? `<span class="badge red">ฆ่าไปแล้ว ${w.kills}</span>` : ''}</div>
            <div class="zone-facts">
              <div><b>ชั่วโมงนี้:</b> ${w.moveChoice ? `เลือกไป ${esc(w.moveChoice)}` : 'ยังไม่เลือกห้อง'}${w.actionChoice ? ` · ทำ "${esc(w.actionChoice)}"` : ''}</div>
              <div><b>ของในมือ:</b> ${w.inventory.length ? esc(w.inventory.map((i) => i.name).join(', ')) : '-'}</div>
              <div><b>ภารกิจ:</b> ${w.objectives.length ? esc(w.objectives.map((o) => `${o.text} (เหลือ ${o.remainingHours} ชม.)`).join(' · ')) : '-'}</div>
              <div><b>ทางออกที่รู้จัก:</b> ${w.exitsKnown.length ? esc(w.exitsKnown.join(', ')) : '-'}</div>
            </div>
            <div class="agtitle" style="margin-top:.6rem">📓 สมุดบันทึกของ ${esc(w.name)} (ล่าสุด)</div>
            ${logGroupsHtml(w.log) || '<p class="muted">ยังไม่มีบันทึก</p>'}
          </div>`
        : '<p class="muted">เลือกคนที่อยากตามดู — จะเห็นสมุดบันทึก ของในมือ ภารกิจ และสิ่งที่เขาเลือกทำในชั่วโมงนี้ (กดชื่อเดิมอีกครั้งเพื่อเลิกตามดู)</p>';
    } else if (tab === 'map') {
      body = `<div class="ghostmap">${sp.rooms
        .map(
          (r) => `<div class="groom ${r.locked ? 'locked' : ''} ${r.bodies.length ? 'body' : ''}">
          <div class="gname">${r.isSleep ? '🛏 ' : ''}${esc(r.name)} ${r.locked ? '<span class="badge red">🔒</span>' : ''}${r.barred ? '<span class="badge red">🚧</span>' : ''}${r.broken ? '<span class="badge">ประตูพัง</span>' : ''}${r.dark ? '<span class="badge">🌑 มืด</span>' : ''}</div>
          ${r.people.length ? `<div>🧍 ${esc(r.people.join(', '))}</div>` : ''}
          ${r.bodies.length ? `<div class="bad">☠ ${esc(r.bodies.join(', '))}</div>` : ''}
          ${r.traps.length ? `<div class="bad">🪤 ${esc(r.traps.map((t) => `${t.name}${t.door ? ' (ประตู)' : ''} ของ${t.setter}`).join(', '))}</div>` : ''}
          ${r.items.length ? `<div class="muted">${esc(r.items.map((i) => `${i.hidden ? '🙈' : ''}${i.name}${i.poisoned ? ' ☠' : ''}${i.bloody ? ' 🩸' : ''}`).join(', '))}</div>` : ''}
          ${r.evidence ? `<div class="muted">🔍 ร่องรอย ${r.evidence}</div>` : ''}
        </div>`,
        )
        .join('')}</div>
        ${sp.passages?.length ? `<p class="muted" style="font-size:.8rem">🕳 ทางลับ: ${esc(sp.passages.map((x) => `${x.aName} ↔ ${x.bName}`).join(' · '))}</p>` : ''}
        <p class="muted" style="font-size:.8rem">🙈 = ของที่ถูกซ่อน · ☠ หลังชื่ออาหาร = มีพิษ · 🩸 เปื้อนเลือด · กับดักทุกอันบอกว่าใครวาง${sp.blackout ? ' · 🌑 ไฟดับทั้งตึก' : ''}</p>`;
    } else {
      const feed = [...sp.feed].reverse();
      body = feed.length
        ? `<div class="report-log">${feed.map((e) => `<div class="logent k-feed"><span class="muted">${esc(timeText(e.day, e.hour))}${e.phase === 'investigation' ? ' (เก็บหลักฐาน)' : ''}</span> ${esc(e.text)}</div>`).join('')}</div>`
        : '<p class="muted">ยังไม่มีเหตุการณ์ที่น่าสนใจ — รอดูต่อไป</p>';
    }
    const votes = s.phase === 'trial' ? `<div class="zone-facts"><div><b>🗳 โหวตตอนนี้:</b> ${s.players.filter((p) => p.alive).map((p) => `${esc(p.character?.nickname || p.name)} → ${p.vote ? esc(displayName(p.vote)) : '…'}`).join(' · ')}</div></div>` : '';
    return `<div class="card spectator">
      <h3>👻 โหมดวิญญาณ — คุณเสียชีวิตแล้ว (${esc(FATE_LABEL[s.me.fate] || '')}${s.me.deathCauseLabel && s.me.deathCauseLabel !== FATE_LABEL[s.me.fate] ? ` — ${esc(s.me.deathCauseLabel)}` : ''})</h3>
      <p class="muted">พิมพ์ในแชทได้เลย — เป็น<b>แชทผี</b> คนเป็นมองไม่เห็น (ทุกคนจะเห็นเมื่อเกมจบ) · ผีด้วยกันตอนนี้: ${ghosts ? esc(ghosts) : 'ยังไม่มี คุณเป็นคนแรก'}</p>
      ${votes}
      <div class="gtabs">${tabBtn('watch', `👁 ตามดู${w ? ` ${esc(w.name)}` : ''}`)}${tabBtn('map', '🗺 ทุกห้อง')}${tabBtn('feed', `📜 เหตุการณ์จริง (${sp.feed.length})`)}</div>
      ${body}
    </div>`;
  }

  function casesHtml(s) {
    const cases = s.announcedCases || [];
    if (!cases.length) return '';
    return `<div class="card incident">
      <h2>☠ ศพที่ถูกประกาศ (${cases.length})</h2>
      <p class="muted" style="font-size:.85rem">ต้องมีคนพบศพ ${s.bodyThreshold} คน (คนที่ลงมือฆ่าเองนับเป็นคนแรก คนวางกับดัก/ยาพิษไม่นับจนกว่าจะเดินมาเห็นศพเอง) ถึงจะประกาศ · ศพอาจถูกย้ายมาจากที่อื่น</p>
      ${cases
        .map(
          (c) => `<div class="case ${c.judged ? 'judged' : ''}">
          <div class="row"><b>${esc(c.title)}</b><span class="spacer"></span><span class="badge">พบที่ ${esc(c.zoneName)}</span>${c.announcedDay ? `<span class="badge">ประกาศ${esc(timeText(c.announcedDay, c.announcedHour))}</span>` : ''}</div>
          <p><b>ผู้เสียชีวิต:</b> ${esc(c.victim.characterName)} (${esc(c.victim.playerName)})</p>
          ${c.judged && c.bodyState
            ? `<dl class="report"><dt>สภาพศพ (เฉลย)</dt><dd>${esc(c.bodyState)}</dd><dt>ที่เกิดเหตุ (เฉลย)</dt><dd>${esc(c.sceneNotes)}</dd></dl>`
            : `<p class="muted" style="font-size:.85rem">ประกาศบอกแค่ใครตายและพบที่ไหน — 🔎 <b>ตรวจศพ</b>ที่ห้องนั้นเพื่อรู้ชนิดบาดแผลและเวลาตาย (สายการแพทย์เห็นละเอียดกว่า แต่ไม่มีใครได้ชื่อของ) · 🔍 <b>สำรวจห้อง</b>เพื่อหาร่องรอยและอุปกรณ์ที่ทิ้งไว้ — ผลอยู่ในสมุดบันทึกของคุณคนเดียว</p>`}
        </div>`,
        )
        .join('')}
    </div>`;
  }

  function trialIntroHtml(s) {
    const alive = s.players.filter((p) => p.alive);
    const done = alive.filter((p) => p.voteConfirmed).length;
    return `<div class="card">
      <h2>⚖ การตัดสิน${s.huntRound > 1 ? ` — รอบที่ ${s.huntRound} ของวันนี้` : ''}</h2>
      ${s.huntRound > 1 ? `<p class="status" style="color:var(--red)">📢 "ยังมีฆาตกรอีก 1 คนซ่อนอยู่ในหมู่พวกคุณ" — ระบบไม่บอกว่าเหลือกี่คน ดูคดีที่ยังเปิดอยู่ในการ์ด "ศพที่ถูกประกาศ"</p>` : ''}
      <p>เล่าหลักฐานและสิ่งที่แต่ละคนเห็นในแชท แล้วโหวตทางขวา — <b>โหวตถูก</b> คนนั้นถูกประหาร (ถ้ายังมีฆาตกรเหลือ ระบบจะบอก แต่ไม่บอกว่ากี่คน แล้วตามหาต่อ) · <b>โหวตผิด</b> คนร้ายรอด ทุกคนที่เหลือตาย เกมจบ · ถ้าเชื่อว่าคนร้ายตายไปแล้ว เลือก <b>"ไม่มีคนร้ายให้ลงโทษ"</b></p>
      <p class="muted">ยืนยันโหวตแล้ว ${done}/${alive.length}${s.runoff ? ` · <span class="badge red">รอบตัดสินครั้งที่ ${s.runoff.number}</span>` : ''}</p>
    </div>`;
  }

  function evidenceHtml(s) {
    const me = s.me;
    const ev = me.evidence || [];
    const witness = (me.log || []).filter((l) => ['witness', 'evidence', 'culprit', 'danger', 'escape'].includes(l.kind));
    return `<div class="card clues">
      <h3>🧩 หลักฐานและสิ่งที่คุณรู้ (คนอื่นมองไม่เห็น — เอาไปเล่าในแชท)</h3>
      ${ev.length ? `<ul class="obs">${ev.map((e) => `<li><b>${esc(e.zoneName)}</b> (${esc(timeText(e.day, e.hour))}): ${esc(e.text)}</li>`).join('')}</ul>` : '<p class="muted">คุณยังไม่ได้เก็บหลักฐานจากการสำรวจเลย</p>'}
      ${witness.length ? `<div class="agtitle" style="margin-top:.6rem">จากสมุดบันทึก</div>${witness.slice(-12).map(logEntryHtml).join('')}` : ''}
    </div>`;
  }

  function resultHtml(s) {
    const r = s.lastResult;
    if (!r) return '';
    const maxVotes = Math.max(1, ...r.tally.map((t) => t.count));
    const culpritPlayers = new Set(r.cases.filter((c) => c.killerPlayer).map((c) => c.killerPlayer));
    return `<div class="card result ${r.correct ? 'correct' : 'wrong'}">
      <div class="verdict">${r.correct ? '✔ โหวตถูกต้อง!' : '✘ โหวตผิด!'}</div>
      <p>เสียงส่วนใหญ่โหวต: <b>${esc(displayName(r.votedId))}</b>${r.randomTiebreak ? ' <span class="badge yellow">ยังเสมอหลังรอบตัดสิน จึงสุ่มตัดสิน</span>' : ''}</p>
      <p>${r.correct ? (r.executedId ? `⛓ <b>${esc(displayName(r.executedId))}</b> ถูกประหาร` : r.cases.some((c) => c.killerName) ? '🕊 ไม่มีใครถูกประหาร — คนร้ายของคดีนี้ตายไปก่อนแล้ว จึงไม่มีใครให้ลงโทษ' : '🕊 ไม่มีใครถูกประหาร — ไม่มีคนร้ายในคดีนี้') : `☠ ทุกคนที่เหลือถูกประหาร${r.escaped?.length ? ` · 🏃 คนร้ายตัวจริง <b>${esc(r.escaped.map(displayName).join(', '))}</b> รอดไปได้` : ''}`}</p>
      ${r.correct ? (r.moreKillers ? `<p class="status" style="color:var(--red)">📢 เสียงประกาศ: "ยังมีฆาตกรอีก 1 คนซ่อนอยู่ในหมู่พวกคุณ" — คดีที่ยังไม่ปิด: <b>${esc((r.stillOpen || []).join(', '))}</b> · ระบบไม่บอกว่าเหลือกี่คน การตามหาจะดำเนินต่อ: เก็บหลักฐานอีก 1 ชั่วโมง แล้วตัดสินใหม่</p>` : `<p class="status">🕊 คดีทั้งหมดของวันนี้ปิดแล้ว ไม่มีฆาตกรเหลืออยู่ — ขึ้นวันใหม่ได้</p>`) : ''}
      ${r.runoffs ? `<p class="muted">มีการโหวตรอบตัดสิน ${r.runoffs} ครั้ง</p>` : ''}
      <h3>ผลโหวต</h3>
      <div class="tally">${r.tally
        .map((t) => `<div class="bar ${culpritPlayers.has(playerById(t.targetId)?.name) ? 'culprit' : ''}"><span>${esc(displayName(t.targetId))}</span><div class="fill"><i style="width:${(t.count / maxVotes) * 100}%"></i></div><span>${t.count}</span></div>`)
        .join('') || '<p class="muted">ไม่มีคะแนนโหวต</p>'}</div>
      <h3>ความจริงของคดี${r.moreKillers ? 'ที่ปิดในรอบนี้' : ''}</h3>
      ${r.cases
        .map(
          (c) => `<div class="case">
          <div class="row"><b>${esc(c.title || 'คดี')}</b><span class="spacer"></span><span class="badge">${esc(c.causeLabel)}${c.trapLabel ? `: ${esc(c.trapLabel)}` : ''}</span></div>
          <p>${esc(c.truthSummary)}</p>
          <ul class="obs">
            <li>ผู้ตาย: <b>${esc(c.victimName)}</b> (${esc(c.victimPlayer)}) · ที่${esc(c.zoneName)} · ${esc(timeText(c.day, c.hour))}</li>
            <li>คนร้าย: <b>${c.killerName ? `${esc(c.killerName)} (${esc(c.killerPlayer)})${c.killerUltimate ? ` — ${esc(c.killerUltimate)}` : ''}` : 'ไม่มี'}</b>${c.killerFakeUltimate ? ` <span class="badge purple">โรลปลอม! ประกาศไว้ว่า ${esc(c.killerFakeUltimate)}</span>` : ''}${c.cause === 'defense' ? ' <span class="badge yellow">ป้องกันตัว</span>' : ''}${c.killerName ? (c.killerFate === 'escaped' ? ' <span class="badge red">รอดไปได้ — โหวตผิด</span>' : c.killerFate === 'executed' ? ' <span class="badge">ถูกประหารรอบนี้</span>' : !c.killerAlive ? ' <span class="badge">ตายไปก่อนการตัดสิน</span>' : '') : ''}</li>
            ${c.weaponName ? `<li>อาวุธ: ${esc(c.weaponName)}${c.messy ? ' · ลงมือแบบเลอะเทอะ' : ' · ลงมือเงียบเชียบ'}${c.moved ? ' · ศพถูกย้าย' : ''}</li>` : ''}
            ${c.witnesses?.length ? `<li>คนที่เห็นตอนลงมือ: ${esc(c.witnesses.join(', '))}</li>` : ''}
            ${c.present?.length ? `<li>คนที่อยู่ในห้องตอนนั้น: ${esc(c.present.join(', '))}</li>` : ''}
            ${c.designatedName ? `<li class="muted">ฆาตกรที่เกมเลือกวันนั้น: ${esc(c.designatedName)}${c.designatedHeard ? ' (ได้ยินเสียงจากที่เกิดเหตุ)' : ''}</li>` : ''}
          </ul>
        </div>`,
        )
        .join('')}
      <details><summary>ใครไปห้องไหนในแต่ละชั่วโมง และเกิดอะไรขึ้นจริง ๆ</summary>${timelineHtml(r.timeline)}</details>
    </div>`;
  }

  function timelineHtml(tl) {
    if (!tl?.length) return '';
    return tl
      .map(
        (t) => `<div class="whereabouts"><h3>${esc(timeText(t.day, t.hour))}${t.phase === 'investigation' ? ' (รอบเก็บหลักฐาน)' : ''}</h3>
        <ul>${t.positions.map((p) => `<li><b>${esc(p.characterName)}</b> <span class="muted">(${esc(p.playerName)})</span> → ${esc(p.zoneName)}</li>`).join('')}</ul>
        ${t.events.length ? `<ul class="events">${t.events.map((e) => `<li class="truth">${esc(e)}</li>`).join('')}</ul>` : '<p class="muted">ไม่มีเหตุการณ์สำคัญ</p>'}
      </div>`,
      )
      .join('');
  }

  // ---------- side ----------
  function renderSide(s) {
    setHtml('#side', myCardHtml(s) + inventoryHtml(s) + actionsHtml(s) + noticesHtml(s) + notebookHtml(s) + historyHtml(s));
  }

  function myCardHtml(s) {
    const me = playerById(s.me.id);
    const c = me?.character;
    if (!c) return `<div class="card mycard"><h3>ตัวละครของคุณ</h3><p class="muted">กำลังสุ่มตัวละครและ Ultimate...</p></div>`;
    const t = s.me.trait;
    const shown = c.shownToOthers;
    return `<div class="card mycard">
      <h3>ตัวละครของคุณ</h3>
      <div class="phead">${avatarHtml(c, 'lg')}<div>
        <div class="big">${esc(c.name)} <span class="muted" style="font-weight:300">(${esc(c.nickname)})</span></div>
        <div class="muted">${esc(c.gender)} · อายุ ${c.age}</div>
      </div></div>
      <p><b>รูปลักษณ์:</b> ${esc(c.appearance)}</p>
      <hr style="border-color:var(--line);border-style:solid none none">
      ${shown
        ? `<div class="rolebox">
            <div class="rolerow"><span class="rlabel">คนอื่นเห็นคุณเป็น</span><span class="rval ${shown === '???' ? 'unknown' : ''}">${esc(shown)}</span></div>
            <div class="rolerow"><span class="rlabel">โรลจริงของคุณ</span><span class="rval real">${esc(c.ultimate)}</span></div>
            <p class="muted" style="font-size:.85rem;margin-top:.3rem">${shown === '???' ? 'คุณกำลัง "ปกปิดโรล" อยู่ — จะเปิดเผยเองในแชทหรือเก็บเป็นความลับก็ได้' : `คุณถือ "โรลปลอม" — คนอื่นเข้าใจว่าคุณคือ ${esc(shown)} (${esc(s.me.fakeUltimate?.description || '')}) มีแค่คุณที่รู้ของจริง`}</p>
          </div>`
        : `<div class="ult">${esc(c.ultimate)}</div><span class="badge">ทุกคนเห็นโรลนี้</span>`}
      <p>${esc(c.ultimateDescription || '')}</p>
      ${t && t.key !== 'none' ? `<p style="margin-top:.5rem">${traitBadge(t.key)} <span class="muted" style="font-size:.85rem">${esc(t.description)}</span></p><ul class="obs" style="font-size:.82rem">${(t.effects || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="muted" style="font-size:.85rem">ไม่มี trait พิเศษ — ใช้แอ็กชันพื้นฐานได้ทุกอย่าง (ลงมือมือเปล่า 35%, ถืออาวุธ 70%)</p>'}
      ${!me.alive ? `<p><span class="badge red">${FATE_LABEL[me.fate] || 'เสียชีวิต'}</span></p>` : ''}
    </div>`;
  }

  function inventoryHtml(s) {
    const me = s.me;
    if (!s.location) return '';
    const inv = me.inventory || [];
    const objs = me.objectives || [];
    return `<div class="card inv">
      <h3>🎒 ของที่ถือ (${inv.length}/${me.inventoryMax || s.config.inventoryMax})</h3>
      ${inv.length ? `<div class="chips">${inv.map((i) => `<span class="chip ${i.isPart ? 'part' : ''} ${i.kind === 'trap' ? 'trap' : ''} ${i.bloody ? 'bloody' : ''}" title="${esc(i.description || '')}${i.tagText ? ` — ${esc(i.tagText)}` : ''}">${KIND_ICON[i.kind] || '•'} ${esc(i.name)}${i.bloody ? ' 🩸' : ''}${i.ammo != null ? ` <small>(${i.ammo} นัด)</small>` : ''}${i.tagText ? ` <small class="muted">${esc(i.tagText)}</small>` : ''}${i.unlocksZoneNames?.length ? ` <small>(ไข${esc(i.unlocksZoneNames.join(', '))})</small>` : i.exitName ? ` <small>(${esc(i.exitName)})</small>` : ''}</span>`).join('')}</div>` : '<p class="muted">มือเปล่า</p>'}
      ${exitsHtml(s)}
      ${s.config.objectives ? `<h3 style="margin-top:.7rem">📋 ภารกิจลับ</h3>
      ${objs.length ? objs.map((o) => `<div class="objective ${o.done ? 'done' : o.remainingHours <= 1 ? 'due' : ''}">${o.done ? (o.forgiven ? '➖' : '✅') : '•'} ${esc(o.text)} ${objectiveBadge(o)}</div>`).join('') : '<p class="muted">ไม่มีภารกิจค้าง</p>'}
      <p class="muted" style="font-size:.78rem">ภารกิจละเลยได้ แต่ครบกำหนดแล้วยังไม่ทำ = สลบ 1–3 ชั่วโมง ของบางชิ้นหล่น และระหว่างสลบใครลงมือกับคุณก็สำเร็จแน่นอน</p>` : ''}
      ${me.buffs?.questPlus || me.buffs?.koResist ? `<p style="margin-top:.5rem">${me.buffs.questPlus ? `<span class="badge green">💊 ภารกิจถัดไป +${me.buffs.questPlus} ชม.</span> ` : ''}${me.buffs.koResist ? '<span class="badge green">💊 ต้านทานสลบ 1 ครั้ง</span>' : ''}</p>` : ''}
      ${me.isDesignated ? '<p style="margin-top:.5rem"><span class="badge red">🔪 วันนี้เกมเลือกคุณเป็นฆาตกร</span></p>' : ''}
    </div>`;
  }

  // ทางออกที่ "คุณ" ค้นพบแล้ว (คนอื่นไม่รู้ว่าคุณรู้)
  function exitsHtml(s) {
    const exits = s.me.exits || [];
    const total = s.exitsTotal || 0;
    return `<h3 style="margin-top:.7rem">🚪 ทางออกที่คุณรู้จัก (${exits.length}/${total})</h3>
      ${exits.length
        ? exits.map((x) => `<div class="exitbox ${x.open ? 'open' : ''}">
            <div class="row"><b>${ROUTE_ICON[x.route] || '🚪'} ${esc(x.name)}</b><span class="spacer"></span><span class="badge yellow">${esc(x.zoneName)}</span></div>
            <div class="muted" style="font-size:.82rem">${esc(x.description)}</div>
            <div style="font-size:.85rem;margin-top:.25rem"><b>${esc(x.routeLabel)}</b> · ผ่านแล้ว ${x.stepsDone ?? 0}/${x.steps?.length ?? 0} ขั้น</div><div class="muted" style="font-size:.78rem">ทำขั้นไหนก่อนก็ได้ ขั้นที่ ✅ แล้วไม่ต้องทำซ้ำ · ของที่ต้องถือ (กุญแจ/เศษรหัส/ชุดที่ประกอบ) ต้องอยู่ในมือตอนลงมือ · ไปที่ห้องนั้นแล้วเลือก "ลงมือกับทางออก" จะทำทุกขั้นที่ทำได้ในชั่วโมงเดียว</div>
            ${x.steps?.length ? `<ol class="obs" style="margin:.2rem 0 0 1.1rem;font-size:.82rem">${x.steps.map((st) => `<li>${st.done ? '✅' : '⬜'} ${esc(st.label)}${st.needed ? ` (${st.progress}/${st.needed})` : ''}</li>`).join('')}</ol>` : ''}
            ${x.items?.length ? `<div class="chips" style="margin-top:.3rem">${x.items.map((i) => `<span class="chip ${i.held ? 'part' : ''}" title="${i.held ? 'คุณถืออยู่' : 'ยังไม่ได้อยู่กับคุณ'}">${i.held ? '✅' : '⬜'} ${esc(i.name)}</span>`).join('')}</div>` : ''}
            ${x.route === 'breach' ? `<div class="muted" style="font-size:.82rem">ความคืบหน้า ${x.progress}/${x.progressNeeded}</div>` : ''}${x.route === 'power' ? `<div class="muted" style="font-size:.82rem">${x.powered ? '⚡ มีไฟแล้ว' : 'ยังไม่มีไฟ'}</div>` : ''}
          </div>`).join('')
        : `<p class="muted" style="font-size:.85rem">ยังไม่รู้ว่าทางออกอยู่ห้องไหน — "สำรวจห้องอย่างละเอียด" ในห้องต่าง ๆ หรือหาแผนผัง/บันทึกที่ซ่อนอยู่ (มีทั้งหมด ${total} ทาง แต่ละทางเปิดไม่เหมือนกัน)</p>`}
      <details class="help"><summary>🛠 สูตรประกอบกับดัก และกติกากับดัก</summary>
        <ul class="obs">${(s.config.recipes || []).map((r) => `<li><b>${esc(r.name)}</b> = ${esc(r.how)}${r.traitLabel ? ` <span class="badge cyan">${esc(r.traitLabel)}</span>` : ''}<br><span class="muted">${esc(r.desc)}</span></li>`).join('')}
          <li><b>ยาพิษในอาหาร</b> = ถือยา/สารพิษไปห้องที่มีอาหาร แล้วเลือก "ผสมยาพิษ" (ไม่ต้องคราฟ)</li>
        </ul>
        <p class="muted" style="font-size:.8rem">ของเดี่ยว ๆ วางเป็นกับดักไม่ได้ ต้องประกอบก่อน (ใช้ 1 ชั่วโมง) แล้วค่อย "วางกับดัก" ที่ทางเข้าห้อง · ถ้ามีศพที่ยังไม่ถูกพบ คนที่ไม่ใช่คนร้ายคดีนั้นจะลงมือ/วางกับดักไม่ได้จนกว่าจะพบศพ</p>
      </details>`;
  }

  function actionsHtml(s) {
    const me = s.me;
    const alive = s.players.filter((p) => p.alive);
    let body = '';
    const hostForce = (label) => (me.isHost ? `<hr style="border-color:var(--line);border-style:solid none none"><button class="small danger" data-action="force-step">${label}</button>` : '');
    switch (s.phase) {
      case 'day':
      case 'investigation': {
        if (!s.step) body += '<p class="status">กำลังประมวลผล...</p>';
        else if (s.step === 'move') {
          const n = alive.filter((p) => p.moved).length;
          body += me.alive ? `<p class="status">${me.moveChoice ? `${me.ko ? 'สลบอยู่ที่' : 'เลือกไป'} ${esc(zoneName(me.moveChoice))} แล้ว` : 'เลือกห้องจากแผนที่ตรงกลาง'}</p>` : `<p class="status">รอทุกคนเลือกห้อง</p>`;
          body += hostForce('บังคับไปต่อ (คนที่ยังไม่เลือกจะอยู่ที่เดิม)');
        } else if (s.step === 'act') {
          const n = alive.filter((p) => p.acted).length;
          body += me.alive ? `<p class="status">${me.actionChoice ? `เลือก "${esc(me.actionChoice.label)}" แล้ว` : 'เลือกแอ็กชันตรงกลาง'}</p>` : `<p class="status">รอทุกคนเลือกแอ็กชัน</p>`;
          body += hostForce('บังคับไปต่อ (คนที่ยังไม่เลือกจะอยู่เฉย ๆ)');
        } else {
          const n = alive.filter((p) => p.ready).length;
          body += me.alive ? (me.ready ? `<p class="status">พร้อมแล้ว รอคนอื่น</p>` : `<button class="primary" data-action="ready">พร้อมไปชั่วโมงถัดไป</button><p class="status">รอคนอื่นกดพร้อม</p>`) : `<p class="status">รอทุกคน</p>`;
          body += hostForce('บังคับไปชั่วโมงถัดไป');
        }
        break;
      }
      case 'trial': {
        const done = alive.filter((p) => p.voteConfirmed).length;
        if (me.alive && me.ko) body += `<p class="status">😵 คุณสลบอยู่ โหวตไม่ได้ — รอคนอื่นโหวต (${done}/${alive.length})</p>`;
        else if (me.alive) {
          if (me.voteConfirmed) body += `<p class="status">คุณยืนยันโหวต <b>${esc(displayName(me.myVote))}</b> แล้ว รอคนอื่น (${done}/${alive.length})</p>`;
          else {
            const cands = [...alive.filter((p) => p.id !== me.id).map((p) => p.id), 'none'].filter((id) => !s.runoff || s.runoff.candidates.includes(id));
            body += `${s.runoff ? `<p><span class="badge red">รอบตัดสินครั้งที่ ${s.runoff.number}</span> คะแนนเสมอ โหวตได้เฉพาะตัวเลือกที่เสมอกัน</p>` : '<p>โหวตคนร้าย:</p>'}<div class="votelist">${cands
              .map((id) => {
                const p = playerById(id);
                return `<button data-action="vote" data-id="${esc(id)}" class="${me.myVote === id ? 'selected' : ''} ${id === 'none' ? 'none-vote' : ''}">${id === 'none' ? '🕊 ไม่มีคนร้ายให้ลงโทษ (คนร้ายตายไปแล้ว)' : `${esc(p?.character?.name || p?.name || '?')} <span class="muted">(${esc(p?.name || '')})</span>`}</button>`;
              })
              .join('')}</div>
              <button class="primary" data-action="confirm-vote" ${me.myVote ? '' : 'disabled'}>ยืนยันโหวต</button>
              <p class="status">ยืนยันแล้ว ${done}/${alive.length}</p>`;
          }
        } else body += `<p class="status">รอทุกคนโหวต (${done}/${alive.length})</p>`;
        if (me.alive && !me.ko) body += `<div class="bagcheck"><label>👜 ขอตรวจกระเป๋า <select id="bag-target">${alive.filter((p) => p.id !== me.id).map((p) => `<option value="${esc(p.id)}">${esc(p.character?.nickname || p.name)}</option>`).join('')}</select></label> <button class="small" data-action="bag-request">ขอดู</button><div class="muted" style="font-size:.78rem">เจ้าของต้องยอม ผล (ของทุกชิ้น รวมคราบเลือด) ประกาศในแชทให้ทุกคนเห็น</div></div>`;
        if (me.isHost) body += `<hr style="border-color:var(--line);border-style:solid none none"><button class="small danger" data-action="force-vote">ปิดโหวตตอนนี้</button>`;
        break;
      }
      case 'trial_result':
        body += s.lastResult?.moreKillers
          ? me.isHost ? `<button class="primary" data-action="next-round">🔎 ตามหาฆาตกรที่เหลือ (เก็บหลักฐานต่อ)</button>` : `<p class="status">รอหัวห้องเริ่มการตามหาฆาตกรที่เหลือ...</p>`
          : me.isHost ? `<button class="primary" data-action="next-round">☀ ขึ้นวันใหม่ (วันที่ ${s.day + 1})</button>` : `<p class="status">รอหัวห้องขึ้นวันใหม่...</p>`;
        break;
      default:
        body += `<p class="status">กรุณารอสักครู่...</p>`;
    }
    if (s.config.debugCheats && me.alive && ['day', 'investigation', 'trial'].includes(s.phase)) body += `<p><button class="small danger" data-action="debug-die" title="เปิดอยู่เพราะ DEBUG_CHEATS=true">💀 (ทดสอบ) ตายทันที</button></p>`;
    return `<div class="card actions"><h3>การกระทำ</h3>${body}<p style="margin-top:.8rem"><button class="small ghost" data-action="leave">ออกจากห้อง</button></p></div>`;
  }

  function notebookHtml(s) {
    const log = s.me.log || [];
    if (!log.length) return '';
    return `<div class="card notebook">
      <div class="row"><h3>📓 สมุดบันทึก</h3><span class="spacer"></span><button class="small ghost" data-action="toggle-notebook">${ui.notebookOpen ? 'ซ่อน' : 'แสดง'} (${log.length})</button></div>
      ${ui.notebookOpen ? logGroupsHtml(log) : '<p class="muted" style="font-size:.85rem">ทุกอย่างที่คุณเห็นและทำ มีแค่คุณที่รู้</p>'}
    </div>`;
  }

  // บันทึกจัดกลุ่มตามชั่วโมง (ล่าสุดอยู่บน) — ใช้ทั้งสมุดบันทึกของตัวเองและสมุดของคนที่ผีตามดู
  function logGroupsHtml(log) {
    const groups = new Map();
    for (const l of log) {
      const key = `${l.day}-${l.hour}-${l.phase}`;
      if (!groups.has(key)) groups.set(key, { day: l.day, hour: l.hour, phase: l.phase, entries: [] });
      groups.get(key).entries.push(l);
    }
    return [...groups.values()]
      .reverse()
      .map((g) => `<div class="nbday"><div class="agtitle">${esc(timeText(g.day, g.hour))}${g.phase === 'investigation' ? ' · เก็บหลักฐาน' : ''}</div>${g.entries.map(logEntryHtml).join('')}</div>`)
      .join('');
  }

  function noticesHtml(s) {
    const list = s.me.notices || [];
    if (!list.length) return '';
    return list
      .map((n) => `<div class="notice ${esc(n.kind)}"><span>${esc(n.text)}</span><span class="spacer"></span>${n.kind === 'bagRequest' ? `<button class="small" data-action="bag-reply" data-id="${esc(n.id)}" data-accept="1">✅ ให้ดู</button><button class="small danger" data-action="bag-reply" data-id="${esc(n.id)}" data-accept="0">❌ ไม่ให้</button>` : `<button class="small ghost" data-action="dismiss-notice" data-id="${esc(n.id)}">✕</button>`}</div>`)
      .join('');
  }

  function historyHtml(s) {
    if (!s.history?.length) return '';
    return `<div class="card history"><h3>การตัดสินที่ผ่านมา</h3><ol>${s.history
      .map((h) => `<li><b>${esc(timeText(h.day, h.hour))}</b>${h.round > 1 ? ` <span class="badge">รอบที่ ${h.round}</span>` : ''} ผู้ตาย: ${esc(h.victims.join(', ') || '-')}<br>โหวต: ${esc(h.votedName)} <span class="${h.correct ? 'ok' : 'bad'}">${h.correct ? '(ถูก)' : '(ผิด)'}</span>${h.culprits.length ? ` · คนร้าย: ${esc(h.culprits.join(', '))}` : ' · ไม่มีคนร้าย'}${h.moreKillers ? ' · <span class="bad">ยังมีฆาตกรเหลือ</span>' : ''}</li>`)
      .join('')}</ol></div>`;
  }

  // ---------- chat ----------
  function canChat(s) {
    if (['lobby', 'ended'].includes(s.phase)) return true;
    return s.phase !== 'generating'; // คนเป็นคุยแชทปกติ ผีคุยแชทผี
  }

  const inGhostChat = (s) => !s.me.alive && !['lobby', 'ended'].includes(s.phase);

  function renderChat() {
    const s = state;
    const log = $('#chat-log');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60 || !log.dataset.filled;
    const html = s.chat
      .map((m) =>
        m.system
          ? `<div class="msg system ${m.debug ? 'debug' : ''}">${esc(m.text)}</div>`
          : `<div class="msg ${m.ghost ? 'ghost' : ''} ${m.playerId === s.me.id ? 'me' : ''}">${m.ghost ? '<span class="gtag" title="แชทผี — คนเป็นมองไม่เห็นจนกว่าเกมจบ">👻</span>' : ''}<span class="who">${esc(m.name)}</span>${m.characterName ? `<span class="char">${esc(m.characterName)}</span>` : ''}<span>${esc(m.text)}</span></div>`,
      )
      .join('');
    if (log.dataset.lastHtml !== html) {
      log.dataset.lastHtml = html;
      log.innerHTML = html;
      if (nearBottom) log.scrollTop = log.scrollHeight;
    }
    log.dataset.filled = '1';
    const input = $('#chat-input');
    if (input) {
      const ok = canChat(s);
      input.disabled = !ok;
      input.placeholder = !ok ? 'ยังคุยไม่ได้ในช่วงนี้' : inGhostChat(s) ? '👻 แชทผี — คนเป็นมองไม่เห็น' : 'พิมพ์ข้อความ...';
      input.classList.toggle('ghost-input', ok && inGhostChat(s));
    }
  }

  // ---------- end ----------
  function renderEnd() {
    const s = state;
    mount(
      'end',
      `<div class="screen end">
        <div class="hero"><h1>GAME OVER<span>${esc(END_LABEL[s.endReason] || 'สรุปผล')}</span></h1></div>
        <div class="card" id="end-rank"></div>
        <div id="end-truth"></div>
        <div class="card" id="end-controls"></div>
        <div class="card chat"><h3>แชท</h3><div id="chat-log" class="chat-log"></div>${chatFormHtml()}</div>
      </div>`,
    );
    const row = (r) => `<li class="${r.playerId === s.me.id ? 'me' : ''}">
        <span class="oicon">${r.portrait ? `<img class="avatar sm" src="${esc(r.portrait)}" alt="">` : FATE_ICON[r.fate] || ''}</span>
        <span><b>${esc(r.name)}</b>${r.isBot ? ' <span class="badge">บอท</span>' : ''}${r.playerId === s.me.id ? ' <span class="badge cyan">คุณ</span>' : ''}<br><span class="muted">${esc(r.characterName || '-')} · ${esc(r.ultimate || '-')} ${traitBadge(r.trait)}${r.fakeRole ? ` <span class="badge purple">โรลปลอม: ${esc(r.fakeUltimate || '?')}</span>` : ''}${r.kills ? ` <span class="badge red">ฆ่า ${r.kills}</span>` : ''}</span></span>
        <span style="text-align:right"><span class="badge ${FATE_CLASS[r.fate] || ''}">${FATE_ICON[r.fate] || ''} ${FATE_LABEL[r.fate] || '-'}</span>${r.deathCauseLabel && r.fate !== 'executed' && r.fate !== 'punished' ? `<br><span class="muted">${esc(r.deathCauseLabel)}</span>` : ''}${r.eliminatedDay ? `<br><span class="muted">${esc(timeText(r.eliminatedDay, r.eliminatedHour))}</span>` : ''}${r.revived ? '<br><span class="badge yellow">เคยคืนชีพ</span>' : ''}</span>
      </li>`;
    const o = s.outcome || { survived: [], died: [], unsolved: [] };
    $('#end-rank').innerHTML = `<div class="outcome">
      <div><h3 style="color:var(--green)">รอดชีวิต (${o.survived.length})</h3><ul>${o.survived.map(row).join('') || '<li class="muted">ไม่มีใครรอด</li>'}</ul></div>
      <div><h3 style="color:var(--red)">ไม่รอด (${o.died.length})</h3><ul>${o.died.map(row).join('') || '<li class="muted">ไม่มีใครตาย</li>'}</ul></div>
    </div>
    <p class="muted" style="margin-top:.6rem">เล่นไป ${o.days} วัน ${o.hours} ชั่วโมง · ${esc(END_LABEL[s.endReason] || '')}</p>
    ${o.exits?.length ? `<h3 style="margin-top:.8rem">ทางออกของสถานที่นี้</h3>${o.exits.map((x) => `<div class="case">${ROUTE_ICON[x.route] || '🚪'} <b>${esc(x.name)}</b> ที่${esc(x.zoneName)} — ${x.open ? `<span class="badge green">เปิดสำเร็จโดย ${esc(x.openedBy.join(', '))}</span>` : `<span class="badge">มีคนค้นพบ ${x.discovered} คน ไม่ได้เปิด</span>`}</div>`).join('')}` : ''}
    ${o.unsolved?.length ? `<h3 style="margin-top:.8rem">คดีที่ยังไม่ได้ตัดสินตอนเกมจบ</h3>${o.unsolved.map((c) => `<div class="case"><b>${esc(c.victimName)}</b> — ${esc(c.causeLabel)}${c.killerName ? ` โดย <b>${esc(c.killerName)}</b>` : ''} ที่${esc(c.zoneName)} ${esc(timeText(c.day, c.hour))}${c.truthSummary ? `<br><span class="muted">${esc(c.truthSummary)}</span>` : ''}</div>`).join('')}` : ''}`;
    $('#end-truth').innerHTML = s.lastResult ? resultHtml(s) : '';
    $('#end-controls').innerHTML = s.me.isHost
      ? `<button class="primary" data-action="restart">เล่นอีกครั้งกับคนเดิม</button> <button class="ghost" data-action="leave">ออกจากห้อง</button>`
      : `<p class="muted">รอหัวห้องเริ่มเกมใหม่</p><button class="ghost" data-action="leave">ออกจากห้อง</button>`;
    renderChat();
  }

  // ---------- modal ----------
  function openModal(innerHtml, buttonLabel = 'ปิด') {
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="card modal">${innerHtml}<p style="text-align:right;margin-top:.8rem"><button class="primary" data-action="close-modal">${esc(buttonLabel)}</button></p></div></div>`;
  }
  function closeModal() {
    $('#modal-root').innerHTML = '';
  }

  function confirmDialog(message) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      root.innerHTML = `<div class="modal-backdrop confirm"><div class="card modal" style="max-width:440px">
        <p style="font-size:1.05rem">${esc(message)}</p>
        <p class="row" style="justify-content:flex-end;margin-top:1rem"><button data-confirm="no">ยกเลิก</button><button class="primary" data-confirm="yes">ตกลง</button></p>
      </div></div>`;
      root.onclick = (e) => {
        const b = e.target.closest('[data-confirm]');
        const backdrop = e.target.classList.contains('modal-backdrop');
        if (!b && !backdrop) return;
        root.onclick = null;
        root.innerHTML = '';
        resolve(!!b && b.dataset.confirm === 'yes');
      };
    });
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    if (e.target.classList?.contains('modal-backdrop')) {
      if (!e.target.classList.contains('confirm')) closeModal();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    switch (action) {
      case 'copy-code':
        try {
          await navigator.clipboard.writeText(state.code);
          toast('คัดลอกรหัสห้องแล้ว');
        } catch {
          toast(`รหัสห้อง: ${state.code}`);
        }
        break;
      case 'copy-link': {
        const link = inviteLink(state.code);
        try {
          await navigator.clipboard.writeText(link);
          toast(isLocalHost() ? 'คัดลอกลิงก์แล้ว (เป็น localhost: เพื่อนเครื่องอื่นต้องใช้ IP/URL แชร์แทน)' : 'คัดลอกลิงก์เชิญแล้ว ส่งให้เพื่อนได้เลย');
        } catch {
          toast(`ลิงก์เชิญ: ${link}`);
        }
        break;
      }
      case 'leave':
        if (await confirmDialog('ออกจากห้องนี้?')) {
          store.code = '';
          location.reload();
        }
        break;
      case 'start':
        btn.disabled = true;
        await act('game:start');
        break;
      case 'pick-zone':
        if (state.me.moveChoice || !state.me.alive) break;
        if ((state.me.door?.lockedIn || state.me.door?.barred) && id !== state.me.zoneId && !(state.me.passages || []).some((x) => (x.a === state.me.zoneId && x.b === id) || (x.b === state.me.zoneId && x.a === id))) {
          toast('🔒 คุณถูกล็อกอยู่ในห้องนี้ ออกไม่ได้ — เลือกห้องนี้ต่อ แล้วสะเดาะ/พังประตูในขั้นเลือกแอ็กชัน (หรือไขกุญแจถ้ามี)', 'error');
          break;
        }
        ui.selectedZone = id;
        renderMain(state);
        break;
      case 'confirm-move':
        if (ui.selectedZone) await act('day:move', { zoneId: ui.selectedZone });
        break;
      case 'pick-action':
        ui.selectedAction = btn.dataset.key;
        renderMain(state);
        break;
      case 'confirm-action': {
        const a = (state.me.availableActions || []).find((x) => actionKey(x) === ui.selectedAction);
        if (!a) break;
        const payload = { type: a.type, itemId: a.itemId, itemId2: a.itemId2, targetId: a.targetId, victimId: a.victimId, recipeId: a.recipeId, exitId: a.exitId };
        if (a.needsZone) payload.toZoneId = $('#move-body-to')?.value || '';
        if (a.multiItems) payload.itemIds = [...document.querySelectorAll('.hide-item:checked')].map((x) => x.value);
        if (a.danger && !(await confirmDialog(`ยืนยัน "${a.label}"? เลือกแล้วเปลี่ยนไม่ได้`))) break;
        await act('day:act', payload);
        break;
      }
      case 'give': {
        const itemId = $('#give-item')?.value;
        const targetId = $('#give-to')?.value;
        if (!itemId || !targetId) break;
        if (await act('day:give', { targetId, itemId })) toast('ให้ของเรียบร้อย');
        break;
      }
      case 'request': {
        const pair = $('#request-pair')?.value || '';
        const [targetId, itemId] = pair.split('|');
        if (!targetId || !itemId) break;
        if (await act('day:request', { targetId, itemId })) toast('ได้ของจากบอทแล้ว');
        break;
      }
      case 'item-now':
        if (await act('day:item', { type: btn.dataset.type, itemId: id })) toast('เรียบร้อย — ยังเลือกทำอย่างอื่นได้');
        break;
      case 'door-now':
        if (btn.dataset.type === 'breakPower' && !(await confirmDialog('พังเครื่องปั่นไฟ? ไฟจะดับทั้งตึกจนกว่าจะมีคนซ่อม'))) break;
        if (await act('day:door', { type: btn.dataset.type, itemId: btn.dataset.id || undefined })) toast('เรียบร้อย — ไม่กินชั่วโมง');
        break;
      case 'ready':
        await act('day:ready');
        break;
      case 'follow':
        await act('spectate:follow', { targetId: state.me.spectator?.watching?.id === id ? '' : id });
        break;
      case 'ghost-tab':
        ui.ghostTab = id;
        renderMain(state);
        break;
      case 'debug-die':
        if (await confirmDialog('(ทดสอบ) ตายทันทีเพื่อดูโหมดวิญญาณ?')) await act('debug:die');
        break;
      case 'force-step':
        if (await confirmDialog('บังคับไปต่อเลย? คนที่ยังไม่เลือกจะถูกเลือกให้อัตโนมัติ')) await act('host:forceStep');
        break;
      case 'vote':
        await act('vote:cast', { targetId: id });
        break;
      case 'confirm-vote':
        if (state.me.myVote && (await confirmDialog(`ยืนยันโหวต "${displayName(state.me.myVote)}"? ถ้าผิด ทุกคนตายและเกมจบ`))) await act('vote:confirm');
        break;
      case 'force-vote':
        if (await confirmDialog('ปิดโหวตตอนนี้? คนที่ยังไม่โหวตจะถือว่างดออกเสียง')) await act('host:forceVote');
        break;
      case 'next-round':
        btn.disabled = true;
        await act('host:nextRound');
        break;
      case 'restart':
        if (await confirmDialog('เริ่มเกมใหม่กับผู้เล่นชุดเดิม?')) await act('host:restart');
        break;
      case 'bag-request': {
        const targetId = $('#bag-target')?.value;
        if (targetId) await act('trial:bagRequest', { targetId });
        break;
      }
      case 'bag-reply':
        await act('trial:bagReply', { id, accept: btn.dataset.accept === '1' });
        break;
      case 'dismiss-notice':
        await act('notice:dismiss', { id });
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'toggle-notebook':
        ui.notebookOpen = !ui.notebookOpen;
        renderSide(state);
        break;
      default:
        break;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'bot-count') act('lobby:setBots', { count: Number(e.target.value) });
    if (e.target.id === 'move-body-to') ui.moveBodyTo = e.target.value;
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'join-form') {
      e.preventDefault();
      const name = $('#name').value.trim();
      const code = $('#code').value.trim().toUpperCase();
      const mode = e.submitter?.dataset.action || (code ? 'join' : 'create');
      if (!name) return;
      store.name = name;
      ui.joinError = '';
      const ack =
        mode === 'join'
          ? await send('room:join', { code, name, playerId: store.playerId })
          : await send('room:create', { name, playerId: store.playerId });
      if (!ack.ok) {
        ui.joinError = ack.error || 'เข้าร่วมไม่สำเร็จ';
        renderJoin();
      } else {
        store.code = ack.code;
        send('state:request');
      }
    }
    if (e.target.id === 'chat-form') {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await act('chat:send', { text });
      input.focus();
    }
  });

  // ---------- boot ----------
  const inviteParam = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(inviteParam)) {
    ui.inviteCode = inviteParam;
    if (store.name) store.code = inviteParam;
    history.replaceState(null, '', location.pathname);
  }
  if (store.code && store.name) {
    $('#app').innerHTML = `<div class="screen join"><div class="card loading"><div class="spinner"></div><h2>กำลังกลับเข้าห้อง ${esc(store.code)}...</h2></div></div>`;
  } else {
    renderJoin();
  }
})();
