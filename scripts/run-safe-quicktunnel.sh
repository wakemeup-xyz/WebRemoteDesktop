#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
LOG_FILE="${LOG_FILE:-/tmp/wrd-safe-quicktunnel.log}"
URL_FILE="${URL_FILE:-/tmp/wrd-safe-current-url.txt}"
PID_FILE="${PID_FILE:-/tmp/wrd-safe-quicktunnel.pid}"

cd "$PROJECT_DIR"
curl -fsS "http://127.0.0.1:8080/health" >/dev/null

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "safe quick tunnel already running (pid=$OLD_PID)"
    echo "url: $(cat "$URL_FILE" 2>/dev/null || echo 'pending')"
    exit 0
  fi
fi

while true; do
  : > "$LOG_FILE"
  nohup "$CLOUDFLARED" tunnel --protocol http2 --url "$ORIGIN" >> "$LOG_FILE" 2>&1 &
  PID=$!
  disown "$PID" 2>/dev/null || true
  echo "$PID" > "$PID_FILE"

  URL=""
  for _ in $(seq 1 45); do
    URL=$(grep -Eo 'https://[^[:space:]]+\.trycloudflare\.com' "$LOG_FILE" | tail -1 || true)
    if [ -n "$URL" ]; then
      printf '%s\n' "$URL" > "$URL_FILE"
      echo "$URL"
      break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "failed to obtain quick tunnel url"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi

  while kill -0 "$PID" 2>/dev/null; do
    if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
      echo "$(date -u +%FT%TZ) safe quick tunnel expired, restarting" >> "$LOG_FILE"
      kill "$PID" 2>/dev/null || true
      break
    fi
    sleep 15
  done

  wait "$PID" 2>/dev/null || true
  sleep 2
done
