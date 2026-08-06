#!/bin/bash
set -euo pipefail

ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
FORMAL_URL="${FORMAL_URL:-https://link.stockhub.wiki}"
CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
PROCESS_FIXTURE="${WRD_PREFLIGHT_PROCESS_FIXTURE:-}"
LOG_FIXTURE="${WRD_PREFLIGHT_LOG_FIXTURE:-}"
FIXED_LOG="${WRD_FIXED_DOMAIN_LOG:-/tmp/wrd-fixed-domain.log}"

process_lines() {
  if [ -n "$PROCESS_FIXTURE" ]; then
    sed -n '1,200p' "$PROCESS_FIXTURE"
  else
    ps -axo pid=,command= | awk '/[c]loudflared/ && /tunnel/ {print}'
  fi
}

# Read-only log tail for classification only — never prints secrets or full command lines.
log_lines() {
  if [ -n "$LOG_FIXTURE" ]; then
    sed -n '1,400p' "$LOG_FIXTURE"
  elif [ -f "$FIXED_LOG" ]; then
    tail -n 200 "$FIXED_LOG" 2>/dev/null || true
  fi
}

status=0
if [ "${WRD_PREFLIGHT_SKIP_LOCAL:-0}" != "1" ]; then
  if ! curl -fsS --max-time 2 "$ORIGIN/health" >/dev/null; then
    echo 'local-health: failed'
    status=1
  else
    echo 'local-health: ok'
  fi
fi

if ! grep -Eq '^[[:space:]]*credentials-file[[:space:]]*:' "$CONFIG" 2>/dev/null; then
  echo 'credentials-file: missing'
  status=1
else
  echo 'credentials-file: present'
fi

formal_count="$(process_lines | awk '/--config/ && /run/ {count++} END {print count+0}')"
token_count="$(process_lines | awk '/(^|[[:space:]])--token([=[:space:]]|$)/ {count++} END {print count+0}')"
http2_count="$(process_lines | awk '/--protocol[ =]http2/ {count++} END {print count+0}')"
quic_count="$(process_lines | awk '/--protocol[ =]quic/ {count++} END {print count+0}')"

if [ "$formal_count" -le 1 ]; then
  echo "formal-owners: $formal_count"
else
  echo "multiple-formal-owners: $formal_count"
  status=1
fi

if [ "$token_count" -eq 0 ]; then
  echo 'token-argv: absent'
else
  echo 'token-argv: present'
  status=1
fi

if [ "$http2_count" -gt 0 ]; then
  echo 'protocol: http2'
elif [ "$quic_count" -gt 0 ]; then
  echo 'protocol: quic'
else
  echo 'protocol: unspecified'
fi

# Classify recent connector health signals without dumping raw logs.
timeout_hits="$(log_lines | grep -cE 'timeout: no recent network activity|failed to accept QUIC stream|Connection terminated' || true)"
reconnect_hits="$(log_lines | grep -cE 'Retrying connection|Registered tunnel connection|Initiating graceful shutdown' || true)"
echo "recent-timeouts: ${timeout_hits:-0}"
echo "recent-reconnects: ${reconnect_hits:-0}"
if [ "${timeout_hits:-0}" -gt 5 ]; then
  echo 'connector-stability: timeout-heavy'
  status=1
elif [ "${reconnect_hits:-0}" -gt 8 ]; then
  echo 'connector-stability: reconnect-heavy'
else
  echo 'connector-stability: ok'
fi

if [ "${WRD_PREFLIGHT_SKIP_NETWORK:-0}" != "1" ]; then
  if ! curl -fsS --max-time 5 -o /dev/null \
    -w 'formal-health: code=%{http_code} total=%{time_total}\n' "$FORMAL_URL/health"; then
    status=1
  fi
fi

exit "$status"
