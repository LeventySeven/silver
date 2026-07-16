/**
 * Bounded internal retry taxonomy (adopt-list E4, SOTA-b §4).
 *
 * Silver's `errors.ts` classifies failures for the HOST, but has no INTERNAL
 * retry — a flaky 503 / connection reset on `page.goto`, a CDP attach, or an
 * extract-fetch surfaces as a hard failure the host must babysit. `withRetries`
 * wraps such a call site: it classifies each throw as `rate_limit` (429),
 * `transient` ({408,409,425,500,502,503,504} + connection needles), or `fatal`
 * (everything else — rethrown immediately, NEVER retried), and gives rate-limit
 * vs transient their own bounded exponential backoff.
 *
 * HARD numeric cap (SOTA-b §4 — never loop silently): once a class exhausts its
 * `maxRetries`, `withRetries` throws a `RetriesExhaustedError` whose `.code` is
 * the taxonomy member `retries_exhausted`, so the dispatcher's `mapThrow`
 * surfaces the loud, distinct code instead of masquerading as the last transient
 * error. There is no unbounded/infinite path.
 *
 * Keyless: pure classification + timers. No model, no network of its own.
 */
import type { ErrorCode } from './errors.js'

/** How a thrown error is treated by the retry loop. */
export type RetryClass = 'rate_limit' | 'transient' | 'fatal'

/** Backoff policy for one retry class. `maxRetries` is a HARD cap (>= 0). */
export type BackoffPolicy = {
  /** Maximum RETRIES after the initial attempt (hard cap; 0 disables retry). */
  maxRetries: number
  /** First backoff delay (ms). */
  baseMs: number
  /** Upper clamp on any single backoff delay (ms). */
  maxMs: number
  /** Exponential growth factor per attempt. */
  factor: number
  /** Add up to +/-50% random jitter to each delay (thundering-herd guard). */
  jitter: boolean
}

export type RetryConfig = {
  /** Backoff for `rate_limit` (429) errors. Merged over the defaults. */
  rateLimit?: Partial<BackoffPolicy>
  /** Backoff for `transient` errors. Merged over the defaults. */
  transient?: Partial<BackoffPolicy>
  /** Override the default classifier (e.g. to add domain needles). */
  classify?: (err: unknown) => RetryClass
  /** Injectable sleep (tests pass a no-op to run instantly). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable jitter source in [0,1). Default: Math.random. */
  random?: () => number
}

/**
 * Rate-limit backs off harder and longer than a generic transient blip — a 429
 * means "you are going too fast", so a short retry storm makes it worse.
 */
export const DEFAULT_RATE_LIMIT_POLICY: BackoffPolicy = {
  maxRetries: 4,
  baseMs: 1_000,
  maxMs: 20_000,
  factor: 2,
  jitter: true,
}

export const DEFAULT_TRANSIENT_POLICY: BackoffPolicy = {
  maxRetries: 3,
  baseMs: 250,
  maxMs: 4_000,
  factor: 2,
  jitter: true,
}

/**
 * HTTP statuses that are RETRYABLE-transient (not 429, which is its own class).
 * 408 request-timeout, 409 conflict, 425 too-early, 5xx gateway/unavailable.
 */
const TRANSIENT_STATUSES = new Set([408, 409, 425, 500, 502, 503, 504])

/** Connection/transport needles that mean "try again" regardless of HTTP status. */
const TRANSIENT_NEEDLES: readonly string[] = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'eai_again',
  'epipe',
  'socket hang up',
  'network error',
  'connection reset',
  'connection closed',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'service unavailable',
]

/** Thrown when a retry class hits its hard cap. `.code` → `retries_exhausted`. */
export class RetriesExhaustedError extends Error {
  readonly code: ErrorCode = 'retries_exhausted'
  /** The class that exhausted (`rate_limit` | `transient`). */
  readonly retryClass: RetryClass
  /** Total attempts made (initial + retries). */
  readonly attempts: number
  /** The last underlying error (kept for the caller's own logging, never surfaced). */
  readonly lastError: unknown
  constructor(retryClass: RetryClass, attempts: number, lastError: unknown) {
    super('retries_exhausted')
    this.name = 'RetriesExhaustedError'
    this.retryClass = retryClass
    this.attempts = attempts
    this.lastError = lastError
  }
}

