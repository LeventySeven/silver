/**
 * TOTP helper (RFC-6238) + a `<totp>NAME</totp>` write-path resolution — adopt-list
 * D2, the #1 cross-vertical MFA unblock. KEYLESS: pure `node:crypto` HMAC math, no
 * model, no network, no third-party OTP service.
 *
 * Two layers:
 *
 *  1. `totp(secretBase32, opts)` — the raw RFC-6238 generator (HMAC-SHA1 by
 *     default, HOTP dynamic truncation). Given a base32 seed and a time it returns
 *     the current N-digit code. This is what the [TEST] RFC-6238 test vectors
 *     exercise directly.
 *
 *  2. `resolveTotpTokens()` — the fill-time indirection that mirrors the
 *     `<secret>` mechanism (secret.ts). A host embeds `<totp>NAME</totp>` in a
 *     `fill`/`type` value; at dispatch the token is replaced with the CURRENT
 *     6-digit code derived from the base32 SEED registered under NAME. The seed is
 *     looked up through the SAME domain-scoped secret registry (a TOTP seed is just
 *     a domain-scoped secret whose value is the base32 key), so the anti-exfil
 *     domain guarantee applies unchanged: a `bank.com`-scoped seed refuses to
 *     produce a code on `evil.com`. The raw seed never enters the host context or
 *     an envelope — only the ephemeral 6-digit code reaches the page.
 */
import { createHmac } from 'node:crypto'

/** Options for {@link totp}. `t` is UNIX time in SECONDS (default: now). */
export type TotpOptions = {
  /** UNIX time in seconds at which to compute the code. Default: `Date.now()/1000`. */
  t?: number
  /** Number of output digits. Default 6. */
  digits?: number
  /** Time step in seconds. Default 30. */
  period?: number
  /** HMAC hash. Default SHA1 (the RFC-6238 / Google-Authenticator default). */
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512'
}

/** RFC-4648 base32 alphabet (no padding needed on decode). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an RFC-4648 base32 string to bytes. Case-insensitive; surrounding
 * whitespace and trailing `=` padding are ignored. Throws on an invalid
 * character so a mistyped seed fails loud rather than producing a wrong code.
 */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('invalid base32 character in TOTP secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

/**
 * Compute an RFC-6238 TOTP code. Pure function of (seed, time). Never throws for a
 * valid base32 seed; throws for an empty/invalid seed (fail loud, not a wrong code).
 */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  const period = opts.period && opts.period > 0 ? Math.floor(opts.period) : 30
  const digits = opts.digits && opts.digits > 0 ? Math.floor(opts.digits) : 6
  const algorithm = opts.algorithm ?? 'SHA1'
  const nowSec = opts.t !== undefined ? opts.t : Date.now() / 1000

  const key = base32Decode(secretBase32)
  if (key.length === 0) throw new Error('empty TOTP secret')

  // 8-byte big-endian counter = floor(time / period).
  let counter = Math.floor(nowSec / period)
  const buf = Buffer.alloc(8)
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }

  const digest = createHmac(algorithm.toLowerCase(), key).update(buf).digest()
  // HOTP dynamic truncation (RFC-4226 §5.3).
  const offset = digest[digest.length - 1] & 0x0f
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const code = bin % 10 ** digits
  return code.toString().padStart(digits, '0')
}

/**
 * The write-path token a host embeds in a fill/type value. Case-insensitive; the
 * NAME is `[A-Za-z0-9_.-]+`. Global+ignore-case so every occurrence is resolved.
 */
export const TOTP_TOKEN_RE = /<totp>\s*([A-Za-z0-9_.-]+)\s*<\/totp>/gi

/** Quick presence check (does this value contain any `<totp>` token at all?). */
export function hasTotpToken(value: string): boolean {
  return /<totp>/i.test(String(value ?? ''))
}

/**
 * The minimal shape of a domain-scoped seed store. `SecretRegistry` (secret.ts)
 * satisfies this structurally: `resolveValue('<secret>NAME</secret>', url)` returns
 * the base32 SEED registered under NAME, refusing on unknown-name / domain-mismatch.
 * Depending only on this interface keeps totp.ts decoupled from secret.ts.
 */
export type SeedResolver = {
  resolveValue(
    value: string,
    pageUrl: string,
  ): { value: string; usedSecret?: boolean; refused: boolean; reason?: string }
}

export type TotpResolveResult = {
  /** The value with every `<totp>` token replaced by its current code. */
  value: string
  /** True iff at least one `<totp>` token was resolved. */
  usedTotp: boolean
  /** True iff a token could not be resolved (unknown seed / domain mismatch / bad seed). */
  refused: boolean
  /** Static reason on refusal (no seed/host echoed). */
  reason?: string
}

/**
 * Resolve every `<totp>NAME</totp>` token in `value` to the current 6-digit code.
 *
 * The base32 seed for NAME is fetched through `seeds` (the domain-scoped secret
 * registry) using a synthesized `<secret>NAME</secret>` lookup against `pageUrl`,
 * so domain scope is enforced identically to `<secret>`. On ANY failure (unknown
 * seed, domain mismatch, invalid base32) the ORIGINAL value is returned with
 * `refused:true` — the caller MUST fail the action closed and MUST NOT dispatch it.
 *
 * `opts.t` (seconds) is injectable for deterministic tests; production uses now.
 */
export function resolveTotpTokens(
  value: string,
  pageUrl: string,
  seeds: SeedResolver,
  opts: { t?: number; digits?: number; period?: number } = {},
): TotpResolveResult {
  const input = String(value ?? '')
  if (!hasTotpToken(input)) return { value: input, usedTotp: false, refused: false }

  let refused = false
  let reason: string | undefined
  let usedTotp = false

  const out = input.replace(TOTP_TOKEN_RE, (match, rawName: string) => {
    const name = String(rawName).toUpperCase()
    // Reuse the secret registry's domain-scoped lookup: a TOTP seed is a secret.
    const seed = seeds.resolveValue(`<secret>${name}</secret>`, pageUrl)
    if (seed.refused) {
      refused = true
      reason = seed.reason ?? 'unknown or out-of-scope TOTP seed'
      return match
    }
    try {
      usedTotp = true
      return totp(seed.value, { t: opts.t, digits: opts.digits, period: opts.period })
    } catch {
      refused = true
      reason = 'invalid TOTP seed'
      return match
    }
  })

  if (refused) return { value: input, usedTotp: false, refused: true, reason }
  return { value: out, usedTotp, refused: false }
}
