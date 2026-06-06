#!/bin/bash
set -euo pipefail

SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SAFE_TUNNEL_PID="/tmp/wrd-safe-quicktunnel.pid"
SAFE_SIGNAL_PID="/tmp/wrd-safe-signal.pid"
SAFE_HOST_PID="/tmp/wrd-safe-host.pid"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

print_pid_status() {
  local pid_file="$1"
  local label="$2"
  local kind="$3"

  if [ ! -f "$pid_file" ]; then
    echo "$label: pid file missing"
    return 0
  fi

  local recorded_pid
  recorded_pid=$(wrd_safe_read_pid_file "$pid_file")
  if [ -z "$recorded_pid" ]; then
    recorded_pid=$(wrd_safe_reconcile_pid_file "$pid_file" "$kind" "$PROJECT_DIR" || true)
    if [ -z "$recorded_pid" ]; then
      echo "$label: pid file empty"
      return 0
    fi
  fi

  if wrd_safe_pid_is_running "$recorded_pid"; then
    echo "$label: running pid=$recorded_pid"
    return 0
  fi

  local reconciled_pid
  reconciled_pid=$(wrd_safe_reconcile_pid_file "$pid_file" "$kind" "$PROJECT_DIR" || true)
  if wrd_safe_pid_is_running "$reconciled_pid"; then
    echo "$label: running pid=$reconciled_pid (reconciled)"
  else
    echo "$label: stale pid=$recorded_pid"
  fi
}

echo '=== safe wrd status ==='
print_pid_status "$SAFE_SIGNAL_PID" 'safe signal-server' signal
print_pid_status "$SAFE_HOST_PID" 'safe host' host
print_pid_status "$SAFE_TUNNEL_SUPERVISOR_PID" 'safe tunnel supervisor' tunnel-supervisor
print_pid_status "$SAFE_TUNNEL_PID" 'safe quick tunnel' quick-tunnel
echo 'entrypoint: WebRemoteDesktop uses http://127.0.0.1:8080 (do not open 5173 or run npm run dev for this repo)'

if [ -f "$SAFE_URL_FILE" ]; then
  echo "safe url file: $(cat "$SAFE_URL_FILE" 2>/dev/null || echo 'empty')"
else
  echo 'safe url file: missing'
fi

if curl -fsS "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  echo 'local health: ok'
else
  echo 'local health: down'
fi

if curl -fsS "http://127.0.0.1:8080/api/status" >/tmp/wrd-safe-status.json 2>/dev/null; then
  echo "api status: $(cat /tmp/wrd-safe-status.json)"
  rm -f /tmp/wrd-safe-status.json
else
  echo 'api status: unavailable'
fi
