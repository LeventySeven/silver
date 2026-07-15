/**
 * Per-verb command handlers (plan Task 11).
 *
 * Kept out of cli.ts so every handler is unit/integration-testable without going
 * through argv. Each handler returns an `Envelope` — it NEVER throws for an
 * expected failure (it returns `fail(code)`); an UNEXPECTED throw bubbles to the
 * cli.ts dispatcher, which maps it to a sanitized envelope (no path/secret leak).
 *
 * The browser-as-daemon model (session.ts): each handler `connect()`s over CDP,
 * does its work, then closes the CDP transport (`browser.close()` on a
 * connectOverCDP browser only drops the transport — the detached browser keeps
 * running). Cross-command state (generation, previous snapshot text, page
 * fingerprint, extract value-map) lives in a per-session `silver-state.json` sidecar
 * next to session.json / refmap.json.
 *
 * KEYLESS: no model / provider call anywhere. Every "smart" step is a keyless
 * heuristic or a bundle handed to the host.
 */
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import type { Page, Locator, CDPSession, Frame } from 'playwright'

import { ok, fail, type Envelope } from './envelope.js'
import type { ParsedFlags } from './flags.js'
import {
  openSession,
  connect,
  connectExternalSession,
  closeSession,
  saveRefMap,
  loadRefMap,
  readSidecar,
  sessionDir,
  sessionsRoot,
  isPidAlive,
  currentNamespace,
  type Connection,
  type OpenOptions,
} from './session.js'
import { withSessionLock } from './lock.js'
import {
  loadTabRegistry,
  saveTabRegistry,
  emptyRegistry,
  syncRegistry,
  findTab,
  isValidLabel,
  pageTargetId,
  resolveActivePage,
  type TabRecord,
  type TabRegistry,
} from './tabs.js'
import { groundRef, parseRef, newGeneration, type RefMap, type RefEntry } from '../perception/refmap.js'
import {
  ensureCapture,
  readCapture,
  clearCapture,
  applyRoutes,
  addRoute,
  removeRoute,
  startHar,
  stopHar,
  buildHar,
  saveActiveFrame,
  clearActiveFrame,
  resolveActiveFrame,
  findFrame,
  type RouteRule,
} from './capture.js'
import { snapshotNodes, type SnapNode } from '../perception/walk.js'
import { render } from '../perception/serialize.js'
import { observe } from '../perception/diff.js'
import { assertNavigableResolved, assertContainedPath } from '../security/egress.js'
import { neutralize, capOutput } from '../security/injection.js'
import { redactValue } from '../security/redact.js'
import { requiresConfirm, confirmGateDecision, isDestructivePaidName } from '../security/confirm.js'
import {
  act,
  find,
  locate,
  cleanupStamp,
  type ActVerb,
  type ActOptions,
  type FindKind,
} from '../actuation/actions.js'
import { toLocator } from '../actuation/resolve.js'
import { settleAndFingerprint } from '../actuation/pagechange.js'
import { waitFor, WaitError, type WaitSpec, type WaitState } from '../actuation/wait.js'
import { buildBundle, type JsonSchema } from '../extract/transform.js'
import { resolveIds } from '../extract/resolve.js'

const VERSION = '0.1.0'

/**
 * Package root, computed from THIS compiled module's location so it is correct
 * whether we run from `dist/core/handlers.js` or `src/core/handlers.ts` (both
 * are two levels below the package root). Used to locate on-disk skill docs.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Verbs whose invocation is a click/press-like ACTIVATION of a control — the
 * only ones the narrowed paid/destructive confirm gate applies to. */
const CONFIRM_GATED_VERBS: ReadonlySet<string> = new Set(['click', 'dblclick', 'press'])

// ---------------------------------------------------------------------------
// Per-session state sidecar (silver-state.json) — our cross-command scratch.
// ---------------------------------------------------------------------------

type ExtractState = {
  urlFieldPaths: string[]
  valueMap: Record<string, string>
  generation: number
}

type UabState = {
  /** The generation of the most recent snapshot (0 = none taken yet). */
  generation: number
  /** The most recent snapshot text, for diff-when-shorter observation. */
  prevTree: string | null
  /** The most recent page fingerprint, for the page_changed flag. */
  fingerprint: string | null
  /** The last extract bundle's reverse-map, keyed to its generation. */
  extract?: ExtractState
}

function statePath(name: string): string {
  return path.join(sessionDir(name), 'silver-state.json')
}

async function loadState(name: string): Promise<UabState | null> {
  try {
    const raw = await fs.readFile(statePath(name), 'utf8')
    return JSON.parse(raw) as UabState
  } catch {
    return null
  }
}

async function saveState(name: string, state: UabState): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await fs.writeFile(statePath(name), JSON.stringify(state), 'utf8')
}

async function patchState(name: string, patch: Partial<UabState>): Promise<UabState> {
  const cur: UabState = (await loadState(name)) ?? {
    generation: 0,
    prevTree: null,
    fingerprint: null,
  }
  const next: UabState = { ...cur, ...patch }
  await saveState(name, next)
  return next
}

// ---------------------------------------------------------------------------
// Connection helpers.
// ---------------------------------------------------------------------------

function openOpts(flags: ParsedFlags): OpenOptions {
  return { headed: flags.headed }
}

/** Connect to the session, auto-spawning the detached browser if none is live.
 * EXTERNAL (connect'd) sessions are never auto-respawned into an owned browser —
 * a failed connect there is surfaced, since we do not own that process. */
async function ensureConnected(name: string, opts: OpenOptions): Promise<Connection> {
  try {
    return await connect(name)
  } catch (err) {
    const info = await readSidecar(name).catch(() => null)
    if (info?.external) throw err
    await openSession(name, opts)
    return await connect(name)
  }
}

/**
 * Run `fn` with a fresh connection to the session's ACTIVE tab, holding the
 * per-session advisory lock for the whole critical section (connect → act →
 * disconnect). The lock serializes commands against ONE session so they stop
 * racing `pages()[0]` and the sidecars; different sessions never block. The CDP
 * transport is always dropped after.
 */
async function withConnection<T>(
  flags: ParsedFlags,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  return withSessionLock(flags.session, async () => {
    const conn = await ensureConnected(flags.session, openOpts(flags))
    // Every verb operates on the ACTIVE tab, not blindly on pages()[0].
    const page = await resolveActivePage(conn.context, flags.session)
    // Register the dialog handler on the active page (fix P0-7): with no
    // listener, Playwright silently CANCELS every alert/confirm/prompt, so a
    // `confirm("delete?")` guard is auto-dismissed while the host still gets ok().
    attachDialogHandler(page, flags.session)
    // Re-materialize any persisted `network route` rules on this connection.
    // `page.route` handlers are client-side and vanish on our per-command CDP
    // reconnect, so routing is kept "on by default" by re-applying it here. A
    // single cheap sidecar read + early return when no rules exist — zero effect
    // on the common (no-route) path. Never throws.
    await applyRoutes(page, flags.session).catch(() => {})
    try {
      return await fn({ ...conn, page })
    } finally {
      await conn.browser.close().catch(() => {})
    }
  })
}

// ---------------------------------------------------------------------------
// Dialogs (fix P0-7): AUTO-ACCEPT alert/confirm/prompt with sane defaults and
// stamp the last one into a dedicated session sidecar so `dialog status` can
// surface it. A dedicated file (never silver-state.json) keeps the async,
// best-effort dialog write from racing a command's own state save.
// ---------------------------------------------------------------------------

type LastDialog = { type: string; message: string; defaultValue?: string; at: string }

function dialogPath(name: string): string {
  return path.join(sessionDir(name), 'dialog.json')
}

async function writeDialogSidecar(name: string, d: LastDialog): Promise<void> {
  try {
    await fs.mkdir(sessionDir(name), { recursive: true })
    await fs.writeFile(dialogPath(name), JSON.stringify(d), 'utf8')
  } catch {
    /* best-effort — the dialog handler must never throw into Playwright */
  }
}

async function loadDialogSidecar(name: string): Promise<LastDialog | null> {
  try {
    return JSON.parse(await fs.readFile(dialogPath(name), 'utf8')) as LastDialog
  } catch {
    return null
  }
}

