# COMBAIN v2 — Backend Specification v1.0

> **Статус:** DRAFT — §1–2 ACCEPTED (3 fixes applied); §3–5 Auth+REST+WS  
> **Фронтенд:** FROZEN (20/20 smoke). Контракт = `public/js/api.js` + `ws.js`.  
> **Nexus / EventLog / selectors:** OUT OF SCOPE (v3 backlog).

---

## Решения, зафиксированные до написания

| # | Вопрос | Решение v2 |
|---|--------|------------|
| Q1 | Auth | **Access-only JWT**, TTL 7 days. Нет refresh-токена. Протух → re-login / `clearAuth()`. |
| Q2 | Files | **Локальный диск** `uploads/`, абстракция `FileStorage` (позже S3/MinIO). |
| Q3 | Soft delete | **Только** `Message.deletedAt` и `Room.deletedAt` (+ `RoomMember.leftAt` как soft-leave). Остальное — hard delete. |
| Q4 | Scope | **Phase 1 + Phase 2** в этом ТЗ. **Calls (signaling)** — Phase 3 (отдельный addendum). |

### Phase map

| Phase | In scope | Out |
|-------|----------|-----|
| **1 MVP** | Auth, Rooms, Messages, Typing, Presence, Upload, Reactions | Payments, SMS, Group admin, Calls |
| **2** | Groups (roles/kick/ban), Pins, Search, Read receipts | Calls |
| **3** | WebRTC signaling (offer/answer/ICE/hangup), TURN notes | — |

Presence / Typing / WebSocket connections / ICE — **ephemeral (in-memory)**, не в Prisma.

---

## 1. Стек и структура проекта

### 1.1 Runtime stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Node.js ≥ 20 LTS | ES modules or CJS — **CJS acceptable** to match simple deploy |
| HTTP | Express 4.x | Static `public/` optional in same process for self-host |
| WS | `ws` 8.x | Attached to same HTTP server |
| ORM | Prisma 5.x | Single source of schema + migrations |
| DB driver | **SQLite via Prisma** (`provider = "sqlite"`) | Dev + single-node self-host default |
| Optional native | better-sqlite3 | **Not a second source of truth.** Use only if we add raw SQL helpers *through* Prisma `$queryRaw` / or drop Prisma for a pure better-sqlite3 path later. **v1 choice: Prisma-only.** |
| Auth crypto | `bcryptjs` or `bcrypt` | password hash |
| Tokens | `jose` or `jsonwebtoken` | JWT HS256, secret from env |
| Validation | `zod` | request body/query |
| Upload | `multer` + disk storage | field name `file` (matches frontend FormData) |
| Logging | `pino` (optional console in MVP) | structured logs |
| Config | `dotenv` | `DATABASE_URL`, `JWT_SECRET`, `PORT`, `UPLOAD_DIR` |

**Инженерная граница:** Prisma schema = persistence contract. Нет параллельных DDL в better-sqlite3. Если позже нужен better-sqlite3 performance path — отдельная миграция архитектуры, не dual-write.

### 1.2 Project layout

```text
backend/
  package.json
  .env.example
  prisma/
    schema.prisma
    migrations/
    seed.js
  src/
    index.js                 # HTTP + WS bootstrap
    config.js
    db.js                    # PrismaClient singleton
    middleware/
      auth.js                # Bearer JWT → req.user
      validate.js            # zod wrappers
      error.js               # central error handler
      rateLimit.js           # optional Phase 1.1
    routes/
      auth.js
      rooms.js
      messages.js
      users.js
      groups.js              # Phase 2
    ws/
      hub.js                 # conn map, room subscriptions
      handlers.js            # switch(type)
      presence.js            # in-memory presence + typing TTL
    services/
      authService.js
      roomService.js
      messageService.js
      userService.js
      groupService.js
      uploadService.js
      serialize.js           # DTOs matching frontend shapes
    storage/
      fileStorage.js         # interface + LocalDiskStorage
    utils/
      errors.js              # AppError(code, status, message)
      cursors.js
  uploads/                   # gitignored
```

### 1.3 Process model

```text
Express HTTP
   ├── REST /auth /rooms /messages /users /groups
   ├── POST /messages/upload
   ├── static /uploads/*  (or controlled download route)
   └── upgrade → WebSocket /ws?token=JWT

In-memory (ephemeral):
   connections: Map<userId, Set<WebSocket>>
   roomSubs:    Map<roomId, Set<userId>>
   typing:      Map<roomId, Map<userId, expiresAt>>
   presence:    derived from connections (+ lastSeenAt in DB on disconnect)
```

