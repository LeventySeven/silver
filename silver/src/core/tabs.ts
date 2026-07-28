/**
 * Multi-tab registry (DECISION §3 "shared browser: each subagent gets its own
 * tab"; build order step 1). One detached browser can hold many tabs; this maps
 * durable, human-facing tab ids (`t1`, `t2`, …) + optional labels onto live
 * Playwright pages, PERSISTED across the stateless per-command CDP reconnects.
 *
 * The stable key is the CDP **targetId** (a page's browser-target id, invariant
 * across `connectOverCDP` reconnections), NOT the page's array index (which
 * shifts as tabs open/close) and NOT its URL (ambiguous). The registry sidecar
 * (`tabs.json`) records `{ id, label?, targetId }` per tab plus the active
 * target; every command resolves "the active tab" through it.
 *
 * `syncRegistry` reconciles the persisted registry against the browser's live
 * targets on each tab command: it keeps stable ids for surviving tabs, drops
 * closed ones, mints ids for pages that appeared out-of-band (the first page
 * `open` created, or a popup), and guarantees the active target is concrete.
 *
 * KEYLESS: pure CDP + filesystem. No model anywhere.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { sessionDir } from './session.js'

export type TabRecord = {
  id: string
  label?: string
  targetId: string
  /**
   * TRUE only for a tab SILVER ITSELF created (`tab new`). Absent means the tab
   * was DISCOVERED — it already existed in the browser when we looked.
   *
   * This is the whole ownership model, and it has to be recorded at creation
   * because it cannot be recovered afterwards: CDP exposes no opener, no creator,
   * and no per-tab context that distinguishes ours from the user's (all 21 of the
   * user's pages sit in one browserContextId). So the distinction is made by
   * WHICH CODE PATH RAN — `tab new` sets it, `syncRegistry`'s discovery branch
   * never does — exactly how Aside splits `openTab()` (ownership:'owned') from
   * `attachBrowserTab()`. A heuristic over URLs or timestamps would be a guess,
   * and the cost of guessing wrong is closing a human's work.
   */
  owned?: true
}
export type TabRegistry = {
  /** Next numeric suffix to mint (`t${nextId}`). Monotonic within a session. */
  nextId: number
  /** CDP targetId of the active tab (null only before any page exists). */
  activeTargetId: string | null
  tabs: TabRecord[]
  /**
   * Identity of the browser INSTANCE these targetIds belong to.
   *
   * targetIds are durable across CDP reconnects (measured: 21/21 stable over a
   * 22.7-hour disconnect) but NOT across a browser restart — the browser mints a
   * new GUID and new targetIds, so a persisted `owned` flag could otherwise land
   * on one of the user's fresh tabs. On a GUID mismatch every ownership claim in
   * this registry is void. Absent on registries written before this existed,
   * which are therefore treated as owning nothing.
   */
  browserGuid?: string
}

/**
 * The browser instance's identity, parsed from its CDP websocket endpoint
 * (`ws://host:port/devtools/browser/<guid>`). Empty string when it can't be
 * determined — which, being unequal to any recorded guid, fails closed.
 */
export function browserGuidOf(wsEndpoint: string | undefined): string {
  if (typeof wsEndpoint !== 'string') return ''
  const m = /\/devtools\/browser\/([0-9a-fA-F-]+)/.exec(wsEndpoint)
  return m?.[1] ?? ''
}

/**
 * Does this registry's recorded ownership still apply to the browser we are
 * talking to? Fails closed: no recorded guid, or a different browser, means we
 * own nothing here.
 */
export function ownershipValid(reg: TabRegistry, currentGuid: string): boolean {
  return Boolean(reg.browserGuid) && reg.browserGuid === currentGuid && currentGuid !== ''
}

/**
 * May Silver destroy this tab? True only for a tab it created, in a browser it
 * still recognises. Used to keep `tab close` off a human's tabs in an EXTERNAL
 * (`connect`ed) session, where every other tab in the window belongs to someone
 * who is still using it.
 */
export function isOwnedTab(reg: TabRegistry, rec: TabRecord, currentGuid: string): boolean {
  return rec.owned === true && ownershipValid(reg, currentGuid)
}

const TABS_SIDECAR = 'tabs.json'

function tabsPath(name: string): string {
  return path.join(sessionDir(name), TABS_SIDECAR)
}

export function emptyRegistry(): TabRegistry {
  return { nextId: 1, activeTargetId: null, tabs: [] }
}

export async function loadTabRegistry(name: string): Promise<TabRegistry | null> {
  try {
    const raw = await fs.readFile(tabsPath(name), 'utf8')
    const reg = JSON.parse(raw) as TabRegistry
    if (typeof reg.nextId === 'number' && Array.isArray(reg.tabs)) return reg
    return null
  } catch {
    return null
  }
}

