import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome, setNamespace } from '../../src/core/session.js'

/**
 * HIDDEN SUBTREES must not be actionable.
 *
 * The worst failure this tool can have is the agent acting on the WRONG element,
 * and an invisible one is the worst case of that: it looks like a normal ref, it
 * clicks "successfully", and the user sees nothing happen — or worse, something
 * they never saw coming.
 *
 * `visibility: hidden` INHERITS, so a descendant of a hidden container computes
 * `hidden` too and the walk prunes it. `opacity: 0` does NOT inherit — every
 * descendant of an `opacity: 0` container computes `opacity: 1`. Closed modals,
 * dropdowns and toasts are routinely hidden that way, so their buttons stayed
 * ref-eligible.
 */

const SUFFIX = `${process.pid}-${Date.now()}`
const NS = `hidden-${SUFFIX}`

const PAGE = `<!doctype html><html><body>
  <button id="real">Visible Action</button>

  <div style="opacity: 0">
    <button id="op">Opacity Hidden Action</button>
  </div>

  <div style="visibility: hidden">
    <button id="vis">Visibility Hidden Action</button>
  </div>

  <div style="display: none">
    <button id="disp">Display None Action</button>
  </div>

  <!-- The styled-control pattern silver deliberately exempts: sites hide the real
       input (usually with opacity:0) and style a label in its place, so the input
       must stay actionable or the pattern becomes undrivable. -->
  <input id="chk" type="checkbox" style="opacity: 0" aria-label="Accept terms" />
</body></html>`

let server: Server
let base: string
/** Snapshot ONCE: a re-snapshot returns a diff (or "No changes detected"), not the tree. */
let snap = ''

describe('hidden subtrees are not ref-eligible (real Chromium)', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}/`
    await run(['open', base, '--session', 'h', '--namespace', NS])
    const res = await run(['snapshot', '-i', '--session', 'h', '--namespace', NS])
    expect(res.env.success).toBe(true)
    snap = String(res.env.data)
  })

  afterAll(async () => {
    await run(['close', '--all', '--namespace', NS]).catch(() => {})
    await fs
      .rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true })
      .catch(() => {})
    setNamespace('')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('prunes a button inside an opacity:0 container', () => {
    // The control: a genuinely visible button IS offered.
    expect(snap).toContain('Visible Action')
    // The regression: an invisible one must not be.
    expect(snap).not.toContain('Opacity Hidden Action')
  })

  it('prunes visibility:hidden and display:none subtrees too', () => {
    expect(snap).not.toContain('Visibility Hidden Action')
    expect(snap).not.toContain('Display None Action')
  })

  it('still keeps an opacity:0 CHECKBOX — the styled-control exemption survives', () => {
    // The one case that must NOT be pruned by the stricter visibility test. Sites
    // hide the real input and style a label over it; pruning it would make every
    // custom checkbox on the web undrivable. The exemption is preserved by only
    // changing what counts as hidden, never the `!isRadioCheck` carve-out.
    expect(snap).toContain('Accept terms')
  })
})
