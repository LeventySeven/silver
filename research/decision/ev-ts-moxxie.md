# ev-ts-moxxie — Fact digest: TypeScript base (skill/agent-browser, "moxxie")

Scope: `/Users/seventyleven/Desktop/Silver/skill/agent-browser`. All claims below verified by
reading the file cited or by running the command shown. No opinions asserted without a file/run
anchor.

## Facts

**Tests.** `npx vitest run` → **14 test files, 142/142 passing**, 13.6s wall (run live, not
taken on faith). Split: 9 unit files (pure functions: serialize/security/diff/errors/extract/
refmap/roles) + 5 integration files that spawn **real Chromium** via the session daemon
(session/walk/iframe/actions/cli/security-harden — the last is 10 sub-tests alone). The claimed
"142 tests, eval pass_k 1.000" is at minimum consistent with the test count; no `evals/` dir or
eval harness exists under this path (unlike `silver/evals` in the Rust fork) — the eval-gating
claim could not be independently verified here, only the unit/integration suite could.

**Codebase size.** `find src -name '*.ts' | xargs wc -l` → **5,117 lines** across 24 files
(`src/core/handlers.ts` 1,211 lines is the single largest file — the verb dispatcher).
`tsc -p .` builds clean with no errors (`dist/` populated, 504K).

**Session model / persistence** (`src/core/session.ts`, lines 1–345). Browser-as-daemon: `openSession`
spawns a **detached** Chromium (`child.unref()`, `stdio:'ignore'`) with a per-session
`--user-data-dir` and `--remote-debugging-port`, so the browser **outlives the CLI process**
(session.ts:1-13, 118-184). State lives in JSON sidecars under `~/.moxxie/sessions/<name>/`:
`session.json` (port/pid/wsEndpoint), `refmap.json` (ref→element grounding, generation-tagged),
`moxxie-state.json` (fingerprint/diff baseline), `dialog.json`. Sidecars are written via
atomic tmp-file + `rename()` (session.ts:70-83) — no torn-JSON reads. `closeSession` does a
graceful CDP disconnect → SIGTERM → poll-for-exit → SIGKILL escalation → `rm -rf` the session
dir, specifically to avoid the "Chromium resurrects the profile dir after premature rm" bug
(session.ts:283-319, comment at 288-292 names the reasoning). Reconnect is PID-liveness gated:
a dead pid on a stale sidecar throws `'the previous browser process is gone'` rather than hanging
on a dead CDP endpoint (session.ts:242-249). Deterministic 1280×900 viewport pinned at both launch
and connect for reproducible snapshots/screenshots (session.ts:51-58, 257-258). Verified live in
`tests/integration/session.test.ts`: "detached browser survives across two separate connect()
calls" (2.5s, passing).

**Multi-session / parallel readiness.** Sessions are **named** and independent: `--session <name>`
flag (`src/core/flags.ts:25,71,131`, default `'default'`), each name maps to its own
`~/.moxxie/sessions/<name>/` dir, own spawned Chromium process, own port, own refmap/state
(`src/core/handlers.ts` threads `flags.session` through every handler — 40+ call sites, e.g.
lines 150, 314, 319, 342, 517, 567). This means **N named sessions = N independent browser
processes addressable concurrently by N sub-agents**, no shared-state collision, no orchestration
layer needed on top — it falls directly out of the sidecar-per-name design. What is **not**
present: no `session list`/`session gc` sweep of orphaned processes was found beyond the
`session` verb dispatch stub (`handlers.ts:272 case 'session': return handleSession(flags)` —
handler body not fully enumerated here beyond the dispatch), and no built-in fan-out/queueing
across sessions — that orchestration would be the host LLM's (or a wrapper's) job, consistent with
the project's "host is the brain" stance.

**Security / phase-quarantine** (`src/security/registry.ts`, full file read). `buildRegistry`
is a **pure function of flags**: 21 always-on read-only verbs, 24 actor verbs added **only**
when `enableActions===true && readOnly!==true` (registry.ts:76-88). The CLI dispatcher
(`src/cli.ts:60-65`) rejects any verb outside the built set with `not_permitted` **before**
`handle()` is ever called — quarantine-as-code, not a runtime toggle a prompt-injected loop
could flip. Verified live: `cli.test.ts` — "click is quarantined then enabled" (passing).

**Egress guard** (`src/security/egress.ts:1-60`, full-file structure read). Denylist-by-default
scheme/host guard: flat deny of `file:`/`data:`/`blob:`/`view-source:`, raw-IP-literal deny
(v4/v6/decimal/hex — classic SSRF footgun), a short known-dangerous-host list (Google/Microsoft/
Apple account pages, Chrome/Firefox extension stores) denied exact-or-suffix, and an opt-in
`--allowed-domains` **suffix** match (not substring — comment explicitly calls out
`booking.com.evil.com` vs `m.booking.com`, egress.ts:14-18). DNS-rebinding note: the guard
resolves-then-checks in Node (`assertNavigableResolved`) *before* `page.goto`, with the residual
TOCTOU window explicitly documented, not hidden (session.ts:137-141, egress.ts header).

