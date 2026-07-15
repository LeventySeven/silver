# Advocate brief: S1 — Rust / keep the Vercel fork (`silver/`)

Author's stance: advocate for S1. Every claim below is grounded in files read directly in
this pass or inherited from the `ev-*.md` digests (cited), which were themselves grounded in
`silver/`, `skill/agent-browser/`, `reference/webwright/`, and `research/sources/`. Weaknesses
are stated as plainly as strengths — a case that hides the downsides is worthless.

## The one-line case

S1 is the only strategy where the two hardest, highest-weight requirements — long-running/
resumable tasks (weight 3) and parallel multi-agent orchestration (weight 3) — already have
**working, documented, first-class primitives on disk today**, not a design sketch. The fork
also already carries our own shipped deltas (extract.rs, egress.rs), proving we can extend it
in-language, not just in theory. What S1 needs is not a rewrite, only a fix to distribution and
one deliberate feature: a task/checkpoint-artifact convention layered on top of what's there.

## Criterion-by-criterion

**1. Agent-ergonomics (w=3) — Strong.** `commands.rs` dispatches 96 distinct top-level verb
match-arms today (`grep -c '"[a-z_]*" =>' cli/src/commands.rs` = 96, confirmed live this pass;
`ev-vercel-rust.md` separately counted 60+ by name and `ev-aside-adapt.md` counted 159 total
match arms including aliases/sub-verbs) — the broadest surface of any of the three assets by a
wide margin (moxxie: 5,117 lines / one 1,211-line handler file, `tab`/`frame`/`network`/`pdf`
explicitly `notImplemented()`, per `ev-ts-moxxie.md`). Stable `t1`/`t2` tab ids and `@e1`-style
element refs are load-bearing agent-ergonomic choices, not incidental. `mcp.rs` already exposes
~20 typed MCP tools plus an `extraArgs` escape hatch, so an MCP-speaking host gets full CLI
parity without shelling out. `silver/skill-data/{core,dogfood,slack,electron,vercel-sandbox,
agentcore}` is a working general-SKILL.md package today, and `browser::to_ai_friendly_error` is
called from the action-dispatch path specifically to make CDP failures legible to a model. This
criterion is close to already-won.

