import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome, setNamespace } from '../../src/core/session.js'

/**
 * MEDIA FIDELITY — silver must not impose preferences nobody asked for.
 *
 * `connectOverCDP` applies Playwright's context defaults to whatever pages it
 * drives: `colorScheme: 'light'`, `reducedMotion: 'no-preference'`, `forcedColors:
 * 'none'`. Silver never requested any of them. On the user's real browser the
 * effect was visible and maddening — their pages flipped to light for the
 * duration of every command and back to dark on disconnect, so an agent working
 * in the background made the browser strobe.
 *
 * It is also an authenticity tell: a browser that insists it prefers light while
 * the OS is dark is exactly the mismatch fingerprinting looks for.
 *
 * The page's own reported value is the oracle here — reading it back through
 * Playwright would just re-measure the layer under test.
 */

const SUFFIX = `${process.pid}-${Date.now()}`
const NS = `media-${SUFFIX}`

// Reports what the PAGE believes, so an override shows up as a changed value.
const PAGE = `<!doctype html><html><body><h1 id="cs"></h1>
<script>
  document.getElementById('cs').textContent =
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
</script></body></html>`

let server: Server
let base: string

function text(r: { env: { data: unknown } }): string {
  return JSON.stringify(r.env.data)
}

describe('media emulation fidelity (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
    await run(['open', base, '--session', 'm', '--namespace', NS])
  })

  afterAll(async () => {
    await run(['close', '--all', '--namespace', NS]).catch(() => {})
    await fs
      .rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true })
      .catch(() => {})
    setNamespace('')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not force a colorScheme override when none was asked for', async () => {
    // The regression: Playwright's default made this report 'light' regardless of
    // what the browser would actually say. `emulateMedia({colorScheme: null})`
    // hands the question back to the browser.
    const res = await run([
      'eval',
      "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
      '--session',
      'm',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(res.env.success).toBe(true)

    // Whatever the browser reports, the PAGE must agree — no override in between.
    const viaEval = text(res).includes('dark') ? 'dark' : 'light'
    const rendered = await run(['read', '--session', 'm', '--namespace', NS])
    expect(text(rendered)).toContain(viaEval)
  })

  it('still honours an EXPLICIT `set color-scheme`, and it survives the reconnect', async () => {
    // Clearing the unasked-for default must not break the deliberate override —
    // it is persisted and re-applied on every connect (F8).
    const set = await run([
      'set',
      'color-scheme',
      'dark',
      '--session',
      'm',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(set.env.success).toBe(true)

    // A SEPARATE command, i.e. after a full disconnect/reconnect cycle.
    const after = await run([
      'eval',
      "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
      '--session',
      'm',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(text(after)).toContain('dark')

    const light = await run([
      'set',
      'color-scheme',
      'light',
      '--session',
      'm',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(light.env.success).toBe(true)
    const back = await run([
      'eval',
      "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
      '--session',
      'm',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(text(back)).toContain('light')
  })
})
