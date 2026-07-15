# DECISION red-team — attacking the S2 (TypeScript / moxxie) verdict

Adversarial review of `DECISION.md` against the eleven `ev-*`/`adv-*` digests and the
actual code in `silver/`, `skill/agent-browser/`, and `reference/webwright/`. Every
number below was re-verified live this pass unless cited to a digest. No praise-padding.

## Verdict: CONFIRM the language, REJECT the reasoning that got there

TypeScript is a defensible pick, but **the decision is right for almost none of the
reasons it gives**, and it is right on a much thinner margin than "unanimous 5/5,
S2 79 · S1 75" implies. A 4-point spread on a ~100 scale, with S1 leading the two
heaviest-weighted criteria, is a coin-flip dressed as a consensus. The decision wins
its case by (a) inflating Rust's costs into "permanent structural liabilities" that are
mostly fixable or mis-scored, and (b) applying optimism asymmetrically — Rust's one
missing piece is "the same cost in both languages," while moxxie's *many* missing pieces
are each "a small additive change." Strip both distortions and the honest statement is:
**TS wins on exactly one durable axis (Playwright-native ecosystem fit / no
CDP-maintenance-forever), and loses today on the two requirements the product is
actually named for.** That single axis is real and probably enough — but the deciders
should adopt S2 knowing they are betting the product's headline features on projected
future work, not choosing the base that already has them.

---

## 1. The load-bearing distortion: the two HARDEST requirements favor Rust *today*, and the decision overrode its own evidence to flip them

The product's stated differentiators are long-running/resumable (w3) and parallel
multi-agent/multi-browser (w3) — the two heaviest criteria. On both, **silver has
materially more built today**, and this is verifiable, not rhetorical:

**Long-task (c).** silver ships: AES-256-GCM encrypted state-at-rest, 30s autosave
gated by a quiet-period, deterministic `session id --scope worktree|cwd|git-root`
reconnect keys, and a full restore-policy surface — `--restore-save`,
`--restore-check-url`, `--restore-check-text`, `--restore-check-fn` (verified in
`silver/cli/src/flags.rs:246-249,688-706`). moxxie has crash-safe sidecars and PID-gated
reconnect — and **none** of the restore machinery. The decision's claim that "the only
piece Rust has that TS lacks is encryption-at-rest, a ~30-line `node:crypto` addition"
(DECISION.md:69-70) is an understatement of the actual gap: it silently drops the entire
autosave-policy / restore-check / deterministic-scope layer. The one genuinely shared gap
(the task-artifact convention) is missing in both — fair — but that is the *only* part of
(c) that is a wash. Everything else on (c) is a silver lead the decision doesn't count.

**Parallel (d).** silver has: `SILVER_NAMESPACE` socket scoping, `session list`,
a real tab API (`tab_new/tab_switch/tab_close/tab_list` + `_by_id` variants, verified
`browser.rs:960-1413`), per-tool MCP `session` routing, daemon-level command
serialization via `Arc<Mutex<DaemonState>>`, and process-level identity (`walk_daemons`,
PID liveness, `parent_session_id` hooks) to hang a concurrency cap off. moxxie has
**zero** locking primitives (verified: `grep -rniE 'lock|mutex|semaphore|flock' src` →
empty), `tab`/`frame`/`network`/`pdf` are literal `notImplemented()` one-liners (verified
`handlers.ts:284-288`), no namespace scoping, no `session list`.

Crucially, the two evidence digests that studied requirement (d) most closely both
concluded the **opposite** of the decision:

- `ev-parallel.md` bottom line: the ideal subagent layer's "closest base" is
  "**silver's Rust daemon-per-session model** ... since silver already has the
  process/socket isolation, namespace scoping, and MCP session-routing plumbing that
  Aside's pattern assumes." moxxie is named the "cheaper fallback ... but would first
  need real per-session command serialization (currently absent) and a genuine
  multi-context/tab API (currently absent)."
- `ev-aside-adapt.md` item 7: subagent-as-session is "*more* natural on Silver's Rust
  daemon ... since daemon-tracked sessions already have process-level identity ... to
  hang a `parent_session_id`/concurrency-cap/depth-guard off of; agent-browser's
  sidecar-JSON model ... [is] slightly more plumbing since there's no central daemon
  registry to enforce a concurrency cap against."

The decision reverses both verdicts with one move (DECISION.md:77-81): it declares that
sharing a live browser is "the wrong pattern per Aside," redefines the requirement down
to "own-context-per-agent," and then asserts that shape "is exactly moxxie's existing
N-detached-processes primitive." That reframe does enormous work and is partly a
sleight of hand: the *user's stated requirement* explicitly includes "many agents
sharing ONE browser in parallel," and the decision's own architecture (§3) keeps that
branch alive via `connect <endpoint>` + a real tab/context API — **both of which silver
has and moxxie must build.** So even after conceding Aside's point, silver is ahead on
the shared-browser branch, and — because it has namespace/session-list/locking/identity —
ahead on the own-browser branch too. moxxie's "primitive" is N detached processes with no
lock, no listing, no GC, no identity registry. Calling that "exactly" the right primitive
is advocacy.

