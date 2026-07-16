import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadConfig,
  mergeConfig,
  normalizeConfig,
  type SilverConfig,
} from '../../src/core/config.js'
import { parseFlags } from '../../src/core/flags.js'

// E3: config-file system — user → project → env → CLI, lists concatenated,
// scalars overridden only when the CLI set them explicitly (the shadow-boolean).

describe('normalizeConfig — coercion + unknown-key dropping', () => {
  it('coerces csv strings to lists, numeric/boolean scalars, drops unknown keys', () => {
    const cfg = normalizeConfig({
      allowedDomains: 'a.com, b.com',
      confirmActions: ['buy', 'pay'],
      timeout: '5000',
      headed: 'true',
      maxOutput: 1234,
      totallyUnknown: 'ignored',
      session: 'work',
    })
    expect(cfg.allowedDomains).toEqual(['a.com', 'b.com'])
    expect(cfg.confirmActions).toEqual(['buy', 'pay'])
    expect(cfg.timeout).toBe(5000)
    expect(cfg.headed).toBe(true)
    expect(cfg.maxOutput).toBe(1234)
    expect(cfg.session).toBe('work')
    expect((cfg as Record<string, unknown>).totallyUnknown).toBeUndefined()
  })

  it('returns an empty config for non-object input (never throws)', () => {
    expect(normalizeConfig(null)).toEqual({})
    expect(normalizeConfig('nope')).toEqual({})
    expect(normalizeConfig([1, 2])).toEqual({})
  })
})

describe('loadConfig — layering user → project → env', () => {
  let dir: string
  let home: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'silver-cfg-'))
    home = join(dir, 'home')
    cwd = join(dir, 'proj')
    mkdirSync(join(home, '.silver'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('concatenates list fields and last-wins scalars across layers', () => {
    writeFileSync(
      join(home, '.silver', 'config.json'),
      JSON.stringify({ allowedDomains: ['user.com'], timeout: 1000, session: 'u' }),
    )
    writeFileSync(
      join(cwd, 'silver.json'),
      JSON.stringify({ allowedDomains: ['proj.com'], timeout: 2000 }),
    )
    const { config, sources } = loadConfig({
      home,
      cwd,
      env: { SILVER_ALLOWED_DOMAINS: 'env.com' },
    })
    // Lists concatenate across all three layers.
    expect(config.allowedDomains).toEqual(['user.com', 'proj.com', 'env.com'])
    // Scalars: project overrides user; env not set → project value stands.
    expect(config.timeout).toBe(2000)
    expect(config.session).toBe('u')
    expect(sources).toContain('env')
  })

  it('dedupes concatenated list entries (order preserved)', () => {
    writeFileSync(
      join(home, '.silver', 'config.json'),
      JSON.stringify({ allowedDomains: ['a.com', 'b.com'] }),
    )
    writeFileSync(join(cwd, 'silver.json'), JSON.stringify({ allowedDomains: ['b.com', 'c.com'] }))
    const { config } = loadConfig({ home, cwd, env: {} })
    expect(config.allowedDomains).toEqual(['a.com', 'b.com', 'c.com'])
  })

  it('fails OPEN on malformed JSON — warns, never throws', () => {
    writeFileSync(join(cwd, 'silver.json'), '{ this is not json ')
    const { config, warnings } = loadConfig({ home, cwd, env: {} })
    expect(config).toEqual({})
    expect(warnings.length).toBe(1)
    // No path in the warning (no-leak invariant).
    expect(warnings[0]).not.toContain(cwd)
    expect(warnings[0]).toContain('not valid JSON')
  })

  it('missing files are silent (no warnings, empty config)', () => {
    const { config, warnings, sources } = loadConfig({ home, cwd, env: {} })
    expect(config).toEqual({})
    expect(warnings).toEqual([])
    expect(sources).toEqual([])
  })
})

describe('mergeConfig — CLI over config, shadow-boolean precedence', () => {
  it('config fills a scalar the CLI did NOT set; CLI wins when it did', () => {
    const config: SilverConfig = { timeout: 9000, session: 'cfg', headed: true }
    // CLI sets only session explicitly.
    const cli = parseFlags(['snapshot', '--session', 'cli'])
    const { flags, explicit } = mergeConfig(config, cli)
    expect(flags.session).toBe('cli') // CLI explicit → wins
    expect(flags.timeout).toBe(9000) // CLI default → config fills
    expect(flags.headed).toBe(true) // CLI default false → config true fills
    expect(explicit.session).toBe(true)
    expect(explicit.timeout).toBe(false)
    expect(explicit.headed).toBe(false)
  })

  it('a config default never clobbers an explicit CLI scalar (the precedence bug)', () => {
    const config: SilverConfig = { timeout: 9000 }
    const cli = parseFlags(['snapshot', '--timeout', '500'])
    const { flags, explicit } = mergeConfig(config, cli)
    expect(flags.timeout).toBe(500)
    expect(explicit.timeout).toBe(true)
  })

  it('list fields are config ∪ CLI (config first), deduped', () => {
    const config: SilverConfig = { allowedDomains: ['a.com', 'b.com'] }
    const cli = parseFlags(['open', '--allowed-domains', 'b.com,c.com'])
    const { flags, explicit } = mergeConfig(config, cli)
    expect(flags.allowedDomains).toEqual(['a.com', 'b.com', 'c.com'])
    expect(explicit.allowedDomains).toBe(true)
  })

  it('config-supplied confirmActions engages the gate (confirmActionsProvided)', () => {
    const config: SilverConfig = { confirmActions: ['buy'] }
    const cli = parseFlags(['click', '@e1']) // no --confirm-actions
    const { flags } = mergeConfig(config, cli)
    expect(flags.confirmActions).toEqual(['buy'])
    expect(flags.confirmActionsProvided).toBe(true)
  })

  it('does not mutate the input CLI flags object', () => {
    const config: SilverConfig = { timeout: 9000 }
    const cli = parseFlags(['snapshot'])
    const before = cli.timeout
    mergeConfig(config, cli)
    expect(cli.timeout).toBe(before)
  })
})
