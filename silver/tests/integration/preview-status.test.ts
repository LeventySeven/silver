import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { run } from '../../src/cli.js'
import { closeSession } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'

/**
 * Issue #1 — "never hand back a URL silver has not itself proven."
 *
 * The bug: `handleOpen` DISCARDED the navigation Response, so a 404 came back as
 * `{success:true, data:{url, title, page_changed}}` — a link the agent could pass
 * to a human having proved only that *something* answered. `silver open` now
 * carries the HTTP status it actually observed, plus an `http_error` flag and an
 * advisory warning when the server answered >= 400.
 *
 * The three outcomes must stay DISTINCT and must not be conflated:
 *   - unreachable host  -> `navigation_failed` (retryable with backoff)
 *   - server answered   -> success + `status` (the number decides, not the fact
 *                          that a document loaded)
 *   - not observed      -> `status: null` (a same-document/hash navigation).
 *                          null means NOT OBSERVED and must never be read as 200.
 */

const NAME = `silver-preview-status-${process.pid}-${Date.now()}`

const OK_PAGE = `<!doctype html><html><head><title>preview ok</title></head>
<body><h1>the route rendered</h1><p>this is the real page</p></body></html>`

// A 404 body with real content — the point is that a rendered, non-empty page is
// NOT evidence the route exists. Only the status is.
const NOT_FOUND_PAGE = `<!doctype html><html><head><title>404 Not Found</title></head>
<body><h1>404</h1><p>No such route on this deployment.</p></body></html>`

let server: Server
let base: string
let deadBase: string

type Open = {
  url: string
  title: string
  page_changed: boolean
  status: number | null
  http_error?: true
}

describe('issue #1: `open` surfaces the HTTP status it actually observed', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/ok')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(OK_PAGE)
        return
      }
      if (url.startsWith('/boom')) {
        res.writeHead(500, { 'content-type': 'text/html' })
        res.end('<!doctype html><html><body><h1>500</h1></body></html>')
        return
      }
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end(NOT_FOUND_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    // Addressed by NAME: the egress guard hard-blocks a loopback IP LITERAL and
    // `--allowed-domains` cannot lift it; only `localhost` is exempt.
    base = `http://localhost:${(server.address() as AddressInfo).port}`

    // A port nothing listens on: bind one, read it, then give it back.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    deadBase = `http://localhost:${deadPort}`
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('a 200 route reports status 200 and flags nothing', async () => {
    const r = await run(['open', `${base}/ok`, '--session', NAME])
    expect(r.env.success).toBe(true)
    const d = r.env.data as Open
    expect(d.status).toBe(200)
    expect(d.http_error).toBeUndefined()
    expect(r.env.warning ?? '').not.toContain('http_error')
  })

  it('a 404 route still loads, but reports status 404 + http_error (the issue)', async () => {
    const r = await run(['open', `${base}/definitely-not-a-route`, '--session', NAME])
    // The navigation itself succeeded — there IS a document. That is exactly why
    // the status has to be reported: `success:true` was never proof of a route.
    expect(r.env.success).toBe(true)
    const d = r.env.data as Open
    expect(d.status).toBe(404)
    expect(d.http_error).toBe(true)
    // Loud in human mode too, not only under --json.
    expect(r.env.warning ?? '').toContain('http_error')
    expect(r.env.warning ?? '').toContain(ERRORS.http_error.message)
  })

  it('a 500 route is flagged the same way (the rule is >= 400, not just 404)', async () => {
    const r = await run(['open', `${base}/boom`, '--session', NAME])
    expect(r.env.success).toBe(true)
    const d = r.env.data as Open
    expect(d.status).toBe(500)
    expect(d.http_error).toBe(true)
  })

  it('a same-document (hash) navigation reports status null — NOT an assumed 200', async () => {
    // Playwright resolves goto() to null when nothing was re-requested. Defaulting
    // that to 200 would silently reintroduce "silver claims a route it never saw".
    await run(['open', `${base}/ok`, '--session', NAME])
    const r = await run(['open', `${base}/ok#section`, '--session', NAME])
    expect(r.env.success).toBe(true)
    const d = r.env.data as Open
    expect(d.status).toBeNull()
    expect(d.http_error).toBeUndefined()
  })

  it('an unreachable host stays `navigation_failed`, distinct from an HTTP error', async () => {
    const r = await run(['open', `${deadBase}/ok`, '--session', NAME])
    expect(r.env.success).toBe(false)
    expect(r.env.error).toBe(ERRORS.navigation_failed.message)
    // "nobody answered" and "the server said 404" need different remedies.
    expect(r.env.error).not.toBe(ERRORS.http_error.message)
  })

  it('`reload` carries the status too, so a poll loop that reloads is not blind', async () => {
    await run(['open', `${base}/definitely-not-a-route`, '--session', NAME])
    const r = await run(['reload', '--session', NAME])
    expect(r.env.success).toBe(true)
    const d = r.env.data as { url: string; page_changed: boolean; status: number | null }
    expect(d.status).toBe(404)
    expect((r.env.data as Open).http_error).toBe(true)
  })
})

describe('issue #1: `read <url>` on a non-2xx says http_error, not page_crash', () => {
  let srv: Server
  let b: string

  beforeAll(async () => {
    srv = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/ok')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(OK_PAGE)
        return
      }
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end(NOT_FOUND_PAGE)
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    b = `http://localhost:${(srv.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  })

  it('reports http_error and NOT the destructive `reload` remedy', async () => {
    const r = await run(['read', `${b}/missing`, '--session', `${NAME}-read`])
    expect(r.env.success).toBe(false)
    expect(r.env.error).toBe(ERRORS.http_error.message)
    // page_crash tells the host to `reload` — destructive and useless for a 404:
    // the same request returns the same status.
    expect(r.env.error).not.toBe(ERRORS.page_crash.message)
    expect(r.env.error).not.toContain('the page crashed')
  })

  it('a 2xx read is unaffected', async () => {
    const r = await run(['read', `${b}/ok`, '--session', `${NAME}-read`])
    expect(r.env.success).toBe(true)
    expect(String(r.env.data)).toContain('the route rendered')
  })
})
