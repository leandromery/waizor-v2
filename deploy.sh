#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# waizor-v2 — pull latest code and rebuild the container.
# Run on the VPS from the repo root (e.g. /opt/waizor-v2).
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy it from .env.production.example first." >&2
  exit 1
fi

echo "==> Pulling latest code..."
git pull --ff-only

echo "==> Building and (re)starting container..."
docker compose up -d --build --remove-orphans

echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Done. Recent logs:"
docker compose logs --tail=30 app
