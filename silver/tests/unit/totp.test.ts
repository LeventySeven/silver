import { describe, it, expect } from 'vitest'
import {
  totp,
  base32Decode,
  resolveTotpTokens,
  hasTotpToken,
  type SeedResolver,
} from '../../src/security/totp.js'

// ---------------------------------------------------------------------------
// RFC-6238 Appendix B test vectors (SHA-1). The shared secret is the ASCII
// string "12345678901234567890" (20 bytes) = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
// ---------------------------------------------------------------------------
const RFC_SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('totp: base32Decode', () => {
  it('decodes the RFC seed to the ASCII "12345678901234567890"', () => {
    expect(base32Decode(RFC_SEED_B32).toString('ascii')).toBe('12345678901234567890')
  })
  it('is case-insensitive and ignores whitespace + padding', () => {
    expect(base32Decode('  gezd gnbv gy3t qojq= ').toString('ascii')).toBe('1234567890')
  })
  it('throws on an invalid base32 character (fail loud, not a wrong code)', () => {
    expect(() => base32Decode('GEZD1!')).toThrow()
  })
})

describe('totp: RFC-6238 vectors (SHA-1)', () => {
  // The canonical 8-digit outputs from RFC-6238 Appendix B, T0=0, X=30s.
  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  it('produces the exact 8-digit code at each RFC time', () => {
    for (const [t, expected] of VECTORS) {
      expect(totp(RFC_SEED_B32, { t, digits: 8 }), `t=${t}`).toBe(expected)
    }
  })

  it('produces the 6-digit code (mod 10^6 of the 8-digit vector)', () => {
    for (const [t, eight] of VECTORS) {
      const six = eight.slice(-6)
      expect(totp(RFC_SEED_B32, { t, digits: 6 }), `t=${t}`).toBe(six)
    }
  })

  it('defaults to 6 digits and a 30s period', () => {
    expect(totp(RFC_SEED_B32, { t: 59 })).toBe('287082')
    // Same 30s window (30..59) yields the same code as t=59.
    expect(totp(RFC_SEED_B32, { t: 30 })).toBe(totp(RFC_SEED_B32, { t: 59 }))
    // The next window (t=60) is a different counter → (almost surely) different code.
    expect(totp(RFC_SEED_B32, { t: 60 })).not.toBe(totp(RFC_SEED_B32, { t: 59 }))
  })

  it('throws on an empty secret', () => {
    expect(() => totp('', { t: 59 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// <totp>NAME</totp> resolution over a domain-scoped seed registry.
// ---------------------------------------------------------------------------

/** A fake seed registry structurally matching SecretRegistry.resolveValue. */
function fakeSeeds(seedsByName: Record<string, { seed: string; domain: string }>): SeedResolver {
  return {
    resolveValue(value: string, pageUrl: string) {
      const m = /<secret>\s*([A-Za-z0-9_.-]+)\s*<\/secret>/i.exec(value)
      if (!m) return { value, refused: false }
      const name = m[1].toUpperCase()
      const entry = seedsByName[name]
      if (!entry) return { value, refused: true, reason: 'unknown secret' }
      let host = ''
      try {
        host = new URL(pageUrl).hostname.toLowerCase()
      } catch {
        host = ''
      }
      const ok = entry.domain === '*' || host === entry.domain || host.endsWith('.' + entry.domain)
      if (!ok) return { value, refused: true, reason: 'domain scope mismatch' }
      return { value: entry.seed, refused: false }
    },
  }
}

describe('totp: resolveTotpTokens', () => {
  const seeds = fakeSeeds({ MFA: { seed: RFC_SEED_B32, domain: 'bank.com' } })

  it('detects the token', () => {
    expect(hasTotpToken('<totp>MFA</totp>')).toBe(true)
    expect(hasTotpToken('nope')).toBe(false)
  })

  it('replaces the token with the current code on a matching domain', () => {
    const r = resolveTotpTokens('<totp>MFA</totp>', 'https://login.bank.com/mfa', seeds, { t: 59 })
    expect(r.refused).toBe(false)
    expect(r.usedTotp).toBe(true)
    expect(r.value).toBe('287082')
  })

  it('REFUSES on a mismatched domain (never emits a code off-scope)', () => {
    const r = resolveTotpTokens('<totp>MFA</totp>', 'https://evil.com/steal', seeds, { t: 59 })
    expect(r.refused).toBe(true)
    expect(r.usedTotp).toBe(false)
    expect(r.value).toBe('<totp>MFA</totp>') // original returned unchanged
  })

  it('REFUSES an unknown seed name', () => {
    const r = resolveTotpTokens('<totp>NOPE</totp>', 'https://bank.com/', seeds, { t: 59 })
    expect(r.refused).toBe(true)
  })

  it('passes plain values through untouched', () => {
    const r = resolveTotpTokens('just a code', 'https://bank.com/', seeds)
    expect(r).toEqual({ value: 'just a code', usedTotp: false, refused: false })
  })
})