function attachDialogHandler(page: Page, session: string): void {
  page.on('dialog', (dialog) => {
    const type = dialog.type()
    const message = dialog.message()
    const defaultValue = dialog.defaultValue()
    const rec: LastDialog = { type, message, at: new Date().toISOString() }
    if (defaultValue) rec.defaultValue = defaultValue
    void writeDialogSidecar(session, rec)
    // Sane defaults: prompt -> its default text; alert/confirm/beforeunload -> OK.
    const done = type === 'prompt' ? dialog.accept(defaultValue) : dialog.accept()
    void done.catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// Output presentation: cap the untrusted content FIRST, then wrap in the
// boundary markers so the markers themselves are never sliced off (spec §7).
// ---------------------------------------------------------------------------

function presentPageText(text: string, flags: ParsedFlags): string {
  const capped = capOutput(text, flags.maxOutput)
  return flags.contentBoundaries ? neutralize(capped) : capped
}

// ---------------------------------------------------------------------------
// The dispatch entry the CLI calls.
// ---------------------------------------------------------------------------

export async function handle(flags: ParsedFlags): Promise<Envelope<unknown>> {
  switch (flags.verb) {
    // lifecycle
    case 'open':
    case 'goto':
    case 'navigate':
      return handleOpen(flags)
    case 'close':
      return handleClose(flags)
    case 'back':
    case 'forward':
    case 'reload':
      return handleHistory(flags)
    // perception
    case 'snapshot':
      return handleSnapshot(flags)
    case 'read':
      return handleRead(flags)
    case 'screenshot':
      return handleScreenshot(flags)
    // interaction (registry-gated upstream)
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'fill':
    case 'type':
    case 'press':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'scroll':
    case 'upload':
    case 'drag':
      return handleAct(flags)
    case 'find':
      return handleFind(flags)
    // query
    case 'get':
      return handleGet(flags)
    case 'is':
      return handleIs(flags)
    case 'wait':
      return handleWait(flags)
    // extract
    case 'extract':
      return handleExtract(flags)
    // tabs (multi-tab: enables shared-browser parallel — each subagent a tab)
    case 'tab':
      return handleTab(flags)
    // connect an already-running CDP browser to this session (share-one-browser)
    case 'connect':
      return handleConnect(flags)
    // auth / session
    case 'state':
      return handleStateVerb(flags)
    case 'cookies':
      return handleCookies(flags)
    case 'session':
      return handleSession(flags)
    // meta
    case 'version':
      return ok({ name: 'silver', version: VERSION })
    case 'doctor':
      return handleDoctor()
    case 'skill':
      return handleSkill(flags)
    case 'dialog':
      return handleDialog(flags)
    // Vercel-parity verbs (real Playwright — no stubs).
    case 'network':
      return handleNetwork(flags)
    case 'pdf':
      return handlePdf(flags)
    case 'frame':
      return handleFrame(flags)
    case 'storage':
      return handleStorage(flags)
    case 'console':
      return handleConsole(flags)
    case 'errors':
      return handleErrors(flags)
    case 'clipboard':
      return handleClipboard(flags)
    case 'mouse':
      return handleMouse(flags)
    case 'keyboard':
      return handleKeyboard(flags)
    case 'scrollintoview':
    case 'scrollinto':
      return handleScrollIntoView(flags)
    case 'eval':
      return handleEval(flags)
    case 'batch':
      return handleBatch(flags)
    default:
      return notImplemented()
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function handleOpen(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[0]
  if (!url) return badRequest('a URL is required (usage: silver open <url>)')

  // Egress guard at the FIRST layer — before any browser is spawned/navigated.
  // The RESOLVED guard (lexical + DNS) closes the rebinding SSRF hole (C1): a
  // public hostname resolving to loopback/metadata/private is denied here, before
  // `page.goto`. `localhost` is exempt by name (see egress.ts).
  const nav = await assertNavigableResolved(url, {
    allowFile: flags.allowFileAccess,
    allowedDomains: flags.allowedDomains,
  })
  if (!nav.ok) return fail('navigation_blocked')

  return withConnection(flags, async ({ page }) => {
    // Install the capture instrumentation BEFORE navigating so console/network
    // that fires during page load is hooked from document-start (see capture.ts).
    await ensureCapture(page, flags.session).catch(() => {})
    await page.goto(url, gotoOpts(flags))
    // Re-install on the freshly-loaded document so the page-side wrappers persist
    // into later commands (they live in the doc's JS, surviving our disconnect).
    await ensureCapture(page, flags.session).catch(() => {})
    const prev = await loadState(flags.session)
    // Navigation invalidates prior refs: bump the generation, write an EMPTY
    // refmap at that generation (so a stale `eN` fails element_not_found), reset
    // the diff baseline, and drop any extract bundle.
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: null,
      fingerprint: fp.fingerprint,
    })
    return ok({
      url: page.url(),
      title: await page.title().catch(() => ''),
      page_changed: fp.page_changed,
    })
  })
}

async function handleClose(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.all) {
    const names = await listSessionNames()
    for (const name of names) {
      // Serialize each teardown behind its own session lock so a close never
      // races an in-flight command on that session.
      await withSessionLock(name, () => closeSession(name)).catch(() => {})
    }
    return ok({ closed: names.length })
  }
  // Hold the session lock across teardown so a concurrent command on this
  // session finishes first (and vice-versa). closeSession removes the dir
  // (incl. the .lock); release then no-ops on the already-gone file.
  await withSessionLock(flags.session, () => closeSession(flags.session))
  return ok({ closed: 1, session: flags.session })
}

async function handleHistory(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    if (flags.verb === 'back') await page.goBack(gotoOpts(flags))
    else if (flags.verb === 'forward') await page.goForward(gotoOpts(flags))
    else await page.reload(gotoOpts(flags))

    // Re-hook capture on the new document after a history navigation / reload.
    await ensureCapture(page, flags.session).catch(() => {})
    const prev = await loadState(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: null,
      fingerprint: fp.fingerprint,
    })
    return ok({ url: page.url(), page_changed: fp.page_changed })
  })
}

function gotoOpts(flags: ParsedFlags): { waitUntil: 'domcontentloaded'; timeout?: number } {
  const o: { waitUntil: 'domcontentloaded'; timeout?: number } = { waitUntil: 'domcontentloaded' }
  if (flags.timeout !== undefined) o.timeout = flags.timeout
  return o
}

/**
 * A new tab / a tab switch lands on a DIFFERENT DOM than the last snapshot's, so
 * prior `@eN` refs no longer ground. Bump the generation, write an EMPTY refmap
 * at it (a stale ref → element_not_found), reset the diff baseline, and
 * re-fingerprint — mirroring handleOpen/handleHistory. Keeps grounding loud.
 */
async function invalidateRefs(session: string, page: Page): Promise<void> {
  const prev = await loadState(session)
  const gen = newGeneration(prev?.generation ?? 0)
  await saveRefMap(session, { generation: gen, entries: {} })
  const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
  await saveState(session, { generation: gen, prevTree: null, fingerprint: fp.fingerprint })
}

// ---------------------------------------------------------------------------
// tabs — multi-tab on real Playwright pages (build order step 1). Ids `t1,t2,…`
// are stable across the stateless per-command reconnects (keyed by CDP
// targetId, persisted in the tabs.json sidecar). Every OTHER verb operates on
// the active tab (resolveActivePage in withConnection). Subcommands:
//   tab | tab list          -> ids + labels + urls + titles (+ which is active)
//   tab new [url] [--label L]-> open a page, make it active, return its id
//   tab <tN|label>          -> switch the active tab
//   tab close [tN|label]    -> close a tab (default: the active one)
// ---------------------------------------------------------------------------

async function handleTab(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  if (sub === undefined || sub === 'list') return handleTabList(flags)
  if (sub === 'new') return handleTabNew(flags)
  if (sub === 'close') return handleTabClose(flags)
  // Anything else is a switch target: `tab t2` / `tab <label>`.
  return handleTabSwitch(flags, sub)
}

async function handleTabList(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ context }) => {
    const reg = (await loadTabRegistry(flags.session)) ?? emptyRegistry()
    const synced = await syncRegistry(context, reg)
    await saveTabRegistry(flags.session, synced.reg)
    const tabs = await Promise.all(
      synced.live.map(async (t) => ({
        tabId: t.id,
        label: t.label ?? null,
        url: t.page.url(),
        title: await t.page.title().catch(() => ''),
        active: t.targetId === synced.reg.activeTargetId,
      })),
    )
    const active = synced.live.find((t) => t.targetId === synced.reg.activeTargetId)?.id ?? null
    return ok({ tabs, active })
  })
}

async function handleTabNew(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[1]
  const label = flags.label
  if (label !== undefined && !isValidLabel(label)) {
    return badRequest(
      'invalid tab label; labels must start with a letter and use only letters, digits, - and _ (and not look like t<N>)',
    )
  }
  // Egress guard BEFORE opening/navigating (same first-layer check as `open`).
  if (url !== undefined) {
    const nav = await assertNavigableResolved(url, {
      allowFile: flags.allowFileAccess,
      allowedDomains: flags.allowedDomains,
    })
    if (!nav.ok) return fail('navigation_blocked')
  }

  return withConnection(flags, async ({ context }) => {
    const reg = (await loadTabRegistry(flags.session)) ?? emptyRegistry()
    const synced = await syncRegistry(context, reg)
    if (label !== undefined && synced.reg.tabs.some((t) => t.label === label)) {
      return badRequest('that tab label is already used in this session; labels must be unique')
    }

    const page = await context.newPage()
    // Deterministic viewport (P0-8) for the new tab too.
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
    await ensureCapture(page, flags.session).catch(() => {})
    if (url !== undefined) await page.goto(url, gotoOpts(flags))
    await ensureCapture(page, flags.session).catch(() => {})

    const targetId = await pageTargetId(page)
    const id = `t${synced.reg.nextId}`
    const record: TabRecord = label !== undefined ? { id, label, targetId } : { id, targetId }
    const nextReg: TabRegistry = {
      nextId: synced.reg.nextId + 1,
      activeTargetId: targetId, // the new tab becomes active
      tabs: [...synced.reg.tabs, record],
    }
    await saveTabRegistry(flags.session, nextReg)
    await invalidateRefs(flags.session, page)

    return ok({
      tabId: id,
      label: label ?? null,
      url: page.url(),
      title: await page.title().catch(() => ''),
      total: nextReg.tabs.length,
    })
  })
}

