#!/bin/bash
set -euo pipefail

# Signal Server 启动脚本（防重复启动）
# 用法: ./scripts/run-signal.sh

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node}"
PIDFILE="/tmp/wrd-signal.pid"
LOGFILE="/tmp/signal-server.log"

# 如果已有 signal server 在运行，先停止
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Signal server already running (PID: $OLD_PID). Stopping it first..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$OLD_PID" 2>/dev/null; then
            kill -9 "$OLD_PID" 2>/dev/null || true
            sleep 1
        fi
    fi
    rm -f "$PIDFILE"
fi

# 清理 launchctl 残留
launchctl remove com.webremotedesktop.signal 2>/dev/null || true

cd "$PROJECT_DIR/signal-server"

# 启动并记录 PID
nohup "$NODE_BIN" server.js > "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

echo "Signal server started (PID: $NEW_PID)"
echo "Log: tail -f $LOGFILE"
