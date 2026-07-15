export const meta = {
  name: 'silver-deep-synthesis',
  description: 'DEEP multi-lens synthesis: per-source lens fan-outs + rigorous empirical engine benchmarking vs Vercel + Anthropic skill best-practices + transcripts/BAD_GUIDE + usage taxonomy -> engine plan + adopt-list + world-class SKILL -> adversarial verification.',
  phases: [
    { title: 'DeepDive', detail: 'per-source lens agents (thorough whole-file reads) + Anthropic-skill + transcripts + usage taxonomy' },
    { title: 'Measure', detail: 'rigorous empirical benchmarking of Silver vs the real Vercel binary (tokens, latency, parallel)' },
    { title: 'Synthesize', detail: 'engine plan + top-5-gaps adopt-list + world-class SKILL design' },
    { title: 'Verify', detail: 'adversarial red-team + measurement sanity-check' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const OUT = REPO + '/research/deepdive'
const SEED = REPO + '/research/topfive'   // the prior (shallow) digests — seed, then go DEEPER
const SRC = REPO + '/silver/src'
const REF = REPO + '/reference'
const ORACLE = REPO + '/rust-oracle'
const RF = '/Users/seventyleven/Desktop/researchfms'
const TD = RF + '/teardowns'
const AP = TD + '/_aside_parts'
const R1 = REPO + '/research/sources'
const BIN = REPO + '/silver/dist/cli.js'
const CHROME = '/Users/seventyleven/.agent-browser/browsers/chrome-149.0.7827.54/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const CTX = 'PROJECT "Silver": a KEYLESS Node/TS browser CLI on Playwright (code at ' + SRC + '; binary `node ' + BIN + '`). Host LLM is the brain; Silver NEVER calls a model. It already synthesizes Vercel agent-browser + Aside + Webwright + browser-use + Stagehand + AgentQL into one CLI (full verb parity + tasks + subagents + memory + parallel + extract + security, 230 tests, eval-gated). This is a DEEP investigation to make Silver GENUINELY better than each source by taking the TOP capabilities of each (true synthesis, not feature-checkboxing) and to verify/close the ENGINE efficiency gap vs Vercel (Rust + persistent daemon vs Silver TS + per-command CDP reconnect). Token-efficiency is a property of the SNAPSHOT format (not the language); latency is affected by the connection model. Be honest + empirical.'

const RIGOR = 'THIS IS A DEEP INVESTIGATION — shallow skimming is a FAILURE. Read the ENTIRE relevant files (not excerpts), follow imports/references, and produce a THOROUGH, SPECIFIC digest (aim 800-1500 words) with real file:line anchors and concrete mechanisms. Separate clearly: what the source does + HOW (mechanism), why it beats competitors, and the CONCRETE GAP vs Silver (read Silver code at ' + SRC + ') with a keyless adopt recommendation + priority. You have FULL tool access (Read, Grep, Glob, Bash, WebFetch, WebSearch).'

// ---- per-source lens fan-out ----
const SOURCES = [
  { name: 'vercel', paths: ORACLE + '/cli/src (+ ' + TD + '/VERCEL.md, seed ' + SEED + '/top5-vercel.md ' + SEED + '/engine-vercel-deep.md)',
    lenses: {
      engine: 'The ENGINE: the persistent per-session daemon + ONE held CDP connection (connection.rs/daemon.rs), no per-command reconnect, connection warmth, why it is FAST + LEAN. Read the daemon + CDP client fully. Quantify what Silver loses by connectOverCDP every command.',
      perception: 'Perception/token-efficiency: native/snapshot.rs — the @eN a11y-tree compaction (INTERACTIVE/CONTENT/STRUCTURAL role gating, compact mode, depth, iframe splice, hidden-input promotion), diff snapshot. What makes its snapshot LEAN (few tokens) yet complete. Compare byte-for-byte to Silver serialize.ts/walk.ts.',
      longhorizon: 'Sessions/restore/persistence: --session/--namespace, --restore + the encrypted state, worktree ids, idle-timeout, session gc. How it persists + resumes. Gap vs Silver session.ts.',
      top5dx: 'The TOP 5 things Vercel beats EVERY competitor on, + its agent DX (docs-in-binary two-tier skill, --json envelope, error UX). For each: what/why/evidence + Silver has-it-or-GAP.' } },
  { name: 'aside', paths: AP + ' + ' + R1 + '/aside-*.md (seed ' + SEED + '/top5-aside.md)',
    lenses: {
      engine: 'Why Aside is SOTA = the HARNESS not the model (95_why_sota, 20_runtime_loop, 96_tool_registry): the single repl/code-execution tool, the lean ~10K loop, the 1440x900 fixed viewport, concurrency. What harness levers should Silver adopt.',
      perception: 'The snapshot builder (91_snapshot_builder, 40_perception): injected a11y walker, downsample+enrich, diff-when-shorter, never-truncate, readiness gate. What Silver perception is missing.',
      longhorizon: 'Memory/dreaming + subagents (85, 25, 97): file-backed memory, episodic extraction, subagent orchestration + compaction. Keyless subset for Silver.',
      top5dx: 'TOP 5 things Aside beats every competitor on (long-horizon, security, REPL, memory) + DX. For each: what/why/evidence + Silver has-it-or-GAP.' } },
  { name: 'webwright', paths: REF + '/webwright/src + ' + REF + '/webwright/skills (seed ' + SEED + '/top5-webwright.md ' + SEED + '/engine-webwright-deep.md)',
    lenses: {
      browserlifecycle: 'DEEP: exactly how Webwright OPENS + PERSISTS the browser — read tools/persistent_local_browser.py + environments/local_browser.py FULLY. Launch, reuse, persistence across a long task, cleanup. The owner specifically wants this. Concrete adopt for Silver session/engine.',
      longtask: 'The LONG-TASK engine: run/ + agents/default.py + the skill craft/run modes — task = re-runnable script, logs-as-artifact, checkpoint, resume, self_reflection (drop the keyed part). How it beats a naive loop. Adopt for Silver task/.',
      perception: 'How Webwright captures + inspects page state/screenshots only when needed (utils/serialize.py, image_qa). Vision-gating. Gap vs Silver.',
      skillform: 'The skills/webwright/ SKILL packaging (SKILL.md + commands/{craft,run} + reference/{cli_tool_mode,playwright_patterns,workflow}) — the keyless host-driven form. What makes it a GREAT agent skill. Adopt for Silver SKILL.',
      top5dx: 'TOP 5 things Webwright beats every competitor on + DX. For each: what/why/file:line + Silver has-it-or-GAP.' } },
  { name: 'browseruse', paths: REF + '/browser-use/browser_use (+ ' + R1 + '/r2-browseruse-*.md, seed ' + SEED + '/top5-browseruse.md)',
    lenses: {
      perception: 'DOM serializer + interactive-element heuristic cascade + selector-map + viewport/visibility filtering. Read the dom service fully. What Silver walk.ts is missing.',
      actuation: 'Action/controller registry (decorator -> schema+dispatch+doc), multi_act page-change guard, watchdogs (downloads/permissions/crash), sensitive-data. Gap vs Silver actuation/security.',
      top5dx: 'TOP 5 things browser-use beats every competitor on + DX. For each: what/why/file:line + Silver has-it-or-GAP.' } },
  { name: 'stagehand', paths: REF + '/stagehand (+ ' + R1 + '/r2-stagehand-*.md, seed ' + SEED + '/top5-stagehand.md)',
    lenses: {
      extract: 'act/observe/extract + the id-grounding + injectUrls + self-heal/caching + the a11y tree (encoded ids). Read the core fully. Silver already has id-grounded extract — find refinements + the caching/self-heal Silver lacks.',
      perception: 'The accessibility tree build (backendId maps, iframe encoding, frame ordinals). Gap vs Silver walk.ts.',
      top5dx: 'TOP 5 things Stagehand beats every competitor on + DX. For each: what/why/file:line + Silver has-it-or-GAP.' } },
  { name: 'agentql', paths: RF + '/agentql (+ ' + R1 + '/agentql.md, seed ' + SEED + '/top5-agentql.md)',
    lenses: {
      query: 'Resilient query resolution, deterministic-before-model fallback, query caching, the fleet. What Silver find/resolve is missing (avoid a full DSL — flagged anti-pattern).',
      top5dx: 'TOP 5 things AgentQL beats every competitor on + DX. For each: what/why/evidence + Silver has-it-or-GAP.' } },
  { name: 'perplexity', paths: TD + '/PERPLEXITY_COMPUTER.md (seed ' + SEED + '/top5-perplexity.md)',
    lenses: {
      security: 'BrowseSafe injection defense (async classifier, replace-not-append), egress, verification, task decomposition. Keyless subset vs Silver security.',
      top5dx: 'TOP 5 things Perplexity/Comet beats every competitor on + DX. For each: what/why/evidence + Silver has-it-or-GAP.' } },
  { name: 'browserbase', paths: RF + '/browserbase',
    lenses: {
      sessions: 'Session lifecycle, stealth/proxy/captcha (LOCAL keyless subset only — flag cloud/paid as skip), recording. What local keyless wins for Silver.',
      top5dx: 'TOP 5 things Browserbase/Stagehand-cloud beats competitors on + which are keyless-local-relevant for Silver.' } },
]

const lensAgents = []
for (const s of SOURCES) {
  for (const [lens, focus] of Object.entries(s.lenses)) {
    const model = lens === 'engine' || lens === 'browserlifecycle' || lens === 'longtask' ? 'opus' : 'sonnet'
    lensAgents.push({ slug: s.name + '-' + lens, model, prompt: RIGOR + '\n\n' + CTX + '\n\nSOURCE: ' + s.name + ' | LENS: ' + lens + '\nPATHS: ' + s.paths + '\nFOCUS: ' + focus + '\n\nWrite a THOROUGH digest to ' + OUT + '/' + s.name + '-' + lens + '.md. Return a <=250-word summary + the path.' })
  }
}

// ---- companion investigations ----
const COMP = [
  { slug: 'anthropic-skills-1', model: 'sonnet', prompt: RIGOR + '\n\n' + CTX + '\n\nFind ALL of Anthropic\'s OFFICIAL best practices for authoring Agent Skills / SKILL.md. WebSearch + WebFetch: the Anthropic docs "Agent Skills" (docs.claude.com/en/docs/agents-and-tools/agent-skills and its authoring/best-practices pages), the engineering post "Equipping agents for the real world with Agent Skills", and the skill-creator guidance. Extract the DEFINITIVE authoring checklist: YAML frontmatter (name, description trigger-phrasing, allowed-tools), progressive disclosure (SKILL.md + linked reference files + scripts, keep SKILL.md concise/under a few hundred lines), when-to-use triggers, concrete worked examples, command/tool tables, the single-clear-contract principle, degradation, and what makes agents actually LOAD + FOLLOW a skill. Write ' + OUT + '/anthropic-skills-1.md. Return summary + path.' },
  { slug: 'anthropic-skills-2', model: 'sonnet', prompt: RIGOR + '\n\n' + CTX + '\n\nStudy GREAT existing skills as exemplars for Silver\'s SKILL: read the on-disk Compound-V skills at /Users/seventyleven/Desktop/compound-v/skills (frontmatter + structure + tone), the Vercel agent-browser skill-data at ' + REF + '/agent-browser/skill-data + skills, the Webwright skill at ' + REF + '/webwright/skills/webwright, and Silver\'s CURRENT ' + REPO + '/silver/skill-data/core/SKILL.md. Extract the concrete structural + tonal patterns that make a browser-CLI skill instantly usable by an agent (command tables, the loop, decision guidance, examples-from-real-output, hard rules). Write ' + OUT + '/anthropic-skills-2.md. Return summary + path.' },
  { slug: 'transcripts-1', model: 'sonnet', prompt: RIGOR + '\n\n' + CTX + '\n\nMine ' + RF + '/Transcripts/TRANSCRIPTS_ANTHROPIC.md + ' + RF + '/Transcripts/TRANSCRIPTS_CLAUDE_CODE_101.md for wisdom on skills, agent tool-use, context engineering, and browser/agent usage applicable to Silver\'s SKILL + design. Write ' + OUT + '/transcripts-1.md. Return summary + path.' },
  { slug: 'transcripts-2', model: 'sonnet', prompt: RIGOR + '\n\n' + CTX + '\n\nMine /Users/seventyleven/Desktop/BAD_GUIDE.md (211KB) for skill-authoring + agent-CLI + browser-automation wisdom + any usage patterns/philosophy applicable to Silver. Write ' + OUT + '/transcripts-2.md. Return summary + path.' },
  { slug: 'transcripts-3', model: 'sonnet', prompt: RIGOR + '\n\n' + CTX + '\n\nSurvey the OTHER transcripts under ' + RF + '/Transcripts/ (ls it; read any about agents, tools, browsers, product, or ML systems relevant to agent-browser usage). Extract broadly-applicable design + usage wisdom for Silver. Write ' + OUT + '/transcripts-3.md. Return summary + path.' },
  { slug: 'usage-taxonomy', model: 'opus', prompt: RIGOR + '\n\n' + CTX + '\n\nProduce a BROAD, GENERALIZED taxonomy of what AI agents actually do with a browser — the owner wants MANY use cases, not just "Vercel=quick, Aside+Webwright=long". Enumerate categories with concrete examples + which Silver verbs/modes serve each: quick lookup/read, deep multi-source research, form-filling + auth flows, checkout/booking (paid, gated), data extraction pipelines (structured), monitoring/price-watch, testing/QA of a web app, parallel multi-tab gather, competitive scraping (consent), long autonomous tasks (resumable), multi-agent fan-out, verification/fact-check, screenshot/vision-when-needed, download/upload, session reuse across runs. For EACH: the goal, the Silver command sequence, and which mode (quick vs long-task vs parallel/subagent). This drives the SKILL\'s decision guidance. Write ' + OUT + '/usage-taxonomy.md. Return summary + path.' },
]

phase('DeepDive')
const dd = await parallel(lensAgents.concat(COMP).map((a) => () =>
  agent(a.prompt, { label: a.slug, phase: 'DeepDive', model: a.model, effort: a.model === 'opus' ? 'high' : 'medium' })
    .then((r) => ({ slug: a.slug, r })).catch(() => null)))
log('DeepDive: ' + dd.filter(Boolean).length + '/' + (lensAgents.length + COMP.length) + ' done.')

phase('Measure')
const measure = await parallel([
  { slug: 'measure-tokens', prompt: 'EMPIRICAL: measure SNAPSHOT SIZE (chars = token proxy) Silver vs the real Vercel agent-browser 0.31.2 (on PATH) on the SAME pages: https://example.com, https://news.ycombinator.com, https://en.wikipedia.org/wiki/Web_browser, https://github.com/microsoft/webwright . Silver = `node ' + BIN + '`; run `open <url>` then `snapshot -i` and `snapshot -i -c` (compact); count chars of each. Vercel = `agent-browser open <url>` then `agent-browser snapshot -i` / `-i -c`. Use a distinct --session per tool per page; close after. Tabulate chars per page per tool per mode. Report the ratio + verdict: is Silver token-competitive with Vercel? If Silver is fatter, WHERE (which nodes/attrs)? Write ' + OUT + '/measure-tokens.md.' },
  { slug: 'measure-latency', prompt: 'EMPIRICAL: measure LATENCY Silver vs Vercel. For each of https://example.com and https://en.wikipedia.org/wiki/Web_browser: time (a) cold `open` (first command, spawns/attaches browser), (b) 5 successive `snapshot -i` commands (warm), (c) a `get title`. Silver = `node ' + BIN + '` (reconnects per command); Vercel = `agent-browser` (persistent daemon). Use `date +%s%N` or `/usr/bin/time` around each. Run 3 trials, report medians in ms. Quantify Silver\'s per-command reconnect overhead vs Vercel\'s warm daemon. Write ' + OUT + '/measure-latency.md with the numbers + whether a persistent-connection change is warranted.' },
  { slug: 'measure-parallel-coldstart', prompt: 'EMPIRICAL: (1) PARALLEL throughput — launch 4 concurrent Silver sessions (--session p1..p4) each doing open+snapshot on a different page, time total wall-clock; note isolation. (2) COLD-START — time `node ' + BIN + ' version` (no browser) and the first `open` (browser spawn) for Silver, and `agent-browser --version` + first `open` for Vercel. Also inspect Silver session.ts to quantify the connectOverCDP reconnect cost per command (add a timing log or read the flow). Write ' + OUT + '/measure-parallel-coldstart.md with numbers + the engine-change recommendation (persistent connection cache? opt-in daemon?).' },
].map((m) => () => agent('You have FULL tool access (Bash, Read, Grep). ' + CTX + '\n\n' + m.prompt + '\n\nRUN REAL COMMANDS and report REAL NUMBERS (medians of multiple trials). Be rigorous + honest. Return a <=250-word summary + the path.',
  { label: m.slug, phase: 'Measure', model: 'opus', effort: 'high' }).then((r) => ({ slug: m.slug, r })).catch(() => null)))
log('Measure: ' + measure.filter(Boolean).length + '/3 done.')

phase('Synthesize')
const enginePath = REPO + '/research/synthesis/engine-plan.md'
const adoptPath = REPO + '/research/synthesis/adopt-list-v2.md'
const skillPath = REPO + '/research/synthesis/skill-design.md'
const syn = await parallel([
  { slug: 'syn-engine', out: enginePath, focus: 'Read ' + OUT + '/measure-*.md + ' + OUT + '/vercel-engine.md + ' + OUT + '/webwright-browserlifecycle.md + Silver session.ts. Decide, FROM THE EMPIRICAL NUMBERS: (1) is Silver token-competitive with Vercel (keep/tune the snapshot — name specific trims if fatter)? (2) is the per-command latency gap worth closing, and HOW (a cached long-lived CDP connection reused across commands? an opt-in persistent daemon? connection pooling?) — give a CONCRETE, keyless, low-risk design that preserves the robust stateless-command ergonomics + does not add the concurrency bugs the code-review already fought. Write the engine plan with prioritized, file-mapped changes.' },
  { slug: 'syn-adopt', out: adoptPath, focus: 'Read ALL ' + OUT + '/*-top5dx.md + every per-lens digest under ' + OUT + '/. Merge into a prioritized ADOPT-LIST: ONLY concrete capabilities Silver LACKS or does worse than best-in-class, each mapped to a Silver file/change, KEYLESS, P0/P1/P2, citing the source(s). Skip anything Silver already does well or that is cargo-cult / needs a model. Group by capability area.' },
  { slug: 'syn-skill', out: skillPath, focus: 'Read ' + OUT + '/anthropic-skills-*.md + ' + OUT + '/webwright-skillform.md + ' + OUT + '/usage-taxonomy.md + ' + OUT + '/transcripts-*.md + Silver\'s current ' + REPO + '/silver/skill-data/core/SKILL.md. Design the WORLD-CLASS Silver SKILL following Anthropic best-practices: exact frontmatter, progressive disclosure (SKILL.md + which reference/*.md files + examples.md), when-to-use triggers, the GENERALIZED use-case taxonomy with decision guidance (when to use which verb/mode: quick vs long-task vs parallel/subagent vs extract), full command tables, hard rules, real-output examples. Output a complete, build-ready SKILL spec + file plan so ANY agent 100% understands + uses Silver fully. Be concrete.' },
].map((z) => () => agent('You have FULL tool access. ' + CTX + '\n\nYou are a SYNTHESIS lead. ' + z.focus + '\n\nWrite ' + z.out + ' — decisive, concrete, cited. Return a <=400-word exec summary + the path.',
  { label: z.slug, phase: 'Synthesize', effort: 'high' }).then((r) => ({ slug: z.slug, r })).catch(() => null)))
log('Synthesize: ' + syn.filter(Boolean).length + '/3 done.')

phase('Verify')
const rtPath = REPO + '/research/synthesis/deepsynth-redteam.md'
const rt = await agent('You have FULL tool access. Adversarial critic (Compound-V critical-thinking). Read ' + enginePath + ', ' + adoptPath + ', ' + skillPath + ', the ' + OUT + '/measure-*.md, and Silver src (' + SRC + '). Attack all three: (a) ENGINE — do the MEASURED numbers actually justify a persistent-connection/daemon change, or is it premature optimization risking the robust stateless model + reintroducing the lock/race bugs the code-review just fixed? Steelman keeping reconnect. If a change IS justified, is the proposed design actually safe + keyless? (b) ADOPT-LIST — which items are cargo-cult / already-covered / need a model (flag non-keyless)? Which genuinely move the product? (c) SKILL — does it over-promise or bloat (an over-long skill is an anti-pattern)? Is every documented verb real? (d) Are the token/latency verdicts sound given the sample? Write ' + rtPath + ': confirm-or-cut each item with reasons + the corrected priority + the strongest counter-cases. Blunt, no praise-padding. Return summary + path.',
  { label: 'redteam', phase: 'Verify', effort: 'xhigh' })

return { deepdive: dd.filter(Boolean).length, measure: measure.filter(Boolean).length, enginePath, adoptPath, skillPath, rtPath, rt, synth: syn.map((x) => x && x.slug) }
