import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome, setNamespace } from '../../src/core/session.js'
import { loadTabRegistry } from '../../src/core/tabs.js'

/**
 * The human-tab guard, end to end against a real Chromium.
 *
 * An EXTERNAL (`connect`ed) session attaches to a browser Silver does not own —
 * in practice the user's own, full of their live work. Silver may drive it, but
 * it may not destroy a tab it did not create. This is the regression test for a
 * real near-miss: a `connect`ed session's registry held 21 of the user's tabs
 * (Gmail, an iHerb checkout cart, a half-filled Hetzner form) with `tab close`
 * guarded only by "don't close the last one".
 *
 * The setup mirrors that shape: session A spawns a browser and opens tabs (they
 * stand in for the human's), then session B `connect`s to the same browser as an
 * external session — exactly what an agent does to a real browser.
 */

const SUFFIX = `${process.pid}-${Date.now()}`
const NS = `tabown-${SUFFIX}`
const PAGE = `<!doctype html><html><body><h1>tab ownership</h1></body></html>`

let server: Server
let base: string
let endpoint = ''

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

describe('tab ownership guard (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`

    // "The human's browser": an owned session with two tabs already in it.
    const opened = await run(['open', base, '--session', 'host', '--namespace', NS])
    expect(opened.env.success).toBe(true)
    await run(['tab', 'new', base, '--session', 'host', '--namespace', NS])

    setNamespace(NS)
    const { readSidecar } = await import('../../src/core/session.js')
    endpoint = (await readSidecar('host')).wsEndpoint
    setNamespace('')
  })

  afterAll(async () => {
    await run(['close', '--all', '--namespace', NS]).catch(() => {})
    await fs
      .rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true })
      .catch(() => {})
    setNamespace('')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('a connected session owns NOTHING it merely discovered', async () => {
    const res = await run(['connect', endpoint, '--session', 'guest', '--namespace', NS])
    expect(res.env.success).toBe(true)

    setNamespace(NS)
    const reg = await loadTabRegistry('guest')
    setNamespace('')

    expect(reg!.tabs.length).toBeGreaterThanOrEqual(2)
    // Every one of them arrived via discovery, so none may be claimed.
    expect(reg!.tabs.filter((t) => t.owned === true)).toHaveLength(0)
    // …and the browser instance is recorded, which is what scopes any later claim.
    expect(reg!.browserGuid).toMatch(/^[0-9a-fA-F-]+$/)
  })

  it('REFUSES to close a discovered tab in an external session', async () => {
    const before = data<{ tabs: unknown[] }>(
      await run(['tab', 'list', '--session', 'guest', '--namespace', NS]),
    ).tabs.length

    const res = await run(['tab', 'close', 't1', '--session', 'guest', '--namespace', NS])

    expect(res.env.success).toBe(false)
    expect(String(res.env.error)).toContain('did not open')
    // The tab is still there — the refusal is real, not cosmetic.
    const after = data<{ tabs: unknown[] }>(
      await run(['tab', 'list', '--session', 'guest', '--namespace', NS]),
    ).tabs.length
    expect(after).toBe(before)
  })

  it('ALLOWS closing a tab the external session opened itself', async () => {
    // The escape valve: Silver is not locked out of the browser, only out of
    // other people's tabs. A tab it created is its own to clean up.
    const created = await run(['tab', 'new', base, '--session', 'guest', '--namespace', NS])
    expect(created.env.success).toBe(true)
    const tabId = data<{ tabId: string }>(created).tabId

    setNamespace(NS)
    const reg = await loadTabRegistry('guest')
    setNamespace('')
    expect(reg!.tabs.find((t) => t.id === tabId)?.owned).toBe(true)

    const closed = await run(['tab', 'close', tabId, '--session', 'guest', '--namespace', NS])
    expect(closed.env.success).toBe(true)
  })

  it('an OWNED session may still close any of its own tabs', async () => {
    // The guard is scoped to external sessions: a browser Silver spawned is
    // entirely its own, and nothing here should have changed for it.
    const created = await run(['tab', 'new', base, '--session', 'host', '--namespace', NS])
    expect(created.env.success).toBe(true)
    const res = await run(['tab', 'close', 't1', '--session', 'host', '--namespace', NS])
    expect(res.env.success).toBe(true)
  })
})
