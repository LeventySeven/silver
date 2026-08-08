import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SpawnOptions } from 'node:child_process'

/**
 * Locale and timezone are set at the LAUNCH layer, not over CDP.
 *
 * `set timezone` / `set locale` go through `Emulation.setTimezoneOverride` /
 * `setLocaleOverride` — a CDP call, i.e. exactly the layer a detector probes for a
 * runtime patch. `--lang` and a `TZ` env var are stock Chromium and apply BELOW
 * that: the process starts up already believing it, so `Intl`, the `Accept-Language`
 * header, and `navigator.language` agree with each other instead of one of them
 * having been corrected after the fact. Launch-time only, so it binds a FRESH
 * session — the same constraint `--proxy` accepts. The CDP path is untouched and
 * stays the mid-session fallback.
 *
 * This test asserts the args and env are COMPOSED. It cannot assert Chromium
 * honored them — `spawn` is mocked here so nothing launches. That half is verified
 * against a live page (see the commit message for the measured read-back).
 */

/** Every spawn() openSession attempted, newest last. */
const spawns: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: SpawnOptions) => {
      spawns.push({ cmd, args, opts })
      // `pid: undefined` makes openSession throw on the very next line, BEFORE it
      // waits ~8s on a DevToolsActivePort that a fake child will never write.
      // The args/env we came to inspect are already captured by then.
      return { pid: undefined, unref() {} }
    },
  }
})

const { openSession } = await import('../../src/core/session.js')
type OpenOptions = import('../../src/core/session.js').OpenOptions

/**
 * Drive a real openSession and return the argv+options it handed to spawn.
 * `execPath` points at the node binary purely because it is a path that exists:
 * openSession refuses to spawn a missing executable, and this keeps the test
 * hermetic (no `playwright install chromium` required to run it). Nothing is
 * executed — spawn is mocked.
 */
async function launchArgs(opts: OpenOptions = {}) {
  await expect(
    openSession('launch-args', { execPath: process.execPath, ...opts }),
  ).rejects.toThrow()
  const last = spawns.at(-1)
  expect(last, 'openSession never reached spawn()').toBeDefined()
  return last!
}

beforeEach(() => {
  spawns.length = 0
})

describe('openSession composes locale and timezone into the launch', () => {
  it('puts --lang=<locale> in the argv', async () => {
    const { args } = await launchArgs({ locale: 'de-DE' })
    expect(args).toContain('--lang=de-DE')
  })

  it('also puts --accept-lang, without which the locale lands nowhere on macOS', async () => {
    // Not belt-and-braces. Measured against this exact spawn path: `--lang` alone
    // leaves navigator.language, navigator.languages AND the Accept-Language header
    // at en-US on macOS (Chromium reads its app locale from the OS there);
    // `--accept-lang` is what produced `de-DE,de;q=0.9` on the wire. `--lang` still
    // carries the app/ICU locale on Linux and Windows, so both ship. A future
    // cleanup that deletes one of them as a duplicate silently un-sets the locale on
    // one platform or the other — hence this assertion.
    const { args } = await launchArgs({ locale: 'de-DE' })
    expect(args).toContain('--accept-lang=de-DE')
  })

  it('puts TZ=<timezone> in the spawn env, keeping the rest of the environment', async () => {
    const { opts } = await launchArgs({ timezone: 'Europe/Berlin' })
    expect(opts.env?.TZ).toBe('Europe/Berlin')
    // Passing `env` REPLACES the child's whole environment. Dropping PATH/HOME on
    // the browser would break it in ways nobody would trace back to a timezone
    // flag, so the inherited environment has to survive.
    expect(opts.env?.PATH).toBe(process.env.PATH)
  })

  it('sets both together without disturbing the existing args', async () => {
    const { args, opts } = await launchArgs({ locale: 'de-DE', timezone: 'Asia/Tokyo' })
    expect(args).toContain('--lang=de-DE')
    expect(opts.env?.TZ).toBe('Asia/Tokyo')
    // The launch args that were already load-bearing must still be there — in
    // particular the webdriver de-tell, and `about:blank` LAST (Chromium reads a
    // trailing positional as the start URL; an arg appended after it is a URL, not
    // a flag).
    expect(args).toContain('--disable-blink-features=AutomationControlled')
    expect(args.at(-1)).toBe('about:blank')
  })

  it('adds nothing when neither is asked for', async () => {
    const { args, opts } = await launchArgs()
    expect(args.some((a) => a.startsWith('--lang') || a.startsWith('--accept-lang'))).toBe(false)
    // No env override at all, so the child plainly inherits ours — not a copy of
    // process.env that would silently freeze at import time.
    expect(opts.env).toBeUndefined()
  })

  it('ignores an empty value rather than emitting a bare flag', async () => {
    // Same truthiness gate --proxy uses: `--lang=` and `TZ=` are worse than absent
    // (an empty TZ is UTC to some libc implementations, not "unset").
    const { args, opts } = await launchArgs({ locale: '', timezone: '' })
    expect(args.some((a) => a.startsWith('--lang') || a.startsWith('--accept-lang'))).toBe(false)
    expect(opts.env).toBeUndefined()
  })
})
