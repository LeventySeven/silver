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
 *     the holder record; take it over immediately ONLY if the holder pid is dead
 *     (PID-liveness). A LIVE holder is never stolen no matter how long it has
 *     held the lock — a legitimate long command (e.g. `wait --timeout 200000`)
 *     must keep its lock. A heartbeat rewrites the record's `at` while `fn()`
 *     runs, so the only lock that can age past the absolute last-resort bound is
 *     one whose holder died and whose pid was reused by an unrelated live process
 *     (the sole case PID-liveness cannot detect). Otherwise back off with jitter
 *     and retry until the budget.
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

/** Absolute last-resort staleness bound. A LIVE-pid holder is normally NEVER
 * stolen (see isStale) — this bound only bites a holder that was SIGKILLed AND
 * whose pid got reused by an unrelated live process, so PID-liveness reports
 * "alive" but the heartbeat has stopped and `at` freezes. Deliberately far above
 * any legitimate single-command hold (and above HEARTBEAT_MS) so a live command
 * that genuinely holds the lock for minutes is safe. PID-liveness handles the
 * ordinary crash instantly; this is only the deadlock breaker of last resort. */
const ABSOLUTE_STALE_MS = 30 * 60_000
/** Cadence at which a live holder rewrites its record's `at` while `fn()` runs,
 * keeping the lock from ever aging toward ABSOLUTE_STALE_MS. Must be well under
 * that bound. */
const HEARTBEAT_MS = 30_000
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

/** A holder is stale (safe to steal) if its process is gone. A LIVE holder is
 * NOT stealable on age alone — a long-running command legitimately holds the
 * lock for as long as it runs, and the heartbeat keeps its `at` fresh — so age
 * is used only as an absolute deadlock breaker for a dead-but-pid-reused holder
 * (a holder whose pid is now alive but whose heartbeat froze). A missing/corrupt
 * record counts as stale. */
function isStale(rec: LockRecord | null): boolean {
  if (!rec) return true
  // Ordinary crash: pid is gone → steal immediately (the common case).
  if (!isPidAlive(rec.pid)) return true
  // Live pid: never steal on the ordinary bound; only the absolute last-resort
  // bound (pid-reuse deadlock) can force a takeover of a live-pid record.
  return Date.now() - rec.at > ABSOLUTE_STALE_MS
}

/** Rewrite the holder record's `at` iff we still own the lock (token match),
 * atomically (temp + rename) so a concurrent waiter never reads a partial file
 * and mistakes it for a corrupt/stale record. Best-effort: a dropped heartbeat
 * just means the next one retries. */
async function refreshLock(file: string, token: string): Promise<void> {
  const holder = await readLock(file)
  if (!holder || holder.token !== token) return
  const rec: LockRecord = { pid: holder.pid, token, at: Date.now() }
  const tmp = `${file}.${token}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(rec), 'utf8')
    await fs.rename(tmp, file)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
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
  const file = lockPath(name)
  // Keep the record's `at` fresh so a live holder is never mistaken for stale,
  // even across a multi-minute command. unref() so the timer never keeps the
  // process alive on its own.
  const heartbeat = setInterval(() => {
    void refreshLock(file, token)
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    await release(name, token)
  }
}
