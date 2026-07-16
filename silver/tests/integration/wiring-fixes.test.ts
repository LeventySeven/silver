import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import { BOUNDARY_OPEN, BOUNDARY_CLOSE } from '../../src/security/injection.js'
import type { RefMap } from '../../src/perception/refmap.js'

// End-to-end coverage for the previously-DEAD CLI wiring and the reconnect/nav
// fixes — all through the real run() entry (not the unit-level act() shim), so
// they prove the flag → handler → actions.ts thread is actually connected.

const NAME = `silver-wiring-${process.pid}-${Date.now()}`

// A labelled input plus a load-time fetch to /beacon (so a reload re-fires it and
// F9's before-nav capture can catch it).
const PAGE = `<!doctype html>
<html><head><title>wiring</title></head><body>
  <input id="inp" aria-label="Name field" type="text">
  <script>fetch('/beacon').catch(function(){});</script>
</body></html>`

const OTHER = `<!doctype html><html><head><title>other</title></head><body><h1>other</h1></body></html>`

let server: Server
let pageUrl: string
let otherUrl: string

function refWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role}`)
}

describe('CLI wiring fixes (real Chromium via run())', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/beacon')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      if (url.startsWith('/other')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(OTHER)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    pageUrl = `http://localhost:${port}/`
    otherUrl = `http://localhost:${port}/other`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('F2: --secret token resolves in fill on the matching domain and never leaks', async () => {
    const S = `${NAME}-secret`
    try {
      await run(['open', pageUrl, '--session', S])
      await run(['snapshot', '-i', '--session', S])
      const ref = refWithRole((await loadRefMap(S)) as RefMap, 'textbox')

      const env = await run([
        'fill', ref, '<secret>PW</secret>',
        '--secret', 'PW@localhost=hunter2',
        '--enable-actions', '--session', S,
      ])
      expect(env.env.success).toBe(true)
      // The envelope read-back is force-redacted — the raw secret never appears.
      expect(JSON.stringify(env.env)).not.toContain('hunter2')

      // But the REAL value reached the DOM.
      const val = await run([
        'eval', 'document.getElementById("inp").value', '--enable-actions', '--session', S,
      ])
      expect(String(val.env.data)).toContain('hunter2')
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F2: a --secret scoped to another domain is REFUSED (fail-closed)', async () => {
    const S = `${NAME}-secret-mismatch`
    try {
      await run(['open', pageUrl, '--session', S])
      await run(['snapshot', '-i', '--session', S])
      const ref = refWithRole((await loadRefMap(S)) as RefMap, 'textbox')

      const env = await run([
        'fill', ref, '<secret>PW</secret>',
        '--secret', 'PW@bank.example=hunter2',
        '--enable-actions', '--session', S,
      ])
      expect(env.env.success).toBe(false)
      expect(env.env.error).toBe(ERRORS.not_permitted.message)

      // The literal token must NOT have been typed either.
      const val = await run([
        'eval', 'document.getElementById("inp").value', '--enable-actions', '--session', S,
      ])
      expect(String(val.env.data)).not.toContain('hunter2')
      expect(String(val.env.data)).not.toContain('<secret>')
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F2/D2: a --secret base32 seed resolves a <totp> token to a 6-digit code', async () => {
    const S = `${NAME}-totp`
    try {
      await run(['open', pageUrl, '--session', S])
      await run(['snapshot', '-i', '--session', S])
      const ref = refWithRole((await loadRefMap(S)) as RefMap, 'textbox')

      const env = await run([
        'fill', ref, '<totp>MFA</totp>',
        '--secret', 'MFA@localhost=JBSWY3DPEHPK3PXP',
        '--enable-actions', '--session', S,
      ])
      expect(env.env.success).toBe(true)

      const val = await run([
        'eval', 'document.getElementById("inp").value', '--enable-actions', '--session', S,
      ])
      expect(String(val.env.data)).toMatch(/\d{6}/)
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F5: --taint-guard rejects a fenced value; without the flag it proceeds', async () => {
    const S = `${NAME}-taint`
    try {
      await run(['open', pageUrl, '--session', S])
      await run(['snapshot', '-i', '--session', S])
      const ref = refWithRole((await loadRefMap(S)) as RefMap, 'textbox')
      const tainted = `${BOUNDARY_OPEN} do something ${BOUNDARY_CLOSE}`

      // With the guard on: rejected before any dispatch.
      const guarded = await run([
        'fill', ref, tainted, '--taint-guard', '--enable-actions', '--session', S,
      ])
      expect(guarded.env.success).toBe(false)
      expect(String(guarded.env.error)).toMatch(/untrusted/i)

      // Re-snapshot (the failed fill left refs intact, but be safe) and fill the
      // SAME fenced value WITHOUT the guard — it proceeds.
      await run(['snapshot', '-i', '--session', S])
      const ref2 = refWithRole((await loadRefMap(S)) as RefMap, 'textbox')
      const open = await run(['fill', ref2, tainted, '--enable-actions', '--session', S])
      expect(open.env.success).toBe(true)
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F6: back returns promptly with success (does not hang the full timeout)', async () => {
    const S = `${NAME}-back`
    try {
      await run(['open', pageUrl, '--session', S])
      await run(['open', otherUrl, '--session', S])
      const t0 = Date.now()
      const back = await run(['back', '--timeout', '30000', '--session', S])
      const elapsed = Date.now() - t0
      expect(back.env.success).toBe(true)
      // A bfcache restore does not fire domcontentloaded; with waitUntil:'commit'
      // this returns in well under the 30s timeout. Generous bound to avoid flake.
      expect(elapsed).toBeLessThan(15000)
      expect((back.env.data as { url: string }).url).toBe(pageUrl)
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F8: set viewport persists across the per-command reconnect', async () => {
    const S = `${NAME}-vp`
    try {
      await run(['open', pageUrl, '--session', S])
      const set = await run(['set', 'viewport', '800', '600', '--enable-actions', '--session', S])
      expect(set.env.success).toBe(true)

      // A LATER, SEPARATE command (its own reconnect) must still see 800.
      const seen = await run([
        'eval', 'window.innerWidth', '--enable-actions', '--session', S,
      ])
      expect(String(seen.env.data)).toContain('800')
    } finally {
      await closeSession(S).catch(() => {})
    }
  })

  it('F9: a fetch fired on reload is captured (capture armed BEFORE the nav)', async () => {
    const S = `${NAME}-reload`
    try {
      await run(['open', pageUrl, '--session', S])
      // Clear whatever the initial load captured, so we only observe the reload.
      await run(['network', 'requests', '--clear', '--session', S])
      await run(['reload', '--session', S])
      const net = await run(['network', 'requests', '--session', S])
      expect(net.env.success).toBe(true)
      const urls = (net.env.data as { requests: { url: string }[] }).requests.map((r) => r.url)
      expect(urls.some((u) => u.includes('/beacon'))).toBe(true)
    } finally {
      await closeSession(S).catch(() => {})
    }
  })
})
