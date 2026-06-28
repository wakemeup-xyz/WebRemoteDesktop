#!/bin/bash
set -euo pipefail

SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SAFE_TUNNEL_PID="/tmp/wrd-safe-quicktunnel.pid"
SAFE_SIGNAL_PID="/tmp/wrd-safe-signal.pid"
SAFE_HOST_PID="/tmp/wrd-safe-host.pid"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"
source "$PROJECT_DIR/scripts/lib-host-launchctl.sh"
source "$PROJECT_DIR/scripts/lib-tunnel-launchctl.sh"

stop_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    echo "$label pid file missing"
    return 0
  fi

  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    echo "$label pid file empty"
    return 0
  fi

  if wrd_safe_pid_is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! wrd_safe_pid_is_running "$pid"; then
        break
      fi
      sleep 0.2
    done
    if wrd_safe_pid_is_running "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "stopped $label pid=$pid"
  else
    echo "$label already stopped"
  fi

  rm -f "$pid_file"
}

wrd_tunnel_launchctl_stop
stop_pid_file "$SAFE_TUNNEL_SUPERVISOR_PID" "safe tunnel supervisor"
stop_pid_file "$SAFE_TUNNEL_PID" "safe quick tunnel"
wrd_host_launchctl_stop
stop_pid_file "$SAFE_HOST_PID" "safe host"
stop_pid_file "$SAFE_SIGNAL_PID" "safe signal-server"
rm -f "$SAFE_URL_FILE"
echo "removed $SAFE_URL_FILE"
