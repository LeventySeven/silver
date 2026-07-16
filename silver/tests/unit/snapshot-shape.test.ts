import { describe, it, expect } from 'vitest'
import { snapshotShapeKey, diffBaseline } from '../../src/core/handlers.js'
import { observe } from '../../src/perception/diff.js'

// S1 (primary): a snapshot's stored tree is only diff-comparable to a NEW tree
// taken with the SAME render-shape flags. A shape-flip (e.g. `snapshot -i` then
// `snapshot`) shares almost no lines, so diffing the two would drive the Myers
// edit distance toward N+M — the OOM path. `snapshotShapeKey` fingerprints the
// shape; `diffBaseline` returns a diff baseline only when it matches. These are
// the exact two helpers handleSnapshot calls before `observe`.

describe('snapshotShapeKey (S1 shape fingerprint)', () => {
  it('is deterministic for the same flags', () => {
    expect(snapshotShapeKey({ interactive: true, depth: 2 })).toBe(
      snapshotShapeKey({ interactive: true, depth: 2 }),
    )
  })

  it('encodes every shape-affecting flag (each flip changes the key)', () => {
    const base = snapshotShapeKey({})
    expect(snapshotShapeKey({ interactive: true })).not.toBe(base)
    expect(snapshotShapeKey({ compact: true })).not.toBe(base)
    expect(snapshotShapeKey({ depth: 3 })).not.toBe(base)
    expect(snapshotShapeKey({ selector: '#main' })).not.toBe(base)
    expect(snapshotShapeKey({ urls: true })).not.toBe(base)
  })
})

describe('diffBaseline (S1 shape-gated diff selection)', () => {
  const INTERACTIVE = snapshotShapeKey({ interactive: true })
  const FULL = snapshotShapeKey({})

  it('returns the stored tree ONLY when prevTree exists AND the shape matches', () => {
    expect(diffBaseline({ prevTree: '- a\n- b', shapeKey: INTERACTIVE }, INTERACTIVE)).toBe(
      '- a\n- b',
    )
  })

  it('a shape-flip (different flags) yields null — no cross-shape diff', () => {
    // stored an interactive-only tree; a subsequent FULL snapshot must NOT diff it
    expect(diffBaseline({ prevTree: '- a\n- b', shapeKey: INTERACTIVE }, FULL)).toBeNull()
  })

  it('a null prevTree (post-nav reset) never diffs, even with a matching shapeKey', () => {
    expect(diffBaseline({ prevTree: null, shapeKey: FULL }, FULL)).toBeNull()
  })

  it('a prev with no shapeKey (e.g. an extract-stored tree) never diffs', () => {
    expect(diffBaseline({ prevTree: '- a' }, FULL)).toBeNull()
  })

  it('a missing prev (first observation) yields null', () => {
    expect(diffBaseline(null, FULL)).toBeNull()
    expect(diffBaseline(undefined, FULL)).toBeNull()
  })
})

describe('shape-flip end-to-end (handleSnapshot decision path)', () => {
  it('a shape-flip yields the FULL tree, not a diff', () => {
    const prevInteractive = {
      prevTree: '- button "Buy" [ref=e1]',
      shapeKey: snapshotShapeKey({ interactive: true }),
    }
    const fullTree = '- heading "Cart"\n- text "Total: $9"\n- button "Buy" [ref=e1]'
    const r = observe(diffBaseline(prevInteractive, snapshotShapeKey({})), fullTree)
    expect(r.output).toBe(fullTree)
    expect(r.diff).toBeNull()
  })

  it('same shape still diffs a small change (the normal path is intact)', () => {
    const key = snapshotShapeKey({})
    // A base long enough that a one-line diff (a couple hunk lines) beats the full
    // tree, so observe returns the diff — proving the shape gate does not suppress
    // the normal diff path when the shape matches.
    const base = Array.from({ length: 40 }, (_, i) => `- item ${i} [ref=e${i}]`).join('\n')
    const prev = { prevTree: base, shapeKey: key }
    const next = base.replace('- item 20 [ref=e20]', '- item TWENTY changed [ref=e20]')
    const r = observe(diffBaseline(prev, key), next)
    expect(r.diff).not.toBeNull()
    expect(r.output).toBe(r.diff)
    expect(r.output).toContain('@@')
    expect(r.output).toContain('+- item TWENTY changed [ref=e20]')
  })
})
