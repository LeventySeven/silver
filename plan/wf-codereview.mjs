export const meta = {
  name: 'moxxie-code-review',
  description: 'High-depth code review of the shipped moxxie CLI: parallel lenses -> adversarial verify each finding against real code -> confirmed, confidence-gated findings only.',
  phases: [
    { title: 'Review', detail: 'independent lenses read src/ + evals -> candidate findings with file:line + confidence' },
    { title: 'Verify', detail: 'adversarially verify each candidate against the actual code; drop <80 confidence / not-real' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const SRC = `${REPO}/silver/src`
const EV = `${REPO}/evals`

const TOOLS = `You have FULL tool access (Read, Grep, Glob, Bash). READ the actual code — every finding must cite a real file:line you read. Do not report a finding you have not verified against the source.`
const CTX = `TARGET: "moxxie" — a keyless Node/TS browser CLI on Playwright (${SRC}) + its eval harness (${EV}). It is green: 130 tests, eval pass_k 1.000, trifecta 3/3. Invariants that MUST hold: (1) 100% KEYLESS — no model/provider call anywhere in src/; (2) no filesystem path or secret substring in any error/warning string; (3) every ref-taking command passes the generation-stamped grounding gate; (4) page-derived output is neutralized+capped (untrusted); (5) actor verbs gated behind --enable-actions (phase quarantine); (6) egress denylist (file:/data:/blob: denied, suffix-match host allowlist); (7) extract is host-delegated (CLI never infers).`

const RULES = `REPORT ONLY high-confidence, REAL, correctness/security/contract issues in the SHIPPED code. NOT findings: nitpicks, style, "more tests/docs", anything a typechecker/linter catches, pre-existing non-issues, or a deliberate documented design choice (e.g. eN refs instead of fNeM is intentional; confirm-gate fail-open-on-TTY is deliberate). "Nothing to report" is a valid, respected outcome — do not manufacture nits. Score each finding 0-100 confidence; only include >=80.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'confidence', 'file', 'line', 'issue', 'why', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] },
          confidence: { type: 'integer' },
          file: { type: 'string' }, line: { type: 'integer' },
          issue: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
  },
}

const LENSES = [
  { slug: 'correctness', focus: `Correctness bugs across the ENLARGED Silver: logic errors, edge cases, null/undefined, async RACES (the per-session lockfile in core/lock.ts — stale-takeover/token-release correctness; the session sidecar + tabs.json + task action_log concurrent writes; refmap save/load across CDP reconnects), resource leaks (CDP sessions, detached browser processes, stamped data-silver-ref attributes, the capture.ts init-script / network ring buffer, tab targetId registry drift), swallowed errors. Read all of ${SRC}: core/ (session,lock,tabs,capture,handlers,flags,state-crypto), perception/, actuation/, security/, extract/, task/, orchestration/, memory/, mcp/.` },
  { slug: 'security-keyless', focus: `Security + the KEYLESS invariant across the NEW surface. Grep ALL of ${SRC} (incl mcp/, task/, subagent, memory/) for any model/provider call or egress beyond localhost/CDP/the guarded fetch (KEYLESS must hold — mcp is a transport, verify it calls no model). Try to BREAK each gate on the NEW verbs: does eval/wait --fn/mouse/keyboard/network route require --enable-actions (phase-quarantine via registry)? Does the confirm gate still fire for paid/destructive on the find/mouse/keyboard paths? Is page-derived output from console/errors/network/eval routed through neutralize+cap (⟦⟧-glyph + forged-tag safe)? Do task exec / subagent spawn re-apply the full gate chain (not a bypass)? Path containment on pdf/task/screenshots? Does the MCP path preserve quarantine? DNS-SSRF still enforced? Known seed: SKILL agent reported the fill verb echoes the value un-redacted, and --password-stdin / --incognito are parsed-but-dead; the crypto agent reported silver-state.json (content-bearing: prevTree + valueMap) is NOT encrypted. Verify each against code; report real holes only.` },
  { slug: 'contracts', focus: `Cross-module contract consistency across the enlarged graph: cli.ts (META_VERBS + LAYER_VERBS dispatch, the mcp branch) -> handlers.ts / task / subagent / memory. Verify: the snapshot->serialize->refmap->resolve chain (generation stamping, eN-with-real-frameId, backendNodeId resolution across reconnects, tab-switch refmap invalidation); every verb operates on the ACTIVE tab (resolveActivePage) + active frame consistently; the state-crypto migration (plaintext-legacy vs encrypted magic) round-trips for ALL sidecar readers (session.json/refmap.json/tabs.json/task/subagent status); the {success,data,error,warning} envelope honored on the new verbs + the MCP tool results; flags.ts recognizes every new flag (unknown-flag-drop bug). Report real contract breaks.` },
  { slug: 'simplification', focus: `Dead code + HONESTY gaps in the enlarged product. Verbs in ACTOR_VERBS/READ_ONLY_VERBS with NO handler that fall to notImplemented (seed: download/set/keydown/keyup) — does SKILL.md honestly mark them? Parsed-but-unused flags (seed: --password-stdin, --incognito). Redundant/unused exports across the new modules. Any code claiming to do something it doesn't (e.g. task checkpoint screenshot, HAR fidelity, network capture gaps). Prefer deletions. Report real dead-code/honesty issues, not taste.` },
  { slug: 'eval-integrity', focus: `Eval integrity for the enlarged surface. Read ${EV}/harness/*.mjs + tasks/*.json. Are expected/forbidden patterns REAL (not trivially satisfiable)? Trifecta genuinely on DEFAULT flags? pass_k = task-completion not "didn't crash"? Any assertion weakened to go green? Do the NEW capabilities (tab/parallel, task, subagent, memory, network, eval-gated) have ANY eval coverage, or are they only unit-tested (a gap worth flagging)? Is the A/B honest? Report real eval-integrity problems.` },
]

phase('Review')
const reviews = await parallel(LENSES.map((l) => () =>
  agent(
    `${TOOLS}\n\n${CTX}\n\nLENS: ${l.slug}\nFOCUS: ${l.focus}\n\n${RULES}\n\nReturn your findings (each with severity, confidence>=80, real file:line, one-sentence issue/why/fix). If the code is clean for your lens, return an empty findings array — that is a respected outcome.`,
    { label: `review:${l.slug}`, phase: 'Review', schema: SCHEMA, model: 'sonnet', effort: 'high' }
  ).then((r) => ({ ...r, lens: l.slug })).catch(() => null)
))
const candidates = reviews.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => ({ ...f, lens: r.lens })))
log(`Review lenses produced ${candidates.length} candidate findings.`)

