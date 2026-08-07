# STATE — Silver — rewritten 2026-08-08

## Goal
Silver presents a coherent, non-impossible browser identity and reads pages through a world the
page cannot tamper with: `silver doctor --fingerprint` passes its coherence invariants headed and
headless, perception no longer reads via main-world primitives, and PR #3 is landed or closed.

## Done
- Investigation complete (agent-reach + cloakbrowser, 4 parallel agents) — evidence: findings
  verified against source; viewport defect confirmed at session.ts:1673, isolated world absent (0 hits).

## Next
1. Review PR #3 (`perf/park-idle-pages-and-cap-browsers`, 682+/17-, touches session.ts connect()
   at the exact line the viewport fix needs) via compound-v:code-review; land or reject it FIRST.
2. Fix viewport incoherence: gate session.ts:1673 `setViewportSize` on headless-and-not-external
   (`headed` is already in the sidecar at session.ts:946); same for handlers.ts:1334 and :1463.
3. Add `doctor --fingerprint`: offline coherence panel on about:blank (outer>=inner when headed,
   TZ/locale/UA-platform agreement, webdriver, `__pwInitScripts`).
4. Move perception `.evaluate()` reads to `Page.createIsolatedWorld`.
5. Extend tests/unit/commands-docs.test.ts glob to skill-data/** and README.md.
6. `--lang` + `TZ=` at spawn; keep CDP Emulation as mid-session fallback.

## Open decisions
- none (unattended; reversible defaults, no push/merge to origin without the run proving green).

## Verify with
```bash
cd silver && npm run build && npm test
```

## Do not
- Do not rebase the viewport fix onto master before PR #3 is resolved — both edit `connect()`
  around session.ts:1673 and will conflict.
- Do not add JS canvas/WebGL spoofing, human input cadence, captcha solving, a daemon, or
  auto-download of a browser binary. All refused deliberately; see memory silver-sota-aside-mind.
