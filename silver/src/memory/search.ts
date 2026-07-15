/**
 * Grep-first memory ranking (keyless — no embeddings, no model).
 *
 * Ranking is deliberately simple and deterministic (Aside pattern 4/5, minus the
 * vector layer that is explicitly OUT for a keyless CLI):
 *
 *   1. TERM OVERLAP — count of DISTINCT query terms present in the note. A note
 *      matching more of the query ranks higher. A note matching ZERO terms is
 *      excluded (grep-first: it would not appear in a `grep`).
 *   2. RECENCY — `max(0, 1 - ageDays/30)` from the note's timestamp. Among notes
 *      with equal overlap, the fresher one wins (Aside's recency decay).
 *   3. FREQUENCY — total term occurrences, a final tiebreak only.
 *
 * These are combined as an explicit multi-key sort, so ranking is trivially
 * testable ("overlap, then recency").
 */
import type { Note } from './store.js'
import { tsMillis } from './store.js'

export type Scored = {
  note: Note
  matched: number // distinct query terms present
  freq: number // total occurrences
  recency: number // 0..1
  score: number // matched + recency (for display / coarse ordering)
}

/** Tokenize a query into distinct lowercase alphanumeric terms. */
export function terms(query: string): string[] {
  const found = String(query ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
  if (!found) return []
  return [...new Set(found)]
}

function recencyOf(note: Note, now: number): number {
  const ms = tsMillis(note)
  if (ms <= 0) return 0
  const ageDays = (now - ms) / 86_400_000
  return Math.max(0, 1 - ageDays / 30)
}

/**
 * Rank notes for a query. Returns the top `limit` scored notes (overlap-then-
 * recency order), excluding zero-overlap notes. An empty query returns [].
 */
export function rank(notes: Note[], query: string, limit = 5, now = Date.now()): Scored[] {
  const qTerms = terms(query)
  if (qTerms.length === 0) return []

  const scored: Scored[] = []
  for (const note of notes) {
    const hay = `${note.heading}\n${note.body}`.toLowerCase()
    let matched = 0
    let freq = 0
    for (const t of qTerms) {
      const occ = countOccurrences(hay, t)
      if (occ > 0) matched++
      freq += occ
    }
    if (matched === 0) continue // grep-first: no match → not a hit
    const recency = recencyOf(note, now)
    scored.push({ note, matched, freq, recency, score: matched + recency })
  }

  scored.sort((a, b) => {
    if (b.matched !== a.matched) return b.matched - a.matched // 1. overlap
    if (b.recency !== a.recency) return b.recency - a.recency // 2. recency
    if (b.freq !== a.freq) return b.freq - a.freq // 3. frequency
    return tsMillis(b.note) - tsMillis(a.note) // stable: newest first
  })

  return scored.slice(0, Math.max(0, limit))
}

function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i < 0) break
    count++
    from = i + needle.length
  }
  return count
}
