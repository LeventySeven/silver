import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-verbs-${process.pid}-${Date.now()}`

// Main page: a main-frame `.inner` button, a same-origin srcdoc iframe holding
// TWO `.inner` buttons (frame-scoping ground truth), a load-time console.log, and
// endpoints the network tests hit.
const PAGE = `<!doctype html>
<html><body>
  <h1>Silver verbs</h1>
  <input id="kbd" aria-label="kbd field">
  <button class="inner" id="mainbtn">Main</button>
  <iframe id="kid" srcdoc="<button class='inner'>A</button><button class='inner'>B</button>"></iframe>
  <script>console.log('page loaded ok'); window.__loaded = true;</script>
</body></html>`

// A page whose full-viewport pad counts clicks — proves `mouse click <x> <y>`
// actually dispatched at the coordinate.
const MOUSE_PAGE = `<!doctype html>
<html><body>
  <div id="pad" style="position:fixed;top:0;left:0;width:100%;height:100%"
       onclick="window.__mc=(window.__mc||0)+1"></div>
</body></html>`

let server: Server
let pageUrl: string
let mouseUrl: string

function firstRefWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role} in refmap`)
}

describe('vercel-parity verbs (real Chromium via the run() entry)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/ping')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('pong')
        return
      }
      if (url.startsWith('/blocked')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('blocked-body')
        return
      }
      if (url.startsWith('/mouse')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(MOUSE_PAGE)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    pageUrl = `http://localhost:${port}/`
    mouseUrl = `http://localhost:${port}/mouse`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('eval is quarantined without --enable-actions and returns a neutralized result with it', async () => {
    await run(['open', pageUrl, '--session', NAME])

    const denied = await run(['eval', '1+1', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const evaled = await run(['eval', '1+1', '--enable-actions', '--session', NAME])
    expect(evaled.env.success).toBe(true)
    expect(evaled.env.data as string).toContain('2')
    // Page-derived → wrapped in the untrusted-content boundary fence.
    expect(evaled.env.data as string).toContain('page-content')
  })

  it('storage: get is read-only; set/clear require --enable-actions', async () => {
    await run(['open', pageUrl, '--session', NAME])

    // set is an ACTOR sub-op — refused without the grant.
    const setDenied = await run(['storage', 'local', 'set', 'k1', 'v1', '--session', NAME])
    expect(setDenied.env.success).toBe(false)
    expect(setDenied.env.error).toBe(ERRORS.not_permitted.message)

    const setOk = await run([
      'storage', 'local', 'set', 'k1', 'v1', '--enable-actions', '--session', NAME,
    ])
    expect(setOk.env.success).toBe(true)

    // get needs no grant and reads the value back (through the neutralizer).
    const getOne = await run(['storage', 'local', 'get', 'k1', '--session', NAME])
    expect(getOne.env.success).toBe(true)
    expect((getOne.env.data as { value: string }).value).toContain('v1')

    // The whole-store dump now routes each value through the neutralizer too
    // (fix F7), so the value is boundary-fenced like the single-key get above.
    const getAll = await run(['storage', 'local', 'get', '--session', NAME])
    expect((getAll.env.data as { storage: Record<string, string> }).storage.k1).toContain('v1')

    const cleared = await run(['storage', 'local', 'clear', '--enable-actions', '--session', NAME])
    expect(cleared.env.success).toBe(true)
    const afterClear = await run(['storage', 'local', 'get', 'k1', '--session', NAME])
    expect((afterClear.env.data as { value: string | null }).value).toBeNull()
  })

  it('frame switches selector context to an iframe; frame main resets it', async () => {
    await run(['open', pageUrl, '--session', NAME])

    // Main frame has ONE `.inner`.
    const mainCount = await run(['get', 'count', '.inner', '--session', NAME])
    expect((mainCount.env.data as { count: number }).count).toBe(1)

    // Switch into the srcdoc iframe (two `.inner` buttons live there).
    const switched = await run(['frame', '#kid', '--session', NAME])
    expect(switched.env.success).toBe(true)

    const frameCount = await run(['get', 'count', '.inner', '--session', NAME])
    expect((frameCount.env.data as { count: number }).count).toBe(2)

    // Reset → back to the main frame's single `.inner`.
    const reset = await run(['frame', 'main', '--session', NAME])
    expect(reset.env.success).toBe(true)
    const backCount = await run(['get', 'count', '.inner', '--session', NAME])
    expect((backCount.env.data as { count: number }).count).toBe(1)
  })

  it('mouse acts only with --enable-actions; a click dispatches at the coordinate', async () => {
    await run(['open', mouseUrl, '--session', NAME])

    const denied = await run(['mouse', 'move', '10', '20', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const moved = await run(['mouse', 'move', '10', '20', '--enable-actions', '--session', NAME])
    expect(moved.env.success).toBe(true)

    const wheeled = await run(['mouse', 'wheel', '120', '--enable-actions', '--session', NAME])
    expect(wheeled.env.success).toBe(true)

    const clicked = await run(['mouse', 'click', '50', '50', '--enable-actions', '--session', NAME])
    expect(clicked.env.success).toBe(true)

    // The full-viewport pad's onclick counter proves the click landed.
    const check = await run(['eval', 'window.__mc', '--enable-actions', '--session', NAME])
    expect(check.env.data as string).toContain('1')
  })

  it('network requests captures fetch and --filter narrows; route --abort blocks a url', async () => {
    await run(['open', pageUrl, '--session', NAME])

    // Trigger a fetch from host JS; the in-page wrapper records it synchronously.
    const ok = await run([
      'eval', "fetch('/ping').then(function(){return 'ok'},function(){return 'err'})",
      '--enable-actions', '--session', NAME,
    ])
    expect(ok.env.data as string).toContain('ok')

    const reqs = await run(['network', 'requests', '--filter', 'ping', '--session', NAME])
    expect(reqs.env.success).toBe(true)
    const body = reqs.env.data as { total: number; requests: Array<{ url: string; method: string }> }
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(body.requests.some((r) => r.url.includes('/ping'))).toBe(true)

    // route --abort is an ACTOR op — refused without the grant.
    const routeDenied = await run(['network', 'route', '**/blocked', '--abort', '--session', NAME])
    expect(routeDenied.env.error).toBe(ERRORS.not_permitted.message)

    const routed = await run([
      'network', 'route', '**/blocked', '--abort', '--enable-actions', '--session', NAME,
    ])
    expect(routed.env.success).toBe(true)

    // The persisted route is re-applied on the eval command's connection → abort.
    const blocked = await run([
      'eval', "fetch('/blocked').then(function(){return 'ok'},function(){return 'err'})",
      '--enable-actions', '--session', NAME,
    ])
    expect(blocked.env.data as string).toContain('err')

    await run(['network', 'unroute', '--enable-actions', '--session', NAME])
  })

  it('batch shares the session, runs each sub-command through the gate, and honors --bail', async () => {
    const batched = await run(['batch', `open ${pageUrl}`, 'get title', '--session', NAME])
    expect(batched.env.success).toBe(true)
    const data = batched.env.data as {
      count: number
      results: Array<{ command: string; success: boolean }>
    }
    expect(data.count).toBe(2)
    expect(data.results.every((r) => r.success)).toBe(true)

    // --bail stops after the first failing sub-command (an unschemed nav is denied).
    const bailed = await run(['batch', 'open notascheme', 'get title', '--bail', '--session', NAME])
    expect(bailed.env.success).toBe(false)
    const bdata = bailed.env.data as { count: number; results: Array<{ success: boolean }> }
    expect(bdata.count).toBe(1)
    expect(bdata.results[0].success).toBe(false)
  })

  it('keyboard types into the focused control (via a grounded focus)', async () => {
    await run(['open', pageUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const inputRef = firstRefWithRole(map as RefMap, 'textbox')

    // keyboard is an ACTOR verb — refused without the grant.
    const denied = await run(['keyboard', 'type', 'hi', '--session', NAME])
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    await run(['focus', `@${inputRef}`, '--enable-actions', '--session', NAME])
    const typed = await run([
      'keyboard', 'type', 'kbdtext', '--enable-actions', '--session', NAME,
    ])
    expect(typed.env.success).toBe(true)

    const value = await run(['get', 'value', `@${inputRef}`, '--session', NAME])
    expect((value.env.data as { value: string }).value).toContain('kbdtext')
  })

  it('clipboard write is gated; read round-trips the written text', async () => {
    await run(['open', pageUrl, '--session', NAME])

    // write is an ACTOR sub-op — refused without the grant.
    const denied = await run(['clipboard', 'write', 'nope', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const wrote = await run([
      'clipboard', 'write', 'silver-clip-xyz', '--enable-actions', '--session', NAME,
    ])
    expect(wrote.env.success).toBe(true)

    const read = await run(['clipboard', 'read', '--session', NAME])
    expect(read.env.success).toBe(true)
    expect(read.env.data as string).toContain('silver-clip-xyz')
  })

  it('console captures page logs; pdf renders headless; scrollintoview grounds a ref', async () => {
    await run(['open', pageUrl, '--session', NAME])

    const con = await run(['console', '--session', NAME])
    expect(con.env.success).toBe(true)
    expect(con.env.data as string).toContain('page loaded ok')

    const pdf = await run(['pdf', '--session', NAME])
    expect(pdf.env.success).toBe(true)
    const pdfData = pdf.env.data as { encoding: string; pdf: string }
    expect(pdfData.encoding).toBe('base64')
    expect(pdfData.pdf.length).toBeGreaterThan(0)

    // scrollintoview needs a grounded ref → snapshot first.
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const btnRef = firstRefWithRole(map as RefMap, 'button')
    const scrolled = await run([
      'scrollintoview', `@${btnRef}`, '--enable-actions', '--session', NAME,
    ])
    expect(scrolled.env.success).toBe(true)
    expect((scrolled.env.data as { scrolled: boolean }).scrolled).toBe(true)
  })
})
