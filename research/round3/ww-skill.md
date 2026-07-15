# Gap-alignment digest: Webwright's `skills/webwright/` packaging vs. moxxie's SKILL.md gap

**Source**: microsoft/webwright, `reference/webwright/skills/webwright/{SKILL.md,commands/*.md,reference/*.md}`
**Lens**: how to write moxxie's missing SKILL.md — what it tells the host agent, the loop, examples, progressive disclosure.
**Moxxie anchors read**: `skill/agent-browser/src/core/handlers.ts` (`handle()` dispatcher L157-228, `handleSkill()` L858-879, verb list, envelope/error shape).

## Headline finding

Moxxie has **no SKILL.md at all**. `handlers.ts:858-879` (`handleSkill`) hardcodes a
short/full-text blurb returned by `moxxie skill [--full]`, with a comment
literally saying `// (Full SKILL.md ships in a later task.)` (L875). Webwright's
entire packaging is a worked example of exactly the file moxxie is missing:
a `SKILL.md` with YAML frontmatter (`name`, `description`, `allowed-tools`),
a short "Modes"/loop section, a "Reference Files" progressive-disclosure
pointer, and `commands/*.md` slash-command wrappers — all designed for the
**same host-driven, keyless** pattern moxxie targets (Webwright's Claude Code
adaptation explicitly strips the original OpenAI-backed `image_qa` /
`self_reflection` tools and replaces them with the host's own `Read`/reasoning,
landing exactly on moxxie's "host is the brain" model).

---

## Findings

### 1. Missing SKILL.md file — adopt the frontmatter + progressive-disclosure shape
- **source_does**: `SKILL.md` (L1-5) uses YAML frontmatter with `name`, a
  *trigger-rich* `description` (states literally when to use the skill: "Use
  when the user asks to automate a web task... and wants reusable scripts
  plus screenshot evidence"), and `allowed-tools`. Body is short (~160 lines)
  and defers detail to `reference/*.md` files loaded on demand ("Reference
  Files" section, L143-151).
- **moxxie_current**: `handleSkill()` in handlers.ts returns a hardcoded
  string via `moxxie skill`/`moxxie skill --full` — no on-disk SKILL.md, so
  Claude Code / Codex skill auto-discovery (which scans for `SKILL.md` with
  frontmatter) cannot find moxxie at all.
- **recommendation**: adopt
- **change**: Create `skill/agent-browser/SKILL.md` (or wherever the package
  root is) with frontmatter (`name: moxxie`, a description that states
  trigger phrases like "Use when an agent needs to browse, read, or fill a
  web page"), a short loop section mirroring `handleSkill()`'s short text
  (already good prose — reuse it), and move the longer security-posture
  prose into a `reference/security.md` loaded only when needed. Keep
  `handleSkill()` in sync (or have it read the same on-disk file) so `moxxie
  skill --full` and SKILL.md never drift.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `SKILL.md:1-5,143-151`; moxxie `handlers.ts:858-879`.

### 2. `description` field doubles as trigger/routing text — moxxie's CLI text isn't structured for that
- **source_does**: the frontmatter `description` is written as a trigger
  clause ("Use when the user asks to automate a web task (search, filter,
  form-fill, multi-step flow, data extraction) and wants reusable scripts
  plus screenshot evidence rather than a one-shot answer") — this is what
  the host's skill-router matches against, distinct from the in-body prose.
- **moxxie_current**: `handleSkill()`'s `short` string (L859-866) is written
  as *documentation* ("moxxie — keyless browser automation for AI agents.
  Lean loop: ..."), not as a *trigger* clause. If used verbatim as a SKILL.md
  `description`, a host router has nothing to match "should I invoke this"
  against.
- **recommendation**: align
- **change**: When authoring SKILL.md's frontmatter, write a dedicated
  `description:` distinct from the body — e.g. "Use when an agent needs to
  navigate, read, click, fill, or extract data from a live web page via a
  local headless browser — keyless, no model calls, works standalone or
  chained with other CLIs." Keep `handleSkill()`'s existing short text as
  the *body*, unchanged.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `SKILL.md:3`; moxxie `handlers.ts:859-866`.

### 3. Slash-command wrappers (`commands/run.md`, `commands/craft.md`) — skip, moxxie is a CLI not a mode-selectable agent
- **source_does**: `commands/run.md` and `commands/craft.md` are thin
  Claude Code slash-command templates that just point back at SKILL.md +
  reference files and pass `$ARGUMENTS` through, letting the user pick
  "one-shot" vs. "CLI tool" mode explicitly.
- **moxxie_current**: moxxie is a single CLI binary invoked verb-by-verb
  (`open`, `snapshot`, `click`, ...) directly by the host agent via Bash —
  there is no "mode" concept to select between; the host already drives the
  loop turn-by-turn.
- **recommendation**: skip-cargo-cult
- **change**: none — do not add `/moxxie:run` / `/moxxie:craft` slash
  commands. They'd just wrap `Bash: moxxie ...`, adding indirection without
  new capability. (If a genuine two-mode split emerges later — e.g.
  "one-shot task" vs. "author a reusable script that re-runs moxxie
  invocations" — revisit, but nothing in the current handlers.ts surface
  needs it.)
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `commands/run.md:1-34`, `commands/craft.md`; moxxie
  `handlers.ts` verb dispatch L157-228 (already a flat command surface).

### 4. Reusable/parameterized artifact contract (CLI Tool Mode) — worth stealing the *idea*, not the Python shape
- **source_does**: `reference/cli_tool_mode.md` defines a strict contract
  for turning a one-shot script into a reusable tool: a `# Parameters` table
  in plan.md, one function with a Google-style docstring, an `argparse`
  wrapper whose defaults reproduce the original task, import-safety (no
  side effects at module load), and a `step 0 params: ...` log line so
  resolved arguments are auditable.
- **moxxie_current**: moxxie has no concept of "author a reusable script
  that wraps this session's actions" — every `moxxie` invocation is already
  atomic/composable at the shell level (`moxxie open`, `moxxie click @e3`,
  ...), so the host itself is the "reusable script" layer (e.g. a bash
  script chaining moxxie calls with named args). There's no code-gen step in
  moxxie to parameterize.
- **recommendation**: align (as documentation guidance, not new code)
- **change**: In moxxie's SKILL.md, add a short "composing a reusable
  script" section recommending the host write a small bash script of
  chained `moxxie` verb calls with named shell variables/flags at the top
  (mirroring the `# Parameters` table idea) when a task is likely to be
  re-run with different inputs — pure documentation guidance for the host,
  no moxxie code changes needed.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `reference/cli_tool_mode.md:24-127`; moxxie has no
  equivalent surface (verified by grep — no "argparse"/reusable-script
  concept anywhere in `handlers.ts`).

### 5. Self-verification loop replacing the OpenAI `image_qa`/`self_reflection` tools — directly validates moxxie's screenshot handler design
- **source_does**: `reference/workflow.md` Step 5 explicitly documents that
  the *host's own* `Read` tool on saved PNGs + reasoning against `plan.md`
  **replaces** the original model-backed `image_qa`/`self_reflection` tools
  ("No `OPENAI_API_KEY` is required" — SKILL.md L17-21, workflow.md L4-7).
  This is the same keyless-substitution pattern moxxie already uses
  (host is the brain).
- **moxxie_current**: `handleScreenshot()` (handlers.ts L372-381) already
  returns either `{saved:true}` (file path given) or base64 image data for
  the host to `Read` and reason over — architecturally identical to
  Webwright's replacement pattern. No moxxie change needed here; this is a
  confirming precedent, not a gap.
- **recommendation**: skip-cargo-cult (already aligned — no action)
- **change**: none. Optionally cite this precedent in SKILL.md prose ("host
  reads screenshots itself, no vision model call") to reassure operators
  that keylessness extends to visual verification too.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `SKILL.md:17-21`, `workflow.md:4-7`; moxxie
  `handlers.ts:372-381`.

### 6. Numbered "Hard Rules" checklist embedded directly in SKILL.md body
- **source_does**: SKILL.md's "Hard Rules" section (L114-141) is a flat,
  scannable bullet list of behavioral constraints stated as imperatives
  ("One bash command per step...", "Numeric... constraints are exact...",
  "Do not install extra packages...") placed directly in the top-level file,
  not buried in a reference doc — these are the rules a host is most likely
  to violate under time pressure.
- **moxxie_current**: `handleSkill()`'s `--full` text (L867-876) does
  contain real hard-rule content (file:/data:/blob: denial, egress
  denylist, redaction, no-model-call) but as one dense paragraph, not a
  scannable list, and it's the *only* place any of this is documented since
  there's no SKILL.md.
- **recommendation**: adopt
- **change**: When writing SKILL.md, reformat the `--full` security prose
  (handlers.ts L870-876) into a bulleted "Hard Rules" section: (1) read-only
  by default — actor verbs need `--enable-actions`; (2) a stale ref fails
  loudly, never guess — re-`snapshot`; (3) file:/data:/blob: navigation
  denied by default; (4) egress is a host denylist, `--allowed-domains`
  hardens further; (5) output is neutralized + boundary-fenced unless
  `--no-content-boundaries`; (6) extract never shows the host a real URL,
  only IDs — `extract resolve` maps back. One bullet per rule, matching
  Webwright's scannability.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `SKILL.md:114-141`; moxxie `handlers.ts:867-879`.

### 7. Explicit "what mode am I in / what to do first" instruction pointing back at SKILL.md from any entry point
- **source_does**: `commands/run.md` (L15-17) explicitly tells the agent:
  "For the full operating contract, first read the `SKILL.md` of the
  `webwright` skill... Then follow the standard workflow" — every entry
  point re-anchors to the single source of truth rather than duplicating
  the loop.
- **moxxie_current**: there is no SKILL.md to anchor to; `moxxie skill` is
  the only self-describing entry point and it's *inside* the CLI (a host
  has to already know to run `moxxie skill` before it knows moxxie exists).
  This is circular for a host that hasn't yet decided to try moxxie.
- **recommendation**: adopt
- **change**: SKILL.md is what a host's skill-discovery mechanism finds
  *before* ever invoking the CLI — it's the missing bootstrap. Once
  SKILL.md exists, keep `moxxie skill`/`moxxie skill --full` as the
  in-session refresher (already correct design per handlers.ts), and have
  SKILL.md's body literally say "run `moxxie skill --full` any time for the
  current security posture" so the two stay cross-referenced rather than
  duplicated.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `commands/run.md:15-17`; moxxie `handlers.ts:858-879`
  (`moxxie skill` verb already exists, just has no on-disk counterpart).

### 8. Concrete worked-example loop with real verbs, not abstract description
- **source_does**: SKILL.md's "Modes" + reference/workflow.md give a
  concrete numbered loop (Plan → Explore → Author → Execute → Self-verify →
  Done) with literal code snippets a host can copy (heredoc Python, log line
  formats, screenshot naming conventions) — the host never has to infer the
  interaction shape.
- **moxxie_current**: `handleSkill()`'s short text (L859-866) already gives
  a concrete example loop (`open <url> -> snapshot -i -> click/fill ->
  snapshot`) — this is the right density for a *short* description, but it's
  the only example that exists anywhere; there's no equivalent of
  Webwright's `reference/playwright_patterns.md` with copy-pasteable
  multi-step examples (e.g. a full extract→resolve cycle, a confirm-gated
  mutating action, a wait-for-navigation pattern).
- **recommendation**: adopt
- **change**: Add a `reference/examples.md` (or a "Worked Examples" section
  in SKILL.md) with 3-4 literal, copy-pasteable moxxie command sequences
  covering: (a) the full extract → host-infers → `extract resolve --ids`
  round trip (handlers.ts L605-680), (b) a confirm-gated mutating action
  with `--enable-actions --confirm-actions` (L387-403), (c) a `wait --text`
  /`wait @eN` pattern (L556-599), (d) session lifecycle (`session id`,
  `close --all`). This is the single highest-value addition since it turns
  the terse CLI reference into runnable recipes.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `reference/playwright_patterns.md` (whole file, esp.
  L15-47, L121-166); moxxie `handlers.ts:387-456,605-680` (act/find/extract
  handlers with no example doc anywhere).

---

## Top recommendation

Write `skill/agent-browser/SKILL.md` now (P0, finding #1/#2/#7 combined):
YAML frontmatter with a trigger-phrased `description`, body = the existing
`handleSkill()` short text verbatim, a "Hard Rules" bulleted section
reformatted from the `--full` prose (#6), and a pointer to a new
`reference/examples.md` with 3-4 worked moxxie command sequences (#8). This
is the single change that makes moxxie discoverable by Claude
Code/Codex/OpenClaw skill routers at all — currently `handleSkill()`'s
comment (`// Full SKILL.md ships in a later task`) confirms this was always
planned but never done.