async function handleTabSwitch(flags: ParsedFlags, ref: string): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ context }) => {
    const reg = (await loadTabRegistry(flags.session)) ?? emptyRegistry()
    const synced = await syncRegistry(context, reg)
    const rec = findTab(synced.reg.tabs, ref)
    const page = rec ? synced.byId.get(rec.id) : undefined
    if (!rec || !page) return badRequest('no such tab; run `tab list` to see open tabs')

    await page.bringToFront().catch(() => {})
    await saveTabRegistry(flags.session, { ...synced.reg, activeTargetId: rec.targetId })
    await invalidateRefs(flags.session, page)

    return ok({
      tabId: rec.id,
      label: rec.label ?? null,
      url: page.url(),
      title: await page.title().catch(() => ''),
    })
  })
}

async function handleTabClose(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const ref = flags.args[1] // optional; default = the active tab
  return withConnection(flags, async ({ context }) => {
    const reg = (await loadTabRegistry(flags.session)) ?? emptyRegistry()
    const synced = await syncRegistry(context, reg)
    if (synced.live.length <= 1) {
      return badRequest('cannot close the last tab; use `close` to end the session')
    }

    const target =
      ref !== undefined
        ? findTab(synced.reg.tabs, ref)
        : synced.reg.tabs.find((t) => t.targetId === synced.reg.activeTargetId)
    const page = target ? synced.byId.get(target.id) : undefined
    if (!target || !page) return badRequest('no such tab; run `tab list` to see open tabs')

    const wasActive = target.targetId === synced.reg.activeTargetId
    await page.close().catch(() => {})

    const remaining = synced.reg.tabs.filter((t) => t.targetId !== target.targetId)
    let active = synced.reg.activeTargetId
    if (wasActive) active = remaining[remaining.length - 1]?.targetId ?? null
    await saveTabRegistry(flags.session, { nextId: synced.reg.nextId, activeTargetId: active, tabs: remaining })

    // Closing the active tab promotes a new active tab with a different DOM.
    if (wasActive && active) {
      const newRec = remaining.find((t) => t.targetId === active)
      const newPage = newRec ? synced.byId.get(newRec.id) : undefined
      if (newPage) await invalidateRefs(flags.session, newPage)
    }

    const activeId = remaining.find((t) => t.targetId === active)?.id ?? null
    return ok({ closed: target.id, active: activeId, total: remaining.length })
  })
}

// ---------------------------------------------------------------------------
// connect — attach this --session to an ALREADY-RUNNING CDP browser someone
// else launched (the "share one browser" branch). Each agent then makes its own
// tab. Accepts ws://…, http://127.0.0.1:PORT, or a bare port.
// ---------------------------------------------------------------------------

async function handleConnect(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const endpoint = flags.args[0]
  if (!endpoint) {
    return badRequest('usage: silver connect <ws-url | http://127.0.0.1:PORT | port>')
  }
  return withSessionLock(flags.session, async () => {
    // Free a prior OWNED browser on this session name so we don't orphan it.
    const prior = await readSidecar(flags.session).catch(() => null)
    if (prior && !prior.external) await closeSession(flags.session).catch(() => {})

    let info
    try {
      info = await connectExternalSession(flags.session, endpoint)
    } catch {
      // Generic, no-leak: endpoint unreachable or not a CDP endpoint.
      return badRequest(
        'could not attach to that CDP endpoint; is a browser running there with --remote-debugging-port?',
      )
    }

    // Reset grounding state + seed the tab registry from the attached browser.
    await saveRefMap(flags.session, { generation: 1, entries: {} })
    await saveState(flags.session, { generation: 1, prevTree: null, fingerprint: null })
    const conn = await connect(flags.session)
    try {
      const synced = await syncRegistry(conn.context, emptyRegistry())
      await saveTabRegistry(flags.session, synced.reg)
      return ok({
        connected: true,
        session: flags.session,
        external: true,
        tabs: synced.live.length,
        ...(info.port ? { port: info.port } : {}),
      })
    } finally {
      await conn.browser.close().catch(() => {})
    }
  })
}

// ---------------------------------------------------------------------------
// perception
// ---------------------------------------------------------------------------

async function handleSnapshot(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    const prev = await loadState(flags.session)
    const prevRefmap = await loadRefMap(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)

    const snapOpts: Parameters<typeof snapshotNodes>[1] = { interactive: flags.interactive }
    if (flags.depth !== undefined) snapOpts.maxDepth = flags.depth
    if (flags.selector !== undefined) snapOpts.selectorScope = flags.selector
    const nodes = await snapshotNodes(page, snapOpts)

    const { text, refmap } = render(
      nodes,
      { generation: gen, entries: {} },
      {
        generation: gen,
        title: await page.title().catch(() => ''),
        url: page.url(),
        compact: flags.compact,
        filtered: flags.interactive,
        prevRefmap,
        ...(flags.maxOutput !== undefined ? { maxChars: flags.maxOutput } : {}),
      },
    )
    await saveRefMap(flags.session, refmap)

    const obsv = observe(prev?.prevTree ?? null, text)
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: text,
      fingerprint: fp.fingerprint,
      ...(prev?.extract ? { extract: prev.extract } : {}),
    })

    return ok(presentPageText(obsv.output, flags), warnIf(fp.page_changed))
  })
}

function warnIf(pageChanged: boolean): string | undefined {
  return pageChanged ? 'the page changed during this command; refs may be stale' : undefined
}

async function handleRead(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[0]
  if (url) {
    const fetched = await fetchGuarded(url, flags)
    if (!fetched.ok) return fail(fetched.code)
    if (!fetched.res.ok) return fail('page_crash')
    const html = await fetched.res.text()
    return ok(presentPageText(htmlToText(html), flags))
  }
  return withConnection(flags, async ({ page }) => {
    const text = (await page.evaluate(
      "document.body ? document.body.innerText : ''",
    )) as string
    return ok(presentPageText(text ?? '', flags))
  })
}

/**
 * Fetch `url`, re-running the egress guard on EVERY hop (fix P1-SEC5 / SSRF).
 *
 * A one-shot `assertNavigable` before a redirect-following fetch is bypassable:
 * a benign initial URL can 3xx-redirect to `http://169.254.169.254/…`, `file:`,
 * or a raw-IP host. We follow redirects MANUALLY and re-assert navigability on
 * each Location before requesting it, blocking the moment a hop is disallowed.
 */
async function fetchGuarded(
  url: string,
  flags: ParsedFlags,
): Promise<{ ok: true; res: Response } | { ok: false; code: 'navigation_blocked' }> {
  const MAX_HOPS = 10
  const opts = { allowFile: flags.allowFileAccess, allowedDomains: flags.allowedDomains }
  const signal = flags.timeout ? AbortSignal.timeout(flags.timeout) : undefined
  let current = url
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // Resolved guard per hop (C1 + P1-SEC5): a redirect Location that lexically
    // looks benign but RESOLVES to a private/metadata address is denied here.
    if (!(await assertNavigableResolved(current, opts)).ok) {
      return { ok: false, code: 'navigation_blocked' }
    }
    const res = await fetch(current, {
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return { ok: true, res } // 3xx with no target — treat as final.
      try {
        current = new URL(location, current).toString()
      } catch {
        return { ok: false, code: 'navigation_blocked' }
      }
      continue
    }
    return { ok: true, res }
  }
  // Too many redirects — fail closed rather than loop.
  return { ok: false, code: 'navigation_blocked' }
}

async function handleScreenshot(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const outPath = flags.args[0]
  // Path containment (fix P1-SEC4): only write inside the working directory.
  let resolvedOut: string | undefined
  if (outPath) {
    const c = assertContainedPath(outPath)
    if (!c.ok) return fail('path_denied')
    resolvedOut = c.resolved
  }
  return withConnection(flags, async ({ page }) => {
    const shotOpts: { fullPage: boolean; path?: string } = { fullPage: flags.full }
    if (resolvedOut) shotOpts.path = resolvedOut
    const buf = await page.screenshot(shotOpts)
    if (resolvedOut) return ok({ saved: true })
    return ok({ encoding: 'base64', image: buf.toString('base64') })
  })
}

// ---------------------------------------------------------------------------
// interaction (behind --enable-actions via the registry)
// ---------------------------------------------------------------------------

