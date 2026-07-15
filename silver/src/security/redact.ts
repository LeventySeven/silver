/**
 * Value redaction at the serializer choke point (plan Task 6, spec §5/§7).
 *
 * The serializer routes every emitted node value through `redactValue` so
 * secrets can never appear in a snapshot / get-text output. This is the single
 * choke point the trifecta suite (test 3: a `type=password` value never appears
 * in any snapshot) relies on.
 *
 * Two independent signals redact a value:
 *   1. It is a password input. We accept this two ways (belt AND suspenders):
 *      an explicit `isPassword` flag surfaced by the walk from the DOM input
 *      type, OR a role/name that hints "password" (defense in depth for cases
 *      where the DOM type flag is unavailable, e.g. a re-rendered field).
 *   2. The value looks like a payment-card number (13-19 digits, optionally
 *      grouped by spaces/dashes).
 *
 * Redaction is purely local (keyless) — no model, no network.
 */

/** The single sentinel emitted in place of any secret value. */
export const REDACTED = '[redacted]'

/**
 * Card-shaped value: 13-19 digits, each optionally followed by a single space
 * or dash separator, on a word boundary. Matches "4111111111111111",
 * "4111 1111 1111 1111", "4111-1111-1111-1111", etc. Kept deliberately loose —
 * over-redacting a value is safe; leaking a card number is not.
 */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/

/** Case-insensitive hint that a field is a password field. */
const PASSWORD_HINT_RE = /password|passwd|pwd/i

/**
 * Decide the value to emit for a node. Returns `"[redacted]"` when the value
 * belongs to a password field or looks like a card number; otherwise returns
 * `rawValue` unchanged.
 *
 * @param role      the node's ARIA role (a "password" hint may live here)
 * @param name      the node's accessible name (another "password" hint source)
 * @param rawValue  the raw value the AX tree reported for the node
 * @param isPassword explicit DOM-derived password flag (default false)
 */
export function redactValue(
  role: string,
  name: string,
  rawValue: string,
  isPassword = false,
): string {
  if (isPassword) return REDACTED
  if (PASSWORD_HINT_RE.test(role) || PASSWORD_HINT_RE.test(name)) return REDACTED
  if (rawValue !== '' && CARD_RE.test(rawValue)) return REDACTED
  return rawValue
}
