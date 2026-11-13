// public/js/app.js
// COMBAIN v2 — application entry point


// ────────────────────────────────────────
// Initialization
// ────────────────────────────────────────

(async function init() {
  bindUI();

  if (Store.token) {
    try {
      const me = await apiMe();
      Store.userId = me.id;
      Store.username = me.username;
      localStorage.setItem('combain_user_id', me.id);
      localStorage.setItem('combain_username', me.username);
      await bootstrap();
      return;
    } catch (e) {
      console.warn('[APP] Saved session invalid:', e);
      clearAuth();
    }
  }
  showAuthScreen();
})();


// ────────────────────────────────────────
// Bootstrap after auth
// ────────────────────────────────────────

async function bootstrap() {
  showMainScreen();
  await Promise.all([loadRooms(), loadIceServers()]);
  await loadPresence();
  wsConnect();
  setupDragDrop();
  setupMessagePagination();
  renderMeName();
}

function renderMeName() {
  const el = document.getElementById('meName');
  if (el) el.textContent = Store.username || '';
}


// ────────────────────────────────────────
// Screen switching
// ────────────────────────────────────────

function showAuthScreen() {
  const auth = document.getElementById('auth-screen');
  const main = document.getElementById('main-screen');
  if (auth) auth.style.display = 'flex';
  if (main) main.style.display = 'none';
}

function showMainScreen() {
  const auth = document.getElementById('auth-screen');
  const main = document.getElementById('main-screen');
  if (auth) auth.style.display = 'none';
  if (main) main.style.display = 'flex';
}


// ────────────────────────────────────────
// Auth handlers
// ────────────────────────────────────────

async function doLogin(e) {
  if (e) e.preventDefault();
  const u = document.getElementById('lU')?.value;
  const p = document.getElementById('lP')?.value;
  const errEl = document.getElementById('lE');
  if (errEl) errEl.textContent = '';
  if (!u || !p) { if (errEl) errEl.textContent = 'Enter username and password'; return; }

  try {
    const data = await apiLogin(u, p);
    saveAuth(data.token, data.id, data.username);
    await bootstrap();
  } catch (err) {
    console.warn('[AUTH] Login failed:', err);
    if (errEl) errEl.textContent = err.message || err.error || 'Login failed';
  }
}

async function doReg(e) {
  if (e) e.preventDefault();
  const u = document.getElementById('rU')?.value;
  const p = document.getElementById('rP')?.value;
  const errEl = document.getElementById('rE');
  if (errEl) errEl.textContent = '';
  if (!u || !p) { if (errEl) errEl.textContent = 'Enter username and password'; return; }

  try {
    const data = await apiRegister(u, p);
    saveAuth(data.token, data.id, data.username);
    await bootstrap();
  } catch (err) {
    console.warn('[AUTH] Registration failed:', err);
    if (errEl) errEl.textContent = err.message || err.error || 'Registration failed';
  }
}

async function doLogout() {
  try { await apiLogout(); } catch {}
  wsDisconnect();
  cleanupCall();
  resetStore();
  clearAuth();
  showAuthScreen();
}

function resetStore() {
  Store.rooms = [];
  Store.activeRoomId = null;
  Store.messages = {};
  Store.typing = {};
  Store.users = {};
  Store.unreadCounts = {};
  Store.onlineUsers = new Set();
  Store.replyToId = null;
  Store.activeCallId = null;
  Store.searchQuery = '';
  Store.modalOpen = null;
  if (Store.peerConnection) { try { Store.peerConnection.close(); } catch {} }
  Store.peerConnection = null;
  Store.remoteStream = null;
}


// ────────────────────────────────────────
// Auth tab switching
// ────────────────────────────────────────

function swTab(tab) {
  const fL = document.getElementById('fL');
  const fR = document.getElementById('fR');
  if (fL) fL.classList.toggle('hidden', tab !== 'login');
  if (fR) fR.classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('.atab').forEach(b => {
    b.classList.toggle('on', b.textContent.includes(tab === 'login' ? 'Sign In' : 'Sign Up'));
  });
}