### 1.4 Environment

```bash
PORT=3000
HOST=0.0.0.0
DATABASE_URL="file:./data/combain.db"
JWT_SECRET="change-me-in-production"
JWT_TTL_SECONDS=604800          # 7 days
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=52428800          # 50 MB
CORS_ORIGIN=*                   # tighten in prod
ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"}]'
```

### 1.5 Error model (global)

JSON body:

```json
{ "error": "CODE_SNAKE", "message": "Human readable" }
```

| HTTP | Typical codes |
|------|----------------|
| 400 | `VALIDATION_ERROR`, `INVALID_CURSOR` |
| 401 | `UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_INVALID` |
| 403 | `FORBIDDEN`, `NOT_MEMBER`, `ROLE_REQUIRED` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND`, `ROOM_NOT_FOUND`, `MESSAGE_NOT_FOUND` |
| 409 | `USER_EXISTS`, `ALREADY_MEMBER` |
| 413 | `FILE_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` |

### 1.6 Transaction boundaries (principle)

| Operation | Transaction |
|-----------|-------------|
| register | user create + (optional) session row if opaque tokens; JWT may be stateless → user only |
| create room | room + members (all-or-nothing) |
| leave room | update `leftAt` |
| send message (WS) | message insert; broadcast after commit |
| react | upsert/delete reaction in one tx; read aggregate after |
| soft-delete message | single update |
| pin | pin row + optional room membership check in tx |
| mark read | createMany skipDuplicates |

**Rule:** never broadcast WS events for data that rolled back.

---

## 2. Domain model & Prisma schema (16 models)

### 2.1 Persistent vs ephemeral

| Persistent (DB) | Ephemeral (memory) |
|-----------------|--------------------|
| User, Session (optional), Room, RoomMember | WebSocket connections |
| Message, MessageReaction, MessageRead | Typing indicators |
| PinnedMessage, UserBlock, GroupBan | Per-connection subscribe set |
| UploadedFile, RoomInvite, AppSetting, AuditLog | Call/ICE state (**Phase 3**) |
| User.lastSeenAt / status snapshot on disconnect | Live `online` derived from conn map |

### 2.2 ID strategy

- All primary keys: `String @id @default(cuid())`
- Frontend-agnostic; do not use autoincrement integers in public API

### 2.3 Models (detailed)

#### 1. User

| Field | Type | Null | Default | Notes |
|-------|------|------|---------|-------|
| id | String PK | no | cuid() | |
| username | String | no | — | **unique**, 3–32 chars, `[a-zA-Z0-9_]` |
| passwordHash | String | no | — | bcrypt |
| displayName | String | yes | null | |
| bio | String | yes | null | |
| avatarUrl | String | yes | null | |
| balance | Float | no | 0 | reserved modules |
| status | String | no | `"offline"` | last known; live online from memory |
| lastSeenAt | DateTime | yes | null | set on WS disconnect |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime | no | updatedAt | |

**Indexes:** unique(username); index(status)  
**Invariants:** username immutable recommended; password never returned in DTO

#### 2. Session (optional with JWT)

For access-only JWT, Session is **optional**. Two modes:

- **A (recommended MVP):** JWT carries `sub=userId`; no Session table. Logout = client discards token (server cannot revoke without denylist).
- **B:** opaque/random token stored in Session; logout deletes row.

**Spec default MVP:** Mode A (JWT only). Session model reserved for Mode B / future revoke.

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| tokenHash | String | no | — | unique; store hash not raw |
| userId | String FK → User | no | — | onDelete Cascade |
| createdAt | DateTime | no | now() |
| expiresAt | DateTime | yes | null |
| userAgent | String | yes | null |
| ip | String | yes | null |

#### 3. Room

| Field | Type | Null | Default | Notes |
|-------|------|------|---------|-------|
| id | String PK | no | cuid() | |
| type | String | no | — | `direct` \| `group` |
| name | String | yes | null | required for group in validation |
| description | String | yes | null | |
| avatarUrl | String | yes | null | |
| createdById | String FK → User | no | — | Restrict delete |
| deletedAt | DateTime | yes | null | **soft delete room** |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime | no | updatedAt | |

**Indexes:** (type); (updatedAt); (deletedAt)  
**Invariants:**

- `direct`: exactly 2 active members (`leftAt IS NULL`); uniqueness of unordered pair (application-level or join table hash).
- `group`: name non-empty after trim.

#### 4. RoomMember

| Field | Type | Null | Default | Notes |
|-------|------|------|---------|-------|
| id | String PK | no | cuid() | |
| roomId | String FK → Room | no | — | Cascade |
| userId | String FK → User | no | — | Cascade |
| role | String | no | `"member"` | `owner` \| `admin` \| `member` |
| joinedAt | DateTime | no | now() | |
| leftAt | DateTime | yes | null | soft-leave; null = active |
| mutedUntil | DateTime | yes | null | reserved |

**Constraints:** `@@unique([roomId, userId])`  
**Indexes:** (userId); (roomId, leftAt)  
**Invariants:** one `owner` per group recommended; direct members both `member` or creator `owner`

#### 5. Message

| Field | Type | Null | Default | Notes |
|-------|------|------|---------|-------|
| id | String PK | no | cuid() | |
| roomId | String FK → Room | no | — | Cascade |
| authorId | String FK → User | no | — | **onDelete: Restrict** (explicit) |
| type | String | no | `"text"` | text\|image\|video\|voice\|file\|location\|contact |
| text | String | yes | null | |
| clientMessageId | String | yes | null | client idempotency |
| replyToId | String FK → Message | yes | null | **onDelete: SetNull** |
| fileUrl | String | yes | null | |
| fileName | String | yes | null | |
| fileSize | Int | yes | null | |
| fileMimeType | String | yes | null | |
| locationLat | Float | yes | null | |
| locationLng | Float | yes | null | |
| locationAddress | String | yes | null | |
| contactData | String | yes | null | |
| fileId | String FK → UploadedFile | yes | null | optional link |
| editedAt | DateTime | yes | null | |
| deletedAt | DateTime | yes | null | **soft delete** |
| createdAt | DateTime | no | now() | |

**Indexes:** (roomId, createdAt); (authorId); (replyToId); (deletedAt)  
**Cursor (§9):** opaque cursor = `{createdAt ISO}|{id}` (or message id lookup → createdAt); order `createdAt DESC, id DESC`  
**Unique:** application idempotency on `(roomId, clientMessageId)` when clientMessageId IS NOT NULL  
**Invariants:** soft-deleted messages keep row; `text` may be nulled on delete; replies may point to deleted parent

#### 6. MessageReaction

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| messageId | String FK → Message | no | Cascade |
| userId | String FK → User | no | Cascade |
| emoji | String | no | — | max length 32 |
| createdAt | DateTime | no | now() |

**Constraints:** `@@unique([messageId, userId, emoji])`  
**Behavior:** toggle (delete if exists, else create)

#### 7. MessageRead

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| messageId | String FK → Message | no | Cascade |
| userId | String FK → User | no | Cascade |
| readAt | DateTime | no | now() |

**Constraints:** `@@unique([messageId, userId])`  
**Indexes:** (userId, readAt); (messageId)

#### 8. PinnedMessage (Phase 2)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| roomId | String FK → Room | no | Cascade |
| messageId | String FK → Message | no | Cascade |
| pinnedBy | String FK → User | no | Restrict |
| pinnedAt | DateTime | no | now() |

**Constraints:** `@@unique([roomId, messageId])`  
**Authz:** owner/admin (or any member — product choice: **admin/owner only**)

#### 9. UserBlock

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| blockerId | String FK → User | no | Cascade |
| blockedId | String FK → User | no | Cascade |
| createdAt | DateTime | no | now() |

**Constraints:** `@@unique([blockerId, blockedId])`; blocker ≠ blocked  
**Effect:** block create direct / optionally filter search

#### 10. Call (Phase 3 — schema reserved, handlers later)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| roomId | String FK → Room | no | Cascade |
| callerId | String FK → User | no | Restrict |
| status | String | no | `"ringing"` | ringing\|active\|ended |
| offerSdp | String | yes | null |
| answerSdp | String | yes | null |
| startedAt | DateTime | no | now() |
| answeredAt | DateTime | yes | null |
| endedAt | DateTime | yes | null |
| endedById | String | yes | null |

#### 11. CallParticipant (Phase 3 reserved)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| callId | String FK → Call | no | Cascade |
| userId | String FK → User | no | Cascade |
| joinedAt | DateTime | no | now() |
| leftAt | DateTime | yes | null |

**Constraints:** `@@unique([callId, userId])`

#### 12. UploadedFile

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| uploaderId | String FK → User | no | Restrict |
| url | String | no | — | public path `/uploads/...` |
| fileName | String | no | — |
| fileSize | Int | no | — |
| mimeType | String | no | — |
| storageKey | String | yes | null | relative path on disk |
| createdAt | DateTime | no | now() |

#### 13. GroupBan (Phase 2)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| roomId | String FK → Room | no | Cascade |
| userId | String FK → User | no | Cascade |
| bannedBy | String FK → User | no | Restrict |
| reason | String | yes | null |
| createdAt | DateTime | no | now() |

**Constraints:** `@@unique([roomId, userId])`  
**Effect:** cannot rejoin; kick sets leftAt

#### 14. RoomInvite (reserved)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| roomId | String | no | — |
| inviterId | String | no | — |
| inviteeId | String | no | — |
| status | String | no | `"pending"` |
| createdAt | DateTime | no | now() |

**Constraints:** `@@unique([roomId, inviteeId])`

#### 15. AppSetting

| Field | Type | Null | Default |
|-------|------|------|---------|
| key | String PK | no | — |
| value | String | no | — | JSON or plain |
| updatedAt | DateTime | no | updatedAt |

**Keys:** `ice_servers`, `modules.sms`, `modules.payments`

#### 16. AuditLog (optional, recommended)

| Field | Type | Null | Default |
|-------|------|------|---------|
| id | String PK | no | cuid() |
| actorId | String | yes | null |
| action | String | no | — |
| targetType | String | yes | null |
| targetId | String | yes | null |
| meta | String | yes | null | JSON string |
| createdAt | DateTime | no | now() |

**Indexes:** (actorId, createdAt); (action)

### 2.4 Prisma sketch (canonical)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id           String    @id @default(cuid())
  username     String    @unique
  passwordHash String
  displayName  String?
  bio          String?
  avatarUrl    String?
  balance      Float     @default(0)
  status       String    @default("offline")
  lastSeenAt   DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  sessions     Session[]
  memberships  RoomMember[]
  messages     Message[]          @relation("MessageAuthor")
  reactions    MessageReaction[]
  reads        MessageRead[]
  pins         PinnedMessage[]    @relation("PinnedBy")
  blocksOut    UserBlock[]        @relation("Blocker")
  blocksIn     UserBlock[]        @relation("Blocked")
  callsFrom    Call[]             @relation("CallCaller")
  callParts    CallParticipant[]
  bans         GroupBan[]         @relation("BannedUser")
  bansIssued   GroupBan[]         @relation("BannedBy")
  uploads      UploadedFile[]
  roomsCreated Room[]             @relation("RoomCreator")

  @@index([status])
}

model Session {
  id        String    @id @default(cuid())
  tokenHash String    @unique
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime  @default(now())
  expiresAt DateTime?
  userAgent String?
  ip        String?

  @@index([userId])
}

model Room {
  id          String    @id @default(cuid())
  type        String
  name        String?
  description String?
  avatarUrl   String?
  createdById String
  createdBy   User      @relation("RoomCreator", fields: [createdById], references: [id])
  deletedAt   DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  members  RoomMember[]
  messages Message[]
  pins     PinnedMessage[]
  calls    Call[]
  bans     GroupBan[]

  @@index([type])
  @@index([updatedAt])
  @@index([deletedAt])
}

model RoomMember {
  id         String    @id @default(cuid())
  roomId     String
  userId     String
  role       String    @default("member")
  joinedAt   DateTime  @default(now())
  leftAt     DateTime?
  mutedUntil DateTime?
  room       Room      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([roomId, userId])
  @@index([userId])
  @@index([roomId, leftAt])
}

model Message {
  id              String    @id @default(cuid())
  roomId          String
  authorId        String
  type            String    @default("text")
  text            String?
  clientMessageId String?
  replyToId       String?
  fileUrl         String?
  fileName        String?
  fileSize        Int?
  fileMimeType    String?
  locationLat     Float?
  locationLng     Float?
  locationAddress String?
  contactData     String?
  fileId          String?
  editedAt        DateTime?
  deletedAt       DateTime?
  createdAt       DateTime  @default(now())

  room      Room              @relation(fields: [roomId], references: [id], onDelete: Cascade)
  author    User              @relation("MessageAuthor", fields: [authorId], references: [id], onDelete: Restrict) // messages outlive author hard-delete attempts
  replyTo   Message?          @relation("Replies", fields: [replyToId], references: [id], onDelete: SetNull) // replies outlive parent hard-delete
  replies   Message[]         @relation("Replies")
  reactions MessageReaction[]
  reads     MessageRead[]
  pins      PinnedMessage[]
  file      UploadedFile?     @relation(fields: [fileId], references: [id])

  @@index([roomId, createdAt])
  @@index([authorId])
  @@index([replyToId])
  @@index([deletedAt])
}

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

model Call {
  id         String    @id @default(cuid())
  roomId     String
  callerId   String
  status     String    @default("ringing")
  offerSdp   String?
  answerSdp  String?
  startedAt  DateTime  @default(now())
  answeredAt DateTime?
  endedAt    DateTime?
  endedById  String?
  room       Room      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  caller     User      @relation("CallCaller", fields: [callerId], references: [id])
  participants CallParticipant[]

  @@index([roomId, status])
}

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

model UploadedFile {
  id         String    @id @default(cuid())
  uploaderId String
  url        String
  fileName   String
  fileSize   Int
  mimeType   String
  storageKey String?
  createdAt  DateTime  @default(now())
  uploader   User      @relation(fields: [uploaderId], references: [id])
  messages   Message[]

  @@index([uploaderId])
}

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

model RoomInvite {
  id        String   @id @default(cuid())
  roomId    String
  inviterId String
  inviteeId String
  status    String   @default("pending")
  createdAt DateTime @default(now())

  // Intentionally no Prisma @relation FKs in v2 — application-level consistency
  // (avoids cascade graphs; Room/User deletes must clean invites in service layer)
  // Future: room Room @relation(...); inviter/invitee User @relation(...)

  @@unique([roomId, inviteeId])
  @@index([inviteeId, status])
}

model AppSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}

model AuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  action     String
  targetType String?
  targetId   String?
  meta       String?
  createdAt  DateTime @default(now())

  @@index([actorId])
  @@index([createdAt])
  @@index([action])
}
```

