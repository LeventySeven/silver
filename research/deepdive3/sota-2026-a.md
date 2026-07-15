# SOTA 2026-a: Latest browser/computer-use agent techniques Silver could adopt keylessly

Scope: WebVoyager / Online-Mind2Web / WebArena leaderboard state, the newest open tools (browser-use,
Skyvern, Nova Act, Fara-7B, Operator, Anthropic/Gemini computer-use, Convergence Proxy), and the
concrete engineering techniques the top 2026 systems use — filtered to what Silver can adopt **without
ever calling a model itself** (Silver is a keyless CLI; the host LLM is the brain). Builds on
`research/synthesis/adopt-list-v2.md` (A0–I5) — this pass goes beyond that list, not over it.

## 1. Benchmark state (context, not directly actionable)

Online-Mind2Web is now the harder/more-trusted benchmark; WebVoyager has saturated near 97–98% for top
commercial agents and is treated as a regression check, not a frontier signal. Leaders on Online-Mind2Web:
Browser Use Cloud ("bu-max") 97.0%, well ahead of Yutori Navigator (64.7%), OpenAI Operator (58.3%),
Gemini 2.5 Computer Use (57.3%); open-weights SOTA is Avenir-Web on Gemini 3 Pro at 53.7%
(steel.dev leaderboard, arXiv:2602.02468). WebArena/VisualWebArena gains now come from **test-time tree
search** (LATS-style), not just better base models — a search-augmented GPT-4o agent posted +39.7% on
VisualWebArena and +28% relative on WebArena over the ReAct baseline (arXiv:2407.01476, jykoh.com paper).
None of this is directly portable into Silver (Silver has no model to search with), but it reframes
where the *host's* reasoning quality comes from — informs G4/G6 skill-prose guidance, not engine code.

## 2. Caching & replay — the dominant 2026 convergence, extends Silver's D1

Every serious 2026 harness now ships a two-tier cache: (a) **action/selector cache** keyed on a DOM hash,
validated then replayed with zero model call on hit; (b) **prompt cache** for the static scaffolding
portion of context. Stagehand v3 reports "up to 2x faster execution and ~30% cost reduction on repeat
workflows" from action caching; Skyvern goes one step further with **code caching** — it records the
actions a run took and *compiles them to executable code*, so subsequent runs skip both the LLM call and
the screenshot/DOM analysis entirely, only falling back to the agent loop on cache miss (skyvern.com/docs
/developers/features/code-caching). Anchor (b0.dev) frames this explicitly as "record at planning time,
replay deterministically after." Microsoft's Fara-7B paper (arXiv:2511.19663) doesn't cache but reinforces
the same idea from the training side: FaraGen synthesizes 145K verified trajectories specifically so a
small model can be *distilled into a fast, cheap, mostly-deterministic policy*.

**Concrete Silver change beyond D1:** adopt-list-v2's D1 already specs a self-healing resolution cache
(ref-level). Extend it with Skyvern's idea one level up — a **verb-sequence cache**: when `task compile`
(F1) or `batch` replays a recorded action_log against the same normalized URL + DOM-hash, skip straight to
dispatching the verbs (no re-snapshot, no re-resolve) unless the DOM hash differs, in which case fall back
to normal resolution and rewrite the cache entry. This is F1 + D1 fused: `task/store.ts` already has the
action log; `perception/refmap.ts` already has generation/staleness. The DOM-hash-gate is the only new
primitive (hash the flat interactive-node list, not full HTML — cheap, already computed for diffing in
`perception/diff.ts`). **Keyless.** Priority: P1, sits directly on top of D1/F1 already in the backlog —
worth calling out because "hash-gated whole-sequence skip" is a bigger win than the item-level framing in
v2 suggests (Skyvern reports it eliminates the LLM call **and** the screenshot/DOM step, i.e. the entire
host round-trip, on cache hit).

## 3. Verification/validator loops — Skyvern's Planner→Actor→Validator, applicable as a Silver *primitive* not a Silver *decision*

