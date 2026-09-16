#!/bin/bash

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WRD_HOST_LABEL="${WRD_HOST_LABEL:-com.webremotedesktop.host}"
WRD_HOST_PLIST_SRC="$PROJECT_DIR/launchd/$WRD_HOST_LABEL.plist"
WRD_HOST_PLIST_DST="$HOME/Library/LaunchAgents/$WRD_HOST_LABEL.plist"
WRD_HOST_DOMAIN="gui/$(id -u)"
WRD_HOST_PREFLIGHT_LABEL="com.webremotedesktop.host.bootstrap-probe"

wrd_host_launchctl_install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cp "$WRD_HOST_PLIST_SRC" "$WRD_HOST_PLIST_DST"
}

wrd_host_launchctl_loaded() {
  launchctl print "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1
}

wrd_host_launchctl_bootout() {
  launchctl bootout "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>/dev/null || true
  launchctl remove "$WRD_HOST_LABEL" 2>/dev/null || true
}

# Prove this shell can register a throwaway agent before we are allowed to
# remove a healthy one. Non-GUI contexts (agent shells, ssh, CI) fail with
# "Bootstrap failed: 5: Input/output error"; without this probe that failure
# would strand the host agent in a booted-out state with no way back.
wrd_host_launchctl_can_bootstrap() {
  local probe_plist probe_output
  probe_plist="$(mktemp -t wrd-bootstrap-probe)" || return 1
  cat > "$probe_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WRD_HOST_PREFLIGHT_LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST

  if ! probe_output=$(launchctl bootstrap "$WRD_HOST_DOMAIN" "$probe_plist" 2>&1); then
    rm -f "$probe_plist"
    echo "  bootstrap probe failed: ${probe_output:-unknown launchctl error}" >&2
    return 1
  fi

  launchctl bootout "$WRD_HOST_DOMAIN" "$probe_plist" >/dev/null 2>&1 \
    || launchctl remove "$WRD_HOST_PREFLIGHT_LABEL" >/dev/null 2>&1 \
    || true
  rm -f "$probe_plist"
  return 0
}

# Reuse the loaded agent whenever the installed plist still matches the repo
# copy. Only swap it out when a reload is genuinely required, and never leave
# the environment without a loaded agent if that swap cannot succeed.
wrd_host_launchctl_start() {
  wrd_host_launchctl_install

  if wrd_host_launchctl_loaded && cmp -s "$WRD_HOST_PLIST_SRC" "$WRD_HOST_PLIST_DST" 2>/dev/null; then
    launchctl enable "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1 || true
    if launchctl kickstart -k "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1; then
      return 0
    fi
    echo "warning: kickstart failed for $WRD_HOST_LABEL; falling back to re-bootstrap" >&2
  fi

  if wrd_host_launchctl_loaded; then
    if ! wrd_host_launchctl_can_bootstrap; then
      echo "refusing to reload $WRD_HOST_LABEL: this shell cannot bootstrap LaunchAgents" >&2
      echo "  the currently loaded agent was left loaded and untouched" >&2
      echo "  hint: run ./scripts/start-safe-wrd.sh from a GUI Terminal session (Terminal.app)" >&2
      return 1
    fi
    wrd_host_launchctl_bootout
  fi

  local bootstrap_output=""
  if ! bootstrap_output=$(launchctl bootstrap "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>&1); then
    echo "failed to bootstrap $WRD_HOST_LABEL" >&2
    [ -n "$bootstrap_output" ] && echo "  $bootstrap_output" >&2
    echo "  hint: LaunchAgent registration needs a GUI Terminal session; sandboxed or agent shells fail with 'Bootstrap failed: 5: Input/output error'" >&2
    return 1
  fi

  launchctl enable "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1 || true
  if ! launchctl kickstart -k "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1; then
    echo "warning: kickstart failed for $WRD_HOST_LABEL after bootstrap" >&2
  fi
  return 0
}

wrd_host_launchctl_stop() {
  wrd_host_launchctl_bootout
}

wrd_host_launchctl_restart() {
  wrd_host_launchctl_start
}
