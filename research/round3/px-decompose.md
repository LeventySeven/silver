# Perplexity Computer — Task Decomposition / Planning lens → moxxie gap alignment

Source: `/Users/seventyleven/Desktop/researchfms/teardowns/PERPLEXITY_COMPUTER.md`
Moxxie anchor: `/Users/seventyleven/Desktop/moxxie/skill/agent-browser/src/core/handlers.ts`
(plus `security/confirm.ts`, `core/session.ts`, `actuation/actions.ts`, `extract/*` as needed)

Lens: this is **host-side planning doctrine**. moxxie itself never calls a model — the
"decomposition intelligence" the source shows (leader agent decomposing goals, `control_browser`
tool-guidelines, Comet's action taxonomy) lives entirely in the *host* LLM. moxxie's job is to
ship a SKILL.md / `moxxie skill` text that encodes the right *rules of thumb* for that host, and
to make sure the CLI's own primitives (sessions, verbs, confirm gate) actually back those rules
with mechanism, not just prose. Model-routing / sub-agent-typing / wide_research fan-out /
S3 pause-resume are all explicitly out of scope (model-dependent or infra-dependent) and are
called out below as skip-cargo-cult.

Today `handleSkill()` (handlers.ts:858-879) is the *only* place decomposition doctrine lives —
it's a hand-written string, not a real SKILL.md file yet (comment at handlers.ts:875: "Full
SKILL.md ships in a later task"). Every "align" finding below is a concrete addition to that text
(or its eventual file).

---

## Findings

### 1. [P0, adopt] Encode "combine dependent steps, split independent ones" as the core decomposition rule
- **Source does**: Comet's `control_browser` tool guidelines are explicit and give worked examples:
  "Sequential steps that depend on each other must be combined into a single task, not split
  across multiple tasks... When the user requests multiple independent actions, combine them into
  the tasks array within a single tool call for parallel execution... up to 10 at once." Examples:
  "Add iPhone, iPad, and MacBook to my Amazon cart" → 3 parallel tasks; "Fill out the billing form,
  then submit the order" → 1 task. (PERPLEXITY_COMPUTER.md ~2264-2278)
- **moxxie current**: `session.ts` already supports N independent named sessions — `openSession`/
  `connect` (session.ts:85, 202) key everything off `sessionDir(name)`, so `--session cart-iphone`
  and `--session cart-ipad` are two fully independent detached browsers that can run concurrently.
  The *mechanism* exists. Nothing in `handleSkill()` (handlers.ts:858-879) tells the host to use
  it this way — the doc is silent on session-per-independent-subgoal vs one-session-for-dependent-
  steps.
- **Change**: extend the `--full` branch of `handleSkill()` (handlers.ts:867-877) with an explicit
  rule: "Independent sub-goals (add N different items, message N different people) → one
  `--session <name>` per sub-goal, run concurrently. A single logical workflow with ordered
  dependent steps (fill form → submit) → one session, sequential commands, never split across
  sessions."
- **keyless_ok**: true (pure doc + existing session mechanism, no model call).
- **priority**: P0 — this is the single highest-leverage, lowest-cost change for this lens.
- **evidence**: PERPLEXITY_COMPUTER.md:2264-2278; handlers.ts:858-879; session.ts:85,202.

### 2. [P0, adopt] "No partial completion" → make `page_changed`/`stale_refs` a documented replanning gate, not just a data field
- **Source does**: Comet's system prompt: "Comet is exhaustive and thorough in completing tasks.
  Partial completion is unacceptable... Comet never stops prematurely based on assumptions or
  'good enough' heuristics." The leader agent "re-evaluates after each dependency gate" even
  though the full plan is generated upfront (PERPLEXITY_COMPUTER.md ~3140-3145, ~1477).
- **moxxie current**: `handleAct` already stamps every mutating action's response with
  `page_changed` and `stale_refs` (handlers.ts:424-435, via `settleAndFingerprint`,
  actuation/pagechange.ts) — the *mechanism* for detecting "reality diverged from the plan"
  exists and is returned on every call. But `handleSkill()`'s text never tells the host what to
  *do* with those flags as a decomposition primitive — it's presented as an observability detail,
  not a "you must replan here" contract.
- **Change**: add to `handleSkill()` full text: "Treat `page_changed:true` or `stale_refs:true` on
  any action response as a dependency gate: stop executing the rest of your pre-computed step
  list and re-`snapshot` before issuing the next ref-based command. A stale ref fails loudly
  (`element_not_found`) rather than silently misfiring — that failure is the signal to replan, not
  retry blindly."
- **keyless_ok**: true.
- **priority**: P0 — this is moxxie's actual completeness/robustness story for multi-step plans,
  and it's currently undocumented.
- **evidence**: PERPLEXITY_COMPUTER.md ~3140-3145; handlers.ts:424-435; actuation/pagechange.ts.

### 3. [P1, align] Prefer `fill` over `click`+`type` for text inputs — document the round-trip cost
- **Source does**: Comet's `computer` tool notes (verbatim): "Combine click and type into single
  call, not separate calls." (PERPLEXITY_COMPUTER.md ~3063-3067)
- **moxxie current**: moxxie's actuation layer already has an atomic `fill` verb dispatched through
  `handleAct` (handlers.ts:178-191, `act()` in actuation/actions.ts) alongside separate `click`
  and `type` verbs. The primitive exists and is *better* than Comet's (Comet still needs 2 tool
  calls even when "combined" conceptually; moxxie's `fill` is one CLI invocation). The gap is
  purely documentation: nothing tells the host to prefer `fill` over sequential `click`+`type`,
  and each extra round trip is a fresh generation-check / stale-ref risk window (handlers.ts:426).
- **Change**: add one line to `handleSkill()`: "For text inputs, use `fill @eN <value>` in a single
  call rather than `click @eN` followed by `type @eN <value>` — fewer round trips, less exposure
  to `page_changed` invalidating the ref between the two calls. Reserve `click`+`type` for
  contenteditable/custom-widget fields `fill` can't target."
- **keyless_ok**: true.
- **priority**: P1.
- **evidence**: PERPLEXITY_COMPUTER.md ~3063-3067; handlers.ts:178-191,387-440.

### 4. [P1, adopt] Close the dead-code gap in `ConfirmContext` — add a keyless keyword heuristic for irreversible/paid targets
- **Source does**: Comet's 3-tier action taxonomy (PERPLEXITY_COMPUTER.md ~3175-3195) does NOT gate
  by verb alone. Ordinary clicks are Tier 3 (auto); clicks on "irreversible action buttons ('send',
  'publish', 'post', 'purchase', 'submit')" and "entering ANY financial data in forms" are Tier 2
  (explicit confirm). The classification is by *target semantics*, not just by action type.
