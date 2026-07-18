import { describe, it, expect } from 'vitest'
import {
  INTERACTIVE_ROLES,
  CONTENT_ROLES,
  STRUCTURAL_ROLES,
} from '../../src/perception/roles.js'

describe('role allowlists (adapted from reference snapshot.rs:11-62; content grammar narrowed in R4)', () => {
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
    expect(CONTENT_ROLES.has('gridcell')).toBe(true) // ARIA interactive-grid cell — kept
    // not content
    expect(CONTENT_ROLES.has('button')).toBe(false)
    expect(CONTENT_ROLES.has('generic')).toBe(false)
    // Round 4 measured downsample: plain-table roles are name-from-content, so as
    // CONTENT_ROLES they flooded the interactive tree with non-actionable data cells.
    // Removed — a bare `<td>`/`<th>` grounds ONLY when genuinely interactive.
    expect(CONTENT_ROLES.has('cell')).toBe(false)
    expect(CONTENT_ROLES.has('columnheader')).toBe(false)
    expect(CONTENT_ROLES.has('rowheader')).toBe(false)
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
    expect(CONTENT_ROLES.size).toBe(7) // was 10; −3 plain-table roles (Round 4 downsample)
    expect(STRUCTURAL_ROLES.size).toBe(20)
  })
})
