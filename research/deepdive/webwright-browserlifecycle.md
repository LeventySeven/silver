# Webwright — Browser Lifecycle (deep dive)

**Lens:** exactly how Webwright OPENS + PERSISTS + REUSES + CLEANS UP a browser
across a long task, read fully from source, then measured against Silver.

**Files read in full:**
`reference/webwright/src/webwright/tools/persistent_local_browser.py`,
`reference/webwright/src/webwright/environments/local_browser.py`,
`reference/webwright/src/webwright/config/persistent_browser.yaml`,
`reference/webwright/src/webwright/agents/default.py`.
Silver counterpart read in full: `silver/src/core/session.ts` (+ tree scan of
`silver/src/core` and `silver/src/task`).

---

## 1. What Webwright does + HOW (the mechanism, precisely)

Webwright has **two independent browser codepaths**. The benchmark long-task
engine uses the first; the second is a live in-process env used elsewhere.

### 1a. The CLI-managed persistent browser (the one the owner asked about)

`persistent_local_browser.py` is a standalone `argparse` CLI with three verbs —
`create`, `info`, `release` — invoked by the agent as ordinary bash steps
(`persistent_browser.yaml:105`, `:115-123`). The entire persistence design is:

**OPEN** — `_cmd_create` (`persistent_local_browser.py:107-169`):
- Locates the Playwright-bundled Chromium via a throwaway `sync_playwright()`
  context, reading `p.chromium.executable_path` (`:54-66`).
- Builds the arg vector (`:117-130`): `--remote-debugging-port=0` (let Chromium
  pick a free port), `--user-data-dir=<per-session>`, `--no-first-run`,
  `--no-default-browser-check`, `--disable-features=TranslateUI,MediaRouter`,
  `--window-size=1280,1800`, plus `--headless=new` and `--no-sandbox` (both
  default True, `:126-129`).
- Spawns **detached** with `subprocess.Popen(..., start_new_session=True)`
  (`:141-144`) so the browser gets its own process group and **survives the
  parent shell exiting** — this is what makes it outlive a single bash step.
- **Readiness detection is stderr-scraping**: `_wait_for_devtools_url`
  (`:81-104`) reads Chromium's stderr line-by-line until the regex
  `DevTools listening on (ws://\S+)` (`:43`) matches, extracting `connectUrl`.
  It polls `proc.poll()` each loop so an early Chromium crash raises with the
  stderr tail instead of hanging (`:86-94`); hard timeout 30s (`:266-269`).
- **Persists state as plaintext JSON** (`:154-163`): `{id, pid, connectUrl,
  userDataDir, executablePath, headless, createdAt}` written with a direct
  `out_path.write_text(...)` (`:163`) — not atomic, not encrypted. Prints
  `LB_CONNECT_URL=...` etc. for the agent to read (`:165-168`).

**REUSE** — every later Playwright step (system prompt, `persistent_browser.yaml:
125-165`): `connect_over_cdp(connectUrl)` → do work → **`await browser.close()`**.
The single load-bearing fact (documented `:8-11`, `:157`): for a CDP-attached
browser, `browser.close()` **only drops the Playwright transport; the Chromium
subprocess keeps running**. So page, cookies, localStorage, and any open
dropdown/dialog survive across independent bash steps. The agent is told
NEVER to kill the subprocess itself (`persistent_browser.yaml:105`, `:111`).
This is the whole persistence model: *the browser is a daemon; each command
re-attaches and detaches.*

**LIVENESS** — `_cmd_info` (`:172-180`): `os.kill(pid, 0)` (`_pid_alive`,
`:69-78`) + JSON dump with an `alive` flag. It only *reports*; it does not gate
`connect` — a stale session file will still be handed to `connect_over_cdp`,
which then hangs/errors.

**CLEANUP** — `_cmd_release` (`:203-228`) → `_terminate_pid` (`:183-200`):
SIGTERM, poll up to `--kill-timeout` (default 10s), escalate to SIGKILL, then
optionally `shutil.rmtree` the user-data-dir and `unlink` the session file
(both default True, `:285-296`). Release is a **separate CLI verb**, and the
completion gate (below) refuses `done` until `.lb_session.json` is gone — this
is how Webwright avoids zombie Chromium processes.

