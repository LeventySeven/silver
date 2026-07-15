# Anthropic's official Agent Skills authoring checklist — and where Silver's skill packaging still falls short

Sources fetched directly (not from training memory), full text read in each case:
- Anthropic Engineering Blog — "Equipping agents for the real world with Agent Skills" (`anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills`)
- Claude Platform Docs — "Agent Skills overview" (`platform.claude.com/docs/en/agents-and-tools/agent-skills/overview`; `docs.claude.com` 302-redirects here)
- Claude Platform Docs — "Skill authoring best practices" (`platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`)
- `github.com/anthropics/skills` README (skill-creator repo, template + spec pointers)
- Claude Code Docs — "Extend Claude with skills" (`code.claude.com/docs/en/skills`) — Claude-Code-specific frontmatter fields beyond the cross-product spec
- On-disk, read in full: `silver/SKILL.md` (24 lines), `silver/skill-data/core/SKILL.md` (378 lines), `silver/skill-data/core/examples.md` (458 lines), `silver/src/core/handlers.ts:1503-1546` (`handleSkill`, `compactHead`)

---

## 1. The mechanism: progressive disclosure is the whole design

Every other rule in the docs is downstream of one architectural fact, stated identically across the blog post and both docs pages: Claude runs in a VM with filesystem access, and a Skill is a **directory on that filesystem**, not a context-window payload. This turns "how much can a skill contain" from a token question into a *file-access* question, and it is why the docs define three strict loading tiers with different costs:

| Level | What | When loaded | Token cost |
|---|---|---|---|
| 1 — Metadata | `name` + `description` from YAML frontmatter | Always, at startup, into the system prompt | ~100 tokens/skill |
| 2 — Instructions | SKILL.md body | Only when Claude decides the skill is relevant, via `bash: cat SKILL.md` | Anthropic's target: under 5k tokens |
| 3+ — Resources/code | Bundled `.md` reference files, scripts, data | Only when SKILL.md (or Claude) explicitly references them | Zero until accessed; scripts contribute only their *output*, never their source |

Mechanistically: Claude never receives skill bodies "pushed" into it. It reads `SKILL.md` with the same Bash tool it uses for any file, and any further file the body links to is a second, separate Bash read. This is why "a skill can bundle comprehensive API docs, large datasets, extensive examples... there's no context penalty for bundled content that isn't used" (overview doc) is a true statement rather than marketing — it's a direct consequence of on-demand filesystem reads, not a token-compression trick. Scripts get an additional exemption: `validate_form.py`'s source is *never* read into context at all if Claude only executes it via Bash; only stdout counts.

**Consequence for authors:** every design decision below (500-line cap, one-level-deep references, TOC-for-long-files) is not stylistic advice — it is calibrated to what a model will and won't do when navigating a filesystem it hasn't fully read. E.g. "avoid deeply nested references" (§3 below) is explicitly grounded in an observed failure mode: "Claude might use commands like `head -100` to preview content rather than reading entire files" when references are more than one hop deep, causing silent truncation.

## 2. YAML frontmatter — the entire discovery contract

