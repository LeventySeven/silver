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
import { spawn } from 'node:child_process'
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
}

const SIDECAR = 'session.json'
const REFMAP = 'refmap.json'
const READY_BUDGET_MS = 8_000

/**
 * Deterministic viewport (P0-8): a fixed window size makes snapshots/screenshots
 * and concurrent eval runs reproducible instead of inheriting a version-dependent
 * headless default. Applied both as a launch arg and (best-effort) per connect.
 */
const VIEWPORT = { width: 1280, height: 900 } as const

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
export function sessionsRoot(): string {
  const base = path.join(os.homedir(), '.silver')
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

/**
 * Spawn a detached Chromium, wait until its debugging endpoint is live, and
 * persist the sidecar. Returns the sidecar contents.
 */
export async function openSession(name: string, opts: OpenOptions = {}): Promise<SessionInfo> {
  const dir = sessionDir(name)
  // E2 real-Chrome-profile: `profile` (an EXISTING user-data-dir) wins over an
  // explicit userDataDir override, which wins over the throwaway per-session dir.
  // Whichever is chosen is recorded in the sidecar and REUSED on every reconnect.
  const userDataDir = opts.profile ?? opts.userDataDir ?? path.join(dir, 'profile')
  await fs.mkdir(userDataDir, { recursive: true })

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
  const execPath = chromium.executablePath()
  // Onramp fix (swap-readiness): a fresh install where Chromium was never downloaded
  // otherwise fails the FIRST `open` with an unclassified `engine_error` ("re-snapshot
  // and retry") — nonsense for a missing binary. Detect it the same way `doctor` does
  // (existsSync on the resolved path) and throw the TYPED `browser_missing` code so the
  // envelope carries the `npx playwright install chromium` fix the doctor already knows.
  if (!execPath || !existsSync(execPath)) {
    throw Object.assign(new Error('browser_missing'), { code: 'browser_missing' as const })
  }

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
    // stealth: never advertise automation (spec §7) — note: NO --enable-automation
    ...(opts.headed ? [] : ['--headless=new']),
    // Vercel-alignment: route through a proxy (unauthenticated). Applied at launch,
    // so it only affects a FRESH session. The value is operator-supplied argv, not
    // page-derived, so it is safe to pass verbatim; the egress guard still governs
    // which hosts navigation may reach (the proxy is transport, not a policy bypass).
    ...(opts.proxy ? [`--proxy-server=${opts.proxy}`] : []),
    'about:blank',
  ]

  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const pid = child.pid
  if (pid === undefined) {
    throw new Error('failed to spawn the browser process')
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
  const browser = await chromium.connectOverCDP(info.wsEndpoint)
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close().catch(() => {})
    throw new Error('the browser has no available context')
  }
  const page = context.pages()[0] ?? (await context.newPage())
  // Deterministic viewport (P0-8); best-effort over a CDP-connected page.
  await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height }).catch(() => {})
  // S2: re-arm the CDP Fetch-layer subresource egress guard on EVERY connect (the
  // per-command reconnect model means it must be re-enabled each time). Never
  // blocks the connect itself — a failure to arm is swallowed.
  await enableFetchEgressGuard(context, fetchEgressPolicy).catch(() => {})
  return { browser, context, page }
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
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        return
      }
    }
    await delay(50)
  }
}
