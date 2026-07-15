# Stagehand act()/observe() method-map vs moxxie actuation/actions.ts

Source read: `packages/core/lib/v3/handlers/actHandler.ts`,
`packages/core/lib/v3/handlers/handlerUtils/actHandlerUtils.ts` (the
`METHOD_HANDLER_MAP` + `performUnderstudyMethod`).
Moxxie read: `skill/agent-browser/src/actuation/actions.ts`,
`skill/agent-browser/src/actuation/resolve.ts`,
`skill/agent-browser/src/security/registry.ts`,
`skill/agent-browser/src/core/handlers.ts`,
`skill/agent-browser/src/core/errors.ts`,
`skill/agent-browser/src/actuation/pagechange.ts`,
`skill/agent-browser/src/security/redact.ts`.

Framing: stagehand's `act()` is LLM-inference (instruction → element+method+args)
+ a deterministic dispatch table (`METHOD_HANDLER_MAP`). Moxxie has no
inference step by design — the host LLM already supplies verb+ref+value — so
this lens compares the two **dispatch tables**, not the inference layer. The
inference-only pieces (twoStep planning, LLM self-heal) are out of scope for a
keyless CLI and are marked skip.

## Findings

### 1. No page-level scroll primitives — only element scrollIntoView (P0, keyless)
- **Source**: `METHOD_HANDLER_MAP` (actHandlerUtils.ts:124-144) has
  `scrollTo`/`scroll` (scroll element to a Y percentage,
  `scrollElementToPercentage`, line 186), `scrollByPixelOffset` (page scroll by
  dx/dy from an element's centroid, line 205), `mouse.wheel` (raw wheel event,
  line 221), `nextChunk`/`prevChunk` (scroll by one viewport/element height,
  `scrollByElementHeight`, line 437).
- **Moxxie now**: `actions.ts` `applyVerb` case `'scroll'` (line 292-294) does
  exactly one thing: `locator.scrollIntoViewIfNeeded()`. There is no
  page-level "scroll down N px" or "scroll to 50%" or "page down one
  viewport" primitive anywhere in `actuation/`.
- **Recommendation**: adopt. A host LLM reading an infinite-scroll feed or a
  long article has no way to ask moxxie "scroll down a viewport" without
  first snapshotting to find a scrollable ref and using scrollIntoView on an
  element that happens to be at the target position — clunky and sometimes
  impossible (nothing to point a ref at, e.g. `document.body` scroll on a
  page with no far-down interactive elements).
- **Change**: extend `ActVerb` in `actions.ts` with `scrollPage` (or overload
  `scroll` when `ref` is the special value `page`/`body`) taking a
  `{ direction: 'down'|'up', amount: 'viewport'|number }` option, dispatched
  via `page.mouse.wheel(0, dy)` or `page.evaluate` scrollBy — no CDP hand-rolling
  needed since Playwright's `page.mouse.wheel` already exists. Keep
  `scrollIntoViewIfNeeded` as-is for the ref-anchored case.
- keyless_ok: true — pure Playwright.
- **evidence**: actHandlerUtils.ts:124-144,186-219,437-493 vs actions.ts:292-294.

### 2. `keyboard`/`mouse` verbs are registered but unimplemented dead code (P0, keyless)
- **Source**: stagehand's `pressKey` handler (actHandlerUtils.ts:278-306) calls
  `page.keyPress(key)` — a **page-level** key press, not scoped to an
  element. `wheelScroll` (line 221) is a page-level `Input.dispatchMouseEvent`
  wheel event.
- **Moxxie now**: `security/registry.ts` lists `'keyboard'`, `'keydown'`,
  `'keyup'`, and `'mouse'` in `ACTOR_VERBS` (lines 68-70ish), implying they're
  meant to be actionable verbs — but `core/handlers.ts`'s `handle()` switch
  (lines 220-226) routes all of them to `notImplemented()`. Moxxie's only
  `'press'` verb (`actions.ts` line 276-278) is `locator.press(value)`, which
  requires a live ref/element to target and cannot send a global key (e.g.
  `Escape` to close a modal with no obvious focus target, or `Tab` to move
  focus before an unrelated snapshot).
