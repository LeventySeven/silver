#!/usr/bin/env node
/**
 * Deterministic scripted-host eval runner + pass_k (plan Task 12, spec §9 P0).
 *
 * THE GATE. No model in the loop: a fixed `script` of uab argv arrays is driven
 * against ONE shared `--session` per (task,run) so page state persists across
 * commands (browser-as-daemon). We accumulate every command's stdout, then apply
 * the ground-truth regex gate:
 *
 *   PASS  iff  every expectedPattern matches the accumulated output
 *         AND  no forbiddenPattern (task-specific ∪ global hallucination traps)
 *              matches it.
 *
 * `pass_k` = fraction of (task,run) pairs that passed. Deterministic scripts must
 * give pass_k = 1.0; the harness EXITS NON-ZERO when pass_k < THRESHOLD (0.8).
 *
 * The LLM-in-the-loop suite and cross-family judge are OPTIONAL layers: `--judge`
 * logs a non-flipping secondary verdict (degrades to "skipped" with no key). The
 * regex gate is always the ground truth.
 *
 * Fixtures are served over http on localhost (uab denies file:/data: and raw-IP;
 * see server.mjs). `{BASE}` in a task's start_url/script is replaced with the
 * live server base URL.
 *
 * Node built-ins only. Usage:
 *   node evals/harness/run.mjs --suite smoke --k 3 [--timeout 30000] [--judge]
 */
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, runUab } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const DEFAULT_UAB = path.join(REPO_ROOT, 'silver', 'dist', 'cli.js')

/** Actor verbs (mirrors src/security/registry.ts ACTOR_VERBS): these need
 * --enable-actions to be dispatchable. We add the flag automatically. */
const ACTOR_VERBS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'keyboard',
  'select', 'check', 'uncheck', 'upload', 'download', 'drag', 'scroll',
  'scrollintoview', 'hover', 'focus', 'eval', 'find', 'set', 'mouse', 'dialog',
])

/**
 * Global hallucination traps injected into EVERY task's forbidden set. These are
 * uab-invented-output / model-leakage tokens that must never appear in the
 * keyless CLI's output. (Task-specific forbidden patterns are added on top.)
 */
const GLOBAL_TRAPS = [
  'navigation_allowed',      // only navigation_blocked is a real status
  'model_response',
  'AI_ANALYSIS',
  '\\bgpt-[0-9]',
  '\\bclaude-[0-9]',
  '\\bgemini-[0-9]',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
]

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { suite: 'smoke', k: 3, timeout: 30000, uab: DEFAULT_UAB, judge: false }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--suite') a.suite = argv[++i]
    else if (t === '--k') a.k = Number(argv[++i])
    else if (t === '--timeout') a.timeout = Number(argv[++i])
    else if (t === '--uab') a.uab = path.resolve(argv[++i])
    else if (t === '--judge') a.judge = true
  }
  if (!Number.isFinite(a.k) || a.k < 1) a.k = 3
  return a
}

// ---------------------------------------------------------------------------
// task loading
// ---------------------------------------------------------------------------

function loadTasks(suite) {
  const dir = path.join(REPO_ROOT, 'evals', 'tasks', suite)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.map((f) => {
    const task = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    task._file = f
    return task
  })
}

/** Replace {BASE} in a string with the live server base url. */
function subst(s, base) {
  return typeof s === 'string' ? s.split('{BASE}').join(base) : s
}

// ---------------------------------------------------------------------------
// running one command
// ---------------------------------------------------------------------------

function buildArgv(cmd, session, base, taskEnableActions) {
  const verb = cmd[0]
  const rest = cmd.slice(1).map((x) => subst(x, base))
  const argv = [verb, ...rest, '--session', session]
  if (taskEnableActions || ACTOR_VERBS.has(verb)) argv.push('--enable-actions')
  return argv
}

/** Run one uab command; returns { argv, out } (stdout+stderr, or a timeout note). */
async function runCmd(uab, argv, timeout) {
  const r = await runUab(uab, argv, { timeout })
  return { argv, out: r.out }
}

// ---------------------------------------------------------------------------
// pattern matching
// ---------------------------------------------------------------------------

function compile(patterns) {
  return patterns.map((p) => {
    try {
      return { src: p, re: new RegExp(p) }
    } catch (e) {
      throw new Error(`invalid regex in task: ${JSON.stringify(p)} (${e.message})`)
    }
  })
}

