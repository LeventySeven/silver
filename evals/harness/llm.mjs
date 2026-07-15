#!/usr/bin/env node
/**
 * OPTIONAL LLM-in-the-loop suite (plan Task 12, spec §9). Drives uab through a
 * REAL host brain — the `claude` CLI (Claude Code) — instead of a fixed script,
 * to exercise the actual product surface an agent drives. Graded by the same
 * deterministic expected/forbidden gate on the model's final answer.
 *
 * This is an OPTIONAL layer: it must DEGRADE GRACEFULLY. If `claude` is not
 * runnable, or a run times out / errors, it prints "LLM suite skipped: <reason>"
 * and exits 0 — it NEVER gates the build (run.mjs + trifecta.mjs are the gate).
 *
 * Usage:
 *   node evals/harness/llm.mjs [--tasks id,id] [--timeout 180000] [--dry]
 *   --dry  prints the prompts it WOULD send, without invoking claude (safe smoke).
 *
 * Node built-ins only.
 */
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, execCommand, runUab } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const UAB = path.join(REPO_ROOT, 'silver', 'dist', 'cli.js')

/** Default: two cheap read-only tasks that don't need --enable-actions. */
const DEFAULT_TASKS = ['example-domain', 'button-ref']

function parseArgs(argv) {
  const a = { tasks: DEFAULT_TASKS, timeout: 180000, dry: false }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--tasks') a.tasks = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else if (t === '--timeout') a.timeout = Number(argv[++i])
    else if (t === '--dry') a.dry = true
  }
  return a
}

function loadTask(id) {
  const dir = path.join(REPO_ROOT, 'evals', 'tasks', 'smoke')
  const file = readdirSync(dir).find((f) => {
    try { return JSON.parse(readFileSync(path.join(dir, f), 'utf8')).id === id } catch { return false }
  })
  if (!file) return null
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
}

const subst = (s, base) => (typeof s === 'string' ? s.split('{BASE}').join(base) : s)

function buildPrompt(task, base, session) {
  const url = subst(task.start_url, base)
  return [
    `You are driving a headless browser to complete a task. Do NOT guess — observe the page first.`,
    ``,
    `TASK: ${task.task}`,
    ``,
    `TOOL: the uab CLI. Run commands with Bash like:`,
    `  node ${UAB} open ${url} --session ${session}`,
    `  node ${UAB} snapshot -i --session ${session}`,
    `  node ${UAB} get text @eN --session ${session}   # read an element by its @ref`,
    `Refs like @e1 come from the snapshot. Open the URL, take an interactive`,
    `snapshot, then read what you need by @ref.`,
    ``,
    `When done, state the final answer in one short sentence. Be factual; quote`,
    `text you actually observed in the snapshot — never invent content.`,
  ].join('\n')
}

async function claudeAvailable() {
  const r = await execCommand('claude', ['--version'], { timeout: 8000 })
  return r.status === 0
}

function grade(text, expected, forbidden) {
  const missing = (expected ?? []).filter((p) => !new RegExp(p).test(text))
  const hit = (forbidden ?? []).filter((p) => new RegExp(p).test(text))
  return { pass: missing.length === 0 && hit.length === 0, missing, hit }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log('# uab LLM-in-the-loop suite (optional; host brain = claude CLI)')

  const tasks = args.tasks.map(loadTask).filter(Boolean)
  if (tasks.length === 0) {
    console.log('LLM suite skipped: no matching tasks')
    process.exit(0)
  }

  if (!args.dry) {
    const ok = await claudeAvailable()
    if (!ok) {
      console.log('LLM suite skipped: `claude` CLI not runnable in this environment')
      process.exit(0)
    }
  }

  const server = await startServer()
  let ran = 0
  let passed = 0
  try {
    for (const task of tasks) {
      const session = `llm-${task.id}-${process.pid}`
      const prompt = buildPrompt(task, server.baseUrl, session)

      if (args.dry) {
        console.log(`\n--- [dry] prompt for ${task.id} ---\n${prompt}\n`)
        continue
      }

      console.log(`\n[run] ${task.id} — invoking claude (timeout ${args.timeout}ms)...`)
      const r = await execCommand('claude', ['-p', prompt, '--allowedTools', 'Bash'], { timeout: args.timeout })
      await runUab(UAB, ['close', '--session', session], { timeout: 10000 })

      if (r.timedOut) {
        console.log(`  [skip] ${task.id}: claude timed out (optional layer — not a gate failure)`)
        continue
      }
      if (r.status !== 0 && !r.out.trim()) {
        console.log(`  [skip] ${task.id}: claude exited ${r.status} with no output (optional layer)`)
        continue
      }
      ran++
      const g = grade(r.out, task.expectedPatterns, [...(task.forbiddenPatterns ?? [])])
      if (g.pass) passed++
      console.log(`  ${g.pass ? 'PASS' : 'FAIL'} ${task.id}` +
        (g.pass ? '' : `  missing=[${g.missing.join(', ')}] hit=[${g.hit.join(', ')}]`))
      console.log(`  claude final (last 200 chars): ${r.out.trim().slice(-200).replace(/\n/g, ' ')}`)
    }
  } finally {
    await server.close()
  }

  if (args.dry) {
    console.log('\n# dry run complete (no model invoked)')
  } else if (ran === 0) {
    console.log('\nLLM suite skipped: no task produced a gradeable model result (degraded gracefully)')
  } else {
    console.log(`\n# LLM suite: ${passed}/${ran} passed (advisory; run.mjs + trifecta.mjs are the gate)`)
  }
  process.exit(0)
}

main().catch((err) => {
  // Even a crash must not gate — report and exit 0.
  console.log('LLM suite skipped: harness error —', err && err.message ? err.message : err)
  process.exit(0)
})
