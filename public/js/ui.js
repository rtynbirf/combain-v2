// public/js/ui.js
// COMBAIN v2 — UI utilities


// ────────────────────────────────────────
// Toast
// ────────────────────────────────────────

function toast(message, type) {
  const container = document.getElementById('toasts');
  if (!container) { console[type === 'fail' ? 'error' : 'log'](message); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'ok');
  el.textContent = String(message ?? '');
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 4000);
}


// ────────────────────────────────────────
// Modal
// ────────────────────────────────────────

function openM(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  Store.modalOpen = id;
}

function closeModal() {
  if (!Store.modalOpen) return;
  const el = document.getElementById(Store.modalOpen);
  if (el) el.classList.remove('show');
  Store.modalOpen = null;
}


// ────────────────────────────────────────
// Rooms render
// ────────────────────────────────────────

function renderRooms() {
  const list = document.getElementById('rL');
  if (!list) return;

  const query = String(Store.searchQuery || '').trim().toLowerCase();
  const filtered = Store.rooms.filter(room => {
    if (!query) return true;
    const name = getRoomDisplayName(room).toLowerCase();
    if (name.includes(query)) return true;
    return room.participants?.some(p => p.user?.username?.toLowerCase().includes(query)) || false;
  });

  list.innerHTML = filtered.map(room => {
    const name = getRoomDisplayName(room);
    const active = room.id === Store.activeRoomId;
    const initial = (name.charAt(0) || '?').toUpperCase();
    const unread = Number(Store.unreadCounts[room.id] || 0);
    const online = isRoomOnline(room);

    return `<div class="ri ${active ? 'on' : ''}" onclick="openRoom('${jsAttr(room.id)}')">
      <div class="ra">${escHtml(initial)}${online ? '<span class="pdot"></span>' : ''}</div>
      <div style="flex:1;min-width:0">
        <div class="rn">${escHtml(name)}</div>
        <div class="rp" id="rp_${cssId(room.id)}"></div>
      </div>
      ${unread > 0 ? `<span class="rb">${unread > 99 ? '99+' : unread}</span>` : ''}
    </div>`;
  }).join('');

  // Load last message previews
  filtered.forEach(async room => {
    try {
      const last = await apiGetLastMessage(room.id);
      const el = document.getElementById('rp_' + cssId(room.id));
      if (!el || !last) return;
      let preview = last.deletedAt ? 'Message deleted'
        : last.type === 'text' ? (last.text || '')
        : (last.fileName || last.type || 'Attachment');
      el.textContent = preview;
    } catch {}
  });
}


// ────────────────────────────────────────
// Chat render
// ────────────────────────────────────────

function renderChat(keepScroll) {
  const container = document.getElementById('ms');
  if (!container) return;
  const roomId = Store.activeRoomId;
  if (!roomId) { container.innerHTML = ''; updateChatHeader(); return; }

  const messages = Store.messages[roomId] || [];
  const oldHeight = container.scrollHeight;
  const oldTop = container.scrollTop;

  let html = '';
  if (messages._nextCursor) {
    html += '<div class="load-more" onclick="loadMoreMessages()">\u2191 Load more</div>';
  }
  html += messages.map(m => renderMessage(m)).join('');
  container.innerHTML = html;

  if (keepScroll) {
    container.scrollTop = oldTop + (container.scrollHeight - oldHeight);
  } else {
    scrollToBottom();
  }

  updateChatHeader();
}


// ────────────────────────────────────────
// Render single message
// ────────────────────────────────────────

