#!/bin/bash
set -euo pipefail

# Web Remote Desktop Host 启动脚本（防重复启动）
# 用法: ./scripts/run-host.sh

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
PIDFILE="/tmp/wrd-host.pid"
LOGFILE="/tmp/host.log"

# 如果已有 host 在运行，先停止
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Host already running (PID: $OLD_PID). Stopping it first..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 2
        # 强制终止如果还在
        if kill -0 "$OLD_PID" 2>/dev/null; then
            kill -9 "$OLD_PID" 2>/dev/null || true
            sleep 1
        fi
    fi
    rm -f "$PIDFILE"
fi

# 清理 launchctl 残留（避免和旧机制冲突）
launchctl remove com.webremotedesktop.host 2>/dev/null || true

# 加载环境变量
if [ -f "$PROJECT_DIR/signal-server/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/signal-server/.env"
    set +a
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
export PYTHONPATH="/Users/macstudio1/.homebrew/lib/python3.11/site-packages:/Users/macstudio1/Library/Python/3.11/lib/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"

cd "$PROJECT_DIR/python-host"

# 启动并记录 PID
nohup "$PYTHON_BIN" host.py > "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

echo "Host started (PID: $NEW_PID)"
echo "Log: tail -f $LOGFILE"
