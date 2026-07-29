#!/usr/bin/env bash
# The plugin surface (skills/ + commands/ at the repo root, which Claude Code's plugin
# system loads) is a copy of the canonical assets under silver/. Two hand-maintained
# copies of one file always drift, so this script owns the copy and `--check` fails
# loudly the moment they disagree.
#
# The copy is NOT verbatim. The canonical files sit beside silver/skill-data/, so a bare
# `skill-data/...` link is only correct in the canonical home; at the plugin root the same
# tree is one segment down. Every such path is rewritten to `silver/skill-data/...` on the
# way out, and `--check` compares the TRANSFORMED source against the destination — the
# transform is what gets verified, so a hand-edit of either copy still fails the check.
#
# `--check` reports four kinds of disagreement:
#   stale   — the plugin copy differs from the transformed canonical file
#   missing — a canonical file has no plugin copy
#   orphan  — a plugin-surface file whose canonical source is gone (deleted or renamed).
#             The pair set is the UNION of both sides precisely so this direction cannot
#             pass silently: building it from the canonical side alone made a deleted
#             silver/commands/task.md report "in sync" while commands/task.md kept
#             shipping to installed users as /silver:task, pointing at a dead feature.
#   version — .claude-plugin/plugin.json's `version` is the plugin's update identity, so a
#             stale one freezes installed users on an old prompt layer. It is pinned to
#             silver/package.json's version, making the bump enforced instead of remembered.
#             (Omitting `version` entirely is also valid — Claude Code then falls back to the
#             commit SHA — and the check skips this rule when the key is absent.)
#
#   scripts/sync-plugin.sh          copy canonical -> plugin surface, pruning orphans
#   scripts/sync-plugin.sh --check  exit 1 if the plugin surface disagrees with silver/
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# An empty silver/commands/ must yield zero pairs, not one literal `silver/commands/*.md`.
shopt -s nullglob

pairs=( "silver/SKILL.md:skills/silver/SKILL.md" )
for c in silver/commands/*.md; do pairs+=( "$c:commands/$(basename "$c")" ); done

# The inverse of the pair mapping: given a plugin-surface path, which canonical file must
# be behind it? Prints nothing for a path the surface has no business containing.
canonical_for() {
  case "$1" in
    skills/silver/SKILL.md) printf 'silver/SKILL.md' ;;
    commands/*.md)          printf 'silver/commands/%s' "${1#commands/}" ;;
  esac
}

# Every plugin-surface file with no canonical source behind it, one per line.
orphans() {
  local dst src
  for dst in skills/*/*.md commands/*.md; do
    src="$(canonical_for "$dst")"
    if [ -z "$src" ] || [ ! -e "$src" ]; then printf '%s\n' "$dst"; fi
  done
}

# silver/-relative doc links -> plugin-root-relative. Idempotent: an already-rewritten path
# is normalised back first, so applying the transform twice is a no-op.
transform() { sed -e 's#silver/skill-data/#skill-data/#g' -e 's#skill-data/#silver/skill-data/#g' "$1"; }

json_field() {
  node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]]??""))' "$1" "$2"
}

if [ "${1:-}" = "--check" ]; then
  stale=0
  for p in "${pairs[@]}"; do
    src="${p%%:*}"; dst="${p##*:}"
    if [ ! -e "$dst" ]; then
      printf 'missing: %s has no plugin copy at %s\n' "$src" "$dst" >&2; stale=1; continue
    fi
    if ! transform "$src" | cmp -s - "$dst"; then
      printf 'stale: %s differs from %s\n' "$dst" "$src" >&2; stale=1
    fi
  done
  while IFS= read -r o; do
    [ -n "$o" ] || continue
    printf 'orphan: %s has no canonical source\n' "$o" >&2; stale=1
  done < <(orphans)
  if [ -e .claude-plugin/plugin.json ] && [ -e silver/package.json ]; then
    plugin_version="$(json_field .claude-plugin/plugin.json version)"
    cli_version="$(json_field silver/package.json version)"
    if [ -n "$plugin_version" ] && [ "$plugin_version" != "$cli_version" ]; then
      printf 'version: .claude-plugin/plugin.json is %s but silver/package.json is %s — bump the plugin with the CLI\n' \
        "$plugin_version" "$cli_version" >&2
      stale=1
    fi
  fi
  if [ "$stale" -eq 0 ]; then echo "plugin surface in sync (${#pairs[@]} files)"; fi
  exit "$stale"
fi

mkdir -p skills/silver commands
for p in "${pairs[@]}"; do transform "${p%%:*}" > "${p##*:}"; done
removed=0
while IFS= read -r o; do
  [ -n "$o" ] || continue
  rm -f "$o"
  rmdir "$(dirname "$o")" 2>/dev/null || true
  removed=$((removed + 1))
done < <(orphans)
if [ "$removed" -gt 0 ]; then
  printf 'synced %s files into the plugin surface (pruned %s orphan(s))\n' "${#pairs[@]}" "$removed"
else
  printf 'synced %s files into the plugin surface\n' "${#pairs[@]}"
fi
