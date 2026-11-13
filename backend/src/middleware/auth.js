const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { db, cuid } = require('../db');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, jti: cuid() },
    config.jwtSecret,
    { expiresIn: config.jwtTtl }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

// Phase 2: отзыв токена по jti. Legacy-токен без jti отозвать нельзя — он просто истечёт.
function revokeToken(token) {
  const p = jwt.decode(token);
  if (!p || !p.jti) return false;
  const expiresAt = new Date((p.exp || Math.floor(Date.now() / 1000) + 60) * 1000).toISOString();
  db.prepare('INSERT OR IGNORE INTO RevokedToken (jti,expiresAt,createdAt) VALUES (?,?,?)')
    .run(p.jti, expiresAt, new Date().toISOString());
  return true;
}

function isRevoked(jti) {
  return !!db.prepare('SELECT 1 FROM RevokedToken WHERE jti = ?').get(jti);
}

// Сборка мусора: отозванные токены, чей срок истёк, больше не нужны (вызывается по таймеру из index.js)
function cleanupRevoked() {
  db.prepare('DELETE FROM RevokedToken WHERE expiresAt < ?').run(new Date().toISOString());
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return next(new AppError(401, 'UNAUTHORIZED', 'Missing token'));
  let payload;
  try {
    payload = verifyToken(m[1]);
  } catch {
    return next(new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token'));
  }
  // Phase 2: logout/GDPR-отзыв — токен с таким jti мёртв
  if (payload.jti && isRevoked(payload.jti)) {
    return next(new AppError(401, 'TOKEN_REVOKED', 'Token revoked'));
  }
  // Phase 2: мягкое удаление — удалённый пользователь живёт только в истории сообщений
  const u = db.prepare('SELECT deletedAt FROM User WHERE id = ?').get(payload.sub);
  if (!u || u.deletedAt) return next(new AppError(401, 'TOKEN_INVALID', 'Account unavailable'));
  req.user = { id: payload.sub, username: payload.username };
  req.token = m[1];
  next();
}

module.exports = { signToken, verifyToken, authRequired, revokeToken, isRevoked, cleanupRevoked };