- **moxxie current**: `security/confirm.ts` already defines exactly this shape —
  `ConfirmContext = { destructive?: boolean; paid?: boolean }` and
  `requiresConfirm(verb, ctx?)` (confirm.ts:47-56) which treats a flagged benign verb as
  confirm-worthy. But `grep -n "destructive\|paid\|ConfirmContext" handlers.ts actions.ts` finds
  it referenced ONLY in the `import` at handlers.ts:46 and the call site at handlers.ts:396
  (`requiresConfirm(verb)` — no `ctx` argument is ever passed). The context-aware half of the gate
  is dead code; today the gate is purely a static per-verb allowlist
  (`MUTATING_VERBS`, confirm.ts:26-40), identical for a "click @e3" on a nav link and a
  "click @e3" on a "Buy now" button.
- **Change**: in `handleAct` (handlers.ts:387-440), before calling `requiresConfirm`, read the
  target's accessible name from the refmap entry (`refmap.entries[ref]` → node name, already
  available via `groundRef`/the snapshot's `SnapNode.name`) and match against a small static
  keyword list (`buy|purchase|checkout|pay|order now|submit|send|publish|post|delete|remove|
  confirm|subscribe`), setting `ctx.destructive`/`ctx.paid` accordingly before calling
  `requiresConfirm(verb, ctx)`. This finally wires up the type that already exists.
- **keyless_ok**: true — pure string matching against the already-captured accessible name, zero
  model calls.
- **priority**: P1 — meaningful safety upgrade, small diff, uses an unused hook already in the code.
- **evidence**: PERPLEXITY_COMPUTER.md ~3183-3195; confirm.ts:19-56; handlers.ts:46,396.

