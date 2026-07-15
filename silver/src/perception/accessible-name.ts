/**
 * Accessible name computation (plan Task 5, W3C accname priority).
 *
 * CDP `Accessibility.getFullAXTree` already computes the W3C accessible name for
 * every node (`AXNode.name`), applying the full priority chain
 * (aria-labelledby -> aria-label -> associated <label> -> alt -> title ->
 * name-from-content incl. ::before/::after). So the primary job here is to
 * NORMALIZE that string, not re-derive it.
 *
 * We keep a pragmatic DOM-attribute fallback for the case where CDP reports an
 * empty name but the DOM still carries a usable label (aria-label / alt / title
 * / placeholder / trimmed text content) — e.g. a cursor-interactive `<div>`
 * button whose AX name is empty.
 *
 * The returned string is the PLAIN name (normalized, <=100 chars). JSON-escaping
 * + quoting happens once, at the serializer choke point, so we never double
 * escape.
 */

/** Max characters for an accessible name (spec §5). */
export const MAX_NAME_LEN = 100

// Zero-width / BOM / soft-hyphen / invisible characters Chrome leaves in names.
const INVISIBLE_RE = /[\uFEFF\u200B\u200C\u200D\u2060\u00AD]/g
// C0/C1 control characters that would corrupt a single-line snapshot.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
// Any run of ASCII/Unicode whitespace (incl. newlines/tabs) collapses to a space.
const WHITESPACE_RE = /\s+/g

export type NameHints = {
  ariaLabel?: string
  alt?: string
  title?: string
  placeholder?: string
  textContent?: string
}

/**
 * Normalize a raw name into its snapshot form: strip invisible + control chars,
 * collapse whitespace, trim, and cap at 100 characters.
 */
export function normalizeName(raw: string): string {
  const cleaned = raw
    .replace(INVISIBLE_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
  return cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN) : cleaned
}

/**
 * Resolve the accessible name for a node. Prefers the CDP-computed W3C name;
 * falls back through the DOM hints in accname priority order when CDP is empty.
 */
export function accessibleName(axName: string, hints: NameHints = {}): string {
  const primary = normalizeName(axName)
  if (primary !== '') return primary

  const fallback =
    hints.ariaLabel ??
    hints.alt ??
    hints.title ??
    hints.textContent ??
    hints.placeholder ??
    ''
  return normalizeName(fallback)
}