Skyvern 2.0's three-phase loop (planner decomposes → actor executes → **validator confirms success against
a post-action screenshot/state before continuing**, else replans) and the broader 2026 pattern researchers
call "closing the verification loop" (thinkroom.kieranklaassen.com; testmuai.com "Loop Engineering") both
converge on one idea: **do not trust self-reported success; check state, not model claims.** The
self-critique research explicitly flags that a model grading its own homework "agrees with itself" (the
coherence trap) — the fix is grounding the check in *execution*, not another LLM call.

Silver cannot run a validator model (keyless), but it can supply the **grounding substrate** a host-side
validator loop needs, which today it does only partially:
- **Gap:** after a mutating verb, Silver returns the action result but the *caller* (host) has to issue a
  separate `snapshot`/`get` to verify the goal state — there is no single verb that says "did the thing I
  expected happen." Webwright/Aside-style tasks already re-verify selected-state after a drawer closes
  (G4, ported as prose); Silver could make this a **first-class flag** instead of a documented convention.
- **Change:** add `--verify <role>:<name>[:state]` to mutating verbs (`click`, `fill`, `select`) — after
  the action + settle, resolve the named target once more and report a structured
  `{expected, observed, matched:boolean}` block in the envelope, computed from data Silver already holds
  (accessible name, checked/selected/value) — no vision, no model, no new dependency. This directly
  operationalizes Webwright's Hard Rule "re-verify selected state after a drawer/modal closes" as a Silver
  mechanism instead of leaving it as skill prose the host might forget under context pressure.
- `actuation/actions.ts` (post-action path) + `core/envelope.ts` (result shape). Keyless.
- Priority: **P1** — cheap, closes a documented Webwright gap (G4) with code instead of prose, and is the
  keyless-compatible half of the industry's dominant 2026 reliability pattern.

## 4. Nova Act's "atomic commands" — validates and sharpens Silver's own architecture bet

Amazon's Nova Act SDK's headline finding: decomposing a task into many small, explicit, composable
commands (rather than one big natural-language goal handed to an agent loop) takes success rates from
~50% to 90%+ on UI tasks like date pickers, dropdowns, and popups (AWS ML blog, labs.amazon.science). This
is Silver's exact `~40 discrete verbs` bet, already vindicated independently by Amazon's own internal
evals — worth stating explicitly in the SKILL.md tonal-craft item (G6) as an evidence-backed claim:
*"prefer many small silver verb calls over one big free-text instruction — this is now an industry-wide
finding, not a Silver idiosyncrasy."* Also validates **not** building a `repl`-only surface that discards
the verb API — B0's `repl` should be additive, not a replacement, which the adopt-list-v2 spec already
gets right. No code change; a one-line SKILL.md citation add. Priority: P2 (doc only).

Nova Act's other technique — reported >90% accuracy specifically on **date selection, dropdown
navigation, and popup handling** — reinforces C1 (compound-component synthesis / format hints) as
correctly prioritized; these are the exact three UI classes Nova Act had to solve for with atomic commands
and Silver can solve for free at the perception layer instead. No new item, just evidence C1 is P1-correct.

## 5. Fara-7B's "critical point recognition" — a keyless pattern-matchable analog

Fara-7B's safety design has the model **detect points requiring human permission or sensitive info and
halt** rather than acting through them (Microsoft Research blog). Silver's `security/confirm.ts` +
`registry.ts` already gate destructive/paid actions by verb name (`isDestructivePaidName`) — the
adopt-list's E2 (structured confirm preview) is the right direction. What's new from Fara-7B specifically:
their critical-point set is broader than "paid/destructive" — it includes **entering credentials on an
unfamiliar domain** and **submitting anything containing what looks like a SSN/card number pattern**.
- **Change:** extend `security/registry.ts`'s trigger set with two keyless pattern checks on the *value*
  about to be submitted (not just the verb name): a credit-card-shape regex (Luhn-checkable 13–19 digit
  run) and a SSN-shape regex, both gated behind the existing confirm flow — flag-and-confirm, never block
  silently. This is a value-inspection gate Silver doesn't have today (current gates are verb-name-based
  only, per `registry.ts` — confirmed via grep in adopt-list-v2's E1 discussion which only covers the
  `<secret>` tag, not raw literal PII typed by the host).
