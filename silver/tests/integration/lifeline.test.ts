import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, isPidAlive, readSidecar, setNamespace ,
  silverHome} from '../../src/core/session.js'

/**
 * The LIFELINE: a kernel-enforced kill switch for an abandoned browser.
 *
 * The sweeper reclaims an abandoned browser only when SOME silver command runs
 * again somewhere on the machine. That covers a busy fleet but not a machine that
 * goes quiet — the case that produced the original 3h13m / ~1.5 GB orphan. So the
 * browser also carries its own death switch: `--remote-debugging-pipe` gives
 * Chromium a CDP read pipe whose write end is held by a tiny `sh` holder, and
 * Chromium shuts ITSELF down the moment that fd hits EOF. No signal, no timer, no
 * cooperation from anything — the kernel's fd refcount is the mechanism.
 *
 * Every test here drives the REAL CLI against a REAL Chromium, because the whole
 * claim is about OS behavior that a mock cannot exhibit.
 */

const SUFFIX = `${process.pid}-${Date.now()}`
const NS = `lifeline-${SUFFIX}`
const PAGE = `<!doctype html><html><body><h1>lifeline</h1></body></html>`

let server: Server
let base: string

function nsDir(ns: string): string {
  return path.join(silverHome(), sanitizeNamespace(ns))
}

/** Poll until `fn()` is true or the budget runs out. Returns whether it became true. */
async function until(fn: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return fn()
}

