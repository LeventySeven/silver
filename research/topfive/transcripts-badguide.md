# Transcripts + BAD_GUIDE mining — skill-authoring wisdom & browser-agent use-case taxonomy

Sources read: `/Users/seventyleven/Desktop/BAD_GUIDE.md` (1,679 lines, grepped full);
`/Users/seventyleven/Desktop/researchfms/Transcripts/TRANSCRIPTS_CLAUDE_CODE_101.md` (840 lines,
§10–15 read in full, lines 560–819); `/Users/seventyleven/Desktop/researchfms/Transcripts/TRANSCRIPTS_ANTHROPIC.md`
(6,622 lines, grepped for skill/browser/computer-use/agent-future sections, lines 992–1005,
1595–1621, 4380–4439 read in full). Cross-checked against Silver's actual
`/Users/seventyleven/Desktop/Silver/silver/SKILL.md` and
`/Users/seventyleven/Desktop/Silver/silver/skill-data/core/SKILL.md` to separate "already has"
from real gaps, plus `reference/webwright/skills/webwright/SKILL.md` and
`reference/browser-use/skills/open-source/SKILL.md` for comparison.

## Part A — Skill-authoring wisdom (from TRANSCRIPTS_CLAUDE_CODE_101.md §10–15)

This is the single densest source on how Claude Code actually selects and loads skills — worth
treating as ground truth for SKILL.md design, not folklore.

1. **Matching is semantic, on `description` alone.** "The description is how Claude decides
   whether to use the skill — it's the matching criteria" (line 576). Only `name`+`description`
   load at startup; the body loads only on match (line 632). **Silver already does this correctly**:
   `silver/SKILL.md`'s frontmatter description is trigger-phrase-dense ("navigate, read, click,
   fill, or extract data... quick tasks, long-running tasks... parallel sessions/tabs, subagents,
   grep-first memory"). GAP: the taxonomy in Part B below (form-filling, monitoring, testing,
   scraping-with-consent, research/gather) isn't reflected as explicit trigger phrases in the
   description — per the guide's own troubleshooting rule ("if a skill isn't triggering, add more
   keywords that match how you phrase requests", line 671), Silver should stress-test its
   description against phrasings like "monitor this page for changes," "fill out this form,"
   "scrape these listings," "test this login flow" and add any that don't semantically overlap.

2. **500-line ceiling + progressive disclosure is a hard authored norm**, not a suggestion:
   "Keep `SKILL.md` under 500 lines. If you exceed that, consider splitting into different
   content" (line 688), with `scripts/`, `references/`, `assets/` as the recommended split (line
   682-685), and the explicit warning against "cramming everything into one 20,000-line text file"
   (line 680). **Silver already does this** — the two-tier design (`silver/SKILL.md` stub at 25
   lines pointing to `silver skill --full`) is exactly the progressive-disclosure pattern the
   transcript describes, arguably a cleaner implementation than a static `references/` split
   because it's CLI-driven and always version-matched to the installed binary.

