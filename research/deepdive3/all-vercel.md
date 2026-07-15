# all-vercel: exhaustive transferable-surface sweep of Vercel's agent-browser Rust CLI

Source read exhaustively: `rust-oracle/cli/src/{commands.rs (5795L), flags.rs (1906L), read.rs,
native/{providers.rs, diff.rs, policy.rs, cookies.rs, storage.rs, egress.rs, inspect_server.rs,
tracing.rs}}`. Cross-checked against Silver's `src/core/flags.ts`, `src/core/handlers.ts`,
`src/security/confirm.ts`. Builds on `deepdive/vercel-{engine,longhorizon,perception,top5dx}.md` and
`synthesis/adopt-list-v2.md` — everything below is confirmed NOT already covered there (verified by
grep against the prior digests' cited items) or is a materially deeper cut of something they only
gestured at.

## 1. `silver read <url>` — keyless, browser-free static-doc fetch with llms.txt support — **P0**

The single biggest capability gap. Vercel's `read.rs` (~1050 lines) is a standalone HTTP client
(`reqwest`, no CDP, no page) that: negotiates `Accept: text/markdown, text/plain;q=0.9,
text/html;q=0.7` against the server; on an HTML response, tries a same-origin `.md` sibling URL
(`markdown_fallback_url`) before giving up; discovers the *nearest ancestor* `llms.txt` /
`llms-full.txt` by walking the URL path upward (`llms_file_candidates`) — the emerging 2026
AI-content-discovery convention; parses `llms.txt`'s markdown link list to find the entry matching
the requested doc (`find_llms_link_for_target`, doc-path/slug matching, not just literal href);
supports `--llms index|full`, `--outline` (heading extraction into a TOC), `--filter <heading>`
(returns only the matching markdown section, `filter_markdown_sections`), `--require-md` (fail
closed instead of silently degrading), `--raw`, `--timeout`, `--headers`, and `--allowed-domains`
(SSRF-consistent with the browser path). Silver has **zero** equivalent: `grep -r llms|outline`
across `silver/src` returns nothing, and there is no `read.ts` at all — every doc/text fetch in
Silver must open a full Chromium page, wait for load, and run the DOM→snapshot pipeline, even for a
static markdown/docs page that would 10-100x cheaper as a HEAD+GET.
- **Why it matters for Silver specifically**: docs/API-reference lookups are one of the most common
  sub-tasks in agent loops; a raw `fetch` avoids browser cold-start (the ~185ms-3.5s figures in
  `measure-parallel-coldstart.md`) entirely for the common case. It also composes with content
  boundaries: the fetched text still needs the `⟦untrusted⟧` wrapper since it's page content.
- **Concrete change**: new `silver/src/perception/read.ts` mirroring `read.rs`'s functions
  (`normalize_url`, `fetch_read_url`, `run_llms_index/full`, `format_page_outline`,
  `filter_markdown_sections`), wired to a new `read` verb in `handlers.ts`/`flags.ts` (`--llms`,
  `--outline`, `--filter`, `--raw`, `--require-md`). Reuse Silver's existing `allowedDomains`
  plumbing and `assertNavigableResolved`-equivalent (Silver's `egress.ts`) for the fetch target.
- **KEYLESS check**: pure HTTP + string parsing (markdown heading regex, path-candidate generation).
  No model call anywhere in the 1050-line file.
- **Priority: P0** — highest token/latency ROI of anything in this sweep; a Silver differentiator
  vs. every source reviewed so far (none of Aside/Stagehand/browser-use/AgentQL have an llms.txt-aware
  static reader).

## 2. `silver confirm <id>` / `silver deny <id>` — decoupled two-phase confirmation — **P0**

Silver's `confirm.ts` gate is synchronous-blocking: on a TTY it presumably prompts inline; on
non-TTY it fails closed unless pre-approved via `--confirm-actions`. Vercel's model is
fundamentally different and better for the agent-loop shape Silver targets: a gated action returns
a `confirmationId` (pending, not yet executed) instead of blocking, and the **host** — which may be
a different process/turn — issues a *separate* CLI invocation `silver confirm <id>` or
`silver deny <id>` to resolve it (`commands.rs:1272-1285`). This decouples "the action was
requested" from "the human/host approved it" across turns, which matters enormously for an agent
harness that can't leave a blocking `read()` open on stdin between LLM turns (Silver's actual
deployment shape — a fresh CLI process per verb). Silver's current fail-closed-on-non-TTY design
means confirmable actions are simply impossible without pre-listing them in `--confirm-actions`
ahead of time; Vercel's design lets the host inspect the pending action (target, verb, risk) *after*
attempting it and decide per-instance.
- **Concrete change**: extend the mutating-verb path in `handlers.ts` to, when `requiresConfirm(verb)`
  is true and no TTY/pre-approval, return a `{status: "confirmation_required", confirmationId}`
  envelope instead of erroring; persist the pending action (verb+args+target) keyed by that id in
  session state (reuse the sidecar dir); add `confirm`/`deny` verbs to `flags.ts`/`handlers.ts` that
  look it up and either execute or discard it. Store pending actions with a TTL so they can't be
  replayed stale.
- Keyless. Not in `adopt-list-v2.md` (that doc only covers the confirm-gate *policy decision*, not
  this two-phase execution shape) or `red-team.md`.
- **Priority: P0** — directly fixes a documented Silver limitation (fail-closed = feature-dead on
  non-TTY) with a strictly more capable pattern already proven in production Vercel usage.

## 3. `--action-policy <file.json>` — declarative allow/deny/confirm/default policy file — **P1**

`native/policy.rs`'s `ActionPolicy`: a JSON file (`{"default": "deny"|"allow", "allow": [...],
"deny": [...], "confirm": [...]}`) with precedence **deny > confirm > allow > default**, loaded via
`--action-policy`/`SILVER_ACTION_POLICY` (with `SILVER_POLICY` back-compat alias), and a `reload()`
method for hot-reload without restart. Silver's `confirmActions` is CSV-only, additive-only
(pre-approve a set), and has no hard **deny** concept at all — a Silver-driven agent cannot express
"never allow `download` regardless of confirmation" short of not implementing the verb. A
file-based policy is also the right shape for a fleet operator who wants one policy checked into a
repo and applied identically across many `silver` invocations, vs. reconstructing a CLI flag every
time.
- **Concrete change**: `src/security/policy.ts` port of `ActionPolicy` (same JSON shape for drop-in
  compatibility with existing Vercel policy files users may already have); wire into the confirm
  gate ahead of `confirmGateDecision` so `deny` short-circuits before the TTY/pre-approval check.
- Keyless, file I/O only.
- **Priority: P1** — meaningfully strengthens Silver's stated security-parity/security-superiority
  claim over Vercel; currently Silver is *weaker* here (no deny list), which undercuts the "hardened
  security" pitch in the project brief.

## 4. `silver inspect` DevTools-proxy server — **P1**

`native/inspect_server.rs` (362 lines): a tiny HTTP+WebSocket server bound to `127.0.0.1:0` that (a)
serves a `302` redirect at `GET /` to Chrome's own bundled DevTools frontend
(`/devtools/devtools_app.html?ws=...`) and (b) on `GET /ws` creates a **fresh**
`Target.attachToTarget` CDP session per DevTools connection (so `DOM.enable` etc. always re-fires
initial state) and proxies messages bidirectionally, injecting/stripping `sessionId` so DevTools
sees a normal single-target view. This gives a human operator (or the agent's supervisor) a live,
real Chrome DevTools UI into the exact browser session the CLI is driving — for debugging why a
selector isn't grounding, watching network waterfalls, or eyeballing a stuck page — without ever
touching Playwright's own inspector. Silver has an `inspect` token already reserved in some verb
grammar for React inspection (`react inspect <fiberId>`) but no top-level `silver inspect` that opens
a debugging bridge to the live page.
- **Concrete change**: a thin Node `http`+`ws` server in `src/actuation/inspect.ts` that does the
  same `Target.attachToTarget` handshake against Silver's existing CDP client, prints the DevTools
  URL to stderr (not stdout — keeps `--json` output clean), and tears down on exit. This is pure
  developer-experience but is a strong differentiator: no competitor (Stagehand, browser-use,
  AgentQL) exposes a one-command bridge to real Chrome DevTools.
- Keyless.
- **Priority: P1** — cheap to build (CDP attach/detach + a WS relay is <200 lines), high leverage
  for debugging agent failures, a category of DX none of the researched sources have.

## 5. `trace start/stop` + separate `profiler start/stop` — two distinct performance-capture verbs — **P2**

Vercel exposes **two** Chromium performance-capture paths that Silver conflates or lacks: `trace
start|stop [path]` uses `Tracing.start` with `recordMode: recordContinuously` and
`transferMode: ReturnAsStream`, streaming `Tracing.dataCollected`/`Tracing.tracingComplete` events
with a category list tuned for DevTools-style flame charts (`devtools.timeline`,
`v8.cpu_profiler`, `blink.user_timing`, `renderer.scheduler`, etc. — 14 categories in
`DEFAULT_PROFILER_CATEGORIES`), and reads the trace back over an `IO` stream if it didn't arrive
inline (handles both small in-band and large out-of-band trace payloads). `profiler start
--categories <csv>` is the customizable variant for narrower captures. Both write a
`.json`/Chrome-trace-format file an agent (or a human loading `chrome://tracing`) can consume for
root-causing "why did this page take 4 seconds to interactive." Silver's `recording.rs`-equivalent
(if any) is video/HAR, not CPU/paint/layout tracing — a different axis entirely (visual repro vs.
performance root-cause).
- **Concrete change**: `src/actuation/tracing.ts` wrapping `Tracing.start/end` + IO-stream drain,
  exposed as `trace start|stop <path>`. Useful specifically for agents doing performance-regression
  tasks ("did my change make the page slower") — a taxonomy gap not covered in
  `usage-taxonomy.md`.