### 5. [P2, adopt-as-doc / skip-cargo-cult the alternative] Document `extract`/`extract resolve` as moxxie's answer to Comet's `attached_ids`, don't adopt raw ID passing
- **Source does**: Comet's `control_browser` guidance: "the browser agent operates in isolation...
  pass the relevant id fields via `attached_ids`. The agent will dereference these IDs to retrieve
  the full content." (PERPLEXITY_COMPUTER.md ~2267) This is Perplexity's mechanism for handing data
  gathered in one step to a sub-agent executing a later step.
- **moxxie current**: moxxie already has a strictly more rigorous version of this same idea:
  `extract --schema` returns an id-annotated bundle with real URLs *stripped* from the host-facing
  text (handlers.ts:638-653, "the host must see IDs, NEVER real URLs (the moat, spec §8)"), and
  `extract resolve --ids` (handlers.ts:668-680) maps host-chosen IDs back to real values without
  ever exposing them to the host's own reasoning trace. This is a genuine moxxie strength over the
  source's `attached_ids` (which does pass real dereferenced content into the sub-agent's context).
- **Change**: nothing to build — this is a documentation-only finding. Add to `handleSkill()`:
  "To move data extracted from one page into a later step (e.g. a value read via `extract` used to
  `fill` a field on another page), use `extract resolve --ids` to get the grounded value — never
  hand-copy text you saw in a snapshot, since link/URL text is stripped from what you're shown."
  Explicitly do **not** adopt a Perplexity-style `attached_ids` pass-through that hands the host
  raw dereferenced page content — that reintroduces the exact leak moxxie's id-stripping was built
  to prevent.
- **keyless_ok**: true.
- **priority**: P2 (doc clarity on an existing strength, not a functional gap).
- **evidence**: PERPLEXITY_COMPUTER.md ~2267; handlers.ts:605-680 (`handleExtract`,
  `handleExtractResolve`).

### 6. [P1, adopt] "Do not retry after a rejection" doctrine for the confirm gate
- **Source does**: verbatim Comet guidance: "If the user cancels or rejects a task, do not
  retry—explain and move on." (PERPLEXITY_COMPUTER.md ~2281)
- **moxxie current**: the confirm gate fails closed and returns `fail('not_permitted')`
  (handlers.ts:396-403, confirm.ts:78-90) on a non-TTY invocation of a mutating verb that wasn't
  pre-approved via `--confirm-actions`. Nothing tells the host that this failure is *permanent* for
  the session, not transient — a host that doesn't know the gate's mechanics could plausibly retry
  the same `click @eN` in a loop hoping for a different outcome, burning turns.
- **Change**: add to `handleSkill()`: "`not_permitted` means the action needs `--confirm-actions`
  pre-approval or a human in a TTY session — it is not a flaky/timing error. Do not retry the same
  verb; either restart the plan with the verb pre-approved, or stop and report to the operator."
- **keyless_ok**: true.
- **priority**: P1.
- **evidence**: PERPLEXITY_COMPUTER.md ~2281; handlers.ts:392-403; confirm.ts:60-90.

### 7. [P2, adopt] Document the persistent-session decomposition model as a deliberate contrast with ephemeral-task products
- **Source does**: "Tasks are ephemeral: once a task completes, its browser session ends and
  cannot be resumed. Each task must be self-contained to complete successfully." (PERPLEXITY_COMPUTER.md
  ~2280) — this forces Comet's host to front-load an entire workflow into one `control_browser`
  call because there's no resume.
  Comet's own sub-agent guidance re-derives the opposite lesson locally though: "avoid
  repeatedly scrolling down the page... use `get_page_text`/`read_page`" — i.e. even within one
  ephemeral task, minimize wasted round trips because there's no persistence to fall back on.
