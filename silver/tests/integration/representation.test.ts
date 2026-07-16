import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Representation phase-1 primitives: `get html @eN`, `get box @eN`, and the
// `sparse_tree` advisory. Exercised end-to-end through the run() entry on real
// Chromium, mirroring verbs.test.ts.

const NAME = `silver-repr-${process.pid}-${Date.now()}`

// A canvas-DOMINANT page: one nameless icon button (empty a11y name — the exact
// case `get html` exists for) above a canvas that fills most of the viewport.
const CANVAS_PAGE = `<!doctype html>
<html><head><title>Canvas demo</title></head><body>
  <button id="icon" aria-label="" style="width:36px;height:36px">
    <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="currentColor"/></svg>
  </button>
  <canvas id="c" width="1200" height="800" style="display:block;width:100vw;height:88vh;background:#334"></canvas>
</body></html>`

// A healthy NORMAL page: several controls, NO canvas — must never trip sparse_tree.
const NORMAL_PAGE = `<!doctype html>
<html><head><title>Normal</title></head><body>
  <h1>Hello</h1>
  <button>Alpha</button>
  <button>Bravo</button>
  <a href="/next">Next</a>
  <input aria-label="search">
</body></html>`

// A canvas that dominates the viewport BUT with many interactive controls — the
// red-team "rich dashboard" case: canvas-dominance alone must NOT fire sparse_tree.
const CANVAS_BUSY_PAGE = `<!doctype html>
<html><head><title>Dashboard</title></head><body>
  <canvas id="c" width="1200" height="800" style="display:block;width:100vw;height:88vh;background:#334"></canvas>
  <button>b1</button><button>b2</button><button>b3</button><button>b4</button>
  <button>b5</button><button>b6</button><button>b7</button><button>b8</button>
</body></html>`

// A form whose serialized markup carries secrets `get html` must NOT leak (S3):
// a server-PREFILLED password value (survives into outerHTML, unlike a live-typed
// one), a password-HINTED input (name=pwd, type=text — caught by the belt-and-
// suspenders hint), a visible card number, and a plain input whose value must be
// KEPT (proves the per-<input> mask does not over-redact normal fields).
const REDACT_PAGE = `<!doctype html>
<html><head><title>Redact</title></head><body>
  <h1>Sign up</h1>
  <input type="password" value="prefilled-secret" aria-label="secretpass">
  <input type="text" name="pwd" value="hinted-secret" aria-label="hintedfield">
  <input type="text" value="4111 1111 1111 1111" aria-label="cardfield">
  <input type="text" value="keepme" aria-label="plainfield">
</body></html>`

let server: Server
let base: string

function firstRefWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role} in refmap`)
}

function refByName(map: RefMap, name: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.name === name) return ref
  }
  throw new Error(`no ref with name ${name} in refmap`)
}

describe('representation phase-1: get html / get box / sparse_tree', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      const body = url.startsWith('/normal')
        ? NORMAL_PAGE
        : url.startsWith('/busy')
          ? CANVAS_BUSY_PAGE
          : url.startsWith('/redact')
            ? REDACT_PAGE
            : CANVAS_PAGE
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(body)
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

  it('get html @eN returns the element outerHTML, neutralized + fenced, stamp-free', async () => {
    await run(['open', `${base}/x`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = firstRefWithRole(map!, 'button')

    const res = await run(['get', 'html', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const html = res.env.data as string
    // It is the ELEMENT's HTML (the icon button), not a whole-page dump.
    expect(html).toContain('<button')
    expect(html).toContain('id="icon"')
    // Page-derived → wrapped in the untrusted-content boundary fence.
    expect(html).toContain('page-content')
    // The internal grounding stamp must NOT leak into the returned HTML.
    expect(html).not.toContain('data-silver-ref')
  })

  it('get html without a ref is a clean bad-request', async () => {
    await run(['open', `${base}/x`, '--session', NAME])
    const res = await run(['get', 'html', '--session', NAME])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toContain('usage: silver get html')
  })

  it('get box @eN returns a plausible {x,y,width,height}', async () => {
    await run(['open', `${base}/x`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = firstRefWithRole(map!, 'button')

    const res = await run(['get', 'box', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const box = res.env.data as { x: number; y: number; width: number; height: number }
    expect(Number.isFinite(box.x)).toBe(true)
    expect(Number.isFinite(box.y)).toBe(true)
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
  })

  it('get html/box are READ-ONLY (no --enable-actions needed)', async () => {
    // Both ran above with no actions grant and succeeded — assert the negative too:
    // there is no `not_permitted` path for these read verbs.
    await run(['open', `${base}/x`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = firstRefWithRole(map!, 'button')
    const box = await run(['get', 'box', ref, '--session', NAME])
    expect(box.env.error).not.toBe(
      'that action is not enabled in the current phase; the session is read-only (pass --enable-actions to allow acting)',
    )
  })

  it('the default snapshot does NOT compute/store geometry on any RefEntry (no regression)', async () => {
    await run(['open', `${base}/x`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    expect(Object.keys(map!.entries).length).toBeGreaterThan(0)
    for (const entry of Object.values(map!.entries)) {
      const e = entry as Record<string, unknown>
      // Geometry is LAZY (red-team #3): boxes are computed on-demand by `get box`,
      // never persisted on the default walk's refmap.
      expect(e.box).toBeUndefined()
      expect(e.x).toBeUndefined()
      expect(e.width).toBeUndefined()
      expect(e.rect).toBeUndefined()
    }
  })

  it('sparse_tree FIRES on a canvas-dominant, ref-poor page', async () => {
    await run(['open', `${base}/x`, '--session', NAME])
    const snap = await run(['snapshot', '-i', '--session', NAME])
    expect(snap.env.success).toBe(true)
    expect(snap.env.warning ?? '').toContain('sparse_tree')
  })

  it('sparse_tree is SILENT on a healthy normal page (no canvas)', async () => {
    await run(['open', `${base}/normal`, '--session', NAME])
    const snap = await run(['snapshot', '-i', '--session', NAME])
    expect(snap.env.warning ?? '').not.toContain('sparse_tree')
  })

  it('sparse_tree is SILENT when canvas dominates but many refs exist (dashboard)', async () => {
    await run(['open', `${base}/busy`, '--session', NAME])
    const snap = await run(['snapshot', '-i', '--session', NAME])
    expect(snap.env.warning ?? '').not.toContain('sparse_tree')
  })

  // S3: `get html` is NOT a redaction hole. It must route the element's
  // outerHTML through the same redaction choke point as get text/value/attr.
  it('get html redacts a server-prefilled password value (not just live-typed)', async () => {
    await run(['open', `${base}/redact`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = refByName(map!, 'secretpass')

    const res = await run(['get', 'html', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const html = res.env.data as string
    expect(html).toContain('[redacted]')
    expect(html).not.toContain('prefilled-secret')
    // The masked value belongs to THIS password input.
    expect(html).toContain('type="password"')
  })

  it('get html redacts a password-HINTED input value (name=pwd, type=text)', async () => {
    await run(['open', `${base}/redact`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = refByName(map!, 'hintedfield')

    const res = await run(['get', 'html', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const html = res.env.data as string
    expect(html).toContain('[redacted]')
    expect(html).not.toContain('hinted-secret')
  })

  it('get html redacts a card-shaped digit run anywhere in the markup', async () => {
    await run(['open', `${base}/redact`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = refByName(map!, 'cardfield')

    const res = await run(['get', 'html', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const html = res.env.data as string
    expect(html).toContain('[redacted]')
    expect(html).not.toContain('4111')
  })

  it('get html KEEPS a normal input value and still strips data-silver-ref', async () => {
    await run(['open', `${base}/redact`, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const ref = refByName(map!, 'plainfield')

    const res = await run(['get', 'html', ref, '--session', NAME])
    expect(res.env.success).toBe(true)
    const html = res.env.data as string
    // Per-<input> masking must not over-redact a non-password, non-card field.
    expect(html).toContain('keepme')
    // The grounding stamp is still stripped (existing behavior preserved).
    expect(html).not.toContain('data-silver-ref')
  })
})
