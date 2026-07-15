# Deep Dive — Anthropic's own transcripts (skills, tool-use, context engineering) applied to Silver

Sources read in full: `/Users/seventyleven/Desktop/researchfms/Transcripts/TRANSCRIPTS_CLAUDE_CODE_101.md`
(840 lines, entire file — §1–15) and `/Users/seventyleven/Desktop/researchfms/Transcripts/
TRANSCRIPTS_ANTHROPIC.md` (6,622 lines; §3 "Claude Code Best Practices" L1062–1371, §4 "Building
More Effective AI Agents" L1373–1623, §5 "Building with MCP and the Claude API" L1625–1924, §10
"Tips for Building AI Agents" L3515–3715, §12 "Building the Future of Agents with Claude" L3938–
4157 read in full — these are the sections whose content is skill-authoring, tool-design,
context-management, or multi-agent orchestration wisdom directly applicable to a CLI-as-tool like
Silver; the interpretability/safety/red-team sections §9, §15–18 were scanned by heading and
excluded as out of scope for this brief). Cross-checked against Silver's actual
`/Users/seventyleven/Desktop/Silver/silver/skill-data/core/SKILL.md` (379 lines), the stub
`/Users/seventyleven/Desktop/Silver/silver/SKILL.md` (24 lines), `src/perception/diff.ts` (174
lines), and `src/orchestration/subagent.ts` (top 80 lines) to separate "Silver already does this"
from real, unclosed gaps.

This is not a second BAD_GUIDE pass — `research/topfive/transcripts-badguide.md` already mined
BAD_GUIDE.md plus a lighter read of these same two files. This digest reads the two Anthropic
transcript files as the sole primary source and pushes past that prior pass on four axes the
earlier one under-covered: MCP/tool-design economics (fewer-tools-beats-more, UI-shaped not
API-shaped tools), the context-management primitives Anthropic ships in the Claude Developer
Platform (tombstoning, recency-preserving eviction, agentic memory) mapped onto Silver's own
diff/memory mechanisms, the sub-agent skill-inheritance trap, and the "unhobbling" design
philosophy as it bears on how prescriptive Silver's own command surface should be.

## Part A — What the source says + the mechanism

### A1. Skill matching is semantic-on-description-alone, and the failure mode is silent

Claude Code scans four locations at startup — enterprise, personal (`~/.claude/skills`), project
(`.claude/skills`), and installed plugins — and loads **only `name` + `description`** into context
at boot (CC101 §11, L627–632). The full `SKILL.md` body loads only after Claude "compares [the
request] to the descriptions... and activates the ones that match" (§10 L578) and — critically —
**asks the user to confirm loading the skill** before reading the full file (§11 L637). The
matching is pure semantic overlap between the user's phrasing and the description string; there is
no fallback heuristic. The troubleshooting section is explicit that "the cause is almost always the
description" (§15 L804) when a skill silently fails to trigger, and the fix is empirical: test
real phrasings ("Help me profile this," "Why is this slow?," "Make this faster") against the
description and add whatever keywords fail to match (§15 L806).

**Mechanism**: this is a two-stage retrieval — a cheap always-resident index (name+description)
gates a metadata-window read of the full body — not unlike Silver's own two-tier `SKILL.md` stub +
`silver skill --full`. The difference is Claude Code's index is the description string alone,
so its precision is entirely a copywriting problem, not an engineering one.

### A2. Progressive disclosure has a hard 500-line ceiling and a run-don't-read rule for scripts

CC101 §12 codifies two mechanical rules that read as folklore but are stated as norms: keep
`SKILL.md` under 500 lines (L688), and "tell Claude to RUN the script, not READ it" (L692) — a
script executed from a skill directory costs only its stdout in tokens, never its source, and is
"best for environment validation, data transformations that need to be consistent, and operations
more reliable as tested code than generated code" (L693).

### A3. Sub-agents do NOT inherit skills automatically — and built-ins can't use them at all

This is the single most concrete, actionable, and under-cited finding in either transcript for a
tool like Silver. ANTHROPIC §14 "Sharing Skills" (L768–786) states plainly: "Sub-agents don't
automatically see your skills — when you delegate, the sub-agent starts with a fresh, clean
context" (L769). "Built-in agents (Explorer, Plan, Verify) CAN'T access skills at all" (L770).
"Only custom sub-agents you define can use them — and only when you explicitly list them" via an
`AGENT.md`'s `skills:` field (L771–772), and — the sharpest detail — "these skills are loaded when
the sub-agent starts, NOT on demand like in the main conversation" (L773), so only skills that are
"always relevant to the sub-agent's purpose" belong in that list (L785).

