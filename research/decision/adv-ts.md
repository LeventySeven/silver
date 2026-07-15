# Advocate brief: S2 — TypeScript / consolidate

Author's role: advocate for S2. Every claim below is anchored to a file I read or a digest
under `research/decision/`. Weaknesses are stated plainly, not buried — a case that hides them
is worthless for a real decision.

## The one-sentence case

We already have a 5,117-line, 142/142-tests-green, keyless TypeScript CLI
(`skill/agent-browser`, "moxxie") that **independently re-derived both of the Rust fork's
proudest deltas** (ID-grounded extract, DNS-SSRF egress guard) on a codebase 14x smaller than
the Rust fork, on the one browser-automation library (Playwright) that is TS-native rather than
a secondary binding — so S2 is not "build TS from scratch," it's "finish the 20% that's
stubbed on a base that already passes its own tests," while S1 is "keep hand-maintaining a
71,796-line raw-CDP client that already diverges from upstream on 46 of 64 files."

## Criterion-by-criterion (weights as given)

### 1. Agent-ergonomics (weight 3) — strong, met today
`skill/agent-browser/src/cli.ts` groups verbs by phase (lifecycle/perception/interaction/query/
extract/auth/meta), ships a sanitized `--json` failure envelope (`mapThrow`, cli.ts:79-96 —
no raw stack/path/secret ever reaches stdout), and `SKILL.md` uses a **discovery-stub**
pattern: `moxxie skill --full` loads the real contract from the binary itself rather than a
static doc that drifts from the code (SKILL.md:13-18). This is the same ergonomic shape Rust's
`silver` offers (stable ids, `skills/agent-browser` package) — TS is not behind here, it
independently arrived at the same design. Honest gap: `tab`/`frame`/`network`/`pdf` are
explicitly stubbed `notImplemented()` (handlers.ts:283-288) rather than faked — real work
remains to reach the Rust fork's 60+ verb parity, but every stub is honest, not silently wrong.

### 2. Quick-task speed (weight 2) — strong, mitigated architecturally, unbenchmarked numerically
`session.ts` already implements the daemon-equivalent pattern for TS: `openSession` spawns a
**detached** Chromium (`child.unref()`, `stdio:'ignore'`) that survives the CLI process exit;
later invocations `connect()` over CDP instead of relaunching Chrome (session.ts:1-13,
118-184, 242-260). This is architecturally the same cold-start mitigation Rust's daemon
provides — the difference is Rust keeps a persistent in-process socket server, TS reconnects a
short-lived process to a long-lived browser each call. Neither codebase has a stopwatch
benchmark (`ev-language.md` caveats section, confirmed no perf numbers in either tree), so I
make no unverified speed claim. What's structurally different: `tsc` builds instantly and the
full 142-test vitest suite runs in **13.6s wall** (`ev-ts-moxxie.md`), versus Rust's measured
**1m34s incremental release rebuild** (LTO + codegen-units=1 forces a full relink even for a
one-file change, `ev-vercel-rust.md`) — that's a dev-loop speed advantage, not a runtime one,
but it directly compounds into criterion 6.

### 3. Long-running/resumable tasks (weight 3) — real gap, honestly the closest call, still winnable
The evidence digest's own bottom line favors Rust here on raw features today: Rust has
AES-256-GCM-encrypted, autosaved (every 30s) session-state restore (`state.rs`, `actions.rs`)
that TS does not yet have encrypted-at-rest. I will not spin this away. But two things narrow
the gap sharply:
- **The missing "task = re-runnable artifact" half is absent from *both* Rust and TS today.**
  `ev-longtask.md` is explicit: "gap in all three as directly usable code... Silver has
  session/state resume but no task-checkpoint log." Neither base has Webwright's
  `plan.md → numbered run folders → action log → screenshots` convention. This is a filesystem/
  prose convention, not a language-specific mechanism (`ev-longtask.md` bottom line, verbatim:
  "a filesystem convention, not a language-specific mechanism"). Building it once in TS costs
  the same as building it once in Rust.