async function handleAct(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const verb = flags.verb as ActVerb
  const ref = flags.args[0]
  if (!ref) return badRequest('a ref is required (usage: silver <verb> @eN [value])')

  // Confirm gate: engaged only when the operator supplies --confirm-actions
  // (an explicit allowlist of auto-approved mutating verbs). Without it,
  // --enable-actions alone permits actor verbs so the primary non-TTY
  // agent-driving path (and the eval harness) is not bricked. See report.
  if (flags.confirmActionsProvided && requiresConfirm(verb)) {
    const decision = confirmGateDecision({
      verb,
      isTTY: Boolean(process.stdout.isTTY),
      confirmActions: flags.confirmActions,
    })
    if (!decision.allow) return fail('not_permitted')
  }

  const refmap = await loadRefMap(flags.session)
  if (!refmap) return fail('element_not_found')

  // Narrowed paid/destructive confirm gate (fix P0-4). Runs AFTER grounding, so
  // a hallucinated @e999 still fails the grounding gate FIRST (trifecta test 2b).
  // Only click/press-like activations of a control whose accessible name looks
  // paid/destructive (Buy/Pay/Delete/…) are gated, and only on a NON-TTY session
  // that did not pre-approve the verb via --confirm-actions. Plain clicks/fills
  // on non-matching names stay ungated (the smoke evals' buttons are unaffected).
  if (CONFIRM_GATED_VERBS.has(verb)) {
    const g = groundRef(refmap, ref)
    if (!g.ok) return fail(g.code)
    if (
      isDestructivePaidName(g.entry.name) &&
      !process.stdout.isTTY &&
      !flags.confirmActions.includes(verb)
    ) {
      return fail('confirm_required')
    }
  }

  // Value: positional arg, or stdin for large/unsafe payloads.
  let value = flags.args[1]
  if (flags.stdin) value = await readStdin()

  // Path containment for `upload` (fix P1-SEC4): every file must resolve inside
  // the working directory, or the whole action is refused before we touch the page.
  let uploadFiles: string[] | undefined
  if (verb === 'upload') {
    uploadFiles = []
    for (const fp of flags.args.slice(1)) {
      const c = assertContainedPath(fp)
      if (!c.ok) return fail('path_denied')
      uploadFiles.push(c.resolved)
    }
  }

  return withConnection(flags, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    try {
      const opts: ActOptions = {}
      if (flags.force) opts.force = true
      if (flags.timeout !== undefined) opts.timeout = flags.timeout
      if (verb === 'select') opts.selectValues = flags.args.slice(1)
      if (verb === 'upload') opts.files = uploadFiles ?? []
      if (verb === 'drag') opts.targetRef = flags.args[1]

      const env = await act(page, cdp, verb, ref, value, refmap, opts)

      // Stamp the page-change contract onto every action response (spec §6).
      const prev = await loadState(flags.session)
      const fp = await settleAndFingerprint(page, prev?.fingerprint, refmap.generation)
      await patchState(flags.session, { fingerprint: fp.fingerprint })

      if (!env.success) return env
      return ok({
        ...env.data,
        page_changed: fp.page_changed,
        stale_refs: fp.stale_refs,
        generation: refmap.generation,
      })
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
}

async function handleFind(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0] as FindKind
  const val = flags.args[1]
  if (!kind || !val) return badRequest('usage: silver find <kind> <value> [action] [text]')
  const subaction = flags.args[2] as Exclude<ActVerb, 'drag'> | undefined
  const subValue = flags.args[3]

  return withConnection(flags, async ({ page }) => {
    const opts: Parameters<typeof find>[4] = {}
    if (subValue !== undefined) opts.value = subValue
    if (flags.name !== undefined) opts.name = flags.name
    if (flags.index !== undefined) opts.index = flags.index

    // Narrowed paid/destructive confirm gate (fix P0-4 parity with handleAct):
    // `find <kind> <value> click` can DISPATCH a click/press activation, so it
    // MUST run the SAME gate a direct `click @eN` runs — otherwise
    // `find text "Buy now" click` bypasses the gate that `click @eN` enforces.
    // Applies only to click/press-like subactions, only on a NON-TTY session,
    // and only when the verb was not pre-approved via `--confirm-actions`.
    if (
      subaction !== undefined &&
      CONFIRM_GATED_VERBS.has(subaction) &&
      !process.stdout.isTTY &&
      !flags.confirmActions.includes(subaction)
    ) {
      // (a) the semantic target strings the caller supplied (kind value + --name).
      let paid =
        isDestructivePaidName(val) ||
        (flags.name !== undefined && isDestructivePaidName(flags.name))
      // (b) the located element's accessible name (best-effort textContent).
      if (!paid) {
        try {
          const loc = locate(page, kind, val, opts)
          if ((await loc.count().catch(() => 0)) > 0) {
            const name = (await loc.textContent({ timeout: flags.timeout }).catch(() => '')) ?? ''
            paid = isDestructivePaidName(name)
          }
        } catch {
          /* locate failure → find() below returns element_not_found cleanly */
        }
      }
      if (paid) return fail('confirm_required')
    }

    const res = (await find(page, kind, val, subaction, opts)) as Envelope<FindResultShape>
    // Neutralize/cap any returned page text through the SAME choke point as
    // `get text` (fix I4): FindResult.text is raw page textContent otherwise.
    if (res.success && res.data && typeof res.data.text === 'string') {
      return ok({ ...res.data, text: presentPageText(res.data.text, flags) })
    }
    return res as Envelope<unknown>
  })
}

/** Shape of the `find` envelope's data (mirrors actions.ts FindResult). */
type FindResultShape = {
  kind: string
  val: string
  matched: number
  text?: string
  verb?: string
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

async function handleGet(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0]
  const rest = flags.args.slice(1)
  return withConnection(flags, async ({ page }) => {
    switch (kind) {
      case 'title':
        return ok({ title: await page.title() })
      case 'url':
        return ok({ url: page.url() })
      case 'count': {
        const target = rest[0]
        if (!target) return badRequest('usage: silver get count <selector>')
        // Scope selector counting to the active frame (set via `frame <sel>`),
        // defaulting to the main frame when none is active.
        const frame = await resolveActiveFrame(page, flags.session)
        const n = await frame.locator(target).count()
        return ok({ count: n })
      }
      case 'text': {
        const ref = rest[0]
        if (!ref) {
          const text = (await page.evaluate(
            "document.body ? document.body.innerText : ''",
          )) as string
          return ok(presentPageText(text ?? '', flags))
        }
        return withLocator(page, flags.session, ref, async (loc) => {
          const t = (await loc.textContent()) ?? ''
          return ok(presentPageText(t, flags))
        })
      }
      case 'value': {
        const ref = rest[0]
        if (!ref) return badRequest('usage: silver get value @eN')
        // Route through the SAME redaction + neutralize choke point as get-text
        // (fix P0-1): a raw inputValue() would leak a password and bypass the
        // injection scrub. isPassword is read from the live DOM `type`; role/name
        // come from the grounded ref (RefEntry) for the redactValue hint check.
        return withLocator(page, flags.session, ref, async (loc, entry) => {
          const raw = await loc.inputValue()
          const type = ((await loc.getAttribute('type')) ?? '').toLowerCase()
          const isPassword = type === 'password'
          const redacted = redactValue(entry.role, entry.name, raw, isPassword)
          return ok({ value: presentPageText(redacted, flags) })
        })
      }
      case 'attr': {
        const ref = rest[0]
        const attrName = rest[1]
        if (!ref || !attrName) return badRequest('usage: silver get attr @eN <attribute>')
        // Redact THEN neutralize + cap (fix P0-1 + I3): `get attr @<pw> value`
        // would otherwise leak a raw `hunter2`. isPassword is read from the live
        // DOM `type`; role/name come from the grounded ref. redactValue also
        // catches card-shaped values regardless of the attribute name.
        return withLocator(page, flags.session, ref, async (loc, entry) => {
          const raw = (await loc.getAttribute(attrName)) ?? ''
          const type = ((await loc.getAttribute('type')) ?? '').toLowerCase()
          const isPassword = type === 'password'
          const redacted = redactValue(entry.role, entry.name, raw, isPassword)
          return ok({ attribute: attrName, value: presentPageText(redacted, flags) })
        })
      }
      default:
        return badRequest('usage: silver get text|value|attr|title|url|count [ref]')
    }
  })
}

async function handleIs(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0]
  const ref = flags.args[1]
  if (!kind || !ref) return badRequest('usage: silver is visible|enabled|checked @eN')
  return withConnection(flags, async ({ page }) =>
    withLocator(page, flags.session, ref, async (loc) => {
      switch (kind) {
        case 'visible':
          return ok({ visible: await loc.isVisible() })
        case 'enabled':
          return ok({ enabled: await loc.isEnabled() })
        case 'checked':
          return ok({ checked: await loc.isChecked() })
        default:
          return badRequest('usage: silver is visible|enabled|checked @eN')
      }
    }),
  )
}

/** Ground + resolve a ref to a Locator, then run `fn` with the Locator AND the
 * grounded RefEntry (for role/name-aware redaction); returns fail(code) on a
 * grounding miss (a ResolveError throw bubbles to the dispatcher). */
