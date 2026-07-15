/**
 * Per-session advisory lock (DECISION §3 "per-session lock guard"; the red-team's
 * required lock primitive — Silver had ZERO locking before this).
 *
 * The problem: concurrent CLI invocations against ONE `--session` all connect to
 * the same browser and read-modify-write the same sidecars (`refmap.json`,
 * `silver-state.json`, the tab registry) and race `pages()[0]`. Nothing serialized
 * them. This lock makes commands against the SAME session run one-at-a-time;
 * commands against DIFFERENT sessions (or namespaces) never block each other,
 * because the lock file lives inside that session's own dir.
 *
 * Mechanism: an atomic exclusive-create lockfile (`<sessionDir>/.lock`).
 *   - acquire: `fs.open(path, 'wx')` (atomic create-if-absent). On EEXIST, read
 *     the holder record; take it over immediately if the holder pid is dead
 *     (PID-liveness) or the lock is older than a hard staleness bound (defends
 *     pid reuse); otherwise back off with jitter and retry until the budget.
 *   - release: remove the lockfile ONLY if it still carries OUR random token, so
 *     a process that took over a stale lock is never un-locked by the slow
 *     original holder (a token mismatch means someone else legitimately owns it).
 *
 * KEYLESS: pure filesystem + pid signals. No model, no network, no secrets.
 * Error strings are generic (no path/session leak) — a budget exhaustion throws
 * with `code: 'session_busy'`, which the CLI's mapThrow surfaces sanitized.
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { sessionDir, isPidAlive } from './session.js'

/** How long a live-pid holder may keep the lock before we force takeover. This
 * only bites a process that was SIGKILLed AND whose pid got reused by an
 * unrelated live process — PID-liveness handles the ordinary crash instantly. */
const HARD_STALE_MS = 120_000
/** Max time to wait for a busy same-session lock before failing session_busy.
 * Generous: a legitimately-serialized command (incl. an ~8s browser spawn or a
 * long `wait`) must not spuriously lose the lock. */
const DEFAULT_BUDGET_MS = 60_000
const POLL_MIN_MS = 15
const POLL_MAX_MS = 60

type LockRecord = { pid: number; token: string; at: number }

/** Thrown when the lock budget is exhausted; mapThrow → fail('session_busy'). */
export class LockError extends Error {
  readonly code = 'session_busy' as const
  constructor() {
    super('session is busy')
    this.name = 'LockError'
  }
}

function lockPath(name: string): string {
  return path.join(sessionDir(name), '.lock')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readLock(file: string): Promise<LockRecord | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const rec = JSON.parse(raw) as LockRecord
    if (typeof rec.pid === 'number' && typeof rec.token === 'string') return rec
    return null
  } catch {
    return null
  }
}

/** A holder is stale (safe to steal) if its process is gone or the lock is
 * older than the hard bound. A missing/corrupt record counts as stale. */
function isStale(rec: LockRecord | null): boolean {
  if (!rec) return true
  if (!isPidAlive(rec.pid)) return true
  return Date.now() - rec.at > HARD_STALE_MS
}

/** Acquire the lock, returning the token needed to release it. */
async function acquire(name: string, budgetMs: number): Promise<string> {
  const file = lockPath(name)
  const token = randomUUID()
  const deadline = Date.now() + budgetMs
  // Ensure the session dir exists (a concurrent close may have removed it).
  await fs.mkdir(sessionDir(name), { recursive: true }).catch(() => {})

  for (;;) {
    try {
      const fh = await fs.open(file, 'wx')
      const rec: LockRecord = { pid: process.pid, token, at: Date.now() }
      await fh.writeFile(JSON.stringify(rec), 'utf8')
      await fh.close()
      return token
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Parent dir vanished (a concurrent close rm -rf'd it) — recreate + retry.
        await fs.mkdir(sessionDir(name), { recursive: true }).catch(() => {})
        continue
      }
      if (code !== 'EEXIST') throw err

      // Lock is held. Steal it if the holder is stale; otherwise wait.
      const holder = await readLock(file)
      if (isStale(holder)) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) throw new LockError()
      await delay(POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS)))
    }
  }
}

/** Release the lock iff it still carries our token (never steal-back-safe). */
async function release(name: string, token: string): Promise<void> {
  const file = lockPath(name)
  const holder = await readLock(file)
  if (holder && holder.token === token) {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

/**
 * Run `fn` while holding the session's advisory lock. Same-session calls
 * serialize; different sessions/namespaces run concurrently. The lock is always
 * released, even if `fn` throws.
 */
export async function withSessionLock<T>(
  name: string,
  fn: () => Promise<T>,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<T> {
  const token = await acquire(name, budgetMs)
  try {
    return await fn()
  } finally {
    await release(name, token)
  }
}
