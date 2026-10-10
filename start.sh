#!/bin/sh
# One command: install on first run, build the UI, serve everything on http://localhost:8000
set -e
cd "$(dirname "$0")"
[ -d api/.venv ] || (cd api && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt)
[ -d web/node_modules ] || (cd web && npm install)
[ -f .env ] || cp .env.example .env
(cd web && npm run build --silent)
cd api && exec .venv/bin/uvicorn main:app --env-file ../.env --host 127.0.0.1 --port 8000