- **TS's session sidecar model already has the crash-resilience primitives that matter**:
  atomic tmp-file + `rename()` writes (session.ts:70-83, no torn-JSON reads), PID-liveness-gated
  reconnect that fails cleanly instead of hanging on a dead CDP endpoint (session.ts:242-249),
  and a documented close sequence (graceful CDP disconnect → SIGTERM → poll → SIGKILL → `rm -rf`)
  specifically engineered around a named Chromium profile-resurrection bug (session.ts:283-319).
  AES-256-GCM-at-rest is a ~30-line addition on Node's built-in `crypto` module — the same
  primitive Rust's `aes-gcm` crate wraps — not new architecture, just an unbuilt feature.

Net: S2 does not have the encrypted-restore box checked today, but it has the harder
half — crash-safe sidecar persistence and reconnect semantics — already built and tested, and
the actually-missing "task artifact" layer is a wash across all three bases per the evidence.

### 4. Parallel multi-agent / multi-browser orchestration (weight 3) — honest gap, cheap to close
`ev-parallel.md`'s verdict favors Rust today: `--session`/`SILVER_NAMESPACE` is a **documented,
README-first-class** feature with an MCP-level `session` routing argument; TS's identical
isolation shape (N named sessions = N detached OS processes, verified: `handlers.ts` threads
`flags.session` through 40+ call sites) is real but undocumented as a headline feature, and
critically: **grep for `lock|Lock|Mutex` across `src/` returns zero hits** — two commands
issued concurrently against the *same* session name race on `contexts()[0]`/`pages()[0]` with
no serialization (`ev-parallel.md`). I will not understate this.

What closes it: Node has a native, zero-dependency answer to exactly the cross-process
coordination Rust's daemon provides via a Unix socket — `net.createServer({path: ...})` is a
first-class stdlib primitive, not a novel engineering exercise; a thin per-session lock (or a
minimal socket-server daemon mirroring Rust's own shape) is a small, well-trodden Node pattern.
And — per the one source in this evidence base with an explicit architectural opinion on this
exact question — Aside's own design (`ev-parallel.md`, `ev-aside-adapt.md`) says the
*correct* pattern for parallel agents is never to share one browser's live tab/form state
across concurrent agents in the first place ("sharing open CDP targets/tabs across concurrent
agents would create races and undefined ownership over form/session state" — own
context/session per agent, always). Under that lens, TS's existing N-isolated-sessions
primitive is already the *right* shape for criterion (d); what's missing is (a) documenting it
as first-class, and (b) a guard rail (lock or reject) against the misuse case of hammering one
session concurrently — both small, additive changes to a base that already has the hard part
(process isolation, no shared state) done.

### 5. Install-and-use / zero-config (weight 2) — strong, verified live, and S1's story is currently broken
This is where the evidence is least ambiguous. `ev-distribution.md`, tested live in this
sandbox on 2026-07-15:
- **TS is the only one of the three that is *actually* zero-build today**: `dist/cli.js` is
  checked into the tree and runs immediately (`node dist/cli.js --help` returns valid JSON
  instantly, no compile step for a consumer).
- **The npm name `moxxie` is free** — verified live (`npm view moxxie` → 404).
- **Rust's distribution story is presently non-functional**: `agent-browser` — the name
  Silver's own `package.json` declares — is already taken by the real, actively-published
  upstream Vercel package (`npm view agent-browser` → real package, v0.31.2, confirmed live),
  and `scripts/postinstall.js` hardcodes `GITHUB_REPO = 'vercel-labs/agent-browser'`
  (postinstall.js:56) — i.e. Silver's installer, as it stands, would fetch **the wrong
  project's binaries** or fail outright. No prebuilt binaries exist in the repo; a fresh sandbox
  installing Rust today must compile 332 crates from source with `cargo`/`rustc` present.
- Only prerequisite for TS is Node ≥24, one ubiquitous runtime most sandboxes already have.

This is not a close call on the evidence as it stands today — Rust's zero-config story requires
real re-plumbing (own GitHub org, own npm name, fixed postinstall) before it matches what TS
already does.

### 6. Enhanceability / dev velocity (weight 3) — strong, this is S2's biggest structural edge
- **Codebase size**: TS is 5,117 lines across 24 files; Rust is 71,796 lines across 75 files
  (`ev-vercel-rust.md`) — roughly 14x smaller for a comparable security/extract/session feature
  set already proven out.
- **Iteration loop**: `tsc` clean build + 142-test vitest suite in 13.6s, versus Rust's measured
  2m19s clean release build / 1m34s incremental release rebuild (LTO+codegen-units=1 forces a
  full relink even on a one-file touch, `ev-vercel-rust.md`) — debug-profile Rust rebuilds fast
  (5.2s) but that's not the profile that ships.
- **46 of ~64 Rust source files already diverge from upstream** (`ev-vercel-rust.md`, `diff -rq`
  verified) — every future upstream Vercel security fix must be re-diffed and re-merged by hand
  against a fork that's no longer a thin patch set. TS's `skill/agent-browser` has no upstream
  fork-maintenance tax at all; `NOTICE` credits adapted *patterns* (Vercel's snapshot grammar,
  Stagehand's extract design, browser-use's heuristics), not a vendored codebase to rebase.
- **Aside-pattern adaptability, read directly**: `ev-aside-adapt.md` scores most of the 11
  recommended Aside adoptions as equally easy in either language — but the one place language
  matters most (item 9, a persistent multi-statement REPL/code-exec tool) explicitly favors TS:
  Aside itself implements this via `node:vm` (aside-07 pattern 18), the same primitive natively
  available to a Node/TS runtime; Rust "has no equivalent std primitive... embedding a JS engine
  (`rquickjs`/`boa`) purely to offer a persistent scripting surface is a heavyweight dependency
  addition" (`ev-aside-adapt.md`, item 9). Every other Aside item (citation-ID contracts, tool
  registry as pure function, untrusted-output wrapping, memory-as-markdown) is a straightforward
  addition on either base — but TS's `security/` directory (5 files: confirm/egress/injection/
  redact/registry) already houses the exact chokepoints those patterns hang off of, tested, today.
