const express = require('express');
const { authRequired } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { publicUser } = require('../services/serialize');
const store = require('../services/store');
const hub = require('../ws/hub');

const router = express.Router();
router.use(authRequired);

router.get('/profile', (req, res) => {
  res.json(publicUser(store.getUserById(req.user.id)));
});

router.patch('/profile', (req, res, next) => {
  try {
    const u = store.getUserById(req.user.id);
    const displayName = req.body?.displayName !== undefined ? String(req.body.displayName) : u.displayName;
    const bio = req.body?.bio !== undefined ? String(req.body.bio) : u.bio;
    const avatarUrl = req.body?.avatarUrl !== undefined ? String(req.body.avatarUrl) : u.avatarUrl;
    store.db.prepare('UPDATE User SET displayName=?, bio=?, avatarUrl=?, updatedAt=? WHERE id=?')
      .run(displayName, bio, avatarUrl, store.now(), req.user.id);
    res.json(publicUser(store.getUserById(req.user.id)));
  } catch (e) { next(e); }
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  if (!q) return res.json([]);
  const users = store.db.prepare('SELECT * FROM User WHERE lower(username) LIKE ? LIMIT ?')
    .all('%' + q + '%', limit)
    .filter((u) => u.id !== req.user.id);
  res.json(users.map(publicUser));
});

router.get('/blocks', (req, res) => {
  const rows = store.db.prepare(
    'SELECT u.* FROM UserBlock b JOIN User u ON u.id = b.blockedId WHERE b.blockerId = ?'
  ).all(req.user.id);
  res.json(rows.map(publicUser));
});

router.post('/block', (req, res, next) => {
  try {
    const userId = req.body?.userId;
    if (!userId || userId === req.user.id) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid userId');
    try {
      store.db.prepare('INSERT INTO UserBlock (id,blockerId,blockedId,createdAt) VALUES (?,?,?,?)')
        .run(store.cuid(), req.user.id, userId, store.now());
    } catch {}
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/block/:id', (req, res) => {
  store.db.prepare('DELETE FROM UserBlock WHERE blockerId=? AND blockedId=?').run(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.post('/presence', (req, res) => {
  const userIds = req.body?.userIds || [];
  const out = {};
  for (const id of userIds) {
    const u = store.getUserById(id);
    if (!u) continue;
    out[id] = {
      status: hub.isOnline(id) ? 'online' : (u.status || 'offline'),
      lastSeenAt: u.lastSeenAt || null,
    };
  }
  res.json(out);
});

router.get('/:id', (req, res, next) => {
  if (['profile', 'search', 'blocks', 'block', 'presence'].includes(req.params.id)) return next();
  const u = store.getUserById(req.params.id);
  if (!u) return next(new AppError(404, 'USER_NOT_FOUND', 'Not found'));
  res.json(publicUser(u));
});

module.exports = router;
