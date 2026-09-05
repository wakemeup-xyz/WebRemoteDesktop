#!/bin/bash
# Bounded formal named-tunnel watcher.
# Never touches host/server/quicktunnel — only restart-fixed-domain-tunnel.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-fixed-domain.sh
source "$SCRIPT_DIR/lib-fixed-domain.sh"

WRD_FIXED_WATCH_INTERVAL_SEC="${WRD_FIXED_WATCH_INTERVAL_SEC:-60}"
WRD_FIXED_WATCH_FAIL_SEC="${WRD_FIXED_WATCH_FAIL_SEC:-180}"
WRD_FIXED_WATCH_COOLDOWN_SEC="${WRD_FIXED_WATCH_COOLDOWN_SEC:-300}"
WRD_FIXED_WATCH_MAX_RESTARTS="${WRD_FIXED_WATCH_MAX_RESTARTS:-2}"
WRD_FIXED_WATCH_WINDOW_SEC="${WRD_FIXED_WATCH_WINDOW_SEC:-3600}"
WRD_FIXED_WATCH_STATE="${WRD_FIXED_WATCH_STATE:-/tmp/wrd-fixed-watch-state.json}"
WRD_FIXED_WATCH_LOG="${WRD_FIXED_WATCH_LOG:-/tmp/wrd-fixed-watch.log}"
WRD_FIXED_WATCH_LOCK="${WRD_FIXED_WATCH_LOCK:-/tmp/wrd-fixed-watch.lock}"
WRD_FIXED_WATCH_PID_FILE="${WRD_FIXED_WATCH_PID_FILE:-$WRD_FIXED_WATCH_LOCK/pid}"
WRD_FIXED_WATCH_START_FILE="${WRD_FIXED_WATCH_START_FILE:-$WRD_FIXED_WATCH_LOCK/start}"
WRD_FIXED_WATCH_SIGNATURE_FILE="${WRD_FIXED_WATCH_SIGNATURE_FILE:-$WRD_FIXED_WATCH_LOCK/signature}"
WRD_FIXED_WATCH_INIT_MARKER="${WRD_FIXED_WATCH_INIT_MARKER:-$WRD_FIXED_WATCH_LOCK/initializing}"
WRD_FIXED_WATCH_INIT_MAX_SEC="${WRD_FIXED_WATCH_INIT_MAX_SEC:-30}"
WRD_FIXED_WATCH_ONCE="${WRD_FIXED_WATCH_ONCE:-0}"

WRD_FIXED_WATCH_LOCK_HELD=0
WRD_FIXED_WATCH_LOCK_CREATED=0
WRD_FIXED_WATCH_OWNER_START=""
WRD_FIXED_WATCH_OWNER_SIGNATURE=""

RESTART_SCRIPT="$SCRIPT_DIR/restart-fixed-domain-tunnel.sh"

wrd_fixed_notify() {
  local title="$1" body="$2"
  osascript -e "display notification \"${body//\"/\\\"}\" with title \"${title//\"/\\\"}\"" 2>/dev/null || true
}

wrd_fixed_watch_log() {
  local line="[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
  mkdir -p "$(dirname "$WRD_FIXED_WATCH_LOG")" 2>/dev/null || true
  printf '%s\n' "$line" >> "$WRD_FIXED_WATCH_LOG" 2>/dev/null || true
  printf '%s\n' "$line" >&2
}

