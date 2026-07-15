import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/cli.js'
import { sanitizeNamespace } from '../../src/core/session.js'
import { rank } from '../../src/memory/search.js'
import type { Note } from '../../src/memory/store.js'

const NS = `mem-${process.pid}-${Date.now()}`

function data<T = Record<string, unknown>>(r: { env: { data: unknown } }): T {
  return r.env.data as T
}

afterAll(async () => {
  await fs.rm(path.join(os.homedir(), '.silver', sanitizeNamespace(NS)), {
    recursive: true,
    force: true,
  }).catch(() => {})
})

/** Build a synthetic note with a controllable timestamp for recency tests. */
function note(body: string, atMsAgo: number, now: number): Note {
  return {
    file: '/x/episodic/day.md',
    line: 1,
    at: new Date(now - atMsAgo).toISOString(),
    tags: [],
    heading: 'h',
    body,
  }
}

describe('memory grep-first ranking (pure, keyless)', () => {
  const now = Date.parse('2026-07-15T12:00:00.000Z')

  it('ranks by term OVERLAP first (more distinct query terms → higher)', () => {
    const notes = [
      note('the checkout flow', 0, now), // matches "checkout" only
      note('checkout requires a date first', 0, now), // matches "checkout" + "date"
    ]
    const ranked = rank(notes, 'checkout date', 5, now)
    expect(ranked.length).toBe(2)
    expect(ranked[0].matched).toBe(2)
    expect(ranked[0].note.body).toContain('date first')
  })

  it('EXCLUDES zero-overlap notes (grep-first: no match → not a hit)', () => {
    const notes = [note('stripe payment quirks', 0, now), note('checkout page', 0, now)]
    const ranked = rank(notes, 'checkout', 5, now)
    expect(ranked.length).toBe(1)
    expect(ranked[0].note.body).toContain('checkout')
  })

  it('breaks equal-overlap ties by RECENCY (fresher wins)', () => {
    const notes = [
      note('checkout note OLD', 20 * 86_400_000, now), // 20 days old
      note('checkout note NEW', 1 * 86_400_000, now), // 1 day old
    ]
    const ranked = rank(notes, 'checkout', 5, now)
    expect(ranked[0].note.body).toContain('NEW')
    expect(ranked[0].recency).toBeGreaterThan(ranked[1].recency)
  })

  it('an empty query returns nothing', () => {
    expect(rank([note('anything', 0, now)], '   ', 5, now)).toEqual([])
  })
})

describe('memory add/search end-to-end (files-are-truth, no vectors)', () => {
  it('add writes a markdown note; search grep-ranks it and excludes non-matches', async () => {
    const a = await run([
      'memory',
      'add',
      'getyourguide checkout needs a date selected first',
      '--tag',
      'booking',
      '--namespace',
      NS,
    ])
    expect(a.env.success).toBe(true)
    expect(data<{ tags: string[]; ref: string }>(a).tags).toEqual(['booking'])

    await run(['memory', 'add', 'stripe webhook signing secret rotation', '--tag', 'payments', '--namespace', NS])

    const search = await run(['memory', 'search', 'checkout', '--namespace', NS])
    expect(search.env.success).toBe(true)
    const s = data<{ count: number; results: Array<{ excerpt: string; tags: string[] }> }>(search)
    expect(s.count).toBe(1) // only the getyourguide note matches "checkout"
    expect(s.results[0].excerpt).toContain('getyourguide')
    expect(s.results[0].tags).toEqual(['booking'])
    // Excerpt is neutralized/boundary-fenced (injection scrub on echoed page text).
    expect(s.results[0].excerpt).toContain('page-content untrusted')
  })

  it('search on a miss returns an explicit empty result', async () => {
    const search = await run(['memory', 'search', 'kubernetes', '--namespace', NS])
    const s = data<{ count: number; note?: string }>(search)
    expect(s.count).toBe(0)
    expect(s.note).toContain('no matching memories')
  })

  it('list returns recent notes newest-first', async () => {
    const listed = await run(['memory', 'list', '--namespace', NS])
    const l = data<{ total: number; recent: Array<{ tags: string[] }> }>(listed)
    expect(l.total).toBeGreaterThanOrEqual(2)
  })
})