Two fields are the cross-product spec (github.com/anthropics/skills, platform docs, overview all agree):

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---
```

**`name`** — max 64 chars; lowercase letters, numbers, hyphens only; no XML tags; cannot contain the reserved words "anthropic" or "claude". Recommended form: **gerund** (`processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`) because it names the *activity*, not the domain — acceptable alternatives are noun phrases (`pdf-processing`) or imperative (`process-pdfs`). Explicitly banned: vague (`helper`, `utils`, `tools`), overly generic (`documents`, `data`), or inconsistent naming across a skill library.

**`description`** — non-empty, max 1024 chars, no XML tags. This is the single highest-leverage field in the whole system: "Each Skill has exactly one description field... Claude uses it to choose the right Skill from potentially 100+ available Skills." Three hard rules, all with good/bad pairs in the docs:
- **Always third person.** "Processes Excel files and generates reports" — never "I can help you..." or "You can use this to...". Rationale given explicitly: the description is injected verbatim into the system prompt, and inconsistent point-of-view causes discovery problems (i.e., a first-person description reads as a stray user/assistant turn rather than a capability listing, confusing the selection heuristic).
- **State both *what* and *when*.** "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs..." — the *when* clause carries the actual trigger phrases a user is likely to type.
- **Be specific, not vague.** Explicit anti-examples: `"Helps with documents"`, `"Processes data"`, `"Does stuff with files"` — all rejected as too generic to disambiguate among competing skills.

**Claude-Code-specific extensions** (not in the cross-product spec; `code.claude.com/docs/en/skills`, table at lines 231-249 of the fetched doc): `when_to_use` (extra trigger text, appended to `description`, shares its 1,536-char cap in the skill *listing*, separate from the 1024-char frontmatter cap on `description` alone), `disable-model-invocation` (user-only, hides description from context entirely — for side-effecting actions like `/deploy`), `user-invocable: false` (Claude-only, hides from the `/` menu — for background knowledge), `allowed-tools` (space/comma/YAML-list of tools pre-approved while the skill is active — **grants, does not restrict**; every other tool stays callable per baseline permissions), `disallowed-tools` (the actual restriction primitive — removes tools from the pool for the skill's duration), `model`/`effort` (per-invocation overrides), `context: fork` + `agent:` (run the skill's body as a subagent prompt in isolation), `paths` (glob-gated auto-activation), `argument-hint`/`arguments` (`$ARGUMENTS`, `$N`, `$name` substitution). The important correction to a common misconception (confirmed independently via a GitHub issue search): **`allowed-tools` is a pre-approval allowlist, not a sandbox** — it does not block tools that aren't listed.

## 3. Progressive disclosure in practice — concrete structural rules

- **Keep SKILL.md body under 500 lines.** Stated identically in both platform docs and Claude Code docs. Split into sibling files once you approach it.
- **Reference files must be exactly one level deep from SKILL.md.** Every reference file links directly *from* SKILL.md; reference files must not link to other reference files. The docs give a concrete bad/good pair: `SKILL.md → advanced.md → details.md` (bad, "Claude might partially read files... resulting in incomplete information") vs `SKILL.md → {advanced.md, reference.md, examples.md}` each linked independently (good).
- **Files over 100 lines need a table of contents** at the top, so a partial/preview read (`head -100`) still surfaces the full scope of what's in the file even if Claude never reads past the ToC.
- **Domain-partition, don't monolith.** For multi-domain skills, split by domain (`reference/finance.md`, `reference/sales.md`) rather than one giant reference — "When a user asks about sales metrics, Claude only needs to read sales-related schemas, not finance or marketing data," which is a token-cost argument, not just organization.
- **Three concrete organization patterns** given verbatim: (1) high-level guide with references (SKILL.md is a table of contents to FORMS.md/REFERENCE.md/EXAMPLES.md); (2) domain-specific organization (per-domain reference files + a grep-first search block in SKILL.md itself, e.g. `grep -i "revenue" reference/finance.md`); (3) conditional details (SKILL.md shows the common path inline, links out only for edge cases like tracked-changes or OOXML internals).

## 4. Degrees of freedom — matching instruction specificity to task fragility

A framework not covered by any competitor's skill docs I've seen: **match specificity to how many ways the task can go wrong.**
- **High freedom** (prose/heuristics) — "code review process," multiple valid approaches, decisions depend on context.
- **Medium freedom** (parameterized pseudocode/scripts) — a preferred pattern exists but some variation is fine.
- **Low freedom** (exact script invocation, explicit "do not modify") — fragile, error-prone, must-follow-exact-sequence operations like DB migrations: `"Run exactly this script: python scripts/migrate.py --verify --backup. Do not modify the command or add additional flags."`

The docs frame this with a robot-on-a-path analogy: narrow bridge with cliffs (low freedom, exact guardrails) vs. open field (high freedom, general direction). This is the closest thing in the corpus to a *contract-tightness dial* — authors are explicitly told to vary it per-section, not pick one register for the whole skill.

## 5. Workflows, feedback loops, and the plan-validate-execute pattern

- **Checklists for complex multi-step tasks** — literally a copy-pasteable markdown checklist Claude checks off as it progresses (`- [ ] Step 1: ...`), for both code and non-code skills. Rationale: "prevent Claude from skipping critical validation."
- **Validator → fix → repeat feedback loops** — "run validator, fix errors, repeat" as an explicit named pattern, with STYLE_GUIDE.md-as-validator (no code) and `python ooxml/scripts/validate.py` (with code) as parallel examples.
- **Plan-validate-execute for batch/destructive operations** — the highest-value pattern for reliability: Claude first emits a structured plan file (e.g. `changes.json`), a script validates the plan *before* anything is applied, only then execution runs, then a final verify step. Explicitly scoped to "batch operations, destructive changes, complex validation rules, high-stakes operations" — and the implementation tip is to make validators verbose ("Field 'signature_date' not found. Available fields: customer_name, order_total, signature_date_signed") so Claude can self-correct without another round-trip to the human.

## 6. Content-quality anti-patterns (all with explicit good/bad pairs in the docs)

- **No time-sensitive info** ("before/after August 2025" style language) — put deprecated behavior in a collapsed `<details>` "old patterns" section instead, so the main content never silently rots.
- **Consistent terminology** — pick one term ("API endpoint", "field", "extract") and never vary it; the docs' claim is explicit: "Consistency helps Claude understand and follow instructions," implying near-synonym drift genuinely costs comprehension, not just style.
- **Concise by default, with an explicit test**: "Does Claude really need this explanation? Can I assume Claude knows this?" — a ~50-token PDF-extraction example is marked *good*, a ~150-token version explaining what a PDF is is marked *bad*, specifically because "Claude is already very smart" is the stated default assumption.
- **Don't offer too many options** — "you can use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or..." is flagged bad; the fix is "provide a default, with an escape hatch" (default library + one explicit fallback condition).
- **No Windows-style paths, ever** — forward slashes even when authoring on Windows, because Unix-style paths work everywhere and backslashes break on Unix runtimes.
- **Scripts must "solve, don't punt."** A script that just does `open(path).read()` and lets exceptions propagate to Claude is explicitly bad; the good version catches `FileNotFoundError`/`PermissionError` and degrades gracefully. Paired with "no voodoo constants" (Ousterhout's law, cited by name) — every magic number needs an inline comment justifying its value, because "if you don't know the right value, how will Claude determine it?"
- **MCP tools need fully-qualified names** (`ServerName:tool_name`, e.g. `BigQuery:bigquery_schema`) — omitting the server prefix causes "tool not found" errors when multiple MCP servers are present.
- **Package/dependency honesty** — never assume a library is pre-installed; state the install command explicitly, and note the platform matters: claude.ai can pull from npm/PyPI/GitHub at runtime, the Claude API has zero network access and zero runtime installs (pre-baked packages only), Claude Code has full network access but should avoid global installs.

## 7. Evaluation-driven development — build the eval before the prose

This is the most load-bearing methodological claim in the whole corpus and the one most teams skip: **"Create evaluations BEFORE writing extensive documentation."** The five-step loop as given:
1. Run Claude on representative tasks *without* the skill, document specific failures.
2. Build ≥3 scenarios that test exactly those gaps (an eval is a JSON object: `skills`, `query`, `files`, `expected_behavior` — a list of concrete pass conditions, not vibes).
3. Establish a no-skill baseline.
4. Write the *minimal* instructions needed to pass the evals — not a comprehensive manual.
5. Iterate against the evals, not against imagined future needs.

The companion "Claude A / Claude B" workflow formalizes this as a role split: Claude A (helps author/refine the skill, sees the user's domain expertise) vs. Claude B (a fresh instance that actually uses the skill on real tasks) — and the checklist explicitly says test across **Haiku (enough guidance?), Sonnet (clear/efficient?), Opus (not over-explained?)** since a skill tuned for one model's implicit competence may under- or over-specify for another. Claude Code's `skill-creator` plugin (`code.claude.com/docs/en/skills`) operationalizes exactly this loop: `evals/evals.json` per skill, isolated per-test-case subagent runs, pass/fail grading with evidence, a with-skill-vs-without-skill benchmark, and blind A/B version comparison before committing an edit — plus automated "should-trigger / should-not-trigger" prompt generation to tune the `description` field's hit rate directly.

## 8. The complete pre-ship checklist (verbatim structure from best-practices doc)

**Core quality:** description is specific + states what/when; SKILL.md body under 500 lines; extra detail lives in separate files; no time-sensitive info (or quarantined in an "old patterns" block); consistent terminology; concrete (not abstract) examples; references exactly one level deep; progressive disclosure used; workflows have clear numbered steps.
**Code and scripts:** scripts solve rather than punt; explicit error handling; no voodoo constants; required packages both listed and verified available; scripts documented; forward-slash paths only; validation/feedback loops on critical operations.
**Testing:** ≥3 evaluations exist; tested on Haiku/Sonnet/Opus; tested on real (not synthetic) usage; team feedback incorporated if shared.

---

## Concrete gap vs Silver's own skill packaging

Silver's top-level `silver/SKILL.md` (24 lines) is the correct pattern per §2/§3: it now carries proper frontmatter —

```yaml
---
name: silver
description: Use when an agent must navigate, read, click, fill, or extract data from a live web page via a local headless browser — keyless (no model calls), standalone or chained with other CLIs. Covers quick tasks, long-running tasks (durable run folders), parallel sessions/tabs, subagents, and grep-first memory. The host is the brain; silver is grounded eyes + hands.
allowed-tools: Bash(silver:*)
---
```

This satisfies the third-person rule, the what+when rule, and stays well under the char caps (description ≈ 480 chars of the 1024 max). Good state, no action needed there.

**Gap A — the "full guide" is CLI-served text, not a linked reference file (§1, §3 mismatch).** Anthropic's model is: SKILL.md links to `FORMS.md`/`REFERENCE.md` by relative path, and Claude reads them with a second Bash call. Silver instead routes the deep content through `silver skill --full`, which `handleSkill()` in `silver/src/core/handlers.ts:1502-1531` resolves by `readFileSync`-ing `skill-data/core/SKILL.md` (378 lines) and returning it whole, or `compactHead()` (a byte-boundary truncation at 1200 chars, `handlers.ts:1533-1541`) for the short form. This works, but it means the "reference file" is invisible to the filesystem-navigation heuristics Anthropic's docs assume (§1: "Claude navigates your skill directory like a filesystem") — Claude cannot `Read skill-data/core/examples.md` directly unless it already knows that path exists; it has to know to invoke a *command* instead of following a markdown link. **Fix:** either (a) have `silver/SKILL.md` link directly to `skill-data/core/SKILL.md` and `examples.md` by relative path so Claude can `Read` them like any other reference file (cheap, no CLI round-trip), keeping `silver skill --full` only as a fallback for hosts without filesystem access to the npm package; or (b) explicitly document the CLI-serving contract in SKILL.md itself ("this skill's reference content is served via `silver skill --full`, not via file links — invoke that command to load Level 2/3 content") so a host doesn't waste a turn trying `head -100` on a path that isn't linked anywhere. **Priority: P1** — this is a discoverability gap, not a correctness bug; docs still get read, just via a less standard path that a host tuned to Anthropic's own filesystem-navigation training might not try first.

**Gap B — no table of contents on the 378-line reference and the 458-line examples file (§3).** Both `skill-data/core/SKILL.md` and `examples.md` exceed the 100-line ToC threshold; neither has one (confirmed by `grep -n "^## Contents"` returning empty on `core/SKILL.md`). Given Anthropic's own stated failure mode — partial reads via `head -100` on long files silently truncating scope — this is the single cheapest fix available: a 10-line "## Contents" block at the top of each file listing its `##` section headers. **Priority: P0** (near-zero cost, directly closes a documented model failure mode).

