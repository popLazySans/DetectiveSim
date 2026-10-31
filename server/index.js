// HTTP + Socket.IO server
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { Game, GameError } from './game.js';
import { createAI } from './ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const ai = createAI();
const rooms = new Map();

// รูปตัวละคร (ถ้ามี): วางไฟล์ public/portraits/<characterId>.png|jpg|webp เช่น c01.png
const PORTRAITS = new Map();
try {
  for (const f of fs.readdirSync(path.join(here, '..', 'public', 'portraits'))) {
    const m = /^(c\d{2})\.(png|jpe?g|webp)$/i.exec(f);
    if (m && !PORTRAITS.has(m[1])) PORTRAITS.set(m[1], `/portraits/${f}`);
  }
} catch {}

const app = express();
app.use(express.static(path.join(here, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, aiMode: ai.mode, model: ai.model, lastAiError: ai.lastError, portraits: PORTRAITS.size }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return rooms.has(s) ? genCode() : s;
}

function broadcast(game) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.code !== game.code || !s.data.playerId) continue;
    s.emit('state', game.viewFor(s.data.playerId));
  }
}

function otherSocketsFor(code, playerId, except) {
  for (const s of io.sockets.sockets.values()) {
    if (s !== except && s.data.code === code && s.data.playerId === playerId) return true;
  }
  return false;
}

function joinRoom(socket, game, playerId, name) {
  const id = typeof playerId === 'string' && /^[\w-]{8,64}$/.test(playerId) ? playerId : randomUUID();
  if (socket.data.code && socket.data.code !== game.code) {
    const old = rooms.get(socket.data.code);
    socket.leave(socket.data.code);
    if (old && !otherSocketsFor(old.code, socket.data.playerId, socket)) old.setConnected(socket.data.playerId, false);
  }
  // ผูก socket กับห้องก่อน addPlayer เพื่อให้ broadcast แรกส่งถึง socket นี้ด้วย
  const prev = { code: socket.data.code, playerId: socket.data.playerId };
  socket.data.code = game.code;
  socket.data.playerId = id;
  try {
    game.addPlayer({ id, name });
  } catch (err) {
    socket.data.code = prev.code;
    socket.data.playerId = prev.playerId;
    throw err;
  }
  socket.join(game.code);
  socket.emit('state', game.viewFor(id));
  return { code: game.code, playerId: id };
}

io.on('connection', (socket) => {
  const game = () => {
    const g = rooms.get(socket.data.code);
    if (!g) throw new GameError('คุณยังไม่ได้อยู่ในห้อง');
    return g;
  };
  const me = () => socket.data.playerId;

  const handle = (fn) => async (payload, ack) => {
    try {
      const result = await fn(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
    } catch (err) {
      const message = err instanceof GameError ? err.message : 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์';
      if (!(err instanceof GameError)) console.error('[socket] unexpected error', err);
      socket.emit('error:msg', { message });
      if (typeof ack === 'function') ack({ ok: false, error: message });
    }
  };

  socket.on('room:create', handle(({ name, playerId }) => {
    const code = genCode();
    const g = new Game({ code, ai, onChange: broadcast, portraits: PORTRAITS });
    rooms.set(code, g);
    console.log(`[room ${code}] created by ${name}`);
    return joinRoom(socket, g, playerId, name);
  }));

  socket.on('room:join', handle(({ code, name, playerId }) => {
    const g = rooms.get(String(code || '').trim().toUpperCase());
    if (!g) throw new GameError('ไม่พบห้องนี้ ตรวจสอบรหัสอีกครั้ง');
    return joinRoom(socket, g, playerId, name);
  }));

  socket.on('state:request', handle(() => {
    socket.emit('state', game().viewFor(me()));
  }));

  socket.on('lobby:setBots', handle(({ count }) => game().setBots(me(), count)));
  socket.on('game:start', handle(async () => { await game().start(me()); }));
  socket.on('chat:send', handle(({ text }) => game().sendChat(me(), text)));
  // วงจรวัน: เลือกห้อง → เลือกแอ็กชัน → อ่านบันทึก/พร้อมไปต่อ
  socket.on('day:move', handle(({ zoneId }) => game().chooseMove(me(), String(zoneId || ''))));
  socket.on('day:act', handle(({ type, itemId, itemId2, targetId, victimId, toZoneId, recipeId, exitId }) => game().chooseAction(me(), { type, itemId, itemId2, targetId, victimId, toZoneId, recipeId, exitId })));
  socket.on('day:ready', handle(() => game().markReady(me())));
  socket.on('day:give', handle(({ targetId, itemId }) => game().giveItem(me(), String(targetId || ''), String(itemId || ''))));
  socket.on('host:forceStep', handle(() => game().forceStep(me())));
  // การตัดสิน
  socket.on('vote:cast', handle(({ targetId }) => game().castVote(me(), String(targetId || ''))));
  socket.on('vote:confirm', handle(() => game().confirmVote(me())));
  socket.on('host:forceVote', handle(() => game().forceVote(me())));
  socket.on('host:nextRound', handle(async () => { await game().nextRound(me()); }));
  socket.on('host:restart', handle(() => game().restart(me())));
  socket.on('notice:dismiss', handle(({ id }) => game().dismissNotice(me(), id)));

  socket.on('disconnect', () => {
    const g = rooms.get(socket.data.code);
    if (!g || !socket.data.playerId) return;
    if (!otherSocketsFor(g.code, socket.data.playerId, socket)) g.setConnected(socket.data.playerId, false);
  });
});

// ลบห้องที่ไม่มีคนใช้งานนาน
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of rooms) {
    const anyConnected = g.humans().some((p) => p.connected);
    if (!anyConnected && now - g.lastActivity > ROOM_TTL_MS) {
      g.clearTimers();
      rooms.delete(code);
      console.log(`[room ${code}] removed (idle)`);
    }
  }
}, 5 * 60 * 1000).unref();

// ที่อยู่ในวง LAN สำหรับให้เพื่อนที่ใช้ Wi-Fi เดียวกันเข้าเล่น
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

ai.ready.then(() => {
  // ฟังทุก interface (0.0.0.0) เพื่อให้เครื่องอื่นในวง LAN หรือ tunnel เข้าถึงได้
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Danganronpa-web server running at http://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) console.log(`เพื่อนใน Wi-Fi เดียวกันเข้าได้ที่: ${lan.map((ip) => `http://${ip}:${PORT}`).join('  |  ')}`);
    console.log('เล่นผ่านอินเทอร์เน็ต: npm run share (ต้องติดตั้ง cloudflared) หรือดูหัวข้อ "เล่นกับเพื่อน" ใน README');
    console.log(`AI mode: ${ai.mode}${ai.mode === 'claude' ? ` (model ${ai.model})` : ' (ตั้ง ANTHROPIC_API_KEY ใน .env เพื่อใช้ Claude)'}`);
  });
});
