export const meta = {
  name: 'silver-decision-base-language',
  description: 'Unbiased decision workflow: which base (Vercel/Webwright/Aside) + which language (Rust/TS/Python) should Silver consolidate on. Evidence -> Advocates -> independent Judges -> Synthesis -> Red-team.',
  phases: [
    { title: 'Evidence', detail: 'grounded fact-finding on each base + language from the real code' },
    { title: 'Advocate', detail: 'steelman each strategy (strongest honest case)' },
    { title: 'Judge', detail: 'independent judges score all strategies on fixed weighted criteria' },
    { title: 'Decide', detail: 'synthesize the verified recommendation' },
    { title: 'RedTeam', detail: 'critical-thinking on the recommendation' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const OUT = `${REPO}/research/decision`
const SILVER_RUST = `${REPO}/silver`               // the forked+rebranded Vercel Rust engine (WORKS today)
const TS_MOXXIE = `${REPO}/skill/agent-browser`    // our existing TS CLI on Playwright (WORKS, eval-gated)
const WW = `${REPO}/reference/webwright`            // Microsoft Webwright (Python+Playwright)
const VERCEL = `${REPO}/reference/agent-browser`    // upstream Vercel (Rust)
const R1 = `${REPO}/research/sources`               // round-1/2 source digests (aside, etc.)

const CONTEXT = `PROJECT "Silver": the ULTIMATE keyless browser CLI/skill for AI agents. The host LLM is the brain; Silver is eyes+hands and NEVER calls a model (100% keyless). GOAL: consolidate into ONE product in ONE language that adapts the BEST of all sources: Vercel agent-browser (fast, agent-ergonomic CLI, great for QUICK tasks), Webwright (Microsoft, great for LONG-RUNNING tasks — task = a re-runnable script, logs are the artifact), Aside (the SOTA browser-agent — REPL/code-execution, long-horizon, memory, subagents), Browser Use / Stagehand / AgentQL / Perplexity. Required capabilities: (a) agent-ergonomic CLI + a general SKILL.md; (b) fast quick tasks; (c) long-running/resumable tasks; (d) PARALLEL multi-agent orchestration — a user launches many sub-agents, each can drive its OWN browser or share ONE browser doing parallel tasks; (e) install-and-use with zero config; (f) keyless.

ASSETS WE ALREADY HAVE (both work): (1) a forked+rebranded Vercel Rust CLI at ${SILVER_RUST} (full 60+ verb surface, builds, drives Chrome; we already added a keyless ID-grounded extract + DNS-SSRF guard in Rust). (2) a TS CLI on Playwright at ${TS_MOXXIE} (142 tests, eval pass_k 1.000, our extract/security/diff in TS). Webwright (Python) at ${WW}.`

const TOOLS = `You have FULL tool access (Read, Grep, Glob, Bash). READ the actual code (${SILVER_RUST}, ${TS_MOXXIE}, ${WW}, ${VERCEL}, ${R1}). Ground every claim in a real file you read. Be objective — do NOT assume the owner's lean (they said they *might* be wrong and want an unbiased verdict).`

const CRITERIA = `SCORING CRITERIA (fixed weights — use these exactly):
1. Agent-ergonomics — how easily an LLM host drives it via shell (weight 3)
2. Quick-task speed / latency (weight 2)
3. Long-running / resumable task support — script-as-artifact, session persistence, recovery (weight 3)
4. Parallel multi-agent / multi-browser orchestration — many agents, own-or-shared browser, parallel sessions (weight 3)
5. Install-and-use / zero-config distribution for a sub-agent (weight 2)
6. Enhanceability / dev velocity — how fast WE can adapt+extend+absorb the best of all sources (weight 3)
7. Keyless fit (weight 1 — all can be keyless)
8. Leverage of existing assets — we have a working Rust fork AND a working TS CLI (weight 2)
9. Ecosystem fit — Playwright/CDP maturity, browser control depth (weight 2)`

const STRATEGIES = `THE THREE STRATEGIES UNDER EVALUATION:
- S1 "Rust / keep-Vercel-fork": keep enhancing the forked Vercel Rust CLI (${SILVER_RUST}). Fast single static binary; we add long-task + parallel + our deltas in Rust.
- S2 "TypeScript / consolidate": consolidate everything in TS — adapt Vercel's design + our existing TS CLI (${TS_MOXXIE}) + Webwright's long-task patterns, on Playwright/CDP. npm-distributed.
- S3 "Python / consolidate": consolidate in Python — adapt Webwright (Python+Playwright) + Vercel's design + Aside patterns. pip/uv-distributed.`

phase('Evidence')
const EVIDENCE = [
  { slug: 'ev-vercel-rust', focus: `Evaluate the Rust/Vercel-fork base (${SILVER_RUST} + ${VERCEL}). Read the code. FACTS on: verb surface + agent-ergonomics, speed/daemon architecture, session persistence + restore (long-task readiness), multi-session/parallel support (can N agents each get an isolated session? shared browser?), how HARD it is for US to add features in Rust (build times, complexity), distribution (single binary vs needs cargo/npm). Objective pros/cons.` },
  { slug: 'ev-webwright-python', focus: `Evaluate Webwright (${WW}, Python+Playwright). Read the code. FACTS on: its long-running-task model (task=re-runnable script, logs-as-artifact — how does it actually work?), perception, the skill form, multi-session/parallel support, install (pip/uv), how easily WE could adapt it. What is genuinely BEST about Webwright for long tasks that Vercel lacks? Objective pros/cons.` },
  { slug: 'ev-ts-moxxie', focus: `Evaluate the TypeScript base (${TS_MOXXIE}, our existing CLI on Playwright). Read the code. FACTS on: what works (142 tests, eval-gated, our extract/security/diff), agent-ergonomics, session model + persistence, multi-session/parallel readiness, npm distribution, dev velocity. What would we KEEP vs rewrite if TS wins? Objective pros/cons.` },
  { slug: 'ev-language', focus: `Language comparison for an agent-driven browser CLI: Rust vs TypeScript vs Python. Objective on: (a) install-and-use/distribution (single binary vs npm vs pip/uv), (b) startup + runtime speed, (c) browser-control ecosystem (Playwright is TS-native + Python-official; Rust uses raw CDP/chromiumoxide), (d) dev velocity / enhanceability for US, (e) concurrency model for parallel browsers (tokio vs node event loop vs asyncio). Cite the real repos as evidence (Vercel hand-rolls CDP in Rust; Webwright uses Playwright-Python; ours uses Playwright-TS).` },
  { slug: 'ev-parallel', focus: `The PARALLEL multi-agent / multi-browser requirement specifically. Read all three bases. Which architecture best supports: many sub-agents each launching their OWN browser session, OR many agents sharing ONE browser doing parallel tasks (tabs/contexts)? How does each base's session/daemon model + language concurrency support this? What would the ideal design be, and which base/language is closest?` },
  { slug: 'ev-longtask', focus: `The LONG-RUNNING / RESUMABLE task requirement. Compare Webwright's script-as-artifact approach vs Vercel's session/restore vs Aside's REPL+memory (from ${R1}, the aside digests). What's the best keyless design for long-horizon browser tasks (resume after crash, replayable history, checkpoints), and which base/language enables it most cleanly?` },
  { slug: 'ev-aside-adapt', focus: `Aside patterns worth adapting into Silver's basement (read the aside digests under ${R1}: aside-02 runtime/tools, aside-06 memory/subagents, aside-07 vision/skills). Which Aside patterns (REPL/code-execution, long-horizon loop, memory, subagent orchestration, site playbooks) should Silver adopt, and does the choice of base/language make any of them easier/harder? Keyless-compatible only.` },
  { slug: 'ev-distribution', focus: `Install-and-use reality for a sub-agent: can it instantly get + run each option with zero config? Rust (cargo build / prebuilt binary + Chrome download), TS (npm i + playwright install), Python (pip/uv + playwright install). Cross-platform. Which is genuinely the lowest-friction "just install and use" for an arbitrary agent sandbox? Test what you can (cargo/npm/uv are available).` },
]
const evDigests = await parallel(EVIDENCE.map((e) => () =>
  agent(`${TOOLS}\n\n${CONTEXT}\n\nEVIDENCE TASK (${e.slug}): ${e.focus}\n\nWrite a grounded fact digest to ${OUT}/${e.slug}.md (Facts / Pros / Cons / relevance to each of the 9 criteria). Return a compact summary (<=250 words) + the path. FACTS with file anchors, not opinions.`,
    { label: e.slug, phase: 'Evidence', model: 'sonnet', effort: 'medium' }
  ).then((r) => r).catch(() => null)
))
log(`Evidence: ${evDigests.filter(Boolean).length}/${EVIDENCE.length} done.`)

phase('Advocate')
const ADVOCATES = [
  { slug: 'adv-rust', s: 'S1 (Rust / keep the Vercel fork)' },
  { slug: 'adv-ts', s: 'S2 (TypeScript / consolidate)' },
  { slug: 'adv-python', s: 'S3 (Python / consolidate)' },
]
const advDigests = await parallel(ADVOCATES.map((a) => () =>
  agent(`${TOOLS}\n\n${CONTEXT}\n\n${STRATEGIES}\n\n${CRITERIA}\n\nYou are the ADVOCATE for ${a.s}. Read ALL evidence digests under ${OUT}/ (ls then read) + the real code. Make the STRONGEST HONEST case for ${a.s} being the best substrate for Silver — grounded, acknowledging its real weaknesses (a case that hides the downsides is worthless). Address every one of the 9 criteria, and specifically how ${a.s} handles long-running tasks + parallel multi-browser + adapting the best of all sources. Write ${OUT}/${a.slug}.md. Return a <=300-word summary + path.`,
    { label: a.slug, phase: 'Advocate', model: 'sonnet', effort: 'high' }
  ).then((r) => r).catch(() => null)
))
log(`Advocates: ${advDigests.filter(Boolean).length}/3 done.`)

phase('Judge')
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scores', 'winner', 'reasoning', 'confidence'],
  properties: {
    scores: {
      type: 'object', additionalProperties: false, required: ['S1_rust', 'S2_ts', 'S3_python'],
      properties: {
        S1_rust: { type: 'number' }, S2_ts: { type: 'number' }, S3_python: { type: 'number' },
      },
      description: 'weighted total 0-100 for each strategy',
    },
    winner: { type: 'string', enum: ['S1_rust', 'S2_ts', 'S3_python'] },
    confidence: { type: 'integer' },
    reasoning: { type: 'string', description: 'why this winner; the decisive criteria' },
    per_criterion: { type: 'string', description: 'brief per-criterion note on which strategy won each' },
  },
}
const judges = await parallel([0, 1, 2, 3, 4].map((i) => () =>
  agent(`${TOOLS}\n\n${CONTEXT}\n\n${STRATEGIES}\n\n${CRITERIA}\n\nYou are INDEPENDENT JUDGE #${i + 1}. Read ALL evidence + advocate digests under ${OUT}/ and spot-check the real code. Score EACH strategy (S1 Rust, S2 TS, S3 Python) as a weighted 0-100 total against the 9 fixed criteria+weights. Be objective and skeptical of every advocate's spin. Pick a winner. Do NOT default to the owner's lean or the current Rust fork — score on merit. Return the structured verdict.`,
    { label: `judge-${i + 1}`, phase: 'Judge', schema: JUDGE_SCHEMA, effort: 'high' }
  ).then((v) => v).catch(() => null)
))
const votes = judges.filter(Boolean)
const tally = { S1_rust: 0, S2_ts: 0, S3_python: 0 }
votes.forEach((v) => { if (v.winner && tally[v.winner] !== undefined) tally[v.winner]++ })
const avg = { S1_rust: 0, S2_ts: 0, S3_python: 0 }
votes.forEach((v) => { for (const k of Object.keys(avg)) avg[k] += (v.scores?.[k] || 0) })
for (const k of Object.keys(avg)) avg[k] = votes.length ? Math.round(avg[k] / votes.length) : 0
log(`Judges: winners tally ${JSON.stringify(tally)}; avg scores ${JSON.stringify(avg)}`)

phase('Decide')
const decisionPath = `${REPO}/research/decision/DECISION.md`
const decision = await agent(
  `${TOOLS}\n\n${CONTEXT}\n\n${STRATEGIES}\n\n${CRITERIA}\n\nYou are the DECISION synthesizer. The 5 independent judges voted — winners tally: ${JSON.stringify(tally)}; average weighted scores: ${JSON.stringify(avg)}. Read ALL digests under ${OUT}/ (evidence + advocates) and the judges' reasoning is reflected in the tally/averages above.\n\nWrite ${decisionPath} — the VERIFIED decision: (1) the chosen LANGUAGE + BASE strategy and WHY (grounded, weighing the judge consensus + evidence, not the owner's lean); (2) if the winner is NOT the current Rust fork, the honest migration plan (what to reuse from the Rust fork + the TS CLI + Webwright); (3) the target ARCHITECTURE for the required capabilities — agent-ergonomic CLI + general SKILL, fast quick tasks, long-running/resumable tasks (script-as-artifact + session persistence), PARALLEL multi-agent multi-browser (own-or-shared), keyless; (4) exactly which patterns to adapt from Vercel / Webwright / Aside / the rest, mapped to the design; (5) the build order. Be decisive. Return a <=400-word exec summary + the path.`,
  { label: 'decide', phase: 'Decide', effort: 'high' }
)

phase('RedTeam')
const rtPath = `${REPO}/research/decision/decision-redteam.md`
const redTeam = await agent(
  `${TOOLS}\n\nAdversarial critic (Compound-V critical-thinking). Read ${decisionPath} + the digests under ${OUT}/. The decision picks a base+language for Silver. ATTACK it: Is the winner actually best, or an artifact of biased advocacy / sunk-cost in an existing asset? Steelman the runner-up. Does the choice REALLY serve the hardest requirements — long-running tasks + parallel multi-browser — or just the easy ones? Any hidden cost (rewrite effort, distribution, keyless) underweighted? Is the migration plan realistic? Would the decision look different if we weighted install-and-use or dev-velocity higher? Write ${rtPath}: confirm-or-overturn the decision with reasons, the strongest case against, and any correction to the build plan. Blunt, no praise-padding. Return summary + path.`,
  { label: 'decide-redteam', phase: 'RedTeam', effort: 'high' }
)

return { evidence: evDigests.filter(Boolean).length, advocates: advDigests.filter(Boolean).length, judgeVotes: votes.length, tally, avgScores: avg, decisionPath, decision, rtPath, redTeam }