**Net:** the decision does not show S2 serving the hardest requirements better — it
shows S2 can *reach parity* if a stack of unbuilt work turns out cheap. That may be true,
but it is the same "bounded, finishable" bet the decision dismisses when Rust makes it.

## 2. Asymmetric optimism — the accounting trick that decides the whole thing

The decision's core rhetorical engine (DECISION.md:58-90) is: *Rust's leads are "bounded"
and closeable in TS at equal cost; Rust's liabilities are "permanent."* Applied honestly,
the same lens flips several conclusions:

- Rust's missing task-artifact layer → "a filesystem convention, same cost in both." ✅ Fair.
- moxxie's missing encrypted state → "~30 lines." moxxie's missing lock guard →
  "small `net.createServer` addition." moxxie's missing tab/frame/network/pdf →
  "real work remains but honest." moxxie's missing MCP wrapper, `session list`/`gc`,
  namespace scoping, restore machinery, subagent layer, eval harness → all filed under
  "port architecture ideas, cheaper than porting code."

Tallied, moxxie's "small additive changes" **are the bulk of silver's 71,796 lines**.
mcp.rs alone is 4,137 lines — 80% the size of *all of moxxie's src* — and the migration
plan (§2, §5) says to rebuild it. actions.rs is 11,755 lines of CDP action dispatch that
Playwright partly subsumes but does not eliminate. The honest characterization of the
migration is not "finish the stubbed 20%" (adv-ts.md's framing) — it is **"re-implement
most of silver's differentiating feature set in TypeScript."** That is a legitimate
choice; it is not a cheap one, and the decision's build order (§5, seven phases each
gated by the test suite) quietly concedes this while the prose calls it finishing.

## 3. The "permanent liabilities" list is mostly not permanent (DECISION.md:86-87)

The summary calls these Rust liabilities "permanent": *CDP-maintenance-forever, fork tax,
broken dist, 14× code, slow release loop.* Checking each:

- **CDP-maintenance-forever** — genuinely permanent and structural. This is the *one*
  real, durable argument for TS, and it should carry the entire decision on its own.
  silver hand-rolls CDP over `tokio-tungstenite` against raw `browser_protocol.json`
  (31,261 lines) with no Playwright; TS inherits auto-wait/selectors/interception/
  multi-browser upstream forever. This is real. Keep it.
- **"broken dist"** — **not permanent; flatly contradicted by the decision's own
  migration §5 step 0**, which fixes it (rename one hardcoded `GITHUB_REPO`, pick a free
  npm name, own the GitHub Releases). It is a branding bug, ~an afternoon, not a design
  flaw. Listing it as a permanent structural liability is wrong.
- **"14× code"** — misleading as a *liability*. Much of the 14× is *functionality moxxie
  lacks and must build* (MCP server, tab/frame/network/pdf, output formatting at 3,952
  lines, full restore). ~6,332 of silver's lines are `e2e_tests.rs` (silver's number
  includes tests; moxxie's 5,117 excludes its 3,360 test lines — so the comparison is
  also apples-to-oranges). More code that does more is not automatically a tax.
- **"slow release loop"** — cherry-picked. The cited 1m34s is the *release* profile
  (`lto=true, codegen-units=1`). The dev inner loop is **incremental debug = 5.2s**
  (ev-vercel-rust.md, measured), which is comparable to moxxie's 13.6s tsc+142-test run.
  You do not build release to iterate. adv-rust.md even notes `[profile.ci]` exists to
  kill this. The dev-velocity gap is real but a fraction of the size implied.
- **"fork tax"** — only a tax *if you commit to tracking upstream Vercel forever.* For a
  product whose entire thesis is "the ULTIMATE" divergent tool, you deliberately fork and
  stop rebasing; the 46/64 divergence then costs nothing. The decision treats an optional
  maintenance posture as an unavoidable structural cost.

So of five "permanent liabilities," **one is actually permanent.** The decision's weight
against S1 is built substantially on the other four, which don't hold.

## 4. A distribution asymmetry the decision scores backwards

The decision credits install-and-use to TS by comparing moxxie's *finished-today* story
(checked-in `dist/cli.js`, free npm name) against silver's *broken-today* story (wrong
repo, taken name, must compile 332 crates). But it never credits silver's **end state**,
which the TS end state can never match: a single 9.2MB native binary with **no runtime
dependency at all.** moxxie is permanently `engines.node >=24` (verified `package.json`)
plus a 67MB `node_modules` plus the Playwright Chromium download. For "the ULTIMATE
keyless browser CLI" distributed into arbitrary agent sandboxes, a zero-runtime single
binary is a *durable* distribution edge — the decision compares broken-Rust-today to
working-TS-today and silently discards fixable-Rust-tomorrow being strictly better than
permanent-Node-TS. If you weight install-and-use (w2) higher, it is genuinely ambiguous
which way it cuts, not the clean TS win the decision claims.

## 5. Steelman for the runner-up (S1 / Rust), stated at full strength

