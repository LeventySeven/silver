---
description: Drive one web page to read a fact, click through, or fill a form — the lean loop.
argument-hint: <url-or-goal>
---

# Quick browser task

First load the guide: run `silver skill --full` (or read `skill-data/core/SKILL.md`). Then
follow §1 "The lean loop" for: **$ARGUMENTS**

Steps: `silver open <url> --session q` → `silver snapshot -i --session q` (read the `@eN` refs) →
act with `--enable-actions` (`click`/`fill`/`press`) → re-`snapshot` after any
`page_changed`/`stale_refs` → read the value (`get text @ref`) or `extract`. Start read-only;
only add `--enable-actions` when you must mutate. Pass secrets on `--stdin`, never argv. Verify
the goal, not just `success:true`.