**Gap C — no eval harness at all (§7).** `find silver -iname "eval*"` returns nothing. There is no `evals/evals.json`, no baseline (with-skill vs without-skill) measurement, and no evidence the skill was tuned against Haiku/Sonnet/Opus separately. Given Silver's own stated design goal is host-model-agnostic ("host LLM is the brain"), this is the most consequential gap: nothing currently verifies the skill's `description` field actually triggers correctly across weaker vs stronger host models, nor that the compact-head truncation (`compactHead`, 1200-char hard cut) doesn't itself decapitate a load-bearing instruction for a Haiku-class host that needs more scaffolding than the compact head provides. **Priority: P0** — directly actionable via `skill-creator` plugin's evals.json format from §7, and it's the only gap here that requires new methodology rather than a file edit.

**Gap D — degrees-of-freedom dial (§4) is not applied consistently.** A skim of `skill-data/core/SKILL.md` shows prose-only guidance throughout (high-freedom register) even in places that read as fragile/exact-sequence operations (e.g. the ref-staleness re-snapshot rule, egress-guard flag combinations) — Anthropic's low-freedom pattern ("Run exactly this... do not modify") is not used anywhere Silver's contract has a single correct sequence. **Priority: P2** — worth a follow-up pass once Gaps A–C are closed, since it's a within-file tightening rather than a structural gap.
