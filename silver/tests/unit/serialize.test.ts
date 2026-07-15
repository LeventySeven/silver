import { describe, it, expect } from 'vitest'
import { render, OutputOverflowError } from '../../src/perception/serialize.js'
import { cleanUrl, type SnapNode } from '../../src/perception/walk.js'
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
    inputType: p.inputType,
    min: p.min,
    max: p.max,
    options: p.options,
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

// New default format (engine-plan §2 trims): `generation=` dropped from the
// header, `level=0` dropped (indent already encodes it), `url=` opt-in (absent
// without `--urls`/emitUrls). `level=1` on the indented nodes is retained.
const GOLDEN = [
  '- title: "Test Page" [url=https://example.com]',
  '- heading "Welcome" [ref=e1]',
  '- button "Sign in" [ref=e2, disabled]',
  '- link "Docs" [ref=e3]',
  '- list',
  '  - textbox "Password" [ref=e4, level=1]: [redacted]',
  '  - checkbox "Remember me" [ref=e5, level=1, checked=true]',
  '- group',
  '- StaticText "Footer text"',
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
    expect(text).toContain('- heading "Welcome" [ref=e1]')
    expect(text).toContain('  - textbox "Password" [ref=e4, level=1]: [redacted]')
    // `list` is kept because it is an ancestor of the textbox/checkbox refs
    expect(text).toContain('- list')
    // bare structural lines with no ref/value and no ref-bearing descendants drop
    expect(text).not.toContain('- group')
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
    expect(text).toContain('* button "Sign in" [ref=e2, disabled]')
    // heading was present -> normal `-` bullet
    expect(text).toContain('- heading "Welcome" [ref=e1]')
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

describe('render — preamble trim (T3)', () => {
  it('drops the interactive-only note line under filtered mode', () => {
    const { text } = render(fixture(), emptyMap, {
      filtered: true,
      generation: 3,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text).not.toContain('# note')
    // the header is line 0 and the body follows immediately (no preamble line)
    expect(text.split('\n')[0]).toBe('- title: "Test Page" [url=https://example.com]')
  })

  it('drops the generation= echo from the header (still in the RefMap sidecar)', () => {
    const { text, refmap } = render(fixture(), emptyMap, {
      generation: 7,
      title: 'Test Page',
      url: 'https://example.com',
    })
    expect(text).not.toContain('generation=')
    expect(text.split('\n')[0]).toBe('- title: "Test Page" [url=https://example.com]')
    expect(refmap.generation).toBe(7) // generation still travels in the sidecar
  })
})

describe('render — url= opt-in (T1) + level= trim (T2)', () => {
  it('omits inline url= by default and emits it under emitUrls', () => {
    const base = { generation: 1, title: 'T', url: 'https://example.com' }
    const off = render(fixture(), emptyMap, base).text
    expect(off).toContain('- link "Docs" [ref=e3]')
    expect(off).not.toContain('url=https://ex.com/docs')
    const on = render(fixture(), emptyMap, { ...base, emitUrls: true }).text
    expect(on).toContain('- link "Docs" [ref=e3, url=https://ex.com/docs]')
  })

  it('drops level= at indent 0 but keeps it at indent > 0', () => {
    const { text } = render(fixture(), emptyMap, { generation: 1, title: 'T', url: 'u' })
    expect(text).toContain('- heading "Welcome" [ref=e1]') // indent 0 → no level=
    expect(text).toContain('  - textbox "Password" [ref=e4, level=1]: [redacted]') // indent 1 → level=1
  })

  it('drops level= entirely under filtered (interactive) mode', () => {
    const nodes = [
      mk({ backendNodeId: 1, role: 'list', level: 0, refEligible: false }),
      mk({ backendNodeId: 2, role: 'button', name: 'Go', level: 1, refEligible: true }),
    ]
    const { text } = render(nodes, emptyMap, {
      filtered: true,
      generation: 1,
      title: 'T',
      url: 'u',
    })
    expect(text).toContain('- button "Go" [ref=e1]')
    expect(text).not.toContain('level=')
  })
})

describe('render — C1 format hints', () => {
  it('renders a select with its first options and a date input with an ISO hint', () => {
    const nodes = [
      mk({
        backendNodeId: 1,
        role: 'combobox',
        name: 'Country',
        level: 0,
        refEligible: true,
        inputType: 'select',
        options: ['United States', 'Canada', 'Mexico', 'Brazil', 'Chile'],
      }),
      mk({
        backendNodeId: 2,
        role: 'textbox',
        name: 'Birthday',
        level: 0,
        refEligible: true,
        inputType: 'date',
      }),
      mk({
        backendNodeId: 3,
        role: 'slider',
        name: 'Volume',
        level: 0,
        refEligible: true,
        inputType: 'range',
        min: '0',
        max: '11',
      }),
      mk({
        backendNodeId: 4,
        role: 'textbox',
        name: 'Email',
        level: 0,
        refEligible: true,
        inputType: 'email',
      }),
    ]
    const { text } = render(nodes, emptyMap, { generation: 1, title: 'T', url: 'u' })
    // select: first 4 option labels (capped), not all 5
    expect(text).toContain('options=["United States","Canada","Mexico","Brazil"]')
    expect(text).not.toContain('Chile')
    // date: ISO format hint
    expect(text).toContain('format="YYYY-MM-DD"')
    // range: min/max
    expect(text).toContain('min=0')
    expect(text).toContain('max=11')
    // email: a format_hint
    expect(text).toContain('format_hint=email')
  })
})

describe('render — text-leaf merge (P1-P1)', () => {
  it('drops a StaticText child that merely echoes its parent name (dedup)', () => {
    const nodes = [
      mk({ backendNodeId: 1, role: 'button', name: 'Save', level: 0, refEligible: true }),
      mk({ backendNodeId: 2, role: 'StaticText', name: 'Save', level: 1 }),
    ]
    const { text } = render(nodes, emptyMap, { generation: 1, title: '', url: '' })
    expect(text).toContain('- button "Save" [ref=e1]')
    // the redundant text leaf is folded away, not re-emitted as its own line
    expect(text).not.toContain('StaticText "Save"')
  })

  it('keeps a DISTINCT StaticText child under a named parent (no info loss)', () => {
    const nodes = [
      mk({ backendNodeId: 1, role: 'button', name: 'Toolbar', level: 0, refEligible: true }),
      mk({ backendNodeId: 2, role: 'StaticText', name: 'Toolbar', level: 1 }),
      mk({ backendNodeId: 3, role: 'StaticText', name: 'Beta', level: 1 }),
    ]
    const { text } = render(nodes, emptyMap, { generation: 1, title: '', url: '' })
    expect(text).toContain('- button "Toolbar" [ref=e1]')
    expect(text).not.toContain('StaticText "Toolbar"') // duplicate dropped
    expect(text).toContain('StaticText "Beta"') // distinct text preserved
  })

  it('folds text-leaf children into an UNNAMED ref node display name', () => {
    const nodes = [
      // a cursor-interactive div: ref-eligible but no accessible name of its own
      mk({
        backendNodeId: 1,
        role: 'generic',
        name: '',
        level: 0,
        refEligible: true,
        cursorInteractive: true,
      }),
      mk({ backendNodeId: 2, role: 'StaticText', name: 'Click me', level: 1 }),
    ]
    const { refmap, text } = render(nodes, emptyMap, { generation: 1, title: '', url: '' })
    // the folded text appears on the ref node's own line …
    expect(text).toContain('- generic "Click me" [ref=e1]')
    // … and is NOT also emitted as a separate StaticText line
    expect(text).not.toContain('StaticText "Click me"')
    // display-only: the minted RefEntry keeps the node's REAL (empty) name so the
    // resolver's (role,name,nth) shape match still lines up with a fresh walk.
    expect(refmap.entries.e1.name).toBe('')
  })
})

describe('cleanUrl — base resolution (P1-P2)', () => {
  it('resolves a root-relative href against the page base', () => {
    expect(cleanUrl('/login', 'https://example.com/app/page')).toBe('https://example.com/login')
  })

  it('resolves a dot-relative href against the page base', () => {
    expect(cleanUrl('../rel', 'https://example.com/a/b/')).toBe('https://example.com/a/rel')
  })

  it('still strips tracking params on an absolute href', () => {
    expect(cleanUrl('https://ex.com/x?utm_source=n&keep=1')).toBe('https://ex.com/x?keep=1')
  })

  it('leaves a relative href untouched when no base is given (back-compat)', () => {
    expect(cleanUrl('/login')).toBe('/login')
  })
})
