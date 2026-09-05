#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
# Isolate quick tunnel from ~/.cloudflared/config.yml named-tunnel settings.
# Without this, cloudflared reuses named-tunnel material and trycloudflare edges 404.
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-/dev/null}"
ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
LOG_FILE="${LOG_FILE:-/tmp/wrd-safe-quicktunnel.log}"
URL_FILE="${URL_FILE:-/tmp/wrd-safe-current-url.txt}"
URL_ARCHIVE_FILE="${URL_ARCHIVE_FILE:-/tmp/wrd-safe-current-url.last.txt}"
PID_FILE="${PID_FILE:-/tmp/wrd-safe-quicktunnel.pid}"
URL_POLL_ATTEMPTS="${URL_POLL_ATTEMPTS:-45}"
URL_POLL_INTERVAL_SECONDS="${URL_POLL_INTERVAL_SECONDS:-1}"
WATCH_INTERVAL_SECONDS="${WATCH_INTERVAL_SECONDS:-15}"
URL_READY_TIMEOUT_SECONDS="${URL_READY_TIMEOUT_SECONDS:-60}"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

publish_safe_url() {
  local url="$1"
  local current_tmp="${URL_FILE}.tmp.$$"
  local archive_tmp="${URL_ARCHIVE_FILE}.tmp.$$"
  wrd_safe_url_is_reachable "$url" || return 1
  if ! printf '%s\n' "$url" > "$archive_tmp" || ! mv "$archive_tmp" "$URL_ARCHIVE_FILE"; then
    rm -f "$archive_tmp" "$current_tmp"
    return 1
  fi
  if ! printf '%s\n' "$url" > "$current_tmp" || ! mv "$current_tmp" "$URL_FILE"; then
    rm -f "$current_tmp"
    return 1
  fi
}

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

PID=""
URL=""
TERMINAL_STATE=""
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
    fi
    if [ -n "$URL" ] && ! wrd_safe_url_is_reachable "$URL"; then
      wrd_safe_quick_tunnel_observe unreachable "$URL" >&2
    fi
    echo "safe quick tunnel already running (pid=$OLD_PID)"
    if [ -n "$URL" ]; then
      echo "url: $URL"
    else
      echo "url: pending"
    fi
  fi
fi

if [ -z "$PID" ]; then
  : > "$LOG_FILE"
  # Drop named-tunnel token/cred env so quick tunnel cannot attach to wrd-tunnel.
  # --config isolates from ~/.cloudflared/config.yml named-tunnel injection.
  nohup env -u TUNNEL_TOKEN -u TUNNEL_CRED_FILE -u TUNNEL_CREDENTIALS_FILE \
    -u CLOUDFLARED_CREDENTIALS_FILE \
    "$CLOUDFLARED" tunnel --config "$CLOUDFLARED_CONFIG" --protocol http2 --url "$ORIGIN" \
    >> "$LOG_FILE" 2>&1 &
  PID=$!
  disown "$PID" 2>/dev/null || true
  echo "$PID" > "$PID_FILE"
fi

if [ -z "$URL" ]; then
  for _ in $(seq 1 "$URL_POLL_ATTEMPTS"); do
    LOG_URL=$(extract_trycloudflare_url "$LOG_FILE" || true)
    if [ -n "$LOG_URL" ]; then
      URL="$LOG_URL"
      if wait_for_public_url "$URL"; then
        publish_safe_url "$URL"
        echo "$URL"
        break
      fi
      printf '%s %s\n' "$(date -u +%FT%TZ)" "$(wrd_safe_quick_tunnel_observe unreachable "$URL")" >> "$LOG_FILE"
      TERMINAL_STATE=unreachable
      URL=""
      break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
        TERMINAL_STATE=unauthorized
      else
        TERMINAL_STATE=connector-exit
      fi
      break
    fi
    sleep "$URL_POLL_INTERVAL_SECONDS"
  done
fi

if [ -z "$URL" ]; then
  # Reap a connector already proven dead before classifying its final log.
  if [ -z "$TERMINAL_STATE" ] && ! kill -0 "$PID" 2>/dev/null; then
    wait "$PID" 2>/dev/null || true
    if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
      TERMINAL_STATE=unauthorized
    else
      TERMINAL_STATE=connector-exit
    fi
  fi
  wrd_safe_quick_tunnel_observe "${TERMINAL_STATE:-missing-url}" >&2
  tail -n 40 "$LOG_FILE" || true
  exit 1
fi

UNAUTHORIZED_REPORTED=0
UNREACHABLE_REPORTED=0
while kill -0 "$PID" 2>/dev/null; do
  if grep -q 'Unauthorized: Tunnel not found' "$LOG_FILE"; then
    if [ "$UNAUTHORIZED_REPORTED" -eq 0 ]; then
      printf '%s %s\n' "$(date -u +%FT%TZ)" "$(wrd_safe_quick_tunnel_observe unauthorized)" >> "$LOG_FILE"
      UNAUTHORIZED_REPORTED=1
    fi
  fi

  if [ -s "$URL_FILE" ]; then
    CURRENT_URL=$(cat "$URL_FILE" 2>/dev/null || true)
    if [ -n "$CURRENT_URL" ] && ! wrd_safe_url_is_reachable "$CURRENT_URL"; then
      if [ "$UNREACHABLE_REPORTED" -eq 0 ]; then
        printf '%s %s\n' "$(date -u +%FT%TZ)" "$(wrd_safe_quick_tunnel_observe unreachable "$CURRENT_URL")" >> "$LOG_FILE"
        UNREACHABLE_REPORTED=1
      fi
    else
      UNREACHABLE_REPORTED=0
    fi
  fi
  sleep "$WATCH_INTERVAL_SECONDS"
done

wait "$PID" 2>/dev/null || true
wrd_safe_quick_tunnel_observe connector-exit >&2
exit 1
