# Engine deep-dive: Webwright browser lifecycle + long-task engine vs Silver

Scope: exactly how Webwright opens/persists a browser across a long task,
checkpoints, and resumes — and what of its engine is genuinely superior to
Silver's task run-folder + session model. Everything below is read from source.

Files read:
- `reference/webwright/src/webwright/tools/persistent_local_browser.py`
- `reference/webwright/src/webwright/environments/local_browser.py`
- `reference/webwright/src/webwright/run/cli.py`
- `reference/webwright/src/webwright/agents/default.py`
- `reference/webwright/src/webwright/config/persistent_browser.yaml`
- Silver: `silver/src/core/session.ts`, `silver/src/task/index.ts`, `silver/src/task/store.ts`

---

## 1. How Webwright persists a browser across a long task

Webwright has TWO browser codepaths. The benchmark long-task engine uses the
CLI-tool one, not the `LocalBrowserEnvironment` class.

### The persistence trick (the whole idea)
`persistent_local_browser.py` `create` (lines 107-169):
- `subprocess.Popen([chromium, --remote-debugging-port=0, --user-data-dir=<per-session>, --no-first-run, --no-default-browser-check, --headless=new, --window-size=1280,1800])`
- Detaches into its own process group via `start_new_session=True` (line 142) so
  the browser survives the parent shell exiting.
- **Reads Chromium's stderr line-by-line** until the regex
  `DevTools listening on (ws://\S+)` matches (`_wait_for_devtools_url`, 81-104),
  extracting the `connectUrl`.
- Persists `{id, pid, connectUrl, userDataDir, executablePath, headless, createdAt}`
  to `.lb_session.json` (154-163). Prints `LB_CONNECT_URL=...` etc.

Every subsequent step (persistent_browser.yaml lines 129-161, 342-358):
`connect_over_cdp(connectUrl)` → do work → **`await browser.close()`**. For a
CDP-attached browser `browser.close()` **only drops the Playwright transport;
the Chromium subprocess keeps running**, so the page, cookies, localStorage, and
any open dropdown/dialog survive across bash steps. This single fact is the
entire persistence model. The model is told NEVER to kill the subprocess itself;
release is a separate CLI verb.

`info` = `os.kill(pid, 0)` liveness + JSON dump (172-180).
`release` = SIGTERM → wait `kill_timeout` → SIGKILL, optional `rmtree` of the
user-data-dir + delete session file (183-228).

### The other codepath (not used by the long-task engine)
`LocalBrowserEnvironment` (local_browser.py) is a live, in-process env owning one
event loop and executing each model action as an `exec()`'d async python snippet
with `page/context/browser/playwright/task` in scope (432-450). It supports three
modes: `local_cdp` (attach to a Chrome on :9222, auto-starting Chrome/Edge if
absent, 262-308), `local_persistent` (`launch_persistent_context`, 342-353), and
`local_launch` (fresh, 354-362). It captures a **structured per-step observation**
— url, title, `body.aria_snapshot()`, viewport screenshot, console last-20 /
recent-50, python_output (463-502) — and auto-persists `steps/step_NNNN.py` plus an
appended `script.py` (422-430).

---

## 2. Silver ALREADY HAS (equal or better)

**The core browser-persistence engine is identical, and Silver's is more robust.**
`session.ts openSession` (204-270): detached Chromium (`detached:true`,
`child.unref()`), `--remote-debugging-port=0`, per-session profile,
`--headless=new`. Silver reads the **`DevToolsActivePort` file** then confirms via
`/json/version` (272-305) — strictly better than scraping stderr (no
buffering/locale/line-race fragility, works even if stderr is redirected).
`connect()` (328-348) does `connectOverCDP` per command and the caller
`browser.close()`s = CDP-only disconnect — **the exact same reconnect-per-command
pattern Webwright uses**. Silver additionally has: encrypted-at-rest sidecars
(AES-256-GCM, `writeSidecar`), PID-liveness with the `process.kill(0,...)`
process-group footgun handled (74-82), an **external-attach** mode
(`connectExternalSession`, 360-380) mirroring Webwright's `local_cdp` mode, and a
teardown that **waits for actual process exit before rm-ing the profile**
(437-494) to avoid Chromium resurrecting the dir — a correctness bug Webwright's
`release` does not guard.

- **`run_<n>` immutable attempt folders + "the script IS the artifact / re-run is
  the resume."** store.ts is explicitly this pattern (comment lines 1-20, cites
  "Webwright DECISION §3"): `startRun` opens a new numbered folder each call,
  `latestRun` = highest n, with plan.md + action_log.jsonl + screenshots/ +
  checkpoint.json. This is a 1:1 port of Webwright's `final_runs/run_<id>/`.
