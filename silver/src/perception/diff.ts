/**
 * Diff-when-shorter observation (plan Task 7, spec §5).
 *
 * `observe(prev, tree)` returns the snapshot payload the host should read:
 *   - first observation (prev === null)      -> the full tree
 *   - nothing changed (prev === tree)         -> the "No changes detected" sentinel
 *   - a change                                -> whichever is SHORTER, the unified
 *                                                diff or the full tree
 *
 * The diff is a git-style unified diff (`@@ -a,b +c,d @@` hunks with 3 lines of
 * context), built on a hand-implemented Myers O(ND) line diff — no new
 * dependency. The full-tree "new node" `*` marking is the serializer's job
 * (Task 6); this module only produces the unified diff.
 */

/** Sentinel returned when the tree is byte-identical to the previous one. */
export const NO_CHANGES = 'No changes detected'

/** Lines of unchanged context kept around each change, git-default. */
const CONTEXT = 3

/**
 * S1 belt (memory bound). The Myers forward pass records one snapshot of the
 * V-array (length `2*(N+M)+1`) per edit-distance `d`. For two highly DISSIMILAR
 * trees the edit distance D ≈ N+M, so an unbounded pass builds ~D snapshots of a
 * ~2(N+M) array → O((N+M)^2) memory → multi-GB heap → the CLI is OOM-killed.
 *
 * `MAX_TRACE_CELLS` caps the TOTAL cells the trace may hold. Since each snapshot
 * is `2*max+1` cells, the effective `d` cap = `MAX_TRACE_CELLS / (2*max+1)` — it
 * scales INVERSELY with tree size, so trace memory stays under a fixed ceiling
 * (~64MB) regardless of input size. When the true edit distance exceeds the cap
 * the pass bails and `observe` falls back to the full tree; for a near-total
 * change the diff is never shorter than the tree anyway, so nothing useful is
 * lost. A normal small change has a tiny D (a handful of edits) that stays far
 * under the cap, so the ordinary diff path is completely unaffected.
 */
const MAX_TRACE_CELLS = 8_000_000

/**
 * Up-front size guard: a tree pair this large whose lengths differ by this large
 * a fraction is a near-total change whose diff can never beat the full tree, so
 * skip straight to the full tree without running Myers at all. Sized so no normal
 * small diff (a few changed lines on a stable page) is ever affected.
 */
const LARGE_TREE_LINES = 2000
const LENGTH_SKEW_FRAC = 0.3

type Op = { type: 'eq' | 'del' | 'ins'; text: string }

/**
 * Observe a new tree against the previous one and pick the shortest useful
 * representation.
 */
export function observe(
  prevTree: string | null,
  tree: string,
): { tree: string; diff: string | null; output: string } {
  if (prevTree === null) {
    return { tree, diff: null, output: tree }
  }
  if (prevTree === tree) {
    return { tree, diff: null, output: NO_CHANGES }
  }
  const diff = unifiedDiff(prevTree, tree)
  // Degenerate case: strings differ but produced no hunks (should not happen
  // for real line changes) — fall back to the full tree.
  if (diff === '') {
    return { tree, diff: null, output: tree }
  }
  const output = diff.length < tree.length ? diff : tree
  return { tree, diff, output }
}

/** Build a git-style unified diff between two multi-line strings. */
export function unifiedDiff(prev: string, next: string): string {
  const a = prev.split('\n')
  const b = next.split('\n')

  // S1 belt (up-front): a huge pair whose lengths are wildly skewed is a
  // near-total change; its diff can never be shorter than the full tree, so bail
  // to the full tree (observe treats '' as "use the full tree") without paying
  // for a Myers pass at all. Small pages never trip this (maxLen < threshold).
  const maxLen = Math.max(a.length, b.length)
  if (maxLen > LARGE_TREE_LINES && Math.abs(a.length - b.length) > maxLen * LENGTH_SKEW_FRAC) {
    return ''
  }

  const ops = myers(a, b)
  // S1 belt: the forward pass hit its memory bound before converging (two large,
  // highly-dissimilar trees) — fall back to the full tree.
  if (ops === null) return ''

  // Line-number-annotated entries (1-based, matching unified-diff convention).
  let oldNo = 0
  let newNo = 0
  const entries = ops.map((op) => {
    if (op.type === 'eq') {
      oldNo += 1
      newNo += 1
      return { op, oldNo, newNo }
    }
    if (op.type === 'del') {
      oldNo += 1
      return { op, oldNo, newNo }
    }
    newNo += 1
    return { op, oldNo, newNo }
  })

  const changed = entries
    .map((e, i) => (e.op.type !== 'eq' ? i : -1))
    .filter((i) => i >= 0)
  if (changed.length === 0) return ''

  // Expand each change by CONTEXT lines and merge overlapping windows.
  const ranges: { start: number; end: number }[] = []
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(entries.length - 1, i + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  const out: string[] = []
  for (const range of ranges) {
    const slice = entries.slice(range.start, range.end + 1)
    const oldLines = slice.filter((e) => e.op.type !== 'ins')
    const newLines = slice.filter((e) => e.op.type !== 'del')
    const oldStart = oldLines.length ? oldLines[0].oldNo : 0
    const newStart = newLines.length ? newLines[0].newNo : 0
    out.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`)
    for (const e of slice) {
      const prefix = e.op.type === 'eq' ? ' ' : e.op.type === 'del' ? '-' : '+'
      out.push(prefix + e.op.text)
    }
  }
  return out.join('\n')
}

/**
 * Myers O(ND) line diff. Returns the edit script as an ordered list of eq/del/
 * ins ops. Classic greedy forward pass recording the V-array per edit distance
 * `d`, then a backtrack over that trace to recover the script.
 */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max
  const v = new Array<number>(2 * max + 1).fill(0)
  const trace: number[][] = []

  // S1 belt: cap the number of recorded snapshots so the trace can NEVER exceed
  // MAX_TRACE_CELLS. Each snapshot is `2*max+1` cells, so the cap on `d` scales
  // inversely with tree size. `Math.min(max, …)` keeps small inputs (where the
  // budget dwarfs `max`) byte-for-byte identical to the unbounded algorithm.
  const maxD = Math.min(max, Math.floor(MAX_TRACE_CELLS / (2 * max + 1)))

  let done = false
  for (let d = 0; d <= maxD && !done; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1] // move down (insertion)
      } else {
        x = v[offset + k - 1] + 1 // move right (deletion)
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }

  // S1 belt: the pass reached its snapshot cap without the two trees converging
  // (their edit distance exceeds the bound) — signal "too dissimilar to diff
  // cheaply" so the caller falls back to the full tree instead of over-allocating.
  if (!done) return null

  // Backtrack through the recorded traces to reconstruct the script.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = vv[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', text: a[x - 1] })
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'ins', text: b[y - 1] })
        y -= 1
      } else {
        ops.push({ type: 'del', text: a[x - 1] })
        x -= 1
      }
    }
  }
  ops.reverse()
  return ops
}
