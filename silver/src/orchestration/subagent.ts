/**
 * `silver subagent …` — keyless subagent orchestration (Aside's design).
 *
 * Silver is KEYLESS: it never runs a model, so a "subagent" is NOT an in-CLI
 * agent loop. It is a scoped CHILD unit of work — an isolated child SESSION (its
 * own detached browser) OR its own TAB in a shared browser — plus a recorded
 * task the HOST's own sub-agent drives with silver commands. `spawn` reserves
 * the scope and returns a child id + the session/tab handle + the environment
 * the host should give the child; `wait` blocks on a status file the child (via
 * `subagent done|fail`) updates. This gives the owner's "launch per-agents, each
 * its own browser or shared" primitive without any model call.
 *
 * The three hard invariants (Aside pattern 12), enforced HERE, not by
 * convention:
 *   - CAP: at most 5 concurrent RUNNING children per namespace. A lockfile-free
 *     counted semaphore — the running record files ARE the count.
 *   - ONE LEVEL: a child cannot spawn. Enforced via `SILVER_SUBAGENT_DEPTH` in
 *     the environment: `spawn` refuses if depth ≥ 1, and hands the child an env
 *     with depth = 1 so the child's own `spawn` is refused in turn.
 *   - OWN CONTEXT PER AGENT: two RUNNING isolated children may never share a
 *     session (live page state is never shared). Auto-assigned sessions are
 *     distinct; a `--tab` child shares the browser but gets its own tab (own DOM).
 *
 * Subcommands:
 *   subagent spawn <prompt…> [--session c] [--tab] [--background]
 *                            [--name d] [--confirm-actions v,…]   (ACTOR)
 *   subagent wait <id> [<id>…]           block until terminal (status file)
 *   subagent done <id> [--text result]   mark a child complete (frees a slot)
 *   subagent fail <id> [--text reason]   mark a child failed  (frees a slot)
 *   subagent status <id>                 one record
 *   subagent list                        all records in the namespace
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { ok, fail, type Envelope } from '../core/envelope.js'
import type { ParsedFlags } from '../core/flags.js'
import { withSessionLock } from '../core/lock.js'
import { nsRoot, sanitizeSegment } from '../core/nsdirs.js'
import { neutralize, capOutput } from '../security/injection.js'
import { assertContainedPath } from '../security/egress.js'

export const SUBAGENTS_SUB = 'subagents'

/**
 * Reserved session name whose advisory lock (core/lock.ts `withSessionLock`)
 * serializes the spawn read-check-write PER NAMESPACE. The lock file lives under
 * that namespace's own `sessions/.subagents-lock/` dir, so spawns in different
 * namespaces never block each other while same-namespace spawns run one-at-a-
 * time — the only way the CAP + id-mint + session-clash checks can be atomic.
 * The leading dot keeps it out of `session list` (no `session.json` sidecar) and
 * away from any real user-chosen `--session` name.
 */
const SPAWN_LOCK_NAME = '.subagents-lock'

/** Aside's default: at most 5 concurrent children under one parent/namespace. */
export const CONCURRENCY_CAP = 5
/**
 * 3b — crash-safe cap reclamation. A child is driven by the HOST's own loop;
 * there is NO Silver-side process for it, so a host that dies mid-task never
 * calls `subagent done|fail` and its record stays `running` FOREVER, permanently
 * wedging a cap slot (the 6th spawn is refused for good). There is also no
 * heartbeat and no usable liveness signal — session-daemon liveness does NOT
 * track the driver (a persistent browser daemon outlives its dead driver), so a
 * generous TTL on `updatedAt` is the only robust keyless reclaim: a child that
 * has been `running` this long with no completion is presumed abandoned. It
 * fails SAFE — a falsely-reaped but still-live child recovers, because its later
 * `subagent done` simply flips the record back (subagentMark writes status
 * unconditionally) and its result is preserved. This reclaims the cap SLOT only;
 * the abandoned child's orphan browser is `session gc`'s job, not the reaper's.
 */
export const STALE_SUBAGENT_MS = 30 * 60_000
const MAX_PROMPT = 20_000
/** Hard bound on a result FILE (O1). Far above MAX_PROMPT — a long result is
 * written whole (not truncated to MAX_PROMPT); this only caps a hostile blob. */
