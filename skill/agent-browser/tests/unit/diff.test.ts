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