### 1b. The in-process `LocalBrowserEnvironment` (second codepath, NOT the long-task engine)

`local_browser.py` owns one asyncio loop and one browser, and `exec()`s each
model action as an async snippet with `page/context/browser/playwright/task` in
scope (`:432-450`). Three modes (`:327-362`): `local_cdp` (attach to a Chrome on
:9222, **auto-launching real Chrome/Edge** if absent via macOS `open -na` or a
direct exec, `_ensure_local_cdp_browser:262-308`), `local_persistent`
(`launch_persistent_context`, `:342-353`), `local_launch` (fresh, `:354-362`).
It captures a **structured per-step observation** after every action —
`_capture_observation:463-502`: url, title, `body.aria_snapshot()`, a viewport
screenshot, last-20 step console + last-50 rolling console — and auto-appends
`steps/step_NNNN.py` + a concatenated `script.py` (`_persist_step_code:422-430`).
Page-level `console`/`pageerror` listeners accumulate history for the life of
the env (`_attach_page_listeners:370-386`). This codepath is where Webwright's
richest lifecycle ideas live, even though the benchmark uses the CLI codepath.

---

## 2. Why it beats competitors

- **Language-agnostic persistence via a filesystem handshake.** State lives in a
  JSON file (`connectUrl` + `pid`), not in a long-lived process's memory. Any
  later step — bash, Python, even a different tool — can re-attach. This is what
  lets a *stateless per-command* agent harness drive a *stateful* browser, the
  same architectural bet Silver makes.
- **Detach + CDP-only-close is the cheapest possible durable session.** No
  daemon to write, no IPC protocol; the OS process table *is* the session
  registry and `start_new_session=True` is the entire durability mechanism.
- **Cleanup is enforced, not hoped-for.** The completion gate ties `done` to
  `.lb_session.json` being deleted (`persistent_browser.yaml:111`, `:320-321`),
  making zombie-avoidance a hard contract rather than agent discipline.

---

## 3. Concrete gap vs Silver (browser-lifecycle lens)

**On lifecycle proper, Silver already MATCHES or BEATS Webwright — this is not a
gap, and the deep read confirms it point-by-point** (`silver/src/core/session.ts`):

| Concern | Webwright | Silver | Winner |
|---|---|---|---|
| Detach | `start_new_session=True` (`:141`) | `spawn(detached:true)` + `child.unref()` (`session.ts:233-237`) | tie |
| Free port | `--remote-debugging-port=0` (`:119`) | same (`session.ts:216`) | tie |
| Readiness | **scrape stderr** for `DevTools listening` (`:81-104`) | read `DevToolsActivePort` file, then confirm `/json/version` (`session.ts:272-305`) | **Silver** (no buffering/locale/line-race/redirect fragility) |
| State at rest | **plaintext** `write_text` (`:163`) | **AES-256-GCM** + **atomic** temp+rename (`writeSidecar`/`atomicWrite`, `session.ts:122-149`) | **Silver** |
| Reuse | `connect_over_cdp` → `browser.close()` | `connectOverCDP` → caller `browser.close()` (`connect`, `session.ts:328-348`) | tie (identical model) |
| Stale-session guard | `info` only *reports* liveness (`:172-180`) | **gates** connect: `isPidAlive` fails a dead pid so caller re-spawns (`session.ts:335-337`) | **Silver** |
| External/shared browser | `local_cdp` mode auto-starts Chrome (`:262-308`) | `connectExternalSession` (`session.ts:360-380`), pid=0, gc/respawn skip it | tie / Silver (safer scoping) |
| Teardown correctness | SIGTERM→SIGKILL then `rmtree` immediately (`:183-228`) | SIGTERM→**wait for actual exit**→SIGKILL→*then* rm dir (`closeSession`/`waitForExit`, `session.ts:437-494`) | **Silver** (avoids Chromium resurrecting the profile dir) |
| Process-group footgun | n/a | pid≤0 treated dead so `kill(0,…)` never nukes the group (`isPidAlive:74-82`, `closeSession:458`) | **Silver** |

