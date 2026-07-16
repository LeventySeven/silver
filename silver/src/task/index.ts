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
import { resolveActivePage } from '../core/tabs.js'
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
  refreshManifest,
  saveReplayCache,
  loadReplayCache,
  decideReplay,
  REPLAY_CACHE_FILE,
  type Checkpoint,
  type ReplayStep,
  type ReplayCache,
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

// ---------------------------------------------------------------------------
// T5 — subprocess env hygiene for `task exec`. A fixed non-interactive child env
// (paginators → cat, no progress bars, no color, CI mode) + a workspace-scoped
// TMPDIR, applied for the duration of the inner dispatch and then restored.
// ---------------------------------------------------------------------------

/** The fixed env every `task exec` child inherits (defeats paginator/progress hangs). */
export const EXEC_FIXED_ENV: Readonly<Record<string, string>> = {
  PAGER: 'cat',
  MANPAGER: 'cat',
  LESS: '-R',
  PIP_PROGRESS_BAR: 'off',
  TQDM_DISABLE: '1',
  CI: '1',
  NO_COLOR: '1',
}

/** The workspace-scoped TMPDIR for a run's `task exec` children (under the run folder). */
export function execTmpdir(id: string, n: number): string {
  return path.join(runDirPath(id, n), 'tmp')
}

/**
 * Merge `env` into `process.env` (so anything the inner command spawns inherits
 * it) and return a restore fn that puts the parent env back exactly — deleting
 * keys that were previously unset. Silver runs one command per process, so this
 * scoped mutate/restore is the mechanism for a "child env" without a real fork.
 */