async function withLocator(
  page: Page,
  session: string,
  ref: string,
  fn: (loc: Locator, entry: RefEntry) => Promise<Envelope<unknown>>,
): Promise<Envelope<unknown>> {
  const refmap = await loadRefMap(session)
  if (!refmap) return fail('element_not_found')
  const g = groundRef(refmap, ref)
  if (!g.ok) return fail(g.code)
  const cdp: CDPSession = await page.context().newCDPSession(page)
  try {
    const loc = await toLocator(page, cdp, g.entry, g.ref)
    return await fn(loc, g.entry)
  } finally {
    // Clean up the stamped `data-silver-ref` (fix I1): get/is/attr paths stamp via
    // toLocator but, unlike act(), never cleaned up — leaving stale stamps that
    // could let a later `.first()` pick the wrong element (breaks R4 no-misclick).
    await cleanupStamp(page).catch(() => {})
    await cdp.detach().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

async function handleWait(flags: ParsedFlags): Promise<Envelope<unknown>> {
  // `wait --fn <expr>` executes the expression IN PAGE CONTEXT via
  // page.waitForFunction — arbitrary in-page JS with side effects (cookie
  // exfil, DOM mutation), NOT a sandboxed predicate and NOT egress-guarded.
  // `wait` is a read-only verb, so gate --fn behind --enable-actions here (fix
  // P0-3); every other wait form (ref/selector/text/url/load/ms) stays read-only.
  if (flags.fn !== undefined && !flags.enableActions) return fail('not_permitted')
  return withConnection(flags, async ({ page }) => {
    const cdp: CDPSession = await page.context().newCDPSession(page)
    try {
      const spec = await buildWaitSpec(flags, page, cdp)
      if ('error' in spec) return spec.error
      await waitFor(page, spec.spec)
      return ok({ waited: true })
    } catch (err) {
      if (err instanceof WaitError) return fail(err.code)
      if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout')
      throw err
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
}

async function buildWaitSpec(
  flags: ParsedFlags,
  page: Page,
  cdp: CDPSession,
): Promise<{ spec: WaitSpec } | { error: Envelope<unknown> }> {
  const timeout = flags.timeout
  if (flags.text !== undefined) return { spec: { text: flags.text, timeout } }
  if (flags.url !== undefined) return { spec: { url: flags.url, timeout } }
  if (flags.fn !== undefined) return { spec: { fn: flags.fn, timeout } }
  if (flags.load !== undefined) {
    const load = flags.load as 'load' | 'domcontentloaded' | 'networkidle'
    return { spec: { load, timeout } }
  }
  const arg = flags.args[0]
  if (!arg) return { error: badRequest('usage: silver wait <ref|ms|selector|--text|--url|--load|--fn>') }
  if (/^\d+$/.test(arg)) return { spec: { ms: Number(arg) } }
  // A ref → grounded wait; anything else is treated as a CSS selector.
  if (/^(@|ref=)?e\d+$/.test(arg)) {
    const refmap = await loadRefMap(flags.session)
    if (!refmap) return { error: fail('element_not_found') }
    const state: WaitState = 'visible'
    return { spec: { ref: arg, refmap, cdp, state, timeout } }
  }
  void page
  return { spec: { selector: arg, timeout } }
}

// ---------------------------------------------------------------------------
// extract (keyless, ID-grounded)
// ---------------------------------------------------------------------------

async function handleExtract(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.args[0] === 'resolve') return handleExtractResolve(flags)

  const schema = parseSchemaArg(flags.schema)
  if (schema === null) return badRequest('a --schema <json|@file> is required for extract')

  return withConnection(flags, async ({ page }) => {
    const prev = await loadState(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)

    const nodes = await snapshotNodes(page, { interactive: true })
    const { text, refmap } = render(
      nodes,
      { generation: gen, entries: {} },
      {
        generation: gen,
        title: await page.title().catch(() => ''),
        url: page.url(),
        // Bound the extract snapshot the same way handleSnapshot does (fix M1):
        // an uncapped bundle could blow the host's context. Exceeding the cap
        // fails loudly with output_overflow (never a silent truncation).
        ...(flags.maxOutput !== undefined ? { maxChars: flags.maxOutput } : {}),
      },
    )
    await saveRefMap(flags.session, refmap)

    // Element IDs are `<generation>-<n>` (the ^\d+-\d+$ shape transform.ts
    // constrains url fields to). Build the id→value map and an id-annotated
    // snapshot the host reads. The host only ever sees IDs, never real URLs.
    const nodeByBackend = new Map<number, SnapNode>()
    for (const n of nodes) nodeByBackend.set(n.backendNodeId, n)

    const valueMap: Record<string, string> = {}
    const idToUrl = new Map<string, string>()
    for (const [ref, entry] of Object.entries(refmap.entries)) {
      const id = `${gen}-${ref.slice(1)}` // "e3" -> "<gen>-3"
      const node = nodeByBackend.get(entry.backendNodeId)
      valueMap[id] = node?.url ?? node?.name ?? node?.value ?? ''
      if (node?.url) idToUrl.set(id, node.url)
    }

    // The host must see IDs, NEVER real URLs (the moat, spec §8): the id-pattern
    // schema alone is not enough, because resolveIds passes a non-ID string
    // through untouched — so a host that COPIED a real URL out of the snapshot
    // would bypass grounding. We therefore strip each link's real `url=` token
    // from the host-facing snapshot; the CLI-retained valueMap holds the truth.
    const idText = text
      .replace(/ref=e(\d+)/g, (_m, n: string) => `id=${gen}-${n}`)
      .split('\n')
      .map((line) => {
        const m = /id=(\d+-\d+)/.exec(line)
        if (!m) return line // header/non-ref lines keep their url (page context)
        const u = idToUrl.get(m[1])
        return u ? line.replace(`, url=${u}]`, ']').replace(` url=${u}`, '') : line
      })
      .join('\n')
    const safeIdText = flags.contentBoundaries ? neutralize(idText) : idText

    const bundle = buildBundle(schema, safeIdText, valueMap, flags.instruction)

    await saveState(flags.session, {
      generation: gen,
      prevTree: text,
      fingerprint: prev?.fingerprint ?? null,
      extract: { urlFieldPaths: bundle.url_field_paths, valueMap, generation: gen },
    })

    return ok(bundle)
  })
}

async function handleExtractResolve(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const result = parseJsonArg(flags.ids)
  if (result === undefined) return badRequest('extract resolve requires --ids <json|@file>')

  const state = await loadState(flags.session)
  const ex = state?.extract
  if (!ex) return badRequest('no extract bundle in this session; run `extract --schema` first')

  const currentGeneration = state?.generation ?? ex.generation
  const res = resolveIds(result, ex.urlFieldPaths, ex.valueMap, ex.generation, currentGeneration)
  if (!res.ok) return fail(res.code)
  return ok(res.data, res.warning)
}

// ---------------------------------------------------------------------------
// auth / sessions
// ---------------------------------------------------------------------------

async function handleStateVerb(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  const target = flags.args[1] ?? flags.state
  if (sub === 'save') {
    if (!target) return badRequest('usage: silver state save <path>')
    // Path containment (fix P1-SEC4): the storage-state file is written to disk.
    const c = assertContainedPath(target)
    if (!c.ok) return fail('path_denied')
    const savePath = c.resolved
    return withConnection(flags, async ({ context }) => {
      await context.storageState({ path: savePath })
      return ok({ saved: true })
    })
  }
  if (sub === 'load') {
    if (!target) return badRequest('usage: silver state load <path>')
    // Path containment (fix P1-SEC4): only read a storage-state file from CWD.
    const c = assertContainedPath(target)
    if (!c.ok) return fail('path_denied')
    let parsed: { cookies?: unknown }
    try {
      parsed = JSON.parse(await fs.readFile(c.resolved, 'utf8')) as { cookies?: unknown }
    } catch {
      return badRequest('could not read the storage-state file')
    }
    return withConnection(flags, async ({ context }) => {
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        await context.addCookies(parsed.cookies as Parameters<typeof context.addCookies>[0])
      }
      // NOTE (v1): localStorage/origins from storageState are not replayed here
      // (would require navigating each origin). Cookies are applied. See report.
      return ok({ loaded: true, cookies: Array.isArray(parsed.cookies) ? parsed.cookies.length : 0 })
    })
  }
  return badRequest('usage: silver state save|load <path>')
}

async function handleCookies(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.args[0] !== 'set') return badRequest('usage: silver cookies set --curl <file>')
  if (!flags.curl) return badRequest('usage: silver cookies set --curl <file>')
  let raw: string
  try {
    raw = await fs.readFile(flags.curl, 'utf8')
  } catch {
    return badRequest('could not read the cookies file')
  }
  return withConnection(flags, async ({ context, page }) => {
    const origin = flags.url ?? page.url()
    const cookies = parseCookies(raw, origin)
    if (cookies.length === 0) return badRequest('no cookies found in the supplied file')
    await context.addCookies(cookies as Parameters<typeof context.addCookies>[0])
    return ok({ set: cookies.length })
  })
}

type SimpleCookie = { name: string; value: string; url?: string; domain?: string; path?: string }

/** Parse a cookies payload: a JSON array, a raw cURL command, or a bare
 * `Cookie:` header / `k=v; k2=v2` string. */
function parseCookies(raw: string, originUrl: string): SimpleCookie[] {
  const trimmed = raw.trim()
  // 1. JSON array of cookie objects.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr)) {
        return arr
          .filter((c): c is SimpleCookie => typeof c === 'object' && c !== null && 'name' in c)
          .map((c) => (c.domain || c.url ? c : { ...c, url: safeOrigin(originUrl) }))
      }
    } catch {
      /* fall through */
    }
  }
  // 2. A `Cookie:` header line embedded in a curl command or on its own.
  const headerMatch = /(?:cookie:\s*)([^\n'"]+)/i.exec(trimmed)
  const pairSource = headerMatch ? headerMatch[1] : trimmed
  return pairSource
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .map((p) => {
      const eq = p.indexOf('=')
      return {
        name: p.slice(0, eq).trim(),
        value: p.slice(eq + 1).trim(),
        url: safeOrigin(originUrl),
      }
    })
    .filter((c) => c.name.length > 0)
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'http://localhost'
  }
}

