import { describe, it, expect } from 'vitest'
import { isValidLabel, findTab, emptyRegistry, type TabRecord } from '../../src/core/tabs.js'
import { sanitizeNamespace } from '../../src/core/session.js'

describe('tab label validation', () => {
  it('accepts letter-led alphanumeric/-/_ labels', () => {
    for (const good of ['docs', 'a', 'my-tab_2', 'Checkout']) {
      expect(isValidLabel(good)).toBe(true)
    }
  })
  it('rejects empty, digit-led, punctuation, and t<N>-shadowing labels', () => {
    for (const bad of ['', '2docs', '-x', 'a b', 'a.b', 't1', 't42']) {
      expect(isValidLabel(bad)).toBe(false)
    }
  })
})

describe('findTab', () => {
  const recs: TabRecord[] = [
    { id: 't1', targetId: 'T-AAA' },
    { id: 't2', label: 'docs', targetId: 'T-BBB' },
  ]
  it('resolves by exact id', () => {
    expect(findTab(recs, 't2')?.targetId).toBe('T-BBB')
  })
  it('resolves by exact label', () => {
    expect(findTab(recs, 'docs')?.id).toBe('t2')
  })
  it('returns undefined for an unknown ref', () => {
    expect(findTab(recs, 't9')).toBeUndefined()
    expect(findTab(recs, 'nope')).toBeUndefined()
  })
})

describe('emptyRegistry', () => {
  it('starts at t1 with no active tab', () => {
    const reg = emptyRegistry()
    expect(reg.nextId).toBe(1)
    expect(reg.activeTargetId).toBeNull()
    expect(reg.tabs).toEqual([])
  })
})

describe('sanitizeNamespace', () => {
  it('lowercases and collapses non-alphanumerics into a single path segment', () => {
    expect(sanitizeNamespace('Worktree: One')).toBe('worktree-one')
    expect(sanitizeNamespace('  Group_A / 2  ')).toBe('group-a-2')
  })
  it('returns empty for falsy / all-punctuation input (→ un-namespaced)', () => {
    expect(sanitizeNamespace(undefined)).toBe('')
    expect(sanitizeNamespace('')).toBe('')
    expect(sanitizeNamespace('///')).toBe('')
  })
})
