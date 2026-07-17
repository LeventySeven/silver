/**
 * Ranked wait taxonomy (plan Task 8, spec §6).
 *
 * `waitFor(page, spec)` maps a wait spec to the corresponding Playwright wait.
 * Playwright owns all polling/timing — we add no constants. The taxonomy, best
 * (most specific) first:
 *
 *   { selector }  wait for an element to reach a state (default: visible)
 *   { ref }       wait for a grounded ref's element (state, default: visible)
 *   { text }      wait for text to appear (getByText -> visible)
 *   { url }       wait for a navigation to a URL (glob | string)
 *   { load }      wait for a load state (load | domcontentloaded | networkidle)
 *   { fn }        wait for an in-page predicate expression to become truthy
 *   { ms }        LAST RESORT: a bare fixed delay. Prefer any of the above — a
 *                 fixed sleep is brittle (races slow pages, wastes time on fast
 *                 ones). Documented as the fallback form only.
 */
import type { Page, Locator, CDPSession } from 'playwright'
import type { RefMap } from '../perception/refmap.js'
import { groundRef } from '../perception/refmap.js'
import { waitForReady, type ReadyResult } from '../perception/pageready.js'
import { toLocator } from './resolve.js'
import { cleanupStamp } from './actions.js'

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

export type WaitSpec =
  | { ms: number }
  | { selector: string; state?: WaitState; timeout?: number }
  | { ref: string; refmap: RefMap; cdp: CDPSession; state?: WaitState; timeout?: number }
  // `state` defaults to 'visible' (wait for the text to APPEAR); item #7 threads
  // 'hidden' for `wait --text-gone` (wait for the text to DISAPPEAR).
  | { text: string; state?: WaitState; timeout?: number }
  | { url: string; timeout?: number }
  | { load: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }
  // S5: dual-quiet page-ready — resolves via waitForReady (DOM + network quiet).
  | { ready: true; timeout?: number }
  | { fn: string; timeout?: number }

/**
 * Typed wait failure for a grounding miss on a `{ ref }` wait. Timeouts are left
 * to propagate as Playwright's `TimeoutError` (the caller maps them to
 * `fail("timeout")`).
 */
export class WaitError extends Error {
  readonly code: 'ref_stale' | 'element_not_found'
  constructor(code: 'ref_stale' | 'element_not_found') {
    super(code)
    this.code = code
    this.name = 'WaitError'
  }
}

export async function waitFor(page: Page, spec: WaitSpec): Promise<void | ReadyResult> {
  if ('ready' in spec) {
    // S5: dual-quiet page-ready. Returns the {ready,reason} result (all other
    // wait forms return void). Advisory — never throws, never hangs past the cap.
    return waitForReady(page, { timeout: spec.timeout })
  }
  if ('ms' in spec) {
    // LAST RESORT — a bare fixed delay (see module doc).
    await page.waitForTimeout(spec.ms)
    return
  }
  if ('selector' in spec) {
    await page
      .locator(spec.selector)
      .first()
      .waitFor({ state: spec.state ?? 'visible', timeout: spec.timeout })
    return
  }
  if ('ref' in spec) {
    const g = groundRef(spec.refmap, spec.ref)
    if (!g.ok) throw new WaitError(g.code)
    const loc: Locator = await toLocator(page, spec.cdp, g.entry, g.ref)
    // Clean up the stamped `data-silver-ref` (fix I1): toLocator stamps here too,
    // and only act() cleaned up — a leaked stamp can mis-anchor a later locate.
    try {
      await loc.waitFor({ state: spec.state ?? 'visible', timeout: spec.timeout })
    } finally {
      await cleanupStamp(page).catch(() => {})
    }
    return
  }
  if ('text' in spec) {
    // Default 'visible' (appear); item #7 passes 'hidden' for `--text-gone`.
    await page
      .getByText(spec.text)
      .first()
      .waitFor({ state: spec.state ?? 'visible', timeout: spec.timeout })
    return
  }
  if ('url' in spec) {
    // SUBSTRING match, mirroring `expect url-matches` (handlers.ts `urlMatches`,
    // which does `url.includes(pattern)`) and the "URL to contain a string" docs.
    // A bare `waitForURL(string)` treats the string as a GLOB that must match the
    // ENTIRE url, so a plain substring like "index" or "localhost" never matched
    // and always timed out — contradicting the documented "contains" contract.
    await page.waitForURL((url) => url.href.includes(spec.url), { timeout: spec.timeout })
    return
  }
  if ('load' in spec) {
    await page.waitForLoadState(spec.load, { timeout: spec.timeout })
    return
  }
  // { fn }: a page-function expression string; Playwright evaluates it and polls.
  await page.waitForFunction(spec.fn, undefined, { timeout: spec.timeout })
}
