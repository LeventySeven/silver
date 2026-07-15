# ev-longtask — Long-running / resumable browser tasks: evidence digest

Scope: compare Webwright's script-as-artifact model, Vercel agent-browser / Silver's
session-daemon + storage-state restore, and Aside's REPL+memory/subagent patterns, all
grounded in files actually read in this repo. Verdict at the end is separated from facts.

Working "9 criteria" used below (from the dispatch brief's stated requirements a–f, plus
3 project-level add-ons needed to judge a *base+language* choice, not just a feature):
(a) agent-ergonomic CLI + general SKILL.md, (b) fast quick tasks, (c) long-running/resumable
tasks, (d) parallel multi-agent orchestration (own browser or shared), (e) zero-config
install, (f) keyless (never calls a model), (g) single-language consolidation, (h) feature
parity with the existing 60+ verb surface, (i) security (SSRF/DNS guard, sandboxing).

---

## Facts

### Webwright (Python, Microsoft) — script-as-artifact

- Webwright's own binary (`webwright` CLI, `src/webwright/run/cli.py`) is **not keyless**:
  `run_one()` calls `get_model(config.get("model", {}))` and `agent.run(...)`, i.e. it makes
  its own LLM calls (OpenAI/Anthropic/OpenRouter backends under `src/webwright/models/`).
  `DEFAULT_CONFIGS = ["base.yaml", "model_openai.yaml"]` — a model config is mandatory to run
  the standalone tool. (`cli.py:17,86-88`)
- The re-runnable-script model is real and load-bearing: `DefaultAgent.run()`
  (`agents/default.py:280-320`) loops `step() → query() → execute_actions()`, writes a full
  `trajectory.json` after every step via `self.save(self.config.output_path)`
  (`agents/default.py:322,332`), and separately writes per-step debug JSON + a
  human-readable `debug/steps.md` (`_write_debug_step_artifact`, lines 100-165). The task's
  actual deliverable is `final_script.py` inside `final_runs/run_<id>/`, plus
  `final_script_log.txt` and per-CP screenshots (`skills/webwright/reference/workflow.md`
  steps 3-6). This is genuinely resumable in the "re-run the artifact" sense, not the
  "resume a crashed in-flight run" sense — there is no checkpoint/resume of a run in
  progress; a fresh run always starts a new numbered `final_runs/run_<id+1>/`.
- **Context compaction as crash-adjacent resilience**: `_compact_history()`
  (`agents/default.py:265-292`) periodically summarizes the running transcript via an LLM
  call (itself a model call — not keyless) into `[system, summary]`, triggered by
  `summary_every_n_steps`. This bounds context growth on long-horizon runs but requires the
  model backend to still be reachable.
- **Keyless-compatible path exists but is a different product**: `skills/webwright/` is a
  Claude Code / Codex plugin whose `reference/workflow.md` and `reference/cli_tool_mode.md`
  explicitly state *"No `OPENAI_API_KEY` is required"* — because in that mode the **host
  coding agent itself** (already running, already has a brain) plays the role Webwright's
  internal model normally plays: it writes `plan.md` (Critical Points checklist), authors
  `final_script.py` directly via its own Write/Edit tools, executes it, and self-verifies
  by `Read`-ing screenshots — replacing `webwright.tools.image_qa` and
  `webwright.tools.self_reflection` (`cli_tool_mode.md:9-11`, `workflow.md:5-7`). This is
  the load-bearing precedent for Silver: **the artifact-and-checkpoint convention
  (plan.md → numbered run folders → action log → screenshots-per-checkpoint) is
  language-agnostic and keyless-compatible; the agent LOOP that drives it is what must be
  supplied externally (by the host LLM), not reimplemented as an internal model call.**
