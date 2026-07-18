import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/cli.js'
import {
  closeSession,
  loadRefMap,
  setFetchEgressPolicy,
  currentFetchEgressPolicy,
} from '../../src/core/session.js'
import { ERRORS } from '../../src/core/errors.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Integration tests for the v3 HUB WIRING (handlers/cli/flags/registry): the
// sibling modules (config, policy, suggest, skillmatch, retry, reliability
// helpers) exist and are unit-tested; these lock that the dispatch hub actually
// CALLS them on the real command path.

function firstRefWithRole(map: RefMap, role: string): string {
  for (const [ref, entry] of Object.entries(map.entries)) {
    if (entry.role === role) return ref
  }
  throw new Error(`no ref with role ${role} in refmap`)
}

// ---------------------------------------------------------------------------
// E3: config merge changes a flag (env layer) + --no-config opts out.
// ---------------------------------------------------------------------------
describe('E3: config merge is wired into run() before dispatch', () => {
  beforeEach(() => setFetchEgressPolicy({ allowFile: false, allowedDomains: [] }))
  afterEach(() => {
    delete process.env.SILVER_ALLOWED_DOMAINS
    setFetchEgressPolicy({ allowFile: false, allowedDomains: [] })
  })

  it('an env-layer config value flows through mergeConfig into the effective flags', async () => {
    process.env.SILVER_ALLOWED_DOMAINS = 'config-only.example'
    // `version` is a meta verb (no browser); run() merges config then applies the
    // global egress policy BEFORE dispatch — so this proves the production wiring.
    await run(['version'])
    expect(currentFetchEgressPolicy().allowedDomains).toContain('config-only.example')
  })

  it('allowedDomains is TIGHTEN-ONLY: a config layer cannot WIDEN the CLI fence', async () => {
    // BUG #3: a lower-trust config/env allowlist must never ADD egress hosts past
    // the operator's --allowed-domains. Disjoint config → rejected, CLI stands.
    process.env.SILVER_ALLOWED_DOMAINS = 'config-only.example'
    await run(['--allowed-domains', 'cli-only.example', 'version'])
    const pol = currentFetchEgressPolicy()
    expect(pol.allowedDomains).toEqual(['cli-only.example'])
    expect(pol.allowedDomains).not.toContain('config-only.example')
  })

  it('--no-config opts out of the merge entirely', async () => {
    process.env.SILVER_ALLOWED_DOMAINS = 'config-only.example'
    await run(['--no-config', 'version'])
    expect(currentFetchEgressPolicy().allowedDomains).not.toContain('config-only.example')
  })
})

// ---------------------------------------------------------------------------
// D5: an unknown (mistyped) verb suggests the closest real verb, sanitized.
// ---------------------------------------------------------------------------
describe('D5: unknown-verb typo suggestion is wired into the dispatch gate', () => {
  it('suggests `click` for `clik` (a bare-token typo)', async () => {
    const res = await run(['clik', '@e5'])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toContain('did you mean')
    expect(res.env.error).toContain('click')
    // The sanitized token is echoed, never the selector value.
    expect(res.env.error).toContain('clik')
    expect(res.env.error).not.toContain('@e5')
  })

  it('a REAL actor verb missing its grant is NOT a typo — plain not_permitted', async () => {
    const res = await run(['click', '@e5'])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toBe(ERRORS.not_permitted.message)
  })

  it('a truly-unknown verb (no close typo) is reported as UNKNOWN, not a permission dead-end', async () => {
    // `run` is edit-distance-far from every real verb → no suggestion. Before the
    // fix this fell through to not_permitted, so retrying with --enable-actions hit
    // the identical error (a dead-end loop). Now it names the real problem.
    const res = await run(['run'])
    expect(res.env.success).toBe(false)
    expect(res.env.error).toContain('unknown verb')
    expect(res.env.error).toContain('silver help')
    expect(res.env.error).not.toBe(ERRORS.not_permitted.message)
    // ...and adding the grant does NOT change it (it's not a permission problem).
    const withGrant = await run(['run', '--enable-actions'])
    expect(withGrant.env.error).toContain('unknown verb')
  })

  it('a URL passed as a verb never leaks past the sanitized prefix', async () => {
    const res = await run(['https://evil.example/pay?token=secret'])
    // Either no suggestion (not a bare token) or a suggestion that never contains
    // the unsafe tail — the token past the first unsafe char can never appear.
    expect(res.env.error ?? '').not.toContain('secret')
    expect(res.env.error ?? '').not.toContain('evil.example')
  })
})