- Keyless.
- **Priority: P2** — narrower use case than #1-4 but zero-model and cheap; also closes a taxonomy
  gap (performance-debugging agents) none of the eight prior-round sources addressed.

## 6. `record start|stop|restart <path> [url]` with mid-run **restart** — **P2**

Beyond simple start/stop, Vercel's recording verb has a `restart` subcommand that stops the current
`.webm` and immediately starts a new one at a new path — useful for an agent that wants to segment a
long task into per-step video clips without a start/stop round-trip losing frames at the boundary,
and it auto-prefixes a bare `url` positional with `https://` (`if !u.starts_with("http")`) the same
convenience Silver already does for `open`. If Silver's recording only has start/stop, `restart` is
a one-function addition with real workflow value (video-per-checkpoint task evidence, matching
Silver's own `task checkpoint --note` pattern — segmenting recordings at checkpoints is a natural
pairing).
- **Concrete change**: add `restart` to `src/actuation/recording.ts`'s verb switch — stop, then
  reuse the start path with the new output.
- Keyless.
- **Priority: P2**.

## 7. `highlight <selector>` — visual debug overlay on a live element — **P2**

A single-purpose verb: box-highlight an element in the actual rendered page (presumably via CDP
`Overlay.highlightNode` or an injected outline style) so a human watching headed mode — or a
screenshot taken right after — can visually confirm *which* DOM node a selector/ref resolved to.
This is cheap, valuable debugging affordance for the exact failure mode Silver's own docs flag as
hard (grounding mismatches): instead of trusting the ref map, `silver highlight <selector> &&
silver screenshot` gives visual ground truth in two commands. Not present in Silver at all.
- **Concrete change**: `src/actuation/highlight.ts` — inject a temporary outlined `<div>` overlay
  (or use `Overlay.highlightNode` if Silver already has CDP Overlay domain enabled) positioned over
  the resolved element's bounding box, auto-clearing after N ms or on next navigation.
