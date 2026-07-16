/**
 * Dual-quiet page-ready detection (adopt S5).
 *
 * `waitForReady(page)` resolves when the page is BOTH DOM-quiet AND network-quiet
 * — a keyless, model-free readiness signal that is far more robust than the raw
 * `--load networkidle` on modern SPAs. `networkidle` flakes two ways: a page that
 * holds a websocket / long-poll socket open NEVER idles (so the wait always times
 * out), and a page whose DOM settles long before the network makes it wait far
 * longer than needed. Dual-quiet fixes both:
 *
 *   - DOM-quiet: an in-page MutationObserver records `window.__silverLastMutation`
 *     on every mutation (subtree/childList/attributes/characterData). We poll the
 *     age of that timestamp; the DOM is quiet once no mutation has fired for
 *     `DOM_QUIET_WINDOW_MS`.
 *   - Network-quiet: Playwright `request`/`requestfinished`/`requestfailed` events
 *     drive a live pending-request count. The network is quiet once the pending
 *     count is 0 AND has stayed silent for `NETWORK_FORGIVENESS_MS` — a short grace
 *     so a request that fires just after the count hits 0 doesn't let us declare a
 *     premature (false) quiet.
 *
 * Ladder (all advisory — this NEVER throws and NEVER hangs past the hard cap):
 *   - both quiet            -> { ready: true,  reason: 'ready' }   (happy path)
 *   - soft target reached &
 *     DOM quiet (net never
 *     idled — long-poll SPA) -> { ready: true,  reason: 'dom_quiet' }
 *   - hard cap / timeout    -> { ready: false, reason: 'timeout' } (advisory)
 *
 * The soft-target rung is what makes this usable on never-idling SPAs: once the
 * DOM has settled and we are past the soft target, we stop waiting on a network
 * that will never go quiet and report the page settled. Only a page that never
 * even reaches DOM-quiet runs all the way to the hard cap.
 *
 * KEYLESS: a fixed MutationObserver snippet (read-only — it OBSERVES, never
 * mutates) + Playwright request events. No model call anywhere.
 */
import type { Page } from 'playwright'

/** ms with no DOM mutation before the DOM counts as quiet. */
export const DOM_QUIET_WINDOW_MS = 500
/** ms the pending-request count must hold at 0 before the network counts as quiet. */
export const NETWORK_FORGIVENESS_MS = 1500
/** ms after which DOM-quiet alone (network never idled) is accepted as ready. */
export const SOFT_TARGET_MS = 6000
/** Absolute ceiling: the wait can never run longer than this (unless overridden). */
export const HARD_CAP_MS = 14000
/** Poll cadence for the quiet checks. */
const POLL_INTERVAL_MS = 100

export type ReadyResult = { ready: boolean; reason: 'ready' | 'dom_quiet' | 'timeout' }

export type ReadyOptions = {
  /** Override the hard cap (wired from `flags.timeout`). */
  timeout?: number
  domQuietMs?: number
  networkForgivenessMs?: number
  softTargetMs?: number
  hardCapMs?: number
  pollIntervalMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/**
 * Idempotent in-page snippet: install the MutationObserver once (re-arms itself
 * after a navigation wiped the previous document's context), then return the age
 * in ms of the last mutation. Written as a STRING because tsconfig `lib` has no
 * DOM types. Read-only — the observer never mutates the page.
 */
const DOM_QUIET_PROBE_JS = `(function(){
  if(!window.__silverReadyObs){
    window.__silverLastMutation=Date.now();
    try{
      var o=new MutationObserver(function(){window.__silverLastMutation=Date.now();});
      o.observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,characterData:true});
      window.__silverReadyObs=o;
    }catch(e){window.__silverLastMutation=Date.now();}
  }
  return Date.now()-(window.__silverLastMutation||Date.now());
})()`

/**
 * Resolve when the page is both DOM-quiet and network-quiet. Advisory: always
 * resolves (never throws), always within the hard cap (or `opts.timeout`).
 */
export async function waitForReady(page: Page, opts: ReadyOptions = {}): Promise<ReadyResult> {
  const domQuietMs = opts.domQuietMs ?? DOM_QUIET_WINDOW_MS
  const netForgiveMs = opts.networkForgivenessMs ?? NETWORK_FORGIVENESS_MS
  const softTargetMs = opts.softTargetMs ?? SOFT_TARGET_MS
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  // `flags.timeout` (opts.timeout) OVERRIDES the hard cap; else the hard cap.
  const deadlineMs = opts.timeout ?? opts.hardCapMs ?? HARD_CAP_MS

  // ---- network-quiet tracking (attach now, detach in finally) --------------
  let pending = 0
  let lastNetworkEventAt = Date.now()
  const onRequest = (): void => {
    pending++
    lastNetworkEventAt = Date.now()
  }
  const onSettled = (): void => {
    if (pending > 0) pending--
    lastNetworkEventAt = Date.now()
  }
  page.on('request', onRequest)
  page.on('requestfinished', onSettled)
  page.on('requestfailed', onSettled)

  const start = Date.now()
  try {
    for (;;) {
      const now = Date.now()
      const elapsed = now - start

      // DOM-quiet: age of the last mutation (in-page clock; self-consistent). A
      // destroyed execution context (mid-navigation) counts as NOT quiet this tick.
      let msSinceMutation = 0
      try {
        msSinceMutation = (await page.evaluate(DOM_QUIET_PROBE_JS)) as number
      } catch {
        msSinceMutation = 0
      }
      const domQuiet = msSinceMutation >= domQuietMs

      // Network-quiet: no in-flight requests, silent for the forgiveness window.
      const netQuiet = pending === 0 && Date.now() - lastNetworkEventAt >= netForgiveMs

      if (domQuiet && netQuiet) return { ready: true, reason: 'ready' }
      // Past the soft target with a settled DOM but a network that never idles
      // (long-poll / websocket SPA): report settled rather than burning to the cap.
      if (elapsed >= softTargetMs && domQuiet) return { ready: true, reason: 'dom_quiet' }
      if (elapsed >= deadlineMs) return { ready: false, reason: 'timeout' }

      await sleep(pollMs)
    }
  } finally {
    page.off('request', onRequest)
    page.off('requestfinished', onSettled)
    page.off('requestfailed', onSettled)
  }
}
