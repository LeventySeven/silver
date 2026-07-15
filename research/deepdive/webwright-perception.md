# Deep dive: Webwright perception (vision-gating) vs Silver

Lens: how Webwright decides WHEN to pay for a screenshot / vision tokens vs
when to stay text-only, and the corresponding Silver mechanism.

Files read in full: `reference/webwright/src/webwright/utils/serialize.py`,
`reference/webwright/src/webwright/tools/image_qa.py`,
`reference/webwright/src/webwright/tools/self_reflection.py`,
`reference/webwright/src/webwright/environments/local_browser.py`
(`_execute_async`, `_capture_observation`, lines 391-511),
`reference/webwright/src/webwright/agents/default.py` (full agent loop,
pruning, gating), `reference/webwright/src/webwright/models/base.py`
(`format_observation_messages`, `BaseModelConfig`, lines 195-223, 340-399),
`reference/webwright/src/webwright/config/{base,local_browser,persistent_browser,task_showcase}.yaml`
— vs Silver `silver/src/core/handlers.ts` (`handleSnapshot`/`handleScreenshot`,
:742-860), `silver/src/perception/diff.ts`, `silver/src/task/index.ts`
(:129-160, 312-330), `silver/src/task/store.ts`.

## What `serialize.py` actually is

`utils/serialize.py` is a 23-line, generic `recursive_merge(*dictionaries)`
helper (deep-merges dicts, `UNSET` sentinel skips fields) used to layer YAML
config files (base → mode modifier → model modifier). It has **nothing to do
with page/DOM serialization** despite the name — that's a documentation trap
in the original task brief. The actual DOM/page state serializer for the
agent loop is `environments/local_browser.py:_capture_observation`
(463-502).

## Mechanism 1: capture is unconditional, injection is gated (the real trick)

`_capture_observation` (local_browser.py:463-502) runs after **every single
step** unconditionally: `page.url`, `page.title()`,
`page.locator("body").aria_snapshot(timeout=observation_timeout_ms)`
(480-484), and `page.screenshot(path=screenshots_dir/step_NNNN.png,
full_page=False)` (486-489) — each wrapped in its own bare `try/except` so a
failure in one (e.g. screenshot fails on a closing tab) doesn't blank the
others or abort the step. All four fields (url, title, aria_snapshot,
screenshot_path) go into the observation dict returned to the agent loop
regardless of whether anything downstream will use them.

**The gate is one config bool, checked once, at the boundary where an
observation becomes a model message.** `models/base.py:376-399`
(`format_observation_messages`): the text (rendered via
`observation_template`, includes url/title/aria_snapshot/console) is
*always* appended as a `text_part`. The screenshot is only turned into an
`image_part_from_path(...)` — i.e. base64-encoded and injected as vision
tokens — `if self.config.attach_observation_screenshot and screenshot_path`
(393-394). `BaseModelConfig.attach_observation_screenshot` defaults `True`
(base.py:213) but **every shipped mode config flips it to `False`**:
`config/base.yaml:26`, `local_browser.yaml` (documented inline, 22-28),
`persistent_browser.yaml:22`, `task_showcase.yaml:22`. `local_browser.yaml`'s
comment states the rationale explicitly: "The screenshot file is NOT
visually attached to the prompt by default... the agent relies on the ARIA
snapshot + printed text... override... to send the PNG as a real image
input each step (extra image tokens, slower, costlier)."

So the PNG is written to disk on every step (cheap: local file I/O, zero
tokens) purely as an evidence trail, while the live agent loop runs
text-only off the ARIA tree. Vision tokens are spent only when something
*downstream* explicitly asks for them.

## Mechanism 2: two purpose-built, on-demand vision tools

Screenshots earn their keep in exactly two places, both separate CLI/tool
invocations with their own model call — never inline in the main loop:

