import { describe, it, expect, vi, afterEach } from 'vitest'
import { ok, fail, print, type Envelope } from '../../src/core/envelope.js'

/** Capture everything print() writes to stdout for one call. */
function captured(env: Envelope<unknown>, json: boolean): string {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    print(env, json)
  } finally {
    spy.mockRestore()
  }
  return chunks.join('')
}

afterEach(() => vi.restoreAllMocks())

describe('envelope humanForm — failure diagnostics', () => {
  // F12: a failing `batch` in default (non-json) mode previously printed only the
  // terse "one or more batch commands failed" line and dropped env.data — the
  // per-subcommand results the operator needs to see WHICH command failed.
  it('F12: renders env.data on a failure so batch sub-results survive human mode', () => {
    const batchFailure: Envelope<unknown> = {
      success: false,
      data: {
        count: 2,
        results: [
          { command: 'open notascheme', success: false, error: 'nav denied' },
          { command: 'get title', success: false, error: 'no page' },
        ],
      },
      error: 'one or more batch commands failed',
    }
    const out = captured(batchFailure, false)
    // The terse error line is still present…
    expect(out).toContain('error: one or more batch commands failed')
    // …and now the per-subcommand diagnostics ride along.
    expect(out).toContain('open notascheme')
    expect(out).toContain('nav denied')
    expect(out).toContain('get title')
    expect(out).toContain('"count": 2')
  })

  it('a failure with NO data still prints just the error line (no stray null)', () => {
    const out = captured(fail('not_permitted'), false)
    expect(out).toContain('error:')
    expect(out).not.toContain('null')
  })

  it('json mode is unchanged: the raw envelope is emitted verbatim', () => {
    const env: Envelope<unknown> = {
      success: false,
      data: { count: 1, results: [{ command: 'x', success: false, error: 'e' }] },
      error: 'one or more batch commands failed',
    }
    const out = captured(env, true).trim()
    expect(JSON.parse(out)).toEqual(env)
  })

  it('success human form is unaffected (string data prints bare)', () => {
    const out = captured(ok('hello world'), false).trim()
    expect(out).toBe('hello world')
  })
})
