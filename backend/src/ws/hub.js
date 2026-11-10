/** In-memory connection & room subscription hub */
const connections = new Map(); // userId -> Set<ws>
const roomSubs = new Map(); // roomId -> Set<userId>
const typing = new Map(); // roomId -> Map<userId, timeout>

// Провайдер участников комнаты (roomId -> userId[]), подключается из index.js.
// Нужен для Class A: событие доходит ВСЕМ онлайн-участникам, а не только подписчикам.
let memberLookup = null;
function setMemberLookup(fn) { memberLookup = typeof fn === 'function' ? fn : null; }

function addConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
  ws._userId = userId;
}

function removeConnection(userId, ws) {
  const set = connections.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    connections.delete(userId);
    return true; // was last
  }
  return false;
}

function isOnline(userId) {
  const set = connections.get(userId);
  return !!(set && set.size > 0);
}

function sendToUser(userId, frame) {
  const set = connections.get(userId);
  if (!set) return;
  const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function subscribe(userId, roomId) {
  if (!roomSubs.has(roomId)) roomSubs.set(roomId, new Set());
  roomSubs.get(roomId).add(userId);
}

function unsubscribeAll(userId) {
  for (const [, set] of roomSubs) set.delete(userId);
}

/**
 * Class A: доставить всем онлайн-участникам комнаты (подписчики ∪ члены из БД).
 * Сообщения/реакции/прочтения доходят в фоновые комнаты — фронтенд сам поднимет бейджи.
 */
function broadcastToRoom(roomId, frame, excludeUserId) {
  const data = JSON.stringify(frame);
  const targets = new Set(roomSubs.get(roomId) || []);
  if (memberLookup) {
    try { for (const uid of memberLookup(roomId) || []) targets.add(uid); } catch {}
  }
  for (const uid of targets) {
    if (excludeUserId && uid === excludeUserId) continue;
    sendToUser(uid, data);
  }
}

/** Class B: только подписчики комнаты (typing и прочий «комнатный» шум) */
function broadcastToSubscribers(roomId, frame, excludeUserId) {
  const data = JSON.stringify(frame);
  for (const uid of roomSubs.get(roomId) || []) {
    if (excludeUserId && uid === excludeUserId) continue;
    sendToUser(uid, data);
  }
}

/** Broadcast presence to everyone connected (simple MVP) */
function broadcastAll(frame, excludeUserId) {
  const data = JSON.stringify(frame);
  for (const [uid, set] of connections) {
    if (excludeUserId && uid === excludeUserId) continue;
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(data);
    }
  }
}

function setTyping(roomId, userId) {
  if (!typing.has(roomId)) typing.set(roomId, new Map());
  const map = typing.get(roomId);
  if (map.has(userId)) clearTimeout(map.get(userId));
  const t = setTimeout(() => {
    map.delete(userId);
    broadcastToSubscribers(roomId, {
      type: 'typing_stop',
      payload: { userId, roomId },
    }, userId);
  }, 4000);
  map.set(userId, t);
}

function clearTyping(roomId, userId) {
  const map = typing.get(roomId);
  if (!map || !map.has(userId)) return;
  clearTimeout(map.get(userId));
  map.delete(userId);
}

module.exports = {
  addConnection,
  removeConnection,
  isOnline,
  sendToUser,
  subscribe,
  unsubscribeAll,
  setMemberLookup,
  broadcastToRoom,
  broadcastToSubscribers,
  broadcastAll,
  setTyping,
  clearTyping,
};
