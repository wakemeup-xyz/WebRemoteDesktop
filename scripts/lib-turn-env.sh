#!/bin/bash
# Load TURN_* into the current shell for Host / operator scripts.
# Priority: already-exported env TURN_URLS wins; else fill gaps from
# signal-server/.env (already sourced by caller) then WRD_TURN_JSON / ~/.StockHub/turn.json.
# shellcheck shell=bash

wrd_turn_default_json_path() {
  if [ -n "${WRD_TURN_JSON:-}" ]; then
    printf '%s\n' "$WRD_TURN_JSON"
    return 0
  fi
  printf '%s\n' "${HOME}/.StockHub/turn.json"
}

wrd_turn_load_json_into_env() {
  local json_path
  json_path="$(wrd_turn_default_json_path)"
  [ -f "$json_path" ] || return 0

  # Only fill missing fields so explicit env / .env stays authoritative.
  local parsed
  parsed="$(
    python3 - "$json_path" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except Exception as exc:
    print(f"error={exc}", file=sys.stderr)
    sys.exit(1)

server = data.get("turnServer") if isinstance(data, dict) else None
if not isinstance(server, dict):
    server = data if isinstance(data, dict) else {}

host = str(server.get("host") or "").strip()
port = server.get("port") or 3478
transport = str(server.get("transport") or "udp").strip().lower() or "udp"
username = str(server.get("username") or server.get("user") or "").strip()
password = str(server.get("password") or server.get("credential") or "").strip()
urls = str(server.get("urls") or server.get("TURN_URLS") or "").strip()
if not urls and host:
    urls = f"turn:{host}:{port}?transport={transport}"

def esc(value: str) -> str:
    return value.replace("'", "'\"'\"'")

print(f"TURN_URLS='{esc(urls)}'")
print(f"TURN_USERNAME='{esc(username)}'")
print(f"TURN_CREDENTIAL='{esc(password)}'")
PY
  )" || return 0

  eval "$parsed"
}

wrd_turn_export_for_host() {
  # Capture whether caller already set TURN_URLS before json fill.
  local had_urls=0
  if [ -n "${TURN_URLS:-}" ]; then
    had_urls=1
  fi

  if [ "$had_urls" -eq 0 ] || [ -z "${TURN_USERNAME:-}" ] || [ -z "${TURN_CREDENTIAL:-}" ]; then
    local before_urls="${TURN_URLS:-}"
    local before_user="${TURN_USERNAME:-}"
    local before_cred="${TURN_CREDENTIAL:-}"
    wrd_turn_load_json_into_env || true
    # Restore any non-empty pre-existing values (env / .env win over json).
    if [ -n "$before_urls" ]; then TURN_URLS="$before_urls"; fi
    if [ -n "$before_user" ]; then TURN_USERNAME="$before_user"; fi
    if [ -n "$before_cred" ]; then TURN_CREDENTIAL="$before_cred"; fi
  fi

  export TURN_URLS="${TURN_URLS:-}"
  export TURN_USERNAME="${TURN_USERNAME:-}"
  export TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
  export STUN_URLS="${STUN_URLS:-stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302}"

  local configured=0
  if [ -n "${TURN_URLS:-}" ] && [ -n "${TURN_USERNAME:-}" ] && [ -n "${TURN_CREDENTIAL:-}" ]; then
    configured=1
  fi

  local source="none"
  if [ "$configured" -eq 1 ]; then
    if [ "$had_urls" -eq 1 ]; then
      source="env"
    elif [ -f "$(wrd_turn_default_json_path)" ]; then
      source="json"
    else
      source="env"
    fi
  fi

  # Non-secret summary for launch logs.
  # IMPORTANT: callers must invoke this in the current shell (not
  # `summary="$(wrd_turn_export_for_host)"`), or TURN_* exports are lost.
  if [ "$configured" -eq 1 ]; then
    TURN_ENV_SUMMARY="$(printf 'TURN env: configured=1 source=%s urls=%s' "$source" "$TURN_URLS")"
  else
    TURN_ENV_SUMMARY='TURN env: configured=0 source=none'
  fi
  printf '%s\n' "$TURN_ENV_SUMMARY"
}