// ---------------------------------------------------------------------------
// K1: `skills resolve` runs the auto-injection matcher over on-disk descriptors.
// ---------------------------------------------------------------------------
describe('K1: skills resolve is wired into handleSkill', () => {
  it('returns the always-on core skill for any url (progressive disclosure)', async () => {
    const res = await run(['skills', 'resolve', '--url', 'https://example.com'])
    expect(res.env.success).toBe(true)
    const d = res.env.data as { matched: number; matches: { name: string; reason: string }[] }
    expect(Array.isArray(d.matches)).toBe(true)
    // The non-site-specific core SKILL is always applicable.
    expect(d.matches.some((m) => m.reason === 'always')).toBe(true)
  })

  it('`skill resolve` (singular) routes to the same matcher', async () => {
    const res = await run(['skill', 'resolve', '--url', 'https://example.com'])
    expect(res.env.success).toBe(true)
    expect(res.env.data).toHaveProperty('matches')
  })
})

// ---------------------------------------------------------------------------
// K4: structured doctor report shape (a focused shape-only assertion).
// ---------------------------------------------------------------------------
describe('K4: doctor returns the structured report shape', () => {
  it('has checks[] with named checks incl. the new session_locks / cdp_reachable', async () => {
    const res = await run(['doctor'])
    expect(res.env.success).toBe(true)
    const d = res.env.data as {
      checks: { name: string; status: string; message: string; fix?: string }[]
      verdict: string
      next: string
      passed: number
      total: number
    }
    expect(Array.isArray(d.checks)).toBe(true)
    expect(typeof d.verdict).toBe('string')
    expect(typeof d.next).toBe('string')
    expect(typeof d.passed).toBe('number')
    expect(d.total).toBe(d.checks.length)
    const names = d.checks.map((c) => c.name)
    expect(names).toContain('playwright')
    expect(names).toContain('chromium')
    expect(names).toContain('browser_launch')
    expect(names).toContain('session_locks')
    expect(names).toContain('cdp_reachable')
  })
})

// ---------------------------------------------------------------------------
// S5 (action-policy deny) + R5a (page_empty): the real-Chromium hub wiring.
// ---------------------------------------------------------------------------
describe('S5 + R5a hub wiring (real Chromium via run())', () => {
  const NAME = `silver-v3wire-${process.pid}-${Date.now()}`
  let server: Server
  let pageUrl: string
  let emptyUrl: string
  let tmp: string
  let denyClickPolicy: string

  const PAGE = `<!doctype html>
<html><body>
  <h1>v3 wiring page</h1>
  <button id="go" onclick="void 0">Go</button>
</body></html>`
  const EMPTY = `<!doctype html><html><head></head><body></body></html>`

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end((req.url ?? '').startsWith('/empty') ? EMPTY : PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    pageUrl = `http://localhost:${port}/`
    emptyUrl = `http://localhost:${port}/empty`
    tmp = mkdtempSync(join(tmpdir(), 'silver-v3-policy-'))
    denyClickPolicy = join(tmp, 'deny-click.json')
    writeFileSync(denyClickPolicy, JSON.stringify({ default: 'allow', deny: ['click'] }), 'utf8')
  })

  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
    rmSync(tmp, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('S5: an action-policy `deny` hard-blocks the verb even with --enable-actions', async () => {
    await run(['open', pageUrl, '--session', NAME])
    await run(['snapshot', '-i', '--session', NAME])
    const map = await loadRefMap(NAME)
    const btn = firstRefWithRole(map as RefMap, 'button')

    // With the deny policy: click is refused (not_permitted), regardless of grant.
    const denied = await run([
      'click',
      `@${btn}`,
      '--enable-actions',
      '--action-policy',
      denyClickPolicy,
      '--session',
      NAME,
    ])
    expect(denied.env.success).toBe(false)
    expect(denied.env.error).toBe(ERRORS.not_permitted.message)

    // Without the policy: the same click proceeds (control — the ref is still live).
    const ok = await run(['click', `@${btn}`, '--enable-actions', '--session', NAME])
    expect(ok.env.success).toBe(true)
  })

  it('R5a: opening a blank-shell page surfaces page_empty', async () => {
    const res = await run(['open', emptyUrl, '--session', NAME])
    expect(res.env.success).toBe(true)
    const d = res.env.data as { page_empty?: boolean }
    expect(d.page_empty).toBe(true)
    expect(res.env.warning ?? '').toContain('page_empty')
  })
})
