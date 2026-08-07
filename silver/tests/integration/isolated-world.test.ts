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
 * holds only if the observation cannot be authored by the observed. Two ways a
 * page could author it, both closed here:
 *   - INTERCEPT the read — monkey-patch `document.querySelectorAll` or
 *     `Element.prototype.getAttribute` and hand the scan a DOM of its choosing.
 *     Closed by running the scan in an isolated world.
 *   - REDIRECT the result — ship a copy of the scan's own idx tag and capture
 *     another element's record. Closed by a per-walk random tag name.
 *
 * The fixtures have to attack the SCAN, not the tree. Refs themselves come from
 * `Accessibility.getFullAXTree` over CDP, which never runs page JS, so a test on
 * a real `<button>` would pass before the fix and prove nothing — the `<button>`
 * below is the CONTROL that shows the fixture has not simply broken the page.
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
 * An HONEST page pinning the one measured COST of the isolated world.
 * `el.onclick` is a PER-WORLD JS binding: a handler assigned from main-world JS
 * reads back `null` from an isolated world (measured on Chromium 1.61 — main
 * `[onclick!==null]=true`, isolated `false`). The `onclick=""` CONTENT attribute
 * is real DOM and survives via `hasAttribute` (measured `true` in both worlds).
 */
const ONCLICK_PAGE = `<!doctype html><html><body>
  <div id="attr" onclick="void 0">Inline Attr Div</div>
  <div id="oc">Legacy Handler Div</div>
  <script>document.getElementById('oc').onclick = function () { return 1 }</script>
</body></html>`

/**
 * The shape that made the `el.onclick` loss expensive, and the reason click
 * wiring is now read from CDP rather than from page JS.
 *
 * `cursor` INHERITS, so every row below computes `pointer` from the container
 * and meets the parent-cursor dedup — which exists to stop every child of a
 * clickable card minting its own ref. Independent wiring is the only thing that
 * tells a real row from decoration, so when the scan lost sight of `el.onclick`
 * the rows collapsed INTO the container: one ref, named with the concatenated
 * child text, and a click landing on the container's centre. Measured against
 * base `0f5fe33`: 4 refs became 1.
 *
 * `Beta Row` uses `addEventListener`, which the old JS probe never saw on ANY
 * commit. It is here because the CDP listener registry does see it — this path
 * is not just restored, it is better than what it replaced.
 */
const ROWS_PAGE = `<!doctype html><html><body>
  <div id="card" style="cursor:pointer">
    <div id="a">Alpha Row</div>
    <div id="b">Beta Row</div>
    <div id="p">Plain Decoration</div>
  </div>
  <script>
    document.getElementById('a').onclick = function () { return 1 }
    document.getElementById('b').addEventListener('click', function () { return 1 })
  </script>
</body></html>`

/**
 * REDIRECTING the result. The scan tags matched elements and the walk joins
 * idx -> backendNodeId from the DOM in document order, last write wins — so a
 * page shipping its own copy of a FIXED tag captured a record. Measured before
 * the fix, on base and on the first cut of the isolated-world change alike: the
 * real clickable lost its ref and the decoy was offered in its place.
 */
const DECOY_PAGE = `<!doctype html><html><body>
  <div style="cursor:pointer">Real Clickable</div>
  <div data-__uab-idx="0" aria-label="DECOY ELEMENT">x</div>
  <div data-__uab-idx="1" aria-label="DECOY TWO">y</div>
</body></html>`

const PAGES: Record<string, string> = {
  '/': PATCHED_PAGE,
  '/onclick': ONCLICK_PAGE,
  '/rows': ROWS_PAGE,
  '/decoy': DECOY_PAGE,
}

let server: Server
let base: string
/** Snapshot ONCE per session: a re-snapshot returns a diff, not the tree. */
const snaps: Record<string, string> = {}

/** The rendered line carrying `name`, or '' — so a ref can be asserted per line. */
function lineFor(snap: string, name: string): string {
  return snap.split('\n').find((l) => l.includes(name)) ?? ''
}

describe('perception reads an isolated world the page cannot patch (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGES[req.url ?? '/'] ?? PATCHED_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`

    for (const [route, session] of [
      ['/', 'p'],
      ['/onclick', 'o'],
      ['/rows', 'r'],
      ['/decoy', 'd'],
    ]) {
      await run(['open', `${base}${route}`, '--session', session, '--namespace', NS])
      const res = await run(['snapshot', '-i', '--session', session, '--namespace', NS])
      expect(res.env.success, `snapshot ${route}`).toBe(true)
      snaps[route] = String(res.env.data)
    }
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
    expect(snaps['/']).toContain('Genuine Button')
  })

  it('still sees a cursor:pointer div on a page that lies to main-world DOM reads', () => {
    // The enrichment SCAN_JS alone provides. With the scan in the main world the
    // patched `querySelectorAll` returns [], the cursor cascade records nothing,
    // and this clickable div silently stops being offered to the host.
    expect(snaps['/']).toContain('Order Now Please')
    expect(lineFor(snaps['/'], 'Order Now Please')).toMatch(/ref=e\d+/)
  })

  it('keeps the inline onclick="" attribute signal — it is real DOM, not a JS binding', () => {
    expect(lineFor(snaps['/onclick'], 'Inline Attr Div')).toMatch(/ref=e\d+/)
  })

  it('keeps per-row refs inside a cursor:pointer card (JS onclick AND addEventListener)', () => {
    // The regression this file exists to prevent: rows wired independently must
    // stay individually addressable, or the host gets one ref named with the
    // concatenated child text and clicks the container's centre instead.
    expect(lineFor(snaps['/rows'], 'Alpha Row')).toMatch(/ref=e\d+/)
    expect(lineFor(snaps['/rows'], 'Beta Row')).toMatch(/ref=e\d+/)
    // Decoration inheriting the same cursor must NOT get its own ref — the
    // dedup still has to earn its keep, or every card floods the tree. Matched
    // on the QUOTED whole name: the container's own name is the concatenated
    // child text, so a substring test would find "Plain Decoration" inside it.
    expect(snaps['/rows']).not.toContain('"Plain Decoration"')
    // Exactly three: the card, and the two wired rows. Nothing else.
    expect(snaps['/rows'].match(/ref=e\d+/g) ?? []).toHaveLength(3)
  })

  it('a page-authored scan tag cannot capture a real element ref', () => {
    // REDIRECTING the read: the decoys ship the old fixed tag name.
    expect(lineFor(snaps['/decoy'], 'Real Clickable')).toMatch(/ref=e\d+/)
    expect(snaps['/decoy']).not.toContain('DECOY ELEMENT')
    expect(snaps['/decoy']).not.toContain('DECOY TWO')
  })

  it('DOCUMENTED COST: an element wired ONLY by a JS onclick, with no other signal', () => {
    // Deliberate, measured, and narrow. `el.onclick` is per-world, so a handler
    // set by main-world JS is invisible to the isolated scan. Everything that
    // LOOKS clickable is still caught: inline `onclick=""` (real DOM), a pointer
    // cursor, tabindex, contenteditable, a real <a>/<button> from the AX tree,
    // and — via the CDP listener registry — any element the dedup would drop.
    // What is left is an element with a JS-assigned handler and NO other signal
    // at all, which looks unclickable to a human too. Catching it would mean
    // tagging every element on the page so the walk could re-decide, which is
    // not worth it for that case. If it is ever recovered, DELETE this test
    // rather than weakening it.
    expect(snaps['/onclick']).not.toContain('Legacy Handler Div')
  })
})
