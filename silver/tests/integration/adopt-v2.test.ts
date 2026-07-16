import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { closeSession, sessionDir } from '../../src/core/session.js'

// Covers the keyless adopt-list-v2 items owned here that do NOT need Firefox:
//   F2 doctor real-launch probe · G5 skill reference catalog ·
//   B1 coordinate-verb dispatch · E4 page-initiated download auto-detection.

const NAME = `silver-av2-${process.pid}-${Date.now()}`

// A canvas fixture (B1): no AX node for the drawing surface, so ref-based verbs
// cannot target it — coordinate verbs are the only way in. margin:0 so page
// coordinates map straight onto the canvas. A click sets document.title so we
// can prove the raw pointer event actually landed.
const CANVAS_PAGE = `<!doctype html><html><head><title>canvas</title></head>
<body style="margin:0;padding:0">
<canvas id="c" width="300" height="300"></canvas>
<script>
  var c = document.getElementById('c');
  window.__clicks = [];
  c.addEventListener('click', function (e) {
    window.__clicks.push([e.offsetX, e.offsetY]);
    document.title = 'clicked';
  });
</script>
</body></html>`

// A page-initiated download (E4): a link with the download attribute pointing at
// an attachment response. Clicking it (NOT via the `download` verb) must be
// auto-handled so the artifact lands in the contained per-session downloads dir.
const DL_PAGE = `<!doctype html><html><head><title>dl</title></head>
<body><a id="dl" href="/file" download="report.bin">download</a></body></html>`

const DL_BODY = 'auto-download-payload'

let server: Server
let canvasUrl: string
let dlUrl: string
let refDir: string
const refFixture = `zz-test-${process.pid}` // unique so it never clobbers sibling files

