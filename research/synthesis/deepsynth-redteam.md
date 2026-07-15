# Deep-Synthesis Red-Team — engine-plan, adopt-list-v2, skill-design

**Author:** adversarial critic (Compound-V critical-thinking) · **Date:** 2026-07-16
**Method:** read all three synthesis docs + the three `measure-*` deepdives + the Silver source
(`session.ts`, `lock.ts`, `pagechange.ts`, `serialize.ts`, `handlers.ts`, `confirm.ts`, `cli.ts`).
**New evidence:** I re-measured the one number the two latency docs disagree on (see §0). Blunt, no praise-padding.

---

## 0. New measurement — I settled the load-bearing conflict myself

The two latency docs disagree on how much of Silver's ~188 ms fixed tax is the **Playwright module import**:
`vercel-engine`/`engine-plan` say **~150 ms**; `measure-parallel-coldstart §5` says **module load ~35 ms**.
That difference decides whether **P2 (dynamic import) buys 4× or 1.2×** on meta verbs. I measured it directly
on this machine (Node v25.9.0, `dist/` build, medians of 6–9):

| Probe | ms (med, min–max) |
|---|---|
| bare `node -e ''` | **37** (35.6–38.9) |
| `node` + `import('playwright')` only | **186** (177–193) |
| `silver version` (full CLI) | **188** (184–199) |
| in-process `import('playwright')` timer | **142** (140.6–143.9) |

**Verdict: `engine-plan` is right, `measure-parallel-coldstart §5` is wrong.** The Playwright import is **~142 ms**
and it is **~100 % of everything Silver adds over bare Node** — `silver version` (188) ≈ `node+import playwright`
(186). The rest of the CLI bundle costs ~2 ms. So `measure-parallel-coldstart`'s "module load ~35 ms" sub-term
is a mis-decomposition (its *total* 188 ms is fine). **This validates P2 empirically: dropping the static
Playwright import off the meta path takes `version`/`doctor`/`skill`/non-browser verbs from ~188 ms → ~40 ms
(4.7×).** One correction to P2's own copy: it also claims browser commands "shed the import from their critical
path too / cheaper everywhere" — **false.** `snapshot`/`get`/`open`/`click` all need Playwright and still pay the
142 ms; only the **daemon** removes it for them. P2's concrete, real win is meta/non-browser verbs, nothing more.

---

## 1. Bottom line

- **ENGINE.** P1 (skip settle on reads) and P2 (dynamic import) are **confirmed, safe, keyless, and free** — do
  them. They are also the *only* two engine changes the measurements clearly justify. **The daemon (A3/P3) is
  NOT justified by the numbers once you put 188 ms in the denominator of a real agent loop**, and its safety
  story is under-specified in **exactly the areas the code-review just fixed** (two-writer races, the TTY confirm
  gate). Keep it opt-in *and defer it* behind a real end-to-end benchmark + a written concurrency/TTY design.
- **A2 (a11y-tree cache) must be CUT.** It is the flagship internal contradiction: `engine-plan §1` already
  rejects it on evidence; `adopt-list A2` re-adopts it citing the refuted `measure-latency` attribution. The AX
  walk is 5 ms; the cache fixes a cost that does not exist.
- **TOKEN.** T1/T2/T3 verdicts are **sound** (measured, decomposed, cross-checked); minor over-claim on T2.
- **ADOPT-LIST.** ~60 % genuinely move the product. **B0 (repl) is over-ranked** (P0 → P1: keyless but its
  safety is unresolved and in direct tension with the confirmed-non-gap security wins). **D1 (self-healing
  cache) is over-claimed** and fights the ephemeral-ref invariant. **E3(a), E5, E6 are cargo-cult / marginal.**
- **SKILL.** Directionally right (evals-first, ToCs, red-flags, untrusted sentence, task-correctness rules are
  high-value) but **at risk of the over-long anti-pattern**: don't grow core to 480; the 4 `commands/` dispatchers
  and 5 reference files are the bloat; and the decision matrix documents `daemon --session`, a verb that does not
  exist.

---

## 2. ENGINE — confirm/cut with reasons

