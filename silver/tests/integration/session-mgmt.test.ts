import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace } from '../../src/core/session.js'

const SUFFIX = `${process.pid}-${Date.now()}`
// Every destructive `session gc` here runs inside a UNIQUE namespace so it only
// ever scans a private root — it can never reap a sibling test's session dir
// that is mid-spawn (vitest runs test files in parallel over one ~/.silver).
const NS_GC = `gc-${SUFFIX}`
const NS_A = `alpha-${SUFFIX}`
const NS_B = `beta-${SUFFIX}`

const LIVE = 'live'
const STALE = 'stale'
const ORPHAN = 'orphan'

const PAGE = `<!doctype html><html><body><h1>Session Mgmt</h1></body></html>`

function nsRoot(ns: string): string {
  return path.join(os.homedir(), '.silver', sanitizeNamespace(ns), 'sessions')
}
function nsSessionJson(ns: string, session: string): string {
  return path.join(nsRoot(ns), session, 'session.json')
}

let server: Server
let base: string

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

describe('session list / gc + namespace isolation (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    await run(['close', '--session', LIVE, '--namespace', NS_GC]).catch(() => {})
    await run(['close', '--session', 'shared', '--namespace', NS_A]).catch(() => {})
    await run(['close', '--session', 'shared', '--namespace', NS_B]).catch(() => {})
    for (const ns of [NS_GC, NS_A, NS_B]) {
      await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(ns)), {
        recursive: true,
        force: true,
      }).catch(() => {})
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('session list reports liveness + tab count; gc reaps dead + orphan dirs, keeps live', async () => {
    // --- a genuinely live session (in the private gc namespace) ---
    const opened = await run(['open', base, '--session', LIVE, '--namespace', NS_GC])
    expect(opened.env.success).toBe(true)

    // --- a STALE session dir: valid sidecar but a dead pid ---
    const staleDir = path.join(nsRoot(NS_GC), STALE)
    await fs.mkdir(staleDir, { recursive: true })
    await fs.writeFile(
      path.join(staleDir, 'session.json'),
      JSON.stringify({
        port: 1,
        pid: 2147483646, // never a live process here
        wsEndpoint: 'ws://127.0.0.1:1/devtools/browser/none',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    )
    // --- an ORPHAN dir: no session.json at all ---
    await fs.mkdir(path.join(nsRoot(NS_GC), ORPHAN), { recursive: true })

    // --- session list: the live one present + alive; the stale one dead ---
    const listed = await run(['session', 'list', '--namespace', NS_GC])
    const l = data<{
      namespace: string
      sessions: Array<{ name: string; alive: boolean | null; tabs: number }>
    }>(listed)
    expect(l.namespace).toBe(sanitizeNamespace(NS_GC))
    const live = l.sessions.find((s) => s.name === LIVE)
    const stale = l.sessions.find((s) => s.name === STALE)
    expect(live?.alive).toBe(true)
    expect(live!.tabs).toBeGreaterThanOrEqual(1)
    expect(stale?.alive).toBe(false)
    // The orphan (no sidecar) is not a listable session.
    expect(l.sessions.find((s) => s.name === ORPHAN)).toBeUndefined()

    // --- session gc: reaps the dead + orphan dirs, keeps the live one ---
    const gc = await run(['session', 'gc', '--namespace', NS_GC])
    const g = data<{ removed: string[]; kept: string[] }>(gc)
    expect(g.removed).toContain(STALE)
    expect(g.removed).toContain(ORPHAN)
    expect(g.kept).toContain(LIVE)

    expect(existsSync(staleDir)).toBe(false)
    expect(existsSync(path.join(nsRoot(NS_GC), ORPHAN))).toBe(false)
    expect(existsSync(path.join(nsRoot(NS_GC), LIVE))).toBe(true)
  })

  it('namespaces isolate identical --session names into separate roots', async () => {
    // Same session name "shared" in two different namespaces = two browsers.
    const a = await run(['open', base, '--session', 'shared', '--namespace', NS_A])
    const b = await run(['open', base, '--session', 'shared', '--namespace', NS_B])
    expect(a.env.success).toBe(true)
    expect(b.env.success).toBe(true)

    // On-disk: each lives under its own ~/.silver/<ns>/sessions/shared path.
    expect(existsSync(nsSessionJson(NS_A, 'shared'))).toBe(true)
    expect(existsSync(nsSessionJson(NS_B, 'shared'))).toBe(true)

    // session list is scoped to the current namespace: each shows ONLY its own
    // "shared" session (the unique ns guarantees no bleed from other tests).
    const listA = await run(['session', 'list', '--namespace', NS_A])
    const la = data<{ namespace: string; sessions: Array<{ name: string; pid?: number }> }>(listA)
    expect(la.namespace).toBe(sanitizeNamespace(NS_A))
    expect(la.sessions.map((s) => s.name)).toEqual(['shared'])

    const listB = await run(['session', 'list', '--namespace', NS_B])
    const lb = data<{ sessions: Array<{ name: string; pid?: number }> }>(listB)
    expect(lb.sessions.map((s) => s.name)).toEqual(['shared'])

    // Isolation proof: the two "shared" sessions are distinct browsers (pids).
    expect(la.sessions[0].pid).toBeTruthy()
    expect(lb.sessions[0].pid).toBeTruthy()
    expect(la.sessions[0].pid).not.toBe(lb.sessions[0].pid)
  })
})
