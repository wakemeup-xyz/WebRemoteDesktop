#!/bin/bash
set -euo pipefail

SAFE_TUNNEL_SUPERVISOR_PID="/tmp/wrd-safe-tunnel-supervisor.pid"
SAFE_TUNNEL_PID="/tmp/wrd-safe-quicktunnel.pid"
SAFE_SIGNAL_PID="/tmp/wrd-safe-signal.pid"
SAFE_HOST_PID="/tmp/wrd-safe-host.pid"
SAFE_URL_FILE="/tmp/wrd-safe-current-url.txt"
SAFE_URL_ARCHIVE_FILE="/tmp/wrd-safe-current-url.last.txt"
SAFE_TUNNEL_LOG="/tmp/wrd-safe-quicktunnel.log"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

recover_safe_url_file() {
  [ -f "$SAFE_URL_FILE" ] && return 0

  local recovered_url
  if [ -f "$SAFE_URL_ARCHIVE_FILE" ]; then
    recovered_url=$(cat "$SAFE_URL_ARCHIVE_FILE" 2>/dev/null || true)
  fi
  if [ -n "$recovered_url" ] && wrd_safe_url_is_reachable "$recovered_url"; then
    printf '%s\n' "$recovered_url" > "$SAFE_URL_FILE"
    return 0
  fi

  if [ -z "$recovered_url" ] && [ -f "$SAFE_TUNNEL_LOG" ]; then
    recovered_url=$(grep -Eo 'https://[^[:space:]]+\.trycloudflare\.com' "$SAFE_TUNNEL_LOG" | tail -1 || true)
  fi
  if [ -n "$recovered_url" ] && wrd_safe_url_is_reachable "$recovered_url"; then
    printf '%s\n' "$recovered_url" > "$SAFE_URL_FILE"
    return 0
  fi

  return 1
}

print_pid_status() {
  local pid_file="$1"
  local label="$2"
  local kind="$3"

  local recorded_pid
  recorded_pid=$(wrd_safe_read_pid_file "$pid_file")
  if [ -z "$recorded_pid" ]; then
    recorded_pid=$(wrd_safe_reconcile_pid_file "$pid_file" "$kind" "$PROJECT_DIR" || true)
    if [ -z "$recorded_pid" ]; then
      if [ -f "$pid_file" ]; then
        echo "$label: pid file empty"
      else
        echo "$label: pid file missing"
      fi
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

recover_safe_url_file || true

if [ -f "$SAFE_URL_FILE" ]; then
  SAFE_URL_VALUE=$(cat "$SAFE_URL_FILE" 2>/dev/null || echo 'empty')
  echo "safe url file: $SAFE_URL_VALUE"
  echo "safe url source of truth: use $SAFE_URL_FILE as the current effective public URL; trycloudflare may change only when the tunnel expires or is rebuilt"
  SAFE_URL_STATE=$(wrd_safe_url_reachability_state "$SAFE_URL_VALUE" || true)
  case "$SAFE_URL_STATE" in
    reachable)
      echo 'safe url reachability: ok'
      ;;
    dns-unresolved)
      echo 'safe url reachability: dns-unresolved'
      ;;
    origin-unreachable)
      echo 'safe url reachability: origin-unreachable'
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
