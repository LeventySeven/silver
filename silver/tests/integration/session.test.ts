import { describe, it, expect, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  openSession,
  connect,
  closeSession,
  saveRefMap,
  loadRefMap,
  sessionDir,
  setFetchEgressPolicy,
} from '../../src/core/session.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-it-${process.pid}-${Date.now()}`

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('session lifecycle (real Chromium, detached, CDP reconnect)', () => {
  afterAll(async () => {
    // Belt-and-suspenders cleanup even if an assertion above threw.
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'LOAD-BEARING: detached browser survives across two separate connect() calls',
    async () => {
      // --- open: spawns a DETACHED Chromium; the CLI-side spawn is unref'd ---
      const info = await openSession(NAME, { headed: false })
      expect(info.pid).toBeGreaterThan(0)
      expect(info.port).toBeGreaterThan(0)
      expect(info.wsEndpoint.startsWith('ws')).toBe(true)
      expect(existsSync(sessionDir(NAME))).toBe(true)

      // --- connect #1 (fresh CDP session): navigate, then DISCONNECT only ---
      {
        const { browser, page } = await connect(NAME)
        await page.goto('data:text/html,<h1>hi</h1>')
        // browser.close() on a connectOverCDP browser only drops the CDP
        // transport; the detached browser process keeps running.
        await browser.close()
      }

      // --- connect #2 (a SEPARATE connect): the browser must still be alive,
      // and it must still hold the page state from connect #1 ---
      {
        const { browser, page } = await connect(NAME)
        const text = await page.evaluate(
          () => document.querySelector('h1')?.textContent ?? '',
        )
        expect(text).toBe('hi')
        await browser.close()
      }

      // --- refmap sidecar round-trips across "commands" ---
      const map: RefMap = {
        generation: 1,
        entries: {
          e1: {
            generation: 1,
            backendNodeId: 7,
            role: 'button',
            name: 'Go',
            nth: 0,
            frameId: 'main',
          },
        },
      }
      await saveRefMap(NAME, map)
      const loaded = await loadRefMap(NAME)
      expect(loaded).toEqual(map)

      // --- close: kills the detached process and removes the sidecar dir ---
      await closeSession(NAME)
      expect(existsSync(sessionDir(NAME))).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// S2: CDP Fetch-layer subresource egress guard — closes the exfil hole where a
// page on an allowed domain beacons to any host via fetch()/<img>/XHR.
// ---------------------------------------------------------------------------
describe('S2: CDP Fetch-layer subresource egress', () => {
  const SNAME = `${NAME}-fetch`
  let server: Server
  let hits: Set<string>
  let base = ''

  afterAll(async () => {
    setFetchEgressPolicy({ allowFile: false, allowedDomains: [] })
    try {
      await closeSession(SNAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it(
    'blocks a subresource to a non-allowed host (raw-IP + allowlist) while normal subresources load',
    async () => {
      hits = new Set<string>()
      server = createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0]
        hits.add(url)
        if (url.startsWith('/page')) {
          const port = (server.address() as AddressInfo).port
          // Same-origin fetch (/allowed) must pass; a cross-origin fetch to the
          // raw-IP host (127.0.0.1) is a would-be exfil beacon that the Fetch
          // guard must BLOCK (raw-IP literals are denied by the egress policy).
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(
            `<!doctype html><meta charset=utf8><body>hi<script>
              fetch('/allowed').catch(()=>{});
              fetch('http://127.0.0.1:${port}/blocked').catch(()=>{});
            </script></body>`,
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      base = `http://localhost:${port}`

      // Default policy: raw-IP subresources are denied, localhost http is allowed.
      setFetchEgressPolicy({ allowFile: false, allowedDomains: [] })
      await openSession(SNAME, { headed: false })
      const { browser, page } = await connect(SNAME)
      try {
        await page.goto(`${base}/page`, { waitUntil: 'load' })
        // Give the async subresource fetches time to fire / be intercepted.
        for (let i = 0; i < 30 && !hits.has('/allowed'); i++) await delay(100)
        await delay(300)
      } finally {
        await browser.close()
      }

      // The top-level document loaded and the same-origin subresource passed…
      expect(hits.has('/page')).toBe(true)
      expect(hits.has('/allowed')).toBe(true)
      // …but the cross-origin raw-IP beacon was blocked BEFORE reaching the server.
      expect(hits.has('/blocked')).toBe(false)
    },
  )

  it(
    'with --allowed-domains set, a normally-reachable subresource host is blocked',
    async () => {
      hits.clear()
      // Restrict subresources to example.com — the localhost page's own
      // same-origin fetch is now OFF-allowlist and must be blocked.
      setFetchEgressPolicy({ allowFile: false, allowedDomains: ['example.com'] })
      const { browser, page } = await connect(SNAME)
      try {
        await page.goto(`${base}/page2`, { waitUntil: 'load' })
        await delay(600)
      } finally {
        await browser.close()
      }
      // Document navigation still loads (nav path owns navigations)…
      expect(hits.has('/page2')).toBe(true)
      // …but the subresource fetch to the non-allowlisted localhost host is blocked.
      expect(hits.has('/allowed')).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// E2: real-Chrome-profile launch — `--profile <path>` reuses an EXISTING
// user-data-dir instead of a throwaway one (the truest keyless auth).
// ---------------------------------------------------------------------------
describe('E2: --profile launches against an existing user-data-dir', () => {
  const PNAME = `${NAME}-profile`
  let profileDir = ''

  afterAll(async () => {
    try {
      await closeSession(PNAME)
    } catch {
      /* ignore */
    }
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'reuses the provided profile dir (records it + populates it, never a throwaway)',
    async () => {
      profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-profile-'))
      // A marker the launch must leave untouched (proves reuse, not recreate).
      await fs.writeFile(path.join(profileDir, 'MARKER'), 'keep')

      const info = await openSession(PNAME, { headed: false, profile: profileDir })
      // The session records the passed profile as its user-data-dir…
      expect(info.userDataDir).toBe(profileDir)
      // …and Chromium actually launched against it (wrote its profile there),
      // NOT into a throwaway `<sessionDir>/profile`.
      expect(existsSync(path.join(profileDir, 'DevToolsActivePort'))).toBe(true)
      expect(existsSync(path.join(sessionDir(PNAME), 'profile'))).toBe(false)
      // The pre-existing marker survived (the dir was reused, not wiped).
      expect(existsSync(path.join(profileDir, 'MARKER'))).toBe(true)

      await closeSession(PNAME)
    },
  )
})

// ---------------------------------------------------------------------------
// BUG #9: a browser SIGKILL/crash leaves a STALE DevToolsActivePort in the
// profile dir. `openSession` must delete it BEFORE spawn so `waitForDevToolsPort`
// only ever reads the freshly-spawned browser's port (not the dead one), else the
// auto-respawn reconnects to a dead port and permanently wedges the session.
// ---------------------------------------------------------------------------
describe('BUG #9: openSession clears a stale DevToolsActivePort before spawn', () => {
  const RNAME = `${NAME}-stale-port`
  const profileDir = path.join(sessionDir(RNAME), 'profile')

  afterAll(async () => {
    try {
      await closeSession(RNAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'reopens cleanly against a userDataDir that already holds a dead port file',
    async () => {
      // Simulate a crashed browser: the profile dir survives with a DevToolsActivePort
      // pointing at a now-dead port (Chromium leaves this file on SIGKILL).
      await fs.mkdir(profileDir, { recursive: true })
      const stalePortFile = path.join(profileDir, 'DevToolsActivePort')
      const STALE_PORT = 1 // privileged + unbound: no CDP endpoint will ever answer
      await fs.writeFile(stalePortFile, `${STALE_PORT}\n/devtools/browser/stale-uuid`)

      // Without the fix, waitForDevToolsPort reads the stale port first and the
      // ws-endpoint wait times out → openSession throws. With the fix it removes the
      // stale file, so the port read is the freshly-spawned browser's real port.
      const info = await openSession(RNAME, { headed: false })
      expect(info.port).toBeGreaterThan(0)
      expect(info.port).not.toBe(STALE_PORT)
      expect(info.wsEndpoint.startsWith('ws')).toBe(true)

      // The on-disk port file now reflects the LIVE browser, not the stale value.
      const written = await fs.readFile(stalePortFile, 'utf8')
      const firstLine = Number.parseInt(written.split('\n', 1)[0]?.trim() ?? '', 10)
      expect(firstLine).toBe(info.port)
      expect(firstLine).not.toBe(STALE_PORT)

      // And the session is actually reconnectable (not wedged on a dead port).
      const { browser, page } = await connect(RNAME)
      try {
        await page.goto('data:text/html,<h1>ok</h1>')
        const text = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '')
        expect(text).toBe('ok')
      } finally {
        await browser.close()
      }

      await closeSession(RNAME)
    },
  )
})
