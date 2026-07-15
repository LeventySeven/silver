# browser-use watchdogs vs moxxie — downloads/permissions/crash/dialog

Source read: `browser_use/browser/watchdogs/{downloads,crash,popups,permissions,aboutblank}_watchdog.py`
Moxxie read: `skill/agent-browser/src/core/handlers.ts`, `skill/agent-browser/src/core/session.ts`,
`skill/agent-browser/src/actuation/{actions,pagechange}.ts`

## Headline

browser-use runs a persistent event-bus process with five always-on watchdogs covering the
"page does something weird" surface. moxxie is a connect→act→disconnect CLI with **zero**
coverage of JS dialogs, downloads, or native permission prompts, and only reactive (string-match
on a thrown error) crash detection. This is the single biggest robustness gap surfaced by this
lens: an agent driving moxxie today can silently get a `confirm()` auto-dismissed, a file download
silently vanish into an unconfigured Chromium temp dir, or a permission bubble sit blocking a page
region moxxie's snapshot can't see and the host is never told any of it happened.

## Findings

### 1. Dialog handling: absent end-to-end (P0, adopt)
- Source: `popups_watchdog.py` `on_TabCreatedEvent` registers `Page.javascriptDialogOpening` on
  every target at creation; `handle_dialog` accepts alert/confirm/beforeunload
  (`should_accept = dialog_type in ('alert','confirm','beforeunload')`), dismisses `prompt`, and
  appends `f'[{dialog_type}] {message}'` to `browser_session._closed_popup_messages` so the next
  agent turn sees what happened (lines 62-141).
- moxxie: `handlers.ts` `handle()` dispatch table has `case 'dialog': return notImplemented()`
  (line 222-224). `grep` across `session.ts`/`actions.ts`/`pagechange.ts` finds **no**
  `page.on('dialog', ...)` or CDP `Page.javascriptDialogOpening` registration anywhere.
  Playwright's own default (auto-*dismiss*, i.e. Cancel, when no listener is registered) then
  silently governs every dialog moxxie ever encounters. A `confirm()` gating "are you sure you
  want to delete" is auto-*canceled* — the click the host asked for never actually completes —
  and the host gets a normal `ok()` envelope with no signal anything happened.
- Change: in `session.ts`, register a `page.on('dialog', handler)` at `connect()`/`ensureConnected`
  time (handlers.ts) that mirrors browser-use's accept/dismiss policy, and persist
  `{type, message}` into `moxxie-state.json` (the existing `UabState` sidecar in handlers.ts) as
  e.g. `lastDialog`. Stamp `dialog_handled` onto the next `handleAct`/`handleSnapshot` envelope
  the same way `page_changed`/`stale_refs` are already stamped (handlers.ts lines 424-435).
- keyless_ok: true — pure CDP event wiring, no model call.
- Priority: P0 — currently a correctness bug (intended actions silently no-op), not just a
  missing nicety.

### 2. Downloads: no CDP download behavior configured, no signal in the envelope (P0, adopt)
- Source: `downloads_watchdog.py` `attach_to_target` calls
  `cdp_client.send.Browser.setDownloadBehavior(params={'behavior':'allow','downloadPath':...,
  'eventsEnabled': True})` once per browser session, then registers
  `Browser.downloadWillBegin`/`downloadProgress` to track completion and dispatch
  `FileDownloadedEvent(path, file_name, file_size, ...)` (lines 459-507, 917-1013).
- moxxie: `session.ts`'s `openSession` builds the Chromium launch `args` list (lines 96-105) with
  no download-behavior configuration, and no CDP session anywhere calls
  `Browser.setDownloadBehavior`. `handlers.ts`'s `handleAct` (lines 387-440) stamps
  `page_changed`/`stale_refs`/`generation` onto every action envelope but has nothing for
  downloads. A click that triggers a file download today either silently drops (headless Chromium
  without `setDownloadBehavior` commonly blocks/cancels programmatic downloads) or lands in an
  undiscoverable default temp path — either way the host has no way to know a download happened,
  where it went, or what it's called.
