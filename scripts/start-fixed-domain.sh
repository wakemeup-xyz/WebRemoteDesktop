#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-stockhub.wiki}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
NODE_BIN="${NODE_BIN:-/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node}"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"

if [ ! -f "$HOME/.cloudflared/config.yml" ]; then
  echo "Missing ~/.cloudflared/config.yml. Run scripts/setup-cloudflare.sh first."
  exit 1
fi

pkill -f 'node server.js' 2>/dev/null || true
pkill -f 'cloudflared tunnel run' 2>/dev/null || true
pkill -f 'python.*host.py' 2>/dev/null || true
sleep 2

(cd "$PROJECT_DIR/signal-server" && nohup "$NODE_BIN" server.js > /tmp/signal-server.log 2>&1 &)
for _ in {1..20}; do
  curl -s http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 1
done
curl -s http://127.0.0.1:8080/health >/dev/null 2>&1 || {
  tail -n 80 /tmp/signal-server.log
  exit 1
}

nohup "$CLOUDFLARED" tunnel run wrd-tunnel > /tmp/tunnel.log 2>&1 &
sleep 5

cd "$PROJECT_DIR"
./scripts/restart-host.sh

printf '\n=== ready ===\n'
echo "Domain: https://$DOMAIN"
curl -s http://127.0.0.1:8080/api/status || true
