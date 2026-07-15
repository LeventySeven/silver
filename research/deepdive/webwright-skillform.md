# Deep dive: webwright's SKILL packaging form vs Silver's

Scope: not the engine (covered in `engine-webwright-deep.md`) or the
capability-by-capability list (`top5-webwright.md`) — this is specifically the
**packaging** of webwright's Claude-Code adaptation: how `SKILL.md` +
`commands/{craft,run}.md` + `reference/{cli_tool_mode,playwright_patterns,
workflow}.md` are structured as a *keyless, host-driven skill form*, and what
of that packaging Silver's own skill files should adopt.

Files read in full:
- `reference/webwright/skills/webwright/SKILL.md` (162 lines)
- `reference/webwright/skills/webwright/commands/craft.md` (63 lines)
- `reference/webwright/skills/webwright/commands/run.md` (35 lines)
- `reference/webwright/skills/webwright/reference/cli_tool_mode.md` (188 lines)
- `reference/webwright/skills/webwright/reference/playwright_patterns.md` (182 lines)
- `reference/webwright/skills/webwright/reference/workflow.md` (108 lines)
- Silver: `silver/SKILL.md` (25 lines, discovery stub), `silver/skill-data/core/SKILL.md`
  (378 lines, full guide), `silver/skill-data/core/examples.md` (458 lines)
- Silver serving code: `silver/src/core/handlers.ts:1503-1546`

---

## 1. What makes webwright's skill packaging genuinely good

**(a) It is a *rewritten* skill, not a repackaged one.** The original
webwright is an LLM-driven loop that parses `{"bash_command": "..."}` JSON off
model output (`src/webwright/run/cli.py`, `agents/default.py`) and burns
tokens on OpenAI-backed `image_qa`/`self_reflection` tool calls
(`tools/image_qa.py`, `tools/self_reflection.py`). The skill authors did not
port that loop — `SKILL.md:9-21` explicitly tells the host: "You do NOT need
to wrap your output in JSON — that constraint only existed because the
original harness parsed model output" and "replaces the OpenAI-backed
`image_qa` and `self_reflection` tools with your own native abilities: you
read PNGs with `Read` and verify success against `plan.md` yourself. No
`OPENAI_API_KEY`... required." This is the single most important design
decision in the whole packaging: it identifies exactly which parts of the
original tool were *keyed* (needed a model call) versus *structural*
(workspace contract, plan.md, run folders) and discards only the keyed parts.
The structural contract survives verbatim; the model-calling scaffolding is
replaced by the host's own tool access (`Read`, `Bash`, `Write`, `Edit`).

