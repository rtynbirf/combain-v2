// public/js/ws.js
// COMBAIN v2 — WebSocket transport and event dispatcher

let ws = null;
let reconnectTimer = null;
let reconnectDelay = CONFIG.RECONNECT_DELAY;
let wsManualClose = false;
let wsConnecting = false;


// ────────────────────────────────────────
// Connect
// ────────────────────────────────────────

function wsConnect() {
  if (!Store.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  wsManualClose = false;
  wsConnecting = true;

  const url = CONFIG.WS_URL + '?token=' + encodeURIComponent(Store.token);
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) { socket.close(); return; }
    wsConnecting = false;
    reconnectDelay = CONFIG.RECONNECT_DELAY;
    console.log('[WS] Connected');
    wsResubscribe();
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    wsHandleMessage(message);
  };

  socket.onerror = () => { if (ws !== socket) return; };

  socket.onclose = (event) => {
    if (ws === socket) { ws = null; wsConnecting = false; }
    console.log('[WS] Closed:', event.code, event.reason || '');
    if (!wsManualClose && Store.token) wsScheduleReconnect();
  };
}


// ────────────────────────────────────────
// Reconnect
// ────────────────────────────────────────

function wsScheduleReconnect() {
  if (!Store.token || wsManualClose || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!Store.token || wsManualClose) return;
    wsConnect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, CONFIG.RECONNECT_MAX);
  }, delay);
}


// ────────────────────────────────────────
// Re-subscribe after reconnect
// ────────────────────────────────────────

function wsResubscribe() {
  if (!Store.activeRoomId) return;
  wsSend('rejoin', { roomId: Store.activeRoomId });
}


// ────────────────────────────────────────
// Send
// ────────────────────────────────────────

function wsSend(type, payload, requestId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const envelope = { type };
  if (payload !== undefined && payload !== null) envelope.payload = payload;
  if (requestId) envelope.requestId = requestId;
  try { ws.send(JSON.stringify(envelope)); return true; } catch { return false; }
}


// ────────────────────────────────────────
// Disconnect
// ────────────────────────────────────────

function wsDisconnect() {
  wsManualClose = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = CONFIG.RECONNECT_DELAY;
  wsConnecting = false;
  const socket = ws;
  ws = null;
  if (!socket) return;
  try { socket.close(1000, 'logout'); } catch {}
}


// ────────────────────────────────────────
// Connection state
// ────────────────────────────────────────

function wsIsConnected() {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}


// ────────────────────────────────────────
// Incoming dispatcher
// ────────────────────────────────────────

function wsHandleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  const { type, requestId, payload } = msg;

  switch (type) {
    case 'auth_ok':
      console.log('[WS] Auth OK:', payload?.userId);
      if (payload && payload.userId && !Store.userId) {
        Store.userId = payload.userId;
        localStorage.setItem('combain_user_id', payload.userId);
      }
      break;

    case 'subscribed':
      console.log('[WS] Subscribed:', payload?.roomId);
      break;

    case 'rejoined':
      console.log('[WS] Rejoined:', payload?.roomId);
      break;

    case 'chat_message':
      chatReceiveMessage(payload, requestId);
      break;

    case 'message_edited':
      chatEditMessage(payload);
      break;

    case 'message_deleted':
      chatDeleteMessage(payload);
      break;

    case 'message_reaction':
      chatUpdateReaction(payload);
      break;

    case 'messages_read':
      chatMarkReadRemote(payload);
      break;

    case 'messages_read_ack':
      console.log('[WS] Messages read:', payload?.readCount);
      break;

    case 'message_read_by':
      chatReadBy(payload);
      break;

    case 'typing_start':
      if (payload?.userId && payload?.roomId) typingAdd(payload.userId, payload.roomId);
      break;

    case 'typing_stop':
      if (payload?.userId && payload?.roomId) typingRemove(payload.userId, payload.roomId);
      break;

    case 'presence_update':
      if (payload?.userId && payload?.status) presenceUpdate(payload.userId, payload.status);
      break;

    case 'call_created':
      if (payload?.callId) Store.activeCallId = payload.callId;
      if (typeof callCreated === 'function') callCreated(payload);
      break;

    case 'call_offer':
      callIncoming(payload);
      break;

    case 'call_answer':
      callAnswerReceived(payload);
      break;

    case 'ice_candidate':
      callIceReceived(payload);
      break;

    case 'call_ended':
      callEnded(payload);
      break;

    case 'message_pinned':
      if (typeof chatPinMessage === 'function') chatPinMessage(payload);
      break;

    case 'message_unpinned':
      if (typeof chatUnpinMessage === 'function') chatUnpinMessage(payload);
      break;

    case 'error':
      console.warn('[WS] Server error:', msg.code, msg.message, msg.requestId);
      if (typeof toast === 'function') toast(msg.message || msg.code || 'WebSocket error', 'fail');
      break;

    default:
      console.log('[WS] Unknown message:', msg);
  }
}