### 2.5 Serialization contracts (frontend-facing)

**User public:** `{ id, username, displayName?, bio?, avatarUrl? }`  
**Message:** see frozen frontend / previous TZ (includes `authorUsername`, `reactions` map, ISO dates)  
**Room:** includes `participants[]` with nested `user`, `participantIds`, optional `unreadCount`

### 2.6 Seed (dev)

- Users: `test/test123`, `alice/alice123`
- One direct room with 5 sample messages (parity with mock)
- AppSetting ice_servers + modules flags false

---

## Next sections (not written yet)

3. Auth (JWT claims, middleware)  
4. REST endpoints (full tables)  
5. WebSocket protocol + envelope  
6. Files  
7. Calls Phase 3  
8. Presence & typing TTL  
9. Cursor pagination  
10. Rate limit & security  
11. Migrations & seed scripts  
12. JSON response schemas / OpenAPI optional  

**Review checkpoint:** утвердить §1–2 (стек, Prisma-only, soft-delete policy, 16 models, Phase split) before §3–5.

---

## 3. Authentication

### 3.1 Mechanism

- **Algorithm:** HS256 JWT
- **Secret:** `JWT_SECRET` (env, min 32 chars in prod)
- **TTL:** `JWT_TTL_SECONDS` default **604800** (7 days)
- **Transport:**
  - REST: `Authorization: Bearer <token>`
  - WS: `ws://host/ws?token=<token>` (query; fragment not available to server)

