#!/bin/bash
set -euo pipefail

SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SAFE_TUNNEL_PID="/tmp/wrd-safe-quicktunnel.pid"
SAFE_SIGNAL_PID="/tmp/wrd-safe-signal.pid"
SAFE_HOST_PID="/tmp/wrd-safe-host.pid"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"

print_pid_status() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    echo "$label: pid file missing"
    return 0
  fi

  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    echo "$label: pid file empty"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "$label: running pid=$pid"
  else
    echo "$label: stale pid=$pid"
  fi
}

echo '=== safe wrd status ==='
print_pid_status "$SAFE_SIGNAL_PID" 'safe signal-server'
print_pid_status "$SAFE_HOST_PID" 'safe host'
print_pid_status "$SAFE_TUNNEL_SUPERVISOR_PID" 'safe tunnel supervisor'
print_pid_status "$SAFE_TUNNEL_PID" 'safe quick tunnel'

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
