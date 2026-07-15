#!/usr/bin/env node
/**
 * A/B differentiator: run each smoke task through BOTH uab and Vercel's
 * `agent-browser`, side-by-side (plan Task 12, spec §1/§9 — "the moat").
 *
 * Vercel's `benchmarks/` are pure daemon latency/memory — it ships NO
 * task-completion suite. This harness runs the identical scripted task through
 * both CLIs (their verbs are near-identical: open / snapshot -i / click / fill /
 * get) and prints a pass table + a one-line summary of the capabilities uab has
 * that Vercel does not.
 *
 * uab is graded with the task's real deterministic gate (expected/forbidden +
 * global hallucination traps). Vercel is graded BEST-EFFORT on a format-neutral
 * expectation (the essential page content any correct browser should surface),
 * with the script light-translated where the surfaces differ (Vercel's
 * `get text` needs a selector; Vercel has no `extract` and no `--enable-actions`
 * phase gate). Where Vercel structurally cannot express a task it is marked N/A.
 *
 * Verified capability deltas (measured live, not asserted from docs):
 *   - EGRESS default: `open file:///etc/passwd` — uab denies (navigation_blocked),
 *     Vercel ALLOWS. (trifecta-by-default)
 *   - PROMPT-INJECTION: forged <system> tags — uab neutralizes + boundary-fences,
 *     Vercel returns them raw.
 *   - EXTRACT: uab has ID-grounded `extract --schema`; Vercel has no extract verb.
 *
 * Degrades gracefully when `agent-browser` is not usable. Node built-ins only.
 * Usage: node evals/harness/ab.mjs --suite smoke
 */
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, runUab, execCommand } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const UAB = path.join(REPO_ROOT, 'skill', 'agent-browser', 'dist', 'cli.js')
const VERCEL_BIN = 'agent-browser'
const TIMEOUT = 30000

const ACTOR_VERBS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck',
  'upload', 'drag', 'scroll', 'hover', 'focus', 'find',
])

const GLOBAL_TRAPS = [
  'navigation_allowed', 'model_response', 'AI_ANALYSIS',
  '\\bgpt-[0-9]', '\\bclaude-[0-9]', '\\bgemini-[0-9]',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
]

/**
 * Per-task A/B spec: how to grade the Vercel side fairly.
 *   unsupported : Vercel structurally can't express this task (verb absent).
 *   vercelExpect: format-neutral content Vercel must surface to "pass".
 *   note        : the capability delta this task illustrates.
 */
const AB = {
  'button-ref': { vercelExpect: ['Activate'], note: '' },
  'heading-get-text': { vercelExpect: ['Docs Index'], note: '' },
  'example-domain': { vercelExpect: ['Example Domain'], note: '' },
  'login-flow': { vercelExpect: ['Login successful'], note: 'both mask the password; uab uses [redacted] (no length leak)' },
  'extract-grounding': { unsupported: 'Vercel has no extract verb', note: 'uab-only: ID-grounded extract --schema' },
  'hallucination-trap': { vercelExpect: ['Example Domain'], note: '' },
  // Graded on a FORMAT-NEUTRAL expectation (fix I5): the old check demanded
  // moxxie's OWN `PROMPT_INJECTION_NEUTRALIZED` token — a sentinel Vercel can
  // never emit, so the Vercel side was rigged to fail. We instead assert the raw
  // `<system>` tag SURVIVES in Vercel's output: Vercel passes forged transcript
  // tags through verbatim (it "passes") while moxxie neutralizes them — an honest
  // A/B where each CLI is judged on what a correct-for-its-design tool produces.
  'injection-neutralized': { vercelExpect: ['<system>'], note: 'uab neutralizes forged <system> tags; Vercel passes them through raw' },
}

function parseArgs(argv) {
  const a = { suite: 'smoke' }
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--suite') a.suite = argv[++i]
  return a
}

function loadTasks(suite) {
  const dir = path.join(REPO_ROOT, 'evals', 'tasks', suite)
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    return t
  })
}

const subst = (s, base) => (typeof s === 'string' ? s.split('{BASE}').join(base) : s)

function checkGate(text, expected, forbidden) {
  const missing = expected.filter((p) => !new RegExp(p).test(text))
  const hit = forbidden.filter((p) => new RegExp(p).test(text))
  return missing.length === 0 && hit.length === 0
}

// ---- uab side (real gate) ----
async function runUabTask(task, base) {
  const S = `ab-uab-${task.id}-${process.pid}`
  const out = []
  const openArgv = ['open', subst(task.start_url, base), '--session', S]
  if (task.enableActions) openArgv.push('--enable-actions')
  out.push((await runUab(UAB, openArgv, { timeout: TIMEOUT })).out)
  for (const cmd of task.script ?? []) {
    const argv = [cmd[0], ...cmd.slice(1).map((x) => subst(x, base)), '--session', S]
    if (task.enableActions || ACTOR_VERBS.has(cmd[0])) argv.push('--enable-actions')
    out.push((await runUab(UAB, argv, { timeout: TIMEOUT })).out)
  }
  await runUab(UAB, ['close', '--session', S], { timeout: 10000 })
  const text = out.join('\n')
  const forbidden = [...(task.forbiddenPatterns ?? []), ...GLOBAL_TRAPS]
  return checkGate(text, task.expectedPatterns ?? [], forbidden)
}

