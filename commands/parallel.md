---
description: Run several browser jobs at once — own-session-per-agent, shared tabs, or subagent fan-out.
argument-hint: <goals>
---

# Parallel browser work

Load the guide (`silver skill --full`, or read `skill-data/core/reference/taxonomy.md` and
`agents-memory.md`), then pick the shape for: **$ARGUMENTS**

Rule: combine dependent steps into one session; split independent ones. Below ~3 genuinely
independent units, stay sequential. Choose:

- **Own-browser-per-agent** (safe default, no shared state): N independent `--session <name>`,
  run concurrently; isolate groups with `--namespace`.
- **Shared browser, one tab per worker** (cheaper RAM, shares cookies): `open` then `tab new`
  per worker.
- **Subagent fan-out** (≥3 independent sub-jobs): `silver subagent spawn … --enable-actions`
  (cap 5, one level), YOUR sub-agent drives each child — see the inheritance warning in
  `reference/agents-memory.md §3` (a delegated sub-agent does NOT auto-inherit this skill).
