#!/bin/bash
set -e

# Web Remote Desktop 服务启动脚本
# 用法: ./start-wrd.sh [tunnel|local]

MODE=${1:-local}
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/var/log/wrd"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"
NODE_BIN="${NODE_BIN:-/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node}"

# 创建日志目录
sudo mkdir -p "$LOG_DIR"

echo "=== Starting Web Remote Desktop ==="
echo "Mode: $MODE"
echo "Project: $PROJECT_DIR"
echo ""

echo "[0/3] Starting awake keeper..."
launchctl remove com.webremotedesktop.awake 2>/dev/null || true
launchctl submit -l com.webremotedesktop.awake -- "$PROJECT_DIR/scripts/run-awake-keeper.sh"
echo "Awake keeper PID: $(pgrep -f 'caffeinate -dims' | head -1)"
echo ""

# 1. 启动信令服务器
echo "[1/3] Starting signal server..."
launchctl remove com.webremotedesktop.signal 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
launchctl submit -l com.webremotedesktop.signal -- /bin/zsh -lc \
    "cd '$PROJECT_DIR/signal-server' && '$NODE_BIN' server.js > '$LOG_DIR/signal.log' 2>&1"
sleep 2
echo "Signal server PID: $(pgrep -f 'node server.js' | head -1)"

# 2. 启动 Nginx (如果使用本地模式)
if [ "$MODE" == "local" ]; then
    echo "[2/3] Starting Nginx..."
    if [ -f "$PROJECT_DIR/docs/superpowers/deploy/nginx.conf" ]; then
        sudo nginx -c "$PROJECT_DIR/docs/superpowers/deploy/nginx.conf" 2>/dev/null || \
        sudo nginx -s reload 2>/dev/null || \
        echo "Nginx already running or config error"
    fi
fi

# 3. 启动 Cloudflare Tunnel (如果启用)
if [ "$MODE" == "tunnel" ]; then
    echo "[2/3] Starting Cloudflare Tunnel..."
    if command -v cloudflared &> /dev/null; then
        nohup cloudflared tunnel run wrd-tunnel > "$LOG_DIR/tunnel.log" 2>&1 &
        echo "Cloudflare tunnel PID: $!"
    else
        echo "Warning: cloudflared not installed"
    fi
fi

echo "[3/3] Setup complete"
echo ""
echo "Services:"
echo "  - Signal Server: http://localhost:8080"
echo "  - Nginx: https://localhost (if enabled)"
echo ""
echo "Logs: $LOG_DIR"
echo ""
echo "To start Python Host, run:"
echo "  cd $PROJECT_DIR/python-host && SERVER_URL=http://127.0.0.1:8080 $PYTHON_BIN host.py"
echo "Or launch it as a macOS job:"
echo "  PYTHON_BIN=$PYTHON_BIN launchctl submit -l com.webremotedesktop.host -- $PROJECT_DIR/scripts/run-host-launchctl.sh"
