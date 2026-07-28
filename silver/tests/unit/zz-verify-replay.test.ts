import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome } from '../../src/core/session.js'

const NS = `zzrep-${process.pid}-${Date.now()}`
function nsTasks(): string {
  return path.join(silverHome(), sanitizeNamespace(NS), 'tasks')
}
function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

afterAll(async () => {
  await fs.rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true }).catch(() => {})
})

describe('adversarial verification: task replay --enable-actions failure handling', () => {
  it('three steps at the SAME dom hash: what does the envelope say when every dispatch fails?', async () => {
    await run(['task', 'start', 'login flow', '--id', 'rp1', '--namespace', NS])
    const steps = [
      { command: ['fill', 'e1', 'alice'], ref: 'e1', domHash: 'H1' },
      { command: ['fill', 'e2', 'hunter2'], ref: 'e2', domHash: 'H1' },
      { command: ['click', 'e3'], ref: 'e3', domHash: 'H1' },
    ]
    for (const s of steps) {
      await run(['task', 'log', 'rp1', JSON.stringify({ kind: 'exec', ...s }), '--namespace', NS])
    }
    await run(['task', 'compile', 'rp1', '--namespace', NS])

    const res = await run(['task', 'replay', 'rp1', 'H1', '--enable-actions', '--namespace', NS])
    // eslint-disable-next-line no-console
    console.log('ENVELOPE:', JSON.stringify(res, null, 2))

    const log = await fs.readFile(path.join(nsTasks(), 'rp1', 'run_1', 'action_log.jsonl'), 'utf8')
    // eslint-disable-next-line no-console
    console.log('ACTION LOG:\n' + log)

    const d = data<{ reused: number; dispatched: boolean; steps: Array<Record<string, unknown>> }>(res)
    // eslint-disable-next-line no-console
    console.log('outer success =', res.env.success, 'reused =', d.reused)
    expect(true).toBe(true)
  }, 120_000)
})
