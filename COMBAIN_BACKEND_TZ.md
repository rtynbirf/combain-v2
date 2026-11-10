# COMBAIN v2 — Backend Technical Specification

> **Контракт:** фронтенд из `combain-frontend.zip` (`public/js/api.js`, `ws.js`, `chat.js`, `calls.js`, `rooms.js`).  
> **Стек (целевой):** Node.js + Express + `ws` + Prisma + better-sqlite3 (dev) / PostgreSQL (prod).  
> **Принцип:** бэкенд подстраивается под фронт, не наоборот.

---

## 0. Общие правила API

### Auth
- JWT (или opaque token) в `Authorization: Bearer <token>`.
- `GET /auth/config` — **без** авторизации.
- Остальные REST (кроме register/login) — с Bearer.
- WS: `ws://host/ws?token=<JWT>`.

### Ошибки
```json
{ "error": "CODE", "message": "Human readable" }
```
HTTP: `400` validation, `401` unauth, `403` forbidden, `404` not found, `409` conflict, `413` file too large, `500` internal.

### ID
- Строковые cuid/uuid (`id String @id @default(cuid())`).
- Фронт не зависит от формата, но не использует числовые id.

### Cursor pagination (messages)
- `GET .../messages?limit=50&cursor=<messageId>`
- Ответ: `{ messages: Message[], nextCursor: string | null }`
- Порядок в ответе: **DESC by createdAt** (фронт делает `.reverse()` → ASC).

### Message shape (канон для REST + WS)
```ts
{
  id: string
  roomId: string
  authorId: string
  authorUsername: string
  type: 'text' | 'image' | 'video' | 'voice' | 'file' | 'location' | 'contact'
  text: string | null
  clientMessageId: string | null
  replyToId: string | null
  fileUrl: string | null
  fileName: string | null
  fileSize: number | null
  fileMimeType: string | null
  locationLat?: number | null
  locationLng?: number | null
  locationAddress?: string | null
  contactData?: string | null
  reactions: Record<string, string[]>  // emoji → userId[]
  editedAt: string | null   // ISO
  deletedAt: string | null  // ISO (soft delete)
  createdAt: string         // ISO
  pinnedAt?: string | null
  pinnedBy?: string | null
}
```

### Room shape
```ts
{
  id: string
  type: 'direct' | 'group'
  name: string | null
  description?: string | null
  avatarUrl?: string | null
  participantIds: string[]
  participants: Array<{
    userId: string
    role: 'owner' | 'admin' | 'member'
    user: { id, username, displayName?, bio? }
  }>
  createdBy: string
  createdAt: string
  unreadCount?: number
  leftAt?: string | null  // if current user left
}
```

---

## 1. Prisma schema (16 models)