function renderMessage(m) {
  if (!m) return '';

  if (m.deletedAt) {
    return `<div class="m ${m.authorId === Store.userId ? 's' : 'o'}" id="msg_${cssId(m.id)}"><span class="m-del">Message deleted</span></div>`;
  }

  const mine = String(m.authorId) === String(Store.userId);
  const cls = mine ? 's' : 'o';
  const time = formatTime(m.createdAt);
  let content = '';

  // Reply
  if (m.replyToId) {
    const reply = findMessage(m.replyToId);
    const replyText = reply ? (reply.text || reply.fileName || 'Attachment') : 'Original message';
    content += `<div class="mrep" onclick="scrollToMessage('${jsAttr(m.replyToId)}')">${escHtml(replyText)}</div>`;
  }

  // Content by type
  switch (m.type) {
    case 'text':
      content += `<div class="mt">${escHtml(m.text)}</div>`;
      break;
    case 'image': {
      const imgUrl = safeUrl(m.fileUrl);
      if (imgUrl) {
        content += `<img src="${htmlAttr(imgUrl)}" alt="${htmlAttr(m.fileName || 'Image')}" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer" onclick="showImageModal('${jsAttr(imgUrl)}')">`;
      } else {
        content += `<div class="mt">[blocked image url]</div>`;
      }
      if (m.text) content += `<div class="mt">${escHtml(m.text)}</div>`;
      break;
    }
    case 'video': {
      const videoUrl = safeUrl(m.fileUrl);
      if (videoUrl) {
        content += `<video src="${htmlAttr(videoUrl)}" controls preload="metadata" style="max-width:320px;border-radius:8px"></video>`;
      } else {
        content += `<div class="mt">[blocked video url]</div>`;
      }
      if (m.text) content += `<div class="mt">${escHtml(m.text)}</div>`;
      break;
    }
    case 'voice': case 'audio': {
      const audioUrl = safeUrl(m.fileUrl);
      if (audioUrl) {
        content += `<audio src="${htmlAttr(audioUrl)}" controls preload="metadata" style="max-width:260px"></audio>`;
      } else {
        content += `<div class="mt">[blocked audio url]</div>`;
      }
      if (m.text) content += `<div class="mt">${escHtml(m.text)}</div>`;
      break;
    }
    case 'file': {
      const fileUrl = safeUrl(m.fileUrl);
      if (fileUrl) {
        content += `<div class="mf" onclick="window.open('${jsAttr(fileUrl)}','_blank','noopener')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        <div><div class="mf-name">${escHtml(m.fileName || 'File')}</div><div class="mf-size">${formatSize(m.fileSize)}</div></div>
      </div>`;
      } else {
        content += `<div class="mt">${escHtml(m.fileName || 'File')} [blocked url]</div>`;
      }
      if (m.text) content += `<div class="mt">${escHtml(m.text)}</div>`;
      break;
    }
    case 'location':
      content += `<div class="mt">${escHtml(m.locationAddress || (m.locationLat + ', ' + m.locationLng))}</div>`;
      break;
    case 'contact':
      content += `<div class="mt">${escHtml(m.contactData || 'Contact')}</div>`;
      break;
    default:
      content += `<div class="mt">${escHtml(m.text || m.fileName || m.type || '')}</div>`;
  }

  const edited = m.editedAt ? '<span class="m-ed">(edited)</span>' : '';
  const pending = m._pending ? '<span style="color:var(--t3)">\u23f3</span>' : '';
  const failed = m._failed ? '<span style="color:#e55">\u274c</span>' : '';

  const authorLine = !mine && isGroupChat()
    ? `<div class="ma">${escHtml(m.authorUsername || 'Unknown')}</div>` : '';

  // Reactions
  let reactionsHtml = '';
  if (m.reactions && typeof m.reactions === 'object') {
    const entries = Object.entries(m.reactions);
    if (entries.length) {
      reactionsHtml = '<div class="mreacts">' + entries.map(([emoji, users]) => {
        const count = Array.isArray(users) ? users.length : Number(users) || 0;
        return `<span class="mreact" onclick="toggleReaction('${jsAttr(m.id)}','${jsAttr(emoji)}')">${escHtml(emoji)} ${count}</span>`;
      }).join('') + '</div>';
    }
  }

  return `<div class="m ${cls}" id="msg_${cssId(m.id)}" oncontextmenu="showMsgCtx(event,'${jsAttr(m.id)}')">
    ${authorLine}${content}
    <div class="mtime">${escHtml(time)}${edited}${pending}${failed}</div>
    ${reactionsHtml}
  </div>`;
}


// ────────────────────────────────────────
// Incremental message render
// ────────────────────────────────────────

function renderNewMessage(message) {
  if (typeof renderMessage !== 'function') return;
  const container = document.getElementById('ms');
  if (!container || message.roomId !== Store.activeRoomId) return;
  container.insertAdjacentHTML('beforeend', renderMessage(message));
  scrollToBottom();
}

function updateMessageElement(messageId, message, rerender) {
  const el = document.getElementById('msg_' + cssId(messageId));
  if (!el) { renderChat(); return; }
  if (message) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMessage(message);
    const next = wrapper.firstElementChild;
    if (next) el.replaceWith(next);
  } else {
    renderChat();
  }
}


// ────────────────────────────────────────
// Chat header
// ────────────────────────────────────────

