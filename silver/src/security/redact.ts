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

/**
 * Global variant of {@link CARD_RE} for masking EVERY card-shaped run in a blob
 * of markup (`redactValue` only needs a single boolean test). Kept in lock-step
 * with `CARD_RE` — same pattern, `g` flag.
 */
const CARD_RE_G = /\b(?:\d[ -]?){13,19}\b/g

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

/**
 * Read one attribute's value out of a single serialized tag. Returns `''` when
 * the attribute is absent. Handles double-quoted, single-quoted, and unquoted
 * forms. Used by {@link redactHtml} to inspect a password field's hint
 * attributes (`name`/`id`/`autocomplete`).
 */
function tagAttr(tag: string, attr: string): string {
  const m = tag.match(
    new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]*))`, 'i'),
  )
  if (!m) return ''
  return m[1] ?? m[2] ?? m[3] ?? ''
}

/**
 * Redact secrets out of a blob of element HTML — the `get html` read path, the
 * one read surface that emits raw serialized markup rather than a single node
 * value. Two masks, mirroring `redactValue`'s two signals but applied to HTML:
 *
 *   1. The `value` ATTRIBUTE of a PASSWORD input. A server-prefilled
 *      `value="…"` on a `type=password` field IS serialized into `outerHTML`
 *      (unlike a live-typed value, which lives only on the `.value` DOM
 *      property and never reaches the markup) and would otherwise leak
 *      verbatim. Belt-and-suspenders, mirroring `redactValue`: a field is also
 *      treated as a password field when its `name`/`id`/`autocomplete`
 *      attribute matches {@link PASSWORD_HINT_RE}. Processed PER `<input>` tag
 *      so ONLY password inputs have their value masked — a normal text input
 *      keeps its value.
 *   2. Any card-shaped digit run ANYWHERE in the markup (attribute, text node,
 *      inline handler) → {@link REDACTED}, via the global card variant.
 *
 * Runs BEFORE `presentPageText` (neutralize + cap). Over-redaction is safe; a
 * leak is not. Purely local (keyless) — no model, no network.
 */
export function redactHtml(html: string): string {
  const masked = html.replace(/<input\b[^>]*>/gi, (tag) => {
    const isPassword =
      /\btype\s*=\s*(['"]?)password\1/i.test(tag) ||
      PASSWORD_HINT_RE.test(tagAttr(tag, 'name')) ||
      PASSWORD_HINT_RE.test(tagAttr(tag, 'id')) ||
      PASSWORD_HINT_RE.test(tagAttr(tag, 'autocomplete'))
    if (!isPassword) return tag
    // Mask the value attribute (double-quoted, single-quoted, or unquoted) on
    // THIS password tag only — not every input on the page.
    return tag.replace(
      /(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]*)/i,
      `$1"${REDACTED}"`,
    )
  })
  return masked.replace(CARD_RE_G, REDACTED)
}
