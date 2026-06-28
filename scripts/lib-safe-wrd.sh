#!/bin/bash

wrd_safe_pid_is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wrd_safe_read_pid_file() {
  local pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  cat "$pid_file" 2>/dev/null || true
}

wrd_safe_write_pid_file() {
  local pid_file="$1"
  local pid="$2"
  if [ -n "$pid" ]; then
    printf "%s\n" "$pid" > "$pid_file"
  fi
}

wrd_safe_process_cwd() {
  local pid="$1"
  lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

wrd_safe_pid_matches_cwd() {
  local pid="$1"
  local expected_cwd="$2"
  [ -n "$pid" ] || return 1
  [ -n "$expected_cwd" ] || return 1
  [ "$(wrd_safe_process_cwd "$pid")" = "$expected_cwd" ]
}

wrd_safe_find_pid_by_pattern_and_cwd() {
  local pattern="$1"
  local expected_cwd="$2"
  local pid=""
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    if wrd_safe_pid_matches_cwd "$pid" "$expected_cwd"; then
      printf "%s\n" "$pid"
      return 0
    fi
  done
  return 1
}

wrd_safe_find_signal_pid() {
  local project_dir="$1"
  wrd_safe_find_pid_by_pattern_and_cwd 'server\.js' "$project_dir/signal-server"
}

wrd_safe_find_host_pid() {
  local project_dir="$1"
  wrd_safe_find_pid_by_pattern_and_cwd 'host\.py' "$project_dir/python-host"
}

wrd_safe_find_tunnel_supervisor_pid() {
  local project_dir="$1"
  local scripts_dir="$project_dir/scripts"
  local pid=""
  for pid in $(pgrep -f 'run-safe-quicktunnel\.sh' 2>/dev/null || true); do
    local cwd
    cwd=$(wrd_safe_process_cwd "$pid")
    if [ "$cwd" = "$project_dir" ] || [ "$cwd" = "$scripts_dir" ]; then
      printf "%s\n" "$pid"
      return 0
    fi
  done
  return 1
}

wrd_safe_find_quick_tunnel_pid() {
  local project_dir="$1"
  local pid=""
  for pid in $(pgrep -f 'cloudflared.*tunnel.*--url http://127\.0\.0\.1:8080' 2>/dev/null || true); do
    if wrd_safe_pid_matches_cwd "$pid" "$project_dir"; then
      printf "%s\n" "$pid"
      return 0
    fi
  done
  return 1
}

wrd_safe_find_tunnel_manager_pid() {
  local project_dir="$1"
  local pid=""

  pid=$(wrd_safe_find_tunnel_supervisor_pid "$project_dir" 2>/dev/null || true)
  if wrd_safe_pid_is_running "$pid"; then
    printf "%s\n" "$pid"
    return 0
  fi

  pid=$(wrd_safe_find_quick_tunnel_pid "$project_dir" 2>/dev/null || true)
  if wrd_safe_pid_is_running "$pid"; then
    printf "%s\n" "$pid"
    return 0
  fi

  return 1
}

wrd_safe_find_pid_by_kind() {
  local kind="$1"
  local project_dir="$2"
  case "$kind" in
    signal) wrd_safe_find_signal_pid "$project_dir" ;;
    host) wrd_safe_find_host_pid "$project_dir" ;;
    tunnel-supervisor) wrd_safe_find_tunnel_manager_pid "$project_dir" ;;
    quick-tunnel) wrd_safe_find_quick_tunnel_pid "$project_dir" ;;
    *) return 1 ;;
  esac
}

wrd_safe_reconcile_pid_file() {
  local pid_file="$1"
  local kind="$2"
  local project_dir="$3"
  local current_pid=""
  current_pid=$(wrd_safe_read_pid_file "$pid_file")
  if wrd_safe_pid_is_running "$current_pid"; then
    printf "%s\n" "$current_pid"
    return 0
  fi

  local live_pid=""
  live_pid=$(wrd_safe_find_pid_by_kind "$kind" "$project_dir" 2>/dev/null || true)
  if wrd_safe_pid_is_running "$live_pid"; then
    wrd_safe_write_pid_file "$pid_file" "$live_pid"
    printf "%s\n" "$live_pid"
    return 0
  fi

  return 1
}

wrd_safe_trycloudflare_ips() {
  local host="$1"
  [ -n "$host" ] || return 1

  nslookup "$host" 8.8.8.8 2>/dev/null \
    | sed -n 's/^Address: //p' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
    | tail -n +2 \
    | awk '!seen[$0]++'
}

wrd_safe_trycloudflare_reachable() {
  local url="$1"
  local host="$2"
  local ip=""

  while IFS= read -r ip; do
    [ -n "$ip" ] || continue
    if curl --resolve "${host}:443:${ip}" -I -L --max-time 10 "$url" >/dev/null 2>&1; then
      return 0
    fi
  done < <(wrd_safe_trycloudflare_ips "$host")

  return 1
}

wrd_safe_url_reachability_state() {
  local url="$1"
  [ -n "$url" ] || return 1

  if curl -I -L --max-time 10 "$url" >/dev/null 2>&1; then
    printf '%s\n' reachable
    return 0
  fi

  local host=""
  host=$(printf '%s\n' "$url" | sed -E 's#^https?://([^/]+).*$#\1#')
  if ! printf '%s\n' "$host" | grep -q '\.trycloudflare\.com$'; then
    printf '%s\n' unreachable
    return 1
  fi

  local ip=""
  local resolved_ips=""
  resolved_ips=$(wrd_safe_trycloudflare_ips "$host" 2>/dev/null || true)
  if [ -z "$resolved_ips" ]; then
    printf '%s\n' dns-unresolved
    return 1
  fi

  while IFS= read -r ip; do
    [ -n "$ip" ] || continue
    if curl --resolve "${host}:443:${ip}" -I -L --max-time 10 "$url" >/dev/null 2>&1; then
      printf '%s\n' reachable
      return 0
    fi
  done <<EOF
$resolved_ips
EOF

  printf '%s\n' origin-unreachable
  return 1
}

wrd_safe_url_is_reachable() {
  local url="$1"
  local state=""
  state=$(wrd_safe_url_reachability_state "$url" || true)
  [ "$state" = reachable ]
}
