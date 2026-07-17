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
<html><head><title>Silver verbs</title></head><body>
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

// R2 fixture: a page hosting a recaptcha iframe (detection by iframe src glob).
const CAPTCHA_PAGE = `<!doctype html>
<html><head><title>Verify</title></head><body>
  <h1>Please complete the security check</h1>
  <iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe>
</body></html>`

// R3 fixture: a login wall — a password field + a login-ish title (served at
// a /login path so the URL signal fires too).
const LOGIN_PAGE = `<!doctype html>
<html><head><title>Sign in to continue</title></head><body>
  <h1>Log in</h1>
  <form><input name="user" aria-label="username">
  <input type="password" aria-label="password"></form>
</body></html>`

// S4 fixture: a paid "Buy now" control that records that it was clicked.
const BUY_PAGE = `<!doctype html>
<html><body>
  <button id="buy" onclick="document.body.setAttribute('data-bought','1')">Buy now</button>
</body></html>`

// FIX #6 fixture: a scrollable INNER container (`role=listbox` so it grounds as a
// ref) whose 3000px content overflows a 100px box — `scroll @ref --by 0 500` must
// move the container's OWN scrollTop while the window stays put.
const SCROLL_PAGE = `<!doctype html>
<html><head><title>Scroll box</title></head><body>
  <div id="box" role="listbox" aria-label="items" tabindex="0"
       style="overflow:auto;height:100px;width:200px">
    <div style="height:3000px">tall content</div>
  </div>
</body></html>`

