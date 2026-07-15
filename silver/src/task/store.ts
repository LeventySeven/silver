/**
 * Long-running task-artifact store (Webwright's keyless task convention, ported).
 *
 * The durable artifact is the RUN FOLDER — the script + logs — so a long task
 * survives a crashed agent and is replayable (Webwright's real contribution;
 * DECISION §3 "the script IS the artifact; re-running it is the resume").
 * Layout, per-namespace (mirrors sessions):
 *
 *   ~/.silver/<ns>/tasks/<id>/
 *     meta.json                     — { id, goal, createdAt }
 *     run_<n>/
 *       plan.md                     — Critical-Points checklist the HOST fills
 *       action_log.jsonl            — one JSON event per line (append-only)
 *       screenshots/                — per-checkpoint evidence
 *       checkpoint.json             — progress + Aside "Mistakes & Avoidance"
 *
 * `task start` opens a NEW run folder each time (run_1, run_2, …); the latest
 * run is the highest n. KEYLESS: Silver writes NO model call — the host drives;
 * this module only provides the artifact scaffold + append/read helpers.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { nsRoot } from '../core/nsdirs.js'
import { capOutput } from '../security/injection.js'

export const TASKS_SUB = 'tasks'

/** Hard bound on any single stored free-text field, so a hostile page value
 * handed to `task start`/`task log` cannot write an unbounded file. */
const MAX_TEXT = 200_000

export function tasksRoot(): string {
  return nsRoot(TASKS_SUB)
}
export function taskDir(id: string): string {
  return path.join(tasksRoot(), id)
}
export function runDirPath(id: string, n: number): string {
  return path.join(taskDir(id), `run_${n}`)
}

export type TaskMeta = { id: string; goal: string; createdAt: string }

export type Progress = { done: string[]; inProgress: string[]; blocked: string[] }

export type Checkpoint = {
  task: string
  run: string
  goal: string
  status: string
  updatedAt: string
  progress: Progress
  nextSteps: string[]
  /** Aside's browser-specific field: known failure modes to avoid repeating. */
  mistakesAndAvoidance: string[]
  criticalContext: string[]
  lastScreenshot: string | null
  note: string | null
}

/** Bound a free-text field before it is persisted. */
export function bound(text: string): string {
  return capOutput(String(text ?? ''), MAX_TEXT)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Does this task exist on disk? */
export async function taskExists(id: string): Promise<boolean> {
  return (await readJson<TaskMeta>(path.join(taskDir(id), 'meta.json'))) !== null
}

/** List the run numbers present for a task, ascending. */
export async function listRuns(id: string): Promise<number[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(taskDir(id))
  } catch {
    return []
  }
  const runs: number[] = []
  for (const e of entries) {
    const m = /^run_(\d+)$/.exec(e)
    if (m) runs.push(Number.parseInt(m[1], 10))
  }
  return runs.sort((a, b) => a - b)
}

/** The highest run number, or 0 if none. */
export async function latestRun(id: string): Promise<number> {
  const runs = await listRuns(id)
  return runs.length > 0 ? runs[runs.length - 1] : 0
}

/** The plan.md Critical-Points template (Webwright), embedding the goal. */
export function planTemplate(goal: string): string {
  return `# Task: ${goal}

> Host-driven, keyless — Silver writes no model call. Fill in one CPn below for
> every explicit constraint, filter, sort, selection, or required datum. Each CP
> must be independently verifiable from a screenshot or an action_log line. Tick
> \`[x]\` ONLY with cited evidence.

## Critical Points
- [ ] CP1:
- [ ] CP2:

## Notes
`
}

function freshCheckpoint(id: string, run: string, goal: string): Checkpoint {
  return {
    task: id,
    run,
    goal,
    status: 'in_progress',
    updatedAt: new Date().toISOString(),
    progress: { done: [], inProgress: [], blocked: [] },
    nextSteps: [],
    mistakesAndAvoidance: [],
    criticalContext: [],
    lastScreenshot: null,
    note: null,
  }
}

export type StartedRun = { id: string; run: string; runNumber: number; dir: string; goal: string }

/**
 * Create a NEW run folder for a task (creating the task itself on first call),
 * scaffolding plan.md, an empty action_log.jsonl, a screenshots/ dir, and a
 * fresh checkpoint.json. Returns the run descriptor.
 */
export async function startRun(id: string, goal: string): Promise<StartedRun> {
  const boundedGoal = bound(goal)
  await fs.mkdir(taskDir(id), { recursive: true })
  // First-touch meta (preserve the original goal across later runs).
  const metaPath = path.join(taskDir(id), 'meta.json')
  const existing = await readJson<TaskMeta>(metaPath)
  const meta: TaskMeta = existing ?? {
    id,
    goal: boundedGoal,
    createdAt: new Date().toISOString(),
  }
  if (!existing) await writeJson(metaPath, meta)

  const n = (await latestRun(id)) + 1
  const runName = `run_${n}`
  const dir = runDirPath(id, n)
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true })
  await fs.writeFile(path.join(dir, 'plan.md'), planTemplate(meta.goal), 'utf8')
  await fs.writeFile(path.join(dir, 'action_log.jsonl'), '', 'utf8')
  await writeJson(path.join(dir, 'checkpoint.json'), freshCheckpoint(id, runName, meta.goal))
  await appendLog(id, n, { kind: 'run_start', goal: meta.goal })

  return { id, run: runName, runNumber: n, dir, goal: meta.goal }
}

/** Append one event to a run's action_log.jsonl (append-only, timestamped). */
export async function appendLog(id: string, n: number, event: unknown): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), event }) + '\n'
  await fs.mkdir(runDirPath(id, n), { recursive: true }).catch(() => {})
  await fs.appendFile(path.join(runDirPath(id, n), 'action_log.jsonl'), line, 'utf8')
}

/** Read a run's action_log as parsed records (best-effort; skips bad lines). */
export async function readLog(id: string, n: number): Promise<unknown[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(runDirPath(id, n), 'action_log.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out
}

export async function loadCheckpoint(id: string, n: number): Promise<Checkpoint | null> {
  return readJson<Checkpoint>(path.join(runDirPath(id, n), 'checkpoint.json'))
}

export async function saveCheckpoint(id: string, n: number, cp: Checkpoint): Promise<void> {
  await writeJson(path.join(runDirPath(id, n), 'checkpoint.json'), cp)
}

export async function readPlan(id: string, n: number): Promise<string> {
  try {
    return await fs.readFile(path.join(runDirPath(id, n), 'plan.md'), 'utf8')
  } catch {
    return ''
  }
}

export type PlanProgress = { total: number; checked: number; open: string[] }

/** Parse a plan.md checklist into done/open counts (the `- [ ]`/`- [x]` lines). */
export function parsePlan(plan: string): PlanProgress {
  const open: string[] = []
  let total = 0
  let checked = 0
  for (const line of plan.split('\n')) {
    const m = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line)
    if (!m) continue
    total++
    if (m[1] === ' ') open.push(m[2].trim())
    else checked++
  }
  return { total, checked, open }
}

/** Enumerate all task ids in the namespace (dirs with a meta.json). */
export async function listTaskIds(): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(tasksRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory() && (await taskExists(e.name))) out.push(e.name)
  }
  return out.sort()
}
