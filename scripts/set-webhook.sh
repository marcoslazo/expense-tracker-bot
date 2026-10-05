#!/usr/bin/env bash
# Registers (or re-registers) the Telegram webhook pointing at the Cloud Run
# service. Only needed once per service URL, or after rotating
# WEBHOOK_SECRET_TOKEN — it's not part of the deploy itself.
#
# Usage:
#   TELEGRAM_BOT_TOKEN=... CLOUD_RUN_URL=https://... WEBHOOK_SECRET_TOKEN=... \
#     ./scripts/set-webhook.sh

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${CLOUD_RUN_URL:?CLOUD_RUN_URL is not set (the Cloud Run service URL, no trailing /)}"
: "${WEBHOOK_SECRET_TOKEN:?WEBHOOK_SECRET_TOKEN is not set}"

response=$(curl -sS \
  --data-urlencode "url=${CLOUD_RUN_URL}/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET_TOKEN}" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook")

echo "$response"

if command -v node >/dev/null 2>&1; then
  ok=$(echo "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).ok)}catch{console.log('false')}})")
  if [ "$ok" != "true" ]; then
    echo "setWebhook failed — check the response above." >&2
    exit 1
  fi
fi

echo "Webhook registered at ${CLOUD_RUN_URL}/webhook"
