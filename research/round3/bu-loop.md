# browser-use agent loop vs moxxie — gap alignment

Lens: agent loop / message manager / max_failures + grace / done semantics / loop
detection vs moxxie's host-driven loop. Source read:
`browser_use/agent/service.py` (4144 lines: `step()` ~1027-1249,
`_handle_step_error()` ~1250-1306, `_check_step_budget`-equivalent
`_inject_budget_warning` ~1533-1558, `_force_done_after_last_step` ~1560-1569,
`_force_done_after_failure` ~1571-1582, `run()` main loop ~2493-2690) and
`browser_use/agent/views.py` (`ActionResult` ~305-345 incl. the
`success=True requires is_done=True` validator; `ActionLoopDetector` class
~157-248).

Moxxie side read: `skill/agent-browser/src/core/handlers.ts` (full file, 936
lines) and `skill/agent-browser/src/core/errors.ts`, `envelope.ts`.

## Structural framing

browser-use is a **model-in-the-loop** agent: `Agent.run()` owns a persistent
Python process that calls an LLM every step, holds `consecutive_failures`
state, injects budget/loop-detection nudges as synthetic user messages, and
can unilaterally force a `done` action. moxxie is **stateless per CLI
invocation** — there is no `run()` loop in moxxie at all; the host LLM *is*
the loop, and moxxie's only cross-call state is the `moxxie-state.json`
sidecar (generation, prevTree, fingerprint) read/written by each handler
(`handlers.ts:83-110`). None of browser-use's loop-control fields
(`consecutive_failures`, `n_steps`, `loop_detector`) exist anywhere in
moxxie's source (`grep` for `budget|max_step|consecutive|retry|attempt` across
`src/` returns nothing outside `errors.ts`/`confirm.ts` string matches).

This means every one of browser-use's loop-discipline mechanisms is
necessarily **host-side** for moxxie — moxxie cannot enforce a step budget or
consecutive-failure count itself because it has no persistent loop to enforce
it in. The lever moxxie DOES have is: (a) what `moxxie skill` teaches the host
to do, and (b) what state the sidecar could optionally track and surface back
to the host as a nudge on the next command's envelope.

## Findings

### 1. No consecutive-failure counter surfaced to the host — P0, adopt (as sidecar counter + envelope nudge)
- **source_does**: `service.py:1227-1234` increments `state.consecutive_failures`
  on any single-action step whose result has an `error`, resets to 0 on
  success. `service.py:2600-2604` in `run()` hard-stops the whole agent once
  `consecutive_failures >= max_failures` (default 5) unless
  `final_response_after_failure` grace is set, in which case
  `_force_done_after_failure()` (`service.py:1571-1582`) injects a message
  forcing the LLM's *next* action to be `done` with `success=False`.
- **moxxie_current**: `handlers.ts` has no failure counter of any kind. Each
  handler call is independent; `errors.ts` tags `retryableByHost` per error
  code but nothing tracks how many times the host has already retried the
  same ref/action. A host LLM can retry `click @e7` against a
  `ref_stale`/`element_not_found` error indefinitely with no signal from
  moxxie that it's stuck.
- **recommendation**: adopt (align, keyless)
- **change**: In `moxxie-state.json` (extend `UabState` in `handlers.ts:66-81`),
  add `lastErrorCode: string | null` and `consecutiveErrorCount: number`.
  In `patchState`/the act-handler failure path (`handleAct`, `handleWait`,
  `withLocator`), when a handler returns `fail(code)`, compare `code` to
  `lastErrorCode`: same code → increment; different/success → reset to 0.
  When `consecutiveErrorCount` crosses a threshold (e.g. 3), attach a
  `warning` to the envelope: `"you have hit '<code>' N times in a row on this
  session; re-snapshot before the next attempt, or stop and report the
  blocker instead of retrying the same action"`. This is a pure heuristic —
  no model call, just counting — and closes the single biggest gap: moxxie
  currently has zero mechanism to tell a host "you are stuck."
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `service.py:1227-1234`, `service.py:2600-2604`; moxxie
  `handlers.ts:66-110` (UabState/patchState), `errors.ts` (no counter field).

### 2. No "grace" / forced-done-on-failure semantics — P1, align (as SKILL.md instruction, not code)
- **source_does**: `_force_done_after_failure()` (`service.py:1571-1582`) gives
  the LLM exactly one more turn after hitting `max_failures`, restricted to
  the `done` tool only, explicitly telling it to set `success=false` if the
  task isn't finished and to "include everything you found out... in the done
  text" — i.e., forced graceful degradation instead of a silent crash/hang.
- **moxxie_current**: moxxie has no `done` verb or task-completion concept at
  all — `handle()`'s switch in `handlers.ts:157-227` has no `done` case, and
  there's no equivalent of `ActionResult.is_done`/`success`. Task completion
  is entirely a host-side decision never communicated back to moxxie.
- **recommendation**: skip-cargo-cult as a *code* feature (moxxie has no task
  object to mark "done" on — that's the host's job, correctly, per the
  keyless design), but **adopt as SKILL.md prose**: moxxie should explicitly
  teach the host the browser-use discipline in text, since moxxie can't
  enforce it. This is the single cheapest, highest-leverage change available.
