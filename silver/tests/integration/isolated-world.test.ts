import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome, setNamespace } from '../../src/core/session.js'

/**
 * PERCEPTION MUST NOT READ THE DOM THROUGH THE PAGE'S OWN JAVASCRIPT.
 *
 * Silver's whole claim is that fabricated data is structurally impossible: the
 * host acts on `@ref` handles minted from what silver actually OBSERVED. That
 * holds only if the observation cannot be authored by the observed. Running the
 * in-page scan in the page's MAIN world broke exactly that — a page that
 * monkey-patches `document.querySelectorAll` (or `Element.prototype.getAttribute`)
 * hands the perception layer a DOM of its choosing. This is an INTEGRITY test;
 * any anti-detection benefit is incidental.
 *
 * The fixture below has to attack the SCAN, not the tree. Refs themselves come
 * from `Accessibility.getFullAXTree` over CDP, which never runs page JS, so a
 * test on a real `<button>` would pass before the fix and prove nothing — the
 * `<button>` here is the CONTROL that shows the fixture has not simply broken
 * the page. The assertion targets a `cursor:pointer` div, which is ref-eligible
 * ONLY through the SCAN_JS cursor cascade (its AX role is generic and it has no
 * name of its own).
 */

const SUFFIX = `${process.pid}-${Date.now()}`
const NS = `isoworld-${SUFFIX}`

/**
 * The hostile page. `document.querySelectorAll` is replaced with a liar, so any
 * scan that walks the DOM through main-world JS sees an empty document; the
 * `getAttribute` patch is the same lie one layer down (role/tabindex/type reads).
 * Nothing here throws — a lying page that crashes is a page you would notice.
 */
const PATCHED_PAGE = `<!doctype html><html><body>
  <div id="ptr" style="cursor:pointer">Order Now Please</div>
  <button id="real">Genuine Button</button>
  <script>
    document.querySelectorAll = function () { return [] }
    Element.prototype.getAttribute = function () { return null }
  </script>
</body></html>`

/**
 * An HONEST page that pins the one measured COST of moving to an isolated world.
 * `el.onclick` is a PER-WORLD JS binding: a handler assigned from main-world JS
 * reads back `null` from an isolated world (measured on Chromium 1.61 — main
 * `[onclick!==null]=true`, isolated `false`). The `onclick=""` CONTENT attribute
 * is real DOM and survives the boundary via `hasAttribute` (measured: `true` in
 * both worlds), so the common inline case is unaffected.
 */
const ONCLICK_PAGE = `<!doctype html><html><body>
  <div id="attr" onclick="void 0">Inline Attr Div</div>
  <div id="oc">Legacy Handler Div</div>
  <script>document.getElementById('oc').onclick = function () { return 1 }</script>
</body></html>`

let server: Server
let base: string
/** Snapshot ONCE per session: a re-snapshot returns a diff, not the tree. */
let patchedSnap = ''
let onclickSnap = ''

/** The rendered line carrying `name`, or '' — so a ref can be asserted per line. */
function lineFor(snap: string, name: string): string {
  return snap.split('\n').find((l) => l.includes(name)) ?? ''
}

describe('perception reads an isolated world the page cannot patch (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(req.url === '/onclick' ? ONCLICK_PAGE : PATCHED_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`

    await run(['open', base, '--session', 'p', '--namespace', NS])
    const a = await run(['snapshot', '-i', '--session', 'p', '--namespace', NS])
    expect(a.env.success).toBe(true)
    patchedSnap = String(a.env.data)

    await run(['open', `${base}onclick`, '--session', 'o', '--namespace', NS])
    const b = await run(['snapshot', '-i', '--session', 'o', '--namespace', NS])
    expect(b.env.success).toBe(true)
    onclickSnap = String(b.env.data)
  })

  afterAll(async () => {
    await run(['close', '--all', '--namespace', NS]).catch(() => {})
    await fs
      .rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true })
      .catch(() => {})
    setNamespace('')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('CONTROL: the AX-derived button survives — the fixture did not break the page', () => {
    // Refs come from CDP's AX tree, which runs no page JS. If this fails, the
    // fixture broke the page itself and the real assertion below means nothing.
    expect(patchedSnap).toContain('Genuine Button')
  })

  it('still sees a cursor:pointer div on a page that lies to main-world DOM reads', () => {
    // The enrichment SCAN_JS alone provides. With the scan in the main world the
    // patched `querySelectorAll` returns [], the cursor cascade records nothing,
    // and this clickable div silently stops being offered to the host.
    expect(patchedSnap).toContain('Order Now Please')
    expect(lineFor(patchedSnap, 'Order Now Please')).toMatch(/ref=e\d+/)
  })

  it('keeps the inline onclick="" attribute signal — it is real DOM, not a JS binding', () => {
    expect(lineFor(onclickSnap, 'Inline Attr Div')).toMatch(/ref=e\d+/)
  })

  it('DOCUMENTED COST: a JS-assigned el.onclick is invisible from the isolated world', () => {
    // Deliberate, measured trade. `el.onclick` is per-world, so a handler set by
    // main-world JS cannot be seen from the isolated world. Recovering it would
    // mean a SECOND full main-world walk — double the per-snapshot scan cost, run
    // in the very world we stopped trusting, and a page that lies about
    // `querySelectorAll` would simply return [] there too. So it buys nothing
    // against the attack and only helps benign pages, in a narrow case:
    // `addEventListener` handlers were ALREADY invisible to this probe, inline
    // `onclick=""` still works (test above), and a real <a>/<button> is
    // ref-eligible from the AX tree regardless. What is left is a legacy
    // JS-assigned handler on an element with no pointer cursor, no tabindex and
    // no contenteditable — i.e. one that does not look clickable to a human
    // either. If that signal is ever recovered world-independently, DELETE this
    // test rather than weakening it.
    expect(onclickSnap).not.toContain('Legacy Handler Div')
  })
})
