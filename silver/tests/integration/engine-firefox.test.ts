import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'

// H1: `--engine firefox` launches Playwright's Firefox instead of Chromium — the
// real fix for TLS/H2-fingerprint sites that fail under Chromium. Firefox does
// not expose a reconnectable CDP devtools port, so the session uses a
// launch-per-command persistent-context model (see connectLaunched); a single
// self-contained `open` verifies the engine actually launches and navigates.

const NAME = `silver-ff-${process.pid}-${Date.now()}`

const PAGE = `<!doctype html><html><head><title>firefox-ok</title></head>
<body><h1 id="h">hello from firefox</h1></body></html>`

let server: Server
let pageUrl: string

describe('H1: --engine firefox launch', () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('opens a page under Firefox and returns its url + title', async () => {
    const res = await run(['open', pageUrl, '--engine', 'firefox', '--session', NAME])
    expect(res.env.success).toBe(true)
    const d = res.env.data as { url: string; title: string }
    expect(d.url).toBe(pageUrl)
    expect(d.title).toBe('firefox-ok')
  })
})