async function handleSession(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  if (sub === 'id') {
    const base = flags.scope === 'worktree' ? worktreeRoot(process.cwd()) : process.cwd()
    const prefix = flags.prefix ?? 'silver'
    const id = `${prefix}-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`
    // Deliberately omit `base` (a path) from the envelope — no-leak invariant.
    return ok({ id, scope: flags.scope ?? 'cwd' })
  }
  if (sub === 'list') return sessionList()
  if (sub === 'gc') return sessionGc()
  return badRequest('usage: silver session id|list|gc')
}

/**
 * `session list` — enumerate this namespace's sessions with liveness (is the pid
 * alive?), active tab count, and age. Cheap: reads the sidecars only (no CDP
 * connect, no browser spawn). External (connect'd) sessions report `alive:null`
 * since we don't own the process to signal it.
 */
async function sessionList(): Promise<Envelope<unknown>> {
  const names = await listSessionNames()
  const sessions = []
  for (const name of names) {
    const info = await readSidecar(name).catch(() => null)
    const reg = await loadTabRegistry(name).catch(() => null)
    const alive: boolean | null = info ? (info.external ? null : isPidAlive(info.pid)) : false
    const tabs = reg ? reg.tabs.length : alive === false ? 0 : 1
    sessions.push({
      name,
      alive,
      external: info?.external ?? false,
      ...(info && !info.external ? { pid: info.pid } : {}),
      tabs,
      ...(info?.createdAt ? { ageMs: Date.now() - Date.parse(info.createdAt) } : {}),
    })
  }
  return ok({ namespace: currentNamespace() || null, sessions })
}

/**
 * `session gc` — reap dead sessions: remove the dirs of sessions whose owned
 * browser process is gone, plus orphaned dirs missing/with a corrupt sidecar
 * (port of the Rust fork's walk_daemons/cleanup_stale_files). Never touches an
 * external (connect'd) session or a session with a live pid.
 */
async function sessionGc(): Promise<Envelope<unknown>> {
  let entries
  try {
    entries = await fs.readdir(sessionsRoot(), { withFileTypes: true })
  } catch {
    return ok({ removed: [], kept: [] })
  }
  const removed: string[] = []
  const kept: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const name = e.name
    const hasSidecar = existsSync(path.join(sessionsRoot(), name, 'session.json'))
    const info = hasSidecar ? await readSidecar(name).catch(() => null) : null
    if (info?.external) {
      kept.push(name)
      continue
    }
    if (!info || !isPidAlive(info.pid)) {
      await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
      removed.push(name)
    } else {
      kept.push(name)
    }
  }
  return ok({ removed, kept })
}

function worktreeRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

async function listSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsRoot(), { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory() && existsSync(path.join(sessionsRoot(), e.name, 'session.json'))) {
        out.push(e.name)
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

async function handleDoctor(): Promise<Envelope<unknown>> {
  const report: { playwright: boolean; chromium: boolean; uab_writable: boolean } = {
    playwright: true,
    chromium: false,
    uab_writable: false,
  }
  try {
    const exec = chromium.executablePath()
    report.chromium = Boolean(exec) && existsSync(exec)
  } catch {
    report.chromium = false
  }
  try {
    const root = path.join(os.homedir(), '.silver')
    await fs.mkdir(root, { recursive: true })
    const probe = path.join(root, `.doctor-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.rm(probe, { force: true })
    report.uab_writable = true
  } catch {
    report.uab_writable = false
  }
  return ok(report)
}

function handleSkill(flags: ParsedFlags): Envelope<unknown> {
  // Serve the on-disk SKILL.md when present (fix §5): `--full` returns it whole,
  // default returns a compact head. Fall back to the inline blurb below when the
  // file is absent, so this handler is fully self-contained.
  const skillFile = path.join(PACKAGE_ROOT, 'skill-data', 'core', 'SKILL.md')
  let onDisk: string | null = null
  try {
    onDisk = readFileSync(skillFile, 'utf8')
  } catch {
    onDisk = null
  }
  if (onDisk && onDisk.trim().length > 0) {
    return ok(flags.full ? onDisk : compactHead(onDisk))
  }

  const short =
    'silver — keyless browser automation for AI agents. Lean loop: ' +
    '`open <url>` -> `snapshot -i` (grounded @eN refs) -> act with `--enable-actions` ' +
    '(`click @eN`, `fill @eN <text>`) -> re-`snapshot` to observe the diff. ' +
    'Read-only by default; actor verbs need `--enable-actions`. IDs are grounded: ' +
    'a stale ref fails loudly (re-snapshot, never guess). Extract is host-run: ' +
    '`extract --schema <json>` prints a bundle you infer over, then `extract resolve --ids <json>` ' +
    'maps element IDs back to real values. `silver doctor` checks your install.'
  if (flags.full) {
    return ok(
      short +
        '\n\nSecurity posture: file:/data:/blob: navigation denied by default ' +
        '(`--allow-file-access` lifts file:); egress is a scheme+host denylist with ' +
        'opt-in `--allowed-domains` suffix hardening; page output is neutralized + ' +
        'boundary-fenced (`--no-content-boundaries` off, `--max-output` caps free-form dumps); ' +
        'passwords/cards are redacted at the serializer. The CLI NEVER calls a model — ' +
        'the host is the brain.',
    )
  }
  return ok(short)
}

/** Compact head of a long SKILL.md: leading content to a line boundary. */
function compactHead(md: string): string {
  const LIMIT = 1200
  if (md.length <= LIMIT) return md
  const slice = md.slice(0, LIMIT)
  const lastNl = slice.lastIndexOf('\n')
  const head = lastNl > 0 ? slice.slice(0, lastNl) : slice
  return `${head}\n\n… (run \`silver skill --full\` for the complete SKILL.md)`
}

/**
 * `dialog` verb (fix P0-7). Dialogs are AUTO-ACCEPTED as they appear (see
 * attachDialogHandler); this verb surfaces the last one. Minimal by design:
 *   dialog | dialog status   -> the last dialog (type + message) or null
 *   dialog accept | dismiss  -> acknowledges the (already-automatic) mode
 * Note: `dialog` is registry-classified as an actor verb, so it requires
 * --enable-actions to dispatch.
 */
async function handleDialog(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0] ?? 'status'
  if (sub === 'status') {
    const last = await loadDialogSidecar(flags.session)
    return ok({ lastDialog: last })
  }
  if (sub === 'accept' || sub === 'dismiss') {
    return ok({ mode: sub, note: 'dialogs are auto-accepted when they appear' })
  }
  return badRequest('usage: silver dialog status')
}

// ---------------------------------------------------------------------------
// network — captured requests, routing, and HAR export (real Playwright/CDP).
//   network requests [--filter|--type|--method|--status] [--clear]   (read)
//   network route <url> [--abort|--body <json>] [--resource-types <csv>] (actor)
//   network unroute [url]                                            (actor)
//   network har start | stop [path]                                  (read)
// ---------------------------------------------------------------------------

async function handleNetwork(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  switch (sub) {
    case 'requests':
      return handleNetworkRequests(flags)
    case 'route':
      return handleNetworkRoute(flags)
    case 'unroute':
      return handleNetworkUnroute(flags)
    case 'har':
      return handleNetworkHar(flags)
    default:
      return badRequest('usage: silver network <requests|route|unroute|har> [args]')
  }
}

async function handleNetworkRequests(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    await ensureCapture(page, flags.session)
    let list = await readCapture(page, 'net')
    if (flags.filter !== undefined) {
      list = list.filter((r) => String(r.url ?? '').includes(flags.filter as string))
    }
    if (flags.type !== undefined) {
      list = list.filter((r) => String(r.resourceType ?? '') === flags.type)
    }
    if (flags.method !== undefined) {
      const m = flags.method.toUpperCase()
      list = list.filter((r) => String(r.method ?? '').toUpperCase() === m)
    }
    if (flags.status !== undefined) {
      const s = flags.status
      list = list.filter((r) => {
        const st = String(r.status ?? '')
        return st === s || st.startsWith(s)
      })
    }
    const total = list.length
    // Bound the returned array (the page-side ring buffer is already capped).
    const CAP = 200
    const requests = list.slice(-CAP)
    if (flags.clear) await clearCapture(page, 'net')
    return ok({ total, requests })
  })
}

async function handleNetworkRoute(flags: ParsedFlags): Promise<Envelope<unknown>> {
  // Interception mutates network behaviour → an ACTOR sub-op (verb-level registry
  // gate cannot split by subcommand, so gate here — mirrors `wait --fn`).
  if (!flags.enableActions) return fail('not_permitted')
  const url = flags.args[1]
  if (!url) {
    return badRequest(
      'usage: silver network route <url> [--abort] [--body <json>] [--resource-types <csv>]',
    )
  }
  const rule: RouteRule = { url, abort: flags.abort }
  if (flags.body !== undefined) rule.body = flags.body
  if (flags.resourceTypes.length > 0) rule.resourceTypes = flags.resourceTypes
  // Persist the rule; withConnection re-applies all rules on every connection so
  // routing is effectively persistent across the stateless per-command reconnect.
  await addRoute(flags.session, rule)
  return ok({
    routed: url,
    abort: rule.abort,
    ...(rule.body !== undefined ? { fulfilled: true } : {}),
    ...(rule.resourceTypes ? { resourceTypes: rule.resourceTypes } : {}),
  })
}

async function handleNetworkUnroute(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (!flags.enableActions) return fail('not_permitted')
  const url = flags.args[1]
  await removeRoute(flags.session, url)
  return ok({ unrouted: url ?? 'all' })
}

async function handleNetworkHar(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const op = flags.args[1]
  if (op === 'start') {
    await startHar(flags.session)
    // Ensure capture is live so the buffer accumulates for the HAR export.
    return withConnection(flags, async ({ page }) => {
      await ensureCapture(page, flags.session)
      return ok({ har: 'recording' })
    })
  }
  if (op === 'stop') {
    const outPath = flags.args[2]
    let resolvedOut: string | undefined
    if (outPath) {
      const c = assertContainedPath(outPath)
      if (!c.ok) return fail('path_denied')
      resolvedOut = c.resolved
    }
    return withConnection(flags, async ({ page }) => {
      await ensureCapture(page, flags.session)
      const list = await readCapture(page, 'net')
      const har = buildHar(list)
      await stopHar(flags.session)
      if (resolvedOut) {
        await fs.writeFile(resolvedOut, JSON.stringify(har, null, 2), 'utf8')
        return ok({ saved: true, entries: list.length })
      }
      return ok({ entries: list.length, har })
    })
  }
  return badRequest('usage: silver network har <start|stop> [path]')
}

// ---------------------------------------------------------------------------
// pdf — render the current page to PDF (Chromium headless only). Read-only.
// ---------------------------------------------------------------------------

async function handlePdf(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const outPath = flags.args[0]
  // Path containment (fix P1-SEC4): only write inside the working directory.
  let resolvedOut: string | undefined
  if (outPath) {
    const c = assertContainedPath(outPath)
    if (!c.ok) return fail('path_denied')
    resolvedOut = c.resolved
  }
  return withConnection(flags, async ({ page }) => {
    try {
      const pdfOpts: { path?: string } = {}
      if (resolvedOut) pdfOpts.path = resolvedOut
      const buf = await page.pdf(pdfOpts)
      if (resolvedOut) return ok({ saved: true })
      return ok({ encoding: 'base64', pdf: buf.toString('base64') })
    } catch {
      // page.pdf throws in headed Chromium; the default is headless so this is rare.
      return badRequest('pdf generation requires headless Chromium (the default runs headless)')
    }
  })
}

// ---------------------------------------------------------------------------
// frame — switch subsequent selector/eval commands into an iframe's context.
//   frame <@ref|selector|name>  -> store + validate the active frame
//   frame main                  -> reset to the main frame
// (ref-based verbs are ALREADY frame-aware via the RefEntry.frameId plumbing; this
// makes SELECTOR/eval commands target a frame explicitly — see get-count / eval.)
// ---------------------------------------------------------------------------

async function handleFrame(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const arg = flags.args[0]
  if (!arg) return badRequest('usage: silver frame <@ref|selector|name|main>')
  if (arg === 'main') {
    await clearActiveFrame(flags.session)
    return ok({ frame: 'main' })
  }
  return withConnection(flags, async ({ page }) => {
    let key = arg
    // A grounded `@ref` is resolved NOW to a durable key (the frame's name or
    // url) so later re-resolution survives DOM re-renders / reconnects.
    if (parseRef(arg)) {
      const refmap = await loadRefMap(flags.session)
      if (!refmap) return fail('element_not_found')
      const g = groundRef(refmap, arg)
      if (!g.ok) return fail(g.code)
      const cdp = await page.context().newCDPSession(page)
      try {
        const loc = await toLocator(page, cdp, g.entry, g.ref)
        const handle = await loc.elementHandle()
        const cf = handle ? await handle.contentFrame() : null
        if (!cf) return fail('element_not_found')
        key = cf.name() || cf.url()
      } catch {
        return fail('element_not_found')
      } finally {
        await cleanupStamp(page).catch(() => {})
        await cdp.detach().catch(() => {})
      }
    }
    const frame = await findFrame(page, key)
    if (!frame) return fail('element_not_found')
    await saveActiveFrame(flags.session, key)
    return ok({ frame: { name: frame.name() || null, url: frame.url() } })
  })
}

// ---------------------------------------------------------------------------
// storage — localStorage / sessionStorage. get=read, set/clear=actor.
// ---------------------------------------------------------------------------

async function handleStorage(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0]
  if (kind !== 'local' && kind !== 'session') {
    return badRequest('usage: silver storage <local|session> [get|set|clear] [key] [value]')
  }
  const store = kind === 'local' ? 'localStorage' : 'sessionStorage'

  // Sub-op + positional resolution mirrors the Rust oracle: an explicit
  // get/set/clear takes key/value after it; a bare `storage local <key>` is a get.
  let op = flags.args[1]
  let key: string | undefined
  let value: string | undefined
  if (op === 'get' || op === 'set' || op === 'clear') {
    key = flags.args[2]
    value = flags.args[3]
  } else {
    key = flags.args[1]
    value = flags.args[2]
    op = 'get'
  }

  // set/clear mutate storage → ACTOR sub-ops (gate here; verb is read-only-listed).
  if ((op === 'set' || op === 'clear') && !flags.enableActions) return fail('not_permitted')

  return withConnection(flags, async ({ page }) => {
    if (op === 'set') {
      if (key === undefined || value === undefined) {
        return badRequest('usage: silver storage <local|session> set <key> <value>')
      }
      await page.evaluate(
        (a: string[]) => {
          ;(globalThis as unknown as Record<string, Storage>)[a[0]].setItem(a[1], a[2])
        },
        [store, key, value],
      )
      return ok({ set: key })
    }
    if (op === 'clear') {
      await page.evaluate((s: string) => {
        ;(globalThis as unknown as Record<string, Storage>)[s].clear()
      }, store)
      return ok({ cleared: true, type: kind })
    }
    // get
    if (key !== undefined) {
      const v = (await page.evaluate(
        (a: string[]) => (globalThis as unknown as Record<string, Storage>)[a[0]].getItem(a[1]),
        [store, key],
      )) as string | null
      return ok({ key, value: v === null ? null : presentPageText(v, flags) })
    }
    // whole-store dump (constant script — store name is a validated literal).
    const all = (await page.evaluate(
      `(function(){var s=window.${store};var o={};for(var i=0;i<s.length;i++){var k=s.key(i);if(k!==null)o[k]=s.getItem(k);}return o;})()`,
    )) as Record<string, string>
    return ok({ type: kind, storage: all })
  })
}

