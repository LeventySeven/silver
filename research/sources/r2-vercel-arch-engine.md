# R2 Source Digest — vercel/agent-browser (arch + engine)

Repo root read: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/agent-browser`
Stack: Rust CLI (`cli/src/**`, ~32k LOC in `cli/src/native/`), no Node/TS runtime for the core engine — the earlier teardown assumption of a JS driver is wrong for this shipped version; it's a native Rust CDP client compiled to a single binary (`agent-browser`).

## License

Apache License 2.0 (`LICENSE`, header verified lines 1-3: "Apache License, Version 2.0, January 2004"). Fork/adapt is permitted with attribution + NOTICE preservation (standard Apache-2.0 terms — state-changes notice, retain copyright/license/notice files, no trademark grant).

## Killer Insight

The snapshot/ref system is NOT "a11y tree dumped verbatim." It's a **three-source-merge**: (1) `Accessibility.getFullAXTree` CDP call, (2) a synchronous DOM-wide `querySelectorAll('*')` JS walk that detects **cursor-interactive but ARIA-invisible** elements (div-as-button via `cursor:pointer`/`onclick`/`tabindex`/`contenteditable`), and (3) a **hidden-input promotion pass** that fixes the common "styled radio/checkbox card" pattern where Chrome drops a `display:none` `<input type=radio>` from the AX tree entirely, leaving only a nameless `LabelText`/`generic` node — the engine detects the hidden input via JS, and promotes the label node's role to `radio`/`checkbox` with the DOM `.checked` state. This is why refs stay stable and clickable even on framework-heavy pages (React MUI/Radix-style styled inputs) where a naive AX-tree-only snapshot would silently miss half the interactive surface. Nothing in the Playwright/CDP docs describes this pattern — it's original engineering, evidenced at `cli/src/native/snapshot.rs:624-939`.

The second big insight: refs (`e1`, `e2`, …) are **not raw backendNodeIds** — they resolve through a two-tier fallback: cached `backend_node_id` fast path via `DOM.resolveNode`/`DOM.getBoxModel`, and on staleness (SPA re-render invalidated the node), a **re-query of the full AX tree matching role+name+nth-occurrence** (`element.rs:625-674`, `find_node_id_by_role_name`). This gives refs SPA-navigation resilience without a MutationObserver.

## Exact Command Surface / API (verbatim)

### Daemon protocol action names (internal JSON dispatch, `actions.rs:1825-1919`, the wire-level command set the CLI's flag parser maps onto)
```
launch, navigate, read, url, cdp_url, inspect, title, content, evaluate, close,
snapshot, screenshot, click, dblclick, fill, type, press, hover, scroll, select,
check, uncheck, wait, gettext, getattribute, isvisible, isenabled, ischecked,
back, forward, reload, cookies_get, cookies_set, cookies_clear,
storage_get, storage_set, storage_clear, setcontent, headers, offline,
console, errors, session_info, state_save, state_load,
state_list, state_show, state_clear, state_clean, state_rename,
trace_start, trace_stop, profiler_start, profiler_stop,
recording_start, recording_stop, recording_restart, pdf,
tab_list, tab_new, tab_switch, tab_close, viewport, useragent|user_agent,
set_media, download, diff_snapshot, diff_url,
credentials_set, credentials_get, credentials_delete, credentials_list,
mouse, keyboard, focus, clear, selectall, scrollintoview, dispatch, highlight,
tap, boundingbox, innertext, innerhtml, inputvalue, setvalue, count, styles,
bringtofront, timezone, locale, geolocation, permissions, dialog, upload
```
(source: `cli/src/native/actions.rs:1825-1919`)

### Ref syntax (`element.rs:124-147`, `parse_ref`)
Accepted forms, all normalize to `e<N>`:
- `@e1`
- `ref=e1`
- bare `e1` (must start with `e` + all-digit suffix)

### CSS/XPath selector dispatch (`element.rs:688-722`)
- Plain string → `document.querySelector(<json-escaped-selector>)`
- `xpath=<expr>` prefix → `document.evaluate(<expr>, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
- Count variant uses `XPathResult.ORDERED_NODE_SNAPSHOT_TYPE`.

### Snapshot output line format (`snapshot.rs:1075-1203`, `render_tree`)
```
<indent(2sp/level)>- <role> "<name>" [level=N, checked=X, expanded=B, selected, disabled, required, ref=eN, url=...] <cursor-kind> [hint1, hint2]: <value>
```
Example real shape (from tests, `snapshot.rs:1377,1388`):
```
- navigation
  - link "Home" [ref=e1]
  - link "About" [ref=e2]
- main
  - heading "Title"
  - paragraph
    - text: Hello
- form
  - radio "Single unit" [checked=false, ref=e1]
  - checkbox "I agree" [checked=false, ref=e2]
  - button "Submit" [ref=e3]
```
Cursor-interactive elements append `<kind> [hints]` after the attribute bracket, kind ∈ `clickable | focusable | editable`, hints ∈ `cursor:pointer | onclick | tabindex | contenteditable` (`snapshot.rs:854-874`).

### Env vars driving the engine (grep'd across `actions.rs`, `providers.rs`, `chrome.rs`)
`AGENT_BROWSER_SESSION`, `AGENT_BROWSER_SESSION_NAME`, `AGENT_BROWSER_ENGINE` (chrome|lightpanda, default "chrome"), `AGENT_BROWSER_HEADED`, `AGENT_BROWSER_USER_AGENT`, `AGENT_BROWSER_COLOR_SCHEME`, `AGENT_BROWSER_DEFAULT_TIMEOUT` (default 25000ms — intentionally under the CLI's 30s IPC read timeout so the daemon reports a clean timeout instead of the client EAGAIN-retrying, `actions.rs:405-412`), `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` (default 30000), `AGENT_BROWSER_ALLOWED_DOMAINS`, `AGENT_BROWSER_NO_AUTO_DIALOG`, `AGENT_BROWSER_STATE_EXPIRE_DAYS`, `AGENT_BROWSER_DAEMON=1` (marks the spawned child as the daemon process), `AGENT_BROWSER_SOCKET_DIR`, `AGENT_BROWSER_STREAM_PORT`, `AGENT_BROWSER_PLUGINS`, plus per-provider keys: `BROWSERBASE_API_KEY`, `BROWSERLESS_API_KEY`/`_API_URL`/`_BROWSER_TYPE`/`_TTL`/`_STEALTH`, `BROWSER_USE_API_KEY`, `KERNEL_API_KEY`/`_ENDPOINT`/`_HEADLESS`/`_STEALTH`/`_TIMEOUT_SECONDS`/`_PROFILE_NAME`, `AGENTCORE_REGION`/`_BROWSER_ID`/`_SESSION_TIMEOUT`/`_PROFILE_ID` (+ standard `AWS_*` creds, SigV4-signed).

### Provider connect URLs (verbatim, `providers.rs`)
- Browserbase: `POST https://api.browserbase.com/v1/sessions`, header `x-bb-api-key`, response field `connectUrl` (line 257-292); cleanup `POST https://api.browserbase.com/v1/sessions/{id}` body `{"status":"REQUEST_RELEASE"}` (line 129-137).
- Browserless: `POST {BROWSERLESS_API_URL:-https://production-sfo.browserless.io}/session?token=<key>` body `{ttl, stealth, browser}`, response `connect`/`stop` URLs (line 303-382).
- Browser Use: `wss://connect.browser-use.com?apiKey=<key>` (line 388, no session object — direct ws URL).
- Kernel: `POST {KERNEL_ENDPOINT:-https://api.onkernel.com}/browsers` body `{headless, stealth, timeout_seconds}`, response any of `cdp_ws_url|connectUrl|connect_url|cdpUrl|cdp_url` (line 393-479).
- AWS Bedrock AgentCore: `PUT https://bedrock-agentcore.{region}.amazonaws.com/browsers/{browser_id}/sessions/start`, full AWS SigV4 signing implemented by hand with `hmac`/`sha2` (service = `bedrock-agentcore`), ws at `wss://{host}/browser-streams/{browserIdentifier}/sessions/{sessionId}/automation` (lines 486-861).

### Chrome-for-Testing resolution (`install.rs:7-8`, `chrome.rs:830-921`)
Last-known-good JSON feed:
```
https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
```
Install cache dir: `~/.agent-browser/browsers/chrome-<version>/...`. `find_chrome()` search order: (1) `~/.agent-browser/browsers` install cache, (2) system Chrome/Chromium/Brave/Canary well-known paths per-OS, (3) Puppeteer's cache, (4) Playwright's Chromium cache. No bundled/vendored browser — always launches a real, separately-managed Chrome-for-Testing or system browser via CDP.

### Chrome launch flags actually shipped (`chrome.rs:364-519`, `build_chrome_args`)
Always-on baseline:
```
--remote-debugging-port=0 --no-first-run --no-default-browser-check
--disable-background-networking --disable-backgrounding-occluded-windows
--disable-component-update --disable-default-apps --disable-hang-monitor
--disable-popup-blocking --disable-prompt-on-repost --disable-sync
--disable-features=Translate
--enable-features=NetworkService,NetworkServiceInProcess[,Vulkan if webgpu+linux]
--metrics-recording-only
```
Conditional: `--enable-unsafe-webgpu` (+`--use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface` on Linux) when `webgpu`; `--password-store=basic --use-mock-keychain` unless real keychain; `--headless=new` (+`--hide-scrollbars`, `--enable-unsafe-swiftshader`) when headless AND no extensions loaded (extensions require headed — content scripts don't inject headless); `--user-data-dir=<profile or tmp uuid dir>`; `--window-size=W,H` (default 1280x720) when headless and no explicit size; `--no-sandbox`/`--disable-dev-shm-usage` heuristically added (`should_disable_sandbox`/`should_disable_dev_shm`, likely container/CI detection). Note: multiple `--enable-features=` user args get merged into ONE flag because Chrome only honors the last occurrence on the command line (line 365-391) — a real gotcha worth stealing.

### Lightpanda engine launch (`lightpanda.rs:43-60`)
```
lightpanda serve --host 127.0.0.1 --port <port> --timeout 604800 [--http_proxy <proxy>]
```
Session timeout hardcoded to 604800s (1 week, "the documented maximum" per comment). Discovery via CDP endpoint polling with 500ms timeout, 100ms poll interval, 10s overall startup timeout.

## Patterns

1. **Name/role dedup for stable refs** — Tier: core
   - What: multiple elements sharing role+name (e.g. two "Submit" buttons) get an `nth` suffix baked into the RefEntry so re-resolution disambiguates.
   - How: `RoleNameTracker` (`snapshot.rs:185-214`) keys on `"{role}:{name}"`, increments a counter per key during the initial tree walk; only keys with count>1 get an explicit `nth` stored in `ref_map` (`snapshot.rs:393-418`). Fallback re-resolution (`find_node_id_by_role_name`, `element.rs:629-674`) walks the fresh AX tree counting matches until it hits the stored `nth`.
   - Evidence: `snapshot.rs:185-214`, `element.rs:625-674`.
   - Tier: core.

2. **Interception/occlusion guard before every coordinate-based interaction** — Tier: core
   - What: before dispatching a click/hover at computed (x,y), a JS `blockerAt(doc, el, x, y)` walks `elementFromPoint` (descending into same-origin iframes), checks shadow-including ancestor/descendant relation and label↔control association, and returns a short description of whatever unrelated element would actually receive the click. If non-null, the interaction is aborted with a clear error instead of silently clicking the wrong thing.
   - How: `BLOCKER_AT_JS` const (`element.rs:731-761`) is inlined into both `build_selector_js` (used for CSS/XPath resolution, line 763-788) and `check_node_interception` (used for ref-based resolution via backendNodeId → resolveNode → callFunctionOn, line 402-463). Error text: `"Element '{}' is covered by <{}> at its click point..."` (line 822-827).
   - Evidence: `element.rs:299-463, 731-828`.
   - Tier: core — this is the actionability/auto-wait analog to Playwright's actionability checks, done via one JS round-trip instead of Playwright's internal C++ hit-testing.

3. **Three-source-merge accessibility snapshot** — Tier: core
   - What: merges CDP `Accessibility.getFullAXTree` with a JS `querySelectorAll('*')` cursor-interactive scan and a hidden-input-promotion pass.
   - How: (a) fetch full AX tree; (b) `find_cursor_interactive_elements` (`snapshot.rs:624-907`) runs one big JS `Runtime.evaluate` that tags matching elements with `data-__ab-ci=<index>` attributes, then batch-resolves backendNodeIds via `DOM.getDocument`+`DOM.querySelectorAll('[data-__ab-ci]')`+parallel `DOM.describeNode` (avoids N round-trips), then strips the marker attrs; (c) `promote_hidden_inputs` (`snapshot.rs:914-939`) rewrites `LabelText`/`generic` AX nodes that wrap a `display:none`/`visibility:hidden` radio/checkbox into `role=radio|checkbox` with `checked` state pulled from the DOM.
   - Evidence: `snapshot.rs:216-427, 624-939`.
   - Tier: core.

4. **StaticText aggregation + redundant-name collapse** — Tier: important
   - What: cleans the raw CDP AX tree's habit of splitting one visual text run into many `StaticText` AX nodes (due to inline tags), and collapses a parent node whose sole child StaticText duplicates its own name.
   - How: `build_tree` (`snapshot.rs:941-1073`) post-processes children lists: contiguous `StaticText` runs get concatenated into the first node (others `.clear()`d to empty, which `render_tree` then skips over transparently); single StaticText child with name == parent name is cleared.
   - Evidence: `snapshot.rs:993-1043`.
   - Tier: important.

5. **Interactive/content/structural role tri-classification for ref assignment** — Tier: core
   - What: only 3 categories of AX roles get a `ref`: hard-interactive roles always; content roles (heading, cell, listitem, article, region, main, navigation, …) only if they have a non-empty accessible name; structural roles (generic, group, list, table, row, …) never get refs directly (but their children may) — plus any node whose backendNodeId matched the cursor-interactive scan always gets a ref regardless of role.
   - How: `INTERACTIVE_ROLES`/`CONTENT_ROLES`/`STRUCTURAL_ROLES` const arrays (`snapshot.rs:11-66`); ref-assignment loop `snapshot.rs:369-391`.
   - Evidence: `snapshot.rs:11-66, 369-391`.
   - Tier: core.

6. **Cross-origin vs same-origin iframe dual-path resolution** — Tier: core
   - What: cross-origin iframes get a dedicated CDP session (`Target.attachToTarget`-style OOPIF session, tracked in `iframe_sessions: HashMap<frame_id, session_id>`); same-origin iframes stay on the parent session and are addressed with an explicit `frameId` param to `Accessibility.getFullAXTree`, or by walking `contentDocument` through `DOM.getFrameOwner`+`DOM.resolveNode` for interaction JS.
   - How: `resolve_ax_session` (`element.rs:595-609`) branches on whether `iframe_sessions` has an entry for the frame; `resolve_center_in_same_process_frame`/`resolve_object_in_same_process_frame` (`element.rs:208-297`) build a `contentDocument`-rooted JS expression, and walk `win.frameElement` up the chain to convert same-process-frame-local coords into top-level viewport coords for input dispatch.
   - Evidence: `element.rs:171-297, 592-623`; regression tests `snapshot.rs:1473-1517`.
   - Tier: core.

7. **Two-tier ref resolution: cached backendNodeId fast path, AX re-query fallback** — Tier: core
   - What: refs don't just store a backendNodeId once; every dereference tries the cached id first (`DOM.getBoxModel`/`DOM.resolveNode`), and only on failure (SPA re-render invalidated it) falls back to re-running the AX tree query and matching role+name+nth.
   - How: `resolve_element_center`/`resolve_element_object_id` (`element.rs:299-396, 479-590`).
   - Evidence: `element.rs:299-396, 479-590`.
   - Tier: core.

8. **Per-session daemon, self-spawning, Unix-socket (or TCP on Windows) IPC** — Tier: core
   - What: process model is one persistent background daemon per named session (`AGENT_BROWSER_SESSION`, default `"default"`), spawned lazily by the first CLI invocation and reused by subsequent commands — NOT a per-command process, NOT a single global daemon.
   - How: `ensure_daemon` (`connection.rs:784-...`) checks `daemon_ready()` (socket connectivity, not PID — supports different PID namespaces), version-matches the running daemon against the CLI binary version and restarts on mismatch, then double-forks via `setsid()` on Unix (`pre_exec` calling `libc::setsid()`) or `CREATE_NEW_PROCESS_GROUP|DETACHED_PROCESS` on Windows, with `AGENT_BROWSER_DAEMON=1` env marking the child. The daemon (`daemon.rs`) binds a Unix domain socket at `<socket_dir>/<session>.sock` (Windows: TCP port file `<session>.port`), writes `.pid`/`.version`/`.stream` sidecar files, and runs a tokio `select!` loop handling: incoming connections, a 100ms drain tick (checks browser process exit + background CDP event draining + periodic autosave), an idle-timeout auto-shutdown, and graceful shutdown signals.
   - Evidence: `connection.rs:784-920`, `daemon.rs:22-256`.
   - Tier: core — this IS the "session daemon/persistence" answer: exactly one OS-level daemon process per agent-browser session name, holding the live CDP connection and RefMap in memory across CLI invocations.
   - Anti-pattern-adjacent gotcha worth copying: idle-timeout autosave-then-close and drain-tick browser-process-exit detection both live in the same `select!` loop as the socket accept loop — cheap to reimplement, easy to get racy if split across threads.

9. **Selector-scoped snapshot via backendNodeId subtree membership** — Tier: important
   - What: `snapshot --selector <css>` doesn't re-run a separate AX query rooted differently; it resolves the CSS selector to a DOM subtree's full backendNodeId set (`DOM.describeNode` depth:-1, recursing through `children`, `shadowRoots`, `contentDocument`), then finds AX tree nodes whose `backend_node_id` is in that set AND whose AX parent is NOT in that set — those become the render roots.
   - How: `take_snapshot` lines 231-354, `collect_backend_node_ids` (`snapshot.rs:1338-1356`).
   - Evidence: `snapshot.rs:231-354`.
   - Tier: important.

10. **poll_until_true 100ms-interval waiter, shared across all wait_for_* variants** — Tier: important
    - What: every `wait` sub-mode (selector attached/detached/hidden/visible, text, custom function, URL pattern) reduces to a boolean JS expression evaluated via `Runtime.evaluate` with `awaitPromise:true`, polled every 100ms against a deadline computed from `timeout_ms` (falls back to `default_timeout_ms`, itself from `AGENT_BROWSER_DEFAULT_TIMEOUT`, default 25000ms).
    - How: `poll_until_true` (`actions.rs:4382-4419`); state-specific check-string builders at `actions.rs:4240-4271` (selector), `4293-4304` (text), `4306-4314` (function), and a separate non-JS `wait_for_url` loop (`4276-4291`) that polls `mgr.get_url()` directly rather than evaluating JS.
    - Evidence: `actions.rs:4240-4419`.
    - Tier: important.

## Reusable code (fork candidates)

- `cli/src/native/snapshot.rs` — the entire a11y-tree-walk + cursor-interactive-merge + hidden-input-promotion + StaticText-aggregation + compact-tree renderer. Single highest-value file to port; ~1600 lines, self-contained given a CDP client.
- `cli/src/native/element.rs` — ref parsing/resolution (`parse_ref`, `RefMap`, `resolve_element_center`, `resolve_element_object_id`), the `BLOCKER_AT_JS` occlusion-check snippet, and cross-origin/same-origin iframe dual-path helpers. Directly portable JS snippets even into a non-Rust implementation.
- `cli/src/native/interaction.rs` — click/fill/type/press/scroll primitives built on top of element.rs resolution; the `type_text_into_active_context` char-by-char dispatch logic (special-cases `\n`/`\r`/`\t` as real key events, everything else as `Input.insertText` — documented workaround for VS Code/Electron webviews rejecting repeated `dispatchKeyEvent` with printable `text`).
- `cli/src/native/cdp/chrome.rs` — `build_chrome_args` (flag list) and `find_chrome` (cross-platform discovery + Puppeteer/Playwright cache fallback chain) — a complete, battle-tested Chrome-for-Testing launch recipe.
- `cli/src/install.rs` — Chrome-for-Testing download via the official `last-known-good-versions-with-downloads.json` feed, with retry/backoff on `download_bytes` (tests show 500 retried, 403 not retried).
- `cli/src/connection.rs` (`ensure_daemon`, lines ~784-990) — the daemon lifecycle/spawn/version-check/respawn state machine, directly reusable process-model design even in another language.
- `cli/src/native/providers.rs` — ready-made REST clients for Browserbase/Browserless/Browser-Use/Kernel, plus a hand-rolled AWS SigV4 signer for Bedrock AgentCore (no AWS SDK dependency) — useful if the new tool wants zero-dependency cloud-provider support.

## Anti-patterns

- Hand-rolled SigV4 signing in `providers.rs` (694-817) duplicates a well-trodden AWS SDK concern inside application code — fine for a dependency-light CLI, but a maintenance/security liability to copy verbatim (canonical-request/string-to-sign construction is easy to get subtly wrong; worth using a signing crate if the AWS-provider integration is not a priority for the new tool).
- `wait_for_url`/`poll_until_true`/`wait_for_selector_in_frame` are three separate, near-identical 100ms-poll-loop implementations rather than one generic poller parameterized by an async predicate — copy the *behavior*, not the triplication.
- `resolve_ax_session`/`resolve_frame_session` exist as two structurally-identical functions differing only in return type (Value+&str vs &str) — a sign the ref/iframe resolution layer could use a shared "frame routing" abstraction; don't propagate the duplication when porting.
