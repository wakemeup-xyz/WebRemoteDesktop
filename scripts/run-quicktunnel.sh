#!/bin/bash
set -euo pipefail

CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
LOG_FILE="${LOG_FILE:-/tmp/cloudflared-wrd.log}"
URL_FILE="${URL_FILE:-/tmp/wrd-current-url.txt}"

while true; do
  : > "$LOG_FILE"
  "$CLOUDFLARED" tunnel --protocol http2 --url "$ORIGIN" >> "$LOG_FILE" 2>&1 &
  pid=$!

  url=""
  for _ in $(seq 1 45); do
    url=$(grep -Eo 'https://[^[:space:]]+\.trycloudflare\.com' "$LOG_FILE" | tail -1 || true)
    if [ -n "$url" ]; then
      printf '%s\n' "$url" > "$URL_FILE"
      break
    fi
    sleep 1
  done

  while kill -0 "$pid" 2>/dev/null; do
    if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
      echo "$(date -u +%FT%TZ) quick tunnel expired, restarting" >> "$LOG_FILE"
      kill "$pid" 2>/dev/null || true
      break
    fi
    sleep 15
  done

  wait "$pid" 2>/dev/null || true
  sleep 2
done
