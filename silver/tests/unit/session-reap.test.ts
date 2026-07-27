import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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
  setNamespace,
  maybeSweepIdleSessions,
  DEFAULT_SESSION_IDLE_MS,
  type SessionInfo,
} from '../../src/core/session.js'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Regression tests for the orphaned-daemon leak: `open` spawns a detached
 * browser that outlives the CLI by design, and before this reaper existed
 * nothing ever killed it — a real run accumulated 105 live sessions / ~65 GB
 * RSS, oldest 25 hours idle. `session gc` could not help: it only removes dirs
 * whose process is ALREADY dead.
 */

/**
 * ISOLATION NOTE. The reaper is GLOBAL now, so a sibling test file's `silver open`
 * sweeps every namespace — including this file's fixtures. Two rules keep these
 * tests hermetic without redirecting `$HOME` (which on macOS breaks Chromium's
 * keychain lookup and pops a modal on every launch):
 *   1. A fixture that SHOULD be reaped is idle by only a few seconds and is reaped
 *      with an explicitly tiny TTL. A sibling sweeping on the 30-minute default
 *      cannot match it.
 *   2. A fixture's pid is always a disposable `spawnVictim()`, never `process.pid`
 *      — a stray global sweep must never be able to SIGTERM the test runner.
 */
/** Idle long enough for a tiny explicit TTL, far too short for any default sweep. */
const BRIEF_IDLE_MS = 3_000
/** The explicit TTL these tests reap with. */
const TINY_TTL_MS = 1_000

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
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).toContain(name)
    // The browser process is actually signalled — the whole point of the fix.
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)
    // And the dir is gone, so `session list` stops reporting a phantom.
    expect(await fs.stat(sessionDir(name)).then(() => true).catch(() => false)).toBe(false)
  })

  it('leaves an actively-used session alone (lastUsedAt is the clock, not createdAt)', async () => {
    const name = uniq('fresh')
    // Created long ago but touched just now — the lean-loop case.
    const victim = spawnVictim()
    await seed(name, { pid: victim.pid!, createdAt: ago(24 * 60 * 60 * 1000), lastUsedAt: ago(0) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).not.toContain(name)
    expect(res.keptAlive).toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('falls back to createdAt when lastUsedAt is absent (pre-fix sidecars age out)', async () => {
    const victim = spawnVictim()
    const name = uniq('legacy')
    await seed(name, { pid: victim.pid!, createdAt: ago(BRIEF_IDLE_MS) })

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).toContain(name)
  })

  it('never reaps an external (connect’d) session — we do not own that process', async () => {
    const name = uniq('external')
    const victim = spawnVictim()
    await seed(name, { pid: victim.pid!, external: true, lastUsedAt: ago(BRIEF_IDLE_MS) })

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).not.toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('skips sessions whose process is already dead (that is plain gc’s job)', async () => {
    const name = uniq('dead')
    await seed(name, { pid: 0x7ffffff0, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    const res = await reapIdleSessions(30 * 60 * 1000)

    expect(res.reaped).not.toContain(name)
  })

  it('excludes the named session so `open` never reaps the one it is opening', async () => {
    const name = uniq('self')
    const victim = spawnVictim()
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    const res = await reapIdleSessions(TINY_TTL_MS, name)

    expect(res.reaped).not.toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('ttl <= 0 disables reaping entirely (documented escape hatch)', async () => {
    const name = uniq('disabled')
    const victim = spawnVictim()
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    for (const ttl of [0, -1]) {
      const res = await reapIdleSessions(ttl)
      expect(res.reaped).toEqual([])
    }
    expect(isPidAlive(victim.pid!)).toBe(true)
  })
})

/**
 * THE PARALLEL-AGENT LEAK (the namespace blind spot).
 *
 * SKILL.md tells a fleet to isolate agent-GROUPS with `--namespace`, so N parallel
 * agents put their browsers in N DIFFERENT roots (`~/.silver/<ns>/sessions/`). But
 * the reaper reads `sessionsRoot()`, which is namespace-scoped — so agent B's sweep
 * physically cannot see agent A's abandoned browser. The "self-limiting" property
 * held per-namespace and was unbounded ACROSS them: the machine that motivated this
 * had 226 namespaces and a 3-hour-idle orphaned browser at ~1.5 GB RSS.
 */
describe('reapIdleSessions — across namespaces (the parallel-agent leak)', () => {
  afterEach(() => setNamespace(''))

  it('reaps an abandoned session left in ANOTHER namespace', async () => {
    const victim = spawnVictim()
    const name = uniq('cross-ns')
    const nsA = `silver-test-ns-a-${process.pid}`

    // Agent A opens a browser in its own namespace, then walks away.
    setNamespace(nsA)
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    const dirA = sessionDir(name)

    // Agent B, in a DIFFERENT namespace, sweeps. Before the fix it saw nothing.
    setNamespace(`silver-test-ns-b-${process.pid}`)
    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).toContain(`${nsA}/${name}`)
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)
    expect(await fs.stat(dirA).then(() => true).catch(() => false)).toBe(false)
    await fs.rm(path.join(os.homedir(), '.silver', nsA), { recursive: true, force: true })
  })

  it('reaps the un-namespaced root too, when sweeping from inside a namespace', async () => {
    const victim = spawnVictim()
    const name = uniq('root-from-ns')

    setNamespace('')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    setNamespace(`silver-test-ns-c-${process.pid}`)
    const res = await reapIdleSessions(TINY_TTL_MS)

    // Labelled `(root)/<name>`: only the CALLER's own namespace gets a bare name.
    // Labelling the un-namespaced root bare too made `~/.silver/sessions/default`
    // and `~/.silver/<ns>/sessions/default` collide on a single key.
    expect(res.reaped).toContain(`(root)/${name}`)
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)
  })

  it('still never reaps an external session in another namespace', async () => {
    const name = uniq('cross-ns-external')
    const nsD = `silver-test-ns-d-${process.pid}`

    setNamespace(nsD)
    await seed(name, { pid: 0, external: true, lastUsedAt: ago(BRIEF_IDLE_MS) })

    setNamespace('')
    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).not.toContain(`${nsD}/${name}`)
    await fs.rm(path.join(os.homedir(), '.silver', nsD), { recursive: true, force: true })
  })

  it('`exclude` protects the caller’s own session in its own namespace only', async () => {
    // `open` passes its own session name as `exclude`. That must not accidentally
    // shield a same-named session belonging to a DIFFERENT agent's namespace —
    // `default` is the most common session name, so a bare-name exclude would
    // shield every other agent's `default` browser and re-open the whole leak.
    const victim = spawnVictim()
    const nsE = `silver-test-ns-e-${process.pid}`
    const shared = uniq('default-like')

    setNamespace(nsE)
    await seed(shared, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    setNamespace('')
    const res = await reapIdleSessions(TINY_TTL_MS, shared)

    expect(res.reaped).toContain(`${nsE}/${shared}`)
    await fs.rm(path.join(os.homedir(), '.silver', nsE), { recursive: true, force: true })
  })
})

/**
 * The reaper's safety rails. Aside's stance, adopted here: reap only what is
 * PROVABLY safe to reap, never everything that isn't provably unsafe. The idle
 * stamp alone is not proof — `connect()` stamps `lastUsedAt` at the START of a
 * command, so a single long-running command (`wait --timeout 200000`) keeps
 * aging while it actively drives the browser. The lockfile is the authoritative
 * "hands off" signal.
 */
describe('reapIdleSessions — never reaps a session a live command is holding', () => {
  it('keeps an idle-past-TTL session whose lock has a LIVE holder', async () => {
    const victim = spawnVictim()
    const holder = spawnVictim() // stands in for the process running the command
    const name = uniq('busy')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    await fs.writeFile(
      path.join(sessionDir(name), '.lock'),
      JSON.stringify({ pid: holder.pid, token: 'tok', at: Date.now() }),
      'utf8',
    )

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).not.toContain(name)
    expect(res.keptAlive).toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('reaps once the lock holder is DEAD (a crashed command must not pin a browser forever)', async () => {
    const victim = spawnVictim()
    const dead = spawnVictim()
    const deadPid = dead.pid!
    dead.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    const name = uniq('stale-lock')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    await fs.writeFile(
      path.join(sessionDir(name), '.lock'),
      JSON.stringify({ pid: deadPid, token: 'tok', at: Date.now() }),
      'utf8',
    )

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).toContain(name)
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)
  })
})

/**
 * The sweep is GLOBAL, so the TTL cannot be whatever the sweeping process happens
 * to have in its env — otherwise the shortest TTL anywhere on the machine would
 * govern every agent group, and a session opened with `SILVER_SESSION_IDLE_MS=0`
 * ("this browser outlives everything") would be reaped by any unrelated command.
 * `openSession` records the governing TTL on the sidecar; the reaper obeys it.
 */
describe('reapIdleSessions — a session is governed by ITS OWN recorded TTL', () => {
  it('never reaps a session whose recorded TTL is 0, however idle it is', async () => {
    const victim = spawnVictim()
    const name = uniq('pinned')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS), idleTtlMs: 0 })

    // A sweeper with an aggressive TTL must still leave it alone.
    const res = await reapIdleSessions(1)

    expect(res.reaped).not.toContain(name)
    expect(res.keptAlive).toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('honours a LONGER recorded TTL than the sweeping process asks for', async () => {
    const victim = spawnVictim()
    const name = uniq('long-ttl')
    // Idle 40 min, but this session was opened with a 24h TTL.
    await seed(name, {
      pid: victim.pid!,
      lastUsedAt: ago(BRIEF_IDLE_MS),
      idleTtlMs: 24 * 60 * 60 * 1000,
    })

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).not.toContain(name)
    expect(isPidAlive(victim.pid!)).toBe(true)
  })

  it('an EXPLICIT `session gc <idleMs>` overrides a session’s recorded TTL', async () => {
    // The per-session TTL exists to stop an AMBIENT sweep in one namespace from
    // re-timing another's browser. An operator typing a number is not ambient —
    // otherwise a pinned session becomes unreclaimable by any command at all.
    const victim = spawnVictim()
    const name = uniq('override')
    await seed(name, {
      pid: victim.pid!,
      lastUsedAt: ago(BRIEF_IDLE_MS),
      idleTtlMs: 24 * 60 * 60 * 1000,
    })

    const ambient = await reapIdleSessions(TINY_TTL_MS)
    expect(ambient.reaped).not.toContain(name)

    const explicit = await reapIdleSessions(TINY_TTL_MS, undefined, { overrideSessionTtl: true })
    expect(explicit.reaped).toContain(name)
  })

  it('falls back to the caller’s TTL when the sidecar predates the field', async () => {
    const victim = spawnVictim()
    const name = uniq('legacy-ttl')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })

    const res = await reapIdleSessions(TINY_TTL_MS)

    expect(res.reaped).toContain(name)
  })
})

