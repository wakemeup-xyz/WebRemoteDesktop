#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
LOG_FILE="${LOG_FILE:-/tmp/wrd-safe-quicktunnel.log}"
URL_FILE="${URL_FILE:-/tmp/wrd-safe-current-url.txt}"
URL_ARCHIVE_FILE="${URL_ARCHIVE_FILE:-/tmp/wrd-safe-current-url.last.txt}"
PID_FILE="${PID_FILE:-/tmp/wrd-safe-quicktunnel.pid}"
URL_POLL_ATTEMPTS="${URL_POLL_ATTEMPTS:-45}"
URL_POLL_INTERVAL_SECONDS="${URL_POLL_INTERVAL_SECONDS:-1}"
WATCH_INTERVAL_SECONDS="${WATCH_INTERVAL_SECONDS:-15}"
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-2}"
URL_READY_TIMEOUT_SECONDS="${URL_READY_TIMEOUT_SECONDS:-60}"
UNREACHABLE_URL_FAIL_LIMIT="${UNREACHABLE_URL_FAIL_LIMIT:-4}"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

extract_trycloudflare_url() {
  local source_file="$1"
  [ -f "$source_file" ] || return 1
  grep -Eo 'https://[^[:space:]]+\.trycloudflare\.com' "$source_file" | tail -1
}

wait_for_public_url() {
  local url="$1"
  local waited=0
  [ -n "$url" ] || return 1

  while [ "$waited" -lt "$URL_READY_TIMEOUT_SECONDS" ]; do
    if wrd_safe_url_is_reachable "$url"; then
      return 0
    fi
    sleep "$URL_POLL_INTERVAL_SECONDS"
    waited=$((waited + URL_POLL_INTERVAL_SECONDS))
  done

  return 1
}

cd "$PROJECT_DIR"
curl -fsS "http://127.0.0.1:8080/health" >/dev/null

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    PID="$OLD_PID"
    URL="$(cat "$URL_FILE" 2>/dev/null || true)"
    if [ -z "$URL" ]; then
      URL="$(cat "$URL_ARCHIVE_FILE" 2>/dev/null || true)"
    fi
    if [ -z "$URL" ]; then
      URL="$(extract_trycloudflare_url "$LOG_FILE" || true)"
      if [ -n "$URL" ]; then
        if wait_for_public_url "$URL"; then
          printf '%s\n' "$URL" > "$URL_FILE"
          printf '%s\n' "$URL" > "$URL_ARCHIVE_FILE"
        else
          URL=""
        fi
      fi
    fi
    echo "safe quick tunnel already running (pid=$OLD_PID)"
    if [ -n "$URL" ]; then
      echo "url: $URL"
    else
      echo "url: pending"
    fi
  else
    PID=""
  fi
else
  PID=""
fi

while true; do
  if [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
    : > "$LOG_FILE"
    nohup "$CLOUDFLARED" tunnel --protocol http2 --url "$ORIGIN" >> "$LOG_FILE" 2>&1 &
    PID=$!
    disown "$PID" 2>/dev/null || true
    echo "$PID" > "$PID_FILE"
  fi

  URL=""
  for _ in $(seq 1 "$URL_POLL_ATTEMPTS"); do
    if [ -z "$URL" ] && [ -s "$URL_FILE" ]; then
      URL=$(cat "$URL_FILE" 2>/dev/null || true)
    fi
    LOG_URL=$(extract_trycloudflare_url "$LOG_FILE" || true)
    if [ -n "$LOG_URL" ]; then
      URL="$LOG_URL"
    fi
    if [ -n "$URL" ]; then
      if wait_for_public_url "$URL"; then
        printf '%s\n' "$URL" > "$URL_FILE"
        printf '%s\n' "$URL" > "$URL_ARCHIVE_FILE"
        echo "$URL"
        break
      fi
      echo "$(date -u +%FT%TZ) safe quick tunnel url not reachable yet: $URL" >> "$LOG_FILE"
      URL=""
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep "$URL_POLL_INTERVAL_SECONDS"
  done

  if [ -z "$URL" ]; then
    if [ -s "$URL_FILE" ]; then
      URL=$(cat "$URL_FILE" 2>/dev/null || true)
    elif [ -s "$URL_ARCHIVE_FILE" ]; then
      URL=$(cat "$URL_ARCHIVE_FILE" 2>/dev/null || true)
    elif [ -s "$LOG_FILE" ]; then
      URL=$(extract_trycloudflare_url "$LOG_FILE" || true)
      if [ -n "$URL" ]; then
        if wait_for_public_url "$URL"; then
          printf '%s\n' "$URL" > "$URL_FILE"
          printf '%s\n' "$URL" > "$URL_ARCHIVE_FILE"
        else
          URL=""
        fi
      fi
    fi
    if [ -z "$URL" ]; then
      echo "failed to obtain quick tunnel url"
      tail -n 40 "$LOG_FILE" || true
      exit 1
    fi
  fi

  while kill -0 "$PID" 2>/dev/null; do
    UNREACHABLE_URL_FAIL_COUNT=0
    if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
      echo "$(date -u +%FT%TZ) safe quick tunnel expired, restarting" >> "$LOG_FILE"
      kill "$PID" 2>/dev/null || true
      break
    fi
    if [ -s "$URL_FILE" ]; then
      CURRENT_URL=$(cat "$URL_FILE" 2>/dev/null || true)
      if [ -n "$CURRENT_URL" ]; then
        if wrd_safe_url_is_reachable "$CURRENT_URL"; then
          UNREACHABLE_URL_FAIL_COUNT=0
        else
          UNREACHABLE_URL_FAIL_COUNT=$((UNREACHABLE_URL_FAIL_COUNT + 1))
          echo "$(date -u +%FT%TZ) safe quick tunnel url not reachable yet: $CURRENT_URL" >> "$LOG_FILE"
          if [ "$UNREACHABLE_URL_FAIL_COUNT" -ge "$UNREACHABLE_URL_FAIL_LIMIT" ]; then
            echo "$(date -u +%FT%TZ) safe quick tunnel url unreachable too long, restarting" >> "$LOG_FILE"
            rm -f "$URL_FILE"
            kill "$PID" 2>/dev/null || true
            break
          fi
        fi
      fi
    fi
    sleep "$WATCH_INTERVAL_SECONDS"
  done

  wait "$PID" 2>/dev/null || true
  PID=""
  sleep "$RESTART_DELAY_SECONDS"
done
