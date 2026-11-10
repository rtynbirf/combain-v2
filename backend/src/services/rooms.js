const { prisma } = require('../db');
const { AppError } = require('../utils/errors');
const { serializeRoom } = require('./serialize');

async function requireMember(roomId, userId) {
  const m = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (!m || m.leftAt) throw new AppError(403, 'NOT_MEMBER', 'Not a room member');
  return m;
}

async function loadRoom(roomId) {
  return prisma.room.findFirst({
    where: { id: roomId, deletedAt: null },
    include: {
      members: { where: { leftAt: null }, include: { user: true } },
    },
  });
}

async function listRoomsForUser(userId) {
  const memberships = await prisma.roomMember.findMany({
    where: { userId, leftAt: null, room: { deletedAt: null } },
    include: {
      room: {
        include: {
          members: { where: { leftAt: null }, include: { user: true } },
        },
      },
    },
    orderBy: { room: { updatedAt: 'desc' } },
  });
  return memberships.map((m) => serializeRoom(m.room));
}

async function findDirectRoom(userA, userB) {
  const rooms = await prisma.room.findMany({
    where: { type: 'direct', deletedAt: null },
    include: { members: true },
  });
  for (const r of rooms) {
    const active = r.members.filter((m) => !m.leftAt).map((m) => m.userId);
    if (active.length === 2 && active.includes(userA) && active.includes(userB)) return r.id;
  }
  return null;
}

async function createRoom(creatorId, { type, participantIds, name }) {
  const ids = [...new Set([creatorId, ...(participantIds || [])])];
  if (type === 'direct') {
    const other = (participantIds || []).find((id) => id !== creatorId);
    if (!other) throw new AppError(400, 'VALIDATION_ERROR', 'Need participant');
    const existing = await findDirectRoom(creatorId, other);
    if (existing) {
      const room = await loadRoom(existing);
      return serializeRoom(room);
    }
    const room = await prisma.$transaction(async (tx) => {
      const r = await tx.room.create({
        data: { type: 'direct', createdById: creatorId },
      });
      await tx.roomMember.createMany({
        data: [
          { roomId: r.id, userId: creatorId, role: 'member' },
          { roomId: r.id, userId: other, role: 'member' },
        ],
      });
      return r;
    });
    return serializeRoom(await loadRoom(room.id));
  }
  if (type === 'group') {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new AppError(400, 'VALIDATION_ERROR', 'Group name required');
    const room = await prisma.$transaction(async (tx) => {
      const r = await tx.room.create({
        data: { type: 'group', name: cleanName, createdById: creatorId },
      });
      await tx.roomMember.create({
        data: { roomId: r.id, userId: creatorId, role: 'owner' },
      });
      for (const uid of ids) {
        if (uid === creatorId) continue;
        await tx.roomMember.create({
          data: { roomId: r.id, userId: uid, role: 'member' },
        });
      }
      return r;
    });
    return serializeRoom(await loadRoom(room.id));
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid room type');
}

module.exports = { requireMember, loadRoom, listRoomsForUser, createRoom };