wrd_fixed_watch_mark_skip() {
  local reason="$1"
  STATE_PATH="$WRD_FIXED_WATCH_STATE" SKIP_REASON="$reason" python3 - <<'PY'
import json, os
path = os.environ["STATE_PATH"]
try:
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
except (OSError, json.JSONDecodeError):
    state = {}
state["lastAction"] = "skip"
state["lastStatus"] = "formal-down"
state["lastSkipReason"] = os.environ.get("SKIP_REASON", "unknown")
with open(path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
PY
}

# Pure decision + state update for fail window / status / action.
# Does NOT mutate restarts[] or lastRestartAt (those only change on real restart).
# Prints one JSON line: {"action":"...","status":"...","failStartedAt":...,...}
wrd_fixed_watch_decide() {
  local now="$1" origin_ok="$2" formal_ok="$3"
  local state_path="$WRD_FIXED_WATCH_STATE"
  local fail_sec="$WRD_FIXED_WATCH_FAIL_SEC"
  local cooldown_sec="$WRD_FIXED_WATCH_COOLDOWN_SEC"
  local max_restarts="$WRD_FIXED_WATCH_MAX_RESTARTS"
  local window_sec="$WRD_FIXED_WATCH_WINDOW_SEC"

  NOW_EPOCH="$now" \
  ORIGIN_OK="$origin_ok" \
  FORMAL_OK="$formal_ok" \
  STATE_PATH="$state_path" \
  FAIL_SEC="$fail_sec" \
  COOLDOWN_SEC="$cooldown_sec" \
  MAX_RESTARTS="$max_restarts" \
  WINDOW_SEC="$window_sec" \
  python3 - <<'PY'
import json, os, sys

now = int(os.environ["NOW_EPOCH"])
origin_ok = os.environ.get("ORIGIN_OK", "0") == "1"
formal_ok = os.environ.get("FORMAL_OK", "0") == "1"
state_path = os.environ["STATE_PATH"]
fail_sec = int(os.environ["FAIL_SEC"])
cooldown_sec = int(os.environ["COOLDOWN_SEC"])
max_restarts = int(os.environ["MAX_RESTARTS"])
window_sec = int(os.environ["WINDOW_SEC"])

default = {
    "failStartedAt": None,
    "lastRestartAt": None,
    "restarts": [],
    "lastStatus": "healthy",
    "lastAction": "none",
}

try:
    with open(state_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raw = {}
except (OSError, json.JSONDecodeError):
    raw = {}

state = dict(default)
state.update({k: raw.get(k, default[k]) for k in default})
if not isinstance(state.get("restarts"), list):
    state["restarts"] = []

fail_started = state.get("failStartedAt")
last_restart = state.get("lastRestartAt")
restarts = [int(x) for x in state["restarts"] if x is not None]

action = "none"
status = "healthy"

if not origin_ok:
    action = "none"
    status = "origin-down"
    fail_started = None
elif formal_ok:
    action = "none"
    status = "healthy"
    fail_started = None
else:
    # origin ok, formal down
    if fail_started is None:
        fail_started = now
    try:
        fail_started_i = int(fail_started)
    except (TypeError, ValueError):
        fail_started_i = now
        fail_started = now
    elapsed = now - fail_started_i
    if elapsed < fail_sec:
        action = "none"
        status = "formal-down"
    else:
        in_cooldown = False
        if last_restart is not None:
            try:
                lr = int(last_restart)
                if now - lr < cooldown_sec:
                    in_cooldown = True
            except (TypeError, ValueError):
                in_cooldown = False
        if in_cooldown:
            action = "none"
            status = "formal-down"
        else:
            window_start = now - window_sec
            recent = [t for t in restarts if t >= window_start]
            if len(recent) >= max_restarts:
                action = "notify"
                status = "budget-exhausted"
            else:
                action = "restart"
                status = "restarted"

state["failStartedAt"] = fail_started
state["lastRestartAt"] = last_restart
state["restarts"] = restarts
state["lastStatus"] = status
state["lastAction"] = action

os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")

out = {
    "action": action,
    "status": status,
    "failStartedAt": fail_started,
    "lastRestartAt": last_restart,
    "restarts": restarts,
}
print(json.dumps(out, separators=(",", ":")))
PY
}

wrd_fixed_watch_record_restart() {
  local now="$1"
  local state_path="$WRD_FIXED_WATCH_STATE"
  NOW_EPOCH="$now" STATE_PATH="$state_path" python3 - <<'PY'
import json, os
now = int(os.environ["NOW_EPOCH"])
path = os.environ["STATE_PATH"]
try:
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
except (OSError, json.JSONDecodeError):
    state = {}
restarts = state.get("restarts") or []
if not isinstance(restarts, list):
    restarts = []
restarts = [int(x) for x in restarts if x is not None]
restarts.append(now)
state["restarts"] = restarts
state["lastRestartAt"] = now
state["lastStatus"] = "restarted"
state["lastAction"] = "restart"
with open(path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
PY
}

wrd_fixed_watch_tick() {
  local decide_only="${1:-0}"
  local now origin_ok formal_ok decision action status

  if [ "$decide_only" = "1" ]; then
    now="${NOW_EPOCH:?NOW_EPOCH required in --decide-only}"
    origin_ok="${ORIGIN_OK:?ORIGIN_OK required in --decide-only}"
    formal_ok="${FORMAL_OK:?FORMAL_OK required in --decide-only}"
  else
    now="$(date +%s)"
    origin_ok=0
    formal_ok=0
    if wrd_fixed_origin_health_ok; then
      origin_ok=1
    fi
    if wrd_fixed_formal_health_ok; then
      formal_ok=1
    fi
  fi

  decision="$(wrd_fixed_watch_decide "$now" "$origin_ok" "$formal_ok")"
  # Always emit decision JSON on stdout (fixture/tests + operators).
  printf '%s\n' "$decision"

  action="$(printf '%s' "$decision" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("action", "none"))')"
  status="$(printf '%s' "$decision" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status", ""))')"

  if [ "$decide_only" = "1" ]; then
    return 0
  fi

  case "$action" in
    none)
      wrd_fixed_watch_log "tick status=$status action=none origin_ok=$origin_ok formal_ok=$formal_ok"
      ;;
    notify)
      wrd_fixed_watch_log "tick status=$status action=notify origin_ok=$origin_ok formal_ok=$formal_ok"
      wrd_fixed_notify "WRD formal tunnel" "status=$status (no restart)"
      ;;
    restart)
      # A token-based connector is not managed by this watcher. Refuse before
      # invoking the credentials-file restart helper to avoid a second submit.
      local token_connectors
      if ! token_connectors="$(wrd_fixed_count_token_connectors)"; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=token-inspection-failed"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: unable to inspect cloudflared processes"
        wrd_fixed_watch_mark_skip token-inspection-failed || true
        return 0
      fi
      if [ "$token_connectors" -gt 0 ]; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=token-connector count=$token_connectors"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: token connector detected ($token_connectors)"
        wrd_fixed_watch_mark_skip token-connector || true
        return 0
      fi

      # Safety: multiple formal owners → notify/skip, never restart
      local owners
      if ! owners="$(wrd_fixed_count_formal_owners)"; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=formal-owner-inspection-failed"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: unable to inspect formal cloudflared owners"
        wrd_fixed_watch_mark_skip formal-owner-inspection-failed || true
        return 0
      fi
      if ! [[ "$owners" =~ ^[0-9]+$ ]]; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=formal-owner-inspection-invalid"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: invalid formal owner inspection"
        wrd_fixed_watch_mark_skip formal-owner-inspection-invalid || true
        return 0
      fi
      if [ "$owners" -gt 1 ]; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=multiple-formal-owners count=$owners"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: multiple formal owners ($owners)"
        wrd_fixed_watch_mark_skip multiple-formal-owners || true
        return 0
      fi

      wrd_fixed_watch_log "tick status=$status action=restart origin_ok=$origin_ok formal_ok=$formal_ok"
      wrd_fixed_notify "WRD formal tunnel" "restarting formal named tunnel"
      # Best-effort restart; record budget even if health wait fails (attempt consumed).
      set +e
      bash "$RESTART_SCRIPT"
      local rc=$?
      set -e
      wrd_fixed_watch_record_restart "$now"
      wrd_fixed_watch_log "restart-fixed-domain-tunnel.sh exit=$rc recorded at epoch=$now"
      ;;
    *)
      wrd_fixed_watch_log "tick status=$status action=$action (unhandled)"
      ;;
  esac
}

