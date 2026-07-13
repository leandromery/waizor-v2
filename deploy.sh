#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# waizor-v2 — pull latest code, rebuild the image, redeploy the Swarm service.
# Run on the VPS from the repo root (e.g. /opt/waizor-v2).
#
# The app runs as a Docker Swarm service behind the existing Traefik proxy
# (see deploy/stack.yml). Swarm can't build, so we build with Compose first,
# then `docker stack deploy` picks up the freshly built waizor-v2:latest.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy it from .env.production.example first." >&2
  exit 1
fi

echo "==> Pulling latest code..."
git pull --ff-only

echo "==> Building waizor-v2:latest (bakes NEXT_PUBLIC_* from .env)..."
docker compose build

echo "==> Deploying the Swarm service..."
set -a; . ./.env; set +a
docker stack deploy -c deploy/stack.yml waizor

echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Done. Service state:"
docker service ps waizor_app --no-trunc | head -5
