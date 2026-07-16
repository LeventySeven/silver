import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'

// F1: `--engine firefox|webkit` is REJECTED at session launch. Silver's whole
// perception/actuation stack speaks CDP (`context.newCDPSession`), which
// firefox/webkit do not expose — a non-chromium session could open but never
// snapshot. Rather than ship that half-broken fallback, openSession fails LOUD
// with the `engine_unsupported` taxonomy error. A real non-CDP firefox path is
// out of scope (it needs an engine-agnostic perception rewrite).

const NAME = `silver-ff-${process.pid}-${Date.now()}`

const PAGE = `<!doctype html><html><head><title>firefox-ok</title></head>
<body><h1 id="h">hello</h1></body></html>`

let server: Server
let pageUrl: string

describe('F1: --engine firefox|webkit is rejected at launch', () => {
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
      /* never opened — nothing to close */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects --engine firefox with a clear engine_unsupported error', async () => {
    const res = await run(['open', pageUrl, '--engine', 'firefox', '--session', NAME])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toBe(ERRORS.engine_unsupported.message)
    // The advisory names the requirement so a host can self-correct.
    expect(String(res.env.error)).toMatch(/Chromium/i)
  })

  it('rejects --engine webkit the same way', async () => {
    const res = await run(['open', pageUrl, '--engine', 'webkit', '--session', `${NAME}-wk`])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toBe(ERRORS.engine_unsupported.message)
  })

  it('still opens normally under the default (chromium) engine', async () => {
    const res = await run(['open', pageUrl, '--session', NAME])
    expect(res.env.success).toBe(true)
    const d = res.env.data as { url: string; title: string }
    expect(d.url).toBe(pageUrl)
    expect(d.title).toBe('firefox-ok')
  })
})
