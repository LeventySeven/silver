# ev-parallel: parallel multi-agent / multi-browser orchestration

Scope: objective fact digest on requirement (d) — many sub-agents each launching
their OWN browser session, OR many agents sharing ONE browser doing parallel
tasks (tabs/contexts). Grounded in `silver` (Rust), `skill/agent-browser`
("moxxie", TS/Playwright), `reference/webwright` (Python), and the Aside
teardown digest at `research/sources/aside-06-memory-subagents.md`. All claims
anchored to files read directly.

## Facts

### silver (Rust) — session-scoped daemon, N-daemons-in-parallel, single-Mutex serialization inside each
- Each `--session <name>` gets its own OS-process daemon and its own Unix
  socket (`{session}.sock`) / pid file / stream file under a namespaced socket
  dir (`cli/src/native/daemon.rs:23-89`, `run_daemon(session: &str)`).
  `get_socket_dir()` additionally scopes by `SILVER_NAMESPACE`
  (`cli/src/connection.rs:97-137`), so different worktrees/agents never
  collide even on session-name reuse.
- README documents exactly the "many sub-agents, each own browser" pattern as
  a first-class, named feature: `## Sessions — Run multiple isolated browser
  instances` with the literal example `agent-browser --session agent1 open
  site-a.com` / `agent-browser --session agent2 open site-b.com`
  (`silver/README.md:592-600`), plus `AGENT_BROWSER_NAMESPACE` /
  `--namespace <name>` to "Isolate daemon sockets and restore-state
  directories" (`silver/README.md:711`, `:882`).
- Inside one daemon, all connections are handled by `tokio::spawn`-ed tasks
  (`cli/src/native/daemon.rs:216-217`) but every command locks a single
  `Arc<tokio::sync::Mutex<DaemonState>>` (`daemon.rs:189-191,443-446`) — i.e.
  commands against the *same* session execute strictly one-at-a-time even
  though the socket accepts concurrent connections. `DaemonState` holds
  exactly one `Option<BrowserManager>` (`native/actions.rs:277`) — one browser
  per daemon/session.
- Multi-tab support exists inside that one browser/daemon:
  `BrowserManager::tab_new`, `tab_switch`, `tab_close_by_id`, `tab_list`
  (`cli/src/native/browser.rs:960-1111`; dispatch in
  `cli/src/native/actions.rs:5089-5128`) — tabs are addressable by a stable
  `tab_id`/`format_tab_id` (`t{n}`). But because all commands funnel through
  the one `DaemonState` Mutex, "parallel tasks in tabs" is actually
  *serialized switch-and-act*, not concurrent execution — there is no
  evidence of per-tab independent locks or concurrent CDP command dispatch
  across tabs.
- The MCP server (`cli/src/mcp.rs`) exposes an optional `session` argument on
  every browser tool call (`append_session_args`, `mcp.rs:3448-3452`;
  `TOOL_SESSION`/`TOOL_SESSION_LIST`/`TOOL_SESSION_INFO`, `mcp.rs:151-154`),
  so an MCP host driving several concurrent tool-call streams can route each
  to a different named session/daemon — this is the mechanism by which many
  agents in one host process each get their own browser.
- Concurrency runtime: `tokio` with `rt-multi-thread` (per `ev-language.md`
  finding, `cli/Cargo.toml`), true OS-thread-backed async — daemons for
  different sessions run as fully independent OS processes regardless.

### skill/agent-browser ("moxxie", TS/Playwright) — one detached Chromium per named session, no daemon serialization, no tab/context API
- `openSession(name, opts)` spawns a **detached** Playwright-Chromium
  subprocess per session name with its own `--user-data-dir`
  (`src/core/session.ts:118-184`); the CLI process itself is stateless —
  every later command `connect()`s over CDP, acts, and lets the browser keep
  running (`session.ts:1-13` doc comment, `:242-260`).
- `connect()` returns `context = browser.contexts()[0]` and
  `page = context.pages()[0] ?? newPage()` (`session.ts:250-256`) — i.e. it
  always targets the browser's *first* context/page. There is **no** locking
  primitive anywhere in `src/` (grep for `lock|Lock|Mutex` returns zero
  concurrency-control hits) — two commands issued concurrently against the
  same session name race on the same page with no serialization.
