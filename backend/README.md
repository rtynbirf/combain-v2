# COMBAIN v2 — Real Backend

Express + Prisma + SQLite. Matches frozen frontend contract.

## Setup

```bash
cd backend
npm install
npm run db:setup   # generate + push + seed
npm start
```

Open http://localhost:3000 (serves `../public` if present).

Accounts: `test/test123`, `alice/alice123`

## Scripts

- `npm run db:push` — apply schema
- `npm run db:seed` — seed users + sample room
- `npm test` — smoke test (server must be running)
