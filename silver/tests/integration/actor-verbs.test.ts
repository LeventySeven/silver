import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { closeSession, loadRefMap } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-actor-${process.pid}-${Date.now()}`

// A page with a focusable input (keydown/keyup target), a download LINK, and a
// download BUTTON that dispatches a click-driven download from JS.
const PAGE = `<!doctype html>
<html><body>
  <h1>Silver actor verbs</h1>
  <input id="kbd" aria-label="kbd field">
  <a id="dllink" href="/download">download link</a>
</body></html>`

const DL_BODY = 'hello-download-payload'

let server: Server
let pageUrl: string

// Download output files are written INSIDE the cwd (assertContainedPath) — track
// them so afterAll removes every artifact this suite creates.
const created: string[] = []
function outName(tag: string): string {
  const rel = `silver-dl-${process.pid}-${tag}-${Date.now()}.bin`
  created.push(path.resolve(process.cwd(), rel))
  return rel
}

function firstRefWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role} in refmap`)
}

describe('download / keydown / keyup / set (real Chromium via the run() entry)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/download')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.bin"',
        })
        res.end(DL_BODY)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    pageUrl = `http://localhost:${port}/`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    for (const f of created) await fs.rm(f, { force: true }).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('download is quarantined without --enable-actions', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const denied = await run(['download', '#dllink', outName('gate'), '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)
  })

  it('download <selector> <path> clicks the link and saves the file (contained path)', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const out = outName('sel')
    const dl = await run(['download', '#dllink', out, '--enable-actions', '--session', NAME])
    expect(dl.env.success).toBe(true)
    expect((dl.env.data as { saved: boolean }).saved).toBe(true)
    // The suggested filename is page/server-derived → boundary-fenced (neutralized).
    const filename = (dl.env.data as { filename: string }).filename
    expect(filename).toContain('page-content')
    expect(filename).toContain('report.bin')
    // The bytes actually landed on disk.
    const content = await fs.readFile(path.resolve(process.cwd(), out), 'utf8')
    expect(content).toBe(DL_BODY)
  })

  it('download <@ref> <path> works via a grounded ref too', async () => {
    await run(['open', pageUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const linkRef = firstRefWithRole(map as RefMap, 'link')
    const out = outName('ref')
    const dl = await run(['download', `@${linkRef}`, out, '--enable-actions', '--session', NAME])
    expect(dl.env.success).toBe(true)
    const content = await fs.readFile(path.resolve(process.cwd(), out), 'utf8')
    expect(content).toBe(DL_BODY)
  })

  it('download rejects a path outside the working directory (path_denied)', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const denied = await run([
      'download', '#dllink', '/etc/silver-should-never-write', '--enable-actions', '--session', NAME,
    ])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.path_denied.message)
  })

  it('download --wait times out cleanly when no download occurs', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const waited = await run([
      'download', '--wait', '--timeout', '600', '--enable-actions', '--session', NAME,
    ])
    expect(waited.env.success).toBe(false)
    expect(waited.env.error).toBe(ERRORS.timeout.message)
  })

  it('keydown/keyup dispatch a real key to the focused control', async () => {
    await run(['open', pageUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const inputRef = firstRefWithRole(map as RefMap, 'textbox')

    // keydown is an ACTOR verb — refused without the grant.
    const denied = await run(['keydown', 'a', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    await run(['focus', `@${inputRef}`, '--enable-actions', '--session', NAME])
    const down = await run(['keydown', 'a', '--enable-actions', '--session', NAME])
    expect(down.env.success).toBe(true)
    expect((down.env.data as { keydown: string }).keydown).toBe('a')
    const up = await run(['keyup', 'a', '--enable-actions', '--session', NAME])
    expect(up.env.success).toBe(true)
    expect((up.env.data as { keyup: string }).keyup).toBe('a')

    // The keydown/up pair inserted the character into the focused input.
    const value = await run(['get', 'value', `@${inputRef}`, '--session', NAME])
    expect((value.env.data as { value: string }).value).toContain('a')
  })

  it('keydown without a key is a clean usage error', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const bad = await run(['keydown', '--enable-actions', '--session', NAME])
    expect(bad.env.success).toBe(false)
    expect(bad.env.error).toContain('usage: silver keydown')
  })

  it('set viewport resizes the page and is gated without --enable-actions', async () => {
    await run(['open', pageUrl, '--session', NAME])

    // Gated: no grant → not_permitted (never reaches the handler).
    const denied = await run(['set', 'viewport', '800', '600', '--session', NAME])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    const set = await run(['set', 'viewport', '800', '600', '--enable-actions', '--session', NAME])
    expect(set.env.success).toBe(true)
    const data = set.env.data as {
      viewport: { width: number; height: number }
      applied: { width: number; height: number }
    }
    expect(data.viewport).toEqual({ width: 800, height: 600 })
    // The resize actually took effect on the live page: the in-connection read-back
    // of window.innerWidth/innerHeight matches the requested viewport. (Emulation
    // overrides are per-connection under the reconnect model, so this is verified
    // within the same command rather than a later one.)
    expect(data.applied).toEqual({ width: 800, height: 600 })
  })

  it('set offline / color-scheme / geolocation / timezone / locale all succeed', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const offline = await run(['set', 'offline', 'false', '--enable-actions', '--session', NAME])
    expect((offline.env.data as { offline: boolean }).offline).toBe(false)

    const scheme = await run(['set', 'color-scheme', 'dark', '--enable-actions', '--session', NAME])
    expect((scheme.env.data as { colorScheme: string }).colorScheme).toBe('dark')

    const geo = await run(['set', 'geolocation', '51.5', '-0.12', '--enable-actions', '--session', NAME])
    expect((geo.env.data as { geolocation: { latitude: number } }).geolocation.latitude).toBe(51.5)

    const tz = await run(['set', 'timezone', 'America/New_York', '--enable-actions', '--session', NAME])
    expect((tz.env.data as { timezone: string }).timezone).toBe('America/New_York')

    const locale = await run(['set', 'locale', 'en-GB', '--enable-actions', '--session', NAME])
    expect((locale.env.data as { locale: string }).locale).toBe('en-GB')
  })

  it('set with an unknown subcommand returns a typed error listing the valid ones', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const bad = await run(['set', 'bogus', '--enable-actions', '--session', NAME])
    expect(bad.env.success).toBe(false)
    for (const sub of ['viewport', 'offline', 'color-scheme', 'geolocation', 'timezone', 'locale']) {
      expect(bad.env.error).toContain(sub)
    }
  })

  it('set timezone rejects an invalid IANA name cleanly', async () => {
    await run(['open', pageUrl, '--session', NAME])
    const bad = await run(['set', 'timezone', 'Not/AZone', '--enable-actions', '--session', NAME])
    expect(bad.env.success).toBe(false)
    expect(bad.env.error).toContain('invalid timezone')
  })
})
