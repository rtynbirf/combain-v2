// test/smoke.js — COMBAIN v2 интеграционный набор (REST + WS, изолированная БД)
// Запуск: npm test  (спавнит сервер на случайном порту, tmp-каталог данных)
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'combain-test-'));
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'combain-up-'));
const JWT_SECRET = 'test-secret-' + crypto.randomBytes(16).toString('hex');

let server;
const results = [];
let passed = 0;
let failed = 0;

function ok(cond, name, extra) {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function eq(a, b, name) { ok(Object.is(a, b), name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

async function req(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const t = setTimeout(() => { ws.terminate(); reject(new Error('ws connect timeout')); }, 5000);
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_ok') { clearTimeout(t); resolve(ws); }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(t); reject(new Error('ws http ' + res.statusCode)); });
  });
}

function wsSend(ws, type, payload, requestId) {
  const env = { type };
  if (payload !== undefined) env.payload = payload;
  if (requestId) env.requestId = requestId;
  ws.send(JSON.stringify(env));
}

function waitFor(ws, type, { timeout = 5000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting "${type}"`));
    }, timeout);
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === type && (!filter || filter(m))) {
        clearTimeout(t); ws.off('message', onMsg); resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      UPLOAD_DIR,
      JWT_SECRET,
      RATE_LIMIT_MAX: '100000',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  // Ждём готовности
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(100);
    try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch {}
  }
  if (!up) { console.error('Server failed to start'); process.exit(1); }

  const ts = Date.now().toString(36);
  const [U1, U2, U3] = [`t1_${ts}`, `t2_${ts}`, `t3_${ts}`];
  const P1 = 'pass1';
  const P2 = 'pass2';
  const P3 = 'pass3';

  // ── Health ───────────────────────────────────────────────
  {
    const h = await req('GET', '/api/health');
    eq(h.status, 200, 'health: 200');
    ok(h.json && h.json.ok === true, 'health: ok=true');
    const r = await req('GET', '/api/ready');
    eq(r.status, 200, 'ready: 200');
    ok(r.json && r.json.db === 'up', 'ready: db up');
  }

  // ── Auth ─────────────────────────────────────────────────
  let T1, T2, T3, ID1, ID2, ID3;
  {
    const r1 = await req('POST', '/auth/register', { body: { username: U1, password: P1 } });
    eq(r1.status, 201, 'auth: register u1 201');
    T1 = r1.json.token; ID1 = r1.json.id;
    const rd = await req('POST', '/auth/register', { body: { username: U1, password: P1 } });
    eq(rd.status, 409, 'auth: duplicate username 409');
    const r2 = await req('POST', '/auth/register', { body: { username: U2, password: P2 } });
    T2 = r2.json.token; ID2 = r2.json.id;
    const r3 = await req('POST', '/auth/register', { body: { username: U3, password: P3 } });
    T3 = r3.json.token; ID3 = r3.json.id;
    const li = await req('POST', '/auth/login', { body: { username: U1, password: P1 } });
    eq(li.status, 200, 'auth: login 200');
    ok(!!li.json.token, 'auth: login returns token');
    const bad = await req('POST', '/auth/login', { body: { username: U1, password: 'wrong' } });
    eq(bad.status, 401, 'auth: wrong password 401');
    const me = await req('GET', '/auth/me', { token: T1 });
    eq(me.status, 200, 'auth: /me 200');
    eq(me.json.username, U1, 'auth: /me username');
    const noauth = await req('GET', '/rooms');
    eq(noauth.status, 401, 'auth: no token 401');
    // alg:none подделка
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = b64u({ alg: 'none', typ: 'JWT' }) + '.' + b64u({ sub: ID1, username: U1 }) + '.';
    const frg = await req('GET', '/rooms', { token: forged });
    eq(frg.status, 401, 'auth: alg=none forged token rejected');
  }

  // ── Rooms ────────────────────────────────────────────────
  let directId, groupId;
  {
    const d = await req('POST', '/rooms', { token: T1, body: { type: 'direct', participantIds: [ID2] } });
    eq(d.status, 201, 'rooms: direct created 201');
    directId = d.json.id;
    const d2 = await req('POST', '/rooms', { token: T2, body: { type: 'direct', participantIds: [ID1] } });
    eq(d2.json.id, directId, 'rooms: duplicate direct returns same room');
    const g = await req('POST', '/rooms', { token: T1, body: { type: 'group', name: 'CI Group', participantIds: [ID2] } });
    eq(g.status, 201, 'rooms: group created 201');
    groupId = g.json.id;
    eq(g.json.participants.length, 2, 'rooms: group has 2 members');
    const bad = await req('POST', '/rooms', { token: T1, body: { type: 'channel' } });
    eq(bad.status, 400, 'rooms: invalid type 400');
    const list = await req('GET', '/rooms', { token: T2 });
    const ids = list.json.map((r) => r.id);
    ok(ids.includes(directId) && ids.includes(groupId), 'rooms: list includes both rooms for u2');
    ok(list.json.every((r) => 'unreadCount' in r), 'rooms: list carries unreadCount field');
  }

  // ── Phase 1 регрессии: Class A WS-доставка + unread ───────
  {
    const wsA = await wsConnect(T1);
    const wsB = await wsConnect(T2);
    const subA = waitFor(wsA, 'subscribed');
    wsSend(wsA, 'subscribe', { roomId: directId });
    await subA;

    // B НЕ подписан на комнату — но сообщение должно дойти (Class A)
    const sent = waitFor(wsA, 'chat_message');
    wsSend(wsA, 'chat_message', { roomId: directId, text: 'class-a probe', clientMessageId: 'cm-class-a' }, 'req-class-a');
    const ackA = await sent;
    const msgId = ackA.payload.id;
    await waitFor(wsB, 'chat_message', { filter: (m) => m.payload && m.payload.id === msgId });

    // unreadCount в списке комнат у B = 1
    const list = await req('GET', '/rooms', { token: T2 });
    const room = list.json.find((r) => r.id === directId);
    eq(room && room.unreadCount, 1, 'phase1: unreadCount=1 after background message');

    // B читает → 0
    const read = await req('POST', '/messages/read', { token: T2, body: { roomId: directId, messageIds: [msgId] } });
    eq(read.status, 200, 'phase1: messages/read 200');
    const list2 = await req('GET', '/rooms', { token: T2 });
    eq(list2.json.find((r) => r.id === directId).unreadCount, 0, 'phase1: unreadCount=0 after read');

    wsA.close(); wsB.close();
    await sleep(150);
  }

  // ── Идемпотентность clientMessageId + unique index ───────
  {
    const wsA = await wsConnect(T1);
    const first = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-idem' });
    wsSend(wsA, 'chat_message', { roomId: directId, text: 'idem', clientMessageId: 'cm-idem' }, 'req-idem');
    const m1 = (await first).payload;
    const second = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-idem' });
    wsSend(wsA, 'chat_message', { roomId: directId, text: 'idem', clientMessageId: 'cm-idem' }, 'req-idem');
    const m2 = (await second).payload;
    eq(m2.id, m1.id, 'idempotency: same clientMessageId → same message id');
    // Проверяем unique-индекс прямой read-only выкладкой в ту же БД сервера
    const Database = require('better-sqlite3');
    const check = new Database(path.join(DATA_DIR, 'combain.db'), { readonly: true, fileMustExist: true });
    const row = check.prepare('SELECT COUNT(*) AS c FROM Message WHERE roomId=? AND clientMessageId=?').get(directId, 'cm-idem');
    check.close();
    eq(row.c, 1, 'idempotency: unique index keeps single row');
    wsA.close();
    await sleep(100);
  }

  // ── 405 на direct /participants (Phase 1) ─────────────────
  {
    const r = await req('POST', `/rooms/${directId}/participants`, { token: T1, body: { userId: ID3 } });
    eq(r.status, 405, 'phase1: POST participants on direct → 405');
    ok(r.json && r.json.error === 'DIRECT_ROOM_IMMUTABLE', 'phase1: 405 error code DIRECT_ROOM_IMMUTABLE');
  }

  // ── Pagination ───────────────────────────────────────────
  {
    const wsA = await wsConnect(T1);
    const subA = waitFor(wsA, 'subscribed');
    wsSend(wsA, 'subscribe', { roomId: groupId });
    await subA;
    for (let i = 1; i <= 5; i++) {
      const w = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-pg' + i });
      wsSend(wsA, 'chat_message', { roomId: groupId, text: 'pg' + i, clientMessageId: 'cm-pg' + i }, 'req-pg' + i);
      await w;
    }
    wsA.close();
    await sleep(100);
    const p1 = await req('GET', `/rooms/${groupId}/messages?limit=2`, { token: T2 });
    eq(p1.json.messages.length, 2, 'pagination: first page limit=2');
    ok(p1.json.nextCursor, 'pagination: nextCursor present');
    const p2 = await req('GET', `/rooms/${groupId}/messages?limit=2&cursor=${encodeURIComponent(p1.json.nextCursor)}`, { token: T2 });
    eq(p2.json.messages.length, 2, 'pagination: second page');
    ok(p2.json.messages[0].id !== p1.json.messages[0].id, 'pagination: pages disjoint');
    const badCur = await req('GET', `/rooms/${groupId}/messages?cursor=@@@`, { token: T2 });
    eq(badCur.status, 400, 'pagination: invalid cursor 400');
  }

  // ── Edit / Delete ────────────────────────────────────────
  {
    const wsA = await wsConnect(T1);
    const w = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-edit' });
    wsSend(wsA, 'chat_message', { roomId: groupId, text: 'original text', clientMessageId: 'cm-edit' }, 'req-edit');
    const editId = (await w).payload.id;
    wsA.close();
    await sleep(100);

    const wsB = await wsConnect(T2);
    // слушатель готовим ДО запроса — иначе событие придёт раньше, чем мы начнём ждать
    const edB = waitFor(wsB, 'message_edited', { filter: (m) => m.payload.id === editId });
    const ed = await req('PATCH', `/messages/${editId}/edit`, { token: T1, body: { text: 'edited text' } });
    eq(ed.status, 200, 'edit: 200');
    await edB;
    const edForeign = await req('PATCH', `/messages/${editId}/edit`, { token: T2, body: { text: 'hack' } });
    eq(edForeign.status, 403, 'edit: foreign author 403');
    const delB = waitFor(wsB, 'message_deleted', { filter: (m) => m.payload.id === editId });
    const del = await req('DELETE', `/messages/${editId}`, { token: T1 });
    eq(del.status, 200, 'delete: 200');
    await delB;
    const after = await req('GET', `/rooms/${groupId}/messages?limit=100`, { token: T2 });
    const deleted = after.json.messages.find((m) => m.id === editId);
    ok(deleted && deleted.deletedAt && deleted.text === null, 'delete: tombstone text null');
    wsB.close();
    await sleep(100);
  }

  // ── Reactions ────────────────────────────────────────────
  {
    const wsA = await wsConnect(T1);
    const w = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-react' });
    wsSend(wsA, 'chat_message', { roomId: groupId, text: 'react me', clientMessageId: 'cm-react' }, 'req-react');
    const reactId = (await w).payload.id;
    wsA.close();
    await sleep(100);

    const wsB = await wsConnect(T2);
    const rb = waitFor(wsB, 'message_reaction', { filter: (m) => m.payload.messageId === reactId && m.payload.added });
    const r1 = await req('POST', `/messages/${reactId}/react`, { token: T2, body: { emoji: '🔥' } });
    eq(r1.status, 200, 'reactions: add 200');
    await rb;
    eq(r1.json.reactions['🔥'] && r1.json.reactions['🔥'][0], ID2, 'reactions: map contains user');
    const r2 = await req('POST', `/messages/${reactId}/react`, { token: T2, body: { emoji: '🔥' } });
    eq(r2.json.added, false, 'reactions: toggle removes');
    wsB.close();
    await sleep(100);
  }

  // ── Pins / Search ────────────────────────────────────────
  {
    const wsA = await wsConnect(T1);
    const w = waitFor(wsA, 'chat_message', { filter: (m) => m.requestId === 'req-pin' });
    wsSend(wsA, 'chat_message', { roomId: groupId, text: 'pin me needle', clientMessageId: 'cm-pin' }, 'req-pin');
    const pinId = (await w).payload.id;
    wsA.close();
    await sleep(100);
    const pin = await req('POST', `/messages/${pinId}/pin?roomId=${groupId}`, { token: T1 });
    eq(pin.status, 200, 'pins: pin 200');
    const pins = await req('GET', `/messages/pinned/${groupId}`, { token: T1 });
    ok(pins.json.some((m) => m.id === pinId), 'pins: pinned list contains message');
    const unpin = await req('DELETE', `/messages/${pinId}/pin?roomId=${groupId}`, { token: T1 });
    eq(unpin.status, 200, 'pins: unpin 200');
    const sr = await req('GET', '/messages/search?q=needle', { token: T1 });
    ok(sr.json.some((m) => m.id === pinId), 'search: finds message');
  }

  // ── Participants / leave / rejoin ────────────────────────
  {
    const add = await req('POST', `/rooms/${groupId}/participants`, { token: T1, body: { userId: ID3 } });
    eq(add.status, 200, 'participants: add to group 200');
    const list3 = await req('GET', '/rooms', { token: T3 });
    ok(list3.json.some((r) => r.id === groupId), 'participants: u3 sees group');
    const role = await req('GET', `/rooms/${groupId}/participants`, { token: T1 });
    ok(role.json.some((p) => p.userId === ID3 && p.role === 'member'), 'participants: u3 member role');
    const leave = await req('POST', `/rooms/${groupId}/leave`, { token: T3 });
    eq(leave.status, 200, 'leave: 200');
    const list3b = await req('GET', '/rooms', { token: T3 });
    ok(!list3b.json.some((r) => r.id === groupId), 'leave: room gone from list');
    const rejoin = await req('POST', `/rooms/${groupId}/rejoin`, { token: T3 });
    eq(rejoin.status, 200, 'rejoin: 200');
    const list3c = await req('GET', '/rooms', { token: T3 });
    ok(list3c.json.some((r) => r.id === groupId), 'rejoin: room back in list');
  }

  // ── Access control ───────────────────────────────────────
  {
    const foreign = await req('GET', `/rooms/${directId}/messages`, { token: T3 });
    eq(foreign.status, 403, 'access: foreign room messages 403');
    const noRoom = await req('POST', '/rooms/does-not-exist/leave', { token: T1 });
    eq(noRoom.status, 403, 'access: unknown room leave 403');
  }

  // ── WS ошибки ────────────────────────────────────────────
  {
    const wsA = await wsConnect(T1);
    const err = waitFor(wsA, 'error');
    wsSend(wsA, 'totally_unknown_type', {});
    const e = await err;
    ok(e.code === 'UNKNOWN_TYPE', 'ws: unknown type error frame');
    wsA.close();
    await sleep(100);
    // Плохой токен → сервер принимает соединение и закрывает с 4401
    const badWs = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=garbage`);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {}); // close может прийти с error-эффектом — не мешаем
      setTimeout(() => resolve(-2), 5000);
    });
    eq(badWs, 4401, 'ws: bad token closed 4401');
  }

  // ── Upload / static / SPA / security ─────────────────────
  {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hello combain')], { type: 'text/plain' }), 'note.txt');
    const up = await fetch(BASE + '/messages/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + T1 },
      body: fd,
    });
    eq(up.status, 200, 'upload: 200');
    const upJson = await up.json();
    ok(upJson.url && upJson.url.startsWith('/uploads/'), 'upload: url path');
    const dl = await fetch(BASE + upJson.url);
    eq(dl.status, 200, 'upload: served back 200');
    const spa = await req('GET', '/');
    ok(spa.text.includes('js/config.js'), 'spa: index.html served');
    const hdrs = await fetch(BASE + '/auth/me');
    ok(hdrs.headers.get('x-content-type-options') === 'nosniff', 'security: nosniff header');
    ok(!!hdrs.headers.get('x-frame-options') || !!hdrs.headers.get('content-security-policy'), 'security: frame protection header');
    const rl = await req('POST', '/auth/login', { body: { username: U1, password: P1 } });
    ok(!!rl.headers.get('ratelimit') || !!rl.headers.get('ratelimit-policy'), 'security: rate limit headers (draft-7)');
  }

  // ── Итог ─────────────────────────────────────────────────
  console.log('\nCOMBAIN v2 smoke suite\n' + '─'.repeat(60));
  for (const line of results) console.log(line);
  console.log('─'.repeat(60));
  console.log(`TOTAL: ${passed + failed}  PASS: ${passed}  FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exitCode = 1; }).finally(() => {
  if (server) { try { server.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {} }, 300);
});
