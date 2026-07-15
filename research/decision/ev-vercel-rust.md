# Evidence: Vercel/Rust fork base (Silver = forked agent-browser, Rust CLI)

Sources read: `/Users/seventyleven/Desktop/Silver/silver/cli/src/**` (all 71,796 lines across
75 files per `wc -l`), `/Users/seventyleven/Desktop/Silver/silver/Cargo.toml`,
`/Users/seventyleven/Desktop/Silver/silver/package.json`, `/Users/seventyleven/Desktop/Silver/silver/README.md`,
`/Users/seventyleven/Desktop/Silver/silver/AGENTS.md`, `/Users/seventyleven/Desktop/Silver/silver/scripts/postinstall.js`,
diffed against unmodified upstream at `/Users/seventyleven/Desktop/Silver/reference/agent-browser`.
Two real `cargo build` runs performed live (see Build section) rather than assumed.

## Facts

### Verb surface / agent ergonomics
- `cli/src/commands.rs` is 5,795 lines and dispatches on a flat string match (`match cmd { "open"|"goto"|"navigate" => ..., "click" => ..., "extract" => ..., "find" => ..., "state" => ..., "diff" => ..., "react" => ..., ... }`, commands.rs:368-3102+). A `grep -c '"\w*" =>'` sweep surfaced 60+ distinct top-level verbs (open/back/forward/reload/read/click/dblclick/fill/type/hover/focus/check/uncheck/select/drag/upload/download/press/keyboard/scroll/wait/screenshot/pdf/snapshot/extract/eval/close/auth/confirm/deny/connect/stream/get/is/find/mouse/set/network/storage/cookies/tab/window/frame/dialog/trace/profiler/record/console/errors/highlight/clipboard/state/tap/swipe/device/diff/batch/react/pushstate/removeinitscript, etc).
- Stable tab-id scheme (`t1`, `t2`…) never reused within a session (commands.rs:163-228, README.md:332) — explicitly agent-ergonomic (avoids stale positional-index bugs).
- Element refs use an `@e1`-style stable id convention (README.md:332 references this alongside tab ids).
- `mcp.rs` exposes the whole CLI surface as ~20 namespaced MCP tools with typed fields (`url`, `selector`, `text`, `key`, `session`) plus an `extraArgs` escape hatch for full CLI parity (README.md:520, mcp.rs exists as its own module).
- A `skills/agent-browser` directory + `skill-data/` ships a general SKILL.md-style package for host agents (silver/skills/agent-browser, silver/skill-data/{core,dogfood,slack,electron,vercel-sandbox,agentcore}).
- Error strings are AI-facing: `browser::to_ai_friendly_error` is called from the action-dispatch path (actions.rs:1631, 2033) to convert Rust/CDP errors into agent-readable messages.

### Speed / daemon architecture
- One background daemon process per named session (`native/daemon.rs`); a Unix-domain socket (`.sock`) on macOS/Linux or a deterministic-hash TCP port on Windows (daemon.rs:23-390, `get_port_for_session`).
- `DaemonState` (actions.rs:276-382) holds `browser: Option<BrowserManager>` — **one Chrome instance per daemon**, driven by newline-delimited JSON commands over the socket (`handle_connection`, daemon.rs:392-469), i.e. persistent-process + IPC, not a spawn-per-command CLI.
- Idle-timeout auto-shutdown (`SILVER_IDLE_TIMEOUT_MS`) and a 100ms drain-interval tick that reaps a crashed/closed Chrome process and periodically autosaves state (daemon.rs:119-166, 225-238) — long-lived daemon with self-cleanup, not a leaking background process.
- `connect <port|url>` lets a session attach to an **existing** CDP endpoint instead of launching its own Chrome (commands.rs:1288-1330), so a daemon can drive a browser someone else launched.
- CDP client (`native/cdp/client.rs`), CDP event loop (`native/stream/cdp_loop.rs`), a live WebSocket "stream" server per session for real-time viewport/console/network mirroring to a dashboard (README.md:1375-1391, `native/stream/*`).

### Session persistence + restore (long-task readiness)
- `--session <name>` / `SILVER_SESSION` env selects/creates a named daemon; `--restore` auto-saves/restores cookies + localStorage keyed to that session name (README.md:676-712, flags.rs:60-679).
- State is saved on `close`, on idle-timeout, on daemon shutdown, **and periodically** every `SILVER_AUTOSAVE_INTERVAL_MS` (default 30000ms) while the browser is open, so an agent that dies mid-task still leaves a recent state snapshot (README.md:692, daemon.rs:126, 161-166, 236).
- `state.rs` (1,061 lines) implements per-origin cookie + localStorage + sessionStorage save/restore (`save_state`/`load_state`, state.rs:250-531), a `sessions/` directory (`get_sessions_dir`, state.rs:845-846), AES-256-GCM encryption-at-rest option (`AGENT_BROWSER_ENCRYPTION_KEY`, README.md:696, Cargo.toml `aes-gcm` dep).
- `session id --scope worktree|cwd|git-root --prefix <name>` generates a **stable, deterministic** session key so a resumed agent run reconnects to the same daemon/state (connection.rs:450-570, README.md:582/616).
- No task-script/log-as-artifact abstraction exists in this codebase — persistence here is browser-state (cookies/storage) resumability, not a re-runnable script-with-logs model (that pattern lives in Webwright, not here — confirmed by absence of any "task" or "script" replay concept in cli/src).

