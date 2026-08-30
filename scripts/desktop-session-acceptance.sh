#!/usr/bin/env bash
set -euo pipefail

LOCAL_ORIGIN="${WRD_LOCAL_ORIGIN:-http://127.0.0.1:8080}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)
      printf '%s\n' 'usage: scripts/desktop-session-acceptance.sh [--local-only]'
      exit 0
      ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

health_state='NOT RUN'
health_reason='local health preflight not run'
health_json=''
if health_json="$(curl -fsS --max-time 5 "$LOCAL_ORIGIN/health" 2>/dev/null)"; then
  if printf '%s' "$health_json" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    health_state='PASS'
    health_reason='health endpoint returned status=ok'
  else
    health_state='PARTIAL'
    health_reason='health endpoint responded without status=ok'
  fi
else
  health_state='BLOCKED'
  health_reason='local origin unavailable; start signal-server manually before runtime acceptance'
fi

printf '{\n'
printf '  "timestamp": "%s",\n' "$STAMP"
printf '  "origin": "%s",\n' "$LOCAL_ORIGIN"
printf '  "localOnly": %s,\n' "$([ "$LOCAL_ONLY" -eq 1 ] && printf true || printf false)"
printf '  "health": {"status": "%s", "reason": "%s"},\n' "$health_state" "$health_reason"
printf '  "evidence": {"attemptId": null, "phase": null, "media": null, "candidateSummary": null, "frameCounters": null, "inputAck": null},\n'
printf '  "acceptance": {\n'
printf '    "live-frame": {"status": "NOT RUN", "reason": "requires a real browser-rendered fresh frame; synthetic frames are prohibited"},\n'
printf '    "stall-resume": {"status": "NOT RUN", "reason": "requires observed stall and fresh-frame recovery in a running Viewer"},\n'
printf '    "disconnect-reset": {"status": "NOT RUN", "reason": "requires a real disconnect and reset-barrier trace"},\n'
printf '    "dual-viewer": {"status": "NOT RUN", "reason": "requires two real Viewer sessions and lease write rejection evidence"},\n'
printf '    "tunnel-frame": {"status": "NOT RUN", "reason": "public tunnel evidence is outside --local-only and is never synthesized"},\n'
printf '    "physical-input": {"status": "NOT RUN", "reason": "requires real keyboard/mouse input acknowledgement"}\n'
printf '  }\n'
printf '}\n'
