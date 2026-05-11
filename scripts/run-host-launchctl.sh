#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3}"

if [ -f "$PROJECT_DIR/signal-server/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/signal-server/.env"
    set +a
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
export PYTHONPATH="/Users/macstudio1/.homebrew/lib/python3.11/site-packages:/Users/macstudio1/Library/Python/3.11/lib/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"

cd "$PROJECT_DIR/python-host"
exec "$PYTHON_BIN" host.py >> /tmp/host-debug.log 2>&1
