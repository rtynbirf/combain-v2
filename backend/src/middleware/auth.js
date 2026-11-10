const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('../utils/errors');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: config.jwtTtl }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return next(new AppError(401, 'UNAUTHORIZED', 'Missing token'));
  try {
    const payload = verifyToken(m[1]);
    req.user = { id: payload.sub, username: payload.username };
    req.token = m[1];
    next();
  } catch (e) {
    next(new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token'));
  }
}

module.exports = { signToken, verifyToken, authRequired };
