/**
 * Egress guard — scheme + host DENYLIST with opt-in suffix allowlist hardening.
 *
 * Design posture (spec §7, red-team S5/S6):
 *   - DENYLIST by default: http(s) with no `--allowed-domains` set is allowed
 *     (an empty allowlist would brick ~every task — the aside-05 footgun).
 *   - Flat, unconditional deny of `file:` / `data:` (top-level) / `blob:` /
 *     `view-source:` / any non-http(s) scheme. `allowFile` lifts ONLY `file:`.
 *     ("reachable from untrusted content" is NOT a runtime-checkable property,
 *     so we default-deny instead of conditioning — red-team S6.)
 *   - Raw-IP literals (v4/v6/decimal/hex) denied — classic phishing/SSRF vector.
 *   - A small known-dangerous host list (credential/identity pages) denied by
 *     exact-or-suffix match.
 *   - `--allowed-domains` is an opt-in HARDENING layer: when set & non-empty the
 *     host must match by SUFFIX (`host===d || host.endsWith("."+d)`), NEVER by
 *     substring — so `booking.com.evil.com` is denied while `m.booking.com` is
 *     allowed for `allowedDomains=['booking.com']`.
 *
 * This is a pure function; the CLI is expected to call it on the lowest
 * navigation primitive it controls so a compromised/injected agent loop cannot
 * route around it (red-team aside-05 #8: put the hard deny at the lowest layer).
 */
import * as path from 'node:path'
import * as dns from 'node:dns'
import * as net from 'node:net'
import type { ErrorCode } from '../core/errors.js'

/** Guaranteed to be a real member of the error taxonomy. */
type NavBlocked = Extract<ErrorCode, 'navigation_blocked'>
type PathDenied = Extract<ErrorCode, 'path_denied'>

export type NavigableResult = { ok: true } | { ok: false; code: NavBlocked }

export type EgressOptions = {
  allowFile: boolean
  allowedDomains?: string[]
}

/**
 * Small, defensible known-dangerous host list: identity/credential-management
 * and extension-store surfaces where an autonomous agent has no business
 * navigating by default. Matched by exact-or-suffix (so subdomains are covered).
 * Intentionally short — the real guarantee is the scheme + suffix logic; this is
 * defense-in-depth, hot-updatable config in spirit (aside-05 #18).
 */
const KNOWN_DANGEROUS_HOSTS: readonly string[] = [
  'accounts.google.com',
  'passwords.google.com',
  'myaccount.google.com',
  'chromewebstore.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'addons.mozilla.org',
]

const DENY: NavigableResult = { ok: false, code: 'navigation_blocked' }
const ALLOW: NavigableResult = { ok: true }

/** `scheme:` at the head of the string, per RFC 3986 (case-insensitive). */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/** dotted-quad shape (range-loose on purpose: a real TLD is never all-numeric). */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** whole host is a single decimal integer (e.g. 2130706433 == 127.0.0.1). */
const DECIMAL_HOST_RE = /^\d+$/
/** whole host is a single hex integer (e.g. 0x7f000001). */
const HEX_HOST_RE = /^0x[0-9a-fA-F]+$/

/**
 * Decide whether an agent-issued navigation target is allowed.
 *
 * Returns `{ok:true}` to permit, or `{ok:false, code:'navigation_blocked'}` to
 * deny. Never throws.
 */
