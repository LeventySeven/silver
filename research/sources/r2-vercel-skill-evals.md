# R2 — vercel-labs/agent-browser: SKILL + EVAL + BENCHMARK mining

Repo root: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/agent-browser`
Source: `vercel:skill+evals+bench` (github.com/vercel-labs/agent-browser, confirmed via `benchmarks/bench.ts:53` `REPO_URL = "https://github.com/vercel-labs/agent-browser.git"`)
License: **Apache License 2.0** (verbatim header at `LICENSE:1-3`)

## Killer Insight

agent-browser ships a **two-tier skill system** that solves the "stale docs" problem structurally, not by convention: a tiny, versioned-with-the-repo `skills/agent-browser/SKILL.md` stub (hidden from listings) that tells the agent to shell out to `agent-browser skills get core`, which reads live `skill-data/*/SKILL.md` content bundled in the same npm/binary release the agent already installed (`cli/src/skills.rs:20-30`). This guarantees the instructions the agent reads always match the binary's actual command surface — no separate "docs site drift" failure mode. Their eval harness then explicitly tests for this discipline as a *behavior*, not just a content check: `skill-loading` eval cases fail the agent if it doesn't run `skills get` before touching the browser at all (`evals/cases/skill-loading.ts:11-21`), and a `context-footprint` eval case forces the agent to reason about CLI-skill-load cost vs. paginated MCP `tools/list` cost (`evals/cases/context-footprint.ts:30-53`). The benchmark suite, meanwhile, is **not** a Mind2Web/WebVoyager task-completion benchmark at all — it is a pure infra-latency/memory bench comparing their old Node daemon vs new Rust daemon (`benchmarks/README.md:1-3`, `benchmarks/bench.ts:1-25`). That's a real gap: they prove speed and skill-loading discipline, but never prove browser-task correctness. Our build should copy the two-tier skill architecture and the skill-loading/skill-selection eval categories, but add a genuine task-completion benchmark (Mind2Web-style) that they lack.

## Exact Command Surface / API (verbatim)

Skill CLI surface (`skills.rs` + `skill-data/core/SKILL.md`):
```
agent-browser skills list                 # skills.rs:452 -> run_list()
agent-browser skills get <name>           # skills.rs:453-461 -> run_get()
agent-browser skills get <name> --full    # includes references/*, templates/* content
agent-browser skills get --all            # all non-hidden skills, concatenated with "\n---\n"
agent-browser skills path [name]          # skills.rs:463-465 -> run_path(); no name = list search dirs
agent-browser skills get core             # entry point workflow doc
agent-browser skills get core --full      # + references/commands.md, snapshot-refs.md, authentication.md,
                                           #   trust-boundaries.md, session-management.md, profiling.md,
                                           #   video-recording.md, proxy-support.md, webgpu.md, templates/*
```
JSON output shape for `skills list --json` (`skills.rs:231-244`):
```json
{"success": true, "data": [{"name": "...", "description": "..."}]}
```
JSON shape for `skills get --json` (`skills.rs:315-341`):
```json
{"success": true, "data": [{"name": "...", "content": "<raw SKILL.md text>", "files": [{"path": "references/x.md", "content": "..."}]}]}
```
Error shape (`skills.rs:277-291`, `skills.rs:433-446`): `{"success": false, "error": "Skill not found: <name>"}` / `"Skills directory not found. Set AGENT_BROWSER_SKILLS_DIR or reinstall via npm."`, exit code 1.

Skill directory resolution order (`skills.rs:33-64`, `find_package_root`):
1. `AGENT_BROWSER_SKILLS_DIR` env var — single dir override (`skills.rs:69-74`)
2. `../` relative to the running executable (npm install layout: binary in `bin/`)
3. Walk up parent directories from the executable looking for a `skills/` child (dev builds: `target/debug/` or `target/release/`)

Two skill directories searched, both shipped in the npm package (`skills.rs:30`, `SKILL_DIRS = &["skills", "skill-data"]`):
- `skills/` — discovery stubs, `hidden: true`, exist only to redirect external tools (`npx skills add`) into `skills get core`
- `skill-data/` — actual runtime content: `core`, `electron`, `slack`, `dogfood`, `vercel-sandbox`, `agentcore`

SKILL.md frontmatter fields parsed (`skills.rs:87-125`, `parse_frontmatter`): `name:`, `description:` (supports YAML multi-line continuation via 2-space/tab indent), `hidden: true|yes`.

Core CLI command surface documented for agents (`skill-data/core/SKILL.md`):
```
agent-browser open <url>
agent-browser snapshot [-i] [-u] [-c] [-d N] [-s "<css>"] [--json]
agent-browser click @eN [--new-tab]
agent-browser dblclick|hover|focus @eN
agent-browser fill @eN "text"        # clear then type
agent-browser type @eN "text"        # no clear
agent-browser press Enter|Control+a
agent-browser check|uncheck @eN
agent-browser select @eN "value" ["value2" ...]
agent-browser upload @eN file1.pdf
agent-browser scroll up|down|left|right 500
agent-browser scrollintoview @eN
agent-browser drag @e1 @e2
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click [--exact]
agent-browser find label "Email" fill "..."
agent-browser find placeholder "Search" type "..."
agent-browser find testid "submit-btn" click
agent-browser find first ".card" click
agent-browser find nth 2 ".card" hover
agent-browser wait @eN | wait 2000 | wait --text "..." | wait --url "**/dashboard" | wait --load networkidle|domcontentloaded | wait --fn "js expr"
agent-browser read [url] [--filter text] [--outline] [--llms index|full] [--require-md] [--raw] [--json]
agent-browser get text|html|attr|value|title|url|count @eN [attrName|selector]
agent-browser screenshot [path] [--full] [--annotate]
agent-browser tab [new <url>|<tabId>|close <tabId>]
agent-browser frame @eN | frame main
agent-browser dialog status|accept["text"]|dismiss
agent-browser auth save <name> --url <url> --username <u> --password-stdin
agent-browser auth login <name> [--credential-provider <p> --item <name>]
agent-browser session id --scope worktree --prefix <name>
agent-browser --session <name> --restore [--restore-check-text <t>] open <url>
agent-browser session info --json
agent-browser network route "<glob>" [--body '<json>'|--abort]
agent-browser network requests
agent-browser network har start / har stop <path>
agent-browser record start <file> / record stop
agent-browser eval "<js>" | eval --stdin | eval -b <base64>
agent-browser doctor [--offline --quick] [--fix] [--json]
agent-browser plugin add <name> --name <alias>
agent-browser plugin list
agent-browser plugin run <alias> <capability> --payload '<json>'
agent-browser mcp [--tools all|core,network,react|core|network|state|debug|tabs|react|mobile]
agent-browser react tree|inspect <fiberId>|renders start|renders stop|suspense [--only-dynamic]
agent-browser vitals [url] [--json]
agent-browser pushstate <url>
```
Global flags (`skill-data/core/SKILL.md:413-427`): `--session <name>`, `--json`, `--headed`, `--webgpu`, `--auto-connect`, `--cdp <port>`, `--profile <name|path>`, `--headers <json>`, `--proxy <url>`, `--state <path>`, `--restore [name]`, `--restore-save auto|always|never`, `--namespace <name>`.

MCP server invocation: `agent-browser mcp` — defaults to MCP protocol `2025-11-25`, default tools profile `core`. Env override `AGENT_BROWSER_SESSION`.

Eval CLI (`evals/run.ts`):
```
bun run evals/run.ts [--provider claude|codex] [--model <name>] [--category skill-loading|skill-selection|command-usage|context-footprint] [--judge] [--json] [--timeout <ms>] [--help]
```
Default provider `claude` → `anthropic/claude-sonnet-4.6`; `codex` → `openai/o3` (`evals/run.ts:87-88`). Exit code 1 if any failed/errored (`evals/run.ts:147`).

Benchmark CLI (`benchmarks/bench.ts:70-96`):
```
pnpm bench -- [--iterations N] [--warmup N] [--json] [--branch <name>] [--vcpus N]
```
Defaults: `iterations=10, warmup=1, branch="ctate/native-2", vcpus=8` (`bench.ts:78-82`). `TIMEOUT_MS = 30*60*1000` (`bench.ts:100`). Repo cloned inside the sandbox from `https://github.com/vercel-labs/agent-browser.git` (`bench.ts:101`).

