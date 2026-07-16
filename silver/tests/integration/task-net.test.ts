import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { closeSession, sanitizeNamespace } from '../../src/core/session.js'

// F11 (network har coverage) + F13 (task exec markers for string envelopes).
// Both drive real Chromium through the run() entry, like the sibling network
// requests/route test in tests/integration/verbs.test.ts.

const NAME = `silver-tasknet-${process.pid}-${Date.now()}`
const NAME2 = `silver-tasknet2-${process.pid}-${Date.now()}`
const NS = `tasknet-${process.pid}-${Date.now()}`

const PAGE = `<!doctype html>
<html><head><title>Silver task-net</title></head><body>
  <h1>task-net fixture</h1>
  <button id="mainbtn">Main</button>
</body></html>`

let server: Server
let pageUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/ping')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('pong')
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
  for (const s of [NAME, NAME2]) {
    try {
      await closeSession(s)
    } catch {
      /* ignore */
    }
  }
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(NS)), {
    recursive: true,
    force: true,
  }).catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('network har + task exec markers (real Chromium via run())', () => {
  // F11 — network har has no coverage. Record on a page that issues a fetch,
  // then export the HAR and assert it is a valid HAR carrying the request.
  it('F11: network har start → fetch → stop produces a valid HAR with the request', async () => {
    await run(['open', pageUrl, '--session', NAME])

    const started = await run(['network', 'har', 'start', '--session', NAME])
    expect(started.env.success).toBe(true)
    expect((started.env.data as { har: string }).har).toBe('recording')

    // Issue a fetch from host JS; the in-page wrapper records it for the HAR.
    const fetched = await run([
      'eval',
      "fetch('/ping').then(function(){return 'ok'},function(){return 'err'})",
      '--enable-actions',
      '--session',
      NAME,
    ])
    expect(fetched.env.data as string).toContain('ok')

    const stopped = await run(['network', 'har', 'stop', '--session', NAME])
    expect(stopped.env.success).toBe(true)
    const body = stopped.env.data as {
      entries: number
      har: {
        log: {
          version: string
          creator: { name: string }
          entries: Array<{ request: { method: string; url: string } }>
        }
      }
    }
    // A valid HAR 1.2 envelope from silver…
    expect(body.har.log.version).toBe('1.2')
    expect(body.har.log.creator.name).toBe('silver')
    expect(Array.isArray(body.har.log.entries)).toBe(true)
    // …carrying the /ping request the page issued.
    expect(body.entries).toBeGreaterThanOrEqual(1)
    expect(body.har.log.entries.some((e) => e.request.url.includes('/ping'))).toBe(true)
  })

  // F13 — task exec dropped the task/run/logged markers when the inner verb
  // returned a STRING envelope (snapshot/read). Assert they now attach.
  it('F13: task exec -- snapshot (string envelope) still carries the task markers', async () => {
    await run(['open', pageUrl, '--session', NAME2])
    await run(['task', 'start', 'snapshot the page', '--id', 'sn', '--namespace', NS])

    const exec = await run([
      'task',
      'exec',
      'sn',
      '--enable-actions',
      '--namespace',
      NS,
      '--session',
      NAME2,
      '--',
      'snapshot',
    ])
    expect(exec.env.success).toBe(true)
    const d = exec.env.data as { task?: string; run?: string; logged?: boolean; result?: unknown }
    // The markers ride along even though snapshot's inner data is a string…
    expect(d.task).toBe('sn')
    expect(d.run).toBe('run_1')
    expect(d.logged).toBe(true)
    // …and the original STRING payload is preserved verbatim under `result`
    // (snapshot emits a page-content boundary + a title line). Before the fix a
    // string envelope was returned bare and these markers were dropped entirely.
    expect(typeof d.result).toBe('string')
    expect(String(d.result)).toContain('page-content')
    expect(String(d.result)).toContain('title:')

    // The exec was recorded to the action_log too.
    const logPath = path.join(
      os.homedir(),
      '.silver',
      sanitizeNamespace(NS),
      'tasks',
      'sn',
      'run_1',
      'action_log.jsonl',
    )
    const jsonl = await fs.readFile(logPath, 'utf8')
    const execLine = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((r) => r.event?.kind === 'exec')
    expect(execLine).toBeDefined()
    expect(execLine.event.command).toEqual(['snapshot'])
    expect(execLine.event.success).toBe(true)
  })
})
