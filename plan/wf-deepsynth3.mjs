export const meta = {
  name: 'silver-deep-synthesis-3',
  description: 'Broader round: everything-transferable per source (10-15+), latest 2026 SOTA browser-agent techniques (web), failure-mode taxonomy, broad use-case/workflow taxonomy, agent-design patterns, novel-capability brainstorm -> adopt-list-v3 + roadmap -> red-team.',
  phases: [
    { title: 'Explore', detail: 'wide+deep mining per source + web SOTA + failure modes + use cases + design patterns + novel ideas' },
    { title: 'Synthesize', detail: 'adopt-list-v3 + capability roadmap' },
    { title: 'RedTeam', detail: 'adversarial cut/keep + keyless + cost-benefit' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const OUT = REPO + '/research/deepdive3'
const SRC = REPO + '/silver/src'
const REF = REPO + '/reference'
const ORACLE = REPO + '/rust-oracle'
const RF = '/Users/seventyleven/Desktop/researchfms'
const TD = RF + '/teardowns'
const AP = TD + '/_aside_parts'

const CTX = 'PROJECT "Silver": a KEYLESS Node/TS browser CLI on Playwright (' + SRC + '). Host LLM is the brain; Silver NEVER calls a model. It already synthesizes Vercel + Aside + Webwright + browser-use + Stagehand + AgentQL into one CLI (full verb parity + tasks + subagents + memory + parallel + extract + hardened security + an engine that is now token-lean + 6x faster on warm snapshot; 235 tests, eval-gated). This is the BROADER next investigation: not top-5 per source but EVERYTHING transferable (10-15+ per source), the LATEST 2026 techniques, failure modes, a broad use-case taxonomy, agent-design patterns, and NOVEL capabilities that would make Silver categorically the best keyless browser for agents. Prior rounds: research/topfive/, research/deepdive/, research/synthesis/{adopt-list-v2,engine-plan,skill-design}.md — READ the relevant prior digest for your area and go BEYOND it (do not repeat; find what was missed).'

const RIGOR = 'DEEP + BROAD — shallow is a failure. Read thoroughly; for web tasks do real WebSearch + WebFetch. Produce a thorough digest (800-1500 words) with specifics + file/URL anchors. For each idea: what it is, why it helps, the concrete Silver change (file), KEYLESS check, and priority. You have FULL tool access (Read, Grep, Bash, WebFetch, WebSearch).'

const A = []
const add = (slug, model, focus) => A.push({ slug, model, focus })

// wide per-source: EVERYTHING transferable (10-15+), beyond top-5
add('all-vercel', 'sonnet', 'Read Vercel agent-browser code at ' + ORACLE + '/cli/src EXHAUSTIVELY (every native/*.rs, commands.rs, flags.rs). List EVERYTHING (10-15+) transferable to Silver that Silver lacks or does worse — every flag, verb, ergonomic, engine trick, error-UX nicety, config option. Prior: research/deepdive/vercel-*.md + adopt-list-v2. Go beyond it. Write ' + OUT + '/all-vercel.md.')
add('all-aside', 'sonnet', 'Read the Aside teardown (' + AP + ' ALL parts) EXHAUSTIVELY. List EVERYTHING (10-15+) transferable + keyless that Silver lacks. Prior: research/deepdive/aside-*.md. Go beyond. Write ' + OUT + '/all-aside.md.')
add('all-webwright', 'opus', 'Read Webwright code at ' + REF + '/webwright EXHAUSTIVELY (src + skills + config). List EVERYTHING (10-15+) transferable — the long-task engine, browser lifecycle, skill packaging, config, prompts (keyless parts), utils. Prior: research/deepdive/webwright-*.md. Go beyond. Write ' + OUT + '/all-webwright.md.')
add('all-browseruse', 'sonnet', 'Read browser-use at ' + REF + '/browser-use/browser_use EXHAUSTIVELY. List EVERYTHING (10-15+) transferable + keyless. Prior: research/deepdive/browseruse-*.md. Go beyond. Write ' + OUT + '/all-browseruse.md.')
add('all-stagehand', 'sonnet', 'Read Stagehand at ' + REF + '/stagehand EXHAUSTIVELY. List EVERYTHING (10-15+) transferable + keyless. Prior: research/deepdive/stagehand-*.md. Go beyond. Write ' + OUT + '/all-stagehand.md.')
add('all-agentql-perplexity-bb', 'sonnet', 'Read AgentQL (' + RF + '/agentql), Perplexity (' + TD + '/PERPLEXITY_COMPUTER.md), Browserbase (' + RF + '/browserbase) teardowns. List EVERYTHING (10-15+ combined) transferable + keyless-local that Silver lacks. Go beyond adopt-list-v2. Write ' + OUT + '/all-agentql-perplexity-bb.md.')

// latest 2026 SOTA (web)
add('sota-2026-a', 'sonnet', 'WebSearch + WebFetch the LATEST (2025-2026) browser/computer-use agent techniques + tools + benchmarks: WebVoyager, Online-Mind2Web, WebArena/VisualWebArena leaderboards + the techniques the top systems use; new open tools (e.g. browser-use updates, Skyvern, Nova Act, OpenAI Operator/computer-use, Anthropic computer-use, Convergence, Multi-on, Runner H, etc). What techniques do the current SOTA systems use that Silver could adopt KEYLESSLY? Write ' + OUT + '/sota-2026-a.md.')
add('sota-2026-b', 'sonnet', 'WebSearch + WebFetch recent (2025-2026) research + engineering on: accessibility-tree vs pixel perception, set-of-marks, DOM distillation/compaction for token efficiency, self-correction/verification loops, and reliability techniques for web agents. Extract concrete keyless techniques Silver could adopt to improve perception/token-efficiency/reliability. Write ' + OUT + '/sota-2026-b.md.')

// failure modes
add('failure-modes', 'opus', 'Mine the teardowns (' + AP + '/100_agent_errors_modes.md, ' + TD + '/BROWSER_USE.md) + ' + RF + '/Transcripts + BAD_GUIDE for the FAILURE MODES that break real browser agents (stale refs, wrong-frame, hidden overlays, infinite loops, silent wrong-clicks, dynamic content races, auth expiry, captcha, rate limits, hallucinated success, injection). For EACH: does Silver prevent/handle it today (cite src), and if not, the keyless fix. A gap-driven reliability backlog. Write ' + OUT + '/failure-modes.md.')

// broad use-case + workflow taxonomy (beyond the first one)
add('use-cases-wide', 'opus', 'Produce a MUCH broader use-case + WORKFLOW taxonomy than research/deepdive/usage-taxonomy.md (which you should read + extend, not repeat). Include verticals (e-commerce, travel, finance, research, social, dev/QA, data, ops, legal/compliance, healthcare, real-estate, jobs, gov) and cross-cutting workflows (auth+2FA flows, pagination/infinite-scroll harvest, multi-step wizards, file up/download pipelines, CAPTCHA-handback, price monitoring, form automation, competitive intel, doc extraction, A/B testing). For each: the goal, Silver command sequence, mode, and any capability gap. This makes Silver generally usable for ANYTHING. Write ' + OUT + '/use-cases-wide.md.')

// agent-design patterns (transcripts)
add('agent-design-patterns', 'sonnet', 'Mine ' + RF + '/Transcripts (Anthropic, Claude Code, a16z, ICML, others) + BAD_GUIDE for AGENT-DESIGN patterns applicable to Silver: context engineering, tool-design principles, verification/eval discipline, harness-as-moat, progressive disclosure, error-UX, multi-agent orchestration. What should Silver adopt in its design/SKILL/ergonomics? Write ' + OUT + '/agent-design-patterns.md.')

// novel-capability brainstorm
add('novel-capabilities', 'opus', 'BRAINSTORM novel capabilities that would make Silver CATEGORICALLY the best keyless browser for agents — things NOT in any current competitor (or done better): e.g. deterministic action replay/record, a self-describing capability manifest for hosts, a first-class verification/assert verb, structured page-diff over time, a keyless "observe" that returns candidate actions, snapshot caching keyed by DOM hash, semantic-locator resilience, an offline HTML fixture recorder for evals, cross-run memory of site playbooks, a `plan`-artifact verb, cost/step accounting. For each: the idea, why it wins, the keyless Silver design (file), effort, priority. Be inventive but grounded (keyless, no model). Write ' + OUT + '/novel-capabilities.md.')

phase('Explore')
const ex = await parallel(A.map((a) => () =>
  agent(RIGOR + '\n\n' + CTX + '\n\nTASK (' + a.slug + '): ' + a.focus,
    { label: a.slug, phase: 'Explore', model: a.model, effort: a.model === 'opus' ? 'high' : 'medium' }
  ).then((r) => ({ slug: a.slug, r })).catch(() => null)))
log('Explore: ' + ex.filter(Boolean).length + '/' + A.length + ' done.')

phase('Synthesize')
const v3 = REPO + '/research/synthesis/adopt-list-v3.md'
const syn = await agent('You have FULL tool access. Synthesis lead. Read ALL digests under ' + OUT + '/ + the prior ' + REPO + '/research/synthesis/adopt-list-v2.md (do not re-list v2 items already done or deferred). Write ' + v3 + ' — the NEXT prioritized, keyless, file-mapped ADOPT-LIST + capability roadmap: the strongest NEW ideas from the wide per-source mining, 2026 SOTA, failure modes, use cases, design patterns, and novel brainstorm. Group by theme (engine/perception/actuation/reliability/extract/tasks/orchestration/security/skill/ergonomics). Each item: concrete Silver change (file), keyless check, effort, priority, source. Be decisive + broad — the owner wants a LOT of high-value work identified. Return a <=500-word exec summary + the path.',
  { label: 'synth-v3', phase: 'Synthesize', effort: 'high' })

phase('RedTeam')
const rtp = REPO + '/research/synthesis/adopt-list-v3-redteam.md'
const rt = await agent('You have FULL tool access. Adversarial critic. Read ' + v3 + ' + the digests + Silver src (' + SRC + '). Cut cargo-cult / non-keyless (flag any needing a model) / already-covered / not-worth-the-complexity items; confirm the genuinely high-value ones; correct the priority. Steelman keeping Silver simple where an item adds risk. Write ' + rtp + ': the confirm/cut table + corrected priority order. Blunt. Return summary + path.',
  { label: 'redteam-v3', phase: 'RedTeam', effort: 'high' })

return { explored: ex.filter(Boolean).length, adoptV3: v3, syn, rtp, rt }