### Multi-session / parallel support
- Confirmed N-agents-N-isolated-sessions: `agent-browser --session agent1 open site-a.com` / `--session agent2 open site-b.com` run as two separate daemon processes, each with its own Chrome instance, cookies, storage, navigation history, and auth state (README.md:593-628).
- `SILVER_NAMESPACE` env var scopes the entire socket directory (`namespaces/<ns>/run/`), letting e.g. separate git worktrees or CI jobs run fully isolated session sets without collision (connection.rs:129-132, tested at daemon.rs:566-586).
- `session list` enumerates all active daemons (connection.rs walks the socket dir; README.md:606-611); `close --all` closes every session (README.md:145, connection.rs:836-877).
- Shared-browser parallelism is also possible via `connect <port>` (commands.rs:1288-1330) — multiple daemons/agents can attach to one already-running Chrome's CDP endpoint and each drive their own tab (`tab new`, `tab` stable-id list, commands.rs:1573+, PageInfo/pages Vec in browser.rs:297-382).
- A local dashboard process (port 4848) shows all sessions live regardless of engine (Chrome/Lightpanda local, or cloud AgentCore/Browserbase/Browserless/Browser Use/Kernel) and can spawn new sessions from the UI (README.md:927-947).

### Difficulty of adding features (for us) in Rust
- Real build timings measured on this machine (Apple Silicon, arm64):
  - Full clean `cargo build --release` (LTO=true, codegen-units=1): **2m 19s** (229s CPU, 176% parallel util) for a 9.2MB single Mach-O binary.
  - Touch one file (`commands.rs`) + incremental `--release` rebuild: **1m 34s** — the `lto=true, codegen-units=1` release profile means even a single-file change re-links/re-optimizes the whole crate, a real iteration-speed cost.
  - Same touch + incremental **debug** build: **5.2s** — dev-profile iteration is fast; the expensive profile is release-only.
- A `[profile.ci]` exists (`lto = "thin"`, `codegen-units = 16`, Cargo.toml:63-66) specifically to make CI/release builds faster than the shipped `[profile.release]`, evidence the maintainers already hit this same LTO cost and mitigated it for CI (but the fully-optimized profile is still what ships).
- We (the "we" of this project) have already added two non-trivial Rust modules on top of upstream: `native/extract.rs` (443 lines, "Silver Delta 1" keyless ID-grounded extract, extract.rs:1-34) and `native/egress.rs` (311 lines, DNS-SSRF guard) — both are files present in `silver/cli/src/native` but absent from the unmodified `reference/agent-browser/cli/src/native` (confirmed via `diff -rq`, only-in-silver: `egress.rs`, `extract.rs`). This proves the fork is buildable and extensible by us today, not just theoretically forkable.
- `diff -rq` between `silver/cli/src` and unmodified upstream shows **46 of ~64 files already diverge**, i.e. most of the surface has already been touched/rebranded, not just the two new files — nontrivial ongoing maintenance surface against upstream.
- 838 `#[test]` functions exist under `cli/src` (`grep -rn '#\[test\]' | wc -l`), i.e. a real Rust test suite already backs this code, which lowers the risk of silent regressions when adding features but also means new features are expected to carry matching Rust tests (higher authoring cost per feature than an untested script).
- Async Rust with `tokio`, `RwLock`/`Mutex`-guarded shared daemon state (`Arc<RwLock<...>>` used pervasively in `DaemonState`, actions.rs:283-348), raw CDP protocol handling (`cli/cdp-protocol`, `native/cdp/*`) — this is systems-level async Rust, not scripting; ramp-up cost for a contributor is materially higher than TS/Python.

