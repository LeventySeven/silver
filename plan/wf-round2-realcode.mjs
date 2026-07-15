export const meta = {
  name: 'uab-round2-realcode',
  description: 'Round 2: mine the REAL cloned source of Vercel agent-browser, browser-use, and stagehand for exact command surfaces, formats, schemas, skill/eval structure, and licenses.',
  phases: [
    { title: 'MineCode', detail: 'grounded agents reading actual repo source → digest files' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/ultimate-agent-browser'
const OUT = `${REPO}/research/sources`
const REF = `${REPO}/reference`

const GOAL = `PROJECT GOAL: Build the ULTIMATE keyless browser-automation CLI/skill for AI agents ("agent-browser") that a sub-agent installs and drives via the shell. We already mined the teardown docs (Round 1). This is Round 2: mine the ACTUAL SOURCE CODE of three shipped open-source tools so our build copies EXACT, correct command surfaces / formats / algorithms and we can fork/adapt with proper attribution.`

const TOOLS = `You have FULL tool access (Read, Grep, Glob, Bash). Read the real files. Use Bash (ls, find, rg/grep, cat) to navigate the repo, then Read the load-bearing files. Cite real file:line anchors. Do NOT guess an API — open the file and read it.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source_slug', 'license', 'killer_insight', 'exact_command_surface', 'patterns', 'reusable_code', 'anti_patterns', 'digest_path'],
  properties: {
    source_slug: { type: 'string' },
    license: { type: 'string', description: 'The repo LICENSE (read the LICENSE file) — for fork/adapt attribution.' },
    killer_insight: { type: 'string' },
    exact_command_surface: { type: 'array', items: { type: 'string' }, description: 'EXACT commands/subcommands/flags/API signatures/JSON shapes read from source (verbatim).' },
    patterns: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'what', 'how', 'evidence', 'tier'],
        properties: {
          name: { type: 'string' },
          what: { type: 'string' },
          how: { type: 'string', description: 'Concrete implementation detail: algorithm, data shape, constant, exact format — enough to reimplement.' },
          evidence: { type: 'string', description: 'file:line anchor actually read.' },
          tier: { type: 'string', enum: ['core', 'important', 'nice', 'anti-pattern'] },
        },
      },
    },
    reusable_code: { type: 'array', items: { type: 'string' }, description: 'Specific files/functions worth adapting directly (fork candidates), with path + what they do.' },
    anti_patterns: { type: 'array', items: { type: 'string' } },
    digest_path: { type: 'string' },
  },
}

const SOURCES = [
  { slug: 'r2-vercel-cli-surface', label: 'vercel:cli-surface',
    root: `${REF}/agent-browser`,
    focus: `The EXACT command surface. Read agent-browser.schema.json, cli/, bin/, README.md, docs/, AGENTS.md, examples/. Enumerate every subcommand + every flag + the JSON output shape of snapshot (the @eN / ref format), open/click/fill/type/press/select/get/eval/wait/network/screenshot/state/cookies/session. Extract global flags (--engine, --session, --state, --headers, --json). This is the PRIMARY command-surface source of truth — be exhaustive and verbatim.` },
  { slug: 'r2-vercel-arch-engine', label: 'vercel:arch+engine',
    root: `${REF}/agent-browser`,
    focus: `Architecture & actuation. Read packages/, the CDP driver, how it connects to Chrome-for-Testing vs lightpanda, the snapshot builder (a11y tree walk, ref assignment, interactive filter, offscreen/diff), the actuation (locator resolve from ref, auto-wait, actionability), and how a session daemon/persistence works. Extract the real snapshot-building + actuation algorithm and the process model (daemon? per-command?).` },
  { slug: 'r2-vercel-skill-evals', label: 'vercel:skill+evals+bench',
    root: `${REF}/agent-browser`,
    focus: `The SKILL + EVAL + BENCHMARK structure — this is how a shipped agent-browser packages itself and proves quality. Read skills/, skill-data/, evals/, benchmarks/. Extract: how their skill doc is written (what it tells the agent), how evals are structured (tasks, scoring, pass@k), what benchmarks they run (Mind2Web/WebVoyager?), and the exact eval harness shape we should adopt/beat.` },

  { slug: 'r2-browseruse-dom', label: 'browser-use:dom+serialize',
    root: `${REF}/browser-use`,
    focus: `The DOM/a11y serialization + indexed-element system. Find the dom service (grep for 'clickable', 'highlight_index', 'buildDomTree' / build_dom_tree, selector map). Extract how it builds the indexed interactive-element list the model sees, how indices map back to elements, viewport/visibility filtering, and the exact serialized format. Compare to the @eN ref approach.` },
  { slug: 'r2-browseruse-controller', label: 'browser-use:controller+agent',
    root: `${REF}/browser-use`,
    focus: `The action/controller registry + agent loop + safety. Find the Controller / action registry (grep 'registry', '@controller.action', 'ActionModel'), the Agent loop (message manager, memory, step), sensitive_data handling, structured/typed output, done-action, max-steps/failure handling. Extract the action-registry pattern, the loop shape, and the sensitive-data/allowlist safety mechanics.` },

  { slug: 'r2-stagehand-act-observe', label: 'stagehand:act+observe+a11y',
    root: `${REF}/stagehand`,
    focus: `act() + observe() + the accessibility tree. grep for 'observe', 'act', 'accessibility', 'a11y', 'buildBackendIdMaps', 'getAccessibilityTree'. Extract how observe returns candidate actions (selectors/xpath + method + args), how act performs them, the self-heal/retry, and the a11y-tree extraction (backend node id mapping). This grounds our snapshot+actuation.` },
  { slug: 'r2-stagehand-extract-cache', label: 'stagehand:extract+prompts+cache',
    root: `${REF}/stagehand`,
    focus: `extract() (structured, schema/zod-driven) + the ID-grounding that stops hallucinated values + the verbatim system prompts + action caching/self-heal. grep 'extract', 'zod', 'schema', 'prompt', 'cache'. Extract the extract contract (schema in -> grounded values out), the URL/ID grounding for links, and the exact prompt text for act/extract/observe (verbatim, we compared these in Round 1).` },
]

phase('MineCode')
const digests = await parallel(SOURCES.map((s) => () =>
  agent(
    `${TOOLS}\n\n${GOAL}\n\nSOURCE REPO: ${s.label}\nREPO ROOT: ${s.root}\n\nFOCUS: ${s.focus}\n\nTASK:\n1. Explore the repo (ls/find/grep) then Read the load-bearing files for your focus. Read real code, not just docs.\n2. Read the LICENSE file at the repo root and record it.\n3. Write a grounded digest to ${OUT}/${s.slug}.md — Killer Insight; Exact Command Surface / API (verbatim); Patterns (What/How-to-reimplement/Evidence file:line/Tier); Reusable code (fork candidates: path + purpose); Anti-patterns; License.\n4. Return the structured summary; digest_path = the file you wrote.\n\nQuality bar: verbatim signatures and formats with real file:line anchors. We will BUILD from this, so precision beats prose.`,
    { label: `mine:${s.slug}`, phase: 'MineCode', schema: SCHEMA, model: 'sonnet', effort: 'medium' }
  ).then((r) => ({ ...r, label: s.label })).catch(() => null)
))

const ok = digests.filter(Boolean)
log(`Round 2 mined ${ok.length}/${SOURCES.length} repos.`)
return {
  mined: ok.length,
  digests: ok.map((d) => ({ slug: d.source_slug, license: d.license, killer: d.killer_insight, path: d.digest_path })),
}
