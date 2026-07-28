import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../../src/core/config.js'

/**
 * A PROJECT config may narrow, never grant.
 *
 * `silver.json` is read from the working directory, so it arrives with whatever
 * repository happens to be checked out — the lowest-trust layer there is.
 * `enableActions` is the tool's central safety gate: read-only is the default and
 * every state-changing verb is quarantined behind it. A checked-in file that
 * flipped it would silently arm actions for every command run in that directory,
 * which is privilege escalation by `git clone`.
 *
 * This mirrors the trust ordering the allowlist merge already enforces — a
 * lower-trust layer may only tighten — applied to the boolean grants. The USER
 * layer keeps the ability to set them: the user wrote that file themselves.
 */

let dir = ''
let home = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-cfg-proj-'))
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-cfg-home-'))
  await fs.mkdir(path.join(home, '.silver'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

const writeProject = (cfg: unknown) =>
  fs.writeFile(path.join(dir, 'silver.json'), JSON.stringify(cfg), 'utf8')
const writeUser = (cfg: unknown) =>
  fs.writeFile(path.join(home, '.silver', 'config.json'), JSON.stringify(cfg), 'utf8')

const load = () => loadConfig({ cwd: dir, home, env: {} })

describe('a project silver.json cannot grant capability', () => {
  it('ignores enableActions — the central safety gate', async () => {
    await writeProject({ enableActions: true })
    const { config, warnings } = load()
    expect(config.enableActions).toBeUndefined()
    expect(warnings.join(' ')).toContain('enableActions')
  })

  it('ignores the other grant-shaped booleans', async () => {
    await writeProject({
      allowFileAccess: true,
      grantPermissions: true,
      noEncryptState: true,
    })
    const { config } = load()
    expect(config.allowFileAccess).toBeUndefined()
    expect(config.grantPermissions).toBeUndefined()
    expect(config.noEncryptState).toBeUndefined()
  })

  it('ignores contentBoundaries:false — the same grant spelled as a removal', async () => {
    await writeProject({ contentBoundaries: false })
    const { config, warnings } = load()
    expect(config.contentBoundaries).not.toBe(false)
    expect(warnings.join(' ')).toContain('contentBoundaries')
  })

  it('still accepts everything a project config legitimately sets', async () => {
    // The feature has to keep working: a project file exists to stop you retyping
    // flags, and none of these widen anything.
    await writeProject({ session: 'proj', timeout: 9000, allowedDomains: ['example.com'] })
    const { config } = load()
    expect(config.session).toBe('proj')
    expect(config.timeout).toBe(9000)
    expect(config.allowedDomains).toEqual(['example.com'])
  })

  it('warns rather than failing — the rest of the config still loads', async () => {
    await writeProject({ enableActions: true, session: 'still-here' })
    const { config, warnings } = load()
    expect(config.session).toBe('still-here')
    expect(config.enableActions).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('the USER layer may still grant — they wrote that file themselves', async () => {
    await writeUser({ enableActions: true })
    const { config } = load()
    expect(config.enableActions).toBe(true)
  })

  it('a project file cannot override a user DENIAL back to true', async () => {
    await writeUser({ enableActions: false })
    await writeProject({ enableActions: true })
    const { config } = load()
    expect(config.enableActions).toBe(false)
  })
})
