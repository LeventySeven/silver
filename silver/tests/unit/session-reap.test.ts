import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  sessionDir,
  writeSidecar,
  readSidecar,
  reapIdleSessions,
  resolveIdleTtlMs,
  touchSession,
  isPidAlive,
  DEFAULT_SESSION_IDLE_MS,
  type SessionInfo,
} from '../../src/core/session.js'
import * as path from 'node:path'

/**
 * Regression tests for the orphaned-daemon leak: `open` spawns a detached
 * browser that outlives the CLI by design, and before this reaper existed
 * nothing ever killed it — a real run accumulated 105 live sessions / ~65 GB
 * RSS, oldest 25 hours idle. `session gc` could not help: it only removes dirs
 * whose process is ALREADY dead.
 */

const created: string[] = []
const children: ChildProcess[] = []

function uniq(tag: string): string {
  const name = `silver-reap-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  created.push(name)
  return name
}

/** A real, live, DISPOSABLE pid. Never use process.pid for a reapable session —
 * the reaper SIGTERMs it, which would kill the test runner. */
function spawnVictim(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

async function seed(name: string, over: Partial<SessionInfo>): Promise<void> {
  const info: SessionInfo = {
    port: 9222,
    pid: 1,
    wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x',
    createdAt: new Date().toISOString(),
    engine: 'chromium',
    ...over,
  }
  await fs.mkdir(sessionDir(name), { recursive: true })
  await writeSidecar(path.join(sessionDir(name), 'session.json'), info)
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const name of created.splice(0)) {
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  }
})

describe('reapIdleSessions', () => {
  it('kills a live session idle past the TTL and removes its dir', async () => {
    const victim = spawnVictim()
    const name = uniq('idle')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).toContain(name)
    // The browser process is actually signalled — the whole point of the fix.
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)
    // And the dir is gone, so `session list` stops reporting a phantom.
    expect(await fs.stat(sessionDir(name)).then(() => true).catch(() => false)).toBe(false)
  })

  it('leaves an actively-used session alone (lastUsedAt is the clock, not createdAt)', async () => {
    const name = uniq('fresh')
    // Created long ago but touched seconds ago — the lean-loop case. Uses
    // process.pid deliberately: if this were ever reaped the runner would die,
    // so the assertion is self-enforcing.
    await seed(name, { pid: process.pid, createdAt: ago(24 * 60 * 60 * 1000), lastUsedAt: ago(5_000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).not.toContain(name)
    expect(res.keptAlive).toContain(name)
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('falls back to createdAt when lastUsedAt is absent (pre-fix sidecars age out)', async () => {
    const victim = spawnVictim()
    const name = uniq('legacy')
    await seed(name, { pid: victim.pid!, createdAt: ago(60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).toContain(name)
  })

  it('never reaps an external (connect’d) session — we do not own that process', async () => {
    const name = uniq('external')
    await seed(name, { pid: process.pid, external: true, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).not.toContain(name)
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('skips sessions whose process is already dead (that is plain gc’s job)', async () => {
    const name = uniq('dead')
    await seed(name, { pid: 0x7ffffff0, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).not.toContain(name)
  })

  it('excludes the named session so `open` never reaps the one it is opening', async () => {
    const name = uniq('self')
    await seed(name, { pid: process.pid, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000, name)

    expect(res.reaped).not.toContain(name)
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('ttl <= 0 disables reaping entirely (documented escape hatch)', async () => {
    const name = uniq('disabled')
    await seed(name, { pid: process.pid, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    for (const ttl of [0, -1]) {
      const res = await reapIdleSessions(ttl)
      expect(res.reaped).toEqual([])
    }
    expect(isPidAlive(process.pid)).toBe(true)
  })
})

describe('resolveIdleTtlMs', () => {
  afterEach(() => {
    delete process.env.SILVER_SESSION_IDLE_MS
  })

  it('prefers the explicit argument', () => {
    process.env.SILVER_SESSION_IDLE_MS = '1000'
    expect(resolveIdleTtlMs(5_000)).toBe(5_000)
  })

  it('falls back to the env var, then to the 30-minute default', () => {
    process.env.SILVER_SESSION_IDLE_MS = '1234'
    expect(resolveIdleTtlMs()).toBe(1234)
    delete process.env.SILVER_SESSION_IDLE_MS
    expect(resolveIdleTtlMs()).toBe(DEFAULT_SESSION_IDLE_MS)
    expect(DEFAULT_SESSION_IDLE_MS).toBe(30 * 60 * 1000)
  })

  it('honours an explicit 0 (disable) rather than treating it as unset', () => {
    expect(resolveIdleTtlMs(0)).toBe(0)
  })

  it('ignores an unparseable env var instead of disabling the reaper', () => {
    process.env.SILVER_SESSION_IDLE_MS = 'not-a-number'
    expect(resolveIdleTtlMs()).toBe(DEFAULT_SESSION_IDLE_MS)
  })
})

describe('touchSession', () => {
  it('stamps lastUsedAt so an in-use session keeps resetting its idle clock', async () => {
    const name = uniq('touch')
    await seed(name, { pid: process.pid, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    await touchSession(name)

    const info = await readSidecar(name)
    expect(Date.now() - Date.parse(info.lastUsedAt!)).toBeLessThan(5_000)
    // Everything else on the sidecar survives the rewrite.
    expect(info.pid).toBe(process.pid)
    expect(info.engine).toBe('chromium')
  })

  it('never throws on a missing session', async () => {
    await expect(touchSession('silver-reap-nonexistent-xyz')).resolves.toBeUndefined()
  })
})
