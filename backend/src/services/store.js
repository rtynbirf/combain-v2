const { db, cuid } = require('../db');
const { AppError } = require('../utils/errors');
const { publicUser, serializeMessage, serializeRoom } = require('./serialize');

const now = () => new Date().toISOString();

function getUserById(id) {
  return db.prepare('SELECT * FROM User WHERE id = ?').get(id);
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM User WHERE username = ?').get(username);
}

function requireMember(roomId, userId) {
  const m = db.prepare('SELECT * FROM RoomMember WHERE roomId = ? AND userId = ?').get(roomId, userId);
  if (!m || m.leftAt) throw new AppError(403, 'NOT_MEMBER', 'Not a room member');
  return m;
}

function getReactions(messageId) {
  return db.prepare('SELECT * FROM MessageReaction WHERE messageId = ?').all(messageId);
}

function messageWithAuthor(m) {
  if (!m) return null;
  const author = getUserById(m.authorId);
  return serializeMessage({ ...m, authorUsername: author?.username }, getReactions(m.id));
}

function loadRoomMembers(roomId) {
  return db.prepare(`
    SELECT rm.*, u.username, u.displayName, u.bio, u.avatarUrl
    FROM RoomMember rm JOIN User u ON u.id = rm.userId
    WHERE rm.roomId = ?
  `).all(roomId);
}

function loadRoom(roomId) {
  const room = db.prepare('SELECT * FROM Room WHERE id = ? AND deletedAt IS NULL').get(roomId);
  if (!room) return null;
  return { room, members: loadRoomMembers(roomId) };
}

function listRoomsForUser(userId) {
  const rows = db.prepare(`
    SELECT r.* FROM Room r
    JOIN RoomMember rm ON rm.roomId = r.id
    WHERE rm.userId = ? AND rm.leftAt IS NULL AND r.deletedAt IS NULL
    ORDER BY r.updatedAt DESC
  `).all(userId);
  // Непрочитанные одним запросом на все комнаты: не мои, не удалённые, без моего MessageRead
  const unreadByRoom = Object.fromEntries(
    db.prepare(`
      SELECT m.roomId, COUNT(*) AS cnt
      FROM Message m
      JOIN RoomMember rm ON rm.roomId = m.roomId AND rm.userId = ? AND rm.leftAt IS NULL
      WHERE m.authorId != ? AND m.deletedAt IS NULL
        AND NOT EXISTS (SELECT 1 FROM MessageRead mr WHERE mr.messageId = m.id AND mr.userId = ?)
      GROUP BY m.roomId
    `).all(userId, userId, userId).map((r) => [r.roomId, r.cnt])
  );
  return rows.map((r) => {
    const members = loadRoomMembers(r.id);
    return serializeRoom(r, members, unreadByRoom[r.id] || 0);
  });
}

