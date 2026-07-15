import { describe, it, expect } from 'vitest'
import { render, OutputOverflowError } from '../../src/perception/serialize.js'
import type { SnapNode } from '../../src/perception/walk.js'
import type { RefMap } from '../../src/perception/refmap.js'

/** Build a SnapNode with sensible defaults; override what a test cares about. */
function mk(p: Partial<SnapNode> & { role: string; level: number }): SnapNode {
  return {
    backendNodeId: p.backendNodeId ?? 0,
    role: p.role,
    name: p.name ?? '',
    value: p.value ?? '',
    level: p.level,
    flags: p.flags ?? {},
    frameId: p.frameId ?? 'main',
    cursorInteractive: p.cursorInteractive ?? false,
    refEligible: p.refEligible ?? false,
    isPassword: p.isPassword ?? false,
    url: p.url,
  }
}

/**
 * A hand-built tree exercising: RootWebArea promotion, a heading (content ref),
 * a disabled button, a link with a url, a structural `list` wrapper, a password
 * textbox (redacted), a checked checkbox, a bare `group` (dropped by compact),
 * and a collapsed empty `generic` promoting its StaticText child.
 */
function fixture(): SnapNode[] {
  return [
    mk({ backendNodeId: 0, role: 'RootWebArea', level: 0 }),
    mk({ backendNodeId: 1, role: 'heading', name: 'Welcome', level: 1, refEligible: true }),
    mk({
      backendNodeId: 2,
      role: 'button',
      name: 'Sign in',
      level: 1,
      refEligible: true,
      flags: { disabled: true },
    }),
    mk({
      backendNodeId: 3,
      role: 'link',
      name: 'Docs',
      level: 1,
      refEligible: true,
      url: 'https://ex.com/docs',
    }),
    mk({ backendNodeId: 4, role: 'list', level: 1, refEligible: false }),
    mk({
      backendNodeId: 5,
      role: 'textbox',
      name: 'Password',
      value: 'hunter2',
      level: 2,
      refEligible: true,
      isPassword: true,
    }),
    mk({
      backendNodeId: 6,
      role: 'checkbox',
      name: 'Remember me',
      level: 2,
      refEligible: true,
      flags: { checked: true },
    }),
    mk({ backendNodeId: 7, role: 'group', level: 1, refEligible: false }),
    mk({ backendNodeId: 8, role: 'generic', level: 1, refEligible: false }),
    mk({ backendNodeId: 9, role: 'StaticText', name: 'Footer text', level: 2, refEligible: false }),
  ]
}

const emptyMap: RefMap = { generation: 0, entries: {} }

const GOLDEN = [
  '- title: "Test Page" [url=https://example.com, generation=3]',
  '- heading "Welcome" [ref=e1, level=0]',
  '- button "Sign in" [ref=e2, level=0, disabled]',
  '- link "Docs" [ref=e3, level=0, url=https://ex.com/docs]',
  '- list [level=0]',
  '  - textbox "Password" [ref=e4, level=1]: [redacted]',
  '  - checkbox "Remember me" [ref=e5, level=1, checked=true]',
  '- group [level=0]',
  '- StaticText "Footer text" [level=0]',
].join('\n')

