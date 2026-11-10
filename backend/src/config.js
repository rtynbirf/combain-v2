require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const root = path.join(__dirname, '..');
const DEV_SECRET = 'combain-dev-secret-change-in-production-32chars';
const jwtSecret = process.env.JWT_SECRET || DEV_SECRET;
// Fail-fast: в проде запрещаем дефолтный секрет — иначе любые токены подделываемы
if (process.env.NODE_ENV === 'production' && jwtSecret === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set in production (see .env.example)');
}
module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret,
  jwtTtl: parseInt(process.env.JWT_TTL_SECONDS || '604800', 10),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || './uploads'),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  publicDir: path.resolve(root, process.env.PUBLIC_DIR || '../public'),
  iceServers: (() => {
    try { return JSON.parse(process.env.ICE_SERVERS_JSON || '[{"urls":"stun:stun.l.google.com:19302"}]'); }
    catch { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
  })(),
  // WS-хардненинг: список разрешённых Origin (CSWSH-защита).
  // Пусто = разрешены все (self-host за прокси; origin-проверку включает сам владелец).
  wsAllowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Максимальный байтовый размер WS-фрейма (файлы идут через HTTP/multer, не WS)
  wsMaxPayload: parseInt(process.env.WS_MAX_PAYLOAD || '131072', 10),
  // Лимит сообщений на соединение (анти-флуд): окно 10 секунд
  wsMsgLimit: parseInt(process.env.WS_MSG_LIMIT || '60', 10),
  // Лимит неудачных попыток логина/регистрации с одного IP за минуту
  authLimitMax: parseInt(process.env.AUTH_LIMIT_MAX || '30', 10),
};