function createRoom(creatorId, { type, participantIds, name }) {
  const ts = now();
  if (type === 'direct') {
    const other = (participantIds || []).find((id) => id !== creatorId);
    if (!other) throw new AppError(400, 'VALIDATION_ERROR', 'Need participant');
    // find existing
    const rooms = db.prepare(`SELECT r.id FROM Room r WHERE r.type = 'direct' AND r.deletedAt IS NULL`).all();
    for (const { id } of rooms) {
      const members = db.prepare('SELECT userId FROM RoomMember WHERE roomId = ? AND leftAt IS NULL').all(id).map((m) => m.userId);
      if (members.length === 2 && members.includes(creatorId) && members.includes(other)) {
        const loaded = loadRoom(id);
        return serializeRoom(loaded.room, loaded.members);
      }
    }
    const roomId = cuid();
    const create = db.transaction(() => {
      db.prepare(`INSERT INTO Room (id,type,name,createdById,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`)
        .run(roomId, 'direct', null, creatorId, ts, ts);
      db.prepare(`INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)`)
        .run(cuid(), roomId, creatorId, 'member', ts);
      db.prepare(`INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)`)
        .run(cuid(), roomId, other, 'member', ts);
    });
    create();
    const loaded = loadRoom(roomId);
    return serializeRoom(loaded.room, loaded.members);
  }
  if (type === 'group') {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new AppError(400, 'VALIDATION_ERROR', 'Group name required');
    const roomId = cuid();
    const ids = [...new Set([creatorId, ...(participantIds || [])])];
    const create = db.transaction(() => {
      db.prepare(`INSERT INTO Room (id,type,name,createdById,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`)
        .run(roomId, 'group', cleanName, creatorId, ts, ts);
      for (const uid of ids) {
        const role = uid === creatorId ? 'owner' : 'member';
        db.prepare(`INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,?,?)`)
          .run(cuid(), roomId, uid, role, ts);
      }
    });
    create();
    const loaded = loadRoom(roomId);
    return serializeRoom(loaded.room, loaded.members);
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid room type');
}

function encodeCursor(m) {
  return Buffer.from(`${m.createdAt}|${m.id}`).toString('base64url');
}

function getMessages(roomId, userId, { cursor, limit = 50 } = {}) {
  requireMember(roomId, userId);
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  let rows;
  if (cursor) {
    let createdAt, id;
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      // cursor строго вида "<ISO createdAt>|<message id>" — иначе мусор декодируется
      // молча и отдаёт пустую страницу вместо ошибки
      const sep = raw.lastIndexOf('|');
      if (sep === -1) throw new Error('no separator');
      createdAt = raw.slice(0, sep);
      id = raw.slice(sep + 1);
      const isoOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(createdAt) && !Number.isNaN(Date.parse(createdAt));
      if (!isoOk || !id) throw new Error('bad cursor parts');
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
    }
    rows = db.prepare(`
      SELECT * FROM Message WHERE roomId = ?
        AND (createdAt < ? OR (createdAt = ? AND id < ?))
      ORDER BY createdAt DESC, id DESC LIMIT ?
    `).all(roomId, createdAt, createdAt, id, take + 1);
  } else {
    rows = db.prepare(`
      SELECT * FROM Message WHERE roomId = ?
      ORDER BY createdAt DESC, id DESC LIMIT ?
    `).all(roomId, take + 1);
  }
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    messages: page.map((m) => messageWithAuthor(m)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

function createMessage(authorId, data) {
  requireMember(data.roomId, authorId);
  if (data.clientMessageId) {
    const existing = db.prepare(
      'SELECT * FROM Message WHERE roomId = ? AND clientMessageId = ?'
    ).get(data.roomId, data.clientMessageId);
    if (existing) return messageWithAuthor(existing);
  }
  const id = cuid();
  const ts = now();
  db.prepare(`
    INSERT INTO Message (id,roomId,authorId,type,text,clientMessageId,replyToId,fileUrl,fileName,fileSize,fileMimeType,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, data.roomId, authorId, data.type || 'text', data.text ?? null,
    data.clientMessageId || null, data.replyToId || null,
    data.fileUrl || null, data.fileName || null, data.fileSize ?? null, data.fileMimeType || null,
    ts
  );
  db.prepare('UPDATE Room SET updatedAt = ? WHERE id = ?').run(ts, data.roomId);
  return messageWithAuthor(db.prepare('SELECT * FROM Message WHERE id = ?').get(id));
}

function editMessage(userId, messageId, text) {
  const msg = db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId);
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  if (msg.authorId !== userId) throw new AppError(403, 'FORBIDDEN', 'Not author');
  const ts = now();
  db.prepare('UPDATE Message SET text = ?, editedAt = ? WHERE id = ?').run(String(text), ts, messageId);
  return messageWithAuthor(db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId));
}

function softDeleteMessage(userId, messageId) {
  const msg = db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId);
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  const member = db.prepare('SELECT * FROM RoomMember WHERE roomId = ? AND userId = ?').get(msg.roomId, userId);
  const isAdmin = member && !member.leftAt && (member.role === 'admin' || member.role === 'owner');
  if (msg.authorId !== userId && !isAdmin) throw new AppError(403, 'FORBIDDEN', 'Forbidden');
  const ts = now();
  db.prepare('UPDATE Message SET deletedAt = ?, text = NULL WHERE id = ?').run(ts, messageId);
  return messageWithAuthor(db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId));
}

function toggleReaction(userId, messageId, emoji) {
  const msg = db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId);
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  requireMember(msg.roomId, userId);
  const existing = db.prepare(
    'SELECT * FROM MessageReaction WHERE messageId = ? AND userId = ? AND emoji = ?'
  ).get(messageId, userId, emoji);
  let added;
  if (existing) {
    db.prepare('DELETE FROM MessageReaction WHERE id = ?').run(existing.id);
    added = false;
  } else {
    db.prepare(
      'INSERT INTO MessageReaction (id,messageId,userId,emoji,createdAt) VALUES (?,?,?,?,?)'
    ).run(cuid(), messageId, userId, emoji, now());
    added = true;
  }
  const reactions = getReactions(messageId);
  const map = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push(r.userId);
  }
  return { messageId, userId, emoji, added, reactions: map, roomId: msg.roomId };
}

module.exports = {
  getUserById,
  getUserByUsername,
  requireMember,
  loadRoom,
  loadRoomMembers,
  listRoomsForUser,
  createRoom,
  getMessages,
  createMessage,
  editMessage,
  softDeleteMessage,
  toggleReaction,
  messageWithAuthor,
  now,
  cuid: require('../db').cuid,
  db,
};
