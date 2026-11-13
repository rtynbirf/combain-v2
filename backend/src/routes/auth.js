const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { signToken, authRequired, revokeToken } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const config = require('../config');
const store = require('../services/store');

const router = express.Router();

// Phase 2: усиленная валидация. Username: 3–24 символа [a-zA-Z0-9_];
// password: 8–128 символов, минимум одна буква и одна цифра.
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
function passwordError(p) {
  if (p.length < 8 || p.length > 128) return 'Password must be 8-128 characters';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain a letter and a digit';
  return null;
}

// Анти-брутфорс: считаем только НЕудачные попытки (успешный логин не наказывается),
// строгий лимит на IP. Глобальный rate-limit дальше по стеку — отдельно не считаем.
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.authLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, slow down' } },
});

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!USERNAME_RE.test(username)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Username must be 3-24 chars [a-zA-Z0-9_]');
    }
    const pErr = passwordError(password);
    if (pErr) throw new AppError(400, 'VALIDATION_ERROR', pErr);
    if (store.getUserByUsername(username)) {
      throw new AppError(409, 'USER_EXISTS', 'Username already taken');
    }
    const id = store.cuid();
    const ts = store.now();
    const passwordHash = await bcrypt.hash(password, 10);
    store.db.prepare(`
      INSERT INTO User (id,username,passwordHash,displayName,balance,status,createdAt,updatedAt)
      VALUES (?,?,?,?,0,'offline',?,?)
    `).run(id, username, passwordHash, username, ts, ts);
    const user = store.getUserById(id);
    res.status(201).json({ id: user.id, username: user.username, token: signToken(user) });
  } catch (e) { next(e); }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = store.getUserByUsername(username);
    // Удалённый (soft-deleted) пользователь — те же «Invalid credentials», без утечек
    if (!user || user.deletedAt || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }
    res.json({ id: user.id, username: user.username, token: signToken(user) });
  } catch (e) { next(e); }
});

// Phase 2: logout реально отзывает токен (jti → RevokedToken); сессия на другом устройстве продолжает жить
router.post('/logout', authRequired, (req, res) => {
  revokeToken(req.token);
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res, next) => {
  try {
    const user = store.getUserById(req.user.id);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found');
    res.json({
      id: user.id, username: user.username, balance: user.balance,
      displayName: user.displayName, bio: user.bio,
    });
  } catch (e) { next(e); }
});

router.get('/config', (req, res) => {
  res.json({ modules: { sms: false, payments: false }, ice_servers: config.iceServers });
});

module.exports = router;
