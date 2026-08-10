#!/bin/bash
# Read-only Host lock / sleep policy check for WebRemoteDesktop.
# Exit codes:
#   0 = OK (EXIT_OK)
#   1 = hard failure (EXIT_HARD): awake missing/not running, or caffeinate still locks display (-d)
#   2 = warnings only (EXIT_WARN): e.g. password_policy=manual_verify, short battery sleep
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEEPER_SCRIPT="$PROJECT_DIR/scripts/run-awake-keeper.sh"
LABEL="com.webremotedesktop.awake"
DOMAIN="gui/$(id -u)"

EXIT_OK=0
EXIT_HARD=1
EXIT_WARN=2

hard_fail=0
warn=0

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

mark_hard() {
  hard_fail=1
  say "HARD: $*"
}

mark_warn() {
  warn=1
  say "WARN: $*"
}

# --- keeper script contract ---
section "awake keeper script"
if [[ ! -f "$KEEPER_SCRIPT" ]]; then
  mark_hard "missing $KEEPER_SCRIPT"
  inv=""
else
  say "path: $KEEPER_SCRIPT"
  # Use [[:space:]] — macOS BSD sed treats \s as a literal "s", which would
  # strip the final "s" from caffeinate -ims via a broken s/\s+$// substitute.
  inv="$(grep -E '^[[:space:]]*exec[[:space:]]+/usr/bin/caffeinate[[:space:]]+' "$KEEPER_SCRIPT" | head -1 | sed -E 's/^[[:space:]]*exec[[:space:]]+//;s/[[:space:]]+$//')"
  if [[ -z "$inv" ]]; then
    mark_hard "no exec /usr/bin/caffeinate line in run-awake-keeper.sh"
  else
    say "invocation: $inv"
    # Reject -d alone or inside a short-option cluster (e.g. -dims, -di).
    if [[ "$inv" =~ caffeinate[[:space:]]+-([a-zA-Z]*d[a-zA-Z]*|[[:alnum:]]*[[:space:]]+-d\b) ]]; then
      mark_hard "caffeinate still suppresses display sleep (-d); expected -ims without -d"
    elif [[ "$inv" =~ caffeinate[[:space:]]+-[a-zA-Z]*d ]]; then
      mark_hard "caffeinate still suppresses display sleep (-d); expected -ims without -d"
    elif [[ ! "$inv" =~ caffeinate[[:space:]]+-ims ]]; then
      mark_warn "expected caffeinate -ims; found: $inv"
    else
      say "OK: caffeinate allows display sleep (no -d), uses -ims"
    fi
  fi
fi

# --- launchd service ---
section "launch agent $LABEL"
launch_out=""
if launch_out="$(launchctl print "$DOMAIN/$LABEL" 2>&1)"; then
  say "launchctl print: OK ($DOMAIN/$LABEL)"
  if printf '%s\n' "$launch_out" | grep -Eq 'state = running|runs = [1-9]'; then
    say "OK: service looks active"
  else
    # print succeeded but state unclear — still warn
    say "launchctl print succeeded; inspect state manually if needed"
  fi
  printf '%s\n' "$launch_out" | grep -E 'path = |state = |program = |arguments = |pid = ' | head -20 || true
else
  mark_hard "awake LaunchAgent not installed or not loaded ($DOMAIN/$LABEL)"
  say "$launch_out" | head -5
fi

# Live process check (pgrep -f avoids false negatives from ps/grep races)
section "caffeinate process"
ims_running=0
d_running=0
if pgrep -f '/usr/bin/caffeinate -ims' >/dev/null 2>&1 || pgrep -f 'caffeinate -ims' >/dev/null 2>&1; then
  ims_running=1
fi
if pgrep -f 'caffeinate -[a-zA-Z]*d' >/dev/null 2>&1; then
  # Ignore matches that are -ims only: -ims does not include d
  if pgrep -f 'caffeinate -dims' >/dev/null 2>&1 || pgrep -f 'caffeinate -d' >/dev/null 2>&1; then
    d_running=1
  fi
fi
if pgrep -x caffeinate >/dev/null 2>&1 || pgrep -f '/usr/bin/caffeinate' >/dev/null 2>&1; then
  ps -ax -o pid=,command= | grep '[c]affeinate' | grep -v 'grep' | head -10 || true
  if [[ "$ims_running" -eq 1 ]]; then
    say "OK: found caffeinate -ims"
  elif [[ "$d_running" -eq 1 ]]; then
    mark_warn "running caffeinate still has -d (display sleep locked); reinstall awake keeper"
  else
    mark_warn "caffeinate running but not clearly -ims (may be short-lived external caffeinate)"
  fi
