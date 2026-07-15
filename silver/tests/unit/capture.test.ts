import { describe, it, expect } from 'vitest'
import {
  INSTALLER,
  buildHar,
  isAuthoritativeNetEntry,
} from '../../src/core/capture.js'

// F13: PerformanceObserver-sourced (non-fetch) network entries must be marked
// best-effort so their placeholder method/status is never presented as
// authoritative (status/method filters, HAR response fidelity).

describe('capture — net-entry provenance (`source`)', () => {
  it('the in-page installer stamps real fetch/XHR as source:fetch and observer entries as source:observer', () => {
    // fetch + XHR records carry source:'fetch'.
    expect(INSTALLER).toContain("resourceType: 'fetch', source: 'fetch'")
    expect(INSTALLER).toContain("resourceType: 'xhr', source: 'fetch'")
    // PerformanceObserver resource entries carry source:'observer'.
    expect(INSTALLER).toContain("source: 'observer'")
  })

  it('isAuthoritativeNetEntry: real fetch/XHR are authoritative, observer entries are not', () => {
    expect(isAuthoritativeNetEntry({ source: 'fetch', status: 404 })).toBe(true)
    expect(isAuthoritativeNetEntry({ source: 'observer', status: 200 })).toBe(false)
    // Legacy entries (captured before the field existed) default to authoritative.
    expect(isAuthoritativeNetEntry({ status: 200 })).toBe(true)
  })
})

describe('buildHar — observer entries are marked best-effort, fetch entries authoritative', () => {
  type HarLog = {
    log: { entries: Array<Record<string, unknown>> }
  }

  it('a real fetch entry keeps its observed status and carries no best-effort comment', () => {
    const har = buildHar([
      { url: 'https://x.test/api', method: 'POST', status: 404, resourceType: 'fetch', source: 'fetch', ts: 1000 },
    ]) as HarLog
    const entry = har.log.entries[0]
    const response = entry.response as Record<string, unknown>
    expect(response.status).toBe(404)
    expect(response.comment).toBeUndefined()
    expect(entry.comment).toBeUndefined()
    expect(entry._source).toBe('fetch')
    expect((entry.request as Record<string, unknown>).method).toBe('POST')
  })

  it('an observer entry drops the fabricated 200 status to 0 and is tagged best-effort', () => {
    const har = buildHar([
      { url: 'https://x.test/img.png', method: 'GET', status: 200, resourceType: 'img', source: 'observer', ts: 2000 },
    ]) as HarLog
    const entry = har.log.entries[0]
    const response = entry.response as Record<string, unknown>
    // The placeholder 200 must NOT be presented as a real response code.
    expect(response.status).toBe(0)
    expect(typeof response.comment).toBe('string')
    expect(typeof entry.comment).toBe('string')
    expect(entry._source).toBe('observer')
  })
})