## Patterns

### 1. Two-tier skill packaging (stub → live content)
- **What**: Ship a permanently-stable, tiny stub skill that agent tooling discovers (`skills/agent-browser/SKILL.md`), whose entire job is to redirect to a CLI subcommand (`agent-browser skills get core`) that serves the real, versioned-with-binary instructions.
- **How**: Stub has `hidden: true` frontmatter so `skills list`/`skills get --all` never surface it (`skills.rs:13-17`, `skills.rs:217-218`, `skills.rs:262`); it just contains a short "Start here" section pointing at the CLI (`skills/agent-browser/SKILL.md:14-23`). Real content lives in `skill-data/<name>/SKILL.md` + `references/*.md` + `templates/*`, read fresh off disk relative to the running binary at call time (`skills.rs:180-212`).
- **Evidence**: `skills/agent-browser/SKILL.md:1-23`, `cli/src/skills.rs:9-30`, `cli/src/skills.rs:428-461`.
- **Tier**: core — directly copy this for agent-browser-ultimate: ship a stub `SKILL.md` for marketplace discovery plus a `skills-data/` tree served by our own CLI subcommand, so instructions never drift from the shipped binary.

### 2. Specialized skill routing by domain, not by feature
- **What**: Rather than one giant skill file, agent-browser splits into `core` (generic web), `electron` (desktop apps), `slack`, `dogfood` (QA/exploratory testing), `vercel-sandbox`, `agentcore` (AWS cloud browsers) — each independently loadable.
- **How**: `skill-data/core/SKILL.md:429-435` has an explicit "When to load another skill" section mapping trigger phrases → `agent-browser skills get <name>` command. The `skill-selection` eval category tests exactly this routing decision against 8 cases (Slack, Electron/VSCode, Electron/Discord, dogfood x2, AgentCore, vercel-sandbox, core-fallback) — `evals/cases/skill-selection.ts:11-94`.
- **Evidence**: `skill-data/core/SKILL.md:429-435`, `evals/cases/skill-selection.ts:11-94`.
- **Tier**: important — the trigger-phrase → skill-name eval-test pairing is the right pattern to replicate for our own specialized skills (e.g. auth-vault workflows, CAPTCHA handling, mobile emulation).

