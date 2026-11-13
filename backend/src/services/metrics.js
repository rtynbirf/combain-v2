// services/metrics.js — Phase 3b: метрики Prometheus (prom-client).
// HTTP: счётчик запросов (method/route/status — только шаблоны роутов, без
// cardinality-взрыва) и гистограмма длительности. WS: соединения и сообщения.
// БД: живые счётчики строк выставляются на скрейпе (/metrics → setDbGauges).
'use strict';

const client = require('prom-client');
const store = require('./store');

const register = new client.Registry();

const httpRequests = new client.Counter({
  name: 'combain_http_requests_total',
  help: 'Total HTTP requests by method/route/status',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: 'combain_http_request_duration_seconds',
  help: 'HTTP request duration in seconds by method/route',
  labelNames: ['method', 'route'],
  registers: [register],
});

const wsConnections = new client.Gauge({
  name: 'combain_ws_connections',
  help: 'Currently connected WebSocket sockets',
  registers: [register],
});

const wsMessages = new client.Counter({
  name: 'combain_ws_messages_total',
  help: 'Total WS client frames handled',
  registers: [register],
});

const messagesCreated = new client.Counter({
  name: 'combain_messages_created_total',
  help: 'Total messages created (REST + WS)',
  registers: [register],
});

const dbUsers = new client.Gauge({
  name: 'combain_db_users_active',
  help: 'Users not soft-deleted',
  registers: [register],
});

const dbRooms = new client.Gauge({
  name: 'combain_db_rooms',
  help: 'Rooms not soft-deleted',
  registers: [register],
});

const dbMessages = new client.Gauge({
  name: 'combain_db_messages',
  help: 'Messages not soft-deleted',
  registers: [register],
});

function incHttp(method, route, status) {
  try { httpRequests.inc({ method, route, status }); } catch {}
}

function observeHttp(method, route, seconds) {
  try { httpDuration.observe({ method, route }, seconds); } catch {}
}

function incWsMessage() { try { wsMessages.inc(); } catch {} }
function incMessage() { try { messagesCreated.inc(); } catch {} }

function setWsConnections(n) { try { wsConnections.set(n); } catch {} }

function setDbGauges() {
  try {
    dbUsers.set(store.db.prepare('SELECT COUNT(*) c FROM User WHERE deletedAt IS NULL').get().c);
    dbRooms.set(store.db.prepare('SELECT COUNT(*) c FROM Room WHERE deletedAt IS NULL').get().c);
    dbMessages.set(store.db.prepare('SELECT COUNT(*) c FROM Message WHERE deletedAt IS NULL').get().c);
  } catch {}
}

async function render() {
  return register.metrics();
}

module.exports = {
  register,
  incHttp,
  observeHttp,
  incWsMessage,
  incMessage,
  setWsConnections,
  setDbGauges,
  render,
};
