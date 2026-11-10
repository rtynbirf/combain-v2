// public/js/rooms.js
// COMBAIN v2 — rooms, room switching and message pagination


// ────────────────────────────────────────
// Load rooms
// ────────────────────────────────────────

async function loadRooms() {
  try {
    const data = await apiGetRooms();
    Store.rooms = Array.isArray(data) ? data : (Array.isArray(data?.rooms) ? data.rooms : []);

    // Clean stale unread counts
    const roomIds = new Set(Store.rooms.map(r => r.id));
    Object.keys(Store.unreadCounts).forEach(id => { if (!roomIds.has(id)) delete Store.unreadCounts[id]; });

    renderRooms();
    return Store.rooms;
  } catch (error) {
    console.warn('[ROOMS] Failed to load rooms:', error);
    toast(error.message || 'Failed to load rooms', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Open room
// ────────────────────────────────────────

async function openRoom(roomId) {
  if (!roomId) return;
  const room = Store.rooms.find(r => r.id === roomId);
  if (!room) { console.warn('[ROOMS] Unknown room:', roomId); return; }

  // Stop typing in previous room
  if (Store.activeRoomId && Store.activeRoomId !== roomId) stopTyping();

  Store.activeRoomId = roomId;

  if (!Store.typing[roomId]) Store.typing[roomId] = new Set();

  // Subscribe via WS
  wsSend('subscribe', { roomId });

  // Load history once
  if (!Store.messages[roomId]) {
    Store.messages[roomId] = [];
    try {
      const data = await apiGetMessages(roomId);
      const messages = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
      Store.messages[roomId] = messages.reverse(); // server DESC → client ASC
      Store.messages[roomId]._nextCursor = data?.nextCursor || null;
    } catch (error) {
      console.warn('[ROOMS] Failed to load messages:', error);
      toast(error.message || 'Failed to load messages', 'fail');
    }
  }

  // Reset local unread
  Store.unreadCounts[roomId] = 0;
  markRoomRead(roomId);

  renderRooms();
  renderChat();
  renderTyping();
  showChatView();

  // Mobile: hide sidebar
  const sidebar = document.getElementById('sb');
  if (sidebar && window.innerWidth < 768) sidebar.classList.add('mh');

  return room;
}


// ────────────────────────────────────────
// Mark room messages as read
// ────────────────────────────────────────

function markRoomRead(roomId) {
  if (!roomId) return;
  const messages = Store.messages[roomId] || [];

  const unread = messages.filter(m =>
    m && m.id &&
    m.authorId !== Store.userId &&
    !m._readByMe &&
    !m._pending &&
    !String(m.id).startsWith('c_') &&
    !m.deletedAt
  );

  if (unread.length === 0) { Store.unreadCounts[roomId] = 0; return; }

  const messageIds = unread.map(m => m.id);
  wsSend('messages_read', { messageIds, roomId });
  unread.forEach(m => { m._readByMe = true; });
  Store.unreadCounts[roomId] = 0;
  renderRooms();
}


// ────────────────────────────────────────
// Create direct room
// ────────────────────────────────────────

async function createDirectRoom(targetUserId) {
  if (!targetUserId) return;
  if (String(targetUserId) === String(Store.userId)) {
    toast('Cannot create a direct chat with yourself', 'fail');
    return;
  }
  try {
    const room = await apiCreateRoom('direct', [targetUserId]);
    await loadRooms();
    if (room?.id) await openRoom(room.id);
    closeModal();
    return room;
  } catch (error) {
    console.warn('[ROOMS] Failed to create direct room:', error);
    toast(error.message || 'Failed to create chat', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Create group room
// ────────────────────────────────────────

async function createGroupRoom(name, userIds) {
  const cleanName = String(name || '').trim();
  const participants = Array.isArray(userIds) ? [...new Set(userIds.filter(Boolean).map(String))] : [];
  if (!cleanName) { toast('Group name is required', 'fail'); return; }
  try {
    const room = await apiCreateRoom('group', participants, cleanName);
    await loadRooms();
    if (room?.id) await openRoom(room.id);
    closeModal();
    return room;
  } catch (error) {
    console.warn('[ROOMS] Failed to create group:', error);
    toast(error.message || 'Failed to create group', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Leave room
// ────────────────────────────────────────

async function leaveRoom(roomId) {
  if (!roomId) return;
  try {
    await apiLeaveRoom(roomId);
    if (Store.activeRoomId === roomId) {
      stopTyping();
      Store.activeRoomId = null;
      delete Store.messages[roomId];
      delete Store.typing[roomId];
      delete Store.unreadCounts[roomId];
      const chat = document.getElementById('cv');
      const empty = document.getElementById('nc');
      if (chat) chat.classList.add('hidden');
      if (empty) empty.classList.remove('hidden');
    }
    await loadRooms();
    toast('You left the chat', 'ok');
  } catch (error) {
    console.warn('[ROOMS] Failed to leave room:', error);
    toast(error.message || 'Failed to leave chat', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Rejoin room
// ────────────────────────────────────────

async function rejoinRoom(roomId) {
  if (!roomId) return;
  try {
    const result = await api('POST', '/rooms/' + encodeURIComponent(roomId) + '/rejoin');
    await loadRooms();
    await openRoom(roomId);
    return result;
  } catch (error) {
    console.warn('[ROOMS] Failed to rejoin room:', error);
    toast(error.message || 'Failed to rejoin chat', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Load participants
// ────────────────────────────────────────

async function loadRoomParticipants(roomId) {
  if (!roomId) return [];
  try {
    const data = await apiGetParticipants(roomId);
    const participants = Array.isArray(data) ? data : (Array.isArray(data?.participants) ? data.participants : []);
    participants.forEach(p => { if (p?.user?.id) Store.users[p.user.id] = p.user; });
    return participants;
  } catch (error) {
    console.warn('[ROOMS] Failed to load participants:', error);
    toast(error.message || 'Failed to load participants', 'fail');
    throw error;
  }
}


// ────────────────────────────────────────
// Load more messages (pagination)
// ────────────────────────────────────────

async function loadMoreMessages() {
  const roomId = Store.activeRoomId;
  if (!roomId) return false;
  const messages = Store.messages[roomId];
  if (!messages) return false;
  const cursor = messages._nextCursor;
  if (!cursor) return false;
  if (messages._loadingMore) return false;
  messages._loadingMore = true;

  const container = document.getElementById('ms');
  const oldScrollHeight = container?.scrollHeight || 0;
  const oldScrollTop = container?.scrollTop || 0;

  try {
    const data = await apiGetMessages(roomId, cursor);
    const received = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
    const older = received.reverse();

    // Deduplicate
    const existingIds = new Set(messages.filter(Boolean).map(m => m.id).filter(Boolean));
    const uniqueOlder = older.filter(m => {
      if (!m?.id) return true;
      if (existingIds.has(m.id)) return false;
      existingIds.add(m.id);
      return true;
    });

    Store.messages[roomId] = [...uniqueOlder, ...messages];
    Store.messages[roomId]._nextCursor = data?.nextCursor || null;
    Store.messages[roomId]._loadingMore = false;

    renderChat(true);

    // Restore scroll position
    if (container) {
      container.scrollTop = oldScrollTop + (container.scrollHeight - oldScrollHeight);
    }

    return uniqueOlder.length > 0;
  } catch (error) {
    Store.messages[roomId]._loadingMore = false;
    console.warn('[ROOMS] Failed to load more messages:', error);
    toast(error.message || 'Failed to load more', 'fail');
    return false;
  }
}


// ────────────────────────────────────────
// Scroll-triggered pagination
// ────────────────────────────────────────

function setupMessagePagination() {
  const container = document.getElementById('ms');
  if (!container) return;
  if (container.dataset.paginationReady === '1') return;
  container.dataset.paginationReady = '1';
  container.addEventListener('scroll', () => {
    if (container.scrollTop > 120) return;
    loadMoreMessages();
  }, { passive: true });
}


// ────────────────────────────────────────
// Unread count
// ────────────────────────────────────────

async function refreshUnreadCount(roomId) {
  if (!roomId) return 0;
  try {
    const data = await apiGetUnread(roomId);
 const count = Number(data?.count || 0);
    Store.unreadCounts[roomId] = count;
    renderRooms();
    return count;
  } catch (error) {
    console.warn('[ROOMS] Failed to load unread count:', error);
    return Store.unreadCounts[roomId] || 0;
  }
}


// ────────────────────────────────────────
// Incoming message → unread state
// ────────────────────────────────────────

function roomHandleIncomingMessage(message) {
  if (!message?.roomId) return;
  const roomId = message.roomId;

  if (roomId === Store.activeRoomId) {
    message._readByMe = true;
    if (message.id) wsSend('messages_read', { messageIds: [message.id], roomId });
    Store.unreadCounts[roomId] = 0;
    return;
  }

  Store.unreadCounts[roomId] = (Store.unreadCounts[roomId] || 0) + 1;
  renderRooms();
}


// ────────────────────────────────────────
// Mobile navigation
// ────────────────────────────────────────

function goBack() {
  stopTyping();
  Store.activeRoomId = null;
  const sidebar = document.getElementById('sb');
  const empty = document.getElementById('nc');
  const chat = document.getElementById('cv');
  if (sidebar) sidebar.classList.remove('mh');
  if (empty) empty.classList.remove('hidden');
  if (chat) chat.classList.add('hidden');
  renderRooms();
}