- **change**: Add to `handleSkill()`'s full-mode string
  (`handlers.ts:858-879`) a "loop discipline" paragraph: *"moxxie does not
  track your step budget or retry count — you must. Before retrying the same
  ref/action a 3rd time in a row, re-`snapshot` first; if a 4th attempt still
  fails, stop and report the blocker rather than continuing. If you exhaust
  your own step budget, save partial results and report what you found rather
  than truncating silently."* This directly ports browser-use's
  budget-warning (`service.py:1546-1558`, fires at 75% of `max_steps`) and
  forced-done (`service.py:1560-1582`) philosophy into words, since moxxie has
  no step counter to hook a mechanical trigger into.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `service.py:1560-1582`; moxxie `handlers.ts:858-879`
  (current `handleSkill`, no loop-discipline paragraph present).

### 3. No loop/repetition detector — P1, align (lightweight sidecar heuristic)
- **source_does**: `ActionLoopDetector` (`views.py:157-248`) hashes each
  action (name + normalized params) into a 20-item rolling window
  (`record_action`, `views.py:178-185`) and separately fingerprints page state
  to detect stagnant pages (`record_page_state`, `views.py:187-197`,
  `consecutive_stagnant_pages`). `get_nudge_message()` (`views.py:211-248`)
  escalates a **soft** text nudge at 5/8/12 repeats and at 5 stagnant pages —
  never blocks the action, purely informs the LLM. Injected every step via
  `_inject_loop_detection_nudge` (`service.py:1488-1496`).
- **moxxie_current**: moxxie already computes a page fingerprint per action
  (`settleAndFingerprint`, used throughout `handlers.ts`, e.g.
  `handleAct` line 426, `handleOpen` line 253) and returns `page_changed`/
  `stale_refs` on every act response (`handlers.ts:430-435`) — this is
  browser-use's stagnation signal, but only for the *current* call, not
  accumulated across calls. There is no action-repetition hash tracking at
  all.
- **recommendation**: adopt (align, keyless) — moxxie already has 80% of the
  primitive (fingerprinting); it just isn't accumulated into a rolling
  window or exposed as a nudge.
- **change**: Extend `UabState` with `recentActionHashes: string[]` (cap 20)
  and `stagnantCount: number`. In `handleAct` (`handlers.ts:387-440`), after
  computing `fp`, hash `verb+ref+value` (simple string, no crypto needed
  beyond existing `createHash` import already in the file) and push into the
  rolling window; if `!fp.page_changed`, increment `stagnantCount` else reset
  to 0. When the same hash appears ≥5 times in the window, or
  `stagnantCount >= 5`, add a `warning` to the envelope surfacing this to the
  host, mirroring browser-use's escalating language ("you've repeated this
  N times without the page changing — try a different approach"). Keep it
  purely additive to the existing envelope `warning` field
  (`envelope.ts:14-21` already supports `warning?`), never blocking — matches
  browser-use's explicit "soft detection... never blocks actions" design
  (`views.py:160-161`).
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `views.py:157-248`, `service.py:1488-1496`; moxxie
  `handlers.ts:412-439` (`settleAndFingerprint` call sites),
  `actuation/pagechange.ts` (fingerprint primitive, not accumulated).

### 4. `success=True` requires `is_done=True` invariant — P2, skip-cargo-cult (no moxxie equivalent object)
- **source_does**: `ActionResult` validator (`views.py:341-346`) rejects a
  model output that claims `success=True` without also setting
  `is_done=True` — prevents the LLM from claiming victory on an intermediate
  step.
- **moxxie_current**: moxxie's `Envelope` (`envelope.ts:10-15`) has
  `success`/`error`/`data`/`warning` but `success` means "did this CLI call
  itself execute without an internal fault," not "is the overall task done" —
  there's no `is_done` concept because moxxie never claims task completion,
  only per-command success.
- **recommendation**: skip-cargo-cult. This validator exists because
  browser-use's `success` field is overloaded to mean task-level outcome.
  moxxie's `success` is correctly scoped to command-level outcome and
  porting this invariant would conflate two different concepts moxxie
  deliberately keeps separate.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `views.py:341-346`; moxxie `envelope.ts:10-15`.

### 5. Separate connection-error vs logic-error handling paths — P2, adopt (align, cheap)
- **source_does**: `_handle_step_error` (`service.py:1250-1306`) branches
  hard: `InterruptedError` is swallowed as normal (not a failure,
  `service.py:1254-1258`); connection/browser-closed errors
  (`_is_connection_like_error`, `service.py:1308-1322`;
  `_is_browser_closed_error`, `service.py:1324-1339`) attempt a bounded
  reconnect wait and, if truly terminal, set `state.stopped = True` rather
  than counting toward `consecutive_failures` — i.e. infra failures don't
  burn the same failure budget as logic mistakes (wrong selector, bad param).