**2. Quick-task speed / latency (w=2) — Good at runtime, real dev-loop cost admitted.**
`native/daemon.rs` runs one persistent daemon per session; a CLI call is a thin client over a
Unix socket, so steady-state command latency does not pay Chrome-launch cost — this is the same
architecture moxxie converged on independently (`session.ts`'s detached-Chromium daemon), which
is itself evidence the daemon shape is the right one regardless of language. Where S1 is
genuinely worse: the release profile (`opt-level=3, lto=true, codegen-units=1`) makes a
single-file touch cost ~1m34s to rebuild in release vs 5.2s in debug — measured live in this
project (`ev-vercel-rust.md`). That's a real dev-iteration tax, not a runtime one; end users
never pay it, but we do, every time we ship a change. A `[profile.ci]` (`lto="thin"`,
`codegen-units=16`) exists specifically because the maintainers already hit this and mitigated
it for CI — worth adopting as our default dev profile too.

**3. Long-running/resumable tasks (w=3) — Half already built, half is a filesystem convention
away.** This is the criterion S1 wins hardest on infrastructure and is honest about the gap.
What's already real: `native/actions.rs` runs `auto_save_restore_state()` off the daemon's
background tick (every `SILVER_AUTOSAVE_INTERVAL_MS`, default 30s), gated by a 2s post-command
quiet period so autosave never stalls a live command burst; `native/state.rs` persists cookies +
localStorage + sessionStorage **AES-256-GCM encrypted at rest**; `session id --scope
worktree|cwd|git-root` derives a deterministic session key so a killed-and-restarted agent
reconnects to the exact same daemon/state without coordination. None of the other two assets
has encrypted-at-rest session persistence — Webwright's is a plain JSON sidecar
(`persistent_local_browser.py`), moxxie's is unencrypted JSON sidecars too (`ev-ts-moxxie.md`).
What's honestly missing: there is no re-runnable "task = script, logs = artifact" concept
anywhere in `cli/src` (`grep -rniE "checkpoint|resume"` across `native/*.rs` returns
session/storage-state hits only) — that's Webwright's real contribution, and it's a filesystem
convention (`plan.md` → numbered run folders → `action_log.jsonl` → per-checkpoint screenshots
→ judge-gated `done`), not a language-specific mechanism. Webwright's own `skills/webwright/`
mode already proves this convention works **with zero model calls of its own** when a host LLM
drives it — directly compatible with Silver's keyless mandate. The honest synthesis
(`ev-longtask.md`'s own bottom line, which I independently agree with after reading the same
files): port that convention as a thin Rust module writing into Silver's existing session
directory, letting the host LLM supply the loop. This is additive engineering on a proven base,
not new architecture.

**4. Parallel multi-agent / multi-browser orchestration (w=3) — Best-documented primitive of
the three, with one honest structural gap.** `--session <name>` giving N isolated daemons +
Chrome instances is a literal, named, first-class README feature (`## Sessions — Run multiple
isolated browser instances`, with the exact `--session agent1`/`--session agent2` example) —
not something inferred from code, something the maintainers wrote down as the intended usage.
`SILVER_NAMESPACE` scopes the entire socket directory so separate worktrees/CI jobs/agents never
collide even on session-name reuse; `mcp.rs`'s per-tool-call `session` argument lets one MCP host
route many concurrent tool-call streams to different daemons. `connect <port|url>` lets a daemon
attach to a CDP endpoint someone else already launched — the "share one already-running browser"
half of the requirement. moxxie has the *same* N-isolated-processes shape (detached Chromium per
session name) but it is undocumented as a feature and, critically, has **zero locking
primitive** anywhere in `src/` (`grep -rn "lock|Lock|Mutex"` = 0 hits per `ev-parallel.md`) — two
concurrent commands against the same moxxie session race on `contexts()[0]`/`pages()[0]` with no
serialization at all. Silver's daemon, by contrast, serializes every command against one session
through `Arc<tokio::sync::Mutex<DaemonState>>` (confirmed live this pass, `daemon.rs:189,308,
394`) — correctness-safe by construction, even though that means intra-session commands are
turn-by-turn rather than truly concurrent. That's the honest gap: tab primitives
(`tab_new/switch/close/list`) exist, but every tab op still goes through the same global Mutex,
so "many agents sharing one browser's tabs, executing in parallel" is not built — it's
serialized-but-safe today. Aside's own design (`research/sources/aside-06-memory-subagents.md`,
digested in `ev-parallel.md`) independently argues this is the *correct* choice, not a
limitation to route around: "sharing open CDP targets/tabs across concurrent agents would create
races and undefined ownership over form/session state" — Aside's answer is own-tab-per-subagent,
never shared live state, exactly the boundary Silver's Mutex already enforces by accident of
design. The work still owed is a spawn/wait subagent layer on top — Aside's own two-verb
`subagent(spawn|resume)` + `subagent_wait` shape is directly portable — and `ev-parallel.md`'s
own verdict, independently reached, is that Silver's daemon-per-session model is "the closer
starting substrate for this than agent-browser's sidecar model," because the daemon already has
process-level identity (`walk_daemons`, PID liveness) to hang a concurrency cap and
`parent_session_id` off of.

**5. Install-and-use / zero-config (w=2) — Right architecture, currently broken in practice, and
I will not paper over this.** `ev-distribution.md` tested this live and found real problems: the
npm package name `agent-browser` is taken by the actual upstream Vercel package (verified live,
v0.31.2 published), `scripts/postinstall.js` hardcodes `GITHUB_REPO =
'vercel-labs/agent-browser'`, and `package.json`'s `repository.url` is still upstream's — so
Silver's Rust binary cannot npm-publish today without a rename + owned GitHub Releases. No
prebuilt binaries exist in the repo currently; a fresh sandbox must compile 332 locked crates
from source. This is a real, measured weakness against moxxie, which ships a checked-in
`dist/cli.js` that runs instantly with a free npm name (`moxxie`, verified 404 on npm today).
Where I still argue S1 wins on this criterion despite the current breakage: the *end state* the
architecture is built for — a single native binary, no interpreter, no Node/Python runtime
needed at all — is strictly better than either alternative once the rename/release-pipeline is
fixed, which is bounded, mechanical work (new npm name, own GitHub Releases, fix one hardcoded
constant), not new engineering. `silver doctor` was run live and passes zero-config with no API
key required once built — the keyless story is real, only the packaging pipe is broken. This is
a solvable-this-sprint gap, not a structural one, but scoring it honestly today: partial credit,
not full.