- Long-lived browser handle: `tools/persistent_local_browser.py` (314 lines) launches a
  detached headless Chromium subprocess (`--remote-debugging-port=0`,
  `--user-data-dir=...`), persists `{id, pid, connectUrl, userDataDir}` to a JSON sidecar
  file, and documents `create` / `info` / `release` subcommands so **any later
  process/step re-attaches via `connect_over_cdp(connectUrl)`** and must call
  `browser.disconnect()` (never `.close()`) to survive across steps
  (`persistent_local_browser.py:1-24`). This is a keyless, plain-JSON-file resumable
  browser handle — architecturally close to what Silver's Rust daemon already does, but
  file-based/no-daemon instead of socket-based.
- Reusability beyond one run: `skills/webwright/reference/cli_tool_mode.md` defines a
  second mode (`/webwright:craft`) that produces a **parameterized CLI tool**
  (`final_script.py` with `argparse`, importable without side effects, an
  "Import-safety smoke test", and mandatory `step 0 params: ...` log line) instead of a
  one-shot script — i.e. long-horizon tasks become reusable, replayable command-line tools,
  not just one-off logs (`cli_tool_mode.md:44-70,109-140`).
- Repeatable-run surfacing: `assets/task_showcase/` is a Flask dashboard that reads
  `task.json` (metadata) + `report.json` (curated structured output) per task id from
  `tasks/<short_id>/`, generated when `-c task_showcase.yaml` is stacked onto a run
  (`README.md:112-133,153-157`) — a lightweight, keyless-compatible history/browsing UI for
  past runs.

### Silver (Rust fork) / agent-browser — session daemon + encrypted storage-state restore

- Silver already runs a **persistent per-session daemon** (`silver/cli/src/native/daemon.rs`,
  `run_daemon(session: &str)`), writing `.sock`/`.pid`/`.version` sidecar files under a
  socket dir (`daemon.rs:22-70`) and a `connection.rs` layer that discovers/cleans up
  sessions (`ActiveSession`, `walk_daemons`, `cleanup_stale_files`,
  `connection.rs:156-349`). This gives near-zero-latency **quick tasks** (criterion b) via
  a warm daemon reused across CLI invocations of the same `--session`.
- Storage-state persistence is real, automatic, and keyless: `native/actions.rs` implements
  `auto_save_restore_state()` (line 2645) and `maybe_autosave_restore_state()` (line 2629),
  called from the daemon's background tick every `interval_ms` (call site
  `actions.rs:9830-9848`, e.g. `30_000`ms), gated by a 2s post-command quiet period
  (`AUTOSAVE_QUIET_PERIOD_MS`, `actions.rs:2589`) so a save never stalls an active command
  burst, and gated further by a `restore_save` policy of `auto|always|never`
  (`actions.rs:2649-2669`). `native/state.rs` defines `StorageState { cookies,
  origins: Vec<OriginStorage> }` collected via CDP `Runtime.evaluate` over each frame's
  origin (`state.rs:18-98`), and the state file is AES-256-GCM encrypted (`use
  aes_gcm::{...}`, `state.rs:1`).
- CLI-level flags confirm this is user-facing, not internal-only: `--session`,
  `--restore=<path|session-name>`, `--restore-save`, `--restore-check-url`,
  `--restore-check-text`, `--restore-check-fn`, all with `SILVER_RESTORE*` env-var
  equivalents (`silver/cli/src/flags.rs:62-66,245-249,481-493,625-632`).
- **What this restores is browser/session identity (cookies, localStorage, sessionStorage,
  the live daemon+tab), not task progress.** There is no equivalent in the grepped
  `native/*.rs` files to Webwright's `plan.md` / Critical Points / numbered run folders /
  per-step action log — i.e. Silver's daemon answers "how do I keep a login session or an
  open tab alive across CLI calls or a crash" but not "how do I resume a partially-completed
  multi-step task from exactly where it left off with a durable, replayable record of what
  happened." Grounded by `grep -rniE "session|restore|resume|checkpoint|daemon"` across
  `silver/cli/src/native/*.rs` returning session/storage-state hits only, no
  checkpoint/task-log hits.

