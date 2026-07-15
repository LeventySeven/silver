/**
 * Session lifecycle — the load-bearing "browser-as-daemon" model (plan Task 4).
 *
 * `openSession` spawns a DETACHED Playwright-Chromium with a remote-debugging
 * port and a per-session user-data-dir, then `child.unref()`s it so the browser
 * survives this CLI process exiting. Every later command `connect()`s over CDP,
 * does its work, and disconnects — the browser keeps running. Cross-command
 * state (endpoint / pid, RefMap + generation) lives in JSON sidecars under
 * `~/.silver/sessions/<name>/`.
 *
 * NO model calls, ever. Errors thrown here are generic (no path / secret) to
 * honor the no-leak invariant.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { RefMap } from '../perception/refmap.js'

export type SessionInfo = {
  port: number
  pid: number
  wsEndpoint: string
  createdAt: string
}

export type OpenOptions = {
  /** Launch with a visible window. Default false (headless). */
  headed?: boolean
  /** Override the profile directory. Default `<sessionDir>/profile`. */
  userDataDir?: string
  /** Request a specific debugging port. Default 0 (let Chromium pick a free one). */
  port?: number
  /** Recorded for later idle-reaping logic; unused by open itself. */
  idleTimeoutMs?: number
}

export type Connection = {
  browser: Browser
  context: BrowserContext
  page: Page
}

const SIDECAR = 'session.json'
const REFMAP = 'refmap.json'
const READY_BUDGET_MS = 8_000

/**
 * Deterministic viewport (P0-8): a fixed window size makes snapshots/screenshots
 * and concurrent eval runs reproducible instead of inheriting a version-dependent
 * headless default. Applied both as a launch arg and (best-effort) per connect.
 */
const VIEWPORT = { width: 1280, height: 900 } as const

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True while `pid` is a live process (EPERM = alive-but-not-ours; ESRCH = gone). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Write a sidecar ATOMICALLY (P1-S5): write to a unique temp file then rename
 * into place. `rename(2)` is atomic within a directory, so a concurrent reader
 * never observes a half-written (torn) JSON grounding file.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, data, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Root dir for all sessions: `~/.silver/sessions`. */
export function sessionsRoot(): string {
  return path.join(os.homedir(), '.silver', 'sessions')
}

/** Per-session dir: `~/.silver/sessions/<name>`. */
export function sessionDir(name: string): string {
  return path.join(sessionsRoot(), assertName(name))
}

function sidecarPath(name: string): string {
  return path.join(sessionDir(name), SIDECAR)
}

function refmapPath(name: string): string {
  return path.join(sessionDir(name), REFMAP)
}

/**
 * Session names become path segments, so constrain them. On rejection we throw
 * a generic error (no name echoed) to keep error strings clean.
 */
function assertName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('invalid session name')
  }
  return name
}

/**
 * Spawn a detached Chromium, wait until its debugging endpoint is live, and
 * persist the sidecar. Returns the sidecar contents.
 */
export async function openSession(name: string, opts: OpenOptions = {}): Promise<SessionInfo> {
  const dir = sessionDir(name)
  const userDataDir = opts.userDataDir ?? path.join(dir, 'profile')
  await fs.mkdir(userDataDir, { recursive: true })

  const requestedPort = opts.port ?? 0
  const execPath = chromium.executablePath()
  if (!execPath) {
    throw new Error('no Chromium executable is available')
  }

  const args = [
    `--remote-debugging-port=${requestedPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    // deterministic viewport for reproducible snapshots/screenshots (P0-8)
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    // SSRF note (C1): the DNS-rebinding guard is a Node pre-check in egress.ts
    // (`assertNavigableResolved`), run BEFORE goto/fetch. We deliberately do NOT
    // pin `--host-resolver-rules` here — it would break legitimate resolution and
    // `localhost` — so a residual rebind TOCTOU between our lookup and Chromium's
    // own is accepted and documented (see egress.ts).
    // stealth: never advertise automation (spec §7) — note: NO --enable-automation
    ...(opts.headed ? [] : ['--headless=new']),
    'about:blank',
  ]

  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const pid = child.pid
  if (pid === undefined) {
    throw new Error('failed to spawn the browser process')
  }

  try {
    // Single shared readiness budget (≤8s total): first learn the actual
    // (possibly auto-picked) port from `<userDataDir>/DevToolsActivePort`, then
    // confirm the CDP endpoint via /json/version.
    const deadline = Date.now() + READY_BUDGET_MS
    const port = await waitForDevToolsPort(userDataDir, deadline)
    const wsEndpoint = await waitForWsEndpoint(port, deadline)

    const info: SessionInfo = {
      port,
      pid,
      wsEndpoint,
      createdAt: new Date().toISOString(),
    }
    await fs.mkdir(dir, { recursive: true })
    await atomicWrite(sidecarPath(name), JSON.stringify(info, null, 2))
    return info
  } catch (err) {
    // Readiness failed — do not leave a zombie browser behind.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    throw err
  }
}

async function waitForDevToolsPort(userDataDir: string, deadline: number): Promise<number> {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(file, 'utf8')
      const firstLine = content.split('\n', 1)[0]?.trim()
      const port = firstLine ? Number.parseInt(firstLine, 10) : Number.NaN
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      /* file not written yet */
    }
    await delay(100)
  }
  throw new Error('the browser did not expose a debugging port in time')
}

async function waitForWsEndpoint(port: number, deadline: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/json/version`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: unknown }
        if (typeof body.webSocketDebuggerUrl === 'string' && body.webSocketDebuggerUrl.length > 0) {
          return body.webSocketDebuggerUrl
        }
      }
    } catch {
      /* endpoint not up yet */
    }
    await delay(100)
  }
  throw new Error('the browser debugging endpoint did not respond in time')
}