### 3. Eval harness: regex-pattern gate + optional LLM judge, no numeric-only scoring
- **What**: Every eval case is graded two ways — hard pass/fail via `expectedPatterns`/`forbiddenPatterns` regex arrays (case-insensitive, dotall: `new RegExp(pattern, "is")`), and optionally a 1-5 LLM judge score against a per-case rubric string. Pattern match is the actual `pass` boolean; judge score is informational only and never flips pass/fail (`evals/lib/judge.ts:90-140`).
- **How**: `testPatterns()` (`judge.ts:11-35`) ANDs all expected patterns and ORs-negates all forbidden patterns. `runLLMJudge()` (`judge.ts:55-88`) always calls Claude (`claudeProvider.callRaw`) regardless of the eval's own provider, model pinned to `anthropic/claude-opus-4.6` (`judge.ts:53`), strips ```json fences before `JSON.parse`, clamps score to `[0,5]`, and on parse failure returns `{score:0, reasoning:"Failed to parse..."}` rather than throwing.
- **Evidence**: `evals/lib/judge.ts:11-35`, `evals/lib/judge.ts:37-88`, `evals/lib/judge.ts:90-140`.
- **Tier**: core — directly reusable grading architecture: deterministic regex gate as ground truth + judge as a secondary quality signal, never trust the judge alone.

