// public/js/chat.js
// COMBAIN v2 — chat, messages, typing, reactions


// ────────────────────────────────────────
// Send text message
// ────────────────────────────────────────

function sendTextMessage(text, replyToId) {
  if (!Store.activeRoomId) return;
  const cleanText = String(text || '').trim();
  if (!cleanText) return;

  const clientMessageId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const roomId = Store.activeRoomId;

  const optimistic = {
    id: clientMessageId,
    roomId,
    authorId: Store.userId,
    authorUsername: Store.username,
    text: cleanText,
    clientMessageId,
    type: 'text',
    createdAt: new Date().toISOString(),
    _pending: true,
  };

  // Show immediately
  addMessage(optimistic);

  // Send after local add
  const sent = wsSend('chat_message', {
    roomId,
    text: cleanText,
    clientMessageId,
    replyToId: replyToId || null,
  }, clientMessageId);

  if (!sent) markMessageFailed(clientMessageId, 'Connection unavailable');

  stopTyping();
}


// ────────────────────────────────────────
// Send media message
// ────────────────────────────────────────

async function sendMediaMessage(file, text, replyToId) {
  if (!Store.activeRoomId || !file) return;
  if (file.size > CONFIG.MAX_FILE_SIZE) {
    toast('File is too large. Maximum size is 50 MB.', 'fail');
    return;
  }

  try {
    toast('Uploading...', 'ok');

    const uploaded = await uploadFile(file, progress => {
      updateUploadProgress(progress);
    });

    const clientMessageId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const roomId = Store.activeRoomId;
    const msgType = getMediaType(file.type);
    const caption = String(text || '').trim() || null;

    const optimistic = {
      id: clientMessageId,
      roomId,
      authorId: Store.userId,
      authorUsername: Store.username,
      text: caption,
      clientMessageId,
      type: msgType,
      fileUrl: uploaded.url,
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize,
      fileMimeType: uploaded.mimeType,
      createdAt: new Date().toISOString(),
      _pending: true,
    };

    addMessage(optimistic);

    const sent = wsSend('media_message', {
      roomId,
      clientMessageId,
      type: msgType,
      fileUrl: uploaded.url,
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize,
      fileMimeType: uploaded.mimeType,
      text: caption,
      replyToId: replyToId || null,
    }, clientMessageId);

    if (!sent) markMessageFailed(clientMessageId, 'Connection unavailable');

    stopTyping();
    updateUploadProgress(null);
  } catch (error) {
    updateUploadProgress(null);
    console.warn('[CHAT] Upload failed:', error);
    toast('Upload failed: ' + (error.message || error.error || 'Unknown error'), 'fail');
  }
}


function getMediaType(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return 'file';
}


// ────────────────────────────────────────
// Receive message / ACK
// ────────────────────────────────────────

function chatReceiveMessage(payload, requestId) {
  if (!payload?.roomId) return;
  const roomId = payload.roomId;
  if (!Store.messages[roomId]) Store.messages[roomId] = [];
  const messages = Store.messages[roomId];

  // ACK our optimistic message
  if (requestId) {
    const index = messages.findIndex(m => m.clientMessageId === requestId || m.id === requestId);
    if (index !== -1) {
      messages[index] = { ...payload, _pending: false };
      updateMessageElement(payload.id, messages[index]);
      return;
    }
  }

  // Server sent our message without requestId
  if (payload.clientMessageId && payload.authorId === Store.userId) {
    const optIdx = messages.findIndex(m => m.clientMessageId === payload.clientMessageId);
    if (optIdx !== -1) {
      messages[optIdx] = { ...payload, _pending: false };
      updateMessageElement(payload.id, messages[optIdx]);
      return;
    }
  }

  // Duplicate protection
  if (payload.id && messages.some(m => m.id === payload.id)) return;

  // New message
  addMessage(payload);

  if (roomId === Store.activeRoomId) {
    payload._readByMe = true;
    scrollToBottom();
    if (payload.id) wsSend('messages_read', { messageIds: [payload.id], roomId });
    Store.unreadCounts[roomId] = 0;
  } else {
    roomHandleIncomingMessage(payload);
  }

  renderRooms();
}


// ────────────────────────────────────────
// Add message
// ────────────────────────────────────────

function addMessage(message) {
  if (!message?.roomId) return;
  const roomId = message.roomId;
  if (!Store.messages[roomId]) Store.messages[roomId] = [];
  const messages = Store.messages[roomId];
  if (message.id && messages.some(m => m.id === message.id)) return;
  messages.push(message);
  if (roomId === Store.activeRoomId) renderNewMessage(message);
}


// ────────────────────────────────────────
// Edit message
// ────────────────────────────────────────

function editMessage(messageId, newText) {
  const text = String(newText || '').trim();
  if (!messageId || !text) return;
  wsSend('edit_message', { messageId, text });
}

function chatEditMessage(payload) {
  if (!payload?.id) return;
  Object.values(Store.messages).forEach(msgs => {
    const msg = msgs.find(m => m.id === payload.id);
    if (!msg) return;
    if (payload.text !== undefined) msg.text = payload.text;
    if (payload.editedAt) msg.editedAt = payload.editedAt;
  });
  updateMessageElement(payload.id, null, true);
}


// ────────────────────────────────────────
// Delete message
// ────────────────────────────────────────

function deleteMessage(messageId) {
  if (!messageId) return;
  wsSend('delete_message', { messageId });
}

function chatDeleteMessage(payload) {
  if (!payload?.id) return;
  Object.values(Store.messages).forEach(msgs => {
    const msg = msgs.find(m => m.id === payload.id);
    if (!msg) return;
    msg.deletedAt = payload.deletedAt || new Date().toISOString();
    msg.text = null;
  });
  updateMessageElement(payload.id, null, true);
}


