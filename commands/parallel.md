---
description: Run several browser jobs at once — shared tabs, own-session-per-agent, or subagent fan-out.
argument-hint: <goals>
---

# Parallel browser work

Load the guide (`silver skill --full`, or read `silver/skill-data/core/reference/taxonomy.md` and
`agents-memory.md`), then pick the shape for: **$ARGUMENTS**

Rule: combine dependent steps into one session; split independent ones. Below ~3 genuinely
independent units, stay sequential. Choose:

- **Shared browser, one tab per worker** (the default — start here): `open` then `tab new` per
  worker. A session is a whole Chromium; a tab is a tab. Measured on three pages at once:
  3 sessions = 33 processes / 3.5 GB / 48.6% CPU, the same 3 as tabs = 12 processes / 1.4 GB /
  15.4%. The cookie jar is shared, which is what you want for N workers on ONE logged-in site.
- **Own-browser-per-agent** (when isolation is the point): N independent `--session <name>`,
  run concurrently; isolate groups with `--namespace`. Use it when the jobs need SEPARATE
  logins/cookies for the same site, or must not see each other's storage at all — not merely
  because they run at the same time. At most `SILVER_MAX_BROWSERS` (default 3) run at once;
  past that, silver stops the least-recently-used browser (profile kept, next command
  respawns it) and says so on the `open` envelope as `evicted`.
- **Subagent fan-out** (≥3 independent sub-jobs): `silver subagent spawn … --enable-actions`
  (cap 5, one level), YOUR sub-agent drives each child — see the inheritance warning in
  `reference/agents-memory.md §3` (a delegated sub-agent does NOT auto-inherit this skill).