```prisma
// schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite" // prod: "postgresql"
  url      = env("DATABASE_URL")
}

// 1. User
model User {
  id           String   @id @default(cuid())
  username     String   @unique
  passwordHash String
  displayName  String?
  bio          String?
  avatarUrl    String?
  balance      Float    @default(0)
  status       String   @default("offline") // online | away | offline
  lastSeenAt   DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  sessions     Session[]
  memberships  RoomMember[]
  messages     Message[]         @relation("MessageAuthor")
  reactions    MessageReaction[]
  reads        MessageRead[]
  pins         PinnedMessage[]   @relation("PinnedBy")
  blocksInit   UserBlock[]       @relation("Blocker")
  blocksRecv   UserBlock[]       @relation("Blocked")
  callsFrom    Call[]            @relation("CallCaller")
  callParts    CallParticipant[]
  bans         GroupBan[]        @relation("BannedUser")
  bansBy       GroupBan[]        @relation("BannedBy")
  uploads      UploadedFile[]

  @@index([username])
  @@index([status])
}

// 2. Session (Bearer tokens)
model Session {
  id        String   @id @default(cuid())
  token     String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  expiresAt DateTime?
  userAgent String?
  ip        String?

  @@index([userId])
  @@index([token])
}

// 3. Room
model Room {
  id          String   @id @default(cuid())
  type        String   // direct | group
  name        String?
  description String?
  avatarUrl   String?
  createdById String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  members     RoomMember[]
  messages    Message[]
  pins        PinnedMessage[]
  calls       Call[]
  bans        GroupBan[]

  @@index([type])
  @@index([updatedAt])
}

// 4. RoomMember (participants + roles + leave)
model RoomMember {
  id        String    @id @default(cuid())
  roomId    String
  userId    String
  role      String    @default("member") // owner | admin | member
  joinedAt  DateTime  @default(now())
  leftAt    DateTime? // soft-leave; null = active
  mutedUntil DateTime?

  room      Room      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([roomId, userId])
  @@index([userId])
  @@index([roomId, leftAt])
}

// 5. Message
model Message {
  id               String    @id @default(cuid())
  roomId           String
  authorId         String
  type             String    @default("text")
  text             String?
  clientMessageId  String?
  replyToId        String?
  fileUrl          String?
  fileName         String?
  fileSize         Int?
  fileMimeType     String?
  locationLat      Float?
  locationLng      Float?
  locationAddress  String?
  contactData      String?
  editedAt         DateTime?
  deletedAt        DateTime?
  createdAt        DateTime  @default(now())

  room      Room              @relation(fields: [roomId], references: [id], onDelete: Cascade)
  author    User              @relation("MessageAuthor", fields: [authorId], references: [id])
  replyTo   Message?          @relation("MessageReplies", fields: [replyToId], references: [id])
  replies   Message[]         @relation("MessageReplies")
  reactions MessageReaction[]
  reads     MessageRead[]
  pins      PinnedMessage[]
  file      UploadedFile?     @relation(fields: [fileId], references: [id])
  fileId    String?

  @@unique([roomId, clientMessageId]) // idempotency per room (nullable clientMessageId: SQLite allows multiple NULL)
  @@index([roomId, createdAt])
  @@index([authorId])
  @@index([replyToId])
  @@index([deletedAt])
}

// 6. MessageReaction
model MessageReaction {
  id        String   @id @default(cuid())
  messageId String
  userId    String
  emoji     String
  createdAt DateTime @default(now())

  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId, emoji])
  @@index([messageId])
}

// 7. MessageRead (read receipts)
model MessageRead {
  id        String   @id @default(cuid())
  messageId String
  userId    String
  readAt    DateTime @default(now())

  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId])
  @@index([userId, readAt])
  @@index([messageId])
}

// 8. PinnedMessage
model PinnedMessage {
  id        String   @id @default(cuid())
  roomId    String
  messageId String
  pinnedBy  String
  pinnedAt  DateTime @default(now())

  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user      User     @relation("PinnedBy", fields: [pinnedBy], references: [id])

  @@unique([roomId, messageId])
  @@index([roomId])
}

// 9. UserBlock
model UserBlock {
  id        String   @id @default(cuid())
  blockerId String
  blockedId String
  createdAt DateTime @default(now())

  blocker   User     @relation("Blocker", fields: [blockerId], references: [id], onDelete: Cascade)
  blocked   User     @relation("Blocked", fields: [blockedId], references: [id], onDelete: Cascade)

  @@unique([blockerId, blockedId])
  @@index([blockedId])
}

// 10. Call
model Call {
  id         String    @id @default(cuid())
  roomId     String
  callerId   String
  status     String    @default("ringing") // ringing | active | ended
  offerSdp   String?
  answerSdp  String?
  startedAt  DateTime  @default(now())
  answeredAt DateTime?
  endedAt    DateTime?
  endedById  String?

  room         Room              @relation(fields: [roomId], references: [id], onDelete: Cascade)
  caller       User              @relation("CallCaller", fields: [callerId], references: [id])
  participants CallParticipant[]

  @@index([roomId, status])
  @@index([callerId])
}

// 11. CallParticipant
model CallParticipant {
  id       String    @id @default(cuid())
  callId   String
  userId   String
  joinedAt DateTime  @default(now())
  leftAt   DateTime?

  call     Call      @relation(fields: [callId], references: [id], onDelete: Cascade)
  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([callId, userId])
}

// 12. UploadedFile
model UploadedFile {
  id        String    @id @default(cuid())
  uploaderId String
  url       String
  fileName  String
  fileSize  Int
  mimeType  String
  storageKey String?
  createdAt DateTime  @default(now())

  uploader  User      @relation(fields: [uploaderId], references: [id])
  messages  Message[]

  @@index([uploaderId])
}

// 13. GroupBan
model GroupBan {
  id        String   @id @default(cuid())
  roomId    String
  userId    String
  bannedBy  String
  reason    String?
  createdAt DateTime @default(now())

  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  user      User     @relation("BannedUser", fields: [userId], references: [id], onDelete: Cascade)
  banner    User     @relation("BannedBy", fields: [bannedBy], references: [id])

  @@unique([roomId, userId])
}

// 14. RoomInvite (optional future; reserved for completeness)
model RoomInvite {
  id        String   @id @default(cuid())
  roomId    String
  inviterId String
  inviteeId String
  status    String   @default("pending") // pending | accepted | declined
  createdAt DateTime @default(now())

  @@unique([roomId, inviteeId])
  @@index([inviteeId, status])
}

// 15. AppSetting (server config / feature flags)
model AppSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}

// 16. AuditLog (optional ops)
model AuditLog {
  id        String   @id @default(cuid())
  actorId   String?
  action    String
  targetType String?
  targetId  String?
  meta      String?  // JSON string
  createdAt DateTime @default(now())

  @@index([actorId, createdAt])
  @@index([action])
}
```