### 3.2 Claims

```json
{
  "sub": "<userId>",
  "username": "<username>",
  "iat": 0,
  "exp": 0
}
```

No refresh token in v2. Expired/invalid → `401` + client `clearAuth()`.

### 3.3 Password

- bcrypt cost ≥ 10
- Min length 6 (align with practical UX; document in validation)
- Never log or return hash

### 3.4 Endpoints behavior

| Endpoint | Rules |
|----------|--------|
| `POST /auth/register` | username unique → 409 `USER_EXISTS`; create user; return `{ id, username, token }` **201** |
| `POST /auth/login` | verify password; 401 on fail; return `{ id, username, token }` **200** |
| `POST /auth/logout` | **200** `{ ok: true }` always if authenticated; JWT mode = no server revoke (optional denylist later) |
| `GET /auth/me` | current user DTO + `balance` |
| `GET /auth/config` | **no auth**; `{ modules: { sms: false, payments: false }, ice_servers: [...] }` from env/AppSetting |

### 3.5 Middleware

```text
authRequired:
  missing/invalid/expired token → 401
  sets req.user = { id, username }

authOptional:
  for routes that may work both ways (none in MVP critical path)
```

### 3.6 WS auth

On connection:

1. Parse `token` query param  
2. Verify JWT  
3. Fail → close code **4401** (or 1008) + no `auth_ok`  
4. Success → register connection in hub; send `{ type: "auth_ok", payload: { userId } }`  
5. Set user presence online (memory + optional DB status)  
6. On close → remove connection; if last socket for user → offline + `lastSeenAt=now` + broadcast `presence_update`

