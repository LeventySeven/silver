import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import { CONCURRENCY_CAP } from '../../src/orchestration/subagent.js'

const NS = `sub-${process.pid}-${Date.now()}`

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}
async function nuke(ns: string): Promise<void> {
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(ns)), {
    recursive: true,
    force: true,
  }).catch(() => {})
}

afterEach(() => {
  delete process.env.SILVER_SUBAGENT_DEPTH
  delete process.env.SILVER_SUBAGENT_ID
})
afterAll(async () => {
  await nuke(NS)
})

describe('silver subagent — keyless scoped-child orchestration', () => {
  it('spawn is actor-gated: refused without --enable-actions', async () => {
    const denied = await run(['subagent', 'spawn', 'do a thing', '--namespace', NS])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)
  })

  it('spawn reserves an isolated child session + returns the one-level env; never runs a model', async () => {
    const ns = `${NS}-a`
    const s = await run(['subagent', 'spawn', 'research flights', '--enable-actions', '--name', 'research', '--namespace', ns])
    expect(s.env.success).toBe(true)
    const d = data<{ id: string; session: string; readOnly: boolean; childEnv: Record<string, string> }>(s)
    expect(d.id).toBe('sa1')
    expect(d.session).toBe('sa1') // own context: auto session == child id
    expect(d.readOnly).toBe(true) // children default read-only
    expect(d.childEnv.SILVER_SUBAGENT_DEPTH).toBe('1') // one-level enforcement env
    await nuke(ns)
  })

  it('enforces the concurrency CAP (5): the 6th running child is refused, a freed slot re-opens it', async () => {
    const ns = `${NS}-cap`
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      const ok = await run(['subagent', 'spawn', `child ${i}`, '--enable-actions', '--namespace', ns])
      expect(ok.env.success).toBe(true)
    }
    // 6th → refused (limit reached).
    const sixth = await run(['subagent', 'spawn', 'one too many', '--enable-actions', '--namespace', ns])
    expect(sixth.env.success).toBe(false)
    expect(sixth.env.error).toContain('too many active subagents')

    // Free a slot, then a spawn succeeds again.
    const done = await run(['subagent', 'done', 'sa1', '--text', 'finished', '--namespace', ns])
    expect(done.env.success).toBe(true)
    const reopened = await run(['subagent', 'spawn', 'now there is room', '--enable-actions', '--namespace', ns])
    expect(reopened.env.success).toBe(true)
    expect(data<{ id: string }>(reopened).id).toBe('sa6')
    await nuke(ns)
  })

  it('3b: a stale running child (dead driver) is reaped so the cap slot is reclaimed', async () => {
    const ns = `${NS}-stale`
    // Fill the cap.
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      const ok = await run(['subagent', 'spawn', `child ${i}`, '--enable-actions', '--namespace', ns])
      expect(ok.env.success).toBe(true)
    }
    // 6th refused — cap full, no stale children yet.
    const blocked = await run(['subagent', 'spawn', 'blocked', '--enable-actions', '--namespace', ns])
    expect(blocked.env.success).toBe(false)
    expect(blocked.env.error).toContain('too many active subagents')

    // Simulate a DEAD driver: age sa1's record past the TTL (it never called
    // done/fail, so it stays `running` — the exact wedge 3b reclaims). Records are
    // plain JSON on disk (not sidecars), so this is a faithful stand-in for a
    // real 30-min-stale child without waiting.
    const rec1 = path.join(os.homedir(), '.silver', sanitizeNamespace(ns), 'subagents', 'sa1.json')
    const r = JSON.parse(await fs.readFile(rec1, 'utf8')) as { updatedAt: string; status: string }
    r.updatedAt = new Date(Date.now() - 60 * 60_000).toISOString() // 60m ago > 30m TTL
    await fs.writeFile(rec1, JSON.stringify(r, null, 2), 'utf8')

    // list surfaces the staleness (display-only) and drops it from the live count.
    const listed = await run(['subagent', 'list', '--namespace', ns])
    const l = data<{ running: number; subagents: Array<{ id: string; stale: boolean }> }>(listed)
    expect(l.running).toBe(CONCURRENCY_CAP - 1)
    expect(l.subagents.find((s) => s.id === 'sa1')?.stale).toBe(true)

    // The next spawn REAPS sa1 (under the spawn lock) and succeeds — slot reclaimed.
    const reopened = await run(['subagent', 'spawn', 'reclaimed', '--enable-actions', '--namespace', ns])
    expect(reopened.env.success).toBe(true)

    // sa1 is now `failed` (abandoned), no longer wedging the cap; the reason lives
    // in `note` (metadata), NOT `result` (which stays null — it produced no output).
    const after = await run(['subagent', 'list', '--namespace', ns])
    const a = data<{ subagents: Array<{ id: string; status: string; result: string | null; note: string | null }> }>(after)
    const sa1 = a.subagents.find((s) => s.id === 'sa1')
    expect(sa1?.status).toBe('failed')
    expect(sa1?.note).toContain('abandoned')
    expect(sa1?.result).toBeNull()
    await nuke(ns)
  })

  it('3b: a falsely-reaped child that later completes (no --text) shows its real result, not the reap note', async () => {
    const ns = `${NS}-revive`
    await run(['subagent', 'spawn', 'slow child', '--enable-actions', '--namespace', ns])
    // Age it past the TTL and reap it via a subsequent spawn.
    const rec1 = path.join(os.homedir(), '.silver', sanitizeNamespace(ns), 'subagents', 'sa1.json')
    const r = JSON.parse(await fs.readFile(rec1, 'utf8')) as { updatedAt: string }
    r.updatedAt = new Date(Date.now() - 60 * 60_000).toISOString()
    await fs.writeFile(rec1, JSON.stringify(r, null, 2), 'utf8')
    await run(['subagent', 'spawn', 'trigger reap', '--enable-actions', '--namespace', ns])

    // The still-alive child now completes with NO --text. It must come back `done`
    // with a null result and the reap note cleared — never the stale "abandoned…".
    const done = await run(['subagent', 'done', 'sa1', '--namespace', ns])
    expect(done.env.success).toBe(true)
    const listed = await run(['subagent', 'list', '--namespace', ns])
    const sa1 = data<{ subagents: Array<{ id: string; status: string; result: string | null; note: string | null }> }>(listed).subagents.find((s) => s.id === 'sa1')
    expect(sa1?.status).toBe('done')
    expect(sa1?.result).toBeNull()
    expect(sa1?.note).toBeNull()
    await nuke(ns)
  })

  it('CAP + id/session invariants hold under interleaved concurrent spawns (namespace lock)', async () => {
    const ns = `${NS}-race`
    // Fire CAP+4 spawns CONCURRENTLY. Without the namespace-scoped lock the
    // unlocked read-check-write would let >CAP through, collide on sa<N> ids, or
    // duplicate the auto-assigned session. Each uses the default session so the
    // child session is its own id — collisions would be observable as dup sessions.
    const N = CONCURRENCY_CAP + 4
    const settled = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        run(['subagent', 'spawn', `racer ${i}`, '--enable-actions', '--namespace', ns]),
      ),
    )

    const succeeded = settled.filter((r) => r.env.success)
    const failed = settled.filter((r) => !r.env.success)

    // Exactly CAP win; the rest are refused for cap (never a crash / other error).
    expect(succeeded.length).toBe(CONCURRENCY_CAP)
    expect(failed.length).toBe(N - CONCURRENCY_CAP)
    for (const f of failed) expect(f.env.error).toContain('too many active subagents')

    // Ids are unique and are exactly sa1..sa<CAP> (no silent clobber, no dup id).
    const ids = succeeded.map((r) => data<{ id: string }>(r).id)
    expect(new Set(ids).size).toBe(CONCURRENCY_CAP)
    expect([...ids].sort()).toEqual(
      Array.from({ length: CONCURRENCY_CAP }, (_, i) => `sa${i + 1}`).sort(),
    )

    // Each isolated child got its own session (own-context invariant held).
    const sessions = succeeded.map((r) => data<{ session: string }>(r).session)
    expect(new Set(sessions).size).toBe(CONCURRENCY_CAP)

    // The registry agrees: exactly CAP running records persisted, ids all distinct.
    const listed = await run(['subagent', 'list', '--namespace', ns])
    const l = data<{ running: number; subagents: Array<{ id: string }> }>(listed)
    expect(l.running).toBe(CONCURRENCY_CAP)
    expect(new Set(l.subagents.map((s) => s.id)).size).toBe(CONCURRENCY_CAP)
    await nuke(ns)
  })

  it('enforces ONE-LEVEL nesting: a child (SILVER_SUBAGENT_DEPTH=1) cannot spawn', async () => {
    const ns = `${NS}-nest`
    process.env.SILVER_SUBAGENT_DEPTH = '1'
    const denied = await run(['subagent', 'spawn', 'grandchild', '--enable-actions', '--namespace', ns])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toContain('one level of nesting only')
    await nuke(ns)
  })

  it('enforces OWN-CONTEXT: two isolated children may not share a live session', async () => {
    const ns = `${NS}-own`
    const first = await run(['subagent', 'spawn', 'agent A', '--enable-actions', '--session', 'shared', '--namespace', ns])
    expect(first.env.success).toBe(true)
    const clash = await run(['subagent', 'spawn', 'agent B', '--enable-actions', '--session', 'shared', '--namespace', ns])
    expect(clash.env.success).toBe(false)
    expect(clash.env.error).toContain('already owned by a running subagent')
    await nuke(ns)
  })

  it('--tab child shares the browser session but is flagged for its own tab (own DOM)', async () => {
    const ns = `${NS}-tab`
    const s = await run(['subagent', 'spawn', 'tab worker', '--enable-actions', '--tab', '--session', 'shared', '--namespace', ns])
    expect(s.env.success).toBe(true)
    const d = data<{ tab: boolean; session: string }>(s)
    expect(d.tab).toBe(true)
    expect(d.session).toBe('shared')
    await nuke(ns)
  })

  it('--confirm-actions grants the child a scoped actor allowlist (not read-only)', async () => {
    const ns = `${NS}-grant`
    const s = await run(['subagent', 'spawn', 'buyer', '--enable-actions', '--confirm-actions', 'click,fill', '--namespace', ns])
    const d = data<{ readOnly: boolean; allow: string[] }>(s)
    expect(d.readOnly).toBe(false)
    expect(d.allow).toEqual(['click', 'fill'])
    await nuke(ns)
  })

  it('wait blocks until a child is marked terminal, then returns its (scrubbed) result', async () => {
    const ns = `${NS}-wait`
    await run(['subagent', 'spawn', 'quick job', '--enable-actions', '--namespace', ns])
    await run(['subagent', 'done', 'sa1', '--text', 'the answer is 42', '--namespace', ns])
    const w = await run(['subagent', 'wait', 'sa1', '--timeout', '2000', '--namespace', ns])
    expect(w.env.success).toBe(true)
    const r = data<{ results: Array<{ id: string; status: string; result: string; timedOut: boolean }> }>(w)
    expect(r.results[0].status).toBe('done')
    expect(r.results[0].timedOut).toBe(false)
    expect(r.results[0].result).toContain('the answer is 42')
    await nuke(ns)
  })

  it('list reports the cap, running count, and every record', async () => {
    const ns = `${NS}-list`
    await run(['subagent', 'spawn', 'one', '--enable-actions', '--namespace', ns])
    await run(['subagent', 'spawn', 'two', '--enable-actions', '--namespace', ns])
    const listed = await run(['subagent', 'list', '--namespace', ns])
    const l = data<{ cap: number; running: number; subagents: unknown[] }>(listed)
    expect(l.cap).toBe(CONCURRENCY_CAP)
    expect(l.running).toBe(2)
    expect(l.subagents.length).toBe(2)
    await nuke(ns)
  })

  // -------------------------------------------------------------------------
  // O1 — result-file handoff: a long `done --text` result must NOT be silently
  // truncated at MAX_PROMPT; it is written to a file and `resultPath` surfaced.
  // -------------------------------------------------------------------------
  it('O1: a result longer than MAX_PROMPT is written to a file (not truncated) + resultPath surfaced', async () => {
    const ns = `${NS}-big`
    await run(['subagent', 'spawn', 'produce a big report', '--enable-actions', '--namespace', ns])

    // 60k chars — comfortably over MAX_PROMPT (20k). A UNIQUE sentinel near the
    // very end proves the tail was NOT lost to truncation.
    const tail = 'THE_UNTRUNCATED_END_MARKER'
    const big = 'x'.repeat(60_000) + tail

    const done = await run(['subagent', 'done', 'sa1', '--text', big, '--namespace', ns])
    expect(done.env.success).toBe(true)
    const d = data<{ id: string; status: string; result: string; resultPath: string }>(done)
    expect(d.status).toBe('done')
    expect(typeof d.resultPath).toBe('string')
    expect(d.resultPath.length).toBeGreaterThan(0)

    // The FULL, untruncated result is on disk (tail sentinel present, full length).
    const onDisk = await fs.readFile(d.resultPath, 'utf8')
    expect(onDisk.length).toBe(big.length)
    expect(onDisk.endsWith(tail)).toBe(true)

    // list + wait both surface resultPath so the parent can fetch the whole thing.
    const listed = await run(['subagent', 'list', '--namespace', ns])
    const rec = data<{ subagents: Array<{ id: string; resultPath: string | null }> }>(listed).subagents.find(
      (s) => s.id === 'sa1',
    )
    expect(rec?.resultPath).toBe(d.resultPath)

    const waited = await run(['subagent', 'wait', 'sa1', '--timeout', '2000', '--namespace', ns])
    const w = data<{ results: Array<{ id: string; resultPath: string | null }> }>(waited)
    expect(w.results[0].resultPath).toBe(d.resultPath)
    await nuke(ns)
  })

  it('O1: done <nonexistent-id> --result-file (valid in-cwd) fails cleanly and leaves NO orphan result file', async () => {
    const ns = `${NS}-orphan`
    // Note: no spawn — the id does not exist.
    const src = path.join(process.cwd(), `silver-orphan-${process.pid}-${Date.now()}.txt`)
    await fs.writeFile(src, 'a valid, contained result file', 'utf8')

    const done = await run(['subagent', 'done', 'sa999', '--result-file', src, '--namespace', ns])
    expect(done.env.success).toBe(false)
    expect(done.env.error).toContain('no such subagent')

    // The side effect (writeResultFile) must NOT have run for a missing record —
    // no <id>.result.txt orphan under the subagents dir.
    const orphan = path.join(os.homedir(), '.silver', sanitizeNamespace(ns), 'subagents', 'sa999.result.txt')
    await expect(fs.access(orphan)).rejects.toThrow()

    await fs.rm(src, { force: true }).catch(() => {})
    await nuke(ns)
  })

  it('O1: a short result stays inline (no file, resultPath null) — unchanged behavior', async () => {
    const ns = `${NS}-small`
    await run(['subagent', 'spawn', 'quick', '--enable-actions', '--namespace', ns])
    const done = await run(['subagent', 'done', 'sa1', '--text', 'all good', '--namespace', ns])
    const d = data<{ result: string; resultPath: string | null }>(done)
    expect(d.result).toContain('all good')
    expect(d.resultPath).toBeNull()
    await nuke(ns)
  })

  it('O1: --result-file <path> (in-cwd) moves the file into the subagents dir + records resultPath', async () => {
    const ns = `${NS}-rf`
    await run(['subagent', 'spawn', 'file handoff', '--enable-actions', '--namespace', ns])

    // A child legitimately writes its result INSIDE the working dir; that path is
    // contained, so the handoff reads it (see the path-containment guard below).
    const src = path.join(process.cwd(), `silver-result-${process.pid}-${Date.now()}.txt`)
    const body = 'a big external result\n'.repeat(2000) + 'FILE_TAIL_MARKER'
    await fs.writeFile(src, body, 'utf8')

    const done = await run(['subagent', 'done', 'sa1', '--result-file', src, '--namespace', ns])
    expect(done.env.success).toBe(true)
    const d = data<{ resultPath: string }>(done)
    expect(typeof d.resultPath).toBe('string')
    const onDisk = await fs.readFile(d.resultPath, 'utf8')
    expect(onDisk).toBe(body)
    // The stored copy lives under the subagents dir (not the caller's source path).
    expect(d.resultPath).not.toBe(src)
    expect(d.resultPath).toContain(path.join(sanitizeNamespace(ns), 'subagents'))

    await fs.rm(src, { force: true }).catch(() => {})
    await nuke(ns)
  })

  it('O1: --result-file that cannot be read fails cleanly WITHOUT leaking the path', async () => {
    const ns = `${NS}-rfbad`
    await run(['subagent', 'spawn', 'bad file', '--enable-actions', '--namespace', ns])
    const secretPath = path.join(process.cwd(), 'nonexistent-SECRET_PATH_TOKEN', 'result.txt')
    const done = await run(['subagent', 'done', 'sa1', '--result-file', secretPath, '--namespace', ns])
    expect(done.env.success).toBe(false)
    expect(done.env.error).not.toContain('SECRET_PATH_TOKEN')
    await nuke(ns)
  })

  // -------------------------------------------------------------------------
  // SECURITY — `--result-file` path containment. `subagent done`/`fail` are on
  // the always-available read-only verb path (no --enable-actions), so an
  // unrestricted read of `--result-file` is an unauthenticated arbitrary local
  // file-read. The path must resolve inside the working directory or be refused
  // (path_denied) fail-closed, with the path never echoed.
  // -------------------------------------------------------------------------
  it('SEC: --result-file with an out-of-cwd absolute path is refused (path_denied), file not read, no .result.txt', async () => {
    const ns = `${NS}-rfesc`
    await run(['subagent', 'spawn', 'exfil attempt', '--enable-actions', '--namespace', ns])

    // /etc/passwd EXISTS and is readable — so if the guard were missing this WOULD
    // be read. Refusal here proves it's the containment check, not a missing file.
    const done = await run(['subagent', 'done', 'sa1', '--result-file', '/etc/passwd', '--namespace', ns])
    expect(done.env.success).toBe(false)
    expect(done.env.error).toBe(ERRORS.path_denied.message)

    // The refusal is fail-closed: no result recorded, no full-result file persisted.
    const d = data<{ resultPath: string | null } | null>(done)
    expect(d).toBeNull()
    const resultFile = path.join(
      os.homedir(),
      '.silver',
      sanitizeNamespace(ns),
      'subagents',
      'sa1.result.txt',
    )
    await expect(fs.access(resultFile)).rejects.toThrow()

    await nuke(ns)
  })

  it('SEC: --result-file out-of-cwd via a trailing positional path is also refused (path_denied)', async () => {
    const ns = `${NS}-rfpos`
    await run(['subagent', 'spawn', 'exfil attempt 2', '--enable-actions', '--namespace', ns])
    // `subagent done <id> <path>` — the trailing positional is the same read sink.
    const done = await run(['subagent', 'done', 'sa1', '/etc/passwd', '--namespace', ns])
    expect(done.env.success).toBe(false)
    expect(done.env.error).toBe(ERRORS.path_denied.message)
    await nuke(ns)
  })
})
