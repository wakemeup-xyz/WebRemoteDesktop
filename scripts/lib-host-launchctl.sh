#!/bin/bash

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WRD_HOST_LABEL="${WRD_HOST_LABEL:-com.webremotedesktop.host}"
WRD_HOST_PLIST_SRC="$PROJECT_DIR/launchd/$WRD_HOST_LABEL.plist"
WRD_HOST_PLIST_DST="$HOME/Library/LaunchAgents/$WRD_HOST_LABEL.plist"
WRD_HOST_DOMAIN="gui/$(id -u)"
WRD_HOST_PREFLIGHT_LABEL="com.webremotedesktop.host.bootstrap-probe"

wrd_host_launchctl_install() {
  mkdir -p "$(dirname "$WRD_HOST_PLIST_DST")" || return 1
  cp "$WRD_HOST_PLIST_SRC" "$WRD_HOST_PLIST_DST"
}

wrd_host_launchctl_loaded() {
  launchctl print "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1
}

wrd_host_launchctl_bootout() {
  launchctl bootout "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>/dev/null || true
  launchctl remove "$WRD_HOST_LABEL" 2>/dev/null || true
}

# Prove a throwaway agent can register and be removed before replacing a
# loaded Host. launchctl requires a .plist suffix; error 5 alone does not
# identify the cause of registration failure.
wrd_host_launchctl_can_bootstrap() {
  local probe_dir probe_plist probe_label probe_output="" cleanup_output=""
  local probe_failed=0 cleanup_failed=0
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/wrd-bootstrap-probe.XXXXXX")" || return 1
  probe_plist="$probe_dir/probe.plist"
  probe_label="${WRD_HOST_PREFLIGHT_LABEL}.${probe_dir##*/}"
  if ! cat > "$probe_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${probe_label}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  then
    if ! rm -rf "$probe_dir"; then
      echo "  bootstrap probe directory cleanup failed: $probe_dir" >&2
    fi
    echo "  could not write bootstrap probe plist" >&2
    return 1
  fi

  if ! probe_output=$(launchctl bootstrap "$WRD_HOST_DOMAIN" "$probe_plist" 2>&1); then
    echo "  bootstrap probe failed: ${probe_output:-unknown launchctl error}" >&2
    probe_failed=1
  fi

  # Even a failed bootstrap may have partially registered this unique probe.
  # Never call the Host bootout helper from this cleanup path.
  if ! cleanup_output=$(launchctl bootout "$WRD_HOST_DOMAIN" "$probe_plist" 2>&1); then
    if ! cleanup_output=$(launchctl remove "$probe_label" 2>&1); then
      echo "  bootstrap probe cleanup not confirmed: ${cleanup_output:-unknown launchctl error}" >&2
      cleanup_failed=1
    fi
  fi
  if ! rm -rf "$probe_dir"; then
    echo "  bootstrap probe directory cleanup failed: $probe_dir" >&2
    return 1
  fi
  [ "$probe_failed" -eq 0 ] && [ "$cleanup_failed" -eq 0 ]
}

# Restore a prior registration after a replacement failed. A successful probe
# cannot guarantee that the actual plist will bootstrap; keep the backup if
# restoration also fails so the original configuration remains recoverable.
wrd_host_launchctl_restore() {
  local previous_plist="$1" restore_output=""
  # A failing bootstrap may still have partially registered its replacement.
  wrd_host_launchctl_bootout
  if ! cp "$previous_plist" "$WRD_HOST_PLIST_DST"; then
    echo "failed to restore previous plist for $WRD_HOST_LABEL; backup kept at $previous_plist" >&2
    return 1
  fi
  if ! restore_output=$(launchctl bootstrap "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>&1); then
    echo "failed to restore previous agent for $WRD_HOST_LABEL; backup kept at $previous_plist" >&2
    [ -n "$restore_output" ] && echo "  $restore_output" >&2
    return 1
  fi
  rm -f "$previous_plist"
  launchctl enable "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1 || true
  if ! launchctl kickstart -k "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1; then
    echo "warning: kickstart failed for restored $WRD_HOST_LABEL" >&2
  fi
  echo "previous $WRD_HOST_LABEL agent and plist restored" >&2
  return 0
}

# Compare before copying: kickstart reuses the job's loaded configuration, not
# changes subsequently copied to its plist. Probe and preserve a rollback copy
# before removing a loaded agent; a replacement failure remains a failed start.
wrd_host_launchctl_start() {
  local previous_plist="" bootstrap_output=""
  if [ ! -f "$WRD_HOST_PLIST_SRC" ] || [ ! -r "$WRD_HOST_PLIST_SRC" ]; then
    echo "cannot read host plist: $WRD_HOST_PLIST_SRC" >&2
    return 1
  fi

  if wrd_host_launchctl_loaded; then
    if cmp -s "$WRD_HOST_PLIST_SRC" "$WRD_HOST_PLIST_DST" 2>/dev/null; then
      launchctl enable "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1 || true
      if launchctl kickstart -k "$WRD_HOST_DOMAIN/$WRD_HOST_LABEL" >/dev/null 2>&1; then
        return 0
      fi
      echo "warning: kickstart failed for $WRD_HOST_LABEL; falling back to re-bootstrap" >&2
    fi
    if [ ! -f "$WRD_HOST_PLIST_DST" ] || [ ! -r "$WRD_HOST_PLIST_DST" ]; then
      echo "refusing to reload $WRD_HOST_LABEL: installed plist is unavailable for rollback" >&2
      return 1
    fi
    if ! wrd_host_launchctl_can_bootstrap; then
      echo "refusing to reload $WRD_HOST_LABEL: bootstrap preflight did not complete" >&2
      echo "  the currently loaded agent was left loaded and untouched" >&2
      return 1
    fi
    previous_plist="$(mktemp -t wrd-host-plist-backup)" || return 1
    if ! cp "$WRD_HOST_PLIST_DST" "$previous_plist"; then
      rm -f "$previous_plist"
      echo "refusing to reload $WRD_HOST_LABEL: could not back up installed plist" >&2
      return 1
    fi
    wrd_host_launchctl_bootout
  fi

  if ! wrd_host_launchctl_install; then
    echo "failed to install plist for $WRD_HOST_LABEL" >&2
    if [ -n "$previous_plist" ]; then wrd_host_launchctl_restore "$previous_plist" || true; fi
    return 1
  fi
  if ! bootstrap_output=$(launchctl bootstrap "$WRD_HOST_DOMAIN" "$WRD_HOST_PLIST_DST" 2>&1); then
    echo "failed to bootstrap $WRD_HOST_LABEL" >&2
    [ -n "$bootstrap_output" ] && echo "  $bootstrap_output" >&2
    echo "  inspect the launchctl error and plist before retrying" >&2
    if [ -n "$previous_plist" ]; then wrd_host_launchctl_restore "$previous_plist" || true; fi
    return 1
  fi

  if [ -n "$previous_plist" ]; then rm -f "$previous_plist"; fi
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
