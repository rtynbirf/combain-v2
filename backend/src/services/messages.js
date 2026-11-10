const { prisma } = require('../db');
const { AppError } = require('../utils/errors');
const { serializeMessage } = require('./serialize');
const { requireMember } = require('./rooms');

const MSG_INCLUDE = {
  author: true,
  reactions: true,
};

function encodeCursor(m) {
  return Buffer.from(`${m.createdAt.toISOString()}|${m.id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    return { createdAt: new Date(iso), id };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
  }
}

async function getMessages(roomId, userId, { cursor, limit = 50 } = {}) {
  await requireMember(roomId, userId);
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const where = { roomId };
  if (cursor) {
    const c = decodeCursor(cursor);
    where.OR = [
      { createdAt: { lt: c.createdAt } },
      { createdAt: c.createdAt, id: { lt: c.id } },
    ];
  }
  const rows = await prisma.message.findMany({
    where,
    include: MSG_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;
  return {
    messages: page.map(serializeMessage),
    nextCursor,
  };
}

async function createMessage(authorId, data) {
  await requireMember(data.roomId, authorId);
  if (data.clientMessageId) {
    const existing = await prisma.message.findFirst({
      where: { roomId: data.roomId, clientMessageId: data.clientMessageId },
      include: MSG_INCLUDE,
    });
    if (existing) return serializeMessage(existing);
  }
  const msg = await prisma.message.create({
    data: {
      roomId: data.roomId,
      authorId,
      type: data.type || 'text',
      text: data.text ?? null,
      clientMessageId: data.clientMessageId || null,
      replyToId: data.replyToId || null,
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize ?? null,
      fileMimeType: data.fileMimeType || null,
    },
    include: MSG_INCLUDE,
  });
  await prisma.room.update({
    where: { id: data.roomId },
    data: { updatedAt: new Date() },
  });
  return serializeMessage(msg);
}

async function editMessage(userId, messageId, text) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  if (msg.authorId !== userId) throw new AppError(403, 'FORBIDDEN', 'Not author');
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { text: String(text), editedAt: new Date() },
    include: MSG_INCLUDE,
  });
  return serializeMessage(updated);
}

async function softDeleteMessage(userId, messageId) {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { room: { include: { members: true } } },
  });
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  const member = msg.room.members.find((m) => m.userId === userId && !m.leftAt);
  const isAdmin = member && (member.role === 'admin' || member.role === 'owner');
  if (msg.authorId !== userId && !isAdmin) throw new AppError(403, 'FORBIDDEN', 'Forbidden');
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), text: null },
    include: MSG_INCLUDE,
  });
  return serializeMessage(updated);
}

async function toggleReaction(userId, messageId, emoji) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Not found');
  await requireMember(msg.roomId, userId);
  const existing = await prisma.messageReaction.findUnique({
    where: {
      messageId_userId_emoji: { messageId, userId, emoji },
    },
  });
  let added;
  if (existing) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
    added = false;
  } else {
    await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
    added = true;
  }
  const reactions = await prisma.messageReaction.findMany({ where: { messageId } });
  const map = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push(r.userId);
  }
  return { messageId, userId, emoji, added, reactions: map, roomId: msg.roomId };
}

module.exports = {
  getMessages,
  createMessage,
  editMessage,
  softDeleteMessage,
  toggleReaction,
  encodeCursor,
  MSG_INCLUDE,
};
