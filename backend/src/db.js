const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// DATA_DIR: переопределяемый каталог данных (Docker-том, изолированные тесты)
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'combain.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS User (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      displayName TEXT,
      bio TEXT,
      avatarUrl TEXT,
      balance REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'offline',
      lastSeenAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS Room (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      description TEXT,
      avatarUrl TEXT,
      createdById TEXT NOT NULL,
      deletedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (createdById) REFERENCES User(id)
    );
    CREATE TABLE IF NOT EXISTS RoomMember (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joinedAt TEXT NOT NULL,
      leftAt TEXT,
      mutedUntil TEXT,
      UNIQUE(roomId, userId),
      FOREIGN KEY (roomId) REFERENCES Room(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS Message (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      authorId TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      clientMessageId TEXT,
      replyToId TEXT,
      fileUrl TEXT,
      fileName TEXT,
      fileSize INTEGER,
      fileMimeType TEXT,
      locationLat REAL,
      locationLng REAL,
      locationAddress TEXT,
      contactData TEXT,
      fileId TEXT,
      editedAt TEXT,
      deletedAt TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (roomId) REFERENCES Room(id) ON DELETE CASCADE,
      FOREIGN KEY (authorId) REFERENCES User(id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_room_created ON Message(roomId, createdAt);
    -- Идемпотентность доставки: повтор (roomId, clientMessageId) невозможен на уровне БД
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_room_clientmsgid
      ON Message(roomId, clientMessageId) WHERE clientMessageId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS MessageReaction (
      id TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      userId TEXT NOT NULL,
      emoji TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(messageId, userId, emoji),
      FOREIGN KEY (messageId) REFERENCES Message(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS MessageRead (
      id TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      userId TEXT NOT NULL,
      readAt TEXT NOT NULL,
      UNIQUE(messageId, userId),
      FOREIGN KEY (messageId) REFERENCES Message(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS PinnedMessage (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      pinnedBy TEXT NOT NULL,
      pinnedAt TEXT NOT NULL,
      UNIQUE(roomId, messageId)
    );
    CREATE TABLE IF NOT EXISTS UserBlock (
      id TEXT PRIMARY KEY,
      blockerId TEXT NOT NULL,
      blockedId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(blockerId, blockedId)
    );
    CREATE TABLE IF NOT EXISTS UploadedFile (
      id TEXT PRIMARY KEY,
      uploaderId TEXT NOT NULL,
      url TEXT NOT NULL,
      fileName TEXT NOT NULL,
      fileSize INTEGER NOT NULL,
      mimeType TEXT NOT NULL,
      storageKey TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS GroupBan (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      userId TEXT NOT NULL,
      bannedBy TEXT NOT NULL,
      reason TEXT,
      createdAt TEXT NOT NULL,
      UNIQUE(roomId, userId)
    );
    CREATE TABLE IF NOT EXISTS AppSetting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

migrate();

module.exports = { db, cuid };
