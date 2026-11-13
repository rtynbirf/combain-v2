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
const logger = require('./utils/logger');
const { verifyToken, isRevoked, cleanupRevoked } = require('./middleware/auth');
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
const metrics = require('./services/metrics');
const { getPolicy } = require('./services/csp');

const app = express();
// За обратным прокси (Caddy/Nginx) включать TRUST_PROXY=true, иначе rate-limit
// видит один IP прокси для всех клиентов
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
// Базовые security-заголовки (CSP генерируем сами ниже — из фактического контента фронтенда)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());

// Phase 3a: CSP, автогенерируемая из public/index.html (хэши inline-стилей и
// статических on*-обработчиков; script-src 'self'; без unsafe-inline в script-контексте).
app.use((req, res, next) => {
  const policy = getPolicy(config.publicDir);
  if (policy) res.setHeader('Content-Security-Policy', policy);
  next();
});

// Phase 3b: HTTP-метрики. route-лейбл — шаблон роута (без cardinality-взрыва)
app.use((req, res, next) => {
  const end = process.hrtime.bigint();
  res.on('finish', () => {
    const route = metricsRoute(req);
    metrics.incHttp(req.method, route, res.statusCode);
    metrics.observeHttp(req.method, route, Number(process.hrtime.bigint() - end) / 1e9);
  });
  next();
});

function metricsRoute(req) {
  const p = req.path || req.originalUrl || '';
  if (req.baseUrl && req.route) return req.baseUrl + req.route.path;
  if (req.baseUrl) return req.baseUrl;
  if (p === '/' || p === '/metrics' || p === '/api/health' || p === '/api/ready') return p;
  if (p.startsWith('/uploads')) return '/uploads';
  if (p.startsWith('/api')) return p;
  return 'static';
}
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

// Access-логи (структурированные): метод, путь, статус, длительность.
// Не шумим: health-пробы и статика файлов не логируются.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const p = req.path;
    if (p === '/api/health' || p === '/api/ready' || p.startsWith('/uploads')) return;
    logger.http('http_request', {
      method: req.method,
      path: p,
      status: res.statusCode,
      ms: +(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1),
      userId: req.user ? req.user.id : undefined,
    });
  });
  next();
});

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

// Phase 3b: метрики для Prometheus (скрейп на /metrics; без секретов — только счётчики)
app.get('/metrics', async (req, res) => {
  try {
    metrics.setWsConnections(wss.clients.size);
    metrics.setDbGauges();
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.render());
  } catch (e) {
    logger.error('metrics_error', { err: e.message });
    res.status(500).end();
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
  app.get('/*splat', (req, res, next) => {
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
// Keep-alive чуть больше, чем у прокси (Caddy/Nginx ~60с) — чтобы соединения
// не рвались race-ом на границе таймаутов
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// WS: maxPayload режет гигантские фреймы на уровне библиотеки (anti-DoS, close 1009)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.wsMaxPayload });

// Phase 2: сборка мусора отозванных токенов с истёкшим сроком — раз в 10 минут
setInterval(() => { try { cleanupRevoked(); } catch {} }, 10 * 60 * 1000).unref();

wss.on('connection', (ws, req) => {
  try {
    // CSWSH-защита: если ALLOWED_ORIGINS задан — чужие origin не пускаем
    const origin = req.headers.origin;
    if (config.wsAllowedOrigins.length && origin && !config.wsAllowedOrigins.includes(origin)) {
      logger.warn('ws_origin_rejected', { origin });
      ws.close(4403, 'Origin not allowed');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) { ws.close(4401, 'Unauthorized'); return; }
    let payload;
    try { payload = verifyToken(token); } catch { ws.close(4401, 'Unauthorized'); return; }
    // Phase 2: отозванный токен (logout/GDPR) или удалённый аккаунт в WS не пускаем
    if (payload.jti && isRevoked(payload.jti)) { ws.close(4401, 'Token revoked'); return; }
    const alive = store.db.prepare('SELECT deletedAt FROM User WHERE id = ?').get(payload.sub);
    if (!alive || alive.deletedAt) { ws.close(4401, 'Unauthorized'); return; }
    const userId = payload.sub;
    hub.addConnection(userId, ws);
    try {
      store.db.prepare("UPDATE User SET status='online' WHERE id=?").run(userId);
    } catch {}
    hub.broadcastAll({ type: 'presence_update', payload: { userId, status: 'online' } }, userId);
    ws.send(JSON.stringify({ type: 'auth_ok', payload: { userId } }));
    logger.info('ws_connected', { userId, origin: origin || '-' });

    // Анти-флуд: не более wsMsgLimit сообщений за скользящее окно 10с
    let msgCount = 0;
    let windowStart = Date.now();

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 10000) { windowStart = now; msgCount = 0; }
      if (++msgCount > config.wsMsgLimit) {
        logger.warn('ws_rate_limited', { userId });
        ws.close(4408, 'Rate limited');
        return;
      }
      metrics.incWsMessage();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handle(ws, userId, msg);
    });

    ws.on('close', () => {
      const last = hub.removeConnection(userId, ws);
      hub.unsubscribeAll(userId);
      logger.info('ws_closed', { userId, last });
      if (last) {
        try {
          store.db.prepare("UPDATE User SET status='offline', lastSeenAt=? WHERE id=?")
            .run(store.now(), userId);
        } catch {}
        hub.broadcastAll({ type: 'presence_update', payload: { userId, status: 'offline' } });
      }
    });
  } catch (e) {
    logger.error('ws_connection_error', { err: e.message });
    try { ws.close(); } catch {}
  }
});

// Корректное завершение: Docker/k8s шлёт SIGTERM — закрываем WS, HTTP и БД.
function shutdown(sig) {
  logger.warn('shutdown', { sig });
  for (const client of wss.clients) {
    try { client.close(1001, 'Server shutting down'); } catch {}
  }
  server.closeIdleConnections();
  server.close(() => {
    try { store.db.close(); } catch {}
    logger.info('shutdown_done');
    process.exit(0);
  });
  // Страховка: не висим дольше 5 секунд
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
  logger.info('seed_done', { users: 'test/test123, alice/alice123' });
}

seed();

server.listen(config.port, config.host, () => {
  logger.info('server_started', { host: config.host, port: config.port, node: process.version });
});
