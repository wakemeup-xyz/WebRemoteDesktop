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

  local recorded_pid
  recorded_pid=$(wrd_safe_read_pid_file "$pid_file")
  if wrd_safe_pid_is_running "$recorded_pid"; then
    echo "$label: running pid=$recorded_pid"
    return 0
  fi

  local live_pid=""
  live_pid=$(wrd_safe_find_pid_by_kind "$kind" "$PROJECT_DIR" 2>/dev/null || true)
  if wrd_safe_pid_is_running "$live_pid"; then
    echo "$label: running pid=$live_pid (discovered; pid file unchanged)"
  elif [ -n "$recorded_pid" ]; then
    echo "$label: stale pid=$recorded_pid"
  elif [ -f "$pid_file" ]; then
    echo "$label: pid file empty"
  else
    echo "$label: pid file missing"
  fi
}

echo '=== safe wrd status ==='
echo 'formal public entry: https://link.stockhub.wiki'
print_pid_status "$SAFE_SIGNAL_PID" 'safe signal-server' signal
print_pid_status "$SAFE_HOST_PID" 'safe host' host
print_pid_status "$SAFE_TUNNEL_SUPERVISOR_PID" 'safe tunnel supervisor' tunnel-supervisor
print_pid_status "$SAFE_TUNNEL_PID" 'safe quick tunnel' quick-tunnel
echo 'quick tunnel: debug-only, do not share it as the formal public entry'
echo 'entrypoint: WebRemoteDesktop uses http://127.0.0.1:8080 (do not open 5173 or run npm run dev for this repo)'
if wrd_safe_cloudflared_token_in_argv; then
  echo 'security warning: cloudflared token found in process arguments'
fi

if [ -f "$SAFE_URL_FILE" ]; then
  SAFE_URL_VALUE=$(cat "$SAFE_URL_FILE" 2>/dev/null || echo 'empty')
  echo "safe url file: $SAFE_URL_VALUE"
  echo "safe url source of truth: use $SAFE_URL_FILE as the current effective debug quick tunnel URL; trycloudflare may change only when the tunnel expires or is rebuilt"
  SAFE_URL_STATE=$(wrd_safe_url_reachability_state "$SAFE_URL_VALUE" || true)
  case "$SAFE_URL_STATE" in
    deliverable)
      echo 'safe url reachability: ok'
      ;;
    dns-unresolved)
      echo 'safe url reachability: dns-unresolved'
      ;;
    origin-unreachable)
      echo 'safe url reachability: origin-unreachable'
      ;;
    http-invalid)
      echo 'safe url reachability: http-invalid'
      ;;
    content-invalid)
      echo 'safe url reachability: content-invalid'
      ;;
    *)
      echo 'safe url reachability: unreachable'
      ;;
  esac
else
  echo 'safe url file: missing'
fi

if curl -fsS "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  echo 'local health: ok'
else
  echo 'local health: down'
fi

if curl -fsS "http://127.0.0.1:8080/api/status" >/tmp/wrd-safe-status.json 2>/dev/null; then
  echo "hostOnline summary: $(grep -Eo '"hostOnline":[^,}]+' /tmp/wrd-safe-status.json | head -n 1 || echo 'hostOnline:unknown')"
  echo "api status: $(cat /tmp/wrd-safe-status.json)"
  rm -f /tmp/wrd-safe-status.json
else
  echo 'api status: unavailable'
fi