---

## 4. REST API

### 4.1 Conventions

- JSON UTF-8; dates **ISO-8601** strings in responses
- List rooms: **array** (not `{ rooms: [] }`) — matches frontend `apiGetRooms`
- Messages page: `{ messages: Message[], nextCursor: string | null }`
- Upload response: `{ url, fileName, fileSize, mimeType }` (frontend also accepts `mimeType`)

### 4.2 Auth routes

| METHOD | PATH | AUTH | INPUT | SUCCESS | ERRORS |
|--------|------|------|-------|---------|--------|
| POST | `/auth/register` | no | `{ username, password }` | 201 `{ id, username, token }` | 400 validation; 409 USER_EXISTS |
| POST | `/auth/login` | no | `{ username, password }` | 200 `{ id, username, token }` | 400; 401 |
| POST | `/auth/logout` | yes | — | 200 `{ ok: true }` | 401 |
| GET | `/auth/me` | yes | — | 200 `{ id, username, balance, displayName?, bio? }` | 401 |
| GET | `/auth/config` | no | — | 200 config object | — |

**Idempotency:** register not idempotent; login is safe to retry.

### 4.3 Rooms

| METHOD | PATH | AUTH | INPUT | SUCCESS | SIDE EFFECTS / TX |
|--------|------|------|-------|---------|-------------------|
| GET | `/rooms` | yes | — | 200 `Room[]` active memberships (`leftAt` null, room not soft-deleted) | include participants, optional unreadCount |
| POST | `/rooms` | yes | `{ type, participantIds[], name? }` | 200/201 `Room` | **tx:** create room + members; direct: reuse existing pair if found |
| GET | `/rooms/:id/messages` | yes | `?cursor&limit` | 200 `{ messages, nextCursor }` | member only; order createdAt DESC |
| GET | `/rooms/:id/participants` | yes | — | 200 participants[] | member only |
| POST | `/rooms/:id/leave` | yes | — | 200 `{ ok: true }` | set `leftAt`; unsubscribe WS |
| POST | `/rooms/:id/rejoin` | yes | — | 200 Room or `{ ok }` | clear `leftAt` if not banned |
| POST | `/rooms/:id/participants` | yes | `{ userId }` | 200 | admin/owner; not banned |
| GET | `/rooms/:id/unread` | yes | — | 200 `{ count }` | messages not read by me, not mine |
| GET | `/rooms/:id/last-message` | yes | — | 200 Message or `null` | member only |

