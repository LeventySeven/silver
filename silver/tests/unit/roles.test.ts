import { describe, it, expect } from 'vitest'
import {
  INTERACTIVE_ROLES,
  CONTENT_ROLES,
  STRUCTURAL_ROLES,
} from '../../src/perception/roles.js'

describe('role allowlists (verbatim from reference snapshot.rs:11-62)', () => {
  it('classifies interactive roles', () => {
    expect(INTERACTIVE_ROLES.has('button')).toBe(true)
    expect(INTERACTIVE_ROLES.has('textbox')).toBe(true)
    expect(INTERACTIVE_ROLES.has('checkbox')).toBe(true)
    expect(INTERACTIVE_ROLES.has('Iframe')).toBe(true)
    // not interactive
    expect(INTERACTIVE_ROLES.has('heading')).toBe(false)
    expect(INTERACTIVE_ROLES.has('generic')).toBe(false)
  })

  it('classifies content roles', () => {
    expect(CONTENT_ROLES.has('heading')).toBe(true)
    expect(CONTENT_ROLES.has('main')).toBe(true)
    expect(CONTENT_ROLES.has('listitem')).toBe(true)
    // not content
    expect(CONTENT_ROLES.has('button')).toBe(false)
    expect(CONTENT_ROLES.has('generic')).toBe(false)
  })

  it('classifies structural roles', () => {
    expect(STRUCTURAL_ROLES.has('generic')).toBe(true)
    expect(STRUCTURAL_ROLES.has('group')).toBe(true)
    expect(STRUCTURAL_ROLES.has('RootWebArea')).toBe(true)
    expect(STRUCTURAL_ROLES.has('WebArea')).toBe(true)
    // not structural
    expect(STRUCTURAL_ROLES.has('button')).toBe(false)
    expect(STRUCTURAL_ROLES.has('heading')).toBe(false)
  })

  it('the three sets are disjoint', () => {
    for (const r of INTERACTIVE_ROLES) {
      expect(CONTENT_ROLES.has(r)).toBe(false)
      expect(STRUCTURAL_ROLES.has(r)).toBe(false)
    }
    for (const r of CONTENT_ROLES) {
      expect(STRUCTURAL_ROLES.has(r)).toBe(false)
    }
  })

  it('has the exact expected cardinalities (guards accidental edits)', () => {
    expect(INTERACTIVE_ROLES.size).toBe(18)
    expect(CONTENT_ROLES.size).toBe(10)
    expect(STRUCTURAL_ROLES.size).toBe(20)
  })
})
