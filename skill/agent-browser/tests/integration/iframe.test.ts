import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CDPSession, Frame } from 'playwright'
import { openSession, connect, closeSession, saveRefMap } from '../../src/core/session.js'
import {
  snapshotNodes,
  SelectorScopeError,
  type SnapNode,
  MAIN_FRAME_ID,
} from '../../src/perception/walk.js'
import { render } from '../../src/perception/serialize.js'
import { groundRef, type RefMap } from '../../src/perception/refmap.js'
import { act } from '../../src/actuation/actions.js'
import { toLocator } from '../../src/actuation/resolve.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `moxxie-iframe-${process.pid}-${Date.now()}`

// A host page embedding a SAME-ORIGIN (srcdoc, same-process) iframe whose inner
// <button id=inner> flips a flag on click — the ground truth that a click landed
// INSIDE the child frame.
const HOST = readFileSync(
  fileURLToPath(new URL('../fixtures/iframe-host.html', import.meta.url)),
  'utf8',
)

function findNode(nodes: SnapNode[], pred: (n: SnapNode) => boolean): SnapNode | undefined {
  return nodes.find(pred)
}

function refFor(map: RefMap, pred: (e: RefMap['entries'][string]) => boolean): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (pred(entry)) return ref
  }
  throw new Error('no matching ref in refmap')
}

describe('iframe perception + frame-aware resolve (real Chromium, same-process iframe)', () => {
  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'splices the child frame inline, mints a ref for the inner button, and click resolves INSIDE the frame',
    async () => {
      await openSession(NAME, { headed: false })
      const { browser, page } = await connect(NAME)
      const cdp: CDPSession = await page.context().newCDPSession(page)
      try {
        await page.setContent(HOST, { waitUntil: 'load' })
        // Let the child frame commit its srcdoc document.
        await page.waitForTimeout(300)

        // --- 1. snapshot walks the main frame AND splices the child frame ---
        const nodes = await snapshotNodes(page, { interactive: true })

        // The host <button>Outer</button> lives in the main frame.
        const outer = findNode(nodes, (n) => n.role === 'button' && n.name === 'Outer')
        expect(outer, 'main-frame button present').toBeTruthy()
        expect(outer!.frameId).toBe(MAIN_FRAME_ID)

        // The iframe host node is present (role Iframe, ref-eligible).
        const iframeHost = findNode(nodes, (n) => n.role === 'Iframe')
        expect(iframeHost, 'iframe host node present').toBeTruthy()

        // The INNER button was spliced in, tagged with the child frame's real id.
        const inner = findNode(nodes, (n) => n.role === 'button' && n.name === 'Inner Button')
        expect(inner, 'inner button spliced from the child frame').toBeTruthy()
        expect(inner!.refEligible, 'inner button is ref-eligible').toBe(true)
        expect(inner!.frameId).not.toBe(MAIN_FRAME_ID)
        expect(inner!.frameId.length).toBeGreaterThan(0)
        // Nested one semantic level deeper than its Iframe host.
        expect(inner!.level).toBeGreaterThan(iframeHost!.level)

        // The inner <input aria-label="inner field"> also came through the frame.
        const innerField = findNode(nodes, (n) => n.role === 'textbox' && n.name === 'inner field')
        expect(innerField, 'inner input spliced from the child frame').toBeTruthy()
        expect(innerField!.frameId).toBe(inner!.frameId)

        // --- 2. render mints a frame-scoped ref (globally-unique eN) for it ---
        const { text, refmap } = render(
          nodes,
          { generation: 1, entries: {} },
          { generation: 1, title: 'Host', url: page.url() },
        )
        await saveRefMap(NAME, refmap)

        const innerRef = refFor(
          refmap,
          (e) => e.role === 'button' && e.name === 'Inner Button',
        )
        // The RefEntry carries the child frame id (the plumbing resolve uses).
        expect(refmap.entries[innerRef].frameId).toBe(inner!.frameId)
        // The snapshot text shows a ref line for the inner button.
        expect(text).toContain('ref=')
        expect(text).toContain('Inner Button')

        // --- 3. toLocator resolves the frame-scoped ref inside the OWNING frame ---
        const grounded = groundRef(refmap, `@${innerRef}`)
        expect(grounded.ok).toBe(true)
        if (!grounded.ok) throw new Error('grounding failed')

        const loc = await toLocator(page, cdp, grounded.entry, grounded.ref)
        expect(await loc.count()).toBe(1)
        expect(await loc.textContent()).toBe('Inner Button')

        // --- 4. click via the full act() path -> the flag flips INSIDE the frame ---
        const clickEnv = await act(page, cdp, 'click', innerRef, undefined, refmap, {})
        expect(clickEnv.success).toBe(true)

        const childFrame: Frame | undefined = page
          .frames()
          .find((f) => f !== page.mainFrame())
        expect(childFrame, 'child frame present').toBeTruthy()
        const clickedInside = await childFrame!.evaluate(
          () => (window as unknown as { __innerClicked?: boolean }).__innerClicked === true,
        )
        expect(clickedInside, 'the click dispatched inside the child frame').toBe(true)

        // The main frame never received the click (no leakage across the boundary).
        const mainFlag = await page.evaluate(
          () => (window as unknown as { __innerClicked?: boolean }).__innerClicked === true,
        )
        expect(mainFlag).toBe(false)
      } finally {
        await cdp.detach().catch(() => {})
        await browser.close()
      }
    },
  )

  it(
    'selector-scope that matches nothing throws SelectorScopeError (fail-loud, P1-P3)',
    async () => {
      const { browser, page } = await connect(NAME)
      try {
        await page.setContent('<!doctype html><body><main><p>hi</p></main></body>', {
          waitUntil: 'load',
        })
        // A valid selector matching a real element scopes fine (no throw).
        const scoped = await snapshotNodes(page, { selectorScope: 'main' })
        expect(scoped.length).toBeGreaterThan(0)

        // A selector matching NO element must fail loudly, not return an empty tree.
        await expect(
          snapshotNodes(page, { selectorScope: '#definitely-not-here' }),
        ).rejects.toBeInstanceOf(SelectorScopeError)
      } finally {
        await browser.close()
      }
    },
  )
})