export function assertNavigable(url: string, opts: EgressOptions): NavigableResult {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw.length === 0) return DENY

  const schemeMatch = SCHEME_RE.exec(raw)
  if (!schemeMatch) {
    // No explicit scheme → not a well-formed absolute http(s) URL. Fail closed.
    return DENY
  }
  const scheme = schemeMatch[1].toLowerCase()

  // --- Scheme gate -----------------------------------------------------------
  if (scheme === 'file') {
    // allowFile lifts ONLY file: (and nothing else). A lifted file: nav still
    // has no meaningful host to check, so it is permitted outright.
    return opts.allowFile ? ALLOW : DENY
  }
  if (scheme !== 'http' && scheme !== 'https') {
    // data: (top-level), blob:, view-source:, javascript:, chrome:, about:,
    // ws:, ftp:, and every other non-http(s) scheme — flat default deny.
    // allowFile does NOT lift these.
    return DENY
  }

  // --- Parse host (http/https only past this point) --------------------------
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return DENY
  }
  if (host.length === 0) return DENY

  // --- Raw-IP literal deny (v4 / v6 / decimal / hex) -------------------------
  // URL parsing puts IPv6 hosts in bracket form (`[::1]`); any ':' in a host is
  // an IPv6 literal since a real hostname never contains a colon.
  if (host.startsWith('[') || host.includes(':')) return DENY
  if (IPV4_RE.test(host)) return DENY
  if (DECIMAL_HOST_RE.test(host)) return DENY
  if (HEX_HOST_RE.test(host)) return DENY

  // --- Known-dangerous host list (exact or suffix) ---------------------------
  if (matchesAnySuffix(host, KNOWN_DANGEROUS_HOSTS)) return DENY

  // --- Opt-in allowlist hardening (SUFFIX match, never substring) ------------
  const allowed = opts.allowedDomains
  if (allowed && allowed.length > 0) {
    const norm = allowed
      .map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
      .filter((d) => d.length > 0)
    if (norm.length > 0 && !matchesAnySuffix(host, norm)) return DENY
  }

  // http(s), non-IP, non-dangerous, allowlist-satisfied (or no allowlist) → OK.
  return ALLOW
}

// ---------------------------------------------------------------------------
// CDP Fetch-layer subresource egress (adopt-list S2, P0 SECURITY HOLE).
//
// `assertNavigable` guards TOP-LEVEL navigation only. A page on an allowed domain
// can still beacon/exfil via subresource `fetch()`/`<img src>`/XHR/`sendBeacon` to
// ANY host — invisible to the nav guard. The CDP `Fetch.requestPaused` handler in
// session.ts calls THIS decision for every paused subresource, applying the SAME
// egress policy assertNavigable uses (deny file:/data:/blob:/non-http(s) + the
// known-dangerous/IP-literal denylist; restrict to `--allowed-domains` when set).
//
// Document requests (top-level and sub-frame navigations) are the nav path's job
// (`assertNavigableResolved` before goto) and are left to 'continue' here so the
// subresource guard never double-blocks a navigation the nav guard already vetted
// (and so a legitimate `data:`/`blob:` top-level test page still loads).
// ---------------------------------------------------------------------------

export type FetchEgressDecision = 'continue' | 'block'

/**
 * Decide whether a CDP-paused request may proceed. `resourceType` is CDP's
 * `Fetch.requestPaused.resourceType` (`Document`/`Image`/`Stylesheet`/`XHR`/
 * `Fetch`/`Script`/`Ping`/…). Navigations (`Document`) always continue; every
 * other (subresource) request is held to `assertNavigable`. Pure; never throws.
 */
export function subresourceEgressDecision(
  url: string,
  resourceType: string,
  opts: EgressOptions,
): FetchEgressDecision {
  // Navigations are guarded on the nav path — do not re-block them here.
  if (resourceType === 'Document') return 'continue'
  return assertNavigable(url, opts).ok ? 'continue' : 'block'
}

/**
 * DNS-resolving twin of `subresourceEgressDecision` (fix C1 for subresources).
 *
 * The sync version above defers to the LEXICAL `assertNavigable`, which never
 * resolves DNS — so a hostname that lexically looks public but RESOLVES to a
 * loopback/link-local/private/metadata address (classic DNS rebinding, e.g.
 * `127.0.0.1.nip.io` / `169.254.169.254.nip.io`) is blocked as a top-level
 * navigation (which uses `assertNavigableResolved`) yet slipped through as a
 * subresource `fetch()`/`<img>`/beacon. This variant mirrors the sync one's
 * `resourceType` handling (`Document` navigations continue — the nav path owns
 * them) but routes every subresource through `assertNavigableResolved`, so a
 * rebind target is denied at the Fetch layer too. Fails CLOSED: an unresolvable
 * host yields `assertNavigableResolved`'s DENY → 'block'. Never throws.
 *
 * @param lookup injectable resolver (tests pass a stub; prod uses OS DNS).
 */