wrd_fixed_watch_pid_state() {
  local pid="${1:-}"
  local error_file="${WRD_FIXED_WATCH_LOCK}.kill-error.$$"
  local error_text=""
  local state="dead"

  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$state"
    return 0
  fi

  if kill -0 "$pid" 2>"$error_file"; then
    state=live
  else
    error_text="$(cat "$error_file" 2>/dev/null || true)"
    if printf '%s\n' "$error_text" | grep -Eiq 'operation not permitted|permission denied|eperm'; then
      state=unknown
    elif printf '%s\n' "$error_text" | grep -Eiq 'no such process|no process|esrch'; then
      state=dead
    else
      # A failed probe without a known ESRCH signal is not proof of death.
      state=unknown
    fi
  fi
  rm -f "$error_file" 2>/dev/null || true
  printf '%s\n' "$state"
}

wrd_fixed_watch_pid_is_live() {
  [ "$(wrd_fixed_watch_pid_state "${1:-}")" = live ]
}

wrd_fixed_watch_process_start() {
  local pid="$1" start=""
  start="$(ps -p "$pid" -o lstart= 2>/dev/null || true)"
  start="$(printf '%s' "$start" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$start" ] || return 1
  printf '%s\n' "$start"
}

wrd_fixed_watch_process_signature() {
  local pid="$1" signature=""
  signature="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  signature="$(printf '%s' "$signature" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$signature" ] || return 1
  printf '%s\n' "$signature"
}

wrd_fixed_watch_lock_owner_pid() {
  local pid=""
  [ -r "$WRD_FIXED_WATCH_PID_FILE" ] || return 1
  pid="$(tr -d '[:space:]' < "$WRD_FIXED_WATCH_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

wrd_fixed_watch_lock_metadata_matches() {
  local owner_pid="$1" owner_start="$2" owner_signature="$3"
  local recorded_start="" recorded_signature=""
  [ "$owner_pid" = "$$" ] || return 1
  [ -n "$owner_start" ] && [ -n "$owner_signature" ] || return 1
  [ -r "$WRD_FIXED_WATCH_START_FILE" ] || return 1
  [ -r "$WRD_FIXED_WATCH_SIGNATURE_FILE" ] || return 1
  recorded_start="$(cat "$WRD_FIXED_WATCH_START_FILE" 2>/dev/null || true)"
  recorded_signature="$(cat "$WRD_FIXED_WATCH_SIGNATURE_FILE" 2>/dev/null || true)"
  [ "$recorded_start" = "$owner_start" ] && [ "$recorded_signature" = "$owner_signature" ]
}

wrd_fixed_watch_lock_is_initializing() {
  [ -e "$WRD_FIXED_WATCH_INIT_MARKER" ]
}

# Determine whether an incomplete lock is still being initialized. The marker
# is published before pid/start/signature; if the owner dies before publication
# of the pid file, its marker PID lets us reclaim it. If the process crashed
# immediately after mkdir, enumerate a live watcher process before reclaiming
# the otherwise empty directory. A failed process listing is unknown and must
# preserve the lock.
wrd_fixed_watch_initializing_lock_state() {
  local marker_pid=""
  if [ -e "$WRD_FIXED_WATCH_INIT_MARKER" ]; then
    marker_pid="$(sed -n '1p' "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null || true)"
    if [[ "$marker_pid" =~ ^[1-9][0-9]*$ ]]; then
      wrd_fixed_watch_pid_state "$marker_pid"
      return 0
    fi
    # A malformed marker cannot identify its owner while it is fresh. Bound
    # that ambiguity so a crash during marker publication cannot deadlock the
    # watcher forever; after the grace period it is abandoned and reclaimable.
    local marker_mtime="" now_epoch="" marker_age=""
    if ! marker_mtime="$(stat -f '%m' "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null)"; then
      marker_mtime="$(stat -c '%Y' "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null || true)"
    fi
    now_epoch="$(date +%s)"
    if [[ "$marker_mtime" =~ ^[0-9]+$ ]]; then
      marker_age=$((now_epoch - marker_mtime))
      if [ "$marker_age" -ge "$WRD_FIXED_WATCH_INIT_MAX_SEC" ]; then
        printf '%s\n' abandoned
        return 0
      fi
    fi
    printf '%s\n' unknown
    return 0
  fi

  local process_list=""
  if ! process_list="$(ps -axo pid=,command= 2>/dev/null)"; then
    printf '%s\n' unknown
    return 0
  fi
  local watcher_script="$SCRIPT_DIR/watch-fixed-domain.sh"
  local candidate_pids=""
  candidate_pids="$(printf '%s\n' "$process_list" | awk -v self="$$" -v script="$watcher_script" '$1 ~ /^[0-9]+$/ && $1 != self && index($0, script) {print $1}')"
  if [ -z "$candidate_pids" ]; then
    printf '%s\n' abandoned
    return 0
  fi

  local candidate=""
  for candidate in $candidate_pids; do
    case "$(wrd_fixed_watch_pid_state "$candidate")" in
      live)
        printf '%s\n' active
        return 0
        ;;
      unknown)
        printf '%s\n' unknown
        return 0
        ;;
    esac
  done
  printf '%s\n' abandoned
}

