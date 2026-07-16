import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'

// Batch 5 (adopt): S5 `wait --ready` (dual-quiet page-ready) + S6 structured
// markdown extraction for `read <url>`. Both are keyless, model-free.

const NAME = `silver-adopt5-${process.pid}-${Date.now()}`

// S5 fixture: appends DOM nodes on a timer for ~1s then STOPS, and fires ONE
// delayed fetch at ~500ms. After both settle the page is dual-quiet — `wait
// --ready` should resolve ready:true well before the 14s hard cap.
const SETTLE_PAGE = `<!doctype html><html><head><title>settle</title></head><body>
<h1>settling</h1><div id="log"></div>
<script>
  var n=0;
  var t=setInterval(function(){
    var d=document.createElement('p'); d.textContent='node '+(++n);
    document.getElementById('log').appendChild(d);
    if(n>=8) clearInterval(t);
  },110);
  setTimeout(function(){ fetch('/data').then(function(r){return r.text();}); },500);
</script></body></html>`

// S5 fixture: a trivially-static page — dual-quiet almost immediately.
const STATIC_PAGE = `<!doctype html><html><head><title>static</title></head><body>
<h1>totally static</h1><p>nothing changes here</p></body></html>`

// S6 fixture: nav + banner header + an <article> with h1/h2, links, and a list,
// plus an <aside> and <footer> (chrome that must be skipped) and a <script>
// (must be stripped AND never executed — a string parse can't run it).
const READ_PAGE = `<!doctype html><html><head><title>doc</title>
<script>window.__x='HACKSCRIPT'</script><style>.a{color:red}</style></head>
<body>
<nav><a href="/home">NAVIGATION_MENU</a></nav>
<header role="banner"><h1>SITE_BANNER_HEADING</h1></header>
<article>
  <h1>Article Heading</h1>
  <p>Lead paragraph mentioning &amp; ampersands and a <a href="/guide">Guide</a> link.</p>
  <h2>Second Section</h2>
  <ul><li>bullet one</li><li>bullet two</li></ul>
  <p>See the <a href="https://example.com/docs">Docs</a> for more.</p>
</article>
<aside>ASIDE_PROMO_BLURB</aside>
<footer>FOOTER_COPYRIGHT_LINE</footer>
</body></html>`

let server: Server
let base: string

describe('adopt Batch 5: wait --ready (S5) + read markdown (S6)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/data')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      if (url.startsWith('/static')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(STATIC_PAGE)
        return
      }
      if (url.startsWith('/read')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(READ_PAGE)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(SETTLE_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://localhost:${port}`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // --- S5: dual-quiet page-ready ------------------------------------------
  it('wait --ready resolves ready:true after a settling page quiets, before the hard cap', async () => {
    await run(['open', `${base}/dyn`, '--session', NAME])

    const t0 = Date.now()
    const r = await run(['wait', '--ready', '--session', NAME])
    const elapsed = Date.now() - t0

    expect(r.env.success).toBe(true)
    const data = r.env.data as { waited: boolean; ready: boolean; reason: string }
    expect(data.waited).toBe(true)
    expect(data.ready).toBe(true)
    expect(data.reason).toBe('ready')
    // It settled and returned FAR below the 14s hard cap (never hangs).
    expect(elapsed).toBeLessThan(12_000)
  }, 30_000)

  it('wait --ready is read-only (no --enable-actions) and returns quickly on a static page', async () => {
    await run(['open', `${base}/static`, '--session', NAME])

    const t0 = Date.now()
    const r = await run(['wait', '--ready', '--session', NAME])
    const elapsed = Date.now() - t0

    expect(r.env.success).toBe(true)
    const data = r.env.data as { ready: boolean; reason: string }
    expect(data.ready).toBe(true)
    // A trivially-static page is quiet quickly — comfortably under the soft cap.
    expect(elapsed).toBeLessThan(10_000)
  }, 30_000)

  it('wait --ready honors flags.timeout as the hard-cap override (never hangs)', async () => {
    // A page that mutates FOREVER never reaches DOM-quiet; the wait must still
    // return (ready:false, reason:timeout) at the overridden cap, never hang.
    await run(['open', `${base}/dyn`, '--session', NAME])
    const busy = `(function(){setInterval(function(){document.body.appendChild(document.createElement('span'));},50);})()`
    await run(['eval', busy, '--enable-actions', '--session', NAME])

    const t0 = Date.now()
    const r = await run(['wait', '--ready', '--timeout', '2500', '--session', NAME])
    const elapsed = Date.now() - t0

    expect(r.env.success).toBe(true)
    const data = r.env.data as { ready: boolean; reason: string }
    expect(data.ready).toBe(false)
    expect(data.reason).toBe('timeout')
    // Returned at ~the 2500ms override, well under the 14s default hard cap.
    expect(elapsed).toBeGreaterThanOrEqual(2_000)
    expect(elapsed).toBeLessThan(7_000)
  }, 30_000)

  // --- S6: structured markdown for read <url> -----------------------------
  it('read <url> yields landmark-skipped markdown (headings, list) excluding nav/footer/aside', async () => {
    const r = await run(['read', `${base}/read`, '--session', NAME])
    expect(r.env.success).toBe(true)
    const md = r.env.data as string

    // Headings mapped to markdown.
    expect(md).toContain('# Article Heading')
    expect(md).toContain('## Second Section')
    // List items mapped to bullets.
    expect(md).toContain('- bullet one')
    expect(md).toContain('- bullet two')
    // Entity decoded.
    expect(md).toContain('& ampersands')

    // Landmark chrome dropped entirely.
    expect(md).not.toContain('NAVIGATION_MENU')
    expect(md).not.toContain('SITE_BANNER_HEADING')
    expect(md).not.toContain('ASIDE_PROMO_BLURB')
    expect(md).not.toContain('FOOTER_COPYRIGHT_LINE')
    // Script content stripped AND never executed (pure string parse).
    expect(md).not.toContain('HACKSCRIPT')

    // Without --links, link TEXT survives but no `[text](url)` markup.
    expect(md).toContain('Guide')
    expect(md).toContain('Docs')
    expect(md).not.toContain('](')
  }, 20_000)

  it('read --links emits [text](url) with relative hrefs resolved against the page URL', async () => {
    const r = await run(['read', `${base}/read`, '--links', '--session', NAME])
    expect(r.env.success).toBe(true)
    const md = r.env.data as string

    // Absolute href preserved; relative href resolved against the fetched URL.
    expect(md).toContain('[Docs](https://example.com/docs)')
    expect(md).toContain(`[Guide](${base}/guide)`)
  }, 20_000)
})
