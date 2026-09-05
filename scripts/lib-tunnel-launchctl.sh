#!/bin/bash

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WRD_TUNNEL_LABEL="${WRD_TUNNEL_LABEL:-com.webremotedesktop.tunnel}"
WRD_LEGACY_TUNNEL_LABEL="${WRD_LEGACY_TUNNEL_LABEL:-$WRD_TUNNEL_LABEL}"
WRD_TUNNEL_PLIST_SRC="$PROJECT_DIR/launchd/$WRD_TUNNEL_LABEL.plist"
WRD_TUNNEL_PLIST_DST="$HOME/Library/LaunchAgents/$WRD_TUNNEL_LABEL.plist"
WRD_LEGACY_TUNNEL_PLIST_DST="${WRD_LEGACY_TUNNEL_PLIST_DST:-$HOME/Library/LaunchAgents/$WRD_LEGACY_TUNNEL_LABEL.plist}"
WRD_TUNNEL_DOMAIN="gui/$(id -u)"

# Existing installations may still have the old RunAtLoad/KeepAlive job
# loaded even after the checked-in plist is changed. Ordinary startup only
# disables and boots out that loaded job. It must never start, restart, or
# rotate a quick tunnel, and deliberately leaves all URL files untouched.
wrd_tunnel_launchctl_migrate_legacy_autostart() {
  local service="$WRD_TUNNEL_DOMAIN/$WRD_LEGACY_TUNNEL_LABEL"
  if ! launchctl print "$service" >/dev/null 2>&1; then
    return 0
  fi

  echo "disabling loaded legacy quick-tunnel LaunchAgent: $service"
  launchctl disable "$service" 2>/dev/null || true
  launchctl bootout "$WRD_TUNNEL_DOMAIN" "$WRD_LEGACY_TUNNEL_PLIST_DST" 2>/dev/null || true
}

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