- **`tools/image_qa.py`** (`run_image_qa`, 71-97): agent-triggered, ad hoc.
  Takes 1+ image paths + a free-text `question`, builds one
  `input_image`/`detail:high` message part per image (`_high_detail_image_part_from_path`,
  23-30), asks for strict JSON (`answer`, `evidence[]`, `unknown`,
  `confidence`) via `_build_prompt` (14-20), and is invoked by the agent as a
  bash/python step only when the ARIA tree is ambiguous (canvas-rendered
  content, CSS `::before` state, color/layout questions the accessibility
  tree can't answer).
- **`tools/self_reflection.py`** (`run_self_reflection_async`, 379-447): a
  mandatory, two-stage, end-of-task judge, not a per-step tool. Stage 1
  scores every `final_runs/run_<id>/screenshots/*.png` independently
  (`_judge_one_image`, 298-348, parallel via `asyncio.gather`) 1-5 with
  `Reasoning`; stage 2 attaches *every* screenshot plus the concatenated
  per-image reasonings plus `final_script_log.txt` and forces a
  `Status: success|failure` verdict (`_parse_final_verdict`, 283-291). This
  is gated behind `AgentConfig.require_self_reflection_success` (default.py:39)
  — when true, `_tool_gate_error` (208-268) blocks `done=true` until
  `self_reflect_result.json` exists on disk with `predicted_label==1`,
  reading the file rather than trusting the model's say-so.

Both tools are entirely separate processes with their own `load_tool_model`
(keyed, OpenAI/Anthropic-backed) — confirmed by the Claude-Code port itself:
`skills/webwright/SKILL.md:17-21` explicitly **removes** `image_qa` and
`self_reflection` and replaces them with "you read PNGs with `Read` and
verify success against `plan.md` yourself," because a keyless host already
has native vision.

## Mechanism 3: mechanical context-growth control (the OTHER half of gating)

Separate from per-step attach: `default.py:_prune_old_observation_aria_snapshots`
(275-301), gated by `AgentConfig.keep_last_n_observations` (default `-1` =
off; `local_browser.yaml` sets `1`), walks `self.messages`, finds every
message with `extra.observation`, and replaces the `aria_snapshot` text
field on all but the last N with the literal string `"(ARIA snapshot
pruned; see most recent observation)"` (285) — a pure string-splice, no
diffing, no model call. This runs on every `add_messages()` call
(270-273), so it's automatic and can't be forgotten. It bounds the *text*
side of context growth the same way `attach_observation_screenshot` bounds
the *vision* side — together they're webwright's whole answer to "keep the
transcript affordable over a 50+ step task."

## Why this beats naive competitors

Compared to any agent that screenshots + vision-calls every step (e.g.
naive browser-use/AgentQL-style loops), webwright's default config removes
~1 vision-model call's worth of image tokens from every single step while
losing nothing recoverable — the PNG still exists on disk if a human or
`image_qa` later needs it. The ARIA tree is the primary signal because it's
already structured, free-form text the text model reads natively; the image
is insurance, not the default channel.

## Concrete gap vs Silver

**Not a gap, already stronger — text-channel token economy.** Silver's
`handleSnapshot` (handlers.ts:742-779) is strictly better than webwright's
raw `aria_snapshot()` call: `observe(prevTree, tree)`
(perception/diff.ts:28-46) picks whichever is *shorter* — a unified diff
(Myers O(ND), 3 lines context) against the previous tree, or the full tree —
and returns `NO_CHANGES` verbatim when nothing changed. Webwright has no
diffing at all: every step re-sends the complete `body.aria_snapshot()`
regardless of how little changed; its only cost control is the blunt
last-N-full/rest-placeholder prune (`keep_last_n_observations`), which is
purely retroactive (applied to old messages) and does nothing for the
*current* step's payload size. Silver's diff-when-shorter is a per-step,
proactive version of the same idea and dominates it.

**Not a gap — vision-channel gating already exists, arguably more
disciplined.** Silver has no automatic per-step observation loop at all
(stateless, per-command CLI — `snapshot` and `screenshot` are two entirely
separate verbs, `handlers.ts:344-349`). `handleSnapshot` never touches
`page.screenshot`; `handleScreenshot` (844-860) is the *only* code path that
calls `page.screenshot()`, and it must be explicitly invoked by the host,
returning either `{saved:true}` (written to a contained path,
`assertContainedPath`, 846-851) or inline `{encoding:'base64', image:
buf.toString('base64')}` (858). Since the host LLM is Silver's brain and
issues one verb per call, the "attach_observation_screenshot=false" default
is structurally guaranteed — there is no code path where a screenshot's
bytes leak into a response the host didn't explicitly request. This is
tighter than webwright's config-flag gate, which is a single boolean a
misconfigured mode file could flip on by accident.

**Real gap — no automatic per-action evidence trail (webwright's "cheap
disk capture" half).** Webwright captures a PNG to disk on literally every
step (486-489) regardless of the vision-injection gate, so a `final_runs/
run_<id>/screenshots/` directory always has a complete, timestamped visual
history for post-hoc debugging or a later `self_reflection`/`image_qa` call
— even if the live loop never looked at the images. Silver's task engine
only writes a screenshot when the host explicitly calls `task checkpoint`
(`task/index.ts:129-160`, `captureScreenshot`, 312-330) or the bare
`screenshot` verb; ordinary mutating actions (`click`, `fill`, `type`, etc.
via `handleAct`) inside a `task exec` run leave **no visual artifact** unless
the host remembers to checkpoint. If a task fails silently on step 40 of 60
and the host never checkpointed, there is nothing to look at afterward —
only the text `action_log.jsonl`.

**Adopt (keyless, cheap):** in `task exec` (`task/index.ts`, the dispatch
path that already logs `command+result` to `action_log.jsonl`), add a
best-effort `page.screenshot({path: screenshots/step_<n>.png, fullPage:
false})` after every mutating action — same fire-and-forget try/catch
webwright uses (486-489, never blocks or fails the step on capture error) —
written to disk only, never inlined into the JSON envelope returned to the
host (preserving Silver's existing vision-token discipline). This costs
disk I/O only, adds zero tokens to the normal path, and closes the "no
evidence trail if the host forgets to checkpoint" hole. Priority: **medium**
— cheap, mechanical, directly improves post-hoc debuggability of failed
`task exec` runs, but not blocking (webwright's actual novelty here is
disk-capture discipline, not something users are currently missing acutely
since `task checkpoint` already exists as a manual escape hatch).

**No action needed — webwright's `image_qa`/`self_reflection` tools
themselves.** Both are keyed (call `load_tool_model`, an OpenAI/Anthropic
client) and thus categorically inapplicable to keyless Silver; webwright's
own Claude-Code port reaches the same conclusion and deletes them in favor
of the host's native vision (`SKILL.md:17-21`). Silver's `screenshot` verb
already hands the host exactly the raw material (`base64` image or a saved
path) those tools would have consumed — the host doing its own vision
reasoning over that payload is the correct keyless analog, and no new verb
is needed to enable it.
