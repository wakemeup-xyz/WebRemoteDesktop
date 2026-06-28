#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "$PROJECT_DIR/scripts/lib-tunnel-launchctl.sh"

echo "=== Restarting safe tunnel (rotate url) ==="
wrd_tunnel_launchctl_rotate

for _ in $(seq 1 60); do
  if [ -s /tmp/wrd-safe-current-url.txt ]; then
    URL="$(cat /tmp/wrd-safe-current-url.txt 2>/dev/null || true)"
    if [ -n "$URL" ]; then
      echo "safe url: $URL"
      exit 0
    fi
  fi
  sleep 1
done

echo "safe tunnel did not publish a new url"
tail -n 80 /tmp/wrd-safe-tunnel-supervisor.log 2>/dev/null || true
tail -n 80 /tmp/wrd-safe-quicktunnel.log 2>/dev/null || true
exit 1
