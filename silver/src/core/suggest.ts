/**
 * Command-not-found typo suggestion (adopt-list D5a) — `silver clik @e5` should
 * cost a "did you mean `click`?" hint, not a wasted host round-trip.
 *
 * Two tiers, in order:
 *   1. An explicit ALIAS map (`goto` → `open`, `tap` → `click`, …) — the common
 *      alternate names no edit-distance would reliably reach.
 *   2. A hand-rolled Levenshtein over the REAL verb table, returning the closest
 *      verb within a length-scaled threshold.
 *
 * SECURITY (the load-bearing detail): the suggestion is computed on a SANITIZED
 * token prefix only — the leading `[A-Za-z][A-Za-z0-9_-]...` run of the input.
 * A mistyped verb is a bare word; a URL / selector / secret VALUE mistakenly
 * passed as the verb (`silver https://evil.example/pay?token=…`) is NOT a bare
 * word, so nothing past the first unsafe character can ever reach the error
 * string. The returned `suggestion` is itself always a value from our OWN alias
 * targets / verb table, never echoed user input.
 *
 * KEYLESS: pure string math (hand-rolled Levenshtein, no dependency).
 */

/**
 * Common alternate spellings → the canonical Silver verb. Consulted BEFORE
 * edit-distance. Keys are lowercase; values MUST be real verbs in the table the
 * caller passes to {@link suggestVerb}.
 */
export const VERB_ALIASES: Readonly<Record<string, string>> = {
  goto: 'open',
  go: 'open',
  visit: 'open',
  browse: 'open',
  nav: 'open',
  navigate: 'open',
  load: 'open',
  quit: 'close',
  exit: 'close',
  tap: 'click',
  press: 'click',
  input: 'fill',
  write: 'fill',
  enter: 'type',
  screengrab: 'screenshot',
  screencap: 'screenshot',
  shot: 'screenshot',
  ss: 'screenshot',
  capture: 'screenshot',
  scrape: 'extract',
  grab: 'extract',
  assert: 'expect',
  check: 'expect',
  verify: 'expect',
  waitfor: 'wait',
  refresh: 'reload',
  scrolldown: 'scroll',
}

/** The safe token prefix of `input`: the leading `[A-Za-z][A-Za-z0-9_-]*` run. */
export function sanitizeToken(input: string): string | null {
  const m = String(input ?? '').match(/^[A-Za-z][A-Za-z0-9_-]*/)
  return m ? m[0] : null
}

/** Classic iterative Levenshtein edit distance (two-row DP). Case-sensitive. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ac = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** A typo-suggestion result. */
export type VerbSuggestion = {
  /** The sanitized token the suggestion was computed from (safe to echo). */
  input: string
  /** The suggested canonical verb (always from the alias targets / verb table). */
  suggestion: string
  /** How it was reached. */
  reason: 'alias' | 'distance'
  /** Edit distance (only for `reason:"distance"`). */
  distance?: number
}

/** Max edit distance accepted, scaled by the input length (short words → stricter). */
function threshold(len: number): number {
  if (len <= 3) return 1
  if (len <= 6) return 2
  return 3
}

/**
 * Suggest the closest real verb for a not-found `input`.
 *
 * Returns `null` when there is nothing safe or close to suggest — including the
 * critical case where `input` is not a bare token (a URL / selector / value), so
 * no untrusted content ever reaches the caller's error string.
 *
 * `knownVerbs` is the REAL verb table (the caller passes Silver's dispatch list),
 * keeping this module decoupled and the alias targets validated against reality.
 */
export function suggestVerb(input: string, knownVerbs: readonly string[]): VerbSuggestion | null {
  const token = sanitizeToken(input)
  if (!token) return null
  const lower = token.toLowerCase()

  // An exact hit is not a typo — nothing to suggest.
  const known = new Set(knownVerbs.map((v) => v.toLowerCase()))
  if (known.has(lower)) return null

  // Tier 1: explicit alias, but only if its target is a real verb.
  const alias = VERB_ALIASES[lower]
  if (alias && known.has(alias.toLowerCase())) {
    return { input: token, suggestion: alias, reason: 'alias' }
  }

  // Tier 2: nearest verb by edit distance, within the length-scaled threshold.
  let best: string | null = null
  let bestDist = Infinity
  for (const verb of knownVerbs) {
    const d = levenshtein(lower, verb.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = verb
    }
  }
  if (best !== null && bestDist <= threshold(lower.length)) {
    return { input: token, suggestion: best, reason: 'distance', distance: bestDist }
  }
  return null
}
