import { describe, it, expect } from 'vitest'
import { hat, gat, resolveSkills, type Skill } from '../../src/core/skillmatch.js'

// K1: skill auto-injection scorers — hat (host×path specificity), gat (keyword
// word-boundary), resolveSkills (non-site-specific always on; site-specific
// hidden until a URL/keyword match).

describe('hat — host×path specificity score', () => {
  it('scores 100·hostLiteral + 10·pathLiteral − wildcards', () => {
    // host 'a.com' = 5 literal, path '' = 0; no wildcards.
    expect(hat('a.com', '')).toBe(500)
    // '*.stripe.com' = 11 literal (drop the '*') , 1 wildcard.
    expect(hat('*.stripe.com', '')).toBe(100 * 11 - 1)
    // path chars add at 10 each.
    expect(hat('a.com', '/pay')).toBe(500 + 10 * 4)
  })

  it('a more specific rule outranks a broader one', () => {
    const specific = hat('checkout.stripe.com', '/pay')
    const broad = hat('*.stripe.com', '/*')
    expect(specific).toBeGreaterThan(broad)
  })
})

describe('gat — word-boundary keyword count', () => {
  it('counts whole-word keyword hits (case-insensitive)', () => {
    expect(gat(['pay', 'checkout'], 'https://x.com/pay/checkout')).toBe(2)
    expect(gat(['pay'], 'https://x.com/PAY')).toBe(1)
  })

  it('does not match a keyword inside a larger word', () => {
    expect(gat(['pay'], 'https://paypal.com/home')).toBe(0)
  })

  it('empty text or empty keywords → 0', () => {
    expect(gat(['pay'], '')).toBe(0)
    expect(gat([], 'https://x.com/pay')).toBe(0)
  })
})

describe('resolveSkills', () => {
  const always: Skill = { name: 'general', siteSpecific: false }
  const stripe: Skill = {
    name: 'stripe-checkout',
    siteSpecific: true,
    autoInject: { url: ['*.stripe.com/checkout/*'], keywords: ['stripe'] },
  }
  const jobs: Skill = {
    name: 'job-apply',
    siteSpecific: true,
    autoInject: { keywords: ['apply', 'resume'] },
  }

  it('non-site-specific skills are always on (progressive disclosure)', () => {
    const r = resolveSkills('https://anything.com/', '', [always])
    expect(r.map((m) => m.skill.name)).toEqual(['general'])
    expect(r[0].reason).toBe('always')
  })

  it('site-specific skills stay hidden until a URL glob matches', () => {
    const off = resolveSkills('https://example.com/', '', [stripe])
    expect(off).toEqual([])
    const on = resolveSkills('https://js.stripe.com/checkout/session', '', [stripe])
    expect(on.map((m) => m.skill.name)).toEqual(['stripe-checkout'])
    expect(on[0].reason).toBe('url')
  })

  it('site-specific keyword-only skills fire on a message match', () => {
    const off = resolveSkills('https://boards.example.com/list', '', [jobs])
    expect(off).toEqual([])
    const on = resolveSkills('https://boards.example.com/list', 'please apply to this role', [jobs])
    expect(on.map((m) => m.skill.name)).toEqual(['job-apply'])
    expect(on[0].reason).toBe('keyword')
  })

  it('ranks a URL match (by hat specificity) above always-on and keyword matches', () => {
    const r = resolveSkills(
      'https://js.stripe.com/checkout/session',
      'stripe apply',
      [always, jobs, stripe],
    )
    // stripe (url) first, then general (always, 0) and jobs (keyword) after.
    expect(r[0].skill.name).toBe('stripe-checkout')
    expect(r[0].reason).toBe('url')
    expect(r.map((m) => m.skill.name)).toContain('general')
    expect(r.map((m) => m.skill.name)).toContain('job-apply')
  })

  it('tolerates scheme-less URLs and missing autoInject', () => {
    const bare: Skill = { name: 'bare', siteSpecific: true }
    const r = resolveSkills('js.stripe.com/checkout/x', '', [bare, stripe])
    // bare has no rules → never applies; stripe matches the scheme-less URL.
    expect(r.map((m) => m.skill.name)).toEqual(['stripe-checkout'])
  })
})
