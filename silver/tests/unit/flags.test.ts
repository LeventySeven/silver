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

describe('flags: F7 value flags do not swallow a following flag', () => {
  it('a bare -d does not eat the next --session token', () => {
    const f = parseFlags(['snapshot', '-d', '--session', 's'])
    expect(f.session).toBe('s')
    // depth is left UNSET rather than consuming `--session` as its value
    expect(f.depth).toBeUndefined()
    expect(f.verb).toBe('snapshot')
  })
  it('a bare --timeout does not eat the next --session token', () => {
    const f = parseFlags(['snapshot', '--timeout', '--session', 's'])
    expect(f.session).toBe('s')
    expect(f.timeout).toBeUndefined()
  })
  it('still consumes a real detached value (-d 3) and the attached form (-d3)', () => {
    expect(parseFlags(['snapshot', '-d', '3']).depth).toBe(3)
    expect(parseFlags(['snapshot', '-d3']).depth).toBe(3)
  })
  it('still consumes a negative-number value (not a flag)', () => {
    expect(parseFlags(['snapshot', '--timeout', '-1']).timeout).toBe(-1)
  })
})

describe('flags: F2 --secret (repeatable)', () => {
  it('collects each --secret spec, defaulting to []', () => {
    expect(parseFlags(['fill', '@e1', 'x']).secrets).toEqual([])
    const f = parseFlags([
      'fill', '@e1', 'x',
      '--secret', 'PW@bank.com=abc',
      '--secret', 'MFA=JBSWY3DP',
    ])
    expect(f.secrets).toEqual(['PW@bank.com=abc', 'MFA=JBSWY3DP'])
  })
  it('a bare --secret does not swallow the following flag (F7-guarded)', () => {
    const f = parseFlags(['fill', '@e1', 'x', '--secret', '--session', 's'])
    expect(f.secrets).toEqual([])
    expect(f.session).toBe('s')
  })
})

describe('flags: F5 --taint-guard', () => {
  it('is a boolean, OFF by default', () => {
    expect(parseFlags(['fill', '@e1', 'x']).taintGuard).toBe(false)
    expect(parseFlags(['fill', '@e1', 'x', '--taint-guard']).taintGuard).toBe(true)
  })
})

describe('flags: F10 --use-config removed', () => {
  it('no longer exposes a useConfig field, and --use-config is an inert no-op', () => {
    const f = parseFlags(['open', 'x', '--use-config'])
    expect('useConfig' in f).toBe(false)
    // --no-config still works and is unaffected.
    expect(f.noConfig).toBe(false)
    expect(parseFlags(['open', 'x', '--no-config']).noConfig).toBe(true)
  })
})
