/**
 * Point every test file at its own throwaway silver root.
 *
 * Mandatory since the idle reaper went GLOBAL. Before that, a test isolated
 * itself with `--namespace`, because a sweep only ever scanned its own
 * namespace's root — the assumption several integration files still state in
 * their comments. Now a single `silver open` (or `session gc`) sweeps EVERY
 * namespace, so `npm test` against the real root would SIGTERM whatever browsers
 * the developer had parked in another project and delete their session dirs. A
 * test suite may not do that.
 *
 * `SILVER_HOME` relocates only what silver owns. Redirecting `$HOME` instead —
 * the obvious-looking alternative — is actively wrong here: Chromium then cannot
 * find the login keychain and pops a blocking "A keychain cannot be found to
 * store Chromium" modal on every single browser launch.
 *
 * One root per test FILE (vitest runs setup once per worker), so files also stop
 * being able to sweep each other's fixtures out from under them.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll } from 'vitest'

const PREV = process.env.SILVER_HOME
const TEST_ROOT = path.join(
  os.tmpdir(),
  `silver-test-root-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
)

beforeAll(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true })
  process.env.SILVER_HOME = TEST_ROOT
})

afterAll(async () => {
  if (PREV === undefined) delete process.env.SILVER_HOME
  else process.env.SILVER_HOME = PREV
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
})
