/**
 * Typed error taxonomy → recovery table (spec §7, red-team S7).
 *
 * Each error's `message` IS the recovery instruction handed to the host LLM.
 * `retryableByHost` tells the host whether a retry could plausibly succeed.
 *
 * INVARIANT (no-leak): messages are fixed, sanitized strings. They must never
 * embed a filesystem path, URL, host, or secret. Context passed to `fail()` is
 * intentionally NOT interpolated into the message (see envelope.ts).
 */
export const ERRORS = {
  ref_stale: {
    retryableByHost: true,
    message:
      'refs are stale (a new snapshot was taken or the page changed); run `snapshot` again and retry with fresh refs',
  },
  element_not_found: {
    retryableByHost: true,
    message:
      'no element matches that ref/selector; re-snapshot and pick a ref from the current tree',
  },
  element_obscured: {
    retryableByHost: true,
    message:
      'another element covers the target; re-snapshot, scroll it into view, or pass --force',
  },
  timeout: {
    retryableByHost: true,
    message:
      'the element/condition did not become ready in time; re-snapshot or increase --timeout',
  },
  navigation_blocked: {
    retryableByHost: false,
    message:
      'navigation to that target is denied by policy (scheme/host not allowed); not retryable',
  },
  captcha_detected: {
    retryableByHost: false,
    message:
      'a CAPTCHA was detected; human action is required — this agent does not solve CAPTCHAs',
  },
  page_crash: {
    retryableByHost: true,
    message: 'the page crashed; run `reload` then re-snapshot',
  },
  auth_required: {
    retryableByHost: false,
    message:
      'the page requires authentication; load a saved state (`state load`) or cookies (`cookies set --curl`)',
  },
  not_permitted: {
    retryableByHost: false,
    message:
      'that action is not enabled in the current phase; the session is read-only (pass --enable-actions to allow acting)',
  },
  // Added for the serializer's never-truncate contract (spec §5): when output
  // exceeds the cap we fail loudly with the escape hatches, never silently cut.
  output_overflow: {
    retryableByHost: true,
    message:
      'output exceeded the size cap; narrow the scope with -d (max depth), -s (selector scope), or a ref to snapshot a subtree instead of the whole page',
  },
} as const

export type ErrorCode = keyof typeof ERRORS

export type ErrorEntry = {
  readonly retryableByHost: boolean
  readonly message: string
}
