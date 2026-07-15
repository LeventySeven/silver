# Webwright — the LONG-TASK engine (lens: longtask)

Scope: how Webwright turns a multi-step web task into a *durable, re-runnable,
self-verifying* unit of work — and exactly which mechanisms Silver's `task/`
should adopt, all keyless (drop every model-calling part). Sources read in full:
`agents/default.py`, `run/cli.py`, `tools/self_reflection.py`, the five skill
files (`SKILL.md`, `commands/{craft,run}.md`, `reference/{workflow,cli_tool_mode}.md`),
and configs `base.yaml` / `local_browser.yaml`. Compared against Silver
`task/index.ts` + `task/store.ts`.

---

## 1. What Webwright does + HOW (the mechanism)

Webwright has TWO long-task shapes that share one contract. The **agentic
loop** (`agents/default.py`, used by `run/cli.py`) and the **skill/craft
discipline** (a Claude-Code adaptation where the host IS the loop). The engine
= five interlocking mechanisms.

**(a) The run folder is the durable artifact, not the transcript.**
Skill contract `SKILL.md:45-69`: every clean execution lives in its own
immutable `final_runs/run_<id>/` (id = max existing + 1) holding
`final_script.py`, `screenshots/final_execution_<step>_<action>.png`, and
`final_script_log.txt` (reset per run; one `step <n> action: …` line per
constraint-relevant interaction; final datum printed at the end). A *failed*
run is never edited in place — you author a NEW `run_<id+1>/` and re-verify
(`workflow.md:85-88`). So the folder is a monotonic ledger of attempts, and the
newest run is the source of truth.

**(b) task = a re-runnable SCRIPT, not a log of a run.** The mandated artifact
is executable: `cd final_runs/run_<id> && python final_script.py`
reproduces the task with **zero LLM in the loop** (`cli_tool_mode.md:133-141`).
CLI-tool mode (`craft`) hardens this into a reusable tool: one function with a
Google-style `Args:` docstring, every task value promoted to an `argparse
--flag` whose *default equals the original value* (`cli_tool_mode.md:56-107`),
a `step 0 params: name=value …` echo line (`:113-121`), and an **import-safety
smoke test** — importing the module must NOT launch a browser
(`:143-153`). This is the load-bearing idea: the deliverable is a parameterized
program a cron job / CI runner / human can re-execute forever, not a chat log.