**Примечания по SQLite:**  
- `@@unique([roomId, clientMessageId])` — несколько `NULL` clientMessageId допустимы в SQLite.  
- Для PostgreSQL при необходимости использовать partial unique index `WHERE client_message_id IS NOT NULL`.

---

## 2. REST endpoints (полный список)

### Auth
| Method | Path | Auth | Body / Query | Response | Status |
|--------|------|------|--------------|----------|--------|
| POST | `/auth/register` | no | `{ username, password }` | `{ id, username, token }` | 201 |
| POST | `/auth/login` | no | `{ username, password }` | `{ id, username, token }` | 200 |
| POST | `/auth/logout` | yes | — | `{ ok: true }` | 200 |
| GET | `/auth/me` | yes | — | `{ id, username, balance, displayName?, bio? }` | 200 |
| GET | `/auth/config` | no | — | `{ modules: { sms, payments }, ice_servers: [...] }` | 200 |

### Rooms
| Method | Path | Auth | Body / Query | Response |
|--------|------|------|--------------|----------|
| GET | `/rooms` | yes | — | `Room[]` (только active membership `leftAt=null`) |
| POST | `/rooms` | yes | `{ type, participantIds[], name? }` | `Room` |
| GET | `/rooms/:id/messages` | yes | `?cursor=&limit=50` | `{ messages, nextCursor }` |
| GET | `/rooms/:id/participants` | yes | — | participants array |
| POST | `/rooms/:id/leave` | yes | — | `{ ok: true }` |
| POST | `/rooms/:id/rejoin` | yes | — | `Room` / `{ ok: true }` |
| POST | `/rooms/:id/participants` | yes | `{ userId }` | participant / Room |
| GET | `/rooms/:id/unread` | yes | — | `{ count: number }` |
| GET | `/rooms/:id/last-message` | yes | — | `Message \| null` |

### Messages
| Method | Path | Auth | Body / Query | Response |
|--------|------|------|--------------|----------|
| PATCH | `/messages/:id/edit` | yes | `{ text }` | updated Message |
| DELETE | `/messages/:id` | yes | — | soft-deleted Message / `{ ok }` |
| POST | `/messages/forward` | yes | `{ messageId, targetRoomId, clientMessageId }` | new Message |
| POST | `/messages/:id/react` | yes | `{ emoji }` | `{ messageId, userId, emoji, added, reactions }` |
| GET | `/messages/:id/reactions` | yes | — | reactions map / list |
| POST | `/messages/:id/pin` | yes | `?roomId=` | pin info |
| DELETE | `/messages/:id/pin` | yes | `?roomId=` | `{ ok }` |
| GET | `/messages/pinned/:roomId` | yes | — | Message[] |
| POST | `/messages/read` | yes | `{ messageIds[], roomId }` | `{ readCount }` |
| GET | `/messages/search` | yes | `?q=&roomId=&limit=` | Message[] |
| POST | `/messages/upload` | yes | multipart `file` | `{ url, fileName, fileSize, mimeType }` |