function applyChildEnv(env: Record<string, string>): () => void {
  const prev = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(env)) {
    prev.set(k, process.env[k])
    process.env[k] = v
  }
  return () => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
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
    case 'compile':
      return taskCompile(flags)
    case 'replay':
      return taskReplay(flags)
    default:
      return badRequest(
        'usage: silver task start|log|checkpoint|status|list|resume|exec|compile|replay',
      )
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
  await refreshManifest(id, n)
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
  await refreshManifest(id, n)

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
  // The T2 manifest is the machine-readable index; surface it (and refresh it so
  // `status` never reports a stale count) for list/status/resume + tooling.
  const manifest = n > 0 ? await refreshManifest(id, n) : null
  return ok({
    id,
    runs: (await listRuns(id)).map((r) => `run_${r}`),
    latestRun: n > 0 ? `run_${n}` : null,
    status: cp?.status ?? 'unknown',
    plan: { total: plan.total, checked: plan.checked, remaining: plan.total - plan.checked },
    logEntries: log.length,
    verbCount: manifest?.verbCount ?? 0,
    manifest,
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
  // T5 — subprocess env hygiene: any child the inner command spawns (a paginator
  // like git/man/less, a progress-bar drawer like pip/tqdm, or Chromium itself)
  // can block the capture or spam `\r`. Merge a fixed non-interactive env plus a
  // workspace-scoped TMPDIR for the duration of the inner dispatch, restoring the
  // parent env afterward so nothing leaks across commands. KEYLESS.
  const tmpdir = execTmpdir(id, n)
  await fs.mkdir(tmpdir, { recursive: true }).catch(() => {})
  const restoreEnv = applyChildEnv({ ...EXEC_FIXED_ENV, TMPDIR: tmpdir })
  let res: Awaited<ReturnType<(typeof import('../cli.js'))['run']>>
  try {
    const { run } = await import('../cli.js')
    res = await run(argv)
  } finally {
    restoreEnv()
  }

  // Capture the resolved ref + DOM fingerprint the inner verb reported (when
  // present) so `task compile` can auto-name variables (T1) and the replay cache
  // (T3) can key each step by its DOM-hash — all from data Silver already holds,
  // no extra work, no model.
  const innerData =
    res.env.success && res.env.data !== null && typeof res.env.data === 'object'
      ? (res.env.data as Record<string, unknown>)
      : {}
  const hint = execHint(innerData)
  await appendLog(id, n, {
    kind: 'exec',
    command: inner,
    success: res.env.success,
    ...hint,
    ...(res.env.success ? {} : { error: res.env.error }),
  })
  const manifest = await refreshManifest(id, n)

  // T6a — opt-in `--echo-plan` anti-drift: append the current plan.md checklist
  // (OPEN items first) + the original goal to the exec envelope, so a long host
  // loop keeps the goal fresh even as its own context rots. Off by default; the
  // host wires `--echo-plan` (flags: `echoPlan`).
  const echoPlan = (flags as ParsedFlags & { echoPlan?: boolean }).echoPlan === true
  let planEcho: Record<string, unknown> | null = null
  if (echoPlan) {
    const plan = parsePlan(await readPlan(id, n))
    planEcho = {
      goal: present(manifest.goal),
      open: plan.open.map((t) => present(t)), // open (unchecked) items first
      checked: plan.checked,
      total: plan.total,
    }
  }

  // Return the inner envelope verbatim so the host sees exactly what the command
  // produced, plus a marker that it was recorded to the task artifact. When the
  // inner data is NOT an object (e.g. `snapshot`/read verbs return a string), it
  // is wrapped under `result` so the task/run/logged bookkeeping markers still
  // attach — otherwise a string envelope would silently drop them.
  const data = res.env.success ? res.env.data : null
  const markers = {
    task: id,
    run: `run_${n}`,
    logged: true,
    ...(planEcho ? { echoPlan: planEcho } : {}),
  }
  return {
    success: res.env.success,
    data:
      res.env.success && data !== null
        ? typeof data === 'object'
          ? { ...(data as Record<string, unknown>), ...markers }
          : { result: data, ...markers }
        : data,
    error: res.env.error,
    ...(res.env.warning ? { warning: res.env.warning } : {}),
  }
}

/**
 * `task compile <id>` — the durable, re-runnable artifact (adopt-list F1).
 *
 * Reads the latest run's action_log.jsonl, pulls the recorded `exec` command
 * invocations, promotes each literal argument into a named `--flag`-style shell
 * parameter (Webwright's `# Parameters` shape), and emits a runnable `silver`
 * script whose DEFAULTS reproduce the task verbatim and whose parameters let a
 * human/cron vary it — with ZERO further LLM. The script IS the artifact
 * (task/store.ts's stated intent, now delivered). KEYLESS: pure text assembly.
 */
async function taskCompile(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task compile <id>')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  const log = await readLog(id, n)
  const events = collectVerbEvents(log)
  const { script, parameters } = renderScript(id, n, events)

  const scriptName = 'compiled.sh'
  const out = path.join(runDirPath(id, n), scriptName)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, script, { encoding: 'utf8', mode: 0o755 })

  // Build + persist the T3 verb-sequence DOM-hash replay cache alongside the
  // script so a later `task replay` can reuse known-good refs deterministically.
  const cache = buildReplayCache(id, n, events)
  await saveReplayCache(id, n, cache)
  const cachePath = path.join(runDirPath(id, n), REPLAY_CACHE_FILE)

  await appendLog(id, n, { kind: 'compile', script: scriptName, commands: events.length })
  // Record the compiled-script + replay-cache paths in the run manifest (T2).
  await refreshManifest(id, n, { compiledScript: out, replayCache: cachePath })

  return ok({
    id,
    run: `run_${n}`,
    script: out,
    scriptName,
    replayCache: cachePath,
    commands: events.length,
    parameters,
    variables: parameters.filter((p) => p.detected).map((p) => ({ name: p.name, type: p.detected })),
    note: 're-run this script to reproduce the task verbatim; override any parameter (env var) to vary it — detected variables (urls/search/email/…) are named by kind, secrets are never baked in — no LLM needed',
  })
}

// ---------------------------------------------------------------------------
// T1 — variable auto-detection. A recorded verb whose value varies run-to-run
// (a filled search term, email, url, credential) is promoted to a semantically
// NAMED override parameter instead of an opaque positional slot. Detection is
// keyless: (1) an explicit `var` annotation on the log event, (2) the DOM hint
// (role/name/type/placeholder) the actuation verb reported, (3) value-shape
// regex. Everything undetected keeps the stable positional name (back-compat).
// ---------------------------------------------------------------------------

/** A DOM hint the actuation verb reported about the element it acted on. */
type DomHint = {
  role?: string
  name?: string
  inputType?: string
  placeholder?: string
  id?: string
  ariaLabel?: string
}

/** One recorded verb invocation + the metadata used to name its variables. */
type VerbEvent = {
  argv: string[]
  domHash: string | null
  ref: string | null
  meta?: DomHint
  /** Explicit host annotation of THE value: `{ name?, type?, secret? }`. */
  var?: { name?: string; type?: string; secret?: boolean }
}

/** A detected variable: its semantic kind + whether it is a credential. */
type Detection = { type: string; secret: boolean } | null

/** Input verbs whose LAST non-flag positional is a run-to-run "filled value". */
const INPUT_VERBS = new Set(['fill', 'type', 'select', 'search'])