const RESULT_FILE_MAX = 5_000_000
const WAIT_DEFAULT_MS = 60_000
const WAIT_POLL_MS = 50

export type SubStatus = 'running' | 'done' | 'failed'

export type SubRecord = {
  id: string
  description: string | null
  prompt: string
  session: string
  tab: boolean
  status: SubStatus
  /** Read-only unless the spawn granted actor verbs via --confirm-actions. */
  readOnly: boolean
  allow: string[]
  background: boolean
  depth: number
  createdAt: string
  updatedAt: string
  result: string | null
  /**
   * O1 — path to the FULL, untruncated result on disk (under `.silver/<ns>/
   * subagents/`), or null. Set when the result exceeds MAX_PROMPT (auto) or a
   * `--result-file` was supplied. `result` then holds only a bounded preview;
   * the parent reads `resultPath` only if it needs the whole thing (no silent
   * truncation of long child output).
   */
  resultPath: string | null
  /**
   * 3b — metadata note (NOT the child's output). The stale-reaper writes the
   * "abandoned…" reason here, leaving `result` null, so a falsely-reaped child
   * that later completes never surfaces the reap reason as its result. An explicit
   * done/fail clears it (an answering child was not abandoned). Optional/additive.
   */
  note?: string | null
}

function subagentsRoot(): string {
  return nsRoot(SUBAGENTS_SUB)
}
function recordPath(id: string): string {
  return path.join(subagentsRoot(), `${id}.json`)
}

/** On-disk path for a child's FULL result (O1), under the subagents dir. */
function resultFilePath(id: string): string {
  return path.join(subagentsRoot(), `${id}.result.txt`)
}

/** Write a child's full result into the subagents dir; returns the path (O1). */
async function writeResultFile(id: string, content: string): Promise<string> {
  await fs.mkdir(subagentsRoot(), { recursive: true })
  const out = resultFilePath(id)
  await fs.writeFile(out, capOutput(content, RESULT_FILE_MAX), 'utf8')
  return out
}

function badRequest(message: string): Envelope<never> {
  return { success: false, data: null, error: message }
}

/** Scrub + cap any echoed prompt/result (a child's task may be page-derived). */
function present(text: string | null): string | null {
  if (text === null || text === undefined) return null
  return neutralize(capOutput(String(text), 2_000))
}

async function readRecord(id: string): Promise<SubRecord | null> {
  try {
    return JSON.parse(await fs.readFile(recordPath(id), 'utf8')) as SubRecord
  } catch {
    return null
  }
}

async function writeRecord(rec: SubRecord): Promise<void> {
  await fs.mkdir(subagentsRoot(), { recursive: true })
  await fs.writeFile(recordPath(rec.id), JSON.stringify(rec, null, 2), 'utf8')
}

async function allRecords(): Promise<SubRecord[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(subagentsRoot())
  } catch {
    return []
  }
  const out: SubRecord[] = []
  for (const e of entries) {
    if (!e.endsWith('.json')) continue
    const rec = await readRecord(e.slice(0, -5))
    if (rec) out.push(rec)
  }
  return out
}

/**
 * 3b — is this a `running` child that has gone stale (abandoned by a dead
 * driver)? Keyed on `updatedAt` (the semantic "last activity" — equal to
 * `createdAt` today since children don't heartbeat, but the right field the day
 * one is added). An unparseable timestamp is treated as NOT stale (fail-safe:
 * never reap on a parse glitch).
 */
function isStaleRunning(rec: SubRecord): boolean {
  if (rec.status !== 'running') return false
  const last = Date.parse(rec.updatedAt)
  if (!Number.isFinite(last)) return false
  return Date.now() - last > STALE_SUBAGENT_MS
}

/**
 * 3b — reap abandoned children: flip every stale `running` record to `failed`
 * (in place AND on disk, best-effort) so the cap slot and its session name are
 * genuinely reclaimed and `list`/`status` tell the truth. MUST be called inside
 * the spawn lock so the read-check-write stays atomic. A concurrent `subagent
 * done` from a slow-but-live child races cleanly: whoever writes last wins, and
 * a real completion (done) is the correct final state.
 */
