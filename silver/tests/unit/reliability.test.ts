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

  it('S4: maps a wrong-element-type throw to wrong_element_type (NOT page_crash)', () => {
    // Verbatim playwright-core 1.61 createStacklessError messages.
    expect(classifyEngineError(new Error('Not a checkbox or radio button'))).toBe(
      'wrong_element_type',
    )
    expect(classifyEngineError(new Error('Element is not a <select> element'))).toBe(
      'wrong_element_type',
    )
    expect(
      classifyEngineError(
        new Error('Element is not an <input>, <textarea> or [contenteditable] element'),
      ),
    ).toBe('wrong_element_type')
    expect(classifyEngineError(new Error('Node is not an HTMLInputElement'))).toBe(
      'wrong_element_type',
    )
    // A realistic `is checked @<a-link>` surface must NOT become page_crash.
    expect(
      classifyEngineError(new Error('elementHandle.isChecked: Not a checkbox or radio button')),
    ).not.toBe('page_crash')
  })

  it('returns null for a generic/unclassified throw (cli falls back to engine_error)', () => {
    expect(classifyEngineError(new Error('element not found'))).toBeNull()
    expect(classifyEngineError(new Error('something totally unexpected happened'))).toBeNull()
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
    'wrong_element_type',
    'engine_error',
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

  it('S4: wrong_element_type is non-retryable and warns AGAINST reload', () => {
    expect(ERRORS.wrong_element_type.retryableByHost).toBe(false)
    expect(ERRORS.wrong_element_type.message.toLowerCase()).toContain('do not reload')
    // It must not carry the destructive `reload` advice page_crash gives.
    expect(ERRORS.wrong_element_type.message.toLowerCase()).not.toContain('run `reload`')
  })

  it('S4: engine_error is a NEUTRAL retryable fallback that does not claim a crash', () => {
    expect(ERRORS.engine_error.retryableByHost).toBe(true)
    expect(ERRORS.engine_error.message.toLowerCase()).toContain('unclassified')
    expect(ERRORS.engine_error.message.toLowerCase()).toContain('do not assume the page crashed')
    expect(ERRORS.engine_error.message).not.toBe(ERRORS.page_crash.message)
  })

  it('S9: auth_required is branch-neutral (fill+submit OR restore a saved session)', () => {
    const m = ERRORS.auth_required.message.toLowerCase()
    // Names the fill+submit branch (plain login form)…
    expect(m).toContain('fill')
    expect(m).toContain('submit')
    // …and the restore-session branch (`state load`).
    expect(m).toContain('state load')
    // The old wording assumed only the saved-state path — must no longer read that way.
    expect(m).toContain('login form')
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
