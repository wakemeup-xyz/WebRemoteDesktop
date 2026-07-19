#!/usr/bin/env bash
set -euo pipefail

# Read-only Terminal acceptance checks. Service startup and tunnel lifecycle remain user-managed.
BASE_URL="${WRD_RUNTIME_BASE_URL:-http://127.0.0.1:8080}"
URL_FILE="${WRD_SAFE_URL_FILE:-/tmp/wrd-safe-current-url.txt}"
METRICS_TOKEN="${WRD_TERMINAL_METRICS_TOKEN:-}"
PROBE_TOKEN="${WRD_TERMINAL_PROBE_TOKEN:-}"
EXPECTED_PYTHON_PATH_FRAGMENT="${WRD_EXPECTED_PYTHON_PATH_FRAGMENT:-/.homebrew/opt/python@3.11/}"
PROBE_ENV_FILE="${WRD_TERMINAL_ENV_FILE:-}"
safe_url_before=""
safe_url_file_present=0

fail() {
  echo "terminal-runtime-check: $*" >&2
  exit 1
}

health=$(curl -fsS "$BASE_URL/health") || fail "local health unavailable"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$health" || fail "local health is not ok"

status=$(curl -fsS "$BASE_URL/api/status") || fail "local status unavailable"
printf '%s\n' "$status" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' || fail "local api status is not ok"

if [[ -f "$URL_FILE" ]]; then
  safe_url_before=$(sed -n '1p' "$URL_FILE")
  [[ "$safe_url_before" =~ ^https?:// ]] || fail "safe URL file is invalid"
  safe_url_file_present=1
  echo "safe-url-file: present (value withheld)"
else
  echo "safe-url-file: missing"
fi

if [[ -n "$PROBE_TOKEN" ]]; then
  probe=$(node "$(dirname "$0")/terminal-runtime-probe.js" \
    "$BASE_URL" "$PROBE_TOKEN" "$EXPECTED_PYTHON_PATH_FRAGMENT") \
    || fail "Terminal environment/lifecycle probe failed"
  PROBE_JSON="$probe" node -e '
    let body;
    try {
      body = JSON.parse(process.env.PROBE_JSON || "");
    } catch {
      process.exit(2);
    }
    if (!body || !body.shell || !body.commandPython || !body.envPython) process.exit(3);
    if (!body.exited || !body.inputRejectedAfterExit || body.inputAckAfterExit) process.exit(4);
    if (!Array.isArray(body.forbiddenEnvNames) || body.forbiddenEnvNames.length) process.exit(5);
  ' || fail "Terminal probe returned an invalid or unsafe result"
fi

if [[ -n "$METRICS_TOKEN" ]]; then
  metrics=$(curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" "$BASE_URL/api/admin/terminal/metrics") \
    || fail "admin Terminal metrics unavailable"
  METRICS_JSON="$metrics" node -e '
    let body;
    try {
      body = JSON.parse(process.env.METRICS_JSON || "");
    } catch {
      process.exit(2);
    }
    if (!body || typeof body.metrics !== "object" || typeof body.pool !== "object") {
      process.exit(3);
    }
    const forbidden = /^(raw|command|output|.*(?:secret|password|token|api[_-]?key).*)$/i;
    const pending = [body];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.test(key)) process.exit(4);
        pending.push(child);
      }
    }
  ' || fail "metrics response is invalid or contains forbidden raw/secrets fields"
fi

if [[ -n "$PROBE_ENV_FILE" ]]; then
  [[ -r "$PROBE_ENV_FILE" ]] || fail "Terminal environment probe file is not readable"
  forbidden='JWT_SECRET|WRD_TERMINAL_ADMIN_PASSWORD|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE'
  grep -Eq "$forbidden" "$PROBE_ENV_FILE" && fail "Terminal environment contains forbidden key" || true
  grep -Eq '(^|:)python@3\.11/libexec/bin' "$PROBE_ENV_FILE" || fail "Homebrew Python 3.11 path missing"
fi

if [[ "$safe_url_file_present" == "1" ]]; then
  safe_url_after=$(sed -n '1p' "$URL_FILE")
  [[ "$safe_url_before" == "$safe_url_after" ]] || fail "safe URL changed during read-only runtime checks"
fi

echo "terminal-runtime-check: ok"
