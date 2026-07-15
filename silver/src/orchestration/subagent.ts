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
import { nsRoot, sanitizeSegment } from '../core/nsdirs.js'
import { neutralize, capOutput } from '../security/injection.js'

export const SUBAGENTS_SUB = 'subagents'

/** Aside's default: at most 5 concurrent children under one parent/namespace. */
export const CONCURRENCY_CAP = 5
const MAX_PROMPT = 20_000
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
}

function subagentsRoot(): string {
  return nsRoot(SUBAGENTS_SUB)
}
function recordPath(id: string): string {
  return path.join(subagentsRoot(), `${id}.json`)
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

/** Next free `sa<N>` id (scans existing records so ids never collide). */
function nextId(records: SubRecord[]): string {
  let max = 0
  for (const r of records) {
    const m = /^sa(\d+)$/.exec(r.id)
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return `sa${max + 1}`
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

  const records = await allRecords()

  // CONCURRENCY CAP: count RUNNING children; refuse the 6th.
  const running = records.filter((r) => r.status === 'running')
  if (running.length >= CONCURRENCY_CAP) {
    return badRequest(`too many active subagents (limit ${CONCURRENCY_CAP}); wait for one to finish`)
  }

  const id = nextId(records)
  const tab = flags.tab === true

  // Child session name: explicit --session (non-default) wins; else the child id.
  const explicit = flags.session && flags.session !== 'default' ? flags.session : null
  const childSession = tab ? flags.session : (explicit ?? id)
  const validSession = sanitizeSegment(childSession)
  if (!validSession) return badRequest('invalid --session name for the child')

  // OWN CONTEXT PER AGENT: an isolated (non-tab) child must not share a session
  // with another RUNNING child — that would share live page/form state.
  if (!tab) {
    const clash = running.some((r) => !r.tab && r.session === validSession)
    if (clash) {
      return badRequest('that session is already owned by a running subagent; each isolated child needs its own browser')
    }
  }

  // Grant model: children default READ-ONLY; --confirm-actions <verbs> is the
  // tool-gated allowlist of actor verbs the child may use.
  const allow = flags.confirmActionsProvided ? [...flags.confirmActions] : []
  const readOnly = allow.length === 0

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
  }
  await writeRecord(rec)

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

async function subagentWait(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const ids = flags.args.slice(1).map((a) => sanitizeSegment(a)).filter((x): x is string => x !== null)
  if (ids.length === 0) return badRequest('usage: silver subagent wait <id> [<id>…]')

  const budget = Number.isFinite(flags.timeout) && (flags.timeout as number) > 0 ? (flags.timeout as number) : WAIT_DEFAULT_MS
  const deadline = Date.now() + budget

  const results: Array<{ id: string; status: string; timedOut: boolean; result: string | null; description: string | null }> = []
  for (const id of ids) {
    let rec = await readRecord(id)
    while (rec && rec.status === 'running' && Date.now() < deadline) {
      await delay(WAIT_POLL_MS)
      rec = await readRecord(id)
    }
    if (!rec) {
      results.push({ id, status: 'unknown', timedOut: false, result: null, description: null })
      continue
    }
    results.push({
      id,
      status: rec.status,
      timedOut: rec.status === 'running',
      result: present(rec.result),
      description: rec.description,
    })
  }
  return ok({ results })
}

async function subagentMark(flags: ParsedFlags, status: 'done' | 'failed'): Promise<Envelope<unknown>> {
  const id = sanitizeSegment(flags.args[1])
  if (!id) return badRequest(`usage: silver subagent ${status === 'done' ? 'done' : 'fail'} <id> [--text <result>]`)
  const rec = await readRecord(id)
  if (!rec) return badRequest('no such subagent; run `subagent list` to see ids')
  rec.status = status
  rec.result = flags.text !== undefined ? capOutput(flags.text, MAX_PROMPT) : rec.result
  rec.updatedAt = new Date().toISOString()
  await writeRecord(rec)
  return ok({ id, status, result: present(rec.result) })
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
  const running = records.filter((r) => r.status === 'running').length
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
    readOnly: rec.readOnly,
    allow: rec.allow,
    background: rec.background,
    ageMs: Date.now() - Date.parse(rec.createdAt),
    result: present(rec.result),
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
