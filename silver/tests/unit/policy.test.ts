import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideAction,
  loadPolicy,
  parsePolicy,
  normalizePolicy,
} from '../../src/security/policy.js'

// S5: action policy with a REAL hard deny (precedence deny > confirm > allow > default).

describe('normalizePolicy — shape + defaults', () => {
  it('defaults an absent/invalid default to allow, coerces lists', () => {
    const p = normalizePolicy({ deny: 'download, buy', allow: ['click'] })
    expect(p.default).toBe('allow')
    expect(p.deny).toEqual(['download', 'buy'])
    expect(p.allow).toEqual(['click'])
    expect(p.confirm).toEqual([])
  })

  it('honors an explicit valid default', () => {
    expect(normalizePolicy({ default: 'confirm' }).default).toBe('confirm')
    expect(normalizePolicy({ default: 'DENY' }).default).toBe('deny')
    expect(normalizePolicy({ default: 'bogus' }).default).toBe('allow')
  })
})

describe('decideAction — precedence deny > confirm > allow > default', () => {
  it('deny is a terminal hard stop even when the verb is also allowed/confirmed', () => {
    const p = normalizePolicy({
      default: 'allow',
      allow: ['download'],
      confirm: ['download'],
      deny: ['download'],
    })
    expect(decideAction(p, 'download')).toBe('deny')
  })

  it('confirm beats allow', () => {
    const p = normalizePolicy({ default: 'allow', allow: ['submit'], confirm: ['submit'] })
    expect(decideAction(p, 'submit')).toBe('confirm')
  })

  it('allow beats default deny', () => {
    const p = normalizePolicy({ default: 'deny', allow: ['click'] })
    expect(decideAction(p, 'click')).toBe('allow')
    expect(decideAction(p, 'fill')).toBe('deny') // falls through to default
  })

  it('falls through to default when nothing matches', () => {
    const p = normalizePolicy({ default: 'confirm' })
    expect(decideAction(p, 'anything')).toBe('confirm')
  })

  it('supports glob patterns', () => {
    const p = normalizePolicy({ default: 'allow', deny: ['buy*', 'pay*'] })
    expect(decideAction(p, 'buy')).toBe('deny')
    expect(decideAction(p, 'buynow')).toBe('deny')
    expect(decideAction(p, 'payment')).toBe('deny')
    expect(decideAction(p, 'click')).toBe('allow')
  })

  it('matches @host-scoped patterns against verb@host from ctx', () => {
    const p = normalizePolicy({ default: 'allow', deny: ['download@*.corp.example'] })
    expect(decideAction(p, 'download', { host: 'files.corp.example' })).toBe('deny')
    // Same verb on a different host → not denied.
    expect(decideAction(p, 'download', { host: 'example.com' })).toBe('allow')
    // Host derived from a URL when host is absent.
    expect(decideAction(p, 'download', { url: 'https://x.corp.example/f' })).toBe('deny')
  })

  it('is case-insensitive on the verb', () => {
    const p = normalizePolicy({ default: 'allow', deny: ['Download'] })
    expect(decideAction(p, 'DOWNLOAD')).toBe('deny')
  })
})

describe('parsePolicy / loadPolicy — parsing + no-leak errors', () => {
  let tmp: string | null = null
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    tmp = null
  })

  it('parsePolicy throws a fixed, path-free message on bad JSON', () => {
    expect(() => parsePolicy('{not json')).toThrow('action policy is not valid JSON')
  })

  it('loadPolicy reads + normalizes a file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'silver-pol-'))
    const path = join(tmp, 'policy.json')
    writeFileSync(path, JSON.stringify({ default: 'confirm', deny: ['download'] }))
    const p = loadPolicy(path)
    expect(p.default).toBe('confirm')
    expect(decideAction(p, 'download')).toBe('deny')
  })

  it('loadPolicy throws a path-free message on a missing file', () => {
    const missing = join(tmpdir(), 'silver-nope', 'policy.json')
    try {
      loadPolicy(missing)
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toBe('action policy file could not be read')
      expect(msg).not.toContain(missing)
    }
  })
})