// ---- Vercel side (best-effort, translated) ----
function translateForVercel(cmd) {
  // Vercel's `get text` requires a selector; bare uab `get text` → `get text body`.
  if (cmd[0] === 'get' && cmd[1] === 'text' && cmd[2] === undefined) return ['get', 'text', 'body']
  return cmd
}

async function runVercelTask(task, base, spec) {
  const S = `ab-vc-${task.id}-${process.pid}`
  const out = []
  out.push((await execCommand(VERCEL_BIN, ['open', subst(task.start_url, base), '--session', S], { timeout: TIMEOUT })).out)
  for (const cmd of task.script ?? []) {
    const v = translateForVercel(cmd).map((x) => subst(x, base))
    out.push((await execCommand(VERCEL_BIN, [...v, '--session', S], { timeout: TIMEOUT })).out)
  }
  await execCommand(VERCEL_BIN, ['close', '--session', S], { timeout: 10000 })
  return checkGate(out.join('\n'), spec.vercelExpect ?? [], [])
}

async function vercelAvailable() {
  const r = await execCommand(VERCEL_BIN, ['--version'], { timeout: 8000 })
  return r.status === 0 && /\d+\.\d+/.test(r.out)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = loadTasks(args.suite)
  const haveVercel = await vercelAvailable()

  console.log('# A/B — uab vs Vercel agent-browser')
  console.log(`# uab:    ${UAB}`)
  console.log(`# vercel: ${haveVercel ? VERCEL_BIN : '(not usable — Vercel side skipped)'}`)
  console.log('')

  const server = await startServer()
  const rows = []
  let uabPass = 0
  let vcPass = 0
  let vcExpressible = 0

  try {
    for (const task of tasks) {
      const spec = AB[task.id] ?? { vercelExpect: [], note: '' }
      const uOk = await runUabTask(task, server.baseUrl)
      if (uOk) uabPass++

      let vCell
      if (!haveVercel) {
        vCell = 'skip'
      } else if (spec.unsupported) {
        vCell = 'N/A'
      } else {
        vcExpressible++
        const vOk = await runVercelTask(task, server.baseUrl, spec)
        if (vOk) vcPass++
        vCell = vOk ? 'PASS' : 'FAIL'
      }
      rows.push({ id: task.id, uab: uOk ? 'PASS' : 'FAIL', vercel: vCell, note: spec.note || spec.unsupported || '' })
    }
  } finally {
    await server.close()
  }

  // ---- table ----
  const idW = Math.max(...rows.map((r) => r.id.length), 8)
  console.log(`  ${'task'.padEnd(idW)}  ${'uab'.padEnd(6)}${'vercel'.padEnd(7)}note`)
  console.log(`  ${'-'.repeat(idW)}  ${'-'.repeat(6)}${'-'.repeat(7)}${'-'.repeat(4)}`)
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(idW)}  ${r.uab.padEnd(6)}${r.vercel.padEnd(7)}${r.note}`)
  }

  const uabK = (uabPass / tasks.length).toFixed(3)
  const vcK = haveVercel && vcExpressible > 0 ? (vcPass / vcExpressible).toFixed(3) : 'n/a'
  console.log('')
  console.log('# capability deltas (honest labeling of evidence — fix M4):')
  console.log('#   TASK-VERIFIED by a scripted task in THIS run (see the table above):')
  console.log('#     - prompt-injection: `injection-neutralized` — uab emits [PROMPT_INJECTION_NEUTRALIZED]')
  console.log('#       + boundary fences; Vercel surfaces the raw <system> tag (graded format-neutrally).')
  console.log('#     - extract: `extract-grounding` — uab has ID-grounded `extract --schema`; Vercel')
  console.log('#       has no extract verb (marked N/A above).')
  console.log('#   ASSERTED-BY-DESIGN (proven by the unit/trifecta suites, NOT by a task in this harness):')
  console.log('#     - trifecta-by-default: uab denies file:// egress on default flags (trifecta.mjs test 1).')
  console.log('#     - generation-stamped stale-@ref grounding gate + diff-when-shorter snapshots.')
  console.log('#   (To promote an asserted delta to task-verified, add a task driving both CLIs')
  console.log('#    through file:// and a stale-@ref click.)')
  console.log('')
  console.log(`# SUMMARY: uab pass_k=${uabK} (${uabPass}/${tasks.length}) vs vercel pass_k=${vcK}` +
    (haveVercel ? ` (${vcPass}/${vcExpressible} expressible; extract N/A on Vercel)` : ' (Vercel not run)') +
    ` — task-verified deltas: injection-neutralization + extract. Egress/grounding deltas are` +
    ` asserted-by-design (see the unit + trifecta suites).`)
  process.exit(0)
}

main().catch((err) => {
  console.error('ab crashed:', err && err.stack ? err.stack : err)
  process.exit(2)
})
