import { describe, it, expect, beforeEach } from 'vitest'
import { run } from '../../src/cli.js'
import { parseFlags } from '../../src/core/flags.js'
import { setFetchEgressPolicy, currentFetchEgressPolicy } from '../../src/core/session.js'

// Regression tests for the v3 PARTIAL fixes: the S2 Fetch-layer egress policy and
// the E2 --profile flag were implemented as functions but NOT wired into the CLI
// flags path in production (the adversarial verifier's catch). These lock the wiring.

describe('doctor --trifecta: keyless lethal-trifecta self-report (agent-security)', () => {
  it('flags HIGH-RISK only when the unscoped secret is ALLOWED (opt-in) + open egress; leaks no value', async () => {
    const r = await run([
      'doctor', '--trifecta', '--enable-actions',
      '--secret', 'GH_TOKEN=ghp_TOPSECRET', '--allow-unscoped-secrets',
    ])
    const d = r.env.data as {
      legsArmed: number
      lethalTrifectaRisk: boolean
      trifecta: { actor: { armed: boolean }; exfil: { open: boolean }; secret: { unscopedActiveCount: number } }
    }
    expect(d.trifecta.actor.armed).toBe(true)
    expect(d.trifecta.exfil.open).toBe(true)
    expect(d.trifecta.secret.unscopedActiveCount).toBe(1)
    expect(d.legsArmed).toBe(3)
    expect(d.lethalTrifectaRisk).toBe(true)
    // The report is keyless observability — a secret VALUE must never appear in it.
    expect(JSON.stringify(d)).not.toContain('ghp_TOPSECRET')
  })

  it('the SAME unscoped secret WITHOUT the opt-in is fail-closed (blocked) → NOT high risk', async () => {
    const r = await run(['doctor', '--trifecta', '--enable-actions', '--secret', 'GH_TOKEN=ghp_x'])
    const d = r.env.data as {
      lethalTrifectaRisk: boolean
      trifecta: { secret: { unscopedActiveCount: number; unscopedBlockedCount: number } }
    }
    expect(d.trifecta.secret.unscopedActiveCount).toBe(0)
    expect(d.trifecta.secret.unscopedBlockedCount).toBe(1)
    expect(d.lethalTrifectaRisk).toBe(false) // fail-closed neutralizes the exfil leg
  })

  it('a scoped secret + an egress allowlist is NOT flagged as a trifecta', async () => {
    const r = await run(['doctor', '--trifecta', '--secret', 'TOK@bank.com=x', '--allowed-domains', 'bank.com'])
    const d = r.env.data as {
      lethalTrifectaRisk: boolean
      trifecta: { exfil: { open: boolean }; secret: { unscopedActiveCount: number } }
    }
    expect(d.trifecta.exfil.open).toBe(false)
    expect(d.trifecta.secret.unscopedActiveCount).toBe(0)
    expect(d.lethalTrifectaRisk).toBe(false)
  })

  it('the read-only default is disarmed on the actor leg', async () => {
    const r = await run(['doctor', '--trifecta'])
    const d = r.env.data as { trifecta: { actor: { armed: boolean } }; lethalTrifectaRisk: boolean }
    expect(d.trifecta.actor.armed).toBe(false)
    expect(d.lethalTrifectaRisk).toBe(false)
  })
})

describe('S2: --allowed-domains reaches the Fetch-layer egress policy via the CLI', () => {
  beforeEach(() => setFetchEgressPolicy({ allowFile: false, allowedDomains: [] }))

  it('run() applies the operator allowlist to the subresource egress policy', async () => {
    // `version` is a meta verb (no browser), but run() applies the global egress
    // policy BEFORE the version branch — so this proves the production wiring.
    await run(['--allowed-domains', 'example.com,foo.test', 'version'])
    const pol = currentFetchEgressPolicy()
    expect(pol.allowedDomains).toContain('example.com')
    expect(pol.allowedDomains).toContain('foo.test')
  })

  it('run() propagates --allow-file-access into the subresource policy', async () => {
    await run(['--allow-file-access', 'version'])
    expect(currentFetchEgressPolicy().allowFile).toBe(true)
  })

  it('default (no allowlist flag) leaves the policy empty (default-deny still applies to file/metadata)', async () => {
    await run(['version'])
    expect(currentFetchEgressPolicy().allowedDomains).toEqual([])
  })
})

describe('E2: --profile is parsed and thread-able into an owned launch', () => {
  it('parseFlags captures --profile as a string flag', () => {
    const f = parseFlags(['--profile', '/tmp/my-chrome-profile', '--session', 's', 'open', 'https://x.test'])
    expect(f.profile).toBe('/tmp/my-chrome-profile')
  })

  it('--profile is absent by default', () => {
    const f = parseFlags(['open', 'https://x.test'])
    expect(f.profile).toBeUndefined()
  })
})
