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
 * or dash separator. Matches "4111111111111111", "4111 1111 1111 1111",
 * "4111-1111-1111-1111", etc. Kept deliberately loose — over-redacting a value
 * is safe; leaking a card number is not.
 *
 * The run is anchored on DIGIT boundaries rather than `\b` word boundaries, so a
 * card glued directly to a letter/digit still matches (`4111111111111111ok`,
 * `X4111111111111111`, `4111-1111-1111-1111approved`) — a `\b` requires a
 * word/non-word transition and simply does NOT fire at a digit⇄letter edge,
 * letting such cards leak through. The anchors:
 *   - `(?<![\d.\-])` — NOT preceded by a digit, dot, or dash, so the run can't
 *     start in the middle of a longer number or a decimal (`3.14159265358979`
 *     never matches).
 *   - `(?<=\d)` — the run must END on a digit, never a trailing separator.
 *   - `(?![\d])` — NOT followed by a digit, so a card-length run isn't matched
 *     as a fragment of a longer pure-digit number.
 */
const CARD_RE = /(?<![\d.\-])(?:\d[ -]?){13,19}(?<=\d)(?![\d])/

/**
 * Global variant of {@link CARD_RE} for masking EVERY card-shaped run in a blob
 * of markup / page text (`redactValue` only needs a single boolean test). Kept
 * in lock-step with `CARD_RE` — same pattern, `g` flag.
 */
const CARD_RE_G = /(?<![\d.\-])(?:\d[ -]?){13,19}(?<=\d)(?![\d])/g

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
 * Mask every card-shaped digit run in a blob of visible page TEXT with
 * {@link REDACTED}. This is the security choke for the read paths that emit page
 * text rather than a single node value or raw markup — `read`, `get text`, and
 * `snapshot` (a card can surface in an element's accessible name or a StaticText
 * node). Without this, the SAME card that `get html`/`redactValue` mask would
 * leak verbatim through those surfaces.
 *
 * `String.prototype.replace` resets the shared global regex's `lastIndex` to 0
 * at the start of the operation, so there is no cross-call statefulness bug from
 * reusing `CARD_RE_G` here. Over-masking a long non-card digit run is the
 * accepted trade — leaking a card is worse. Purely local (keyless).
 */
export function maskCards(text: string): string {
  return text.replace(CARD_RE_G, REDACTED)
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
