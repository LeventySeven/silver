# Aside — TOP 5 DX/capability wins vs every competitor, and Silver's gap status

Lens: top5dx (long-horizon reliability, security, REPL/action-surface, memory). Sources read in full:
`researchfms/teardowns/_aside_parts/{10_overview,25_daemon_brain,60_native_security,85_memory_moss,
89_guardrails_captcha,91_snapshot_builder,93_benchmark_analysis,94_competitor_context,95_why_sota,
97_subagents_context,100_agent_errors_modes}.md`, `Silver/research/sources/aside-{01,05,06}-*.md`,
seed `Silver/research/topfive/top5-aside.md`. Verified directly against Silver source
(`/Users/seventyleven/Desktop/Silver/silver/src`): `actuation/actions.ts`, `actuation/resolve.ts`,
`security/registry.ts`, `security/confirm.ts`, `security/redact.ts`, `perception/walk.ts`,
`memory/store.ts`, `orchestration/subagent.ts`.

---

## 1. Single `repl` code-execution action surface (not N discrete tools)

**Mechanism (Aside, `10_overview.md:60`, `95_why_sota.md:27`, `93_benchmark_analysis.md`):** the
agent's entire tool surface is one `repl(title, code)` call running Playwright-flavored TypeScript in
a persistent, process-scoped REPL. Helper globals: `page`, `tabs[]`, `openTab()`, `snapshot(page,opts)`,
`webfetch(url,format,timeout)`, `websearch({objective,queries,mode})`, `fs`, `sleep`, `display`. No
imports, 120s timeout, scope persists across calls — a fill→click→press-Enter→re-snapshot sequence is
one round-trip with real control flow (loops/conditionals/try-catch), not four atomic tool calls. The
300-trajectory corpus shows this converges independently with Browser Use's own benchmark-winning
"Python-writing agent" design (94_competitor_context.md:46-67) — both rivals abandoned click/type
schemas for code-execution. Median 12.9 repl calls/task vs 34.0 messages/task (2.6x overcounting if you
naively count "turns").

