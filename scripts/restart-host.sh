#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/back-debug.log"
PID_FILE="/tmp/wrd-host.pid"
SAFE_PID_FILE="/tmp/wrd-safe-host.pid"
HOST_STATUS_URL="http://127.0.0.1:8080/api/status"
source "$PROJECT_DIR/scripts/lib-host-launchctl.sh"
source "$PROJECT_DIR/scripts/lib-safe-wrd.sh"

rm -f "$PID_FILE"
rm -f "$SAFE_PID_FILE"

echo "=== Restarting host launchagent ==="
wrd_host_launchctl_restart

NEW_PID=""
for _ in $(seq 1 30); do
    NEW_PID=$(wrd_safe_find_host_pid "$PROJECT_DIR" || true)
    if wrd_safe_pid_is_running "$NEW_PID"; then
        wrd_safe_write_pid_file "$PID_FILE" "$NEW_PID"
        wrd_safe_write_pid_file "$SAFE_PID_FILE" "$NEW_PID"
        break
    fi
    sleep 1
done

HOST_ONLINE=0
if wrd_safe_pid_is_running "$NEW_PID"; then
    for _ in $(seq 1 30); do
        if curl -fsS "$HOST_STATUS_URL" 2>/dev/null | rg '"hostOnline":true' >/dev/null 2>&1; then
            HOST_ONLINE=1
            break
        fi
        sleep 1
    done
fi

if wrd_safe_pid_is_running "$NEW_PID" && [ "$HOST_ONLINE" -eq 1 ]; then
    echo "Host started with PID: $NEW_PID"
    echo "Log: $LOG_FILE"
else
    echo "Host failed to reconnect; api status:"
    curl -fsS "$HOST_STATUS_URL" 2>/dev/null || echo "api status unavailable"
    echo
    echo "Host failed to stay running; tailing log:"
    tail -n 80 "$LOG_FILE"
    exit 1
fi
