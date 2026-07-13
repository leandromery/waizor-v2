#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# waizor-v2 — drain scheduled automation & flow work.
#
# The app exposes two cron endpoints that must be pinged on a schedule:
#   GET /api/automations/cron  — resumes "Wait" steps in automations
#   GET /api/flows/cron        — times out abandoned flow runs
# Both authenticate with the `x-cron-secret` header == AUTOMATION_CRON_SECRET.
#
# Install (every 5 minutes) via crontab on the VPS:
#   */5 * * * * AUTOMATION_CRON_SECRET=xxxx /opt/waizor-v2/deploy/cron-ping.sh >> /var/log/waizor-cron.log 2>&1
#
# Or export AUTOMATION_CRON_SECRET in the environment before calling.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${WAIZOR_BASE_URL:-https://v2.waizor.com.br}"
SECRET="${AUTOMATION_CRON_SECRET:?AUTOMATION_CRON_SECRET must be set}"

for path in /api/automations/cron /api/flows/cron; do
  curl -fsS -m 60 \
    -H "x-cron-secret: ${SECRET}" \
    "${BASE_URL}${path}" \
    && echo " <- ${path} $(date -u +%FT%TZ)"
done
