/**
 * Page-change flag via a cheap post-settle fingerprint (plan Task 8, spec §6,
 * red-team S4).
 *
 * After an action, the CLI wants to tell the host "the page changed, your refs
 * may be stale" — but it must NEVER auto-embed a fresh snapshot (that is the
 * host's decision). So we compute a cheap fingerprint AFTER a bounded settle and
 * compare it to the previous one. The result is a FLAG the CLI stamps onto the
 * response; nothing more.
 *
 * Settle = `waitForLoadState('domcontentloaded')` then a SHORT bounded
 * network-idle race (default ≤400ms — a page that never idles must not hang the
 * command; `--wait networkidle` opts into a longer full wait). The read-only
 * `snapshot` verb takes the NO-SETTLE path (`fingerprintOnly`): it observes the
 * already-loaded page as-is and never races `networkidle` (engine-plan P1), so a
 * warm snapshot no longer pays the settle tax while STILL emitting the
 * page_changed/stale_refs flag from the cheap fingerprint compare.
 *
 * Fingerprint = `url + '|' + focusedBackendNodeId + '|' + domNodeCount`:
 *   - url               changes on navigation
 *   - focusedBackendNodeId  changes when focus moves (via CDP; 0 if unresolved)
 *   - domNodeCount       changes when the DOM is added to / removed from
 *
 * `compareFingerprint` is a pure function so the CLI (and tests) can compare a
 * stored previous fingerprint against a fresh one without a browser.
 */
import type { Page } from 'playwright'

export type PageChange = {
  /** Echoed session generation, when the caller supplies one. */
  generation?: number
  /** The fingerprint differs from the previous one. */
  page_changed: boolean
  /** Alias of page_changed: any change may have invalidated live refs. */
  stale_refs: boolean
  /** The freshly computed fingerprint (the CLI stores this as the next prev). */
  fingerprint: string
}

/**
 * Default upper bound on the network-idle race for MUTATING verbs. Lowered from
 * 1200→400ms (engine-plan P1b): each command is a fresh Playwright client that
 * never observed the load, so Playwright restarts its idle timer every time and
 * the old 1200ms budget was a per-action tax. A page that genuinely needs the
 * full idle wait opts in via `--wait networkidle` (→ NETWORK_IDLE_FULL_BUDGET_MS).
 */
const NETWORK_IDLE_BUDGET_MS = 400

/** Opt-in (`--wait networkidle`) full-idle budget for pages that need it. */
const NETWORK_IDLE_FULL_BUDGET_MS = 10_000

/**
 * How much to wait before fingerprinting:
 *   - 'none'    → no wait at all (read-only `snapshot`: observe the page as-is)
 *   - 'default' → domcontentloaded + a ≤400ms network-idle race (mutating verbs)
 *   - 'full'    → domcontentloaded + a ≤10s network-idle race (`--wait networkidle`)
 */
export type SettleMode = 'none' | 'default' | 'full'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Pure comparison: did the page change? A missing previous fingerprint means
 * "no basis for comparison" -> not changed (the first action can't be a change).
 */
export function compareFingerprint(prev: string | null | undefined, cur: string): boolean {
  if (prev === null || prev === undefined || prev === '') return false
  return prev !== cur
}

/**
 * Settle the page (per `mode`), fingerprint it, and compare to `prev`.
 *
 * @param page       the connected page
 * @param prev       the previous fingerprint (from the last snapshot/action)
 * @param generation optional session generation to echo back
 * @param mode       settle policy (default 'default'; mutating verbs)
 */
export async function settleAndFingerprint(
  page: Page,
  prev?: string | null,
  generation?: number,
  mode: SettleMode = 'default',
): Promise<PageChange> {
  const fingerprint = await fingerprintAfterSettle(page, mode)
  const changed = compareFingerprint(prev, fingerprint)
  const out: PageChange = { page_changed: changed, stale_refs: changed, fingerprint }
  if (generation !== undefined) out.generation = generation
  return out
}

/**
 * Fingerprint the page WITHOUT any settle race (engine-plan P1). The read-only
 * `snapshot` verb uses this: it observes the already-loaded page as-is and never
 * races `networkidle`, while STILL emitting the page_changed/stale_refs flag from
 * the cheap `url|focusedBackendId|domNodeCount` compare against `prev`.
 */
export async function fingerprintOnly(
  page: Page,
  prev?: string | null,
  generation?: number,
): Promise<PageChange> {
  return settleAndFingerprint(page, prev, generation, 'none')
}

async function fingerprintAfterSettle(page: Page, mode: SettleMode): Promise<string> {
  // Bounded settle: DOM ready, then a short network-idle race we never exceed.
  // 'none' (read-only snapshot) skips both waits — the page is observed as-is.
  if (mode !== 'none') {
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    const budget = mode === 'full' ? NETWORK_IDLE_FULL_BUDGET_MS : NETWORK_IDLE_BUDGET_MS
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      delay(budget),
    ])
  }

  const url = page.url()
  const focused = await focusedBackendId(page).catch(() => 0)
  const domNodeCount = (await page
    .evaluate("document.getElementsByTagName('*').length")
    .catch(() => 0)) as number
  return `${url}|${focused}|${domNodeCount}`
}

/** The backendNodeId of `document.activeElement`, or 0 if none/unresolved. */
async function focusedBackendId(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable').catch(() => {})
    const ev = (await cdp.send('Runtime.evaluate', {
      expression: 'document.activeElement',
    })) as { result?: { objectId?: string } }
    const objectId = ev.result?.objectId
    if (objectId === undefined) return 0
    const desc = (await cdp.send('DOM.describeNode', { objectId })) as {
      node?: { backendNodeId?: number }
    }
    return desc.node?.backendNodeId ?? 0
  } finally {
    await cdp.detach().catch(() => {})
  }
}
