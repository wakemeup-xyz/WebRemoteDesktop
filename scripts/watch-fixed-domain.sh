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
WRD_FIXED_WATCH_ONCE="${WRD_FIXED_WATCH_ONCE:-0}"

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
      # Safety: multiple formal owners → notify/skip, never restart
      local owners
      owners="$(wrd_fixed_count_formal_owners || true)"
      if [ "${owners:-0}" -gt 1 ]; then
        wrd_fixed_watch_log "tick status=$status action=skip reason=multiple-formal-owners count=$owners"
        wrd_fixed_notify "WRD formal tunnel" "skip restart: multiple formal owners ($owners)"
        # rewrite lastAction to skip without counting a restart
        STATE_PATH="$WRD_FIXED_WATCH_STATE" python3 - <<'PY' || true
import json, os
path = os.environ["STATE_PATH"]
try:
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
except (OSError, json.JSONDecodeError):
    state = {}
state["lastAction"] = "skip"
state["lastStatus"] = "formal-down"
with open(path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
PY
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

wrd_fixed_watch_acquire_lock() {
  if mkdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null; then
    # shellcheck disable=SC2064
    trap 'rmdir "$WRD_FIXED_WATCH_LOCK" 2>/dev/null || true' EXIT
    return 0
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

main "$@"