let server: Server
let pageUrl: string
let mouseUrl: string
let scrollUrl: string
let baseUrl: string

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
      if (url.startsWith('/scroll')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(SCROLL_PAGE)
        return
      }
      if (url.startsWith('/captcha')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(CAPTCHA_PAGE)
        return
      }
      if (url.startsWith('/login')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(LOGIN_PAGE)
        return
      }
      if (url.startsWith('/buy')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(BUY_PAGE)
        return
      }
      // D6: echo back the Cookie header the fetch arrived with, so a test can
      // prove the session's cookies rode along.
      if (url.startsWith('/echo-cookie')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('COOKIE:' + (req.headers.cookie ?? 'none'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://localhost:${port}`
    pageUrl = `http://localhost:${port}/`
    mouseUrl = `http://localhost:${port}/mouse`
    scrollUrl = `http://localhost:${port}/scroll`
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
    // FIX #3: scrollintoview/scrollinto now route through the SAME grounded
    // handleAct pipeline as `scroll` (they used to run a bespoke handler that
    // returned only `{scrolled:true}` and SKIPPED the spec-§6 grounding contract).
    // This is a correction, not a weakening: the alias envelope must now carry
    // page_changed / stale_refs / generation like every other action envelope.
    const sdata = scrolled.env.data as {
      verb: string
      ref: string
      generation: number
      page_changed: boolean
      stale_refs: boolean
    }
    expect(sdata.verb).toBe('scroll')
    expect(sdata.generation).toBeGreaterThan(0)
    expect(sdata).toHaveProperty('page_changed')
    expect(sdata).toHaveProperty('stale_refs')
  })

  it('FIX #6: scroll @ref --by moves the container’s own scrollTop, not the page', async () => {
    await run(['open', scrollUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    // The scrollable container grounds as a `listbox` ref.
    const boxRef = firstRefWithRole(map as RefMap, 'listbox')

    // Baseline: the container is at the top and the window has not scrolled.
    // `--no-content-boundaries` returns the raw eval value (no untrusted fence).
    const topBefore = await run([
      'eval', "document.getElementById('box').scrollTop",
      '--enable-actions', '--no-content-boundaries', '--session', NAME,
    ])
    expect(Number(topBefore.env.data)).toBe(0)

    const scrolled = await run([
      'scroll', `@${boxRef}`, '--by', '0', '500', '--enable-actions', '--session', NAME,
    ])
    expect(scrolled.env.success).toBe(true)
    // The delta form still rides the grounded handleAct pipeline (grounding fields).
    const sd = scrolled.env.data as { verb: string; ref: string; generation: number }
    expect(sd.verb).toBe('scroll')
    expect(sd.generation).toBeGreaterThan(0)

    // The CONTAINER's own scroll box moved by the delta…
    const topAfter = await run([
      'eval', "document.getElementById('box').scrollTop",
      '--enable-actions', '--no-content-boundaries', '--session', NAME,
    ])
    expect(Number(topAfter.env.data)).toBe(500)

    // …while the PAGE itself did not scroll.
    const winY = await run([
      'eval', 'window.scrollY',
      '--enable-actions', '--no-content-boundaries', '--session', NAME,
    ])
    expect(Number(winY.env.data)).toBe(0)
  })

  // --- AC1: expect / assertion primitive ----------------------------------
  it('AC1: expect asserts element + page state (present passes, absent fails)', async () => {
    await run(['open', pageUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])

    // A present element is visible → the assertion holds.
    const vis = await run(['expect', '.inner', 'visible', '--session', NAME])
    expect(vis.env.success).toBe(true)
    expect((vis.env.data as { matched: boolean }).matched).toBe(true)

    // An absent element → the assertion fails cleanly (matched:false, not a throw).
    const absent = await run(['expect', '.no-such-element-xyz', 'visible', '--session', NAME])
    expect(absent.env.success).toBe(false)
    expect((absent.env.data as { matched: boolean }).matched).toBe(false)

    // A grounded @ref resolves through the same grounding gate.
    const map = await loadRefMap(NAME)
    const btnRef = firstRefWithRole(map as RefMap, 'button')
    const refVis = await run(['expect', `@${btnRef}`, 'visible', '--session', NAME])
    expect(refVis.env.success).toBe(true)

    // text-contains: pass and fail.
    const txt = await run(['expect', 'h1', 'text-contains', 'Silver verbs', '--session', NAME])
    expect(txt.env.success).toBe(true)
    const txtNo = await run(['expect', 'h1', 'text-contains', 'not-in-the-page', '--session', NAME])
    expect(txtNo.env.success).toBe(false)

    // count: the main frame has exactly one `.inner`.
    const cnt = await run(['expect', '.inner', 'count', '1', '--session', NAME])
    expect(cnt.env.success).toBe(true)
    const cntNo = await run(['expect', '.inner', 'count', '5', '--session', NAME])
    expect(cntNo.env.success).toBe(false)
    expect((cntNo.env.data as { observed: string }).observed).toBe('1')

    // Page-level matchers need no target.
    const title = await run(['expect', 'title-contains', 'Silver', '--session', NAME])
    expect(title.env.success).toBe(true)
    const url = await run(['expect', 'url-matches', 'localhost', '--session', NAME])
    expect(url.env.success).toBe(true)
    const urlNo = await run(['expect', 'url-matches', 'example.com', '--session', NAME])
    expect(urlNo.env.success).toBe(false)
  })

  // --- R2/R3: CAPTCHA + auth-wall detection (dead codes now emitted) -------
  it('R2/R3: snapshot/open surface captcha_detected and auth_required', async () => {
    // A recaptcha iframe → captcha_detected on the snapshot warning + open flag.
    await run(['open', `${baseUrl}/captcha`, '--session', NAME])
    const capSnap = await run(['snapshot', '-i', '--session', NAME])
    expect(capSnap.env.warning ?? '').toContain('captcha_detected')
    const capOpen = await run(['open', `${baseUrl}/captcha`, '--session', NAME])
    expect((capOpen.env.data as { captcha_detected?: boolean }).captcha_detected).toBe(true)

    // A login wall (password field + login URL/title) → auth_required.
    await run(['open', `${baseUrl}/login`, '--session', NAME])
    const loginSnap = await run(['snapshot', '-i', '--session', NAME])
    expect(loginSnap.env.warning ?? '').toContain('auth_required')
    const loginOpen = await run(['open', `${baseUrl}/login`, '--session', NAME])
    expect((loginOpen.env.data as { auth_required?: boolean }).auth_required).toBe(true)

    // A plain page trips neither detector.
    await run(['open', pageUrl, '--session', NAME])
    const normal = await run(['snapshot', '-i', '--session', NAME])
    expect(normal.env.warning ?? '').not.toContain('captcha_detected')
    expect(normal.env.warning ?? '').not.toContain('auth_required')
  })

  // --- D6: cookie-authenticated read fetch --------------------------------
  it('D6: read attaches the live session cookies to the fetch Cookie header', async () => {
    await run(['open', pageUrl, '--session', NAME])
    // Seed a cookie in the browser context (same origin as the echo endpoint).
    await run(['eval', "document.cookie='silversess=abc123'", '--enable-actions', '--session', NAME])

    const r = await run(['read', `${baseUrl}/echo-cookie`, '--session', NAME])
    expect(r.env.success).toBe(true)
    // The echo endpoint reflects the Cookie header it received.
    expect(r.env.data as string).toContain('silversess=abc123')
  })

  // --- S4: two-phase confirm / deny gate ----------------------------------
  it('S4: a gated buy returns requires_confirmation; confirm proceeds, deny aborts', async () => {
    const origTTY = process.stdout.isTTY
    process.stdout.isTTY = false
    try {
      await run(['open', `${baseUrl}/buy`, '--session', NAME])
      await run(['snapshot', '-i', '--session', NAME])
      const map = await loadRefMap(NAME)
      const buyRef = firstRefWithRole(map as RefMap, 'button')

      // Default (no --two-phase-confirm): the paid control still hard-denies.
      const hard = await run(['click', `@${buyRef}`, '--enable-actions', '--session', NAME])
      expect(hard.env.success).toBe(false)
      expect(hard.env.error).toBe(ERRORS.confirm_required.message)

      // deny path: request → deny → the click never fires.
      const p1 = await run([
        'click', `@${buyRef}`, '--enable-actions', '--two-phase-confirm', '--session', NAME,
      ])
      expect(p1.env.success).toBe(false)
      const d1 = p1.env.data as { status: string; confirmation_id: string }
      expect(d1.status).toBe('requires_confirmation')
      expect(typeof d1.confirmation_id).toBe('string')
      expect(d1.confirmation_id.length).toBeGreaterThan(0)

      const denied = await run(['deny', d1.confirmation_id, '--session', NAME])
      expect(denied.env.success).toBe(true)
      expect((denied.env.data as { denied: boolean }).denied).toBe(true)
      const notBought = await run([
        'eval', "document.body.getAttribute('data-bought')", '--enable-actions', '--session', NAME,
      ])
      expect(notBought.env.data as string).toContain('null')

      // confirm path: request → confirm → the click fires (data-bought set).
      const p2 = await run([
        'click', `@${buyRef}`, '--enable-actions', '--two-phase-confirm', '--session', NAME,
      ])
      const id2 = (p2.env.data as { confirmation_id: string }).confirmation_id
      const confirmed = await run(['confirm', id2, '--enable-actions', '--session', NAME])
      expect(confirmed.env.success).toBe(true)
      expect((confirmed.env.data as { confirmed: string }).confirmed).toBe(id2)

      const bought = await run([
        'eval', "document.body.getAttribute('data-bought')", '--enable-actions', '--session', NAME,
      ])
      expect(bought.env.data as string).toContain('1')

      // One-shot: re-confirming the same id no longer resolves.
      const again = await run(['confirm', id2, '--enable-actions', '--session', NAME])
      expect(again.env.success).toBe(false)
    } finally {
      process.stdout.isTTY = origTTY
    }
  })
})