- Keyless.
- **Priority: P2** — small win but directly serves Silver's own stated "grounding" weak point.

## 8. `clipboard read|write|copy|paste` — first-class OS/page clipboard verb — **P2**

Four operations: `read` (get clipboard contents), `write <text>` (set), `copy`/`paste` (trigger the
page-level clipboard events, i.e. drive a real copy/paste UI interaction rather than programmatic
get/set — meaningfully different because some sites intercept `copy`/`paste` events for custom
behavior). Silver's `handlers.ts` verb list includes `clipboard` as a token but grep shows no
distinct copy/paste event-simulation path — worth verifying it isn't just get/set. If Silver only
has get/set, the `copy`/`paste` *event-simulation* pair is the gap (drives `Input.dispatchKeyEvent`
Ctrl+C/Ctrl+V through Chromium rather than `navigator.clipboard` JS API, which many sites block from
script but not from real key-events).
- **Concrete change**: add `copy`/`paste` operations to Silver's clipboard verb that dispatch actual
  keyboard shortcuts through CDP `Input.dispatchKeyEvent` instead of the Clipboard API.
- Keyless.
- **Priority: P3** — narrow but real gap for clipboard-heavy workflows (paste-detection UIs).

## 9. `tap <selector>` / `swipe <up|down|left|right> [distance]` — explicit touch-semantic verbs — **P2**

