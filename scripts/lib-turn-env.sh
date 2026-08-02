#!/bin/bash
# Load TURN_* into the current shell for Host / operator scripts.
# Priority: already-exported env TURN_URLS wins; else fill gaps from
# signal-server/.env (already sourced by caller) then WRD_TURN_JSON / ~/.StockHub/turn.json.
# Multi-server turnServers[]: export the default node (Aliyun preferred).
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
import re
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except Exception as exc:
    print(f"error={exc}", file=sys.stderr)
    sys.exit(1)

def preferred_aliyun(entry):
    region = str(entry.get("region") or "").strip().lower()
    if region in {"cn", "aliyun", "china"}:
        return True
    blob = " ".join(str(entry.get(key) or "") for key in ("id", "remark", "label", "realm", "host"))
    return bool(re.search(r"阿里云|aliyun|ali\.yun", blob, flags=re.I))

def build_urls(entry):
    host = str(entry.get("host") or "").strip()
    port = entry.get("port") or 3478
    transport = str(entry.get("transport") or "udp").strip().lower() or "udp"
    urls = str(entry.get("urls") or entry.get("TURN_URLS") or "").strip()
    if not urls and host:
        urls = f"turn:{host}:{port}?transport={transport}"
    return urls

entries = []
if isinstance(data, dict) and isinstance(data.get("turnServers"), list):
    entries = [item for item in data["turnServers"] if isinstance(item, dict)]
if isinstance(data, dict) and isinstance(data.get("turnServer"), dict):
    entries.append(data["turnServer"])
if not entries and isinstance(data, dict) and (data.get("host") or data.get("urls") or data.get("TURN_URLS")):
    entries = [data]

if not entries:
    sys.exit(0)

configured = []
for entry in entries:
    urls = build_urls(entry)
    username = str(entry.get("username") or entry.get("user") or "").strip()
    password = str(entry.get("password") or entry.get("credential") or "").strip()
    if urls and username and password:
        configured.append({**entry, "_urls": urls, "_username": username, "_password": password})

if not configured:
    entry = entries[0]
    urls = build_urls(entry)
    username = str(entry.get("username") or entry.get("user") or "").strip()
    password = str(entry.get("password") or entry.get("credential") or "").strip()
else:
    file_default = str(data.get("defaultTurnServerId") or "").strip() if isinstance(data, dict) else ""
    chosen = None
    if file_default:
        for entry in configured:
            if str(entry.get("id") or "").strip() == file_default:
                chosen = entry
                break
    if chosen is None:
        aliyun = [entry for entry in configured if preferred_aliyun(entry)]
        chosen = aliyun[0] if aliyun else configured[0]
    urls = chosen["_urls"]
    username = chosen["_username"]
    password = chosen["_password"]

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