function updateChatHeader() {
  const room = Store.rooms.find(r => r.id === Store.activeRoomId);
  const nameEl = document.getElementById('chName');
  const statusEl = document.getElementById('chStatus');
  if (!room) return;

  const isGroup = room.type === 'group';
  const name = isGroup ? (room.name || 'Group') : (getOtherParticipant(room)?.user?.username || 'Unknown');
  if (nameEl) nameEl.textContent = name;

  if (statusEl) {
    const typingUsers = Store.typing[Store.activeRoomId];
    if (typingUsers && typingUsers.size > 0) {
      statusEl.textContent = 'typing...';
      return;
    }
    if (!isGroup) {
      const other = getOtherParticipant(room);
      const otherId = other?.userId ?? other?.user?.id;
      statusEl.textContent = (otherId && Store.onlineUsers.has(String(otherId))) ? 'online' : 'offline';
    } else {
      statusEl.textContent = (room.participants?.length || 0) + ' members';
    }
  }
}


// ────────────────────────────────────────
// Typing indicator
// ────────────────────────────────────────

function renderTyping() {
  const el = document.getElementById('typInd');
  if (!el) return;
  const users = Store.typing[Store.activeRoomId];
  if (!users || users.size === 0) { el.textContent = ''; el.style.minHeight = '0'; return; }
  const names = [...users].map(id => {
    const u = Store.users[id];
    return u?.displayName || u?.username || 'Someone';
  }).join(', ');
  el.textContent = names + ' typing...';
  el.style.minHeight = '20px';
  updateChatHeader();
}


// ────────────────────────────────────────
// Presence
// ────────────────────────────────────────

function presenceUpdate(userId, status) {
 const id = String(userId);
  if (status === 'online') Store.onlineUsers.add(id);
  else Store.onlineUsers.delete(id);
  renderRooms();
  updateChatHeader();
}


// ────────────────────────────────────────
// Context menu
// ────────────────────────────────────────

function showMsgCtx(event, msgId) {
  event.preventDefault();
  const ctx = document.getElementById('msgCtx');
  if (!ctx) return;
  ctx.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - ctx.offsetWidth - 4)) + 'px';
  ctx.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - ctx.offsetHeight - 4)) + 'px';
  ctx.dataset.msgId = String(msgId);
  ctx.classList.add('show');
  setTimeout(() => { document.addEventListener('click', hideMsgCtx, { once: true }); }, 0);
}

function hideMsgCtx() {
  document.getElementById('msgCtx')?.classList.remove('show');
}

function getContextMessageId() {
  return document.getElementById('msgCtx')?.dataset.msgId || null;
}


// ────────────────────────────────────────
// Context menu actions
// ────────────────────────────────────────

function ctxReply() {
  const id = getContextMessageId();
  if (!id) return;
  Store.replyToId = id;
  const msg = findMessage(id);
  const bar = document.getElementById('replyBar');
  if (bar) {
    bar.textContent = '\u21a9 Reply to: ' + (msg?.text || msg?.fileName || 'message');
    bar.classList.remove('hidden');
  }
  hideMsgCtx();
}

function ctxEdit() {
  const id = getContextMessageId();
  const msg = findMessage(id);
  if (msg && msg.authorId === Store.userId) {
    const t = prompt('Edit message:', msg.text || '');
    if (t) editMessage(id, t);
  }
  hideMsgCtx();
}

function ctxDelete() {
  const id = getContextMessageId();
  if (id && confirm('Delete message?')) deleteMessage(id);
  hideMsgCtx();
}

function ctxReact() {
  const id = getContextMessageId();
  if (id) toggleReaction(id, '\ud83d\udc4d');
  hideMsgCtx();
}

function ctxForward() {
  const id = getContextMessageId();
  const target = prompt('Target room ID:');
  if (target) forwardMessage(id, target);
  hideMsgCtx();
}

function ctxPin() {
  const id = getContextMessageId();
  const msg = findMessage(id);
  if (!msg) { hideMsgCtx(); return; }
  if (msg.pinnedAt) apiUnpinMessage(id, Store.activeRoomId);
  else apiPinMessage(id, Store.activeRoomId);
  hideMsgCtx();
}


// ────────────────────────────────────────
// File input handler
// ────────────────────────────────────────

function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > CONFIG.MAX_FILE_SIZE) {
    toast('File too large (max 50MB)', 'fail');
    input.value = '';
    return;
  }
  sendMediaMessage(file, null, Store.replyToId || null);
  Store.replyToId = null;
  const bar = document.getElementById('replyBar');
  if (bar) bar.classList.add('hidden');
  input.value = '';
}


// ────────────────────────────────────────
// Image modal
// ────────────────────────────────────────

function showImageModal(url) {
  const ov = document.getElementById('imgOv');
  if (!ov) return;
  const safe = safeUrl(url);
  if (!safe) return;
  ov.innerHTML = '';
  const img = document.createElement('img');
  img.src = safe;
  img.alt = 'Image';
  img.style.maxWidth = '90vw';
  img.style.maxHeight = '90vh';
  img.style.objectFit = 'contain';
  ov.appendChild(img);
  ov.classList.add('show');
}