### P1 — skip `networkidle` settle on read verbs. **CONFIRM. Strengthened.**
Source-verified: `handleSnapshot` (handlers.ts:769) is the *only* read verb that calls `settleAndFingerprint`;
`handleGet` (1012), `handleIs` (1080), `handleRead` (785) already never settle. So P1 is literally a one-handler
change. **Stronger than the plan states:** the control experiment (`snapshot` on `about:blank` = 1465 ms, walk =
5 ms) proves the settle is not merely *expensive* — it is **architecturally dead**. `waitForLoadState('networkidle')`
on a freshly re-attached client that never observed the load provides *zero* settle signal (it either times out
the budget or fires a fixed idle timer against network activity it never saw). Removing it loses nothing real.
The page_changed/stale_refs flag survives because the fingerprint (`url|focusedBackendId|domNodeCount`,
pagechange.ts:77-82) is a ~5 ms point-in-time compute that does not need the race. **Do it first. Biggest win, no
new surface.**

### P1b — lower `NETWORK_IDLE_BUDGET_MS` 1200→400 on mutating verbs. **CONFIRM WITH CAUTION — the risky sibling.**
Unlike P1, this touches verbs where waiting *does* matter (`open`/`click` after which content loads). Shrinking a
budget that is *dead time on reconnect* just shortens the dead time; it does not add a real settle signal. The
combination **P1 (snapshot never settles) + P1b (open settles only 400 ms)** means `open; snapshot` on a slow
SPA can capture a skeleton DOM, and the host only learns via `page_changed` on the *next* command — if there is
one. **The principled fix is C2, not P1b.** C2 (Stagehand-style in-flight-request counter via CDP `Network.enable`)
is a settle signal that *works* on a reconnected client because it counts requests from connect-time forward.
**Recommendation: keep P1 free-standing; do not ship P1b alone — pair it with C2 (promote C2 from P2), or leave
`open`'s budget high (open is rare; snapshot is hot).**

### P2 — dynamic-import Playwright off the meta path. **CONFIRM. Now empirically validated (§0).**
142 ms is real and is ~100 % of Silver's over-Node startup. Meta/non-browser verbs 188 → ~40 ms. Trim the
"cheaper everywhere" claim — browser verbs still pay 142 ms until the daemon exists.

### A2 — a11y-tree cache + dirty-tracking. **CUT. Flagship contradiction.**
`adopt-list A2` calls this "P1, biggest absolute single-command win," citing `measure-latency`'s "~1200 ms is
snapshot/a11y-tree computation." That attribution is **refuted by the about:blank control**: a near-empty tree
still costs 1465 ms, and `snapshotNodes` is measured at **4–9 ms**. If tree-building were 1200 ms, about:blank
would be fast. It is not. **`engine-plan §1` already reaches this conclusion and rejects the cache; the adopt-list
simply failed to propagate the correction.** A cache saves 5 ms and buys invalidation bugs. The residual after P1
is `boot(188) + walk(5) + fingerprint(~8) + render` — the walk is not the bottleneck at any point. Cut it, or
demote to "rejected on evidence" like the engine-plan does.

### A3 / P3 — opt-in persistent daemon. **DO NOT BUILD YET. Steelman for keeping reconnect below.**
The plans frame it responsibly (opt-in, fallback preserved). My objection is to the *justification* and the
*safety story*, not the opt-in framing.

**Steelman for keeping the stateless reconnect model (the plans under-weight this):**
1. **The 188 ms/command win is real in isolation but small in the denominator that matters.** `measure-latency`
   sells it as "20-step loop = 4.9 s overhead vs 0.12 s." That measures *tool overhead in a vacuum*. In a real
   agent loop each step also costs **seconds of host model inference**. Shaving 188 ms of Node boot off a step
   that already costs 2–5 s of thinking is a **<10 % wall-clock improvement**, not the 40× the ratio implies.
   The daemon optimizes the wrong term.
2. **It reintroduces the exact race the review just closed.** `withSessionLock` + atomic + encrypted sidecars
   were built because "concurrent CLI invocations against one `--session` … read-modify-write the same sidecars"
   (lock.ts:6-12). The daemon holds RefMap/state **in RAM** and only writes sidecars on shutdown. But the plan
   *keeps a cold-fallback path* that still uses `withConnection` → `withSessionLock` → file lock. **Nothing
   serializes the daemon's in-RAM state against a concurrent cold-fallback command that grabs the file lock and
   mutates the same browser over CDP** (CDP allows multiple clients). Two writers, two disjoint locks, lost
   updates — the precise bug class the review fixed. The plan's "in-process mutex *replaces* the file lock" is
   only true if the daemon **holds the file lock for its entire lifetime** and the client **refuses to fall back
   while a live daemon pid exists** — neither is specified.
