import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'

// SOTA-alignment adopts (Aside/Vercel synthesis): [scrollable]/[focused] enrichment,
// interpolated ref-drag, and the annotated set-of-marks screenshot. Real Chromium.
const NAME = `silver-align-${process.pid}-${Date.now()}`

// A NAMELESS overflow:auto box with content overflow — proves a scroll container
// with no role/name still gets a ref + [scrollable] so the host can scroll it.
const SCROLL = `<!doctype html><html><head><title>Scroll</title></head><body>
  <h1>scroll page</h1>
  <div id="box" style="overflow:auto;height:100px;width:200px"><div style="height:2000px">tall</div></div>
</body></html>`

const FOCUS = `<!doctype html><html><head><title>Focus</title></head><body>
  <input id="inp" aria-label="the field">
</body></html>`

// Two buttons + a document-level mousemove counter — proves the ref-grounded drag
// fires INTERMEDIATE moves (interpolation), not just two endpoint hovers.
const DND = `<!doctype html><html><head><title>DnD</title></head><body>
  <button id="src">SRC</button>
  <button id="dst" style="margin-top:120px">DST</button>
  <script>window.__mm=0;document.addEventListener('mousemove',function(){window.__mm++});</script>
</body></html>`

const MARKS = `<!doctype html><html><head><title>Marks</title></head><body>
  <button>Alpha</button><button>Beta</button><a href="#">Gamma</a>
</body></html>`

let server: Server
let base: string

async function firstRefWithRole(session: string, role: string): Promise<string> {
  const map = await loadRefMap(session)
  if (!map) throw new Error('no refmap')
  for (const [ref, e] of Object.entries(map.entries)) if (e.role === role) return ref
  throw new Error(`no ${role} ref`)
}

describe('SOTA alignment adopts (real Chromium via run())', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = req.url ?? '/'
      const body = u.startsWith('/focus') ? FOCUS : u.startsWith('/dnd') ? DND : u.startsWith('/marks') ? MARKS : SCROLL
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('[scrollable]: a nameless overflow:auto box gets a ref + [scrollable], and scroll @ref --by moves it', async () => {
    await run(['open', `${base}/scroll`, '--session', NAME])
    const snap = await run(['snapshot', '-i', '--session', NAME])
    expect(String(snap.env.data)).toContain('scrollable')
    // The scroll box (role generic) is now ref-eligible — find it and scroll its own box.
    const ref = await firstRefWithRole(NAME, 'generic').catch(() => firstRefWithRole(NAME, 'group'))
    const scrolled = await run(['scroll', ref, '--by', '0', '150', '--enable-actions', '--session', NAME])
    expect(scrolled.env.success).toBe(true)
    const top = await run(['eval', "document.getElementById('box').scrollTop", '--enable-actions', '--session', NAME])
    expect(Number(String(top.env.data).replace(/[^\d.]/g, ''))).toBeGreaterThan(0)
  })

  it('scroll box minted via a FULL (non-interactive) snapshot still grounds + scrolls (mint-mode re-match)', async () => {
    // The misground bug was a mint-mode mismatch: a nameless generic minted in
    // non-interactive mode re-matched in interactive mode. Mint via full `snapshot`
    // (interactive:false) and confirm the scroll box grounds + its mode is recorded.
    await run(['open', `${base}/scroll`, '--session', NAME])
    const full = await run(['snapshot', '--session', NAME]) // NON-interactive
    expect(String(full.env.data)).toContain('scrollable')
    const map = await loadRefMap(NAME)
    const scrollEntry = Object.values(map!.entries).find((e) => e.role === 'generic' || e.role === 'group')
    expect(scrollEntry).toBeTruthy()
    // The mint mode is persisted as non-interactive so the slow-path re-match agrees.
    expect((scrollEntry as { interactive?: boolean }).interactive).toBe(false)
    const ref = await firstRefWithRole(NAME, 'generic').catch(() => firstRefWithRole(NAME, 'group'))
    const scrolled = await run(['scroll', ref, '--by', '0', '120', '--enable-actions', '--session', NAME])
    expect(scrolled.env.success).toBe(true)
  })

  it('[focused]: the control holding keyboard focus renders [focused] in the snapshot', async () => {
    await run(['open', `${base}/focus`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstRefWithRole(NAME, 'textbox')
    await run(['focus', ref, '--enable-actions', '--session', NAME])
    const snap = await run(['snapshot', '-i', '--session', NAME])
    expect(String(snap.env.data)).toContain('focused')
  })

  it('interpolated ref-drag fires intermediate mousemove events (DnD libs register the drag)', async () => {
    await run(['open', `${base}/dnd`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const buttons = Object.entries(map!.entries).filter(([, e]) => e.role === 'button')
    const src = buttons[0][0]
    const dst = buttons[1][0]
    await run(['drag', src, dst, '--enable-actions', '--session', NAME])
    const mm = await run(['eval', 'window.__mm', '--enable-actions', '--session', NAME])
    // A two-endpoint dragTo would give ~2; interpolation gives >=6 (steps+1). Assert >2.
    expect(Number(String(mm.env.data).replace(/[^\d]/g, ''))).toBeGreaterThan(2)
  })

  it('get styles @ref returns the requested computed CSS of a grounded element', async () => {
    await run(['open', `${base}/focus`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstRefWithRole(NAME, 'textbox')
    const st = await run(['get', 'styles', ref, 'display', 'visibility', '--session', NAME])
    expect(st.env.success).toBe(true)
    const d = st.env.data as Record<string, string>
    expect(String(d.display)).toContain('inline') // <input> is inline-block
    expect(String(d.visibility)).toContain('visible')
  })

  it('screenshot --annotated draws a set-of-marks overlay over the current refs; errors without a snapshot', async () => {
    // Fresh session (no snapshot yet) → clean error.
    const fresh = `${NAME}-x`
    await run(['open', `${base}/marks`, '--session', fresh])
    const noSnap = await run(['screenshot', '--annotated', '--session', fresh])
    expect(noSnap.env.success).toBe(false)

    await run(['snapshot', '-i', '--session', fresh])
    const shot = await run(['screenshot', '--annotated', '--session', fresh])
    expect(shot.env.success).toBe(true)
    const d = shot.env.data as { image: string; annotated: number }
    expect(d.annotated).toBeGreaterThanOrEqual(2) // Alpha/Beta/Gamma
    expect(typeof d.image).toBe('string')
    expect(d.image.length).toBeGreaterThan(0)
    await closeSession(fresh).catch(() => {})
  })
})
