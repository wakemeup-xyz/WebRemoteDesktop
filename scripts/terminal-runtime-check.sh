#!/usr/bin/env bash
set -euo pipefail

# Read-only Terminal acceptance checks. Service startup and tunnel lifecycle remain user-managed.
BASE_URL="${WRD_RUNTIME_BASE_URL:-http://127.0.0.1:8080}"
URL_FILE="${WRD_SAFE_URL_FILE:-/tmp/wrd-safe-current-url.txt}"
METRICS_TOKEN="${WRD_TERMINAL_METRICS_TOKEN:-}"
PROBE_ENV_FILE="${WRD_TERMINAL_ENV_FILE:-}"

fail() {
  echo "terminal-runtime-check: $*" >&2
  exit 1
}

health=$(curl -fsS "$BASE_URL/health") || fail "local health unavailable"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$health" || fail "local health is not ok"

status=$(curl -fsS "$BASE_URL/api/status") || fail "local status unavailable"
printf '%s\n' "$status" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' || fail "local api status is not ok"

if [[ -f "$URL_FILE" ]]; then
  safe_url=$(sed -n '1p' "$URL_FILE")
  [[ "$safe_url" =~ ^https?:// ]] || fail "safe URL file is invalid"
  echo "safe-url-file: present (value withheld)"
else
  echo "safe-url-file: missing"
fi

if [[ -n "$METRICS_TOKEN" ]]; then
  metrics=$(curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" "$BASE_URL/api/admin/terminal/metrics") \
    || fail "admin Terminal metrics unavailable"
  grep -q '"metrics"' <<<"$metrics" || fail "metrics response missing metrics"
  grep -q '"pool"' <<<"$metrics" || fail "metrics response missing pool"
  grep -Eq 'SECRET|PASSWORD|TOKEN|API_KEY|raw|command|output' <<<"$metrics" \
    && fail "metrics response contains forbidden raw/secrets fields" || true
fi

if [[ -n "$PROBE_ENV_FILE" ]]; then
  [[ -r "$PROBE_ENV_FILE" ]] || fail "Terminal environment probe file is not readable"
  forbidden='JWT_SECRET|WRD_TERMINAL_ADMIN_PASSWORD|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE'
  grep -Eq "$forbidden" "$PROBE_ENV_FILE" && fail "Terminal environment contains forbidden key" || true
  grep -Eq '(^|:)python@3\.11/libexec/bin' "$PROBE_ENV_FILE" || fail "Homebrew Python 3.11 path missing"
fi

echo "terminal-runtime-check: ok"
