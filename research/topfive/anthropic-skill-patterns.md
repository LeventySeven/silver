# Anthropic Agent Skills — build-ready checklist for Silver's SKILL.md

Sources (fetched directly, not from memory):
- Anthropic Engineering Blog, "Equipping agents for the real world with Agent Skills" (Oct 2025, Barry Zhang / Keith Lazuka / Mahesh Murag) — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude Platform Docs, "Skill authoring best practices" — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Claude Platform Docs, "Agent Skills overview" (linked from best-practices, structure section)
- On-disk: `/Users/seventyleven/Desktop/compound-v/skills/*/SKILL.md` (23 skills, all with YAML frontmatter)
- On-disk: `/Users/seventyleven/Desktop/Silver/silver/skill-data/core/SKILL.md` (378 lines) + `examples.md`
- On-disk: `/Users/seventyleven/Desktop/Silver/silver/src/core/handlers.ts:1503-1546` (how Silver actually serves the skill file)

---

## 1. YAML frontmatter — GAP: Silver has none at all

**Anthropic's hard requirement:** every `SKILL.md` begins with YAML frontmatter with exactly two required fields, loaded into the system prompt at startup as "Level 1" metadata — this is the entire discovery mechanism when 100+ skills are available:

```yaml
---
name: processing-pdfs
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---
```

Validation rules (verbatim from platform.claude.com/docs):
- `name`: max 64 chars, lowercase letters/numbers/hyphens only, no XML tags, cannot contain reserved words "anthropic"/"claude".
- `description`: non-empty, max 1024 chars, no XML tags, **must describe both what the skill does and when to use it**, written in **third person** ("Processes Excel files…", never "I can help you…" or "You can use this to…").
- Naming convention: gerund form preferred (`processing-pdfs`, `analyzing-spreadsheets`) or noun-phrase alternative; avoid vague names (`helper`, `utils`, `tools`).

**Silver already has:** a well-written, information-dense opening two paragraphs that function as a description in prose (`silver is grounded eyes + hands for a live web page…`).

**GAP — confirmed by direct read:**
```
$ sed -n '1,5p' /Users/seventyleven/Desktop/Silver/silver/skill-data/core/SKILL.md
# silver — the keyless browser for AI agents
**silver is grounded eyes + hands for a live web page; YOU are the brain.** ...
```
No `---` block, no `name:`, no `description:`. And `handlers.ts:1503-1546` confirms the harness only does `readFileSync` + a byte-boundary head-truncation for the compact form — it never parses frontmatter, so there is no discovery metadata Silver could inject into a host's system prompt even if the host tried to read it. Every one of the 23 `compound-v/skills/*/SKILL.md` files (e.g. `agent-security`, `brainstorming`) DOES carry this frontmatter — so Silver is inconsistent with the project's own established convention, not just Anthropic's.

