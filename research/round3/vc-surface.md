# vercel/agent-browser vs moxxie: verb/flag surface gap (tab/frame/network/dialog/pdf)

Lens: full verb/flag surface comparison. Source read: `reference/agent-browser/cli/src/commands.rs`
(parser), `reference/agent-browser/cli/src/native/actions.rs` (dialog runtime behavior).
Moxxie read: `skill/agent-browser/src/core/handlers.ts` (dispatch + all handlers),
`skill/agent-browser/src/core/flags.ts` (flag surface), `skill/agent-browser/src/core/session.ts`
(page/context lifecycle), `skill/agent-browser/src/perception/walk.ts` (snapshot tree walk).

Ground truth on moxxie's current posture: `handlers.ts:218-224` routes `tab`, `frame`, `network`,
`dialog`, `pdf` straight to `notImplemented()` ("not implemented in v1" — honestly stubbed, never
faked). `flags.ts` has zero flags for any of these five verbs. `session.ts:210` always takes
`context.pages()[0] ?? newPage()` — there is no concept of a second tab anywhere in the session
model. `walk.ts` hardcodes `frameId: 'main'` (line 245) and never calls `contentFrame()` /
`childFrames()` — iframes are structurally invisible to snapshot.

All five are Playwright-native capabilities (`page.context().newPage()`, `page.on('dialog')`,
`page.route()`/`page.on('request')`, `frame.locator()`, `page.pdf()`) — nothing here requires a
model call. Every finding below is keyless.

## Findings

### 1. `tab` — no multi-tab support at all (P0, adopt)
- **Source**: `commands.rs:1480-1524` — `tab new [url] [--label <name>]`, `tab list`, `tab close
  [tabId]`, `tab <tabId>` (bare ref switches), `tab` alone defaults to `tab list`.
- **Moxxie now**: `session.ts:210` pins to `pages()[0]` permanently; `handlers.ts:219-224` stubs
  `tab` as not-implemented. Any page that opens `target="_blank"` (OAuth popups, "open in new tab"
  links, payment redirects) leaves moxxie's snapshot/act loop stuck on the original (now
  background) tab with no way to reach the new one.
- **Change**: add a `tabs: Page[]` + `activeTabIndex` to the session sidecar (or track via
  `context.pages()` directly since Playwright already owns the list). Implement `handleTab` in
  `handlers.ts`: `tab new [url]` → `context.newPage()` (+goto if url given), `tab list` → enumerate
  `context.pages()` with url/title, `tab close [n]` → close by index, `tab <n>` → set active index
  used by `withConnection`'s page resolution. Add `tab`/`tabId`/`label` flags to `flags.ts`.
- **Priority**: P0 — this is the single biggest functional hole; agent flows that trigger a new
  tab currently have no recovery path at all.

### 2. `dialog` — no `page.on('dialog')` handler anywhere (P0, adopt)
- **Source**: `native/actions.rs:317-328,578-628` — agent-browser installs a background dialog
  handler by default (`auto_dialog: true`): `alert` and `beforeunload` dialogs are auto-accepted
  so they never block the agent; `confirm`/`prompt` dialogs are captured as `pending_dialog` and
  wait for an explicit `dialog accept [text] | dialog dismiss [text] | dialog status`
  (`commands.rs:1560-1585`).
- **Moxxie now**: no `page.on('dialog', ...)` listener exists anywhere in `session.ts` or
  `handlers.ts`; `dialog` verb is stubbed `notImplemented()`. Playwright's undocumented-but-real
  default when no listener is registered is to auto-**dismiss** every dialog (alert included) —
  so an `alert()` a page throws mid-flow is silently swallowed, and a `confirm()` guarding a
  destructive action is always answered "cancel" with no way for the agent to say otherwise. This
  is silent, non-obvious behavior difference from what a human tester using a real browser sees.
- **Change**: in `session.ts`'s connect/open path, register a `page.on('dialog', ...)` handler
  that auto-accepts `alert`/`beforeunload` (log to session state so the agent can see it happened)
  and stashes `confirm`/`prompt` dialogs as pending (blocking act calls with a clear
  `dialog_open` fail code, mirroring moxxie's existing "never guess, fail loudly" philosophy from
  the refmap generation-check). Add `handleDialog` in `handlers.ts` for
  `dialog accept [text] | dismiss | status`, plus `dialog`/`response`/`promptText` flags.
- **Priority**: P0 — right now moxxie either hangs (if Playwright *did* wait) or silently mis-answers
  every confirm dialog it hits; both are worse than an honest stub because the agent doesn't know
  it happened.

### 3. `frame` — snapshot never descends into iframes (P0, adopt)
- **Source**: `commands.rs:1547-1557` — `frame main` returns to the top frame, `frame <selector>`
  scopes subsequent commands to a named iframe.
- **Moxxie now**: `walk.ts:245` hardcodes `frameId: 'main'` on every node; there is no
  `contentFrame()` / `childFrames()` traversal anywhere in the perception layer. Payment forms
  (Stripe Elements), OAuth embeds, and many WYSIWYG editors live inside iframes — moxxie's
  `snapshot` simply cannot see or ground refs to elements inside them today, and `act`/`get`/`is`
  have no way to target them either.
- **Change**: extend `snapshotNodes` (`walk.ts`) to optionally recurse into same-origin (and, best
  effort, cross-origin) iframes, tagging real per-frame IDs instead of the constant `'main'`, and
  add a `frame <selector>|main` verb in `handlers.ts` that scopes the *next* command's page
  resolution to `page.frameLocator(selector)` (stored in session state, cleared by `frame main` or
  navigation). This is the highest-leverage of the five for real-world form-filling tasks.