describe('maybeSweepIdleSessions — throttled so every command can sweep for free', () => {
  const stamp = (): string => path.join(os.homedir(), '.silver', '.last-sweep')
  let saved: string | null = null

  beforeEach(async () => {
    saved = await fs.readFile(stamp(), 'utf8').catch(() => null)
  })
  afterEach(async () => {
    if (saved === null) await fs.rm(stamp(), { force: true }).catch(() => {})
    else await fs.writeFile(stamp(), saved, 'utf8').catch(() => {})
    delete process.env.SILVER_SESSION_IDLE_MS
  })

  it('sweeps when the stamp is stale, and skips while it is fresh', async () => {
    const victim = spawnVictim()
    const name = uniq('sweep')
    process.env.SILVER_SESSION_IDLE_MS = String(TINY_TTL_MS)
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    await fs.writeFile(stamp(), String(Date.now() - 10 * 60_000), 'utf8')

    await maybeSweepIdleSessions()
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(victim.pid!)).toBe(false)

    // The stamp is now fresh, so a second victim survives this window.
    const survivor = spawnVictim()
    const name2 = uniq('sweep-throttled')
    await seed(name2, { pid: survivor.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    await maybeSweepIdleSessions()
    await new Promise((r) => setTimeout(r, 250))
    expect(isPidAlive(survivor.pid!)).toBe(true)
  })

  it('does nothing at all when reaping is disabled (SILVER_SESSION_IDLE_MS=0)', async () => {
    const victim = spawnVictim()
    const name = uniq('sweep-disabled')
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(BRIEF_IDLE_MS) })
    await fs.rm(stamp(), { force: true }).catch(() => {})
    process.env.SILVER_SESSION_IDLE_MS = '0'

    await maybeSweepIdleSessions()

    expect(isPidAlive(victim.pid!)).toBe(true)
    // and it must not even claim the sweep slot, or re-enabling would be throttled
    expect(await fs.stat(stamp()).then(() => true).catch(() => false)).toBe(false)
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
    const victim = spawnVictim()
    await seed(name, { pid: victim.pid!, lastUsedAt: ago(48 * 60 * 60 * 1000) })

    await touchSession(name)

    const info = await readSidecar(name)
    expect(Date.now() - Date.parse(info.lastUsedAt!)).toBeLessThan(5_000)
    // Everything else on the sidecar survives the rewrite.
    expect(info.pid).toBe(victim.pid!)
    expect(info.engine).toBe('chromium')
  })

  it('never throws on a missing session', async () => {
    await expect(touchSession('silver-reap-nonexistent-xyz')).resolves.toBeUndefined()
  })
})
