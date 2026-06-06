#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"
SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SIGNAL_PID_FILE="/tmp/wrd-safe-signal.pid"
HOST_PID_FILE="/tmp/wrd-safe-host.pid"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

cd "$PROJECT_DIR"

start_signal() {
  local existing_pid=""
  existing_pid=$(wrd_safe_reconcile_pid_file "$SIGNAL_PID_FILE" signal "$PROJECT_DIR" || true)
  if wrd_safe_pid_is_running "$existing_pid"; then
    echo "signal-server already running (pid=$existing_pid)"
    return 0
  fi

  (
    cd "$PROJECT_DIR/signal-server"
    nohup "$NODE_BIN" server.js > /tmp/signal-server.log 2>&1 &
    local new_pid=$!
    disown "$new_pid" 2>/dev/null || true
    wrd_safe_write_pid_file "$SIGNAL_PID_FILE" "$new_pid"
    echo "started signal-server pid=$new_pid"
  )
}

wait_signal() {
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "signal-server failed health check"
  tail -n 80 /tmp/signal-server.log || true
  exit 1
}

start_host() {
  local existing_pid=""
  existing_pid=$(wrd_safe_reconcile_pid_file "$HOST_PID_FILE" host "$PROJECT_DIR" || true)
  if wrd_safe_pid_is_running "$existing_pid"; then
    echo "host already running (pid=$existing_pid)"
    return 0
  fi

  set -a
  source "$PROJECT_DIR/signal-server/.env"
  set +a
  export SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
  export PYTHONPATH="/Users/macstudio1/.homebrew/lib/python3.11/site-packages:/Users/macstudio1/Library/Python/3.11/lib/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"

  (
    cd "$PROJECT_DIR/python-host"
    nohup "$PYTHON_BIN" host.py >> "$PROJECT_DIR/back-debug.log" 2>&1 &
    local new_pid=$!
    disown "$new_pid" 2>/dev/null || true
    wrd_safe_write_pid_file "$HOST_PID_FILE" "$new_pid"
    echo "started host pid=$new_pid"
  )
}

wait_host() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:8080/api/status" | rg '"hostOnline":true' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "host failed to connect back to signal-server"
  tail -n 80 "$PROJECT_DIR/back-debug.log" || true
  exit 1
}

start_safe_tunnel() {
  local supervisor_pid=""
  supervisor_pid=$(wrd_safe_reconcile_pid_file "$SAFE_TUNNEL_SUPERVISOR_PID" tunnel-supervisor "$PROJECT_DIR" || true)

  if wrd_safe_pid_is_running "$supervisor_pid"; then
    echo "safe tunnel supervisor already running (pid=$supervisor_pid)"
    return 0
  fi

  nohup "$PROJECT_DIR/scripts/run-safe-quicktunnel.sh" >/tmp/wrd-safe-tunnel-supervisor.log 2>&1 &
  local new_pid=$!
  disown "$new_pid" 2>/dev/null || true
  wrd_safe_write_pid_file "$SAFE_TUNNEL_SUPERVISOR_PID" "$new_pid"
  echo "started safe tunnel supervisor pid=$new_pid"
}

wait_safe_url() {
  for _ in $(seq 1 50); do
    if [ -s "$SAFE_URL_FILE" ]; then
      return 0
    fi
    sleep 1
  done
  echo "safe quick tunnel url not ready"
  tail -n 80 /tmp/wrd-safe-quicktunnel.log /tmp/wrd-safe-tunnel-supervisor.log 2>/dev/null || true
  exit 1
}

start_signal
wait_signal
start_host
wait_host
start_safe_tunnel
wait_safe_url

echo
echo '=== safe wrd ready ==='
echo 'entrypoint: http://127.0.0.1:8080'
echo 'warning: do not open 5173 / http://127.0.0.1:5173 or run npm run dev for this repo'
echo 'use either the local 8080 page or the safe URL below'
echo "safe url: $(cat "$SAFE_URL_FILE")"
echo "status: $(curl -fsS http://127.0.0.1:8080/api/status)"
echo "signal pid file: $SIGNAL_PID_FILE"
echo "host pid file: $HOST_PID_FILE"
echo "tunnel url file: $SAFE_URL_FILE"
