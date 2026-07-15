import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace } from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'

const NS = `task-${process.pid}-${Date.now()}`

function nsTasks(): string {
  return path.join(os.homedir(), '.silver', sanitizeNamespace(NS), 'tasks')
}
function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

afterAll(async () => {
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(NS)), {
    recursive: true,
    force: true,
  }).catch(() => {})
})

describe('silver task — Webwright keyless run-folder artifact', () => {
  it('start creates the run folder scaffold (plan.md + action_log + screenshots + checkpoint)', async () => {
    const started = await run(['task', 'start', 'book a flight to NYC', '--id', 't1', '--namespace', NS])
    expect(started.env.success).toBe(true)
    const d = data<{ id: string; run: string; dir: string; artifacts: string[] }>(started)
    expect(d.id).toBe('t1')
    expect(d.run).toBe('run_1')

    const runDir = path.join(nsTasks(), 't1', 'run_1')
    expect(existsSync(runDir)).toBe(true)
    expect(existsSync(path.join(runDir, 'plan.md'))).toBe(true)
    expect(existsSync(path.join(runDir, 'action_log.jsonl'))).toBe(true)
    expect(existsSync(path.join(runDir, 'screenshots'))).toBe(true)
    expect(existsSync(path.join(runDir, 'checkpoint.json'))).toBe(true)

    // plan.md is the Critical-Points checklist embedding the goal.
    const plan = await fs.readFile(path.join(runDir, 'plan.md'), 'utf8')
    expect(plan).toContain('Critical Points')
    expect(plan).toContain('book a flight to NYC')
    expect(plan).toMatch(/- \[ \] CP1:/)

    // checkpoint carries Aside's "Mistakes & Avoidance" field.
    const cp = JSON.parse(await fs.readFile(path.join(runDir, 'checkpoint.json'), 'utf8'))
    expect(cp).toHaveProperty('mistakesAndAvoidance')
    expect(Array.isArray(cp.mistakesAndAvoidance)).toBe(true)
    expect(cp.status).toBe('in_progress')
  })

  it('start again opens a NEW run folder (run_2), preserving the original goal', async () => {
    const again = await run(['task', 'start', 'ignored second goal', '--id', 't1', '--namespace', NS])
    expect(again.env.success).toBe(true)
    expect(data<{ run: string }>(again).run).toBe('run_2')
    expect(existsSync(path.join(nsTasks(), 't1', 'run_2'))).toBe(true)
    // meta.json keeps the FIRST goal.
    const meta = JSON.parse(await fs.readFile(path.join(nsTasks(), 't1', 'meta.json'), 'utf8'))
    expect(meta.goal).toBe('book a flight to NYC')
  })

  it('log appends events to the latest run action_log; status reflects the count', async () => {
    const logged = await run(['task', 'log', 't1', '{"kind":"nav","url":"x"}', '--namespace', NS])
    expect(logged.env.success).toBe(true)
    await run(['task', 'log', 't1', 'a plain non-json note', '--namespace', NS])

    const jsonl = await fs.readFile(path.join(nsTasks(), 't1', 'run_2', 'action_log.jsonl'), 'utf8')
    const lines = jsonl.trim().split('\n')
    // run_start (from start) + 2 logs = 3 lines.
    expect(lines.length).toBe(3)
    const last = JSON.parse(lines[lines.length - 1])
    expect(last.event.text).toContain('plain non-json note')

    const status = await run(['task', 'status', 't1', '--namespace', NS])
    const s = data<{ latestRun: string; plan: { total: number; remaining: number }; logEntries: number }>(status)
    expect(s.latestRun).toBe('run_2')
    expect(s.logEntries).toBe(3)
    expect(s.plan.total).toBe(2) // CP1 + CP2 from the template
  })

  it('checkpoint records a note; screenshot degrades to null with no live browser', async () => {
    const cp = await run(['task', 'checkpoint', 't1', '--note', 'reached the results page', '--namespace', NS])
    expect(cp.env.success).toBe(true)
    const c = data<{ checkpointed: boolean; screenshot: string | null; note: string | null }>(cp)
    expect(c.checkpointed).toBe(true)
    expect(c.screenshot).toBeNull() // no session connected in this unit test
    expect(c.note).toContain('reached the results page')
  })

  it('resume returns the remaining (unchecked) plan + recent log so the host can continue', async () => {
    const resumed = await run(['task', 'resume', 't1', '--namespace', NS])
    expect(resumed.env.success).toBe(true)
    const r = data<{ run: string; remainingPlan: string[]; recentLog: unknown[] }>(resumed)
    expect(r.run).toBe('run_2')
    // Two unchecked CPs remain (template CP1/CP2).
    expect(r.remainingPlan.length).toBe(2)
    expect(r.recentLog.length).toBeGreaterThan(0)
  })

  it('list enumerates the task with its latest run', async () => {
    const listed = await run(['task', 'list', '--namespace', NS])
    const l = data<{ tasks: Array<{ id: string; latestRun: string }> }>(listed)
    const t1 = l.tasks.find((t) => t.id === 't1')
    expect(t1?.latestRun).toBe('run_2')
  })

  it('exec is registry-read-only at the verb level but actor-gated in-handler (needs --enable-actions)', async () => {
    const denied = await run(['task', 'exec', 't1', '--namespace', NS, '--', 'version'])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)
  })

  it('exec re-dispatches a silver command AND auto-logs it to the action_log', async () => {
    const before = (await fs.readFile(path.join(nsTasks(), 't1', 'run_2', 'action_log.jsonl'), 'utf8'))
      .trim()
      .split('\n').length
    const exec = await run(['task', 'exec', 't1', '--enable-actions', '--namespace', NS, '--', 'version'])
    expect(exec.env.success).toBe(true)
    const d = data<{ task: string; logged: boolean; version?: string }>(exec)
    expect(d.task).toBe('t1')
    expect(d.logged).toBe(true)

    const after = (await fs.readFile(path.join(nsTasks(), 't1', 'run_2', 'action_log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(after.length).toBe(before + 1)
    const execEntry = JSON.parse(after[after.length - 1])
    expect(execEntry.event.kind).toBe('exec')
    expect(execEntry.event.command).toEqual(['version'])
    expect(execEntry.event.success).toBe(true)
  })

  it('compile emits a runnable .sh with a # Parameters header from logged commands (F1)', async () => {
    // Log a couple of exec-shaped commands so compile has verbatim invocations.
    await run([
      'task',
      'log',
      't1',
      JSON.stringify({ kind: 'exec', command: ['open', 'https://example.com'] }),
      '--namespace',
      NS,
    ])
    await run([
      'task',
      'log',
      't1',
      JSON.stringify({ kind: 'exec', command: ['fill', 'e5', 'hello world', '--force'] }),
      '--namespace',
      NS,
    ])

    const compiled = await run(['task', 'compile', 't1', '--namespace', NS])
    expect(compiled.env.success).toBe(true)
    const c = data<{
      script: string
      scriptName: string
      commands: number
      parameters: Array<{ name: string; default: string }>
    }>(compiled)
    expect(c.scriptName).toBe('compiled.sh')
    // Every logged silver command is compiled (this run also has a prior `exec
    // version`), so at least the two we just added are present.
    expect(c.commands).toBeGreaterThanOrEqual(2)

    const sh = await fs.readFile(c.script, 'utf8')
    // A runnable script with a parameters header.
    expect(sh.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(sh).toContain('set -euo pipefail')
    expect(sh).toContain('# Parameters')
    // literals promoted to override-able params whose defaults reproduce the task
    expect(sh).toContain('https://example.com')
    expect(sh).toContain('hello world')
    expect(sh).toMatch(/silver 'open' "\$OPEN_\d+_1"/)
    expect(sh).toMatch(/silver 'fill' "\$FILL_\d+_1" "\$FILL_\d+_2" '--force'/)
    // the flag stayed literal (not parameterized)
    expect(c.parameters.some((p) => p.default === '--force')).toBe(false)
    expect(c.parameters.some((p) => p.default === 'https://example.com')).toBe(true)
  })

  it('compile fails cleanly for a task with no run', async () => {
    const bad = await run(['task', 'compile', 'never-started', '--namespace', NS])
    expect(bad.env.success).toBe(false)
  })

  it('rejects an invalid task id (path traversal) without echoing it', async () => {
    const bad = await run(['task', 'start', 'x', '--id', '../escape', '--namespace', NS])
    expect(bad.env.success).toBe(false)
    expect(bad.env.error).not.toContain('escape') // no-leak: the id is never echoed
  })

  // -------------------------------------------------------------------------
  // T1 — variable auto-detection in `task compile`.
  // -------------------------------------------------------------------------
  it('T1: a filled search term compiles to a script with a named --flag for it', async () => {
    await run(['task', 'start', 'search a shop', '--id', 'vt', '--namespace', NS])
    // A fill whose DOM hint (role:searchbox) marks the value as a search term.
    await run([
      'task',
      'log',
      'vt',
      JSON.stringify({
        kind: 'exec',
        command: ['fill', 'e3', 'wireless headphones'],
        meta: { role: 'searchbox', name: 'Search products' },
      }),
      '--namespace',
      NS,
    ])

    const compiled = await run(['task', 'compile', 'vt', '--namespace', NS])
    expect(compiled.env.success).toBe(true)
    const c = data<{
      script: string
      parameters: Array<{ name: string; default: string; detected?: string; secret?: boolean }>
      variables: Array<{ name: string; type: string }>
    }>(compiled)

    // The search term is promoted to a semantically NAMED parameter, not an
    // opaque positional slot — its default reproduces the run.
    const term = c.parameters.find((p) => p.default === 'wireless headphones')
    expect(term).toBeDefined()
    expect(term?.name).toBe('SEARCH_TERM')
    expect(term?.detected).toBe('search_term')
    expect(c.variables.some((v) => v.type === 'search_term')).toBe(true)

    const sh = await fs.readFile(c.script, 'utf8')
    expect(sh).toContain('# Parameters')
    expect(sh).toContain('SEARCH_TERM="${SEARCH_TERM:-wireless headphones}"')
    expect(sh).toMatch(/silver 'fill' "\$FILL_\d+_1" "\$SEARCH_TERM"/)
  })

  it('T1: value-shape detection names an email/url and never bakes a credential', async () => {
    await run(['task', 'start', 'sign up', '--id', 'vt2', '--namespace', NS])
    // Email by value-shape (no hint), password flagged secret by DOM hint.
    await run([
      'task',
      'log',
      'vt2',
      JSON.stringify({ kind: 'exec', command: ['fill', 'e1', 'ops@skale.solutions'] }),
      '--namespace',
      NS,
    ])
    await run([
      'task',
      'log',
      'vt2',
      JSON.stringify({
        kind: 'exec',
        command: ['fill', 'e2', 'hunter2secret'],
        meta: { inputType: 'password', name: 'Password' },
      }),
      '--namespace',
      NS,
    ])

    const compiled = await run(['task', 'compile', 'vt2', '--namespace', NS])
    const c = data<{
      script: string
      parameters: Array<{ name: string; default: string; detected?: string; secret?: boolean }>
    }>(compiled)

    const email = c.parameters.find((p) => p.detected === 'email')
    expect(email?.name).toBe('EMAIL')
    expect(email?.default).toBe('ops@skale.solutions')

    // The credential is marked secret, its value REDACTED from the parameters,
    // and required-at-runtime (never baked) in the emitted script.
    const secret = c.parameters.find((p) => p.secret)
    expect(secret).toBeDefined()
    expect(secret?.default).toBe('<secret>')
    const sh = await fs.readFile(c.script, 'utf8')
    expect(sh).not.toContain('hunter2secret')
    expect(sh).toContain(`${secret?.name}="\${${secret?.name}:?`)
  })

  // -------------------------------------------------------------------------
  // T2 — run manifest.
  // -------------------------------------------------------------------------
  it('T2: a run produces a manifest.json with the expected fields', async () => {
    await run(['task', 'start', 'index me', '--id', 'mf', '--namespace', NS])
    const manifestPath = path.join(nsTasks(), 'mf', 'run_1', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    expect(m.taskId).toBe('mf')
    expect(m.run).toBe('run_1')
    expect(m.goal).toBe('index me')
    expect(typeof m.silverVersion).toBe('string')
    expect(m.silverVersion.length).toBeGreaterThan(0)
    expect(typeof m.startedAt).toBe('string')
    expect(m).toHaveProperty('endedAt')
    expect(m.verbCount).toBe(0)
    expect(m.outcome).toBe('in_progress')
    expect(Array.isArray(m.checkpoints)).toBe(true)
    expect(m).toHaveProperty('compiledScript')

    // Logging a verb bumps the manifest verb count; compile records the script.
    await run([
      'task',
      'log',
      'mf',
      JSON.stringify({ kind: 'exec', command: ['open', 'https://example.com'] }),
      '--namespace',
      NS,
    ])
    const compiled = await run(['task', 'compile', 'mf', '--namespace', NS])
    const cscript = data<{ script: string; replayCache: string }>(compiled).script
    const m2 = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    expect(m2.verbCount).toBe(1)
    expect(m2.compiledScript).toBe(cscript)
    expect(typeof m2.replayCache).toBe('string')

    // status surfaces the manifest for tooling.
    const status = await run(['task', 'status', 'mf', '--namespace', NS])
    const s = data<{ manifest: { taskId: string; verbCount: number } }>(status)
    expect(s.manifest.taskId).toBe('mf')
    expect(s.manifest.verbCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // T3 — verb-sequence DOM-hash replay cache.
  // -------------------------------------------------------------------------
  it('T3: matching DOM-hash reuses the cached step; a mismatch triggers fallback', async () => {
    await run(['task', 'start', 'replay me', '--id', 'rp', '--namespace', NS])
    // Two recorded verbs, each carrying its own DOM-hash + resolved ref.
    await run([
      'task',
      'log',
      'rp',
      JSON.stringify({ kind: 'exec', command: ['click', 'e5'], ref: 'e5', domHash: 'HASH_A' }),
      '--namespace',
      NS,
    ])
    await run([
      'task',
      'log',
      'rp',
      JSON.stringify({ kind: 'exec', command: ['click', 'e9'], ref: 'e9', domHash: 'HASH_B' }),
      '--namespace',
      NS,
    ])

    // Build the cache (compile persists replay_cache.json alongside the script).
    await run(['task', 'compile', 'rp', '--namespace', NS])
    expect(existsSync(path.join(nsTasks(), 'rp', 'run_1', 'replay_cache.json'))).toBe(true)

    // Replay with the current DOM-hash = HASH_A: step 0 is a known-good reuse,
    // step 1 (HASH_B) mismatches and must fall back to a fresh snapshot.
    const replayed = await run(['task', 'replay', 'rp', 'HASH_A', '--namespace', NS])
    expect(replayed.env.success).toBe(true)
    const r = data<{
      total: number
      reused: number
      fallback: number
      steps: Array<{ index: number; ref: string | null; reuse: boolean; reason: string }>
    }>(replayed)
    expect(r.total).toBe(2)
    expect(r.reused).toBe(1)
    expect(r.fallback).toBe(1)

    const hit = r.steps[0]
    expect(hit.reuse).toBe(true)
    expect(hit.ref).toBe('e5') // known-good ref reused with NO host round-trip
    expect(hit.reason).toBe('dom_hash_match')

    const miss = r.steps[1]
    expect(miss.reuse).toBe(false)
    expect(miss.ref).toBeNull()
    expect(miss.reason).toBe('dom_hash_mismatch')
  })
})