**Mechanism**: skill-loading and sub-agent-context isolation are two independently-designed
systems that don't compose automatically; a developer has to bridge them by hand in the
sub-agent's own definition file.

### A4. Tools/MCP servers should be shaped like your UI, not your API — and fewer beats many

ANTHROPIC §4 "Best practices for building agents" (L1583–1601) states the core anti-pattern
directly: "Tools or MCPs for the model should be one-to-one with your UI, not your API" (L1589).
The worked example: a Slack API with three separate endpoints (load conversation, resolve user ID
→ name, resolve channel ID → name) forces the model into three tool calls just to render what a
human sees rendered in one screen (L1592–1599). The prescription: "design a tool or MCP that
presents everything all at once with as little interaction as possible" (L1600). §5 "MCP
interface design ≠ API design" (L1835–1847) sharpens this into a number: "generally one or two
tools beats 15 or 20 tools" (L1836), because "as you give LLMs more information, it makes it
harder for them to make good decisions" (L1831) — and the effect compounds when *multiple* MCP
servers expose confusingly-similar tools (two task trackers both exposing `get_project_status`,
L1810–1813) with "no implicit information about which one to use in which context" (L1812).

### A5. Tool descriptions ARE prompt engineering — "it's all one context window"

§5's "Tip — MCP servers and tools are prompts" (L1777–1802) makes the point with a concrete
before/after: a bad `generate_image(description)` tool just relays "a cute puppy" verbatim to a
diffusion model; naming the model in the description and specifying prompting style in the
description changes what text Claude *writes into the argument*, producing categorically better
output "just by changing a few words" (L1786–1798). §10's "bare-bones-tools anti-pattern" (Eric,
L3585–3595) generalizes this: people spend effort on beautiful prompts and then hand the model
tools with undocumented, letter-named parameters ("A", "B") — "when people start using tool use /
function calling, they forget they still have to prompt" (L3593). Alex's closing point (L3597–
3601): the tool description is textually concatenated into the same prompt as everything else, so
a bad tool description doesn't just fail silently — it actively degrades unrelated reasoning in
the same turn.

### A6. Empathy-with-the-model is a design ritual, not a platitude

§10's OSWorld story (Barry, L3568–3583) is the strongest illustration: two engineers, stuck on
"counterintuitive" agent trajectories for a week, fixed it by literally closing their eyes for a
minute then blinking at the screen for a second to simulate the model's discrete, sparse
screenshot-based perception — "a lot of context and knowledge the model does not have, and you
have to be empathetic to the model... make that missing context clear in the prompt, in the tool
descriptions, and in the environment" (L3581–3582).

### A7. Context management: recency-preserving eviction + tombstones + agentic memory