3. **The TTY confirm gate structurally breaks in a detached daemon.** `destructivePaidBlocks` (handlers.ts:286)
   and `confirmGateDecision` (confirm.ts:96-113) branch on `process.stdout.isTTY` *in the process that touches
   the browser*. The daemon is `detached` with `stdio:'ignore'` (session.ts:233-236) — **it has no TTY, ever.**
   So in daemon mode `isTTY` is always false and the interactive-human prompt path (confirm.ts:106) is
   unreachable; every un-pre-approved paid/destructive action fails closed even for an interactive operator. This
   fails *safe*, so it is not a hole — but "re-assert the confirm gate inside the daemon" (engine-plan §4) is
   **under-specified**: the client must evaluate `isTTY` and either prompt client-side or round-trip the prompt.
4. **"Port Vercel's daemon.rs" understates the work.** `withConnection` also attaches the dialog handler
   (handlers.ts:204), re-applies `network route` rules "because they vanish on our per-command reconnect"
   (handlers.ts:206-210), and resolves the active tab. In a *persistent* connection routes do **not** vanish, so
   that logic must be **rewritten, not ported**; dialog/active-tab handling must be re-implemented in the request
   loop. Plus N parallel sessions = N long-lived detached Node daemons (~50–80 MB RSS each) instead of ephemeral
   ones — the 3.5× isolation is preserved but at a standing memory cost.

**Verdict:** the daemon may still be worth building *someday*, but **not on the current evidence**. Gate the build
behind (a) an **end-to-end agent-loop benchmark that includes host think-time** (prove the wall-clock win is
material, not a microbench artifact), and (b) a **written concurrency + TTY-gate design** that reconciles the
daemon-RAM-state vs cold-fallback-file-lock problem (daemon holds the file lock for life; client checks live
daemon pid before falling back). Until both exist, it is a P3 *research* item, not a build item. **Ship P1 + P2 +
token trims and re-measure the real loop before touching the architecture.**

### A4 — batch CDP reuse + short-circuit. **SPLIT: A4a downgrade, A4b keep.**
A4a (hold one CDP connection across a `batch`) saves the **~3 ms reconnect × (N−1)** — the *identical* cost the
plan explicitly rejects as "the standalone CDP-connection cache (~3 ms), rejected on evidence." Batch already runs
in one process (no per-subcommand 188 ms boot). So A4a is inconsistent with the plan's own reject stance:
marginal, not P1. A4b (check the fingerprint delta and stop the batch on stale refs instead of failing
subcommands one-by-one) is a **correctness/UX** win independent of latency — keep it.

### A5 — owned CDP layer (drop Playwright). **KEEP DEFERRED, but its stated rationale is weak.**
The latency case is thin: reconnect is 3 ms and A0/P1 already fixes the settle. The real merit is
**dependency-surface / maintainability**, not speed. Fine as a strategic note; do not let a latency argument
justify a several-hundred-line rewrite.

### Reconnect number (3 ms vs 60 ms). **engine-plan picks correctly.**
`measure-parallel-coldstart`'s microbench (`connectOverCDP` → op → close, median 3.1 ms) beats `measure-latency`'s
back-of-envelope "~60 ms" (which is just the residual after subtracting boot from `get title` — it swallows query
time and variance into "reconnect"). The engine-plan's 3 ms is the defensible figure.

---

## 3. TOKEN — verdicts are sound, one over-claim

`measure-tokens` is the most rigorous of the three deepdives: 3 trials, deterministic ±8 chars, decomposed by
byte source, with a **direct** stripped-format comparison (url+level removed → 0.88–1.01× vs Vercel). The
"keep the format, flip three defaults" conclusion is correct and I confirmed the code:

- **T1 (`url=` opt-in):** serialize.ts:255 pushes `url=` unconditionally with no flag and no `RenderOptions`
  field — the change is real, 35–54 % on link-dense pages, low-risk. **CONFIRM.** *Caveat to document:* extract
  uses element-IDs (not inline URLs) and clicks use refs, so most tasks are unaffected — but a task that must
  *read/report* an href now needs `--urls`, and a host that doesn't know to pass it will silently underperform or
  double-snapshot. The SKILL must document `--urls`. (Vercel ships URLs-off by default, so this is field-proven.)
