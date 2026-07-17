import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'

// The taste-filtered Playwright-parity SUPERSET additions (all keyless, grounded,
// security-preserving). One file per capability group, real Chromium via run().
const NAME = `silver-superset-${process.pid}-${Date.now()}`
const NAME_B = `${NAME}-b`
// state save/load writes a real file; keep it INSIDE the CWD (assertContainedPath).
const STATE_FILE = `.silver-superset-state-${process.pid}.json`

const MAIN = `<!doctype html><html><head><title>Superset</title></head><body>
  <h1>Silver Superset</h1>
  <button id="t"
    oncontextmenu="this.setAttribute('data-ctx','1');return false"
    onclick="if(event.shiftKey)this.setAttribute('data-shift','1')"
    data-tag="TARGET">Target</button>
  <div id="spin">Loading spinner</div>
  <script>setTimeout(function(){var s=document.getElementById('spin');if(s)s.remove();},400)</script>
</body></html>`

const COOKIE_PAGE = `<!doctype html><html><head><title>Cookie</title></head><body>
  <h1>cookie page</h1>
  <script>document.cookie='sid=supersecretvalue; path=/';</script>
</body></html>`

const LOG_PAGE = `<!doctype html><html><head><title>Logs</title></head><body>
  <h1>logs</h1>
  <script>console.log('loginfo-msg');console.error('errmsg-boom');</script>
</body></html>`

const DIALOG_PAGE = `<!doctype html><html><head><title>Dialog</title></head><body>
  <button id="p" onclick="this.setAttribute('data-confirmed', confirm('proceed?') ? 'yes' : 'no')">Proceed</button>
</body></html>`

let server: Server
let base: string

async function firstButtonRef(session: string): Promise<string> {
  const map = await loadRefMap(session)
  if (!map) throw new Error('no refmap')
  for (const [ref, e] of Object.entries(map.entries)) if (e.role === 'button') return ref
  throw new Error('no button ref in refmap')
}

