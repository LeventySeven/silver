import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'

// Real-error-analysis fixes (SOTA round): a click on an OCCLUDED element (consent /
// GDPR wall — on ~every major site) must map to `element_obscured` ("dismiss the
// banner first"), not the misleading generic `timeout` ("increase --timeout", which
// can never clear a modal); and the lean text rungs must preserve table cell/row
// boundaries (innerText, not textContent).
const NAME = `silver-recovery-${process.pid}-${Date.now()}`

// A target link fully covered by a fixed full-viewport overlay (z-index 9999).
const OVERLAY = `<!doctype html><html><head><title>Overlay</title></head><body>
  <a href="#" id="t" onclick="document.title='CLICKED'">Accept terms</a>
  <div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,.6)">consent wall</div>
</body></html>`

// A semantic table (th + caption → role table) whose adjacent numeric cells fuse
// under textContent but separate under innerText.
const TABLE = `<!doctype html><html><head><title>Table</title></head><body>
  <table><caption>Pop</caption><thead><tr><th>Country</th><th>Population</th></tr></thead>
  <tbody><tr><td>India</td><td>1,429,404,000</td></tr></tbody></table>
</body></html>`

// A button whose onclick INCREMENTS a counter — proves the self-verifying click
// actuates the handler EXACTLY once (no double-actuation from the fallback firing
// on a click that already landed).
const COUNTER = `<!doctype html><html><head><title>Counter</title></head><body>
  <button id="b" onclick="window.__n=(window.__n||0)+1;document.getElementById('o').textContent='count '+window.__n">Tap</button>
  <div id="o">count 0</div>
</body></html>`

// The adversarial double-actuation cases (two rounds of review): a handler CONSUMES
// the click via stopPropagation/stopImmediatePropagation at some level and is itself
// the actuator. A landing probe that watches the CLICK event is defeated (the click
// is stopped before the probe sees it → false "didn't land" → fallback fires it
// AGAIN). The mouse-DOWN-count probe is immune: a delivered-but-consumed click still
// fires mousedown, so the fallback never triggers. Each must actuate EXACTLY once.
const SWALLOWERS: Record<string, string> = {
  // 1) ancestor <div> capture-phase stopPropagation
  swallowancestor: `<div id="w"><button id="b">Tap</button></div><script>window.__n=0;document.getElementById('w').addEventListener('click',function(e){e.stopPropagation();bump();},true);</script>`,
  // 2) window-level capture-phase PLAIN stopPropagation (window is above document)
  swallowwindow: `<button id="b">Tap</button><script>window.__n=0;window.addEventListener('click',function(e){if(e.target.id==='b'){bump();e.stopPropagation();}},true);</script>`,
  // 3) document-level capture-phase stopImmediatePropagation, registered at load
  swallowdoc: `<button id="b">Tap</button><script>window.__n=0;document.addEventListener('click',function(e){if(e.target.id==='b'){bump();e.stopImmediatePropagation();}},true);</script>`,
}
const swallowPage = (body: string): string =>
  `<!doctype html><html><head><title>Swallow</title></head><body>${body}<div id="o">count 0</div>` +
  `<script>function bump(){window.__n=(window.__n||0)+1;document.getElementById('o').textContent='count '+window.__n;}</script></body></html>`

let server: Server
let overlayUrl: string
let tableUrl: string
let counterUrl: string
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    const u = (req.url || '').replace(/^\//, '').split('?')[0]
    const body =
      u === 'table'
        ? TABLE
        : u === 'counter'
          ? COUNTER
          : u in SWALLOWERS
            ? swallowPage(SWALLOWERS[u])
            : OVERLAY
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  base = `http://localhost:${port}`
  overlayUrl = `${base}/overlay`
  tableUrl = `${base}/table`
  counterUrl = `${base}/counter`
})

afterAll(async () => {
  try {
    await closeSession(NAME)
  } catch {
    /* ignore */
  }
  await new Promise<void>((r) => server.close(() => r()))
})

describe('error-recovery + table-boundary fixes (from real error analysis)', () => {
  it('a click on an OCCLUDED element maps to element_obscured, not a generic timeout', async () => {
    await run(['open', overlayUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    // e1 is the (now-covered) "Accept terms" link. Short --timeout: the intercept is
    // detected as soon as the actionability check gives up; we assert the mapping,
    // not the wait.
    const occluded = await run(['click', 'e1', '--timeout', '1500', '--enable-actions', '--session', NAME])
    expect(occluded.env.success).toBe(false)
    expect(occluded.env.error).toBe(ERRORS.element_obscured.message)
    // Control: a genuinely-absent ref must NOT be reported as obscured (no over-fire).
    const absent = await run(['click', 'e999', '--enable-actions', '--session', NAME])
    expect(absent.env.error).not.toBe(ERRORS.element_obscured.message)
  })

  it('self-verifying click actuates the onclick handler EXACTLY once (no double-actuation)', async () => {
    // The fix for the connectOverCDP silent-no-op click verifies the trusted click
    // landed and falls back to a DOM click only if it did NOT. On a normal page the
    // trusted click lands, so the fallback must NOT fire — the handler runs once.
    await run(['open', counterUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const clicked = await run(['click', 'e1', '--enable-actions', '--session', NAME])
    expect(clicked.env.success).toBe(true)
    const out = await run(['get', 'text', '--session', NAME]) // whole-page innerText
    const text = String((out.env.data as { text?: string })?.text ?? out.env.data)
    // Exactly one increment — 'count 1', never 'count 2' (which a double-actuation gives).
    expect(text).toContain('count 1')
    expect(text).not.toContain('count 2')
  })

  it.each(Object.keys(SWALLOWERS))(
    'self-verifying click does NOT double-actuate when a handler consumes the click (%s)',
    async (key) => {
      // Regression for two rounds of adversarial review: an actuator that consumes
      // the click (stopPropagation/stopImmediatePropagation at ancestor / window /
      // document capture) must still fire EXACTLY once. The mouse-down-count probe
      // sees the delivered click (mousedown fires before any click-stopper) → no
      // fallback → single actuation.
      await run(['open', `${base}/${key}`, '--session', NAME])
      await run(['snapshot', '-i', '--session', NAME])
      const clicked = await run(['click', 'e1', '--enable-actions', '--session', NAME])
      expect(clicked.env.success).toBe(true)
      const out = await run(['get', 'text', '--session', NAME])
      const text = String((out.env.data as { text?: string })?.text ?? out.env.data)
      expect(text).toContain('count 1')
      expect(text).not.toContain('count 2') // consumed once, never re-fired
    },
  )

  it('find/get-text preserve table cell + row boundaries (innerText, not fused textContent)', async () => {
    await run(['open', tableUrl, '--session', NAME])
    const found = await run(['find', 'role', 'table', '--session', NAME])
    expect(found.env.success).toBe(true)
    const text = (found.env.data as { text?: string }).text ?? ''
    // Cells are tab-separated, rows newline-separated — NOT the fused concatenation.
    expect(text).toContain('India\t1,429,404,000')
    expect(text).toContain('Country\tPopulation')
    expect(text).not.toContain('India1,429,404,000') // the pre-fix fusion is gone
  })
})
