/**
 * Session lifecycle — the load-bearing "browser-as-daemon" model (plan Task 4).
 *
 * `openSession` spawns a DETACHED Playwright-Chromium with a remote-debugging
 * port and a per-session user-data-dir, then `child.unref()`s it so the browser
 * survives this CLI process exiting. Every later command `connect()`s over CDP,
 * does its work, and disconnects — the browser keeps running. Cross-command
 * state (endpoint / pid, RefMap + generation) lives in JSON sidecars under
 * `~/.silver/sessions/<name>/`.
 *
 * NO model calls, ever. Errors thrown here are generic (no path / secret) to
 * honor the no-leak invariant.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { RefMap } from '../perception/refmap.js'
import { decodeStateBuffer, encryptJson, isStateEncryptionEnabled } from './state-crypto.js'
import {
  assertNavigableResolved,
  containedFilename,
  createSubresourceEgressGuard,
  type EgressOptions,
} from '../security/egress.js'

/**
 * Playwright browser engines Silver recognizes on the `--engine` flag. Only
 * `chromium` is actually SUPPORTED at runtime — the whole perception/actuation
 * stack speaks CDP (`context.newCDPSession`), which firefox/webkit do not expose.
 * The non-chromium members exist ONLY so we can recognize the request and reject
 * it with a clear `engine_unsupported` error at session launch (F1).
 */
export type Engine = 'chromium' | 'firefox' | 'webkit'

/** Normalize a `--engine` value to a recognized engine (default chromium). */
export function normalizeEngine(e: string | undefined): Engine {
  return e === 'firefox' ? 'firefox' : e === 'webkit' ? 'webkit' : 'chromium'
}

/**
 * F1: reject a non-chromium engine at the launch/connect chokepoint. Throws an
 * error carrying the `engine_unsupported` taxonomy code so the hub's `mapThrow`
 * surfaces the fixed recovery message (no path/secret leak). Silver cannot
 * snapshot under firefox/webkit — its perception uses CDP, which they lack — so
 * we fail LOUD rather than opening a session that cannot perceive.
 */
function assertChromiumEngine(engine: Engine): void {
  if (engine !== 'chromium') {
    throw Object.assign(new Error('engine_unsupported'), { code: 'engine_unsupported' as const })
  }
}

export type SessionInfo = {
  port: number
  pid: number
  wsEndpoint: string
  createdAt: string
  /**
   * True when this session was attached to an ALREADY-RUNNING browser via
   * `connect <endpoint>` rather than spawned by us. We do not own its process,
   * so: pid-liveness is not checked before connecting, a failed connect is NOT
   * auto-respawned into a fresh owned browser, and `session gc` never reaps it.
   */
  external?: boolean
  /**
   * The Playwright engine this session launches. Always `chromium` in practice —
   * `openSession` rejects any other engine at launch (F1), because the whole
   * perception/actuation stack is CDP-only. Retained on the type for forward
   * compatibility and to let `connect` re-reject a stale non-chromium sidecar.
   */
  engine?: Engine
  /** The persistent profile dir (recorded for the non-chromium relaunch path). */
  userDataDir?: string
  /** Whether to launch headed (recorded for the non-chromium relaunch path). */
  headed?: boolean
  /** The custom browser executable this session was spawned with (CloakHQ binary
   * swap), if any — recorded so `doctor`/`session` can surface a non-default,
   * user-obtained binary. Absent means the bundled Chromium. */
  execPath?: string
  /** 2c: this session is a durable (--restore) session — its cookies+localStorage
   * are autosaved to the external restore file. Sticky across auto-respawn. */
  restore?: boolean
  /**
   * ISO timestamp of the last `connect()` against this session — i.e. the last
   * command that actually touched the browser. Written best-effort on every
   * connect (a failed touch never fails the command).
   *
   * This is the idle-reaper's clock. Absent on sidecars written before this
   * field existed, and on a session that was opened but never used again; both
   * cases fall back to `createdAt`, which is the conservative choice — it can
   * only make a session look OLDER, never younger, so a stale sidecar is reaped
   * rather than leaked.
   */
  lastUsedAt?: string
  /**
   * PID of this session's LIFELINE HOLDER — the tiny `sh` process that owns the
   * browser's `--remote-debugging-pipe` file descriptors and thereby its life.
   * Absent when no lifeline was attached (reaping disabled, win32, or the fds
   * could not be handed over — all of which degrade to sweep-only reclamation).
   * See `spawnLifelineHolder`.
   */
  holderPid?: number
  /**
   * Filename (inside the session dir) of the clock THIS generation's holder polls.
   * Generation-unique so an auto-respawn retires the previous holder by unlinking
   * its file instead of signalling a possibly-recycled pid.
   */
  deadlineFile?: string
  /**
   * The idle TTL this session was OPENED with, in ms. The sweep is global, so
   * without this the sweeping process's own TTL would govern every other
   * namespace's sessions — and a session deliberately opened with
   * `SILVER_SESSION_IDLE_MS=0` ("outlives everything") would still be reaped by
   * any unrelated command running with the default. `0` means never reap.
   */
  idleTtlMs?: number
}

export type OpenOptions = {
  /** Launch with a visible window. Default false (headless). */
  headed?: boolean
  /** Override the profile directory. Default `<sessionDir>/profile`. */
  userDataDir?: string
  /** Request a specific debugging port. Default 0 (let Chromium pick a free one). */
  port?: number
  /** Recorded for later idle-reaping logic; unused by open itself. */
  idleTimeoutMs?: number
  /** Browser engine to launch (H1). Default chromium. */
  engine?: Engine
  /**
   * Real-Chrome-profile launch (adopt-list E2): an EXISTING user-data-dir (the
   * user's logged-in profile) to launch against instead of a throwaway one — the
   * truest keyless auth, no credential ever enters Silver. When set it becomes the
   * `--user-data-dir` and is REUSED across the session's lifetime, so its cookies
   * and storage carry the logged-in session.
   *
   * ISOLATION TRADE-OFF (documented): pointing at a real profile means Silver
   * shares that profile's cookies, extensions, and history — there is NO isolation
   * from the user's normal browsing, and the profile must NOT be in use by another
   * running Chrome (the user-data-dir lock is exclusive). Prefer a dedicated copied
   * profile for unattended runs; use the live profile only for interactive auth.
   */
  profile?: string
  /** Vercel-alignment: route the browser through a proxy (Chromium `--proxy-server`),
   * applied at launch. Unauthenticated proxies only. */
  proxy?: string
  /**
   * Detection coherence: the browser's content locale, applied at LAUNCH as
   * Chromium's own `--lang` + `--accept-lang` instead of over CDP.
   *
   * `set locale` / `set timezone` reach for `Emulation.setLocaleOverride` /
   * `setTimezoneOverride`, which patch a renderer that is already running. That is
   * the layer a detector probes: the override itself is observable, and anything
   * read before it lands (the first request's `Accept-Language`, a value cached at
   * startup) still carries the OLD identity, so the two disagree. A launch flag is
   * read before the first frame exists, so there is no earlier value to contradict.
   *
   * Cost, and it is a real one: launch-time means FRESH SESSION ONLY — exactly the
   * constraint `proxy` above accepts. A session that is already open cannot adopt
   * this, which is precisely why the CDP verbs stay as the mid-session fallback
   * rather than being replaced by it.
   *
   * Silver never DERIVES this from a proxy, an IP, or a geo database: a guess that
   * disagrees with the exit node is a louder tell than saying nothing. Operator-
   * supplied or absent.
   */
  locale?: string
  /**
   * IANA timezone (`Europe/Berlin`), applied at LAUNCH as the child's `TZ` env var.
   * Same mechanism, same trade-off, same fresh-session-only constraint as `locale`
   * above — ICU and libc read `TZ` at process start, so `Date` and `Intl` agree
   * from the first evaluation instead of being corrected by a CDP call later.
   */
  timezone?: string
  /**
   * CloakHQ alignment (opt-in binary swap): an operator-supplied path to a
   * DIFFERENT Chromium executable to spawn instead of Playwright's bundled one —
   * e.g. a source-level stealth build (cloakbrowser.dev) whose C++ fingerprint
   * patches (canvas/WebGL/TLS-JA3/fonts) live below JS and cannot be reimplemented
   * in Silver. Silver still drives it over CDP (a stealth Chromium is a standard
   * CDP target), and every security guard (egress/redaction/containment) is
   * Node-layer and runs BEFORE goto/fetch — so the swap buys authenticity WITHOUT
   * weakening the envelope. Silver NEVER downloads/bundles the binary; it only
   * accepts a path the user obtained themselves. Falls back to
   * `SILVER_BROWSER_EXECUTABLE` (the sticky, set-once form that also survives an
   * auto-respawn), then to the bundled Chromium.
   */
  execPath?: string
  /**
   * 2c durable session: mark this session so its cookies+localStorage are
   * autosaved (after mutating commands) to an encrypted restore file that lives
   * OUTSIDE the session dir — so it survives closeSession's `fs.rm(sessionDir)`,
   * `session gc`, AND a daemon SIGKILL. The mark is made STICKY in the sidecar
   * (see openSession) so a later bare command's auto-respawn does not drop it.
   */
  restore?: boolean
}

/**
 * Low-risk permission prompts auto-granted on connect when `--grant-permissions`
 * is set (E4), so a task that hits one of these dialogs does not hang. NOT
 * granted by default — the flag is the opt-in. (Camera/microphone are
 * deliberately EXCLUDED — higher-risk, and not needed for the hang class.)
 */
export const AUTO_GRANT_PERMISSIONS: readonly string[] = [
  'geolocation',
  'clipboard-read',
  'clipboard-write',
  'notifications',
]

/**
 * Grant the low-risk permission set on `context` (E4). Best-effort: a permission
 * name an engine does not recognize is skipped rather than throwing. Optionally
 * scoped to one origin; without an origin it applies context-wide.
 */
