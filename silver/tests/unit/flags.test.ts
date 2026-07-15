import { describe, it, expect } from 'vitest'
import { parseFlags } from '../../src/core/flags.js'

// Focused on the adopt-list-v2 flags added here (H1 --engine, B1 coordinate
// pairs, E4 --grant-permissions, G5 --list). Pure string parsing, no I/O.

describe('flags: H1 --engine', () => {
  it('parses --engine firefox', () => {
    expect(parseFlags(['open', 'x', '--engine', 'firefox']).engine).toBe('firefox')
  })
  it('parses --engine=webkit inline form', () => {
    expect(parseFlags(['open', 'x', '--engine=webkit']).engine).toBe('webkit')
  })
  it('defaults engine to undefined (session normalizes to chromium)', () => {
    expect(parseFlags(['open', 'x']).engine).toBeUndefined()
  })
})

describe('flags: B1 coordinate pairs', () => {
  it('--at x y consumes two numeric tokens into a pair', () => {
    const f = parseFlags(['click', '--at', '50', '60', '--enable-actions'])
    expect(f.at).toEqual([50, 60])
    expect(f.verb).toBe('click')
    expect(f.enableActions).toBe(true)
    // the pair tokens are NOT left as positionals
    expect(f.args).toEqual([])
  })
  it('--from x y --to x y parse independently', () => {
    const f = parseFlags(['drag', '--from', '10', '20', '--to', '80', '90'])
    expect(f.from).toEqual([10, 20])
    expect(f.to).toEqual([80, 90])
  })
  it('type --at x y keeps the trailing text as a positional', () => {
    const f = parseFlags(['type', '--at', '5', '6', 'hello world'])
    expect(f.at).toEqual([5, 6])
    expect(f.args).toEqual(['hello world'])
  })
  it('--at=x,y inline form is accepted', () => {
    expect(parseFlags(['click', '--at=12,34']).at).toEqual([12, 34])
  })
  it('a non-numeric pair leaves the field undefined (no partial coordinate)', () => {
    expect(parseFlags(['click', '--at', 'foo', 'bar']).at).toBeUndefined()
  })
})

describe('flags: E4 --grant-permissions', () => {
  it('is a boolean, OFF by default', () => {
    expect(parseFlags(['open', 'x']).grantPermissions).toBe(false)
    expect(parseFlags(['open', 'x', '--grant-permissions']).grantPermissions).toBe(true)
  })
})

describe('flags: G5 --list', () => {
  it('is a boolean, OFF by default', () => {
    expect(parseFlags(['skill']).list).toBe(false)
    expect(parseFlags(['skill', '--list']).list).toBe(true)
  })
})