- Honest cons: no git history in `skill/agent-browser` (same-day-authored, so no velocity trend
  to point to — only a point-in-time snapshot); `handlers.ts` at 1,211 lines is a single-file
  verb dispatcher that will need decomposing as the surface grows past today's stubs.

### 7. Keyless fit (weight 1) — fully met, verified
No model call anywhere in `skill/agent-browser/src` (grep-verified across the security/extract/
session modules per `ev-ts-moxxie.md`); `extract/resolve.ts` is explicitly a pure JSON
transform (resolve.ts:18) — no network/model call. All three bases can be keyless in principle,
but note the asymmetry: adapting Webwright (Python) into anything means *deleting* a real
model-calling layer first (`models/anthropic_model.py`, `openrouter_model.py`,
`webwright doctor`'s `OPENAI_API_KEY missing = FAIL` check, verified live in
`ev-distribution.md`) — an integration tax TS and Rust simply don't pay, since neither one ever
had a model call to begin with.

### 8. Leverage of existing assets (weight 2) — this is S2's sleeper argument
The brief frames this as "we have a working Rust fork AND a working TS CLI" — but reading both
trees shows something stronger than parity: **the TS CLI already independently re-derived both
of the Rust fork's headline deltas**, on its own, without porting:
- Rust's `native/extract.rs` (443 lines, "Silver Delta 1", ID-grounded keyless extract) has a
  direct TS counterpart: `extract/resolve.ts`, which goes further — it documents two specific
  hardenings *over Stagehand's own `injectUrls`* (generation-gating against stale refmaps after
  navigation, and a "loud null" instead of Stagehand's silent `?? ""` value-fabrication bug;
  resolve.ts:44-47, 62-70).
- Rust's `native/egress.rs` (311 lines, DNS-SSRF guard) has a direct TS counterpart:
  `security/egress.ts` — denylist-by-default scheme/host guard, raw-IP-literal deny (v4/v6/
  decimal/hex), suffix-not-substring domain matching with the `booking.com.evil.com` footgun
  named explicitly in a comment (egress.ts:14-18), and a documented (not hidden) DNS-rebinding
  TOCTOU window.

So S2 is not "port Rust's deltas into TS" — that work is done, tested, and in some documented
respects (the Stagehand-null fix) more hardened than the Rust original. What S2 actually needs
to port from the Rust asset is *architecture ideas* (documented `--session`/`--namespace`
as first-class, encrypted-state-at-rest, a session-list/gc sweep) — cheaper than porting code,
and the TS codebase's existing test suite (142 cases) is the regression net that makes doing so
safe.