### Users
| Method | Path | Auth | Body / Query | Response |
|--------|------|------|--------------|----------|
| GET | `/users/profile` | yes | — | own profile |
| PATCH | `/users/profile` | yes | `{ displayName?, bio?, avatarUrl? }` | profile |
| GET | `/users/:id` | yes | — | public profile |
| GET | `/users/search` | yes | `?q=&limit=20` | User[] |
| POST | `/users/block` | yes | `{ userId }` | `{ ok }` |
| DELETE | `/users/block/:id` | yes | — | `{ ok }` |
| GET | `/users/blocks` | yes | — | User[] |
| POST | `/users/presence` | yes | `{ userIds[] }` | `{ [userId]: { status, lastSeenAt } }` |

### Groups
| Method | Path | Auth | Body / Query | Response |
|--------|------|------|--------------|----------|
| GET | `/groups/:roomId/roles` | yes | — | `{ [userId]: role }` or list |
| POST | `/groups/:roomId/promote` | yes | `{ userId }` | `{ ok }` |
| POST | `/groups/:roomId/demote` | yes | `{ userId }` | `{ ok }` |
| POST | `/groups/:roomId/kick` | yes | `{ userId }` | `{ ok }` |
| POST | `/groups/:roomId/ban` | yes | `{ userId }` | `{ ok }` |
| PATCH | `/groups/:roomId` | yes | `{ name?, description?, avatarUrl? }` | Room |

---

## 3. WebSocket protocol

### Connect
```
ws://<host>/ws?token=<JWT>
```
Сразу после accept → server push:
```json
{ "type": "auth_ok", "payload": { "userId": "..." } }
```
И `presence_update` online для контактов (опционально).

### Envelope
```json
{ "type": "string", "requestId": "string?", "payload": {} }
```

### Client → Server

| type | payload | server response / side-effect |
|------|---------|--------------------------------|
| `subscribe` | `{ roomId }` | `subscribed` `{ roomId }` |
| `rejoin` | `{ roomId }` | `rejoined` `{ roomId }` (+ clear leftAt) |
| `chat_message` | `{ roomId, text, clientMessageId, replyToId? }` | broadcast `chat_message` (echo with `requestId=clientMessageId`) |
| `media_message` | `{ roomId, clientMessageId, type, fileUrl, fileName, fileSize, fileMimeType, text?, replyToId? }` | same as chat_message |
| `edit_message` | `{ messageId, text }` | broadcast `message_edited` |
| `delete_message` | `{ messageId }` | broadcast `message_deleted` |
| `forward_message` | `{ messageId, targetRoomId, clientMessageId }` | broadcast `chat_message` in target |
| `message_reaction` | `{ messageId, emoji }` | broadcast `message_reaction` (toggle) |
| `messages_read` | `{ messageIds[], roomId }` | `messages_read_ack` + broadcast `messages_read`; optionally `message_read_by` to authors |
| `typing_start` | `{ roomId }` | broadcast `typing_start` (exclude self) |
| `typing_stop` | `{ roomId }` | broadcast `typing_stop` |
| `call_offer` | `{ roomId, sdp }` | `call_created` `{ callId }` to caller + broadcast `call_offer` `{ callId, sdp, fromUserId }` |
| `call_answer` | `{ callId, sdp }` | broadcast `call_answer` |
| `ice_candidate` | `{ callId, candidate }` | broadcast `ice_candidate` (buffer if peer RINGING) |
| `hangup` | `{ callId }` | broadcast `call_ended` `{ callId, endedBy }` |

### Server → Client (push)

