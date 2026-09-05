#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-fixed-domain.sh
source "$SCRIPT_DIR/lib-fixed-domain.sh"

if ! token_connectors="$(wrd_fixed_count_token_connectors)"; then
  echo "refusing restart: unable to inspect cloudflared processes; no managed connector submit" >&2
  exit 2
fi
if [ "$token_connectors" -gt 0 ]; then
  echo "refusing restart: existing cloudflared --token connector(s) detected ($token_connectors); no managed connector submit" >&2
  exit 2
fi

wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG"
wrd_fixed_unset_tunnel_token

owners="$(wrd_fixed_count_formal_owners || true)"
if [ "${owners:-0}" -gt 1 ]; then
  echo "refusing restart: multiple formal owners ($owners); run fixed-tunnel-preflight.sh" >&2
  exit 2
fi

echo "=== restarting formal connector $WRD_FIXED_TUNNEL_NAME ==="
wrd_fixed_stop_connector
wrd_fixed_start_connector

if wrd_fixed_wait_formal_health; then
  echo "formal health ok: $WRD_FIXED_FORMAL_HEALTH_URL"
  exit 0
fi

echo "formal health not deliverable after restart" >&2
tail -n 40 "$WRD_FIXED_DOMAIN_LOG" >&2 || true
exit 1