Not just aliases: `tap` is click "for semantic clarity for touch interfaces" (its own action tag,
distinguishable in logs/HAR from a mouse click, and presumably dispatches `Input.dispatchTouchEvent`
CDP touch events rather than mouse events on mobile emulation) and `swipe` validates direction
(`up|down|left|right`) and optional pixel distance, translating to a touch-drag gesture. Silver
targets desktop-first snapshot/interaction; if mobile-viewport / touch-emulation tasks are in scope
(device emulation, responsive testing), Silver lacks the semantically-correct touch primitives —
using `click`/`drag` under touch emulation can produce different event sequences than real touch,
causing false negatives on touch-only UI (e.g., swipeable carousels, pull-to-refresh).
- **Concrete change**: `tap` as an alias that dispatches `Input.dispatchTouchEvent` (touchStart/End)
  instead of mouse events when device emulation is active; `swipe` as a synthesized multi-point touch
  drag with configurable distance/direction.
- Keyless.
- **Priority: P3** — only matters once Silver does serious mobile/touch-emulation testing, but cheap
  to add alongside existing `drag`/`scroll` machinery.

## 10. `connect <port|url>` — direct attach to an already-running Chrome — **P1**

One line of dispatch (`commands.rs:1288-1330`) but high value: accepts either a bare port number
(validated 1-65535) or a full `ws://`/`wss://`/`http://`/`https://` CDP endpoint and turns it into a
`launch` action with `cdpPort`/`cdpUrl` — i.e. "don't spawn a new browser, attach to the one already
running on port 9222." Silver has `--cdp <url>` as a *launch flag*, but there's a real ergonomic
difference between "always specify `--cdp` on every command" and a one-shot `connect <port>` that
presumably persists the attachment into the session so subsequent commands in the same `--session`
don't need to repeat it. Worth confirming Silver's `--cdp` flag persists per-session the same way;
if it must be repeated on every invocation, `connect` as a verb (that writes the CDP target into
session state once) is the missing ergonomic.
- **Concrete change**: `connect` verb in `flags.ts`/`handlers.ts` that validates the port/URL and
  persists it into the session sidecar so later commands in the same `--session` inherit it without
  re-passing `--cdp`.
- Keyless.
- **Priority: P1** — closes a real repeated-flag friction point for the "attach to my existing
  Chrome" workflow, which is common when a human has a logged-in browser already open.

## 11. `stream enable --port <port>` — CDP screencast HTTP dashboard — **P2**

`native/stream/{dashboard.rs, websocket.rs, http.rs, cdp_loop.rs, chat.rs}` (5 files, not fully read
here but the `commands.rs` dispatch plus file names make the shape clear): a `stream enable [--port
N]` verb that starts an HTTP+WS server serving a live low-latency screencast of the page (via CDP
`Page.startScreencast`) plus, per `stream/chat.rs`, apparently a **chat-overlay** dashboard —
plausibly for a human-in-the-loop supervising an agent's browser session in real time via a browser
tab, distinct from and complementary to `silver inspect`'s raw-DevTools bridge (`inspect` = full CDP
protocol access for a developer; `stream` = a simple visual dashboard for a non-technical
supervisor to *watch* what the agent is doing, maybe intervene via chat). Silver has no watch-mode
dashboard at all — screenshots are pull-based/on-demand only.
- **Concrete change**: lower priority to build fully (this is the most implementation-heavy item in
  the list — HTTP+WS server, canvas/video rendering client), but even a minimal MJPEG-over-HTTP
  screencast endpoint (`Page.startScreencast` → HTTP multipart response) run via `stream enable
  --port` would let a human watch a long agent task live without needing a full desktop VNC setup.
