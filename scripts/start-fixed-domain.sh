#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-link.stockhub.wiki}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
NODE_BIN="${NODE_BIN:-/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node}"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
TUNNEL_NAME="${TUNNEL_NAME:-wrd-tunnel}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
LOCAL_ORIGIN="${LOCAL_ORIGIN:-http://127.0.0.1:${LOCAL_PORT}}"
HEALTH_URL="${HEALTH_URL:-${LOCAL_ORIGIN}/health}"
TUNNEL_LABEL="${TUNNEL_LABEL:-com.webremotedesktop.fixed-domain}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"

if [ ! -f "$CLOUDFLARED_CONFIG" ]; then
  echo "Missing ~/.cloudflared/config.yml. Run scripts/setup-cloudflare.sh first."
  exit 1
fi
if ! grep -Eq '^[[:space:]]*credentials-file[[:space:]]*:' "$CLOUDFLARED_CONFIG"; then
  echo "Cloudflare config must define credentials-file for the named tunnel."
  exit 1
fi
unset TUNNEL_TOKEN

pkill -f 'node server.js' 2>/dev/null || true
pkill -f 'python.*host.py' 2>/dev/null || true
launchctl remove "$TUNNEL_LABEL" 2>/dev/null || true
pkill -f "cloudflared tunnel --config $CLOUDFLARED_CONFIG run $TUNNEL_NAME" 2>/dev/null || true
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

launchctl submit -l "$TUNNEL_LABEL" -- /bin/zsh -lc "unset TUNNEL_TOKEN; exec \"$CLOUDFLARED\" tunnel --config \"$CLOUDFLARED_CONFIG\" run \"$TUNNEL_NAME\" >> /tmp/wrd-fixed-domain.log 2>&1"
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
curl -s "${LOCAL_ORIGIN}/api/status" || true