function hideImageModal() {
  document.getElementById('imgOv')?.classList.remove('show');
}


// ────────────────────────────────────────
// Call UI
// ────────────────────────────────────────

function showCallUI() {
  const el = document.getElementById('callUI');
  if (el) el.classList.add('show');
  if (localStream) showLocalVideo(localStream);
}

function hideCallUI() {
  const el = document.getElementById('callUI');
  if (el) el.classList.remove('show');
}

function showIncomingCall(userId, onAccept, onReject) {
  const modal = document.getElementById('incomingCall');
  const name = Store.users[userId]?.username || userId || 'Someone';
  if (!modal) {
    // Fallback only if markup is missing
    console.warn('[UI] #incomingCall missing');
    onReject?.();
    return;
  }
  modal.dataset.userId = String(userId || '');
  modal.classList.add('show');
  const nameEl = modal.querySelector('[data-call-user]');
  if (nameEl) nameEl.textContent = name;
  const accept = modal.querySelector('[data-call-accept]');
  const reject = modal.querySelector('[data-call-reject]');
  if (accept) {
    accept.onclick = () => {
      modal.classList.remove('show');
      onAccept?.();
    };
  }
  if (reject) {
    reject.onclick = () => {
      modal.classList.remove('show');
      onReject?.();
    };
  }
}

function hideIncomingCall() {
  document.getElementById('incomingCall')?.classList.remove('show');
}


// ────────────────────────────────────────
// Drag and drop
// ────────────────────────────────────────

function setupDragDrop() {
  const chatArea = document.getElementById('cv');
  if (!chatArea) return;
  chatArea.addEventListener('dragover', e => { e.preventDefault(); chatArea.style.outline = '2px dashed var(--accent)'; });
  chatArea.addEventListener('dragleave', () => { chatArea.style.outline = ''; });
  chatArea.addEventListener('drop', e => {
    e.preventDefault();
    chatArea.style.outline = '';
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.size > CONFIG.MAX_FILE_SIZE) { toast('File too large', 'fail'); return; }
    sendMediaMessage(file);
  });
}


// ────────────────────────────────────────
// Escaping utilities
// ────────────────────────────────────────

function escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Allow only safe URL schemes for media / links (XSS / javascript: protection). */
function safeUrl(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  // Relative path or absolute path on same origin
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  const lower = s.toLowerCase();
  if (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('data:image/') ||
    lower.startsWith('data:video/') ||
    lower.startsWith('data:audio/') ||
    lower.startsWith('data:application/')
  ) {
    return s;
  }
  return '';
}

function htmlAttr(value) { return escHtml(value); }

function jsAttr(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function cssId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}


// ────────────────────────────────────────
// Formatting utilities
// ────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}


// ────────────────────────────────────────
// Room helpers
// ────────────────────────────────────────

function getRoomDisplayName(room) {
  if (!room) return 'Unknown';
  if (room.type === 'group') return room.name || 'Group';
  const other = getOtherParticipant(room);
  return other?.user?.username || other?.username || 'Unknown';
}

function getOtherParticipant(room) {
  return room?.participants?.find(p => String(p.userId ?? p.user?.id) !== String(Store.userId));
}

function getUserDisplayName(userId) {
  const id = String(userId);
  if (String(Store.userId) === id) return Store.username || 'You';
  const user = Store.users[id];
  return user?.displayName || user?.username || id;
}

function isRoomOnline(room) {
  if (room?.type === 'group') return false;
  const other = getOtherParticipant(room);
  if (!other) return false;
  const id = String(other.userId ?? other.user?.id);
  return Store.onlineUsers.has(id);
}

function isGroupChat() {
  const room = Store.rooms.find(r => String(r.id) === String(Store.activeRoomId));
  return room?.type === 'group';
}

function findMessage(id) {
  const messages = Store.messages[Store.activeRoomId] || [];
  return messages.find(m => String(m.id) === String(id));
}

function scrollToMessage(id) {
  const el = document.getElementById('msg_' + cssId(id));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => { el.classList.remove('highlight'); }, 1500);
}

function scrollToBottom() {
  const container = document.getElementById('ms');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}

function showChatView() {
 document.getElementById('nc')?.classList.add('hidden');
  document.getElementById('cv')?.classList.remove('hidden');
  const sb = document.getElementById('sb');
  if (sb && window.innerWidth < 768) sb.classList.add('mh');
}
