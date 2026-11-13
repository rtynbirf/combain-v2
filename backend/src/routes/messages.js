const express = require('express');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const store = require('../services/store');
const hub = require('../ws/hub');

const router = express.Router();
if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => {
      cb(null, Date.now() + '_' + (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_'));
    },
  }),
  limits: { fileSize: config.maxFileSize },
});

router.post('/upload', authRequired, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', 'File too large'));
      return next(err);
    }
    try {
      if (!req.file) throw new AppError(400, 'VALIDATION_ERROR', 'No file');
      const url = '/uploads/' + req.file.filename;
      store.db.prepare(`INSERT INTO UploadedFile (id,uploaderId,url,fileName,fileSize,mimeType,storageKey,createdAt)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        store.cuid(), req.user.id, url, req.file.originalname || req.file.filename,
        req.file.size, req.file.mimetype || 'application/octet-stream', req.file.filename, store.now()
      );
      res.json({
        url, fileName: req.file.originalname || req.file.filename,
        fileSize: req.file.size, mimeType: req.file.mimetype || 'application/octet-stream',
      });
    } catch (e) { next(e); }
  });
});

router.use(authRequired);

router.patch('/:id/edit', (req, res, next) => {
  try {
    const msg = store.editMessage(req.user.id, req.params.id, req.body?.text);
    hub.broadcastToRoom(msg.roomId, { type: 'message_edited', payload: { id: msg.id, text: msg.text, editedAt: msg.editedAt } });
    res.json(msg);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const msg = store.softDeleteMessage(req.user.id, req.params.id);
    hub.broadcastToRoom(msg.roomId, { type: 'message_deleted', payload: { id: msg.id, deletedAt: msg.deletedAt } });
    res.json(msg);
  } catch (e) { next(e); }
});

router.post('/forward', (req, res, next) => {
  try {
    const { messageId, targetRoomId, clientMessageId } = req.body || {};
    const msg = store.forwardMessage(req.user.id, { messageId, targetRoomId, clientMessageId });
    hub.broadcastToRoom(targetRoomId, { type: 'chat_message', requestId: clientMessageId, payload: msg });
    res.json(msg);
  } catch (e) { next(e); }
});

router.post('/:id/react', (req, res, next) => {
  try {
    const result = store.toggleReaction(req.user.id, req.params.id, String(req.body?.emoji || '👍'));
    hub.broadcastToRoom(result.roomId, {
      type: 'message_reaction',
      payload: { messageId: result.messageId, userId: result.userId, emoji: result.emoji, added: result.added, reactions: result.reactions },
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id/reactions', (req, res) => {
  const reactions = store.db.prepare('SELECT * FROM MessageReaction WHERE messageId=?').all(req.params.id);
  const map = {};
  for (const r of reactions) { if (!map[r.emoji]) map[r.emoji] = []; map[r.emoji].push(r.userId); }
  res.json(map);
});

router.post('/:id/pin', (req, res, next) => {
  try {
    const roomId = req.query.roomId;
    const me = store.requireMember(roomId, req.user.id);
    if (me.role !== 'owner' && me.role !== 'admin') throw new AppError(403, 'ROLE_REQUIRED', 'Admin required');
    const ts = store.now();
    const existing = store.db.prepare('SELECT id FROM PinnedMessage WHERE roomId=? AND messageId=?').get(roomId, req.params.id);
    if (!existing) {
      store.db.prepare('INSERT INTO PinnedMessage (id,roomId,messageId,pinnedBy,pinnedAt) VALUES (?,?,?,?,?)')
        .run(store.cuid(), roomId, req.params.id, req.user.id, ts);
    }
    hub.broadcastToRoom(roomId, { type: 'message_pinned', payload: { messageId: req.params.id, pinnedBy: req.user.id, pinnedAt: ts } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/pin', (req, res, next) => {
  try {
    store.requireMember(req.query.roomId, req.user.id);
    store.db.prepare('DELETE FROM PinnedMessage WHERE roomId=? AND messageId=?').run(req.query.roomId, req.params.id);
    hub.broadcastToRoom(req.query.roomId, { type: 'message_unpinned', payload: { messageId: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/pinned/:roomId', (req, res, next) => {
  try {
    store.requireMember(req.params.roomId, req.user.id);
    const pins = store.db.prepare('SELECT messageId FROM PinnedMessage WHERE roomId=?').all(req.params.roomId);
    res.json(pins.map((p) => store.messageWithAuthor(store.db.prepare('SELECT * FROM Message WHERE id=?').get(p.messageId))).filter(Boolean));
  } catch (e) { next(e); }
});

router.post('/read', (req, res, next) => {
  try {
    const { messageIds, roomId } = req.body || {};
    // Phase 2: верхний потолок пакета прочтения — иначе один запрос может завалить и БД, и broadcast
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'messageIds required');
    }
    if (messageIds.length > 500) {
      throw new AppError(400, 'VALIDATION_ERROR', 'messageIds limited to 500 per request');
    }
    store.requireMember(roomId, req.user.id);
    let count = 0;
    for (const mid of messageIds || []) {
      try {
        store.db.prepare('INSERT INTO MessageRead (id,messageId,userId,readAt) VALUES (?,?,?,?)')
          .run(store.cuid(), mid, req.user.id, store.now());
        count++;
      } catch {}
    }
    hub.broadcastToRoom(roomId, { type: 'messages_read', payload: { userId: req.user.id, messageIds } }, req.user.id);
    res.json({ readCount: count });
  } catch (e) { next(e); }
});

router.get('/search', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const roomId = req.query.roomId;
    if (roomId) store.requireMember(roomId, req.user.id);
    const memberships = store.db.prepare('SELECT roomId FROM RoomMember WHERE userId=? AND leftAt IS NULL').all(req.user.id).map((m) => m.roomId);
    let sql = "SELECT * FROM Message WHERE deletedAt IS NULL AND text LIKE ?";
    const params = ['%' + q + '%'];
    if (roomId) { sql += ' AND roomId=?'; params.push(roomId); }
    else if (memberships.length) {
      sql += ' AND roomId IN (' + memberships.map(() => '?').join(',') + ')';
      params.push(...memberships);
    } else return res.json([]);
    sql += ' ORDER BY createdAt DESC LIMIT ?'; params.push(limit);
    res.json(store.db.prepare(sql).all(...params).map((m) => store.messageWithAuthor(m)));
  } catch (e) { next(e); }
});

module.exports = router;
