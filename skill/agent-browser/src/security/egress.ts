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
import type { ErrorCode } from '../core/errors.js'

/** Guaranteed to be a real member of the error taxonomy. */
type NavBlocked = Extract<ErrorCode, 'navigation_blocked'>

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