export async function subresourceEgressDecisionResolved(
  url: string,
  resourceType: string,
  opts: EgressOptions,
  lookup?: DnsLookupAll,
): Promise<FetchEgressDecision> {
  // Navigations are guarded on the nav path — do not re-block/re-resolve them.
  if (resourceType === 'Document') return 'continue'
  return (await assertNavigableResolved(url, opts, lookup)).ok ? 'continue' : 'block'
}

/**
 * Cap on the per-guard host-decision cache. A single page rarely touches this
 * many distinct hosts; past the cap we simply stop caching (still correct, just
 * un-amortized) so a hostile page cannot grow the map without bound.
 */
const SUBRESOURCE_HOST_CACHE_MAX = 4096

/**
 * The cacheable hostname for a paused request, or `null` when the target must not
 * be cached: `Document` navigations (owned by the nav path) and non-http(s) /
 * unparseable targets (decided lexically with no DNS cost, so nothing to
 * amortize). Only http(s) subresources carry a resolvable host worth caching.
 */
function cacheableHost(url: string, resourceType: string): string | null {
  if (resourceType === 'Document') return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  return host.length > 0 ? host : null
}

/**
 * Build a STATEFUL subresource egress decider that resolves each unique host at
 * most once. The CDP Fetch guard (session.ts) creates ONE per armed guard: a page
 * can fire hundreds of subresources at the same host, and under a fixed policy the
 * `block`/`continue` verdict is host-deterministic, so we cache the resolved
 * decision per hostname (bounded by `SUBRESOURCE_HOST_CACHE_MAX`) rather than
 * re-resolving DNS on every request. Non-cacheable targets (`Document` / non-http /
 * unparseable) fall straight through to `subresourceEgressDecisionResolved`. Fails
 * CLOSED: any unexpected error decides 'block'. The returned decider never throws.
 *
 * @param lookup injectable resolver (tests pass a stub; prod uses OS DNS).
 */
export function createSubresourceEgressGuard(
  opts: EgressOptions,
  lookup?: DnsLookupAll,
): (url: string, resourceType: string) => Promise<FetchEgressDecision> {
  const cache = new Map<string, FetchEgressDecision>()
  return async (url: string, resourceType: string): Promise<FetchEgressDecision> => {
    const host = cacheableHost(url, resourceType)
    if (host !== null) {
      const cached = cache.get(host)
      if (cached !== undefined) return cached
    }
    let decision: FetchEgressDecision
    try {
      decision = await subresourceEgressDecisionResolved(url, resourceType, opts, lookup)
    } catch {
      decision = 'block' // fail closed on any unexpected error
    }
    if (host !== null && cache.size < SUBRESOURCE_HOST_CACHE_MAX) cache.set(host, decision)
    return decision
  }
}

/** true iff `host === d` or `host` ends with `"." + d` for some `d` in list. */
function matchesAnySuffix(host: string, domains: readonly string[]): boolean {
  for (const d of domains) {
    if (host === d || host.endsWith('.' + d)) return true
  }
  return false
}

/** Normalize an `--allowed-domains` list (trim, lowercase, strip leading dots). */
function normalizeAllowed(allowed?: string[]): string[] {
  if (!allowed || allowed.length === 0) return []
  return allowed
    .map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
    .filter((d) => d.length > 0)
}

// ---------------------------------------------------------------------------
// DNS-rebinding SSRF close (red-team C1).
//
// The lexical `assertNavigable` denies RAW-IP literals but a PUBLIC hostname
// that RESOLVES to a private/metadata address slips through: e.g.
// `http://169.254.169.254.nip.io/` or `http://127.0.0.1.nip.io/` (real public
// wildcard-DNS) are ordinary hostnames lexically, yet resolve to the cloud
// metadata endpoint / loopback. `assertNavigableResolved` runs the lexical gate
// AND resolves the host, denying if ANY address is loopback/link-local/private/
// reserved — unless the operator opted the domain in via `--allowed-domains`.
//
// Residual TOCTOU (accepted, documented): Chromium performs its OWN resolution
// when it navigates, so a hostile authoritative server could rebind between our
// lookup and Chromium's. The Node pre-check is the guard we ship; a full close
// would need `--host-resolver-rules` pinning, which would break legitimate
// resolution (and `localhost`) and is not adopted.
// ---------------------------------------------------------------------------

