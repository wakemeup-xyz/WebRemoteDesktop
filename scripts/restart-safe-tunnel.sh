#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SAFE_URL_FILE="${SAFE_URL_FILE:-/tmp/wrd-safe-current-url.txt}"
SAFE_TUNNEL_SUPERVISOR_LOG="${SAFE_TUNNEL_SUPERVISOR_LOG:-/tmp/wrd-safe-tunnel-supervisor.log}"
SAFE_QUICK_TUNNEL_LOG="${SAFE_QUICK_TUNNEL_LOG:-/tmp/wrd-safe-quicktunnel.log}"
RESTART_URL_POLL_ATTEMPTS="${RESTART_URL_POLL_ATTEMPTS:-60}"
RESTART_URL_POLL_INTERVAL_SECONDS="${RESTART_URL_POLL_INTERVAL_SECONDS:-1}"

source "$PROJECT_DIR/scripts/lib-tunnel-launchctl.sh"

echo "=== Restarting safe tunnel (rotate url) ==="
wrd_tunnel_launchctl_rotate

for _ in $(seq 1 "$RESTART_URL_POLL_ATTEMPTS"); do
  if [ -s "$SAFE_URL_FILE" ]; then
    URL="$(cat "$SAFE_URL_FILE" 2>/dev/null || true)"
    if [ -n "$URL" ]; then
      echo "safe url: $URL"
      exit 0
    fi
  fi
  sleep "$RESTART_URL_POLL_INTERVAL_SECONDS"
done

echo "safe tunnel did not publish a new url"
tail -n 80 "$SAFE_TUNNEL_SUPERVISOR_LOG" 2>/dev/null || true
tail -n 80 "$SAFE_QUICK_TUNNEL_LOG" 2>/dev/null || true
exit 1
