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
  // R6: a navigation could not REACH its target — DNS did not resolve, or the
  // connection was refused/reset (`net::ERR_NAME_NOT_RESOLVED`/`ERR_CONNECTION_*`).
  // DISTINCT from `navigation_blocked` (policy forbids — never retry): this is
  // "the site is unreachable right now", so a bounded retry/back-off can succeed.
  navigation_failed: {
    retryableByHost: true,
    message:
      'navigation could not reach the target (DNS did not resolve or the connection was refused/reset) — this is NOT a policy block; verify the URL/network and retry with backoff',
  },
  // R5a: after `open`/`goto` the DOM is (near-)empty — a blank shell, an anti-bot
  // interstitial, or a 429/403 body with no content. Advisory: the host should
  // reload/wait or change approach rather than act on a page that has not rendered.
  page_empty: {
    retryableByHost: true,
    message:
      'the page loaded but its DOM is (near-)empty — likely a blank shell, an anti-bot interstitial, or a throttled response; wait and reload, or try a different entry point',
  },
  // R5b: the SAME (verb, ref, page-fingerprint) has recurred K times with no
  // observable change — a stuck loop. ADVISORY only (never blocks the action):
  // retrying the identical action unchanged will not progress.
  repetition_detected: {
    retryableByHost: false,
    message:
      'the same action on the same element has repeated with no page change — do not retry it unchanged; re-snapshot and pick a different element, or stop and reassess',
  },
  // E4: `withRetries` reached its HARD numeric cap without success (never loop
  // silently). The underlying error was rate-limit/transient but did not clear
  // within the bounded attempts — retrying blindly again is not the answer.
  retries_exhausted: {
    retryableByHost: false,
    message:
      'the operation still failed after the maximum bounded retries; do not retry blindly — back off further, reduce request rate, or investigate the underlying failure',
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

// ---------------------------------------------------------------------------
// R6: engine-error → taxonomy classifier. A pure, string-needle classifier the
// dispatcher's `mapThrow` consults BEFORE its generic `page_crash` fallback, so a
// dropped CDP transport surfaces as retryable `page_crash` and an unreachable
// host surfaces as retryable-but-distinct `navigation_failed` (NOT the
// never-retry policy `navigation_blocked`). Message needles only — nothing from
// the error object is ever interpolated into a surfaced string (no-leak).
// ---------------------------------------------------------------------------

/**
 * Chromium `net::ERR_*` codes that mean "the target host was unreachable" —
 * DNS/connection failures, NOT policy blocks. Deliberately EXCLUDES
 * `ERR_BLOCKED_BY_CLIENT`/`ERR_ABORTED` (our own egress guard / a deliberate
 * cancel) so a policy denial is never mislabelled as a transient site outage.
 */
const NAVIGATION_FAILED_NEEDLES: readonly string[] = [
  'net::err_name_not_resolved',
  'net::err_name_resolution_failed',
  'net::err_connection_refused',
  'net::err_connection_reset',
  'net::err_connection_closed',
  'net::err_connection_timed_out',
  'net::err_connection_failed',
  'net::err_address_unreachable',
  'net::err_internet_disconnected',
  'net::err_socket_not_connected',
  'net::err_empty_response',
]

/**
 * Message fragments Playwright/CDP emit when the browser or its transport went
 * away mid-command (a crash/close, not a page-level error) → `page_crash`.
 */
const PAGE_CRASH_NEEDLES: readonly string[] = [
  'browser has been closed',
  'browser closed',
  'target closed',
  'target crashed',
  'page has been closed',
  'page closed',
  'page crashed',
  'websocket closed',
  'connection closed',
  'session closed',
  'browser has disconnected',
  'browserContext.newPage: Browser closed'.toLowerCase(),
]

/** Extract a lowercased message string from any thrown value (for needle match). */
function errorText(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (err instanceof Error) return String(err.message ?? '').toLowerCase()
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m.toLowerCase()
  }
  return ''
}

/**
 * Map a thrown engine error to a taxonomy code by message needle, or `null` when
 * it matches neither class (caller keeps its own default). `navigation_failed`
 * is checked first so an unreachable-host `net::ERR_*` surfaced through a closed
 * page is not swallowed by the broader crash needles.
 */
export function classifyEngineError(err: unknown): ErrorCode | null {
  const text = errorText(err)
  if (text.length === 0) return null
  if (NAVIGATION_FAILED_NEEDLES.some((n) => text.includes(n))) return 'navigation_failed'
  if (PAGE_CRASH_NEEDLES.some((n) => text.includes(n))) return 'page_crash'
  return null
}

/** True when `err` looks like a CDP/browser transport drop (retryable reconnect). */
export function isPageCrash(err: unknown): boolean {
  return classifyEngineError(err) === 'page_crash'
}