**(c) plan.md Critical-Points contract + harsh self-verify.** `SKILL.md:71-113`:
parse the task into a numbered checklist where each CP is *independently
verifiable from a screenshot or a log line*; tick `[x]` ONLY with cited
evidence; a harsh verification pass (`workflow.md:69-92`) re-opens every cited
PNG and refuses ambiguous/occluded/broadened states (exact numerics, sort via
the site's real control not result order, reopen closed drawers). Done requires
ALL CPs ticked (`workflow.md:93-106`).

**(d) Automatic context management in the loop** (`agents/default.py`). Two
keyless-adjacent mechanisms bound token growth on long runs:
- `_prune_old_observation_aria_snapshots` (`default.py:275-301`): keeps full
  ARIA only for the last `keep_last_n_observations` observations, string-replaces
  older payloads in-place with `(ARIA snapshot pruned…)`. `local_browser.yaml:85`
  sets N=1. Purely structural — **no model call** (comment `:80-85`: ARIA
  snapshots are ~10-20k chars each and dominate token usage).
- `_compact_history` (`default.py:303-339`): every `summary_every_n_steps`
  (`base.yaml:90` = 20) it replaces the whole transcript with `[system,
  summary]` via one structured summary call (`DEFAULT_SUMMARY_USER_PROMPT`
  `:16-29` enumerates exactly what to preserve: goal, constraints, file paths,
  satisfied vs open CPs, working selectors, pitfalls, latest run state, next
  action). `local_browser.yaml:92` overrides it for live-browser state.

**(e) An enforced completion gate.** `require_self_reflection_success`
(`base.yaml:89` = true) → `_tool_gate_error` (`default.py:208-268`) BLOCKS
`done=true` at the loop level (`execute_actions:400-424` flips `done` back to
false and injects the error) until the latest run folder holds
`self_reflect_result.json` with `predicted_label == 1`. `self_reflection.py` is
the keyed judge: per-screenshot 1-5 score + reasoning, then a final verdict
call over all images plus `final_script_log.txt` (`_load_action_history_log`
:` action_history_log`), parsed to `Status: success|failure`
(`_parse_final_verdict`). The **structural half is keyless**: the gate reads
disk for evidence existence; only the label comes from a model.

Bonus: **explore→author handoff.** `run` seeds a fresh run with
`explore_history` (`default.py:350-361`) — a prior live-exploration transcript
injected as "Previous Explore History… do NOT repeat failed approaches."

---

## 2. Why this beats a naive loop

A naive agent loop = one growing message list, "I think I'm done" as the exit
condition, and nothing on disk but the chat. Webwright beats it on four axes:

- **Crash-survivability & replay.** Because the artifact is a script in an
  immutable numbered folder (a/b), a crashed or context-exhausted agent loses
  nothing — the folder is re-executable standalone and the newest `run_<n>` is
  unambiguously the resume point. A naive loop that dies mid-task loses all
  progress.
- **Bounded cost on long tasks.** Prune (d-i) + compact (d-ii) keep a 100-step
  run (`base.yaml:88`) from linearly blowing up context. ARIA pruning alone is
  the single biggest token lever and costs zero model calls. A naive loop pays
  O(steps²) tokens and eventually falls over.
- **Anti-hallucinated-success.** The completion gate (e) makes "done" a
  disk-verifiable fact (evidence files exist + judge label), not the model's
  self-assessment. The CP checklist (c) forces exact-match evidence per
  constraint. A naive loop routinely declares victory on a broadened filter or
  an implied sort.
- **Reusability compounding.** `craft` mode (b) means the *second* time you need
  a similar task you run a flag, not a fresh agent. Naive loops re-derive from
  scratch every time.

vs the other four sources specifically: browser-use / Stagehand keep the
loop-in-memory model (no re-runnable artifact); Aside contributes the
Mistakes-&-Avoidance checkpoint field but not the executable script; Vercel's
edge is the *engine/connection* layer, orthogonal to this task-durability layer.
Webwright's unique contribution is precisely "the script IS the artifact, and
completion is gated on disk evidence."

---

## 3. Concrete gap vs Silver + keyless adopt plan

Silver already ports the *scaffold* (a) and (c): `store.ts` immutable `run_<n>`
folders (`startRun:145-168`, `latestRun:100-103`), `planTemplate:106-120`
Critical-Points, append-only `action_log.jsonl` (`appendLog:171-175`),
per-checkpoint screenshots under the session lock (`index.ts:317-331`), and
`task exec` re-dispatch (`index.ts:227-269`). Subcommands today:
start/log/checkpoint/status/list/resume/exec (`index.ts:63-81`). What is
missing is the whole *back half* of the engine — the parts that make a LONG run
actually survive and actually finish honestly.

**GAP-1 — no re-runnable script artifact (highest value).** Silver's run folder
is a *record* (`action_log.jsonl` + `checkpoint.json`), not an executable
reproduction — contradicting its own comment (`store.ts:4-6` "the script IS the
artifact; re-running it is the resume"). `task resume` (`index.ts:200-225`)
requires the host to come back and re-issue commands; nothing runs standalone.
**Adopt keyless:** `task compile <id>` reads `action_log.jsonl`'s recorded
`exec` invocations (already logged with `kind:'exec', command:[…]` at
`index.ts:250-255`) and emits `run_<n>/replay.sh` — a shell script of the exact
`silver` argv, constant values optionally promoted to `$1/$2` flags with the
original as default (the keyless analog of `craft`'s argparse defaults). No
model needed; it is a pure transform of the log. **Priority: P0.**

**GAP-2 — action_log grows unbounded; no pruning/compaction.** Silver stores
every snapshot/log event forever; `task resume` returns only `log.slice(-8)`
(`index.ts:210`) — a blunt tail that loses everything before it. **Adopt
keyless:** (i) when `task log` stores a snapshot event, keep full ARIA for only
the last N and placeholder older ones on read (port `_prune_…:275-301` as a
read-time transform); (ii) `task compact <id>` emits the log + the
`DEFAULT_SUMMARY_USER_PROMPT` template (`default.py:16-29`) for the HOST to
fill, then stores the returned prose as the resume baseline — turning `resume`
from "last 8 lines" into "compacted complete summary + remaining plan." Silver
can't make the summary call (keyless), so it scaffolds it. **Priority: P1.**

**GAP-3 — no completion gate; done is unverified.** `task status`
(`index.ts:163-180`) only *reports* remaining CPs; nothing blocks the host from
declaring done with open CPs or missing evidence. **Adopt the STRUCTURAL half of
(e), keyless:** `task verify <id>` fails unless every plan.md CP is `[x]` AND
each checked CP cites a screenshot/log line that actually exists on disk. This
is the keyless analog of self-reflection — *evidence-existence checking, not
model judging* (mechanically what `_tool_gate_error:208-268` does minus the
`predicted_label` read). **Priority: P1.**

**GAP-4 — no explore→author handoff.** Silver stores the raw material
(`checkpoint.mistakesAndAvoidance` + `criticalContext`, `store.ts:54-58`) but
has no verb to seed a NEW run from a prior run's learnings. **Adopt keyless:**
`task start --from-run <n>` copies the prior checkpoint's `mistakesAndAvoidance`
+ `criticalContext` into the new run's plan.md Notes / a `prior_learnings.md`
(port of `explore_history` seeding `default.py:350-361`). **Priority: P2.**

**Verdict:** Silver has Webwright's folder scaffold but not its long-task
*engine*. The four keyless adopts above — a compiled replay script (P0),
prune+compact context management (P1), a disk-evidence completion gate (P1), and
a learnings handoff (P2) — are what convert Silver's `task/` from "a place to
write notes" into Webwright's genuinely crash-survivable, replayable,
honestly-completing long-task unit, with zero model calls added.