/** A resolved address (mirrors the shape of Node's `dns.LookupAddress`). */
export type ResolvedAddress = { address: string; family: number }

/** Injectable resolver (default: `dns.promises.lookup(host,{all:true})`). */
export type DnsLookupAll = (host: string) => Promise<ResolvedAddress[]>

const defaultLookupAll: DnsLookupAll = async (host) => {
  const res = await dns.promises.lookup(host, { all: true })
  return res.map((r) => ({ address: r.address, family: r.family }))
}

/**
 * `localhost` / `*.localhost` are RFC 6761 special-use loopback names. They are
 * NOT a DNS-rebinding vector (a rebind hides a private IP behind a PUBLIC name);
 * the agent typed the loopback name explicitly, and the lexical gate already
 * permits it. We preserve that and skip resolution for these names. (A raw
 * `127.0.0.1` literal stays denied by the lexical IP gate.)
 */
function isExplicitLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

/**
 * S9: true iff `url`'s host is a LOOPBACK IP LITERAL the lexical gate denies but
 * that the agent almost certainly meant as `localhost` (which the guard permits
 * by name): a 127/8 IPv4 literal or the IPv6 `::1`. Callers use this ONLY to
 * attach a "use http://localhost:PORT" remedy to the UNCHANGED
 * `navigation_blocked` denial — it does NOT relax the block. Deliberately does
 * NOT match metadata/link-local (169.254/16) or private ranges (10/8, 172.16/12,
 * 192.168/16): those stay denied with no such hint. Pure; never throws.
 */
export function isLoopbackLiteralHost(url: string): boolean {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw.length === 0) return false
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return false
  }
  // `new URL('http://[::1]/').hostname` is `[::1]` — strip the IPv6 brackets.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  if (IPV4_RE.test(bare)) return Number(bare.split('.')[0]) === 127 // 127/8 loopback
  return false
}

/**
 * Async navigability guard: the lexical `assertNavigable` PLUS a DNS resolution
 * check that denies any host resolving to a non-public address. Never throws.
 *
 * @param lookup  injectable resolver (tests pass a stub; prod uses OS DNS).
 */
export async function assertNavigableResolved(
  url: string,
  opts: EgressOptions,
  lookup: DnsLookupAll = defaultLookupAll,
): Promise<NavigableResult> {
  // (a) LEXICAL gate first — scheme / raw-IP / dangerous-host / allowlist. If it
  // denies, we are done (and never resolve DNS for an already-denied target).
  const lexical = assertNavigable(url, opts)
  if (!lexical.ok) return lexical

  // Only http(s) targets carry a resolvable host. A lifted `file:` nav has no
  // host and was already vetted lexically — permit it unchanged.
  let host: string
  let scheme: string
  try {
    const u = new URL(url.trim())
    scheme = u.protocol.replace(/:$/, '').toLowerCase()
    host = u.hostname.toLowerCase()
  } catch {
    return DENY
  }
  if (scheme !== 'http' && scheme !== 'https') return lexical
  if (host.length === 0) return DENY
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  // Explicit loopback names are not a rebinding vector (see above).
  if (isExplicitLoopbackName(bareHost)) return ALLOW

  // Operator-trusted domains bypass the resolution check: they may legitimately
  // point at internal hosts, and the operator opted in via `--allowed-domains`.
  const allowed = normalizeAllowed(opts.allowedDomains)
  if (allowed.length > 0 && matchesAnySuffix(bareHost, allowed)) return ALLOW

  // (b) RESOLVE and reject if ANY address is loopback/link-local/private/reserved.
  let addrs: ResolvedAddress[]
  try {
    addrs = await lookup(bareHost)
  } catch {
    // Cannot prove the host is safe → fail closed.
    return DENY
  }
  if (addrs.length === 0) return DENY
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) return DENY
  }
  return ALLOW
}

