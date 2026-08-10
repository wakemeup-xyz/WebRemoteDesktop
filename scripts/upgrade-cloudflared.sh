#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-fixed-domain.sh
source "$SCRIPT_DIR/lib-fixed-domain.sh"

NEED_VERSION="${WRD_CLOUDFLARED_MIN_VERSION:-2026.7.3}"
BREW_BIN="${BREW_BIN:-brew}"

wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG"
wrd_fixed_unset_tunnel_token

have="$(wrd_fixed_parse_cloudflared_version)"
echo "cloudflared current: ${have:-unknown}"

if [ -n "$have" ] && wrd_fixed_version_ge "$have" "$NEED_VERSION"; then
  echo "version already >= $NEED_VERSION; skipping brew upgrade"
else
  echo "upgrading cloudflared via Homebrew toward $NEED_VERSION"
  if ! "$BREW_BIN" upgrade cloudflared; then
    echo "brew upgrade cloudflared failed; leaving existing connector untouched" >&2
    exit 1
  fi
  # ensure link points at new cellar if brew left old symlink
  hash -r 2>/dev/null || true
  have="$(wrd_fixed_parse_cloudflared_version)"
  if [ -z "$have" ] || ! wrd_fixed_version_ge "$have" "$NEED_VERSION"; then
    echo "cloudflared still < $NEED_VERSION after upgrade (have=${have:-none})" >&2
    exit 1
  fi
fi

echo "restarting formal connector on $(command -v "$CLOUDFLARED" 2>/dev/null || echo "$CLOUDFLARED") ($have)"
"$SCRIPT_DIR/restart-fixed-domain-tunnel.sh"