**Validation:**

- `type` ∈ `direct|group`
- direct: `participantIds` length 1 (other user); server adds self
- group: `name` required non-empty; `participantIds` ≥ 0

### 4.4 Messages

| METHOD | PATH | AUTH | INPUT | SUCCESS | NOTES |
|--------|------|------|-------|---------|-------|
| PATCH | `/messages/:id/edit` | yes | `{ text }` | 200 Message | author only; set editedAt |
| DELETE | `/messages/:id` | yes | — | 200 | soft delete; author or group admin |
| POST | `/messages/forward` | yes | `{ messageId, targetRoomId, clientMessageId }` | 200 Message | member of both rooms |
| POST | `/messages/:id/react` | yes | `{ emoji }` | 200 reaction payload | toggle; same shape as WS |
| GET | `/messages/:id/reactions` | yes | — | 200 | map or list |
| POST | `/messages/:id/pin` | yes | `?roomId=` | 200 | Phase 2; admin/owner |
| DELETE | `/messages/:id/pin` | yes | `?roomId=` | 200 `{ ok }` | Phase 2 |
| GET | `/messages/pinned/:roomId` | yes | — | 200 Message[] | Phase 2 |
| POST | `/messages/read` | yes | `{ messageIds[], roomId }` | 200 `{ readCount }` | createMany skipDuplicates |
| GET | `/messages/search` | yes | `?q&roomId&limit` | 200 Message[] | Phase 2; membership filter |
| POST | `/messages/upload` | yes | multipart `file` | 200 `{ url, fileName, fileSize, mimeType }` | max 50MB |

