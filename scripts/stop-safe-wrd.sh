#!/bin/bash
set -euo pipefail

SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SAFE_TUNNEL_PID="/tmp/wrd-safe-quicktunnel.pid"
SAFE_SIGNAL_PID="/tmp/wrd-safe-signal.pid"
SAFE_HOST_PID="/tmp/wrd-safe-host.pid"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"

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

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "stopped $label pid=$pid"
  else
    echo "$label already stopped"
  fi

  rm -f "$pid_file"
}

stop_pid_file "$SAFE_TUNNEL_SUPERVISOR_PID" "safe tunnel supervisor"
stop_pid_file "$SAFE_TUNNEL_PID" "safe quick tunnel"
stop_pid_file "$SAFE_HOST_PID" "safe host"
stop_pid_file "$SAFE_SIGNAL_PID" "safe signal-server"
rm -f "$SAFE_URL_FILE"
echo "removed $SAFE_URL_FILE"
