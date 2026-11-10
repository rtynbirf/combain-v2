function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || null,
    avatarUrl: u.avatarUrl || null,
  };
}

function reactionsMap(rows) {
  const map = {};
  for (const r of rows || []) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push(r.userId);
  }
  return map;
}

function serializeMessage(m, reactions) {
  if (!m) return null;
  return {
    id: m.id,
    roomId: m.roomId,
    authorId: m.authorId,
    authorUsername: m.authorUsername || 'unknown',
    type: m.type || 'text',
    text: m.deletedAt ? null : (m.text ?? null),
    clientMessageId: m.clientMessageId || null,
    replyToId: m.replyToId || null,
    fileUrl: m.fileUrl || null,
    fileName: m.fileName || null,
    fileSize: m.fileSize ?? null,
    fileMimeType: m.fileMimeType || null,
    reactions: reactionsMap(reactions),
    editedAt: m.editedAt || null,
    deletedAt: m.deletedAt || null,
    createdAt: m.createdAt,
  };
}

function serializeRoom(room, members, unreadCount) {
  const active = (members || []).filter((m) => !m.leftAt);
  return {
    id: room.id,
    type: room.type,
    name: room.name || null,
    description: room.description || null,
    avatarUrl: room.avatarUrl || null,
    participantIds: active.map((m) => m.userId),
    participants: active.map((m) => ({
      userId: m.userId,
      role: m.role,
      user: publicUser(m),
    })),
    createdBy: room.createdById,
    createdAt: room.createdAt,
    unreadCount: unreadCount ?? 0,
  };
}

module.exports = { publicUser, serializeMessage, serializeRoom, reactionsMap };