**Why it beats every competitor:** CodeAct batching cuts round-trip count and lets an LLM apply
patterns it is heavily pretrained on (real Playwright syntax) instead of learning a bespoke JSON
tool schema in-context — Aside explicitly avoids Playwright-MCP's 13K-token API re-teach cost by just
asserting "Playwright is available." An indexed-element schema (Browser Use's shipped `click(index=34)`)
is explicitly named as the weaker intermediate rung between pixel-coordinate agents and full
code-execution (94_competitor_context.md:101-111).

**Silver status — CONFIRMED CORE GAP.** Read `security/registry.ts:24-122` directly: Silver ships
~40 discrete verbs (`click`, `fill`, `type`, `scroll`, `select`, `hover`, `press`, …) split into
`READ_ONLY_VERBS`/`ACTOR_VERBS`, each a separate CLI process invocation with its own CDP reconnect. An
`eval` verb exists (`registry.ts:104`) that calls `page.evaluate`, but it is: (a) a single JS
expression per invocation, not a persistent multi-statement scope carrying `tabs[]`/`page` state across
calls; (b) not wired to `snapshot()`/`openTab()`/`webfetch()`/`websearch()` as in-scope helper globals
the model can compose inside one script — those remain separate verbs; (c) gated behind
`--enable-actions` and a per-call confirm prompt (`security/confirm.ts`) because it's classified as
arbitrary-code-execution — the opposite of Aside's stance, where `repl` is the PRIMARY low-friction
surface, not a rare escape hatch. This is the single largest architectural divergence from Aside and
compounds with the per-command CDP-reconnect cost already flagged in the project brief: N verb
invocations means N reconnects, where a `repl` design would need one.

**Recommendation — ADOPT, priority P0 (keyless, no model call needed to build it):** Add a `silver
repl` verb (or a host-side wrapper mode) that opens one CDP connection, keeps one JS execution context
alive across a sequence of statements passed in, and exposes `snapshot()`, `openTab()`, `tabs[]`, and
Silver's existing extract/webfetch-equivalent as callable globals inside that context. This is the
highest-leverage single change available — it collapses N stateless invocations (and N reconnects)
into 1, and it is orthogonal to the model-choice question the whole "why-SOTA" thesis is built on: the
representation and the action surface are what matter, and Silver already nailed the representation
(item 3 below) but not the action surface.

---

## 2. Diff-based, downsampled a11y-tree perception with escalation ladder

**Mechanism (Aside):** `snapshot(page,{interactive:true})` filters to interactive ∪ scrollable ∪
landmark ∪ canvas nodes, collapses non-semantic wrapper divs, never silently truncates (a re-scope
error instead of `.slice()`), and returns a `.diff` (git-style `@@` unified diff vs prior snapshot)
alongside `.tree`; the dominant idiom across 831/300-trajectories-worth of usage is
`console.log(s.diff || s.tree)`. A four-way escalation ladder (`interactive:true` → `selector`-scoped
→ `ref`-rooted → `interactive:false` full tree → screenshot) keeps median observation cost ~1,699
tokens/task despite ~13 snapshots/task. D2Snap (arXiv 2508.04412) backs the representation choice
empirically: downsampled hierarchy-preserving tree 73% success > screenshot 65% > raw DOM 38%.

**Why it beats competitors:** this is the actual load-bearing mechanism behind Aside's harness-not-model
SOTA claim — the GPT-5.5-vs-Kimi-k2.6 model-swap holds observation/action-surface constant and the
93%-vs-88% gap concentrates entirely in reasoning categories, not perception-dependent navigation
(~59/60 both models). Competitors using raw DOM or screenshots pay for the representation gap directly.

**Silver status — ALREADY HAS THIS, closely, independently arrived at.** Confirmed by direct read:
`perception/walk.ts` (interactive-role filter, depth cap, `walk.ts:307-324` password/redaction-aware
node capture), `perception/accessible-name.ts` (dedicated W3C accname module, not `innerText`),
`perception/refmap.ts` (ref minting), `perception/diff.ts` (hand-rolled Myers O(ND) diff, `output =
diff.length < tree.length ? diff : tree` — byte-identical strategy to Aside's `diff: c.length >
s.length ? s : c`), `security/injection.ts:13-16` (explicit "never-truncate contract" distinct from
opt-in `capOutput()`, i.e. Silver already encodes Aside's anti-pattern-6 lesson as a design decision).
No action needed here — this is parity, not a gap.

---

## 3. Two independent guardrail layers with different bypass surfaces: navigation denylist beneath the tool layer + a mechanically-enforced confirm gate above it

**Mechanism (Aside, `89_guardrails_captcha.md` §3, §5.1):** Two gates that are deliberately
non-redundant in *where* they sit. (a) `ActorSafetyLists.navigation_blocked` — a 512-entry denylist
(Google credential pages + ~508 regulated-goods merchants) enforced at the actual browser
navigation/network-throttle layer, below any specific driving API. The teardown proves the CDP-driving
agent bypasses the *separate* native-Actor allowlist (`site_policy.MayActOnUrl`) because it never
routes through that tool-invocation path — but the navigation-layer denylist still holds because it
isn't tied to a specific calling convention. The explicit lesson: an allowlist wired to one tool
wrapper is a speed bump, not a boundary; a denylist at the lowest primitive is not bypassable by
switching driving mechanism. (b) `final_confirm` — a verbatim system-prompt block requiring the model
to call `request_action_confirmation` as the SOLE tool call in its turn before any externally-visible/
destructive/paid/hard-to-reverse action, and that call must carry a structured review artifact
(gmail-draft, x-tweet-draft, screenshot-fallback) matching the destination — the human sees exactly
what will be sent, not a yes/no. Mechanically enforced at the tool-dispatch layer too (reject a turn
that calls both `request_action_confirmation` and another tool). Fed by a dedicated amount-extraction
guardrail (regex label-match over 24 checkout-total label variants + AI fallback) so the confirm
artifact shows a concrete dollar figure, not "I want to buy something."

**Why it beats competitors:** most agent-browser security models rely on a single choke point (usually
a tool-invocation allowlist). Aside's own teardown demonstrates that choke point is bypassable by its
own CDP driving path — and the fact that Aside still ships a second, structurally-different-layer
denylist is what actually holds the line. This "assume any one gate is partially bypassable, get the
guarantee from the intersection" design is the most transferable security insight in the corpus.

**Silver status — SPLIT.**
- Confirm gate: **HAS an analog, narrower.** `security/confirm.ts` (`confirmGateDecision`) is a
  boolean fail-closed gate (deny on non-TTY unless `--confirm-actions` pre-approved), with a separate
  `isDestructivePaidName(name)` check (`confirm.ts:59`) that name-matches destructive/paid verbs.
  **GAP:** no structured draft-artifact preview (no "here is the gmail-draft/x-tweet-draft you're about
  to submit" step) — it's yes/no, not "see exactly what will be sent." No amount-extraction guardrail
  equivalent exists in Silver at all (nothing in `security/` scans checkout-total labels).
- Two-layer navigation gate: **NOT CONFIRMED PRESENT.** Silver has no evidence of a navigation-layer
  denylist (regulated-merchant/credential-page block list) independent of the verb-permission system —
  its gating is all at the verb-dispatch layer (`security/registry.ts` READ_ONLY_VERBS/ACTOR_VERBS),
  which is structurally the single-choke-point design Aside's own teardown shows is the *weaker* half
  of its two-layer approach. This is architecturally sound for Silver's threat model (Silver has no
  "alternate driving path" the way CDP-vs-native-Actor creates one — there's only one CDP path in) but
  worth naming explicitly: Silver currently has ONE layer where Aside has two independently-failing
  ones.

**Recommendation — ADOPT, priority P1 (keyless):**
1. Add a structured preview step to `--confirm-actions` mode for verbs already flagged by
   `isDestructivePaidName` — at minimum, echo the target selector's accessible name + any form-field
   values about to be submitted, not just a bare y/n prompt. Cheap, no model call needed since the data
   already exists in the snapshot/resolve layer.
2. Optionally, port the amount-extraction regex list (label-match + decimal-currency pattern, `89_
   guardrails_captcha.md` §2.1) as a small local library feeding the confirm-gate preview for
   checkout-shaped verbs — pure regex, keyless, directly portable.
3. Consider a navigation-layer denylist (credential-management domains + an opt-in regulated-merchant
   list) enforced in `actuation/` below the verb-dispatch layer, so it survives even if a future Silver
   feature adds an alternate action path (e.g. the `repl` surface from item 1) that could otherwise
   route around verb-level gating the same way Aside's CDP path routes around its native-Actor
   allowlist.

---

## 4. Actionability pre-flight gates (`checkHitTarget`, credited with 99% Mind2Web pass rate)

**Mechanism (Aside, `100_agent_errors_modes.md` §2e, `95_why_sota.md:43`):** before every click/fill,
the runtime runs `scrollIntoViewIfNeeded()` → `waitForReady()` (attached + visible + stable + receives
pointer events) → `checkHitTarget(point)` — a hit-test verifying the element actually under the click
coordinate is the intended element, not an overlay/cookie-banner/modal sitting on top of it → `retarget
('follow-label')` for label→control resolution, with `[0,100,200]`ms retry backoff, and for
checkboxes/radios a DOM-activation fallback that verifies the *resulting state* actually flipped rather
than assuming the click succeeded. This absorbs most transient DOM flakiness below the model entirely
— the source credits it with the 99% Mind2Web pass rate — and `checkHitTarget` specifically is called
out as security-relevant, not just reliability: it prevents clickjacking-style misclicks where an
agent's intended click lands on an attacker-placed overlay instead.

**Why it beats competitors:** this is a genuinely different failure class than "the selector is wrong"
— it catches "the selector is right but something else is now covering it," which a naive
locator-then-click loop cannot detect until the wrong thing happens.

**Silver status — CONFIRMED GAP (verified directly, not inferred).** Read `actuation/actions.ts` in
full (373 lines): line 303 calls `locator.scrollIntoViewIfNeeded({timeout})` — the scroll-into-view
half exists. But there is no pre-flight hit-test: the only related logic is reactive, at
`actuation/actions.ts:351` — `if (/intercepts pointer events|subtree intercepts/i.test(msg)) return
'element_obscured'` — which classifies Playwright's own post-hoc error message *after* a click already
failed, rather than checking before the click fires whether the actual point under the coordinates
matches the intended element. This means Silver currently relies entirely on Playwright's built-in
actionability checks (which do exist inside Playwright itself and are reasonably good) but has no
Aside-style explicit `elementsFromPoint`-based pre-flight verification layered on top, and no state-
verification fallback for checkbox/radio toggles (verify the DOM state actually changed post-click).

**Recommendation — ADOPT, priority P2 (keyless, moderate effort):** Add an explicit pre-click hit-test
in `actuation/actions.ts` — after `scrollIntoViewIfNeeded`, resolve the element's bounding box center,
call `page.evaluate` with `document.elementsFromPoint(x,y)` (or `elementFromPoint`) and verify the
resolved element (or a descendant/ancestor of it) is in that list before dispatching the click; on
mismatch, surface a typed `'element_obscured'` result proactively instead of only after Playwright
throws. Also worth adding: for checkbox/radio `click`, read `checked` state before and after and flag a
result mismatch rather than trusting the click return value.

---

## 5. 3-tier memory (episodic → semantic → L1) with an explicit filing decision tree, plus per-credential agent-access policy

**Mechanism (Aside, `85_memory_moss.md` §10, `60_native_security.md` §6.3):** (a) `episodic/YYYY-MM-
DD.md` = raw dated observations; durable `people/`, `sites/`, `projects/`, `concepts/`, `agent/<slug>.md`
semantic pages (frontmatter + `## Current` + `## History`, each History line citing its backing
episodic source file); `MEMORY.md`/`USER.md` L1 files injected directly into the system prompt every
session, kept deliberately tiny. A verbatim filing decision tree governs promotion: "durable beyond
this session? → names a human? → people/ … website the user uses? → sites/<host>.md … reusable
concept? → concepts/ … agent default behavior? → agent/<slug>.md." This separates "what happened"
(cheap, disposable) from "what we now believe" (curated, retrieval-targeted) from "what to always
assume" (unconditionally loaded, must stay tiny) — an agent can skip search entirely for stable
defaults while still supporting deep recall for specifics. (b) `agentAccessPolicy ∈ {"always",
"while-unlocked","never"}` per stored credential, enforced by the vault worker before releasing any
secret to the agent — independent of whether the vault itself is human-unlocked.

**Why it beats competitors:** most agent memory systems are flat (one growing log) or fully
vectorized (opaque, unauditable). The 3-tier split with an explicit, cheap-to-run filing rule gives
predictable retrieval cost (L1 always loaded, semantic pages searched, episodic grep-only) without
needing an LLM call to decide "where does this fact go" at write time for most entries.

**Silver status — SPLIT, one real gap, one deliberate and well-justified non-gap.**
- Markdown-as-truth / no vector layer: **NOT a gap — a deliberate, correctly-justified divergence.**
  `memory/store.ts:1-9` states outright: "Grep-first markdown memory store (Aside's design, keyless)...
  There is NO embedding / vector index — that would need a model or a native dep; Silver stays keyless
  + zero-dep." This is consistent with Silver's no-model constraint and is in fact the fallback mode
  Aside's own material recommends for a tool that must survive vector-store unavailability.
- 3-tier promotion (episodic → semantic → L1): **CONFIRMED GAP.** Read `memory/store.ts` in full:
  Silver only implements the episodic tier — `addNote()` appends timestamped/tagged blocks to
  `~/.silver/<ns>/memory/episodic/<date>.md`. There is no `people/`/`sites/`/`concepts/` semantic-page
  directory convention, no `MEMORY.md`/`USER.md` L1 briefing files, and no filing/promotion logic at
  all. This is architecturally reasonable for Silver's stateless-per-invocation model (no persistent
  daemon to run a "dreaming" consolidation pass), but the *filing decision tree itself* (pattern 8 in
  aside-06, `85_memory_moss.md` §10) is a cheap, keyless, prompt-fragment-sized win that doesn't require
  a background daemon: it could ship as a `memory/search.ts` or `memory/index.ts` convention that
  recognizes/creates a small set of typed subdirectories on write, with the *host LLM* (not Silver
  itself) doing the promotion judgment call — matching Silver's keyless design (the model is the brain,
  Silver just needs the directory shape and a `memory note --type sites --slug app.brex.com` verb
  surface).
