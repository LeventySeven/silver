import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import {
  sessionDir,
  writeSidecar,
  enforceBrowserCeiling,
  resolveMaxBrowsers,
  takeEvictionNotice,
  isPidAlive,
  DEFAULT_MAX_BROWSERS,
  type SessionInfo,
} from '../../src/core/session.js'

/**
 * The browser ceiling. The idle reaper bounds how LONG an abandoned browser
 * lives; nothing bounded how MANY run at once, and each one is a whole Chromium
 * (~10 processes, ~1.17 GB measured). A day of agent work put the machine into
 * swap, which is not something a user can fix from their side — hence a cap.
 *
 * The load-bearing difference from `reapIdleSessions`, and what these tests
 * exist to keep true: eviction STOPS the browser but KEEPS the session dir, so
 * the profile (and its logins) survives and the next command respawns it.
 */

const created: string[] = []
const children: ChildProcess[] = []

function uniq(tag: string): string {
  const name = `silver-cap-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  created.push(name)
  return name
}

/** A real, live, DISPOSABLE pid — the ceiling SIGTERMs what it evicts. */
function spawnVictim(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

async function seed(name: string, over: Partial<SessionInfo>): Promise<void> {
  const info: SessionInfo = {
    port: 9222,
    pid: 1,
    wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x',
    createdAt: new Date().toISOString(),
    engine: 'chromium',
    ...over,
  }
  await fs.mkdir(path.join(sessionDir(name), 'profile'), { recursive: true })
  await writeSidecar(path.join(sessionDir(name), 'session.json'), info)
}

/** Wait until `pid` is gone (SIGTERM delivery is asynchronous). */
async function waitDead(pid: number, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !isPidAlive(pid)
}

afterEach(async () => {
  delete process.env.SILVER_MAX_BROWSERS
  takeEvictionNotice()
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const name of created.splice(0)) {
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  }
})

describe('resolveMaxBrowsers', () => {
  it('defaults to DEFAULT_MAX_BROWSERS', () => {
    delete process.env.SILVER_MAX_BROWSERS
    expect(resolveMaxBrowsers()).toBe(DEFAULT_MAX_BROWSERS)
  })

  it('honors SILVER_MAX_BROWSERS', () => {
    process.env.SILVER_MAX_BROWSERS = '7'
    expect(resolveMaxBrowsers()).toBe(7)
  })

  it('treats 0 as "no ceiling" and ignores garbage', () => {
    process.env.SILVER_MAX_BROWSERS = '0'
    expect(resolveMaxBrowsers()).toBe(0)
    process.env.SILVER_MAX_BROWSERS = 'lots'
    expect(resolveMaxBrowsers()).toBe(DEFAULT_MAX_BROWSERS)
  })
})

describe('enforceBrowserCeiling', () => {
  it('stops the most-idle browser to make room, and keeps its dir', async () => {
    process.env.SILVER_MAX_BROWSERS = '2'
    const stale = spawnVictim()
    const fresh = spawnVictim()
    const staleName = uniq('stale')
    const freshName = uniq('fresh')
    await seed(staleName, { pid: stale.pid!, lastUsedAt: ago(60_000) })
    await seed(freshName, { pid: fresh.pid!, lastUsedAt: ago(1_000) })

    const stopped = await enforceBrowserCeiling(uniq('incoming'))

    expect(stopped).toEqual([staleName])
    expect(await waitDead(stale.pid!)).toBe(true)
    expect(isPidAlive(fresh.pid!)).toBe(true)
    // The whole reason this is safe to do automatically: the profile stays.
    await expect(fs.stat(path.join(sessionDir(staleName), 'profile'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(sessionDir(staleName), 'session.json'))).resolves.toBeTruthy()
  })

  it('does nothing while the live count leaves room for one more', async () => {
    process.env.SILVER_MAX_BROWSERS = '3'
    const a = spawnVictim()
    await seed(uniq('a'), { pid: a.pid!, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
    expect(isPidAlive(a.pid!)).toBe(true)
  })

  it('never stops an external browser — we do not own that process', async () => {
    process.env.SILVER_MAX_BROWSERS = '1'
    const ext = spawnVictim()
    const name = uniq('ext')
    await seed(name, { pid: ext.pid!, external: true, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
    expect(isPidAlive(ext.pid!)).toBe(true)
  })

  it('never stops a session a live command is holding', async () => {
    process.env.SILVER_MAX_BROWSERS = '1'
    const busy = spawnVictim()
    const holder = spawnVictim()
    const name = uniq('busy')
    await seed(name, { pid: busy.pid!, lastUsedAt: ago(60_000) })
    await fs.writeFile(
      path.join(sessionDir(name), '.lock'),
      JSON.stringify({ pid: holder.pid, token: 'x', at: Date.now() }),
      'utf8',
    )

    expect(await enforceBrowserCeiling()).toEqual([])
    expect(isPidAlive(busy.pid!)).toBe(true)
  })

  it('never stops the session being opened', async () => {
    process.env.SILVER_MAX_BROWSERS = '1'
    const own = spawnVictim()
    const name = uniq('own')
    await seed(name, { pid: own.pid!, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling(name)).toEqual([])
    expect(isPidAlive(own.pid!)).toBe(true)
  })

  it('is disabled entirely by SILVER_MAX_BROWSERS=0', async () => {
    process.env.SILVER_MAX_BROWSERS = '0'
    const a = spawnVictim()
    const b = spawnVictim()
    await seed(uniq('a'), { pid: a.pid!, lastUsedAt: ago(60_000) })
    await seed(uniq('b'), { pid: b.pid!, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
    expect(isPidAlive(a.pid!)).toBe(true)
    expect(isPidAlive(b.pid!)).toBe(true)
  })

  it('ignores a session whose browser is already dead', async () => {
    process.env.SILVER_MAX_BROWSERS = '1'
    const dead = spawnVictim()
    dead.kill('SIGKILL')
    await waitDead(dead.pid!)
    await seed(uniq('dead'), { pid: dead.pid!, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
  })
})

describe('takeEvictionNotice', () => {
  it('reports once and then clears — an eviction lands on the command that caused it', () => {
    takeEvictionNotice()
    expect(takeEvictionNotice()).toEqual([])
  })
})
