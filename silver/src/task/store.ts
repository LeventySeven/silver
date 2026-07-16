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

/** Run-folder filenames for the durability index (T2) and replay cache (T3). */
export const MANIFEST_FILE = 'manifest.json'
export const REPLAY_CACHE_FILE = 'replay_cache.json'

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
  // Seed the T2 run manifest so a run is externally-indexable from the first
  // moment (list/status/resume + tooling); later ops refresh it in place.
  await refreshManifest(id, n)

  return { id, run: runName, runNumber: n, dir, goal: meta.goal }
}

// ---------------------------------------------------------------------------
// T4a — base64 log hygiene. A screenshot / data-URL persisted verbatim to a
// run's action_log bloats the folder by MB. Before any event is written we
// replace every base64 image / data-URL payload with a `<omitted:base64 N
// bytes>` size marker (the count is the DECODED byte size). KEYLESS: pure regex.
// ---------------------------------------------------------------------------

/** `data:<mime>[;params];base64,<payload>` — the canonical embedded-image form. */
const DATA_URL_RE = /data:[\w.+-]*\/?[\w.+-]*(?:;[\w-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/]+={0,2})/g
/**
 * A long standalone base64 run (≥ threshold chars). Silver's own `screenshot`/
 * `pdf` verbs return RAW base64 with no `data:` prefix (`{encoding:'base64',
 * image:<b64>}`), so a host that logs such an envelope would otherwise persist
 * the whole blob. The threshold is high enough that ordinary tokens/hashes/ids
 * never match — only genuine multi-KB blobs do.
 */
const RAW_B64_RE = /[A-Za-z0-9+/]{2048,}={0,2}/g