// ────────────────────────────────────────
// Reactions
// ────────────────────────────────────────

function toggleReaction(messageId, emoji) {
  if (!messageId || !emoji) return;
  wsSend('message_reaction', { messageId, emoji });
}

function chatUpdateReaction(payload) {
  if (!payload?.messageId) return;
  Object.values(Store.messages).forEach(msgs => {
    const msg = msgs.find(m => m.id === payload.messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (Array.isArray(payload.reactions)) {
      const result = {};
      payload.reactions.forEach(r => {
        if (!r?.emoji) return;
        if (!result[r.emoji]) result[r.emoji] = [];
        if (r.userId) result[r.emoji].push(r.userId);
      });
      msg.reactions = result;
    } else if (payload.reactions && typeof payload.reactions === 'object') {
      msg.reactions = payload.reactions;
    }
  });
  updateMessageElement(payload.messageId, null, true);
}


// ────────────────────────────────────────
// Pin / Unpin
// ────────────────────────────────────────

function chatPinMessage(payload) {
  if (!payload?.messageId) return;
  const msgs = Store.messages[Store.activeRoomId];
  if (!msgs) return;
  const msg = msgs.find(m => m.id === payload.messageId);
  if (msg) {
    msg.pinnedAt = payload.pinnedAt;
    msg.pinnedBy = payload.pinnedBy;
    renderChat();
  }
}

function chatUnpinMessage(payload) {
  if (!payload?.messageId) return;
  const msgs = Store.messages[Store.activeRoomId];
  if (!msgs) return;
  const msg = msgs.find(m => m.id === payload.messageId);
  if (msg) {
    delete msg.pinnedAt;
    delete msg.pinnedBy;
    renderChat();
  }
}


// ────────────────────────────────────────
// Read receipts
// ────────────────────────────────────────

function chatMarkReadRemote(payload) {
  if (!payload?.messageIds || !Array.isArray(payload.messageIds)) return;
  const ids = new Set(payload.messageIds);
  Object.values(Store.messages).forEach(msgs => {
    msgs.forEach(msg => {
      if (ids.has(msg.id)) {
        if (!msg._readBy) msg._readBy = new Set();
        if (payload.userId) msg._readBy.add(payload.userId);
      }
    });
  });
}

function chatReadBy(payload) {
  if (!payload?.messageId || !payload?.userId) return;
  const msg = findMessageAnywhere(payload.messageId);
  if (!msg) return;
  if (!msg._readBy) msg._readBy = new Set();
  msg._readBy.add(payload.userId);
  updateMessageElement(payload.messageId, null, true);
}


// ────────────────────────────────────────
// Forward
// ────────────────────────────────────────

function forwardMessage(messageId, targetRoomId) {
  const clientMessageId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  wsSend('forward_message', { messageId, targetRoomId, clientMessageId }, clientMessageId);
}


// ────────────────────────────────────────
// Typing
// ────────────────────────────────────────

let typingTimer = null;
let typingStopTimer = null;

function startTyping() {
  const roomId = Store.activeRoomId;
  if (!roomId) return;
  if (!typingTimer) {
    wsSend('typing_start', { roomId });
    typingTimer = setTimeout(() => { typingTimer = null; }, CONFIG.TYPING_DEBOUNCE);
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => { stopTyping(); }, CONFIG.TYPING_STOP_DELAY);
}

function stopTyping() {
  const roomId = Store.activeRoomId;
  clearTimeout(typingTimer);
  clearTimeout(typingStopTimer);
  typingTimer = null;
  typingStopTimer = null;
  if (!roomId) return;
  wsSend('typing_stop', { roomId });
}

function typingAdd(userId, roomId) {
  if (!userId || !roomId || userId === Store.userId) return;
  if (!Store.typing[roomId]) Store.typing[roomId] = new Set();
  Store.typing[roomId].add(userId);
  renderTyping();
}

function typingRemove(userId, roomId) {
  const users = Store.typing[roomId];
  if (!users) return;
  users.delete(userId);
  if (users.size === 0) delete Store.typing[roomId];
  renderTyping();
}


// ────────────────────────────────────────
// Failed optimistic message
// ────────────────────────────────────────

function markMessageFailed(messageId, reason) {
  const msg = findMessageAnywhere(messageId);
  if (!msg) return;
  msg._pending = false;
  msg._failed = true;
  msg._error = reason || 'Send failed';
  updateMessageElement(messageId, null, true);
  toast(msg._error, 'fail');
}


// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

function findMessageAnywhere(id) {
  if (!id) return null;
  for (const messages of Object.values(Store.messages)) {
    const msg = messages.find(m => m?.id === id);
    if (msg) return msg;
  }
  return null;
}

function findMessage(id) {
  return findMessageAnywhere(id);
}


// ────────────────────────────────────────
// UI hooks
// ────────────────────────────────────────

function renderNewMessage(message) {
  if (typeof renderMessage !== 'function') return;
  const container = document.getElementById('ms');
  if (!container) return;
  const html = renderMessage(message);
  container.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

function updateMessageElement(messageId, message, rerender) {
  const el = document.getElementById('msg_' + String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!el) { if (rerender && message) renderChat(); else renderChat(); return; }
  if (message) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMessage(message);
    const next = wrapper.firstElementChild;
    if (next) el.replaceWith(next);
  } else {
    renderChat();
  }
}

function updateUploadProgress(progress) {
  // Progress bar UI deferred — no #uploadProgress in HTML yet
  // Keep callback so uploadFile(onProgress) stays compatible
  void progress;
}