async function reclaimStale(records: SubRecord[]): Promise<void> {
  for (const rec of records) {
    if (!isStaleRunning(rec)) continue
    rec.status = 'failed'
    // The reap reason goes in `note` (metadata), NOT `result` (the child's output,
    // which stays null) — so if this child was only PRESUMED dead and later completes
    // with no --text, its `subagent done` doesn't surface a stale "abandoned…" result.
    rec.note = `abandoned: no completion within ${Math.round(STALE_SUBAGENT_MS / 60_000)}m (driver presumed dead)`
    rec.updatedAt = new Date().toISOString()
    await writeRecord(rec).catch(() => {})
  }
}

/** Highest `sa<N>` in use + 1 (scans existing records so ids never collide). The
 * numeric form lets the atomic-mint loop bump past an id already on disk. */
function nextIdNum(records: SubRecord[]): number {
  let max = 0
  for (const r of records) {
    const m = /^sa(\d+)$/.exec(r.id)
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return max + 1
}

export async function handleSubagent(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  switch (sub) {
    case 'spawn':
      return subagentSpawn(flags)
    case 'wait':
      return subagentWait(flags)
    case 'done':
      return subagentMark(flags, 'done')
    case 'fail':
      return subagentMark(flags, 'failed')
    case 'status':
      return subagentStatus(flags)
    case undefined:
    case 'list':
      return subagentList()
    default:
      return badRequest('usage: silver subagent spawn|wait|done|fail|status|list')
  }
}

async function subagentSpawn(flags: ParsedFlags): Promise<Envelope<unknown>> {
  // Actor sub-gate: spawning provisions an execution unit — require --enable-actions.
  if (!flags.enableActions) return fail('not_permitted')

  // ONE-LEVEL nesting: a child (depth ≥ 1) can never spawn. Enforced via the env
  // the parent handed the child; not a convention — a hard refuse.
  if (currentDepth() >= 1) {
    return badRequest('subagents cannot spawn subagents (one level of nesting only)')
  }

  const prompt = capOutput(flags.args.slice(1).join(' ').trim(), MAX_PROMPT)
  if (!prompt) return badRequest('usage: silver subagent spawn <prompt> [--session c] [--tab] [--background]')

  const tab = flags.tab === true
  // Child session name: explicit --session (non-default) wins; else the child id.
  const explicit = flags.session && flags.session !== 'default' ? flags.session : null
  // Grant model: children default READ-ONLY; --confirm-actions <verbs> is the
  // tool-gated allowlist of actor verbs the child may use.
  const allow = flags.confirmActionsProvided ? [...flags.confirmActions] : []
  const readOnly = allow.length === 0

  // SERIALIZED read-check-write: hold a namespace-scoped advisory lock across the
  // whole cap-count → id-mint → session-clash → write so concurrent same-namespace
  // spawns cannot bypass the CAP, collide on `sa<N>` ids, or duplicate an
  // auto-assigned session. Same-namespace spawns run one-at-a-time; different
  // namespaces never block each other (the lock file lives in the namespace dir).
  return withSessionLock(SPAWN_LOCK_NAME, async () => {
    const records = await allRecords()

    // 3b — reap abandoned children FIRST (a dead driver never called done/fail),
    // so a stale slot is reclaimed instead of wedging the cap forever. In-lock,
    // so the reap + cap-count + clash-check stay atomic.
    await reclaimStale(records)

    // CONCURRENCY CAP: count RUNNING children; refuse the 6th. Post-reclaim, so
    // `running` no longer includes an abandoned child (its status is now failed).
    const running = records.filter((r) => r.status === 'running')
    if (running.length >= CONCURRENCY_CAP) {
      return badRequest(`too many active subagents (limit ${CONCURRENCY_CAP}); wait for one to finish`)
    }

    await fs.mkdir(subagentsRoot(), { recursive: true })

    // Mint the id ATOMICALLY: `fs.open(…, 'wx')` create-if-absent claims the
    // record file; on the (lock-guarded, so near-impossible) EEXIST we bump to
    // the next `sa<N>` and retry. Belt-and-suspenders even if the lock is stolen.
    let n = nextIdNum(records)
    for (;;) {
      const id = `sa${n}`

      const childSession = tab ? flags.session : (explicit ?? id)
      const validSession = sanitizeSegment(childSession)
      if (!validSession) return badRequest('invalid --session name for the child')

      // OWN CONTEXT PER AGENT: an isolated (non-tab) child must not share a
      // session with another RUNNING child — that would share live page/form state.
      if (!tab) {
        const clash = running.some((r) => !r.tab && r.session === validSession)
        if (clash) {
          return badRequest('that session is already owned by a running subagent; each isolated child needs its own browser')
        }
      }

      const now = new Date().toISOString()
      const rec: SubRecord = {
        id,
        description: flags.name ?? null,
        prompt,
        session: validSession,
        tab,
        status: 'running',
        readOnly,
        allow,
        background: flags.background === true,
        depth: 1,
        createdAt: now,
        updatedAt: now,
        result: null,
        resultPath: null,
      }

      try {
        const fh = await fs.open(recordPath(id), 'wx')
        try {
          await fh.writeFile(JSON.stringify(rec, null, 2), 'utf8')
        } finally {
          await fh.close()
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          n++
          continue
        }
        throw err
      }

      // The environment the HOST must set when driving this child, so the child's
      // own `subagent spawn` is refused (one-level enforcement bites downstream).
      const childEnv: Record<string, string> = {
        SILVER_SUBAGENT_DEPTH: '1',
        SILVER_SUBAGENT_ID: id,
      }

      return ok({
        id,
        session: validSession,
        tab,
        background: rec.background,
        readOnly,
        allow,
        childEnv,
        description: rec.description,
        hint: tab
          ? `drive this child in the shared browser: \`silver tab new --session ${validSession}\` then act on its own tab; set env ${envHint(childEnv)}; call \`silver subagent done ${id}\` when finished`
          : `drive this child in its own browser: \`silver <cmd> --session ${validSession}\`${readOnly ? ' (read-only)' : ` (may act: ${allow.join(',')})`}; set env ${envHint(childEnv)}; call \`silver subagent done ${id}\` when finished`,
      })
    }
  })
}

async function subagentWait(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const ids = flags.args.slice(1).map((a) => sanitizeSegment(a)).filter((x): x is string => x !== null)
  if (ids.length === 0) return badRequest('usage: silver subagent wait <id> [<id>…]')

  const budget = Number.isFinite(flags.timeout) && (flags.timeout as number) > 0 ? (flags.timeout as number) : WAIT_DEFAULT_MS
  const deadline = Date.now() + budget

  const results: Array<{
    id: string
    status: string
    timedOut: boolean
    result: string | null
    resultPath: string | null
    description: string | null
  }> = []
  for (const id of ids) {
    let rec = await readRecord(id)
    while (rec && rec.status === 'running' && Date.now() < deadline) {
      await delay(WAIT_POLL_MS)
      rec = await readRecord(id)
    }
    if (!rec) {
      results.push({ id, status: 'unknown', timedOut: false, result: null, resultPath: null, description: null })
      continue
    }
    results.push({
      id,
      status: rec.status,
      timedOut: rec.status === 'running',
      result: present(rec.result),
      resultPath: rec.resultPath ?? null,
      description: rec.description,
    })
  }
  return ok({ results })
}

async function subagentMark(flags: ParsedFlags, status: 'done' | 'failed'): Promise<Envelope<unknown>> {
  const id = sanitizeSegment(flags.args[1])
  if (!id) return badRequest(`usage: silver subagent ${status === 'done' ? 'done' : 'fail'} <id> [--text <result>] [--result-file <path>]`)

  // READ the result payload OUTSIDE the lock (an external `--result-file` read is
  // I/O independent of the record and must not hold the lock), but DEFER the
  // writeResultFile SIDE EFFECT until AFTER the in-lock existence check — else a
  // bogus/typoed id would leave an orphan `<id>.result.txt` on disk.
  //
  // O1 — result-file handoff. `subagent done --text` USED to `capOutput(…,
  // MAX_PROMPT)` and SILENTLY truncate a long result. Now: if `--result-file`
  // is given (host-wired flag `resultFile`, or a trailing positional path), or
  // `--text` exceeds MAX_PROMPT, write the FULL result into the subagents dir
  // and record `resultPath`; `result` keeps only a bounded preview. The parent
  // reads the file only if it needs the whole thing.
  let pending: { content: string; spill: boolean } | null = null
  const explicitFile =
    (flags as ParsedFlags & { resultFile?: string }).resultFile ?? flags.args[2] ?? null
  if (explicitFile) {
    // Path containment (mirrors screenshot/upload/state in core/handlers.ts): a
    // `--result-file` may only be read from INSIDE the working directory. Without
    // this, `subagent done <id> --result-file /etc/passwd` — reachable on the
    // always-available read-only verb path, no --enable-actions — is an
    // unauthenticated arbitrary local file-read. Fail-closed; the path is never
    // echoed (no-leak invariant). A read-only child still reports its own result
    // by writing it inside the project dir, so cwd-containment is the right,
    // consistent boundary — not an actions gate.
    const contained = assertContainedPath(explicitFile)
    if (!contained.ok) return fail('path_denied')
    let content: string
    try {
      content = await fs.readFile(contained.resolved, 'utf8')
    } catch {
      // No path in the error string (no-leak invariant).
      return badRequest('could not read --result-file (no such file or not readable)')
    }
    pending = { content, spill: true } // a --result-file always spills to disk
  } else if (flags.text !== undefined) {
    pending = { content: flags.text, spill: flags.text.length > MAX_PROMPT }
  }

  // 3b — hold the SAME spawn lock across read → mutate → write, so an explicit
  // done/fail cannot be clobbered by a concurrent spawn's `reclaimStale` (which
  // also writes records under this lock). Read the record FRESH inside the lock so
  // we act on the latest state — a reap may have just flipped it to failed.
  return withSessionLock(SPAWN_LOCK_NAME, async () => {
    const rec = await readRecord(id)
    if (!rec) return badRequest('no such subagent; run `subagent list` to see ids')
    if (pending) {
      // Now the record EXISTS — materialize the result (spill to disk only when a
      // file was supplied or the text exceeds MAX_PROMPT), so no orphan file is
      // ever written for a missing id.
      if (pending.spill) {
        rec.resultPath = await writeResultFile(id, pending.content)
        rec.result = capOutput(pending.content, MAX_PROMPT)
      } else {
        rec.result = pending.content
      }
    }
    // An explicit mark is authoritative: clear any reap `note` (a child that
    // answers done/fail was NOT abandoned), so a falsely-reaped-then-revived child
    // never surfaces the stale "abandoned…" reason.
    rec.note = null
    rec.status = status
    rec.updatedAt = new Date().toISOString()
    await writeRecord(rec)
    return ok({ id, status, result: present(rec.result), resultPath: rec.resultPath ?? null })
  })
}

async function subagentStatus(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = sanitizeSegment(flags.args[1])
  if (!id) return badRequest('usage: silver subagent status <id>')
  const rec = await readRecord(id)
  if (!rec) return badRequest('no such subagent; run `subagent list` to see ids')
  return ok(view(rec))
}

async function subagentList(): Promise<Envelope<unknown>> {
  const records = await allRecords()
  records.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  // 3b — report the LIVE count (a stale `running` no longer holds a slot; the
  // next spawn will reap it). Display-only here — the authoritative reap writes
  // under the spawn lock, so `list` never mutates and never races a `done`.
  const running = records.filter((r) => r.status === 'running' && !isStaleRunning(r)).length
  return ok({
    cap: CONCURRENCY_CAP,
    running,
    subagents: records.map(view),
  })
}

function view(rec: SubRecord): Record<string, unknown> {
  return {
    id: rec.id,
    description: rec.description,
    session: rec.session,
    tab: rec.tab,
    status: rec.status,
    // 3b — a `running` child past the TTL is abandoned; surface it so the host
    // sees the truth before the next spawn reaps it. Only ever true on `running`.
    stale: isStaleRunning(rec),
    readOnly: rec.readOnly,
    allow: rec.allow,
    background: rec.background,
    ageMs: Date.now() - Date.parse(rec.createdAt),
    result: present(rec.result),
    resultPath: rec.resultPath ?? null,
    // 3b — the reap reason for an abandoned (stale-reclaimed) child; null otherwise.
    note: rec.note ?? null,
  }
}

function currentDepth(): number {
  const raw = process.env.SILVER_SUBAGENT_DEPTH
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function envHint(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