**Confirm gate** (`src/security/confirm.ts`, full file read). `MUTATING_VERBS` (18 verbs:
click/fill/type/press/select/check/upload/download/drag/set/eval/mouse/dialog/…) require
confirmation; deliberately **excludes** benign viewport-moving verbs (scroll/hover/focus/find/
frame) so those never trip the gate (confirm.ts:17-24). A narrow paid/destructive accessible-name
regex (`buy|purchase|checkout|pay\b|payment|order|delete|remove`, confirm.ts:56) gates a second,
independent layer — explicitly **excludes** `submit/send/post/confirm/subscribe/cancel` because
"a keyless regex cannot tell 'Submit expense report' from 'Submit payment'" (confirm.ts:51-52).
Fail-closed on non-TTY: a mutating verb without `--confirm-actions` pre-approval is denied when
there's no human TTY to prompt (confirm.ts:96-113) — the common "host LLM drives the CLI
headlessly" case. Verified live in `security-harden.test.ts`: "Buy is denied by default
(non-TTY), approvable" and "confirm gate parity: find text click is gated like a direct click"
(both passing).

**Extract (ID-grounded, keyless)** (`src/extract/resolve.ts`, full file read). Two hardenings
documented over Stagehand's `injectUrls`: (1) generation-gating — `resolveIds` refuses
(`ref_stale`) if the bundle's snapshot generation doesn't match the session's current generation
(resolve.ts:44-47), preventing resolution against a stale value-map after navigation; (2) "loud
null" — an ID absent from the value map becomes `null` + a named warning, never Stagehand's
silent `?? ""` that would fabricate a value (resolve.ts:62-70, 85-87). Purely a JSON transform,
no model/network call (resolve.ts:18).

**Diff-when-shorter perception** (`src/perception/diff.ts:1-46`). `observe(prev, tree)` returns
whichever is shorter — a hand-rolled Myers O(ND) unified diff (git-style hunks, 3 lines context)
or the full tree — with a `NO_CHANGES` sentinel for the unchanged case. No new dependency for the
diff engine (comment at line 12).

**CLI surface / agent-ergonomics** (`src/cli.ts` full file, `src/core/handlers.ts` verb switch).
Verbs grouped: lifecycle (open/goto/navigate/close/back/forward/reload), perception
(snapshot/read/screenshot), interaction (click/dblclick/hover/focus/fill/type/press/select/check/
uncheck/scroll/upload/drag/find), query (get/is/wait), extract (extract, extract resolve), auth
(state/cookies/session), meta (version/doctor/skill) — `usage()` in cli.ts:104-140. `--json` flag
present, sanitized failure envelope (`mapThrow`, cli.ts:79-96) guarantees no raw stack/path/secret
ever reaches stdout — typed error codes only. Some verbs (`tab`, `frame`, `network`, `pdf`) are
explicitly **stubbed as not-implemented** rather than faked (`handlers.ts:283-287`, comment:
"nice-to-have — honestly unimplemented (never faked)").

**Skill file** (`SKILL.md`, full file read). Discovery-stub pattern: `moxxie skill --full` /
`moxxie skill` load the real contract from the binary itself (not a static doc the model must
already have memorized) — `SKILL.md:13-18`. States the lean loop explicitly: `open → snapshot -i
(@eN refs) → act with --enable-actions → re-snapshot after page_changed/stale_refs` (SKILL.md:20-22).

**npm distribution.** `package.json`: name `moxxie`, `"private": true` (blocks publish as-is —
would need flipping), `bin: {moxxie: "./dist/cli.js"}`, `engines.node >=24`, single runtime
dependency `playwright ^1.61.0` (package.json:1-27). `npm pack --dry-run` succeeds mechanically:
79 files, **96.2 kB packed / 346.2 kB unpacked** tarball (run live). `node_modules` is 67M (mostly
the Playwright package + its browser-download tooling; Chromium binary itself is fetched
separately by Playwright, not bundled in the 67M). Compares to a Rust binary distribution (the
`silver/` fork) which ships a single compiled executable with no Node/npm runtime dependency at
install time — TS requires Node ≥24 and an `npm install` (or `npx`) step, Rust requires only the
binary.

**Dev velocity / provenance signal.** No `.git` in this directory (not a git repo — confirmed by
env). File mtimes across `src/`, `tests/`, `package.json` all fall on **2026-07-15** (today),
spanning roughly 14:44–18:22 — i.e., this is fresh, same-day-authored code with no multi-day
commit history to inspect for velocity trend; the 5,117-line/142-test surface was produced (or at
least last-touched) in a single working session, which is a *provenance* fact, not a quality
judgment.

**Provenance/licensing** (`NOTICE`, full file read). Explicitly credits three upstream projects
for *adapted patterns*, not verbatim code: vercel-labs/agent-browser (snapshot line grammar,
`@eN` ref format, role allowlists, `parseRef` tolerance, envelope shape), browserbase/stagehand
(ID-grounded extract design), browser-use/browser-use (interactive-element heuristic cascade).

## Pros

- Full test suite is real and green (142/142, integration tests spawn actual Chromium, not
  mocked) — verified by running it, not by trusting the claim.