export async function grantDefaultPermissions(
  context: BrowserContext,
  origin?: string,
): Promise<void> {
  await context
    .grantPermissions([...AUTO_GRANT_PERMISSIONS], origin ? { origin } : undefined)
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Fetch-layer egress policy (adopt-list S2). The subresource egress guard is
// enabled on EVERY connect (below). Its policy is process-wide, mirroring the
// namespace pattern: the CLI sets it ONCE from `--allow-file-access` /
// `--allowed-domains` (see setFetchEgressPolicy), and every per-command reconnect
// re-arms the guard with the current policy. Default (unset) = the nav denylist
// default: file:/data:/blob:/non-http(s)/raw-IP/known-dangerous subresources are
// blocked, ordinary http(s) subresources pass, no allowlist restriction.
// ---------------------------------------------------------------------------

let fetchEgressPolicy: EgressOptions = { allowFile: false, allowedDomains: [] }

/** Set the process-wide subresource egress policy (call once from the CLI). */
export function setFetchEgressPolicy(opts: EgressOptions): void {
  fetchEgressPolicy = {
    allowFile: Boolean(opts?.allowFile),
    allowedDomains: opts?.allowedDomains ? [...opts.allowedDomains] : [],
  }
}

/** The active subresource egress policy (for tests / observability). */
export function currentFetchEgressPolicy(): EgressOptions {
  return fetchEgressPolicy
}

// ---------------------------------------------------------------------------
// HTTP Basic-Auth resolver (ADD #2 — `set credentials`/`set auth`). The Fetch
// egress guard owns the CDP `Fetch` domain, so Playwright's own
// `context.setHTTPCredentials` cannot answer a 401 Basic challenge on a
// CDP-attached context (two Fetch owners conflict → net::ERR_INVALID_AUTH_CREDENTIALS).
// Instead the guard itself answers `Fetch.authRequired` using credentials from
// this process-wide resolver, which handlers.ts installs (per command, from the
// persisted+token-resolved emulation creds) BEFORE the guard is armed on connect.
// Returns the resolved {username,password} for a challenging request URL, or null
// when no credentials apply (then the guard lets the challenge proceed unanswered,
// preserving the honest 401 dead-end). Keyless: pure lookup, no model/network.
// ---------------------------------------------------------------------------

export type BasicAuthResolver = (url: string) => { username: string; password: string } | null
let basicAuthResolver: BasicAuthResolver | null = null

/** Install (or clear with `null`) the per-command Basic-Auth resolver the Fetch
 * egress guard consults when a 401 auth challenge fires. */
export function setBasicAuthResolver(fn: BasicAuthResolver | null): void {
  basicAuthResolver = fn
}

/**
 * CDP `Fetch.enable` interception patterns for the S2 subresource egress guard:
 * one wildcard-URL pattern per interceptable SUBRESOURCE `resourceType`. `Document`
 * is intentionally OMITTED so navigations — and the `Document`-classified request a
 * `download`-attribute link fires (E4) — are never paused by the Fetch domain
 * (pausing+continuing a download-destined Document request drops the download).
 * `WebSocket` is not interceptable by the Fetch domain and is likewise omitted.
 */
// Every `resourceType` the CDP Fetch filter accepts EXCEPT `Document` (probed
// against Chromium: `TextTrack`/`Prefetch`/`Manifest`/`SignedExchange`/`Preflight`/
// `WebSocket` are rejected by `Fetch.enable`, and a single unknown type aborts the
// whole call — so this list is exactly the accepted subresource set). This spans
// the real exfil vectors (`fetch()`/XHR/`<img>`/`<script>`/beacon/EventSource).
const FETCH_GUARD_RESOURCE_TYPES = [
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'XHR',
  'Fetch',
  'EventSource',
  'Ping',
  'CSPViolationReport',
  'Other',
] as const
const FETCH_GUARD_PATTERNS = FETCH_GUARD_RESOURCE_TYPES.map((resourceType) => ({
  urlPattern: '*',
  resourceType,
}))

/**
 * Enable the CDP `Fetch`-layer subresource egress guard on a connected context
 * (adopt-list S2 — closes the exfil hole where a page on an allowed domain
 * beacons to any host via `fetch()`/`<img>`/XHR). For each page (and any page
 * opened later this command) a `Fetch.enable` interceptor holds every subresource
 * request to a per-guard `createSubresourceEgressGuard` decider — the same policy
 * the nav path uses (`assertNavigableResolved`), so a DNS-rebind host that resolves
 * to loopback/link-local/private/metadata is blocked here too (fix C1), with each
 * host's verdict cached so a burst to one host resolves it at most once. A denied
 * request is `Fetch.failRequest`'d with `BlockedByClient`, everything else
 * `Fetch.continueRequest`'d. Best-effort and non-blocking: a target that
 * cannot be armed (gone / non-CDP engine) is skipped rather than failing the
 * command. Chromium-only (CDP); firefox/webkit have no `Fetch` domain.
 */
export async function enableFetchEgressGuard(
  context: BrowserContext,
  opts: EgressOptions = fetchEgressPolicy,
): Promise<void> {
  // ONE stateful decider per armed guard (fix C1): it resolves DNS like the nav
  // path (`assertNavigableResolved`) so a rebind host that lexically looks public
  // but RESOLVES to loopback/link-local/private/metadata is blocked here too, and
  // it caches each host's verdict so a page firing hundreds of subresources at the
  // same host resolves that host at most once. Shared across every page armed by
  // this guard (host→verdict is deterministic under a fixed policy).
  const decide = createSubresourceEgressGuard(opts)
  // ADD #2: when a Basic-Auth resolver is installed for this command, the guard
  // must ALSO own auth handling (`handleAuthRequests`) and intercept the
  // `Document` request so its 401 challenge routes here — Playwright's
  // `setHTTPCredentials` can't answer it while the guard owns the Fetch domain.
  // Captured ONCE per arm() so a mid-flight change can't split a page's state.
  const authOn = basicAuthResolver !== null
  const patterns = authOn
    ? [{ urlPattern: '*', resourceType: 'Document' as const }, ...FETCH_GUARD_PATTERNS]
    : FETCH_GUARD_PATTERNS
  const arm = async (page: Page): Promise<void> => {
    let cdp: import('playwright').CDPSession
    try {
      cdp = await context.newCDPSession(page)
    } catch {
      return // page/target gone, or engine without a CDP Fetch domain
    }
    cdp.on('Fetch.requestPaused', (evt) => {
      const requestId = evt.requestId
      const url = evt.request?.url ?? ''
      const resourceType = String(evt.resourceType ?? '')
      // A `Document` request is only paused when auth handling is on. It was
      // already vetted by `assertNavigableResolved` at the nav layer, so continue
      // it unconditionally (do NOT re-run the egress decider on a navigation) and
      // let its 401, if any, surface as a `Fetch.authRequired` below.
      if (resourceType === 'Document') {
        void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
        return
      }
      // The decision now RESOLVES DNS (async). Hold the paused request until the
      // verdict lands, then fail-closed block or continue. `decide` never throws
      // (it blocks on any resolution error), so this listener cannot reject.
      void (async () => {
        const decision = await decide(url, resourceType)
        if (decision === 'block') {
          await cdp
            .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
            .catch(() => {})
        } else {
          await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
        }
      })()
    })
    if (authOn) {
      // Answer a 401 Basic/Digest challenge with the resolver's credentials for
      // THIS request URL (domain-scoped `<secret>` tokens resolve against it). No
      // credentials → `Default` (let the browser cancel → the honest 401 remains).
      cdp.on('Fetch.authRequired', (evt) => {
        const requestId = evt.requestId
        const url = evt.request?.url ?? ''
        void (async () => {
          const creds = basicAuthResolver ? basicAuthResolver(url) : null
          // SECURITY: never hand Basic-Auth creds to a host the egress guard would
          // DENY (loopback/link-local/private/metadata, or a DNS-rebind host that
          // resolves to one). A 401 redirect to an internal/metadata endpoint must
          // NOT steal the session's credentials — this closes the SSRF-style
          // credential-theft even for a literal/context-wide password. (A
          // domain-scoped `<secret>NAME@domain</secret>` token is ADDITIONALLY
          // refused by the resolver when the challenging host does not match.)
          const allowed = creds ? (await assertNavigableResolved(url, opts)).ok : false
          const authChallengeResponse =
            creds && allowed
              ? {
                  response: 'ProvideCredentials' as const,
                  username: creds.username,
                  password: creds.password,
                }
              : { response: 'Default' as const }
          void cdp
            .send('Fetch.continueWithAuth', { requestId, authChallengeResponse })
            .catch(() => {})
        })()
      })
    }
    try {
      // Intercept every SUBRESOURCE type but deliberately NOT `Document` (unless
      // auth handling is on, above): navigations (and the download a
      // `download`-attribute link triggers, which Chromium classifies as a
      // `Document` request) are the nav path's job and are vetted by
      // `assertNavigableResolved` before goto. Pausing a Document request in the
      // Fetch domain and continuing it drops the page-initiated download (E4) on
      // the floor — so navigations are left entirely native here (no Basic Auth)
      // while the exfil vectors (`fetch()`/`<img>`/XHR/beacon/…) stay guarded.
      await cdp.send('Fetch.enable', { patterns, handleAuthRequests: authOn })
    } catch {
      /* target vanished before enable landed — nothing to guard */
    }
  }
  try {
    await Promise.all(context.pages().map((p) => arm(p)))
  } catch {
    /* best-effort across existing pages */
  }
  // Cover any tab opened DURING this command (e.g. resolveActivePage → newPage,
  // or a window.open) so a subresource from a fresh tab is guarded too.
  context.on('page', (p) => {
    void arm(p)
  })
}

/** Strip any path separators / traversal from a page-supplied download name (S3). */
function sanitizeDownloadName(name: string): string {
  const base = path.basename(name || 'download')
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 128) : 'download'
}

/**
 * Auto-detect PAGE-initiated downloads (E4). Without a `download` listener a
 * click that kicks off a download can leave the artifact pending and stall the
 * task. This handler saves each download to a CONTAINED per-session dir (never a
 * page-chosen path — the suggested filename is sanitized) so the click resolves.
 * Returns a getter for the last saved (contained) filename, for observability.
 *
 * NOT attached for the explicit `download` verb, which arms its own
 * `waitForEvent('download')` — a second consumer would race its `saveAs`.
 */
export function autoHandleDownloads(
  page: Page,
  saveDir: string,
): { last: () => string | null; drain: () => Promise<void> } {
  let last: string | null = null
  const pending = new Set<Promise<void>>()
  page.on('download', (d) => {
    const p = (async () => {
      try {
        await fs.mkdir(saveDir, { recursive: true })
        // S3 chokepoint: a server-suggested filename with traversal/absolute
        // components is reduced to a safe basename contained in saveDir. Belt to
        // sanitizeDownloadName's suspenders — one function owns containment.
        const contained = containedFilename(d.suggestedFilename(), saveDir)
        const dest = contained.ok
          ? contained.resolved
          : path.join(saveDir, sanitizeDownloadName(d.suggestedFilename()))
        await d.saveAs(dest)
        last = d.suggestedFilename()
      } catch {
        await d.delete().catch(() => {})
      }
    })()
    pending.add(p)
    void p.finally(() => pending.delete(p))
  })
  return {
    last: () => last,
    // Await in-flight saves so a caller can flush BEFORE dropping the CDP
    // transport (else saveAs races teardown and the artifact is lost). Empty in
    // the common no-download case → zero added latency.
    drain: async () => {
      if (pending.size > 0) await Promise.allSettled([...pending])
    },
  }
}

export type Connection = {
  browser: Browser
  context: BrowserContext
  page: Page
  /**
   * The sidecar `connect()` read to reach this browser. Carried so a caller can
   * decide how to LEAVE the session (see `parkPages`) without paying a second
   * sidecar read on the hot path of every command.
   */
  info: SessionInfo
}

const SIDECAR = 'session.json'
const REFMAP = 'refmap.json'
const READY_BUDGET_MS = 8_000

/**
 * Deterministic viewport (P0-8): a fixed window size makes snapshots/screenshots
 * and concurrent eval runs reproducible instead of inheriting a version-dependent
 * headless default. Applied both as a launch arg and (best-effort) per connect.
 */
export const VIEWPORT = { width: 1280, height: 900 } as const

/**
 * May we override this session's CONTENT size to `VIEWPORT`?
 *
 * The launch arg `--window-size=1280,900` sizes the WINDOW; `setViewportSize`
 * sizes the CONTENT box. Headless those two are legitimately identical — there is
 * no tab strip and no omnibox to subtract — so forcing 1280×900 content into a
 * 1280×900 window states something true, and we keep it for the determinism it
 * buys (reproducible screenshots, stable scroll math across Chromium versions).
 *
 * HEADED, forcing it states something impossible. A real Chrome window spends
 * ~80-140px on browser chrome, so `outerHeight` is always strictly greater than
 * `innerHeight`; overriding the content box to the window's own height reports
 * `outerHeight === innerHeight`, i.e. a window with no chrome at all. That
 * combination is one of the cheapest automation signals there is — FingerprintJS
 * reads it as a VM. Measured on macOS it came out worse than that: the WM clamped
 * the window to 859px tall to fit the menu bar while the forced viewport stayed
 * 900, so the page reported a 900px content box inside an 859px window — a
 * viewport larger than the window containing it, which no browser can produce.
 * Gated, the same session reads outer 859 / inner 716 — 143px of real chrome.
 *
 * Silver's stance is authenticity, not deception: rather than
 * spoof the numbers we simply stop emitting a false one and let the real window
 * answer. The cost is real and accepted: a headed session's viewport is whatever
 * the window manager gave it, so headed screenshots are not pixel-comparable to
 * headless ones. Determinism is worth less than not being obviously fake, and a
 * host that needs an exact size can still ask for one with `set viewport w h`.
 *
 * EXTERNAL is not about tells at all. A `connect`ed browser is the USER'S, with
 * their tabs in it; resizing it is reaching into a window a person is looking at,
 * on every command. Same reasoning as `parkPages`, which refuses these two cases
 * for the same reason: we do not own that browser.
 *
 * Takes the sidecar fields rather than a whole `SessionInfo` so both call sites
 * (here and `tab new` in handlers.ts) can pass what they already hold.
 */