describe('adopt-list-v2 (F2 doctor · G5 skill · B1 coord · E4 download)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/file')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.bin"',
        })
        res.end(DL_BODY)
        return
      }
      if (url.startsWith('/dl')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(DL_PAGE)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(CANVAS_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    canvasUrl = `http://localhost:${port}/`
    dlUrl = `http://localhost:${port}/dl`

    // G5: author a reference fixture the SKILL sibling would normally provide, so
    // the catalog can be exercised end-to-end. Removed in afterAll.
    refDir = path.join(process.cwd(), 'skill-data', 'core', 'reference')
    await fs.mkdir(refDir, { recursive: true })
    await fs.writeFile(
      path.join(refDir, `${refFixture}.md`),
      '# test reference\n\nhello from the reference catalog\n',
      'utf8',
    )
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await fs.rm(path.join(refDir, `${refFixture}.md`), { force: true }).catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // ---- F2/K4: doctor real-launch probe + structured report shape ----
  it('doctor runs a real headless launch probe and returns the structured report', async () => {
    const res = await run(['doctor'])
    expect(res.env.success).toBe(true)
    type Check = { name: string; status: string; message: string; fix?: string; details?: string }
    const d = res.env.data as {
      checks: Check[]
      verdict: 'ok' | 'issues'
      next: string
      passed: number
      total: number
    }
    // K4: structured shape — an array of {name,status,message,fix,details} checks
    // plus verdict / next / passed / total.
    expect(Array.isArray(d.checks)).toBe(true)
    expect(typeof d.verdict).toBe('string')
    expect(typeof d.next).toBe('string')
    const by = (n: string): Check | undefined => d.checks.find((c) => c.name === n)
    // Deterministic checks (fast, no contention) pass on this machine.
    expect(by('playwright')?.status).toBe('pass')
    expect(by('chromium')?.status).toBe('pass')
    expect(by('uab_writable')?.status).toBe('pass')
    // The new K4 checks are present.
    expect(by('session_locks')).toBeDefined()
    expect(by('cdp_reachable')).toBeDefined()
    // The REAL launch probe ran (a status, not just existsSync). On an unloaded box
    // it passes; under peak parallel test load a fresh full-Chromium launch can lose
    // the resource race, in which case a remediation command is attached.
    const launch = by('browser_launch')
    expect(launch).toBeDefined()
    if (launch?.status === 'fail') {
      expect(launch.fix).toContain('playwright install')
    }
    // Every check carries a remediation command whenever it is not passing.
    for (const c of d.checks) {
      if (c.status === 'fail') expect(typeof c.fix).toBe('string')
    }
    // Accounting invariants: passed = number of passing checks; total = checks.length;
    // verdict is 'ok' iff no check failed.
    expect(d.total).toBe(d.checks.length)
    expect(d.passed).toBe(d.checks.filter((c) => c.status === 'pass').length)
    const anyFail = d.checks.some((c) => c.status === 'fail')
    expect(d.verdict).toBe(anyFail ? 'issues' : 'ok')
  })

  // ---- G5: skill reference catalog ----
  it('skill --list enumerates reference topics', async () => {
    const res = await run(['skill', '--list'])
    expect(res.env.success).toBe(true)
    const refs = (res.env.data as { references: string[] }).references
    expect(Array.isArray(refs)).toBe(true)
    expect(refs).toContain(refFixture)
  })

  it('skill list (positional) also enumerates topics', async () => {
    const res = await run(['skill', 'list'])
    expect((res.env.data as { references: string[] }).references).toContain(refFixture)
  })

  it('skill <ref> serves the reference file content', async () => {
    const res = await run(['skill', refFixture])
    expect(res.env.success).toBe(true)
    expect(res.env.data as string).toContain('hello from the reference catalog')
  })

  it('skill <unknown-ref> is a clean not-found', async () => {
    const res = await run(['skill', 'no-such-topic-xyz'])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toContain('no such skill reference')
  })

  it('skill with a traversal name is rejected before any read', async () => {
    const res = await run(['skill', '../../etc/passwd'])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toContain('invalid skill reference')
  })

  it('skill install copies the payload into <target>/silver and reports it', async () => {
    const dest = path.join(os.tmpdir(), `silver-skill-install-${process.pid}-${Date.now()}`)
    try {
      const res = await run(['skill', 'install', dest])
      expect(res.env.success).toBe(true)
      const data = res.env.data as { installed: string[]; target: string }
      // Files land under <target>/silver, and the report names that install root.
      expect(data.target).toBe(path.join(dest, 'silver'))
      expect(Array.isArray(data.installed)).toBe(true)
      expect(data.installed.length).toBeGreaterThan(0)
      // The discovery stub + the core guide are on disk under <target>/silver.
      expect(existsSync(path.join(dest, 'silver', 'SKILL.md'))).toBe(true)
      expect(existsSync(path.join(dest, 'silver', 'skill-data', 'core', 'SKILL.md'))).toBe(true)
      // Every reported path is a real, contained file inside the install root.
      const installRoot = path.join(dest, 'silver')
      for (const p of data.installed) {
        expect(existsSync(p)).toBe(true)
        expect(p.startsWith(installRoot + path.sep)).toBe(true)
      }
    } finally {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ---- B1: coordinate-verb dispatch (canvas fallback) ----
  it('click --at x y is quarantined without --enable-actions', async () => {
    await run(['open', canvasUrl, '--session', NAME])
    const denied = await run(['click', '--at', '50', '60', '--session', NAME])
    expect(denied.env.success).toBe(false)
  })

  it('click --at x y dispatches a raw pointer click on a canvas (no AX ref)', async () => {
    await run(['open', canvasUrl, '--session', NAME])
    const res = await run(['click', '--at', '50', '60', '--enable-actions', '--session', NAME])
    expect(res.env.success).toBe(true)
    expect((res.env.data as { clicked: { x: number; y: number } }).clicked).toEqual({ x: 50, y: 60 })
    // The canvas actually received the click (its handler set document.title).
    const title = await run(['get', 'title', '--session', NAME])
    expect((title.env.data as { title: string }).title).toBe('clicked')
  })

  it('drag --from --to dispatches a raw pointer drag', async () => {
    await run(['open', canvasUrl, '--session', NAME])
    const res = await run([
      'drag', '--from', '10', '20', '--to', '80', '90', '--enable-actions', '--session', NAME,
    ])
    expect(res.env.success).toBe(true)
    const d = res.env.data as { dragged: { from: { x: number }; to: { x: number } } }
    expect(d.dragged.from.x).toBe(10)
    expect(d.dragged.to.x).toBe(80)
  })

  // ---- E4: page-initiated download auto-detection ----
  it('a click that triggers a download is auto-saved to the contained dir', async () => {
    await run(['open', dlUrl, '--session', NAME])
    // Click the download link via `find` (a NON-`download` actor dispatch). The
    // E4 auto-download handler resolves the page-initiated download so the click
    // does not stall, and lands the file in <session>/downloads.
    const clicked = await run([
      'find', 'text', 'download', 'click', '--enable-actions', '--session', NAME,
    ])
    expect(clicked.env.success).toBe(true)
    const dir = path.join(sessionDir(NAME), 'downloads')
    // Poll: saveAs completes shortly after the download event fires.
    let found = false
    for (let i = 0; i < 50; i++) {
      if (existsSync(dir)) {
        const files = await fs.readdir(dir).catch(() => [] as string[])
        if (files.length > 0) {
          found = true
          break
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(found).toBe(true)
  })
})