- Keyless (pure regex/Luhn, no model). Priority: **P2** — real but narrow; false-positive risk on
  legitimate PII-adjacent form fills means it must stay confirm-gated, not blocking.

## 6. CaMeL / dual-LLM / taint tracking — the one truly novel, fully keyless security upgrade this round found

This is the most important new finding not in adopt-list-v2's security section (E1–E6). DeepMind's CaMeL
(arXiv:2503.18813, "Defeating Prompt Injections by Design") and its 2026 follow-ons (FIDES, Progent, RTBAS,
FORGE, and the computer-use-specific "CaMeLs Can Use Computers Too" arXiv:2601.09923) report **near-
elimination of prompt-injection attacks on AgentDojo** using a mechanism that is **entirely non-model**:
a capability-based interpreter that tracks **data provenance** (where did this string come from — a
trusted user prompt, or an untrusted page?) and refuses to let untrusted-provenance data reach a
sensitive tool call without an explicit capability grant, independent of what the string *says*.

This is directly portable to Silver because it's exactly Silver's existing shape (a typed CLI mediating
between a host LLM and tool calls) with one addition: **provenance tags on values that flow from
`snapshot`/`extract`/`get-text` output back into a subsequent `fill`/`type`/`click` argument.**

Currently `security/injection.ts` (71 lines) does syntactic neutralization of forged transcript-role tags
in *outbound* page content — a content-level defense. CaMeL's insight is orthogonal and additive: it's a
**data-flow** defense that doesn't care about content shape at all. Concretely:
- **Change:** Silver already has a natural taint boundary — anything returned by a read verb
  (`snapshot`, `get`, `extract`, `read`) originates from the untrusted page. Add a lightweight
  provenance marker in the envelope (`origin: "page"` on extracted string values) that the **host** is
  expected to propagate; then, on the Silver side, add an opt-in `--no-untrusted-args` mode (or default-on
  behind a flag) where mutating verbs (`fill`, `type`, navigation to a URL argument) reject arguments that
  arrive wrapped in Silver's own `⟦page-content untrusted⟧` fence marker (already emitted per
  adopt-list-v2's "Confirmed non-gaps" — the fencing exists on the read side today) — i.e., if the host
  echoes untrusted page content verbatim back into a `fill --value` without deliberately stripping the
  fence, Silver refuses and returns a structured "argument appears to be untrusted page content, confirm
  or reformulate" error instead of silently typing it into a form or navigating to it.
- This requires **no model call and no interpreter rewrite** — it's a string-marker convention plus one
  guard check at the mutating-verb entry point, reusing the fence Silver already produces. It closes the
  actual CaMeL threat class (page content flowing unexamined into a sensitive action) at a fraction of
  CaMeL's implementation cost, because Silver's CLI boundary is already the natural taint checkpoint that
  CaMeL's custom Python interpreter exists to create for general-purpose agent code.
- `security/injection.ts` (extend the fence) + `actuation/actions.ts` (guard at mutating-verb dispatch) +
  `core/envelope.ts` (origin tagging on extract/get output).
- Keyless — pure string-marker + regex on args, this round's clearest **novel** (not-in-v2) capability.
  Priority: **P1**, directly answers "what would make Silver categorically the best keyless browser for
  agents" on the security axis — it's a cheap, fully keyless implementation of the actual SOTA 2026
  academic defense, something none of the top5/deepdive sources evaluated (Perplexity/browser-use were
  the prior injection lenses; neither ships taint tracking).

## 7. Session recovery / failure isolation (Browser Harness, browser-use ecosystem)