### 4. Four eval categories, each with a 5-point behavioral rubric
- **What**: `skill-loading` (does the agent run `skills get` before acting?), `skill-selection` (does it pick the *correct* specialized skill?), `command-usage` (does it follow snapshot→interact→re-snapshot?), `context-footprint` (does it reason correctly about CLI-skill vs MCP-discovery token cost?).
- **How**: Each category file exports a `RUBRIC` string with levels 1-5 describing observable agent behavior (not fuzzy "quality"), e.g. skill-loading rubric: 1="does not mention/load any skill" ... 5="runs skills get first, then follows loaded skill's workflow correctly" (`evals/cases/skill-loading.ts:3-9`). `command-usage` cases inject a synthetic `context` block simulating an already-loaded skill's command list so the eval isolates *workflow ordering* rather than skill-content recall (`evals/cases/command-usage.ts:11-28`).
- **Evidence**: `evals/cases/skill-loading.ts:3-21`, `evals/cases/command-usage.ts:3-28`, `evals/cases/context-footprint.ts:3-53`.
- **Tier**: core — the "inject simulated prior context, then test only the next decision" technique in `command-usage.ts` is a clean way to isolate a single skill in a long agent loop; reuse for our snapshot/ref workflow evals.

### 5. context-footprint eval explicitly tests CLI-skill vs MCP-discovery cost tradeoff
- **What**: A dedicated eval case makes the agent articulate/measure token cost of two discovery paths (CLI `skills get` calls vs MCP `initialize`+paginated `tools/list`) and forbids collapsing MCP down to "one generic argv tool" — testing that the agent understands MCP's typed, paginated tool surface (`nextCursor`) rather than treating it as a single passthrough.
- **How**: Forbidden patterns explicitly ban `agent-browser tools list` (doesn't exist — a hallucination trap) and phrases collapsing MCP into "a single generic argv tool" (`evals/cases/context-footprint.ts:47-50`).
- **Evidence**: `evals/cases/context-footprint.ts:11-53`.
- **Tier**: important — good defensive-eval technique: bake known hallucination traps into `forbiddenPatterns` for commands that don't exist in your CLI.

### 6. Provider abstraction spawns the actual agent CLI, not the raw API
- **What**: Evals don't call the model API directly — they shell out to the real `claude` CLI (`claude -p --output-format text --model <model> <prompt>`) via `Bun.spawn`, routed through Vercel AI Gateway by rewriting `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` env vars (`evals/lib/claude.ts:39-51,53-81`). This tests the actual product surface (CLI + skill file) an end user would drive, not a bare completion.
- **How**: `buildPrompt()` wraps the user task with the *actual* stub `SKILL.md` file content read from disk (`claude.ts:6-7,14-19,21-37`) plus an instruction "Show the exact shell commands you would run. Do not explain, just show the commands." — this constrains judge-ability by forcing command-only output.
- **Evidence**: `evals/lib/claude.ts:1-142` (whole file), `evals/lib/claude.ts:53-81` (`spawnClaude` + timeout race via `Promise.race`).
- **Tier**: important — spawning the real CLI with a hard 60s default timeout (`RunOptions.timeout`, `run.ts:36`) via `Promise.race` against a `setTimeout` that kills the proc is the correct pattern for eval harnesses that must not hang forever.

### 7. Benchmarks measure daemon infra performance, not task success (a real gap)
- **What**: `benchmarks/` is a Node-daemon-vs-Rust-daemon latency/memory comparison inside a Vercel Sandbox, covering 8 scenarios (`navigate`, `snapshot`, `screenshot`, `evaluate`, `click`, `fill`, `agent-loop`, `full-workflow`) — not a WebVoyager/Mind2Web-style task-completion benchmark. There is no accuracy/success-rate metric anywhere in the repo.
- **How**: `computeStats()` computes avg/stddev/min/max/p50 over N timed samples after warmup iterations (`bench.ts:178-190`); results table prints `avgMs +/-stddevMs` for both daemons side by side (`bench.ts:728-729`). Cold start, RSS (daemon vs browser separated), binary/dist size also captured (`benchmarks/README.md:18-24`).
- **Evidence**: `benchmarks/scenarios.ts:41-105`, `benchmarks/bench.ts:169-190`, `benchmarks/README.md:5-24`.
- **Tier**: anti-pattern (gap to fix, not to copy) — our build should add a genuine task-completion benchmark (success-rate over real websites, Mind2Web-style) since Vercel's suite only proves speed, never correctness.

### 8. Skill file size discipline via `--full` opt-in
- **What**: The default `skills get core` response is the compact workflow guide (~470 lines including examples); the exhaustive command reference, snapshot-ref deep dive, auth/session/proxy/webgpu references, and shell-script templates are only pulled in with an explicit `--full` flag.
- **How**: `run_get()` only calls `collect_supplementary_files()` (reads `references/*` and `templates/*` subdirs, sorted by filename) when `full == true` (`skills.rs:258, 326-334, 354-363`). This keeps default context footprint small while making the full reference one flag away.
- **Evidence**: `skills.rs:184-212` (`collect_supplementary_files`), `skills.rs:325-334`.
- **Tier**: core — directly copy this progressive-disclosure pattern (default = compact guide, `--full` = everything) for our own skill packaging.

## Reusable code (fork candidates)

- `cli/src/skills.rs` (whole file, 623 lines incl. tests) — skill discovery/serving engine: frontmatter parser, two-directory search with env override + executable-relative resolution, `list`/`get`/`get --full`/`get --all`/`path` subcommands, JSON and text output modes. Directly forkable for any Rust CLI that wants to ship self-describing, binary-synced skill docs.
- `evals/lib/judge.ts` — regex-gate + LLM-judge evaluator (`testPatterns`, `runLLMJudge`, `evaluate`) — forkable evaluation core for any agent-CLI eval harness.
- `evals/lib/reporter.ts` — terminal + JSON eval reporter with pass/fail/error icons, per-category summary table, byCategory pass-rate aggregation (`computeSummary`, `printSummary`, `printResultsJson`).
- `evals/lib/claude.ts` / `evals/lib/codex.ts` — provider abstraction that spawns the real agent CLI with a skill file injected as context, via AI Gateway env rewriting; template for testing "does the agent actually invoke our tool correctly" rather than bare model output.
- `benchmarks/bench.ts:computeStats()` (`bench.ts:178-190`) — clean, dependency-free avg/stddev/p50/min/max implementation, reusable for our own daemon latency benchmarking.
- `skill-data/core/SKILL.md` and `skill-data/dogfood/SKILL.md` — content/structure templates: "core loop" 4-line quickstart, workflow numbered-table pattern (dogfood's `1. Initialize → 2. Authenticate → 3. Orient → 4. Explore → 5. Document → 6. Wrap up`), and the "Setup" parameter table with defaults (`skill-data/dogfood/SKILL.md:13-23`) — good template for our own skill docs.

## Anti-patterns

- **No task-completion benchmark at all.** `benchmarks/` only measures latency/memory of the daemon, never whether the agent actually accomplishes a browser task (no Mind2Web/WebVoyager-style success-rate suite exists in this repo). Confirmed by reading `benchmarks/README.md` end to end and `benchmarks/scenarios.ts` — all 8 scenarios are raw CLI command timings with a synthetic injected HTML page, not real websites or task graphs.
- **Judge model is hardcoded and always Claude**, even when evaluating a Codex/OpenAI-driven agent (`evals/lib/judge.ts:53,66`: `runLLMJudge` calls `claudeProvider.callRaw` unconditionally) — creates a cross-provider grading asymmetry (Claude is both a subject and the sole judge) that isn't disclosed anywhere in the harness output.
- **Pattern regex matching is coarse** — `testPatterns` uses `is` flags (case-insensitive + dotall) with no negative lookahead protections, so an agent could game `expectedPatterns` by merely mentioning a command in a bash comment or apologetic explanation without actually being correct; there's no execution-based verification (they never actually run agent-browser against a live page during evals — it's all text-output pattern matching against a spawned CLI).
- **Benchmark default branch is hardcoded to a personal dev branch** (`branch = "ctate/native-2"`, `bench.ts:79`) rather than `main` — a reproducibility footgun if that branch is deleted/merged later; anyone forking the benchmark script would silently get a stale or missing branch.

## License

Apache License 2.0, per `LICENSE:1-3` at repo root. Attribution required for any forked/adapted code (retain copyright notice per Apache 2.0 §4).