export function shouldEmulateViewport(info: Pick<SessionInfo, 'headed' | 'external'>): boolean {
  return info.headed !== true && info.external !== true
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Lazily import Playwright's `chromium`, reached ONLY inside an actual browser
 * branch (openSession / connect / connectExternalSession / closeSession). Keeping
 * this a DYNAMIC import (not a module-top `import`) means meta / read / flag-parse
 * verbs (`version`, `doctor`, `session list`, …) never pay Playwright's ~150ms
 * module load — it is off the fast path entirely (engine-plan P2). The `Browser`
 * etc. types above are `import type` (erased at compile), so they add no runtime
 * dependency.
 */
async function loadChromium(): Promise<typeof import('playwright').chromium> {
  return (await import('playwright')).chromium
}

/**
 * True while `pid` is a live process (EPERM = alive-but-not-ours; ESRCH = gone).
 *
 * pid <= 0 is treated as dead: `process.kill(0, 0)` targets the whole process
 * GROUP (a footgun), and pid 0 is what external/connected sessions record for a
 * browser whose real pid we do not know.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// Namespace: a sidecar-dir prefix isolating independent agent-GROUPS. Set once
// per CLI invocation from `--namespace` (see cli.ts) — the whole process runs in
// ONE namespace, so a module-level value avoids threading it through 40+ path
// call sites (this mirrors the Rust fork's SILVER_NAMESPACE env approach).
// ---------------------------------------------------------------------------

let activeNamespace = sanitizeNamespace(process.env.SILVER_NAMESPACE ?? '')

/** Sanitize a namespace into a safe single path segment (or '' for none). */
export function sanitizeNamespace(ns: string | undefined): string {
  if (!ns) return ''
  const cleaned = ns
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned
}

/**
 * Set the active namespace for this process. A falsy/empty flag falls back to
 * the SILVER_NAMESPACE env, then to the un-namespaced default.
 */
export function setNamespace(ns: string | undefined): void {
  const fromFlag = sanitizeNamespace(ns)
  activeNamespace = fromFlag || sanitizeNamespace(process.env.SILVER_NAMESPACE ?? '')
}

/** The active namespace segment ('' when un-namespaced). */
export function currentNamespace(): string {
  return activeNamespace
}

/**
 * Write a sidecar ATOMICALLY (P1-S5): write to a unique temp file then rename
 * into place. `rename(2)` is atomic within a directory, so a concurrent reader
 * never observes a half-written (torn) JSON grounding file.
 */
async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Serialize + atomically write a session sidecar, ENCRYPTED at rest by default
 * (AES-256-GCM) so cookie/storage-adjacent session state is never plaintext on
 * disk. `--no-encrypt-state` / `SILVER_NO_ENCRYPT_STATE=1` writes plaintext JSON
 * instead. Reads (`readSidecarObject`) transparently accept either form.
 *
 * Exported so ALL per-session sidecars share ONE crypto path — not just
 * session.json / refmap.json here, but also handlers' silver-state.json (holds
 * the previous page-tree text + the extract value-map of real URLs) and
 * dialog.json, which must never be plaintext on disk (fix F4/F8).
 */
export async function writeSidecar(filePath: string, obj: unknown): Promise<void> {
  const data: string | Buffer = isStateEncryptionEnabled()
    ? encryptJson(obj)
    : JSON.stringify(obj, null, 2)
  await atomicWrite(filePath, data)
}

/**
 * Read a session sidecar and decode it transparently: an encrypted blob is
 * decrypted, a legacy plaintext-JSON sidecar is parsed as-is (migration). The
 * caller owns error mapping (missing vs. corrupt).
 *
 * Exported for handlers' silver-state.json / dialog.json (fix F4/F8) so those
 * sidecars migrate legacy plaintext + round-trip through the SAME crypto.
 */
export async function readSidecarObject<T>(filePath: string): Promise<T> {
  const buf = await fs.readFile(filePath)
  return decodeStateBuffer(buf) as T
}

/**
 * Root dir for all sessions. Un-namespaced: `~/.silver/sessions`. Under a
 * namespace `ns`: `~/.silver/<ns>/sessions` — so independent agent-groups do not
 * collide even when they both use `--session default`.
 */
/**
 * Silver's data root — `$SILVER_HOME`, else `~/.silver`.
 *
 * Exists so a test run (or a throwaway sandbox) can relocate EVERYTHING silver
 * owns without touching `$HOME`. That matters more since the reaper went global:
 * a suite that swept the real root would SIGTERM whatever browsers the developer
 * had parked elsewhere. Redirecting `$HOME` instead is NOT a substitute — on
 * macOS it breaks Chromium's keychain lookup and pops a modal on every launch.
 */
export function silverHome(): string {
  const override = process.env.SILVER_HOME?.trim()
  return override ? override : path.join(os.homedir(), '.silver')
}

export function sessionsRoot(): string {
  const base = silverHome()
  return activeNamespace
    ? path.join(base, activeNamespace, 'sessions')
    : path.join(base, 'sessions')
}

/** Per-session dir: `~/.silver/sessions/<name>`. */
export function sessionDir(name: string): string {
  return path.join(sessionsRoot(), assertName(name))
}

function sidecarPath(name: string): string {
  return path.join(sessionDir(name), SIDECAR)
}

function refmapPath(name: string): string {
  return path.join(sessionDir(name), REFMAP)
}

/**
 * Session names become path segments, so constrain them. On rejection we throw
 * a generic error (no name echoed) to keep error strings clean.
 */
function assertName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('invalid session name')
  }
  return name
}

// ---------------------------------------------------------------------------
// 2c — durable session snapshot (cookies + per-origin localStorage).
//
// Persisted so a logged-in session survives a daemon crash / idle-reap / graceful
// close. Deliberately lives OUTSIDE the session dir (a SIBLING of `sessions/`),
// because closeSession's `fs.rm(sessionDir)` and `session gc` wipe the WHOLE
// session dir (profile included) — so an in-dir file would be lost on a graceful
// close, the exact "log in once, come back tomorrow" case this feature exists for.
// Written through writeSidecar → AES-256-GCM at rest exactly like every other
// sidecar (it holds session tokens; never plaintext). No token is ever minted:
// this is the user's OWN session, captured and replayed.
// ---------------------------------------------------------------------------

export type RestoreSnapshot = {
  cookies: unknown[]
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}

/** Persistent restore dir, a SIBLING of `sessions/` so a session's teardown never
 * deletes it: `~/.silver/[<ns>/]restore`. */
function restoreRoot(): string {
  // Must go through silverHome(): this was the one path still reading os.homedir()
  // directly, so a run with SILVER_HOME set relocated its sessions but kept
  // writing durable login snapshots into the REAL ~/.silver — which is both a
  // leak out of the sandbox and a way for a test run to clobber real snapshots.
  const base = silverHome()
  return activeNamespace ? path.join(base, activeNamespace, 'restore') : path.join(base, 'restore')
}

/** `~/.silver/[<ns>/]restore/<name>.json`. The name is validated (assertName) so
 * it can never escape the restore dir. */
export function restorePath(name: string): string {
  return path.join(restoreRoot(), `${assertName(name)}.json`)
}

/** Read the durable snapshot, or null when none/corrupt. */
export async function readRestoreSnapshot(name: string): Promise<RestoreSnapshot | null> {
  try {
    return await readSidecarObject<RestoreSnapshot>(restorePath(name))
  } catch {
    return null
  }
}

/** Write the durable snapshot (encrypted at rest, best-effort dir create). */
export async function writeRestoreSnapshot(name: string, snap: RestoreSnapshot): Promise<void> {
  await fs.mkdir(restoreRoot(), { recursive: true })
  await writeSidecar(restorePath(name), snap)
}

/**
 * Capture the CURRENT session state into a RestoreSnapshot, MERGING with any prior
 * snapshot so other origins' localStorage survives a navigation. Cookies come from
 * `context.storageState()` (all origins, always complete). localStorage does NOT
 * cross connectOverCDP (storageState returns `origins:[]` over CDP), so the CURRENT
 * page's origin localStorage is scraped manually and merged — the same honest
 * single-active-origin capture `state save` documents.
 *
 * The load-bearing distinction is CAPTURE-FAILURE vs GENUINE-EMPTY:
 *   - A FAILED capture must never overwrite a good snapshot (a transient CDP
 *     hiccup on the per-command reconnect would otherwise wipe the login):
 *     `storageState()` rejecting returns `null` here → the caller SKIPS the write;
 *     a failed localStorage scrape PRESERVES that origin's prior localStorage.
 *   - A SUCCESSFUL-but-empty capture is a real state and IS persisted: a
 *     `localStorage.clear()` logout (localStorage-only auth) drops the origin, so a
 *     logged-out session is not resurrected on the next `open --restore`.
 * Returns `null` when the capture is untrustworthy (caller must not write it).
 */
export async function captureRestoreSnapshot(
  name: string,
  context: BrowserContext,
  page: Page | null,
): Promise<RestoreSnapshot | null> {
  // Cookies cover all origins. If storageState() REJECTS the capture is
  // untrustworthy — return null so the caller does not clobber a good login with
  // []. (A successful empty result IS trusted and persisted.)
  let state: { cookies?: unknown[] }
  try {
    state = (await context.storageState()) as { cookies?: unknown[] }
  } catch {
    return null
  }
  const cookies = Array.isArray(state.cookies) ? state.cookies : []

  let origin = ''
  try {
    origin = page ? new URL(page.url()).origin : ''
  } catch {
    origin = ''
  }

  // Merge: base off the PRIOR snapshot's origins (accumulated over the session so
  // OTHER origins survive), drop the current origin's stale entry, then re-add per
  // the failure-vs-empty rule below. `origin===''`/about:blank keeps all prior
  // origins untouched (nothing to scrape).
  const prev = await readRestoreSnapshot(name).catch(() => null)
  const prevForOrigin = prev?.origins?.find((o) => o.origin === origin)
  const origins = (prev?.origins ?? []).filter((o) => o.origin !== origin)

  if (page && origin && origin !== 'null') {
    // Scrape localStorage for THIS origin. Distinguish a thrown scrape (untrusted →
    // preserve prior) from a successful empty result (a real logout → drop it).
    let ls: Array<{ name: string; value: string }> | null
    try {
      ls = (await page.evaluate(() => {
        const s = (globalThis as unknown as { localStorage: Storage }).localStorage
        const out: Array<{ name: string; value: string }> = []
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i)
          if (k !== null) out.push({ name: k, value: s.getItem(k) ?? '' })
        }
        return out
      })) as Array<{ name: string; value: string }>
    } catch {
      ls = null // scrape FAILED (untrusted) — do not treat as a logout
    }
    if (ls === null) {
      // Failed scrape: keep the prior origin's localStorage rather than lose it.
      if (prevForOrigin) origins.push(prevForOrigin)
    } else if (ls.length > 0) {
      origins.push({ origin, localStorage: ls })
    }
    // ls === [] (successful, empty) → drop the origin so a real logout persists.
  } else if (prevForOrigin) {
    // No usable page/origin to scrape — never drop a prior entry we can't re-read.
    origins.push(prevForOrigin)
  }
  return { cookies, origins }
}

/**
 * Spawn a detached Chromium, wait until its debugging endpoint is live, and
 * persist the sidecar. Returns the sidecar contents.
 */
