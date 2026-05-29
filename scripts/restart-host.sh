#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOST_DIR="$PROJECT_DIR/python-host"
LOG_FILE="$PROJECT_DIR/back-debug.log"
PID_FILE="/tmp/wrd-host.pid"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"

cleanup_old_hosts() {
    pkill -f "python.*host\\.py" 2>/dev/null || true
    pkill -f "overlay_window\\.py" 2>/dev/null || true

    for _ in {1..15}; do
        if ! pgrep -f "python.*host\\.py" >/dev/null 2>&1 && ! pgrep -f "overlay_window\\.py" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.2
    done

    pkill -9 -f "python.*host\\.py" 2>/dev/null || true
    pkill -9 -f "overlay_window\\.py" 2>/dev/null || true
}

echo "=== Stopping old host processes ==="
cleanup_old_hosts

if [ -f "$PROJECT_DIR/signal-server/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/signal-server/.env"
    set +a
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
export PYTHONPATH="/Users/macstudio1/.homebrew/lib/python3.11/site-packages:/Users/macstudio1/Library/Python/3.11/lib/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"

rm -f "$PID_FILE"
cd "$HOST_DIR"

echo "=== Starting new host ==="
nohup "$PYTHON_BIN" host.py >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 2
if ps -p "$NEW_PID" >/dev/null 2>&1; then
    echo "Host started with PID: $NEW_PID"
    echo "Log: $LOG_FILE"
else
    echo "Host failed to stay running; tailing log:"
    tail -n 80 "$LOG_FILE"
    exit 1
fi