- `tab`, `frame`, `network`, `pdf` are explicit stubs: `case 'tab': ...
  return notImplemented()` (`src/core/handlers.ts:283-288`) — moxxie has
  **no** multi-tab or multi-context command surface at all today.
- Isolation model: different session names = different OS processes (`spawn`,
  `detached: true`, `child.unref()`, `session.ts:147-151`) with separate
  user-data-dirs, so N agents each calling `openSession("agentN")` get N
  fully isolated, truly parallel-safe browsers — same pattern as silver's
  `--session`, but with zero in-process daemon/serialization layer (no
  socket server; each CLI invocation is its own short-lived process that
  connects/disconnects over CDP).

### reference/webwright (Python) — single agent, "task = script", sessions are a manual sidecar convention, explicitly not multi-agent
- README states the design intent directly: *"Webwright gives LLM a terminal
  where it can launch multiple browser sessions to inspect the page and
  complete a web task... **No multi-agent system, no graph engine, no plugin
  layer, no hidden orchestration** — just a terminal, a browser, and a
  model."* (`reference/webwright/README.md:19`). This is an explicit design
  disclaimer against the parallel-multi-agent requirement.
  `persistent_local_browser.py` (`create`/`info`/`release` subcommands,
  lines 1-25) spawns one detached Chromium per invocation with a generated
  `uuid` id and its own `--user-data-dir`/sidecar JSON, structurally the same
  isolation shape as moxxie's `session.ts` — but orchestration of *multiple*
  such sessions running at once is left entirely to whatever drives the CLI
  (a single model/terminal loop in webwright's own design), not built in.
- Its execution model is a synchronous, one-command-at-a-time agent loop
  (`config/task_showcase.yaml` shows a single `bash_command` per turn,
  `observation_template` fields like `Command`, `Return code` — one shell
  command in, one observation out) — no async fan-out of multiple browser
  tasks from one webwright process was found.
- `local_browser.py`/environment code uses `asyncio` (`async_playwright()`,
  lines ~311-316 per `ev-language.md`), a cooperative single-threaded event
  loop — adequate for one browser's I/O, not evidence of built-in parallel
  multi-browser dispatch.

### Aside (SOTA browser agent) — the one source with an explicit, load-bearing answer to "shared browser vs. own browser"
Per `research/sources/aside-06-memory-subagents.md` (teardown digest, not
code in this repo, but the most directly relevant design precedent found):
- Pattern 12 (verbatim quote cited in the digest): *"Subagents don't have an
  access to your open browser tabs, live page/form state or REPL state, even
  in `fork_self` mode... Subagents need to open new tabs."* — i.e. Aside's
  answer is **own browser/tab per subagent, always**, even when the child
  inherits the parent's full transcript. Live actuation state (tabs,
  forms) is never shared across concurrent agents.
- Isolation is enforced by a **tool-gate blocklist** on the child (deny
  `subagent`/`fork_subagent` tool names, deny live-tab access), not by
  filtering what context the child sees — "Isolation is a permissions
  problem, not a context problem."
- Hard structural caps: exactly one level of subagent nesting (no recursion,
  enforced in the tool-execute hook), and a concurrency gate throwing "Too
  many active subagents… Limit: 5" at ≥5 concurrent children under one
  parent.
- Minimal two-tool surface: `subagent(action: spawn|resume, ...,
  run_in_background?)` (foreground blocks the parent call; background returns
  a `task_id` and the result is later delivered via a "steer" injected
  mid-run) + `subagent_wait(task_ids)` to block for named background
  children.
- Explicit rationale given for the never-share-live-state rule: "sharing
  open CDP targets/tabs across concurrent agents would create races and
  undefined ownership over form/session state" — a direct architectural
  argument against the "many agents share ONE browser's tabs" branch of the
  requirement.

## Pros / Cons by architecture

