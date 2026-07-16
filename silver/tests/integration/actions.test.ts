import { describe, it, expect, afterAll } from 'vitest'
import type { CDPSession } from 'playwright'
import { openSession, connect, closeSession, saveRefMap } from '../../src/core/session.js'
import { snapshotNodes } from '../../src/perception/walk.js'
import { render } from '../../src/perception/serialize.js'
import { groundRef, newGeneration, type RefMap } from '../../src/perception/refmap.js'
import { act, coordClick, coordType, coordDrag } from '../../src/actuation/actions.js'
import { settleAndFingerprint } from '../../src/actuation/pagechange.js'
import { buildSecretRegistry } from '../../src/security/secret.js'
import { ERRORS } from '../../src/core/errors.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-act-${process.pid}-${Date.now()}`

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

  it(
    'resolves a <secret> in fill on the matching domain, refuses on mismatch, never leaks (E1)',
    async () => {
      const S = `${NAME}-sec`
      await openSession(S, { headed: false })
      const { browser, page } = await connect(S)
      const cdp: CDPSession = await page.context().newCDPSession(page)
      try {
        // Serve the fixture on ANY host so page.url() carries a real domain.
        await page.route('**/*', (route) =>
          route.fulfill({ contentType: 'text/html', body: FIXTURE }),
        )
        const registry = buildSecretRegistry(['BANK_PW@bank.example=s3cr3t-value'])

        // --- matching domain: the token resolves, the SECRET reaches the DOM,
        //     but the envelope read-back is force-redacted (never leaks). ---
        await page.goto('http://bank.example/login')
        const map1 = await takeSnapshot(page, 1, null)
        const inputRef = refFor(map1, 'textbox', 'Name field')
        const okEnv = await act(page, cdp, 'fill', inputRef, '<secret>BANK_PW</secret>', map1, {
          secrets: registry,
        })
        expect(okEnv.success).toBe(true)
        expect(await page.locator('#inp').inputValue()).toBe('s3cr3t-value') // reached the page
        expect(okEnv.data?.value).toBe('[redacted]') // but masked in the envelope
        expect(JSON.stringify(okEnv)).not.toContain('s3cr3t-value')

        // --- mismatched domain: REFUSED, and the secret never reaches the DOM. ---
        await page.goto('http://evil.example/steal')
        const map2 = await takeSnapshot(page, 2, map1)
        const inputRef2 = refFor(map2, 'textbox', 'Name field')
        const refused = await act(page, cdp, 'fill', inputRef2, '<secret>BANK_PW</secret>', map2, {
          secrets: registry,
        })
        expect(refused.success).toBe(false)
        expect(JSON.stringify(refused)).not.toContain('s3cr3t-value')
        expect(await page.locator('#inp').inputValue()).not.toContain('s3cr3t-value')
      } finally {
        await cdp.detach().catch(() => {})
        await browser.close()
        await closeSession(S).catch(() => {})
      }
    },
  )

  it(
    'resolves a <totp> in fill to a 6-digit code on the matching domain (D2)',
    async () => {
      const S = `${NAME}-totp`
      await openSession(S, { headed: false })
      const { browser, page } = await connect(S)
      const cdp: CDPSession = await page.context().newCDPSession(page)
      try {
        await page.route('**/*', (route) =>
          route.fulfill({ contentType: 'text/html', body: FIXTURE }),
        )
        // A TOTP seed is just a domain-scoped secret whose value is the base32 key.
        const registry = buildSecretRegistry(['MFA@bank.example=JBSWY3DPEHPK3PXP'])

        await page.goto('http://bank.example/login')
        const map1 = await takeSnapshot(page, 1, null)
        const inputRef = refFor(map1, 'textbox', 'Name field')
        const env = await act(page, cdp, 'fill', inputRef, '<totp>MFA</totp>', map1, {
          secrets: registry,
        })
        expect(env.success).toBe(true)
        // The CURRENT 6-digit code reached the DOM (never the literal token).
        expect(await page.locator('#inp').inputValue()).toMatch(/^\d{6}$/)
        // The read-back is force-redacted (a live code is still sensitive).
        expect(env.data?.value).toBe('[redacted]')
        expect(JSON.stringify(env)).not.toContain('<totp>')

        // A mismatched domain REFUSES (the anti-exfil guarantee holds for seeds).
        await page.goto('http://evil.example/steal')
        const map2 = await takeSnapshot(page, 2, map1)
        const inputRef2 = refFor(map2, 'textbox', 'Name field')
        const refused = await act(page, cdp, 'fill', inputRef2, '<totp>MFA</totp>', map2, {
          secrets: registry,
        })
        expect(refused.success).toBe(false)
        expect(await page.locator('#inp').inputValue()).not.toMatch(/^\d{6}$/)
      } finally {
        await cdp.detach().catch(() => {})
        await browser.close()
        await closeSession(S).catch(() => {})
      }
    },
  )

  it(
    'coordinate verbs drive page.mouse/keyboard, bypassing refs (B1)',
    async () => {
      const S = `${NAME}-coord`
      await openSession(S, { headed: false })
      const { browser, page } = await connect(S)
      try {
        await page.setContent(FIXTURE, { waitUntil: 'load' })

        // coordClick at the guard button's center fires its onclick (no ref).
        await page.evaluate('window.__guardClicked=false')
        const gbox = await page.locator('#guard').boundingBox()
        if (!gbox) throw new Error('no bounding box for #guard')
        const cx = gbox.x + gbox.width / 2
        const cy = gbox.y + gbox.height / 2
        const clickEnv = await coordClick(page, cx, cy)
        expect(clickEnv.success).toBe(true)
        expect(await page.evaluate('window.__guardClicked')).toBe(true)

        // coordType focuses the input at (x,y) and types — WITHOUT echoing text.
        const ibox = await page.locator('#inp').boundingBox()
        if (!ibox) throw new Error('no bounding box for #inp')
        const typeEnv = await coordType(page, ibox.x + 5, ibox.y + 5, 'typed-here')
        expect(typeEnv.success).toBe(true)
        expect(await page.locator('#inp').inputValue()).toBe('typed-here')
        expect(JSON.stringify(typeEnv)).not.toContain('typed-here')

        // coordDrag returns a success envelope carrying the destination coords.
        const dragEnv = await coordDrag(page, cx, cy, cx + 10, cy + 10)
        expect(dragEnv.success).toBe(true)
        expect(dragEnv.data?.verb).toBe('drag')
        expect(dragEnv.data?.x2).toBe(cx + 10)
      } finally {
        await browser.close()
        await closeSession(S).catch(() => {})
      }
    },
  )

  it(
    'coordDrag interpolates the middle move so DnD-style intermediate mousemoves fire (S8)',
    async () => {
      const S = `${NAME}-drag-interp`
      await openSession(S, { headed: false })
      const { browser, page } = await connect(S)
      try {
        // A document-level mousemove counter. The OLD single-teleport code fired
        // only the two endpoint moves (which DnD libs miss); the interpolated
        // drag fires the initial move + `steps` intermediate mousemoves.
        await page.setContent(
          `<!doctype html><html><body style="margin:0">
             <div id="pad" style="width:800px;height:400px"></div>
             <script>
               window.__moves = 0;
               document.addEventListener('mousemove', function(){ window.__moves++; });
             </script>
           </body></html>`,
          { waitUntil: 'load' },
        )

        await page.evaluate('window.__moves = 0')
        // 400px horizontal drag -> steps = round(min(20,max(5,400/40))) = 10.
        const dragEnv = await coordDrag(page, 100, 100, 500, 100)
        expect(dragEnv.success).toBe(true)

        const moves = (await page.evaluate('window.__moves')) as number
        // Teleport would fire ~2 mousemoves; interpolation fires the initial move
        // plus 10 intermediate ones. Assert well above the 2-move teleport floor.
        expect(moves).toBeGreaterThan(2)
        expect(moves).toBeGreaterThanOrEqual(5)
      } finally {
        await browser.close()
        await closeSession(S).catch(() => {})
      }
    },
  )
})

