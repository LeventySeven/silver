import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import type { Page } from 'playwright'
import {
  detectEmptyPage,
  bumpGenerationOnPageChange,
  compareFingerprint,
  structuralChange,
  fingerprintOnly,
  EMPTY_PAGE_NODE_THRESHOLD,
} from '../../src/actuation/pagechange.js'
import { saveRefMap, loadRefMap, sessionDir } from '../../src/core/session.js'
import { groundRef, type RefMap } from '../../src/perception/refmap.js'

// A minimal fake Page whose evaluate returns a canned in-page probe result.
function fakePage(probe: unknown, opts: { throws?: boolean } = {}): Page {
  return {
    evaluate: async () => {
      if (opts.throws) throw new Error('Execution context was destroyed')
      return probe
    },
  } as unknown as Page
}

describe('detectEmptyPage (R5a)', () => {
  it('flags a near-empty DOM below the node threshold', async () => {
    const p = fakePage({ count: 3, bodyChildren: 0, bodyTextLen: 0 })
    expect(await detectEmptyPage(p)).toBe(true)
  })

  it('flags a body with no children and no text even when node count is above the floor', async () => {
    const p = fakePage({ count: 20, bodyChildren: 0, bodyTextLen: 0 })
    expect(await detectEmptyPage(p)).toBe(true)
  })

  it('does NOT flag a real page with content', async () => {
    const p = fakePage({ count: 500, bodyChildren: 12, bodyTextLen: 3400 })
    expect(await detectEmptyPage(p)).toBe(false)
  })

  it('does NOT flag a thin-but-real body (children present)', async () => {
    const p = fakePage({ count: 10, bodyChildren: 2, bodyTextLen: 0 })
    expect(await detectEmptyPage(p)).toBe(false)
  })

  it('respects a caller-supplied node floor', async () => {
    const p = fakePage({ count: 40, bodyChildren: 3, bodyTextLen: 10 })
    expect(await detectEmptyPage(p, 100)).toBe(true) // 40 < 100
  })

  it('fails safe (returns false) when the in-page probe throws', async () => {
    const p = fakePage(null, { throws: true })
    expect(await detectEmptyPage(p)).toBe(false)
  })

  it('exposes a sane default threshold', () => {
    expect(EMPTY_PAGE_NODE_THRESHOLD).toBeGreaterThan(0)
  })
})

describe('bumpGenerationOnPageChange (R4)', () => {
  const NAME = `silver-pc-${process.pid}-${Date.now()}`

  afterEach(async () => {
    await fs.rm(sessionDir(NAME), { recursive: true, force: true }).catch(() => {})
  })

  const seedMap = (): RefMap => ({
    generation: 5,
    entries: {
      e1: { generation: 5, backendNodeId: 11, role: 'button', name: 'Buy', nth: 0, frameId: 'f' },
    },
  })

  it('bumps the map generation on page_changed:true, leaving entries stale', async () => {
    await saveRefMap(NAME, seedMap())
    const res = await bumpGenerationOnPageChange(NAME, true)
    expect(res.bumped).toBe(true)
    expect(res.generation).toBe(6)

    const map = await loadRefMap(NAME)
    expect(map).not.toBeNull()
    expect(map?.generation).toBe(6)
    // The entry is still present but now at the OLD generation → grounds as stale.
    const g = groundRef(map as RefMap, '@e1')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.code).toBe('ref_stale')
  })

  it('is a no-op on page_changed:false (refs still ground)', async () => {
    await saveRefMap(NAME, seedMap())
    const res = await bumpGenerationOnPageChange(NAME, false)
    expect(res.bumped).toBe(false)
    expect(res.generation).toBe(5)
    const map = await loadRefMap(NAME)
    const g = groundRef(map as RefMap, '@e1')
    expect(g.ok).toBe(true)
  })

  it('is a safe no-op when there is no RefMap yet', async () => {
    const res = await bumpGenerationOnPageChange(NAME, true)
    expect(res.bumped).toBe(false)
    expect(res.generation).toBe(0)
  })
})

describe('compareFingerprint (unchanged contract)', () => {
  it('a missing previous fingerprint is never a change', () => {
    expect(compareFingerprint(null, 'x')).toBe(false)
    expect(compareFingerprint(undefined, 'x')).toBe(false)
    expect(compareFingerprint('', 'x')).toBe(false)
  })
  it('detects a differing fingerprint', () => {
    expect(compareFingerprint('a', 'b')).toBe(true)
    expect(compareFingerprint('a', 'a')).toBe(false)
  })
})

// S7: `stale_refs` is STRUCTURAL-ONLY. The fingerprint is `url|focus|nodeCount`;
// `structuralChange` compares url (index 0) + nodeCount (last index) and IGNORES
// focus (index 1), matching the generation-bump criterion exactly. So a fill/focus
// that only moves focus reports page_changed:true but stale_refs:false.
describe('structuralChange (S7 — focus-only moves are not structural)', () => {
  it('same url + node count, different focus → NOT structural', () => {
    expect(structuralChange('http://x/|11|500', 'http://x/|22|500')).toBe(false)
  })
  it('url change → structural', () => {
    expect(structuralChange('http://x/|11|500', 'http://y/|11|500')).toBe(true)
  })
  it('node-count change → structural', () => {
    expect(structuralChange('http://x/|11|500', 'http://x/|11|600')).toBe(true)
  })
  it('first observation (prev null/undefined/"") → not structural', () => {
    expect(structuralChange(null, 'http://x/|11|500')).toBe(false)
    expect(structuralChange(undefined, 'http://x/|11|500')).toBe(false)
    expect(structuralChange('', 'http://x/|11|500')).toBe(false)
  })
})

// A fake Page for settleAndFingerprint/fingerprintOnly: url() + node count are
// controllable; context() throws so focusedBackendId's `.catch(() => 0)` yields
// focus=0. Fingerprint therefore = `${url}|0|${count}`; we vary the PREV focus
// digit to exercise the focus-only case through the real settle path.
function fpPage(url: string, nodeCount: number): Page {
  return {
    url: () => url,
    context: () => {
      throw new Error('no cdp in test')
    },
    evaluate: async () => nodeCount,
    waitForLoadState: async () => {},
  } as unknown as Page
}

describe('settleAndFingerprint stale_refs wiring (S7)', () => {
  it('focus-only shift → page_changed:true but stale_refs:false', async () => {
    const page = fpPage('http://x/', 500)
    // prev: same url + node count, DIFFERENT focus (9) vs the fake's computed 0
    const res = await fingerprintOnly(page, 'http://x/|9|500')
    expect(res.fingerprint).toBe('http://x/|0|500')
    expect(res.page_changed).toBe(true)
    expect(res.stale_refs).toBe(false)
  })
  it('url change → page_changed:true and stale_refs:true', async () => {
    const res = await fingerprintOnly(fpPage('http://y/', 500), 'http://x/|0|500')
    expect(res.page_changed).toBe(true)
    expect(res.stale_refs).toBe(true)
  })
  it('node-count change → page_changed:true and stale_refs:true', async () => {
    const res = await fingerprintOnly(fpPage('http://x/', 600), 'http://x/|0|500')
    expect(res.page_changed).toBe(true)
    expect(res.stale_refs).toBe(true)
  })
  it('first observation (no prev) → both false', async () => {
    const res = await fingerprintOnly(fpPage('http://x/', 500))
    expect(res.page_changed).toBe(false)
    expect(res.stale_refs).toBe(false)
  })
})
