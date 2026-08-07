# STATE — Silver — rewritten 2026-08-08

## Goal
Silver never silently returns a page it lost, and never presents a structurally impossible
browser identity: `doctor --fingerprint` clean headed and headless, perception read from a world
the page cannot patch, PR #3 landed honestly.

## Done
Full detail is in the `Plan:`/`Recheck:` trailers on each batch commit — read `git log`, not here.
- PR #3 reviewed (FIX_REQUIRED) + merged; plans written and fresh-reviewed (11 stale citations,
  4 design errors corrected before any code).
- Batch 1 — plan A (respawn notice, every-verb reporting, bounded eviction). APPROVED @ `89c979a`.
- Batch 2 — B1 viewport gate + B2 `doctor --fingerprint`. APPROVED @ `a35b980`.
- Batch 3 — B3 doc glob + B4 launch-layer locale/TZ. APPROVED @ `0f5fe33`.
- Batch 4 — B5 isolated-world perception reads. APPROVED @ `95f0ff6`.
- Baseline 748 → 783 tests, build exit 0, passK 100%, verified by me each time, not from a report.

## Next
1. One whole-subsystem pass for drift between batches — per-batch recheck cannot see it.
2. `compound-v:finishing`. Suite must stay at 783.

## Open decisions
- none (unattended; nothing pushed to origin, no PR merged, all work on `run/detection-coherence`).

## Verify with
```bash
cd silver && npm run build && npm test && npm run eval
```

## Do not
1. Trust any line number in the plans without re-grepping — every batch shifts them (~116 lines
   from PR #3 alone). Symbol names are the durable reference.
2. Use `waitForExit` in the browser ceiling — it escalates to SIGKILL, so a "survivor is not
   claimed" test can never go red. Poll instead.
3. Note a session restart whenever `connect()` throws — it also throws on a fresh session's
   first `open`, false-alarming on the most common command.
4. Treat `npm run eval` exit 0 as a gate; it has none. The passK gate is `evals.test.ts`.
5. Target Node >= 24 in `silver/` — the shipped floor is **>=20** and `@types/node` ^24 hides it.
6. Assume a green suite proves perception is unchanged. 781/781 passed while B5 silently
   collapsed pointer-cursor rows, because no fixture uses a JS-assigned `el.onclick`. Diff
   perception output against the base commit when you change what the scan sees.
7. Scan for NULs with `grep $'\x00'` — bash cannot hold NUL in an argument, so the pattern is
   empty and matches every file. Use `LC_ALL=C tr -d '\000' < F | cmp -s - F`.
8. Commit under `docs/` — gitignored by design (this repo ships skill + CLI only).
