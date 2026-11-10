const express = require('express');
const { authRequired } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const store = require('../services/store');
const { serializeRoom } = require('../services/serialize');

const router = express.Router();
router.use(authRequired);

function requireAdmin(roomId, userId) {
  const m = store.requireMember(roomId, userId);
  if (m.role !== 'owner' && m.role !== 'admin') throw new AppError(403, 'ROLE_REQUIRED', 'Admin required');
  return m;
}

router.get('/:roomId/roles', (req, res, next) => {
  try {
    store.requireMember(req.params.roomId, req.user.id);
    const members = store.db.prepare('SELECT userId, role FROM RoomMember WHERE roomId=? AND leftAt IS NULL')
      .all(req.params.roomId);
    const map = {};
    for (const m of members) map[m.userId] = m.role;
    res.json(map);
  } catch (e) { next(e); }
});

router.post('/:roomId/promote', (req, res, next) => {
  try {
    const me = requireAdmin(req.params.roomId, req.user.id);
    if (me.role !== 'owner') throw new AppError(403, 'ROLE_REQUIRED', 'Owner only');
    store.db.prepare('UPDATE RoomMember SET role=? WHERE roomId=? AND userId=?')
      .run('admin', req.params.roomId, req.body.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:roomId/demote', (req, res, next) => {
  try {
    requireAdmin(req.params.roomId, req.user.id);
    store.db.prepare('UPDATE RoomMember SET role=? WHERE roomId=? AND userId=?')
      .run('member', req.params.roomId, req.body.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:roomId/kick', (req, res, next) => {
  try {
    requireAdmin(req.params.roomId, req.user.id);
    store.db.prepare('UPDATE RoomMember SET leftAt=? WHERE roomId=? AND userId=?')
      .run(store.now(), req.params.roomId, req.body.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:roomId/ban', (req, res, next) => {
  try {
    requireAdmin(req.params.roomId, req.user.id);
    const userId = req.body.userId;
    try {
      store.db.prepare('INSERT INTO GroupBan (id,roomId,userId,bannedBy,createdAt) VALUES (?,?,?,?,?)')
        .run(store.cuid(), req.params.roomId, userId, req.user.id, store.now());
    } catch {}
    store.db.prepare('UPDATE RoomMember SET leftAt=? WHERE roomId=? AND userId=?')
      .run(store.now(), req.params.roomId, userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:roomId', (req, res, next) => {
  try {
    requireAdmin(req.params.roomId, req.user.id);
    const room = store.db.prepare('SELECT * FROM Room WHERE id=?').get(req.params.roomId);
    const name = req.body?.name !== undefined ? String(req.body.name) : room.name;
    const description = req.body?.description !== undefined ? String(req.body.description) : room.description;
    const avatarUrl = req.body?.avatarUrl !== undefined ? String(req.body.avatarUrl) : room.avatarUrl;
    store.db.prepare('UPDATE Room SET name=?, description=?, avatarUrl=?, updatedAt=? WHERE id=?')
      .run(name, description, avatarUrl, store.now(), req.params.roomId);
    const loaded = store.loadRoom(req.params.roomId);
    res.json(serializeRoom(loaded.room, loaded.members));
  } catch (e) { next(e); }
});

module.exports = router;