**Note:** Primary send path is **WS** `chat_message` / `media_message`. REST edit/delete/react/read mirror protocol for non-WS clients and frontend helpers.

### 4.5 Users

| METHOD | PATH | AUTH | INPUT | SUCCESS |
|--------|------|------|-------|---------|
| GET | `/users/profile` | yes | — | own profile |
| PATCH | `/users/profile` | yes | `{ displayName?, bio?, avatarUrl? }` | updated profile |
| GET | `/users/:id` | yes | — | public profile |
| GET | `/users/search` | yes | `?q&limit=20` | User[] |
| POST | `/users/block` | yes | `{ userId }` | `{ ok }` |
| DELETE | `/users/block/:id` | yes | — | `{ ok }` |
| GET | `/users/blocks` | yes | — | User[] |
| POST | `/users/presence` | yes | `{ userIds[] }` | `{ [id]: { status, lastSeenAt } }` |

### 4.6 Groups (Phase 2)

| METHOD | PATH | AUTH | INPUT | SUCCESS | AUTHZ |
|--------|------|------|-------|---------|-------|
| GET | `/groups/:roomId/roles` | yes | — | role map/list | member |
| POST | `/groups/:roomId/promote` | yes | `{ userId }` | `{ ok }` | owner/admin |
| POST | `/groups/:roomId/demote` | yes | `{ userId }` | `{ ok }` | owner/admin |
| POST | `/groups/:roomId/kick` | yes | `{ userId }` | `{ ok }` | owner/admin; set leftAt |
| POST | `/groups/:roomId/ban` | yes | `{ userId }` | `{ ok }` | owner/admin; GroupBan + kick |
| PATCH | `/groups/:roomId` | yes | `{ name?, description?, avatarUrl? }` | Room | owner/admin |

### 4.7 Authorization matrix (summary)

| Action | direct | group member | group admin | group owner |
|--------|--------|--------------|-------------|-------------|
| read/send messages | ✓ if active member | ✓ | ✓ | ✓ |
| edit/delete own message | ✓ | ✓ | ✓ | ✓ |
| delete others' message | — | — | ✓ | ✓ |
| pin | — | — | ✓ | ✓ |
| add participant | — | — | ✓ | ✓ |
| kick/ban/promote | — | — | ✓* | ✓ |
| leave | ✓ | ✓ | ✓ | ✓ (transfer owner later) |

\* promote to admin: owner only (recommended)

---

## 5. WebSocket protocol

### 5.1 Connection

```text
URL:  ws://<host>:<port>/ws?token=<JWT>
```

After successful auth, server → client:

```json
{ "type": "auth_ok", "payload": { "userId": "<id>" } }
```

### 5.2 Envelope (canonical)

All frames (both directions):

```json
{
  "type": "<string>",
  "requestId": "<string|optional>",
  "payload": { },
  "serverVersion": "<number|optional, future>"
}
```

- **Client → server:** `requestId` used for correlation on sends that need ACK (e.g. equals `clientMessageId` for chat).
- **Server → client:** on chat ACK, set `requestId` to the client's `clientMessageId` / requestId so frontend replaces optimistic row.
- Unknown `type` from client → `{ type: "error", requestId, code: "UNKNOWN_TYPE", message: "..." }`

### 5.3 Client → Server

