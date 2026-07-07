#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-link.stockhub.wiki}"
DEV_DOMAIN="${DEV_DOMAIN:-dev.link.stockhub.wiki}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
NODE_BIN="${NODE_BIN:-/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node}"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
TUNNEL_NAME="${TUNNEL_NAME:-wrd-tunnel}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
LOCAL_ORIGIN="${LOCAL_ORIGIN:-http://127.0.0.1:${LOCAL_PORT}}"
DEV_LOCAL_ORIGIN="${DEV_LOCAL_ORIGIN:-http://127.0.0.1:5173}"
HEALTH_URL="${HEALTH_URL:-${LOCAL_ORIGIN}/health}"
TUNNEL_LABEL="${TUNNEL_LABEL:-com.webremotedesktop.fixed-domain}"
ENABLE_DEV_SUBDOMAIN="${ENABLE_DEV_SUBDOMAIN:-0}"

if [ ! -f "$HOME/.cloudflared/config.yml" ]; then
  echo "Missing ~/.cloudflared/config.yml. Run scripts/setup-cloudflare.sh first."
  exit 1
fi

pkill -f 'node server.js' 2>/dev/null || true
pkill -f 'python.*host.py' 2>/dev/null || true
launchctl remove "$TUNNEL_LABEL" 2>/dev/null || true
pkill -f "cloudflared tunnel --config $HOME/.cloudflared/config.yml run $TUNNEL_NAME" 2>/dev/null || true
sleep 2

(cd "$PROJECT_DIR/signal-server" && nohup "$NODE_BIN" server.js > /tmp/signal-server.log 2>&1 &)
for _ in {1..20}; do
  curl -s "$HEALTH_URL" >/dev/null 2>&1 && break
  sleep 1
done
curl -s "$HEALTH_URL" >/dev/null 2>&1 || {
  tail -n 80 /tmp/signal-server.log
  exit 1
}

launchctl submit -l "$TUNNEL_LABEL" -- /bin/zsh -lc "exec \"$CLOUDFLARED\" tunnel --config \"$HOME/.cloudflared/config.yml\" run \"$TUNNEL_NAME\" >> /tmp/wrd-fixed-domain.log 2>&1"
for _ in {1..20}; do
  if cloudflared tunnel info "$TUNNEL_NAME" 2>/dev/null | grep -qv 'does not have any active connection'; then
    break
  fi
  sleep 1
done

cd "$PROJECT_DIR"
./scripts/restart-host.sh

printf '\n=== ready ===\n'
echo "Domain: https://$DOMAIN"
echo "Local origin: $LOCAL_ORIGIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
  echo "Dev domain: https://$DEV_DOMAIN"
  echo "Dev origin: $DEV_LOCAL_ORIGIN"
  echo "Dev origin is optional and not startup-blocking"
fi
curl -s "${LOCAL_ORIGIN}/api/status" || true
