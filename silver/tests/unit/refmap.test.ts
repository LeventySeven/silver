import { describe, it, expect } from 'vitest'
import {
  parseRef,
  groundRef,
  newGeneration,
  type RefEntry,
  type RefMap,
} from '../../src/perception/refmap.js'

function entry(generation: number, over: Partial<RefEntry> = {}): RefEntry {
  return {
    generation,
    backendNodeId: 100,
    role: 'button',
    name: 'Go',
    nth: 0,
    frameId: 'main',
    ...over,
  }
}

describe('parseRef', () => {
  it('accepts all three tolerated forms → bare eN', () => {
    expect(parseRef('@e12')).toBe('e12')
    expect(parseRef('ref=e12')).toBe('e12')
    expect(parseRef('e12')).toBe('e12')
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRef('  @e3  ')).toBe('e3')
    expect(parseRef('\tref=e0\n')).toBe('e0')
  })

  it('rejects malformed refs', () => {
    expect(parseRef('foo')).toBeNull()
    expect(parseRef('e')).toBeNull() // no digits
    expect(parseRef('e1x')).toBeNull() // trailing non-digit
    expect(parseRef('@e')).toBeNull() // no digits after prefix
    expect(parseRef('ref=e')).toBeNull()
    expect(parseRef('12')).toBeNull() // missing the e
    expect(parseRef('')).toBeNull()
    expect(parseRef('E12')).toBeNull() // wrong case
  })
})

describe('groundRef', () => {
  it('passes for a current-generation ref and returns the entry', () => {
    const map: RefMap = { generation: 5, entries: { e1: entry(5), e2: entry(5, { name: 'Two' }) } }
    const res = groundRef(map, '@e2')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.ref).toBe('e2')
      expect(res.entry.name).toBe('Two')
    }
  })

  it('LANDMINE: a ref that still exists but from an older generation → ref_stale, NOT ok, NOT a misclick', () => {
    // e5 is a real key in entries, but it was minted in generation 4 while the
    // map is now at generation 5 (a re-render reminted refs). It must fail
    // loudly rather than dispatch on whatever node currently owns "e5".
    const map: RefMap = {
      generation: 5,
      entries: {
        e5: entry(4, { backendNodeId: 999, name: 'STALE TARGET' }),
      },
    }
    const res = groundRef(map, 'e5')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('ref_stale')
    }
  })

  it('unknown string → element_not_found', () => {
    const map: RefMap = { generation: 1, entries: { e1: entry(1) } }
    const res = groundRef(map, 'e999')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('element_not_found')
  })

  it('unparseable ref → element_not_found', () => {
    const map: RefMap = { generation: 1, entries: { e1: entry(1) } }
    const res = groundRef(map, 'not-a-ref')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('element_not_found')
  })

  it('does not treat inherited Object.prototype keys as entries', () => {
    const map: RefMap = { generation: 1, entries: { e1: entry(1) } }
    // "constructor" is not a valid ref, but guard against prototype confusion.
    const res = groundRef(map, 'constructor')
    expect(res.ok).toBe(false)
  })
})

describe('newGeneration', () => {
  it('is a monotonic +1 bump', () => {
    expect(newGeneration(0)).toBe(1)
    expect(newGeneration(41)).toBe(42)
  })
})
