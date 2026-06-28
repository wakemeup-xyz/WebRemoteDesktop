#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/back-debug.log"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
WAIT_INTERVAL_SECONDS="${WRD_HOST_WAIT_INTERVAL_SECONDS:-1}"

if [ -f "$PROJECT_DIR/signal-server/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/signal-server/.env"
  set +a
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
export PYTHONPATH="/Users/macstudio1/.homebrew/lib/python3.11/site-packages:/Users/macstudio1/Library/Python/3.11/lib/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"
HEALTH_URL="${WRD_HOST_HEALTH_URL:-${SERVER_URL}/health}"
WAIT_TIMEOUT_SECONDS="${WRD_HOST_WAIT_TIMEOUT_SECONDS:-0}"
HOST_AUTH_URL="${WRD_HOST_AUTH_URL:-${SERVER_URL}/api/auth/login/host}"

wait_for_signal_server() {
  local elapsed=0
  while [ "$WAIT_TIMEOUT_SECONDS" = "0" ] || [ "$elapsed" -lt "$WAIT_TIMEOUT_SECONDS" ]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$WAIT_INTERVAL_SECONDS"
    elapsed=$((elapsed + 1))
  done
  return 1
}

wait_for_host_auth() {
  local elapsed=0
  local auth_body
  auth_body=$(printf '{"secret":"%s"}' "${HOST_SHARED_SECRET:-}")
  while [ "$WAIT_TIMEOUT_SECONDS" = "0" ] || [ "$elapsed" -lt "$WAIT_TIMEOUT_SECONDS" ]; do
    if curl -fsS \
      -H 'Content-Type: application/json' \
      -X POST \
      -d "$auth_body" \
      "$HOST_AUTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$WAIT_INTERVAL_SECONDS"
    elapsed=$((elapsed + 1))
  done
  return 1
}

cd "$PROJECT_DIR/python-host"
echo "=== LaunchAgent starting host ===" >> "$LOG_FILE"
if ! wait_for_signal_server; then
  echo "Signal server health check failed: $HEALTH_URL" >> "$LOG_FILE"
  exit 0
fi
echo "Signal server healthy: $HEALTH_URL" >> "$LOG_FILE"
if ! wait_for_host_auth; then
  echo "Host auth preflight failed: $HOST_AUTH_URL" >> "$LOG_FILE"
  exit 0
fi
echo "Host auth preflight succeeded: $HOST_AUTH_URL" >> "$LOG_FILE"
exec "$PYTHON_BIN" host.py
