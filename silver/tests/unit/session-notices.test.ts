import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import { parseFlags } from '../../src/core/flags.js'
import { handle, noteSessionRestarted, takeRestartNotice } from '../../src/core/handlers.js'
import {
  closeSession,
  readSidecar,
  writeSidecar,
  sessionDir,
  isPidAlive,
  takeEvictionNotice,
  type SessionInfo,
} from '../../src/core/session.js'

/**
 * Session notices: what silver tells the host when it LOST the browser it was
 * driving, or stopped somebody else's to make room.
 *
 * The bug these exist for: the browser ceiling evicts an idle session, and the
 * victim's next `read` comes back `{"success":true,"data":"⟦page-content
 * untrusted⟧\n\n⟦/page-content⟧"}` — an empty page reported as fact, with no
 * hint that the page it describes no longer exists. `snapshot` degrades honestly
 * (`page_empty`); `read` did not. The respawn path predates the ceiling (a
 * crashed or OOM-killed browser takes it too), so this covers that as well.
 *
 * The other half: `enforceBrowserCeiling` SIGTERMs other sessions' browsers from
 * `openSession`, which EVERY verb reaches through `ensureConnected` — but only
 * `handleOpen` ever read the eviction notice, so a bare `silver read` stopped a
 * browser and reported nothing at all.
 */

const children: ChildProcess[] = []
const created: string[] = []

function uniq(tag: string): string {
  const name = `silver-notice-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  created.push(name)
  return name
}

/** A real, live, DISPOSABLE pid — the ceiling SIGTERMs what it evicts. */
function spawnVictim(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

/** A session dir + sidecar for a browser we did not really launch. */
async function seed(name: string, pid: number): Promise<void> {
  const info: SessionInfo = {
    port: 9222,
    pid,
    wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
    engine: 'chromium',
  }
  await fs.mkdir(path.join(sessionDir(name), 'profile'), { recursive: true })
  await writeSidecar(path.join(sessionDir(name), 'session.json'), info)
}

/** Wait until `pid` is gone (signal delivery is asynchronous). */
async function waitDead(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 25))
  }
  return !isPidAlive(pid)
}

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body><h1>notices</h1><p>hello</p></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // localhost by NAME: the egress guard denies a raw-IP literal.
  base = `http://localhost:${(server.address() as AddressInfo).port}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  delete process.env.SILVER_MAX_BROWSERS
  // Both notices are module-level and read-once. A test that left one pending
  // would hand it to the NEXT test's envelope — exactly the cross-command bleed
  // the read-once shape exists to prevent.
  takeRestartNotice()
  takeEvictionNotice()
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const name of created.splice(0)) {
    await closeSession(name).catch(() => {})
    await fs.rm(sessionDir(name), { recursive: true, force: true }).catch(() => {})
  }
})

describe('takeRestartNotice', () => {
  it('reports once and then clears — a respawn lands on the command that caused it', () => {
    expect(takeRestartNotice()).toBeNull()
    noteSessionRestarted('silver-notice-x')
    expect(takeRestartNotice()).toBe('silver-notice-x')
    expect(takeRestartNotice()).toBeNull()
  })
})

describe('the FIRST open of a session is not a respawn', () => {
  it('leaves no restart notice and says nothing about a respawn', async () => {
    // The trap this guards: `connect()` throws when there is no sidecar at all,
    // so `ensureConnected`'s catch runs on a brand-new session too. Noting a
    // restart there would fire on the single most common command in the tool, and
    // a warning that fires every time teaches the host to ignore it.
    const name = uniq('fresh')
    const env = await handle(parseFlags(['open', base, '--session', name]))
    expect(env.success).toBe(true)
    expect(env.warning ?? '').not.toMatch(/respawn/i)
    expect(takeRestartNotice()).toBeNull()
  })
})

describe('a lost browser and an eviction reach EVERY verb, not just `open`', () => {
  it('warns on a bare `read` instead of handing back the blank page as fact', async () => {
    const name = uniq('lost')
    expect((await handle(parseFlags(['open', base, '--session', name]))).success).toBe(true)

    // A second live session for the ceiling to evict, and a cap that leaves the
    // respawn no room. The respawn happens inside the `read` below, so ONE
    // envelope has to carry both notices.
    const bystander = uniq('bystander')
    const victim = spawnVictim()
    await seed(bystander, victim.pid!)
    process.env.SILVER_MAX_BROWSERS = '1'

    // Exactly what the ceiling does to a victim: SIGTERM the browser, keep the
    // session dir. Not `silver close` — the profile and sidecar must survive.
    const info = await readSidecar(name)
    process.kill(info.pid, 'SIGTERM')
    expect(await waitDead(info.pid)).toBe(true)

    const env = await handle(parseFlags(['read', '--session', name]))
    // `read` still succeeds — the respawn worked. What must change is that the
    // envelope stops presenting the blank page it got back as the page.
    expect(env.success).toBe(true)
    expect(env.warning ?? '').toContain(name)
    // ...and the browser this command stopped on its way is named too, on a verb
    // that is not `open`.
    expect(env.warning ?? '').toContain(bystander)
    // Two notices, one envelope, joined — neither may swallow the other.
    expect(env.warning ?? '').toContain('; ')
    expect(await waitDead(victim.pid!)).toBe(true)
  })

  it('folds a pending notice onto `warning` without needing a browser', async () => {
    noteSessionRestarted('silver-notice-pending')
    const env = await handle(parseFlags(['version']))
    expect(env.success).toBe(true)
    expect(env.warning ?? '').toContain('silver-notice-pending')
  })

  it('leaves `warning` untouched when nothing is pending', async () => {
    const env = await handle(parseFlags(['version']))
    expect(env.success).toBe(true)
    expect(env.warning).toBeUndefined()
  })
})