describe('mapActionError classification via coord verbs (S2)', () => {
  // A mock Page whose mouse method throws a chosen engine-shaped message, so we
  // exercise mapActionError's delegation to classifyEngineError through the
  // public coord path without a real browser.
  function throwingPage(message: string): import('playwright').Page {
    const boom = (): never => {
      throw new Error(message)
    }
    return {
      url: () => 'https://example.com/',
      mouse: { click: boom, move: boom, down: boom, up: boom },
      keyboard: { type: boom },
    } as unknown as import('playwright').Page
  }

  it('maps a transport-death "Target closed" to page_crash (retryable), not element_not_found', async () => {
    const env = await coordClick(throwingPage('Target closed'), 10, 10)
    expect(env.success).toBe(false)
    expect(env.error).toBe(ERRORS.page_crash.message)
    expect(env.error).not.toBe(ERRORS.element_not_found.message)
  })

  it('maps a "Not a checkbox or radio button" throw to wrong_element_type, not element_not_found', async () => {
    const env = await coordClick(throwingPage('Not a checkbox or radio button'), 10, 10)
    expect(env.success).toBe(false)
    expect(env.error).toBe(ERRORS.wrong_element_type.message)
    expect(env.error).not.toBe(ERRORS.element_not_found.message)
  })
})
