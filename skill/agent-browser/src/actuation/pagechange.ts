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
 * network-idle race (never block longer than ~1.2s — a page that never idles
 * must not hang the command).
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

/** Upper bound on the network-idle race; a page that never idles won't hang us. */
const NETWORK_IDLE_BUDGET_MS = 1_200

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
 * Settle the page, fingerprint it, and compare to `prev`.
 *
 * @param page       the connected page
 * @param prev       the previous fingerprint (from the last snapshot/action)
 * @param generation optional session generation to echo back
 */
export async function settleAndFingerprint(
  page: Page,
  prev?: string | null,
  generation?: number,
): Promise<PageChange> {
  const fingerprint = await fingerprintAfterSettle(page)
  const changed = compareFingerprint(prev, fingerprint)
  const out: PageChange = { page_changed: changed, stale_refs: changed, fingerprint }
  if (generation !== undefined) out.generation = generation
  return out
}

async function fingerprintAfterSettle(page: Page): Promise<string> {
  // Bounded settle: DOM ready, then a short network-idle race we never exceed.
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    delay(NETWORK_IDLE_BUDGET_MS),
  ])

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