// ────────────────────────────────────────
// Presence loading
// ────────────────────────────────────────

async function loadPresence() {
  const userIds = new Set();
  Store.rooms.forEach(r => (r.participants || []).forEach(p => {
    if (p.userId !== Store.userId) userIds.add(p.userId);
  }));
  if (userIds.size === 0) return;
  try {
    const presence = await apiGetPresence([...userIds]);
    if (presence && typeof presence === 'object') {
      Object.entries(presence).forEach(([uid, info]) => {
        if (info.status === 'online') Store.onlineUsers.add(uid);
        else Store.onlineUsers.delete(uid);
      });
    }
    renderRooms();
  } catch {}
}


// ────────────────────────────────────────
// UI binding
// ────────────────────────────────────────

function bindUI() {
  bindStaticUI();
  setupDelegatedActions();
  // Escape closes everything
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      hideMsgCtx();
      hideImageModal();
      if (Store.modalOpen) closeModal();
    }
  });
}

function bindStaticUI() {
  const loginForm = document.getElementById('fL');
  const regForm = document.getElementById('fR');
  if (loginForm) loginForm.addEventListener('submit', doLogin);
  if (regForm) regForm.addEventListener('submit', doReg);

  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  if (msgInput) {
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessageFromInput(); }
      else startTyping();
    });
  }
  if (sendBtn) sendBtn.addEventListener('click', sendMessageFromInput);

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', e => { Store.searchQuery = e.target.value; renderRooms(); });
  }
}

function sendMessageFromInput() {
  const input = document.getElementById('msgInput');
  const text = input?.value;
  if (!text || !text.trim()) return;
  sendTextMessage(text, Store.replyToId || null);
  input.value = '';
  Store.replyToId = null;
  const bar = document.getElementById('replyBar');
  if (bar) bar.classList.add('hidden');
}


// ────────────────────────────────────────
// New room modal
// ────────────────────────────────────────

const nrSelected = new Set();

async function searchUsersModal() {
  const q = document.getElementById('nrSearch')?.value;
  const el = document.getElementById('nrResults');
  if (!q?.trim()) { if (el) el.innerHTML = ''; return; }
  try {
    const users = await apiSearchUsers(q);
    if (!el) return;
    el.innerHTML = users.map(u =>
      `<div class="nr-user" data-uid="${escHtml(u.id)}">
        ${escHtml(u.username)} ${nrSelected.has(u.id) ? '✓' : ''}
      </div>`
    ).join('');
  } catch {}
}

function toggleNrUser(id, el) {
  if (nrSelected.has(id)) nrSelected.delete(id); else nrSelected.add(id);
  const base = el.textContent.replace(' \u2713', '').trim();
  el.textContent = base + (nrSelected.has(id) ? ' \u2713' : '');
}

function createDirectFromModal() {
  if (nrSelected.size !== 1) { toast('Select exactly one user for direct chat', 'fail'); return; }
  createDirectRoom([...nrSelected][0]);
  nrSelected.clear();
}

function createGroupFromModal() {
  const name = document.getElementById('nrGroupName')?.value?.trim();
  if (!name) { toast('Enter group name', 'fail'); return; }
  if (nrSelected.size < 1) { toast('Select at least one user', 'fail'); return; }
  createGroupRoom(name, [...nrSelected]);
  nrSelected.clear();
}


// ────────────────────────────────────────
// Profile modal
// ────────────────────────────────────────

async function openProfile() {
  try {
    const p = await apiGetProfile();
    const el = document.getElementById('mpBody');
    if (el) {
      el.innerHTML = `
        <div><strong>Username:</strong> ${escHtml(p.username)}</div>
        <div><strong>Display Name:</strong> ${escHtml(p.displayName || '—')}</div>
        <div><strong>Bio:</strong> ${escHtml(p.bio || '—')}</div>
        <div><strong>Balance:</strong> ${p.balance ?? 0}</div>
      `;
    }
    openM('mp');
  } catch (e) { toast('Failed to load profile', 'fail'); }
}