wrd_fixed_watch_write_atomic() {
  local target="$1" content="$2" temporary="${1}.tmp.$$"
  if ! printf '%s' "$content" > "$temporary"; then
    rm -f "$temporary" 2>/dev/null || true
    return 1
  fi
  if ! mv "$temporary" "$target" 2>/dev/null; then
    rm -f "$temporary" 2>/dev/null || true
    return 1
  fi
}

wrd_fixed_watch_remove_metadata() {
  local metadata_file
  for metadata_file in \
    "$WRD_FIXED_WATCH_PID_FILE" \
    "$WRD_FIXED_WATCH_START_FILE" \
    "$WRD_FIXED_WATCH_SIGNATURE_FILE" \
    "$WRD_FIXED_WATCH_INIT_MARKER"; do
    rm -f "$metadata_file" "${metadata_file}.tmp.$$" 2>/dev/null || true
  done
}

wrd_fixed_watch_reclaim_stale_lock() {
  local owner_pid="${1:-}"
  if [ -n "$owner_pid" ]; then
    case "$(wrd_fixed_watch_pid_state "$owner_pid")" in
      live|unknown)
        # Any live or unprobeable owner is treated as held. This prevents PID
        # reuse, EPERM, or an unrelated process from being disrupted.
        return 1
        ;;
    esac
  fi

  # Remove only our known metadata, then require the lock directory to be
  # empty. Never recursively delete a lock path that may contain foreign data.
  wrd_fixed_watch_remove_metadata
  rmdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null
}

