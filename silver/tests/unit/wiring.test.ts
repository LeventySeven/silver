import { describe, it, expect, beforeEach } from 'vitest'
import { run } from '../../src/cli.js'
import { parseFlags } from '../../src/core/flags.js'
import { setFetchEgressPolicy, currentFetchEgressPolicy } from '../../src/core/session.js'

// Regression tests for the v3 PARTIAL fixes: the S2 Fetch-layer egress policy and
// the E2 --profile flag were implemented as functions but NOT wired into the CLI
// flags path in production (the adversarial verifier's catch). These lock the wiring.

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
