#!/bin/bash

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WRD_TUNNEL_LABEL="${WRD_TUNNEL_LABEL:-com.webremotedesktop.tunnel}"
WRD_TUNNEL_PLIST_SRC="$PROJECT_DIR/launchd/$WRD_TUNNEL_LABEL.plist"
WRD_TUNNEL_PLIST_DST="$HOME/Library/LaunchAgents/$WRD_TUNNEL_LABEL.plist"
WRD_TUNNEL_DOMAIN="gui/$(id -u)"

wrd_tunnel_launchctl_install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cp "$WRD_TUNNEL_PLIST_SRC" "$WRD_TUNNEL_PLIST_DST"
}

wrd_tunnel_launchctl_bootout() {
  launchctl bootout "$WRD_TUNNEL_DOMAIN" "$WRD_TUNNEL_PLIST_DST" 2>/dev/null || true
  launchctl remove "$WRD_TUNNEL_LABEL" 2>/dev/null || true
}

wrd_tunnel_launchctl_start() {
  wrd_tunnel_launchctl_install
  wrd_tunnel_launchctl_bootout
  launchctl bootstrap "$WRD_TUNNEL_DOMAIN" "$WRD_TUNNEL_PLIST_DST"
  launchctl enable "$WRD_TUNNEL_DOMAIN/$WRD_TUNNEL_LABEL" 2>/dev/null || true
  launchctl kickstart -k "$WRD_TUNNEL_DOMAIN/$WRD_TUNNEL_LABEL"
}

wrd_tunnel_launchctl_stop() {
  wrd_tunnel_launchctl_bootout
}

wrd_tunnel_launchctl_restart() {
  wrd_tunnel_launchctl_start
}

wrd_tunnel_launchctl_rotate() {
  wrd_tunnel_launchctl_bootout
  pkill -f 'cloudflared.*tunnel.*--url http://127\.0\.0\.1:8080' 2>/dev/null || true
  pkill -f 'run-safe-quicktunnel\.sh' 2>/dev/null || true
  rm -f /tmp/wrd-safe-quicktunnel.pid
  rm -f /tmp/wrd-safe-current-url.txt
  rm -f /tmp/wrd-safe-current-url.last.txt
  rm -f /tmp/wrd-safe-quicktunnel.log
  wrd_tunnel_launchctl_start
}
