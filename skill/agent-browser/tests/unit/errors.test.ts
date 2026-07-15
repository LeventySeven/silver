import { describe, it, expect } from 'vitest'
import { ERRORS, type ErrorCode } from '../../src/core/errors.js'
import { fail, ok } from '../../src/core/envelope.js'

const REQUIRED_CODES = [
  'ref_stale',
  'element_not_found',
  'element_obscured',
  'timeout',
  'navigation_blocked',
  'captcha_detected',
  'page_crash',
  'auth_required',
  'not_permitted',
  'output_overflow',
] as const

describe('error taxonomy', () => {
  it('defines every required code', () => {
    for (const code of REQUIRED_CODES) {
      expect(ERRORS).toHaveProperty(code)
    }
  })

  it('every code has a non-empty message and a boolean retryableByHost', () => {
    for (const code of Object.keys(ERRORS) as ErrorCode[]) {
      expect(typeof ERRORS[code].message).toBe('string')
      expect(ERRORS[code].message.length).toBeGreaterThan(0)
      expect(typeof ERRORS[code].retryableByHost).toBe('boolean')
    }
  })
})

describe('envelope: fail() sanitization (no-leak invariant)', () => {
  it('fail("navigation_blocked", {host}) leaks neither the path nor the secret', () => {
    const env = fail('navigation_blocked', { host: '/Users/secret' })
    const serialized = JSON.stringify(env)
    expect(serialized).not.toContain('/Users')
    expect(serialized).not.toContain('secret')
  })

  it('fail() produces a well-formed failure envelope carrying the table message', () => {
    const env = fail('ref_stale')
    expect(env.success).toBe(false)
    expect(env.data).toBeNull()
    expect(env.error).toBe(ERRORS.ref_stale.message)
  })

  it('no ERRORS message contains an obvious path or secret substring', () => {
    for (const code of Object.keys(ERRORS) as ErrorCode[]) {
      const m = ERRORS[code].message
      expect(m).not.toContain('/Users')
      expect(m).not.toContain('/home')
      expect(m.toLowerCase()).not.toContain('password=')
    }
  })
})

describe('envelope: ok()', () => {
  it('wraps data and omits warning when not given', () => {
    const env = ok({ a: 1 })
    expect(env.success).toBe(true)
    expect(env.error).toBeNull()
    expect(env.data).toEqual({ a: 1 })
    expect('warning' in env).toBe(false)
  })

  it('carries a warning when provided', () => {
    const env = ok(42, 'heads up')
    expect(env.warning).toBe('heads up')
  })
})
