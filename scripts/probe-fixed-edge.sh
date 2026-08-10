#!/bin/bash
# Read-only formal/origin/edge probe. Diagnostic only — never mutates tunnels.
set -euo pipefail

ORIGIN_HEALTH="${ORIGIN_HEALTH:-http://127.0.0.1:8080/health}"
FORMAL_HEALTH="${FORMAL_HEALTH:-https://link.stockhub.wiki/health}"
# Sample CF edge IPs (override with WRD_PROBE_EDGE_IPS=ip1,ip2,...)
WRD_PROBE_EDGE_IPS="${WRD_PROBE_EDGE_IPS:-198.41.200.193,198.41.192.47,198.41.200.23,198.41.192.107}"
WRD_PROBE_JSON_OUT="${WRD_PROBE_JSON_OUT:-/tmp/wrd-fixed-edge-probe.json}"
WRD_PROBE_SKIP_WRITE="${WRD_PROBE_SKIP_WRITE:-0}"
EDGE_PORT=7844

classify() {
  local origin_ok="$1" formal_ok="$2" edge_open="$3" edge_total="$4"
  local edge_fail=$((edge_total - edge_open))
  if [ "$origin_ok" != 1 ]; then
    echo origin-down; return
  fi
  if [ "$formal_ok" != 1 ]; then
    if [ "$edge_total" -gt 0 ] && [ "$edge_fail" -gt "$edge_open" ]; then
      echo edge-blocked; return
    fi
    echo formal-down-local-ok; return
  fi
  if [ "$edge_total" -gt 0 ] && [ "$edge_fail" -gt "$edge_open" ]; then
    echo edge-degraded; return
  fi
  echo ok
}

result_to_ok() {
  case "${1:-}" in
    ok|1|true|yes) echo 1 ;;
    *) echo 0 ;;
  esac
}

# TCP connect check for cloudflared edge port. Prefer nc; fall back to python socket.
# Must remain diagnostic-only (no process control of tunnel daemons).
probe_tcp_edge() {
  local ip="$1"
  if command -v nc >/dev/null 2>&1; then
    # macOS nc: -G is connect timeout seconds; -z is scan without sending data
    nc -z -G 3 "$ip" "$EDGE_PORT" >/dev/null 2>&1
    return $?
  fi
  python3 - "$ip" "$EDGE_PORT" <<'PY'
import socket, sys
ip, port = sys.argv[1], int(sys.argv[2])
try:
    with socket.create_connection((ip, port), timeout=3):
        raise SystemExit(0)
except OSError:
    raise SystemExit(1)
PY
}

check_http_health() {
  local url="$1"
  local body
  if ! body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
    return 1
  fi
  printf '%s' "$body" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
except Exception:
  raise SystemExit(1)
raise SystemExit(0 if d.get("status")=="ok" or d.get("deliverable") is True else 1)' 2>/dev/null
}

origin_ok=0
formal_ok=0
edge_open=0
edge_total=0
mode=live
edge_detail=""

if [ -n "${WRD_PROBE_ORIGIN_RESULT:-}" ] || [ -n "${WRD_PROBE_FORMAL_RESULT:-}" ] || [ -n "${WRD_PROBE_EDGE_RESULTS:-}" ]; then
  mode=fixture
  origin_ok="$(result_to_ok "${WRD_PROBE_ORIGIN_RESULT:-fail}")"
  formal_ok="$(result_to_ok "${WRD_PROBE_FORMAL_RESULT:-fail}")"
  if [ -n "${WRD_PROBE_EDGE_RESULTS:-}" ]; then
    IFS=',' read -r -a edge_bits <<< "${WRD_PROBE_EDGE_RESULTS}"
    for bit in "${edge_bits[@]}"; do
      bit_trimmed="$(printf '%s' "$bit" | tr -d '[:space:]')"
      [ -z "$bit_trimmed" ] && continue
      edge_total=$((edge_total + 1))
      case "$bit_trimmed" in
        1|ok|true|yes) edge_open=$((edge_open + 1)) ;;
      esac
    done
  fi
else
  if check_http_health "$ORIGIN_HEALTH"; then
    origin_ok=1
  fi
  if check_http_health "$FORMAL_HEALTH"; then
    formal_ok=1
  fi
  IFS=',' read -r -a edge_ips <<< "$WRD_PROBE_EDGE_IPS"
  for ip in "${edge_ips[@]}"; do
    ip_trimmed="$(printf '%s' "$ip" | tr -d '[:space:]')"
    [ -z "$ip_trimmed" ] && continue
    edge_total=$((edge_total + 1))
    if probe_tcp_edge "$ip_trimmed"; then
      edge_open=$((edge_open + 1))
      edge_detail="${edge_detail}${edge_detail:+,}${ip_trimmed}:open"
    else
      edge_detail="${edge_detail}${edge_detail:+,}${ip_trimmed}:closed"
    fi
  done
fi

classification="$(classify "$origin_ok" "$formal_ok" "$edge_open" "$edge_total")"
edge_fail=$((edge_total - edge_open))

echo "mode: $mode"
echo "origin-ok: $origin_ok"
echo "formal-ok: $formal_ok"
echo "edge-open: $edge_open"
echo "edge-total: $edge_total"
echo "edge-fail: $edge_fail"
if [ -n "$edge_detail" ]; then
  echo "edge-detail: $edge_detail"
fi
echo "classification: $classification"

if [ "$WRD_PROBE_SKIP_WRITE" != "1" ]; then
  python3 - "$WRD_PROBE_JSON_OUT" "$classification" "$origin_ok" "$formal_ok" "$edge_open" "$edge_total" "$mode" "$ORIGIN_HEALTH" "$FORMAL_HEALTH" <<'PY'
import json, sys
out, classification, origin_ok, formal_ok, edge_open, edge_total, mode, origin_url, formal_url = sys.argv[1:10]
payload = {
  "classification": classification,
  "origin_ok": origin_ok == "1",
  "formal_ok": formal_ok == "1",
  "edge_open": int(edge_open),
  "edge_total": int(edge_total),
  "edge_fail": int(edge_total) - int(edge_open),
  "mode": mode,
  "origin_health": origin_url,
  "formal_health": formal_url,
}
with open(out, "w", encoding="utf-8") as f:
  json.dump(payload, f, indent=2)
  f.write("\n")
PY
fi

exit 0
