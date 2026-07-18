import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { closeSession, sanitizeNamespace } from '../../src/core/session.js'

// The keyless completion gate: `task criteria` pre-commits grounded `expect`
// predicates; `task done` re-runs each LIVE and REFUSES unless every one passes.
// This proves the structural-honesty property — a claimed completion the grounded
// page state does not support cannot pass.
const NS = `silver-vgate-${process.pid}-${Date.now()}`
const SESSION = 'vgate'

// A "success" page: a confirmation title/text and exactly three `.item` rows, so
// url-matches / text-visible / count can all be committed as grounded criteria.
const SUCCESS_PAGE = `<!doctype html>
<html><head><title>Checkout complete</title></head><body>
  <h1>Order confirmed</h1>
  <ul><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>
</body></html>`

let server: Server
let successUrl: string

async function data(id: string, args: string[]): Promise<Record<string, unknown>> {
  const r = await run([...args, '--namespace', NS])
  return (r.env.data ?? {}) as Record<string, unknown>
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(SUCCESS_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  successUrl = `http://localhost:${port}/success`
})

afterAll(async () => {
  try {
    await closeSession(SESSION)
  } catch {
    /* ignore */
  }
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(NS)), { recursive: true, force: true }).catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('task completion gate — grounded, keyless, un-gameable', () => {
  it('done REFUSES until every pre-committed grounded criterion passes; then confirms', async () => {
    await run(['task', 'start', 'complete a checkout', '--id', 'g1', '--namespace', NS])

    // No criteria yet → the gate refuses to run (a gate needs a pre-committed yardstick).
    const noCriteria = await run(['task', 'done', 'g1', '--session', SESSION, '--namespace', NS])
    expect(noCriteria.env.success).toBe(false)
    expect(noCriteria.env.error).toContain('no acceptance criteria')

    // Commit three grounded criteria + one that the page will NOT satisfy.
    await run(['task', 'criteria', 'g1', 'url-matches', '*/success', '--namespace', NS])
    await run(['task', 'criteria', 'g1', 'text-visible', 'Order confirmed', '--namespace', NS])
    await run(['task', 'criteria', 'g1', '.item', 'count', '3', '--namespace', NS])
    const withUnmet = await run(['task', 'criteria', 'g1', 'text-visible', 'Refund issued', '--namespace', NS])
    expect((withUnmet.env.data as { count: number }).count).toBe(4)

    // Drive to the success page.
    await run(['open', successUrl, '--session', SESSION, '--namespace', NS])

    // done must REFUSE — the 4th criterion ('Refund issued') is not grounded on the page.
    const refused = await run(['task', 'done', 'g1', '--session', SESSION, '--namespace', NS])
    expect(refused.env.success).toBe(false)
    const rd = refused.env.data as {
      done: boolean
      unmet: string[]
      criteria: Array<{ criterion: string; matched: boolean; observed: string }>
    }
    expect(rd.done).toBe(false)
    expect(rd.unmet).toContain('text-visible Refund issued')
    // The FAILING row still carries its grounded observed (the actual-vs-expected the
    // host needs to fix the page) — not only passing rows. A failed text-visible
    // observes "false"; the passing url row observes the real URL.
    const refundRow = rd.criteria.find((c) => c.criterion === 'text-visible Refund issued')
    expect(refundRow?.matched).toBe(false)
    expect(refundRow?.observed).toBe('false')
    const urlRow = rd.criteria.find((c) => c.criterion === 'url-matches */success')
    expect(urlRow?.observed).toContain('/success')
    // ...and it must NOT have wrongly failed the genuinely-satisfied ones.
    expect(rd.unmet).not.toContain('url-matches */success')
    expect(rd.unmet).not.toContain('.item count 3')
  })

  it('done PASSES only when the page genuinely satisfies every grounded criterion', async () => {
    await run(['task', 'start', 'complete a checkout (met)', '--id', 'g2', '--namespace', NS])
    await run(['task', 'criteria', 'g2', 'url-matches', '*/success', '--namespace', NS])
    await run(['task', 'criteria', 'g2', 'text-visible', 'Order confirmed', '--namespace', NS])
    await run(['task', 'criteria', 'g2', '.item', 'count', '3', '--namespace', NS])
    await run(['open', successUrl, '--session', SESSION, '--namespace', NS])

    // verify (dry-run) reports all pass but does not mark done.
    const verified = await run(['task', 'verify', 'g2', '--session', SESSION, '--namespace', NS])
    expect(verified.env.success).toBe(true)
    expect((verified.env.data as { allPassed: boolean }).allPassed).toBe(true)
    const statusBefore = await data('g2', ['task', 'status', 'g2'])
    expect(statusBefore.done).toBe(false)

    // done confirms completion and persists it.
    const done = await run(['task', 'done', 'g2', '--session', SESSION, '--namespace', NS])
    expect(done.env.success).toBe(true)
    const dd = done.env.data as { done: boolean; allPassed: boolean; verifiedAt: string }
    expect(dd.done).toBe(true)
    expect(dd.allPassed).toBe(true)
    expect(typeof dd.verifiedAt).toBe('string')

    const statusAfter = await data('g2', ['task', 'status', 'g2'])
    expect(statusAfter.done).toBe(true)
    expect((statusAfter.criteria as { total: number }).total).toBe(3)
  })
})
