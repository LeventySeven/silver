/**
 * Ref -> Playwright Locator resolution (plan Task 8, spec §4/§6).
 *
 * We resolve a grounded RefEntry to a live Playwright `Locator` WITHOUT
 * reimplementing any actionability — Playwright owns attached/visible/stable/
 * enabled + hit-testing once we hand it a Locator. Our only job is to bridge a
 * stable `backendNodeId` (minted at snapshot time) back to a selector Playwright
 * can drive, robustly across CDP reconnects and SPA re-renders.
 *
 * STRATEGY (attribute-stamping — spec-sanctioned; we never replace text nodes):
 *   - FAST PATH: `DOM.resolveNode({backendNodeId})` -> a RemoteObject, then
 *     `Runtime.callFunctionOn` to stamp a `data-uab-ref="<ref>"` attribute on
 *     that node, then `page.locator('[data-uab-ref="<ref>"]').first()`.
 *
 *     Caveat proven empirically: after an SPA re-render the OLD backendNodeId can
 *     still `resolveNode` to a DETACHED node — stamping it succeeds but the
 *     attribute lands on a node no longer in the document. So the fast path is
 *     only accepted when the resulting locator actually matches (`count() > 0`).
 *
 *   - SLOW PATH: re-run `snapshotNodes(page,{interactive:true})` (bounded to
 *     <=5000 nodes), recompute `nth` EXACTLY as the serializer mints it (over
 *     ref-eligible nodes, in document order, keyed by `role name`), find the node
 *     whose (role, name, nth) matches the entry, stamp ITS backendNodeId, locate.
 *
 *   - No match / no live locator -> `ResolveError` (caller maps to
 *     `element_not_found`). A handle is NEVER cached across commands.
 */
import type { Page, Locator, CDPSession } from 'playwright'
import type { RefEntry } from '../perception/refmap.js'
import { snapshotNodes } from '../perception/walk.js'

/** The attribute we stamp on a node to bridge backendNodeId -> a CSS selector. */
export const REF_ATTR = 'data-uab-ref'

/** Bounded re-match ceiling for the slow path (spec §4: <=5000 nodes). */
const REMATCH_LIMIT = 5000

/**
 * Thrown when a grounded ref cannot be bridged to a live element (stale
 * backendNodeId AND no (role,name,nth) re-match). The caller maps `.code` to a
 * `fail("element_not_found")` envelope.
 */
export class ResolveError extends Error {
  readonly code = 'element_not_found' as const
  constructor(message = 'could not resolve the ref to a live element') {
    super(message)
    this.name = 'ResolveError'
  }
}

/** `ref` is validated `e\d+` by parseRef upstream, so it is selector-safe. */
function refSelector(ref: string): string {
  return `[${REF_ATTR}="${ref}"]`
}

/**
 * Stamp `data-uab-ref="<ref>"` onto the node with the given backendNodeId.
 * Returns false if the node could not be resolved to a RemoteObject.
 */
async function stampByBackendNode(
  cdp: CDPSession,
  backendNodeId: number,
  ref: string,
): Promise<boolean> {
  const resolved = (await cdp.send('DOM.resolveNode', { backendNodeId })) as {
    object?: { objectId?: string }
  }
  const objectId = resolved.object?.objectId
  if (objectId === undefined) return false
  await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(v){ this.setAttribute(${JSON.stringify(REF_ATTR)}, v); }`,
    arguments: [{ value: ref }],
  })
  return true
}

/** Slow-path re-match: find the backendNodeId of the (role,name,nth) node. */
async function rematchByShape(page: Page, entry: RefEntry): Promise<number | null> {
  const nodes = await snapshotNodes(page, { interactive: true })
  const bounded = nodes.length > REMATCH_LIMIT ? nodes.slice(0, REMATCH_LIMIT) : nodes
  // Recompute `nth` the SAME way serialize.ts mints it: only over ref-eligible
  // nodes, in document order, keyed by `${role} ${name}`.
  const nthCounts = new Map<string, number>()
  for (const snap of bounded) {
    if (!snap.refEligible) continue
    const key = `${snap.role} ${snap.name}`
    const nth = nthCounts.get(key) ?? 0
    nthCounts.set(key, nth + 1)
    if (snap.role === entry.role && snap.name === entry.name && nth === entry.nth) {
      return snap.backendNodeId
    }
  }
  return null
}

/** Stamp a backendNodeId and return the matching locator, or null if it did not land. */
async function stampAndLocate(
  page: Page,
  cdp: CDPSession,
  backendNodeId: number,
  ref: string,
): Promise<Locator | null> {
  if (!(await stampByBackendNode(cdp, backendNodeId, ref))) return null
  const loc = page.locator(refSelector(ref)).first()
  return (await loc.count()) > 0 ? loc : null
}

/**
 * Resolve a grounded RefEntry to a live Playwright Locator.
 *
 * @param page   the connected page
 * @param cdp    a CDP session bound to `page` (caller owns its lifecycle)
 * @param entry  the grounded RefEntry (from groundRef)
 * @param ref    the bare `eN` string (used as the stamped attribute value)
 */
export async function toLocator(
  page: Page,
  cdp: CDPSession,
  entry: RefEntry,
  ref: string,
): Promise<Locator> {
  // FAST PATH: the backendNodeId is still live in the current document.
  try {
    const fast = await stampAndLocate(page, cdp, entry.backendNodeId, ref)
    if (fast) return fast
  } catch {
    // detached / stale backendNodeId — fall through to the slow path.
  }

  // SLOW PATH: re-snapshot and re-match by (role, name, nth).
  const backendNodeId = await rematchByShape(page, entry)
  if (backendNodeId === null) throw new ResolveError()
  try {
    const slow = await stampAndLocate(page, cdp, backendNodeId, ref)
    if (slow) return slow
  } catch {
    throw new ResolveError()
  }
  throw new ResolveError()
}