| Model | Pros | Cons |
|---|---|---|
| **silver: N daemons, one per `--session`** | Documented, first-class CLI/README feature; full process isolation between agents (separate sockets, separate `BrowserManager`); MCP server can route different tool-call streams to different sessions via a `session` arg; namespace scoping avoids cross-agent/cross-worktree collisions | Within one session/daemon, all commands (including cross-tab ones) serialize on one `tokio::sync::Mutex<DaemonState>` — no true intra-browser command parallelism; running many daemons means many Chrome processes (memory cost); tab API exists but is a single-active-tab-pointer model, not concurrent-tab execution |
| **silver: multiple tabs inside one daemon** | Tab primitives exist (`tab_new/switch/close/list`) and are addressable by id — usable for sequential multi-page workflows in one browser | Not usable for true parallel agent tasks today — every tab op still goes through the same global Mutex, so two "agents" sharing one daemon would still execute strictly turn-by-turn, and nothing in the code partitions state (ref maps, event trackers) per tab |
| **moxxie (TS): N detached Chromium processes, one per session name** | Simple, robust isolation — separate OS process + separate user-data-dir per session, no shared daemon state to race on across sessions; stateless CLI (no daemon lock contention at all) | No daemon means no serialization *within* a session either — concurrent commands against the *same* session name race on `contexts()[0]`/`pages()[0]` with zero locking; no tab/context command surface (`tab` is `notImplemented()`), so "one browser, many parallel tasks via contexts" is not just unserialized, it's unbuilt |
| **webwright (Python): one script/terminal drives everything** | Sidecar-session pattern (`persistent_local_browser.py`) gives the same per-session process isolation primitive as moxxie if a caller chooses to spawn several; "task = re-runnable script" is a strong story for resumable *single*-agent long-running tasks | Explicitly disclaims multi-agent/orchestration in its own README; no async fan-out of multiple browser tasks observed in the driver code; parallel orchestration of multiple sessions is entirely the caller's responsibility, not a built-in capability |
| **Aside (design precedent, not code we have)** | The only source with an explicit architectural verdict: always give each subagent its own tab/browser context, never share live actuation state, enforce isolation via tool-gates + a concurrency cap (5) + one-level nesting; minimal 2-tool spawn/wait surface is directly portable to a CLI (`subagent spawn --background`, `subagent wait <id>`) | Not an available codebase here — only a teardown digest; the caps/mechanism (in-memory session tracker with `parentId`) assume a persistent daemon and would need re-implementation as CLI-appropriate primitives (env flag / lockfile semaphore) per the digest's own anti-pattern note (#8) |

## Relevance to the 9 criteria (as stated in the project brief)
Only criterion (d) — parallel multi-agent/multi-browser orchestration — is
in scope for this digest; the other 8 (agent-ergonomic CLI+SKILL.md, fast
quick tasks, long-running/resumable tasks, install-and-use zero-config,
keyless, plus install/speed/ecosystem/dev-velocity covered in
`ev-language.md`) are covered by sibling `ev-*` docs. Specifically for (d):
- **Many sub-agents, each own browser** — best supported today by **silver's
  `--session`/`--namespace` model**: it is the only one of the three bases
  with *documented, README-first-class* support for this exact pattern, plus
  an MCP-level `session` argument for a host to route concurrent tool calls.
  moxxie supports the same isolation shape (N detached processes) but
  undocumented as a feature and with zero locking discipline within a
  session; webwright supports it only as a manual convention its own docs
  say is not built for multi-agent use.
- **Many agents sharing ONE browser (tabs/contexts)** — **not well
  supported by any of the three bases as built.** Silver has tab primitives
  but serializes all access through one Mutex (turn-by-turn, not parallel);
  moxxing has no tab/context API at all; webwright has neither. Aside's own
  design explicitly rejects this pattern for live state (tabs/forms) citing
  race conditions and undefined ownership — the strongest available argument
  that "shared browser, parallel tabs" is the wrong branch to build toward,
  versus "own context per agent."
- **Ideal design, closest base**: an Aside-shaped subagent layer (own
  browser context per agent, tool-gated isolation, a small concurrency cap,
  spawn/wait as the only two subagent verbs) built **on top of silver's Rust
  daemon-per-session model** — since silver already has the process/socket
  isolation, namespace scoping, and MCP session-routing plumbing that Aside's
  pattern assumes a persistent daemon provides; moxxie's simpler
  process-per-session model is the cheaper fallback if daemon complexity is
  rejected, but would first need real per-session command serialization
  (currently absent) and a genuine multi-context/tab API (currently absent)
  before it could safely support even one browser's worth of concurrent
  work.