export async function openSession(name: string, opts: OpenOptions = {}): Promise<SessionInfo> {
  // Opportunistic idle sweep (leak fix). `open` is the moment new OS resources
  // are committed, so it is the natural place to return abandoned ones — and it
  // makes the live-session count self-limiting: a fleet can only ever accumulate
  // one idle-TTL's worth of sessions, instead of growing without bound until the
  // machine runs out of RAM. Excludes the session being opened, never throws.
  await reapIdleSessions(resolveIdleTtlMs(opts.idleTimeoutMs), name).catch(() => {})
  // Then the hard bound. The idle sweep above only returns browsers nobody has
  // touched for a TTL; this one bounds the count of browsers running RIGHT NOW,
  // which is the number the machine actually feels. Stopped sessions are noted
  // for the `open` envelope rather than dropped silently.
  const stopped = await enforceBrowserCeiling(name).catch(() => [] as string[])
  if (stopped.length > 0) evictionNotice = stopped
  const dir = sessionDir(name)
  // E2 real-Chrome-profile: `profile` (an EXISTING user-data-dir) wins over an
  // explicit userDataDir override, which wins over the throwaway per-session dir.
  // Whichever is chosen is recorded in the sidecar and REUSED on every reconnect.
  const userDataDir = opts.profile ?? opts.userDataDir ?? path.join(dir, 'profile')
  await fs.mkdir(userDataDir, { recursive: true })

  // 2c: the --restore mark is STICKY. A later bare command (no --restore) that
  // triggers an auto-respawn re-runs openSession with THAT command's flags, which
  // would drop restore=false and silence autosave. OR it with the existing
  // sidecar's mark so a session opened with --restore stays a restore session for
  // its whole life. (Fresh open: no prior sidecar → just opts.restore.)
  const prior = await readSidecar(name).catch(() => null)
  const stickyRestore = Boolean(opts.restore) || prior?.restore === true


  // BUG #9: delete any STALE `DevToolsActivePort` left in the profile dir. Chromium
  // removes this file on clean exit but LEAVES it on crash/SIGKILL/OOM/sleep. When
  // the auto-respawn (ensureConnected → openSession) reuses the same userDataDir,
  // `waitForDevToolsPort` polls this file immediately and would read the DEAD
  // browser's old port before the freshly-spawned one overwrites it — targeting a
  // dead endpoint and permanently wedging the session. Removing it first guarantees
  // the port we read belongs to the browser we are about to spawn.
  await fs.rm(path.join(userDataDir, 'DevToolsActivePort'), { force: true })

  // F1: firefox/webkit are rejected HERE, at launch — before any browser is
  // spawned or any sidecar is written. Silver's snapshot/act stack is CDP-only
  // (`context.newCDPSession`), so a non-chromium session could open but never
  // perceive; shipping that half-broken fallback would advertise a capability
  // Silver does not have. A real non-CDP firefox path is out of scope (it needs
  // an engine-agnostic perception rewrite).
  assertChromiumEngine(normalizeEngine(opts.engine))

  const requestedPort = opts.port ?? 0
  const chromium = await loadChromium()
  // CloakHQ binary swap: an operator-supplied stealth Chromium wins over the bundled
  // one. Precedence: explicit --exec-path (opts.execPath) > SILVER_BROWSER_EXECUTABLE
  // env (the sticky, set-once form that also survives an auto-respawn, which re-runs
  // openSession with the current command's flags, NOT the original open's) > bundled.
  const envExec = process.env.SILVER_BROWSER_EXECUTABLE?.trim()
  const customExec = opts.execPath?.trim() || (envExec ? envExec : undefined)
  const execPath = customExec ?? chromium.executablePath()
  // Onramp fix (swap-readiness): a fresh install where Chromium was never downloaded
  // otherwise fails the FIRST `open` with an unclassified `engine_error` ("re-snapshot
  // and retry") — nonsense for a missing binary. Detect it the same way `doctor` does
  // (existsSync on the resolved path) and throw the TYPED code so the envelope carries
  // the right fix: a MISSING custom binary needs a path fix (cloakbrowser.dev), while a
  // missing BUNDLED binary needs `npx playwright install chromium`.
  if (!execPath || !existsSync(execPath)) {
    const code = customExec ? ('browser_execpath_missing' as const) : ('browser_missing' as const)
    throw Object.assign(new Error(code), { code })
  }

  // Resolve ONCE and persist: this is the TTL that governs this session for its
  // whole life, including when some other namespace's command sweeps it.
  const sessionTtlMs = resolveIdleTtlMs(opts.idleTimeoutMs)
  // Arm the lifeline's clock BEFORE deciding to use it. Once Chromium is running
  // with `--remote-debugging-pipe` there is no safe recovery from a failed
  // handover: holding our fd copies hangs the CLI, and dropping them leaves zero
  // writers on fd 3, so Chromium reads EOF and exits a browser we just started.
  // Arming first turns that unrecoverable state into a plain "no lifeline today".
  const deadlineFile = newDeadlineFile()
  const armed =
    lifelineEnabled(sessionTtlMs) &&
    (await fs
      .mkdir(dir, { recursive: true })
      .then(() => renewDeadline(dir, deadlineFile, sessionTtlMs))
      .then(() => true)
      .catch(() => false))
  const withLifeline = armed
  const args = [
    `--remote-debugging-port=${requestedPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    // deterministic viewport for reproducible snapshots/screenshots (P0-8)
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    // SSRF note (C1): the DNS-rebinding guard is a Node pre-check in egress.ts
    // (`assertNavigableResolved`), run BEFORE goto/fetch. We deliberately do NOT
    // pin `--host-resolver-rules` here — it would break legitimate resolution and
    // `localhost` — so a residual rebind TOCTOU between our lookup and Chromium's
    // own is accepted and documented (see egress.ts).
    // stealth: never advertise automation (spec §7) — note: NO --enable-automation.
    // CloakHQ de-tell: disable the Blink AutomationControlled feature, which is what
    // sets `navigator.webdriver = true` — the single most common headless tell. This
    // is a stable launch FLAG (authenticity: don't advertise automation), NOT fragile
    // JS canvas/WebGL spoofing (deliberately NOT reimplemented — see OpenOptions.execPath
    // for the real fingerprint fixes, which live in a stealth binary's compiled C++).
    // NOTE: this flag is now LOAD-BEARING for stealth, not merely nice-to-have.
    // `--remote-debugging-pipe` (added just below for the lifeline) maps straight
    // to Blink's EnableAutomationControlled feature, i.e. it turns
    // `navigator.webdriver` back ON. Chromium applies the explicitly-disabled
    // list LAST, so this line is what keeps it off — measured both ways, and
    // locked by a regression test. Never reorder these two.
    '--disable-blink-features=AutomationControlled',
    // The kill switch. Chromium's pipe thread blocks reading fd 3; when the last
    // writer closes, it reads EOF and shuts ITSELF down. The holder spawned after
    // this owns that fd, so an abandoned browser dies on its own clock instead of
    // waiting for some future CLI invocation to sweep it. The TCP debugging port
    // above is untouched — that is still how every later command reconnects.
    ...(withLifeline ? ['--remote-debugging-pipe'] : []),
    ...(opts.headed ? [] : ['--headless=new']),
    // Vercel-alignment: route through a proxy (unauthenticated). Applied at launch,
    // so it only affects a FRESH session. The value is operator-supplied argv, not
    // page-derived, so it is safe to pass verbatim; the egress guard still governs
    // which hosts navigation may reach (the proxy is transport, not a policy bypass).
    ...(opts.proxy ? [`--proxy-server=${opts.proxy}`] : []),
    // Detection coherence: the locale is set HERE, below CDP. `set locale` uses
    // Emulation.setLocaleOverride, which corrects a renderer that already booted
    // with another language — the correction is observable, and whatever was read
    // before it (the first request's Accept-Language) still carries the old value,
    // so a detector comparing the header against navigator.language finds a seam.
    // These are stock switches read at startup, so there is no earlier value to
    // contradict. Like --proxy above, this binds a FRESH session only; the CDP verb
    // remains for a session already running. Operator-supplied argv passed verbatim
    // — spawn takes an ARRAY, so there is no shell to escape for and nothing here
    // can split into a second argument. Empty string is treated as absent (same
    // truthiness gate --proxy uses): `--lang=` is worse than no flag at all.
    //
    // BOTH switches, because they are not redundant and neither alone is enough.
    // MEASURED on macOS against this spawn path: `--lang` alone moves NOTHING —
    // navigator.language, navigator.languages and Accept-Language all stay en-US,
    // because Chromium takes its app locale from the OS there and ignores the
    // switch. `--accept-lang` is what actually lands: header `de-DE,de;q=0.9`,
    // navigator.language `de-DE`. `--lang` is kept because it IS the switch that
    // carries the app/ICU locale on Linux and Windows, where silver mostly runs
    // headless — dropping it would fix macOS by breaking the common case.
    //
    // Known residual, and it is honest rather than incoherent: on macOS
    // `Intl.DateTimeFormat().resolvedOptions().locale` still reports the OS's
    // en-US. That is a configuration a real person has — a German speaker on an
    // English-language Mac — not an impossible one, so it is left alone. Forcing it
    // would mean an Emulation override, i.e. the exact runtime patch this avoids.
    ...(opts.locale ? [`--lang=${opts.locale}`, `--accept-lang=${opts.locale}`] : []),
    'about:blank',
  ]

  const child = spawn(execPath, args, {
    detached: true,
    // The other half of the launch-layer identity (see --lang above): ICU and libc
    // read TZ at process start, so Date/Intl in every renderer are born in the
    // right zone rather than being moved there by Emulation.setTimezoneOverride.
    // `env` REPLACES the child's environment instead of extending it, so ours has
    // to be spread back in — a browser launched without PATH/HOME fails in ways
    // nobody would trace to a timezone. Only passed when a timezone was asked for,
    // so the default stays plain inheritance rather than a snapshot of process.env.
    ...(opts.timezone ? { env: { ...process.env, TZ: opts.timezone } } : {}),
    // fds 3/4 carry `--remote-debugging-pipe` when the lifeline is on. Chromium
    // requires BOTH to be real pipes: pointing fd 4 at /dev/null instead makes
    // the browser exit the moment this CLI does (measured on Chrome 149).
    stdio: withLifeline
      ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'ignore'],
  })
  child.unref()

  const pid = child.pid
  if (pid === undefined) {
    throw new Error('failed to spawn the browser process')
  }

  let holderPid: number | undefined
  if (withLifeline) {
    // The clock already exists (armed above), so the holder's first poll reads a
    // real deadline rather than racing an absent file and exiting immediately.
    holderPid = spawnLifelineHolder(child, dir, deadlineFile)
    if (holderPid === undefined) {
      // The fds could not be handed over. Chromium is already running with the
      // pipe flag, so there is no version of this where it keeps working: kill it
      // and let the caller's retry come back through with `armed` false.
      releasePipeEnds(child)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      await fs.rm(path.join(dir, deadlineFile), { force: true }).catch(() => {})
      throw new Error('failed to hand the browser lifeline to a holder process')
    }
    // Only now is it safe to drop our copies: the holder owns the lifeline, and
    // holding them here would pin it open and keep the CLI's event loop alive.
    releasePipeEnds(child)
    // The previous generation's holder is retired by removing ITS clock — never
    // by signalling its recorded pid, which may have been recycled since.
    if (prior?.deadlineFile && prior.deadlineFile !== deadlineFile) {
      await fs.rm(path.join(dir, prior.deadlineFile), { force: true }).catch(() => {})
    }
  }

  try {
    // Single shared readiness budget (≤8s total): first learn the actual
    // (possibly auto-picked) port from `<userDataDir>/DevToolsActivePort`, then
    // confirm the CDP endpoint via /json/version.
    const deadline = Date.now() + READY_BUDGET_MS
    const port = await waitForDevToolsPort(userDataDir, deadline)
    const wsEndpoint = await waitForWsEndpoint(port, deadline)

    const info: SessionInfo = {
      port,
      pid,
      wsEndpoint,
      createdAt: new Date().toISOString(),
      engine: 'chromium',
      userDataDir,
      headed: Boolean(opts.headed),
      ...(customExec ? { execPath: customExec } : {}),
      ...(stickyRestore ? { restore: true } : {}),
      ...(holderPid !== undefined ? { holderPid, deadlineFile } : {}),
      idleTtlMs: sessionTtlMs,
    }
    await fs.mkdir(dir, { recursive: true })
    await writeSidecar(sidecarPath(name), info)
    return info
  } catch (err) {
    // Readiness failed — do not leave a zombie browser behind.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    // The holder we just spawned is watching a browser that never came up. Remove
    // the clock we minted for it and it exits on its next poll — no pid signal, so
    // nothing can be misdirected if that pid were ever recycled.
    await fs.rm(path.join(dir, deadlineFile), { force: true }).catch(() => {})
    throw err
  }
}

async function waitForDevToolsPort(userDataDir: string, deadline: number): Promise<number> {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(file, 'utf8')
      const firstLine = content.split('\n', 1)[0]?.trim()
      const port = firstLine ? Number.parseInt(firstLine, 10) : Number.NaN
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      /* file not written yet */
    }
    await delay(100)
  }
  throw new Error('the browser did not expose a debugging port in time')
}

async function waitForWsEndpoint(port: number, deadline: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/json/version`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: unknown }
        if (typeof body.webSocketDebuggerUrl === 'string' && body.webSocketDebuggerUrl.length > 0) {
          return body.webSocketDebuggerUrl
        }
      }
    } catch {
      /* endpoint not up yet */
    }
    await delay(100)
  }
  throw new Error('the browser debugging endpoint did not respond in time')
}

/** Read the sidecar for a session. Throws generically if absent/corrupt. */
export async function readSidecar(name: string): Promise<SessionInfo> {
  const p = sidecarPath(name)
  try {
    await fs.access(p)
  } catch {
    throw new Error('no such session (open one first)')
  }
  try {
    return await readSidecarObject<SessionInfo>(p)
  } catch {
    throw new Error('the session sidecar is corrupt')
  }
}

/**
 * Connect over CDP to the running detached browser. Returns the first context
 * and first page (creating a page if the context somehow has none). The caller
 * MUST `browser.close()` when done — for a connectOverCDP browser that only
 * disconnects the CDP transport; the detached browser process stays alive.
 */