/** Decoded byte size of a base64 payload, computed WITHOUT allocating a Buffer. */
function base64Bytes(b64: string): number {
  const clean = b64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

/** Replace base64 image / data-URL payloads in ONE string with a size marker. */
export function scrubBase64String(s: string): string {
  return s
    .replace(DATA_URL_RE, (_m, payload: string) => `<omitted:base64 ${base64Bytes(payload)} bytes>`)
    .replace(RAW_B64_RE, (m) => `<omitted:base64 ${base64Bytes(m)} bytes>`)
}

/**
 * Deep-clone an arbitrary log event, replacing every base64 image / data-URL
 * string value (at any depth, in arrays and objects) with a size marker. Pure /
 * keyless; non-string leaves pass through untouched. Exported for the T4a test.
 */
export function scrubBase64(value: unknown): unknown {
  if (typeof value === 'string') return scrubBase64String(value)
  if (Array.isArray(value)) return value.map((v) => scrubBase64(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubBase64(v)
    return out
  }
  return value
}

/** Append one event to a run's action_log.jsonl (append-only, timestamped).
 * T4a: base64 image/data-URL payloads are stripped to a size marker first so a
 * screenshot in a log can never bloat the run folder by MB. */
export async function appendLog(id: string, n: number, event: unknown): Promise<void> {
  const safe = scrubBase64(event)
  const line = JSON.stringify({ ts: new Date().toISOString(), event: safe }) + '\n'
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

// ---------------------------------------------------------------------------
// Silver version (single source of truth: package.json), keyless, cached.
// ---------------------------------------------------------------------------

let _version: string | null = null

/**
 * The Silver version, read once from the packaged `package.json`. Falls back to
 * a static string if the file can't be read (never throws — a manifest write
 * must not fail because version discovery hiccuped). KEYLESS: file read only.
 */
export async function silverVersion(): Promise<string> {
  if (_version !== null) return _version
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url)
    const raw = await fs.readFile(pkgUrl, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    _version = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    _version = '0.0.0'
  }
  return _version
}

// ---------------------------------------------------------------------------
// T2 — run manifest: a machine-readable index of a run for list/status/resume
// and external tooling. Seeded at startRun, refreshed on every mutating op.
// ---------------------------------------------------------------------------

export type RunManifest = {
  /** The task id (namespace-scoped). */
  taskId: string
  /** The run folder name (`run_<n>`). */
  run: string
  /** The original goal (bounded free text). */
  goal: string
  /** Silver version that produced/updated this run. */
  silverVersion: string
  /** ISO timestamp the run folder was opened. */
  startedAt: string
  /** ISO timestamp the run reached a terminal outcome, else null. */
  endedAt: string | null
  /** Count of recorded verb invocations (exec/action log events). */
  verbCount: number
  /** Terminal/interim outcome mirrored from the checkpoint status. */
  outcome: string
  /** Screenshot refs captured at each checkpoint (relative filenames). */
  checkpoints: string[]
  /** Path to the compiled re-runnable script, once `task compile` has run. */
  compiledScript: string | null
  /** Path to the verb-sequence replay cache, once built. */
  replayCache: string | null
}

/** Statuses that mean the run is finished (endedAt is stamped). */
const TERMINAL_STATUS = new Set([
  'done',
  'success',
  'succeeded',
  'complete',
  'completed',
  'failed',
  'failure',
  'blocked',
  'aborted',
  'cancelled',
  'canceled',
])

function manifestPath(id: string, n: number): string {
  return path.join(runDirPath(id, n), MANIFEST_FILE)
}

export async function readManifest(id: string, n: number): Promise<RunManifest | null> {
  return readJson<RunManifest>(manifestPath(id, n))
}

/** Count recorded verb invocations (log events carrying a `command` array). */
function countVerbs(log: unknown[]): number {
  let c = 0
  for (const rec of log) {
    const event = (rec as { event?: unknown })?.event
    const cmd = (event as { command?: unknown })?.command
    if (Array.isArray(cmd) && cmd.length > 0) c++
  }
  return c
}

/** Collect checkpoint screenshot refs from the log + latest checkpoint. */
function checkpointRefs(log: unknown[], cp: Checkpoint | null): string[] {
  const refs: string[] = []
  for (const rec of log) {
    const event = (rec as { event?: unknown })?.event as
      | { kind?: unknown; screenshot?: unknown }
      | undefined
    if (event?.kind === 'checkpoint' && typeof event.screenshot === 'string') {
      refs.push(event.screenshot)
    }
  }
  if (cp?.lastScreenshot && !refs.includes(cp.lastScreenshot)) refs.push(cp.lastScreenshot)
  return refs
}

/**
 * (Re)compute the run manifest from the durable artifacts (log + checkpoint)
 * and merge an optional patch (compiledScript / replayCache / outcome override).
 * Idempotent: safe to call after any mutating task op. KEYLESS.
 */
export async function refreshManifest(
  id: string,
  n: number,
  patch: Partial<RunManifest> = {},
): Promise<RunManifest> {
  const existing = await readManifest(id, n)
  const meta = await readJson<TaskMeta>(path.join(taskDir(id), 'meta.json'))
  const cp = await loadCheckpoint(id, n)
  const log = await readLog(id, n)

  const status = cp?.status ?? existing?.outcome ?? 'unknown'
  const terminal = TERMINAL_STATUS.has(status)
  const startedAt = existing?.startedAt ?? meta?.createdAt ?? new Date().toISOString()

  const manifest: RunManifest = {
    taskId: id,
    run: `run_${n}`,
    goal: bound(meta?.goal ?? existing?.goal ?? ''),
    silverVersion: await silverVersion(),
    startedAt,
    endedAt: terminal ? (cp?.updatedAt ?? existing?.endedAt ?? new Date().toISOString()) : null,
    verbCount: countVerbs(log),
    outcome: status,
    checkpoints: checkpointRefs(log, cp),
    compiledScript: existing?.compiledScript ?? null,
    replayCache: existing?.replayCache ?? null,
    ...patch,
  }
  await writeJson(manifestPath(id, n), manifest)
  return manifest
}

// ---------------------------------------------------------------------------
// T3 — verb-sequence DOM-hash replay cache. One entry per recorded verb, keyed
// by the DOM fingerprint at that step. On replay a matching hash means the
// recorded ref is known-good (deterministic replay, no host round-trip); a
// mismatch means self-heal (fresh snapshot + host). Stored in the run folder.
// ---------------------------------------------------------------------------

export type ReplayStep = {
  /** Zero-based position in the recorded verb sequence. */
  index: number
  /** The verb (e.g. `click`, `fill`). */
  verb: string
  /** The full argv token array (`[verb, ...args]`). */
  argv: string[]
  /** The resolved ref (`eN`) the step acted on, when known. */
  ref: string | null
  /** DOM fingerprint recorded at this step (reuses the pagechange fingerprint). */
  domHash: string | null
}

export type ReplayCache = {
  task: string
  run: string
  builtAt: string
  steps: ReplayStep[]
}

function replayCachePath(id: string, n: number): string {
  return path.join(runDirPath(id, n), REPLAY_CACHE_FILE)
}

export async function saveReplayCache(id: string, n: number, cache: ReplayCache): Promise<void> {
  await fs.mkdir(runDirPath(id, n), { recursive: true }).catch(() => {})
  await writeJson(replayCachePath(id, n), cache)
}

export async function loadReplayCache(id: string, n: number): Promise<ReplayCache | null> {
  return readJson<ReplayCache>(replayCachePath(id, n))
}

/**
 * The core replay decision (pure, keyless): given a recorded step and the DOM
 * hash observed NOW, decide whether the recorded ref is known-good and can be
 * dispatched deterministically without a host round-trip, or the caller must
 * fall back to a fresh snapshot + host resolution (self-heal).
 *
 * A hit requires a non-empty recorded hash that equals the current hash AND a
 * recorded ref. Everything else falls back — a missing hash is never a hit
 * (we have no basis to claim the recorded ref is still valid).
 */
export function decideReplay(
  step: ReplayStep,
  currentDomHash: string | null | undefined,
): { reuse: boolean; ref: string | null; reason: string } {
  if (!step.domHash) return { reuse: false, ref: null, reason: 'no_recorded_hash' }
  if (!step.ref) return { reuse: false, ref: null, reason: 'no_recorded_ref' }
  if (currentDomHash === null || currentDomHash === undefined || currentDomHash === '') {
    return { reuse: false, ref: null, reason: 'no_current_hash' }
  }
  if (currentDomHash !== step.domHash) {
    return { reuse: false, ref: null, reason: 'dom_hash_mismatch' }
  }
  return { reuse: true, ref: step.ref, reason: 'dom_hash_match' }
}
