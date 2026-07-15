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
})
