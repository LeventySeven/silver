import { describe, it, expect, afterAll } from 'vitest'
import type { CDPSession } from 'playwright'
import { openSession, connect, closeSession, saveRefMap } from '../../src/core/session.js'
import { snapshotNodes } from '../../src/perception/walk.js'
import { render } from '../../src/perception/serialize.js'
import { groundRef, newGeneration, type RefMap } from '../../src/perception/refmap.js'
import { act } from '../../src/actuation/actions.js'
import { settleAndFingerprint } from '../../src/actuation/pagechange.js'
import { ERRORS } from '../../src/core/errors.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `moxxie-act-${process.pid}-${Date.now()}`

// A text input, a button that MUTATES the DOM (appends a node -> domNodeCount
// changes -> the page-change fingerprint changes), and a "guard" button whose
// onclick sets a flag we watch to PROVE a stale ref never dispatches.
const FIXTURE = `<!doctype html>
<html><body>
  <input id="inp" type="text" aria-label="Name field">
  <button id="add" onclick="var d=document.createElement('div');d.className='added';d.textContent='added';document.body.appendChild(d);">Add Item</button>
  <button id="guard" onclick="window.__guardClicked=true;">Guard</button>
</body></html>`

function refFor(map: RefMap, role: string, name: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role && entry.name === name) return ref
  }
  throw new Error(`no ref for ${role} "${name}" in refmap`)
}

async function takeSnapshot(
  page: import('playwright').Page,
  generation: number,
  prev: RefMap | null,
): Promise<RefMap> {
  const nodes = await snapshotNodes(page, { interactive: true })
  const { refmap } = render(
    nodes,
    { generation, entries: {} },
    { generation, title: 'Fixture', url: page.url(), prevRefmap: prev },
  )
  return refmap
}

describe('actuation (real Chromium, Playwright delegation + stale-ref guard)', () => {
  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'fills, reflects DOM mutation in the page-change flag, and REFUSES a stale ref (red-team R4)',
    async () => {
      await openSession(NAME, { headed: false })
      const { browser, page } = await connect(NAME)
      const cdp: CDPSession = await page.context().newCDPSession(page)
      try {
        await page.setContent(FIXTURE, { waitUntil: 'load' })

        // --- 1. snapshot -> generation 1 refmap (mint refs for input + buttons) ---
        const map1 = await takeSnapshot(page, 1, null)
        await saveRefMap(NAME, map1)
        const inputRef = refFor(map1, 'textbox', 'Name field')
        const addRef = refFor(map1, 'button', 'Add Item')
        const guardRef = refFor(map1, 'button', 'Guard')

        // --- 2. fill @input "hello" -> the control's value is "hello" ---
        const fillEnv = await act(page, cdp, 'fill', inputRef, 'hello', map1, {})
        expect(fillEnv.success).toBe(true)
        expect(fillEnv.data?.value).toBe('hello')
        expect(await page.locator('#inp').inputValue()).toBe('hello')

        // --- 3. click a DOM-mutating button -> settleAndFingerprint: page_changed ---
        const before = await settleAndFingerprint(page, null, 1)
        const clickEnv = await act(page, cdp, 'click', addRef, undefined, map1, {})
        expect(clickEnv.success).toBe(true)
        expect(await page.locator('.added').count()).toBe(1)

        const change = await settleAndFingerprint(page, before.fingerprint, 1)
        expect(change.fingerprint).not.toBe(before.fingerprint)
        expect(change.page_changed).toBe(true)
        expect(change.stale_refs).toBe(true)
        expect(change.generation).toBe(1)

        // --- 4. STALE-REF GUARD: re-snapshot to generation 2, then act on a ref
        //        carrying generation 1 against the gen-2-current refmap. The
        //        grounding gate MUST flag it stale and the action MUST NOT fire. ---
        const gen2 = newGeneration(map1.generation) // 2
        await takeSnapshot(page, gen2, map1) // current session is now generation 2

        // The map the CLI would ground against: current generation is 2, but the
        // entry the host still holds was minted in generation 1 (spec §4 / the
        // silent-wrong-click guard). This mirrors refmap.test.ts's LANDMINE.
        const staleMap: RefMap = { generation: gen2, entries: map1.entries }

        // groundRef itself refuses the stale ref (the layer act relies on).
        const grounded = groundRef(staleMap, guardRef)
        expect(grounded.ok).toBe(false)
        if (!grounded.ok) expect(grounded.code).toBe('ref_stale')

        // Reset the guard flag so we can PROVE no dispatch happened.
        await page.evaluate('window.__guardClicked=false')

        const staleEnv = await act(page, cdp, 'click', guardRef, undefined, staleMap, {})
        expect(staleEnv.success).toBe(false)
        expect(staleEnv.error).toBe(ERRORS.ref_stale.message)

        // The no-misclick guarantee: the guard button's onclick never ran.
        const clicked = await page.evaluate('window.__guardClicked')
        expect(clicked).toBe(false)
      } finally {
        await cdp.detach().catch(() => {})
        await browser.close()
      }
    },
  )
})
