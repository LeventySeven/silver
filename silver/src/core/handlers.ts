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
import { promises as fs, existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import type { Page, Locator, CDPSession, Frame, BrowserContext } from 'playwright'

import { ok, fail, type Envelope } from './envelope.js'
import { ERRORS } from './errors.js'
import type { ParsedFlags } from './flags.js'
import {
  openSession,
  connect,
  connectExternalSession,
  closeSession,
  saveRefMap,
  loadRefMap,
  readSidecar,
  writeSidecar,
  readSidecarObject,
  sessionDir,
  sessionsRoot,
  isPidAlive,
  currentNamespace,
  normalizeEngine,
  grantDefaultPermissions,
  autoHandleDownloads,
  noteAction,
  isRepeating,
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
  resolveWriteValue,
  type ActVerb,
  type ActOptions,
  type FindKind,
} from '../actuation/actions.js'
import * as actionsMod from '../actuation/actions.js'
import * as confirmMod from '../security/confirm.js'
import { toLocator, ResolveError } from '../actuation/resolve.js'
import {
  settleAndFingerprint,
  fingerprintOnly,
  bumpGenerationOnPageChange,
  detectEmptyPage,
  type SettleMode,
} from '../actuation/pagechange.js'
import { withRetries } from './retry.js'
import { loadPolicy, decideAction } from '../security/policy.js'
import { buildSecretRegistry, type SecretRegistry } from '../security/secret.js'
import { taintGuardCheck } from '../security/taint.js'
import { resolveSkills, type Skill } from './skillmatch.js'
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
// Cross-agent merge contracts (implemented by SIBLING agents; called here).
//
// These are resolved by NAMESPACE lookup rather than a static named import so a
// concurrent build stays green before the sibling's export lands: an absent
// export is `undefined` (feature no-ops) instead of a module-load failure. Once
// merged, the real implementations take over. The EXACT signatures below are the
// merge contract the sibling must satisfy.
// ---------------------------------------------------------------------------

/** B1 coordinate actuation (SIBLING adds these to actuation/actions.ts). Each
 * performs the raw page.mouse/page.keyboard action and resolves void. */
type CoordActions = {
  coordClick?(page: Page, x: number, y: number): Promise<void>
  coordType?(page: Page, x: number, y: number, text: string): Promise<void>
  coordDrag?(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void>
}
const coordActions = actionsMod as unknown as CoordActions

/** E2 confirm-preview (SIBLING adds `buildConfirmPreview` to security/confirm.ts).
 * Keyless: builds a preview from the grounded refmap + target (no model call).
 * May be sync or async; the callsite awaits it. */
type ConfirmPreviewInput = {
  /** The grounded control's accessible name (the thing about to be activated). */
  name: string
  /** The form field values about to be submitted (field name → value). */
  formValues?: Record<string, string>
  /** Visible page text, used to surface the checkout total (optional). */
  pageText?: string
}
type ConfirmPreviewFns = {
  buildConfirmPreview?(input: ConfirmPreviewInput): unknown
}
const confirmPreview = confirmMod as unknown as ConfirmPreviewFns

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

// silver-state.json holds prevTree (full page-tree text) AND extract.valueMap
// (the REAL urls the extract moat hides from the host) — so it is routed through
// the SAME AES-256-GCM encryption-at-rest + plaintext-legacy migration as
// session.json / refmap.json (fix F4/F8), never raw fs+JSON.
async function loadState(name: string): Promise<UabState | null> {
  try {
    return await readSidecarObject<UabState>(statePath(name))
  } catch {
    return null
  }
}

async function saveState(name: string, state: UabState): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(statePath(name), state)
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
// S4: pending-confirmation store (pending-confirms.json) — the decoupled
// two-phase confirm gate. A paid/destructive action gated with
// `--two-phase-confirm` is PERSISTED here (verb + args + preview + TTL) keyed by
// a fresh id; a follow-up `silver confirm <id>` re-runs it (pre-approved) and
// `silver deny <id>` drops it. Encrypted at rest through the shared sidecar
// crypto (page-authored preview text may be present), never raw fs+JSON.
// ---------------------------------------------------------------------------

/** How long a pending confirmation stays resolvable before it expires. */
const CONFIRM_TTL_MS = 5 * 60 * 1000

type PendingConfirm = {
  id: string
  verb: string
  /** The positional args the original command carried (ref, and any value). */
  args: string[]
  /** The human-facing preview shown when the confirmation was requested. */
  preview: unknown
  createdAt: string
  ttlMs: number
}

function pendingPath(name: string): string {
  return path.join(sessionDir(name), 'pending-confirms.json')
}

function pendingExpired(rec: PendingConfirm, now: number): boolean {
  const created = Date.parse(rec.createdAt)
  if (!Number.isFinite(created)) return true
  return now - created > (rec.ttlMs ?? CONFIRM_TTL_MS)
}

/** Load the pending-confirmation map, pruning any expired entries. */
async function loadPending(name: string): Promise<Record<string, PendingConfirm>> {
  let map: Record<string, PendingConfirm>
  try {
    map = (await readSidecarObject<Record<string, PendingConfirm>>(pendingPath(name))) ?? {}
  } catch {
    return {}
  }
  const now = Date.now()
  let changed = false
  for (const [id, rec] of Object.entries(map)) {
    if (pendingExpired(rec, now)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) await savePending(name, map).catch(() => {})
  return map
}

async function savePending(name: string, map: Record<string, PendingConfirm>): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(pendingPath(name), map)
}

/** A fresh, unguessable confirmation id (never derived from page content). */
function newConfirmId(): string {
  return `c-${randomBytes(6).toString('hex')}`
}

// ---------------------------------------------------------------------------
// F8: emulation-override sidecar (emulation.json). `set viewport/offline/
// color-scheme` mutate emulation state that lives ONLY for the current CDP
// connection — the stateless per-command reconnect model drops it, so a later
// command saw the default again and the override was silently lost. We PERSIST
// each override here and RE-APPLY it inside withConnection on every connect, so
// `set viewport 800 600` then a later `eval` actually sees width 800.
// ---------------------------------------------------------------------------

type EmulationState = {
  viewport?: { width: number; height: number }
  offline?: boolean
  colorScheme?: 'dark' | 'light' | 'no-preference'
}

function emulationPath(name: string): string {
  return path.join(sessionDir(name), 'emulation.json')
}

async function loadEmulation(name: string): Promise<EmulationState | null> {
  try {
    return await readSidecarObject<EmulationState>(emulationPath(name))
  } catch {
    return null
  }
}

async function patchEmulation(name: string, patch: Partial<EmulationState>): Promise<void> {
  const cur = (await loadEmulation(name)) ?? {}
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(emulationPath(name), { ...cur, ...patch })
}

/**
 * Re-apply the persisted emulation overrides on a fresh connection (F8).
 * Best-effort per override — a failure to apply one never fails the command.
 * Runs AFTER `connect` set the default viewport, so a persisted viewport wins.
 */
async function applyEmulation(page: Page, context: BrowserContext, name: string): Promise<void> {
  const emu = await loadEmulation(name)
  if (!emu) return
  if (emu.viewport) await page.setViewportSize(emu.viewport).catch(() => {})
  if (emu.colorScheme) await page.emulateMedia({ colorScheme: emu.colorScheme }).catch(() => {})
  if (emu.offline !== undefined) await context.setOffline(emu.offline).catch(() => {})
}

// ---------------------------------------------------------------------------
// Connection helpers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E1/D2: the process-wide write-path secret registry. Built ONCE per CLI run
// (cli.ts) from `--secret` specs + `SILVER_SECRET_<NAME>` env vars, and read by
// the write-path handlers (handleAct/handleFind/handleCoordAct) so a
// `<secret>NAME</secret>` / `<totp>NAME</totp>` token resolves at the actions.ts
// choke point. The raw values live ONLY here — never in an envelope or the argv
// the host authored. When unset (no secrets configured) the getter returns a
// fresh empty registry so callers need no null-guard.
// ---------------------------------------------------------------------------
let processSecrets: SecretRegistry | null = null

/** Install the per-run secret registry (called once from cli.ts run()). */
export function setProcessSecrets(reg: SecretRegistry | null): void {
  processSecrets = reg
}

/** The active write-path secret registry (empty when none configured). */
function currentSecrets(): SecretRegistry {
  return processSecrets ?? buildSecretRegistry([])
}

function openOpts(flags: ParsedFlags): OpenOptions {
  // E2: thread `--profile` (an existing user-data-dir) into the launch so an
  // owned session can reuse the user's real logged-in Chrome profile.
  return { headed: flags.headed, engine: normalizeEngine(flags.engine), profile: flags.profile }
}

/** Settle policy for MUTATING verbs: `--wait networkidle` opts into the full
 * idle wait (engine-plan P1b); the common case uses the lowered default budget. */
function settleModeFor(flags: ParsedFlags): SettleMode {
  return flags.waitNetworkidle ? 'full' : 'default'
}

/**
 * F3-policy: the current page URL as recorded in the last snapshot/act
 * fingerprint (`url|focusedBackendId|domNodeCount`), so an `@host`-scoped action
 * policy can be evaluated WITHOUT a browser round-trip before the connection is
 * opened. The url is everything before the final two `|`-segments (a real url is
 * never split — `|` is percent-encoded in URLs). Undefined when no snapshot has
 * been taken yet (then `@host` patterns simply don't match, as before).
 */
async function lastKnownUrl(session: string): Promise<string | undefined> {
  const st = await loadState(session).catch(() => null)
  const fp = st?.fingerprint
  if (!fp) return undefined
  const parts = fp.split('|')
  if (parts.length < 3) return undefined
  const url = parts.slice(0, parts.length - 2).join('|')
  return url && url !== 'about:blank' ? url : undefined
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
    // E4: the CDP attach to a FRESHLY-spawned browser is the flaky call site — the
    // detached Chromium is still bringing up its DevTools endpoint, so the first
    // connect can hit a connection-refused/reset the browser clears in a few ms.
    // Retry it under bounded backoff (transient only; the hard cap surfaces
    // `retries_exhausted` rather than looping) instead of failing the whole command.
    return await withRetries(() => connect(name), {
      transient: { maxRetries: 3, baseMs: 100, maxMs: 1_000 },
      rateLimit: { maxRetries: 0 },
    })
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
    // F8: re-apply persisted emulation overrides (viewport/offline/color-scheme).
    // The per-command reconnect otherwise drops them, so a `set viewport` made in
    // an earlier command would be silently lost by the next command's connect.
    await applyEmulation(page, conn.context, flags.session).catch(() => {})
    // Register the dialog handler on the active page (fix P0-7): with no
    // listener, Playwright silently CANCELS every alert/confirm/prompt, so a
    // `confirm("delete?")` guard is auto-dismissed while the host still gets ok().
    attachDialogHandler(page, flags.session)
    // E4: opt-in permission auto-grant on connect so a task that hits a
    // geolocation/clipboard/notifications prompt does not hang. Flag-gated (OFF
    // by default); best-effort per engine.
    if (flags.grantPermissions) await grantDefaultPermissions(conn.context).catch(() => {})
    // E4: auto-detect PAGE-initiated downloads on every verb EXCEPT `download`
    // (which arms its own waitForEvent — a second consumer would race its saveAs).
    // Prevents a click that kicks off a download from stalling the task; the file
    // is saved to a CONTAINED per-session dir so the click resolves cleanly. The
    // drain is flushed before the transport drops (else saveAs races teardown).
    let drainDownloads: (() => Promise<void>) | null = null
    if (flags.verb !== 'download') {
      drainDownloads = autoHandleDownloads(
        page,
        path.join(sessionDir(flags.session), 'downloads'),
      ).drain
    }
    // Re-materialize any persisted `network route` rules on this connection.
    // `page.route` handlers are client-side and vanish on our per-command CDP
    // reconnect, so routing is kept "on by default" by re-applying it here. A
    // single cheap sidecar read + early return when no rules exist — zero effect
    // on the common (no-route) path. Never throws.
    await applyRoutes(page, flags.session).catch(() => {})
    try {
      return await fn({ ...conn, page })
    } finally {
      // Flush any in-flight auto-download saves before dropping the transport.
      if (drainDownloads) await drainDownloads().catch(() => {})
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

// dialog.json can carry a page-authored dialog message/defaultValue — encrypted
// at rest through the shared sidecar crypto (fix F4/F8), not raw fs+JSON.
async function writeDialogSidecar(name: string, d: LastDialog): Promise<void> {
  try {
    await fs.mkdir(sessionDir(name), { recursive: true })
    await writeSidecar(dialogPath(name), d)
  } catch {
    /* best-effort — the dialog handler must never throw into Playwright */
  }
}

async function loadDialogSidecar(name: string): Promise<LastDialog | null> {
  try {
    return await readSidecarObject<LastDialog>(dialogPath(name))
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
// Narrowed paid/destructive activation gate (fix P0-4 / F3). Shared by
// handleAct, handleMouse (raw-coordinate click), and handleKeyboard (submit-like
// press): on a NON-TTY session that did not pre-approve the verb via
// --confirm-actions, a click/press-like ACTIVATION of a control whose accessible
// name looks paid/destructive (Buy/Pay/Delete/…) is refused (confirm_required).
// A TTY session (interactive human) is allowed through to a prompt.
// ---------------------------------------------------------------------------

function destructivePaidBlocks(name: string, flags: ParsedFlags, verb: string): boolean {
  return (
    isDestructivePaidName(name) && !process.stdout.isTTY && !flags.confirmActions.includes(verb)
  )
}

/** Keys that ACTIVATE the focused control (submit-like), for the F3 keyboard gate. */
const SUBMIT_LIKE_KEYS: ReadonlySet<string> = new Set(['enter', 'numpadenter', 'space', ' '])
function isSubmitLikeKey(key: string): boolean {
  return SUBMIT_LIKE_KEYS.has(key.toLowerCase())
}

// Accessible-name extraction snippet (string JS — tsconfig `lib` has no DOM).
// Prefers aria-label / title, then textContent, then a form control's value.
const NAME_EXTRACT_JS =
  "var n=el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||el.value||'';return String(n).trim();"

/**
 * Best-effort accessible name of the element at viewport point (x,y) — the
 * hit-test the F3 mouse-click gate runs so a raw-coordinate click can't bypass
 * the paid/destructive gate a grounded `click @eN` enforces. x/y are validated
 * finite numbers, so interpolating them into the script is injection-safe.
 */
async function elementNameAtPoint(page: Page, x: number, y: number): Promise<string> {
  const js = `(function(){var el=document.elementFromPoint(${x},${y});if(!el)return '';${NAME_EXTRACT_JS}})()`
  try {
    return ((await page.evaluate(js)) as string) ?? ''
  } catch {
    return ''
  }
}

/** Best-effort accessible name of the currently focused element (F3 keyboard gate). */
async function focusedElementName(page: Page): Promise<string> {
  const js = `(function(){var el=document.activeElement;if(!el)return '';${NAME_EXTRACT_JS}})()`
  try {
    return ((await page.evaluate(js)) as string) ?? ''
  } catch {
    return ''
  }
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
    // AC1: deterministic read-only assertion ("did it actually work?").
    case 'expect':
      return handleExpect(flags)
    // S4: decoupled two-phase confirm gate resolution.
    case 'confirm':
      return handleConfirm(flags)
    case 'deny':
      return handleDeny(flags)
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
    case 'skills':
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
    // download a file triggered by a click (or await the next one with --wait).
    case 'download':
      return handleDownload(flags)
    // raw key hold/release — complete the keyboard surface alongside `press`.
    case 'keydown':
    case 'keyup':
      return handleKeyRaw(flags)
    // mutate browser/page emulation state (viewport/offline/media/geo/tz/locale).
    case 'set':
      return handleSet(flags)
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
    // E4: wrap the flaky navigation in a bounded internal retry. A transient blip
    // (a 503/reset/timeout on load) is retried under bounded backoff instead of
    // surfacing as a hard failure the host must babysit; an unreachable-host
    // `net::ERR_*` is classified FATAL (not retried) so R6 maps it to
    // `navigation_failed` immediately. Exhausting the hard cap throws
    // `retries_exhausted` (never an unbounded loop). rate-limit retries disabled —
    // a nav rarely 429s and a load retry storm would only make it worse.
    await withRetries(() => page.goto(url, gotoOpts(flags)), {
      transient: { maxRetries: 2 },
      rateLimit: { maxRetries: 0 },
    })
    // Re-install on the freshly-loaded document so the page-side wrappers persist
    // into later commands (they live in the doc's JS, surviving our disconnect).
    await ensureCapture(page, flags.session).catch(() => {})
    const prev = await loadState(flags.session)
    // Navigation invalidates prior refs: bump the generation, write an EMPTY
    // refmap at that generation (so a stale `eN` fails element_not_found), reset
    // the diff baseline, and drop any extract bundle.
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen, settleModeFor(flags))
    await saveState(flags.session, {
      generation: gen,
      prevTree: null,
      fingerprint: fp.fingerprint,
    })
    // R2/R3: detect CAPTCHA / auth-wall right after navigation. Surface both as
    // structured booleans on the envelope AND as an advisory warning so the host
    // can branch immediately (CAPTCHA = hand back; auth = load state/cookies).
    const hz = await detectHazards(page)
    // R5a: a (near-)empty DOM after nav is an anti-bot blank shell / a 429-403
    // interstitial / a bundle that never rendered — surface `page_empty` so the
    // host reloads or changes approach rather than acting on a blank page.
    const empty = await detectEmptyPage(page)
    return ok(
      {
        url: page.url(),
        title: await page.title().catch(() => ''),
        page_changed: fp.page_changed,
        ...(hz.captcha ? { captcha_detected: true } : {}),
        ...(hz.auth ? { auth_required: true } : {}),
        ...(empty ? { page_empty: true } : {}),
      },
      hazardWarning(hz, false, empty),
    )
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
    // F9: install capture instrumentation BEFORE the navigation (as handleOpen
    // does) so console/network that fires during the reload/back/forward page
    // LOAD is captured — otherwise ensureCapture ran only after nav and missed
    // every request the freshly-loaded document made on load.
    await ensureCapture(page, flags.session).catch(() => {})

    const isBackForward = flags.verb === 'back' || flags.verb === 'forward'
    if (flags.verb === 'back') await page.goBack(historyNavOpts(flags))
    else if (flags.verb === 'forward') await page.goForward(historyNavOpts(flags))
    else await page.reload(gotoOpts(flags))

    // Re-hook capture on the new document after a history navigation / reload.
    await ensureCapture(page, flags.session).catch(() => {})
    const prev = await loadState(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    // F6: for back/forward, SKIP the settle. A back-forward-cache restore does not
    // re-fire `DOMContentLoaded` for this fresh CDP client, so the settle's
    // `waitForLoadState('domcontentloaded')` (in pagechange.ts, no timeout arg)
    // would block for the FULL default navigation timeout even though the restored
    // page is already loaded. `fingerprintOnly` observes it as-is (no load-state
    // wait) — the page is instantly present after a bfcache restore. `reload` fires
    // the load events normally, so it keeps the bounded settle.
    const fp = isBackForward
      ? await fingerprintOnly(page, prev?.fingerprint, gen)
      : await settleAndFingerprint(page, prev?.fingerprint, gen, settleModeFor(flags))
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
 * F6: goBack/goForward wait options. A history navigation that restores a page
 * from the back-forward cache does NOT fire `domcontentloaded` — the document is
 * reused, not re-parsed — so `waitUntil:'domcontentloaded'` blocks for the FULL
 * `--timeout` (30s) and then errors even though the navigation already
 * succeeded. `commit` resolves as soon as the navigation is committed (which a
 * bfcache restore does immediately), returning promptly on success.
 */
function historyNavOpts(flags: ParsedFlags): { waitUntil: 'commit'; timeout?: number } {
  const o: { waitUntil: 'commit'; timeout?: number } = { waitUntil: 'commit' }
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
        emitUrls: flags.urls,
        prevRefmap,
        ...(flags.maxOutput !== undefined ? { maxChars: flags.maxOutput } : {}),
      },
    )
    await saveRefMap(flags.session, refmap)

    const obsv = observe(prev?.prevTree ?? null, text)
    // Read-only observe: NO networkidle settle race (engine-plan P1). The cheap
    // fingerprint still emits the page_changed/stale_refs flag.
    const fp = await fingerprintOnly(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: text,
      fingerprint: fp.fingerprint,
      ...(prev?.extract ? { extract: prev.extract } : {}),
    })

    // R2/R3: cheap keyless CAPTCHA / auth-wall detection, surfaced as an advisory
    // warning alongside the page_changed flag (a read path never hard-blocks).
    const hz = await detectHazards(page)
    // R5a: empty-DOM advisory on the snapshot path too (a snapshot of a blank
    // shell tells the host to reload rather than parse an empty tree).
    const empty = await detectEmptyPage(page)
    return ok(presentPageText(obsv.output, flags), hazardWarning(hz, fp.page_changed, empty))
  })
}

function warnIf(pageChanged: boolean): string | undefined {
  return pageChanged ? 'the page changed during this command; refs may be stale' : undefined
}

// ---------------------------------------------------------------------------
// R2/R3: keyless CAPTCHA + auth-wall DETECTION. `captcha_detected` and
// `auth_required` are declared in errors.ts but were never emitted — this closes
// two visible reliability holes. Detection is a cheap in-page heuristic (no model
// call): known CAPTCHA iframe hosts / container classes / "I'm not a robot"
// signals; and a login form + login-ish URL/title for the auth wall. The codes
// are surfaced as advisory warnings (read-only paths never hard-block), so the
// host stops and escalates (CAPTCHA = hand back, never solve; auth = load a saved
// state/cookies or use a profile) instead of burning retries.
// ---------------------------------------------------------------------------

type Hazards = { captcha: boolean; auth: boolean }

/** In-page detector (constant script — no interpolation of any host/page value). */
const HAZARD_DETECT_JS = `(function(){
  var captcha=false, auth=false;
  try {
    var ifr=document.getElementsByTagName('iframe');
    for (var i=0;i<ifr.length;i++){
      var src=(ifr[i].getAttribute('src')||'').toLowerCase();
      if (/recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha|geetest|captcha-delivery/.test(src)){captcha=true;break;}
    }
    if (!captcha && document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],#px-captcha')) captcha=true;
    if (!captcha){
      var body=document.body?String(document.body.innerText||''):'';
      if (/i'?m not a robot|i am not a robot|verify you are human|please complete the (security|captcha)/i.test(body)) captcha=true;
    }
    var pw=document.querySelector('input[type=password]');
    var u=String(location.href||'').toLowerCase();
    var t=String(document.title||'').toLowerCase();
    var loginSignal=/(\\/login|\\/signin|\\/sign-in|\\/sso|\\/auth\\b|\\/oauth|accounts\\.|login\\?|signin\\?)/.test(u)
      || /(log ?in|sign ?in|sign ?on|authenticate)/.test(t);
    if (pw && loginSignal) auth=true;
  } catch(e){}
  return {captcha:captcha, auth:auth};
})()`

/** Run the CAPTCHA/auth-wall heuristic on the current page. Best-effort — a
 * detector failure never fails the command (returns "nothing detected"). */
async function detectHazards(page: Page): Promise<Hazards> {
  try {
    const r = (await page.evaluate(HAZARD_DETECT_JS)) as Hazards
    return { captcha: Boolean(r?.captcha), auth: Boolean(r?.auth) }
  } catch {
    return { captcha: false, auth: false }
  }
}

/** Compose the advisory warning for a read/nav path from detected hazards +
 * the page-changed flag. `captcha_detected` / `auth_required` code tokens are
 * embedded so the host can branch on them; messages come from the ERRORS table. */
function hazardWarning(hz: Hazards, pageChanged = false, empty = false): string | undefined {
  const parts: string[] = []
  if (hz.captcha) parts.push(`captcha_detected: ${ERRORS.captcha_detected.message}`)
  if (hz.auth) parts.push(`auth_required: ${ERRORS.auth_required.message}`)
  // R5a: page_empty advisory (blank shell / interstitial / unrendered bundle).
  if (empty) parts.push(`page_empty: ${ERRORS.page_empty.message}`)
  const pc = warnIf(pageChanged)
  if (pc) parts.push(pc)
  return parts.length > 0 ? parts.join(' | ') : undefined
}

async function handleRead(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[0]
  if (url) {
    // D6: when a LIVE session exists, attach that session's cookies for the
    // target origin to the fetch so `read` can hit authenticated site pages/APIs
    // cheaply (order-of-magnitude cheaper than snapshot+click). Still egress-
    // guarded per-hop + neutralized; the cookie only rides same-origin hops.
    const cookieHeader = await sessionCookieHeader(flags, url)
    const fetched = await fetchGuarded(url, flags, cookieHeader)
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
  cookieHeader?: string | null,
): Promise<{ ok: true; res: Response } | { ok: false; code: 'navigation_blocked' }> {
  const MAX_HOPS = 10
  const opts = { allowFile: flags.allowFileAccess, allowedDomains: flags.allowedDomains }
  const signal = flags.timeout ? AbortSignal.timeout(flags.timeout) : undefined
  const targetOrigin = safeOrigin(url)
  let current = url
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // Resolved guard per hop (C1 + P1-SEC5): a redirect Location that lexically
    // looks benign but RESOLVES to a private/metadata address is denied here.
    if (!(await assertNavigableResolved(current, opts)).ok) {
      return { ok: false, code: 'navigation_blocked' }
    }
    // D6: only send the session cookie on hops whose origin matches the ORIGINAL
    // target — a cross-origin redirect must never leak the jar to another host.
    const headers =
      cookieHeader && safeOrigin(current) === targetOrigin ? { Cookie: cookieHeader } : undefined
    // E4: retry a transient fetch failure (503/reset/timeout) under bounded backoff
    // before surfacing it. A fatal error (bad URL, DNS-not-found) is rethrown
    // immediately; exhausting the hard cap throws `retries_exhausted` which the
    // hub's mapThrow surfaces as the loud, distinct code (never a silent loop).
    const res = await withRetries(
      () =>
        fetch(current, {
          redirect: 'manual',
          ...(headers ? { headers } : {}),
          ...(signal ? { signal } : {}),
        }),
      { transient: { maxRetries: 2 }, rateLimit: { maxRetries: 2 } },
    )
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

/**
 * D6: the `Cookie:` header value for `url` drawn from a LIVE session's browser
 * context cookies, or null when no live session exists (keeps `read` browser-free
 * in that case) / the origin has no cookies. Best-effort — never throws, never
 * spawns a browser (a dead/absent session returns null before any connect).
 */
async function sessionCookieHeader(flags: ParsedFlags, url: string): Promise<string | null> {
  const info = await readSidecar(flags.session).catch(() => null)
  if (!info) return null
  const live = info.external === true || isPidAlive(info.pid)
  if (!live) return null
  try {
    return await withConnection(flags, async ({ context }) => {
      const cookies = await context.cookies(url)
      if (!cookies || cookies.length === 0) return null
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    })
  } catch {
    return null
  }
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

  // B1 coordinate fallback: `click --at x y`, `type --at x y <text>`,
  // `drag --from x y --to x y`. Bypasses groundRef/toLocator entirely for canvas
  // widgets / custom controls with no AX node. Already behind --enable-actions
  // (click/type/drag are actor-registry verbs), so no extra grant gate is needed.
  if ((verb === 'click' || verb === 'type') && flags.at) return handleCoordAct(flags, verb)
  if (verb === 'drag' && flags.from && flags.to) return handleCoordAct(flags, verb)

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

  // S5: the action-policy hard gate, consulted BEFORE the destructive-name check.
  // Precedence deny > confirm > allow > default: a `deny` is a TERMINAL hard stop a
  // confirmation can never override (fail hard); a `confirm` routes into the
  // existing confirm gate below even for a non-paid-looking control; an `allow`
  // (or no policy) proceeds. loadPolicy throws a fixed, path-free message on a bad
  // file — the hub's mapThrow surfaces it sanitized (a security file must fail LOUD).
  let policyConfirm = false
  if (flags.actionPolicy) {
    const policy = loadPolicy(flags.actionPolicy)
    // F3-policy: thread the current page host into the decision so `@host`-scoped
    // patterns (e.g. `download@*.corp.example`) actually match. Without ctx they
    // silently failed open. The url comes from the last fingerprint (no browser
    // round-trip); absent → host-scoped patterns simply don't match (as before).
    const url = await lastKnownUrl(flags.session)
    const decision = decideAction(policy, verb, url ? { url } : {})
    if (decision === 'deny') return fail('not_permitted')
    if (decision === 'confirm') policyConfirm = true
  }

  const refmap = await loadRefMap(flags.session)
  if (!refmap) return fail('element_not_found')

  // Narrowed paid/destructive confirm gate (fix P0-4). Runs AFTER grounding, so
  // a hallucinated @e999 still fails the grounding gate FIRST (trifecta test 2b).
  // Only click/press-like activations of a control whose accessible name looks
  // paid/destructive (Buy/Pay/Delete/…) are gated, and only on a NON-TTY session
  // that did not pre-approve the verb via --confirm-actions. Plain clicks/fills
  // on non-matching names stay ungated (the smoke evals' buttons are unaffected).
  // A policy `confirm` decision forces this gate for ANY verb (not just the
  // click/press activations the paid/destructive heuristic covers); a
  // CONFIRM_GATED_VERB additionally trips it when its accessible name looks
  // paid/destructive. Either trigger routes into the same confirm flow below.
  if (policyConfirm || CONFIRM_GATED_VERBS.has(verb)) {
    const g = groundRef(refmap, ref)
    if (!g.ok) return fail(g.code)
    const gateHit =
      policyConfirm ||
      (CONFIRM_GATED_VERBS.has(verb) && destructivePaidBlocks(g.entry.name, flags, verb))
    if (gateHit) {
      // S4: with `--two-phase-confirm`, DON'T hard-deny — persist the pending
      // action and hand back a `requires_confirmation` id the host resolves with
      // a separate `silver confirm <id>` / `deny <id>`. This lets an automated
      // loop approve in-band without pre-listing every verb by name.
      if (flags.twoPhaseConfirm) return requireConfirmation(flags, g.entry, verb)
      // E2: attach a structured PREVIEW to the gated envelope — the target's
      // accessible name + the form-field values about to submit + any extracted
      // amount — so the human/host approves a concrete action, not "buy
      // something". Keyless: built from the grounded refmap by a sibling's
      // buildConfirmPreview. The error string stays fixed (no-leak invariant).
      return confirmRequiredWithPreview(g.entry, refmap, verb)
    }
  }

  // Value: positional arg, or stdin for large/unsafe payloads.
  let value = flags.args[1]
  if (flags.stdin) value = await readStdin()

  // F5: data-provenance (taint) guard, OPT-IN via `--taint-guard`. If the value
  // still carries the ⟦untrusted⟧ page-content fence, the host almost certainly
  // pasted fenced page output straight back into a mutating verb — an
  // inject-and-act / exfil vector. Reject with a clear advisory (no page content
  // echoed). When the flag is off, taintGuardCheck never flags (proceeds).
  if (value !== undefined) {
    const taint = taintGuardCheck({ verb, value, enabled: flags.taintGuard })
    if (taint.flagged) return { success: false, data: null, error: taint.reason ?? '' }
  }

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
      // E1/D2: hand the write-path the secret registry so a fill/type value's
      // `<secret>`/`<totp>` token resolves at the actions.ts choke point.
      opts.secrets = currentSecrets()
      if (verb === 'select') opts.selectValues = flags.args.slice(1)
      if (verb === 'upload') opts.files = uploadFiles ?? []
      if (verb === 'drag') opts.targetRef = flags.args[1]

      const env = await act(page, cdp, verb, ref, value, refmap, opts)

      // Stamp the page-change contract onto every action response (spec §6).
      const prev = await loadState(flags.session)
      const fp = await settleAndFingerprint(
        page,
        prev?.fingerprint,
        refmap.generation,
        settleModeFor(flags),
      )
      await patchState(flags.session, { fingerprint: fp.fingerprint })

      if (!env.success) return env

      // R4: bump the refmap generation when the act STRUCTURALLY changed the page
      // (URL or DOM-node-count changed — a focus-only fingerprint shift does NOT
      // invalidate refs and must not bump). Bumping map.generation WITHOUT
      // re-minting entries makes every existing ref's generation differ from the
      // map's, so the NEXT stale ref hard-fails `ref_stale` instead of silently
      // misclicking a re-rendered tree. Keyless: one integer bump + sidecar write.
      const struct = structuralChange(prev?.fingerprint, fp.fingerprint)
      await bumpGenerationOnPageChange(flags.session, struct)

      // R5b: record this (verb, ref, fingerprint) in the action ring and flag a
      // stuck no-progress loop (K identical acts, unchanged fingerprint) as an
      // ADVISORY `repetition_detected` — never blocking the action itself.
      await noteAction(flags.session, { verb, ref, fingerprint: fp.fingerprint })
      const repeating = await isRepeating(flags.session)

      return ok(
        {
          ...env.data,
          page_changed: fp.page_changed,
          stale_refs: fp.stale_refs,
          generation: refmap.generation,
          ...(repeating ? { repetition_detected: true } : {}),
        },
        repeating ? `repetition_detected: ${ERRORS.repetition_detected.message}` : undefined,
      )
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
}

/**
 * R4 helper: did the act STRUCTURALLY change the page — a URL change or a
 * DOM-node-count change — as opposed to a mere focus shift? The page fingerprint
 * is `url|focusedBackendId|domNodeCount`; a focus-only change (index 1) does not
 * invalidate the current refmap, so it must NOT trigger a generation bump (else a
 * `focus @eN` followed by `get value @eN` would spuriously fail ref_stale). A
 * missing previous fingerprint means "no basis" → not a structural change.
 */
function structuralChange(prev: string | null | undefined, cur: string): boolean {
  if (!prev) return false
  const p = prev.split('|')
  const c = cur.split('|')
  // Compare url (index 0) and domNodeCount (last index); ignore focus (index 1).
  return p[0] !== c[0] || p[p.length - 1] !== c[c.length - 1]
}

/**
 * E2: build the `confirm_required` failure envelope, attaching a structured
 * preview under `data.preview` when the sibling's `buildConfirmPreview` is
 * present. The error message is the fixed taxonomy string (no-leak). Falls back
 * to a bare `fail('confirm_required')` if the preview builder is absent/throws.
 */
async function confirmRequiredWithPreview(
  target: RefEntry,
  refmap: RefMap,
  verb: string,
): Promise<Envelope<unknown>> {
  const base = fail('confirm_required')
  const build = confirmPreview.buildConfirmPreview
  if (!build) return base
  try {
    const preview = await Promise.resolve(build({ name: target.name }))
    if (preview == null) return base
    return { success: false, data: { preview }, error: base.error }
  } catch {
    return base
  }
}

/**
 * S4: build the `requires_confirmation` envelope for the two-phase gate. Persists
 * the pending action (verb + args + preview) under a fresh id with a TTL, and
 * returns `{status:"requires_confirmation", confirmation_id, preview}`. The host
 * proceeds with `silver confirm <id>` or aborts with `silver deny <id>`. The
 * error string is a fixed instruction (no id / no page content interpolated —
 * the id/preview live in `data`, upholding the no-leak invariant on `error`).
 */
async function requireConfirmation(
  flags: ParsedFlags,
  target: RefEntry,
  verb: string,
): Promise<Envelope<unknown>> {
  let preview: unknown = null
  const build = confirmPreview.buildConfirmPreview
  if (build) {
    try {
      preview = (await Promise.resolve(build({ name: target.name }))) ?? null
    } catch {
      preview = null
    }
  }
  const id = newConfirmId()
  try {
    const pending = await loadPending(flags.session)
    pending[id] = {
      id,
      verb,
      args: flags.args,
      preview,
      createdAt: new Date().toISOString(),
      ttlMs: CONFIRM_TTL_MS,
    }
    await savePending(flags.session, pending)
  } catch {
    // If we cannot persist the pending action, fall back to the hard deny so we
    // never hand back an id the host can't resolve.
    return fail('confirm_required')
  }
  return {
    success: false,
    data: { status: 'requires_confirmation', confirmation_id: id, preview },
    error:
      'this looks like a paid/destructive action; run `silver confirm <id>` to proceed or `silver deny <id>` to abort',
  }
}

/**
 * `silver confirm <id>` (S4): resolve a pending two-phase confirmation by
 * RE-RUNNING the original actor verb, this time pre-approved (so the gate lets
 * it through). One-shot: the pending record is removed before execution. The
 * command itself executes an action, so it requires `--enable-actions` (gated
 * in-handler, mirroring `wait --fn`).
 */
async function handleConfirm(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = flags.args[0]
  if (!id) return badRequest('usage: silver confirm <confirmation-id>')
  if (!flags.enableActions) return fail('not_permitted')

  const pending = await loadPending(flags.session)
  const rec = pending[id]
  if (!rec) {
    return badRequest(
      'no such pending confirmation (it may have expired or already been resolved); re-run the original command',
    )
  }
  // One-shot: drop it BEFORE executing so a retry can never double-fire the action.
  delete pending[id]
  await savePending(flags.session, pending)

  // Rebuild the original command's flags, pre-approving the verb by name so the
  // paid/destructive gate (and the confirm-actions gate) both let it through.
  const reFlags: ParsedFlags = {
    ...flags,
    verb: rec.verb,
    args: rec.args,
    enableActions: true,
    twoPhaseConfirm: false,
    confirmActionsProvided: true,
    confirmActions: Array.from(new Set([...flags.confirmActions, rec.verb])),
  }
  const env = await handleAct(reFlags)
  if (!env.success) return env
  // Tag the successful envelope so the host can tie it back to the confirmation.
  const data = (env.data ?? {}) as Record<string, unknown>
  return ok({ ...data, confirmed: id })
}

/**
 * `silver deny <id>` (S4): abort a pending two-phase confirmation without ever
 * executing the action. Idempotent — denying an unknown/expired id still
 * succeeds (the action is, correctly, not performed).
 */
async function handleDeny(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const id = flags.args[0]
  if (!id) return badRequest('usage: silver deny <confirmation-id>')
  const pending = await loadPending(flags.session)
  const existed = Object.prototype.hasOwnProperty.call(pending, id)
  if (existed) {
    delete pending[id]
    await savePending(flags.session, pending)
  }
  return ok({ denied: true, confirmation_id: id, existed })
}

// B1 coordinate actuation: prefer the sibling's actions.ts impls; fall back to
// the raw page.mouse/page.keyboard calls (identical behavior) so the feature
// works before the sibling's export lands. The sibling impls, once merged, take
// over via the CoordActions lookup above.
async function coordClick(page: Page, x: number, y: number): Promise<void> {
  if (coordActions.coordClick) return void (await coordActions.coordClick(page, x, y))
  await page.mouse.click(x, y)
}
async function coordType(page: Page, x: number, y: number, text: string): Promise<void> {
  if (coordActions.coordType) return void (await coordActions.coordType(page, x, y, text))
  await page.mouse.click(x, y)
  await page.keyboard.type(text)
}
async function coordDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  if (coordActions.coordDrag) return void (await coordActions.coordDrag(page, from.x, from.y, to.x, to.y))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

/**
 * B1 coordinate-verb handler. Runs the raw pointer/keyboard action at page
 * coordinates and stamps the same page-change contract as a grounded act. A
 * coordinate `click` still runs the paid/destructive hit-test gate (parity with
 * `mouse click`) so it cannot bypass the confirm gate a grounded click enforces.
 */
async function handleCoordAct(
  flags: ParsedFlags,
  verb: 'click' | 'type' | 'drag',
): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    let data: Record<string, unknown>
    if (verb === 'click') {
      const [x, y] = flags.at as [number, number]
      const hitName = await elementNameAtPoint(page, x, y)
      if (destructivePaidBlocks(hitName, flags, 'click')) return fail('confirm_required')
      await coordClick(page, x, y)
      data = { clicked: { x, y } }
    } else if (verb === 'type') {
      const [x, y] = flags.at as [number, number]
      const raw = flags.stdin ? await readStdin() : (flags.args[0] ?? '')
      // F5: opt-in taint guard parity with the grounded write-path.
      const taint = taintGuardCheck({ verb: 'type', value: raw, enabled: flags.taintGuard })
      if (taint.flagged) return { success: false, data: null, error: taint.reason ?? '' }
      // E1/D2: resolve `<secret>`/`<totp>` tokens fail-closed before typing.
      const r = resolveWriteValue(raw, page.url(), currentSecrets())
      if (r.refused) return fail('not_permitted')
      await coordType(page, x, y, r.value)
      // Never echo the typed text (it may be a secret) — report only the length
      // of the ORIGINAL token (not the resolved secret, to avoid a length leak).
      data = { typed: raw.length, at: { x, y } }
    } else {
      const [fx, fy] = flags.from as [number, number]
      const [tx, ty] = flags.to as [number, number]
      await coordDrag(page, { x: fx, y: fy }, { x: tx, y: ty })
      data = { dragged: { from: { x: fx, y: fy }, to: { x: tx, y: ty } } }
    }
    // Stamp the page-change contract (mutating action) as grounded acts do.
    const prev = await loadState(flags.session)
    const fp = await settleAndFingerprint(
      page,
      prev?.fingerprint,
      prev?.generation ?? 0,
      settleModeFor(flags),
    )
    await patchState(flags.session, { fingerprint: fp.fingerprint })
    return ok({ ...data, page_changed: fp.page_changed, stale_refs: fp.stale_refs })
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
    // E1/D2: thread the secret registry so a `find … fill "<secret>PW</secret>"`
    // subaction resolves the token at the actions.ts write-path choke point.
    opts.secrets = currentSecrets()

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
// expect (AC1) — the marquee trust primitive. A deterministic, READ-ONLY
// assertion that collapses "did it actually work?" into ONE call, so the host
// verifies the GOAL, not just a bare success:true.
//
//   silver expect <ref|selector> visible|hidden|enabled|checked
//   silver expect <ref|selector> text-contains <value>
//   silver expect <ref|selector> value-equals <value>
//   silver expect <selector>     count <n>
//   silver expect url-matches <glob|substring>
//   silver expect title-contains <value>
//
// Returns success:true ONLY when the assertion holds; otherwise a failure
// envelope carrying {matched:false, matcher, expected, observed} so the host
// sees actual-vs-expected. Keyless: Playwright state reads + string compares.
// ---------------------------------------------------------------------------

/** Matchers that assert on the PAGE (no ref/selector target). */
const PAGE_MATCHERS: ReadonlySet<string> = new Set(['url-matches', 'title-contains'])
/** Matchers that assert on a resolved ELEMENT. */
const ELEMENT_MATCHERS: ReadonlySet<string> = new Set([
  'visible',
  'hidden',
  'enabled',
  'checked',
  'text-contains',
  'value-equals',
])
const EXPECT_USAGE =
  'usage: silver expect <ref|selector> <visible|hidden|enabled|checked|text-contains|value-equals|count> [value]  |  silver expect <url-matches|title-contains> <value>'

/** Simple glob/substring URL match: `*` is a wildcard; otherwise a substring test. */
function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern)
  const rx = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  return rx.test(url)
}

/** Build the assertion result envelope: ok when matched, else a failure with the
 * actual-vs-expected in `data` (never in `error`, which stays a fixed string). */
function assertionResult(
  matched: boolean,
  matcher: string,
  expected: string | null,
  observed: string,
): Envelope<unknown> {
  const data = { matched, matcher, expected, observed }
  if (matched) return ok(data)
  return { success: false, data, error: `assertion failed: ${matcher}` }
}

async function handleExpect(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const a = flags.args
  let target: string | undefined
  let matcher: string | undefined
  let value: string | undefined
  if (a[0] !== undefined && PAGE_MATCHERS.has(a[0])) {
    matcher = a[0]
    value = a[1]
  } else {
    target = a[0]
    matcher = a[1]
    value = a[2]
  }
  if (!matcher || (!PAGE_MATCHERS.has(matcher) && !ELEMENT_MATCHERS.has(matcher) && matcher !== 'count')) {
    return badRequest(EXPECT_USAGE)
  }
  if ((matcher === 'text-contains' || matcher === 'value-equals') && value === undefined) {
    return badRequest(`the "${matcher}" matcher requires a value: silver expect <ref|selector> ${matcher} <value>`)
  }
  if (matcher === 'count' && (value === undefined || !/^\d+$/.test(value))) {
    return badRequest('the "count" matcher requires a non-negative integer: silver expect <selector> count <n>')
  }
  if (PAGE_MATCHERS.has(matcher) && value === undefined) {
    return badRequest(`the "${matcher}" matcher requires a value: silver expect ${matcher} <value>`)
  }
  if (!PAGE_MATCHERS.has(matcher) && !target) {
    return badRequest('a ref or selector is required: ' + EXPECT_USAGE)
  }

  return withConnection(flags, async ({ page }) => {
    // Page-level matchers first (no element to resolve).
    if (matcher === 'url-matches') {
      const url = page.url()
      return assertionResult(urlMatches(url, value as string), matcher, value as string, presentPageText(url, flags))
    }
    if (matcher === 'title-contains') {
      const title = await page.title().catch(() => '')
      return assertionResult(
        title.includes(value as string),
        matcher,
        value as string,
        presentPageText(title, flags),
      )
    }
    if (matcher === 'count') {
      // Scope to the active frame (set via `frame <sel>`), else the main frame.
      const frame = await resolveActiveFrame(page, flags.session)
      const n = await frame.locator(target as string).count()
      return assertionResult(n === Number(value), matcher, value as string, String(n))
    }

    // Element matchers: resolve `target` (a grounded @ref, or a CSS selector).
    let cdp: CDPSession | null = null
    try {
      let loc: Locator
      if (parseRef(target as string)) {
        const refmap = await loadRefMap(flags.session)
        if (!refmap) return fail('element_not_found')
        const g = groundRef(refmap, target as string)
        if (!g.ok) return fail(g.code)
        cdp = await page.context().newCDPSession(page)
        loc = await toLocator(page, cdp, g.entry, g.ref)
      } else {
        const frame = await resolveActiveFrame(page, flags.session)
        loc = frame.locator(target as string).first()
      }
      const timeout = flags.timeout ?? 1500
      switch (matcher) {
        case 'visible': {
          const v = await loc.isVisible().catch(() => false)
          return assertionResult(v, matcher, 'true', String(v))
        }
        case 'hidden': {
          const v = await loc.isHidden().catch(() => true)
          return assertionResult(v, matcher, 'true', String(v))
        }
        case 'enabled': {
          const v = await loc.isEnabled({ timeout }).catch(() => false)
          return assertionResult(v, matcher, 'true', String(v))
        }
        case 'checked': {
          const v = await loc.isChecked({ timeout }).catch(() => false)
          return assertionResult(v, matcher, 'true', String(v))
        }
        case 'text-contains': {
          const t = (await loc.textContent({ timeout }).catch(() => null)) ?? ''
          return assertionResult(
            t.includes(value as string),
            matcher,
            value as string,
            presentPageText(t, flags),
          )
        }
        case 'value-equals': {
          const v = await loc.inputValue({ timeout }).catch(() => null)
          return assertionResult(
            v === value,
            matcher,
            value as string,
            v === null ? '(no value)' : presentPageText(v, flags),
          )
        }
        default:
          return badRequest(EXPECT_USAGE)
      }
    } finally {
      await cleanupStamp(page).catch(() => {})
      if (cdp) await cdp.detach().catch(() => {})
    }
  })
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

/**
 * K4: structured doctor check. Each carries a status, a host-facing message, and
 * (on failure) a concrete REMEDIATION COMMAND — the host gets a next step instead
 * of a bare boolean to guess at. `fix` is a fixed, path-free string (errors.ts
 * no-leak style); `details` is an optional sanitized count/label, never a path.
 */
type DoctorStatus = 'pass' | 'fail' | 'warn' | 'skip'
type DoctorCheck = {
  name: string
  status: DoctorStatus
  message: string
  fix?: string
  details?: string
}

/**
 * K4: structured doctor report — `{checks:[{name,status,message,fix,details}],
 * verdict, next, passed, total}`. Probes: playwright import, a PRESENT Chromium
 * executable, a REAL headless launch (the completeness proof `existsSync` misses),
 * ~/.silver writability, session-lock staleness, and CDP-reachability of any live
 * session. Each failing check ships a remediation command so a host self-repairs.
 */
async function handleDoctor(): Promise<Envelope<unknown>> {
  const checks: DoctorCheck[] = []

  // 1. playwright module import + 2. a PRESENT Chromium executable.
  let chromiumType: typeof import('playwright').chromium | null = null
  let chromiumPresent = false
  try {
    const { chromium } = await import('playwright')
    chromiumType = chromium
    checks.push({ name: 'playwright', status: 'pass', message: 'playwright module loads' })
    const exec = chromium.executablePath()
    chromiumPresent = Boolean(exec) && existsSync(exec)
    checks.push(
      chromiumPresent
        ? { name: 'chromium', status: 'pass', message: 'the Chromium executable is present' }
        : {
            name: 'chromium',
            status: 'fail',
            message: 'the Chromium browser is not installed',
            fix: 'npx playwright install chromium',
          },
    )
  } catch {
    checks.push({
      name: 'playwright',
      status: 'fail',
      message: 'the playwright dependency could not be loaded',
      fix: 'npm install',
    })
    checks.push({
      name: 'chromium',
      status: 'fail',
      message: 'cannot check for Chromium — playwright did not load',
      fix: 'npm install',
    })
  }

  // 3. A REAL headless launch + 1x1 screenshot + close (the completeness probe:
  // `existsSync(exec)` reads present on a broken sandbox / partial install / missing
  // shared lib — the #1 CI failure — but actually driving the browser catches it).
  if (chromiumPresent && chromiumType) {
    let browser: import('playwright').Browser | null = null
    try {
      browser = await chromiumType.launch({ headless: true, timeout: 60_000 })
      const page = await browser.newPage()
      await page.setViewportSize({ width: 1, height: 1 })
      await page.screenshot()
      checks.push({
        name: 'browser_launch',
        status: 'pass',
        message: 'a headless Chromium launched and rendered a screenshot',
      })
    } catch {
      checks.push({
        name: 'browser_launch',
        status: 'fail',
        message: 'the Chromium executable is present but a headless launch failed (partial install or missing system libraries)',
        fix: 'npx playwright install --with-deps chromium',
      })
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  } else {
    checks.push({
      name: 'browser_launch',
      status: 'skip',
      message: 'skipped the launch probe — Chromium is not installed',
      fix: 'npx playwright install chromium',
    })
  }

  // 4. ~/.silver writability.
  try {
    const root = path.join(os.homedir(), '.silver')
    await fs.mkdir(root, { recursive: true })
    const probe = path.join(root, `.doctor-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.rm(probe, { force: true })
    checks.push({ name: 'uab_writable', status: 'pass', message: 'the ~/.silver state dir is writable' })
  } catch {
    checks.push({
      name: 'uab_writable',
      status: 'fail',
      message: 'the ~/.silver state dir is not writable (permissions or disk space)',
      fix: 'chmod u+rwx ~/.silver  # or free disk space',
    })
  }

  // 5. Session-lock staleness: a `.lock` whose holder pid is dead is a leftover
  // from a crashed command; it will be auto-stolen on next use, but surface it.
  checks.push(await doctorSessionLocks())

  // 6. CDP-reachability of any live session (a running/attached browser we can
  // actually connect to). No live session → skip (nothing to probe).
  checks.push(await doctorCdpReachable())

  const passed = checks.filter((c) => c.status === 'pass').length
  const total = checks.length
  const firstFail = checks.find((c) => c.status === 'fail')
  const verdict: 'ok' | 'issues' = firstFail ? 'issues' : 'ok'
  const next = firstFail
    ? firstFail.fix ?? firstFail.message
    : 'all checks passed — silver is ready'

  return ok({ checks, verdict, next, passed, total })
}

/** K4 check: scan session `.lock` files for a dead-holder (stale) lock. */
async function doctorSessionLocks(): Promise<DoctorCheck> {
  let stale = 0
  let scanned = 0
  try {
    for (const name of await listSessionNames()) {
      scanned++
      let rec: { pid?: unknown } | null = null
      try {
        rec = JSON.parse(readFileSync(path.join(sessionDir(name), '.lock'), 'utf8'))
      } catch {
        continue // no lock (the common case) or unreadable — not counted stale
      }
      if (typeof rec?.pid === 'number' && !isPidAlive(rec.pid)) stale++
    }
  } catch {
    return { name: 'session_locks', status: 'warn', message: 'could not enumerate sessions' }
  }
  if (stale === 0) {
    return {
      name: 'session_locks',
      status: 'pass',
      message: 'no stale session locks',
      details: `${scanned} session(s) scanned`,
    }
  }
  return {
    name: 'session_locks',
    status: 'warn',
    message: 'stale session lock(s) from a crashed command (auto-stolen on next use)',
    fix: 'silver close --all  # or remove the affected session',
    details: `${stale} stale of ${scanned}`,
  }
}

/** K4 check: can we actually attach over CDP to a live session? */
async function doctorCdpReachable(): Promise<DoctorCheck> {
  let target: string | null = null
  try {
    for (const name of await listSessionNames()) {
      const info = await readSidecar(name).catch(() => null)
      if (info && (info.external === true || isPidAlive(info.pid))) {
        target = name
        break
      }
    }
  } catch {
    /* fall through to skip */
  }
  if (!target) {
    return {
      name: 'cdp_reachable',
      status: 'skip',
      message: 'no live session to probe — start one with `silver open <url>`',
    }
  }
  try {
    const conn = await connect(target)
    await conn.browser.close().catch(() => {})
    return { name: 'cdp_reachable', status: 'pass', message: 'a live session is reachable over CDP' }
  } catch {
    return {
      name: 'cdp_reachable',
      status: 'fail',
      message: 'a session is marked live but its CDP endpoint is unreachable (the browser may have died)',
      fix: 'silver close --all  # then re-open',
    }
  }
}

function handleSkill(flags: ParsedFlags): Envelope<unknown> {
  // K1: `skills resolve --url <url> [--message <text>]` runs the keyless skill
  // auto-injection matcher (Aside hat/gat scorers) over the on-disk skill
  // descriptors: non-site-specific skills are always on; site-specific ones stay
  // hidden until a URL-glob or keyword match fires. Intercepted first so `resolve`
  // is never mistaken for a reference name. Pure string/regex math — no page state.
  if (flags.args[0] === 'resolve') return handleSkillResolve(flags)
  // `skill install [target-dir]` drops the on-disk skill payload into a project
  // (so `npx github:LeventySeven/silver skill install` works). Intercepted BEFORE
  // the `<ref>` catalog path so `install` is never mistaken for a reference name.
  if (flags.args[0] === 'install') return handleSkillInstall(flags)

  // G5: reference-topic catalog served from skill-data/core/reference/<ref>.md
  // (the SKILL sibling authors those files). `skill --list` / `skill list`
  // enumerates the topics; `skill <ref>` serves one. Keyless, readFileSync-served.
  const refDir = path.join(PACKAGE_ROOT, 'skill-data', 'core', 'reference')
  if (flags.list || flags.args[0] === 'list') {
    let references: string[] = []
    try {
      references = readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .sort()
    } catch {
      references = []
    }
    return ok({ references })
  }
  const ref = flags.args[0]
  if (ref !== undefined) {
    // Slug validation blocks path traversal (no `/`, `\`, or leading `..`): the
    // charset excludes separators, so `<ref>.md` can only name a file in refDir.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)) {
      return badRequest('invalid skill reference name (letters, digits, . _ - only)')
    }
    try {
      return ok(readFileSync(path.join(refDir, `${ref}.md`), 'utf8'))
    } catch {
      return badRequest('no such skill reference; run `silver skill --list` to see topics')
    }
  }

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

// ---------------------------------------------------------------------------
// K1: skill auto-injection resolution. Load the on-disk skill descriptors (each
// SKILL/reference `.md`, its optional flat frontmatter block parsed for
// siteSpecific / keywords / urls) and hand them to the keyless resolveSkills
// matcher. A skill with no frontmatter is non-site-specific (always on).
// ---------------------------------------------------------------------------

/** Parse a leading `---\n…\n---` frontmatter block into a flat key→value map. */
function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!m) return { fm: {}, body: md }
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key.length > 0) fm[key.toLowerCase()] = val
  }
  return { fm, body: md.slice(m[0].length) }
}

/** Split a comma/whitespace flat list value (`a, b c`) into trimmed tokens. */
function splitListValue(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0)
}

/** First meaningful line of a skill body, for a short description. */
function firstDescription(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
    if (t.length > 0) return t.length > 160 ? t.slice(0, 157) + '…' : t
  }
  return undefined
}

/** Load skill descriptors from the on-disk skill payload (core SKILL + references). */
function loadSkillDescriptors(): Skill[] {
  const coreDir = path.join(PACKAGE_ROOT, 'skill-data', 'core')
  const files: { name: string; rel: string }[] = [{ name: 'core', rel: 'SKILL.md' }]
  try {
    for (const f of readdirSync(path.join(coreDir, 'reference')).sort()) {
      if (f.endsWith('.md')) files.push({ name: f.slice(0, -3), rel: path.join('reference', f) })
    }
  } catch {
    /* no reference dir in this build — just the core SKILL */
  }
  const skills: Skill[] = []
  for (const { name, rel } of files) {
    let raw: string
    try {
      raw = readFileSync(path.join(coreDir, rel), 'utf8')
    } catch {
      continue
    }
    const { fm, body } = parseFrontmatter(raw)
    const urls = splitListValue(fm.urls ?? fm.url)
    const keywords = splitListValue(fm.keywords)
    const siteSpecific = /^(1|true|yes|on)$/i.test((fm.sitespecific ?? '').trim())
    const skill: Skill = { name, path: rel }
    const description = firstDescription(body)
    if (description) skill.description = description
    if (siteSpecific) skill.siteSpecific = true
    if (urls.length > 0 || keywords.length > 0) {
      const autoInject: Skill['autoInject'] = {}
      if (urls.length > 0) autoInject.url = urls
      if (keywords.length > 0) autoInject.keywords = keywords
      skill.autoInject = autoInject
    }
    skills.push(skill)
  }
  return skills
}

/** K1 handler: score the loaded skills against `--url` / `--message` and return
 * the applicable ones (always-on + URL/keyword matches), most-specific first. */
function handleSkillResolve(flags: ParsedFlags): Envelope<unknown> {
  const url = flags.url ?? ''
  const message = flags.message ?? ''
  const skills = loadSkillDescriptors()
  const matches = resolveSkills(url, message, skills).map((m) => ({
    name: m.skill.name,
    score: m.score,
    reason: m.reason,
    ...(m.skill.description ? { description: m.skill.description } : {}),
    ...(m.skill.path ? { path: m.skill.path } : {}),
  }))
  return ok({ url: url || null, matched: matches.length, matches })
}

/**
 * Relative paths (under PACKAGE_ROOT) of the skill payload `skill install`
 * copies: the SKILL.md discovery stub, the core guide + its `reference/*.md` +
 * `examples.md`, and `commands/*.md`. Only paths that actually exist in this
 * build are returned (a bundle that ships without one directory just skips it).
 */
function collectSkillSources(): string[] {
  const rels = ['SKILL.md', 'skill-data/core/SKILL.md', 'skill-data/core/examples.md']
  for (const dir of ['skill-data/core/reference', 'commands']) {
    try {
      for (const f of readdirSync(path.join(PACKAGE_ROOT, dir)).sort()) {
        if (f.endsWith('.md')) rels.push(`${dir}/${f}`)
      }
    } catch {
      /* directory absent in this build — skip it */
    }
  }
  return rels.filter((r) => existsSync(path.join(PACKAGE_ROOT, r)))
}

/**
 * `silver skill install [target-dir]` — copy the on-disk skill payload into
 * `<target-dir>/silver/` so a user can drop the skill into a project with a
 * single `npx github:LeventySeven/silver skill install`.
 *
 * Target resolution: an explicit positional wins; otherwise default to
 * `./.claude/skills` when that dir already exists, else the cwd. Every file lands
 * under `<target>/silver/`, and EACH destination is re-checked with
 * `assertContainedPath` against that install root — so a bundled relative path
 * can never traverse outside the target (path-containment, defense-in-depth).
 * Keyless, synchronous fs — no model, no network. Returns `{installed, target}`.
 */
function handleSkillInstall(flags: ParsedFlags): Envelope<unknown> {
  // 1. Resolve the target dir: explicit arg → it; else `.claude/skills` if it
  // exists (drop straight into a Claude project) → else the cwd.
  const explicit = flags.args[1]
  let targetDir: string
  if (explicit !== undefined && explicit.trim().length > 0) {
    targetDir = explicit
  } else {
    const claudeSkills = path.join(process.cwd(), '.claude', 'skills')
    targetDir = existsSync(claudeSkills) ? claudeSkills : process.cwd()
  }
  const installRoot = path.resolve(targetDir, 'silver')

  // 2. Collect the payload (relative paths under the package root).
  const rels = collectSkillSources()
  if (rels.length === 0) {
    return badRequest('no skill files are bundled with this build; reinstall silver')
  }

  // 3. Resolve + contain EVERY destination before writing anything (so a
  // containment failure aborts cleanly, never mid-copy). A bundled name can't
  // escape `<target>/silver` — this is belt-and-suspenders over a fixed source set.
  const plan: { src: string; dest: string }[] = []
  for (const rel of rels) {
    const c = assertContainedPath(rel, installRoot)
    if (!c.ok) return fail('path_denied')
    plan.push({ src: path.join(PACKAGE_ROOT, rel), dest: c.resolved })
  }

  // 4. Copy, creating parent dirs as needed. Any fs error propagates to the CLI's
  // throw→envelope mapping (a clean, path-free failure — no leak).
  const installed: string[] = []
  for (const { src, dest } of plan) {
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    installed.push(dest)
  }
  return ok({ installed, target: installRoot })
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
    // --method/--status only match AUTHORITATIVE (source:'fetch') entries. Observer
    // (PerformanceObserver) entries carry an ASSUMED method 'GET' / status 200
    // (capture.ts), so matching them by those fields would present best-effort data
    // as authoritative — the contract at capture.ts:44-50. Scope the filters to fetch.
    if (flags.method !== undefined) {
      const m = flags.method.toUpperCase()
      list = list.filter(
        (r) => String(r.source ?? '') === 'fetch' && String(r.method ?? '').toUpperCase() === m,
      )
    }
    if (flags.status !== undefined) {
      const s = flags.status
      list = list.filter((r) => {
        if (String(r.source ?? '') !== 'fetch') return false
        const st = String(r.status ?? '')
        return st === s || st.startsWith(s)
      })
    }
    const total = list.length
    // Bound the returned array (the page-side ring buffer is already capped).
    const CAP = 200
    // The request url is attacker-controlled free text (a page can seed a captured
    // url with forged transcript tags), so route it through presentPageText
    // (fix F6): neutralize + cap like console/errors before it reaches the host.
    // Filtering/slicing runs on the RAW url first, so --filter still matches
    // unwrapped. The HTTP method is NOT free text — it is a bounded token, so
    // fencing it in content-boundary markers would corrupt a structured field.
    // Sanitize it to a safe uppercase-letter token instead: this strips any
    // injected tag characters entirely (strictly safer than fencing, which leaves
    // attacker text present) while keeping real methods like GET/POST intact.
    const requests = list.slice(-CAP).map((r) => ({
      ...r,
      url: presentPageText(String(r.url ?? ''), flags),
      method: String(r.method ?? '').toUpperCase().replace(/[^A-Z-]/g, '').slice(0, 16),
    }))
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
    // Route EVERY value through presentPageText (fix F7): the whole-store dump
    // otherwise returned each value raw + uncapped, so a page could stash forged
    // transcript tags in localStorage and have them replayed verbatim. Mirrors
    // the single-key `get` path above.
    const storage: Record<string, string> = {}
    for (const [k, v] of Object.entries(all)) storage[k] = presentPageText(String(v), flags)
    return ok({ type: kind, storage })
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
        // F3: hit-test the element under the click point and run the SAME
        // paid/destructive gate a grounded `click @eN` runs — a raw-coordinate
        // click on a "Buy now" control otherwise bypasses the confirm gate.
        const hitName = await elementNameAtPoint(page, x, y)
        if (destructivePaidBlocks(hitName, flags, 'click')) return fail('confirm_required')
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
        if (sub === 'press') {
          // F3: a submit-like press (Enter/Space) ACTIVATES the focused control,
          // so gate it exactly like a `press @eN` on a paid/destructive name —
          // otherwise Enter on a focused "Pay" button bypasses the confirm gate.
          if (isSubmitLikeKey(key)) {
            const focusName = await focusedElementName(page)
            if (destructivePaidBlocks(focusName, flags, 'press')) return fail('confirm_required')
          }
          await page.keyboard.press(key)
        } else if (sub === 'down') await page.keyboard.down(key)
        else await page.keyboard.up(key)
        return ok({ [sub]: key })
      }
      default:
        return badRequest('usage: silver keyboard <type|press|down|up> ...')
    }
  })
}

// ---------------------------------------------------------------------------
// keydown / keyup — raw single-key hold / release (actor). Completes the
// keyboard surface alongside `press` (down+up) and `keyboard down|up`. The key
// is dispatched to the page's focused element via page.keyboard.
//   keydown <key>   ->  page.keyboard.down(key)
//   keyup   <key>   ->  page.keyboard.up(key)
// ---------------------------------------------------------------------------

async function handleKeyRaw(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const key = flags.args[0]
  if (!key) return badRequest(`usage: silver ${flags.verb} <key>`)
  return withConnection(flags, async ({ page }) => {
    if (flags.verb === 'keydown') await page.keyboard.down(key)
    else await page.keyboard.up(key)
    return ok({ [flags.verb]: key })
  })
}

// ---------------------------------------------------------------------------
// download <@ref|selector> <path> — trigger a download by clicking the target
// and capture it via Playwright's `download` event, saving to a CONTAINED path
// (assertContainedPath, like screenshot/pdf/state). Actor verb.
//   download <@ref|selector> <path>   click the target, save the download
//   download --wait [path]            await the NEXT download without a click
// The saved-file path is NOT echoed (no-leak invariant); the server/page-supplied
// suggested filename is neutralized + capped before it reaches the host.
// ---------------------------------------------------------------------------

async function handleDownload(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const timeout = flags.timeout ?? 30000

  // --wait mode: await the next download WITHOUT a click (no target arg).
  if (flags.wait) {
    const outPath = flags.args[0]
    let resolvedOut: string | undefined
    if (outPath !== undefined) {
      const c = assertContainedPath(outPath)
      if (!c.ok) return fail('path_denied')
      resolvedOut = c.resolved
    }
    return withConnection(flags, async ({ page }) => {
      try {
        const download = await page.waitForEvent('download', { timeout })
        if (resolvedOut !== undefined) await download.saveAs(resolvedOut)
        else await download.delete().catch(() => {})
        return ok({
          saved: resolvedOut !== undefined,
          filename: presentPageText(download.suggestedFilename(), flags),
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout')
        throw err
      }
    })
  }

  // click-to-download mode: <@ref|selector> <path>.
  const target = flags.args[0]
  const outPath = flags.args[1]
  if (!target || !outPath) {
    return badRequest('usage: silver download <@ref|selector> <path>  (or: download --wait [path])')
  }
  // Path containment BEFORE we touch the browser (fix P1-SEC4).
  const c = assertContainedPath(outPath)
  if (!c.ok) return fail('path_denied')
  const resolvedOut = c.resolved

  const refBody = parseRef(target)
  return withConnection(flags, async ({ page }) => {
    let cdp: CDPSession | null = null
    try {
      let locator: Locator
      if (refBody) {
        // A grounded ref → the SAME groundRef→toLocator bridge every actor verb
        // runs; a stale ref fails LOUD before any click (R4 no-misclick).
        const refmap = await loadRefMap(flags.session)
        if (!refmap) return fail('element_not_found')
        const g = groundRef(refmap, target)
        if (!g.ok) return fail(g.code)
        cdp = await page.context().newCDPSession(page)
        locator = await toLocator(page, cdp, g.entry, g.ref)
      } else {
        // Anything else is a CSS selector, scoped to the active frame.
        const frame = await resolveActiveFrame(page, flags.session)
        locator = frame.locator(target).first()
      }
      // Arm the download listener BEFORE the click so the event is never missed.
      const downloadPromise = page.waitForEvent('download', { timeout })
      await locator.click({ timeout })
      const download = await downloadPromise
      await download.saveAs(resolvedOut)
      return ok({ saved: true, filename: presentPageText(download.suggestedFilename(), flags) })
    } catch (err) {
      if (err instanceof ResolveError) return fail('element_not_found')
      if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout')
      throw err
    } finally {
      await cleanupStamp(page).catch(() => {})
      if (cdp) await cdp.detach().catch(() => {})
    }
  })
}

// ---------------------------------------------------------------------------
// set <subcommand> … — mutate browser/page emulation state (actor). The keyless,
// useful subset of the Rust oracle's `set`:
//   set viewport <w> <h>                page.setViewportSize
//   set offline <true|false>            context.setOffline
//   set color-scheme <dark|light|no-preference>   page.emulateMedia (alias: media)
//   set geolocation <lat> <lng>         context.setGeolocation (+ grant permission) (alias: geo)
//   set timezone <IANA-tz>              CDP Emulation.setTimezoneOverride (alias: tz)
//   set locale <BCP47>                  CDP Emulation.setLocaleOverride
// Any other subcommand returns a clean typed error listing the valid ones.
// ---------------------------------------------------------------------------

const SET_SUBCOMMANDS = 'viewport, offline, color-scheme, geolocation, timezone, locale'

async function handleSet(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  switch (sub) {
    case 'viewport': {
      const w = Number(flags.args[1])
      const h = Number(flags.args[2])
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        return badRequest('usage: silver set viewport <width> <height> (positive integers)')
      }
      // F8: PERSIST the override so it survives the per-command reconnect —
      // withConnection re-applies it on every later connect.
      await patchEmulation(flags.session, { viewport: { width: w, height: h } })
      return withConnection(flags, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h })
        // Read back the ACTUAL applied inner size within THIS connection as proof
        // the resize landed. The override is now persisted (above), so a LATER
        // command's connect re-applies it via applyEmulation.
        const applied = (await page
          .evaluate('({ width: window.innerWidth, height: window.innerHeight })')
          .catch(() => ({ width: w, height: h }))) as { width: number; height: number }
        return ok({ viewport: { width: w, height: h }, applied })
      })
    }
    case 'offline': {
      // Default true (matching the Rust oracle); `false`/`off`/`0` turns it off.
      const arg = (flags.args[1] ?? 'true').toLowerCase()
      const offline = arg !== 'false' && arg !== 'off' && arg !== '0'
      // F8: persist so the reconnect model does not silently drop it.
      await patchEmulation(flags.session, { offline })
      return withConnection(flags, async ({ context }) => {
        await context.setOffline(offline)
        return ok({ offline })
      })
    }
    case 'color-scheme':
    case 'colorscheme':
    case 'media': {
      const raw = (flags.args[1] ?? 'no-preference').toLowerCase()
      const colorScheme: 'dark' | 'light' | 'no-preference' =
        raw === 'dark' ? 'dark' : raw === 'light' ? 'light' : 'no-preference'
      // F8: persist so a later command re-applies it on connect.
      await patchEmulation(flags.session, { colorScheme })
      return withConnection(flags, async ({ page }) => {
        await page.emulateMedia({ colorScheme })
        return ok({ colorScheme })
      })
    }
    case 'geo':
    case 'geolocation': {
      const lat = Number(flags.args[1])
      const lng = Number(flags.args[2])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return badRequest('usage: silver set geolocation <latitude> <longitude>')
      }
      return withConnection(flags, async ({ context, page }) => {
        // Grant geolocation on the current origin so the page's Geolocation API
        // actually resolves to the emulated position (else it prompts/denies).
        await context
          .grantPermissions(['geolocation'], { origin: safeOrigin(page.url()) })
          .catch(() => {})
        await context.setGeolocation({ latitude: lat, longitude: lng })
        return ok({ geolocation: { latitude: lat, longitude: lng } })
      })
    }
    case 'timezone':
    case 'tz': {
      const tz = flags.args[1]
      if (!tz) return badRequest('usage: silver set timezone <IANA-timezone>')
      return withConnection(flags, async ({ page }) => {
        const cdp = await page.context().newCDPSession(page)
        try {
          await cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz })
          return ok({ timezone: tz })
        } catch {
          return badRequest('invalid timezone; use an IANA name like America/New_York')
        } finally {
          await cdp.detach().catch(() => {})
        }
      })
    }
    case 'locale': {
      const locale = flags.args[1]
      if (!locale) return badRequest('usage: silver set locale <BCP47-locale>')
      return withConnection(flags, async ({ page }) => {
        const cdp = await page.context().newCDPSession(page)
        try {
          await cdp.send('Emulation.setLocaleOverride', { locale })
          return ok({ locale })
        } catch {
          return badRequest('invalid locale; use a BCP47 name like en-US')
        } finally {
          await cdp.detach().catch(() => {})
        }
      })
    }
    default:
      return badRequest(`usage: silver set <${SET_SUBCOMMANDS}> [args…]`)
  }
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
