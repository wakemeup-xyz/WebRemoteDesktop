#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOST_DIR="$PROJECT_DIR/python-host"
LOG_FILE="$PROJECT_DIR/back-debug.log"

echo "=== Stopping old host processes ==="

# Kill host.py main processes
pkill -f "python.*host\.py" 2>/dev/null || true
# Kill overlay_window.py child processes
pkill -f "overlay_window\.py" 2>/dev/null || true

# Wait for processes to exit (max 3 seconds)
for i in {1..15}; do
    if ! pgrep -f "python.*host\.py" > /dev/null 2>&1 && ! pgrep -f "overlay_window\.py" > /dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# Force kill any stragglers
pkill -9 -f "python.*host\.py" 2>/dev/null || true
pkill -9 -f "overlay_window\.py" 2>/dev/null || true

echo "=== Starting new host ==="
cd "$HOST_DIR"
nohup python host.py >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "Host started with PID: $NEW_PID"
echo "Log: $LOG_FILE"
