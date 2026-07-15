import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { openSession, closeSession, readSidecar, setNamespace } from '../../src/core/session.js'

const SUFFIX = `${process.pid}-${Date.now()}`
// A private namespace so this test's `session gc` only scans its own root and
// never reaps a sibling test's mid-spawn session dir. Every run() call passes
// --namespace; the direct openSession/readSidecar/closeSession calls rely on the
// module namespace, which we pin in beforeAll.
const NS = `conn-${SUFFIX}`
const PROVIDER = 'provider' // the browser someone else launched
const ATTACHED = 'attached' // our session, attached over CDP

const PAGE = `<!doctype html><html><body><h1>Shared Browser</h1></body></html>`

let server: Server
let base: string

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

describe('connect: attach a --session to an already-running CDP browser', () => {
  beforeAll(async () => {
    setNamespace(NS) // pin direct session.ts calls to the private root
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    setNamespace(NS)
    // Close the attached (external) session first — it must NOT kill the shared
    // browser — then tear down the provider that actually owns the process.
    await run(['close', '--session', ATTACHED, '--namespace', NS]).catch(() => {})
    await closeSession(PROVIDER).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it(
    'attaches over the CDP ws endpoint, opens its own tab, and is marked external',
    async () => {
      // --- someone else launches a browser (we grab its ws endpoint) ---
      const info = await openSession(PROVIDER, { headed: false })
      expect(info.wsEndpoint.startsWith('ws')).toBe(true)

      // --- our session ATTACHES to that endpoint instead of spawning ---
      const connected = await run(['connect', info.wsEndpoint, '--session', ATTACHED, '--namespace', NS])
      expect(connected.env.success).toBe(true)
      expect(data<{ external: boolean }>(connected).external).toBe(true)

      // --- the attached session drives its OWN tab in the shared browser ---
      const created = await run(['tab', 'new', base, '--label', 'mine', '--session', ATTACHED, '--namespace', NS])
      expect(created.env.success).toBe(true)

      const snap = await run(['snapshot', '-i', '--session', ATTACHED, '--namespace', NS])
      expect(String(snap.env.data)).toContain('Shared Browser')

      // --- the sidecar records it as external with no owned pid ---
      const sidecar = await readSidecar(ATTACHED)
      expect(sidecar.external).toBe(true)
      expect(sidecar.pid).toBe(0)

      // --- session list reports it external with unverifiable liveness ---
      const listed = await run(['session', 'list', '--namespace', NS])
      const row = data<{ sessions: Array<{ name: string; external: boolean; alive: boolean | null }> }>(
        listed,
      ).sessions.find((s) => s.name === ATTACHED)
      expect(row?.external).toBe(true)
      expect(row?.alive).toBeNull()

      // --- gc must NOT reap an external session (we don't own the process) ---
      const gc = await run(['session', 'gc', '--namespace', NS])
      expect(data<{ kept: string[] }>(gc).kept).toContain(ATTACHED)
    },
  )
})