/** Pull the recorded silver verb invocations (+ hints) from a log. */
function collectVerbEvents(log: unknown[]): VerbEvent[] {
  const out: VerbEvent[] = []
  for (const rec of log) {
    // appendLog wraps every event as { ts, event }. A verb event carries the
    // verbatim command token array under `command`.
    const event = (rec as { event?: unknown })?.event as Record<string, unknown> | undefined
    const cmd = event?.command
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((t) => typeof t === 'string')) {
      continue
    }
    const argv = cmd as string[]
    const meta = isObject(event?.meta) ? (event!.meta as DomHint) : undefined
    const varAnn = isObject(event?.var) ? (event!.var as VerbEvent['var']) : undefined
    const domHash =
      strOrNull(event?.domHash) ?? strOrNull(event?.fingerprint) ?? strOrNull(event?.dom_hash)
    const ref = strOrNull(event?.ref) ?? firstRefIn(argv)
    out.push({ argv, domHash, ref, meta, var: varAnn })
  }
  return out
}

/** Extract the ref/dom-hash hint from an inner exec envelope's data. */
function execHint(data: Record<string, unknown>): Record<string, unknown> {
  const hint: Record<string, unknown> = {}
  const ref = strOrNull(data.ref)
  if (ref) hint.ref = ref
  // The pagechange fingerprint doubles as the step DOM-hash (may be nested).
  const fp =
    strOrNull(data.fingerprint) ??
    strOrNull((isObject(data.pageChange) ? (data.pageChange as Record<string, unknown>) : {}).fingerprint)
  if (fp) hint.domHash = fp
  // Carry a DOM hint for variable naming when the verb reported role/name/etc.
  const meta: DomHint = {}
  for (const k of ['role', 'name', 'inputType', 'placeholder', 'id', 'ariaLabel'] as const) {
    const v = strOrNull(data[k])
    if (v) meta[k] = v
  }
  if (Object.keys(meta).length > 0) hint.meta = meta
  return hint
}

/**
 * Decide whether a filled VALUE is a run-to-run variable, and of what kind.
 * Order: explicit annotation → DOM hint → value-shape. Returns null when the
 * value looks like an incidental literal (keeps the stable positional slot).
 */
function detectVariable(value: string, meta: DomHint | undefined, ann: VerbEvent['var']): Detection {
  if (ann && (ann.type || ann.secret)) {
    return { type: normType(ann.type ?? (ann.secret ? 'secret' : 'value')), secret: !!ann.secret }
  }
  const fromMeta = detectFromHint(meta)
  if (fromMeta) return fromMeta
  return detectFromShape(value)
}

function detectFromHint(meta: DomHint | undefined): Detection {
  if (!meta) return null
  const t = (meta.inputType ?? '').toLowerCase()
  if (t === 'password') return { type: 'password', secret: true }
  if (t === 'email') return { type: 'email', secret: false }
  if (t === 'tel') return { type: 'phone', secret: false }
  if (t === 'url') return { type: 'url', secret: false }
  if (t === 'search') return { type: 'search_term', secret: false }
  if (t === 'date' || t === 'datetime-local' || t === 'month') return { type: 'date', secret: false }
  if (t === 'number') return { type: 'number', secret: false }
  if ((meta.role ?? '').toLowerCase() === 'searchbox') return { type: 'search_term', secret: false }
  // Keyword scan over the accessible-name/placeholder/id (word-boundary-ish).
  const hay = [meta.name, meta.placeholder, meta.id, meta.ariaLabel]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase()
  if (!hay) return null
  if (/\b(pass\s?word|passwd|pwd)\b/.test(hay)) return { type: 'password', secret: true }
  if (/\b(cvv|cvc|card\s?number|cc[-\s]?num)\b/.test(hay)) return { type: 'card', secret: true }
  if (/\b(otp|2fa|one[-\s]?time|verification\s?code)\b/.test(hay)) return { type: 'otp', secret: true }
  if (/\b(e-?mail)\b/.test(hay)) return { type: 'email', secret: false }
  if (/\b(phone|tel|mobile)\b/.test(hay)) return { type: 'phone', secret: false }
  if (/\b(search|query|keyword)\b/.test(hay)) return { type: 'search_term', secret: false }
  if (/\b(address|street)\b/.test(hay)) return { type: 'address', secret: false }
  if (/\b(city|town)\b/.test(hay)) return { type: 'city', secret: false }
  if (/\b(zip|postal|postcode)\b/.test(hay)) return { type: 'postal_code', secret: false }
  if (/\bdate\b/.test(hay)) return { type: 'date', secret: false }
  return null
}

