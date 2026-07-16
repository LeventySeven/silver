import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import {
  noteAction,
  isRepeating,
  clearActionRing,
  sessionDir,
  ACTION_RING_SIZE,
  REPETITION_THRESHOLD,
  type ActionRingEntry,
} from '../../src/core/session.js'
import {
  classifyEngineError,
  isPageCrash,
  ERRORS,
  type ErrorCode,
} from '../../src/core/errors.js'

// ---------------------------------------------------------------------------
// R6: engine-error classifier
// ---------------------------------------------------------------------------
describe('classifyEngineError (R6)', () => {
  it('maps transport drops to page_crash', () => {
    expect(classifyEngineError(new Error('Target closed'))).toBe('page_crash')
    expect(classifyEngineError(new Error('Browser has been closed'))).toBe('page_crash')
    expect(classifyEngineError(new Error('WebSocket closed'))).toBe('page_crash')
    expect(classifyEngineError(new Error('Page has been closed'))).toBe('page_crash')
    expect(classifyEngineError('the browser has disconnected')).toBe('page_crash')
  })

  it('maps unreachable-host net::ERR_* to navigation_failed (NOT navigation_blocked)', () => {
    expect(classifyEngineError(new Error('net::ERR_NAME_NOT_RESOLVED at https://x'))).toBe(
      'navigation_failed',
    )
    expect(classifyEngineError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe('navigation_failed')
    expect(classifyEngineError(new Error('net::ERR_CONNECTION_RESET'))).toBe('navigation_failed')
  })

  it('does NOT mislabel our own egress block / a deliberate abort as a site outage', () => {
    expect(classifyEngineError(new Error('net::ERR_BLOCKED_BY_CLIENT'))).toBeNull()
    expect(classifyEngineError(new Error('net::ERR_ABORTED'))).toBeNull()
  })

  it('returns null for unrelated errors', () => {
    expect(classifyEngineError(new Error('element not found'))).toBeNull()
    expect(classifyEngineError(null)).toBeNull()
    expect(classifyEngineError(undefined)).toBeNull()
  })

  it('isPageCrash is the page_crash predicate', () => {
    expect(isPageCrash(new Error('Target closed'))).toBe(true)
    expect(isPageCrash(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// New error codes carry recovery messages + a retryable flag
// ---------------------------------------------------------------------------
describe('new error codes (R5/R6/E4)', () => {
  const NEW_CODES: ErrorCode[] = [
    'page_empty',
    'repetition_detected',
    'navigation_failed',
    'retries_exhausted',
  ]

  it('every new code has a non-empty message and boolean retryableByHost', () => {
    for (const code of NEW_CODES) {
      expect(ERRORS).toHaveProperty(code)
      expect(typeof ERRORS[code].message).toBe('string')
      expect(ERRORS[code].message.length).toBeGreaterThan(0)
      expect(typeof ERRORS[code].retryableByHost).toBe('boolean')
    }
  })

  it('navigation_failed is retryable and DISTINCT from navigation_blocked', () => {
    expect(ERRORS.navigation_failed.retryableByHost).toBe(true)
    expect(ERRORS.navigation_blocked.retryableByHost).toBe(false)
    expect(ERRORS.navigation_failed.message).not.toBe(ERRORS.navigation_blocked.message)
  })

  it('repetition_detected and retries_exhausted advise against blind retry', () => {
    expect(ERRORS.repetition_detected.retryableByHost).toBe(false)
    expect(ERRORS.retries_exhausted.retryableByHost).toBe(false)
  })

  it('no new code leaks a path or secret substring', () => {
    for (const code of NEW_CODES) {
      const m = ERRORS[code].message
      expect(m).not.toContain('/Users')
      expect(m).not.toContain('/home')
      expect(m.toLowerCase()).not.toContain('password=')
    }
  })
})

// ---------------------------------------------------------------------------
// R5b: repetition ring
// ---------------------------------------------------------------------------
describe('action repetition ring (R5b)', () => {
  const NAME = `silver-ring-${process.pid}-${Date.now()}`
  const A: ActionRingEntry = { verb: 'click', ref: 'e5', fingerprint: 'url|0|100' }

  afterEach(async () => {
    await fs.rm(sessionDir(NAME), { recursive: true, force: true }).catch(() => {})
  })

  it('is not repeating below the threshold', async () => {
    await noteAction(NAME, A)
    await noteAction(NAME, A)
    expect(REPETITION_THRESHOLD).toBeGreaterThan(2)
    expect(await isRepeating(NAME)).toBe(false)
  })

  it('detects K identical (verb,ref,fingerprint) in a row', async () => {
    for (let i = 0; i < REPETITION_THRESHOLD; i++) await noteAction(NAME, A)
    expect(await isRepeating(NAME)).toBe(true)
  })

  it('a changed fingerprint (progress) breaks the run', async () => {
    for (let i = 0; i < REPETITION_THRESHOLD - 1; i++) await noteAction(NAME, A)
    // Same verb+ref but the page moved → not a stuck loop.
    await noteAction(NAME, { ...A, fingerprint: 'url|0|250' })
    expect(await isRepeating(NAME)).toBe(false)
  })

  it('a different ref breaks the run', async () => {
    for (let i = 0; i < REPETITION_THRESHOLD - 1; i++) await noteAction(NAME, A)
    await noteAction(NAME, { ...A, ref: 'e9' })
    expect(await isRepeating(NAME)).toBe(false)
  })

  it('bounds the ring to ACTION_RING_SIZE', async () => {
    for (let i = 0; i < ACTION_RING_SIZE + 5; i++) {
      await noteAction(NAME, { ...A, fingerprint: `url|0|${i}` })
    }
    // Read the persisted ring back through a fresh isRepeating (all distinct → false).
    expect(await isRepeating(NAME)).toBe(false)
  })

  it('clearActionRing resets the detector', async () => {
    for (let i = 0; i < REPETITION_THRESHOLD; i++) await noteAction(NAME, A)
    expect(await isRepeating(NAME)).toBe(true)
    await clearActionRing(NAME)
    expect(await isRepeating(NAME)).toBe(false)
  })

  it('an empty/absent ring is never repeating', async () => {
    expect(await isRepeating(NAME)).toBe(false)
  })
})
