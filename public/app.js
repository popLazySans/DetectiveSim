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
    day: 'กลางวัน — พูดคุยกันได้',
    night: 'กลางคืน',
    incident: 'เกิดเหตุ!',
    investigation: 'สืบสวน & โหวต',
    trial_result: 'ผลการตัดสิน',
    ended: 'จบเกม',
  };
  const FATE_LABEL = { victim: 'ถูกฆ่า', executed: 'ถูกประหาร', escaped: 'หนีรอด', wrongly_executed: 'ถูกประหารทั้งที่บริสุทธิ์', survivor: 'รอดชีวิต' };
  const FATE_ICON = { victim: '☠', executed: '⛓', escaped: '🏃', wrongly_executed: '⚖', survivor: '🏁' };
  const FATE_CLASS = { victim: 'purple', executed: 'red', escaped: 'yellow', wrongly_executed: 'red', survivor: 'green' };

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
  let nightTimer = null;
  const ui = { joinError: '', seenIncidentRound: 0, seenEventRound: 0, itemsOpen: true };

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
    const p = playerById(id);
    if (!p) return '???';
    return p.character ? `${p.character.name} (${p.name})` : p.name;
  };

  // ---------- socket ----------
  // แถบสถานะการเชื่อมต่อ: โฮสต์ฟรี (เช่น Render) อาจ "หลับ" และใช้เวลาปลุกราว 1 นาที จึงบอกผู้เล่นให้รอแทนที่จะเห็นหน้าว่าง
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

  // ส่งสัญญาณทุก 4 นาที กันโฮสต์ฟรีหลับระหว่างที่ยังมีคนเปิดหน้าเกมอยู่
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
    renderGame();
    if (s.phase === 'investigation' && s.incident && s.incident.round !== ui.seenIncidentRound) {
      ui.seenIncidentRound = s.incident.round;
      openModal(`${incidentHtml(s)}${cluesHtml(s)}`, 'เริ่มสืบสวน');
    }
    if (s.phase === 'day' && s.specialEvent && s.specialEvent.round !== ui.seenEventRound) {
      ui.seenEventRound = s.specialEvent.round;
      openModal(eventHtml(s), 'รับทราบ');
    }
    if (s.phase === 'night' && !nightTimer) nightTimer = setInterval(updateCountdown, 1000);
    if (s.phase !== 'night' && nightTimer) {
      clearInterval(nightTimer);
      nightTimer = null;
    }
  }

  // ---------- join ----------
  function renderJoin() {
    currentScreen = 'join';
    $('#app').innerHTML = `
      <div class="screen join">
        <div class="hero">
          <h1>DESPAIR BOARD<span>บอร์ดเกมสืบสวนฆาตกรรม</span></h1>
          <p class="muted">3–15 ผู้เล่น · ทุกคนมี Ultimate · ทุกคืนมีคนตาย · โหวตหาคนร้ายให้ถูก</p>
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
          <ol>
            <li>ทุกคนได้รับตัวละคร 1 ตัวพร้อม Ultimate ที่ AI สุ่มให้ — มีแค่ 1–2 คนที่ Ultimate ถูกซ่อนเป็น <b>???</b> (เจ้าของเองอาจไม่รู้ด้วยซ้ำ) และอีก 1 คนถือ <b>โรลปลอม</b>: Ultimate ที่คนอื่นเห็นไม่ใช่ของจริง มีแค่เจ้าตัวที่รู้</li>
            <li>แต่ละวันทุกคนมาถึงสถานที่ใหม่ที่มีอุปกรณ์ 5–10 ชิ้น คุยกันจนทุกคนกด "เข้านอน"</li>
            <li>กลางคืน ระบบสุ่มฆาตกร 1 คน (รู้แค่ตัวเอง) ให้เลือกเป้าหมาย แล้ว AI จะสร้างเหตุการณ์ฆาตกรรมขึ้น — คนตายอาจเป็นใครก็ได้ และคนร้ายตัวจริงอาจไม่ใช่ฆาตกรที่ระบบเลือก!</li>
            <li>ทุกคนเห็นแค่สภาพศพและอุปกรณ์ต้องสงสัย ส่วน "ใครอยู่ที่ไหน" แต่ละคนรู้เฉพาะสิ่งที่ตัวเองทำและเหตุการณ์ที่ตัวเองเห็นหรืออยู่ด้วย ต้องเอามาเล่าในแชทเพื่อต่อภาพ คนที่มี Ultimate เกี่ยวข้องจะรู้มากกว่า — ทุกการปกปิดทิ้งร่องรอย และคนร้ายไม่จำเป็นต้องใช้ Ultimate</li>
            <li>โหวตหาคนร้าย: โหวตถูก → คนร้ายถูกประหาร · โหวตผิด → คนร้ายหนีรอด · คะแนนเสมอ → โหวตรอบตัดสินเฉพาะคนที่เสมอ</li>
            <li>เล่นวนไปจนเหลือคนเดียว แล้วสรุปว่าใครรอด ใครไม่รอด · บางเช้าอาจมีอีเวนต์พิเศษที่ทำให้ "คนตาย" กลับมา</li>
          </ol>
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

  // ลิงก์เชิญ: เปิดแล้วรหัสห้องถูกกรอกให้อัตโนมัติ (ใช้ origin ที่กำลังเปิดอยู่ เช่น IP ในวง LAN หรือ URL ของ tunnel)
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
        <p class="muted">บอทช่วยเติมจำนวนผู้เล่น: บอทจะเข้านอน เลือกเป้าหมาย และโหวตเองอัตโนมัติ</p>
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
    setHtml('#topbar', `
      <span class="logo">DESPAIR BOARD</span>
      <span class="badge">ห้อง ${esc(s.code)}</span>
      <span class="badge pink">วันที่ ${s.round}</span>
      <span class="phase">${PHASE_LABEL[s.phase] || s.phase}</span>
      ${s.location ? `<span class="loc">📍 ${esc(s.location.name)}</span>` : ''}
      <span class="spacer"></span>
      ${aiBadge(s)}
      <span class="badge">มีชีวิต ${alive}/${s.players.length}</span>`);
    setHtml('#roster', s.players.map((p) => playerCard(s, p)).join(''));
    renderMain(s);
    renderSide(s);
    renderChat();
  }

  function playerCard(s, p) {
    const me = s.me;
    const isMe = p.id === me.id;
    const c = p.character;
    const votable = s.phase === 'investigation' && !me.voteConfirmed && (!s.runoff || s.runoff.candidates.includes(p.id));
    const clickable = p.alive && !isMe && me.alive && ((s.phase === 'night' && me.nightRole === 'murderer') || votable);
    const selected = s.phase === 'investigation' && me.myVote === p.id;
    const marks = [];
    if (p.isHost) marks.push('<span class="mark host" title="หัวห้อง">👑</span>');
    if (!p.connected && !p.isBot) marks.push('<span class="mark off" title="ออฟไลน์">⚡</span>');
    if (s.phase === 'day' && p.alive) marks.push(`<span class="mark ${p.sleepConfirmed ? 'ok' : ''}" title="เข้านอน">${p.sleepConfirmed ? '💤' : '…'}</span>`);
    if (s.phase === 'investigation' && p.alive) marks.push(`<span class="mark ${p.voteConfirmed ? 'ok' : ''}" title="โหวต">${p.voteConfirmed ? '🗳️' : '…'}</span>`);
    if (!p.alive) marks.push(`<span class="mark" title="${FATE_LABEL[p.fate] || 'เสียชีวิต'}">${FATE_ICON[p.fate] || '✝'}</span>`);
    const ultHtml = c
      ? c.ultimate === '???'
        ? '<div class="ult unknown" title="Ultimate ถูกซ่อน">???</div>'
        : `<div class="ult">${esc(c.ultimate)}</div>${
            c.fakeRoleExposed
              ? `<div><span class="badge purple" title="Ultimate ที่ประกาศไว้เป็นของปลอม">โรลปลอม · ประกาศว่า ${esc(c.fakeUltimate || '?')}</span></div>`
              : isMe && c.fakeUltimate
                ? `<div><span class="badge purple" title="คนอื่นเห็น Ultimate ของคุณเป็นชื่อนี้">คนอื่นเห็น: ${esc(c.fakeUltimate)}</span></div>`
                : ''
          }`
      : '<div class="ult muted">กำลังสุ่ม...</div>';
    return `<div class="pcard ${p.alive ? '' : 'dead'} ${isMe ? 'me' : ''} ${clickable ? 'clickable' : ''} ${selected ? 'selected' : ''}"
        ${clickable ? `data-action="pick" data-id="${esc(p.id)}"` : ''} title="${c ? esc(`${c.appearance} — ${c.personality}`) : ''}">
      <div class="marks">${marks.join('')}</div>
      <div class="pname">${esc(p.name)}${p.isBot ? ' <span class="badge">บอท</span>' : ''}${isMe ? ' <span class="badge cyan">คุณ</span>' : ''}</div>
      ${c ? `<div class="cname">${esc(c.name)} (${esc(c.nickname)})</div>` : ''}
      ${ultHtml}
      ${!p.alive && p.fate ? `<div class="muted" style="font-size:.8rem">${FATE_LABEL[p.fate]} · วันที่ ${p.eliminatedRound}</div>` : ''}
      ${p.alive && p.revived ? '<div><span class="badge yellow">คืนชีพ</span></div>' : ''}
      ${s.runoff && p.alive && s.runoff.candidates.includes(p.id) ? '<div><span class="badge red">รอบตัดสิน</span></div>' : ''}
    </div>`;
  }

  function renderMain(s) {
    if (!$('#main')) return;
    let html = '';
    switch (s.phase) {
      case 'generating':
      case 'incident':
        html = loadingHtml(s.generating || 'กำลังโหลด...');
        break;
      case 'day':
        html = eventHtml(s) + locationHtml(s) + dayHintHtml(s);
        break;
      case 'night':
        html = nightHtml(s);
        break;
      case 'investigation':
        html = incidentHtml(s) + cluesHtml(s) + locationHtml(s, true);
        break;
      case 'trial_result':
        html = resultHtml(s) + incidentHtml(s) + locationHtml(s, true);
        break;
      default:
        html = '';
    }
    setHtml('#main', html);
    if (s.phase === 'night') updateCountdown();
  }

  const loadingHtml = (label) => `<div class="card loading"><div class="spinner"></div><h2>${esc(label)}</h2><p class="muted">AI กำลังเขียนเรื่องราว อาจใช้เวลาสักครู่...</p></div>`;

  function locationHtml(s, collapsible = false) {
    const loc = s.location;
    if (!loc) return '';
    const sus = new Map((s.incident?.publicReport?.suspiciousItems || []).map((x) => [x.itemId, x.observation]));
    const open = !collapsible || ui.itemsOpen;
    return `<div class="card location">
      <div class="row"><h2>📍 ${esc(loc.name)}</h2><span class="spacer"></span>
        ${collapsible ? `<button class="small ghost" data-action="toggle-items">${open ? 'ซ่อนอุปกรณ์' : 'แสดงอุปกรณ์'} (${loc.items.length})</button>` : ''}</div>
      <p>${esc(loc.description)}</p>
      ${open ? `<div class="items">${loc.items
        .map(
          (it) => `<div class="item ${sus.has(it.id) ? 'suspicious' : ''}">
            <div class="iname">${sus.has(it.id) ? '⚠ ' : ''}${esc(it.name)}</div>
            <div class="iwhere">${esc(it.where)}</div>
            <div class="idesc">${esc(it.description)}</div>
            ${sus.has(it.id) ? `<div class="iobs">${esc(sus.get(it.id))}</div>` : ''}
          </div>`,
        )
        .join('')}</div>` : ''}
    </div>`;
  }

  function eventHtml(s) {
    const ev = s.specialEvent;
    if (!ev) return '';
    const mine = ev.playerId === s.me.id;
    return `<div class="card event">
      <h2>✨ อีเวนต์พิเศษ — ${esc(ev.title)}</h2>
      <p><b>${esc(ev.characterName)} (${esc(ev.playerName)})</b> กลับมามีชีวิตอีกครั้ง!</p>
      <p>${esc(ev.story)}</p>
      ${mine && s.me.eventPrivateNote ? `<div class="clue insight"><span class="ctag">สิ่งที่คุณจำได้ (คนอื่นมองไม่เห็น)</span>${esc(s.me.eventPrivateNote)}</div>` : ''}
    </div>`;
  }

  function dayHintHtml(s) {
    const alive = s.players.filter((p) => p.alive);
    const done = alive.filter((p) => p.sleepConfirmed).length;
    return `<div class="card"><h3>กลางวัน</h3>
      <p>สำรวจสถานที่ พูดคุย วางแผน หรือหาพันธมิตร เมื่อทุกคนกด <b>เข้านอน</b> คืนจะมาถึง... และบางคนจะไม่ได้ตื่นมาอีก</p>
      <p class="muted">เข้านอนแล้ว ${done}/${alive.length} คน</p></div>`;
  }

  function nightHtml(s) {
    const me = s.me;
    if (!me.alive) return `<div class="card night"><h2 class="pulse">คืนที่เงียบงัน</h2><p class="muted">คุณเฝ้ามองจากอีกฟากของความมืด...</p></div>`;
    if (me.nightRole === 'murderer') {
      const targets = s.players.filter((p) => p.alive && p.id !== me.id);
      return `<div class="card night murderer">
        <h2>คืนนี้... คุณคือฆาตกร</h2>
        <p>ระบบเลือกคุณให้เป็นฆาตกรของคืนนี้ มีเพียงคุณเท่านั้นที่รู้ เลือกเป้าหมาย 1 คน แล้วเหตุการณ์จะเริ่มต้นขึ้น</p>
        <p class="muted">คำเตือน: เหตุการณ์จริงอาจไม่เป็นไปตามแผน เป้าหมายอาจรอด คนอื่นอาจตายแทน หรือตัวคุณเองอาจเป็นฝ่ายเพลี่ยงพล้ำ</p>
        <p class="muted">เวลาที่เหลือ: <b id="night-countdown">--</b> (หมดเวลาระบบจะสุ่มให้)</p>
        <div class="targets">${targets
          .map((p) => `<button data-action="pick" data-id="${esc(p.id)}"><b>${esc(p.character?.name || p.name)}</b><span class="muted">${esc(p.name)} · ${esc(p.character?.ultimate || '')}</span></button>`)
          .join('')}</div>
      </div>`;
    }
    return `<div class="card night">
      <h2 class="pulse">ราตรีสวัสดิ์...</h2>
      <p>คุณหลับสนิท ระหว่างนั้นมีบางอย่างกำลังเกิดขึ้นในความมืด</p>
      <p class="muted">คืนจะผ่านไปภายใน <b id="night-countdown">--</b></p>
    </div>`;
  }

  function updateCountdown() {
    const el = $('#night-countdown');
    if (!el || !state?.me?.nightDeadline) return;
    const left = Math.max(0, Math.round((state.me.nightDeadline - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function incidentHtml(s) {
    const inc = s.incident;
    if (!inc) return '';
    const r = inc.publicReport;
    return `<div class="card incident">
      <h2>☠ พบศพ! — ${esc(inc.title)}</h2>
      <p><b>ผู้เสียชีวิต:</b> ${esc(inc.victim.characterName)} (${esc(inc.victim.playerName)})</p>
      <dl class="report">
        <dt>การค้นพบ</dt><dd>${esc(r.discovery)}</dd>
        <dt>สภาพศพ (ที่ทุกคนเห็นได้)</dt><dd>${esc(r.bodyState)}</dd>
        <dt>อุปกรณ์ต้องสงสัย</dt><dd><ul style="margin:0;padding-left:1.2em">${r.suspiciousItems
          .map((x) => `<li><b>${esc(x.itemName)}</b> — ${esc(x.observation)}</li>`)
          .join('') || '<li class="muted">ไม่พบ</li>'}</ul></dd>
        <dt>ความผิดปกติอื่นในที่เกิดเหตุ</dt><dd>${esc(r.sceneNotes)}</dd>
      </dl>
      <p class="muted" style="font-size:.85rem">ไม่มีใครรู้ทุกอย่าง: แต่ละคนรู้แค่สิ่งที่ตัวเองทำและเห็นคืนนี้ (ดูในการ์ดเบาะแสส่วนตัว) เอามาเล่าในแชทเพื่อต่อภาพให้ครบ</p>
    </div>`;
  }

  // ตำแหน่งจริงของทุกคน (แสดงเฉพาะตอนเฉลย)
  function whereaboutsHtml(rows) {
    if (!rows?.length) return '';
    return `<div class="whereabouts">
      <h3>🗺 ตำแหน่งจริงของทุกคนคืนนั้น</h3>
      <ul>${rows
        .map((w) => `<li><b>${esc(w.characterName)}</b> <span class="muted">(${esc(w.playerName || '-')})</span><br><span class="truth">${esc(w.truth || '-')}</span></li>`)
        .join('')}</ul>
    </div>`;
  }

  // เหตุการณ์ย่อยทั้งหมดและใครรู้บ้าง (แสดงเฉพาะตอนเฉลย)
  function observationsHtml(list) {
    if (!list?.length) return '';
    return `<div class="whereabouts">
      <h3>👁 เหตุการณ์ที่แต่ละคนรู้</h3>
      <ul>${list
        .map((o) => `<li>${esc(o.text)}<br><span class="muted">รู้โดย: ${esc((o.knownBy || []).join(', ') || '-')}</span></li>`)
        .join('')}</ul>
    </div>`;
  }

  // วิธีการก่อเหตุ (แสดงให้คนร้ายตอนสืบสวน และให้ทุกคนตอนเฉลย)
  function methodHtml(m) {
    if (!m) return '';
    return `<dl class="report method">
      <dt>วิธีฆ่า</dt><dd>${esc(m.cause)}</dd>
      <dt>การปกปิด</dt><dd>${esc(m.concealment || 'ไม่ได้ปกปิด')}${m.concealmentTrace ? `<br><span class="muted">ร่องรอยที่ทิ้งไว้: ${esc(m.concealmentTrace)}</span>` : ''}</dd>
      <dt>Ultimate</dt><dd>${m.usedUltimate ? esc(m.ultimateUse) : '<span class="muted">ไม่ได้ใช้ Ultimate — ใช้วิธีธรรมดาทั้งหมด</span>'}</dd>
    </dl>`;
  }

  function cluesHtml(s) {
    const me = s.me;
    const cl = me.clues;
    if (!cl) {
      return me.alive ? '' : `<div class="card clues"><h3>คุณเสียชีวิตไปแล้ว</h3><p class="muted">ดูการสืบสวนได้ แต่พูดหรือโหวตไม่ได้</p></div>`;
    }
    const parts = [];
    if (cl.role === 'victim') {
      parts.push(`<div class="clue culprit"><span class="ctag">คุณคือเหยื่อของคืนนี้</span>คุณไม่ได้ตื่นขึ้นมาอีก... ตอนนี้ทำได้เพียงเฝ้าดูว่าเพื่อน ๆ จะหาคนร้ายเจอหรือไม่</div>`);
    } else {
      if (cl.role === 'culprit') {
        parts.push(`<div class="clue culprit"><span class="ctag">🔪 คุณคือคนร้ายตัวจริง — ห้ามให้ใครรู้!</span>${esc(cl.story)}${methodHtml(cl.method)}${
          cl.myPublicInfo ? `<p><b>สิ่งที่ทุกคนรู้เกี่ยวกับคุณ:</b> ${esc(cl.myPublicInfo)} <span class="muted">— เตรียมคำอธิบายไว้</span></p>` : ''
        }</div>`);
      }
      if (cl.murdererNote) parts.push(`<div class="clue"><span class="ctag">บทบาทของคุณคืนนี้</span>${esc(cl.murdererNote)}</div>`);
      if (cl.myNight) parts.push(`<div class="clue night-self"><span class="ctag">🌙 สิ่งที่คุณทำคืนนี้ (มีแค่คุณที่รู้)</span>${esc(cl.myNight)}</div>`);
      if (cl.observations?.length) {
        parts.push(`<div class="clue"><span class="ctag">🤝 เหตุการณ์ที่คุณเห็นหรืออยู่ด้วย (รู้เฉพาะคนในเหตุการณ์)</span><ul class="obs">${cl.observations
          .map((t) => `<li>${esc(t)}</li>`)
          .join('')}</ul></div>`);
      }
      if (cl.clue) parts.push(`<div class="clue"><span class="ctag">👁 สิ่งที่คุณรับรู้คนเดียว</span>${esc(cl.clue)}</div>`);
      if (cl.insight) parts.push(`<div class="clue insight"><span class="ctag">✨ สัญชาตญาณจาก Ultimate ของคุณ</span>${esc(cl.insight)}</div>`);
      if (!parts.length) parts.push(`<div class="clue"><span class="ctag">คุณหลับสนิท</span>คุณไม่ได้ยินหรือเห็นอะไรเลยทั้งคืน ต้องอาศัยหลักฐานในที่เกิดเหตุและคำให้การของคนอื่น</div>`);
    }
    return `<div class="card clues"><h3>เบาะแสส่วนตัวของคุณ (คนอื่นมองไม่เห็น)</h3>${parts.join('')}</div>`;
  }

  function resultHtml(s) {
    const r = s.lastResult;
    if (!r) return '';
    const culprit = playerById(r.culpritId);
    const maxVotes = Math.max(1, ...r.tally.map((t) => t.count));
    return `<div class="card result ${r.correct ? 'correct' : 'wrong'}">
      <div class="verdict">${r.correct ? '✔ โหวตถูกต้อง!' : '✘ โหวตผิด!'}</div>
      <p>เสียงส่วนใหญ่โหวต: <b>${r.votedId ? esc(displayName(r.votedId)) : 'ไม่มีใครโหวต'}</b>${r.randomTiebreak ? ' <span class="badge yellow">ยังเสมอหลังรอบตัดสิน จึงสุ่มตัดสิน</span>' : ''}</p>
      <p>คนร้ายตัวจริงคือ <b>${esc(displayName(r.culpritId))}</b> — Ultimate จริง: <b>${esc(culprit?.character?.ultimate || '???')}</b>${
        r.culpritFakeRole ? ` <span class="badge purple">โรลปลอม! ประกาศไว้ว่า ${esc(r.culpritFakeUltimate || '?')}</span>` : ''
      }</p>
      <p>${r.correct ? '⛓ คนร้ายถูกประหาร' : '🏃 คนร้ายหลบหนีไปได้ และออกจากเกมในฐานะผู้รอด'}${r.accusedExecuted ? ` · ⚖ <b>${esc(displayName(r.accusedId))}</b> ถูกประหารทั้งที่บริสุทธิ์` : ''}</p>
      ${r.runoffs ? `<p class="muted">มีการโหวตรอบตัดสิน ${r.runoffs} ครั้ง</p>` : ''}
      <h3>ผลโหวต</h3>
      <div class="tally">${r.tally
        .map(
          (t) => `<div class="bar ${t.targetId === r.culpritId ? 'culprit' : ''}"><span>${esc(displayName(t.targetId))}</span><div class="fill"><i style="width:${(t.count / maxVotes) * 100}%"></i></div><span>${t.count}</span></div>`,
        )
        .join('') || '<p class="muted">ไม่มีคะแนนโหวต</p>'}</div>
      <h3>ความจริงของคดี</h3>
      <p>${esc(r.truthSummary)}</p>
      ${methodHtml(r.method)}
      ${r.deductionChain?.length ? `<details open><summary>เส้นทางการไขคดี (ควรสรุปได้จากข้อมูลที่แจก)</summary><ol class="deduction">${r.deductionChain.map((d) => `<li>${esc(d)}</li>`).join('')}</ol></details>` : ''}
      <details><summary>เรื่องราวทั้งหมดจากมุมมองคนร้าย</summary><p>${esc(r.culpritStory)}</p></details>
      <details><summary>ตำแหน่งจริงของทุกคน และใครรู้อะไรบ้าง</summary>${whereaboutsHtml(r.whereabouts)}${observationsHtml(r.observations)}</details>
      <p class="muted">ฆาตกรที่ระบบสุ่มคืนนี้: ${esc(displayName(r.murdererId))} · เป้าหมายที่เลือก: ${esc(displayName(r.targetId))}</p>
    </div>`;
  }

  // ---------- side ----------
  function renderSide(s) {
    setHtml('#side', myCardHtml(s) + actionsHtml(s) + noticesHtml(s) + historyHtml(s));
  }

  function myCardHtml(s) {
    const me = playerById(s.me.id);
    const c = me?.character;
    if (!c) return `<div class="card mycard"><h3>ตัวละครของคุณ</h3><p class="muted">กำลังสุ่มตัวละครและ Ultimate...</p></div>`;
    const unknown = c.ultimate === '???';
    return `<div class="card mycard">
      <h3>ตัวละครของคุณ</h3>
      <div class="big">${esc(c.name)} <span class="muted" style="font-weight:300">(${esc(c.nickname)})</span></div>
      <div class="muted">${esc(c.gender)} · อายุ ${c.age}</div>
      <p><b>รูปลักษณ์:</b> ${esc(c.appearance)}</p>
      <p><b>นิสัย:</b> ${esc(c.personality)}</p>
      <hr style="border-color:var(--line);border-style:solid none none">
      <div class="ult ${unknown ? 'unknown' : ''}">${unknown ? '??? (ยังไม่รู้)' : esc(c.ultimate)}</div>
      ${unknown
        ? `<p class="muted">Ultimate ของคุณถูกซ่อนจากทุกคน รวมถึงตัวคุณเอง — อาจตระหนักได้เมื่อเกิดคดี</p>`
        : `<p>${esc(c.ultimateDescription || '')}</p>
           ${s.me.fakeRole
             ? `<span class="badge purple">โรลปลอม</span>
                <p class="muted" style="font-size:.85rem">คนอื่นเห็น Ultimate ของคุณเป็น <b>${esc(s.me.fakeUltimate?.title || '?')}</b> (${esc(s.me.fakeUltimate?.description || '')}) — มีแค่คุณที่รู้ว่าของจริงคืออะไร จะเล่นตามบทปลอมหรือเปิดเผยก็ได้</p>`
             : s.me.ultimateIsHidden
               ? `<span class="badge purple">ซ่อนจากคนอื่น (เห็นเป็น ???)</span>`
               : `<span class="badge">ทุกคนเห็น</span>`}
           ${s.me.ultimateEffect ? `<p class="muted" style="font-size:.85rem">ผลต่อคดี: ${esc(s.me.ultimateEffect)}</p>` : ''}`}
      ${!me.alive ? `<p><span class="badge red">${FATE_LABEL[me.fate] || 'เสียชีวิต'}</span></p>` : ''}
    </div>`;
  }

  function actionsHtml(s) {
    const me = s.me;
    const alive = s.players.filter((p) => p.alive);
    let body = '';
    switch (s.phase) {
      case 'day': {
        const done = alive.filter((p) => p.sleepConfirmed).length;
        if (me.alive) {
          body += me.sleepConfirmed
            ? `<p class="status">คุณเข้านอนแล้ว รอคนอื่น (${done}/${alive.length})</p><button data-action="cancel-sleep">ยังไม่นอน</button>`
            : `<button class="primary" data-action="sleep">💤 เข้านอน</button><p class="status">เข้านอนแล้ว ${done}/${alive.length}</p>`;
        } else body += `<p class="status">รอทุกคนเข้านอน (${done}/${alive.length})</p>`;
        if (me.isHost) body += `<hr style="border-color:var(--line);border-style:solid none none"><button class="small danger" data-action="force-sleep">บังคับเข้านอนทุกคน</button>`;
        break;
      }
      case 'night':
        body += me.nightRole === 'murderer' ? `<p class="status">เลือกเป้าหมายจากรายชื่อตรงกลาง หรือคลิกการ์ดผู้เล่น</p>` : `<p class="status">คืนกำลังผ่านไป...</p>`;
        break;
      case 'investigation': {
        const done = alive.filter((p) => p.voteConfirmed).length;
        if (me.alive) {
          if (me.voteConfirmed) {
            body += `<p class="status">คุณยืนยันโหวต <b>${esc(displayName(me.myVote))}</b> แล้ว รอคนอื่น (${done}/${alive.length})</p>`;
          } else {
            const cands = alive.filter((p) => p.id !== me.id && (!s.runoff || s.runoff.candidates.includes(p.id)));
            body += `${s.runoff ? `<p><span class="badge red">รอบตัดสินครั้งที่ ${s.runoff.number}</span> คะแนนเสมอ โหวตได้เฉพาะคนที่เสมอกัน</p>` : '<p>โหวตผู้ต้องสงสัย:</p>'}<div class="votelist">${cands
              .map((p) => `<button data-action="vote" data-id="${esc(p.id)}" class="${me.myVote === p.id ? 'selected' : ''}">${esc(p.character?.name || p.name)} <span class="muted">(${esc(p.name)})</span></button>`)
              .join('')}</div>
              <button class="primary" data-action="confirm-vote" ${me.myVote ? '' : 'disabled'}>ยืนยันโหวต</button>
              <p class="status">ยืนยันแล้ว ${done}/${alive.length}</p>`;
          }
        } else body += `<p class="status">รอทุกคนโหวต (${done}/${alive.length})</p>`;
        if (me.isHost) body += `<hr style="border-color:var(--line);border-style:solid none none"><button class="small danger" data-action="force-vote">ปิดโหวตตอนนี้</button>`;
        break;
      }
      case 'trial_result':
        body += me.isHost
          ? `<button class="primary" data-action="next-round">${alive.length <= 1 ? '🏁 ไปต่อ / สรุปผล' : '☀ ไปวันถัดไป'}</button>${alive.length <= 1 ? '<p class="status">เหลือผู้เล่นไม่ถึง 2 คน เกมจะสรุปผล (เว้นแต่จะมีอีเวนต์พิเศษ)</p>' : ''}`
          : `<p class="status">รอหัวห้องไปต่อ...</p>`;
        break;
      default:
        body += `<p class="status">กรุณารอสักครู่...</p>`;
    }
    return `<div class="card actions"><h3>การกระทำ</h3>${body}<p style="margin-top:.8rem"><button class="small ghost" data-action="leave">ออกจากห้อง</button></p></div>`;
  }

  function noticesHtml(s) {
    const list = s.me.notices || [];
    if (!list.length) return '';
    return list
      .map((n) => `<div class="notice ${esc(n.kind)}"><span>${esc(n.text)}</span><span class="spacer"></span><button class="small ghost" data-action="dismiss-notice" data-id="${esc(n.id)}">✕</button></div>`)
      .join('');
  }

  function historyHtml(s) {
    if (!s.history?.length) return '';
    return `<div class="card history"><h3>คดีที่ผ่านมา</h3><ol>${s.history
      .map(
        (h) => `<li><b>วันที่ ${h.round}</b> ${esc(h.title)} <span class="muted">@${esc(h.locationName)}</span><br>เหยื่อ: ${esc(h.victimName)} · คนร้าย: ${esc(h.culpritName)} <span class="${h.correct ? 'ok' : 'bad'}">${h.correct ? '(จับได้)' : '(หนีรอด)'}</span></li>`,
      )
      .join('')}</ol></div>`;
  }

  // ---------- chat ----------
  function canChat(s) {
    if (['lobby', 'ended'].includes(s.phase)) return true;
    if (['day', 'investigation', 'trial_result'].includes(s.phase)) return s.me.alive;
    return false;
  }

  function renderChat() {
    const s = state;
    const log = $('#chat-log');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60 || !log.dataset.filled;
    const html = s.chat
      .map((m) =>
        m.system
          ? `<div class="msg system">${esc(m.text)}</div>`
          : `<div class="msg ${m.playerId === s.me.id ? 'me' : ''}"><span class="who">${esc(m.name)}</span>${m.characterName ? `<span class="char">${esc(m.characterName)}</span>` : ''}<span>${esc(m.text)}</span></div>`,
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
      input.placeholder = ok ? 'พิมพ์ข้อความ...' : s.me.alive ? 'ยังคุยไม่ได้ในช่วงนี้' : 'ผู้เสียชีวิตพูดไม่ได้';
    }
  }

  // ---------- end ----------
  function renderEnd() {
    const s = state;
    mount(
      'end',
      `<div class="screen end">
        <div class="hero"><h1>GAME OVER<span>สรุปผล: ใครรอด ใครไม่รอด</span></h1></div>
        <div class="card" id="end-rank"></div>
        <div id="end-truth"></div>
        <div class="card" id="end-controls"></div>
        <div class="card chat"><h3>แชท</h3><div id="chat-log" class="chat-log"></div>${chatFormHtml()}</div>
      </div>`,
    );
    const row = (r) => `<li class="${r.playerId === s.me.id ? 'me' : ''}">
        <span class="oicon">${FATE_ICON[r.fate] || ''}</span>
        <span><b>${esc(r.name)}</b>${r.isBot ? ' <span class="badge">บอท</span>' : ''}${r.playerId === s.me.id ? ' <span class="badge cyan">คุณ</span>' : ''}<br><span class="muted">${esc(r.characterName || '-')} · ${esc(r.ultimate || '-')}${r.fakeRole ? ` <span class="badge purple">โรลปลอม: ${esc(r.fakeUltimate || '?')}</span>` : ''}</span></span>
        <span style="text-align:right"><span class="badge ${FATE_CLASS[r.fate] || ''}">${FATE_LABEL[r.fate] || '-'}</span>${r.eliminatedRound ? `<br><span class="muted">วันที่ ${r.eliminatedRound}</span>` : ''}${r.revived ? '<br><span class="badge yellow">เคยคืนชีพ</span>' : ''}</span>
      </li>`;
    const o = s.outcome || { survived: [], died: [] };
    $('#end-rank').innerHTML = `<div class="outcome">
      <div><h3 style="color:var(--green)">รอดชีวิต (${o.survived.length})</h3><ul>${o.survived.map(row).join('') || '<li class="muted">ไม่มีใครรอด</li>'}</ul></div>
      <div><h3 style="color:var(--red)">ไม่รอด (${o.died.length})</h3><ul>${o.died.map(row).join('') || '<li class="muted">ไม่มีใครตาย</li>'}</ul></div>
    </div>
    <p class="muted" style="margin-top:.6rem">รอดชีวิต = คนที่อยู่จนจบเกม และคนร้ายที่หนีรอดจากการโหวต · ไม่รอด = เหยื่อ คนร้ายที่ถูกจับ${s.config?.executeWrongVote ? ' และผู้บริสุทธิ์ที่ถูกโหวตผิด' : ''}</p>`;
    // ถ้าเกมจบจากคดีคืนสุดท้ายที่ไม่มีการโหวต (เหลือคนเดียว) ให้แสดงคดีนั้นด้วย ไม่ใช่แค่ผลตัดสินวันก่อน
    const finalIncidentUnjudged = s.incident && (!s.lastResult || s.incident.round > s.lastResult.round);
    $('#end-truth').innerHTML = (finalIncidentUnjudged ? incidentHtml(s) : '') + (s.lastResult ? resultHtml(s) : '');
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

  // กล่องยืนยันในหน้าเว็บ (แทน window.confirm ที่บล็อกหน้าและดูไม่เข้ากับธีม)
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
      case 'sleep':
        await act('day:confirmSleep');
        break;
      case 'cancel-sleep':
        await act('day:cancelSleep');
        break;
      case 'force-sleep':
        if (await confirmDialog('บังคับให้ทุกคนเข้านอนเลย?')) await act('host:forceSleep');
        break;
      case 'pick':
        await onPick(id);
        break;
      case 'vote':
        await act('vote:cast', { targetId: id });
        break;
      case 'confirm-vote':
        if (state.me.myVote && await confirmDialog(`ยืนยันโหวต ${displayName(state.me.myVote)} เป็นคนร้าย?`)) await act('vote:confirm');
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
      case 'dismiss-notice':
        await act('notice:dismiss', { id });
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'toggle-items':
        ui.itemsOpen = !ui.itemsOpen;
        renderMain(state);
        break;
      default:
        break;
    }
  });

  async function onPick(id) {
    if (!state) return;
    if (state.phase === 'night' && state.me.nightRole === 'murderer') {
      if (await confirmDialog(`เลือก ${displayName(id)} เป็นเป้าหมาย? เลือกแล้วเปลี่ยนไม่ได้`)) await act('night:chooseTarget', { targetId: id });
    } else if (state.phase === 'investigation') {
      await act('vote:cast', { targetId: id });
    }
  }

  document.addEventListener('change', (e) => {
    if (e.target.id === 'bot-count') act('lobby:setBots', { count: Number(e.target.value) });
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
        ui.seenIncidentRound = 0;
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
  // เปิดจากลิงก์เชิญ (?room=XXXX): กรอกรหัสให้ และถ้าเคยตั้งชื่อไว้แล้วให้เข้าห้องนั้นทันที
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