/** Pull a numeric HTTP status off common error shapes (status/statusCode/response). */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
    const v = e[key]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v
  }
  const resp = e.response as { status?: unknown } | undefined
  if (resp && typeof resp.status === 'number') return resp.status
  return undefined
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  const parts: string[] = []
  if (err instanceof Error) parts.push(String(err.message ?? ''))
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: unknown; code?: unknown; syscall?: unknown }
    if (typeof e.message === 'string') parts.push(e.message)
    // Node system errors carry a STRING `code` (ECONNRESET/ETIMEDOUT/EAI_AGAIN)
    // rather than an HTTP status — fold it into the haystack so needle matching
    // catches it (a numeric `code` is handled as a status by `statusOf`).
    if (typeof e.code === 'string') parts.push(e.code)
    if (typeof e.syscall === 'string') parts.push(e.syscall)
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Default classifier: 429 → `rate_limit`; {408,409,425,5xx} or a transient
 * connection needle → `transient`; everything else → `fatal` (rethrown, never
 * retried). A too-fast-fail on a genuinely fatal error is correct: retrying a 404
 * or a validation error only burns time.
 */
export function classifyRetry(err: unknown): RetryClass {
  const status = statusOf(err)
  if (status === 429) return 'rate_limit'
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return 'transient'
  const msg = messageOf(err)
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return 'rate_limit'
  }
  if (TRANSIENT_NEEDLES.some((n) => msg.includes(n))) return 'transient'
  return 'fatal'
}

/** Honor a server-supplied Retry-After (seconds or ms) when present, capped. */
function retryAfterMs(err: unknown, maxMs: number): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.retryAfterMs === 'number' && e.retryAfterMs >= 0) {
    return Math.min(e.retryAfterMs, maxMs)
  }
  if (typeof e.retryAfter === 'number' && e.retryAfter >= 0) {
    return Math.min(e.retryAfter * 1_000, maxMs)
  }
  return undefined
}

/** Deterministic exponential backoff for `attempt` (0-based), clamped, optional jitter. */
export function backoffDelay(
  policy: BackoffPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const raw = policy.baseMs * Math.pow(policy.factor, Math.max(0, attempt))
  const capped = Math.min(policy.maxMs, raw)
  if (!policy.jitter) return Math.round(capped)
  // +/-50% jitter, clamped to [0, maxMs].
  const jittered = capped * (0.5 + random())
  return Math.round(Math.min(policy.maxMs, Math.max(0, jittered)))
}

function mergePolicy(base: BackoffPolicy, over?: Partial<BackoffPolicy>): BackoffPolicy {
  if (!over) return base
  const merged: BackoffPolicy = {
    maxRetries: over.maxRetries ?? base.maxRetries,
    baseMs: over.baseMs ?? base.baseMs,
    maxMs: over.maxMs ?? base.maxMs,
    factor: over.factor ?? base.factor,
    jitter: over.jitter ?? base.jitter,
  }
  // Guard the hard cap: never negative, always an integer.
  merged.maxRetries = Math.max(0, Math.floor(merged.maxRetries))
  return merged
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)))

/**
 * Run `fn`, retrying rate-limit/transient failures under bounded backoff. A
 * `fatal` classification rethrows immediately; exhausting a class's hard cap
 * throws `RetriesExhaustedError` (`.code === 'retries_exhausted'`). On success
 * the first passing result is returned. There is no unbounded path.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const rateLimit = mergePolicy(DEFAULT_RATE_LIMIT_POLICY, config.rateLimit)
  const transient = mergePolicy(DEFAULT_TRANSIENT_POLICY, config.transient)
  const classify = config.classify ?? classifyRetry
  const sleep = config.sleep ?? defaultSleep
  const random = config.random ?? Math.random

  // Per-class retry budgets consumed independently: a run that alternates 429 and
  // 503 cannot loop forever — each class has its own hard cap and they only count
  // down. Total attempts are therefore bounded by rateLimit.maxRetries +
  // transient.maxRetries + 1.
  let rateLimitLeft = rateLimit.maxRetries
  let transientLeft = transient.maxRetries
  let attempts = 0
  let rateLimitAttempt = 0
  let transientAttempt = 0

  for (;;) {
    attempts += 1
    try {
      return await fn()
    } catch (err) {
      const cls = classify(err)
      if (cls === 'fatal') throw err // never retry a fatal error

      if (cls === 'rate_limit') {
        if (rateLimitLeft <= 0) throw new RetriesExhaustedError('rate_limit', attempts, err)
        rateLimitLeft -= 1
        const delay = retryAfterMs(err, rateLimit.maxMs) ??
          backoffDelay(rateLimit, rateLimitAttempt, random)
        rateLimitAttempt += 1
        await sleep(delay)
        continue
      }

      // transient
      if (transientLeft <= 0) throw new RetriesExhaustedError('transient', attempts, err)
      transientLeft -= 1
      const delay = retryAfterMs(err, transient.maxMs) ??
        backoffDelay(transient, transientAttempt, random)
      transientAttempt += 1
      await sleep(delay)
    }
  }
}