- Session model is already a "daemon with named, independent, addressable sessions" — the
  multi-agent/parallel-orchestration primitive (criterion d) exists today with zero extra
  scaffolding: `--session <name>` gives isolated browser + state per sub-agent.
- Security posture is layered and independently testable: phase-quarantine (registry.ts, pure
  function) → egress guard (denylist + DNS-resolved SSRF check) → confirm gate (fail-closed on
  non-TTY) → redaction — each has its own unit tests plus live integration coverage.
- Keyless-by-construction: extract/resolve.ts is a pure JSON transform with no model call, and the
  whole CLI's failure path (`mapThrow`) guarantees no raw error/path/secret leak.
- Small, focused dependency footprint (Playwright only) and a clean `tsc` build; `npm pack` already
  works mechanically.
- SKILL.md follows a "load the real contract from the binary" discovery-stub pattern rather than a
  static doc that drifts from the code.
- Diff-when-shorter and ID-grounded extract are both custom, tested, and documented as deliberate
  hardenings over the projects they're adapted from (Stagehand's `injectUrls` silent-empty-string
  bug is explicitly named and fixed).

## Cons

- `"private": true` blocks npm publish as-is; would need explicit publish config, and version is
  still `0.1.0` — not yet released anywhere.
- No git history in this directory: all files last-touched same calendar day, so there's no track
  record of iteration speed, regressions, or how the test suite evolved — only a snapshot state.
- Requires Node ≥24 + npm/npx install step vs. a single compiled binary (the Rust fork ships one
  executable); this is a real distribution-weight difference for "install-and-use with zero
  config" (criterion e) — Node/npm must already be on the host.
- No eval harness (`evals/`) found under this path, unlike the Rust fork's `silver/evals` — the
  "eval pass_k 1.000" claim in the task prompt could not be corroborated from files under this
  path; only the 142-test vitest suite could be confirmed.
- Some CLI surface is intentionally unimplemented (`tab`, `frame`, `network`, `pdf` — all
  `notImplemented()`), so the "60+ verb surface" parity claimed for the Rust fork is not yet fully
  matched here; this is honestly stubbed rather than faked, but it is a real gap versus a
  consolidated single product.
- No visible session-listing/garbage-collection command was confirmed beyond the `session` verb's
  dispatch entry — orphaned detached-Chromium processes across many parallel named sessions could
  accumulate without an explicit sweep (not disproven, just not found in the code read).
- Single-largest file, `handlers.ts` at 1,211 lines, is the whole verb dispatcher plus lifecycle
  logic in one file — a maintainability/readability data point for "dev velocity" going forward,
  independent of current correctness.

## Relevance to the 9 criteria (as stated in the task: a–f plus tests/ergonomics/velocity)

1. **Agent-ergonomic CLI + SKILL.md** — met: verb taxonomy grouped by phase, `--json` envelopes,
   self-describing `moxxie skill --full`, sanitized errors (cli.ts, SKILL.md).
2. **Fast quick tasks** — plausible from design (CDP connect/disconnect per command, diff-when-
   shorter to cut payload size) but no benchmark numbers were found under this path to confirm
   wall-clock speed claims.
3. **Long-running/resumable tasks** — partially met: the daemon persists across CLI invocations
   (session.ts), so a long task can resume by reconnecting to the same named session; but there is
   no Webwright-style "task = re-runnable script, logs are the artifact" concept here — state is
   the live browser + JSON sidecars, not a replayable script (contrast with
   `reference/webwright/README.md:75`'s own comparison table, which frames the daemon browser-
   session model, not code+logs, as "state").
4. **Parallel multi-agent orchestration** — met at the primitive level (named, independent
   sessions per sub-agent, verified via `--session` flag threading) but no fan-out/queue
   orchestration layer exists on top; that would be built on top of, not inside, this base.
5. **Install-and-use with zero config** — partially met: `npm i -g moxxie` is the documented path
   (SKILL.md:20) and `npm pack` works, but `private:true` currently blocks it, and it requires
   Node ≥24 already present, unlike a standalone binary.
6. **Keyless** — fully met: no model call found anywhere in the read source; `extract/resolve.ts`
   explicitly a pure transform; egress/confirm/registry are all pure functions of flags/input.
7. **What to KEEP if TS wins**: the entire security stack (registry/egress/confirm/redact/
   injection), the session daemon model, diff.ts, extract/resolve.ts, and the test suite structure
   — all are self-contained, tested, and already pass.
8. **What to REWRITE if TS wins**: `tab`/`frame`/`network`/`pdf` verbs need real implementations
   to reach the claimed 60+ verb parity with the Rust fork; publish config needs finishing; a
   session-list/GC command should be added or confirmed for parallel-session hygiene; if
   Webwright-style resumable task-scripting is wanted, that's new work layered on top of the
   existing daemon, not present today.
9. **Dev velocity** — the codebase is compact (5,117 lines), builds clean, and the test suite runs
   in ~14s, which is fast feedback for iteration; but with no git history available in this
   directory, no trend data could be verified — only a point-in-time snapshot.