If the deciders weight **"which base already has the two named differentiators working in
tested code"** above "which language is cheapest to author in" — a legitimate weighting
for a product sold on long-running + parallel — S1 is the rational pick:

1. It leads outright on the two w3 criteria the product is named for, *today*, in tested
   code (838 `#[test]` functions), not in a build plan.
2. Two independent evidence digests (ev-parallel, ev-aside-adapt) name its daemon the
   *better substrate* for the parallel/subagent layer — the single hardest thing to build.
3. Its distribution *end state* (single binary, zero runtime) is superior to anything TS
   can ship; the current breakage is an afternoon of rename work.
4. Its dev inner loop (5.2s debug) is not the 1m34s the decision implies.
5. The team has already shipped two non-trivial Rust deltas into it (`extract.rs` 443,
   `egress.rs` 311) — the "can we execute in this language" question is already answered
   affirmatively for *both* languages, so it does not favor TS.

S1's one genuinely unfixable weakness is CDP-maintenance-forever (criterion 9). That is
the whole ballgame. Everything else in the case against S1 is overstated.

## 6. Is the winner an artifact of asset-attachment? (the sunk-cost accusation, turned around)

The decision frames S1 as the owner's sunk-cost lean and positions S2 as the neutral
call. But choosing moxxie **discards more working code than choosing silver** — it throws
away silver's MCP server, tab API, encrypted-restore stack, 60+ wired verbs, and daemon
serialization to rebuild them in a 5,117-line asset. That is its own flavor of
asset-attachment: preference for the newer, smaller, cleaner-feeling codebase. Both bases
are pre-existing assets; "consolidate onto moxxie" is not obviously the sunk-cost-free
choice the decision presents. The neutral framing is: *both* picks keep an existing asset
and rewrite the other's deltas; the only non-sunk-cost tiebreaker is the one durable
structural fact — Playwright-native ecosystem economics — which points to TS. Fine. But
say *that*, and only that; don't dress it up with four inflated liabilities.

## 7. Corrections to the build plan (§5)

The plan is directionally right but mis-sequenced and under-scoped:

1. **Re-order for de-risking, not for optics.** Step 0 (rename/publish) unblocks a
   criterion moxxie *already* half-fails too (`private:true`, `0.1.0`, verified). But the
   real risk is whether the two hardest requirements are actually cheap in TS — that is
   the entire premise of the decision. **Prove it first.** Move a thin spike of Phase 2
   (per-session lock via `net.createServer`) and Phase 4 (task-artifact) ahead of verb
   parity, and gate the whole S2 commitment on that spike landing in the time budgeted.
   If the "small additive change" for cross-process locking turns out non-trivial (it is
   the exact thing silver needed a daemon + Mutex for), the decision should be revisited,
   not discovered mid-build.
2. **Right-size the verb-parity phase.** `tab`/`frame`/`network`/`pdf` are not
   "nice-to-haves" (their own code comment, `handlers.ts:283`) — `tab` and `network` are
   core to the parallel and long-task stories. Treat Phase 1 as the largest phase, not a
   warm-up. Budget for decomposing `handlers.ts` (1,211 lines) *before* it absorbs the
   60+ surface, not "as it grows."
3. **Don't discard silver — pin it as the executable spec.** The plan says silver becomes
   "reference material." Stronger: keep silver *building and its e2e suite runnable* as a
   differential oracle, so each TS verb can be checked against the Rust behavior it
   replaces. Otherwise you re-derive 60+ verbs against Playwright with only moxxie's
   142 tests as the net — and moxxie has no eval harness at all (the "pass_k 1.000" claim
   is unverified, adv-ts.md concedes). Port silver's `evals/` harness *early* (currently
   Phase 7, last — that is backwards; the eval net should exist before the rewrite, not
   after).
4. **State the honest cost.** Rename "finish the stubbed 20%" to what §5 actually is:
   re-implementing silver's MCP wrapper, tab/network/frame/pdf primitives, encrypted
   restore, namespace/session management, and subagent layer in TS. Seven test-gated
   phases is not a finish; it is a port. Plan and staff for a port.

## Bottom line

Keep TypeScript — but for the *one* reason that survives scrutiny: Playwright is TS-native
and Rust owns CDP maintenance forever. That single durable fact is enough to justify the
call. Everything else the decision leans on — "wins the hard requirements," "14× code,"
"broken dist is permanent," "1m34s dev loop," "fork tax," "the only missing piece is
encryption" — is either overstated, mis-scored, or contradicted by the decision's own
migration plan and its own parallel/aside evidence digests. The consequence is not that
the verdict flips; it is that the deciders are adopting S2 on a **narrower and riskier
basis than they've been told**: they are betting the product's two headline capabilities,
which exist in tested Rust today, on a TS rewrite whose "cheap additive changes" total
most of the code being discarded. Fund the parallel-lock + task-artifact spike first and
gate on it. If that spike is expensive, S1 is back in play — because on the requirements
this product is named for, S1 is not the sunk-cost option, it is the one that already
works.
