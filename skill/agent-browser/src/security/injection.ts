/**
 * Prompt-injection neutralization for page-derived output (spec §7, red-team C3).
 *
 * Untrusted page content is data, not instructions. Two defenses ship by default:
 *
 *  1. `neutralize()` — regex-strips forged role/boundary tags a hostile page
 *     might inject to impersonate the transcript (`<system>`, `</assistant>`,
 *     `<untrusted ...>`, …), replacing each with a visible
 *     `[PROMPT_INJECTION_NEUTRALIZED]` breadcrumb, then wraps the whole body in
 *     stable, hard-to-forge boundary markers so the host model can always tell
 *     where untrusted content begins and ends.
 *
 *  2. `capOutput()` — opt-in output capping for raw text / console dumps. This
 *     is DISTINCT from the snapshot serializer's never-truncate contract (spec
 *     §5), which fails loudly with `output_overflow` instead of cutting. Capping
 *     applies only to free-form dumps and only when a `maxOutput` is supplied.
 *
 * Applied by the CLI to snapshot / get-text / read / console output.
 */

/** Stable boundary markers (U+27E6 / U+27E7 — not producible by plain HTML). */
const BOUNDARY_OPEN = '⟦page-content untrusted⟧'
const BOUNDARY_CLOSE = '⟦/page-content⟧'

/** Visible breadcrumb left where a forged tag was removed. */
const NEUTRALIZED = '[PROMPT_INJECTION_NEUTRALIZED]'

/**
 * Forged transcript-role / boundary tags, opening or closing forms:
 *   <system> </system> <user> </user> <tool> </tool> <assistant> </assistant>
 *   <untrusted ...> </untrusted>
 * Case-insensitive; global so every occurrence is scrubbed.
 */
const FORGED_ROLE_RE = /<\/?(?:system|user|tool|assistant)>/gi
const FORGED_UNTRUSTED_RE = /<\/?untrusted[^>]*>/gi

/**
 * Strip forged role/boundary tags from page-derived output and wrap the result
 * in stable untrusted-content boundary markers.
 */
export function neutralize(pageOutput: string): string {
  const body = String(pageOutput ?? '')
    .replace(FORGED_ROLE_RE, NEUTRALIZED)
    .replace(FORGED_UNTRUSTED_RE, NEUTRALIZED)
  return `${BOUNDARY_OPEN}\n${body}\n${BOUNDARY_CLOSE}`
}

/**
 * Cap a raw dump to `maxOutput` characters, appending a `…[+N chars]` suffix
 * that names exactly how many characters were dropped. Opt-in: when `maxOutput`
 * is omitted / non-finite, or the string already fits, the input is returned
 * unchanged. A `maxOutput <= 0` caps to the empty string plus the suffix.
 */
export function capOutput(s: string, maxOutput?: number): string {
  const str = String(s ?? '')
  if (maxOutput === undefined || !Number.isFinite(maxOutput)) return str
  const cap = Math.max(0, Math.floor(maxOutput))
  if (str.length <= cap) return str
  const dropped = str.length - cap
  return `${str.slice(0, cap)}…[+${dropped} chars]`
}
