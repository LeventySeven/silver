/**
 * `silver task …` — the long-running task-artifact verb (Webwright, keyless).
 *
 * Subcommands:
 *   task start <goal> [--id <id>]      create a new run folder (plan + log + shots)
 *   task log <id> <event-json>         append an event to the latest action_log
 *   task checkpoint <id> [--note t]    snapshot progress + a best-effort screenshot
 *   task status <id>                   plan progress + latest checkpoint
 *   task list                          all tasks in the namespace
 *   task resume <id>                   latest checkpoint + remaining plan + log tail
 *   task exec <id> -- <silver-cmd...>  run a silver command AND auto-log it
 *
 * `task exec`/`task start`-style writers require --enable-actions for `exec`
 * only (it re-dispatches an arbitrary command); everything else is read-only.
 * The dispatch VERB `task` is read-only in the registry; the actor sub-gate for
 * `exec` lives here (mirrors how `wait --fn` is gated inside its handler).
 *
 * KEYLESS: no model call anywhere — the host is the brain; this writes scaffold.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { ok, fail, type Envelope } from '../core/envelope.js'
import type { ParsedFlags } from '../core/flags.js'
import { sanitizeSegment } from '../core/nsdirs.js'
import { neutralize, capOutput } from '../security/injection.js'
import { withSessionLock } from '../core/lock.js'
import { connect } from '../core/session.js'
import {
  startRun,
  appendLog,
  readLog,
  loadCheckpoint,
  saveCheckpoint,
  readPlan,
  parsePlan,
  latestRun,
  listRuns,
  listTaskIds,
  taskExists,
  runDirPath,
  bound,
  type Checkpoint,
} from './store.js'

/** A clean, non-leaking bad-request envelope (static message only). */
function badRequest(message: string): Envelope<never> {
  return { success: false, data: null, error: message }
}

/** Pass any potentially page-derived text back through the injection scrub. */
function present(text: string): string {
  return neutralize(capOutput(String(text ?? ''), 4_000))
}

/** Resolve + validate a task id positional (index `pos` in args). */
function idAt(flags: ParsedFlags, pos: number): string | null {
  return sanitizeSegment(flags.id ?? flags.args[pos])
}

export async function handleTask(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  switch (sub) {
    case 'start':
      return taskStart(flags)
    case 'log':
      return taskLog(flags)
    case 'checkpoint':
      return taskCheckpoint(flags)
    case 'status':
      return taskStatus(flags)
    case undefined:
    case 'list':
      return taskList()
    case 'resume':
      return taskResume(flags)
    case 'exec':
      return taskExec(flags)
    default:
      return badRequest('usage: silver task start|log|checkpoint|status|list|resume|exec')
  }
}

async function taskStart(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const goal = flags.args.slice(1).join(' ').trim()
  if (!goal) return badRequest('usage: silver task start <goal> [--id <id>]')
  // Deterministic id from --id, else a slug of the goal + a short disambiguator.
  const raw = flags.id ?? slugId(goal)
  const id = sanitizeSegment(raw)
  if (!id) return badRequest('invalid task id; use letters, digits, . _ - only')

  const started = await startRun(id, goal)
  return ok({
    id: started.id,
    run: started.run,
    dir: started.dir,
    goal: present(started.goal),
    artifacts: ['plan.md', 'action_log.jsonl', 'screenshots/', 'checkpoint.json'],
    note: 'fill plan.md with Critical Points; drive the browser via silver; `task log`/`task checkpoint`/`task exec` to record; `task resume` to continue after a crash',
  })
}

async function taskLog(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task log <id> <event-json>')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  // Event is the remaining positional; parse as JSON, else wrap the bounded text.
  const rawEvent = flags.args.slice(2).join(' ').trim()
  if (!rawEvent) return badRequest('usage: silver task log <id> <event-json>')
  const event = safeJson(rawEvent) ?? { text: bound(rawEvent) }
  await appendLog(id, n, event)
  const count = (await readLog(id, n)).length
  return ok({ id, run: `run_${n}`, logged: true, entries: count })
}

async function taskCheckpoint(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task checkpoint <id> [--note <text>]')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  const cp = (await loadCheckpoint(id, n)) ?? null
  if (!cp) return badRequest('this run has no checkpoint; run `task start` again')

  // Best-effort screenshot of the driving session INTO the run folder. If no
  // live browser is connected, degrade gracefully (screenshot stays null) — the
  // checkpoint of progress is still recorded. Held under the session lock so it
  // never races an in-flight command on that session.
  let screenshot: string | null = null
  try {
    screenshot = await captureScreenshot(flags.session, id, n)
  } catch {
    screenshot = null
  }

  const now = new Date().toISOString()
  const next: Checkpoint = {
    ...cp,
    updatedAt: now,
    lastScreenshot: screenshot ?? cp.lastScreenshot,
    note: flags.note !== undefined ? bound(flags.note) : cp.note,
  }
  await saveCheckpoint(id, n, next)
  await appendLog(id, n, {
    kind: 'checkpoint',
    note: flags.note ?? null,
    screenshot: screenshot ?? null,
  })

  return ok({
    id,
    run: `run_${n}`,
    checkpointed: true,
    screenshot: screenshot ?? null,
    note: next.note ? present(next.note) : null,
  })
}