ANTHROPIC §12 (L4085–4127) documents three concrete platform features shipped specifically because
agent loops fill up context with stale tool results: (1) **eviction with a recency guard** — the
model can drop older tool-call results, but "we do preserve the most recent set of tools" (L4101)
after an experiment where deleting a just-called tool's result made Sonnet blindly re-issue the
same call rather than recover gracefully (L4098–4100); (2) **tombstoning** — a removed tool result
leaves "a note... 'the tool results for the search call were here... and they've been removed,'"
which measurably outperforms silent deletion because "the model's not completely memory wiped"
(L4104–4108); (3) an **agentic memory tool** — the model writes free-text notes mid-task ("this
website maybe isn't the right one," "I should use this database, not that database") that it
re-reads "when it's stumped," addressing the observed failure that "the model does about the same
every time it runs" a repeated task like deep research or Pokémon, unlike a human who improves
run-over-run (L4110–4122). Anthropic explicitly ships only the *tool interface* and leaves storage
to the developer (L4123–4126) — the same "keyless, bring-your-own-substrate" posture Silver
already takes with its markdown memory store.

### A8. Workflows vs. agents, and "unhobbling" as a design philosophy

§10 (L3532–3540) and §12 (L3983–4016) converge on the same axis from two different talks: a
**workflow** is a fixed A→B→C prompt chain the developer pre-wires; an **agent** lets the model
decide how many steps and which tools, looping until it resolves. The stronger claim in §12 is
that *scaffolding itself* becomes a liability as models improve — customers who thought a new
model "was actually only just a little bit better" turned out to be constraining it in ways that
hid the model's real gains (L3994–3997); Anthropic's own practice was "once we got done removing
things from Claude Code to really unhobble the model, it turns out there was nothing coding left"
— what remained was file system + Linux CLI + code execution, three domain-agnostic primitives
(L4042–4047).

## Part B — Why this beats "generic agent-tooling advice" as a source

These transcripts are Anthropic's own internal design rationale for the exact two systems Silver's
architecture already emulates: Claude Code's skill system (which Silver's `SKILL.md` +
`skill --full` stub deliberately mirrors) and the Claude Developer Platform's context-management
primitives (which bear directly on how a host LLM should treat Silver's snapshot/diff output). This
is Tier-1 primary-source design reasoning from the people who built and tuned both systems — not
secondary "best practices" blog content — so gaps found here are gaps against the *authored intent*
of the very customization system Silver's skill sits inside, not against some other framework's
conventions.

## Part C — Concrete gaps vs Silver + keyless adopt recommendations

**C1. [HIGH] Sub-agent skill-inheritance is invisible in Silver's own docs — Silver's `SKILL.md`
never tells the host how to wire it into a delegated sub-agent.** Silver's `subagent spawn` (src/
orchestration/subagent.ts:24-32) is a keyless CLI-level primitive (own session/tab + status file),
completely independent of whether the *host* LLM's own sub-agent mechanism (Claude Code's
`Task`/custom agents) has silver's skill loaded. Per A3, if a host spawns a Claude Code sub-agent
to drive `silver subagent spawn`'s child scope, that sub-agent gets **zero** silver knowledge
unless its `AGENT.md` explicitly lists a `skills:` entry for silver — and even then it's loaded
once at spawn, not on-demand. Today `skill-data/core/SKILL.md`'s "Subagents" section (lines
222-236) documents silver's *own* subagent primitive but says nothing about this host-side wiring
requirement. **Adopt**: add one paragraph to `SKILL.md` §"Subagents", something like: "If you (the
host) delegate the driving of a spawned child to your own sub-agent mechanism, that sub-agent does
NOT automatically inherit this skill — list `silver` explicitly in its `AGENT.md` `skills:` field,
since sub-agent skills load once at spawn, not on-demand." Zero code change, pure documentation;
this is the single highest-leverage fix in this digest because it's an actual silent failure mode
today (a spawned sub-agent trying to drive silver with no knowledge of `--enable-actions`, ref
semantics, or the untrusted-content fence). Priority: HIGH, effort: trivial (one skill-doc edit).

**C2. [MEDIUM] Silver's own tool surface partially violates the "UI not API" / "fewer tools" rule
via verb-count, and should say so explicitly rather than leave it implicit.** Silver's command
table (skill-data/core/SKILL.md §2) is intentionally verb-per-primitive (`click`, `fill`, `type`,
`press`, `check`, `select`, `drag`, `mouse …`, `keyboard …`, `keydown`, `keyup` — 11+ distinct
interaction verbs) rather than Anthropic's "1-2 tools that take a natural-language description and
figure it out" MCP-server ideal (A4). This is a **legitimate design divergence, not a bug** — a
CLI's verbs are read by the *host model itself*, not proxied through an MCP tool-call schema, so
the per-command token cost is amortized differently (only the verbs actually invoked show up in
transcript, unlike an MCP server's full tool-schema being resident in context for the entire
session). But the gap is real at the discovery layer: nothing in `SKILL.md` tells the host *when*
to reach for the low-level `mouse`/`keyboard` primitives vs. the semantic `click`/`fill`/`find`,
so a host unfamiliar with the surface may over-index on raw coordinates. **Adopt**: add one line to
§2's Interaction table header along A4's spirit — "prefer ref-based verbs (`click`, `fill`, `find`)
over raw `mouse`/`keyboard` input; the latter exist only for canvas/WebGL/custom-widget escape
hatches where no accessible ref exists." Priority: MEDIUM, effort: trivial.

**C3. [MEDIUM] `extract`'s prompt/schema bundle should get an A5-style tool-description pass —
today the schema-transform doc explains WHAT it does, not HOW to phrase the `--instruction`.**
Silver's `extract` (skill-data/core/SKILL.md lines 141-154) is the one command where the host's own
generated text (the `--instruction`) feeds a downstream inference pass the host itself will later
run over the returned bundle — structurally identical to A5's diffusion-prompt example (the
quality of what the host writes into the instruction field directly gates output quality, exactly
like the `generate_image` `description` parameter). Nothing in the doc coaches the host on
instruction quality (specificity, one schema-shape-worth of ask, avoiding compound asks). **Adopt**:
add 2-3 lines under the extract table: "`--instruction` is itself a prompt you write for yourself
to follow later — be as specific as the field you're filling (e.g. `'the shipped price INCLUDING
tax, not the list price'` beats `'the price'`); vague instructions here degrade YOUR OWN downstream
extraction the same way a vague tool-call argument degrades a diffusion model's output." Priority:
MEDIUM (extraction quality is a stated eval-gated concern already), effort: trivial doc addition.