/**
 * True iff `address` is a loopback / link-local / private / reserved IP (v4 or
 * v6, including IPv4-mapped IPv6). An unparseable address fails closed (true).
 */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return isBlockedV4(address)
  if (net.isIPv6(address)) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — judge the embedded v4.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address)
    if (mapped) return isBlockedV4(mapped[1])
    return isBlockedV6(address.toLowerCase())
  }
  return true
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 — "this host" / reserved
  if (a === 10) return true // 10/8 private
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false
}

function isBlockedV6(ip: string): boolean {
  if (ip === '::' || ip === '::0' || ip === '0:0:0:0:0:0:0:0') return true // unspecified
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true // loopback
  if (/^fe[89ab]/.test(ip)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(ip)) return true // fc00::/7 unique-local
  return false
}

// ---------------------------------------------------------------------------
// Filesystem path containment (spec §7, red-team P1-SEC4).
//
// Any path silver WRITES (screenshot output) or READS (upload input, storage
// state) must resolve INSIDE the working directory. This blocks the mirror of
// the egress hole on the local FS: a `screenshot ../../etc/anything`, an
// absolute `/etc/passwd`, or a traversal `../../.ssh/id_rsa` upload. Same
// fail-closed shape as `assertNavigable`; the path is never echoed into errors.
// ---------------------------------------------------------------------------

export type ContainedPathResult =
  | { ok: true; resolved: string }
  | { ok: false; code: PathDenied }

const PATH_DENY: ContainedPathResult = { ok: false, code: 'path_denied' }

/**
 * Resolve `target` against `root` (default: the process CWD) and permit it only
 * when the resolved path is `root` itself or a descendant of it. Absolute
 * escapes and `..` traversal that leaves `root` are denied. Never throws.
 */
export function assertContainedPath(target: string, root: string = process.cwd()): ContainedPathResult {
  if (typeof target !== 'string' || target.trim().length === 0) return PATH_DENY
  let base: string
  let resolved: string
  try {
    base = path.resolve(root)
    resolved = path.resolve(base, target)
  } catch {
    return PATH_DENY
  }
  if (resolved === base || resolved.startsWith(base + path.sep)) {
    return { ok: true, resolved }
  }
  return PATH_DENY
}

// ---------------------------------------------------------------------------
// Server-suggested filename chokepoint (adopt-list S3).
//
// A download's `suggestedFilename` (or any page/host-supplied name) is untrusted:
// `../../../etc/x`, `/etc/passwd`, `..\..\evil`, a NUL, etc. Every disk-writing
// path that takes such a name must route through this ONE choke — basename-first,
// then sanitize, then re-assert containment — so a traversal/absolute component
// can never escape the contained download dir. Mirrors the `redactValue`/`groundRef`
// single-chokepoint pattern. Never throws; the name is never echoed into errors.
// ---------------------------------------------------------------------------

export type ContainedFilenameResult =
  | { ok: true; resolved: string; basename: string }
  | { ok: false; code: PathDenied }

/**
 * Reduce an untrusted server-suggested filename to a SAFE basename contained in
 * `dir`. Any directory components (POSIX or Windows separators) are stripped, the
 * name is restricted to `[A-Za-z0-9._-]`, leading dots are removed (no `..` /
 * dotfiles), it is length-capped, and the result is re-checked against
 * `assertContainedPath`. Falls back to `download` when nothing safe remains.
 */
export function containedFilename(suggested: string, dir: string): ContainedFilenameResult {
  const raw = typeof suggested === 'string' ? suggested : ''
  // basename-first: collapse any \ to / so a Windows-style path can't smuggle a
  // separator past POSIX basename, then take the final path component only.
  let base = path.basename(raw.replace(/\\+/g, '/'))
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  if (base.length === 0) base = 'download'
  base = base.slice(0, 128)
  const contained = assertContainedPath(base, dir)
  if (!contained.ok) return { ok: false, code: contained.code }
  return { ok: true, resolved: contained.resolved, basename: base }
}
