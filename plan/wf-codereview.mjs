export const meta = {
  name: 'moxxie-code-review',
  description: 'High-depth code review of the shipped moxxie CLI: parallel lenses -> adversarial verify each finding against real code -> confirmed, confidence-gated findings only.',
  phases: [
    { title: 'Review', detail: 'independent lenses read src/ + evals -> candidate findings with file:line + confidence' },
    { title: 'Verify', detail: 'adversarially verify each candidate against the actual code; drop <80 confidence / not-real' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/moxxie'
const SRC = `${REPO}/skill/agent-browser/src`
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
  { slug: 'correctness', focus: `Correctness bugs in the SHIPPED code: logic errors, unhandled edge cases, off-by-one, null/undefined deref, async races (esp. the session sidecar read/write, dialog sidecar, refmap save/load across CDP reconnects), resource leaks (CDP sessions, browser processes, stamped data-moxxie-ref attributes not cleaned), swallowed errors that hide failure. Read all of ${SRC} (core/, perception/, actuation/, security/, extract/).` },
  { slug: 'security-keyless', focus: `Security + the keyless invariant. Grep ALL of ${SRC} for any model/provider call or network egress beyond localhost/CDP + the guarded read fetch (KEYLESS must hold). Verify: no path/secret leaks into error/warning strings; the egress denylist can't be bypassed (substring vs suffix, IP-literal evasions, redirect SSRF); redaction can't be bypassed (get value/attr, snapshot names, extract output); the injection neutralizer can't be escaped (forged tags AND the ⟦⟧ boundary glyphs); phase-quarantine actually prevents actor verbs without --enable-actions (registry is the enforcement, not the prompt); wait --fn / eval are gated; confirm gate runs post-grounding. Try to BREAK each gate; report only real holes.` },
  { slug: 'contracts', focus: `Cross-module contract consistency. Trace the real call graph: cli.ts -> handlers.ts -> {session, walk, serialize, refmap, resolve, actions, wait, pagechange, extract, security}. Verify the snapshot->serialize->refmap->resolve chain is coherent (generation stamping, the eN-with-real-frameId model post-iframe, backendNodeId resolution across reconnects), the {success,data,error,warning} envelope shape is honored everywhere, and no signature/return-shape drift between a producer and its consumers (e.g. snapshotNodes throwing SelectorScopeError -> does every caller handle it?). Report real contract breaks, not naming preferences.` },
  { slug: 'simplification', focus: `Dead code, over-engineering, and HONESTY gaps. Unused exports/branches; verbs in the registry (ACTOR_VERBS/READ_ONLY_VERBS) that have NO handler case and silently fall to notImplemented (keyboard/mouse/keydown/keyup/eval/download/set/tab/frame/network/pdf) — is the SKILL.md honest that these aren't usable? Any place the code claims to do something it doesn't. Prefer deletions over additions. Report only real dead-code/honesty issues, not taste.` },
  { slug: 'eval-integrity', focus: `Eval integrity. Read ${EV}/harness/*.mjs + tasks/*.json. Are the expected/forbidden patterns REAL tests (not trivially satisfiable / not hardcoded to pass)? Does the trifecta suite genuinely run on DEFAULT flags? Does pass_k mean task-completion or just "the command didn't crash"? Is any assertion weakened to go green? Is the A/B vs Vercel honest? Report only real eval-integrity problems (a green eval that doesn't actually prove the capability is a Critical finding).` },
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
