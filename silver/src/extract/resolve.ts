/**
 * Keyless ID → value reverse map for `extract resolve` (spec §3 P4, §8; plan Task 10).
 *
 * The host runs inference over the ID-transformed bundle (transform.ts) and
 * emits a result whose URL fields are element IDs (`3-18`), never free-text
 * URLs. `resolveIds` walks that result along the recorded URL paths and swaps
 * each ID back for its real value from the snapshot's `valueMap`.
 *
 * Two hardenings over Stagehand's `injectUrls`:
 *   1. Generation gating — the `valueMap` is keyed to the snapshot generation.
 *      If the bundle was built against a stale snapshot (`bundleGeneration !==
 *      currentGeneration`), resolution is refused with `ref_stale` rather than
 *      resolving IDs against a value map that no longer describes the page.
 *   2. Loud null — an ID not present in the value map becomes `null` plus a
 *      warning that names the offending IDs, instead of Stagehand's silent
 *      `?? ""` (which would fabricate an empty string and hide the miss).
 *
 * KEYLESS: this module only transforms JSON. No model, no network.
 */

/** The element-ID shape the host is constrained to emit for URL fields. */
const ID_PATTERN = /^\d+-\d+$/

export type ResolveResult =
  | { ok: true; data: unknown; warning?: string }
  | { ok: false; code: 'ref_stale' }

/**
 * Reverse-map element IDs back to real values.
 *
 * @param result           the host's extraction output (IDs in URL fields)
 * @param urlFieldPaths    dot-joined paths from transformSchema (e.g. "*.url")
 * @param valueMap         id → real value, keyed to the snapshot generation
 * @param bundleGeneration the generation the bundle/valueMap was built against
 * @param currentGeneration the session's current snapshot generation
 */
export function resolveIds(
  result: unknown,
  urlFieldPaths: string[],
  valueMap: Record<string, string>,
  bundleGeneration: number,
  currentGeneration: number,
): ResolveResult {
  // Harden #1: a stale snapshot's valueMap must not resolve.
  if (bundleGeneration !== currentGeneration) {
    return { ok: false, code: 'ref_stale' }
  }

  // Work on a copy so the caller's parsed JSON is never mutated.
  let data = clone(result)
  const unknownIds = new Set<string>()

  for (const path of urlFieldPaths) {
    if (path === '') {
      // Root-level URL string (schema itself was a url leaf).
      data = resolveLeaf(data, valueMap, unknownIds)
    } else {
      applyPath(data, path.split('.'), valueMap, unknownIds)
    }
  }

  if (unknownIds.size > 0) {
    // Harden #2: loud null — name every ID we could not resolve.
    const ids = [...unknownIds].join(', ')
    const warning =
      `unresolved element IDs set to null: ${ids} — ` +
      `these IDs are not in the current snapshot's value map (the element may no longer ` +
      `exist); re-snapshot and re-run extract to obtain fresh IDs`
    return { ok: true, data, warning }
  }

  return { ok: true, data }
}

/** Replace a single leaf value: an ID → its mapped value, or (unknown ID) → null. */
function resolveLeaf(
  value: unknown,
  valueMap: Record<string, string>,
  unknownIds: Set<string>,
): unknown {
  if (typeof value === 'string' && ID_PATTERN.test(value)) {
    if (Object.prototype.hasOwnProperty.call(valueMap, value)) {
      return valueMap[value]
    }
    // Unknown ID → loud null (never "" — that would fabricate a value).
    unknownIds.add(value)
    return null
  }
  // Non-ID values (null, "", a stray literal) are left untouched.
  return value
}

/**
 * Walk `node` down `segments`, resolving the leaf(s) the path addresses.
 * `*` means "every element of this array"; a plain segment is an object key.
 */
function applyPath(
  node: unknown,
  segments: string[],
  valueMap: Record<string, string>,
  unknownIds: Set<string>,
): void {
  if (segments.length === 0 || node === null || typeof node !== 'object') return
  const [seg, ...rest] = segments

  if (seg === '*') {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i += 1) {
      if (rest.length === 0) {
        node[i] = resolveLeaf(node[i], valueMap, unknownIds)
      } else {
        applyPath(node[i], rest, valueMap, unknownIds)
      }
    }
    return
  }

  const rec = node as Record<string, unknown>
  if (rest.length === 0) {
    if (Object.prototype.hasOwnProperty.call(rec, seg)) {
      rec[seg] = resolveLeaf(rec[seg], valueMap, unknownIds)
    }
  } else {
    applyPath(rec[seg], rest, valueMap, unknownIds)
  }
}

/** Deep clone of host-supplied plain JSON (Node ≥17 global). */
function clone<T>(v: T): T {
  return structuredClone(v)
}