/**
 * Default idle TTL before an unused session's browser is reaped: 30 minutes.
 *
 * Chosen against the two failure modes. Too short breaks the lean loop — silver's
 * whole premise is that `open` spawns a daemon that OUTLIVES the CLI invocation,
 * so a human (or an agent between tool calls) can take a break mid-task. Too long
 * is what produced the incident this exists to prevent: 105 orphaned daemons,
 * ~65 GB RSS, the oldest 25 hours dead. 30 min is longer than any real
 * think-time gap and far shorter than an overnight leak.
 *
 * A session that is actively used never ages: `connect()` touches `lastUsedAt`
 * on EVERY command, so the clock only runs while nothing is driving the browser.
 */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000

/** Resolve the idle TTL: explicit arg → `SILVER_SESSION_IDLE_MS` → default.
 * `0` (or any non-positive / unparseable value) DISABLES reaping — the documented
 * escape hatch for a deliberately long-lived session. */
export function resolveIdleTtlMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
  const raw = process.env.SILVER_SESSION_IDLE_MS
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return DEFAULT_SESSION_IDLE_MS
}

/** Best-effort: stamp `lastUsedAt` on the session's sidecar. Never throws. */
export async function touchSession(name: string): Promise<void> {
  let info: SessionInfo | null = null
  try {
    info = await readSidecar(name)
    await writeSidecar(sidecarPath(name), { ...info, lastUsedAt: new Date().toISOString() })
  } catch {
    /* a sidecar we cannot read or rewrite ages out on createdAt — see lastUsedAt */
  }
  // Renew THIS generation's clock with THIS session's own TTL, so a command run
  // with a different `SILVER_SESSION_IDLE_MS` cannot re-time someone else's
  // browser. No recorded file means no lifeline was attached; nothing to feed.
  if (info?.deadlineFile) {
    await renewDeadline(sessionDir(name), info.deadlineFile, info.idleTtlMs).catch(() => {})
  }
}

/**
 * The lifeline holder's clock: `<sessionDir>/.deadline`, epoch SECONDS, plaintext.
 *
 * Deliberately NOT the encrypted sidecar. The holder is three lines of `sh` and
 * must read this on a timer; a wall-clock deadline is not secret, and keeping the
 * holder unable to decrypt anything is the point. Precomputing the deadline rather
 * than storing a last-used stamp is Aside's `routines.next_run_at` shape — the
 * watcher does one integer compare and needs no policy of its own.
 */
function deadlinePath(dir: string, file: string): string {
  return path.join(dir, file)
}

/**
 * A fresh, generation-unique clock filename.
 *
 * Each `openSession` mints a new one so the PREVIOUS generation's holder can be
 * retired by unlinking ITS file — never by signalling a pid. A holder pid read
 * back off a sidecar can be stale (the sidecar outlives reboots, and pids are
 * recycled), so signalling it risks SIGTERMing an unrelated process the user
 * owns. Unlinking a path we minted cannot be misdirected.
 */
function newDeadlineFile(): string {
  return `.deadline-${process.pid}-${Date.now()}`
}

/**
 * A deadline far enough out that the holder will never fire it.
 *
 * Used when the TTL is disabled AFTER a session was opened with one. Returning
 * early would leave the ORIGINAL deadline on disk and the already-attached holder
 * would still kill the browser at it — turning the documented "this browser
 * outlives everything" escape hatch into a timed execution.
 */
const NEVER_SECONDS = 100 * 365 * 24 * 60 * 60

/**
 * Push this session's death clock out by one idle TTL. Called on every `connect`
 * (via `touchSession`), so a session actively being driven never reaches its
 * deadline — the same "in use never ages" rule the sweeper follows, enforced by
 * the holder instead of by a future CLI invocation.
 *
 * A TTL of `0` (reaping disabled) writes no deadline at all: no lifeline is
 * attached in that mode, so there is no holder to feed.
 */
async function renewDeadline(dir: string, file: string, ttlMs?: number): Promise<void> {
  const ttl = ttlMs ?? resolveIdleTtlMs()
  // Disabled TTL still writes — a far-future clock, so an ALREADY-ATTACHED holder
  // is disarmed rather than left counting down to the previous deadline.
  const seconds =
    Number.isFinite(ttl) && ttl > 0
      ? Math.floor((Date.now() + ttl) / 1000)
      : Math.floor(Date.now() / 1000) + NEVER_SECONDS
  // ATOMIC. `fs.writeFile` truncates and then writes in a later turn, so a holder
  // polling mid-renewal can read a ZERO-LENGTH file — which its validity check
  // reads as "no clock, exit now", killing a healthy browser that is actively
  // being driven. Measured at ~1.5% of wall time under a tight renew loop. Write
  // to a temp file and rename: rename(2) is atomic within a directory, so the
  // holder always sees a complete old-or-new value. Same discipline as the
  // sidecars' `atomicWrite`.
  const target = deadlinePath(dir, file)
  const tmp = `${target}.tmp.${process.pid}`
  await fs.writeFile(tmp, `${seconds}\n`, 'utf8')
  try {
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * The lifeline holder, as POSIX `sh`. Passed inline via `sh -c` so nothing has to
 * be packaged, installed, or found on disk at runtime.
 *
 * It inherits two file descriptors from the browser's `--remote-debugging-pipe`:
 *   fd 3 — the write end of Chromium's CDP READ pipe. **This is the lifeline.**
 *          Chromium's pipe thread blocks on `read()`; when the last writer closes,
 *          it reads EOF and runs its own `CloseBrowserSoon`. So the browser dies
 *          because the kernel refcounted this fd to zero — no signal, no timer, no
 *          cooperation, and it fires even on `kill -9` of everything else.
 *   fd 4 — the read end of Chromium's CDP WRITE pipe. Drained to `/dev/null` so a
 *          full pipe buffer can never block Chromium's writer thread. Measured:
 *          Chromium REQUIRES both to be real pipes — pointing fd 4 at `/dev/null`
 *          at spawn makes the browser exit as soon as the CLI does.
 *
 * The drainer runs as a background subshell that **closes fd 3 first** (`exec 3<&-`).
 * That detail is load-bearing: a `trap` cannot run on SIGKILL, so if the drainer
 * still held fd 3, `kill -9` on the holder would leave the lifeline open and the
 * browser immortal. With fd 3 closed there, SIGKILLing the holder drops the last
 * writer and the browser dies anyway — verified. The orphaned drainer then reads
 * EOF on fd 4 as the browser exits and terminates itself.
 *
 * Exit conditions: the deadline passes, or the deadline file disappears (which is
 * how `close` and the sweeper's `rm -rf` also collapse the lifeline).
 */
const HOLDER_SH = `
( exec 3<&- ; cat <&4 >/dev/null 2>&1 ) &
DRAIN=$!
exec 4<&-
trap 'kill "$DRAIN" 2>/dev/null' EXIT
trap 'exit 0' INT TERM HUP
miss=0
while :; do
  if [ ! -e "$1" ]; then exit 0; fi
  d=""
  read -r d < "$1" 2>/dev/null
  case "$d" in
    ''|*[!0-9]*)
      miss=$((miss+1))
      [ "$miss" -ge 3 ] && exit 0
      sleep 1
      continue
      ;;
  esac
  miss=0
  if [ "$(date +%s)" -ge "$d" ]; then
    p=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$2" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      sleep 5
      continue
    fi
    exit 0
  fi
  sleep 5
done
`

/** How often the holder re-reads its deadline. Matches HOLDER_SH's `sleep`. */
export const HOLDER_POLL_SECONDS = 5

/**
 * Hand the browser's pipe file descriptors to a detached holder process.
 *
 * Returns the holder's pid, or `undefined` if no lifeline could be attached — in
 * which case the caller simply keeps the sweep-only behavior. Every failure here
 * is non-fatal by design: a browser with no lifeline is exactly what Silver
 * shipped before, not a broken one.
 */
function spawnLifelineHolder(
  child: ChildProcess,
  dir: string,
  file: string,
): number | undefined {
  try {
    const rd = child.stdio[3] as { _handle?: { fd?: number } } | null | undefined
    const wr = child.stdio[4] as { _handle?: { fd?: number } } | null | undefined
    const fd3 = rd?._handle?.fd
    const fd4 = wr?._handle?.fd
    if (typeof fd3 !== 'number' || typeof fd4 !== 'number') return undefined
    const holder = spawn(
      '/bin/sh',
      ['-c', HOLDER_SH, 'silver-holder', deadlinePath(dir, file), path.join(dir, '.lock')],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', fd3, fd4],
      },
    )
    holder.unref()
    return holder.pid
  } catch {
    return undefined // no lifeline; the global sweep remains the backstop
  }
}

/**
 * Release THIS process's copies of the browser's pipe ends.
 *
 * Must run on every path once the handover attempt is over — success or failure.
 * Two things go wrong otherwise: the CLI stays a writer on fd 3, so the lifeline
 * never reaches EOF (and an in-process caller like the test suite masks a holder
 * that already exited); and the sockets stay referenced by the event loop, so
 * `silver open` never exits. The second is why this cannot live only on the
 * success path — the failure path is exactly the full-disk machine this feature
 * exists for.
 */
function releasePipeEnds(child: ChildProcess): void {
  ;(child.stdio[3] as { destroy?: () => void } | null)?.destroy?.()
  ;(child.stdio[4] as { destroy?: () => void } | null)?.destroy?.()
}

/**
 * Should this session get a kernel-enforced lifeline?
 *
 * No when reaping is disabled (`SILVER_SESSION_IDLE_MS=0` is the documented "this
 * browser must outlive everything" escape hatch — attaching a death switch there
 * would silently break it), and no on win32, where extra-fd inheritance and
 * process detachment do not work the way this depends on.
 */
function lifelineEnabled(ttl: number): boolean {
  if (process.platform === 'win32') return false
  return Number.isFinite(ttl) && ttl > 0
}

/** Millis since this session was last touched (falls back to createdAt). */
function idleMsOf(info: SessionInfo): number {
  const stamp = info.lastUsedAt ?? info.createdAt
  const t = Date.parse(stamp)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Date.now() - t
}

/** A session located on disk by absolute path, independent of the ACTIVE namespace. */
type DiscoveredSession = {
  /** Owning namespace ('' for the un-namespaced root). */
  ns: string
  /** Session name (the dir name under that namespace's `sessions/`). */
  name: string
  /** Absolute session dir. */
  dir: string
  /**
   * Display label. Bare `<name>` for the caller's OWN namespace and for the
   * un-namespaced root (both unambiguous from where the caller stands);
   * `<ns>/<name>` for anything else, so two `default`s are never confused.
   * Keeping own-namespace labels bare preserves the pre-global output contract.
   */
  key: string
}

/** True while a live process holds this session's advisory lock — see `isSessionBusy`. */
export async function isSessionDirBusy(dir: string): Promise<boolean> {
  return isSessionBusy(dir)
}

/**
 * Grace before a SIDECAR-LESS dir in ANOTHER namespace may be removed as an orphan.
 *
 * `openSession` creates the profile dir and only writes the sidecar once the
 * browser's CDP endpoint answers (up to `READY_BUDGET_MS`), so a mid-spawn session
 * is briefly indistinguishable on disk from an abandoned one. Inside the caller's
 * OWN namespace that window is covered by the session lock and gc stays immediate
 * (the long-standing contract). Across namespaces — dirs this caller did not create
 * and cannot reason about — we additionally wait out the grace rather than risk
 * deleting a sibling's profile mid-spawn.
 */
export const ORPHAN_GRACE_MS = 60_000

/**
 * Enumerate EVERY session on this machine — across ALL namespaces.
 *
 * This is the fix for the parallel-agent leak. `sessionsRoot()` is scoped to the
 * ACTIVE namespace, and SKILL.md tells a fleet to isolate agent-GROUPS with
 * `--namespace`, so N parallel agents put their browsers under N different roots.
 * A namespace-scoped sweep therefore cannot see any browser but its own group's:
 * the reaper was self-limiting WITHIN a namespace and unbounded ACROSS them,
 * which is exactly the shape a fleet produces (226 namespaces on the machine that
 * motivated this, with a 3-hour-idle orphan still holding ~1.5 GB).
 *
 * Layout: `~/.silver/sessions/<name>` (un-namespaced) and `~/.silver/<ns>/sessions/<name>`.
 * A dir under `~/.silver` with no `sessions/` child (`memory`, `tasks`, …) is skipped.
 * Best-effort throughout: an unreadable root yields no sessions rather than throwing.
 */
export async function discoverAllSessions(): Promise<DiscoveredSession[]> {
  const base = silverHome()
  const found: DiscoveredSession[] = []

  const activeNs = currentNamespace()
  /** A relocated `~/.silver` commonly symlinks a root onto another volume; a
   * Dirent for a symlink reports isDirectory() === false, which would silently
   * turn the whole sweep into a no-op. Fall back to a stat that follows it. */
  const isDir = async (parent: string, e: { name: string; isDirectory(): boolean }) =>
    e.isDirectory() ||
    (await fs
      .stat(path.join(parent, e.name))
      .then((st) => st.isDirectory())
      .catch(() => false))

  const collect = async (ns: string, root: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!(await isDir(root, e))) continue
      const dir = path.join(root, e.name)
      // POSITIVE evidence required. Every top-level dir under ~/.silver is treated
      // as a candidate namespace, so a sibling layer whose own subdir happens to be
      // named `sessions` — `~/.silver/tasks/<id>/…`, and `sessions` is a legal task
      // id — would otherwise present its run dirs as sidecar-less "sessions" and be
      // rm -rf'd as orphans. `session list` already uses exactly this test.
      const looksLikeSession =
        existsSync(path.join(dir, 'session.json')) || existsSync(path.join(dir, 'profile'))
      if (!looksLikeSession) continue
      found.push({
        ns,
        name: e.name,
        dir,
        // Bare ONLY for the caller's own namespace. Labelling the un-namespaced
        // root bare as well made `~/.silver/sessions/default` and
        // `~/.silver/<ns>/sessions/default` collide on one key in gc output.
        key: ns === activeNs ? e.name : `${ns || '(root)'}/${e.name}`,
      })
    }
  }

  let top
  try {
    top = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of top) {
    if (!(await isDir(base, e))) continue
    // `~/.silver/sessions` is the un-namespaced root; every other dir is a
    // candidate namespace whose sessions live one level deeper.
    if (e.name === 'sessions') await collect('', path.join(base, 'sessions'))
    else await collect(e.name, path.join(base, e.name, 'sessions'))
  }
  return found
}