3. **"Tell Claude to RUN the script, not READ it"** (line 692) — scripts in a skill dir execute
   without loading their source into context; only stdout costs tokens. This is best for
   "environment validation, data transformations that need to be consistent, and operations more
   reliable as tested code than generated code" (line 693). GAP worth flagging: Silver's `silver
   skill --full` is itself effectively "run, don't read the source" already (it's the CLI printing
   curated docs, not raw file content), but nothing in Silver's design doc discusses whether
   Silver's own commands (e.g. `extract`, `resolve --ids`) are framed to the host model as "run
   this, trust the output" vs. "here's a transform you could also hand-roll." Worth an explicit
   line in the full skill: extraction/resolve are deterministic, tested code paths — prefer them
   over ad-hoc DOM parsing by the host model.

4. **`allowed-tools` restricts, absence doesn't restrict** (lines 673-676). Silver's
   `silver/SKILL.md` sets `allowed-tools: Bash(silver:*)` — correctly scoped, matches the pattern.

5. **Sub-agents do NOT inherit skills automatically** — "Built-in agents (Explorer, Plan, Verify)
   CAN'T access skills at all. Only custom sub-agents you define can use them — and only when you
   explicitly list them" via an `AGENT.md` `skills` field, loaded at sub-agent start, not on-demand
   (lines 769-773). **This is a real GAP worth surfacing in Silver's docs**: Silver has native
   `subagent spawn` (confirmed at `skill-data/core/SKILL.md` line 369,
   `silver subagent spawn "scrape page 2 of results" --name p2 --session sub-p2
   --enable-actions`), but nothing in the skill content tells a host agent that if it delegates a
   Silver task to a Claude Code custom sub-agent (not Silver's own `subagent` primitive — the
   Claude Code harness-level one), that sub-agent will NOT automatically have the Silver skill
   loaded unless explicitly listed in its `AGENT.md`. This is a footgun specifically for
   Silver-in-Claude-Code usage that the guide flags but Silver's skill content is silent on.

6. **Description length caps and field limits are load-bearing**: `name` ≤64 chars,
   lowercase+hyphens, should match directory name; `description` ≤1024 chars, "the most important
   field" (lines 662-663). Confirm Silver's frontmatter description stays under 1024 chars — it
   currently reads as ~420 chars, comfortably inside the limit.

7. **Conflict resolution priority**: Enterprise > Personal > Project > Plugin skills, same name
   collides silently unless names are distinctive (lines 641-648). Not directly actionable for
   Silver's own SKILL.md (Silver ships as a project/plugin skill), but worth a naming note: `name:
   silver` is short and generic enough to collide with any other "silver"-named skill a user or
   org might have — the guide's own advice ("use descriptive names... instead of `review` use
   `front-end PR review`") suggests Silver's `name` field could be more specific
   (`silver-browser` or `keyless-browser`) to reduce collision risk, though this is a minor,
   debatable tradeoff against brand simplicity.

## Part B — Generalized browser-agent use-case taxonomy

BAD_GUIDE.md itself contains no browser-specific taxonomy beyond one citation: **"The Bitter
Lesson of Agent Frameworks"** (Gregor Zunic, browser-use, line 579-580) — "start with maximal
capability then restrict, delete the click/type/scroll abstraction, hand the model raw DevTools
Protocol, and accept that ~99% of the value lives in the RL'd model, not your harness. Every
abstraction is a liability." This is a direct design argument against over-abstracting Silver's
verb surface — worth weighing against Silver's own accessibility-tree-snapshot abstraction, though
Silver's counter-argument (token efficiency of a structured snapshot vs. raw screenshots/DOM) is
defensible and not addressed by Zunic's essay, which is about click/type/scroll primitives, not
about snapshot format.

TRANSCRIPTS_ANTHROPIC.md's computer-use sections (lines 1609-1621, 4397-4399) supply two concrete,
generalizable use-case seeds beyond "quick vs. long":
- **Self-verification / closing the QA loop**: "Claude can write a web app. Then it can actually
  open it up and test it. Then it can find its own bug instead of you needing to do that... you do
  not have to be Claude's QA engineer" (lines 1610-1614). This is the **testing** use case —
  Silver's own dev loop (build → open localhost → snapshot → interact → verify) is this pattern,
  but Silver's skill content doesn't name "self-QA of your own just-built UI" as an explicit
  recipe/scenario the way it names QUICK/LONG/PARALLEL.
- **Cross-domain reach via "be there with you"**: "Wherever you are, Claude can be there with you
  if it has computer use" (line 1621) — the generalization is that a browser agent isn't just for
  websites-as-data-sources, it's for **any web-hosted surface a human would otherwise operate
  manually** (a Google Doc, an admin console, a dashboard). This supports broadening Silver's
  framing beyond "extract data from a page" toward "operate any web surface on the user's behalf."

Synthesizing what's directly evidenced across these sources plus Silver's own current recipe set
(`skill-data/core/SKILL.md` §5, QUICK/LONG/PARALLEL only), the broader taxonomy that Silver's
SKILL should adopt, marked already-covered vs. gap:

| Use case | Evidence | Silver status |
|---|---|---|
| Quick single-shot extraction/lookup | Silver Recipe A (`skill-data/core/SKILL.md:330`) | HAS |
| Long-running multi-step task w/ crash recovery | Silver Recipe B, run-folder (`:207`, `:343`) | HAS |
| Parallel/multi-tab gather (own-browser-per-agent, shared-browser tab-per-worker) | Silver Recipe C (`:355-368`) | HAS |
| Subagent-delegated sub-tasks | `subagent spawn` (`:222`, `:369`) | HAS (Silver's own primitive — see Part A #5 for the Claude-Code-level distinction) |
| Grep-first persistent memory across sessions | `skill-data/core/SKILL.md:238` | HAS |
| Auth/session handling (cookies, storage state) | `:250-282` ("Auth & meta") | HAS but not framed as a named "auth flow" recipe (login → session persist → resume) the way QUICK/LONG/PARALLEL are |
| Self-QA / verify-your-own-build loop | TRANSCRIPTS_ANTHROPIC.md:1609-1614 | GAP — real capability exists (open+snapshot+interact), not named as a recipe |
| Form-filling as a distinct pattern (multi-field, validation-aware, error-recovery) | webwright's own description explicitly names "search, filter, form-fill, multi-step flow" (`reference/webwright/skills/webwright/SKILL.md:3`) as a first-class trigger phrase | GAP — Silver's interaction verbs support it mechanically but no named "form-fill" recipe or trigger phrase in its description |
| Monitoring / change-detection over time (poll a page, diff state, alert) | Generalized from computer-use "be there with you" framing + browser-use's own monitoring/observability skill split (`reference/browser-use/skills/open-source/SKILL.md:9,31`) | GAP — no recipe, no mention in Silver's description or recipes |
| Extraction pipelines (batch, schema-driven, ID-grounded) | Silver's `extract`/`resolve --ids` (`:141-152`) | HAS the mechanism; not framed as a repeatable "pipeline" recipe (e.g., loop over N pages → same schema → merge) |
| Scraping-with-consent / robots-aware collection | Not evidenced in any source read (BAD_GUIDE, TRANSCRIPTS_ANTHROPIC, CLAUDE_CODE_101 are silent on robots.txt/ToS-aware scraping) | GAP, but note: no primary source in this sweep actually argues for it — flag as a plausible addition from general web-agent ethics, not something these transcripts substantiate. Don't overclaim sourcing here. |
| Research/gather across many sources (cite-as-you-go, multi-tab reconnaissance) | Generalized from computer-use "domains agents have been locked out of" (line 1615) + Silver's own parallel-tab capability | GAP as a named recipe — mechanically supported by PARALLEL recipe, not framed as "research fan-out" |
| Testing web apps (regression, visual diff, login-flow validation) | webwright description again explicit; TRANSCRIPTS_ANTHROPIC self-verification loop | GAP — no named "testing" recipe distinct from self-QA |

## Bottom line

The two Claude Code Skills videos (§10-15, TRANSCRIPTS_CLAUDE_CODE_101.md lines 560-819) are the
load-bearing source for skill-authoring mechanics and validate Silver's existing architecture
(progressive disclosure via `silver skill --full`, scoped `allowed-tools`, lean description) as
already aligned with Anthropic's own documented best practice — the one concrete miss is the
sub-agent skill-inheritance footgun (Part A #5), which Silver's docs don't currently warn about.
On use cases, BAD_GUIDE and TRANSCRIPTS_ANTHROPIC are thin on browser-specific taxonomy directly
(one essay citation, two computer-use passages) — the taxonomy in Part B is built by generalizing
those seeds against Silver's own already-shipped mechanics and one comparison point (webwright's
description explicitly naming form-fill/multi-step-flow as triggers). The clearest, best-evidenced
gap is that Silver's mechanisms already cover form-filling, monitoring-style polling, testing/self-QA,
and research fan-out, but its SKILL.md's recipe section (§5, QUICK/LONG/PARALLEL) and its
frontmatter description don't name them — so semantic matching (Part A #1) will under-trigger on
exactly those phrasings a host agent is likely to use ("fill out this form," "monitor for
changes," "test the login flow," "research these five vendors").