- Change: at `openSession`/`ensureConnected` time in session.ts, send
  `Browser.setDownloadBehavior({behavior:'allow', downloadPath: <sessionDir>/downloads,
  eventsEnabled:true})` over the per-connection CDP session. In `handleAct` (handlers.ts), after
  `act()` returns, race a short (~2s) listen on `Browser.downloadWillBegin`/`downloadProgress`
  (state `completed`) against the existing `settleAndFingerprint` call, and if a download fired,
  attach `download: {path, filename, size}` to the returned envelope. This is the highest-value
  single change from this lens — it's a complete gap today, not a hardening of an existing path.
- keyless_ok: true.
- Priority: P0.

### 3. Filename/path sanitization for downloads (P1, align — contingent on #2)
- Source: `_sanitize_download_filename` strips null bytes, normalizes `\` to `/`, and takes only
  `os.path.basename(...)` of a page-controlled filename (CDP `suggestedFilename` /
  Content-Disposition, i.e. attacker-controlled); `_is_path_contained` does a `realpath` prefix
  check before any write (downloads_watchdog.py lines 1462-1480, called at every write site:
  lines 818, 1043, 1391).
- moxxie: has an analogous discipline for *text* (`src/security/injection.ts` `neutralize`/
  `capOutput`, referenced in handlers.ts `presentPageText`) but nothing for *filenames*, because
  moxxie currently writes no page-controlled path to disk at all (`handleScreenshot`'s `outPath`
  is operator-supplied, not page-supplied). This finding only becomes live once #2 ships — a
  download's suggested filename is exactly the same trust class ("untrusted content from the
  page") that `injection.ts` already treats seriously for snapshot text, so the same rigor should
  extend to filenames the moment moxxie starts writing downloaded bytes to disk.
- Change: when implementing #2, port `_sanitize_download_filename` and `_is_path_contained`
  (or equivalent) into the download-write path before any `fs.writeFile`, so a malicious page
  can't use `../../` or a null-byte trick in `suggestedFilename` to write outside the session's
  `downloads/` directory.
- keyless_ok: true.
- Priority: P1 (blocked on #2 landing first).

### 4. Crash detection is reactive-only; no active health probe (P1, adopt/align)
- Source: `crash_watchdog.py` runs a standing `_monitoring_loop` (every `check_interval_seconds`,
  default 5s) that (a) pings `Runtime.evaluate('1+1')` with a 1s timeout per target
  (`_check_browser_health`, lines 281-331), (b) listens for the CDP `Target.targetCrashed` event
  directly (`attach_to_target`, lines 87-121), and (c) checks the OS process via `psutil` for
  zombie/dead status (lines 312-329) — giving the agent's *next* turn advance warning that the
  browser died, rather than discovering it via a failed action.
- moxxie: the only crash awareness is `actions.ts`'s `mapActionError` — a regex on the *message
  text* of an already-thrown Playwright error (`if (/crash/i.test(msg)) return 'page_crash'`,
  line 342). This only fires *after* a command already tried and failed against a dead browser,
  and only if the underlying error message happens to contain the literal word "crash" (a
  connect-timeout to a killed process wouldn't necessarily match). Because moxxie's
  connect→act→disconnect model deliberately avoids a persistent watchdog process, browser-use's
  full standing-loop approach doesn't transplant directly — but moxxie already has the natural
  hook: `ensureConnected`'s failure path (handlers.ts lines 121-128) currently just always calls
  `openSession` again on any `connect()` failure, silently respawning a fresh browser and masking
  a crash as an invisible restart (stale session state, generation reset, no `browser_crashed`
  signal to the host).
- Change: in `ensureConnected` (handlers.ts), before respawning, do a liveness probe
  (`process.kill(pid, 0)` against the sidecar's recorded pid from `readSidecar`) to distinguish
  "process is dead" (respawn is correct, but tell the host via a distinct fail/warn code) from
  "port unresponsive but process alive" (a real hang — surface `browser_crashed` rather than
  silently retrying). Also wire `Target.targetCrashed` into `handleDoctor`'s or `handleAct`'s CDP
  session so mid-action crashes get a positive event instead of relying on error-message regex.
- keyless_ok: true.
- Priority: P1.

### 5. Dialog-vs-settle race in the existing page-change fingerprint (P1, adopt)
- moxxie-specific hazard, surfaced by reading `pagechange.ts` against browser-use's dialog policy:
  `fingerprintAfterSettle` (pagechange.ts lines 69-83) calls `page.evaluate(...)` to count DOM
  nodes as part of every action's post-settle fingerprint. JS execution in a page is paused while
  a native dialog is open; combined with finding #1 (no dialog listener), any action that pops a
  dialog risks the fingerprint's `page.evaluate` stalling until Playwright's own default dismissal
  kicks in (or the bounded `NETWORK_IDLE_BUDGET_MS` race times out) rather than the CLI actively
  clearing the dialog itself and reporting it.
- Change: this resolves for free once #1's dialog listener is in place — clearing the dialog
  immediately means `fingerprintAfterSettle`'s `evaluate` call no longer has anything to stall on.
  Called out separately because it's the concrete mechanism by which a missing dialog handler
  turns into a hung/slow command, not just a silently-wrong one.
- keyless_ok: true.
- Priority: P1 (same fix as #1, different failure mode).

### 6. Native permission prompts (geolocation/notifications) ungranted (P2, adopt)
- Source: `permissions_watchdog.py` grants `browser_session.browser_profile.permissions` via
  `Browser.grantPermissions` once on `BrowserConnectedEvent` (lines 23-43) specifically to
  suppress native permission-prompt UI that would otherwise sit in front of the page.
- moxxie: `session.ts`'s launch `args` (lines 96-105) and `handlers.ts` never call
  `Browser.grantPermissions`. This is a distinct coverage hole from #1: permission bubbles are
  native Chrome UI, not JS dialogs, so a dialog handler wouldn't catch them, and they're not part
  of the DOM either, so moxxie's snapshot (`perception/walk.ts` etc.) can't see or report them —
  the agent would just observe a page that appears stuck with no textual explanation.
- Change: at session-open time, send `Browser.grantPermissions` for a small fixed set
  (`geolocation`, `notifications`) or gate behind an opt-in flag if the operator wants strict
  least-privilege.
- keyless_ok: true.
- Priority: P2 — real but rarer blocker than dialogs/downloads.

### 7. about:blank "DVD screensaver" + last-tab guard — SKIP-CARGO-CULT
- Source: `aboutblank_watchdog.py` injects a bouncing-logo loading animation into every
  `about:blank` tab (lines 132-259) and guarantees at least one tab survives so the whole browser
  process doesn't die when the last tab closes (lines 60-112).
- moxxie: has no multi-tab lifecycle to protect in the first place — `case 'tab': ... return
  notImplemented()` in `handlers.ts` (lines 219-224), and `handleClose` deliberately tears down
  the *entire* session/browser (`closeSession`, handlers.ts lines 267-277), not individual tabs.
  The screensaver is pure human-facing UX theater for a live-watched agent run; irrelevant to a
  keyless CLI with no observer. The last-tab-survival invariant would only matter once moxxie grows
  a real `tab close` verb — not worth building ahead of that.
- Recommendation: skip-cargo-cult, both the cosmetic animation and (for now) the tab-guard logic.

### 8. Full network-response download sniffing (PDF-in-iframe/embed, Content-Disposition MIME
   heuristics across every response) — SKIP as over-scoped for v1 (align, not adopt, the narrow
   version)
- Source: `downloads_watchdog.py`'s `_setup_network_monitoring` registers a global
  `Network.responseReceived` callback and runs ~40 lines of MIME/extension allow/deny-list logic
  (`_NETWORK_DOWNLOAD_FILE_EXTENSIONS`, `_is_generic_text_attachment`,
  `_should_auto_download_network_response`, lines 38-105, 511-714) to catch downloads that never
  go through the native CDP download flow (e.g. embedded PDF viewers, JS-triggered blob saves).
- Recommendation: implement only the narrow `Browser.setDownloadBehavior` +
  `downloadWillBegin`/`downloadProgress` path (finding #2), which covers moxxie's actual use case
  (agent clicks something → Chromium's native download machinery fires) far more cheaply. Do not
  port the exhaustive network-sniffing surface — it's proportionate to browser-use's
  "autonomously read anything the page might resemble a document" scope, not moxxie's "host issues
  a click/fill, tell it what happened" scope.

## Non-findings (checked, no gap)

- `security_watchdog.py` (domain allow/deny enforcement) has a moxxie analog already
  (`src/security/egress.ts` `assertNavigable`, invoked in `handleOpen`/`handleRead`) — not
  re-litigated here since it's outside this lens's four watchdogs and already aligned.
- `captcha_watchdog.py` is out of this lens's scope (not one of downloads/permissions/crash/dialog)
  and not reviewed here.
