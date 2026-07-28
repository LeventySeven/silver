#!/usr/bin/env bash
# The plugin surface (skills/ + commands/ at the repo root, which Claude Code's plugin
# system loads) is a copy of the canonical assets under silver/. Two hand-maintained
# copies of one file always drift, so this script owns the copy and `--check` fails
# loudly the moment they disagree.
#
#   scripts/sync-plugin.sh          copy canonical -> plugin surface
#   scripts/sync-plugin.sh --check  exit 1 if the plugin surface is stale
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pairs=( "silver/SKILL.md:skills/silver/SKILL.md" )
for c in silver/commands/*.md; do pairs+=( "$c:commands/$(basename "$c")" ); done

if [ "${1:-}" = "--check" ]; then
  stale=0
  for p in "${pairs[@]}"; do
    src="${p%%:*}"; dst="${p##*:}"
    if ! cmp -s "$src" "$dst"; then printf 'stale: %s differs from %s\n' "$dst" "$src" >&2; stale=1; fi
  done
  [ "$stale" -eq 0 ] && echo "plugin surface in sync (${#pairs[@]} files)"
  exit "$stale"
fi

mkdir -p skills/silver commands
for p in "${pairs[@]}"; do cp "${p%%:*}" "${p##*:}"; done
echo "synced ${#pairs[@]} files into the plugin surface"