phase('Verify')
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'confidence', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED'] },
    confidence: { type: 'integer' },
    reasoning: { type: 'string' },
    corrected_severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] },
  },
}
const verified = await parallel(candidates.map((f) => () =>
  agent(
    `${TOOLS}\n\n${CTX}\n\nAdversarially VERIFY this code-review finding against the ACTUAL code. Open the cited file, read the surrounding logic and its callers/callees, and decide: is it a REAL, currently-live bug/hole in the shipped moxxie code (CONFIRMED), or a false positive / non-issue / already-handled / deliberate design (REFUTED)? Default to REFUTED if uncertain.\n\nFINDING [${f.severity}, ${f.lens}] ${f.file}:${f.line}\n  issue: ${f.issue}\n  why: ${f.why}\n  fix: ${f.fix}\n\nReturn a verdict with your own confidence + one-paragraph reasoning citing the real code. Give corrected_severity if the severity is wrong.`,
    { label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT, effort: 'high' }
  ).then((v) => ({ ...f, ...v })).catch(() => null)
))
const confirmed = verified.filter(Boolean).filter((v) => v.verdict === 'CONFIRMED' && v.confidence >= 80)
  .sort((a, b) => ({ Critical: 0, Important: 1, Minor: 2 }[a.corrected_severity || a.severity] - { Critical: 0, Important: 1, Minor: 2 }[b.corrected_severity || b.severity]))
log(`Confirmed ${confirmed.length}/${candidates.length} findings after adversarial verification.`)

return {
  candidates: candidates.length,
  confirmed: confirmed.length,
  findings: confirmed.map((f) => ({ severity: f.corrected_severity || f.severity, lens: f.lens, file: f.file, line: f.line, issue: f.issue, why: f.why, fix: f.fix, reasoning: f.reasoning })),
}
