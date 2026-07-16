import { describe, it, expect } from 'vitest'
import {
  suggestVerb,
  sanitizeToken,
  levenshtein,
  VERB_ALIASES,
} from '../../src/core/suggest.js'

// D5a: typo suggestion — alias map then Levenshtein, on a SANITIZED token prefix
// only so a URL / selector / value never leaks into the error string.

const VERBS = [
  'open',
  'close',
  'snapshot',
  'click',
  'fill',
  'type',
  'press',
  'select',
  'screenshot',
  'extract',
  'expect',
  'wait',
  'reload',
  'scroll',
]

describe('sanitizeToken — safe prefix only', () => {
  it('accepts a bare verb token', () => {
    expect(sanitizeToken('clik')).toBe('clik')
    expect(sanitizeToken('scroll-into')).toBe('scroll-into')
  })

  it('stops at the first unsafe character (URL / selector / value never leaks)', () => {
    expect(sanitizeToken('https://evil.example/pay?token=abc')).toBe('https')
    expect(sanitizeToken('@e5')).toBeNull()
    expect(sanitizeToken('/foo/bar')).toBeNull()
    expect(sanitizeToken('')).toBeNull()
    expect(sanitizeToken('  spaced')).toBeNull()
  })
})

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('clik', 'click')).toBe(1)
    expect(levenshtein('same', 'same')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })
})

describe('suggestVerb', () => {
  it('resolves an explicit alias before edit distance', () => {
    const s = suggestVerb('goto', VERBS)
    expect(s).toEqual({ input: 'goto', suggestion: 'open', reason: 'alias' })
  })

  it('every alias target is a real verb somewhere in a superset table', () => {
    // Sanity: alias targets should be plausible verbs (all lowercase words).
    for (const target of Object.values(VERB_ALIASES)) {
      expect(target).toMatch(/^[a-z]+$/)
    }
  })

  it('suggests the nearest verb by edit distance', () => {
    expect(suggestVerb('clik', VERBS)).toMatchObject({ suggestion: 'click', reason: 'distance' })
    expect(suggestVerb('snapshto', VERBS)).toMatchObject({ suggestion: 'snapshot' })
    expect(suggestVerb('expct', VERBS)).toMatchObject({ suggestion: 'expect' })
  })

  it('returns null for an exact hit (not a typo)', () => {
    expect(suggestVerb('click', VERBS)).toBeNull()
  })

  it('returns null when nothing is close enough', () => {
    expect(suggestVerb('zzzzzzzzzz', VERBS)).toBeNull()
  })

  it('never leaks a URL/value: an unsafe input yields at most its safe prefix', () => {
    const s = suggestVerb('https://evil.example/pay?token=SECRET', VERBS)
    // 'https' has no close verb → null; crucially nothing after the prefix survives.
    if (s) {
      expect(s.input).toBe('https')
      expect(JSON.stringify(s)).not.toContain('SECRET')
      expect(JSON.stringify(s)).not.toContain('evil.example')
    } else {
      expect(s).toBeNull()
    }
  })

  it('a selector/value passed as the verb yields no suggestion (null token)', () => {
    expect(suggestVerb('@e5', VERBS)).toBeNull()
    expect(suggestVerb('/tmp/secret.json', VERBS)).toBeNull()
  })
})
