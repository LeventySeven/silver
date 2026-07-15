import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `moxxie-cli-${process.pid}-${Date.now()}`

// A page with a heading, a text input, and a button that MUTATES the DOM on
// click (appends a node → domNodeCount changes → the page-change fingerprint
// changes → page_changed:true). Served over http://localhost so the egress
// denylist permits it (a raw 127.0.0.1 literal would be DENIED by design; a
// data: URL is denied too — that is the point of the egress guard).
const PAGE = `<!doctype html>
<html><body>
  <h1>UAB Test Page</h1>
  <input id="name" type="text" aria-label="Your name">
  <button id="go" onclick="var d=document.createElement('div');d.className='clicked';d.textContent='clicked';document.body.appendChild(d);">Go</button>
</body></html>`

let server: Server
let pageUrl: string

function firstRefWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role} in refmap`)
}

describe('cli dispatcher (real Chromium via the run() entry)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    // Navigate by HOSTNAME (localhost), not the raw IP the denylist blocks.
    pageUrl = `http://localhost:${port}/`
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
    'open → snapshot -i shows @ref grounding; click is quarantined then enabled; --json is a valid envelope; file: is blocked',
    async () => {
      // --- open (read-only verb, allowed) ---
      const opened = await run(['open', pageUrl, '--session', NAME])
      expect(opened.env.success).toBe(true)
      expect(opened.code).toBe(0)

      // --- snapshot -i → the output carries grounded refs (ref=eN) ---
      const snap = await run(['snapshot', '-i', '--session', NAME])
      expect(snap.env.success).toBe(true)
      expect(typeof snap.env.data).toBe('string')
      expect(snap.env.data as string).toContain('ref=e')

      // --- click WITHOUT --enable-actions → phase quarantine denies it ---
      const denied = await run(['click', '@e1', '--session', NAME])
      expect(denied.env.success).toBe(false)
      expect(denied.env.error).toBe(ERRORS.not_permitted.message)
      expect(denied.code).toBe(1)

      // --- click the button WITH --enable-actions → it acts, and the
      //     response carries the page-change contract (page_changed:true) ---
      const map = await loadRefMap(NAME)
      expect(map).not.toBeNull()
      const buttonRef = firstRefWithRole(map as RefMap, 'button')

      const clicked = await run([
        'click',
        `@${buttonRef}`,
        '--enable-actions',
        '--session',
        NAME,
      ])
      expect(clicked.env.success).toBe(true)
      const data = clicked.env.data as { page_changed?: boolean; generation?: number }
      expect(data.page_changed).toBe(true)
      expect(typeof data.generation).toBe('number')

      // --- --json snapshot returns a well-formed {success,data,error} envelope ---
      const jsonSnap = await run(['--json', 'snapshot', '--session', NAME])
      expect(jsonSnap.json).toBe(true)
      const roundTripped = JSON.parse(JSON.stringify(jsonSnap.env)) as Record<string, unknown>
      expect(roundTripped).toHaveProperty('success')
      expect(roundTripped).toHaveProperty('data')
      expect(roundTripped).toHaveProperty('error')
      expect(roundTripped.success).toBe(true)

      // --- open file:///etc/passwd on DEFAULT flags → navigation_blocked ---
      const blocked = await run(['open', 'file:///etc/passwd', '--session', NAME])
      expect(blocked.env.success).toBe(false)
      expect(blocked.env.error).toBe(ERRORS.navigation_blocked.message)
    },
  )
})