| type | payload |
|------|---------|
| `auth_ok` | `{ userId }` |
| `subscribed` / `rejoined` | `{ roomId }` |
| `chat_message` | full Message (+ `requestId` if ack) |
| `message_edited` | `{ id, text, editedAt }` |
| `message_deleted` | `{ id, deletedAt }` |
| `message_reaction` | `{ messageId, userId, emoji, added, reactions }` |
| `messages_read` | `{ userId, messageIds[] }` |
| `messages_read_ack` | `{ readCount }` |
| `message_read_by` | `{ userId, messageId, roomId }` |
| `typing_start` / `typing_stop` | `{ userId, roomId }` |
| `presence_update` | `{ userId, status }` |
| `call_created` | `{ callId }` |
| `call_offer` | `{ callId, sdp, fromUserId }` |
| `call_answer` | `{ callId, sdp }` |
| `ice_candidate` | `{ callId, candidate, fromUserId }` |
| `call_ended` | `{ callId, endedBy }` |
| `message_pinned` | `{ messageId, pinnedBy, pinnedAt }` |
| `message_unpinned` | `{ messageId }` |
| `error` | `{ code, message }` (+ optional requestId) |

**Всего WS types (C→S + S→C, уникальные):**  
subscribe, rejoin, chat_message, media_message, edit_message, delete_message, forward_message, message_reaction, messages_read, typing_start, typing_stop, call_offer, call_answer, ice_candidate, hangup, auth_ok, subscribed, rejoined, message_edited, message_deleted, messages_read_ack, message_read_by, presence_update, call_created, call_ended, message_pinned, message_unpinned, error ≈ **28**.

---

## 4. Endpoint → Prisma mapping

### Auth
| Endpoint | Prisma / logic |
|----------|----------------|
| `POST /auth/register` | `user.create` + hash password (bcrypt) + `session.create` → token |
| `POST /auth/login` | `user.findUnique({ username })` + verify hash + `session.create` |
| `POST /auth/logout` | `session.deleteMany({ token })` |
| `GET /auth/me` | `user.findUnique({ id })` select public fields + balance |
| `GET /auth/config` | `appSetting` or env → `{ modules, ice_servers }` |

### Rooms
| Endpoint | Prisma / logic |
|----------|----------------|
| `GET /rooms` | `roomMember.findMany({ userId, leftAt: null, include: room + members + user })` + optional unread aggregate |
| `POST /rooms` type=direct | find existing direct with same 2 members; else `room.create` + 2 `roomMember` (role owner for creator) |
| `POST /rooms` type=group | `room.create` + members (creator=owner, others=member) |
| `GET /rooms/:id/messages` | membership check → `message.findMany({ roomId, deletedAt optional, orderBy createdAt desc, take, cursor })` + reactions include |
| `GET /rooms/:id/participants` | `roomMember.findMany({ roomId, leftAt: null, include: user })` |
| `POST /rooms/:id/leave` | `roomMember.update({ leftAt: now })` |
| `POST /rooms/:id/rejoin` | `roomMember.update({ leftAt: null })` if not banned |
| `POST /rooms/:id/participants` | auth admin/owner → `roomMember.create` (check GroupBan) |
| `GET /rooms/:id/unread` | count messages in room where `createdAt > lastRead` and author ≠ me, or `messageRead` absence |
| `GET /rooms/:id/last-message` | `message.findFirst({ roomId, orderBy createdAt desc })` |

### Messages
| Endpoint | Prisma / logic |
|----------|----------------|
| `PATCH .../edit` | author only → `message.update({ text, editedAt })` |
| `DELETE .../:id` | author or admin → `message.update({ deletedAt, text: null })` |
| `POST /messages/forward` | load src message; membership target; `message.create` copy fields + new clientMessageId |
| `POST .../react` | toggle `messageReaction` unique(messageId,userId,emoji); return aggregated map |
| `GET .../reactions` | `messageReaction.groupBy` / findMany → map emoji→userIds |
| `POST .../pin` | admin/owner → `pinnedMessage.upsert` |
| `DELETE .../pin` | `pinnedMessage.delete` |
| `GET /messages/pinned/:roomId` | `pinnedMessage.findMany({ roomId, include: message })` |
| `POST /messages/read` | `messageRead.createMany` skipDuplicates; notify authors via WS |
| `GET /messages/search` | `message.findMany({ text contains q, roomId?, membership filter })` |
| `POST /messages/upload` | save disk/S3 → `uploadedFile.create` → `{ url, fileName, fileSize, mimeType }` |

