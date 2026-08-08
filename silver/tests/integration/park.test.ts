import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'

/**
 * Page parking, end to end through the CLI.
 *
 * Silver is command-scoped — connect, act, disconnect — but the browser it
 * leaves behind is headless, so it has no occluded window and keeps every page
 * running at full rate with nobody watching. Measured before this: three
 * sessions parked on one animating page each held 48.6% of a CPU indefinitely.
 * The fix freezes each page as the transport drops and wakes the one a command
 * is about to drive.
 *
 * The assertions are behavioural: an animating page must NOT paint across a
 * 1.5s gap between commands, MUST paint while a command holds it, and must
 * paint normally with parking switched off. Anything less (asserting we sent
 * the CDP message) would pass just as happily on a page that never stopped —
 * or on one that never woke up again.
 */

// Two sessions, never shared. The freeze is sticky per browser (see
// `unparkPage`), so a session that was parked once cannot be used to test the
// unparked case — it would report "stopped" for the wrong reason.
const PARKED = `silver-park-${process.pid}-${Date.now()}`
const UNPARKED = `silver-nopark-${process.pid}-${Date.now()}`
const GAP_MS = 1_500
/**
 * Frames the page WOULD paint across the gap if it kept running (~60fps).
 * Measured on a real run: 92 awake, 3 parked.
 */
const FRAMES_IF_AWAKE = 60

// A page that paints. The canvas is not decoration: a page with nothing to
// composite has its timers throttled by Chromium anyway, so a static counter
// would show the same "stopped" reading with parking off and prove nothing.
// This is the shape that actually costs a laptop its battery — an animating
// SPA left open in a session nobody is driving.
const COUNTER_PAGE = `<!doctype html><html><body><canvas id="c" width="300" height="200"></canvas><script>
  window.__frames = 0
  var ctx = document.getElementById('c').getContext('2d')
  function paint() {
    window.__frames++
    ctx.fillStyle = 'hsl(' + (window.__frames % 360) + ' 80% 50%)'
    ctx.fillRect(0, 0, 300, 200)
    requestAnimationFrame(paint)
  }
  requestAnimationFrame(paint)
</script></body></html>`

let server: Server
let base: string

function data<T = unknown>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

async function frames(session: string): Promise<number> {
  const r = await run(['eval', 'window.__frames', '--session', session, '--enable-actions'])
  // Page-derived output arrives inside the untrusted-content fences.
  return Number(String(data(r)).replace(/⟦[^⟧]*⟧/g, '').trim())
}

/** Frames painted while no command was running. */
async function framesAcrossGap(session: string): Promise<number> {
  const before = await frames(session)
  await new Promise((r) => setTimeout(r, GAP_MS))
  const after = await frames(session)
  return after - before
}

describe('parked pages stop costing CPU between commands', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(COUNTER_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    // localhost by NAME: the egress guard denies a raw-IP literal.
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    delete process.env.SILVER_NO_PARK
    await closeSession(PARKED).catch(() => {})
    await closeSession(UNPARKED).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('freezes the page when the command ends and wakes it for the next one', async () => {
    delete process.env.SILVER_NO_PARK
    const open = await run(['open', base, '--session', PARKED])
    expect(open.env.success).toBe(true)

    const parked = await framesAcrossGap(PARKED)
    // A few frames land in the wake/attach window at either end; ~60 would mean
    // the page never stopped. The gap between the two bounds is the whole
    // effect, so a loose threshold still cannot pass by accident.
    expect(parked).toBeLessThan(FRAMES_IF_AWAKE / 4)
  })

  it('still runs the page DURING a command — the wake-up is real', async () => {
    delete process.env.SILVER_NO_PARK
    // PARKED has been frozen by the previous test's teardown. A timer that must
    // fire inside the eval proves the page is genuinely running while silver
    // holds it, not merely answering Runtime.evaluate (which a frozen page does).
    const r = await run([
      'eval',
      'new Promise(function(res){var n=window.__frames;setTimeout(function(){res(window.__frames-n)},500)})',
      '--session',
      PARKED,
      '--enable-actions',
    ])
    expect(r.env.success).toBe(true)
    const painted = Number(String(r.env.data).replace(/⟦[^⟧]*⟧/g, '').trim())
    expect(painted).toBeGreaterThan(10)
  })

  it('keeps the page running when SILVER_NO_PARK=1', async () => {
    process.env.SILVER_NO_PARK = '1'
    expect((await run(['open', base, '--session', UNPARKED])).env.success).toBe(true)

    const running = await framesAcrossGap(UNPARKED)
    expect(running).toBeGreaterThan(FRAMES_IF_AWAKE / 2)
  })
})