The `browser-use/browser-harness` project (self-healing framework layered on browser-use) documents four
mechanisms worth naming individually since v2 grouped them loosely under D1/E4: **Selector Fallback**
(text-content / ARIA-label / visual-proximity match chain when the primary locator misses), **Element
Reclassification** (re-derive a node's role when structural change is detected, not just re-find by same
selector), **Session Recovery** (detect a navigation event mid-task and re-establish context rather than
erroring), and **Failure Isolation** (one action's failure doesn't cascade into corrupting the whole
task's action log).

Silver's `perception/refmap.ts` generation-staleness gate already gives failure isolation for free (a
stale ref errors cleanly rather than silently misfiring — this is a *better* primitive than "fallback
match chains," which risk clicking the wrong element with high confidence). The one piece genuinely
missing: **Session Recovery** — if a click triggers an unexpected navigation (redirect, new tab takes
focus, SSO bounce), does Silver's next command detect and report "page changed under you, re-snapshot
required" cleanly, or does it silently resolve against a stale page? `actuation/pagechange.ts`'s
fingerprint mechanism (referenced throughout v2) suggests this is *mostly* covered already — but it's
worth an explicit `doctor`-style self-check: after a verb triggers a page navigation Silver did not
initiate via `open`/`goto` (e.g., a click that submits a form and redirects), confirm the envelope
explicitly surfaces `pageChanged: true` with the new URL, rather than requiring the host to notice via a
diffed snapshot. **Change:** audit `pagechange.ts` output shape against this specific case (click-induced
redirect) and add the field if missing — likely a **verification task, not a build task**, since the
fingerprint machinery already exists per A4b/C2. Keyless. Priority: **P2**, mostly a "verify this is
already true" item rather than new engineering.

## 8. What NOT to adopt (explicit exclusions this round)

- **Vision-primary grounding (Skyvern 2.0's screenshot→VLM path, Anthropic/OpenAI computer-use's
  screenshot+coordinate loop, Fara-7B's direct pixel-coordinate prediction):** all require a
  vision-capable model inside the loop — Silver's AX-tree-first approach is the correct keyless divergence
  and is already validated as leaner-or-equal token-wise (adopt-list-v2 A1). B1's coordinate-fallback verbs
  remain the right-sized concession (host supplies the vision judgment from a screenshot Silver captures;
  Silver stays keyless).
- **Residential-proxy / fingerprint-rotation stealth (Hyperbrowser, Bright Data's 150M+ IP network):**
  paid infra, already correctly excluded in v2 alongside Web Bot Auth and captcha-solving.
  E6 (static JS stealth defaults) remains the right-sized keyless slice of this space.
  Superseded/dead ends checked this round: Convergence's Proxy 1.0 shows no 2026 shutdown signal (still
  listed active, mixed reviews) — nothing to port; MultiOn/Runner H returned no confirmable 2026 status —
  skip, not worth further research spend.
- **Test-time tree search / Reflexion / LATS for the host's reasoning:** genuinely SOTA for benchmark
  scores but lives entirely in the *host's* reasoning loop, not in Silver — Silver's job is to make each
  branch of that search cheap and reliable (fast snapshot, deterministic refs), which the existing A-series
  engine items already target. Correctly out of scope for Silver's own codebase.

## Priority additions to fold into adopt-list-v2

**P1 additions:** §2 verb-sequence cache (extends D1+F1) · §3 `--verify` post-action flag (operationalizes
G4) · §6 CaMeL-lite taint-marker guard on mutating-verb args (new, highest-value security item this round).

**P2 additions:** §4 Nova Act SKILL.md citation (doc-only) · §5 PII/card-pattern confirm-gate extension ·
§7 pagechange.ts click-redirect field audit.

Sources: steel.dev Online-Mind2Web/WebArena leaderboards; arXiv 2511.19663 (Fara-7B), 2602.02468
(Avenir-Web), 2407.01476 (tree search for LM agents), 2601.09923 (CaMeLs Can Use Computers Too), 2503.18813
(CaMeL); AWS ML blog + labs.amazon.science (Nova Act); skyvern.com/docs (code caching, optimization
strategies), Skyvern 2.0 architecture; theairuntime.com "Complete Field Guide to Browser Harnesses in
2026"; Microsoft Research blog (Fara-7B); thinkroom.kieranklaassen.com / testmuai.com (verification loops).