### Aside (SOTA browser agent, digest-only — model-in-the-loop by design)

- `research/sources/aside-06-memory-subagents.md` documents a **derived-index, source-of-truth-is-
  flat-files** memory design: "All memory lives as plain `.md` files under `memory/`. The
  vector index (`.moss-cache/`) and `memory-index.json` chunk map are 100% derived and are
  rebuilt automatically... Grep over markdown is a hard fallback that always works"
  (lines 34-38, pattern §1, tier CORE). This is directly portable to a keyless CLI: no
  vector DB or embedding call required to survive a crash, since the index is disposable.
- 3-tier memory: episodic (raw, dated) → semantic (durable, typed pages) → L1 (tiny,
  always-loaded briefings), governed by a promotion rule (pattern §7, lines 126-159,
  tier CORE) — a filing convention, not an LLM-loop dependency, so it is keyless-adaptable
  as a directory convention (`memory/episodic/*.md`, `memory/<type>/<slug>.md`).
- Pattern §18 (lines 326-336, tier IMPORTANT, "browser-specific"): the compaction/checkpoint
  template has an explicit **"Mistakes & Alternatives / Avoidance"** section — *"Browsing
  involves mistakes. List down the mistakes will likely happen again... and how to
  effectively do better next time."* This is a concrete, cheap, transferable field to add to
  any Silver task-log/checkpoint format, independent of whether Aside's own compaction
  machinery (which calls a model) is ported.
- Subagent resume is `subagent(action: "resume", prompt, task_id)` (pattern §10, lines
  180-193) — resume is of a **live in-memory child conversation by task_id**, tracked by
  the parent process, not a disk-durable checkpoint that survives the parent process dying.
  Pattern §12 (lines 205-224, tier CORE): subagents never share the parent's live browser
  tabs/page/form-state even in `fork_self` mode — *"Subagents need to open new tabs"* — an
  explicit isolation boundary directly relevant to Silver's criterion (d): parallel agents
  driving one shared browser must get **new tabs/targets**, not shared live page state, to
  avoid races.
- Aside's own loop is model-in-the-loop end to end (every "step" in the digests is an LLM
  tool call) — none of its runtime/compaction/memory machinery runs without a model
  reachable. Its long-horizon design is a *pattern source*, not a directly portable
  keyless subsystem, unlike Webwright's `skills/webwright/` mode which was explicitly
  rebuilt to be keyless.

---

## Pros / Cons by approach

**Webwright script-as-artifact**
- Pros: genuinely resumable-as-replayable (a saved `final_script.py` + log + screenshots is
  a durable, human-auditable, re-runnable record — the strongest "replayable history"
  story of the three); its `skills/webwright/` variant is proven keyless (host LLM plays
  the loop role); the CLI-tool mode turns a one-off long task into a parameterized reusable
  tool, directly matching "task = a re-runnable script" from the brief; the
  `persistent_local_browser.py` JSON-sidecar handle is a simple, dependency-light pattern
  for reattaching to a browser across steps.
- Cons: Webwright's *own* CLI binary is not keyless (needs an API key) — only the
  Claude-Code-skill wrapper is; no mid-run checkpoint/resume (only whole-run replay via a
  new numbered folder); Python, a second language Silver would need to either keep or port
  from — conflicts with criterion (g) single-language consolidation if adopted wholesale.

**Silver/agent-browser session daemon + restore**
- Pros: already implemented, in Rust (criterion g satisfied for free), keyless by
  construction (state.rs/actions.rs have no model dependency), gives fast warm-daemon
  reattach for quick tasks (criterion b), encrypted storage-state (security-conscious,
  criterion i), background autosave means "crash after 30s of idle state changes loses at
  most ~30s," which is real crash resilience for *session identity*.
- Cons: resumes browser/session state only — no durable record of *task* progress
  (no plan/checklist/step-log/screenshots-per-checkpoint equivalent found in the grepped
  `native/*.rs` files), so a crashed multi-step task has its login/cookies intact but no
  record of which steps were already done — the orchestrating agent (outside Silver) would
  have to reconstruct task state itself with no help from the CLI.

