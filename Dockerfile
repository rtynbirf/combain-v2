# syntax=docker/dockerfile:1
# ── COMBAIN v2 — production image (multi-stage, non-root, healthcheck) ──

FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
# Node 26 отложен честно: в better-sqlite3 13.0.3 нет musl-пребилда под ABI 147 —
# npm ci на alpine падает в node-gyp (нет python/make/g++ в образе и не нужно).
# Вернуть node:26-alpine, когда в bs3 появится prebuilds/linuxmusl-x64 под ABI 147.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads \
    LOG_DIR=/data/logs \
    PUBLIC_DIR=/app/public
RUN apk add --no-cache tini
WORKDIR /app/backend
COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend/ .
COPY public /app/public
RUN mkdir -p /data /data/uploads && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)throw 0}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
