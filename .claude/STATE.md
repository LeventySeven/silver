# STATE — Silver — rewritten 2026-08-08

## Goal
Silver presents a coherent, non-impossible browser identity and reads pages through a world the
page cannot tamper with: `silver doctor --fingerprint` passes its coherence invariants headed and
headless, perception no longer reads via main-world primitives, and PR #3 is landed or closed.

## Done
- Investigation complete (agent-reach + cloakbrowser, 4 parallel agents) — evidence: findings
  verified against source; viewport defect confirmed, isolated world absent (0 hits).
- PR #3 reviewed (FIX_REQUIRED: 1 Critical, 1 Important, 1 Minor) and merged into this branch.
- Two plans written + fresh-context reviewed (FIX_REQUIRED → 11 stale citations and 4 design
  errors corrected) — evidence: all 11 corrected citations re-verified by `sed`+`grep`.
- Baseline established — evidence: `npm run build` exit 0, `npm test` → "Test Files 68 passed
  (68) / Tests 748 passed (748)".
- **Plan A COMPLETE + rechecked APPROVED** (A1 restart notice, A2 every-verb reporting, A3
  bounded eviction) — evidence: `npm test` → "Test Files 69 passed (69) / Tests 756 passed
  (756)", build exit 0, both verified by me, not by the implementer's report. Recheck caught a
  regression in A3 (bound was on *confirmed exits*, so a slow browser fell through and the loop
  killed the next one too — 2 killed, `[]` reported); fixed by bounding on signals sent with one
  shared confirm budget, pinned by a new invariant test verified red first.

- **Batch 2 (B1 viewport gate + B2 `doctor --fingerprint`) COMPLETE + rechecked APPROVED** —
  evidence: `npm test` → "Test Files 71 passed (71) / Tests 769 passed (769)", build exit 0,
  both re-run by me. Recheck found 7 issues incl. a real prompt-injection channel (page
  `navigator.*` text flowed unclamped into doctor `details`, which reads in silver's own voice
  with no `⟦page-content untrusted⟧` marker); fixed at one `sanitizeProbe` boundary via the
  existing `cookieField`. NUL-byte scan clean on all 8 changed files (verified with
  `tr -d '\000' | cmp`, NOT `grep $'\x00'` — bash cannot hold NUL in an argument, so that
  pattern is empty and matches every file).

- **Batch 3 (B3 doc glob + B4 launch-layer locale/TZ) COMPLETE + rechecked APPROVED** —
  evidence: `npm test` → "Test Files 72 passed (72) / Tests 777 passed (777)", build exit 0,
  re-run independently by the reviewer; B3's matcher proven to bite against 16 install-line
  spellings and NOT to fire on `agent-silver`; B4 proven *honored* on a live page
  (tz=Europe/Berlin, navigator.language=de-DE, Accept-Language=de-DE,de;q=0.9), not merely
  composed into argv. Two Minor findings recorded as a deferred task in the plan, not dropped.

## Next
1. **B5 alone** (isolated-world perception reads — riskiest, own rollback point; the plan
   explicitly permits it to land as attempted+reverted+documented).
2. Then one whole-subsystem pass for drift between batches (per-batch recheck is structurally
   blind to it), then `compound-v:finishing`.
3. Full suite must stay at 777+ passing.

## Open decisions
- none (unattended; reversible defaults, no push/merge to origin without the run proving green).

## Verify with
```bash
cd silver && npm run build && npm test
```

## Do not
- Do not cite pre-PR-#3 line numbers: the merge shifted `session.ts` by ~116 lines. The viewport
  override is at **1789**, not 1673 (1673 is inside `probeRealColorScheme`). Plans are corrected;
  re-derive before trusting any older note.
- Do not use `waitForExit` in the browser ceiling — it escalates to SIGKILL, which cannot be
  ignored, so the "survivor is not claimed" test could never go red. Poll instead.
- Do not note a session restart whenever `connect()` throws: it also throws on a brand-new
  session's first `open`, which would false-alarm on the most common command.
- Do not treat `npm run eval` as a gate — `evals/run.mjs` has no exit code; the real passK gate
  is `tests/integration/evals.test.ts` under `npm test`.
- Do not target Node >= 24 in `silver/` — the shipped `engines` floor is **>=20** and
  `@types/node` ^24 means tsc will not catch a violation.
- Do not commit under `docs/` — it is gitignored by design (public repo ships skill + CLI only).
- Do not add JS canvas/WebGL spoofing, human input cadence, captcha solving, a daemon, or
  auto-download of a browser binary. All refused deliberately; see memory silver-sota-aside-mind.