**(b) Two-tier packaging: SKILL.md is a table of contents, not the manual.**
`SKILL.md` (162 lines) states the contract's spine — modes, prerequisites,
workspace layout, the six-step workflow as a compressed list, hard rules — and
explicitly hands off depth to three sibling files under `reference/`
(`SKILL.md:143-151`): "`reference/playwright_patterns.md` — browser-launch
heredoc skeleton, `aria_snapshot()` recipes...", "`reference/workflow.md` —
detailed walk-through...", "`reference/cli_tool_mode.md` — contract for CLI
tool mode." Each reference file is topic-scoped and one level deep from
SKILL.md (no nested reference-of-a-reference), matching Anthropic's own
"progressive disclosure" guidance (documented independently in this repo's
`research/topfive/anthropic-skill-patterns.md`). Crucially the reference files
are not generic prose — `playwright_patterns.md` is literally copy-pasteable
heredoc code the host can run unmodified (`cat <<'PY' ... PY`), and
`cli_tool_mode.md` is a *contract with a checklist gate* (§ "Completion gate
(CLI mode)", 7 numbered boolean conditions, lines 167-187) — the reference
file doesn't just describe CLI mode, it defines exactly when the host is
allowed to stop.

**(c) Two frontmatter-bearing entry points that select a *mode*, not just a
task.** `commands/run.md` (default one-shot) and `commands/craft.md`
(parameterized CLI-tool mode) are each valid Claude Code slash commands with
their own frontmatter (`description:`, `argument-hint:`) — a host UI or a
user typing `/webwright:craft <task>` gets mode selection as a first-class,
discoverable action, not a prose instruction buried in SKILL.md ("if the user
says 'make it reusable'..."). `SKILL.md:23-33` documents the trigger phrases
for automatic mode inference too (so the skill still activates correctly on a
plain, non-slash-command prompt), giving webwright **two independent
selection paths** — explicit slash command and inferred intent-match — for
the same fork in behavior. This is a mode dispatcher expressed as *packaging*
(two files under `commands/`) rather than as *runtime logic* (an if/else the
model has to execute correctly from prose).

**(d) The workspace contract is enforced by naming convention + a completion
gate, not by external state.** `final_runs/run_<id>/` (mirrored from the
original `base.yaml` `instance_template`), the required `final_script.py`
path, the `screenshots/final_execution_<step>_<action>.png` naming scheme,
and the `step <n> action: ...` log-line format are all just filesystem
conventions any host with `Bash`/`Write`/`Read` can follow — no runtime, no
database, no daemon. The completion gate (`workflow.md:93-107`, six numbered
conditions, "If any of those is false, do not declare done") is likewise pure
prose-as-contract: it works because it's specific and checkable by the same
host that's executing it (re-open the cited PNG, confirm the filter chip is
visible), not because any code enforces it. This "convention + explicit,
falsifiable stop condition" pattern is what makes it a genuinely *keyless*
skill rather than a thin instruction to "browse carefully."

**(e) It explains its own engine choices with a stated reason, inline.**
Firefox-over-Chromium (`SKILL.md:62-66`, `playwright_patterns.md:9-13`) is not
just declared, it's justified: "some sites fail under Chromium with
`ERR_HTTP2_PROTOCOL_ERROR` due to TLS/H2 fingerprinting." Same for "prefer
interactive form filling over deep-link URLs" (`playwright_patterns.md:74-92`)
— four concrete failure modes are listed (params silently dropped, URL
parsers vary by locale/A-B-bucket/signed-in-state, one working deep link says
nothing about another input set) before the rule is stated. This turns
otherwise-arbitrary-looking constraints into things a host model will actually
respect under pressure, because it understands the failure mode being
avoided rather than just following an instruction.

## 2. Why this beats the competitors (Aside/browser-use/Stagehand/AgentQL) on packaging specifically

None of the other four sources in Silver's synthesis set ship a Claude-Code
**skill-form adaptation** at all — they ship a library/CLI/agent loop that
still assumes an LLM key at runtime; there is no `SKILL.md` + `commands/` +
`reference/` directory anywhere in the other four `reference/*` trees (only
webwright has a `skills/` folder alongside its `src/`). Aside's site-agent
loop and Stagehand's `act`/`extract` primitives are keyed-model callers by
design; porting them to a host-driven skill requires the same "identify what
was keyed vs structural" move webwright's own skill authors already did for
webwright itself. Webwright is therefore not just a source of *capabilities*
to synthesize — it is Silver's only working *precedent* for how to package a
keyless skill file at all, which is exactly why this lens exists.

## 3. Concrete gap vs Silver, file:line grounded

Silver already has the Anthropic-recommended two-tier shape: `silver/SKILL.md`
(25 lines, frontmatter `name: silver` / `description:` with explicit "Use
when..." triggers / `allowed-tools: Bash(silver:*)`, lines 1-5) is a
**discovery stub** that tells the host to run `silver skill --full` for the
real guide, and `silver/skill-data/core/SKILL.md` (378 lines) is that guide,
with `examples.md` (458 lines) as a sibling reference for worked transcripts.
This closes the frontmatter gap flagged in `anthropic-skill-patterns.md` — it
appears to have been fixed since that doc was written (skill-data/core/SKILL.md
mtime is newer than the anthropic-skill-patterns doc's own findings would
predict). That much is not a gap.

**GAP-A — no `commands/` slash-command entry points for Silver's own modes.**
Silver's guide already documents three distinct operating modes as prose
headings: `skill-data/core/SKILL.md:330` "Recipe A — QUICK task", `:343`
"Recipe B — LONG task (start → loop with exec/checkpoint → resume after a
crash)", `:355` "Recipe C — PARALLEL work". These are exactly the kind of
fork webwright expresses as two separate, independently-discoverable files
(`commands/run.md`, `commands/craft.md`) with their own `description:` +
`argument-hint:` frontmatter. Today a host (or a human typing `/`) has no way
to select "give me the long-task recipe" without first loading and reading
the entire 378-line guide top to bottom — there is no `silver:task` or
`silver:parallel` slash command a Claude Code user could invoke directly.
**Adopt:** add `silver/commands/{quick,task,parallel}.md`, each a thin
frontmatter + argument-hint file that (like webwright's) tells the host "read
`skill-data/core/SKILL.md` §Recipe A/B/C, then do X with `$ARGUMENTS`." This
is pure packaging — zero runtime code, zero keys, mirrors webwright's own
`commands/craft.md:6-13` pattern of "read SKILL.md first, then follow these
numbered steps with $ARGUMENTS." **Priority: medium** — cheap, no code
changes, directly closes the one structural difference between the two skill
forms that current Silver docs don't already argue is a net win.

**GAP-B — no domain-split `reference/` directory; single 378-line monolith.**
Webwright splits depth into three topic-scoped files
(`reference/{playwright_patterns,workflow,cli_tool_mode}.md`) that SKILL.md
links one level deep and only the relevant one needs to be loaded for a given
task shape. Silver's `skill-data/core/SKILL.md` is one file covering
perception, query, interaction, extract, network, sessions, tasks, subagents,
memory, auth, hard rules, the escalation ladder, and all three recipes —
already flagged as an approaching-the-500-line-ceiling risk in
`anthropic-skill-patterns.md` §2, but not yet acted on (currently 378 lines,
so not urgent, but this deep-dive independently confirms the same
recommendation from the packaging-precedent side: webwright never lets a
single file exceed ~190 lines, splitting by *mode* (workflow) and *engine
mechanics* (playwright_patterns) rather than by verb category the way Silver's
single file does internally via `###` headers). **Adopt when SKILL.md
approaches ~450 lines:** split into `skill-data/core/reference/{tasks,
subagents-memory,recipes}.md`, keep the command tables (Silver's strongest
section per `anthropic-skill-patterns.md` §6) inline in the main file since
they're dense/tabular and benefit from being visible without a second read.
**Priority: low** — not urgent per current line count, but should be done
proactively at the next growth point rather than reactively.

**GAP-C — no stated "why this engine choice" annotations for Silver's own
load-bearing defaults.** Webwright justifies Firefox-over-Chromium and
interactive-fill-over-deep-link inline with the failure modes each rule
avoids (§1e above). Silver's guide states rules (e.g. "Prefer `fill` over
`type`", `SKILL.md:117`; the perception escalation ladder, `:311`) but mostly
as flat imperatives without the "here is what goes wrong if you don't"
justification webwright pairs with its harder rules. This is a soft
gap — Silver's Hard Rules section (`:262`) is independently praised in
`anthropic-skill-patterns.md` §7 as already exceeding Anthropic's own
examples in rigor, so this is refinement, not a real hole. **Adopt
selectively:** where a rule exists specifically to prevent a failure mode a
host might otherwise "reasonably" violate under task pressure (e.g. why
`fill` reads-back-to-verify instead of trusting `type`), add one clause
naming the failure it prevents, mirroring webwright's justification style.
**Priority: low** — polish, not structural.

---

## Summary

Webwright's skill-form packaging is exemplary for one reason above all
others: it correctly separates what was *keyed* (model-calling QA/reflection
tools) from what was *structural* (workspace contract, run folders,
completion gates) and discards only the former — a discipline Silver's own
"never call a model" design already embodies at the product level but has not
yet fully mirrored at the *skill-packaging* level. The concrete, adoptable,
keyless gaps are (A) missing `commands/` slash-command entry points for
Silver's three existing Recipes — cheap, zero-runtime-risk, **do this next**
— and (B) a domain-split `reference/` directory, which is correctly-deferred
until the guide nears the line-count ceiling. (C) is minor prose polish.
Silver's actual guide content (command tables, hard rules, examples.md) is
already denser and more rigorous than webwright's per file; the gap is purely
in *how many independently-discoverable entry points* the packaging exposes,
not in the quality of what's inside them.
