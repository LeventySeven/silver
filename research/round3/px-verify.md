# Perplexity Computer → moxxie: verification / done-checking alignment

Source: `/Users/seventyleven/Desktop/researchfms/teardowns/PERPLEXITY_COMPUTER.md`
Lens: verification / done-checking patterns vs moxxie done semantics + eval judge (keyless)
Moxxie anchors read: `evals/harness/judge.mjs`, `evals/harness/run.mjs`, `evals/README.md`,
`skill/agent-browser/src/security/confirm.ts`, `skill/agent-browser/src/actuation/pagechange.ts`,
`skill/agent-browser/src/core/handlers.ts` (`handleAct`), `skill/agent-browser/src/core/envelope.ts`,
`skill/agent-browser/src/security/injection.ts`

## Findings

### 1. [P0, adopt] Default `--confirm-actions`-off path silently disables the "fail-closed" confirm gate the docstring promises
- source_does: Comet's action taxonomy (verbatim system prompt) puts irreversible-click verbs
  ("send", "publish", "post", "purchase", "submit", delete-style buttons) in a hard-required
  Tier-2 confirmation gate that applies by default, every session, regardless of any prior flag —
  the model must always ask before those specific outcomes, or refuse outright for Tier-1 (account
  creation, security-permission changes).
- moxxie_current: `security/confirm.ts` docstring claims "the gate FAILS CLOSED — the action is
  denied unless the operator pre-approved that verb via `--confirm-actions`". But
  `core/handlers.ts::handleAct` only calls `confirmGateDecision` when
  `flags.confirmActionsProvided` is true (line ~396: `if (flags.confirmActionsProvided &&
  requiresConfirm(verb))`). If the operator never passes `--confirm-actions` at all, the gate is
  never invoked and every mutating verb (click/fill/type/upload/…) proceeds unconditionally. The
  "fail-closed" claim only holds once the flag is present with an empty/partial allowlist — it is
  opt-in fail-closed, not default fail-closed.
- recommendation: align. Either (a) fix the docstring to say "engaged only when `--confirm-actions`
  is supplied" so the security claim is accurate, or (b) make the gate check
  `requiresConfirm(verb)` unconditionally and treat "flag absent" as "empty allowlist" so
  non-TTY mutating actions are denied by default unless explicitly approved — closer to what the
  comment already asserts. (b) is the correct security fix; (a) is the honest minimum.
- keyless_ok: true (pure flag/branch logic, no model call)
- priority: P0
- evidence: `skill/agent-browser/src/security/confirm.ts` lines 1-15 (docstring) vs
  `skill/agent-browser/src/core/handlers.ts` lines 392-403 (actual gating condition); source
  teardown lines 3157-3187 (Tier 1/2/3 action taxonomy, confirmation XML tag).

### 2. [P1, adopt] No heuristic ties destructive/irreversible-button text to the confirm gate's `destructive`/`paid` context
- source_does: Comet's Tier-2 list is keyed off the *semantic outcome* of the click, not the verb:
  "Clicking irreversible action buttons ('send', 'publish', 'post', 'purchase', 'submit')" is
  called out explicitly, separately from the general verb taxonomy — i.e. a plain `click` on a
  button whose accessible name matches a purchase/delete/publish/send lexicon gets escalated even
  though `click` itself is "just" a mutating verb.
- moxxie_current: `confirm.ts::ConfirmContext` already has `destructive?: boolean` and `paid?:
  boolean` fields and `requiresConfirm` honors them — but grep across `skill/agent-browser/src`
  shows these fields are never set anywhere; only the docstring/type declares them. `click`/`fill`
  are gated solely by verb membership in `MUTATING_VERBS`, with no accessible-name/text-content
  lexicon check.
- recommendation: align. In `actuation/actions.ts` (the `click`/`fill`/`select` handlers), look up
  the resolved element's accessible name via the existing `perception/accessible-name.ts` and match
  against a small deterministic keyword list (`buy|purchase|checkout|pay|delete|remove|publish|
  post|send|submit|confirm order`). If matched, pass `{ destructive: true }` into
  `confirmGateDecision` so a plain `click @e12` on a "Delete account" button is treated the same as
  an explicitly-flagged irreversible action, even under looser verb-only gating.
- keyless_ok: true (regex/string match on already-computed accessible name, no model)
- priority: P1
- evidence: source teardown lines 3157-3187 (Comet Tier 2 list, `<confirmation>` tag); moxxie
  `security/confirm.ts` lines 46-59 (`ConfirmContext`, unused `destructive`/`paid` fields).

### 3. [P1, adopt] No "never stop prematurely / partial completion unacceptable" behavioral contract shipped to the host
- source_does: Comet's system prompt states outright: "Comet is exhaustive and thorough in
  completing tasks. Partial completion is unacceptable... Comet never stops prematurely based on
  assumptions or 'good enough' heuristics." This is a standing instruction that shapes when the
  *host* model is allowed to declare done.
