#!/bin/bash

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WRD_HOST_LABEL="${WRD_HOST_LABEL:-com.webremotedesktop.host}"
WRD_HOST_PLIST_SRC="$PROJECT_DIR/launchd/$WRD_HOST_LABEL.plist"
WRD_HOST_PLIST_DST="$HOME/Library/LaunchAgents/$WRD_HOST_LABEL.plist"
WRD_HOST_DOMAIN="gui/$(id -u)"

wrd_host_launchctl_install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cp "$WRD_HOST_PLIST_SRC" "$WRD_HOST_PLIST_DST"
}

wrd_host_launchctl_bootout() {
  launchctl bootout "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>/dev/null || true
  launchctl remove "$WRD_HOST_LABEL" 2>/dev/null || true
}

wrd_host_launchctl_start() {
  wrd_host_launchctl_install
  wrd_host_launchctl_bootout
  launchctl bootstrap "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST"
  launchctl enable "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" 2>/dev/null || true
  launchctl kickstart -k "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL"
}

wrd_host_launchctl_stop() {
  wrd_host_launchctl_bootout
}

wrd_host_launchctl_restart() {
  wrd_host_launchctl_start
}