describe('lifeline kill switch (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    await run(['close', '--all', '--namespace', NS]).catch(() => {})
    await fs.rm(nsDir(NS), { recursive: true, force: true }).catch(() => {})
    setNamespace('')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('records a holder pid, arms a deadline, and still reconnects over the TCP port', async () => {
    const opened = await run(['open', base, '--session', 'a', '--namespace', NS])
    expect(opened.env.success).toBe(true)

    setNamespace(NS)
    const info = await readSidecar('a')
    setNamespace('')

    // A lifeline was attached and the holder is a real, live process.
    expect(typeof info.holderPid).toBe('number')
    expect(isPidAlive(info.holderPid!)).toBe(true)
    // The holder's clock exists and is in the future. Its name is generation-
    // unique and recorded on the sidecar, so an auto-respawn can retire the old
    // holder by unlinking ITS file rather than signalling a recyclable pid.
    expect(info.deadlineFile).toMatch(/^\.deadline-/)
    const deadlineFile = path.join(nsDir(NS), 'sessions', 'a', info.deadlineFile!)
    expect(existsSync(deadlineFile)).toBe(true)
    const deadline = Number((await fs.readFile(deadlineFile, 'utf8')).trim())
    expect(deadline).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // The TTL that governs this session is persisted, so a sweep launched from
    // another namespace with a different env cannot re-time it.
    expect(info.idleTtlMs).toBe(30 * 60 * 1000)

    // The pipe must not cost us the reconnect model: the TCP debugging port is
    // what every later command uses, and it has to keep working alongside it.
    const snap = await run(['snapshot', '--session', 'a', '--namespace', NS])
    expect(snap.env.success).toBe(true)
  })

  it('keeps navigator.webdriver false — the pipe flag turns it back ON without the disable flag', async () => {
    // `--remote-debugging-pipe` maps to Blink's EnableAutomationControlled, so
    // `--disable-blink-features=AutomationControlled` stopped being cosmetic the
    // moment the lifeline shipped. Chromium applies the disable list last; if the
    // two are ever reordered, this test is what catches the regression.
    const res = await run([
      'eval',
      'String(navigator.webdriver)',
      '--session',
      'a',
      '--namespace',
      NS,
      '--enable-actions',
    ])
    expect(res.env.success).toBe(true)
    expect(JSON.stringify(res.env.data)).toContain('false')
  })

  it('SIGKILLing the holder kills the browser — no cleanup code gets to run', async () => {
    setNamespace(NS)
    const info = await readSidecar('a')
    setNamespace('')
    const { pid, holderPid } = info
    expect(isPidAlive(pid)).toBe(true)

    // SIGKILL, deliberately: a trap or exit handler must NOT be what makes this
    // work. The guarantee has to survive the holder being destroyed outright.
    process.kill(holderPid!, 'SIGKILL')

    expect(await until(() => !isPidAlive(pid), 15_000)).toBe(true)
  })

  it('an abandoned browser dies on its own deadline with NO further silver command', async () => {
    // The residual the sweeper cannot cover: nothing runs again, ever. The browser
    // has to reclaim itself. Short TTL so the test is seconds, not half an hour.
    const prev = process.env.SILVER_SESSION_IDLE_MS
    process.env.SILVER_SESSION_IDLE_MS = '6000'
    try {
      const opened = await run(['open', base, '--session', 'b', '--namespace', NS])
      expect(opened.env.success).toBe(true)
      setNamespace(NS)
      const info = await readSidecar('b')
      setNamespace('')
      expect(isPidAlive(info.pid)).toBe(true)

      // From here on: no run(), no sweep, no gc. Just the wall clock.
      expect(await until(() => !isPidAlive(info.pid), 40_000)).toBe(true)
      // The holder cleans itself up too, rather than trading one leak for another.
      expect(await until(() => !isPidAlive(info.holderPid!), 10_000)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.SILVER_SESSION_IDLE_MS
      else process.env.SILVER_SESSION_IDLE_MS = prev
    }
  }, 60_000)

  it('attaches NO lifeline when reaping is disabled (the documented escape hatch)', async () => {
    // `SILVER_SESSION_IDLE_MS=0` means "this browser must outlive everything".
    // Attaching a death switch there would silently break that promise, so the
    // pipe flag and the holder are both withheld.
    const prev = process.env.SILVER_SESSION_IDLE_MS
    process.env.SILVER_SESSION_IDLE_MS = '0'
    try {
      const opened = await run(['open', base, '--session', 'c', '--namespace', NS])
      expect(opened.env.success).toBe(true)
      setNamespace(NS)
      const info = await readSidecar('c')
      setNamespace('')

      expect(info.holderPid).toBeUndefined()
      expect(info.deadlineFile).toBeUndefined()
      expect(info.idleTtlMs).toBe(0)
      expect(isPidAlive(info.pid)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.SILVER_SESSION_IDLE_MS
      else process.env.SILVER_SESSION_IDLE_MS = prev
      await run(['close', '--session', 'c', '--namespace', NS]).catch(() => {})
    }
  })

  it('SIGTERM actually retires a holder (a trap that only cleans up is not enough)', async () => {
    // Regression: the holder's first version trapped TERM to kill its drainer but
    // did NOT exit — POSIX sh resumes the loop after a trap handler returns. So
    // every `killLifelineHolder` was a silent no-op: the holder kept the lifeline
    // open and the browser stayed immortal. The trap must end in `exit`.
    const opened = await run(['open', base, '--session', 'term', '--namespace', NS])
    expect(opened.env.success).toBe(true)
    setNamespace(NS)
    const info = await readSidecar('term')
    setNamespace('')

    process.kill(info.holderPid!, 'SIGTERM')

    expect(await until(() => !isPidAlive(info.holderPid!), 10_000)).toBe(true)
    // and dropping the lifeline must take the browser with it
    expect(await until(() => !isPidAlive(info.pid), 15_000)).toBe(true)
  }, 40_000)

  it('an auto-respawn retires the previous holder instead of stranding it', async () => {
    // Regression: `ensureConnected` re-runs `openSession` whenever the browser
    // died, and the old holder polls the SAME `.deadline` file — which the session
    // keeps renewing — so without explicitly retiring it, every respawn stranded
    // one more holder that only `close` could ever collect.
    const opened = await run(['open', base, '--session', 'resp', '--namespace', NS])
    expect(opened.env.success).toBe(true)

    const holders: number[] = []
    for (let i = 0; i < 3; i++) {
      setNamespace(NS)
      const info = await readSidecar('resp')
      setNamespace('')
      holders.push(info.holderPid!)
      // Hard-kill the browser so the next command has to respawn it.
      process.kill(info.pid, 'SIGKILL')
      await until(() => !isPidAlive(info.pid), 10_000)
      const snap = await run(['snapshot', '--session', 'resp', '--namespace', NS])
      expect(snap.env.success).toBe(true)
    }

    // Every generation but the current one must be gone.
    setNamespace(NS)
    const current = await readSidecar('resp')
    setNamespace('')
    for (const stale of holders.filter((h) => h !== current.holderPid)) {
      expect(await until(() => !isPidAlive(stale), 10_000)).toBe(true)
    }
    expect(isPidAlive(current.holderPid!)).toBe(true)

    await run(['close', '--session', 'resp', '--namespace', NS]).catch(() => {})
  }, 90_000)

  it('`close` takes the holder down with the browser', async () => {
    const opened = await run(['open', base, '--session', 'd', '--namespace', NS])
    expect(opened.env.success).toBe(true)
    setNamespace(NS)
    const info = await readSidecar('d')
    setNamespace('')

    await run(['close', '--session', 'd', '--namespace', NS])

    expect(await until(() => !isPidAlive(info.pid), 10_000)).toBe(true)
    expect(await until(() => !isPidAlive(info.holderPid!), 10_000)).toBe(true)
  })
})
