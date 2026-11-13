const express = require('express');
const { authRequired } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const store = require('../services/store');
const { serializeRoom, publicUser } = require('../services/serialize');
const hub = require('../ws/hub');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res, next) => {
  try { res.json(store.listRoomsForUser(req.user.id)); } catch (e) { next(e); }
});

router.post('/', (req, res, next) => {
  try {
    res.status(201).json(store.createRoom(req.user.id, {
      type: req.body?.type,
      participantIds: req.body?.participantIds || [],
      name: req.body?.name,
    }));
  } catch (e) { next(e); }
});

router.get('/:id/messages', (req, res, next) => {
  try {
    res.json(store.getMessages(req.params.id, req.user.id, {
      cursor: req.query.cursor, limit: req.query.limit,
    }));
  } catch (e) { next(e); }
});

router.get('/:id/participants', (req, res, next) => {
  try {
    store.requireMember(req.params.id, req.user.id);
    const members = store.loadRoomMembers(req.params.id).filter((m) => !m.leftAt);
    res.json(members.map((m) => ({ userId: m.userId, role: m.role, user: publicUser(m) })));
  } catch (e) { next(e); }
});

router.post('/:id/leave', (req, res, next) => {
  try {
    store.requireMember(req.params.id, req.user.id);
    store.db.prepare('UPDATE RoomMember SET leftAt = ? WHERE roomId = ? AND userId = ?')
      .run(store.now(), req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/rejoin', (req, res, next) => {
  try {
    if (store.db.prepare('SELECT id FROM GroupBan WHERE roomId=? AND userId=?').get(req.params.id, req.user.id))
      throw new AppError(403, 'FORBIDDEN', 'Banned');
    const m = store.db.prepare('SELECT * FROM RoomMember WHERE roomId=? AND userId=?').get(req.params.id, req.user.id);
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Not a member');
    store.db.prepare('UPDATE RoomMember SET leftAt = NULL WHERE id = ?').run(m.id);
    const loaded = store.loadRoom(req.params.id);
    res.json(serializeRoom(loaded.room, loaded.members));
  } catch (e) { next(e); }
});

router.post('/:id/participants', (req, res, next) => {
  try {
    const me = store.requireMember(req.params.id, req.user.id);
    const room = store.db.prepare('SELECT type FROM Room WHERE id = ? AND deletedAt IS NULL').get(req.params.id);
    if (!room) throw new AppError(404, 'NOT_FOUND', 'Room not found');
    // Спека §4.1: direct-комната неизменяема — состав задаётся при создании.
    // Проверяем ТИП раньше роли: 405 про сам ресурс, а не про права
    if (room.type === 'direct') {
      throw new AppError(405, 'DIRECT_ROOM_IMMUTABLE', 'Cannot add participants to a direct room');
    }
    if (me.role !== 'owner' && me.role !== 'admin') throw new AppError(403, 'ROLE_REQUIRED', 'Admin required');
    const userId = req.body?.userId;
    if (!userId) throw new AppError(400, 'VALIDATION_ERROR', 'userId required');
    const existing = store.db.prepare('SELECT * FROM RoomMember WHERE roomId=? AND userId=?').get(req.params.id, userId);
    if (existing) store.db.prepare('UPDATE RoomMember SET leftAt=NULL WHERE id=?').run(existing.id);
    else store.db.prepare('INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)')
      .run(store.cuid(), req.params.id, userId, 'member', store.now());
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/invites', (req, res, next) => {
  try {
    const invite = store.createInvite(req.params.id, req.user.id, req.body?.userId);
    // Мгновенный пуш приглашённому (онлайн-уведомление; оффлайн заберёт GET /users/invites)
    hub.sendToUser(invite.inviteeId, {
      type: 'room_invited',
      payload: { inviteId: invite.id, roomId: invite.roomId, inviterId: invite.inviterId, createdAt: invite.createdAt },
    });
    res.status(201).json(invite);
  } catch (e) { next(e); }
});

router.get('/:id/unread', (req, res, next) => {
  try {
    store.requireMember(req.params.id, req.user.id);
    const msgs = store.db.prepare('SELECT id FROM Message WHERE roomId=? AND authorId!=? AND deletedAt IS NULL')
      .all(req.params.id, req.user.id);
    let unread = 0;
    for (const m of msgs) {
      if (!store.db.prepare('SELECT id FROM MessageRead WHERE messageId=? AND userId=?').get(m.id, req.user.id)) unread++;
    }
    res.json({ count: unread });
  } catch (e) { next(e); }
});

router.get('/:id/last-message', (req, res, next) => {
  try {
    store.requireMember(req.params.id, req.user.id);
    const m = store.db.prepare('SELECT * FROM Message WHERE roomId=? ORDER BY createdAt DESC LIMIT 1').get(req.params.id);
    res.json(m ? store.messageWithAuthor(m) : null);
  } catch (e) { next(e); }
});

module.exports = router;