async function taskStatus(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task status <id>')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  const cp = n > 0 ? await loadCheckpoint(id, n) : null
  const plan = n > 0 ? parsePlan(await readPlan(id, n)) : { total: 0, checked: 0, open: [] }
  const log = n > 0 ? await readLog(id, n) : []
  return ok({
    id,
    runs: (await listRuns(id)).map((r) => `run_${r}`),
    latestRun: n > 0 ? `run_${n}` : null,
    status: cp?.status ?? 'unknown',
    plan: { total: plan.total, checked: plan.checked, remaining: plan.total - plan.checked },
    logEntries: log.length,
    updatedAt: cp?.updatedAt ?? null,
  })
}

async function taskList(): Promise<Envelope<unknown>> {
  const ids = await listTaskIds()
  const tasks = []
  for (const id of ids) {
    const n = await latestRun(id)
    const cp = n > 0 ? await loadCheckpoint(id, n) : null
    const plan = n > 0 ? parsePlan(await readPlan(id, n)) : { total: 0, checked: 0, open: [] }
    tasks.push({
      id,
      latestRun: n > 0 ? `run_${n}` : null,
      runs: (await listRuns(id)).length,
      status: cp?.status ?? 'unknown',
      plan: { total: plan.total, checked: plan.checked },
    })
  }
  return ok({ tasks })
}

async function taskResume(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task resume <id>')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  const cp = await loadCheckpoint(id, n)
  const plan = parsePlan(await readPlan(id, n))
  const log = await readLog(id, n)
  const tail = log.slice(-8) // recent context so the host can pick up mid-flow
  return ok({
    id,
    run: `run_${n}`,
    dir: runDirPath(id, n),
    status: cp?.status ?? 'unknown',
    remainingPlan: plan.open.map((t) => present(t)),
    checked: plan.checked,
    nextSteps: cp?.nextSteps ?? [],
    mistakesAndAvoidance: cp?.mistakesAndAvoidance ?? [],
    criticalContext: cp?.criticalContext ?? [],
    lastScreenshot: cp?.lastScreenshot ?? null,
    recentLog: tail,
    note: 're-run the script / continue driving the browser from here; the run folder is the durable artifact',
  })
}

async function taskExec(flags: ParsedFlags): Promise<Envelope<unknown>> {
  // Actor sub-gate: `exec` re-dispatches an arbitrary silver command, so it is
  // classified actor and requires --enable-actions (registry keeps `task`
  // read-only at the verb level; this is the per-sub-op gate, like `wait --fn`).
  if (!flags.enableActions) return fail('not_permitted')

  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task exec <id> -- <silver-cmd...>')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  // The inner command is everything after `<id>` (the flag parser has already
  // put the post-`--` tokens verbatim into args). Re-dispatch through the FULL
  // cli `run()` so the inner command re-parses its own flags AND re-applies the
  // registry/egress/confirm gates — exec grants no bypass.
  const inner = flags.args.slice(2)
  if (inner.length === 0) return badRequest('usage: silver task exec <id> -- <silver-cmd...>')

  const argv = buildInnerArgv(inner, flags)
  const { run } = await import('../cli.js')
  const res = await run(argv)

  await appendLog(id, n, {
    kind: 'exec',
    command: inner,
    success: res.env.success,
    ...(res.env.success ? {} : { error: res.env.error }),
  })

  // Return the inner envelope verbatim so the host sees exactly what the command
  // produced, plus a marker that it was recorded to the task artifact.
  const data = res.env.success ? res.env.data : null
  return {
    success: res.env.success,
    data:
      res.env.success && data !== null && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), task: id, run: `run_${n}`, logged: true }
        : data,
    error: res.env.error,
    ...(res.env.warning ? { warning: res.env.warning } : {}),
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Rebuild the inner argv, threading the parent session/namespace/actions so the
 * re-dispatched command targets the same browser and honors the same grant. */
function buildInnerArgv(inner: string[], flags: ParsedFlags): string[] {
  const argv = [...inner]
  if (!hasFlag(inner, '--session')) argv.push('--session', flags.session)
  if (flags.namespace && !hasFlag(inner, '--namespace')) argv.push('--namespace', flags.namespace)
  // exec required --enable-actions; forward it so an actor inner command works
  // under the single operator grant (the inner registry still gates per-verb).
  if (!hasFlag(inner, '--enable-actions')) argv.push('--enable-actions')
  return argv
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(flag + '='))
}

function safeJson(s: string): unknown {
  try {
    const v = JSON.parse(s)
    return typeof v === 'object' && v !== null ? v : { value: v }
  } catch {
    return undefined
  }
}

/** A short, path-safe id derived from a goal + a time disambiguator. */
function slugId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  const suffix = Date.now().toString(36).slice(-4)
  return `${slug || 'task'}-${suffix}`
}

/**
 * Capture a screenshot of the session's first page INTO the run folder. Uses the
 * session.ts CDP connect primitive directly and drops the transport after. Never
 * touches page state. Returns the relative screenshot filename, or throws if no
 * live browser is reachable (the caller degrades to null).
 */
async function captureScreenshot(session: string, id: string, n: number): Promise<string> {
  return withSessionLock(session, async () => {
    const conn = await connect(session)
    try {
      const page = conn.context.pages()[0] ?? (await conn.context.newPage())
      const file = `checkpoint_${Date.now()}.png`
      const out = path.join(runDirPath(id, n), 'screenshots', file)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await page.screenshot({ path: out })
      return file
    } finally {
      await conn.browser.close().catch(() => {})
    }
  })
}
