import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace, silverHome } from '../../src/core/session.js'

const NS = `vfy-${process.pid}-${Date.now()}`
function nsTasks(): string {
  return path.join(silverHome(), sanitizeNamespace(NS), 'tasks')
}
function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

afterAll(async () => {
  await fs.rm(path.join(silverHome(), sanitizeNamespace(NS)), { recursive: true, force: true }).catch(() => {})
})

describe('VERIFY: compile of FAILED exec commands', () => {
  it('real `task exec` failures land in compiled.sh + replay cache', async () => {
    await run(['task', 'start', 'verify me', '--id', 'vf', '--namespace', NS])

    // Two REAL `task exec` dispatches that FAIL (no browser/session open).
    const e1 = await run([
      'task', 'exec', 'vf', '--enable-actions', '--namespace', NS,
      '--', 'fill', 'e5', 'hello world',
    ])
    const e2 = await run([
      'task', 'exec', 'vf', '--enable-actions', '--namespace', NS,
      '--', 'click', 'e9',
    ])
    console.log('exec1 =>', JSON.stringify(e1.env))
    console.log('exec2 =>', JSON.stringify(e2.env))
    expect(e1.env.success).toBe(false)
    expect(e2.env.success).toBe(false)

    const logPath = path.join(nsTasks(), 'vf', 'run_1', 'action_log.jsonl')
    const raw = await fs.readFile(logPath, 'utf8')
    console.log('--- action_log.jsonl ---\n' + raw)

    const compiled = await run(['task', 'compile', 'vf', '--namespace', NS])
    const c = data<{ script: string; commands: number; parameters: unknown[] }>(compiled)
    console.log('compile envelope =>', JSON.stringify(compiled.env, null, 2))
    const sh = await fs.readFile(c.script, 'utf8')
    console.log('--- compiled.sh ---\n' + sh)

    const cache = await fs.readFile(path.join(nsTasks(), 'vf', 'run_1', 'replay_cache.json'), 'utf8')
    console.log('--- replay_cache.json ---\n' + cache)
  })
})