- **moxxie current**: `session.ts` deliberately keeps a detached browser alive across CLI
  invocations (`openSession` spawns detached + `child.unref()`s, session.ts:5,85; `connect`
  reattaches over CDP, session.ts:202) specifically so a plan can span multiple tool calls/turns.
  This is a real architectural difference from the source's model, and the host needs to know
  it — otherwise a host with priors from ephemeral-task browser agents will over-batch (cram
  everything into instructions it can't give a CLI anyway) or under-trust moxxie's stale-ref
  failure as if it were the same "task already ended" failure mode the source has.
- **Change**: add to `handleSkill()`: "Unlike single-shot browser-agent tools, a moxxie
  `--session <name>` persists across CLI invocations — you can `open`, `snapshot`, reason, then
  `click`/`fill` in a *later* call using the same session name. You do not need to front-load an
  entire workflow into one command. Navigation/reload bumps the generation and invalidates old
  refs (by design, spec §…) — re-`snapshot` after any step that might have changed the page,
  rather than reusing refs from before it."
- **keyless_ok**: true.
- **priority**: P2 — valuable orientation, not correctness-critical.
- **evidence**: PERPLEXITY_COMPUTER.md ~2280-2283; session.ts:85-235; handlers.ts:234-265
  (generation bump on `handleOpen`).

### 8. [P2, adopt] Host-side todo/plan tracking — recommend, don't build
- **Source does**: Comet's tool registry includes `todo_write` — an explicit plan-tracking tool
  with `content`/`status` (`pending|in_progress|completed`)/`active_form` fields, noted "Used VERY
  frequently. Mark completed immediately when done. Do not batch." (PERPLEXITY_COMPUTER.md
  ~3110-3117)
- **moxxie current**: absent, and correctly so — this is pure host-side bookkeeping with no
  browser-state component; moxxie has no notion of a "todo list" and shouldn't (it would either be
  inert prose in the envelope or require moxxie to reason about plan status, which would drift
  toward a model call). `handleSkill()` doesn't mention plan-tracking at all today.
- **Change**: add one line to `handleSkill()`'s full text recommending the *pattern*, not a moxxie
  feature: "For multi-step goals, maintain your own step list outside moxxie and update each step's
  status only after the corresponding moxxie response confirms it (e.g. `page_changed` reflecting
  the expected transition, or a `get`/`is` check) — don't mark a step done just because the command
  didn't error." This is a doc-only nudge; do not add a `moxxie todo` verb.
- **keyless_ok**: true (doc-only; explicitly rejects building the stateful feature).
- **priority**: P2.
- **evidence**: PERPLEXITY_COMPUTER.md ~3110-3117; handlers.ts:858-879 (no existing mention).

### 9. [skip-cargo-cult] Everything requiring a model or heavyweight infra: do NOT adopt
- **Source does**: multi-model task-graph routing (leader Claude Opus 4.6 decomposes → typed
  sub-agents on Gemini/Grok/GPT-5.3-Codex, PERPLEXITY_COMPUTER.md ~288-309, 1387-1449);
  `wide_research` fanning out to 7 parallel search verticals + LLM synthesis (~1499, ~3827);
  async `BrowseSafe` classification "running concurrently with the LLM's planning/reasoning phase"
  (~1985-2001) — a latency-hiding trick that only makes sense when there IS a separate LLM
  planning phase to hide behind; Firecracker microVM pause/resume with full filesystem tarballs to
  S3 for multi-day tasks (~1340-1580); LanceDB long-term memory (~3830-3832).
- **moxxie current**: none of this exists, correctly — moxxie is a single synchronous CLI process
  per invocation with no model, no cross-session memory store, no VM lifecycle to manage.
- **Change**: none. Explicitly flag in the digest so a future pass doesn't re-propose "moxxie
  should classify page content asynchronously while the host thinks" (there is no moxxie-side
  "thinking" to overlap with) or "moxxie should route sub-tasks to specialized backends" (moxxie
  has no backends to route to — the host already *is* the single model in this architecture).
- **keyless_ok**: n/a (recommendation is skip).
- **priority**: n/a.
- **evidence**: PERPLEXITY_COMPUTER.md ~288-309, 1387-1449, 1499, 1985-2001, 1340-1580, 3830-3832.

---

## Top recommendation

**Finding #1** (dependent-vs-independent step splitting via one-session-per-subgoal vs one-session-
sequential) is the single highest-value change: it's zero new code (the session mechanism already
supports it), directly closes the biggest doctrinal gap between what the source teaches its host
and what moxxie currently tells its host, and it's the load-bearing decomposition rule the rest of
the findings (replanning gates, fill-vs-click+type, no-retry-on-reject) all assume the host is
already following.

Runner-up for actual code (not just doc): **Finding #4** (wiring the already-defined
`ConfirmContext.destructive/paid` into a keyless keyword heuristic on the target's accessible
name) — it's the one finding here that closes a real functional gap rather than a documentation
gap, using a type that already exists and sits unused.