// ---------------------------------------------------------------------------
// console / errors — page-derived captured logs (read-only). Routed through
// presentPageText (neutralize + cap) since the content is untrusted page output.
// ---------------------------------------------------------------------------

async function handleConsole(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    await ensureCapture(page, flags.session)
    const msgs = await readCapture(page, 'console')
    if (flags.clear) await clearCapture(page, 'console')
    const text = msgs.map((m) => `[${String(m.level ?? 'log')}] ${String(m.text ?? '')}`).join('\n')
    return ok(
      presentPageText(text, flags),
      msgs.length === 0 ? 'no console messages captured yet on this page' : undefined,
    )
  })
}

async function handleErrors(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    await ensureCapture(page, flags.session)
    const errs = await readCapture(page, 'errors')
    if (flags.clear) await clearCapture(page, 'errors')
    const text = errs.map((e) => String(e.message ?? '')).join('\n')
    return ok(
      presentPageText(text, flags),
      errs.length === 0 ? 'no page errors captured yet on this page' : undefined,
    )
  })
}

// ---------------------------------------------------------------------------
// clipboard — read (read-only) / write (actor). Uses the async Clipboard API
// after granting clipboard permission on the connected context.
// ---------------------------------------------------------------------------

async function handleClipboard(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0] ?? 'read'
  if (sub !== 'read' && sub !== 'write') {
    return badRequest('usage: silver clipboard <read|write> [text]')
  }
  if (sub === 'write' && !flags.enableActions) return fail('not_permitted')

  return withConnection(flags, async ({ page, context }) => {
    await context
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: safeOrigin(page.url()) })
      .catch(() => {})
    // `navigator.clipboard` lives in the BROWSER (tsconfig `lib` has no DOM, and
    // Node's Navigator type lacks `clipboard`) — reach it through the page global.
    type ClipGlobal = {
      navigator: { clipboard: { writeText(v: string): Promise<void>; readText(): Promise<string> } }
    }
    if (sub === 'write') {
      const text = flags.stdin ? await readStdin() : flags.args.slice(1).join(' ')
      try {
        await page.evaluate(
          (t: string) => (globalThis as unknown as ClipGlobal).navigator.clipboard.writeText(t),
          text,
        )
      } catch {
        return badRequest('clipboard write failed (the page may lack clipboard permission/focus)')
      }
      return ok({ written: text.length })
    }
    // read
    try {
      const text = (await page.evaluate(() =>
        (globalThis as unknown as ClipGlobal).navigator.clipboard.readText(),
      )) as string
      return ok(presentPageText(text ?? '', flags))
    } catch {
      return badRequest('clipboard read failed (the page may lack clipboard permission/focus)')
    }
  })
}