- **Priority**: P0 — silent capability gap, not just a missing verb; every other handler is
  already frame-blind.

### 4. `network route`/`unroute` — no request interception (P1, adopt)
- **Source**: `commands.rs:2886-2909` — `network route <url> [--abort] [--body <json>]
  [--resource-type <csv>]`, `network unroute [<url>]`, backed by Playwright's `page.route()`.
- **Moxxie now**: stubbed. There is no way for an agent to block ad/tracker requests that hang a
  test page, or to mock an API response to test a UI state without a live backend.
- **Change**: implement `handleNetwork` sub-verb `route`/`unroute` wrapping
  `page.route(url, handler)` / `page.unroute(url)` directly — no model needed, this is literally a
  1:1 wrapper over an existing Playwright primitive. Store active routes in session state so
  `unroute` without args can clear all.
- **Priority**: P1 — useful but narrower audience than tab/dialog/frame.

### 5. `network requests`/`request <id>` — no request/response log (P1, adopt)
- **Source**: `commands.rs:2916-2937` — `network requests [--filter --type --method --status
  --clear]` lists a ring-buffer of observed requests; `network request <id>` returns one in full
  (headers/body/timing).
- **Moxxie now**: stubbed; nothing listens to `page.on('request')`/`page.on('response')` at all,
  so an agent debugging "why did my form submit fail" has zero visibility into the network layer
  beyond a screenshot.
- **Change**: add a bounded (e.g. last 200) in-memory ring buffer populated by
  `page.on('requestfinished')`/`page.on('requestfailed')` listeners installed alongside the dialog
  handler in `session.ts`; expose via `network requests [--filter --type --method --status
  --clear]` and `network request <id>` in `handlers.ts`. Keep responses capped by
  `capOutput`/content-boundary treatment (same injection defense already used for
  `presentPageText`) since response bodies are untrusted page-originated content.
- **Priority**: P1.

### 6. `network har start/stop` — skip full HAR fidelity (skip-cargo-cult)
- **Source**: `commands.rs:2905-2916` wraps a full HAR recorder (`har start`/`har stop <path>`).
- **Assessment**: Playwright's real HAR recording is fixed at context-creation time
  (`recordHar` option), not dynamically start/stop-able mid-session without relaunching the
  context — agent-browser's Rust CDP client can do this live because it drives raw CDP
  `Network.*` events itself, which is exactly the kind of heavyweight native-runtime machinery
  moxxie deliberately avoided by building on Playwright. Reimplementing true HAR semantics
  (redirect chains, timing breakdowns, postData capture matching the HAR 1.2 spec) purely to
  match agent-browser's surface is bloat for a keyless CLI whose actual consumer is an LLM reading
  text, not a HAR viewer.
- **Recommendation**: **skip** dedicated `har start/stop`. Finding #5's ring-buffer JSON already
  gives the host agent everything it needs (method/status/type/timing) in a much cheaper form. If
  a real `.har` file is ever needed, tell the operator to relaunch the session with
  `recordHar` wired into `session.ts`'s context creation — not worth a stateful start/stop verb.

### 7. `pdf <path>` — trivial, missing (P1, adopt)
- **Source**: `commands.rs:845-850` — `pdf <path>` wraps `page.pdf({ path })`.
- **Moxxie now**: stubbed as `notImplemented()`, despite `session.ts:103` already launching
  chromium headless by default (`--headless=new`) — the one precondition `page.pdf()` needs
  (headless chromium; PDF export is chromium-only in Playwright, unsupported in headed/other
  browsers, but moxxie only ever drives chromium and defaults headless).
  This is the cheapest of all seven findings to close.
- **Change**: add `handlePdf` in `handlers.ts` calling `withConnection(flags, ({page}) =>
  page.pdf({ path: flags.args[0] }))`, mirroring the existing `handleScreenshot` shape almost
  exactly (`handlers.ts:372-381`). No new flags needed beyond the existing positional arg pattern.
- **Priority**: P1 — small effort, real capability, near-zero risk (it's an isolated code path
  that can't destabilize the existing perception/actuation core).

### 8. `window new` — skip (skip-cargo-cult)
- **Source**: `commands.rs:1526-1539` — a separate `window new` verb from `tab new`, spawning a
  new OS-level browser window rather than a new tab in the same context.
- **Assessment**: this distinction matters for agent-browser's native CDP/webdriver multi-window
  automation (its use cases include cross-window drag/drop, multi-monitor testing) but moxxie's
  session model is single-context, single-purpose-per-invocation CLI calls; a second *window* adds
  no capability over a second *tab* for a headless, keyless snapshot-and-act loop, and multiplies
  the state-tracking surface (`activeTabIndex` would need a window dimension too) for no
  corresponding benefit to an LLM driving it via text.
- **Recommendation**: skip. Fold any legitimate "window" need into finding #1's `tab new` (which
  already covers "give me a fresh page to work in").

## Bottom line
The five stubbed verbs are not equally urgent. `tab`, `dialog`, and `frame` (#1-3) are silent
capability gaps that make whole classes of real pages (popups, confirm-guarded destructive
actions, iframe-embedded forms) either invisible or subtly mishandled by moxxie today — these are
P0. `network route/requests` (#4-5) and `pdf` (#7) are net-new, additive capabilities with no
correctness risk to the existing core — P1, cheap wins. `network har` and `window` are the two
places where matching agent-browser's exact surface would be cargo-cult: HAR needs a raw-CDP
runtime moxxie deliberately doesn't have, and `window` is a distinction without a difference for a
snapshot-and-act keyless loop.
