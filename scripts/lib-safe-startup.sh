#!/bin/bash

# Dependencies are sourced by the caller so this file can be used as a small,
# executable seam in fixture tests without starting any service or tunnel.
wrd_safe_startup_tunnel() {
  local pid_file="$1"
  local url_file="$2"
  local project_dir="$3"

  local supervisor_pid=""
  supervisor_pid=$(wrd_safe_reconcile_pid_file "$pid_file" tunnel-supervisor "$project_dir" || true)
  local supervisor_state=absent
  if wrd_safe_pid_is_running "$supervisor_pid"; then
    supervisor_state=running
  fi

  local safe_url=""
  safe_url=$(cat "$url_file" 2>/dev/null || true)
  local url_state=missing
  if [ -n "$safe_url" ]; then
    if wrd_safe_url_is_reachable "$safe_url"; then
      url_state=reachable
    else
      url_state=unreachable
    fi
  fi

  case "$(wrd_safe_startup_tunnel_action "$supervisor_state" "$url_state")" in
    reuse)
      echo "safe tunnel supervisor already running (pid=$supervisor_pid)"
      ;;
    *)
      if [ "$url_state" = unreachable ]; then
        wrd_safe_quick_tunnel_observe unreachable "$safe_url"
      else
        wrd_safe_quick_tunnel_observe missing-url "$url_file"
      fi
      echo "automatic replacement is disabled; explicit rebuild requires a user request"
      ;;
  esac
}
