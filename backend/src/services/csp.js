// services/csp.js — Phase 3a: CSP, автогенерируемая из фактического контента фронтенда.
// Сервер читает public/index.html и разрешает ровно те байты, которые сам и раздаёт:
//   - hash inline <style>-блоков            → style-src
//   - hash тел inline on*-обработчиков      → script-src-attr ('unsafe-hashes')
// Никакого 'unsafe-inline' в script-контексте: любые изменённые байты фронтенда
// не исполнятся, пока их hash не появится в самом файле — заголовок пересчитывается
// по mtime+size и автоматически следует за фронтом.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cache = { mtimeMs: null, size: null, policy: null };

function sha256b64(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('base64');
}

function buildPolicy(html) {
  const styleHashes = [];
  const attrHashes = [];
  let m;

  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(html)) !== null) {
    if (m[1].trim()) styleHashes.push(`'sha256-${sha256b64(m[1])}'`);
  }

  // Телом hash-источника обработчика является значение атрибута как есть.
  const attrRe = /\son[a-z]+\s*=\s*"([^"]*)"/gi;
  const seen = new Set();
  while ((m = attrRe.exec(html)) !== null) {
    if (!m[1].trim()) continue;
    const h = `sha256-${sha256b64(m[1])}`;
    if (!seen.has(h)) { seen.add(h); attrHashes.push(`'${h}'`); }
  }

  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    attrHashes.length
      ? `script-src-attr 'unsafe-hashes' ${attrHashes.join(' ')}`
      : "script-src-attr 'none'",
    styleHashes.length ? `style-src 'self' ${styleHashes.join(' ')}` : "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self'",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  return directives.join('; ');
}

function getPolicy(publicDir) {
  if (!publicDir) return null;
  const file = path.join(publicDir, 'index.html');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (cache.policy && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.policy;
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return null; }
  cache.policy = buildPolicy(html);
  cache.mtimeMs = st.mtimeMs;
  cache.size = st.size;
  return cache.policy;
}

module.exports = { getPolicy, buildPolicy };