### 9. Ecosystem fit — Playwright/CDP maturity, browser control depth (weight 2) — clear structural edge
Playwright is TS-native: written and maintained by Microsoft with the **Node API as the primary/
reference implementation**; Python's Playwright bindings are "a generated/wrapped port of the
Node implementation, not the primary implementation surface" (`ev-language.md`). Rust has *no*
Playwright dependency at all — `silver`'s Cargo.toml shows a hand-rolled CDP client
(`tokio-tungstenite` raw WebSocket + `cli/cdp-protocol/{browser_protocol.json,js_protocol.json}`
parsed by hand, `ev-language.md`) — meaning Rust owns 100% of the protocol-compatibility burden
itself (every new CDP domain/command tracked manually), while TS inherits Playwright's
auto-wait, selector engine, network interception, and multi-browser (Chromium/Firefox/WebKit)
support for free, maintained upstream by the library's own primary authors.

## Score summary against the fixed weights

| # | Criterion | Weight | S2 today | Gap to close |
|---|---|---|---|---|
| 1 | Agent-ergonomics | 3 | Strong | verb parity (tab/frame/network/pdf) |
| 2 | Quick-task speed | 2 | Strong (structural), unbenchmarked | add stopwatch numbers |
| 3 | Long-running/resumable | 3 | Behind on encrypted-restore; ahead on crash-safe sidecars | add AES-GCM-at-rest, task-artifact convention (shared gap w/ Rust) |
| 4 | Parallel multi-agent | 3 | Isolation primitive exists, undocumented, unlocked | document + add cross-process lock/guard |
| 5 | Install-and-use | 2 | Strong, verified live | none blocking; flip `private:true` |
| 6 | Dev velocity | 3 | Strong | decompose `handlers.ts`, no fork-maintenance tax |
| 7 | Keyless fit | 1 | Fully met | none |
| 8 | Leverage of existing assets | 2 | Strong — deltas already independently re-derived | port architecture ideas, not code |
| 9 | Ecosystem fit | 2 | Strong — Playwright is TS-native | none |

S2 leads outright on 1, 2, 5, 6, 7, 8, 9 (weight-sum 16 of 21) and is honestly behind-but-
closeable on 3 and 4 (weight-sum 5 of 21) — and even there, the evidence shows the gap is
mostly *documentation and a lock primitive*, not missing architecture, since the hard
isolation/crash-safety primitives are already built and tested.

## What I will not spin away

- Rust's session daemon is a real, currently-working, currently-documented answer to (3) and
  (4) that TS must still build a socket/lock layer to match — this is genuine unfinished work,
  not a rhetorical gap.
- TS has zero encrypted-at-rest storage today; Rust has AES-256-GCM shipped.
- TS's `142 tests, eval pass_k 1.000` framing in the task brief is only half-verified: the
  142-test count is real and passing, but no eval harness (`evals/`) exists under
  `skill/agent-browser` to substantiate the pass_k figure — unlike Rust's own `silver/evals`
  (which itself evaluates skill-selection, not task-completion pass@k either).
- `skill/agent-browser` has no git history to show iteration velocity over time — every
  argument about "TS is faster to extend" is a structural/architectural argument (smaller
  codebase, faster build, no fork-tax), not a demonstrated trend.
- `private: true` and `0.1.0` mean TS is not published anywhere yet, despite `npm pack` working
  mechanically.

## Bottom line

S2 wins the majority of the weighted criteria today, without qualification, and on the two
criteria where Rust currently leads (long-running resumability, parallel orchestration), the
evidence shows the lead is a documented daemon/lock layer and an encryption call — both
small, well-understood additions on a runtime (Node) that has the exact stdlib primitives
(`net.createServer` for Unix sockets, `node:crypto` for AES-GCM) needed to close them, on a
codebase that is 14x smaller, builds 9x faster, and carries zero upstream-fork-rebasing tax
compared to the alternative. Critically, the TS base is not a green-field bet: it already
independently re-derived and, in one documented case (Stagehand's silent-null bug), improved on
the Rust fork's own signature security deltas — proof the team can execute at this altitude in
this language today, not a hope that it could.