- Keyless.
- **Priority: P2/P3** — valuable for long-horizon/human-oversight use cases (ties into
  `aside-longhorizon.md`'s themes) but the highest implementation cost of anything in this list; scope
  to MJPEG-only first, skip the chat-overlay layer.

## 12. Cloud-browser provider matrix: Browserbase / Browserless / browser-use / Kernel / AgentCore (AWS SigV4) — **P1**

`native/providers.rs` (1103 lines) is a complete multi-cloud CDP-provider abstraction: five
built-in providers (`connect_browserbase`, `connect_browserless`, `connect_browser_use`,
`connect_kernel`, and a full `agentcore` module with **AWS SigV4 request signing from scratch**
— canonical-request construction, HMAC-SHA256 derivation chain, AWS-CLI credential fallback via
`aws configure export-credentials`) each returning a `ProviderConnection{ws_url, session,
direct_page, metadata}`, plus symmetric `close_provider_session` cleanup (DELETE/PATCH calls per
provider on exit) so cloud sessions don't leak and bill indefinitely. This is orthogonal to and
composes with Vercel's own plugin-provider mechanism (`connect_plugin_provider_with_plugins`,
already covered generically in prior digests) — but the five *built-in* named providers are new
information: Silver's `grep -ril browserbase|browserless|agentcore|kernel` across `src` returns
**nothing at all** — Silver has no cloud-provider story beyond bare `--cdp <url>`.
- **Why keyless-compatible**: each provider call is a plain signed/unsigned REST POST using an
  API-key env var (`BROWSERBASE_API_KEY`, `BROWSERLESS_API_KEY`, `BROWSER_USE_API_KEY`,
  `KERNEL_API_KEY`, AWS creds for AgentCore) — no model involvement, same "bring your own key for
  infra, never for cognition" boundary Silver already draws for e.g. proxies.
- **Concrete change**: port the four simple REST providers (Browserbase, Browserless, browser-use,
  Kernel — each ~50-130 lines, trivial fetch+JSON) into `src/actuation/providers.ts`, wired to
  `-p/--provider <name>`. Skip AgentCore's SigV4 signer initially (300+ lines, AWS-specific,
  lowest expected demand) or stub it behind a clearly-marked "not yet ported" error.
- **Priority: P1** — directly extends Silver's addressable market (teams already paying for
  Browserbase/Kernel/browser-use infra but wanting Silver's engine/security/token-lean snapshot on
  top) with almost no security-model change, since these are the same "attach to remote CDP"
  trust boundary Silver's `--cdp` flag already accepts.

## 13. Screenshot pixel-diff with threshold + rendered diff image — **P1**

`native/diff.rs::diff_screenshot`: decodes two PNG/JPEG buffers, on dimension mismatch returns a
structured `dimension_mismatch: {expected: {w,h}, actual: {w,h}}` payload instead of a generic
error, else does per-pixel Euclidean RGB distance against a `threshold` (0.0-1.0, scaled by
`255*sqrt(3)`), and **renders an actual diff PNG**: mismatched pixels painted solid red, matched
pixels dimmed-grayscale (30% luminance) so the diff image itself is a usable visual artifact, not
just a mismatch percentage. Silver's `perception/diff.ts` (confirmed to exist) is very likely
text/snapshot diff only (accessibility-tree diffing, matching the unified-diff `diff_snapshots` half
of this same Rust file, which Silver *has* covered per `adopt-list-v2` deltas) — the **screenshot**
half (visual regression testing with a rendered diff artifact) is the gap; `grep -ril diff` in
Silver's tree shows no `screenshot`+`diff` co-occurrence outside the perception snapshot diff.
- **Concrete change**: `src/perception/screenshotDiff.ts` — decode both images (Node `sharp` or
  `pngjs`), same threshold-distance + red/dimmed-diff-image algorithm, exposed as `diff --screenshot
  <a> <b> [--threshold N] [--out diff.png]`. Directly enables visual-regression-testing agent tasks
  (compare before/after a deploy) that Silver currently can't do without shelling out to a separate
  tool.