**Fix:** prepend
```yaml
---
name: silver
description: Drive a live web page from the CLI — navigate, read the accessibility tree, click/fill/type by stable ref, extract structured data ID-grounded against hallucination, run long-lived tasks and subagents. Use when the user asks to browse, scrape, fill a form, test a web flow, automate a website, or extract data from a live page, and no API key or model call is wanted (fully local Playwright/CDP, keyless).
---
```
Keep `name` gerund-adjacent/noun form (`silver` is a product name — acceptable since it's not vague/generic per the reserved-word rule, but note the rule bans "anthropic"/"claude" specifically, not other proper nouns).

---

## 2. Progressive disclosure — Silver PARTIALLY has this, one gap

Anthropic's model is 3 tiers: (1) name+description pre-loaded, (2) SKILL.md body loaded on trigger, (3) linked reference files loaded on demand, **kept one level deep** from SKILL.md (nested references cause partial-reads via `head -100` and lost information — explicit anti-pattern in the docs).

**Silver already has this well:** `skill-data/core/SKILL.md` (378 lines, under the 500-line ceiling) + a separate `examples.md` for worked transcripts, and `silver skill --full` vs `silver skill` (compact head) mirrors the "load only what's needed" idea at the CLI-verb level. `examples.md` is referenced directly, one level deep — good.

**GAP:** the compact head () in `handlers.ts:1539-1546` truncates by raw **line-boundary of the file**, not by section/heading — it is a blunt token-count function, not domain-aware progressive disclosure. Anthropic's actual guidance is to split into domain-organized files (`reference/finance.md`, `reference/sales.md`, etc.) that Claude *selectively* loads by topic, not a "read the first N lines of one giant file" approach. Silver's compact/full split is a *length* control, not a *relevance* control — a user who needs only the `network route` verb table still can't get "just that" without reading the whole 378-line file or grepping it themselves.

**Fix (optional, matches Pattern 2 "Domain-specific organization" from the docs):** split command tables into `skill-data/core/reference/{perception,interaction,extract,sessions,tasks}.md`, keep SKILL.md as table-of-contents + lean loop + hard rules, link each reference file directly from SKILL.md one level deep. `examples.md` already follows this pattern for worked transcripts — command reference deserves the same treatment once the file nears 500 lines (it's currently at 378, so this is not urgent, but is the correct next move before it grows further).

---

## 3. Conciseness — Silver mostly satisfies this; some risk of growth

Anthropic: "Only add context Claude doesn't already have" — challenge every paragraph with "does this justify its token cost." Concrete example given: a 50-token concise version beats a 150-token verbose one that explains what a PDF is.

**Silver already has this:** the SKILL.md is dense, uses tables (`| Command | What it does |`) rather than prose for the ~60 verbs, and doesn't over-explain concepts a competent agent already knows (accessibility trees, CDP, Playwright). This matches the doc's own "good example" pattern almost exactly — tables over prose is the docs' implicit recommendation via the command-table style used throughout their own PDF/BigQuery examples.

**No major gap here** — Silver's information density is already close to what Anthropic asks for. Watch: as verbs are added, keep enforcing the 500-line ceiling via the reference-file split in §2, not by inflating the compact-head truncation logic.

---

## 4. Trigger-phrasing / "when to use" — GAP: doesn't exist because there's no description field

Anthropic's effective examples all pair *what* + *when*:
```yaml
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```
Vague descriptions are explicitly called out as bad: "Helps with documents", "Processes data", "Does stuff with files."

**Silver's current opening prose does describe *what*** (three-way synthesis of Vercel agent-browser + Webwright + Aside) but never states explicit "Use when…" triggers a host LLM's selection logic could match against — because, again, there is no `description:` field for a host to mechanically read. If Silver is ever loaded as one of several skills/tools available to a host agent (not just invoked as `silver skill`), the host has nothing short of reading the entire 378-line file to decide "should I reach for this."

**Fix:** the `description:` proposed in §1 already closes this — include explicit trigger nouns ("browse", "scrape", "fill a form", "test a web flow", "extract data from a live page") mirroring the docs' "include key terms" guidance.

---

## 5. Concrete examples — Silver already excels here

Anthropic's "Examples pattern": input/output pairs are more effective than descriptions alone. Their own guidance: "provide input/output pairs just like in regular prompting."

**Silver already has this, arguably better than the Anthropic reference PDF skill:** `skill-data/core/examples.md` is explicitly "copied **verbatim** from real `silver` output" against a live local demo app — full request/response JSON envelopes, not abstracted pseudocode. This is stronger than Anthropic's own PDF-skill example (which shows only a code snippet, no I/O transcript). No gap.

---

## 6. Tool/command tables — Silver already excels here

Not explicitly named as a "pattern" in Anthropic's doc but implied throughout their own skill examples (script tables like `analyze_form.py` / `validate_boxes.py` / `fill_form.py` with one-line descriptions each). Silver's `## 2. Command tables` section (lines 70-260) is exactly this, done more exhaustively (Perception / Query / Interaction / Extract / Network & page / Sessions & parallelism / Long-running tasks / Subagents / Memory / Auth & meta). No gap — if anything Silver's table discipline is a pattern Anthropic's own docs would hold up as a good example.

---

## 7. The "clear contract" principle — Silver already excels here, arguably the standout

Anthropic's docs don't use this exact phrase, but the closest analogue is "Set appropriate degrees of freedom" (high/medium/low freedom, matched to task fragility) and "Solve, don't punt" (handle errors explicitly rather than punting to Claude).

**Silver already has this, and goes further:** `## 3. Hard Rules (the security contract)` (line 262) is a named, explicit contract section — untrusted page content fenced in `⟦page-content untrusted⟧…⟦/page-content⟧`, refs that "fail LOUD… and never misclick," `not_permitted` being "permanent for the call — add the flag or stop; don't retry." This is Anthropic's "low freedom / narrow bridge" pattern (exact instructions, no ambiguity) applied to the security-critical surface, which the Anthropic docs only gesture at generically ("Database migration: Run exactly this script… Do not modify"). Silver's version is more load-bearing (prevents prompt injection via untrusted page content) and is a genuine strength to preserve, not a gap.

---

## 8. Degradation — GAP: not addressed as a named concept

Anthropic doesn't use the word "degradation" either, but the closest related guidance is (a) "Avoid time-sensitive information" (put deprecated/legacy info in a collapsible "old patterns" section rather than deleting it or leaving it live) and (b) validation/feedback-loop patterns ("run validator → fix errors → repeat").

**Silver has partial coverage:** `stale_refs`, `page_changed`, `generation` are exactly a feedback-loop / self-invalidating-state pattern (the doc's "Implement feedback loops" pattern, "Common pattern: Run validator → fix errors → repeat" — Silver's analogue is "act → check `page_changed`/`stale_refs` → re-snapshot before reusing a ref").

**GAP:** Silver's SKILL.md has no "old patterns" / deprecation section, and — more importantly for a fast-moving CLI — no stated policy for what a host LLM should do when a verb *doesn't exist yet* in an older Silver build, or when `silver doctor` reports a broken install. Anthropic's "old patterns" pattern exists specifically to avoid instructions going stale as the underlying tool changes; Silver's CLI surface will grow, and today nothing in SKILL.md tells the host model how to detect "this instruction no longer matches the installed binary" versus assuming its own knowledge is right. Given `silver help`/`silver doctor` already exist as verbs, the fix is cheap: add one line near the top: "If a command in this document errors as `unknown_verb`, run `silver help` for the installed binary's real verb list — SKILL.md may be ahead or behind your binary version."

---

## Summary table

| Anthropic pattern | Silver status |
|---|---|
| YAML frontmatter (`name`/`description`, 3rd person, key terms) | **GAP — completely absent**, not parsed by `handlers.ts`, inconsistent with all 23 `compound-v` skills which do have it |
| Progressive disclosure (3-tier, one-level-deep refs) | **Mostly has it** (SKILL.md + examples.md); compact-head truncation is line-count-based not domain-aware — fine now, will need a reference/ split before 500 lines |
| Conciseness (tables > prose, don't over-explain) | **Has it** — dense command tables throughout |
| Trigger-phrasing ("when to use") | **GAP** — blocked on missing `description:` field; prose intro states *what* but not machine-matchable *when* |
| Concrete input/output examples | **Has it, strong** — `examples.md` is verbatim real transcripts |
| Tool/command tables | **Has it, strong** — 9 categorized tables |
| "Clear contract" (degrees of freedom / explicit rules) | **Has it, strong** — `## 3. Hard Rules` section is more rigorous than Anthropic's own examples |
| Degradation / staleness handling | **Partial** — has runtime feedback loops (`stale_refs`/`generation`); missing a stated policy for SKILL.md-vs-binary version drift |

## Priority for Silver's next pass
1. Add YAML frontmatter (`name: silver`, third-person `description:` with explicit "Use when…" triggers) — zero-risk, closes the single biggest structural gap versus both Anthropic's spec and Silver's own sibling skills in `compound-v`.
2. Add a one-line version-drift/degradation note near the top of SKILL.md pointing to `silver help`.
3. Defer the reference-file split (§2) until SKILL.md approaches ~450-500 lines — not urgent at 378.
