/**
 * Uniform response envelope (spec §3 global constraint, red-team S7).
 *
 * Every command returns `{ success, data, error, warning? }`. Commands never
 * throw to the CLI top-level — the dispatcher catches and turns throws into a
 * `fail(...)` envelope.
 */
import { ERRORS, type ErrorCode } from './errors.js'

export type Envelope<T> = {
  success: boolean
  data: T | null
  error: string | null
  warning?: string
}

/** Build a success envelope, optionally carrying a non-fatal warning. */
export function ok<T>(data: T, warning?: string): Envelope<T> {
  const env: Envelope<T> = { success: true, data, error: null }
  if (warning !== undefined) env.warning = warning
  return env
}

/**
 * Build a failure envelope from the error taxonomy.
 *
 * The message comes verbatim from the ERRORS table — a fixed, sanitized
 * recovery instruction. `ctx` is accepted for the CALLER's convenience
 * (logging, branching) but is deliberately NOT interpolated into the message,
 * so no path / host / secret can ever leak into `error`. This is the no-leak
 * invariant enforced by tests/unit/errors.test.ts (and later no-leak.test.ts).
 */
export function fail(code: ErrorCode, ctx?: Record<string, unknown>): Envelope<never> {
  // ctx is intentionally unused in the message body — see the doc comment.
  // Returns Envelope<never> so a failure is assignable to any Envelope<T> a
  // command handler is declared to return, without a cast.
  void ctx
  const entry = ERRORS[code]
  const message = entry ? entry.message : 'an unknown error occurred'
  return { success: false, data: null, error: message }
}

/**
 * Print an envelope. `json` → the raw envelope as JSON (one line). Otherwise a
 * readable human form for interactive use.
 */
export function print(env: Envelope<unknown>, json: boolean): void {
  const out = json ? JSON.stringify(env) : humanForm(env)
  process.stdout.write(out + '\n')
}

function humanForm(env: Envelope<unknown>): string {
  const lines: string[] = []
  if (!env.success) {
    lines.push(`error: ${env.error ?? 'unknown error'}`)
    // A failure can still carry structured diagnostics (e.g. a `batch` failure
    // reports per-subcommand results under `data`). In human mode that detail
    // was previously dropped, leaving only the terse error line. Render it too.
    if (env.data !== null && env.data !== undefined) {
      lines.push(JSON.stringify(env.data, null, 2))
    }
    if (env.warning) lines.push(`warning: ${env.warning}`)
    return lines.join('\n')
  }
  const data = env.data
  if (typeof data === 'string') {
    lines.push(data)
  } else if (data !== null && data !== undefined) {
    lines.push(JSON.stringify(data, null, 2))
  }
  if (env.warning) lines.push(`warning: ${env.warning}`)
  return lines.join('\n')
}