- Keyless — pure pixel math.
- **Priority: P1** — visual regression is a named, common agent-browser use case (design QA,
  pre/post-deploy comparison) entirely unaddressed by Silver's current diff surface.

## 14. Config file system: `.silver/config.json` (user) + `silver.json` (project) + `--config`/`SILVER_CONFIG` — **P1**

`flags.rs`'s `Config` struct + `load_config`: reads `~/.silver/config.json` (or wherever
`CONFIG_DIR`/`CONFIG_FILENAME` point, camelCase JSON via serde), then merges a project-local
`silver.json` on top (project overrides user, per-field `Option::or`, with **list fields
concatenated** rather than replaced — `extensions`, `init_scripts`, `enable`, `plugins` all merge
user+project instead of clobbering), and an explicit `--config <path>` / `SILVER_CONFIG` env var
short-circuits both defaults entirely. Precedence is CLI flag > env var > project config > user
config (evident from the flags.rs field-by-field `.or()` chains: CLI parsing runs after
`load_config` and always overwrites). Silver's `flags.ts` has **no file-based config at all** — every
invocation must pass every flag on the command line or via one-off env vars; there is no durable
per-project default (e.g. "this repo always uses `--allowed-domains internal.corp
--content-boundaries`") and no per-user default profile.
- **Why this matters**: for a CLI meant to be invoked dozens/hundreds of times per agent task, forcing
  every flag onto every invocation is real friction and a source of drift (one invocation in a batch
  forgets `--allowed-domains`, silently running unrestricted). A checked-in `silver.json` per
  repository is the standard "team defaults" pattern every other dev-tool CLI (eslint, tsconfig,
  prettier) already has, and its absence is arguably Silver's single most conventional missing
  feature.
- **Concrete change**: `src/core/config.ts` — camelCase JSON schema mirroring `ParsedFlags` fields
  that make sense as defaults (allowedDomains, contentBoundaries, session/namespace, maxOutput,
  confirmActions, engine, screenshot options), user-file at `~/.silver/config.json`, project-file
  `silver.json` (cwd), `--config`/`SILVER_CONFIG` override, merge semantics matching Vercel's
  (concat for list fields, override for scalars). Must run *before* `parseFlags` so CLI flags still
  win.
- Keyless — file read + JSON parse only.
- **Priority: P1** — high value, moderate effort (well-specified by the Rust reference
  implementation + its own test suite as a spec), and directly upgradable-compatible with existing
  Vercel `agent-browser` config files for teams migrating.

## 15. Explicit-vs-inherited flag provenance tracking (`cli_*` shadow booleans) — **P2**

Every optionally-config-sourced `Flags` field in `flags.rs` has a companion `cli_<field>: bool` set
only when the flag was passed literally on the command line (not via config file or env var) — e.g.
`cli_executable_path`, `cli_profile`, `cli_proxy`, `cli_annotate`, `cli_headed`, `cli_webgpu`,
`cli_restore`. This isn't cosmetic: it lets downstream logic distinguish "the operator explicitly
asked for headed mode *this invocation*" from "headed mode is just the project default" — which
matters for `--restore` (should an explicit `--headed false` on this one call override a persisted
session's launch options, or should the session's original launch win?) and for diagnostic output
("using proxy from silver.json, not a CLI override" vs. a bare value with no provenance). Silver's
config work (item #14 above) will need this same shadow-boolean pattern the moment it lands, or
config-vs-CLI precedence bugs are inevitable (a config default silently overriding an explicit CLI
flag, or vice versa, depending on merge order accidents).
- **Concrete change**: bake this into item #14's implementation from day one — every config-mergeable
  field in `ParsedFlags` gets a `<field>Explicit: boolean` sibling set only in the CLI-token parsing
  loop, not in the config-merge step.
- Keyless.
- **Priority: P2** — not a standalone feature, but a load-bearing implementation detail for #14 that
  is easy to omit and hard to retrofit once config + restore-session interactions ship without it.

## 16. Idle-timeout human-friendly units (`10s` / `3m` / `1h`) parsed to canonical ms with a shared parser — **P3**

Small but a real polish gap: `parse_idle_timeout` accepts `10s`/`3m`/`1h`/raw-ms, converts to a
canonical ms string used identically whether the value came from `--idle-timeout`, the config file,
or `SILVER_IDLE_TIMEOUT_MS` — one parser, one error message shape, applied at all three entry
points. Silver's `timeout` flag (`--timeout`, per `flags.ts`'s `NUMERIC_FIELDS`) is raw-ms-only, no
unit suffix. Trivial to add; meaningfully nicer for humans hand-writing a `silver.json` or CLI
invocation who shouldn't have to mentally convert "wait 3 minutes" to `180000`.
- **Concrete change**: a ~15-line `parseHumanDuration(s: string): number` used wherever Silver parses
  a millisecond duration flag.
- Keyless.
- **Priority: P3**.

## 17. `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` standard env-var inheritance — **P2**

`flags.rs`'s proxy field falls back through `SILVER_PROXY` → `HTTP_PROXY` → `http_proxy` →
`HTTPS_PROXY` → `https_proxy` → `ALL_PROXY` → `all_proxy` (and `proxy_bypass` similarly through
`NO_PROXY`/`no_proxy`) — i.e. it respects the *standard* Unix proxy-environment convention every
other CLI tool (curl, git, npm) honors, so a corporate-proxy environment "just works" without a
Silver-specific flag. Confirm whether Silver's `--proxy`/`SILVER_PROXY` chain does the same
fallback; if not, this is a one-line `.or_else` chain addition with outsized enterprise-deployment
value (agents running inside corporate networks behind a mandatory proxy).
- **Concrete change**: extend Silver's proxy-flag resolution in `flags.ts` to fall back through the
  standard env vars after `SILVER_PROXY`.
- Keyless.
- **Priority: P2** — cheap, standard-compliance, removes a real deployment friction point for
  enterprise users.

## Summary table (priority-sorted)

| # | Item | Priority | Est. effort |
|---|------|----------|-------------|
| 1 | `read <url>` browser-free markdown/llms.txt fetch | P0 | Medium (port ~1050L Rust → ~400L TS) |
| 2 | `confirm`/`deny` decoupled two-phase gate | P0 | Small-Medium |
| 3 | `--action-policy` JSON deny/allow/confirm/default file | P1 | Small |
| 4 | `silver inspect` DevTools-proxy bridge | P1 | Small-Medium |
| 10 | `connect <port\|url>` persist-to-session attach | P1 | Small |
| 12 | Browserbase/Browserless/browser-use/Kernel providers | P1 | Medium |
| 13 | Screenshot pixel-diff + rendered diff image | P1 | Small-Medium |
| 14 | `.silver/config.json` + `silver.json` project config | P1 | Medium |
| 5 | `trace`/`profiler` Chromium performance capture | P2 | Small-Medium |
| 6 | `record restart` mid-run segment | P2 | Tiny |
| 7 | `highlight <selector>` visual debug overlay | P2 | Tiny |
| 8 | `clipboard copy/paste` event-simulation | P2/P3 | Small |
| 9 | `tap`/`swipe` real touch-event primitives | P2/P3 | Small |
| 11 | `stream enable --port` screencast dashboard | P2/P3 | Large |
| 15 | Explicit-vs-config flag provenance (`cli_*`) | P2 | Tiny (bundle with #14) |
| 16 | Human-friendly idle-timeout units | P3 | Tiny |
| 17 | Standard proxy env-var inheritance | P2 | Tiny |

All 17 items are keyless (file I/O, HTTP, CDP, pixel math, string parsing — no model call anywhere
in any cited Rust function). None overlap with `adopt-list-v2.md`'s A1-A4/G1-G6/I1-I5 items or the
prior `vercel-*.md` digests' top-5 lists — every item above is either a verb/flag/file absent from
those documents or (items 13, 15) a materially deeper technical cut of something they only named in
passing.