wrd_fixed_watch_install_traps() {
  trap 'wrd_fixed_watch_release_lock' EXIT
  trap 'wrd_fixed_watch_handle_signal TERM' TERM
  trap 'wrd_fixed_watch_handle_signal INT' INT
}

wrd_fixed_watch_release_lock() {
  local owner_pid=""
  [ "$WRD_FIXED_WATCH_LOCK_HELD" = "1" ] || return 0
  owner_pid="$(wrd_fixed_watch_lock_owner_pid || true)"
  if [ -n "$owner_pid" ]; then
    wrd_fixed_watch_lock_metadata_matches \
      "$owner_pid" "$WRD_FIXED_WATCH_OWNER_START" "$WRD_FIXED_WATCH_OWNER_SIGNATURE" || return 0
  elif [ -e "$WRD_FIXED_WATCH_INIT_MARKER" ]; then
    local marker_pid="" marker_start=""
    marker_pid="$(sed -n '1p' "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null || true)"
    marker_start="$(sed -n '2p' "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null || true)"
    [ "$marker_pid" = "$$" ] && [ "$marker_start" = "$WRD_FIXED_WATCH_OWNER_START" ] || return 0
  elif [ "$WRD_FIXED_WATCH_LOCK_CREATED" != "1" ]; then
    # No complete owner metadata and no marker: do not remove an unknown path.
    return 0
  else
    # We atomically created this directory but crashed before publishing any
    # marker. rmdir remains safe because it only succeeds while still empty.
    :
  fi

  wrd_fixed_watch_remove_metadata
  rmdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null || true
  WRD_FIXED_WATCH_LOCK_HELD=0
}

wrd_fixed_watch_handle_signal() {
  local signal="$1"
  wrd_fixed_watch_release_lock
  if [ "$signal" = "TERM" ]; then
    exit 143
  fi
  exit 130
}

wrd_fixed_watch_initialize_lock() {
  local owner_start="$1" owner_signature="$2"
  WRD_FIXED_WATCH_OWNER_START="$owner_start"
  WRD_FIXED_WATCH_OWNER_SIGNATURE="$owner_signature"
  WRD_FIXED_WATCH_LOCK_HELD=1
  wrd_fixed_watch_install_traps

  if ! wrd_fixed_watch_write_atomic \
    "$WRD_FIXED_WATCH_INIT_MARKER" "$(printf '%s\n%s\n' "$$" "$owner_start")"; then
    wrd_fixed_watch_release_lock
    return 1
  fi
  if ! wrd_fixed_watch_write_atomic "$WRD_FIXED_WATCH_PID_FILE" "$(printf '%s\n' "$$")" \
    || ! wrd_fixed_watch_write_atomic "$WRD_FIXED_WATCH_START_FILE" "$(printf '%s\n' "$owner_start")" \
    || ! wrd_fixed_watch_write_atomic "$WRD_FIXED_WATCH_SIGNATURE_FILE" "$(printf '%s\n' "$owner_signature")"; then
    wrd_fixed_watch_release_lock
    return 1
  fi
  rm -f "$WRD_FIXED_WATCH_INIT_MARKER" 2>/dev/null || {
    wrd_fixed_watch_release_lock
    return 1
  }
}

