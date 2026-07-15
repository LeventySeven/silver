import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-tabs-${process.pid}-${Date.now()}`

// Two distinguishable pages served over localhost (raw-IP / data: are denied by
// the egress guard — localhost is the allowed hostname form).
function pageHtml(heading: string): string {
  return `<!doctype html><html><body><h1>${heading}</h1></body></html>`
}

let server: Server
let base: string

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

describe('multi-tab on real Chromium (open/list/switch/close via run())', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const heading = req.url?.startsWith('/b') ? 'Bravo' : 'Alpha'
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(pageHtml(heading))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://localhost:${port}`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it(
    'opens a 2nd tab, lists stable ids, switches the active tab, and closes one',
    async () => {
      // --- open the first page: this becomes tab t1 (implicitly) ---
      const opened = await run(['open', `${base}/a`, '--session', NAME])
      expect(opened.env.success).toBe(true)

      // --- tab new <url> --label docs → a second tab, made active ---
      const created = await run(['tab', 'new', `${base}/b`, '--label', 'docs', '--session', NAME])
      expect(created.env.success).toBe(true)
      const c = data<{ tabId: string; label: string | null; total: number }>(created)
      expect(c.tabId).toBe('t2')
      expect(c.label).toBe('docs')
      expect(c.total).toBe(2)

      // --- tab list → two tabs with STABLE ids, t2 active + labelled ---
      const listed = await run(['tab', 'list', '--session', NAME])
      const l = data<{
        tabs: Array<{ tabId: string; label: string | null; url: string; active: boolean }>
        active: string
      }>(listed)
      expect(l.tabs.map((t) => t.tabId)).toEqual(['t1', 't2'])
      expect(l.active).toBe('t2')
      const t2 = l.tabs.find((t) => t.tabId === 't2')!
      expect(t2.label).toBe('docs')
      expect(t2.active).toBe(true)
      expect(t2.url).toContain('/b')

      // --- snapshot -i operates on the ACTIVE tab (t2 → Bravo) ---
      const snapB = await run(['snapshot', '-i', '--session', NAME])
      expect(String(snapB.env.data)).toContain('Bravo')
      expect(String(snapB.env.data)).not.toContain('Alpha')

      // --- switch back to t1 by id → snapshot now sees Alpha ---
      const sw1 = await run(['tab', 't1', '--session', NAME])
      expect(sw1.env.success).toBe(true)
      expect(data<{ tabId: string }>(sw1).tabId).toBe('t1')
      const snapA = await run(['snapshot', '-i', '--session', NAME])
      expect(String(snapA.env.data)).toContain('Alpha')
      expect(String(snapA.env.data)).not.toContain('Bravo')

      // --- switch to t2 BY LABEL → active flips back ---
      const swDocs = await run(['tab', 'docs', '--session', NAME])
      expect(data<{ tabId: string }>(swDocs).tabId).toBe('t2')

      // --- close t2 → t1 becomes active, one tab remains ---
      const closed = await run(['tab', 'close', 't2', '--session', NAME])
      const cl = data<{ closed: string; active: string; total: number }>(closed)
      expect(cl.closed).toBe('t2')
      expect(cl.active).toBe('t1')
      expect(cl.total).toBe(1)

      const listed2 = await run(['tab', 'list', '--session', NAME])
      const l2 = data<{ tabs: unknown[]; active: string }>(listed2)
      expect(l2.tabs).toHaveLength(1)
      expect(l2.active).toBe('t1')
    },
  )

  it('refuses a duplicate label and rejects switching to an unknown tab', async () => {
    // t1 already open from the previous test's teardown? No — fresh browser here
    // would be a new session; reuse NAME's live browser which now has only t1.
    const dupOpen = await run(['tab', 'new', `${base}/a`, '--label', 'work', '--session', NAME])
    expect(dupOpen.env.success).toBe(true)
    const dup = await run(['tab', 'new', `${base}/b`, '--label', 'work', '--session', NAME])
    expect(dup.env.success).toBe(false)
    expect(dup.env.error).toMatch(/label is already used/i)

    const bad = await run(['tab', 'tX', '--session', NAME])
    expect(bad.env.success).toBe(false)
    expect(bad.env.error).toMatch(/no such tab/i)
  })
})
