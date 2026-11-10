// public/js/api.js
// COMBAIN v2 — REST API client

async function api(method, path, body) {
  const opts = {
    method,
    headers: {},
  };

  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  if (Store.token) {
    opts.headers['Authorization'] = 'Bearer ' + Store.token;
  }

  const res = await fetch(CONFIG.BASE_URL + path, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw { status: res.status, ...data };
  }

  return data;
}


// ────────────────────────────────────────
// File upload
// ────────────────────────────────────────

async function uploadFile(file, onProgress) {
  if (!(file instanceof File)) {
    throw { status: 400, error: 'INVALID_FILE', message: 'Invalid file' };
  }
  if (file.size > CONFIG.MAX_FILE_SIZE) {
    throw { status: 413, error: 'FILE_TOO_LARGE', message: 'File is too large' };
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.BASE_URL + '/messages/upload');
    if (Store.token) xhr.setRequestHeader('Authorization', 'Bearer ' + Store.token);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText || '{}'); } catch {
        reject({ status: xhr.status, error: 'INVALID_RESPONSE', message: 'Invalid server response' });
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject({ status: xhr.status, ...data });
        return;
      }
      resolve(data);
    };

    xhr.onerror = () => reject({ status: 0, error: 'NETWORK_ERROR', message: 'Network error' });
    xhr.onabort = () => reject({ status: 0, error: 'ABORTED', message: 'Upload aborted' });

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}


// ────────────────────────────────────────
// Auth
// ────────────────────────────────────────

async function apiRegister(username, password) { return api('POST', '/auth/register', { username, password }); }
async function apiLogin(username, password) { return api('POST', '/auth/login', { username, password }); }
async function apiLogout() { return api('POST', '/auth/logout'); }
async function apiMe() { return api('GET', '/auth/me'); }
async function apiGetConfig() { return api('GET', '/auth/config'); }


// ────────────────────────────────────────
// Rooms
// ────────────────────────────────────────

async function apiGetRooms() { return api('GET', '/rooms'); }

async function apiCreateRoom(type, participantIds, name) {
  const body = { type, participantIds };
  if (name) body.name = name;
  return api('POST', '/rooms', body);
}

async function apiGetMessages(roomId, cursor) {
  let path = '/rooms/' + encodeURIComponent(roomId) + '/messages?limit=' + CONFIG.MESSAGE_LOAD_COUNT;
  if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
  return api('GET', path);
}

async function apiGetParticipants(roomId) {
  return api('GET', '/rooms/' + encodeURIComponent(roomId) + '/participants');
}

async function apiLeaveRoom(roomId) {
  return api('POST', '/rooms/' + encodeURIComponent(roomId) + '/leave');
}

async function apiRejoinRoom(roomId) {
  return api('POST', '/rooms/' + encodeURIComponent(roomId) + '/rejoin');
}

async function apiAddParticipant(roomId, userId) {
  return api('POST', '/rooms/' + encodeURIComponent(roomId) + '/participants', { userId });
}

async function apiGetUnread(roomId) {
  return api('GET', '/rooms/' + encodeURIComponent(roomId) + '/unread');
}

async function apiGetLastMessage(roomId) {
  return api('GET', '/rooms/' + encodeURIComponent(roomId) + '/last-message');
}


// ────────────────────────────────────────
// Messages
// ────────────────────────────────────────

async function apiEditMessage(messageId, text) {
  return api('PATCH', '/messages/' + encodeURIComponent(messageId) + '/edit', { text });
}

async function apiDeleteMessage(messageId) {
  return api('DELETE', '/messages/' + encodeURIComponent(messageId));
}

async function apiForwardMessage(messageId, targetRoomId, clientMessageId) {
  return api('POST', '/messages/forward', { messageId, targetRoomId, clientMessageId });
}

async function apiReactMessage(messageId, emoji) {
  return api('POST', '/messages/' + encodeURIComponent(messageId) + '/react', { emoji });
}

async function apiGetReactions(messageId) {
  return api('GET', '/messages/' + encodeURIComponent(messageId) + '/reactions');
}

async function apiPinMessage(messageId, roomId) {
  return api('POST', '/messages/' + encodeURIComponent(messageId) + '/pin?roomId=' + encodeURIComponent(roomId));
}

async function apiUnpinMessage(messageId, roomId) {
  return api('DELETE', '/messages/' + encodeURIComponent(messageId) + '/pin?roomId=' + encodeURIComponent(roomId));
}

async function apiGetPinnedMessages(roomId) {
  return api('GET', '/messages/pinned/' + encodeURIComponent(roomId));
}

async function apiMarkMessagesRead(messageIds, roomId) {
  return api('POST', '/messages/read', { messageIds, roomId });
}

async function apiSearchMessages(q, roomId, limit) {
  let path = '/messages/search?q=' + encodeURIComponent(q) + '&limit=' + (limit || 20);
  if (roomId) path += '&roomId=' + encodeURIComponent(roomId);
  return api('GET', path);
}


// ────────────────────────────────────────
// Users
// ────────────────────────────────────────

async function apiGetProfile() { return api('GET', '/users/profile'); }
async function apiUpdateProfile(data) { return api('PATCH', '/users/profile', data); }

async function apiGetUser(userId) {
  if (Store.users[userId]) return Store.users[userId];
  const user = await api('GET', '/users/' + encodeURIComponent(userId));
  if (user && user.id) Store.users[user.id] = user;
  return user;
}

async function apiSearchUsers(q, limit) {
  return api('GET', '/users/search?q=' + encodeURIComponent(q) + '&limit=' + (limit || 20));
}

async function apiBlockUser(userId) { return api('POST', '/users/block', { userId }); }
async function apiUnblockUser(userId) { return api('DELETE', '/users/block/' + encodeURIComponent(userId)); }
async function apiGetBlocks() { return api('GET', '/users/blocks'); }
async function apiGetPresence(userIds) { return api('POST', '/users/presence', { userIds }); }


// ────────────────────────────────────────
// Groups
// ────────────────────────────────────────

async function apiGetGroupRoles(roomId) { return api('GET', '/groups/' + encodeURIComponent(roomId) + '/roles'); }
async function apiPromoteUser(roomId, userId) { return api('POST', '/groups/' + encodeURIComponent(roomId) + '/promote', { userId }); }
async function apiDemoteUser(roomId, userId) { return api('POST', '/groups/' + encodeURIComponent(roomId) + '/demote', { userId }); }
async function apiKickUser(roomId, userId) { return api('POST', '/groups/' + encodeURIComponent(roomId) + '/kick', { userId }); }
async function apiBanUser(roomId, userId) { return api('POST', '/groups/' + encodeURIComponent(roomId) + '/ban', { userId }); }
async function apiUpdateGroup(roomId, data) { return api('PATCH', '/groups/' + encodeURIComponent(roomId), data); }