/**
 * Is a live command currently holding this session's lock?
 *
 * The idle clock (`lastUsedAt`) is stamped by `connect()` at the START of a
 * command, so a single long-running command (`wait --timeout 200000`, a slow
 * `extract`) keeps aging while it runs. Under a short `SILVER_SESSION_IDLE_MS`
 * a concurrent global sweep could therefore kill a browser out from under a
 * command that is actively driving it. The per-session lockfile is the existing,
 * authoritative "someone is working here" signal — a LIVE holder means hands off,
 * whatever the idle stamp says. Reads the raw record directly (not lock.ts's
 * namespace-scoped helpers) because we sweep by absolute path.
 */
async function isSessionBusy(dir: string): Promise<boolean> {
  try {
    const rec = JSON.parse(await fs.readFile(path.join(dir, '.lock'), 'utf8')) as {
      pid?: number
    }
    return typeof rec.pid === 'number' && rec.pid > 0 && isPidAlive(rec.pid)
  } catch {
    return false // no lock, or a corrupt/unreadable one — not a reason to keep a leak
  }
}

/**
 * Kill the browsers of sessions idle longer than `ttlMs` and remove their dirs,
 * ACROSS EVERY NAMESPACE on this machine.
 *
 * This is the missing half of `session gc`: gc reaps sessions whose process is
 * already DEAD (cleaning up disk), which by construction can never reclaim a
 * live-but-abandoned daemon's memory. Without this, an `open` that is never
 * paired with a `close` leaks a ~600 MB browser forever — and agents that spawn
 * a session per unit of work leak one each.
 *
 * The sweep is GLOBAL by design: a per-namespace sweep is structurally unable to
 * reclaim a parallel fleet's browsers (see `discoverAllSessions`). The TTL, not
 * the namespace boundary, is what keeps it safe — namespaces isolate STATE so two
 * agent-groups never collide on `--session default`; they were never a permission
 * boundary over each other's OS processes, and treating them as one is what let
 * the machine fill up.
 *
 * NEVER reaps: external (`connect`ed) sessions — we do not own that process — a
 * session whose lockfile shows a LIVE holder (a command is mid-flight), the
 * caller's own session (`exclude`, matched within the caller's namespace only),
 * or anything when `ttlMs <= 0`. Entirely best-effort: a failure to reap one
 * session must not fail the command that opportunistically triggered the sweep.
 *
 * Returned names are namespace-qualified (`<ns>/<name>`) for anything outside the
 * active namespace, so a caller can tell two `default`s apart.
 */
export async function reapIdleSessions(
  ttlMs: number = resolveIdleTtlMs(),
  exclude?: string,
  opts: { overrideSessionTtl?: boolean } = {},
): Promise<{ reaped: string[]; keptAlive: string[] }> {
  const reaped: string[] = []
  const keptAlive: string[] = []
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return { reaped, keptAlive }

  const activeNs = currentNamespace()
  for (const s of await discoverAllSessions()) {
    // `exclude` is the caller's OWN session, mid-`open`. Match it namespace-
    // qualified: `default` is the most common session name, so a bare-name
    // exclude would shield every other agent's `default` and reopen the leak.
    if (exclude !== undefined && s.name === exclude && s.ns === activeNs) continue
    let info: SessionInfo | null = null
    try {
      info = await readSidecarObject<SessionInfo>(path.join(s.dir, 'session.json'))
    } catch {
      continue // no/corrupt sidecar — that is plain `session gc`'s job, not ours
    }
    // We only reap browsers we own and that are still running.
    if (info.external || !isPidAlive(info.pid)) continue
    // The session's OWN TTL wins over the sweeping process's — but only for an
    // AMBIENT sweep. The sweep is global, so without this the shortest TTL anywhere
    // on the machine would govern every namespace, and a session opened with
    // `SILVER_SESSION_IDLE_MS=0` ("outlives everything") would be reaped by any
    // unrelated command running the default. An operator who types an explicit
    // `session gc <idleMs>` is not ambient: they are asking for exactly this, on
    // purpose, and their number wins. (Same split as a platform's renewable lease
    // vs. its explicit release call.)
    const effectiveTtl =
      !opts.overrideSessionTtl && typeof info.idleTtlMs === 'number' ? info.idleTtlMs : ttlMs
    if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
      keptAlive.push(s.key)
      continue
    }
    if (idleMsOf(info) < effectiveTtl) {
      keptAlive.push(s.key)
      continue
    }
    if (await isSessionBusy(s.dir)) {
      keptAlive.push(s.key)
      continue
    }
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch {
      /* already gone between the liveness check and here */
    }
    // Removing the dir takes the clock with it, so the lifeline holder exits on
    // its next poll and drops the pipe — a second, independent route to killing a
    // browser whose main pid ignored SIGTERM.
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {})
    reaped.push(s.key)
  }
  return { reaped, keptAlive }
}

// ---------------------------------------------------------------------------
// Browser ceiling — the hard bound on how much of the machine silver may hold.
//
// The idle reaper bounds how LONG an abandoned browser lives (one TTL). Nothing
// bounded how MANY run at once, and a session is a whole Chromium: measured on
// this machine, one session parked on an animating page costs ~10 OS processes
// and ~1.17 GB RSS. Three of them is 3.5 GB; a day's fleet is the machine. The
// same three pages as three TABS of ONE session: 12 processes, 1.39 GB — which
// is why the parallel guidance now leads with tabs, and why this ceiling exists
// for the case where an agent opens sessions anyway.
// ---------------------------------------------------------------------------

/**
 * Default number of silver-owned browsers allowed to run at once, machine-wide.
 *
 * Three, because that is the point where the shape stops being free on a laptop:
 * ~3.5 GB of the 18 GB this was measured on, and the fourth is the one that
 * starts swapping under an editor and a dev server. It is a CEILING, not a
 * quota — a fleet still gets its parallelism, it just gets it as tabs (which
 * cost ~100 MB each) instead of as browsers.
 */
export const DEFAULT_MAX_BROWSERS = 3

/** Resolve the ceiling: `SILVER_MAX_BROWSERS` → default. `0` disables it. */
export function resolveMaxBrowsers(): number {
  const raw = process.env.SILVER_MAX_BROWSERS
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return DEFAULT_MAX_BROWSERS
}

/**
 * The sessions the last `enforceBrowserCeiling` stopped, waiting to be reported.
 *
 * A cap that silently drops work is worse than no cap — the whole complaint
 * this feature answers is "silver eats my machine and I cannot see why". The
 * notice is read once by the `open` handler and cleared, so it lands on the
 * envelope of the command that caused the eviction and never on a later one.
 */
let evictionNotice: string[] = []

/**
 * How long the ceiling waits for the browsers it SIGTERMed to actually exit, and
 * how often it looks. Short on purpose: this sits on the `open` path, so the
 * budget is the delay a user pays when a browser will not die. It is paid ONCE
 * per `enforceBrowserCeiling` call, not once per evicted browser — they shut
 * down in parallel and are waited on together.
 *
 * Half a second is enough for a Chromium that is going to exit at all, and short
 * enough that a wedged one costs the command almost nothing. A browser that is
 * merely SLOW (a heavy page's unload handlers) is simply not reported — the
 * eviction still happened, so this trades a false negative in the notice for a
 * bounded delay, which is the right way round.
 */
const EVICT_EXIT_BUDGET_MS = 500
const EVICT_POLL_MS = 50

/** Take (and clear) the sessions the ceiling stopped for the current command. */
export function takeEvictionNotice(): string[] {
  const out = evictionNotice
  evictionNotice = []
  return out
}

/**
 * Stop the least-recently-used silver browsers until spawning one more stays
 * within `resolveMaxBrowsers()`, machine-wide across every namespace.
 *
 * "Stop", not "reap": the browser is SIGTERMed but its session dir — profile,
 * cookies, sidecars — is left exactly where it is. That is the whole reason a
 * ceiling is safe to enforce automatically. `ensureConnected` already treats a
 * dead pid as "respawn me", so an evicted session's next command brings the
 * browser back with its logged-in profile intact; the only thing lost is the
 * page's in-memory state, the same thing lost to a machine going to sleep.
 * (`reapIdleSessions` deletes the dir — correct for a session nobody has
 * touched in an hour, far too destructive for one being pushed out by load.)
 *
 * NEVER stops: an external (`connect`ed) browser we do not own, a HEADED session
 * a human is watching (see the filter below), a session whose lockfile shows a
 * LIVE holder (a command is mid-flight — see `isSessionBusy`), or `exclude` (the
 * caller's own session, mid-open). If everything over the cap is busy, nothing is
 * stopped and the spawn proceeds: a real command in flight outranks a memory
 * target. Returns the stopped sessions, namespace-qualified — only the ones
 * OBSERVED to have exited, never the ones merely signalled.
 */