| type | payload | Server behavior | Reply / broadcast |
|------|---------|-----------------|-------------------|
| `subscribe` | `{ roomId }` | verify membership; add to roomSubs | `subscribed` `{ roomId }` |
| `rejoin` | `{ roomId }` | same as subscribe; optional clear leftAt if policy allows | `rejoined` `{ roomId }` |
| `chat_message` | `{ roomId, text, clientMessageId, replyToId? }` | insert Message type=text; idempotent on clientMessageId | broadcast `chat_message` full Message; **include requestId** for sender ACK |
| `media_message` | `{ roomId, clientMessageId, type, fileUrl, fileName, fileSize, fileMimeType, text?, replyToId? }` | insert Message | same as chat_message |
| `edit_message` | `{ messageId, text }` | author only; update text+editedAt | broadcast `message_edited` `{ id, text, editedAt }` |
| `delete_message` | `{ messageId }` | soft delete | broadcast `message_deleted` `{ id, deletedAt }` |
| `forward_message` | `{ messageId, targetRoomId, clientMessageId }` | copy to target room | broadcast `chat_message` in target (+ requestId) |
| `message_reaction` | `{ messageId, emoji }` | toggle reaction | broadcast `message_reaction` `{ messageId, userId, emoji, added, reactions }` |
| `messages_read` | `{ messageIds[], roomId }` | MessageRead createMany | `messages_read_ack` `{ readCount }` + broadcast `messages_read` `{ userId, messageIds }`; optional `message_read_by` to authors |
| `typing_start` | `{ roomId }` | memory TTL (e.g. 5s) | broadcast `typing_start` `{ userId, roomId }` exclude self |
| `typing_stop` | `{ roomId }` | clear typing | broadcast `typing_stop` |
| `call_offer` | `{ roomId, sdp }` | **Phase 3** | `call_created` + broadcast `call_offer` |
| `call_answer` | `{ callId, sdp }` | **Phase 3** | broadcast `call_answer` |
| `ice_candidate` | `{ callId, candidate }` | **Phase 3** | broadcast `ice_candidate` |
| `hangup` | `{ callId }` | **Phase 3** | broadcast `call_ended` |

Phase 1–2 server may respond to call_* with `error` `NOT_IMPLEMENTED` or ignore until Phase 3.

### 5.4 Server → Client (push)

| type | payload | When |
|------|---------|------|
| `auth_ok` | `{ userId }` | connect |
| `subscribed` / `rejoined` | `{ roomId }` | after subscribe/rejoin |
| `chat_message` | full Message | new/forwarded message; ACK uses requestId |
| `message_edited` | `{ id, text, editedAt }` | edit |
| `message_deleted` | `{ id, deletedAt }` | soft delete |
| `message_reaction` | `{ messageId, userId, emoji, added, reactions }` | toggle |
| `messages_read` | `{ userId, messageIds[] }` | someone read |
| `messages_read_ack` | `{ readCount }` | to reader |
| `message_read_by` | `{ userId, messageId, roomId }` | to author |
| `typing_start` / `typing_stop` | `{ userId, roomId }` | typing |
| `presence_update` | `{ userId, status }` | online/offline/away |
| `message_pinned` | `{ messageId, pinnedBy, pinnedAt }` | Phase 2 |
| `message_unpinned` | `{ messageId }` | Phase 2 |
| `call_created` | `{ callId }` | Phase 3 |
| `call_offer` | `{ callId, sdp, fromUserId }` | Phase 3 |
| `call_answer` | `{ callId, sdp }` | Phase 3 |
| `ice_candidate` | `{ callId, candidate, fromUserId }` | Phase 3 |
| `call_ended` | `{ callId, endedBy }` | Phase 3 |
| `error` | `{ code, message }` + optional requestId | failures |

### 5.5 Broadcast rules

- Only to users with **active membership** (`leftAt` null) and **active WS subscription** to room (or all user connections if product chooses fan-out by membership — **recommended:** fan-out to all connections of members who are subscribed OR all members' sockets for messages; **MVP:** all open sockets of room members).
- **Frontend expectation:** user may only `subscribe` active room; still deliver to other rooms for unread (frontend updates badges via `loadRooms`). **MVP choice:** broadcast `chat_message` to all connected members of the room (not only subscribed), so inactive tabs get unread updates.
- Never send to blocked pairs if block policy enabled on DM.

### 5.6 Reconnect

- Client reconnects with same JWT; server does not resume message stream automatically.
- Client sends `rejoin` / `subscribe` for `activeRoomId` (frontend `wsResubscribe`).
- No durable server-side offline queue in v2 (client refetches history via REST).

### 5.7 Typing TTL

- On `typing_start`, set expiry ~3–5s; auto `typing_stop` broadcast if no refresh.
- Matches frontend `TYPING_STOP_DELAY` ~3000ms.

### 5.8 Presence

- Online: at least one WS connection.
- Offline on last disconnect; persist `User.lastSeenAt`, `status`.
- `POST /users/presence` returns DB snapshot + overlay online from memory.

---

## Checkpoint

| Section | Status |
|---------|--------|
| §1 Stack | ACCEPTED |
| §2 Schema (+ 3 fixes) | ACCEPTED |
| §3 Auth | DRAFT — review |
| §4 REST | DRAFT — review |
| §5 WS | DRAFT — review |

**Next:** §6 Files, §8 Presence detail, §9 Cursors, §10 Security, §11 Seed — or implement scaffold after §3–5 acceptance.
