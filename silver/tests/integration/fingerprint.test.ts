import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'

/**
 * `doctor --fingerprint` — the offline identity-coherence panel.
 *
 * The gap it closes: everything upstream SETS fingerprint attributes and nothing
 * ever READS them back, so nothing asserts that two attributes silver controls
 * actually agree with each other. A browser is caught not by any single value but
 * by two values that cannot both be true of the same machine — a viewport larger
 * than its own window, a `navigator.language` its own `languages[0]` contradicts.
 *
 * Keyless throughout: no scanner site, no network, no model. Every assertion here
 * is silver reading its own live browser and comparing it against itself.
 *
 * The panel is a REGRESSION DETECTOR, not a gate — see doctorFingerprint. That is
 * why this file asserts `viewport_coherent === 'pass'` rather than asserting the
 * command's exit code: the exit code deliberately does not move, so this test IS
 * the thing that catches a regression.
 */

type Check = { name: string; status: string; message: string; fix?: string; details?: string }
type Panel = { checks: Check[]; verdict: string; next: string }

const SESSION = `silver-fp-${process.pid}-${Date.now()}`
const NAMES = [
  'viewport_coherent',
  'timezone_coherent',
  'locale_coherent',
  'platform_coherent',
  'webdriver_absent',
  'driver_globals_absent',
]

let server: Server
let base: string

async function panel(): Promise<Panel> {
  const r = await run(['doctor', '--fingerprint', '--json'])
  expect(r.env.success).toBe(true)
  return r.env.data as Panel
}

function byName(p: Panel, name: string): Check {
  const c = p.checks.find((x) => x.name === name)
  expect(c, `no check named ${name}`).toBeDefined()
  return c!
}

describe('doctor --fingerprint: offline identity coherence', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>fp</title><body>fingerprint fixture</body>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    // localhost by NAME: the egress guard denies a raw-IP literal.
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    await closeSession(SESSION).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // Runs FIRST, before anything opens a browser: with no live session there is
  // nothing to read attributes off, and the panel must say so instead of
  // inventing values or launching a throwaway browser of its own (a browser that
  // never went through `connect()` could not observe silver's real behaviour).
  it('skips the whole panel cleanly when there is no live session', async () => {
    await closeSession(SESSION).catch(() => {}) // order-independence, not cleanup
    const p = await panel()
    expect(p.checks.map((c) => c.name)).toEqual(NAMES)
    for (const c of p.checks) {
      expect(c.status, `${c.name} should skip with no session`).toBe('skip')
      // A skip that does not say how to un-skip it is a dead end for the host.
      expect(c.message.length).toBeGreaterThan(0)
    }
    expect(p.verdict).toBe('skipped')
  })

  it('reports every named check against a live session', async () => {
    expect((await run(['open', base, '--session', SESSION])).env.success).toBe(true)
    const p = await panel()
    expect(p.checks.map((c) => c.name)).toEqual(NAMES)
    for (const c of p.checks) {
      // Never a gate: a stock Playwright Chromium cannot pass every one of these
      // (its headless UA carries a HeadlessChrome token), so a `fail` here would
      // make the panel break the build for every honest user.
      expect(['pass', 'warn', 'skip'], `${c.name} was ${c.status}`).toContain(c.status)
    }
  })

  it('viewport_coherent PASSES in a live headless session — the B1 regression lock', async () => {
    expect((await run(['open', base, '--session', SESSION])).env.success).toBe(true)
    const c = byName(await panel(), 'viewport_coherent')
    expect(c.status, c.message).toBe('pass')
    // The measured numbers travel with the check; a bare boolean would leave the
    // host unable to tell WHICH dimension went incoherent.
    expect(c.details).toMatch(/outer \d+x\d+/)
  })

  it('the panel is keyless: it names no scanner site and makes no network claim', async () => {
    const p = await panel()
    expect(JSON.stringify(p)).not.toMatch(/https?:\/\//)
  })
})
