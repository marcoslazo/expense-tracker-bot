#!/usr/bin/env bash
# Brings up the WARP tunnel (gluetun) and, once it's healthy, rebuilds and
# starts the bot in long-polling mode — all in one command, for networks that
# block Telegram. See docs/self-hosting.md (Logs and troubleshooting) for the
# manual step-by-step procedure this script automates.
#
# Requires having run ./scripts/generate-warp-profile.sh at least once
# (it creates warp/wgcf-profile.conf).
#
# Usage:
#   ./scripts/dev-warp.sh [log-level]
#   ./scripts/dev-warp.sh debug

set -euo pipefail

LOG_LEVEL="${1:-info}"
export LOG_LEVEL

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.warp.yml)

if [ ! -f warp/wgcf-profile.conf ]; then
  echo "warp/wgcf-profile.conf not found — run ./scripts/generate-warp-profile.sh first" >&2
  exit 1
fi

cleanup() {
  echo "Stopping gluetun and the bot..."
  "${COMPOSE[@]}" down
}
trap cleanup EXIT

echo "Starting WARP tunnel (gluetun)..."
"${COMPOSE[@]}" up -d gluetun

echo "Waiting for gluetun to become healthy..."
container_id=$("${COMPOSE[@]}" ps -q gluetun)
attempts=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container_id")" = "healthy" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo "gluetun did not become healthy after 60s — check warp/wgcf-profile.conf" >&2
    exit 1
  fi
  sleep 1
done

echo "Tunnel ready. Rebuilding the image and starting the bot (LOG_LEVEL=${LOG_LEVEL}, Ctrl+C to stop everything)..."
"${COMPOSE[@]}" up --build bot
