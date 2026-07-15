/**
 * CaMeL-lite taint / data-provenance guard (adopt-list S1) — a KEYLESS defense
 * against the "host echoes untrusted page content verbatim into an action arg"
 * class of prompt injection. No model, no network: it reuses the `⟦untrusted⟧`
 * fence this codebase already stamps onto page-derived output (injection.ts).
 *
 * The read side already wraps everything from snapshot/extract/get/read in the
 * `⟦page-content untrusted⟧ … ⟦/page-content⟧` fence. This is the data-FLOW half:
 * if a value handed to a security-sensitive verb still carries that fence (or the
 * `[PROMPT_INJECTION_NEUTRALIZED]` breadcrumb), it almost certainly originated
 * from page content the host pasted straight back — a beacon/exfil or
 * inject-and-act vector. The guard flags it so the host can confirm or reformulate.
 *
 * OPT-IN BY DESIGN (--taint-guard). Red-team S1: a page legitimately echoes text a
 * host legitimately re-submits (search terms, edited content), so default-on would
 * false-positive on normal page→resubmit flows and train hosts to disable it. The
 * opt-in guard is the MORE secure design because it is the one that stays enabled.
 * When disabled the guard NEVER flags — provenance is still reported for
 * observability but `flagged` is always false.
 */
import { BOUNDARY_OPEN, BOUNDARY_CLOSE, NEUTRALIZED } from './injection.js'

/**
 * Verbs whose argument is an action TARGET / value that a compromised page could
 * weaponize: form input (`fill`/`type`), navigation targets (`open`/`goto`/
 * `navigate`), file selection (`upload`), key sequences (`press`), and arbitrary
 * in-page JS (`eval`). A tainted value reaching one of these is the risk the guard
 * exists for. Read-only observation verbs are deliberately absent.
 */
export const TAINT_SENSITIVE_VERBS: ReadonlySet<string> = new Set([
  'fill',
  'type',
  'open',
  'goto',
  'navigate',
  'upload',
  'press',
  'eval',
])

/**
 * True iff `value` carries page-content provenance: it still contains one of the
 * untrusted-fence markers or the injection-neutralized breadcrumb. That only
 * happens when the host copied fenced page output into the argument verbatim.
 */
export function isTaintedValue(value: string): boolean {
  const s = String(value ?? '')
  return s.includes(BOUNDARY_OPEN) || s.includes(BOUNDARY_CLOSE) || s.includes(NEUTRALIZED)
}

export type TaintDecision = {
  /** Whether the value carries page-content provenance (independent of opt-in). */
  tainted: boolean
  /** Whether the guard is RAISING on this call — only ever true when opt-in AND tainted AND sensitive verb. */
  flagged: boolean
  /** Static reason when flagged (no page content / value echoed). */
  reason?: string
}

/**
 * The guard decision for one mutating-verb dispatch. `enabled` is the
 * `--taint-guard` opt-in. When disabled, `flagged` is ALWAYS false (provenance is
 * still surfaced via `tainted` for observability). When enabled, a tainted value
 * on a sensitive verb is flagged with a structured, no-leak reason the host can
 * act on (confirm or reformulate). Never throws.
 */
export function taintGuardCheck(params: {
  verb: string
  value: string
  enabled: boolean
}): TaintDecision {
  const tainted = isTaintedValue(params.value)
  if (!params.enabled) return { tainted, flagged: false }
  if (!tainted) return { tainted: false, flagged: false }
  if (!TAINT_SENSITIVE_VERBS.has(params.verb)) return { tainted, flagged: false }
  return {
    tainted: true,
    flagged: true,
    reason:
      'argument appears to be untrusted page content (it still carries the ⟦untrusted⟧ provenance fence); confirm it is intended or reformulate without the page text',
  }
}
