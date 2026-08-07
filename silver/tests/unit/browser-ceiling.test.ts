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

/** A SIGTERM-proof child that also COUNTS the signals it was sent. */
type Stubborn = { pid: number; terms: () => number }

/**
 * A pid that SURVIVES SIGTERM — a browser wedged in a beforeunload handler, or
 * one whose engine installed its own term handler. `process.kill` still returns
 * cleanly for it: it reports that the signal was DELIVERED, never that anything
 * died. The afterEach SIGKILLs it, which no handler can catch.
 *
 * It reports each SIGTERM on stdout so a test can assert how many the ceiling
 * actually DELIVERED, which is the only externally-visible evidence of an
 * eviction attempt that did not kill anything.
 *
 * Awaits the child's own "armed" line rather than returning immediately: Node
 * needs ~40ms to boot, and a SIGTERM that lands before the handler is installed
 * is taken by the DEFAULT disposition, which kills it. The test would then go
 * green for the wrong reason — a browser that really died is one the ceiling may
 * honestly claim.
 */
async function spawnStubborn(): Promise<Stubborn> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => console.log('term')); console.log('armed'); setTimeout(() => {}, 60_000)",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  children.push(child)
  let out = ''
  await new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      out += chunk
      if (out.includes('armed')) resolve()
    })
    child.once('error', reject)
  })
  return { pid: child.pid!, terms: () => (out.match(/term/g) ?? []).length }
}

/** Wait until `child` has reported at least `n` SIGTERMs (the pipe is async). */
async function waitTerms(s: Stubborn, n: number, budgetMs = 3_000): Promise<number> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && s.terms() < n) {
    await new Promise((r) => setTimeout(r, 25))
  }
  return s.terms()
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

  it('does not claim a browser that ignored the SIGTERM', async () => {
    // The dishonest failure this pins: `process.kill` throws only when the signal
    // cannot be DELIVERED, so a browser that ignores SIGTERM left the cap unmet
    // while `open` reported it `evicted: [...]` — silver claiming it freed memory
    // it did not free. Leaving the cap unmet is the acceptable half; lying about
    // it is not. Nothing escalates to SIGKILL: a survivor is simply not claimed.
    process.env.SILVER_MAX_BROWSERS = '1'
    const stubborn = await spawnStubborn()
    const name = uniq('stubborn')
    await seed(name, { pid: stubborn.pid, lastUsedAt: ago(60_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
    expect(isPidAlive(stubborn.pid)).toBe(true)
  })

  it('never SIGTERMs more browsers than the cap is over, however slowly they die', async () => {
    // THE bound, and a regression this file has already had to catch once: the
    // loop used to count CONFIRMED EXITS against `over`, so a browser that
    // outlived the confirm budget fell through to the next candidate and got it
    // killed as well — two browsers stopped to make room for one, and neither
    // reported. Signals delivered, not exits observed, is what `over` bounds.
    //
    // cap 2 with two live browsers ⇒ over = 1. Both ignore SIGTERM, so neither
    // can ever be confirmed gone; the second must STILL be left alone.
    process.env.SILVER_MAX_BROWSERS = '2'
    const stale = await spawnStubborn()
    const fresh = await spawnStubborn()
    await seed(uniq('slow-stale'), { pid: stale.pid, lastUsedAt: ago(60_000) })
    await seed(uniq('slow-fresh'), { pid: fresh.pid, lastUsedAt: ago(1_000) })

    expect(await enforceBrowserCeiling()).toEqual([])
    // The most-idle one is the one LRU picks, and it is the ONLY one signalled.
    expect(await waitTerms(stale, 1)).toBe(1)
    expect(fresh.terms()).toBe(0)
    expect(isPidAlive(stale.pid)).toBe(true)
    expect(isPidAlive(fresh.pid)).toBe(true)
  })

  it('reports the browser that exited without dragging in the one that did not', async () => {
    // cap 1 with two live browsers ⇒ over = 2, so both are legitimately in scope.
    // What is under test is the REPORT: a survivor is dropped from it, while a
    // genuine exit alongside it is still named.
    process.env.SILVER_MAX_BROWSERS = '1'
    const stubborn = await spawnStubborn()
    const killable = spawnVictim()
    const stubbornName = uniq('stubborn2')
    const killableName = uniq('killable')
    // The stubborn one is the MORE idle of the two, so LRU reaches it first.
    await seed(stubbornName, { pid: stubborn.pid, lastUsedAt: ago(60_000) })
    await seed(killableName, { pid: killable.pid!, lastUsedAt: ago(30_000) })

    expect(await enforceBrowserCeiling()).toEqual([killableName])
    expect(await waitDead(killable.pid!)).toBe(true)
    expect(isPidAlive(stubborn.pid)).toBe(true)
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
