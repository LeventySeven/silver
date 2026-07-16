import { describe, it, expect } from 'vitest'
import {
  isSparseTree,
  SPARSE_TREE_CANVAS_COVERAGE,
  SPARSE_TREE_MAX_REFS,
} from '../../src/perception/walk.js'

// The `sparse_tree` trigger tuning (representation red-team correction #4):
// canvas-DOMINANCE *and* low interactive-ref density — NOT ref-count alone, so a
// healthy small page never false-positives.
describe('isSparseTree — sparse_tree trigger tuning', () => {
  it('FIRES on a canvas-dominant, ref-poor page (bruno-simon: ~full canvas, 1 ref)', () => {
    expect(isSparseTree({ canvasCoverage: 0.98, refEligibleCount: 1 })).toBe(true)
    expect(isSparseTree({ canvasCoverage: 0.87, refEligibleCount: 0 })).toBe(true)
  })

  it('does NOT fire on a healthy small page (example.com: 2 refs, NO canvas)', () => {
    // The exact false-positive the red team called out: a naive `refs < 3` trigger
    // would nag on example.com. Zero canvas coverage must stay silent.
    expect(isSparseTree({ canvasCoverage: 0, refEligibleCount: 2 })).toBe(false)
  })

  it('does NOT fire when a big chart canvas dominates but many controls exist (dashboard)', () => {
    // canvas-dominance ALONE is not enough — a rich dashboard has plenty of refs.
    expect(isSparseTree({ canvasCoverage: 0.9, refEligibleCount: 40 })).toBe(false)
  })

  it('does NOT fire on low ref-count ALONE without canvas dominance', () => {
    expect(isSparseTree({ canvasCoverage: 0.2, refEligibleCount: 0 })).toBe(false)
    expect(isSparseTree({ canvasCoverage: SPARSE_TREE_CANVAS_COVERAGE, refEligibleCount: 0 })).toBe(
      false,
    ) // strictly greater-than the threshold, not equal
  })

  it('boundary: just over the coverage threshold with just-at the ref ceiling fires', () => {
    expect(
      isSparseTree({
        canvasCoverage: SPARSE_TREE_CANVAS_COVERAGE + 0.01,
        refEligibleCount: SPARSE_TREE_MAX_REFS,
      }),
    ).toBe(true)
    // one ref over the ceiling → silent
    expect(
      isSparseTree({
        canvasCoverage: 0.99,
        refEligibleCount: SPARSE_TREE_MAX_REFS + 1,
      }),
    ).toBe(false)
  })
})
