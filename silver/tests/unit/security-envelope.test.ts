import { describe, it, expect } from 'vitest'
import { parseFlags, securityEnvelopeArgv } from '../../src/core/flags.js'

/**
 * THE SECURITY ENVELOPE must survive a re-dispatch.
 *
 * `batch`, `task exec` and `task replay` run other silver commands by re-entering
 * `run()` with a fresh argv. The inner command is parsed FROM SCRATCH, so a flag
 * left behind is not inherited — it is absent. That failed in the dangerous
 * direction: `task exec … --allowed-domains example.com` produced an inner
 * command with no allowlist at all, i.e. egress unrestricted, and nothing in the
 * output said the fence had been dropped.
 *
 * These tests pin the constraint-carrying flags. They do NOT assert on
 * `--enable-actions`: that GRANTS rather than restricts, so each caller decides
 * whether the inner command is entitled to it.
 */

const flagsFor = (argv: string[]) => parseFlags(['snapshot', ...argv])

describe('securityEnvelopeArgv', () => {
  it('carries the egress allowlist — the one whose absence means UNRESTRICTED', () => {
    const env = securityEnvelopeArgv(flagsFor(['--allowed-domains', 'example.com,api.example.com']))
    expect(env).toContain('--allowed-domains')
    expect(env[env.indexOf('--allowed-domains') + 1]).toBe('example.com,api.example.com')
  })

  it('carries every other restriction the operator set', () => {
    const env = securityEnvelopeArgv(
      flagsFor([
        '--allow-file-access',
        '--confirm-actions',
        'click,fill',
        '--action-policy',
        'deny:click@evil.com',
        '--taint-guard',
        '--secret',
        'PW@bank.com',
        '--no-content-boundaries',
      ]),
    )
    expect(env).toContain('--allow-file-access')
    expect(env).toContain('--confirm-actions')
    expect(env).toContain('--action-policy')
    expect(env).toContain('--taint-guard')
    expect(env).toContain('--secret')
    expect(env).toContain('--no-content-boundaries')
    // The values ride along with their flags.
    expect(env[env.indexOf('--action-policy') + 1]).toBe('deny:click@evil.com')
    expect(env[env.indexOf('--secret') + 1]).toBe('PW@bank.com')
  })

  it('emits nothing when the operator set no restrictions', () => {
    // A default run must not gain flags it never asked for — the envelope only
    // ever narrows, so an empty envelope is the correct empty case.
    expect(securityEnvelopeArgv(flagsFor([]))).toEqual([])
  })

  it('carries EVERY --secret, not just the first', () => {
    const env = securityEnvelopeArgv(
      flagsFor(['--secret', 'A@a.com', '--secret', 'B@b.com', '--secret', 'C@c.com']),
    )
    expect(env.filter((a) => a === '--secret')).toHaveLength(3)
    expect(env).toContain('C@c.com')
  })

  it('re-parses to the SAME restrictions — the envelope round-trips', () => {
    // The real contract: what the inner command ends up with must equal what the
    // outer operator set. Asserting on the argv alone would miss a flag that is
    // emitted but spelled in a way the parser reads differently.
    const outer = flagsFor([
      '--allowed-domains',
      'example.com',
      '--taint-guard',
      '--action-policy',
      'deny:fill@evil.com',
    ])
    const inner = parseFlags(['snapshot', ...securityEnvelopeArgv(outer)])

    expect(inner.allowedDomains).toEqual(outer.allowedDomains)
    expect(inner.taintGuard).toBe(outer.taintGuard)
    expect(inner.actionPolicy).toBe(outer.actionPolicy)
    expect(inner.contentBoundaries).toBe(outer.contentBoundaries)
  })
})
