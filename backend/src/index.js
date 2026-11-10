const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { sendError } = require('./utils/errors');
const { verifyToken } = require('./middleware/auth');
const store = require('./services/store');
const hub = require('./ws/hub');
const { handle } = require('./ws/handlers');

hub.setMemberLookup((roomId) =>
  store.db
    .prepare('SELECT userId FROM RoomMember WHERE roomId = ? AND leftAt IS NULL')
    .all(roomId)
    .map((r) => r.userId)
);

const authRoutes = require('./routes/auth');
const roomsRoutes = require('./routes/rooms');
const messagesRoutes = require('./routes/messages');
const usersRoutes = require('./routes/users');
const groupsRoutes = require('./routes/groups');

const app = express();
// За обратным прокси (Caddy/Nginx) включать TRUST_PROXY=true, иначе rate-limit
// видит один IP прокси для всех клиентов
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
// Базовые security-заголовки. CSP выключен: фронтенд заморожен и использует
// inline-стили; тонкая настройка CSP — Phase 3
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Глобальный rate-limit (draft-7 заголовки RateLimit-*). Health-зонды не считаем
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_MAX || '600', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health' || req.path === '/api/ready',
});
app.use(limiter);

// Health/ready для Docker, Compose и мониторинга
const startedAtIso = new Date().toISOString();
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor(process.uptime()), startedAt: startedAtIso });
});
app.get('/api/ready', (req, res) => {
  try {
    store.db.prepare('SELECT 1').get();
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/auth', authRoutes);
app.use('/rooms', roomsRoutes);
app.use('/messages', messagesRoutes);
app.use('/users', usersRoutes);
app.use('/groups', groupsRoutes);

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir));

if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/auth') || req.path.startsWith('/rooms') ||
        req.path.startsWith('/messages') || req.path.startsWith('/users') ||
        req.path.startsWith('/groups') || req.path.startsWith('/uploads') ||
        req.path.startsWith('/api')) return next();
    const index = path.join(config.publicDir, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    next();
  });
}

app.use((err, req, res, next) => sendError(res, err));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) { ws.close(4401, 'Unauthorized'); return; }
    let payload;
    try { payload = verifyToken(token); } catch { ws.close(4401, 'Unauthorized'); return; }
    const userId = payload.sub;
    hub.addConnection(userId, ws);
    try {
      store.db.prepare("UPDATE User SET status='online' WHERE id=?").run(userId);
    } catch {}
    hub.broadcastAll({ type: 'presence_update', payload: { userId, status: 'online' } }, userId);
    ws.send(JSON.stringify({ type: 'auth_ok', payload: { userId } }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handle(ws, userId, msg);
    });

    ws.on('close', () => {
      const last = hub.removeConnection(userId, ws);
      hub.unsubscribeAll(userId);
      if (last) {
        try {
          store.db.prepare("UPDATE User SET status='offline', lastSeenAt=? WHERE id=?")
            .run(store.now(), userId);
        } catch {}
        hub.broadcastAll({ type: 'presence_update', payload: { userId, status: 'offline' } });
      }
    });
  } catch (e) {
    console.error('[WS]', e);
    try { ws.close(); } catch {}
  }
});

function seed() {
  const bcrypt = require('bcryptjs');
  if (store.getUserByUsername('test')) return;
  const ts = store.now();
  const hash = bcrypt.hashSync('test123', 10);
  const hashA = bcrypt.hashSync('alice123', 10);
  const testId = store.cuid();
  const aliceId = store.cuid();
  store.db.prepare(`INSERT INTO User (id,username,passwordHash,displayName,balance,status,createdAt,updatedAt)
    VALUES (?,?,?,?,0,'offline',?,?)`).run(testId, 'test', hash, 'Test User', ts, ts);
  store.db.prepare(`INSERT INTO User (id,username,passwordHash,displayName,balance,status,createdAt,updatedAt)
    VALUES (?,?,?,?,0,'offline',?,?)`).run(aliceId, 'alice', hashA, 'Alice', ts, ts);
  const roomId = store.cuid();
  store.db.prepare(`INSERT INTO Room (id,type,name,createdById,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`)
    .run(roomId, 'direct', null, testId, ts, ts);
  store.db.prepare(`INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)`)
    .run(store.cuid(), roomId, testId, 'member', ts);
  store.db.prepare(`INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)`)
    .run(store.cuid(), roomId, aliceId, 'member', ts);
  const texts = [
    [aliceId, 'Hey, welcome to COMBAIN!'],
    [aliceId, 'This is the real SQLite backend.'],
    [testId, 'Thanks! Looks good so far.'],
    [aliceId, 'Try sending a message, editing, or deleting one.'],
    [aliceId, 'You can also test reactions and file uploads.'],
  ];
  for (const [authorId, text] of texts) {
    store.db.prepare(
      `INSERT INTO Message (id,roomId,authorId,type,text,createdAt) VALUES (?,?,?,'text',?,?)`
    ).run(store.cuid(), roomId, authorId, text, ts);
  }
  console.log('[seed] test/test123, alice/alice123');
}

seed();

server.listen(config.port, config.host, () => {
  console.log('COMBAIN backend http://' + config.host + ':' + config.port);
});
