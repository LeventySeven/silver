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
import { loadRefMap, saveRefMap } from '../core/session.js'
import { newGeneration } from '../perception/refmap.js'

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

// ---------------------------------------------------------------------------
// R4: bump the RefMap generation on an `act` that reported page_changed:true.
//
// The residual silent-misclick window: the generation only ever bumps on
// `snapshot`, so a MUTATING act that changes the DOM leaves the still-present
// refs at the SAME generation as the map — `groundRef` accepts them, yet they
// now point at a re-rendered (physically stale) tree. Bumping the map generation
// WITHOUT re-minting entries makes every existing entry's generation
// (`entry.generation` = old) differ from `map.generation` (= new), so the NEXT
// ref hard-fails `ref_stale` instead of silently misclicking.
//
// The hub calls this AFTER `handleAct` computes `page_changed`, passing the flag
// through. Keyless: a single integer bump + sidecar write, no browser round-trip.
// ---------------------------------------------------------------------------

export type GenerationBump = {
  /** Whether the generation was actually bumped (only when pageChanged). */
  bumped: boolean
  /** The current map generation (post-bump when bumped, unchanged otherwise). */
  generation: number
}

/**
 * When `pageChanged` is true, bump the session RefMap's generation so the still-
 * present (but now physically stale) refs fail loudly on the next command. The
 * entries are intentionally kept — they simply no longer match `map.generation`,
 * which is exactly what `groundRef` uses to distinguish "fresh" from "stale".
 *
 * No-op (and reports `bumped:false`) when the page did not change or when there
 * is no RefMap yet (no snapshot taken → nothing to invalidate). Best-effort: a
 * missing/corrupt refmap yields `{bumped:false, generation:0}` rather than
 * throwing, so it can never turn a successful act into a failed command.
 */
export async function bumpGenerationOnPageChange(
  session: string,
  pageChanged: boolean,
): Promise<GenerationBump> {
  const map = await loadRefMap(session).catch(() => null)
  if (!map) return { bumped: false, generation: 0 }
  if (!pageChanged) return { bumped: false, generation: map.generation }
  const nextGen = newGeneration(map.generation)
  // Keep the entries at their OLD generation — bumping ONLY map.generation is
  // what turns them stale (entry.generation !== map.generation → ref_stale).
  await saveRefMap(session, { generation: nextGen, entries: map.entries })
  return { bumped: true, generation: nextGen }
}

// ---------------------------------------------------------------------------
// R5a: empty-page detection. After `open`/`goto`, an anti-bot blank shell, a
// 429/403 interstitial, or a JS bundle that never rendered leaves a DOM with
// (almost) no nodes. Detecting it lets the hub emit an advisory `page_empty`
// flag instead of the host acting on a page that has not actually loaded.
// ---------------------------------------------------------------------------

/**
 * Default node-count floor below which a page is considered empty. A truly blank
 * document (`<html><head></head><body></body></html>`) is ~3 elements; a bare
 * interstitial a handful more. Kept low to avoid false positives on thin-but-real
 * pages — the hub can raise it per call.
 */
export const EMPTY_PAGE_NODE_THRESHOLD = 5

type EmptyProbe = { count: number; bodyChildren: number; bodyTextLen: number }

/**
 * True when the page's DOM is (near-)empty: either fewer than `minNodes` total
 * elements, OR a `<body>` with no child elements and no non-whitespace text (a
 * shell whose content never rendered). Keyless: one in-page count, no AX walk.
 * Best-effort — an evaluate failure (page gone mid-check) reports `false` rather
 * than throwing, so detection never turns a live command into an error.
 */
export async function detectEmptyPage(
  page: Page,
  minNodes: number = EMPTY_PAGE_NODE_THRESHOLD,
): Promise<boolean> {
  const probe = (await page
    .evaluate(
      "(() => { const c = document.getElementsByTagName('*').length; const b = document.body; return { count: c, bodyChildren: b ? b.childElementCount : 0, bodyTextLen: b ? (b.innerText || b.textContent || '').trim().length : 0 }; })()",
    )
    .catch(() => null)) as EmptyProbe | null
  if (probe === null) return false
  if (probe.count < minNodes) return true
  return probe.bodyChildren === 0 && probe.bodyTextLen === 0
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