- **plan.md Critical-Points checklist** (`planTemplate`, `parsePlan`) — same
  device Webwright uses.
- **Append-only JSONL action log**, per-checkpoint screenshots captured under the
  session lock (`captureScreenshot`, index.ts 317-331).
- **`task exec`** re-dispatches through the real CLI and auto-logs command+result
  (index.ts 227-269) — arguably cleaner than Webwright's `script.py` string append
  because it re-applies every registry/egress/confirm gate.

**Latency finding (empirical, load-bearing):** Webwright is NOT evidence for a
persistent-controller daemon. Its long-task engine reconnects over CDP and drops
the transport **on every single step**, exactly like Silver. The "persistent"
thing in both is only the browser subprocess. So Webwright validates Silver's
connection model rather than exposing a gap against it; the Rust-daemon latency
axis is a Vercel question, not a Webwright one.

---

## 3. GAP: what Silver should adopt (all keyless)

**GAP-1 — mechanical ARIA-snapshot pruning (no model needed).** `default.py`
`_prune_old_observation_aria_snapshots` (275-301) + config
`keep_last_n_observations` strip the aria payload from all but the last-N
observations in place, replacing with `(ARIA snapshot pruned…)`. This bounds
context growth with **zero model calls** — purely structural. Silver's action_log
grows unbounded with full snapshots. **Adopt:** when `task log` stores an
observation/snapshot event, keep only the last-N full snapshots and placeholder
older ones (or expose `task log --snapshot` that auto-prunes). Directly keyless.

**GAP-2 — a host-triggerable compaction checkpoint.** `_compact_history` (303-339)
replaces the whole transcript with `[system, summary]` every N steps using a
structured summary prompt (`DEFAULT_SUMMARY_USER_PROMPT`, 16-29) that enumerates
exactly what to preserve (goal, constraints, file paths, satisfied vs open CPs,
working selectors, pitfalls, latest run state, next action). Silver is keyless so
it can't make the call — but it can **scaffold** it: a `task compact <id>` verb
that emits the action_log + the summary template for the host to fill, then stores
the returned prose as the resume baseline (replacing tail-of-8). This turns
`task resume` from "last 8 log lines" into "compacted complete summary + remaining
plan," which is what actually survives a very long task.

**GAP-3 — an enforced, keyless completion gate.** `require_self_reflection_success`
+ `_tool_gate_error` (202-268) BLOCK `done=true` until the latest run folder holds
`self_reflect_result.json` with `predicted_label==1`, reading disk and refusing
otherwise. Silver only *reports* remaining CPs (`task status`); nothing blocks a
host from declaring done with open CPs. **Adopt the STRUCTURAL half keyless:** a
`task verify <id>` that fails unless every plan.md CP is `[x]` AND each checked CP
cites a screenshot/log line that actually exists on disk. That is the keyless
analog of self-reflection — evidence-existence checking, not model judging.

**GAP-4 — explore→author handoff.** `run` seeds a fresh run with
`explore_history` (default.py 350-361): a prior live-exploration transcript
injected as "Previous Explore History… do NOT repeat failed approaches." Silver
*stores* the raw material (`checkpoint.mistakesAndAvoidance`, `criticalContext`,
store.ts 46-59) but has no verb to seed a NEW run from a prior run's learnings.
**Adopt:** `task start --from-run <n>` copies forward the prior checkpoint's
mistakesAndAvoidance + criticalContext into the new run's plan.md Notes / a
`prior_learnings.md`, so a second authoring pass starts from what the exploration
pass learned.

**GAP-5 — a single replayable script + zombie-release gate (minor).** Webwright
auto-concatenates every step into `script.py` (local_browser.py 426-430) and
gates completion on the browser being released (`.lb_session.json` gone). Silver's
`task exec` already auto-logs; have it also **append the argv to `replay.sh`** in
the run folder so the run is re-runnable as one script, and let `task verify`
optionally require the session be closed.

---

## 4. One-line verdict
Silver's **browser lifecycle** already matches or beats Webwright (better
readiness detection, encrypted sidecars, safe teardown, external-attach) and
Webwright confirms rather than challenges Silver's reconnect-per-command model.
The real, adoptable superiority is in Webwright's **long-task context + gating
engine**: mechanical snapshot pruning (GAP-1), a compaction checkpoint (GAP-2),
an enforced evidence-existence completion gate (GAP-3), and an explore→author
handoff (GAP-4) — all implementable keyless as new `task` subverbs.