wrd_fixed_watch_acquire_lock() {
  local owner_start="" owner_signature=""
  owner_start="$(wrd_fixed_watch_process_start "$$" || true)"
  owner_signature="$(wrd_fixed_watch_process_signature "$$" || true)"
  if [ -z "$owner_start" ] || [ -z "$owner_signature" ]; then
    wrd_fixed_watch_log "cannot establish watcher process identity; refusing lock acquisition"
    return 1
  fi

  if mkdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null; then
    WRD_FIXED_WATCH_LOCK_CREATED=1
    if ! wrd_fixed_watch_initialize_lock "$owner_start" "$owner_signature"; then
      return 1
    fi
    return 0
  fi

  local owner_pid=""
  owner_pid="$(wrd_fixed_watch_lock_owner_pid || true)"
  if [ -z "$owner_pid" ]; then
    case "$(wrd_fixed_watch_initializing_lock_state)" in
      active|unknown)
        wrd_fixed_watch_log "another watcher is initializing $WRD_FIXED_WATCH_LOCK; exiting"
        return 1
        ;;
      abandoned)
        # The owner died before publishing its pid. Reclaim only our known
        # metadata and require rmdir to prove that no foreign content exists.
        ;;
      *)
        wrd_fixed_watch_log "another watcher owns unknown lock $WRD_FIXED_WATCH_LOCK; exiting"
        return 1
        ;;
    esac
  fi
  local owner_state=""
  if [ -n "$owner_pid" ]; then
    owner_state="$(wrd_fixed_watch_pid_state "$owner_pid")"
  fi
  if [ -n "$owner_pid" ] && [ "$owner_state" = live ]; then
    local owner_start_recorded="" owner_signature_recorded=""
    owner_start_recorded="$(cat "$WRD_FIXED_WATCH_START_FILE" 2>/dev/null || true)"
    owner_signature_recorded="$(cat "$WRD_FIXED_WATCH_SIGNATURE_FILE" 2>/dev/null || true)"
    if [ -z "$owner_start_recorded" ] || [ -z "$owner_signature_recorded" ]; then
      wrd_fixed_watch_log "another watcher holds $WRD_FIXED_WATCH_LOCK (pid=$owner_pid; identity-incomplete); exiting"
    elif [ "$owner_start_recorded" = "$(wrd_fixed_watch_process_start "$owner_pid" || true)" ] \
      && [ "$owner_signature_recorded" = "$(wrd_fixed_watch_process_signature "$owner_pid" || true)" ]; then
      wrd_fixed_watch_log "another watcher holds $WRD_FIXED_WATCH_LOCK (pid=$owner_pid); exiting"
    else
      # A live PID with an identity mismatch may be PID reuse or a foreign
      # process. Preserve the lock; never reclaim or signal it.
      wrd_fixed_watch_log "live foreign or reused pid=$owner_pid owns $WRD_FIXED_WATCH_LOCK; exiting"
    fi
    return 1
  fi
  if [ -n "$owner_pid" ] && [ "$owner_state" = unknown ]; then
    wrd_fixed_watch_log "unknown owner state for pid=$owner_pid at $WRD_FIXED_WATCH_LOCK; preserving lock and exiting"
    return 1
  fi

  if wrd_fixed_watch_reclaim_stale_lock "$owner_pid"; then
    if mkdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null; then
      WRD_FIXED_WATCH_LOCK_CREATED=1
      if ! wrd_fixed_watch_initialize_lock "$owner_start" "$owner_signature"; then
        return 1
      fi
      wrd_fixed_watch_log "reclaimed stale lock $WRD_FIXED_WATCH_LOCK"
      return 0
    fi
  fi

  wrd_fixed_watch_log "another watcher holds $WRD_FIXED_WATCH_LOCK; exiting"
  return 1
}

main() {
  local mode=loop
  if [ "${1:-}" = "--decide-only" ]; then
    mode=decide-only
  fi

  if [ "$mode" = "decide-only" ]; then
    wrd_fixed_watch_tick 1
    exit 0
  fi

  wrd_fixed_watch_acquire_lock || exit 0

  if [ "$WRD_FIXED_WATCH_ONCE" = "1" ]; then
    wrd_fixed_watch_tick 0
    exit 0
  fi

  while true; do
    wrd_fixed_watch_tick 0 || true
    sleep "$WRD_FIXED_WATCH_INTERVAL_SEC"
  done
}

if [ "${WRD_FIXED_WATCH_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