export async function enforceBrowserCeiling(exclude?: string): Promise<string[]> {
  const cap = resolveMaxBrowsers()
  if (cap <= 0) return []
  const activeNs = currentNamespace()
  const live: Array<{ key: string; dir: string; pid: number; idle: number }> = []
  for (const s of await discoverAllSessions()) {
    if (exclude !== undefined && s.name === exclude && s.ns === activeNs) continue
    let info: SessionInfo
    try {
      info = await readSidecarObject<SessionInfo>(path.join(s.dir, 'session.json'))
    } catch {
      continue // no/corrupt sidecar — `session gc`'s problem, not the ceiling's
    }
    // `headed` sits beside `external` because the other two mechanisms on this
    // path already refuse it, and this is the one that cannot be undone.
    // `parkPages` will not FREEZE a headed session and `shouldEmulateViewport`
    // will not RESIZE one, both on the ground that a human asked to watch that
    // window — so the ceiling, which SIGTERMs the process, must not be the single
    // mechanism that reaches into it. Worse than inconsistent: a watched window is
    // by construction the most IDLE session on the machine (nobody issues commands
    // against a page they are reading), so LRU picked it FIRST — the window a
    // human was looking at was the first one the cap took, and it took it with
    // whatever was in the page (a half-filled form, a scroll position) still in it.
    //
    // The cost is real and accepted: a fleet that leaves headed sessions open can
    // hold the machine above the cap, because the ceiling has nothing left it may
    // stop. That is the same trade `isSessionBusy` already makes (a real command
    // in flight outranks a memory target) — a headed window is a HUMAN in flight,
    // and the honest response to "everything is off-limits" is to leave the cap
    // unmet rather than to kill the one thing someone is looking at.
    //
    // It does NOT make a headed session immortal, which is the objection that
    // would otherwise argue this line back out. `reapIdleSessions` still reclaims
    // it after the idle TTL, deliberately without the same exclusion: the reaper
    // fires on TIME (an hour with no command against this session is real evidence
    // nobody is watching), while the ceiling fires because SOMEBODY ELSE wants
    // memory right now — which is evidence about the fleet and none at all about
    // whether a person is looking at this window.
    if (info.external || info.headed || !isPidAlive(info.pid)) continue
    live.push({ key: s.key, dir: s.dir, pid: info.pid, idle: idleMsOf(info) })
  }
  // The caller is about to spawn one more, so the budget for everyone else is
  // cap - 1. A cap of 1 therefore means "one browser at a time", not zero.
  const over = live.length - (cap - 1)
  if (over <= 0) return []
  live.sort((a, b) => b.idle - a.idle) // most-idle first: LRU eviction

  // PHASE 1 — signal, at most `over` of them.
  //
  // The SIGTERM is what costs a session its page, so the SIGTERM is what counts
  // against `over`. Counting CONFIRMED EXITS instead is a real bug that shipped
  // here: a healthy browser that took longer than the budget to shut down fell
  // through to the next candidate and got it killed too, so a cap needing one
  // eviction stopped two browsers and reported neither. Nothing below this loop
  // sends a signal, which is what makes the bound checkable.
  const signalled: Array<{ key: string; pid: number }> = []
  for (const cand of live) {
    if (signalled.length >= over) break
    if (await isSessionBusy(cand.dir)) continue
    try {
      process.kill(cand.pid, 'SIGTERM')
    } catch {
      continue // already gone between the liveness check and here: no signal, no cost
    }
    signalled.push({ key: cand.key, pid: cand.pid })
  }

  // PHASE 2 — confirm, under ONE budget shared by all of them.
  //
  // `process.kill` reports that the signal was DELIVERED, not that anything died:
  // a Chromium wedged in a `beforeunload` handler survives it. Reporting on
  // delivery told the host memory was freed that is still held, so a browser is
  // claimed only once its pid is observed gone. The budget is shared because the
  // browsers are shutting down in PARALLEL — waiting on each in turn would
  // multiply this delay on the `open` path by the number evicted.
  //
  // A survivor is dropped from the report, NOT escalated. SIGKILL cannot be
  // ignored, so escalating would make every candidate "succeed" — the same false
  // report with extra steps — and it orphans the renderers (see
  // `killProcessGroup`), the leak this whole area exists to stop; it also breaks
  // the "SIGTERM, keep the profile" posture that makes automatic eviction safe.
  // The cost of dropping it is a cap left unmet by one browser, which is the
  // cheaper error: the alternative is to keep killing until something dies, and
  // the ceiling is not worth an unbounded body count.
  const deadline = Date.now() + EVICT_EXIT_BUDGET_MS
  while (Date.now() < deadline && signalled.some((s) => isPidAlive(s.pid))) {
    await delay(EVICT_POLL_MS)
  }
  return signalled.filter((s) => !isPidAlive(s.pid)).map((s) => s.key)
}

/**
 * How often the opportunistic safety-net sweep may actually run, machine-wide.
 * The sweep itself is a readdir over `~/.silver` plus a stat per session, so it
 * is cheap — but it is on the hot path of EVERY command, and a fleet can issue
 * thousands per minute. Throttling to once every 60s amortizes it to nothing
 * while still bounding an abandoned browser's life to ~one idle-TTL.
 */
const SWEEP_THROTTLE_MS = 60_000

/** Machine-wide stamp of the last safety-net sweep (shared by every namespace). */
function sweepStampPath(): string {
  return path.join(silverHome(), '.last-sweep')
}

/**
 * Run a global idle sweep at most once per `SWEEP_THROTTLE_MS`, machine-wide.
 *
 * Layer 2 of the leak fix, and explicitly the SAFETY NET rather than the primary
 * path (the per-browser lease in `openSession` is primary — same two-layer shape
 * Vercel uses: a bounded-at-birth timer backed by a periodic stale sweeper).
 * Without it, reaping only ever happened on the next `open`, so the LAST browser
 * a fleet abandoned lived until someone happened to run silver again.
 *
 * The stamp is written BEFORE sweeping so concurrent commands don't all sweep;
 * if two race the window through, the sweep is idempotent (killing a dead pid
 * and removing an absent dir are both no-ops). Entirely best-effort: never
 * throws, never blocks the command that triggered it for long.
 */
export async function maybeSweepIdleSessions(exclude?: string): Promise<void> {
  const ttl = resolveIdleTtlMs()
  if (!Number.isFinite(ttl) || ttl <= 0) return // reaping disabled → no sweep either
  const stamp = sweepStampPath()
  try {
    const last = await fs.readFile(stamp, 'utf8').then((s) => Number(s.trim()))
    if (Number.isFinite(last) && Date.now() - last < SWEEP_THROTTLE_MS) return
  } catch {
    /* no stamp yet — this is the first sweep on this machine */
  }
  try {
    await fs.mkdir(path.dirname(stamp), { recursive: true })
    await fs.writeFile(stamp, String(Date.now()), 'utf8')
  } catch {
    return // cannot claim the sweep slot — skip rather than let every command sweep
  }
  await reapIdleSessions(ttl, exclude).catch(() => {})
}


/**
 * Read the browser's REAL `prefers-color-scheme`, over raw CDP, BEFORE Playwright
 * touches it.
 *
 * `connectOverCDP` silently applies its context default (`colorScheme: 'light'`)
 * to EVERY page in the browser it attaches to, and drops it again on disconnect.
 * On a browser silver owns nobody sees that. On the user's own browser it is
 * glaring: with an agent working, every command flips all their tabs to light and
 * back, so the whole browser strobes.
 *
 * It cannot be cleared once connected — measured, in this order, against a raw-CDP
 * oracle rather than through Playwright (which reports its own emulated view and
 * will happily tell you everything is fine):
 *   - baseline                                  dark
 *   - after connectOverCDP                      light
 *   - after CDP setEmulatedMedia({features:[]}) light   (does NOT clear it)
 *   - after emulateMedia({colorScheme:'dark'})  dark    (only this works)
 * So the only way to leave the pages looking right is to know what they SHOULD
 * say and assert it — which means asking before Playwright arrives.
 *
 * Best-effort and bounded: any failure returns null and the caller simply skips
 * the correction. Never throws, never blocks a command for long.
 */
async function probeRealColorScheme(wsEndpoint: string): Promise<'dark' | 'light' | null> {
  try {
    const m = /^ws:\/\/([^/]+)\//.exec(wsEndpoint)
    if (!m) return null
    const res = await fetch(`http://${m[1]}/json/list`, { signal: AbortSignal.timeout(1500) })
    const targets = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>
    const page = targets.find(
      (t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && /^https?:/.test(t.url ?? ''),
    )
    if (!page?.webSocketDebuggerUrl) return null
    return await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl as string)
      const done = (v: 'dark' | 'light' | null): void => {
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        resolve(v)
      }
      const timer = setTimeout(() => done(null), 1500)
      ws.onerror = () => {
        clearTimeout(timer)
        done(null)
      }
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
              returnByValue: true,
            },
          }),
        )
      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } }
          if (msg.id !== 1) return
          clearTimeout(timer)
          const v = msg.result?.result?.value
          done(v === 'dark' || v === 'light' ? v : null)
        } catch {
          clearTimeout(timer)
          done(null)
        }
      }
    })
  } catch {
    return null
  }
}

export async function connect(name: string): Promise<Connection> {
  const info = await readSidecar(name)
  // F1: a stale non-chromium sidecar (written before this engine was rejected)
  // must fail LOUD here too — its CDP-only verbs could never work. Defense in
  // depth: `openSession` no longer creates such sidecars.
  assertChromiumEngine(normalizeEngine(info.engine))
  // PID-liveness (P1-S1): a stale sidecar whose browser died would otherwise
  // hang on a dead CDP endpoint. Treat a dead pid as "no live session" so the
  // caller (ensureConnected) re-spawns instead. Skipped for EXTERNAL sessions:
  // we do not own the process (pid is unknown/0) — liveness is the CDP connect
  // succeeding, and a failure must NOT trigger an owned-browser respawn.
  if (!info.external && !isPidAlive(info.pid)) {
    throw new Error('the previous browser process is gone (reopen the session)')
  }
  const chromium = await loadChromium()
  // Ask BEFORE Playwright arrives and overwrites the answer — external sessions
  // only, since that is where a human is looking at these tabs.
  const realScheme = info.external === true ? await probeRealColorScheme(info.wsEndpoint) : null
  const browser = await chromium.connectOverCDP(info.wsEndpoint)
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close().catch(() => {})
    throw new Error('the browser has no available context')
  }
  // Put the pages back to what they really said. Playwright applied `light` to ALL
  // of them the moment we connected, and only emulateMedia can override it.
  //
  // Order matters and is the whole point: the FIRST page is corrected and awaited
  // (~60ms), the rest are fired without blocking the command (~300ms for a dozen
  // tabs, all of it invisible because nobody is looking at a background tab). This
  // is MITIGATION, not a cure — Playwright pushes the emulation as part of
  // attaching, so a brief flash before the correction lands is unavoidable while
  // silver reconnects per command. Eliminating it entirely would mean holding one
  // Playwright connection open for the session's lifetime.
  if (realScheme !== null) {
    const open = context.pages()
    if (open.length > 0) {
      await open[0].emulateMedia({ colorScheme: realScheme }).catch(() => {})
      void Promise.allSettled(
        open.slice(1).map((p) => p.emulateMedia({ colorScheme: realScheme })),
      )
    }
  }
  const page = context.pages()[0] ?? (await context.newPage())
  // Idle-reaper clock: record that this session was actually touched. Strictly
  // best-effort — a failed touch must never fail the command that triggered it,
  // and a session whose sidecar we cannot rewrite simply ages out on createdAt.
  await touchSession(name).catch(() => {})
  // Safety-net sweep (leak fix, layer 2). Deliberately AFTER the touch above, so
  // this session's own clock is already reset and it cannot reap the browser it
  // is connecting to; `name` is excluded as belt-and-braces. Piggybacking the
  // sweep on `open` alone was not enough — a fleet that finishes its work never
  // calls `open` again, so the last browsers were never reclaimed. Every command
  // sweeps now, throttled so the cost is amortized to ~nothing.
  await maybeSweepIdleSessions(name)
  // Deterministic viewport (P0-8); best-effort over a CDP-connected page — but
  // only where claiming it is TRUE. See `shouldEmulateViewport`: unconditionally
  // this made a headed browser report a window with no chrome (an automation
  // tell), and resized the user's own window on every command in a `connect`ed
  // one. A persisted `set viewport` still applies afterwards via applyEmulation,
  // so a host that explicitly wants a fixed size in a headed session still gets it.
  if (shouldEmulateViewport(info)) {
    await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height }).catch(() => {})
  }
  // S2: re-arm the CDP Fetch-layer subresource egress guard on EVERY connect (the
  // per-command reconnect model means it must be re-enabled each time). Never
  // blocks the connect itself — a failure to arm is swallowed.
  await enableFetchEgressGuard(context, fetchEgressPolicy).catch(() => {})
  return { browser, context, page, info }
}

/**
 * Freeze every page in a browser silver OWNS, right before dropping the CDP
 * transport at the end of a command.
 *
 * Silver is command-scoped: `connect` → act → disconnect, and between commands
 * NOBODY is looking at the page. A headless Chromium disagrees — it has no
 * occluded windows, so every page it holds is "visible" and keeps its
 * `requestAnimationFrame` loop, its timers and its compositor running at full
 * rate for as long as the daemon lives. Measured on one canvas-animating page
 * per browser, three browsers, nothing driving them: 48.6% of a CPU sustained,
 * which is what an agent's parked sessions were quietly costing the machine.
 * The same three, parked: 3.9%.
 *
 * `Page.setWebLifecycleState('frozen')` is Chromium's own Page Lifecycle
 * transition (the one it applies to a backgrounded tab): task queues stop,
 * state is kept. Attaching over CDP resumes the page — Playwright's connect
 * re-focuses it — so a later command finds it running again with no
 * bookkeeping of ours to get wrong. Parking is therefore invisible except in
 * the CPU graph, and a page that never gets another command simply stays
 * asleep instead of burning a core until the idle reaper arrives.
 *
 * NEVER parks a browser we do not own: an `external` (`connect`ed) session is
 * the user's OWN browser, with their tabs in it, and a `headed` session is one
 * a human asked to watch — freezing either would stop something in front of
 * someone's eyes. Best-effort throughout; a page that cannot be frozen is left
 * running rather than failing the command that just succeeded.
 */
