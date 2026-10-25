#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-link.stockhub.wiki}"
DEV_DOMAIN="${DEV_DOMAIN:-dev.link.stockhub.wiki}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_PORT="${LOCAL_PORT:-8080}"
LOCAL_ORIGIN="${LOCAL_ORIGIN:-http://127.0.0.1:${LOCAL_PORT}}"
DEV_LOCAL_ORIGIN="${DEV_LOCAL_ORIGIN:-http://127.0.0.1:5173}"
ENABLE_DEV_SUBDOMAIN="${ENABLE_DEV_SUBDOMAIN:-0}"
# Keep older aliases while every maintenance path shares the formal API.
WRD_FIXED_TUNNEL_NAME="${WRD_FIXED_TUNNEL_NAME:-${TUNNEL_NAME:-wrd-tunnel}}"
WRD_FIXED_LABEL="${WRD_FIXED_LABEL:-${TUNNEL_LABEL:-com.webremotedesktop.fixed-domain}}"
export WRD_FIXED_TUNNEL_NAME WRD_FIXED_LABEL
source "$PROJECT_DIR/scripts/lib-fixed-domain.sh"

# Validate formal inputs, credentials, owners and bootstrap capability before
# changing Signal or Host. This entry point requires formal tunnel authority.
if [ "$LOCAL_PORT" != "8080" ] || [ "$LOCAL_ORIGIN" != "http://127.0.0.1:8080" ]; then
  echo "fixed-domain local recovery requires http://127.0.0.1:8080" >&2
  exit 2
fi
wrd_fixed_preflight_connector

if ! python3 "$PROJECT_DIR/skills/webremote-service/scripts/wrd_service.py" restart-local; then
  echo "local recovery failed; formal connector was left untouched" >&2
  exit 1
fi
if ! bash "$PROJECT_DIR/scripts/restart-fixed-domain-tunnel.sh"; then
  echo "partial failure: local services recovered; formal connector recovery failed (see rollback result above)" >&2
  exit 1
fi

printf '\n=== ready ===\n'
echo "Domain: https://$DOMAIN"
echo "Local origin: $LOCAL_ORIGIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
  echo "Dev domain: https://$DEV_DOMAIN"
  echo "Dev origin: $DEV_LOCAL_ORIGIN"
  echo "Dev origin is optional and not startup-blocking"
fi