else
  if [[ "$hard_fail" -eq 0 ]]; then
    mark_hard "no caffeinate process found (awake should KeepAlive exec caffeinate)"
  else
    say "no caffeinate process (expected if agent missing)"
  fi
fi

# --- pmset ---
section "pmset sleep / displaysleep"
pmset_custom="$(pmset -g custom 2>/dev/null || true)"
if [[ -z "$pmset_custom" ]]; then
  mark_warn "pmset -g custom unavailable"
else
  printf '%s\n' "$pmset_custom"
  # Parse Battery sleep value (minutes)
  batt_sleep="$(printf '%s\n' "$pmset_custom" | awk '
    /^Battery Power:/ { in_batt=1; next }
    /^AC Power:/ { in_batt=0 }
    in_batt && $1=="sleep" { print $2; exit }
  ')"
  if [[ -n "${batt_sleep:-}" ]] && [[ "$batt_sleep" =~ ^[0-9]+$ ]] && [[ "$batt_sleep" -le 5 && "$batt_sleep" -gt 0 ]]; then
    mark_warn "Battery sleep=${batt_sleep}m is short; machine may sleep on battery despite display policy"
  fi
fi

# --- assertions ---
section "pmset assertions (caffeinate / idle sleep)"
assertions="$(pmset -g assertions 2>/dev/null || true)"
if [[ -z "$assertions" ]]; then
  mark_warn "pmset -g assertions unavailable"
else
  printf '%s\n' "$assertions" | head -40
  if printf '%s\n' "$assertions" | grep -q 'PreventUserIdleSystemSleep'; then
    if printf '%s\n' "$assertions" | grep -qi 'caffeinate'; then
      say "OK: PreventUserIdleSystemSleep present with caffeinate"
      if printf '%s\n' "$assertions" | grep -i caffeinate | grep -Eq 'asserting forever'; then
        say "OK: durable caffeinate assertion (asserting forever) present"
      elif [[ "$ims_running" -eq 1 ]]; then
        say "OK: caffeinate -ims process present (durable keeper)"
      elif printf '%s\n' "$assertions" | grep -i caffeinate | grep -Eq 'asserting for 300 secs|Timeout will fire in'; then
        mark_warn "only short-timeout caffeinate tickets seen; install com.webremotedesktop.awake for durable keep-awake"
      fi
    else
      mark_warn "PreventUserIdleSystemSleep set but not by caffeinate"
    fi
  else
    if [[ "$hard_fail" -eq 0 ]]; then
      mark_hard "no PreventUserIdleSystemSleep assertion (system may idle-sleep)"
    else
      say "no PreventUserIdleSystemSleep (expected if awake down)"
    fi
  fi
fi

# --- password / lock policy (best-effort) ---
section "lock password policy"
password_policy="manual_verify"
if ask_val="$(defaults read com.apple.screensaver askForPassword 2>/dev/null)"; then
  say "defaults com.apple.screensaver askForPassword=$ask_val"
  if [[ "$ask_val" == "0" ]]; then
    password_policy="defaults_askForPassword=0"
    say "OK: legacy askForPassword=0 (no password after screensaver)"
  else
    mark_warn "legacy askForPassword=$ask_val (may still require password); confirm System Settings"
    password_policy="defaults_askForPassword=$ask_val"
  fi
else
  say "password_policy=manual_verify"
  say "Modern macOS often does not expose Lock Screen 'require password' via this defaults key."
  say "Please confirm in 系统设置 → 锁定屏幕:"
  say "  - 屏幕保护程序启动或显示器关闭后需要密码 = 永不"
  say "  - (recommended) 电源适配器下关闭显示器 = 永不 for stable remote capture"
  say "  - 电池下关闭显示器 = allowed (e.g. 2 minutes)"
  mark_warn "password policy not machine-readable; manual_verify required"
fi

section "boundaries"
say "- Manual lock (Ctrl+Cmd+Q) still locks; remote keyboard may fail (Secure Input)."
say "- Lid close / Forced sleep / power loss can still interrupt Host."
say "- Display sleep without -d may yield black/stalled remote frames (accepted tradeoff)."

section "summary"
ok=1
if [[ "$hard_fail" -ne 0 ]]; then ok=0; fi
say "WRD_LOCK_POLICY_SUMMARY ok=$ok hard_fail=$hard_fail warn=$warn password_policy=$password_policy"

if [[ "$hard_fail" -ne 0 ]]; then
  exit "$EXIT_HARD"
fi
if [[ "$warn" -ne 0 ]]; then
  exit "$EXIT_WARN"
fi
exit "$EXIT_OK"
