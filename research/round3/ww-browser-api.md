# webwright vs moxxie — Browser API/Environment surface (Lens: exact Playwright wrapper exposed to the model)

Source read: `reference/webwright/src/webwright/environments/local_browser.py` (the `LocalBrowserEnvironment`
class — `prepare()`/`_prepare_async()`/`execute()`/`_run_python_code()`/`_capture_observation()`),
`reference/webwright/src/webwright/tools/persistent_local_browser.py`, and
`reference/webwright/src/webwright/config/{base,crafted_cli,persistent_browser,task_showcase}.yaml`
(the "hard rules" baked into every agent prompt).

Moxxie read: `skill/agent-browser/src/actuation/actions.ts`, `.../wait.ts`, `.../pagechange.ts`,
`skill/agent-browser/src/core/handlers.ts`, `skill/agent-browser/src/core/session.ts`.

## Framing: webwright's "API" is not a verb set — it's raw Playwright

webwright does not expose click/fill/etc. as named tools at all. Each agent step is a
`python_code` string that gets wrapped in `async def __agent_step__(page, context, browser,
playwright, task): <code>` and `exec()`'d directly (`local_browser.py:432-450`,
`_run_python_code`). The model gets the *entire* Playwright API, unrestricted — arbitrary
`evaluate`, route interception, multi-tab, dialogs, downloads, emulation — "for free," at the
cost of zero grounding/safety guarantees (no ref-staleness check, no confirm gate, no egress
allowlist, no injection neutralization — moxxie's actuation.ts / resolve.ts / security/*
literally do not exist in webwright's model). That's the register this lens compares against:
not verb-for-verb parity, but which *capabilities* webwright gets "for free" that moxxie's
closed verb set has left as `notImplemented()`, plus which *environment defaults* webwright
learned the hard way (repeated as identical hard rules across 4 separate config YAMLs) that
moxxie hasn't encoded at all.

## Findings

### 1. No default viewport — moxxie launches Chromium with no window/viewport size at all (P0)
- **source_does**: Every one of webwright's configs sets an explicit, identical viewport —
  `context = await browser.new_context(viewport={"width": 1280, "height": 1800})`
  (`config/base.yaml:143`, `config/task_showcase.yaml:139`) or
  `page.set_viewport_size({"width": 1280, "height": 1800})` (`config/crafted_cli.yaml:121`,
  `config/persistent_browser.yaml:148`). This is stated as a load-bearing convention, not an
  accident — it exists precisely so screenshots/snapshots are reproducible across runs.
- **moxxie_current**: `session.ts:openSession()` spawns Chromium with only
  `--remote-debugging-port`, `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`,
  `--disable-session-crashed-bubble`, and `--headless=new` — no `--window-size`, and
  `handlers.ts` never calls `context.setViewportSize` or passes `viewport` when connecting.
  Verified: `grep -i viewport session.ts handlers.ts` returns nothing.
- **recommendation**: adopt
- **change**: in `session.ts:openSession`, add `--window-size=1280,1800` (or comparable) to the
  launch `args`, and in `handleOpen`/`ensureConnected` (`handlers.ts`) call
  `page.setViewportSize({ width: 1280, height: 1800 })` once per session on first connect so
  headless Chromium's default (browser-version-dependent, historically ~800x600) never leaks
  into snapshots/screenshots and text-wrap widths stay stable across Chromium upgrades.
- **keyless_ok**: true
- **priority**: P0

### 2. No console/page-error capture anywhere in the command surface (P1)
- **source_does**: `_attach_page_listeners` (`local_browser.py:370-385`) wires
  `page.on("console", ...)` and `page.on("pageerror", ...)` once at prepare time; every single
  step's observation includes `console_output` (last 20 lines from *this* step) and
  `recent_console` (last 50 lines overall) (`_capture_observation`, lines 491-501). This is
  webwright's primary signal for "did my click silently throw a JS error."
- **moxxie_current**: `handlers.ts`'s `handle()` switch has no `console` case at all — it isn't
  even in the `notImplemented()` stub list alongside `tab`/`frame`/`network`/`dialog`/`pdf`
  (lines 219-224), it just falls through to the `default: return notImplemented()`. There is no
  `page.on('console', ...)` or `page.on('pageerror', ...)` listener anywhere in
  `actions.ts`/`handlers.ts`.
- **recommendation**: adopt
- **change**: add a `moxxie console` verb (and, cheaper, stamp console/pageerror activity onto
  every `act`/`wait` envelope the way `page_changed`/`stale_refs` are stamped in
  `handleAct`, `handlers.ts:412-439`). Concretely: in `withConnection` (`handlers.ts:131-141`),
  attach `page.on('console', ...)`/`page.on('pageerror', ...)` for the duration of the
  connection, collect messages, and return them as `console: string[]` on the envelope when
  non-empty. Full session-spanning history isn't achievable with moxxie's
  connect-per-command daemon model (webwright's process stays attached; moxxie's detaches after
  each command — see session.ts header comment), so scope this per-command rather than
  session-lifetime; that's still a strict improvement over the current zero.
- **keyless_ok**: true
- **priority**: P1

### 3. Multi-tab handling is a stub; Playwright gives it for free (P1)
- **source_does**: because webwright hands the model raw `context`, multi-tab "just works":
  the model can write `context.pages`, `await context.new_page()`, `page.bring_to_front()`
  directly in a step (`config/crafted_cli.yaml:120`: `page = context.pages[0] if context.pages
  else await context.new_page()`).
- **moxxie_current**: `handlers.ts:219-224` — `case 'tab': ... return notImplemented()`. No
  tab-list/new/switch/close verb exists, and there's no session-state field tracking "which page
  in `context.pages()` is active" in `UabState` (`handlers.ts:66-81`).
- **recommendation**: adopt
- **change**: implement `moxxie tab list|new|switch <n>|close [n]` in `handlers.ts` using
  `context.pages()`, `context.newPage()`, and `page.bringToFront()`; persist the active tab
  index in `moxxie-state.json` (extend `UabState`) so subsequent `snapshot`/`act` calls target
  the right page after a `tab switch`. This is a common real-world task shape (open link in new
  tab, compare two pages) that moxxie currently cannot do at all.
- **keyless_ok**: true
- **priority**: P1

### 4. Dialog handling is a stub; Playwright auto-dismisses silently by default (P1)
- **source_does**: webwright's raw-code model lets the agent attach a dialog handler ad hoc
  per step (`page.on("dialog", lambda d: d.accept())`) whenever a task needs it — nothing
  structural, but the capability exists because nothing blocks it.
- **moxxie_current**: `handlers.ts:219-224` — `case 'dialog': ... return notImplemented()`.
  Playwright's default behavior with no `dialog` listener attached is to **auto-dismiss**
  `alert`/`confirm`/`prompt`/`beforeunload` dialogs, which can silently eat form submissions
  or navigation-guard prompts with no signal to the host at all — worse than webwright's status
  quo, not just absent.
- **recommendation**: adopt
- **change**: implement a minimal `moxxie dialog accept|dismiss [--text <value>]` verb in
  `handlers.ts` that attaches a one-shot `page.on('dialog', ...)` handler before the wrapped
  action runs (mirrors the `act` verb's grounding-then-dispatch shape in `actuons.ts`), and at
  minimum surface `last_dialog: { type, message } | null` on the action envelope so the host
  knows a dialog fired even if it wasn't handled.
- **keyless_ok**: true
- **priority**: P1

### 5. No raw-evaluate escape hatch for read-only queries (P2)
- **source_does**: because the model writes raw code, arbitrary `page.evaluate(...)` (scroll
  position, computed style, canvas/WebGL feature checks, `localStorage` reads) is available
  with zero extra surface.
- **moxxie_current**: `get` (`handlers.ts:462-509`) covers `title|url|count|text|value|attr`
  only — a fixed enum. There is no `moxxie get eval <js-expression>` or `moxxie eval` verb;
  anything outside that enum (e.g. "is this element's computed `display` none," "what's
  `window.scrollY`") is currently unreachable from the CLI.
- **recommendation**: adopt (narrowly) / skip-cargo-cult (the general case)
- **change**: adopting webwright's *general* code-exec model would be cargo-cult for a keyless
  CLI — it reintroduces exactly the unguarded-actuation surface moxxie's `actuation/actions.ts`
  module doc explicitly rejects (no grounding gate, no confirm gate, no injection
  neutralization) and turns moxxie into an arbitrary-code sandbox with no sandboxing. Instead,
  add one narrow, read-only case: `moxxie get eval <js-expression>` that runs
  `page.evaluate(expr)` read-only (no `--enable-actions` requirement, since it can't mutate DOM
  state through the actuation path), JSON-stringifies the result, and passes it through the
  same `presentPageText`/`capOutput`/`neutralize` pipeline every other text output already uses
  (`handlers.ts:148-151`). This rounds out `get`/`is` for the long tail without opening a
  general code-exec door.
- **keyless_ok**: true
- **priority**: P2

### 6. Full-page screenshots are a known-bad default — moxxie already avoids it but doesn't say why (P2)
- **source_does**: all four webwright configs repeat, verbatim, a "HARD RULE": *"Always Avoid
  taking full page screenshot using Playwright, use viewport 1280x1800... Never do
  `page.screenshot(full_page=True)`"* (`config/base.yaml:194`, `config/persistent_browser.yaml:
  201-205`, `config/task_showcase.yaml:199`, `config/crafted_cli.yaml` viewport comment at
  line 121). The fact that this exact warning is duplicated in every config is strong evidence
  it came from a real eval failure mode (huge/garbled full-page captures breaking downstream
  judges).
- **moxxie_current**: `handleScreenshot` (`handlers.ts:372-381`) already defaults
  `fullPage: flags.full` where `flags.full` is opt-in — so moxxie's *default* is already
  correctly aligned (better than needing a prompt rule to enforce it). But `handleSkill`'s
  advertised skill text (`handlers.ts:858-879`) never mentions the `--full` footgun, so a host
  reaching for "give me the whole page" will reach for `--full` without knowing it's the exact
  thing webwright's operators learned to avoid.
- **recommendation**: adopt (documentation only)
- **change**: add one line to `handleSkill`'s `--full` output (or the `--full` flag's own
  description in `flags.ts`) noting that full-page screenshots can be slow/huge/unreliable on
  long or infinite-scroll pages and that the default viewport screenshot is preferred unless the
  host specifically needs full-page context.
- **keyless_ok**: true
- **priority**: P2

## Explicitly skip-cargo-cult

- **Raw-code-exec as the primary action model.** webwright's entire loop is "the model writes
  Playwright Python and we `exec()` it." Adopting this wholesale for moxxie would delete every
  safety property moxxie's actuation layer is built around: the ref-grounding gate in `act()`
  (`actions.ts:124-155`, "a stale ref must fail before we touch the page"), the confirm gate
  (`requiresConfirm`/`confirmGateDecision`, `handlers.ts:396-403`), and the egress/injection
  guards (`assertNavigable`, `neutralize`/`capOutput`). It would also make moxxie's whole
  envelope/error-code contract (`ErrorCode`, `Envelope<T>`) meaningless since arbitrary code
  can throw anything. Finding 5 above extracts the one legitimately useful sliver
  (read-only `evaluate`) without the rest.
- **The `python_code`-per-step wrapper/exec harness itself** (`_run_python_code`,
  `local_browser.py:432-450`) — this is webwright's *agent loop* mechanism, not a browser
  capability; irrelevant to moxxie's stateless-CLI-per-command shape.
- **`step_execution_timeout_ms` as a global code-block watchdog** (`LocalBrowserEnvironmentConfig`,
  line 167) — this exists because webwright must bound an *arbitrary, multi-statement* code
  block. moxxie's one-verb-per-command model doesn't have that failure mode; Playwright's
  per-locator timeout (`flags.timeout`, already threaded through `ActOptions`/`WaitSpec`) is the
  right-sized equivalent and is already present.
- **Bounded best-effort observation settle** (`_wait_for_observation_ready`,
  `local_browser.py:452-461`) — moxxie already has an equivalent, arguably better-designed
  version (`settleAndFingerprint`/`fingerprintAfterSettle`, `pagechange.ts:57-83`: bounded
  `domcontentloaded` + a 1.2s network-idle race, always best-effort via `.catch(() => {})`).
  No change needed here — flagging so it isn't mistakenly re-built.
