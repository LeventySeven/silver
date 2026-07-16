import { describe, it, expect } from 'vitest'
import { observe, unifiedDiff, NO_CHANGES } from '../../src/perception/diff.js'

const HUNK_HEADER = /^@@ -\d+,\d+ \+\d+,\d+ @@$/

describe('observe (diff-when-shorter)', () => {
  it('first observation (prev === null) returns the full tree, no diff', () => {
    const tree = '- a\n- b\n- c'
    const r = observe(null, tree)
    expect(r.output).toBe(tree)
    expect(r.diff).toBeNull()
    expect(r.tree).toBe(tree)
  })

  it('identical trees return the "No changes detected" sentinel', () => {
    const tree = '- a\n- b\n- c'
    const r = observe(tree, tree)
    expect(r.output).toBe(NO_CHANGES)
    expect(r.diff).toBeNull()
  })

  it('a small change yields a diff SHORTER than the full tree -> output is the diff', () => {
    const base = Array.from({ length: 40 }, (_, i) => `- item ${i} [ref=e${i}]`).join('\n')
    const lines = base.split('\n')
    lines[20] = '- item TWENTY changed [ref=e20]'
    const next = lines.join('\n')

    const r = observe(base, next)
    expect(r.diff).not.toBeNull()
    expect(r.diff!.length).toBeLessThan(next.length)
    expect(r.output).toBe(r.diff)
    expect(r.output).toContain('@@')
    // well-formed hunks
    for (const line of r.diff!.split('\n')) {
      if (line.startsWith('@@')) expect(line).toMatch(HUNK_HEADER)
    }
    // git-style prefixes only; diff must NOT introduce `*` markers
    for (const line of r.diff!.split('\n')) {
      expect(/^[ +\-@]/.test(line)).toBe(true)
    }
    // the actual change is present as a delete + insert pair
    expect(r.diff).toContain('-- item 20 [ref=e20]')
    expect(r.diff).toContain('+- item TWENTY changed [ref=e20]')
  })

  it('a huge change makes the diff LONGER than the tree -> output is the full tree', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line a ${i}`).join('\n')
    const b = Array.from(
      { length: 20 },
      (_, i) => `totally different content number ${i} padded out`,
    ).join('\n')
    const r = observe(a, b)
    expect(r.diff).not.toBeNull()
    expect(r.diff!.length).toBeGreaterThanOrEqual(b.length)
    expect(r.output).toBe(b)
  })
})

describe('unifiedDiff', () => {
  it('emits one hunk covering a pure insertion in context', () => {
    const a = 'x\ny\nz'
    const b = 'x\ny\nNEW\nz'
    const diff = unifiedDiff(a, b)
    const headers = diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(headers.length).toBe(1)
    expect(headers[0]).toMatch(HUNK_HEADER)
    expect(diff).toContain('+NEW')
  })

  it('produces well-formed hunks for multiple separated changes', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    const lines = a.split('\n')
    lines[2] = 'l2-CHANGED'
    lines[25] = 'l25-CHANGED'
    const b = lines.join('\n')
    const diff = unifiedDiff(a, b)
    const headers = diff.split('\n').filter((l) => l.startsWith('@@'))
    // two well-separated changes -> two hunks
    expect(headers.length).toBe(2)
    for (const h of headers) expect(h).toMatch(HUNK_HEADER)
  })
})

// S1 belt: the diff path must never allocate the O((N+M)^2) Myers trace, even
// for two large, highly-dissimilar trees (the documented `snapshot -i` → `snapshot`
// escalation, or navigating between two big distinct pages). It bails to the full
// tree instead — which for a near-total change is never longer than the diff.
describe('unifiedDiff / observe — S1 memory bound', () => {
  it('two LARGE, disjoint trees (20000 lines each) return the full tree FAST, no OOM/hang', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `alpha row ${i} xxxxxxxxxx`).join('\n')
    const b = Array.from({ length: 20000 }, (_, i) => `beta content ${i} yyyyyyyy zz`).join('\n')
    const t0 = Date.now()
    const r = observe(a, b)
    const elapsed = Date.now() - t0
    // Edit distance ≈ N+M → the bound bails the diff → observe falls back to the
    // full tree. (If this OOMed the process would have been killed before asserting.)
    expect(r.output).toBe(b)
    expect(r.diff).toBeNull()
    // Completes quickly: a bounded trace, not an O((N+M)^2) allocation.
    expect(elapsed).toBeLessThan(4000)
  })

  it('unifiedDiff bails to "" for two large equal-length disjoint inputs', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 20000 }, (_, i) => `b${i}`).join('\n')
    expect(unifiedDiff(a, b)).toBe('')
  })

  it('up-front size guard bails on a large length-skewed pair (interactive→full shape)', () => {
    const smallInteractiveTree = Array.from({ length: 50 }, (_, i) => `- control ${i}`).join('\n')
    const bigFullTree = Array.from({ length: 6000 }, (_, i) => `- node ${i}`).join('\n')
    expect(unifiedDiff(smallInteractiveTree, bigFullTree)).toBe('')
  })

  it('a small change on a LARGE (same-shape) tree STILL yields a unified diff', () => {
    // Proves the bound leaves the genuinely-useful large-page diff intact: a tiny
    // edit distance stays far under the cap, so the short diff still wins.
    const base = Array.from({ length: 3000 }, (_, i) => `row ${i} [ref=e${i}]`).join('\n')
    const lines = base.split('\n')
    lines[1500] = 'row 1500 CHANGED [ref=e1500]'
    const next = lines.join('\n')
    const r = observe(base, next)
    expect(r.diff).not.toBeNull()
    expect(r.output).toBe(r.diff)
    expect(r.diff!.length).toBeLessThan(next.length)
    expect(r.diff).toContain('@@')
    expect(r.diff).toContain('+row 1500 CHANGED [ref=e1500]')
  })
})
