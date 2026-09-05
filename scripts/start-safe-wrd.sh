#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"
SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SIGNAL_PID_FILE="/tmp/wrd-safe-signal.pid"
HOST_PID_FILE="/tmp/wrd-safe-host.pid"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"
source "$PROJECT_DIR/scripts/lib-host-launchctl.sh"

stop_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    return 0
  fi

  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "$pid" ] && wrd_safe_pid_is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  echo "stopped $label"
}

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

  wrd_host_launchctl_start

  local new_pid=""
  for _ in $(seq 1 30); do
    new_pid=$(wrd_safe_find_host_pid "$PROJECT_DIR" || true)
    if wrd_safe_pid_is_running "$new_pid"; then
      wrd_safe_write_pid_file "$HOST_PID_FILE" "$new_pid"
      echo "started host pid=$new_pid"
      return 0
    fi
    sleep 1
  done

  echo "host launchagent did not produce a live host pid"
  return 1
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
  local safe_url=""
  safe_url=$(cat "$SAFE_URL_FILE" 2>/dev/null || true)

  if wrd_safe_pid_is_running "$supervisor_pid"; then
    if [ -n "$safe_url" ] && wrd_safe_url_is_reachable "$safe_url"; then
      echo "safe tunnel supervisor already running (pid=$supervisor_pid)"
      return 0
    fi

    echo "current safe URL is unreachable; diagnosing only, not restarting automatically"
    return 0
  fi

  echo "safe quick tunnel supervisor is not running; diagnosing only, no automatic replacement"
  echo "automatic replacement is disabled; explicit rebuild requires a user request"
}

wait_safe_url() {
  if [ ! -s "$SAFE_URL_FILE" ]; then
    echo "safe quick tunnel URL unavailable; diagnosing only, no automatic replacement"
    return 0
  fi
  if wrd_safe_url_is_reachable "$(cat "$SAFE_URL_FILE")"; then
    return 0
  fi
  echo "safe quick tunnel URL is unreachable; diagnosing only, not restarting automatically"
}

start_signal
wait_signal
start_host
wait_host
start_safe_tunnel
wait_safe_url

echo
echo '=== safe wrd ready ==='
echo 'formal public entry: https://link.stockhub.wiki'
echo 'entrypoint: http://127.0.0.1:8080'
echo 'warning: do not open 5173 / http://127.0.0.1:5173 or run npm run dev for this repo'
echo 'quick tunnel: debug-only, do not share it as the formal public entry'
echo 'use either the local 8080 page or the debug quick tunnel URL below'
if [ -s "$SAFE_URL_FILE" ]; then
  echo "safe url: $(cat "$SAFE_URL_FILE")"
  echo "debug quick tunnel url: $(cat "$SAFE_URL_FILE")"
else
  echo 'safe url: unavailable (diagnostic only; no automatic tunnel replacement)'
fi
echo "status: $(curl -fsS http://127.0.0.1:8080/api/status)"
echo "signal pid file: $SIGNAL_PID_FILE"
echo "host pid file: $HOST_PID_FILE"
echo "tunnel url file: $SAFE_URL_FILE"