function detectFromShape(value: string): Detection {
  const v = value.trim()
  if (!v) return null
  if (/^https?:\/\/\S+$/i.test(v)) return { type: 'url', secret: false }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { type: 'email', secret: false }
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/.test(v)) return { type: 'date', secret: false }
  if (looksLikeCard(v)) return { type: 'card', secret: true }
  if (/^\+?[\d][\d\s().-]{6,}$/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 7) {
    return { type: 'phone', secret: false }
  }
  return null
}

/** Luhn check on a bare 13-19 digit run (credit-card shape → treat as secret). */
function looksLikeCard(v: string): boolean {
  const digits = v.replace(/[\s-]/g, '')
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

function normType(t: string): string {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value'
}

/** The compiled parameter record (default is redacted for secrets). */
type CompiledParam = { name: string; default: string; detected?: string; secret?: boolean }

/**
 * Render the parameterized shell script + the parameter list. A detected filled
 * value becomes a semantically named override parameter (`SEARCH_TERM`, `EMAIL`,
 * …); a credential becomes a required-at-runtime secret whose value is NEVER
 * baked into the script; every other non-flag positional keeps its stable
 * `<VERB>_<cmdIndex>_<argPos>` slot. Flags stay literal (shape preserved).
 */
function renderScript(
  id: string,
  n: number,
  events: VerbEvent[],
): { script: string; parameters: CompiledParam[] } {
  const parameters: CompiledParam[] = []
  const used = new Set<string>()
  const body: string[] = []

  events.forEach((ev, ci) => {
    const cmd = ev.argv
    const verb = cmd[0]
    const valuePos = INPUT_VERBS.has(verb) ? lastNonFlagIndex(cmd) : -1
    const parts: string[] = ['silver', shellQuote(verb)]
    for (let p = 1; p < cmd.length; p++) {
      const tok = cmd[p]
      if (tok.startsWith('-')) {
        // A flag (or its literal switch) — keep verbatim, do not parameterize.
        parts.push(shellQuote(tok))
        continue
      }
      const detection = p === valuePos ? detectVariable(tok, ev.meta, ev.var) : null
      if (detection) {
        const base = ev.var?.name ? normType(ev.var.name).toUpperCase() : detection.type.toUpperCase()
        const name = uniqueName(base, used)
        parameters.push({
          name,
          default: detection.secret ? '<secret>' : tok,
          detected: detection.type,
          ...(detection.secret ? { secret: true } : {}),
        })
        parts.push(`"$${name}"`)
        continue
      }
      const name = paramName(verb, ci + 1, p)
      used.add(name)
      parameters.push({ name, default: tok })
      parts.push(`"$${name}"`)
    }
    body.push(parts.join(' '))
  })

  const header = [
    '#!/usr/bin/env bash',
    `# Compiled from silver task "${sanitizeComment(id)}" run_${n}.`,
    '# Silver is keyless: this script calls `silver` verbatim by default. Each',
    '# literal below is an override-able parameter — set the env var to vary it.',
    '# Auto-detected variables (urls/search/email/…) are named by kind; secrets are',
    '# NOT baked in — export the env var at runtime to supply them.',
    'set -euo pipefail',
    '',
    '# Parameters',
    ...parameters.map(paramLine),
    '',
  ]

  const script = [...header, ...body, ''].join('\n')
  return { script, parameters }
}

/** One `# Parameters` line. Secrets are required-at-runtime (no baked value). */
function paramLine(par: CompiledParam): string {
  if (par.secret) {
    return `${par.name}="\${${par.name}:?set ${par.name} (secret; not stored in this script)}"`
  }
  const suffix = par.detected ? `  # ${par.detected} (auto-detected)` : ''
  return `${par.name}="\${${par.name}:-${shellEscapeDefault(par.default)}}"${suffix}`
}

/** The index of the last non-flag positional in a command, or -1. */
function lastNonFlagIndex(cmd: string[]): number {
  for (let p = cmd.length - 1; p >= 1; p--) {
    if (!cmd[p].startsWith('-')) return p
  }
  return -1
}

/** Ensure a shell-valid, unique parameter name (dedupe with a counter). */
function uniqueName(base: string, used: Set<string>): string {
  const clean = base.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE'
  if (!used.has(clean)) {
    used.add(clean)
    return clean
  }
  let i = 2
  while (used.has(`${clean}_${i}`)) i++
  const name = `${clean}_${i}`
  used.add(name)
  return name
}

/** A unique, shell-valid parameter name: `<VERB>_<cmdIndex>_<argPos>`. */
function paramName(verb: string, cmdIndex: number, argPos: number): string {
  const v = String(verb).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ARG'
  return `${v}_${cmdIndex}_${argPos}`
}

// ---------------------------------------------------------------------------
// T3 — verb-sequence DOM-hash replay cache + `task replay`.
// ---------------------------------------------------------------------------

/** Build the replay cache from the recorded verb sequence (keyless). */
function buildReplayCache(id: string, n: number, events: VerbEvent[]): ReplayCache {
  const steps: ReplayStep[] = events.map((ev, i) => ({
    index: i,
    verb: ev.argv[0],
    argv: ev.argv,
    ref: ev.ref,
    domHash: ev.domHash,
  }))
  return { task: id, run: `run_${n}`, builtAt: new Date().toISOString(), steps }
}

/**
 * `task replay <id> [<current-dom-hash>]` — the deterministic replay planner.
 *
 * Loads (or builds) the verb-sequence DOM-hash cache and, given the DOM hash the
 * host observes NOW, decides per step whether the recorded ref is known-good and
 * can be dispatched WITHOUT a host round-trip (hash match), or the host must
 * self-heal with a fresh snapshot (hash mismatch / no recorded hash). With
 * `--enable-actions` it also dispatches the reusable steps in order, stopping at
 * the first step that needs a fresh snapshot so the host can re-resolve. KEYLESS.
 */
async function taskReplay(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = idAt(flags, 1)
  if (!id) return badRequest('usage: silver task replay <id> [<current-dom-hash>]')
  if (!(await taskExists(id))) return badRequest('no such task; run `task start` first')
  const n = await latestRun(id)
  if (n === 0) return badRequest('this task has no run yet; run `task start` first')

  // Use the persisted cache, else build it on the fly from the log (and persist).
  let cache = await loadReplayCache(id, n)
  if (!cache) {
    cache = buildReplayCache(id, n, collectVerbEvents(await readLog(id, n)))
    await saveReplayCache(id, n, cache)
  }

  // The current DOM hash is a plain positional (the flag parser owns no
  // `--dom-hash`); the host passes the fingerprint from its latest snapshot.
  const currentDomHash = flags.args[2] ?? null

  const dispatch = flags.enableActions
  let dispatchedAll = true
  const steps = []
  for (const step of cache.steps) {
    const decision = decideReplay(step, currentDomHash)
    let dispatched = false
    if (dispatch && decision.reuse && dispatchedAll) {
      // Reuse: dispatch the recorded verb directly with the known-good ref — no
      // re-snapshot, no re-resolution. Logged like `exec` for the audit trail.
      const argv = buildInnerArgv(step.argv, flags)
      const { run } = await import('../cli.js')
      const res = await run(argv)
      await appendLog(id, n, { kind: 'replay', command: step.argv, success: res.env.success })
      dispatched = true
    } else if (dispatch && !decision.reuse) {
      // First step that can't be reused halts live dispatch: the host must take a
      // fresh snapshot and self-heal from here (later steps' hashes are stale too).
      dispatchedAll = false
    }
    steps.push({
      index: step.index,
      verb: step.verb,
      ref: decision.ref,
      reuse: decision.reuse,
      reason: decision.reason,
      dispatched,
    })
  }
  if (dispatch) await refreshManifest(id, n)

  const reused = steps.filter((s) => s.reuse).length
  return ok({
    id,
    run: `run_${n}`,
    domHash: currentDomHash,
    total: steps.length,
    reused,
    fallback: steps.length - reused,
    dispatched: dispatch,
    steps,
    note: dispatch
      ? 'reusable steps (matching DOM-hash) were dispatched with their known-good refs; take a fresh snapshot and re-resolve from the first fallback step'
      : 'planner only: pass --enable-actions to dispatch the reusable steps; a matching DOM-hash means the recorded ref is known-good (no host round-trip), a mismatch means self-heal with a fresh snapshot',
  })
}

/** First silver ref (`eN`/`@eN`) among a command's tokens, or null. */
function firstRefIn(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    if (/^@?e\d+$/.test(argv[i])) return argv[i]
  }
  return null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Escape a value for use inside a `"${VAR:-<here>}"` default (double-quote ctx). */
function shellEscapeDefault(s: string): string {
  return String(s ?? '')
    .replace(/[\\"$`]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ')
}

/** Single-quote a literal token for the script body (safe for any content). */
function shellQuote(s: string): string {
  const v = String(s ?? '')
  return `'` + v.replace(/'/g, `'\\''`).replace(/[\r\n]+/g, ' ') + `'`
}

/** Strip anything that could break out of a `#` comment line. */
function sanitizeComment(s: string): string {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 80)
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
      const page = await resolveActivePage(conn.context, session)
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
