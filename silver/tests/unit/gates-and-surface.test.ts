import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../../src/core/config.js'
import { withSessionLock } from '../../src/core/lock.js'
import { sessionDir, setNamespace } from '../../src/core/session.js'

/**
 * Fixes from the whole-codebase audit that are cheap to pin at the unit level.
 * Each of these failed in the PERMISSIVE or SILENT direction, which is why they
 * survived so long — nothing errored, the operator just did not get what they
 * asked for.
 */

describe('SILVER_HOME relocates the USER config too', () => {
  let dir = ''
  const prev = process.env.SILVER_HOME

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-cfghome-'))
    await fs.mkdir(path.join(dir, 'sandbox'), { recursive: true })
  })
  afterEach(async () => {
    if (prev === undefined) delete process.env.SILVER_HOME
    else process.env.SILVER_HOME = prev
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('reads the user config from SILVER_HOME, not the real home', async () => {
    // This was the last file still resolved from the real home, so a sandboxed or
    // test run read — and could be steered by — the developer's own config.
    const sandbox = path.join(dir, 'sandbox')
    await fs.writeFile(path.join(sandbox, 'config.json'), JSON.stringify({ session: 'from-sandbox' }))
    process.env.SILVER_HOME = sandbox

    const { config } = loadConfig({ cwd: dir, env: {} })
    expect(config.session).toBe('from-sandbox')
  })

  it('an explicit opts.home still wins, so tests can inject one', async () => {
    const injected = path.join(dir, 'injected')
    await fs.mkdir(path.join(injected, '.silver'), { recursive: true })
    await fs.writeFile(
      path.join(injected, '.silver', 'config.json'),
      JSON.stringify({ session: 'from-injected' }),
    )
    process.env.SILVER_HOME = path.join(dir, 'sandbox')

    const { config } = loadConfig({ cwd: dir, home: injected, env: {} })
    expect(config.session).toBe('from-injected')
  })
})

describe('the session lock is created already-populated', () => {
  afterEach(() => setNamespace(''))

  it('never leaves a zero-byte lockfile a racing acquirer could steal', async () => {
    // The record used to be written AFTER the exclusive create, so the file was
    // observably empty in between — and an acquirer that hit EEXIST in that window
    // read a corrupt record, which `isStale` treats as stale and STEALS. Two
    // holders, one lock, on the primitive whose job is preventing exactly that.
    const name = `lock-atomic-${process.pid}-${Date.now()}`
    const lockPath = path.join(sessionDir(name), '.lock')

    let sawEmpty = false
    const observed: number[] = []
    await withSessionLock(name, async () => {
      // Poll the file while we hold it: it must always parse.
      for (let i = 0; i < 20; i++) {
        const raw = await fs.readFile(lockPath, 'utf8').catch(() => null)
        if (raw !== null) {
          observed.push(raw.length)
          if (raw.length === 0) sawEmpty = true
          else expect(() => JSON.parse(raw) as unknown).not.toThrow()
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    })

    expect(sawEmpty).toBe(false)
    expect(observed.length).toBeGreaterThan(0)
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  })

  it('still serializes: a second acquirer waits rather than stealing', async () => {
    const name = `lock-serial-${process.pid}-${Date.now()}`
    const order: string[] = []
    await Promise.all([
      withSessionLock(name, async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 120))
        order.push('a-end')
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 20))
        await withSessionLock(name, async () => {
          order.push('b-start')
          order.push('b-end')
        })
      })(),
    ])
    // No interleaving: b must not start before a finished.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  })
})