**Latency finding (load-bearing, honest):** Webwright's long-task engine is
**not** evidence for a persistent-controller daemon. It reconnects over CDP and
drops the transport on **every single step**, exactly like Silver. The only
"persistent" thing in both is the browser subprocess. So Webwright *validates*
Silver's reconnect-per-command connection model rather than exposing a gap; the
Rust-daemon latency question belongs to Vercel, not Webwright.

**The one genuine lifecycle gap — engine choice.** Webwright's live env is
Chromium/Chrome/Edge across three modes; more importantly, its skill layer
elsewhere reaches for Firefox to dodge TLS/H2 fingerprint blocks
(`ERR_HTTP2_PROTOCOL_ERROR`). Silver is **Chromium-only**:
`session.ts:18` imports only `{ chromium }`, `openSession` has no engine param
(`:210` uses `chromium.executablePath()`), and a src-wide grep for
`firefox|webkit` returns **nothing**. A site that fingerprint-blocks Chromium's
client hello has no fallback engine in Silver today.

---

## 4. Keyless adopt recommendations (ranked)

**ADOPT-1 — `--engine firefox|chromium|webkit` on `session open` (Priority: MEDIUM-HIGH, small).**
The only true lifecycle gap. Playwright already bundles Firefox/WebKit, so this
is a launch-selector plumbed through `openSession` (add an `engine` to
`OpenOptions`, record it in the sidecar, dispatch on it in `connect`). Firefox
does not expose the `DevToolsActivePort`/CDP JSON endpoint the same way — Silver
would need a Playwright-server (`launchServer` + `wsEndpoint`) attach path for
non-Chromium engines rather than the raw-CDP path. Fully keyless. Closes the one
real fingerprint-block failure mode.

**ADOPT-2 — carry over Webwright's *enforced release* contract to Silver's task gate (Priority: MEDIUM, tiny).**
Webwright refuses `done` unless the session file is gone (`persistent_browser.
yaml:111`, `:320-321`). Silver's teardown is already safer, but nothing *forces*
a long unattended run to release. Add an optional `task verify --require-closed`
that fails unless the named session's sidecar is absent (or pid dead). Purely a
disk/pid check — keyless.

**ADOPT-3 — port `LocalBrowserEnvironment`'s structured per-step observation cadence, keyless (Priority: MEDIUM).**
Webwright captures url+title+aria+screenshot+console after **every** action
(`:463-502`); Silver only screenshots on an explicit `task checkpoint`. Add an
opt-in `--auto-checkpoint-every N` so long runs accrue evidence without host
discipline. Silver's diff-snapshot format (`perception/diff.ts`) is already
*better* per call than a flat `aria_snapshot()`; this is only about cadence.

**ADOPT-4 (adjacent, from `agents/default.py`) — mechanical ARIA pruning (Priority: MEDIUM, keyless).**
`_prune_old_observation_aria_snapshots:275-301` strips the aria payload from all
but the last-N observations in place — bounded context growth with **zero model
calls**. Silver's `action_log.jsonl` grows unbounded; add last-N snapshot
retention on `task log`. Directly keyless. (The sibling `_compact_history:303-339`
and `_tool_gate_error:208-268` self-reflection gate are *not* keyless as written
— they call the model — but their structural halves, a host-fillable compaction
template and an evidence-existence completion check, are adoptable; these belong
to the long-task-engine lens, not lifecycle.)

**Bottom line:** Silver's browser *lifecycle* is already a superset of
Webwright's (better readiness detection, encrypted+atomic sidecars, stale-pid
gating, resurrection-safe teardown, safe external-attach). The only lifecycle
capability Webwright has that Silver lacks is **multi-engine launch**; everything
else Webwright offers is long-task *context/gating* engine, not lifecycle.
