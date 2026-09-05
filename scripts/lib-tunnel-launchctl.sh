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
# disables and boots out that loaded job after the installed plist proves both
# legacy autostart flags are true. Current false/false and unknown states are
# preserved. It must never start, restart, or rotate a quick tunnel, and
# deliberately leaves all URL files untouched.
wrd_tunnel_launchctl_legacy_autostart_state() {
  local plist="$WRD_LEGACY_TUNNEL_PLIST_DST"
  local run_at_load=""
  local keep_alive=""

  [ -f "$plist" ] || {
    printf '%s\n' unknown
    return 0
  }

  run_at_load=$(plutil -extract RunAtLoad raw -o - "$plist" 2>/dev/null || true)
  keep_alive=$(plutil -extract KeepAlive raw -o - "$plist" 2>/dev/null || true)
  case "$run_at_load:$keep_alive" in
    true:true)
      printf '%s\n' legacy
      ;;
    false:false)
      printf '%s\n' current
      ;;
    *)
      printf '%s\n' unknown
      ;;
  esac
}

wrd_tunnel_launchctl_migrate_legacy_autostart() {
  local service="$WRD_TUNNEL_DOMAIN/$WRD_LEGACY_TUNNEL_LABEL"
  if ! launchctl print "$service" >/dev/null 2>&1; then
    return 0
  fi

  local state=""
  state=$(wrd_tunnel_launchctl_legacy_autostart_state)
  if [ "$state" != legacy ]; then
    echo "preserving loaded quick-tunnel LaunchAgent: $service (plist state=$state)"
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
