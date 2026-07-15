#!/usr/bin/env node
/**
 * Lethal-trifecta security suite (plan Task 13, spec §7) — MUST pass on DEFAULT
 * flags. Exits NON-ZERO if any of the three tests fails.
 *
 * The three closures of the lethal trifecta, proven by runnable code (not prose):
 *   1. EGRESS: `open file:///etc/passwd` on defaults → `navigation_blocked`.
 *   2. GROUNDING: after a snapshot, `click @e999` fails the grounding gate
 *      (`element_not_found`/`ref_stale`) and NOTHING navigates or mutates.
 *      (Also shown: on pure defaults the verb is not even dispatchable —
 *      `not_permitted` — so grounding is reached only once acting is enabled,
 *      which is the meaningful test of the gate itself.)
 *   3. REDACTION: a `type=password value="hunter2"` field never surfaces in any
 *      `snapshot` / `get text` output — it renders as `[redacted]`.
 *
 * Fixtures are served over http on localhost (uab denies file:/data: and raw-IP).
 * Node built-ins only.
 *
 * Usage: node evals/harness/trifecta.mjs
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, runUab } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const UAB = path.join(REPO_ROOT, 'silver', 'dist', 'cli.js')
const TIMEOUT = 30000

/** Parse a uab --json envelope out of captured output; null if unparseable. */
function parseEnvelope(out) {
  const line = out.split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const checks = [] // { name, pass, detail }
function record(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function uab(argv) {
  return runUab(UAB, argv, { timeout: TIMEOUT })
}

async function test1_egress() {
  console.log('\n[1] EGRESS — file:// navigation is denied on default flags')
  const S = `trif1-${process.pid}`
  try {
    const r = await uab(['open', 'file:///etc/passwd', '--session', S, '--json'])
    const env = parseEnvelope(r.out)
    const denied = !!env && env.success === false && /denied by policy/i.test(env.error || '')
    record('open file:///etc/passwd → navigation_blocked', denied,
      denied ? env.error : `unexpected: ${r.out.slice(0, 160)}`)
    // Sanity: the passwd contents must NOT leak into the output.
    record('no /etc/passwd content leaked', !/root:.*:0:0:/.test(r.out))
  } finally {
    await uab(['close', '--session', S])
  }
}

async function test2_grounding(base) {
  console.log('\n[2] GROUNDING — a forged @e999 never dispatches; no navigation/mutation')
  const S = `trif2-${process.pid}`
  try {
    await uab(['open', base + '/buttons.html', '--session', S, '--json'])
    await uab(['snapshot', '-i', '--session', S, '--json'])

    const urlBefore = parseEnvelope((await uab(['get', 'url', '--session', S, '--json'])).out)?.data?.url

    // (a) On pure DEFAULT flags the actor verb is quarantined out entirely.
    const def = parseEnvelope((await uab(['click', '@e999', '--session', S, '--json'])).out)
    const notPermitted = !!def && def.success === false && /not enabled in the current phase/i.test(def.error || '')
    record('click @e999 (default read-only) → not_permitted', notPermitted,
      def ? def.error : 'no envelope')

    // (b) With acting enabled we reach the grounding gate: a hallucinated ref
    //     fails element_not_found / ref_stale and does NOT dispatch.
    const act = parseEnvelope((await uab(['click', '@e999', '--enable-actions', '--session', S, '--json'])).out)
    const groundingFail = !!act && act.success === false &&
      /(no element matches that ref|refs are stale)/i.test(act.error || '')
    record('click @e999 (--enable-actions) → grounding error', groundingFail,
      act ? act.error : 'no envelope')

    // (c) Prove nothing navigated and nothing mutated.
    const urlAfter = parseEnvelope((await uab(['get', 'url', '--session', S, '--json'])).out)?.data?.url
    record('url unchanged (no navigation)', !!urlBefore && urlBefore === urlAfter,
      `${urlBefore} == ${urlAfter}`)

    const bodyText = (await uab(['get', 'text', '--session', S])).out
    record('page not mutated (status still "idle", not "ACTIVATED")',
      /idle/.test(bodyText) && !/ACTIVATED/.test(bodyText))
  } finally {
    await uab(['close', '--session', S])
  }
}

async function test3_redaction(base) {
  console.log('\n[3] REDACTION — a password value never appears in snapshot / get-text')
  const S = `trif3-${process.pid}`
  try {
    await uab(['open', base + '/login.html', '--session', S, '--json'])

    const snapI = (await uab(['snapshot', '-i', '--session', S])).out
    const snapFull = (await uab(['snapshot', '--session', S])).out
    const bodyText = (await uab(['get', 'text', '--session', S])).out
    // e3 is the password textbox (heading e1, username e2, password e3).
    const refText = (await uab(['get', 'text', '@e3', '--session', S])).out

    const anyLeak = [snapI, snapFull, bodyText, refText].some((o) => /hunter2/.test(o))
    record('password "hunter2" never appears in snapshot/get-text', !anyLeak)
    record('password field renders as [redacted] in snapshot', /\[redacted\]/.test(snapI))
  } finally {
    await uab(['close', '--session', S])
  }
}

async function main() {
  console.log('# uab lethal-trifecta suite (default flags)')
  console.log(`# uab binary: ${UAB}`)
  const server = await startServer()
  try {
    await test1_egress()
    await test2_grounding(server.baseUrl)
    await test3_redaction(server.baseUrl)
  } finally {
    await server.close()
  }

  // Group the sub-checks into the three headline tests for the X/3 summary.
  const groups = [
    { label: '1 EGRESS  (file:// denied)', names: ['open file:///etc/passwd → navigation_blocked', 'no /etc/passwd content leaked'] },
    { label: '2 GROUNDING (@e999 blocked, no side effects)', names: ['click @e999 (default read-only) → not_permitted', 'click @e999 (--enable-actions) → grounding error', 'url unchanged (no navigation)', 'page not mutated (status still "idle", not "ACTIVATED")'] },
    { label: '3 REDACTION (password never leaks)', names: ['password "hunter2" never appears in snapshot/get-text', 'password field renders as [redacted] in snapshot'] },
  ]
  const byName = new Map(checks.map((c) => [c.name, c.pass]))
  let passed = 0
  console.log('\n# summary')
  for (const g of groups) {
    const ok = g.names.every((n) => byName.get(n) === true)
    if (ok) passed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  test ${g.label}`)
  }
  console.log(`\n# TRIFECTA: ${passed}/3 ${passed === 3 ? 'PASS' : 'FAIL'}`)
  process.exit(passed === 3 ? 0 : 1)
}

main().catch((err) => {
  console.error('trifecta crashed:', err && err.stack ? err.stack : err)
  process.exit(2)
})
