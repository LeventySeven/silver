export const meta = {
  name: 'uab-round1-investigate',
  description: 'Round 1 deep investigation: mine transferable patterns from every browser-agent source, synthesize a pattern corpus, red-team it.',
  phases: [
    { title: 'Mine', detail: 'one grounded agent per source-slice → digest file + structured summary' },
    { title: 'Synthesize', detail: 'Opus reads all digests → unified pattern corpus' },
    { title: 'RedTeam', detail: 'Opus adversary (critical-thinking) → cargo-cult / gaps / overkill' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/ultimate-agent-browser'
const OUT = `${REPO}/research/sources`
const D = '/Users/seventyleven/Desktop/researchfms'
const TD = `${D}/teardowns`
const AP = `${TD}/_aside_parts`

const GOAL = `PROJECT GOAL: We are building the ULTIMATE browser-automation SKILL/CLI for AI agents ("agent-browser") — a tool a sub-agent installs and drives via the shell to perceive and act on live web pages. We are synthesizing the best transferable patterns from many browser-agent systems. Your job is to MINE one source for patterns worth copying, adapting, or deliberately avoiding.`

const TOOLS = `You have FULL tool access (Read, Grep, Glob, Bash, WebFetch). The instructions below restrict OUTPUT (what you return), NOT your inputs — read the actual files thoroughly with your tools; never guess. Every pattern MUST cite a real file:section anchor you actually read. If a listed path is missing, ls/grep the parent directory to find the real files and read those.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source_slug', 'killer_insight', 'patterns', 'command_surface', 'anti_patterns', 'digest_path'],
  properties: {
    source_slug: { type: 'string' },
    killer_insight: { type: 'string', description: 'The single most important transferable takeaway for building the ultimate agent-browser CLI/skill.' },
    patterns: {
      type: 'array',
      description: '8-20 concrete transferable patterns.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'what', 'why', 'how', 'evidence', 'tier'],
        properties: {
          name: { type: 'string' },
          what: { type: 'string', description: 'The pattern in one or two sentences.' },
          why: { type: 'string', description: 'Why it matters for a browser agent (grounded, not vibes).' },
          how: { type: 'string', description: 'Concrete implementation guidance: algorithm, command surface, flags, constants, data shapes. Be specific enough to build from.' },
          evidence: { type: 'string', description: 'file:section/line anchor you actually read.' },
          tier: { type: 'string', enum: ['core', 'important', 'nice', 'anti-pattern'] },
        },
      },
    },
    command_surface: { type: 'array', items: { type: 'string' }, description: 'Concrete CLI commands / flags / API signatures / snapshot formats worth adopting verbatim or near-verbatim.' },
    anti_patterns: { type: 'array', items: { type: 'string' }, description: 'Things NOT to copy — cargo-cult, over-engineering, stage-inappropriate complexity.' },
    digest_path: { type: 'string' },
  },
}

const SOURCES = [
  { slug: 'aside-01-thesis-why-sota', label: 'aside:thesis+why-sota',
    files: `${AP}/10_overview.md ${AP}/95_why_sota.md ${AP}/93_benchmark_analysis.md ${AP}/94_competitor_context.md`,
    focus: `Aside's core thesis ("agent as code-execution over the live web"), WHY it is SOTA (harness > model), the D2Snap downsampled-a11y-tree finding, the 300-trajectory benchmark analysis, the fixed 1440x900 viewport + concurrency claims. Extract what makes the HARNESS win independent of the model.` },
  { slug: 'aside-02-runtime-loop-tools', label: 'aside:runtime+tools',
    files: `${AP}/20_runtime_loop.md ${AP}/96_tool_registry_full.md ${AP}/30_tools.md`,
    focus: `The agent runtime loop, the SINGLE repl tool vs N discrete tools decision, the full 18-tool registry (webfetch/websearch/repl/etc), the ~10K-token lean loop layout, done-as-a-tool. Extract the exact tool surface and loop shape.` },
  { slug: 'aside-03-perception-snapshot', label: 'aside:perception+snapshot',
    files: `${AP}/40_perception.md ${AP}/91_snapshot_builder.md`,
    focus: `The perception layer: the injected a11y-tree walker, compact indented ARIA tree format with ephemeral ref IDs (eN / f1eN), the DIFF-when-shorter mechanism, downsample+enrich, offscreen/iframe inclusion, "never slice() the tree" rule. Extract the exact snapshot format and the diff algorithm.` },
  { slug: 'aside-04-actuation-webright', label: 'aside:asidewright(actuation)',
    files: `${AP}/90_asidewright.md ${AP}/101_asidewright_actuation.md ${AP}/92_agent_chromium_patches.md`,
    focus: `"Asidewright" — the Playwright-clone → CDP actuation engine (THE "Webright" the owner meant). Locator deref from ref, actionability gates (visible/stable/enabled/receives-events), timing constants, retry/auto-wait, no-focus-steal, stealth/accuracy Chromium patches. Extract the actionability gate list + timing constants + the deref path.` },
  { slug: 'aside-05-security-guardrails', label: 'aside:security+guardrails',
    files: `${AP}/60_native_security.md ${AP}/89_guardrails_captcha.md ${AP}/100_agent_errors_modes.md`,
    focus: `Security as first-class: the lethal-trifecta framing, prompt-injection defenses (system_message authoritative only from user; tool/page output is DATA not INSTRUCTIONS; <untrusted_repl_output> fencing; stop-on-suspected-injection), per-credential agentAccessPolicy, final_confirm / request_action_confirmation for destructive/paid actions, guard mode, captcha/amount-extraction guardrails, fs-jail, error/recovery paths. Extract the exact defense mechanisms and prompt snippets.` },
  { slug: 'aside-06-memory-subagents', label: 'aside:memory+subagents',
    files: `${AP}/85_memory_moss.md ${AP}/25_daemon_brain.md ${AP}/97_subagents_context.md`,
    focus: `Memory (file-backed AGENTS.md/SOUL.md/USER.md/MEMORY.md, episodic extraction, gated "dreaming" consolidation, moss hybrid dense+BM25 retrieval) and multi-agent subagents (typed context_explorer/code_explorer/fork_self, 1-level max-5, no live-tab sharing, the compaction algorithm, the 21.6k-char prompt layout). Extract what a SKILL for sub-agents should borrow (and what is product-specific overkill).` },
  { slug: 'aside-07-vision-skills', label: 'aside:vision+skills',
    files: `${AP}/98_vision_loop.md ${AP}/99_skills_engine.md`,
    focus: `The vision loop (measured 89.3% of tasks use ZERO vision — a11y-first, vision only to disambiguate; annotatedScreenshot). The skills engine (URL auto-inject of site skills, node:vm library, verbatim site skills). Extract when vision is actually needed and how a "site skill / actionbook" cache should work.` },
  { slug: 'aside-08-models-streaming', label: 'aside:models+streaming',
    files: `${AP}/102_model_streaming_routing.md ${AP}/103_custom_agents_onboarding.md ${AP}/50_models_gateway.md`,
    focus: `The 4-slot model router (fast/standard/deep/visual), resumable raw-WS streaming protocol (seq cursors, replay), skill authoring + onboarding. Extract only what a keyless CLI-skill (where the HOST model is the brain) should keep — flag the rest as product infra we DON'T rebuild.` },

  { slug: 'vercel-agent-browser', label: 'vercel:agent-browser',
    files: `${TD}/VERCEL.md /Users/seventyleven/Desktop/badresearch/src/bad_research/browse/agent_browser.py`,
    focus: `Vercel's agent-browser CLI (vercel-labs/agent-browser) — the real keyless Rust CLI where the HOST model is the brain (this is the closest existing thing to our target). Extract its EXACT command surface (open/snapshot -i/click/fill @eN/eval/wait/network/state/cookies), the @eN snapshot grounding, engine choice (chrome-for-testing / lightpanda), --json output, session/state/headers flags, and the ReAct loop the Python wrapper drives. In VERCEL.md grep for 'agent-browser'. This is the PRIMARY command-surface reference.` },
  { slug: 'baseline-skill-and-cli', label: 'baseline:existing skill+cli',
    files: `/Users/seventyleven/Desktop/best-rust-patterns-skills/skills/core-agent-browser/SKILL.md /Users/seventyleven/Desktop/badresearch/src/bad_research/browse/agent_browser.py /Users/seventyleven/Desktop/badresearch/tests/test_browse`,
    focus: `The two BASELINES we are forking: (1) the existing core-agent-browser SKILL.md (the skill doc + command surface + form-submission example), (2) the agent_browser.py provider + its tests (Snapshot parsing, ref normalization @e1/ref=e1/e1, grounding has_ref, page-changing re-snapshot set, StorageState auth, cookies-set-curl auth). ls the test dir and read the tests to learn the exact contract. Extract the FULL command surface + the grounding/auth contract we must preserve and improve.` },

  { slug: 'browser-use', label: 'browser-use',
    files: `${TD}/BROWSER_USE.md`,
    focus: `Browser Use patterns: DOM/a11y serialization, the action/controller registry, indexed clickable elements, the agent memory, sensitive-data handling, structured output, and how it degrades. Extract patterns that beat or complement the ref-snapshot approach, and its anti-patterns.` },
  { slug: 'stagehand-act-extract-observe', label: 'stagehand:act/extract/observe',
    files: `${D}/browserbase/STAGEHAND_DEEP.md ${D}/browserbase/STAGEHAND_321_FULL_EXTRACTION.md`,
    focus: `Stagehand's act/extract/observe primitives, the self-heal/caching of actions, the URL->integer-ID grounding for extract (so a reported value can't be hallucinated), the verbatim act/extract/observe system prompts, observe-before-act. Extract the three primitives' contracts + the ID-grounding extract algorithm.` },
  { slug: 'browserbase-sessions-stealth', label: 'browserbase:sessions+stealth',
    files: `${D}/browserbase`,
    focus: `Browserbase session lifecycle, stealth/proxy/captcha handling, recording, CUA clients, model gateway. ls the dir and read BROWSERBASE.md + session-lifecycle + captcha files. Extract session-management + stealth patterns relevant to a LOCAL CLI (and clearly flag cloud-only infra as out-of-scope-but-note).` },
  { slug: 'agentql', label: 'agentql',
    files: `${D}/agentql`,
    focus: `AgentQL: query-based element finding (a resilient query language over the a11y/DOM tree vs brittle selectors), the browser fleet pattern, caching of resolved queries. ls the dir and read the main teardown + AGENTQL_R2_05_TETRA_BROWSER_FLEET.md. Extract the query-language idea and whether a lightweight query/locator DSL belongs in our CLI.` },
  { slug: 'perplexity-computer', label: 'perplexity-computer',
    files: `${TD}/PERPLEXITY_COMPUTER.md`,
    focus: `Perplexity's Computer / CUA (computer-use agent) patterns: pixel/vision vs a11y trade-offs, task decomposition, tab/session orchestration, verification. Extract what a browser-only agent should borrow and what is over-scoped for a browser CLI.` },

  { slug: 'prior-synthesis-eval-gate', label: 'prior:eval-gate synthesis',
    files: `/Users/seventyleven/Desktop/travels/docs/plans/2026-07-08-agent-browser-and-evals.md /Users/seventyleven/Desktop/travels/docs/plans/2026-07-06-travels-automation-from-aside.md`,
    focus: `The owner's PRIOR synthesis of exactly this problem: the convergent architecture (snapshot->ref->action->re-snapshot, done-as-tool, vision-to-disambiguate, ID-grounded extract), the "EVALS ARE THE GATE, build first" thesis, reader/actor phase-filtered tool quarantine, and the explicit "do NOT build" cargo-cult list. Extract the convergent architecture + the eval-gate discipline + the anti-cargo-cult list VERBATIM — this is our north star.` },
]

phase('Mine')
const digests = await parallel(SOURCES.map((s) => () =>
  agent(
    `${TOOLS}\n\n${GOAL}\n\nSOURCE: ${s.label}\nPRIMARY PATHS: ${s.files}\n\nFOCUS: ${s.focus}\n\nTASK:\n1. Read the primary paths in full (use Bash/ls/grep to locate real files if a path is a directory or missing). These are large teardown files — read thoroughly, follow section anchors.\n2. Write a thorough, GROUNDED markdown digest to ${OUT}/${s.slug}.md — organized as: Killer Insight; Patterns (each with What/Why/How-to-implement/Evidence/Tier); Command Surface (verbatim); Anti-patterns (what NOT to copy). Be concrete: real formats, flags, constants, algorithms, prompt snippets. Quote specifics.\n3. Return the structured summary. Set digest_path to the file you wrote.\n\nQuality bar: every pattern needs a real file:section anchor. Prefer 12-20 specific patterns over vague generalities. Distinguish CORE (must-have for the ultimate CLI) from nice-to-have from anti-pattern.`,
    { label: `mine:${s.slug}`, phase: 'Mine', schema: SCHEMA, model: 'sonnet', effort: 'medium' }
  ).then((r) => ({ ...r, label: s.label })).catch(() => null)
))

const ok = digests.filter(Boolean)
log(`Mined ${ok.length}/${SOURCES.length} sources.`)

phase('Synthesize')
const corpusPath = `${REPO}/research/synthesis/pattern-corpus.md`
const synthSummary = await agent(
  `You have FULL tool access. You are the SYNTHESIS lead for building the ULTIMATE browser-automation CLI/skill for AI agents.\n\n${ok.length} mining agents each wrote a grounded digest under ${OUT}/. READ ALL of them (ls ${OUT}/ then read every .md). They cover: Aside (8 subsystems), Vercel agent-browser, the two baselines we fork, Browser Use, Stagehand, Browserbase, AgentQL, Perplexity Computer, and the owner's prior eval-gate synthesis.\n\nProduce ${corpusPath} — the unified PATTERN CORPUS that will drive the design. Structure it as:\n\n1. **The convergent architecture** — the spine every source agrees on (snapshot->ref->action->re-snapshot; done-as-tool; vision-to-disambiguate; ID-grounded extract). State it crisply.\n2. **The command surface** — the concrete CLI command/flag set we should ship (reconcile Vercel's agent-browser surface + the baseline SKILL.md + enhancements from Aside/Stagehand). Include the snapshot format and @ref grounding.\n3. **The two-mode thesis** — discrete commands (open/snapshot/click) AND a code-execution 'run' mode (Aside's repl-over-page). Decide how both fit.\n4. **Perception** — the exact snapshot builder design (compact a11y tree, ephemeral refs, diff-when-shorter, interactive-only filter, downsample/enrich, offscreen/iframe).\n5. **Actuation** — the actionability gates + auto-wait + timing constants + re-snapshot-on-page-change rules (from asidewright).\n6. **Security model** — the lethal-trifecta defenses we ship by default (prompt-injection framing, untrusted-output fencing, ref-grounding-prevents-hallucination, confirmation gates for destructive/paid, reader/actor quarantine, secrets handling, allowlist).\n7. **Extract & structured output** — the ID-grounded extract contract.\n8. **Auth & sessions** — StorageState, cookies-as-curl, profiles, persistence.\n9. **Evals** — the eval-gate discipline + what the eval harness must measure (this is the MOAT — treat as first-class).\n10. **Explicit NON-GOALS / cargo-cult to avoid** — merge every anti-pattern the miners flagged + the owner's prior "do NOT build" list.\n11. **Ranked build order** — CORE must-haves first.\n\nBe decisive and concrete — this is a build spec, not a survey. Cite which source each major decision draws from. Return a compact executive summary (<= 400 words) of the corpus plus the path.`,
  { label: 'synthesize:corpus', phase: 'Synthesize', effort: 'high' }
)

phase('RedTeam')
const redTeamPath = `${REPO}/research/synthesis/red-team.md`
const redTeam = await agent(
  `You have FULL tool access. You are an ADVERSARIAL critic (Compound-V critical-thinking: steelman + disconfirm). Read ${corpusPath} and the digests under ${OUT}/.\n\nYour job is to make the ultimate agent-browser CLI/skill ACTUALLY the best by attacking the synthesis BEFORE we build:\n- What in the pattern corpus is CARGO-CULT (copied because a big system had it, not because a keyless CLI-skill needs it)? Kill it.\n- Where is the corpus OVER-ENGINEERED for a v1 skill that a sub-agent installs and drives via shell? (memory/dreaming? subagents? model router? cloud sessions?)\n- Where is it UNDER-SPECIFIED such that a builder would guess wrong? (snapshot format details, ref lifecycle, re-snapshot triggers, extract grounding, error handling)\n- What is the single biggest RISK to this being genuinely better than Vercel agent-browser + browser-use + Stagehand, rather than a worse reimplementation? Steelman the case for "just wrap an existing tool instead."\n- Security holes: does the default posture actually close the lethal trifecta, or just talk about it?\n- Evals: is the proposed eval harness real and runnable, or hand-wavy?\n\nWrite ${redTeamPath} with: (a) KILL LIST (cut these), (b) SHARPEN LIST (under-specified -> exact spec), (c) the DEFENSIBLE CORE (what genuinely makes this better, keep at all costs), (d) top 5 build risks + mitigations. Be blunt and specific; no praise-padding. Return a compact summary + the path.`,
  { label: 'redteam:corpus', phase: 'RedTeam', effort: 'high' }
)

return {
  mined: ok.length,
  sources: ok.map((d) => ({ slug: d.source_slug, killer: d.killer_insight })),
  corpus: corpusPath,
  synthSummary,
  redTeamPath,
  redTeam,
}