**Aside memory/subagent patterns**
- Pros: flat-markdown-as-source-of-truth + disposable derived index is a clean, keyless-
  portable durability model for a task log or memory layer; the "Mistakes & Avoidance"
  checkpoint field is a concrete, cheap addition; the "subagents get fresh tabs, never
  shared live state" rule is directly actionable for criterion (d).
- Cons: the actual runtime loop and resume/compaction machinery all assume a model is
  reachable at every step — none of it is a drop-in keyless subsystem; it's a source of
  *conventions* to re-implement keyless, not code to port.

---

## Relevance to the 9 criteria

- (a) CLI + SKILL.md: Webwright's `skills/webwright/{SKILL.md,commands/,reference/}` is a
  working example of exactly this shape already adapted to a host-LLM-driven, keyless mode.
- (b) fast quick tasks: Silver's warm daemon (`daemon.rs`, socket reattach) already wins
  this; Webwright's fresh-Python-process-per-run model does not compete here.
- (c) long-running/resumable: **gap in all three as directly usable code.** Silver has
  session/state resume but no task-checkpoint log. Webwright has a task-checkpoint/replay
  convention (plan.md + numbered run folders + action log) but it's Python and paired to
  its own (keyed) loop unless run as a Claude-Code skill. Aside has the memory-durability
  and checkpoint-template *ideas* but no keyless implementation. The clean synthesis is:
  port Webwright's plan.md/numbered-run-folder/action-log convention as a Rust (or TS)
  module inside Silver's existing session directory, driven by the host LLM (as
  `skills/webwright` already proves works keyless), and add Aside's "Mistakes &
  Avoidance" field to the checkpoint template.
- (d) parallel multi-agent orchestration: Aside's isolation rule (fresh tabs, no shared
  live state even on fork) is the concrete design constraint Silver's daemon must respect
  if multiple agents share one browser — Silver's CDP layer (`CreateTargetParams` in
  `state.rs` imports) already operates at the target/tab level, which is compatible.
- (e) zero-config install: Silver's daemon auto-writes sidecar files on first use
  (`daemon.rs:24-26`) with no separate service to install — stronger than Webwright, whose
  standalone CLI needs a model API key configured before first run.
- (f) keyless: Silver's daemon/state code is keyless by construction (no model import found
  in `native/state.rs` or `native/daemon.rs`). Webwright's own binary is not keyless;
  only its skill-wrapper mode is. Aside is never keyless internally.
- (g) single-language consolidation: favors extending Silver's existing Rust
  daemon/session layer with a Webwright-style checkpoint convention over pulling in Python.
- (h) feature parity: out of scope for this evidence task; not assessed here.
- (i) security: Silver's storage-state is already AES-256-GCM encrypted at rest
  (`state.rs:1,` `Aes256Gcm` import) — stronger default than anything documented in the
  Webwright or Aside sources read for this task.

---

## Bottom line (opinion, separated from the facts above)

Rust/Silver is the better base for criterion (c) specifically because it already owns the
keyless daemon + encrypted session-restore half of the problem; the missing half — a
durable, replayable task-progress artifact (plan/checklist, numbered run/checkpoint
folders, step-action-log, "mistakes to avoid" field) — is a filesystem convention, not a
language-specific mechanism, and Webwright's `skills/webwright/` mode is the existing proof
that this convention works with zero model calls of its own when a host LLM drives it. The
recommended design: add a `runs/<task_id>/run_<n>/{plan.md, action_log.jsonl,
screenshots/, checkpoint.json}` convention alongside Silver's existing `--session`/
`--restore` machinery, written by Silver's CLI commands as a side effect (keyless, just
file I/O) and consumed/driven by whatever host LLM is orchestrating — mirroring Webwright's
proven keyless pattern, implemented once, in Rust, inside the one product.
