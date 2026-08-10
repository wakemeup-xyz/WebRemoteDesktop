#!/bin/bash
# Shared formal named-tunnel helpers. Source only; do not exec.

WRD_FIXED_LABEL="${WRD_FIXED_LABEL:-com.webremotedesktop.fixed-domain}"
WRD_FIXED_TUNNEL_NAME="${WRD_FIXED_TUNNEL_NAME:-wrd-tunnel}"
CLOUDFLARED="${CLOUDFLARED:-/Users/macstudio1/.homebrew/bin/cloudflared}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
WRD_FIXED_TUNNEL_PROTOCOL="${WRD_FIXED_TUNNEL_PROTOCOL:-http2}"
WRD_FIXED_DOMAIN_LOG="${WRD_FIXED_DOMAIN_LOG:-/tmp/wrd-fixed-domain.log}"
WRD_FIXED_FORMAL_HEALTH_URL="${WRD_FIXED_FORMAL_HEALTH_URL:-https://link.stockhub.wiki/health}"
WRD_FIXED_ORIGIN_HEALTH_URL="${WRD_FIXED_ORIGIN_HEALTH_URL:-http://127.0.0.1:8080/health}"
WRD_FIXED_WAIT_SEC="${WRD_FIXED_WAIT_SEC:-45}"

wrd_fixed_unset_tunnel_token() {
  unset TUNNEL_TOKEN
}

wrd_fixed_require_credentials_file() {
  local config="${1:-$CLOUDFLARED_CONFIG}"
  if [ ! -f "$config" ]; then
    echo "missing cloudflared config: $config" >&2
    return 1
  fi
  if ! grep -Eq '^[[:space:]]*credentials-file[[:space:]]*:' "$config"; then
    echo "cloudflared config must define credentials-file: $config" >&2
    return 1
  fi
  return 0
}

wrd_fixed_origin_health_ok() {
  curl -fsS --max-time 3 "$WRD_FIXED_ORIGIN_HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" else 1)' 2>/dev/null
}

wrd_fixed_formal_health_ok() {
  # Prefer repo canonical checker when present.
  local checker
  checker="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/wrd_entry_health.py"
  if [ -f "$checker" ]; then
    python3 "$checker" --url "$WRD_FIXED_FORMAL_HEALTH_URL" 2>/dev/null \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("deliverable") else 1)'
    return $?
  fi
  curl -fsS --max-time 8 "$WRD_FIXED_FORMAL_HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" else 1)' 2>/dev/null
}

wrd_fixed_count_formal_owners() {
  ps -axo pid=,command= | awk '/[c]loudflared/ && /tunnel/ && /--config/ && / run / {count++} END {print count+0}'
}

wrd_fixed_stop_connector() {
  wrd_fixed_unset_tunnel_token
  launchctl remove "$WRD_FIXED_LABEL" 2>/dev/null || true
  # Only the named formal runner with config + run <name>
  pkill -f "cloudflared tunnel --config .* run ${WRD_FIXED_TUNNEL_NAME}" 2>/dev/null || true
  pkill -f "cloudflared tunnel --config .* --protocol .* run ${WRD_FIXED_TUNNEL_NAME}" 2>/dev/null || true
  sleep 1
}

wrd_fixed_start_connector() {
  local protocol="$WRD_FIXED_TUNNEL_PROTOCOL"
  case "$protocol" in
    http2|quic) ;;
    *) echo "WRD_FIXED_TUNNEL_PROTOCOL must be http2 or quic" >&2; return 1 ;;
  esac
  wrd_fixed_require_credentials_file "$CLOUDFLARED_CONFIG" || return 1
  wrd_fixed_unset_tunnel_token
  launchctl submit -l "$WRD_FIXED_LABEL" -- /bin/zsh -lc \
    "unset TUNNEL_TOKEN; exec \"$CLOUDFLARED\" tunnel --config \"$CLOUDFLARED_CONFIG\" --protocol \"$protocol\" run \"$WRD_FIXED_TUNNEL_NAME\" >> \"$WRD_FIXED_DOMAIN_LOG\" 2>&1"
}

wrd_fixed_wait_formal_health() {
  local i
  for i in $(seq 1 "$WRD_FIXED_WAIT_SEC"); do
    if wrd_fixed_formal_health_ok; then
      return 0
    fi
    # Secondary signal while DNS/edge catches up
    if "$CLOUDFLARED" tunnel info "$WRD_FIXED_TUNNEL_NAME" 2>/dev/null | grep -qv 'does not have any active connection'; then
      if wrd_fixed_formal_health_ok; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

wrd_fixed_parse_cloudflared_version() {
  # stdin or arg: raw --version text → X.Y.Z
  local raw="${1:-}"
  if [ -z "$raw" ]; then
    raw="$("$CLOUDFLARED" --version 2>/dev/null || true)"
  fi
  printf '%s\n' "$raw" | awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }'
}

wrd_fixed_version_ge() {
  # usage: wrd_fixed_version_ge <have> <need>
  local have="$1" need="$2"
  printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1 | grep -qx "$need"
}