- **Recommendation**: adopt (close the gap the registry already promises).
  Either implement `keyboard` verb as `page.keyboard.press(key)` (no ref
  needed) and `mouse` as `page.mouse.wheel/move/click(x,y)`, or remove the
  dead registry entries so the tool surface doesn't advertise capabilities
  that 404. Silently promising unimplemented verbs is worse than not listing
  them — an agent that tries `keyboard Escape` gets a generic
  "not implemented" with no better path.
- **Change**: `core/handlers.ts` — add `case 'keyboard': return handleKeyboard(flags)`
  dispatching to a new `keyboardPress(page, key)` in `actions.ts` (or a
  sibling module) using `page.keyboard.press`. Cheapest fix if scope is tight:
  at minimum delete `'keyboard'`/`'mouse'`/`'keydown'`/`'keyup'` from
  `ACTOR_VERBS` until implemented, so `--enable-actions` doesn't lie about the
  verb surface.
- keyless_ok: true.
- **evidence**: actHandlerUtils.ts:278-306,221-237 vs registry.ts ACTOR_VERBS list + handlers.ts:220-226 (`notImplemented()`).

### 3. `click` has no button/modifier option (right-click, middle-click) (P1, keyless)
- **Source**: `clickElement` (actHandlerUtils.ts:308-327) reads
  `args[0] as MouseButton` and passes `{ button }` to the locator click — the
  LLM can emit `click` with `right`/`middle` as an arg for context-menu or
  new-tab flows.
- **Moxxie now**: `applyVerb` case `'click'` (actions.ts:258-260) calls
  `locator.click(withForce(opts))`, and `withForce` (line 328-333) only
  forwards `force`/`timeout` — there is no `button` or `modifiers` field on
  `ActOptions` at all, so a host cannot right-click even though
  `locator.click({ button: 'right' })` is one Playwright arg away.
- **Recommendation**: adopt — trivial, high value (right-click context menus,
  ctrl/cmd+click to open in new tab are common agent tasks).
- **Change**: `actions.ts` — add `button?: 'left'|'right'|'middle'` and
  `modifiers?: ('Alt'|'Control'|'Meta'|'Shift')[]` to `ActOptions`, thread
  through `withForce` (or a new `withClickOpts`) into the `click`/`dblclick`
  cases.
- keyless_ok: true.
- **evidence**: actHandlerUtils.ts:308-327,5 (`MouseButton` type) vs actions.ts:45-56,258-260,328-333.

### 4. No secret-safe variable substitution for `fill`/`type` values (P1, keyless)
- **Source**: `substituteVariablesInArguments` (actHandler.ts:518-534) replaces
  `%key%` tokens in action arguments against a `variables` map supplied
  out-of-band, so the literal secret value need not be echoed by the LLM in
  its own JSON action — it only ever emits the token.
- **Moxxie now**: `security/redact.ts` already solves the **read** side
  (a password/card-shaped value is never emitted in a snapshot). There is no
  symmetric **write** side: `act(..., value, ...)` in `actions.ts` takes
  `value` literally and passes it straight to `fillVerb`/`applyVerb` — a host
  wanting to fill a password field must pass the raw secret as a CLI arg
  (visible in shell history / process list / any command logging moxxie's own
  callers might do).
- **Recommendation**: adopt, staying keyless — moxxie already reads env for
  config elsewhere; extend that pattern. Support `value: "%VAR_NAME%"` that
  resolves against `process.env.MOXXIE_VAR_<NAME>` (or a `--var-file`) inside
  the CLI process, never passed through the host's own arg — this is a real
  security win reachable with zero model calls, purely local string
  substitution mirroring `redact.ts`'s existing pattern.
- **Change**: new `resolveVariables(value: string): string` in
  `security/redact.ts` (or a sibling `security/variables.ts`), called from
  `act()` in `actions.ts` before `dispatch()` is invoked for `fill`/`type`.
- keyless_ok: true.
- **evidence**: actHandler.ts:518-534,28 (`resolveVariableValue`) vs redact.ts:1-54, actions.ts:124-155 (no substitution point today).

### 5. Manual cross-frame drag via centroid math — skip-cargo-cult
- **Source**: `dragAndDrop` (actHandlerUtils.ts:348-423) manually computes
  element centroids, walks the frame-owner chain to convert to main-viewport
  absolute coordinates, then dispatches a raw mouse drag via CDP — because
  stagehand built its own low-level driver ("Understudy") instead of using
  Playwright.