/** Read the sidecar for a session. Throws generically if absent/corrupt. */
export async function readSidecar(name: string): Promise<SessionInfo> {
  let raw: string
  try {
    raw = await fs.readFile(sidecarPath(name), 'utf8')
  } catch {
    throw new Error('no such session (open one first)')
  }
  try {
    return JSON.parse(raw) as SessionInfo
  } catch {
    throw new Error('the session sidecar is corrupt')
  }
}

/**
 * Connect over CDP to the running detached browser. Returns the first context
 * and first page (creating a page if the context somehow has none). The caller
 * MUST `browser.close()` when done — for a connectOverCDP browser that only
 * disconnects the CDP transport; the detached browser process stays alive.
 */
export async function connect(name: string): Promise<Connection> {
  const info = await readSidecar(name)
  // PID-liveness (P1-S1): a stale sidecar whose browser died would otherwise
  // hang on a dead CDP endpoint. Treat a dead pid as "no live session" so the
  // caller (ensureConnected) re-spawns instead.
  if (!isPidAlive(info.pid)) {
    throw new Error('the previous browser process is gone (reopen the session)')
  }
  const browser = await chromium.connectOverCDP(info.wsEndpoint)
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close().catch(() => {})
    throw new Error('the browser has no available context')
  }
  const page = context.pages()[0] ?? (await context.newPage())
  // Deterministic viewport (P0-8); best-effort over a CDP-connected page.
  await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height }).catch(() => {})
  return { browser, context, page }
}

/** Persist the RefMap sidecar for cross-command grounding. */
export async function saveRefMap(name: string, map: RefMap): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await atomicWrite(refmapPath(name), JSON.stringify(map))
}

/** Load the RefMap sidecar, or null if none has been saved yet. */
export async function loadRefMap(name: string): Promise<RefMap | null> {
  let raw: string
  try {
    raw = await fs.readFile(refmapPath(name), 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as RefMap
  } catch {
    return null
  }
}

/**
 * Tear a session down: best-effort graceful CDP disconnect, terminate the
 * detached browser process, WAIT for it to actually exit, then remove the
 * session dir.
 *
 * Waiting for exit is load-bearing: SIGTERM is asynchronous, and a
 * still-shutting-down Chromium keeps writing to its profile dir. Removing the
 * dir before the process is gone lets Chromium re-create files afterward,
 * resurrecting the directory. So we kill, confirm the process is dead
 * (escalating to SIGKILL), and only then remove the dir.
 */
export async function closeSession(name: string): Promise<void> {
  const dir = sessionDir(name)
  let info: SessionInfo | null = null
  try {
    info = await readSidecar(name)
  } catch {
    info = null
  }

  if (info) {
    try {
      const browser = await chromium.connectOverCDP(info.wsEndpoint, { timeout: 3_000 })
      await browser.close()
    } catch {
      /* browser may already be gone */
    }
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch {
      /* already dead */
    }
    await waitForExit(info.pid, 4_000)
  }

  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Block until `pid` no longer exists, escalating to SIGKILL if it lingers.
 * `process.kill(pid, 0)` throws ESRCH once the process is gone.
 */
async function waitForExit(pid: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  let escalated = false
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return // ESRCH — the process is gone
    }
    if (!escalated && Date.now() > deadline - budgetMs / 2) {
      escalated = true
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        return
      }
    }
    await delay(50)
  }
}