**6. Enhanceability / dev velocity (w=3) — The honest tradeoff of the whole case.** This is
where S1's cost is real and I want to state it plainly rather than minimize it. Async Rust +
hand-rolled CDP protocol handling (`cli/cdp-protocol/{browser_protocol.json,js_protocol.json}`,
no Playwright/chromiumoxide dependency) means Silver owns 100% of protocol-compatibility burden
itself — every new Chrome capability requires touching Rust code and the raw CDP layer by hand,
whereas moxxie and Webwright both inherit Playwright's auto-wait, selector engine, and network
interception for free (`ev-language.md`). 46 of ~64 source files already diverge from unmodified
upstream (`diff -rq` confirmed) — every future Vercel upstream security fix requires manual
re-merge, this fork is not a thin rebaseable patch anymore. Against that: we have already proven
we can ship non-trivial Rust features into this exact codebase — `native/extract.rs` (443 lines,
keyless ID-grounded extract) and `native/egress.rs` (311 lines, DNS-SSRF guard), both confirmed
present only in `silver/` and absent from unmodified upstream via `diff -rq`, both compiling
today (line counts reconfirmed live this pass: 754 total). 838 `#[test]` functions already exist
under `cli/src` (reconfirmed live: 838), a real regression net most greenfield rewrites would
take months to rebuild. The honest framing: velocity-per-feature is lower in Rust than TS
(compiler rigor, test-authoring expectations, CDP hand-maintenance), but velocity-to-ship-the-
next-delta is proven fast because the scaffolding, security deltas, and test culture already
exist and are ours. Rewriting in TS or Python to get faster iteration means re-earning the 96-verb
surface, the daemon, the encrypted state layer, and the 838 tests from a much smaller base
(moxxie: 5,117 lines, `tab`/`frame`/`network`/`pdf` unimplemented) before velocity gains show up.

**7. Keyless fit (w=1) — Fully met, verified.** No model-provider call exists anywhere in
`native/state.rs` or `native/daemon.rs` (grepped); every action is a deterministic CDP call.
Unlike Webwright, whose own `webwright doctor` fails a zero-config run live with `OpenAI Key:
FAIL — OPENAI_API_KEY missing` (`ev-distribution.md`, run live) — Webwright's keyless path exists
only as a stripped-down skill wrapper, not its native binary. Silver has no such asterisk.

**8. Leverage of existing assets (w=2) — This criterion is close to a tautology for S1, and I'll
say so directly: it's the strategy of keeping what's already built. The substantive argument is
that what's already built is disproportionately valuable relative to moxxie's TS asset on the
two heaviest-weighted criteria (long-task and parallel, w=3 each) specifically because Silver's
daemon already has process-level session identity, encrypted persistence, and a documented
multi-session pattern that moxxie's simpler, undocumented, unlocked equivalent does not yet
match. The TS asset's real advantage — 142 green tests, a cleaner layered security stack
(registry/egress/confirm/redact as separate testable modules vs. Rust's more monolithic
actions.rs) — is a strong argument for **porting moxxie's security-module *shape* into Silver's
Rust**, not for discarding Silver's daemon/session/parallel substrate to start over in TS.

**9. Ecosystem fit — Playwright/CDP maturity (w=2) — This is S1's weakest criterion and I will
not spin it. Silver talks CDP directly (`tokio-tungstenite`, hand-parsed `browser_protocol.json`/
`js_protocol.json`); it owns 100% of the auto-wait/selector-engine/network-interception surface
that Playwright gives moxxie and Webwright for free. There is no chromiumoxide or equivalent
Rust-Playwright dependency in `Cargo.toml`. This is a genuine, structural ecosystem-maturity gap
against TS/Python — every edge case Playwright's large user base has already found and fixed
must be independently discovered and fixed here. The mitigating fact: Silver already handles the
CDP domains its 96-verb surface needs today (evidenced by the surface existing and building), so
the gap is about *future* edge-case surface area and maintenance burden, not present-day
functionality. This is the one criterion where I'd tell the deciding party: if ecosystem
maturity and long-term CDP-edge-case maintenance cost dominates your risk tolerance, that is a
legitimate reason to weight against S1 despite its wins elsewhere.

## Weighted-honest summary

S1 wins outright on the three heaviest-weighted criteria that matter most for "the ULTIMATE
keyless browser CLI": agent-ergonomics (3), long-running/resumable (3), and parallel
orchestration (3) — all three have real, documented, already-working code today, not a design
doc. It ties or loses on enhanceability (3) and ecosystem fit (2), where TS's Playwright
inheritance and lower per-feature authoring cost are real and I've stated them without spin. It
currently loses on distribution (2) due to a broken/mis-branded npm pipeline — but that's
bounded, mechanical work (rename, own GitHub Releases, fix one hardcoded string), not a redesign.
The strategic question isn't "which language is nicest to write in" — it's "which base already
has the two hardest, most differentiating capabilities built and proven." That's S1.

## Sources read this pass

`/Users/seventyleven/Desktop/Silver/research/decision/ev-vercel-rust.md`,
`ev-language.md`, `ev-longtask.md`, `ev-parallel.md`, `ev-distribution.md`,
`ev-aside-adapt.md`, `ev-ts-moxxie.md`, `ev-webwright-python.md`; live commands against
`/Users/seventyleven/Desktop/Silver/silver/cli/src/commands.rs` (verb-arm count),
`cli/src/native/{egress.rs,extract.rs}` (line counts), `cli/src/native/daemon.rs` (Mutex
serialization sites), and a repo-wide `#[test]` count — all reconfirmed live rather than
taken on the digests' word alone.