- Per-credential agent-access policy: **NOT APPLICABLE / no gap** — Silver has no credential vault
  component at all (out of scope for a keyless browser CLI); this Aside pattern requires a stored-secret
  subsystem Silver doesn't and shouldn't build.

**Recommendation — ADOPT (partial), priority P2 (keyless, low effort):** Extend `memory/store.ts`
with a typed-directory convention (`memory/{people,sites,projects,concepts}/<slug>.md` alongside the
existing `episodic/`) and a `memory note --type <kind> --slug <name>` verb variant that writes/updates a
semantic page instead of (or in addition to) appending to the episodic log — no daemon, no background
"dreaming" pass required; promotion decisions stay a host-LLM judgment call, Silver just needs to expose
the write target. Skip the L1-files-in-system-prompt mechanic entirely (that's a host-harness
responsibility, not Silver's) and skip the gated 24h/5-session consolidation pass (Aside's own
material flags this as overkill for anything but a persistent daemon — directly matches Silver's
one-shot-CLI shape, per aside-06 anti-pattern 1).

---

## Priority summary

- **P0 — adopt now:** `silver repl` persistent code-execution verb (item 1). Highest-leverage change
  available; collapses N-verb/N-reconnect dispatch into one session, directly attacks the
  latency/round-trip gap the project brief already flags against Vercel's persistent-daemon model.
- **P1 — adopt soon:** structured confirm-gate preview + amount-extraction regex for destructive/paid
  verbs (item 3); confirmed real gap, small keyless effort.
- **P2 — adopt when convenient:** pre-flight `elementsFromPoint` hit-test in `actuation/actions.ts`
  (item 4, confirmed gap via direct read — Silver currently only classifies obscured-click errors
  post-hoc); typed semantic-memory directory convention + filing verb (item 5, confirmed gap, cheap).
- **Not a gap, confirmed parity:** downsampled/diffed a11y-tree perception (item 2) — Silver's
  `perception/` stack independently converged on the same design, including the exact "return whichever
  is shorter" diff rule and password-field redaction (`security/redact.ts`, `perception/walk.ts:307-324`
  — confirmed present, not merely claimed).
- **Not a gap, deliberate divergence:** no vector/embedding memory layer — correctly justified by
  Silver's keyless constraint and matches Aside's own recommended fallback behavior.