export async function parkPages(conn: Connection): Promise<void> {
  if (!parkingEnabled()) return
  if (conn.info.external === true || conn.info.headed === true) return
  const pages = conn.context.pages()
  await Promise.all(
    pages.map(async (page) => {
      let cdp: import('playwright').CDPSession
      try {
        cdp = await conn.context.newCDPSession(page)
      } catch {
        return // page/target already gone
      }
      try {
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
      } catch {
        /* a page that refuses to freeze (mid-navigation, crashed) keeps running */
      }
      await cdp.detach().catch(() => {})
    }),
  )
}

/**
 * Is page parking on? `SILVER_NO_PARK=1` turns it off.
 *
 * The escape hatch exists for the one case parking genuinely changes: a page
 * that must keep working while silver is NOT attached — a long poll the agent
 * intends to leave running between commands, a socket the server drops if it
 * goes quiet. Everything else only notices the CPU it stopped spending.
 */
function parkingEnabled(): boolean {
  const raw = process.env.SILVER_NO_PARK?.trim()
  return !(raw === '1' || raw === 'true')
}

/**
 * Wake a parked page for the duration of a command — the inverse of `parkPages`.
 *
 * Attaching over CDP already resumes a frozen page in practice, but that is
 * Playwright's side effect rather than a contract, and a verb that silently
 * hangs because a future version stopped doing it is the worst failure this
 * change could have. So the wake-up is stated. One CDP round-trip on the ONE
 * page the command is about to drive, never the whole tab strip.
 *
 * The wake lasts as long as the transport does, which is exactly one command:
 * measured, a page frozen once runs normally while silver is attached (30
 * frames painted inside a 500ms in-command wait) and settles back to frozen
 * when the transport drops. Chromium's asymmetry, and a convenient one — a
 * parked session needs no re-parking bookkeeping, only a wake on the way in.
 * The flip side is that `SILVER_NO_PARK=1` cannot revive a session that was
 * already parked; it has to be set for the run that OPENS the session (or the
 * session closed and reopened, which spawns a browser that never froze).
 */
export async function unparkPage(context: BrowserContext, page: Page): Promise<void> {
  let cdp: import('playwright').CDPSession
  try {
    cdp = await context.newCDPSession(page)
  } catch {
    return
  }
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  await cdp.detach().catch(() => {})
}

/**
 * Attach the session `name` to an ALREADY-RUNNING browser's CDP endpoint (the
 * "share one browser someone else launched" branch). `endpoint` may be:
 *   - a websocket url         (`ws://…` / `wss://…`) — used directly
 *   - an http devtools url    (`http://127.0.0.1:9222`) — resolved via /json/version
 *   - a bare port             (`9222`) — treated as http://127.0.0.1:<port>
 *
 * We verify the endpoint is reachable, then persist an `external: true` sidecar.
 * We do NOT own the process, so no pid is recorded (0) and gc/respawn skip it.
 */
export async function connectExternalSession(name: string, endpoint: string): Promise<SessionInfo> {
  const resolved = await resolveCdpEndpoint(endpoint)
  // Verify connectability up front so `connect` fails loudly rather than
  // leaving a dangling sidecar that every later command trips over.
  const chromium = await loadChromium()
  const probe = await chromium.connectOverCDP(resolved.wsEndpoint, { timeout: 5_000 })
  try {
    if (!probe.contexts()[0]) throw new Error('the target browser exposes no context')
  } finally {
    await probe.close().catch(() => {})
  }
  const info: SessionInfo = {
    port: resolved.port ?? 0,
    pid: 0,
    wsEndpoint: resolved.wsEndpoint,
    createdAt: new Date().toISOString(),
    external: true,
  }
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(sidecarPath(name), info)
  return info
}

/** Resolve any accepted CDP endpoint form to a concrete websocket url. */
async function resolveCdpEndpoint(endpoint: string): Promise<{ wsEndpoint: string; port?: number }> {
  let ep = endpoint.trim()
  if (ep.length === 0) throw new Error('a CDP endpoint is required')
  if (/^\d+$/.test(ep)) ep = `http://127.0.0.1:${ep}`

  if (ep.startsWith('ws://') || ep.startsWith('wss://')) {
    return { wsEndpoint: ep }
  }
  if (ep.startsWith('http://') || ep.startsWith('https://')) {
    const base = ep.replace(/\/+$/, '')
    const res = await fetch(`${base}/json/version`)
    if (!res.ok) throw new Error('the CDP endpoint did not respond')
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown }
    if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl.length === 0) {
      throw new Error('the CDP endpoint did not expose a websocket url')
    }
    let port: number | undefined
    try {
      const p = Number(new URL(ep).port)
      if (Number.isInteger(p) && p > 0) port = p
    } catch {
      /* no explicit port */
    }
    return { wsEndpoint: body.webSocketDebuggerUrl, port }
  }
  throw new Error('unsupported CDP endpoint (use ws://, http://127.0.0.1:PORT, or a bare port)')
}

/** Persist the RefMap sidecar for cross-command grounding (encrypted at rest). */
export async function saveRefMap(name: string, map: RefMap): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(refmapPath(name), map)
}

/** Load the RefMap sidecar, or null if none has been saved yet. */
export async function loadRefMap(name: string): Promise<RefMap | null> {
  try {
    return await readSidecarObject<RefMap>(refmapPath(name))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// R5b: action-repetition ring. A bounded ring of the last-K `(verb, ref,
// fingerprint)` tuples in a per-session sidecar. When the same tuple recurs K
// times with an UNCHANGED fingerprint the host is stuck in a no-progress loop
// (clicking a dead button, re-filling a field that never accepts). The hub calls
// `noteAction` after each act and `isRepeating` to decide whether to stamp the
// ADVISORY `repetition_detected` flag — it NEVER blocks the action itself.
//
// A dedicated sidecar (never session.json / refmap.json) keeps this soft
// reliability signal off the correctness-critical grounding files. Encrypted at
// rest through the shared crypto (a fingerprint embeds the page URL).
// ---------------------------------------------------------------------------

const ACTION_RING = 'action-ring.json'

/** How many recent actions the ring retains. */
export const ACTION_RING_SIZE = 8

/** Consecutive identical tail entries that trip the repetition advisory. */
export const REPETITION_THRESHOLD = 3

export type ActionRingEntry = {
  /** The actor verb (click/fill/select/…). */
  verb: string
  /** The bare/`@eN` ref (or coordinate token) the verb targeted. */
  ref: string
  /** The post-settle page fingerprint at the time of the action. */
  fingerprint: string
}

type ActionRing = { entries: ActionRingEntry[] }

function actionRingPath(name: string): string {
  return path.join(sessionDir(name), ACTION_RING)
}

/** A stable identity key for an action tuple (NUL-joined so fields can't collide). */
function ringKey(e: ActionRingEntry): string {
  return `${e.verb}\u0000${e.ref}\u0000${e.fingerprint}`
}

async function loadActionRing(name: string): Promise<ActionRing> {
  try {
    const r = await readSidecarObject<ActionRing>(actionRingPath(name))
    return Array.isArray(r?.entries) ? r : { entries: [] }
  } catch {
    return { entries: [] }
  }
}

/**
 * Append `entry` to the session's action ring, bounded to `ACTION_RING_SIZE`
 * (oldest dropped). Best-effort persistence: a write failure is swallowed so a
 * soft-signal bookkeeping error never fails the underlying act.
 */
export async function noteAction(name: string, entry: ActionRingEntry): Promise<void> {
  const ring = await loadActionRing(name)
  ring.entries.push({ verb: entry.verb, ref: entry.ref, fingerprint: entry.fingerprint })
  if (ring.entries.length > ACTION_RING_SIZE) {
    ring.entries = ring.entries.slice(ring.entries.length - ACTION_RING_SIZE)
  }
  try {
    await fs.mkdir(sessionDir(name), { recursive: true })
    await writeSidecar(actionRingPath(name), ring)
  } catch {
    /* soft signal — never fail the act on a bookkeeping write */
  }
}

/**
 * True when the most recent `REPETITION_THRESHOLD` ring entries are all the SAME
 * `(verb, ref, fingerprint)` — i.e. the host repeated one action with no page
 * change. Read-only (does not mutate the ring). Call AFTER `noteAction` so the
 * just-taken action is included in the tail.
 */
export async function isRepeating(name: string): Promise<boolean> {
  const { entries } = await loadActionRing(name)
  if (entries.length < REPETITION_THRESHOLD) return false
  const tail = entries.slice(entries.length - REPETITION_THRESHOLD)
  const first = ringKey(tail[0] as ActionRingEntry)
  return tail.every((e) => ringKey(e) === first)
}

/** Clear the action ring (e.g. after a navigation resets the working context). */
export async function clearActionRing(name: string): Promise<void> {
  try {
    await fs.rm(actionRingPath(name), { force: true })
  } catch {
    /* nothing to clear */
  }
}

/**
 * Tear a session down: best-effort graceful CDP disconnect, terminate the
 * detached browser process, WAIT for it to actually exit, then remove the
 * session dir.
 *
 * Waiting for exit is load-bearing: SIGTERM is asynchronous, and a
 * still-shutting-down Chromium keeps writing to its profile dir. Removing the
 * dir before the process is gone lets Chromium re-create files afterward,
 * resurrecting the directory. So we kill, confirm the process is dead
 * (escalating to SIGKILL), and only then remove the dir.
 */
export async function closeSession(name: string): Promise<void> {
  const dir = sessionDir(name)
  let info: SessionInfo | null = null
  try {
    info = await readSidecar(name)
  } catch {
    info = null
  }

  if (info) {
    try {
      const chromium = await loadChromium()
      const browser = await chromium.connectOverCDP(info.wsEndpoint, { timeout: 3_000 })
      await browser.close()
    } catch {
      /* browser may already be gone */
    }
    // NEVER signal an EXTERNAL (connect'd) browser — we do not own it, and its
    // recorded pid is 0. `process.kill(0, …)` would signal our ENTIRE process
    // group (a footgun that would take down the caller). Only terminate a real,
    // positive pid of a browser WE spawned. Dropping the CDP transport above is
    // the whole teardown for an external session.
    if (!info.external && info.pid > 0) {
      try {
        process.kill(info.pid, 'SIGTERM')
      } catch {
        /* already dead */
      }
      await waitForExit(info.pid, 4_000)
    }
  }

  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Block until `pid` no longer exists, escalating to SIGKILL if it lingers.
 * `process.kill(pid, 0)` throws ESRCH once the process is gone.
 */
async function waitForExit(pid: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  let escalated = false
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return // ESRCH — the process is gone
    }
    if (!escalated && Date.now() > deadline - budgetMs / 2) {
      escalated = true
      killProcessGroup(pid, 'SIGKILL')
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        return
      }
    }
    await delay(50)
  }
}

/**
 * SIGKILL the browser's whole process GROUP, not just its main process.
 *
 * A graceful SIGTERM lets Chromium's browser process tear its own renderers down,
 * so the ordinary path needs nothing extra. The SIGKILL escalation does not: the
 * browser process dies instantly with no chance to reap its children, and the
 * renderers — the actually-fat processes — are left orphaned to launchd. That is
 * exactly the shape of the leak that motivated this work (an orphaned browser at
 * ~284 MB whose surviving renderer alone held ~914 MB).
 *
 * `openSession` spawns with `detached: true`, which on POSIX puts the browser in
 * a NEW process group led by the browser itself, so `kill(-pid)` reaches the whole
 * tree and nothing else. Safety rails, both load-bearing: never negate a pid ≤ 1
 * (`kill(-1)` signals every process the user owns, and `kill(-0)` signals OUR own
 * group — either would be catastrophic), and only ever call this for a pid we have
 * just observed alive, so a recycled pid cannot redirect the group kill at an
 * unrelated tree. Best-effort: a missing group is not an error.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, signal)
  } catch {
    /* no such group, or not ours to signal — the direct kill below still runs */
  }
}
