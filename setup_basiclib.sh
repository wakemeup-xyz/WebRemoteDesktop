#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LOCK_FILE="${SKILLS_LOCK_FILE:-$PROJECT_DIR/skills-lock.json}"
AGENTS_ROOT="${AGENTS_SKILLS_ROOT:-$PROJECT_DIR/.agents/skills}"

log() {
  printf '[setup_basiclib] %s\n' "$*"
}

fail() {
  printf '[setup_basiclib] ERROR: %s\n' "$*" >&2
  exit 1
}

require_file() {
  local file="$1"
  [ -f "$file" ] || fail "required file not found: $file"
}

require_command() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

require_file "$LOCK_FILE"
require_command python3

mkdir -p "$AGENTS_ROOT"

install_local_skill() {
  local skill_name="$1"
  local relative_path="$2"
  local source_dir="$PROJECT_DIR/$relative_path"
  local cache_link="$AGENTS_ROOT/$skill_name"

  [ -d "$source_dir" ] || fail "local skill source directory does not exist: $source_dir"
  [ -f "$source_dir/SKILL.md" ] || fail "local skill is missing SKILL.md: $source_dir"

  rm -rf "$cache_link"
  ln -s "$source_dir" "$cache_link"

  log "installed local skill '$skill_name' from $relative_path"
}

while IFS=$'\t' read -r skill_name source_type skill_path; do
  [ -n "$skill_name" ] || continue

  case "$source_type" in
    local)
      install_local_skill "$skill_name" "$skill_path"
      ;;
    "")
      fail "skill '$skill_name' is missing source type"
      ;;
    *)
      fail "skill '$skill_name' uses unsupported source type '$source_type' in this repo; supported: local"
      ;;
  esac
done < <(
  python3 - "$LOCK_FILE" <<'PY'
import json
import sys

lock_file = sys.argv[1]
with open(lock_file, "r", encoding="utf-8") as fh:
    data = json.load(fh)

skills = data.get("skills", {})
for name, config in skills.items():
    source = config.get("source", "local")
    path = config.get("path", "")
    print(f"{name}\t{source}\t{path}")
PY
)

log "sync complete"