function checkGate(text, expected, forbidden) {
  const missingExpected = compile(expected).filter((c) => !c.re.test(text)).map((c) => c.src)
  const hitForbidden = compile(forbidden).filter((c) => c.re.test(text)).map((c) => c.src)
  return { pass: missingExpected.length === 0 && hitForbidden.length === 0, missingExpected, hitForbidden }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = loadTasks(args.suite)
  if (tasks.length === 0) {
    console.error(`no tasks found in suite "${args.suite}"`)
    process.exit(2)
  }

  // Optional judge (non-flipping). Import lazily so a broken/absent judge never
  // affects the deterministic gate.
  let judgeFn = null
  if (args.judge) {
    try {
      ;({ judge: judgeFn } = await import('./judge.mjs'))
    } catch {
      judgeFn = null
    }
  }

  const server = await startServer()
  const base = server.baseUrl
  const createdSessions = []

  console.log(`# uab eval harness — suite=${args.suite} k=${args.k}`)
  console.log(`# uab binary: ${args.uab}`)
  console.log(`# fixtures:   ${base}`)
  console.log('')

  let totalPairs = 0
  let passedPairs = 0
  const rows = []

  try {
    for (const task of tasks) {
      const expected = task.expectedPatterns ?? []
      const forbidden = [...(task.forbiddenPatterns ?? []), ...GLOBAL_TRAPS]
      let taskPass = 0

      for (let run = 0; run < args.k; run++) {
        const session = `eval-${task.id}-${run}-${process.pid}`
        createdSessions.push(session)

        const startUrl = subst(task.start_url, base)
        const transcript = []
        // 1. open the start url first (shared session, persists across commands).
        const openArgv = ['open', startUrl, '--session', session]
        if (task.enableActions) openArgv.push('--enable-actions')
        transcript.push(await runCmd(args.uab, openArgv, args.timeout))
        // 2. run the scripted commands.
        for (const cmd of task.script ?? []) {
          transcript.push(await runCmd(args.uab, buildArgv(cmd, session, base, task.enableActions), args.timeout))
        }

        const accumulated = transcript.map((t) => t.out).join('\n')
        const gate = checkGate(accumulated, expected, forbidden)
        totalPairs++
        if (gate.pass) {
          passedPairs++
          taskPass++
        } else {
          console.log(`  [FAIL] ${task.id} run ${run + 1}`)
          if (gate.missingExpected.length)
            console.log(`         missing expected: ${gate.missingExpected.join(' | ')}`)
          if (gate.hitForbidden.length)
            console.log(`         hit forbidden:    ${gate.hitForbidden.join(' | ')}`)
        }

        // Optional non-flipping judge (logged only).
        if (judgeFn) {
          try {
            const verdict = await judgeFn({ task, transcript, deterministicPass: gate.pass })
            if (verdict) {
              console.log(`         judge(${task.id} r${run + 1}): verdict=${verdict.verdict} ` +
                `${verdict.failure_reason ? '(' + verdict.failure_reason + ')' : ''} [advisory, non-flipping]`)
            }
          } catch { /* judge is best-effort; never affects the gate */ }
        }

        // Fresh state between runs.
        await runCmd(args.uab, ['close', '--session', session], args.timeout)
      }

      rows.push({ id: task.id, pass: taskPass, k: args.k })
    }
  } finally {
    // Cleanup: close every eval session and stop the fixture server.
    for (const s of [...new Set(createdSessions)]) {
      await runCmd(args.uab, ['close', '--session', s], 10000)
    }
    await server.close()
  }

  // ---- report ----
  console.log('')
  console.log('# per-task results')
  const idW = Math.max(...rows.map((r) => r.id.length), 8)
  for (const r of rows) {
    const frac = r.pass / r.k
    const mark = frac >= 0.8 ? 'PASS' : 'FAIL'
    console.log(`  ${r.id.padEnd(idW)}  ${r.pass}/${r.k}  ${(frac * 100).toFixed(0).padStart(3)}%  ${mark}`)
  }
  const passK = totalPairs === 0 ? 0 : passedPairs / totalPairs
  console.log('')
  console.log(`# overall pass_k = ${passK.toFixed(3)}  (${passedPairs}/${totalPairs} task-run pairs passed)`)
  const THRESHOLD = 0.8
  if (passK < THRESHOLD) {
    console.log(`# GATE FAIL: pass_k ${passK.toFixed(3)} < ${THRESHOLD}`)
    process.exit(1)
  }
  console.log(`# GATE PASS: pass_k ${passK.toFixed(3)} >= ${THRESHOLD}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('runner crashed:', err && err.stack ? err.stack : err)
  process.exit(2)
})