- **moxxie_current**: `handlers.ts` has no distinction — `ensureConnected`
  (`handlers.ts:120-128`) retries once by spawning a fresh session on any
  `connect()` throw, with no differentiation from action-level failures
  once inside `withConnection`. This is fine at moxxie's stateless-per-call
  granularity, but ties into finding #1: the proposed `consecutiveErrorCount`
  in the sidecar (finding 1) must NOT count connection-layer failures the
  same way as logic failures like `ref_stale`, or a flaky detached-browser
  respawn would trip the "you're stuck" nudge spuriously.
- **recommendation**: adopt (align) — fold into finding 1's implementation,
  not a separate mechanism.
- **change**: When implementing finding 1's counter, only increment
  `consecutiveErrorCount` for envelope failures on `retryableByHost: true`
  codes from `errors.ts` that are NOT connection/session-respawn related
  (i.e., don't count a transient `ensureConnected` respawn as a "failure" the
  host caused).
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `service.py:1250-1339`; moxxie `handlers.ts:120-141`
  (`ensureConnected`/`withConnection`).

### 6. Multi-action steps excluded from single-action failure counting — P2, skip-cargo-cult (moxxie has no multi-action steps)
- **source_does**: `service.py:1225-1230` deliberately only counts
  `consecutive_failures` for **single-action** steps; multi-action steps
  (browser-use lets one LLM turn queue up to `max_actions_per_step=5`
  actions) route failures through loop detection/replan nudges instead
  (comment at `service.py:1225-1226`).
- **moxxie_current**: moxxie's CLI is inherently one-verb-per-invocation —
  there is no multi-action batching concept in `handle()`'s dispatch
  (`handlers.ts:157-227`), so this distinction has no moxxie analog.
- **recommendation**: skip-cargo-cult. Nothing to port; the underlying
  problem (don't penalize batched actions the same as single retries) doesn't
  exist in a per-command CLI.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `service.py:1225-1230`; moxxie `handlers.ts:157-227`
  (one-verb-per-call dispatch, no batching).

### 7. Step-budget warning at 75% threshold — P1, adopt (as SKILL.md prose, same as finding 2)
- **source_does**: `_inject_budget_warning`-equivalent logic
  (`service.py:1533-1558`) fires once `steps_used/max_steps >= 0.75`,
  telling the LLM concretely to consolidate results and call `done` rather
  than exhaust the budget with nothing saved.
- **moxxie_current**: moxxie has no step counter (host owns the loop
  entirely) so this can't be mechanical; `handleSkill()`
  (`handlers.ts:858-879`) currently says nothing about budget management at
  all.
- **recommendation**: adopt (align, keyless, prose-only) — merge into the
  SKILL.md text change from finding 2.
  **This is the top overall recommendation**: it's a single text edit with
  zero implementation risk, directly closes moxxie's biggest structural gap
  (no in-process loop to hang a mechanical budget check on), and mirrors the
  exact language browser-use found necessary in production ("partial results
  are far more valuable than exhausting all steps with nothing saved",
  `service.py:1555`).
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `service.py:1533-1558`; moxxie `handlers.ts:858-879`.

### 8. Last-step tool restriction ("only done is available") — P2, skip-cargo-cult (moxxie has no tool-availability gating to restrict)
- **source_does**: `_force_done_after_last_step` (`service.py:1560-1569`)
  literally swaps `self.AgentOutput = self.DoneAgentOutput`, structurally
  removing every tool but `done` from the LLM's function-calling schema on
  the final step.
- **moxxie_current**: moxxie has no schema-level tool gating at the CLI layer
  — the host's tool definitions (e.g. an MCP wrapper around moxxie verbs)
  live entirely outside this source tree. moxxie can't "remove" a verb from
  its own CLI mid-session the way browser-use swaps a Pydantic schema,
  because moxxie isn't the one presenting tools to the model.
- **recommendation**: skip-cargo-cult for moxxie's CLI layer. If moxxie ships
  an MCP-server wrapper in the future, this pattern (restrict to
  read-only/report tools near a budget ceiling) would be worth revisiting
  there — but nothing to change in `handlers.ts` today.
- **keyless_ok**: true (would be, if built) — not applicable now
- **priority**: P2
- **evidence**: source `service.py:1560-1569`; moxxie has no MCP/tool-schema
  layer under `src/core`.

## Top recommendation

Combine findings 2 and 7 into one SKILL.md edit to `handleSkill()`'s
`full`-mode string in `handlers.ts:858-879`: add a short "loop discipline"
paragraph teaching the host (a) to re-snapshot rather than blind-retry after
2 consecutive failures on the same ref/action, (b) to stop and report a
blocker rather than retry indefinitely, and (c) to consolidate/report partial
results once it senses its own step budget running low, since moxxie itself
has no step counter to enforce this mechanically. This is the cheapest,
zero-risk, highest-leverage port from browser-use's loop discipline into a
100% keyless CLI that structurally cannot own the loop itself. Findings 1 and
3 (sidecar-based consecutive-failure and repetition counters surfaced as
envelope `warning`s) are the natural follow-up: they let moxxie start
*mechanically* nudging the host instead of relying purely on prose the host
may forget to follow.