export async function saveTabRegistry(name: string, reg: TabRegistry): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await fs.writeFile(tabsPath(name), JSON.stringify(reg), 'utf8')
}

/**
 * A tab label must start with a letter and contain only letters, digits, `-`,
 * `_` — AND must not look like a tab id (`t3`), which would shadow id lookup.
 */
export function isValidLabel(s: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s)) return false
  if (/^t\d+$/.test(s)) return false
  return true
}

/** Read a page's stable CDP targetId (one short-lived CDP session per call). */
export async function pageTargetId(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const info = await cdp.send('Target.getTargetInfo')
    return info.targetInfo.targetId
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** All live pages in this context paired with their targetIds (context order). */
export async function pageTargets(
  context: BrowserContext,
): Promise<Array<{ page: Page; targetId: string }>> {
  const pages = context.pages()
  return Promise.all(pages.map(async (page) => ({ page, targetId: await pageTargetId(page) })))
}

export type SyncResult = {
  reg: TabRegistry
  byId: Map<string, Page>
  live: Array<{ id: string; page: Page; targetId: string; label?: string; owned?: true }>
}

/** Drop an ownership claim we can no longer stand behind (browser instance changed). */
function stripOwnership(rec: TabRecord): TabRecord {
  if (rec.owned !== true) return rec
  const { owned: _dropped, ...rest } = rec
  return rest
}

/**
 * Reconcile `reg` against the browser's live targets. Surviving tabs keep their
 * ids/labels; closed tabs are dropped; live pages not yet tracked get fresh ids;
 * the active target is coerced to a live one. Returns the updated registry plus
 * id→page maps. Callers persist `result.reg`.
 */
export async function syncRegistry(
  context: BrowserContext,
  reg: TabRegistry,
  browserGuid?: string,
): Promise<SyncResult> {
  const targets = await pageTargets(context)
  const liveIds = new Set(targets.map((t) => t.targetId))

  // A different browser instance invalidates every recorded ownership claim:
  // targetIds do not survive a restart, so a stale `owned` could otherwise mark
  // one of the user's brand-new tabs as ours to close.
  const guid = browserGuid ?? reg.browserGuid ?? ''
  const stillOurs = ownershipValid(reg, guid)

  const kept = reg.tabs
    .filter((t) => liveIds.has(t.targetId))
    .map((t) => (stillOurs ? t : stripOwnership(t)))
  const known = new Set(kept.map((t) => t.targetId))

  let nextId = reg.nextId
  const records: TabRecord[] = [...kept]
  for (const t of targets) {
    // DISCOVERY branch — a page that already existed. Deliberately never `owned`:
    // this is the only place a tab can enter the registry without Silver having
    // created it, and conflating the two is how an agent ends up closing a human's
    // checkout page.
    if (!known.has(t.targetId)) records.push({ id: `t${nextId++}`, targetId: t.targetId })
  }

  let active = reg.activeTargetId
  if (!active || !liveIds.has(active)) active = targets[0]?.targetId ?? null

  const next: TabRegistry = {
    nextId,
    activeTargetId: active,
    tabs: records,
    ...(guid ? { browserGuid: guid } : {}),
  }

  const byTarget = new Map(targets.map((t) => [t.targetId, t.page]))
  const byId = new Map<string, Page>()
  const live: SyncResult['live'] = []
  for (const r of records) {
    const page = byTarget.get(r.targetId)
    if (page) {
      byId.set(r.id, page)
      const entry: SyncResult['live'][number] = { id: r.id, page, targetId: r.targetId }
      if (r.label !== undefined) entry.label = r.label
      if (r.owned === true) entry.owned = true
      live.push(entry)
    }
  }
  return { reg: next, byId, live }
}

/** Find a tab by exact id (`t2`) or exact label. */
export function findTab(records: TabRecord[], ref: string): TabRecord | undefined {
  return records.find((r) => r.id === ref || r.label === ref)
}

/**
 * Resolve the page every non-tab verb should operate on: the active tab.
 *
 * Fast paths avoid all CDP work in the common single-tab case (zero overhead vs.
 * the old `pages()[0]`). Only a genuinely multi-tab session pays for targetId
 * matching. Falls back to `pages()[0]` if the active target has vanished.
 */
export async function resolveActivePage(context: BrowserContext, name: string): Promise<Page> {
  const pages = context.pages()
  if (pages.length === 0) return context.newPage()
  if (pages.length === 1) return pages[0]
  const reg = await loadTabRegistry(name)
  const active = reg?.activeTargetId
  if (!active) return pages[0]
  for (const p of pages) {
    if ((await pageTargetId(p)) === active) return p
  }
  return pages[0]
}
