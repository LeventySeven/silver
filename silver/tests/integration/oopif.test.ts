/**
 * E6 — cross-origin (OOPIF) iframe accessibility + frame-aware resolve.
 *
 * A cross-origin iframe runs OUT of the parent page's renderer process (an
 * "OOPIF"): the parent CDP session's `Accessibility.getFullAXTree({frameId})`
 * cannot cross the process/security boundary, so Stripe/OAuth/checkout/embedded
 * widgets were invisible to Silver (the unresolved vercel-labs #925 bug this
 * fork inherited). This test proves the fix end-to-end: a page embedding a
 * CROSS-ORIGIN iframe with a button → the button gets a ref, and a full-path
 * `act('click')` dispatches INSIDE the OOPIF.
 *
 * The OOPIF is forced deterministically: the host is served on `127.0.0.1` and
 * the iframe `src` on `localhost` (a different site), and Chromium is launched
 * with `--site-per-process` so the cross-site child is guaranteed to be
 * out-of-process (headless Chromium does not isolate loopback hosts otherwise).
 * We drive a directly-launched browser (not the session daemon) purely to add
 * that one launch flag; the code under test is unchanged.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright'
import { snapshotNodes, MAIN_FRAME_ID, type SnapNode } from '../../src/perception/walk.js'
import { render } from '../../src/perception/serialize.js'
import { groundRef, type RefMap } from '../../src/perception/refmap.js'
import { act } from '../../src/actuation/actions.js'
import { toLocator } from '../../src/actuation/resolve.js'

const CHILD_HTML = `<!doctype html><html><body>
  <button id="inner" onclick="window.__oopifClicked = true">Inner OOPIF Button</button>
  <input aria-label="oopif field">
</body></html>`

function findNode(nodes: SnapNode[], pred: (n: SnapNode) => boolean): SnapNode | undefined {
  return nodes.find(pred)
}

function refFor(map: RefMap, pred: (e: RefMap['entries'][string]) => boolean): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (pred(entry)) return ref
  }
  throw new Error('no matching ref in refmap')
}

describe('cross-origin OOPIF iframe perception + resolve (real Chromium, --site-per-process)', () => {
  let browser: Browser
  let context: BrowserContext
  let hostServer: Server
  let childServer: Server
  let hostUrl: string

  beforeAll(async () => {
    // Child (cross-origin, its own site → OOPIF) served on localhost.
    childServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(CHILD_HTML)
    })
    await new Promise<void>((r) => childServer.listen(0, 'localhost', r))
    const childPort = (childServer.address() as AddressInfo).port
    const childUrl = `http://localhost:${childPort}/`

    // Host served on 127.0.0.1 (a different site from `localhost`).
    const hostHtml = `<!doctype html><html><body>
      <h1>Host Page</h1>
      <button>Outer</button>
      <iframe id="child" width="400" height="200" src="${childUrl}"></iframe>
    </body></html>`
    hostServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(hostHtml)
    })
    await new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', r))
    const hostPort = (hostServer.address() as AddressInfo).port
    hostUrl = `http://127.0.0.1:${hostPort}/`

    browser = await chromium.launch({ headless: true, args: ['--site-per-process'] })
    context = await browser.newContext()
  }, 60_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await new Promise<void>((r) => hostServer?.close(() => r()))
    await new Promise<void>((r) => childServer?.close(() => r()))
  })

  it(
    'splices the OOPIF inline, mints a ref for the inner button, and click resolves INSIDE the OOPIF',
    async () => {
      const page: Page = await context.newPage()
      const cdp: CDPSession = await page.context().newCDPSession(page)
      try {
        await page.goto(hostUrl, { waitUntil: 'load' })
        // Let the cross-origin child commit its document in its own process.
        await page.waitForTimeout(500)

        // Precondition: the child really is out-of-process (a distinct Frame the
        // parent target's frame tree does not list). If this ever regressed to a
        // same-process frame, the same-process path would mask the OOPIF fix.
        const childFrame = page.frames().find((f) => f !== page.mainFrame())
        expect(childFrame, 'cross-origin child frame present').toBeTruthy()

        // --- 1. snapshot walks the main frame AND splices the OOPIF ---
        const nodes = await snapshotNodes(page, { interactive: true })

        const outer = findNode(nodes, (n) => n.role === 'button' && n.name === 'Outer')
        expect(outer, 'main-frame button present').toBeTruthy()
        expect(outer!.frameId).toBe(MAIN_FRAME_ID)

        const iframeHost = findNode(nodes, (n) => n.role === 'Iframe')
        expect(iframeHost, 'iframe host node present').toBeTruthy()

        // The button INSIDE the cross-origin frame was spliced in from the OOPIF
        // session — invisible before E6.
        const inner = findNode(
          nodes,
          (n) => n.role === 'button' && n.name === 'Inner OOPIF Button',
        )
        expect(inner, 'inner OOPIF button spliced from the cross-origin frame').toBeTruthy()
        expect(inner!.refEligible, 'inner OOPIF button is ref-eligible').toBe(true)
        expect(inner!.frameId).not.toBe(MAIN_FRAME_ID)
        expect(inner!.frameId.length).toBeGreaterThan(0)
        // Nested one semantic level deeper than its Iframe host.
        expect(inner!.level).toBeGreaterThan(iframeHost!.level)

        // The inner <input aria-label="oopif field"> also came through the OOPIF.
        const innerField = findNode(
          nodes,
          (n) => n.role === 'textbox' && n.name === 'oopif field',
        )
        expect(innerField, 'inner OOPIF input spliced from the cross-origin frame').toBeTruthy()
        expect(innerField!.frameId).toBe(inner!.frameId)

        // --- 2. render mints a frame-scoped ref carrying the OOPIF's real id ---
        const { text, refmap } = render(
          nodes,
          { generation: 1, entries: {} },
          { generation: 1, title: 'Host', url: page.url() },
        )
        const innerRef = refFor(
          refmap,
          (e) => e.role === 'button' && e.name === 'Inner OOPIF Button',
        )
        expect(refmap.entries[innerRef].frameId).toBe(inner!.frameId)
        expect(text).toContain('Inner OOPIF Button')

        // --- 3. toLocator resolves the OOPIF ref inside the OWNING frame ---
        const grounded = groundRef(refmap, `@${innerRef}`)
        expect(grounded.ok).toBe(true)
        if (!grounded.ok) throw new Error('grounding failed')

        const loc = await toLocator(page, cdp, grounded.entry, grounded.ref)
        expect(await loc.count()).toBe(1)
        expect(await loc.textContent()).toBe('Inner OOPIF Button')

        // --- 4. full act() click path -> the flag flips INSIDE the OOPIF ---
        const clickEnv = await act(page, cdp, 'click', innerRef, undefined, refmap, {})
        expect(clickEnv.success).toBe(true)

        const clickedInside = await childFrame!.evaluate(
          () => (window as unknown as { __oopifClicked?: boolean }).__oopifClicked === true,
        )
        expect(clickedInside, 'the click dispatched inside the cross-origin OOPIF').toBe(true)

        // No leakage across the process boundary into the host document.
        const mainFlag = await page.evaluate(
          () => (window as unknown as { __oopifClicked?: boolean }).__oopifClicked === true,
        )
        expect(mainFlag).toBe(false)
      } finally {
        await cdp.detach().catch(() => {})
        await page.close().catch(() => {})
      }
    },
    60_000,
  )
})