### Distribution
- End-user distribution is npm-wrapped native binary: `package.json` `bin: { "silver": "./bin/silver.js" }`; `scripts/postinstall.js` detects OS/arch/musl and downloads the matching prebuilt binary (`agent-browser-<platform>-<arch>`) from a GitHub Releases URL, then on global installs replaces the npm shim with a direct symlink to the native binary (postinstall.js:1-49, package.json `postinstall` script).
- Runtime end state is a **single native binary**, not "needs cargo installed" — cargo is only required to build from source (`build:native`, `build:macos`, `build:linux`, `build:windows`/docker cross-build scripts in package.json).
- Building from source requires the full Rust toolchain (`rustup`, `cargo`) plus, per `Cargo.toml`, native deps like `aes-gcm`, `zip`, `image`(`ravif`/AV1), `reqwest` w/ rustls — a heavier local dev-environment setup than a pure-TS/Node or Python project, though irrelevant to end users who only run the downloaded binary.
- Cross-platform builds use Docker (`docker/docker-compose.yml`, `build:linux`/`build:windows` targets) — cross-compilation infra already exists and works today (evidenced by the release script wiring), not something to build from scratch.

## Pros
1. Broadest verb surface of any asset in the project (60+ commands) — closest to "the ULTIMATE" CLI surface out of the box, already agent-ergonomic (stable ids, AI-friendly errors, MCP tool wrapper).
2. Daemon-per-session architecture is exactly the "N agents, N isolated sessions OR shared browser" model the goal requires, and it's already built and documented (`--session`, `SILVER_NAMESPACE`, `connect <port>`), not something we'd need to design from scratch.
3. Session persistence (autosave every 30s + on close/idle/shutdown, deterministic `session id --scope worktree`) gives real long-task resumability for browser *state* today.
4. Ships as a single native binary via npm postinstall — zero-config keyless install-and-use satisfies criterion (e) directly; no runtime cargo/npm build step for end users.
5. We've already proven we can extend it (extract.rs, egress.rs shipped and buildable) and it carries an 838-test safety net.
6. Real-time WebSocket stream + local dashboard (port 4848) is a capability none of the other assets were confirmed to have — useful for multi-agent observability.

## Cons
1. Release-profile iteration cost is real and measured: a single-file touch costs ~1m34s to rebuild in release mode (LTO + codegen-units=1) versus 5.2s in debug — feature iteration in the profile that actually ships is slow; a `[profile.ci]` mitigation exists but isn't what's distributed.
2. 46 of ~64 source files already diverge from upstream — every future upstream Vercel security/bugfix release requires re-diffing and re-merging by hand; this fork is not a thin, easily-rebaseable patch set anymore.
3. No re-runnable "task = script, logs = artifact" concept anywhere in this codebase — the Webwright long-running-task ergonomic (criterion (c) as Webwright defines it) is absent; what exists is browser-state persistence, not task/script persistence. Would need to be designed and added.
4. Async Rust + raw CDP protocol handling is a materially higher-skill, higher-review-cost codebase to extend than the TS/Playwright asset — every new feature likely needs matching Rust tests given the existing 838-test culture, raising authoring cost per feature.
5. One `browser: Option<BrowserManager>` per daemon means true single-Chrome-multi-agent sharing only works via explicit `connect <port>` to someone else's already-launched Chrome — there's no built-in "N agents auto-share one browser, isolated by tab" orchestrator; that composition has to be hand-rolled by whoever launches the daemons.
6. Heavier local build toolchain (full Rust + native crates like `aes-gcm`, `zip`, `image`/AV1 via `ravif`) than a Node/TS or Python stack, and cross-platform release requires Docker cross-compiles — more moving parts to keep green.

## Relevance to the 9 criteria (as stated in the task)
- (a) agent-ergonomic CLI + general SKILL.md: **Strong.** 60+ verbs, stable ids, `skills/agent-browser` + `skill-data/` already exist.
- (b) fast quick tasks: **Good at runtime** (persistent daemon, no per-command Chrome relaunch) but **weak at dev-iteration speed** in the shipped release profile.
- (c) long-running/resumable tasks: **Partial.** Browser-state resumability (cookies/storage) is solid; there's no re-runnable-script/log-artifact model — that half of Webwright's pattern is missing entirely.
- (d) parallel multi-agent orchestration (isolated OR shared browser): **Strong primitives, no orchestrator.** `--session`/`SILVER_NAMESPACE` give isolation; `connect <port>` gives sharing; nothing composes these into a "launch N sub-agents" helper — that's on us to add.
- (e) install-and-use with zero config: **Strong.** npm postinstall downloads a single native binary; default session with no flags works out of the box.
- (f) keyless: **Consistent with the rest of the project** — nothing in `cli/src` calls out to a model provider; commands are deterministic CDP calls (matches the stated "Silver never calls a model" constraint, though this task did not re-audit every network call for a hidden LLM dependency beyond what was read).
- Ease of adding features (explicitly asked): **Moderate-to-hard.** Proven extensible (two shipped deltas) but release-profile rebuild cost and async-Rust/CDP complexity are real, measured costs, not guesses.
- Build times: **Measured** — 2m19s clean, 1m34s incremental-release, 5.2s incremental-debug.
- Distribution: **Strong.** Single binary, no cargo/npm needed at runtime.
