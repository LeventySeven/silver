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
