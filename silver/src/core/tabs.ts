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

export type TabRecord = { id: string; label?: string; targetId: string }
export type TabRegistry = {
  /** Next numeric suffix to mint (`t${nextId}`). Monotonic within a session. */
  nextId: number
  /** CDP targetId of the active tab (null only before any page exists). */
  activeTargetId: string | null
  tabs: TabRecord[]
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
  live: Array<{ id: string; page: Page; targetId: string; label?: string }>
}

/**
 * Reconcile `reg` against the browser's live targets. Surviving tabs keep their
 * ids/labels; closed tabs are dropped; live pages not yet tracked get fresh ids;
 * the active target is coerced to a live one. Returns the updated registry plus
 * id→page maps. Callers persist `result.reg`.
 */
export async function syncRegistry(context: BrowserContext, reg: TabRegistry): Promise<SyncResult> {
  const targets = await pageTargets(context)
  const liveIds = new Set(targets.map((t) => t.targetId))

  const kept = reg.tabs.filter((t) => liveIds.has(t.targetId))
  const known = new Set(kept.map((t) => t.targetId))

  let nextId = reg.nextId
  const records: TabRecord[] = [...kept]
  for (const t of targets) {
    if (!known.has(t.targetId)) records.push({ id: `t${nextId++}`, targetId: t.targetId })
  }

  let active = reg.activeTargetId
  if (!active || !liveIds.has(active)) active = targets[0]?.targetId ?? null

  const next: TabRegistry = { nextId, activeTargetId: active, tabs: records }

  const byTarget = new Map(targets.map((t) => [t.targetId, t.page]))
  const byId = new Map<string, Page>()
  const live: SyncResult['live'] = []
  for (const r of records) {
    const page = byTarget.get(r.targetId)
    if (page) {
      byId.set(r.id, page)
      const entry: SyncResult['live'][number] = { id: r.id, page, targetId: r.targetId }
      if (r.label !== undefined) entry.label = r.label
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
