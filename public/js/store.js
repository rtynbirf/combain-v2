// public/js/store.js
// COMBAIN v2 — application state

const Store = {
  // Auth
  token: localStorage.getItem('combain_token') || null,
  userId: localStorage.getItem('combain_user_id') || null,
  username: localStorage.getItem('combain_username') || null,

  // Rooms
  rooms: [],
  activeRoomId: null,

  // Messages — by roomId
  // messages[roomId] = Array of messages
  messages: {},

  // Typing — by roomId
  // typing[roomId] = Set(userId)
  typing: {},

  // Users cache — for resolving authorId to profile
  users: {},

  // Unread counts per room
  unreadCounts: {},

  // Online users
  onlineUsers: new Set(),

  // Calls / WebRTC
  activeCallId: null,
  peerConnection: null,
  remoteStream: null,

  // ICE servers loaded from /auth/config
  _iceServers: [],

  // UI state
  searchQuery: '',
  modalOpen: null,
  replyToId: null,
};

// Authentication persistence
function saveAuth(token, userId, username) {
  Store.token = token;
  Store.userId = userId;
  Store.username = username;
  localStorage.setItem('combain_token', token);
  localStorage.setItem('combain_user_id', userId);
  localStorage.setItem('combain_username', username);
}

function clearAuth() {
  Store.token = null;
  Store.userId = null;
  Store.username = null;
  localStorage.removeItem('combain_token');
  localStorage.removeItem('combain_user_id');
  localStorage.removeItem('combain_username');
}