- **Moxxie now**: `dispatch()` `'drag'` case (actions.ts:235-242) is
  `locator.dragTo(target, withForce(opts))` — one Playwright call that already
  handles cross-frame coordinate translation and actionability internally.
- **Recommendation**: skip-cargo-cult. Moxxie's version is strictly simpler
  and already correct because it sits on top of real Playwright; porting
  stagehand's manual centroid/CDP code would be a regression in code size and
  risk for zero behavioral gain.
- keyless_ok: n/a (no change recommended).
- **evidence**: actHandlerUtils.ts:348-423 vs actions.ts:235-242.

### 6. LLM self-heal retry on action failure — skip-cargo-cult (re-express only)
- **Source**: `takeDeterministicAction`'s catch block (actHandler.ts:333-432)
  reruns a fresh snapshot + LLM inference to get a new selector and retries
  once when `selfHeal` is enabled — an actual model call mid-action.
- **Moxxie now**: two keyless mechanisms already cover most of the same
  ground without a model call: (a) `resolve.ts`'s SLOW PATH
  (comment block lines 1-26, re-match by role/name/nth over a fresh bounded
  snapshot before giving up — this *is* a keyless self-heal), and (b)
  `core/errors.ts`'s `ERRORS` table encodes the recovery instruction directly
  in the error message (`element_not_found` → "re-snapshot and pick a ref
  from the current tree", `retryableByHost: true`), pushing the retry
  decision to the host LLM instead of doing it inside the CLI.
- **Recommendation**: skip-cargo-cult as a literal port (would require a
  model call inside moxxie, violating the keyless invariant). Moxxie's
  existing split — deterministic re-match locally, semantic retry pushed to
  the host — is the correct keyless analogue and is already implemented; no
  change needed beyond confirming `resolve.ts`'s slow path is exercised by
  `act()`'s error path (it is, via `toLocator` at actions.ts:140).
- keyless_ok: false for a literal port; true for the already-adopted keyless
  analogue (no further action).
- **evidence**: actHandler.ts:333-432 vs resolve.ts:1-26 + errors.ts:17-21.

### 7. `twoStep` multi-action planning inside act() — N/A, skip
- **Source**: `act()` (actHandler.ts:196-266) lets the LLM mark a response
  `twoStep: true`, triggering a second inference+dispatch round (e.g. open a
  dropdown, then pick an option) inside one `act()` call.
- **Moxxie now**: no equivalent, by design — moxxie has no inference layer at
  all, and multi-step sequencing is the host's job (it issues `click` then
  `select` as two separate CLI invocations, re-snapshotting the `page_changed`
  flag from `pagechange.ts` in between).
- **Recommendation**: skip. This is inherent to stagehand's LLM-driven act()
  loop and has no keyless form — moxxie's per-verb dispatch + `page_changed`
  flag (`pagechange.ts` lines 25-34) already gives the host everything it
  needs to sequence multi-step interactions itself.
- keyless_ok: false (requires the model call this exists to avoid); no change.
- **evidence**: actHandler.ts:196-266 vs pagechange.ts:25-34.

### 8. `fill` verify+fallback — moxxie already ahead, no change
- **Source**: `fillOrType` (actHandlerUtils.ts:239-257) is `fill('')` then
  `fill(value)`, no readback verification.
- **Moxxie now**: `fillVerb` (actions.ts:305-315) fills, reads back
  `inputValue()`, and on mismatch falls back to `pressSequentially` character
  input for stubborn controlled-React inputs, returning the verified value in
  `ActResult.value`.
- **Recommendation**: skip-cargo-cult (nothing to adopt) — moxxie's fill is
  strictly more robust than stagehand's here; flagging for completeness so a
  future pass doesn't "fix" this into stagehand's weaker version.
- keyless_ok: true; no change.
- **evidence**: actHandlerUtils.ts:239-257 vs actions.ts:305-315.

## Top recommendation

Adopt finding #1 (page-level scroll primitives) first: it is the single
capability an agent hits most often that moxxie's current dispatch table
structurally cannot express (there is no ref to scroll-into-view on an
infinite-scroll feed, a long article, or a chat log), it's pure Playwright
(`page.mouse.wheel` / `page.evaluate` scrollBy — no new dependency, no CDP
hand-rolling), and it directly closes the same coverage gap stagehand needed
five separate method-map entries to solve (`scrollTo`, `scrollByPixelOffset`,
`mouse.wheel`, `nextChunk`, `prevChunk`).