### Users
| Endpoint | Prisma / logic |
|----------|----------------|
| `GET/PATCH /users/profile` | `user.findUnique` / `user.update` |
| `GET /users/:id` | public fields only |
| `GET /users/search` | `user.findMany({ username contains q })` exclude self optional |
| `POST /users/block` | `userBlock.create` |
| `DELETE /users/block/:id` | `userBlock.delete` |
| `GET /users/blocks` | `userBlock.findMany({ blockerId, include: blocked })` |
| `POST /users/presence` | `user.findMany({ id in userIds })` → map status/lastSeenAt |

### Groups
| Endpoint | Prisma / logic |
|----------|----------------|
| `GET .../roles` | `roomMember.findMany({ roomId })` → role map |
| `POST .../promote` | caller owner/admin → target member→admin |
| `POST .../demote` | admin→member (not owner) |
| `POST .../kick` | set `leftAt` or delete member |
| `POST .../ban` | `groupBan.create` + kick |
| `PATCH /groups/:roomId` | owner/admin → `room.update` name/description/avatarUrl |

### WS handlers (core writes)
| type | Prisma |
|------|--------|
| `chat_message` / `media_message` | `message.create` + broadcast |
| `edit_message` | `message.update` |
| `delete_message` | soft delete |
| `forward_message` | `message.create` in target room |
| `message_reaction` | toggle reaction row |
| `messages_read` | `messageRead.createMany` |
| `call_offer` | `call.create` status=ringing + participants |
| `call_answer` | `call.update` status=active, answerSdp |
| `hangup` | `call.update` status=ended, endedAt |

---

## 5. Business rules (кратко)

1. **Direct room uniqueness:** пара users → один active direct (оба leftAt null).  
2. **Membership required** для read/write room; left users не получают WS broadcast.  
3. **Soft delete** messages; deleted still occupy id for reply integrity.  
4. **Reactions toggle** same emoji by same user.  
5. **Blocks:** blocked user cannot create direct / message (optional filter search).  
6. **Group permissions:** owner > admin > member; only owner promotes to admin; cannot kick owner.  
7. **Calls:** one active call per room recommended; ICE relay via WS only (no media server).  
8. **Upload:** max 50MB (`CONFIG.MAX_FILE_SIZE`); store under `/uploads/` or object storage; return absolute or same-origin URL.  
9. **Idempotency:** `(roomId, clientMessageId)` unique when clientMessageId set.  
10. **Presence:** on WS connect → online; disconnect → offline + `lastSeenAt`; broadcast to relevant users (rooms in common).

---

## 6. Project layout (suggested)

```
backend/
  package.json
  prisma/schema.prisma
  src/
    index.js          # http + ws attach
    config.js
    db.js             # PrismaClient
    auth/
      jwt.js | tokens.js
      password.js
      middleware.js
    routes/
      auth.js
      rooms.js
      messages.js
      users.js
      groups.js
    ws/
      hub.js          # connection map, room subscriptions
      handlers.js     # switch(type)
    services/
      rooms.js
      messages.js
      calls.js
      presence.js
      upload.js
    utils/
      errors.js
      serialize.js    # Message/Room DTO for frontend
  uploads/
```

---

## 7. Acceptance vs frontend smoke

После реализации бэкенд должен зелёным пройти:

1. Существующий `mock-backend/test-client.js` (адаптировать URL) — 20 checks.  
2. Ручной UI: login test/alice → open seeded/direct → send/edit/delete/react/typing.  
3. Upload image → media bubble.  
4. Create group → multi-user message.  
5. Two browsers: call_offer → accept → hangup (with real ICE servers from `/auth/config`).

---

## 8. Out of scope (v2.x)

- SMS / payments modules (flags false in config until ready)  
- E2E encryption  
- Push (FCM/APNs)  
- Federation  
- Message search full-text engine (LIKE достаточно для v2)

---

*Конец ТЗ. Фронт-контракт зафиксирован zip-сборкой; любые breaking changes — только с версионированием API.*
