#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.webremotedesktop.awake"
SRC="$PROJECT_DIR/launchd/$LABEL.plist"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DST"

launchctl bootout "$DOMAIN" "$DST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed and started $LABEL"
