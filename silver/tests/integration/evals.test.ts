import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace } from '../../src/core/session.js'
// The eval corpus + driver live in evals/ (a standalone, model-free harness). The
// metrics runner (evals/run.mjs) drives them via the built CLI; this test drives
// the SAME fixtures via src as a CI gate: passK must stay 1.0 (a perception /
// actuation regression that breaks a fixture fails here), and obs-token metrics
// must be emitted (the efficiency lever the harness exists to track).
import { startFixtureServer, runEval, FIXTURES } from '../../evals/harness.mjs'

const NS = `silver-evals-${process.pid}-${Date.now()}`
const SESSION = 'evaltest'
let server: ReturnType<typeof startFixtureServer>
let baseUrl: string

beforeAll(async () => {
  server = startFixtureServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await run(['close', '--all', '--namespace', NS]).catch(() => {})
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(NS)), { recursive: true, force: true }).catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('eval harness — keyless, model-free harness-quality gate', () => {
  it('the dumb driver completes every fixture (passK=1.0) and the gate scores it', async () => {
    const { results, metrics } = await runEval({
      runCmd: (argv: string[]) => run(argv),
      baseUrl,
      session: SESSION,
      namespace: NS,
    })
    // Every fixture must pass its GROUNDED completion criteria — a mechanical driver
    // + Silver's harness lands the fixed plan. A drop here is a real harness regression.
    const failed = results.filter((r) => !r.passed)
    expect(failed, JSON.stringify(failed)).toEqual([])
    expect(metrics.passK).toBe(1)
    expect(metrics.fixtures).toBe(FIXTURES.length)

    // The efficiency levers are measured (not zero/undefined) so a token regression
    // is observable run-over-run.
    expect(metrics.obsTokenMedian).toBeGreaterThan(0)
    expect(metrics.actsMedian).toBeGreaterThan(0)
  })
})
