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

let server: Server
let overlayUrl: string
let tableUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end((req.url || '').startsWith('/table') ? TABLE : OVERLAY)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  overlayUrl = `http://localhost:${port}/overlay`
  tableUrl = `http://localhost:${port}/table`
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