- moxxie_current: moxxie ships no `SKILL.md`/host-usage doc under `skill/agent-browser` (only
  `README.md`, `LICENSE`, `NOTICE`, `src`, `tests`, `dist`) — there is no packaged guidance telling
  the host agent "re-snapshot before claiming success" or "don't declare done off a stale
  `page_changed:false` assumption". The `pagechange.ts` fingerprint mechanism (§ finding 4) exists
  in the CLI but nothing tells the host *how to use it* as a done-check.
  `evals/harness/judge.mjs` independently encodes "be initially doubtful of self-reported success"
  for the eval judge, but that doubt is not surfaced to the live host agent driving real tasks.
- recommendation: align (keyless — pure documentation, zero code). Add a short "Verification"
  section to the moxxie skill doc/README instructing the host: after any mutating verb, check the
  response's `stale_refs`/`page_changed` flag before asserting task success; re-run `snapshot` or
  `get text` to confirm the expected end-state text/element is actually present rather than
  inferring success from the action call returning `success:true` (a successful click that doesn't
  produce the expected outcome should not be reported as task-complete).
- keyless_ok: true
- priority: P1
- evidence: source teardown lines 3129-3135 ("Comet is exhaustive... partial completion is
  unacceptable"); moxxie `evals/harness/judge.mjs` lines 3-9 (doubtful-judge design note, not
  propagated to skill docs); no `SKILL.md` found under `skill/agent-browser`.

### 4. [P2, skip-cargo-cult] Async BrowseSafe classifier running concurrently with LLM planning
- source_does: §4.3 of the arXiv paper — untrusted tool output triggers an async ML classifier
  (fast local model + escalation to GPT-5/Claude Sonnet on boundary cases) that runs concurrently
  with the agent's next-token planning, then gates whether the agent is allowed to act on the
  result.
- moxxie_current: `security/injection.ts::neutralize()` does synchronous, deterministic regex
  stripping of forged role/boundary tags plus stable boundary-marker wrapping — no classifier, no
  async race, no model call of any kind.
- recommendation: skip-cargo-cult. moxxie is a synchronous single-command CLI with no persistent
  "planning" phase to hide latency behind, and it is keyless by hard constraint — a two-stage
  classifier pipeline is exactly the kind of infrastructure a 100%-keyless tool must not
  reintroduce. The regex+boundary-marker approach is the correct keyless analog and should stay as
  is; do not chase the async-classifier architecture.
- keyless_ok: false as literally described (requires GPT-5/Claude escalation calls)
- priority: P2
- evidence: source teardown lines 1985-2010 (async middleware architecture, Prompt A4/A5); moxxie
  `security/injection.ts` lines 1-45 (deterministic neutralize()).

### 5. [P1, adopt] No structured "why is this blocked" reason surfaced when the confirm gate denies, beyond a generic `not_permitted`
- source_does: Comet's `<confirmation question="..." action="..." />` tag is a structured,
  machine-parseable object naming *what* is being confirmed and *why* — the calling UI/host can
  render it directly without re-deriving the reason from prose.
- moxxie_current: `core/handlers.ts::handleAct` line 402: on gate deny it returns
  `fail('not_permitted')` — the generic error-taxonomy message, with no verb name, no target
  element, and no distinction between "this verb always needs confirmation" vs "destructive click
  flagged" vs "no TTY and verb not pre-approved". `confirmGateDecision` computes a rich `reason`
  string (`confirm.ts` lines 96-99) but it is discarded — `fail()` never receives it
  (`envelope.ts::fail` explicitly voids `ctx` and only emits the fixed ERRORS-table message).
- recommendation: align. Thread `decision.reason` (and the verb) into the failure via
  `fail('not_permitted', { verb, reason: decision.reason })` and extend the `not_permitted` ERRORS
  entry (or add a `confirm_required` code) to interpolate a short deterministic reason string —
  without violating the existing no-leak invariant (only static verb/reason text, never page
  content or paths). This lets the host construct its own Comet-style confirmation prompt to show
  the human ("this would click 'Delete account' — needs `--confirm-actions delete`") instead of
  guessing from a bare `not_permitted`.
- keyless_ok: true
- priority: P1
- evidence: moxxie `security/confirm.ts` lines 83-100 (`confirmGateDecision` reason strings, e.g.
  "confirmation required but no TTY and verb not pre-approved (fail-closed)"); `core/handlers.ts`
  line 402 (`return fail('not_permitted')` — reason dropped); `core/envelope.ts` lines 33-41
  (`fail()` explicitly voids `ctx`); source teardown lines 3140-3145 (`<confirmation>` tag format).

### 6. [P2, align] `page_changed`/`stale_refs` flag exists but nothing enforces it as a done-check gate before extract/report
- source_does: Comet explicitly treats screenshots and page reads as the authority for current
  state — "screenshot action returns current page state after all actions execute" — and the tab
  context system-reminder mechanism re-pushes `availableTabs` into context whenever it changes so
  the model is never allowed to reason from stale tab state silently.
