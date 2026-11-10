const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('test123', 10);
  const hashA = await bcrypt.hash('alice123', 10);

  const test = await prisma.user.upsert({
    where: { username: 'test' },
    update: {},
    create: { username: 'test', passwordHash: hash, displayName: 'Test User' },
  });
  const alice = await prisma.user.upsert({
    where: { username: 'alice' },
    update: {},
    create: { username: 'alice', passwordHash: hashA, displayName: 'Alice' },
  });

  let room = await prisma.room.findFirst({
    where: { type: 'direct', deletedAt: null },
    include: { members: true },
  });
  if (!room) {
    room = await prisma.room.create({
      data: { type: 'direct', createdById: test.id },
    });
    await prisma.roomMember.createMany({
      data: [
        { roomId: room.id, userId: test.id, role: 'member' },
        { roomId: room.id, userId: alice.id, role: 'member' },
      ],
    });
    const texts = [
      { authorId: alice.id, text: 'Hey, welcome to COMBAIN!' },
      { authorId: alice.id, text: 'This is the real Prisma backend.' },
      { authorId: test.id, text: 'Thanks! Looks good so far.' },
      { authorId: alice.id, text: 'Try sending a message, editing, or deleting one.' },
      { authorId: alice.id, text: 'You can also test reactions and file uploads.' },
    ];
    for (const t of texts) {
      await prisma.message.create({
        data: { roomId: room.id, authorId: t.authorId, type: 'text', text: t.text },
      });
    }
  }

  await prisma.appSetting.upsert({
    where: { key: 'modules' },
    update: { value: JSON.stringify({ sms: false, payments: false }) },
    create: { key: 'modules', value: JSON.stringify({ sms: false, payments: false }) },
  });

  console.log('Seed OK:', { test: test.username, alice: alice.username, roomId: room.id });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
