# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project overview

Self-hosted мессенджер: Express + SQLite (WAL), realtime-доставка Class A/B,
бэкапы Litestream, TLS через Caddy, полный CI/CD (CI, CodeQL, OpenSSF Scorecard).
Карта развёртывания — `docker-compose.yml`, детали — `docs/` и `COMBAIN_BACKEND_TZ.md`.

## Commands

Сервер и тесты живут в `backend/` (Node.js): смотри `backend/package.json`
и следуй паттернам уже существующих файлов перед изменениями. Инфраструктура —
`Dockerfile`, `docker-compose.yml`, `deploy/`.

## Conventions

- Минимальные, сфокусированные изменения; одна логическая мысль — один коммит
  (формат `тип(область): суть по-русски`).
- Никогда не коммитить секреты, токены, ключи: секреты живут в локальных файлах вне git-слежки.
- README.md обновлять при изменении поведения или структуры.
- Перед коммитом прогонять доступные проверки; зелёный CI — закон дома
  (устав: `rtynbirf/repo-doctrine`, волны закрывают красное живым зелёным прогоном).
- Правило аддитивности: добавлять можно; удалять чужое и переписывать историю — нельзя
  (откат — только `git revert`, никогда force-push).
- Новые файлы — в манифесты тем же коммитом, если репо держит манифест свежести.