// ---------------------------------------------------------------------------
// mouse — raw pointer input at page coordinates (actor).
//   mouse move|click <x> <y> [button] | mouse down|up [button] | mouse wheel <dy> [dx]
// ---------------------------------------------------------------------------

const MOUSE_BUTTONS: ReadonlySet<string> = new Set(['left', 'right', 'middle'])

function mouseButton(arg: string | undefined): 'left' | 'right' | 'middle' {
  return arg && MOUSE_BUTTONS.has(arg) ? (arg as 'left' | 'right' | 'middle') : 'left'
}

async function handleMouse(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  return withConnection(flags, async ({ page }) => {
    switch (sub) {
      case 'move':
      case 'click': {
        const x = Number(flags.args[1])
        const y = Number(flags.args[2])
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return badRequest(`usage: silver mouse ${sub} <x> <y> [button]`)
        }
        if (sub === 'move') {
          await page.mouse.move(x, y)
          return ok({ moved: { x, y } })
        }
        const button = mouseButton(flags.args[3])
        await page.mouse.click(x, y, { button })
        return ok({ clicked: { x, y, button } })
      }
      case 'down': {
        const button = mouseButton(flags.args[1])
        await page.mouse.down({ button })
        return ok({ down: button })
      }
      case 'up': {
        const button = mouseButton(flags.args[1])
        await page.mouse.up({ button })
        return ok({ up: button })
      }
      case 'wheel': {
        const dy = Number(flags.args[1] ?? 100)
        const dx = Number(flags.args[2] ?? 0)
        await page.mouse.wheel(Number.isFinite(dx) ? dx : 0, Number.isFinite(dy) ? dy : 0)
        return ok({ wheel: { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 } })
      }
      default:
        return badRequest('usage: silver mouse <move|click|down|up|wheel> [args]')
    }
  })
}

// ---------------------------------------------------------------------------
// keyboard — raw keyboard input (actor). Typed text length is reported (never
// the text itself — it may be a password).
//   keyboard type <text> | keyboard press|down|up <key>
// ---------------------------------------------------------------------------

async function handleKeyboard(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  return withConnection(flags, async ({ page }) => {
    switch (sub) {
      case 'type': {
        const text = flags.stdin ? await readStdin() : flags.args.slice(1).join(' ')
        await page.keyboard.type(text)
        return ok({ typed: text.length })
      }
      case 'press':
      case 'down':
      case 'up': {
        const key = flags.args[1]
        if (!key) return badRequest(`usage: silver keyboard ${sub} <key>`)
        if (sub === 'press') await page.keyboard.press(key)
        else if (sub === 'down') await page.keyboard.down(key)
        else await page.keyboard.up(key)
        return ok({ [sub]: key })
      }
      default:
        return badRequest('usage: silver keyboard <type|press|down|up> ...')
    }
  })
}

// ---------------------------------------------------------------------------
// scrollintoview <@ref> — scroll a grounded ref into view (actor).
// ---------------------------------------------------------------------------

async function handleScrollIntoView(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const ref = flags.args[0]
  if (!ref) return badRequest('usage: silver scrollintoview @eN')
  return withConnection(flags, async ({ page }) =>
    withLocator(page, flags.session, ref, async (loc) => {
      await loc.scrollIntoViewIfNeeded({ timeout: flags.timeout })
      return ok({ scrolled: true, ref })
    }),
  )
}

// ---------------------------------------------------------------------------
// eval <js> | eval --stdin — run host-authored JS in the page (or active frame).
// KEYLESS (the host's own code, not a model call). Gated behind --enable-actions
// via the ACTOR registry (arbitrary in-page JS is a mutating verb). Result is
// neutralized + capped before it reaches the host.
// ---------------------------------------------------------------------------

async function handleEval(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const script = flags.stdin ? await readStdin() : flags.args.join(' ')
  if (script.trim().length === 0) return badRequest('usage: silver eval <js> | eval --stdin')
  return withConnection(flags, async ({ page }) => {
    // Run in the active frame's context (set via `frame <sel>`), else main frame.
    const frame = await resolveActiveFrame(page, flags.session)
    let result: unknown
    try {
      result = await frame.evaluate(script)
    } catch {
      // A page/script exception — no path/secret leak; the host adjusts its JS.
      return badRequest('eval raised an exception in the page')
    }
    const asText =
      typeof result === 'string'
        ? result
        : result === undefined
          ? 'undefined'
          : safeJson(result)
    return ok(presentPageText(asText, flags))
  })
}

/** JSON.stringify that never throws (circular / BigInt → a bounded fallback). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------
// batch — run multiple `silver` commands in ONE process, sharing the session.
//   batch "<cmd>" "<cmd>" ... [--bail]
//   batch --stdin      (JSON array of command strings OR arg-arrays)
// Each sub-command is re-dispatched through run() so the phase-quarantine gate is
// applied PER sub-command; batch itself holds no session lock (each sub-run takes
// and releases it), so the shared session serializes cleanly with no deadlock.
// ---------------------------------------------------------------------------

async function handleBatch(flags: ParsedFlags): Promise<Envelope<unknown>> {
  let commands: string[][]
  try {
    commands = await collectBatchCommands(flags)
  } catch {
    return badRequest('batch --stdin expects a JSON array of command strings or arg-arrays')
  }
  if (commands.length === 0) {
    return badRequest('usage: silver batch "<cmd>" "<cmd>" ... [--bail]  |  batch --stdin')
  }

  // Re-enter the CLI dispatcher. Dynamic import avoids a static cli<->handlers
  // import cycle; `run` is only referenced at call time.
  const { run } = await import('../cli.js')
  const shared = sharedGlobals(flags)

  const results: Array<{ command: string; success: boolean; error: string | null }> = []
  let failed = false
  for (const argv of commands) {
    if (argv.length === 0) continue
    const res = await run([...argv, ...shared])
    results.push({ command: argv.join(' '), success: res.env.success, error: res.env.error })
    if (!res.env.success) {
      failed = true
      if (flags.bail) break
    }
  }
  return {
    success: !failed,
    data: { count: results.length, results },
    error: failed ? 'one or more batch commands failed' : null,
  }
}

/** Collect the batch command list from positional args or a `--stdin` JSON array. */
async function collectBatchCommands(flags: ParsedFlags): Promise<string[][]> {
  if (flags.stdin) {
    const parsed = JSON.parse(await readStdin()) as unknown
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed.map((item) => {
      if (typeof item === 'string') return shellSplit(item)
      if (Array.isArray(item)) return item.map((x) => String(x))
      throw new Error('bad item')
    })
  }
  return flags.args.map((a) => shellSplit(a))
}

/**
 * The session-scoping + permission globals to append to every batch sub-command
 * so they share ONE session and inherit the batch's grant. Appended AFTER the
 * sub-command's own tokens so the shared session/namespace always win.
 */
function sharedGlobals(flags: ParsedFlags): string[] {
  const g: string[] = ['--session', flags.session]
  if (flags.namespace) g.push('--namespace', flags.namespace)
  if (flags.enableActions) g.push('--enable-actions')
  if (flags.confirmActionsProvided) g.push('--confirm-actions', flags.confirmActions.join(','))
  if (flags.allowFileAccess) g.push('--allow-file-access')
  if (flags.allowedDomains.length > 0) g.push('--allowed-domains', flags.allowedDomains.join(','))
  if (flags.timeout !== undefined) g.push('--timeout', String(flags.timeout))
  if (flags.maxOutput !== undefined) g.push('--max-output', String(flags.maxOutput))
  if (flags.headed) g.push('--headed')
  if (!flags.contentBoundaries) g.push('--no-content-boundaries')
  return g
}

/**
 * Minimal shell-word splitter (mirrors the Rust oracle's shell_words_split):
 * respects single/double quotes and backslash escapes. Used to turn a batch
 * command STRING into an argv array. Pure string parsing — no shell invoked.
 */
function shellSplit(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let hasToken = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && !inSingle) {
      const next = s[i + 1]
      if (next !== undefined) {
        cur += next
        hasToken = true
        i++
      }
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      hasToken = true
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      hasToken = true
      continue
    }
    if (c === ' ' && !inSingle && !inDouble) {
      if (hasToken) {
        out.push(cur)
        cur = ''
        hasToken = false
      }
      continue
    }
    cur += c
    hasToken = true
  }
  if (hasToken) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** A clean, non-leaking bad-request envelope (static message only). */
function badRequest(message: string): Envelope<never> {
  return { success: false, data: null, error: message }
}

function notImplemented(): Envelope<never> {
  return { success: false, data: null, error: 'not implemented in v1' }
}

function parseSchemaArg(arg: string | undefined): JsonSchema | null {
  const parsed = parseJsonArg(arg)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return null
  return parsed as JsonSchema
}

/** Parse a `--schema`/`--ids` value: `@file` reads+parses the file, else inline JSON. */
function parseJsonArg(arg: string | undefined): unknown {
  if (arg === undefined) return undefined
  try {
    if (arg.startsWith('@')) {
      // Synchronous read keeps parsing simple; the file is operator-supplied.
      return JSON.parse(readFileSync(arg.slice(1), 'utf8'))
    }
    return JSON.parse(arg)
  } catch {
    return undefined
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Minimal HTML → text: drop script/style, strip tags, decode a few entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
