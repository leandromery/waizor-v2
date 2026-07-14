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

# `docker stack deploy` compares the service spec, not the image contents.
# Because the tag (waizor-v2:latest) is textually unchanged, Swarm sees
# "no change" and does NOT recreate the task — so a freshly rebuilt image
# is never promoted and the old container keeps running. Force a recreate
# with the just-built local :latest; start-first keeps it zero-downtime.
echo "==> Forcing the service to pick up the freshly built image..."
docker service update --force --update-order start-first waizor_app

echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Done. Service state:"
docker service ps waizor_app --no-trunc | head -5