- moxxie_current: `actuation/pagechange.ts::settleAndFingerprint` computes `page_changed` /
  `stale_refs` correctly and the CLI "stamps" it onto every action response (per the file's own
  docstring), but nothing in `handlers.ts` blocks or warns on a subsequent `get text`/`extract`
  call made against a ref map that is already known-stale — the flag is purely advisory data in the
  JSON envelope, left entirely to the host to notice and act on.
- recommendation: align (light). This is consistent with the "moxxie never auto-embeds a fresh
  snapshot" design principle (correct, don't regress it) — but add a `warning` field (the envelope
  already supports `warning?: string`, see `envelope.ts` line 14) on any perception/extract command
  issued when `stale_refs` was true from the prior action and no intervening `snapshot` was taken,
  e.g. `warning: "refs may be stale since last action; consider a fresh snapshot before reporting results"`.
  This is a nudge, not a gate — no behavior change, no model call.
- keyless_ok: true
- priority: P2
- evidence: moxxie `actuation/pagechange.ts` lines 1-22 (docstring: "the CLI wants to tell the
  host... nothing more"); source teardown lines 3057-3068 (`computer` tool notes: screenshot =
  current state authority).

### 7. [P2, adopt] Cross-family judge design is already correctly keyless-degraded; extend it with a deterministic "self-report vs evidence" cross-check that needs no model at all
- source_does: the paper's judge stance is "be initially DOUBTFUL of the agent's self-reported
  success" — Perplexity backs this with a frontier-model judge call.
- moxxie_current: `evals/harness/judge.mjs` already implements the doubtful-judge *stance* in
  comments and gracefully no-ops to `null` when no model key exists (lines 60-94); `run.mjs`'s
  deterministic regex gate (`expectedPattern`/`forbiddenPattern` match over accumulated stdout) is
  correctly the sole ground truth per `evals/README.md` lines 3-6, 49-55.
- recommendation: adopt a keyless strengthening of the doubt principle directly in `run.mjs`: when
  a task's script includes a mutating verb, additionally require that the *last* command's output
  envelope has `success:true` AND (if the verb was a click/fill on a form) that a subsequent
  `expectedPattern` match occurs only after a `page_changed:true` was observed at least once in the
  transcript — i.e. codify "an action that claims to work but never changed the page is suspicious"
  as a second deterministic assertion, not just regex text matching. This is the zero-cost keyless
  version of "be doubtful of self-reported success" that doesn't need judge.mjs's model fallback at
  all.
- keyless_ok: true
- priority: P2
- evidence: `evals/harness/judge.mjs` lines 3-19 (doubtful-judge design note, non-flipping);
  `evals/harness/run.mjs` referenced in `evals/README.md` lines 42-55 (pass_k gate); source
  teardown lines 1-20 area / judge doubt principle cited directly in moxxie's own comment (the
  moxxie author already read this corpus once — this finding closes the loop by wiring the
  page-change signal the CLI already emits into the gate that currently ignores it).

## Skip-cargo-cult (explicitly do NOT adopt)

- **Async two-stage ML classifier (BrowseSafe) with frontier-model escalation** (finding 4) —
  requires live model calls; violates the keyless hard rule outright.
- **`todo_write` tool with pending/in_progress/completed status array** — this belongs to the
  *host* agent's own task-tracking (e.g. Claude Code's TodoWrite), not to a browser-automation CLI.
  moxxie has no persistent multi-step task object to track; adding one would duplicate host-side
  state management for no keyless benefit.
- **`<confirmation question=... action=... />` UI tag emitted by the model** — that's an output
  contract for a chat UI that renders Comet's *own* text stream; moxxie is a CLI whose structured
  JSON envelope is the actual UI contract. Finding 5 captures the useful part (richer machine
  reason) without cargo-culting the XML-in-model-text mechanism.
- **CREATED → IN_PROGRESS → COMPLETED → FAILED async job polling for tasks** — this is
  Perplexity's decomposed multi-agent orchestration model (leader dispatches subtasks to sandboxed
  workers). moxxie's session model is a single synchronous CLI invocation against one Playwright
  session; there is no multi-worker task graph to poll. Not applicable.

## Top recommendation

Fix finding #1 first: the confirm gate's docstring claims fail-closed behavior that the actual
`handleAct` wiring does not provide by default (`--confirm-actions` must be explicitly passed
before any gating happens at all). This is the single highest-value keyless change because it's a
one-line behavioral/documentation mismatch in a security-critical path that the eval suite's own
trifecta test (`evals/README.md` "Trifecta" section) does not currently exercise — the trifecta
tests egress, grounding, and redaction, but never asserts that a mutating verb is actually denied
by default without `--confirm-actions`.