- **T2 (drop `level=` when 0):** serialize.ts:248 emits `level=${renderIndent}` unconditionally. **CONFIRM, but
  the ~10 % is slightly optimistic:** `renderIndent` is *not* always 0 in filtered mode — nested interactive
  elements (a `button` inside a ref-eligible toolbar) render at level 1+. The measured 10 % counted the tag as if
  always 0; dropping only the zero-valued ones saves marginally less. Ship the safe form ("drop when
  renderIndent==0"), not "drop entirely," to preserve the rare real nesting signal.
- **T3 (trim preamble, keep `⟦untrusted⟧`):** correct — `generation=` still travels in the RefMap sidecar
  (serialize.ts:73,94), only the visible echo is dropped; the security fence is preserved. **CONFIRM.**

**Sample soundness:** 4 pages (tiny / link-dense / large / moderate), one machine, one campaign; the Vercel
Wikipedia `-i -u` point is **estimated** (throttling), and Vercel cold-starts were "absorbed with retry" (so
Vercel's *cold* numbers may be optimistic). But the load-bearing claims — strip-to-parity, T1/T2/T3 magnitudes —
are **measured directly, not estimated**, and cross-checked against the byte decomposition. **Verdict: sound.**

---

## 4. ADOPT-LIST — item-by-item

| Item | Verdict | Reason |
|---|---|---|
| A0 skip-settle | **CONFIRM** | = P1. Free, biggest win, safe, keyless. |
| A1 token defaults | **CONFIRM** | = T1/T2/T3. Sound. |
| A2 tree cache | **CUT** | Refuted by about:blank control; walk is 5 ms; engine-plan already rejects it. |
| A3 daemon | **DEFER** | Not justified in real-loop denominator; safety under-specified (see §2). Opt-in framing OK; build-gate it. |
| A4a batch conn-reuse | **DOWNGRADE** | Saves 3 ms×N — the cost the plan rejects elsewhere. |
| A4b batch short-circuit | **CONFIRM** | Correctness win, latency-independent. |
| A5 owned CDP | **KEEP (deferred)** | Maintainability, not latency. |
| B0 `repl` / CodeAct | **DOWNGRADE P0→P1** | Genuinely valuable + keyless, but **safety unresolved** (below). |
| B1 coordinate verbs | **CONFIRM** | Real un-actable class (canvas/shadow-DOM/no-AX-node). Keyless, gated. Two lenses. |
| C1 format hints | **CONFIRM** | Small, keyless, prevents wrong-locale submits. |
| C2 network-quiet gate | **CONFIRM + PROMOTE** | The *principled* mutating-verb settle; pair with/replace P1b. |
| C3 depth ladder | **KEEP (low)** | Cheap insurance, but speculative (no evidence of the failure on real pages). |
| D1 self-healing cache | **DOWNGRADE** | Over-claimed; fights ephemeral-ref invariant; low keyless hit-rate (below). |
| E1 secret write-path | **CONFIRM** | Real read/write asymmetry; clean symmetric fix at redactValue choke point. Keyless. |
| E2 confirm preview + amount regex | **CONFIRM** | Keyless, real human-in-loop UX; data already in snapshot layer. |
| E3(a) keyword injection pass | **CUT / deprioritize** | Security theater (below). |
| E3(b) classify-before-act doc | **CONFIRM** | Free, real, formalizes the implicit convention. |
| E4 download/permission | **CONFIRM (narrow)** | Real zero-coverage gap; keep per-permission opt-in, not blanket auto-grant. |
| E5 pre-flight hit-test | **CUT (lean)** | Redundant with Playwright actionability — the adopt-list itself concedes this. |
| E6 static stealth | **MARGINAL** | Low durable value (fingerprinting arms race), ToS smell, can break sites. P2-or-cut. |
| F1 `task compile` | **CONFIRM (strong)** | Delivers the stated-but-unbuilt "script IS the artifact" intent; keyless; real DX moat. |
| F2 doctor UX + launch probe | **CONFIRM** | `existsSync` misses broken sandbox (#1 CI failure). Cheap, keyless. |
| G1–G4 skill packaging | **CONFIRM** | ToC, evals-first, relative links, web-task Hard Rules — all high-ROI. |
| G5 skill catalog | **CONFIRM (contingent)** | Only once core actually overflows ~450–500 lines. Not before. |
| G6 tonal craft | **CONFIRM (P2)** | Prose; real compliance lever. |
| H1 `--engine firefox` | **CONFIRM (strong)** | Concrete task-failure class (TLS/H2 fingerprint, Akamai/cars.com), zero mitigation, no new dep. |
| I1–I5 ergonomics | **CONFIRM (minor)** | All keyless, low-effort, correctly low-priority. |

**Excluded-items list (Rust rewrite, CDP cache, decorator registry, two-call extract, BrowseSafe classifier, Web
Bot Auth, captcha, network stealth, in-CLI scheduler): all correctly excluded.** Good discipline.

### B0 `repl` — the strongest counter-case
Keyless is not the question (host authors the JS, Silver runs no model — true). **Safety is.** Silver's entire
security posture — the confirmed *non-gaps* the doc celebrates — is built on **discrete, individually gated verbs**
(registry gate, confirm gate at handlers.ts:286, egress guard, redaction, untrusted fence). A persistent-scope
`repl(code)` surface's safety hinges on an **unspecified execution-context decision** the plan never makes:
- If the host's JS runs **in the page context** (real "Playwright-dialect JS"), it can `fetch()` anywhere, read
  the DOM raw, and click paid buttons in a loop — **bypassing egress, redaction, and the confirm gate entirely.**
  This is *more* attack surface than browser-use's decorator registry, which the same doc rejects for
  "reopen[ing] the quarantine attack surface."
- If the JS runs **in a Node sandbox calling only Silver's gated globals** (`snapshot()`, a gated `click()`), it
  is safe — but then it is a batching layer, not "Playwright-dialect JS," and the persistent scope's power is
  much narrower than the pitch implies.

The plan lists `eval` as already gated behind a per-call confirm (MUTATING_VERBS includes `eval`, confirm.ts:41)
*precisely because arbitrary code is dangerous* — then proposes a persistent, un-gated, globals-rich superset as
**P0**. **Resolve the execution-context + gate-preservation design before promoting it.** P1 at most until then.

### D1 self-healing cache — over-claimed and anti-invariant
"Largest *relative* latency win" overstates it. Silver is keyless: it does **not** perform the host round-trip, so
it cannot "skip the whole host round-trip." What it *can* cache is ref→element resolution — but refs are
**ephemeral and generation-scoped by design**, and the confirmed-non-gaps section celebrates exactly that ("a
stale ref fails loud and never misclicks"). A cache that "silently rewrites the entry on drift" is philosophically
opposed to the loud-failure invariant. And the keyless key is `sha256(instruction, url, ref)` — an **exact** match
on a natural-language instruction, which for a stepping agent (page changes every step) has a **low real hit
rate**; making the match fuzzy would require a model (crosses the keyless line). **The better repeatability
investment is F1 (`task compile`), which produces a deterministic re-runnable artifact without fighting the ref
model.** Downgrade D1.

### E3(a) keyword injection pass — cargo-cult
A cross-language keyword blocklist for "ignore previous instructions" is classic security theater: trivially
bypassed (rephrase, homoglyph, base64, split across nodes) and **false-positives on legitimate content** (a
security article, a page *about* prompt injection). The adopt-list itself admits it "will never match BrowseSafe's
F1." The real defense already ships (the `⟦untrusted⟧` fence, a confirmed non-gap) plus host-side classification.
Adding a blocklist buys the *illusion* of protection and a false-positive tax. **Cut E3(a); keep E3(b)** (the doc
convention is free and real).

---

## 5. SKILL — right direction, real bloat risk

**High-value, confirm:** evals-first (G2 — the correctly-identified "build first" step, no eval harness exists),
ToCs on the two >100-line files (G1), the red-flags self-recognition table (§9.1), the explicit untrusted-content
sentence (§9.3), the ordering-constraint gate (§9.2), the sub-agent skill-inheritance warning (§9.4 — a real
silent failure today), and the web-task-correctness Hard Rules (G4). These address genuine gaps and are mostly
free prose.

**Bloat / over-promise — the anti-pattern watch (an over-long skill is itself an anti-pattern):**
1. **Core SKILL grown 378 → ≤480 lines.** Anthropic's own ceiling is ~500; the plan pushes core to within 20
   lines of it *and then* adds 5 reference files. The high-value additions (red-flags, ordering, untrusted) should
   **replace lower-value prose, not stack on top** — hold core **≤400**. Growing toward the ceiling to make room
   for structure is the exact bloat the doctrine warns against.
2. **The 4 `commands/*.md` dispatchers are the most skippable content.** Each is a ~25-line "run `silver skill
   --full`, then do $ARGUMENTS" stub. webwright has them, but Silver's five modes don't each earn a slash command
   — `quick`/`task`/`extract` plausibly do; **`parallel` is marginal** (it's "pick own-session or tabs or
   subagents," which is a decision-matrix row, not a command). Ship at most 3, or defer all four until there's
   evidence a host wants them.
3. **5 reference files is the high end.** Apply G5's own rule to the split itself: split a topic out **when core
   actually overflows**, not preemptively. Start with `security.md` + `taxonomy.md` (the two densest); leave
   extract/tasks/agents-memory inline until core crosses ~450.

**Is every documented verb real? Mostly — one exception.** I spot-checked the dispatch table (handle(),
handlers.ts:330+): `open/snapshot/read/act/get/is/history/eval/tab/network route/set viewport/...` all resolve to
real handlers. **But the decision matrix (skill-design line 276) lists `daemon --session` as a key verb for
"skip re-auth next time."** The daemon does not exist (it is A3/P3, unbuilt — and per §2 should stay unbuilt for
now). **Documenting `--daemon` as a shipping verb is over-promising** — cut that matrix cell (session reuse is
already covered by `state save`/`load` and `cookies set`, which are real). Also flagged: `silver skill <ref>` /
`--list` serving (§2 of skill-design) is correctly marked a build item, not documented as existing — good.

**Ship order (evals → ToCs → high-value prose → structure) is correct.** The fix is discipline on the structural
tail: resist the 480-line core, the 4th command file, and the pre-emptive 5-way split.

---

## 6. Corrected priority

**Do now (free/cheap, safe, measured):**
1. **P1** skip settle on `snapshot` (one handler) — 1469 → ~230 ms.
2. **P2** dynamic-import Playwright off meta path — meta verbs 188 → ~40 ms (validated §0).
3. **T1 + T2 + T3** token defaults — parity-or-better vs Vercel `-i`.
4. **G1 ToCs + G2 evals harness** — evals first, then the prose.
5. **E1** secret write-path indirection.

**Soon (real product moves, bounded, keyless):**
6. **C2** in-flight-request settle for mutating verbs (**replaces/absorbs P1b** — do this instead of blindly
   lowering the dead budget).
7. **H1** `--engine firefox`; **F1** `task compile`; **G3/G4** relative links + web-task Hard Rules;
   **C1** format hints; **E2** confirm preview; **B1** coordinate verbs; **E4** narrow download/permission;
   **F2** doctor probe; the §9 SKILL prose (red-flags, untrusted, ordering, sub-agent inheritance).

**Needs a design/gate before build:**
8. **B0 `repl`** — write the execution-context + gate-preservation design first; then P1, not P0.
9. **A3 daemon** — build only after (a) an end-to-end agent-loop benchmark including host think-time proves the
   win is material, and (b) a written concurrency + TTY-gate design closes the two-writer and detached-TTY gaps.

**Cut / deprioritize:**
- **A2** tree cache (cost doesn't exist). **A4a** batch conn-reuse (3 ms). **E3(a)** keyword injection pass
  (theater). **E5** hit-test (redundant). **E6** stealth (low durable value / ToS). **D1** self-healing cache
  (over-claimed, anti-invariant — prefer F1).
- **P1b** as a standalone (fold into C2). The 4th `commands/` file (`parallel`) and the pre-emptive 5-way
  reference split. The `daemon --session` matrix cell (unbuilt verb).

---

## 7. Two corrections the synthesis docs must reconcile internally

1. **A2 vs engine-plan §1.** The adopt-list re-adopts the a11y-tree cache that the engine-plan rejects, citing the
   same `measure-latency` attribution the engine-plan refutes. One of the two must change; the engine-plan is
   right. **Cut A2.**
2. **The 35 ms vs 142 ms Playwright-import figure.** `measure-parallel-coldstart §5` says 35 ms; my direct
   measurement says **142 ms** (§0). This does not change any conclusion (the *total* fixed tax is ~188 ms either
   way), but it means P2's headline is the optimistic 4.7×, not a 1.2× — and the mis-decomposed sub-term should be
   corrected in the record so a future reader doesn't re-derive the wrong daemon math from it.