**C4. [LOW-MEDIUM, verify-then-adopt] Silver's diff-when-shorter (perception/diff.ts) already
subsumes tombstoning's *intent* for the single-session case, but has no analog to A7's
recency-preserving-eviction guard for the CROSS-COMMAND, WITHIN-HOST-CONTEXT case.** A7's three
context-management features (eviction, tombstone, memory) all operate on the *host's own* context
window across many tool calls within one agent run — a layer Silver deliberately does not manage
(Silver is stateless per invocation; the host's context is the host's problem, per Silver's own
"host LLM is the brain" design). Silver's `diff.ts` already solves the narrower, adjacent problem
of keeping ONE snapshot's re-observation small (git-style unified diff vs. full tree, whichever is
shorter) — this is arguably a *better* mechanism than Anthropic's tombstone-a-tool-call approach
because it diffs structured tree content rather than marking opaque results as gone. The gap: A7's
finding that *silently* dropping content confuses the model (L4098-4100, Sonnet re-issuing a
deleted tool call) has a direct analog Silver does NOT yet handle — if the HOST itself decides to
compact/drop an old `snapshot` output from ITS OWN context (not something Silver controls), Silver
gives it no help recovering ref validity, because refs are generation-scoped and the host has no
lightweight way to ask "what generation am I on and is this ref still live" without a full
re-snapshot. **Adopt** (keyless, low-risk): add a cheap `silver refs status [--session <n>]` (or
extend `get`) that returns just `{generation, refCount}` — a tombstone-equivalent the host can
call after ITS OWN compaction to cheaply re-orient before deciding whether a full re-snapshot is
needed, without spending the tokens of a full tree. This directly serves A7's lesson (a small
orienting signal beats forcing the model to either guess or pay full cost to recover state).
Priority: MEDIUM if the host-compaction interaction with stale refs is a real observed failure
mode in eval runs; LOW/speculative otherwise — recommend validating against Silver's existing 230
tests / eval suite before building, since this is new surface, not a doc fix.

**C5. [LOW] The "unhobbling" philosophy (A8) argues against ANY move toward more prescriptive
built-in heuristics in Silver's actuation layer — worth stating as an explicit non-goal.**
Nothing in Silver's design docs currently states *why* Silver deliberately keeps actuation
deterministic/heuristic (never a model call) rather than growing toward "smart" built-in retry-
with-vision-fallback logic the way Stagehand/browser-use do. A8's finding — that scaffolding
degrades as models improve and best practice is to strip it back to raw primitives (file system +
CLI + code execution) — is direct supporting evidence FOR Silver's existing "every smart step is a
deterministic heuristic or a bundle handed back to you" design stance (skill-data/core/SKILL.md
line 6). **Adopt**: cite this reasoning explicitly in Silver's own `research/decision/DECISION.md`
or a comment near the actuation entrypoint, framed as "why we resist adding model-shaped
heuristics" — not a functional change, a documentation/rationale strengthening move so future
contributors don't accidentally erode the keyless invariant by adding "just one small LLM call for
disambiguation." Priority: LOW (defensive documentation, not a fix for an observed problem).

## Priority summary

1. **C1 — sub-agent skill-inheritance warning in `SKILL.md`** (HIGH, trivial doc edit, closes a
   real silent-failure gap for any host that delegates driving to its own sub-agent).
2. **C3 — extract `--instruction` prompting guidance** (MEDIUM, trivial doc edit, directly serves
   the eval-gated extraction-quality goal).
3. **C2 — ref-verb-vs-raw-input guidance** (MEDIUM, trivial doc edit).
4. **C4 — cheap generation-status probe as a tombstone-equivalent** (MEDIUM/LOW pending eval
   evidence, small new command, only build if stale-ref-after-host-compaction is observed).
5. **C5 — codify the anti-scaffolding rationale** (LOW, pure rationale documentation).

All five are keyless: none require Silver to call a model, none touch the egress/security
boundary, and C1–C3 + C5 are pure documentation deltas to files Silver already owns
(`SKILL.md` / `skill-data/core/SKILL.md` / a decision doc) with no code risk.