describe('Playwright-parity superset (real Chromium via run())', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/cookie')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(COOKIE_PAGE)
        return
      }
      if (url.startsWith('/logs')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(LOG_PAGE)
        return
      }
      if (url.startsWith('/dialog')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(DIALOG_PAGE)
        return
      }
      if (url.startsWith('/api')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('apibody-content-xyz')
        return
      }
      // A response whose HEADER value carries a card-shaped digit run — proves the
      // fetch-header path is neutralized through the same redaction choke as XHR.
      if (url.startsWith('/cardhdr')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-note': '4111111111111111' })
        res.end('ok')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(MAIN)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://localhost:${port}`
  })

  afterAll(async () => {
    for (const s of [NAME, NAME_B]) {
      try {
        await closeSession(s)
      } catch {
        /* ignore */
      }
    }
    await fs.rm(STATE_FILE, { force: true }).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('#1 click --button (right) and --modifiers (Shift) fold onto the grounded click', async () => {
    await run(['open', base, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstButtonRef(NAME)

    const rc = await run(['click', ref, '--button', 'right', '--enable-actions', '--session', NAME])
    expect(rc.env.success).toBe(true)
    const ctx = await run(['get', 'attr', ref, 'data-ctx', '--session', NAME])
    expect(JSON.stringify(ctx.env.data)).toContain('1')

    const sc = await run(['click', ref, '--modifiers', 'Shift', '--enable-actions', '--session', NAME])
    expect(sc.env.success).toBe(true)
    const shift = await run(['get', 'attr', ref, 'data-shift', '--session', NAME])
    expect(JSON.stringify(shift.env.data)).toContain('1')

    // An invalid button fails LOUD (clean usage error, not a silent default).
    const bad = await run(['click', ref, '--button', 'sideways', '--enable-actions', '--session', NAME])
    expect(bad.env.success).toBe(false)
    expect(String(bad.env.error)).toContain('button')
  })

  it('#5 screenshot @ref is element-scoped; --type jpeg returns a JPEG', async () => {
    await run(['open', base, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstButtonRef(NAME)

    const el = await run(['screenshot', ref, '--session', NAME])
    expect(el.env.success).toBe(true)
    const eld = el.env.data as { image: string; ref?: string }
    expect(typeof eld.image).toBe('string')
    expect(eld.image.length).toBeGreaterThan(0)
    expect(eld.ref).toBeTruthy()

    const jpg = await run(['screenshot', ref, '--type', 'jpeg', '--quality', '40', '--session', NAME])
    // base64 of a JPEG (FF D8 FF) begins with "/9j/"; a PNG would begin "iVBOR".
    expect((jpg.env.data as { image: string }).image.startsWith('/9j/')).toBe(true)

    const full = await run(['screenshot', '--type', 'jpeg', '--session', NAME])
    expect((full.env.data as { image: string }).image.startsWith('/9j/')).toBe(true)
  })

  it('#7 wait --text-gone resolves when text disappears (read-only, no --fn)', async () => {
    await run(['open', base, '--session', NAME])
    const gone = await run(['wait', '--text-gone', 'Loading spinner', '--timeout', '6000', '--session', NAME])
    expect(gone.env.success).toBe(true)
    expect((gone.env.data as { waited: boolean }).waited).toBe(true)
  })

  it('#8 expect <text> text-visible passes when present, fails when absent', async () => {
    await run(['open', base, '--session', NAME])
    // Page matchers are matcher-first: `expect text-visible <text>` (like url-matches).
    const yes = await run(['expect', 'text-visible', 'Silver Superset', '--session', NAME])
    expect(yes.env.success).toBe(true)
    const no = await run(['expect', 'text-visible', 'Nonexistent ZZZ string', '--session', NAME])
    expect(no.env.success).toBe(false)
  })

  it('#9/#10 network route mocks a status + lists active routes', async () => {
    await run(['open', base, '--session', NAME])
    const routed = await run([
      'network', 'route', '**/mock-api*',
      '--status', '503', '--body', '{"mock":1}', '--content-type', 'application/json',
      '--enable-actions', '--session', NAME,
    ])
    expect(routed.env.success).toBe(true)
    expect((routed.env.data as { status: number }).status).toBe(503)

    const list = await run(['network', 'routes', '--session', NAME])
    expect((list.env.data as { total: number }).total).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(list.env.data)).toContain('503')

    const status = await run([
      'eval', "fetch('/mock-api').then(function(r){return r.status})",
      '--enable-actions', '--session', NAME,
    ])
    expect(String(status.env.data)).toContain('503')
    await run(['network', 'unroute', '--enable-actions', '--session', NAME])
  })

  it('#11 network request <index> --part body returns the captured (bounded, redacted) body', async () => {
    await run(['open', base, '--session', NAME])
    await run(['eval', "fetch('/api').then(function(r){return r.text()})", '--enable-actions', '--session', NAME])
    await run(['wait', '500', '--session', NAME]) // let the async body-capture .then settle

    const reqs = await run(['network', 'requests', '--filter', '/api', '--session', NAME])
    const items = (reqs.env.data as { requests: Array<{ index: number; url: string }> }).requests
    const apiReq = items.find((r) => r.url.includes('/api'))
    expect(apiReq).toBeTruthy()

    const body = await run(['network', 'request', String(apiReq!.index), '--part', 'body', '--session', NAME])
    expect(body.env.success).toBe(true)
    expect(String((body.env.data as { body: string | null }).body)).toContain('apibody-content-xyz')
  })

  it('#11 fetch response HEADERS are card-masked (no fetch/XHR redaction asymmetry)', async () => {
    await run(['open', base, '--session', NAME])
    await run(['eval', "fetch('/cardhdr').then(function(r){return r.status})", '--enable-actions', '--session', NAME])
    await run(['wait', '400', '--session', NAME])

    const reqs = await run(['network', 'requests', '--filter', '/cardhdr', '--session', NAME])
    const hit = (reqs.env.data as { requests: Array<{ index: number; url: string }> }).requests.find((r) =>
      r.url.includes('/cardhdr'),
    )
    expect(hit).toBeTruthy()

    const resp = await run(['network', 'request', String(hit!.index), '--part', 'response', '--session', NAME])
    // The card-shaped header value must be redacted — it must NEVER appear raw.
    expect(JSON.stringify(resp.env)).not.toContain('4111111111111111')
  })

  it('#12 storage delete removes one key; gated without --enable-actions', async () => {
    await run(['open', base, '--session', NAME])
    await run(['storage', 'local', 'set', 'dk', 'dv', '--enable-actions', '--session', NAME])

    const denied = await run(['storage', 'local', 'delete', 'dk', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const del = await run(['storage', 'local', 'delete', 'dk', '--enable-actions', '--session', NAME])
    expect(del.env.success).toBe(true)
    const got = await run(['storage', 'local', 'get', 'dk', '--session', NAME])
    expect((got.env.data as { value: string | null }).value).toBeNull()
  })

  it('#13 cookies list/get REDACT the value (no token leak); delete is gated then removes', async () => {
    await run(['open', `${base}/cookie`, '--session', NAME])

    const list = await run(['cookies', 'list', '--session', NAME])
    expect(list.env.success).toBe(true)
    // The raw session-token value must NEVER appear in the envelope.
    expect(JSON.stringify(list.env)).not.toContain('supersecretvalue')
    const sid = (list.env.data as { cookies: Array<{ name: string; value: string; valueLength: number }> }).cookies.find(
      (c) => c.name === 'sid',
    )
    expect(sid).toBeTruthy()
    expect(sid!.value).toBe('[redacted]')
    expect(sid!.valueLength).toBe('supersecretvalue'.length)

    const get = await run(['cookies', 'get', 'sid', '--session', NAME])
    expect((get.env.data as { found: boolean }).found).toBe(true)
    expect(JSON.stringify(get.env)).not.toContain('supersecretvalue')

    const denied = await run(['cookies', 'delete', 'sid', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    await run(['cookies', 'delete', 'sid', '--enable-actions', '--session', NAME])
    const after = await run(['cookies', 'get', 'sid', '--session', NAME])
    expect((after.env.data as { found: boolean }).found).toBe(false)
  })

  it('#14 state load replays per-origin localStorage into a fresh session', async () => {
    await run(['open', base, '--session', NAME])
    await run(['storage', 'local', 'set', 'stok', 'seedvalue123', '--enable-actions', '--session', NAME])
    const saved = await run(['state', 'save', STATE_FILE, '--session', NAME])
    expect(saved.env.success).toBe(true)

    // Fresh session B: load the state, then open the SAME origin — the seed init
    // script must restore localStorage (the regression this fixes).
    const loaded = await run(['state', 'load', STATE_FILE, '--session', NAME_B])
    expect(loaded.env.success).toBe(true)
    expect((loaded.env.data as { localStorageKeys: number }).localStorageKeys).toBeGreaterThanOrEqual(1)

    await run(['open', base, '--session', NAME_B])
    const got = await run(['storage', 'local', 'get', 'stok', '--session', NAME_B])
    expect(String((got.env.data as { value: string | null }).value)).toContain('seedvalue123')
  })

  it('#15 eval @ref runs against the grounded element; gated without --enable-actions', async () => {
    await run(['open', base, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstButtonRef(NAME)

    const denied = await run(['eval', ref, 'el => el.getAttribute("data-tag")', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const ok = await run(['eval', ref, 'el => el.getAttribute("data-tag")', '--enable-actions', '--session', NAME])
    expect(ok.env.success).toBe(true)
    expect(String(ok.env.data)).toContain('TARGET')
  })

  it('#16 console --level filters to a single level', async () => {
    await run(['open', `${base}/logs`, '--session', NAME])
    const errs = await run(['console', '--level', 'error', '--session', NAME])
    expect(String(errs.env.data)).toContain('errmsg-boom')
    expect(String(errs.env.data)).not.toContain('loginfo-msg')
  })

  it('#17 dialog dismiss genuinely Cancels a confirm(); accept proceeds', async () => {
    await run(['open', `${base}/dialog`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref = await firstButtonRef(NAME)

    const armed = await run(['dialog', 'dismiss', '--enable-actions', '--session', NAME])
    expect((armed.env.data as { armed: string }).armed).toBe('dismiss')
    await run(['click', ref, '--enable-actions', '--session', NAME])
    const no = await run(['get', 'attr', ref, 'data-confirmed', '--session', NAME])
    expect(JSON.stringify(no.env.data)).toContain('no')

    // Re-arm accept, re-open a clean page, click again → confirm() returns true.
    await run(['dialog', 'accept', '--enable-actions', '--session', NAME])
    await run(['open', `${base}/dialog`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const ref2 = await firstButtonRef(NAME)
    await run(['click', ref2, '--enable-actions', '--session', NAME])
    const yes = await run(['get', 'attr', ref2, 'data-confirmed', '--session', NAME])
    expect(JSON.stringify(yes.env.data)).toContain('yes')
  })

  it('#4 find LOCATES read-only (no grant); the acting form gates; regex matches', async () => {
    await run(['open', base, '--session', NAME])

    // Read-only locate — no --enable-actions needed now.
    const loc = await run(['find', 'role', 'button', '--name', 'Target', '--session', NAME])
    expect(loc.env.success).toBe(true)
    expect((loc.env.data as { matched: number }).matched).toBeGreaterThanOrEqual(1)

    // Regex value (a /pattern/ opt-in matcher).
    const rx = await run(['find', 'text', '/Sil.er/', '--session', NAME])
    expect(rx.env.success).toBe(true)
    expect((rx.env.data as { matched: number }).matched).toBeGreaterThanOrEqual(1)

    // The ACTING form still requires the grant (gated in-handler).
    const actDenied = await run(['find', 'role', 'button', '--name', 'Target', 'click', '--session', NAME])
    expect(actDenied.env.success).toBe(false)
    expect(actDenied.env.error).toBe(ERRORS.not_permitted.message)
  })
})
