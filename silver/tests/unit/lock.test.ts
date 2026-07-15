import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { withSessionLock, LockError } from '../../src/core/lock.js'
import { sessionDir } from '../../src/core/session.js'

const created: string[] = []
function uniq(tag: string): string {
  const name = `silver-lock-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  created.push(name)
  return name
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  for (const name of created.splice(0)) {
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  }
})

describe('per-session advisory lock', () => {
  it('SERIALIZES concurrent commands against the SAME session (no overlap)', async () => {
    const name = uniq('same')
    const events: string[] = []
    const section = (tag: string) => async () => {
      events.push(`${tag}-start`)
      await delay(80)
      events.push(`${tag}-end`)
    }
    // Fire both critical sections concurrently against ONE session.
    await Promise.all([
      withSessionLock(name, section('a')),
      withSessionLock(name, section('b')),
    ])
    // Whichever ran first, each section's start/end must be contiguous — i.e.
    // the two never interleave. (One of the two orderings below.)
    const contiguous =
      (events[0] === 'a-start' &&
        events[1] === 'a-end' &&
        events[2] === 'b-start' &&
        events[3] === 'b-end') ||
      (events[0] === 'b-start' &&
        events[1] === 'b-end' &&
        events[2] === 'a-start' &&
        events[3] === 'a-end')
    expect(contiguous).toBe(true)
  })

  it('does NOT block across DIFFERENT sessions (they overlap)', async () => {
    const n1 = uniq('diffA')
    const n2 = uniq('diffB')
    const events: string[] = []
    const section = (tag: string) => async () => {
      events.push(`${tag}-start`)
      await delay(80)
      events.push(`${tag}-end`)
    }
    await Promise.all([
      withSessionLock(n1, section('a')),
      withSessionLock(n2, section('b')),
    ])
    // Concurrency: both sections start before either ends.
    const starts = new Set([events[0], events[1]])
    const ends = new Set([events[2], events[3]])
    expect(starts).toEqual(new Set(['a-start', 'b-start']))
    expect(ends).toEqual(new Set(['a-end', 'b-end']))
  })

  it('TAKES OVER a stale lock left by a dead pid (fast, no budget wait)', async () => {
    const name = uniq('stale')
    await fs.mkdir(sessionDir(name), { recursive: true })
    const lockFile = path.join(sessionDir(name), '.lock')
    // A dead-pid holder record (pid ~2^31 is never a live process here).
    await fs.writeFile(
      lockFile,
      JSON.stringify({ pid: 2147483646, token: 'ghost', at: Date.now() }),
      'utf8',
    )
    let ran = false
    const start = Date.now()
    await withSessionLock(name, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    // Stale takeover is immediate; nowhere near the 60s budget.
    expect(Date.now() - start).toBeLessThan(2_000)
    // And the lock is released (removed) afterwards.
    await expect(fs.readFile(lockFile, 'utf8')).rejects.toBeTruthy()
  })

  it('fails with LockError(session_busy) when a LIVE holder never releases', async () => {
    const name = uniq('busy')
    await fs.mkdir(sessionDir(name), { recursive: true })
    const lockFile = path.join(sessionDir(name), '.lock')
    // Our own (live) pid holds it, timestamped now → not stale, not takeable.
    await fs.writeFile(
      lockFile,
      JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }),
      'utf8',
    )
    // Tiny budget so the test is fast; the code path is identical to the 60s one.
    let caught: unknown
    try {
      await withSessionLock(name, async () => 'never', 200)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LockError)
    expect((caught as LockError).code).toBe('session_busy')
    // The live holder's lock is untouched (we never stole it).
    const still = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { token: string }
    expect(still.token).toBe('held')
  })
})
