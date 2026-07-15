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
  // A paid/destructive control (Buy/Pay/Delete/…) reached without explicit
  // approval on a non-interactive session. Static reason only (no target leak).
  confirm_required: {
    retryableByHost: false,
    message:
      'this looks like a paid/destructive action; re-run with --confirm-actions to approve',
  },
  // A filesystem path (screenshot output / upload input / state file) resolved
  // outside the working directory. Fail-closed; the path itself is never echoed.
  path_denied: {
    retryableByHost: false,
    message:
      'that file path is outside the allowed directory; use a path inside the current working directory',
  },
  // Added for the serializer's never-truncate contract (spec §5): when output
  // exceeds the cap we fail loudly with the escape hatches, never silently cut.
  output_overflow: {
    retryableByHost: true,
    message:
      'output exceeded the size cap; narrow the scope with -d (max depth), -s (selector scope), or a ref to snapshot a subtree instead of the whole page',
  },
  // The per-session advisory lock could not be acquired: another command is
  // holding this session's lock and did not release it in time. Retryable —
  // commands against ONE session serialize, so retry once the other finishes.
  // Static reason only (no session name / path leak).
  session_busy: {
    retryableByHost: true,
    message:
      'another command is currently using this session; commands against one session run one at a time — retry shortly, or use a different --session',
  },
} as const

export type ErrorCode = keyof typeof ERRORS

export type ErrorEntry = {
  readonly retryableByHost: boolean
  readonly message: string
}
