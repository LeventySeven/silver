import { describe, it, expect } from 'vitest'
import {
  withRetries,
  classifyRetry,
  backoffDelay,
  RetriesExhaustedError,
  DEFAULT_RATE_LIMIT_POLICY,
  DEFAULT_TRANSIENT_POLICY,
  type BackoffPolicy,
} from '../../src/core/retry.js'
import { ERRORS } from '../../src/core/errors.js'

// A no-op sleep so the bounded-backoff loop runs instantly in tests.
const noSleep = async (): Promise<void> => {}

describe('classifyRetry', () => {
  it('429 (status or message) → rate_limit', () => {
    expect(classifyRetry({ status: 429 })).toBe('rate_limit')
    expect(classifyRetry({ statusCode: 429 })).toBe('rate_limit')
    expect(classifyRetry(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limit')
    expect(classifyRetry(new Error('rate limit exceeded'))).toBe('rate_limit')
  })

  it('the transient status set {408,409,425,500,502,503,504} → transient', () => {
    for (const s of [408, 409, 425, 500, 502, 503, 504]) {
      expect(classifyRetry({ status: s })).toBe('transient')
    }
  })

  it('connection needles → transient', () => {
    expect(classifyRetry(new Error('read ECONNRESET'))).toBe('transient')
    expect(classifyRetry(new Error('socket hang up'))).toBe('transient')
    expect(classifyRetry(new Error('getaddrinfo EAI_AGAIN'))).toBe('transient')
    expect(classifyRetry({ code: 'ETIMEDOUT' } as unknown)).toBe('transient')
  })

  it('non-retryable statuses and unknown errors → fatal', () => {
    expect(classifyRetry({ status: 404 })).toBe('fatal')
    expect(classifyRetry({ status: 400 })).toBe('fatal')
    expect(classifyRetry(new Error('validation failed: field required'))).toBe('fatal')
    expect(classifyRetry('some random string')).toBe('fatal')
  })

  it('reads the status off an axios-style response object', () => {
    expect(classifyRetry({ response: { status: 503 } })).toBe('transient')
    expect(classifyRetry({ response: { status: 429 } })).toBe('rate_limit')
  })
})

describe('backoffDelay', () => {
  it('is exponential and clamped to maxMs (no jitter)', () => {
    const p: BackoffPolicy = { maxRetries: 5, baseMs: 100, maxMs: 1_000, factor: 2, jitter: false }
    expect(backoffDelay(p, 0)).toBe(100)
    expect(backoffDelay(p, 1)).toBe(200)
    expect(backoffDelay(p, 2)).toBe(400)
    expect(backoffDelay(p, 3)).toBe(800)
    expect(backoffDelay(p, 4)).toBe(1_000) // clamped
    expect(backoffDelay(p, 10)).toBe(1_000) // clamped
  })

  it('jitter stays within [0, maxMs]', () => {
    const p: BackoffPolicy = { maxRetries: 5, baseMs: 100, maxMs: 1_000, factor: 2, jitter: true }
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const d = backoffDelay(p, 3, () => r)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(1_000)
    }
  })
})

describe('withRetries', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0
    const out = await withRetries(
      async () => {
        calls += 1
        return 'ok'
      },
      { sleep: noSleep },
    )
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries a transient failure then succeeds', async () => {
    let calls = 0
    const out = await withRetries(
      async () => {
        calls += 1
        if (calls < 3) throw { status: 503 }
        return 42
      },
      { sleep: noSleep },
    )
    expect(out).toBe(42)
    expect(calls).toBe(3)
  })

  it('rethrows a fatal error immediately (never retried)', async () => {
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls += 1
          throw { status: 404 }
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ status: 404 })
    expect(calls).toBe(1)
  })

  it('surfaces retries_exhausted at the hard cap (never loops silently)', async () => {
    let calls = 0
    let caught: unknown
    try {
      await withRetries(
        async () => {
          calls += 1
          throw { status: 503 }
        },
        { transient: { maxRetries: 2 }, sleep: noSleep },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RetriesExhaustedError)
    expect((caught as RetriesExhaustedError).code).toBe('retries_exhausted')
    expect((caught as RetriesExhaustedError).retryClass).toBe('transient')
    // initial attempt + 2 retries = 3 calls, then the cap trips.
    expect(calls).toBe(3)
    // `.code` is a real taxonomy member with a message (mapThrow can surface it).
    expect(ERRORS.retries_exhausted.message.length).toBeGreaterThan(0)
  })

  it('honours a separate hard cap for rate-limit vs transient', async () => {
    let calls = 0
    let caught: unknown
    try {
      await withRetries(
        async () => {
          calls += 1
          throw { status: 429 }
        },
        { rateLimit: { maxRetries: 1 }, sleep: noSleep },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RetriesExhaustedError)
    expect((caught as RetriesExhaustedError).retryClass).toBe('rate_limit')
    expect(calls).toBe(2) // initial + 1 rate-limit retry
  })

  it('maxRetries:0 disables retry (one attempt, then exhausted)', async () => {
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls += 1
          throw { status: 500 }
        },
        { transient: { maxRetries: 0 }, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(RetriesExhaustedError)
    expect(calls).toBe(1)
  })

  it('honours a Retry-After (seconds) hint capped to maxMs', async () => {
    const slept: number[] = []
    let calls = 0
    await withRetries(
      async () => {
        calls += 1
        if (calls < 2) throw { status: 429, retryAfter: 999_999 }
        return 'done'
      },
      {
        rateLimit: { maxMs: 5_000 },
        sleep: async (ms) => {
          slept.push(ms)
        },
      },
    )
    expect(slept).toEqual([5_000]) // capped to maxMs, not 999999s
  })

  it('exposes sane default policies', () => {
    expect(DEFAULT_RATE_LIMIT_POLICY.maxRetries).toBeGreaterThan(0)
    expect(DEFAULT_TRANSIENT_POLICY.maxRetries).toBeGreaterThan(0)
    // rate-limit backs off harder/longer than a generic transient blip.
    expect(DEFAULT_RATE_LIMIT_POLICY.baseMs).toBeGreaterThan(DEFAULT_TRANSIENT_POLICY.baseMs)
  })
})
