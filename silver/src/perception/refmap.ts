/**
 * RefMap + parseRef + generation grounding gate (spec §4, red-team S1/R4).
 *
 * This is the correctness core. The grounding gate guarantees that a ref minted
 * in an old snapshot generation can NEVER silently dispatch on a different node
 * after a re-render — a stale `e5` fails loudly instead of misclicking.
 *
 * Adapted from reference/agent-browser/cli/src/native/element.rs (parseRef,
 * RefEntry/RefMap) with a generation field added on top.
 */

export type RefEntry = {
  generation: number
  backendNodeId: number
  role: string
  name: string
  nth: number
  frameId: string
  /**
   * The interactive-filter MODE this ref was minted under. Load-bearing for the
   * slow-path re-match: a cursor-interactive / scrollable nameless `generic` carries
   * a DIFFERENT accessible name in interactive vs. full mode (the text fallback is
   * fed only in interactive mode — walk.ts), which shifts its `(role,name,nth)`
   * bucket. The resolver must re-snapshot in the SAME mode this ref was minted in,
   * or a nameless generic can misground. Optional for back-compat (absent → the
   * historical hardcoded interactive re-match).
   */
  interactive?: boolean
}

/** key = bare "e12" (no `@`, no `ref=`). */
export type RefMap = {
  generation: number
  entries: Record<string, RefEntry>
}

/**
 * Normalize a user-supplied ref into its bare `eN` form.
 *
 *   "@e12" | "ref=e12" | "e12"  ->  "e12"
 *   anything else (e.g. "e", "e1x", "foo")  ->  null
 *
 * A valid ref is `e` followed by one or more ASCII digits, after stripping an
 * optional leading `@` or `ref=` and surrounding whitespace.
 */
export function parseRef(s: string): string | null {
  const trimmed = s.trim()
  let body = trimmed
  if (body.startsWith('@')) {
    body = body.slice(1)
  } else if (body.startsWith('ref=')) {
    body = body.slice(4)
  }
  return /^e\d+$/.test(body) ? body : null
}

/**
 * The grounding gate. Run this on EVERY ref-taking command before any action.
 *
 *   - parseRef fails OR the ref is not a known key  -> element_not_found
 *   - the ref exists but its generation != current  -> ref_stale (the
 *     silent-wrong-click guard)
 *   - otherwise                                      -> ok, with the entry
 */
export function groundRef(
  map: RefMap,
  raw: string,
):
  | { ok: true; entry: RefEntry; ref: string }
  | { ok: false; code: 'ref_stale' | 'element_not_found' } {
  const r = parseRef(raw)
  if (r === null || !Object.prototype.hasOwnProperty.call(map.entries, r)) {
    return { ok: false, code: 'element_not_found' }
  }
  const entry = map.entries[r] as RefEntry
  if (entry.generation !== map.generation) {
    // The string is still present, but it belongs to a prior snapshot — refuse.
    return { ok: false, code: 'ref_stale' }
  }
  return { ok: true, entry, ref: r }
}

/** Monotonic generation bump; each snapshot mints a fresh generation. */
export function newGeneration(prev: number): number {
  return prev + 1
}