describe('render — golden line format + ref minting', () => {
  it('produces the exact expected text', () => {
    const { text } = render(fixture(), emptyMap, {
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text).toBe(GOLDEN)
  })

  it('mints e1..e5 into a fresh RefMap at the given generation', () => {
    const { refmap } = render(fixture(), emptyMap, {
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(refmap.generation).toBe(3)
    expect(Object.keys(refmap.entries)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(refmap.entries.e1).toMatchObject({
      generation: 3,
      backendNodeId: 1,
      role: 'heading',
      name: 'Welcome',
      nth: 0,
      frameId: 'main',
    })
    expect(refmap.entries.e4).toMatchObject({ backendNodeId: 5, role: 'textbox', name: 'Password' })
    // structural list / group / generic / StaticText never mint a ref
    for (const e of Object.values(refmap.entries)) {
      expect(['list', 'group', 'generic', 'StaticText']).not.toContain(e.role)
    }
  })

  it('assigns nth per (role, name) for duplicate refs', () => {
    const nodes = [
      mk({ backendNodeId: 1, role: 'button', name: 'Go', level: 0, refEligible: true }),
      mk({ backendNodeId: 2, role: 'button', name: 'Go', level: 0, refEligible: true }),
      mk({ backendNodeId: 3, role: 'button', name: 'Stop', level: 0, refEligible: true }),
    ]
    const { refmap } = render(nodes, emptyMap, { generation: 1, title: '', url: '' })
    expect(refmap.entries.e1.nth).toBe(0)
    expect(refmap.entries.e2.nth).toBe(1)
    expect(refmap.entries.e3.nth).toBe(0)
  })
})

describe('render — redaction at the value choke point', () => {
  it('a password node renders [redacted] and never leaks the raw value', () => {
    const { text } = render(fixture(), emptyMap, {
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text).toContain('- textbox "Password" [ref=e4, level=1]: [redacted]')
    expect(text).not.toContain('hunter2')
  })

  it('a card-shaped value is redacted even without the password flag', () => {
    const nodes = [
      mk({
        backendNodeId: 1,
        role: 'textbox',
        name: 'Card',
        value: '4111 1111 1111 1111',
        level: 0,
        refEligible: true,
      }),
    ]
    const { text } = render(nodes, emptyMap, { generation: 1, title: '', url: '' })
    expect(text).toContain(': [redacted]')
    expect(text).not.toContain('4111')
  })
})

describe('render — compact', () => {
  it('drops structural-only lines but keeps ref/value lines + ancestors', () => {
    const { text } = render(fixture(), emptyMap, {
      compact: true,
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    // ref lines survive
    expect(text).toContain('- heading "Welcome" [ref=e1, level=0]')
    expect(text).toContain('  - textbox "Password" [ref=e4, level=1]: [redacted]')
    // `list` is kept because it is an ancestor of the textbox/checkbox refs
    expect(text).toContain('- list [level=0]')
    // bare structural lines with no ref/value and no ref-bearing descendants drop
    expect(text).not.toContain('- group [level=0]')
    expect(text).not.toContain('Footer text')
  })
})

describe('render — never truncate', () => {
  it('throws OutputOverflowError (code output_overflow) instead of slicing', () => {
    let thrown: unknown
    try {
      render(fixture(), emptyMap, {
        maxChars: 50,
        generation: 3,
        title: 'Test Page',
        url: 'https://example.com',
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OutputOverflowError)
    expect((thrown as OutputOverflowError).code).toBe('output_overflow')
  })

  it('does not throw when under the cap', () => {
    expect(() =>
      render(fixture(), emptyMap, {
        maxChars: 100_000,
        generation: 3,
        title: 'Test Page',
        url: 'https://example.com',
      }),
    ).not.toThrow()
  })
})

describe('render — new-since-prev marking', () => {
  it('marks ref-eligible nodes absent from prevRefmap with a `*` bullet', () => {
    const prevRefmap: RefMap = {
      generation: 2,
      entries: {
        pa: { generation: 2, backendNodeId: 1, role: 'heading', name: 'Welcome', nth: 0, frameId: 'main' },
        pb: { generation: 2, backendNodeId: 3, role: 'link', name: 'Docs', nth: 0, frameId: 'main' },
        pc: { generation: 2, backendNodeId: 5, role: 'textbox', name: 'Password', nth: 0, frameId: 'main' },
        pd: { generation: 2, backendNodeId: 6, role: 'checkbox', name: 'Remember me', nth: 0, frameId: 'main' },
      },
    }
    const { text } = render(fixture(), emptyMap, {
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
      prevRefmap,
    })
    // button (backendNodeId 2) was not in prevRefmap -> new -> `*` bullet
    expect(text).toContain('* button "Sign in" [ref=e2, level=0, disabled]')
    // heading was present -> normal `-` bullet
    expect(text).toContain('- heading "Welcome" [ref=e1, level=0]')
  })

  it('marks nothing when prevRefmap is absent', () => {
    const { text } = render(fixture(), emptyMap, {
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text).not.toContain('* ')
  })
})

describe('render — filtered note', () => {
  it('adds the interactive-only note when filtered', () => {
    const { text } = render(fixture(), emptyMap, {
      filtered: true,
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text.split('\n')[1]).toBe('# note: interactive elements only')
  })
})
