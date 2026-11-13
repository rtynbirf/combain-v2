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
    // Phase 2: быстрый поиск пары по pairKey (отсортированные id через ':'), было — скан всех direct-комнат
    const pairKey = [creatorId, other].sort().join(':');
    const candidates = db
      .prepare("SELECT id FROM Room WHERE type='direct' AND pairKey = ? AND deletedAt IS NULL")
      .all(pairKey);
    for (const { id } of candidates) {
      const members = db.prepare('SELECT userId FROM RoomMember WHERE roomId = ? AND leftAt IS NULL').all(id).map((m) => m.userId);
      if (members.length === 2 && members.includes(creatorId) && members.includes(other)) {
        const loaded = loadRoom(id);
        return serializeRoom(loaded.room, loaded.members);
      }
    }
    const roomId = cuid();
    const create = db.transaction(() => {
      db.prepare(`INSERT INTO Room (id,type,name,pairKey,createdById,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
        .run(roomId, 'direct', null, pairKey, creatorId, ts, ts);
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
  // Phase 3b: бизнес-счётчик созданных сообщений (REST + WS, идемпотентные повторы не считаются)
  try { require('./metrics').incMessage(); } catch {}
  const id = cuid();
  const ts = now();
  db.prepare(`
    INSERT INTO Message (id,roomId,authorId,type,text,clientMessageId,replyToId,fileUrl,fileName,fileSize,fileMimeType,forwardFromMessageId,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, data.roomId, authorId, data.type || 'text', data.text ?? null,
    data.clientMessageId || null, data.replyToId || null,
    data.fileUrl || null, data.fileName || null, data.fileSize ?? null, data.fileMimeType || null,
    data.forwardFromMessageId || null,
    ts
  );
  db.prepare('UPDATE Room SET updatedAt = ? WHERE id = ?').run(ts, data.roomId);
  return messageWithAuthor(db.prepare('SELECT * FROM Message WHERE id = ?').get(id));
}

// Phase 2: единая логика форварда для REST и WS. Провенанс всегда на первоисточник:
// форвард форварда указывает на исходное сообщение, цепочки не растут
function forwardMessage(userId, { messageId, targetRoomId, clientMessageId }) {
  const src = db.prepare('SELECT * FROM Message WHERE id = ?').get(messageId);
  if (!src) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  requireMember(src.roomId, userId);
  requireMember(targetRoomId, userId);
  return createMessage(userId, {
    roomId: targetRoomId, type: src.type, text: src.text, clientMessageId,
    fileUrl: src.fileUrl, fileName: src.fileName, fileSize: src.fileSize, fileMimeType: src.fileMimeType,
    forwardFromMessageId: src.forwardFromMessageId || src.id,
  });
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

// ── Phase 2: RoomInvite ────────────────────────────────────────────────

// Пригласить в группу. Direct-комнаты неизменяемы (405, как POST /rooms/:id/participants).
// Повторное приглашение: pending — идемпотентно, accepted/declined — возобновляется в pending.
function createInvite(roomId, inviterId, inviteeId) {
  if (!inviteeId || inviteeId === inviterId) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid invitee');
  const room = db.prepare('SELECT type FROM Room WHERE id = ? AND deletedAt IS NULL').get(roomId);
  if (!room) throw new AppError(404, 'NOT_FOUND', 'Room not found');
  if (room.type === 'direct') throw new AppError(405, 'DIRECT_ROOM_IMMUTABLE', 'Direct rooms need no invites');
  requireMember(roomId, inviterId);
  const invitee = db.prepare('SELECT id, deletedAt FROM User WHERE id = ?').get(inviteeId);
  if (!invitee || invitee.deletedAt) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const member = db.prepare('SELECT * FROM RoomMember WHERE roomId = ? AND userId = ?').get(roomId, inviteeId);
  if (member && !member.leftAt) throw new AppError(409, 'ALREADY_MEMBER', 'Already a member');
  const blocked = db.prepare(
    'SELECT id FROM UserBlock WHERE (blockerId = ? AND blockedId = ?) OR (blockerId = ? AND blockedId = ?)'
  ).get(inviterId, inviteeId, inviteeId, inviterId);
  if (blocked) throw new AppError(403, 'BLOCKED', 'Invite blocked');
  const ts = now();
  const existing = db.prepare('SELECT * FROM RoomInvite WHERE roomId = ? AND inviteeId = ?').get(roomId, inviteeId);
  if (existing) {
    if (existing.status === 'pending') return existing;
    db.prepare("UPDATE RoomInvite SET status = 'pending', inviterId = ?, createdAt = ? WHERE id = ?")
      .run(inviterId, ts, existing.id);
    return { ...existing, status: 'pending', inviterId, createdAt: ts };
  }
  const inv = { id: cuid(), roomId, inviterId, inviteeId, status: 'pending', createdAt: ts };
  db.prepare('INSERT INTO RoomInvite (id,roomId,inviterId,inviteeId,status,createdAt) VALUES (?,?,?,?,?,?)')
    .run(inv.id, inv.roomId, inv.inviterId, inv.inviteeId, inv.status, inv.createdAt);
  return inv;
}

function listInvites(userId) {
  return db.prepare(`
    SELECT i.id, i.roomId, i.inviterId, i.inviteeId, i.status, i.createdAt,
           u.username AS inviterUsername, r.name AS roomName, r.type AS roomType
    FROM RoomInvite i
    JOIN User u ON u.id = i.inviterId
    JOIN Room r ON r.id = i.roomId
    WHERE i.inviteeId = ? AND i.status = 'pending'
    ORDER BY i.createdAt DESC
  `).all(userId);
}

function acceptInvite(userId, inviteId) {
  const inv = db.prepare('SELECT * FROM RoomInvite WHERE id = ?').get(inviteId);
  // Чужое приглашение — тот же 404, что и несуществующее (без утечки перечисления)
  if (!inv || inv.inviteeId !== userId) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
  if (inv.status !== 'pending') throw new AppError(409, 'INVITE_NOT_PENDING', `Invite is ${inv.status}`);
  const room = db.prepare('SELECT id FROM Room WHERE id = ? AND deletedAt IS NULL').get(inv.roomId);
  if (!room) throw new AppError(404, 'NOT_FOUND', 'Room not found');
  if (db.prepare('SELECT id FROM GroupBan WHERE roomId = ? AND userId = ?').get(inv.roomId, userId)) {
    throw new AppError(403, 'FORBIDDEN', 'Banned in this room');
  }
  const ts = now();
  const member = db.prepare('SELECT * FROM RoomMember WHERE roomId = ? AND userId = ?').get(inv.roomId, userId);
  db.transaction(() => {
    if (member) db.prepare('UPDATE RoomMember SET leftAt = NULL WHERE id = ?').run(member.id);
    else db.prepare("INSERT INTO RoomMember (id,roomId,userId,role,joinedAt) VALUES (?,?,?,'member',?)")
      .run(cuid(), inv.roomId, userId, ts);
    db.prepare("UPDATE RoomInvite SET status = 'accepted' WHERE id = ?").run(inv.id);
  })();
  const loaded = loadRoom(inv.roomId);
  return serializeRoom(loaded.room, loaded.members);
}

function declineInvite(userId, inviteId) {
  const inv = db.prepare('SELECT * FROM RoomInvite WHERE id = ?').get(inviteId);
  if (!inv || inv.inviteeId !== userId) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
  if (inv.status !== 'pending') throw new AppError(409, 'INVITE_NOT_PENDING', `Invite is ${inv.status}`);
  db.prepare("UPDATE RoomInvite SET status = 'declined' WHERE id = ?").run(inv.id);
  return { ok: true };
}

// ── Phase 2: мягкое удаление пользователя (GDPR-минимум) ───────────────

// Профиль обезличивается, токены мертвы через authRequired (deletedAt),
// username резервируется — история сообщений сохраняет автора без переатрибуции
function softDeleteUser(userId) {
  const u = getUserById(userId);
  if (!u || u.deletedAt) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const ts = now();
  db.transaction(() => {
    db.prepare("UPDATE User SET deletedAt = ?, displayName = NULL, bio = NULL, avatarUrl = NULL, status = 'offline', updatedAt = ? WHERE id = ?")
      .run(ts, ts, userId);
    db.prepare('UPDATE RoomMember SET leftAt = ? WHERE userId = ? AND leftAt IS NULL').run(ts, userId);
    db.prepare("DELETE FROM RoomInvite WHERE inviteeId = ? AND status = 'pending'").run(userId);
    db.prepare("UPDATE RoomInvite SET status = 'declined' WHERE inviterId = ? AND status = 'pending'").run(userId);
  })();
  return { ok: true };
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
  forwardMessage,
  editMessage,
  softDeleteMessage,
  toggleReaction,
  createInvite,
  listInvites,
  acceptInvite,
  declineInvite,
  softDeleteUser,
  messageWithAuthor,
  now,
  cuid: require('../db').cuid,
  db,
};
