import { describe, it, expect } from 'vitest'
import {
  browserGuidOf,
  ownershipValid,
  isOwnedTab,
  type TabRegistry,
  type TabRecord,
} from '../../src/core/tabs.js'

/**
 * TAB OWNERSHIP — the guard that keeps Silver off a human's tabs.
 *
 * When a session is EXTERNAL (`connect`ed), the browser is someone's real one and
 * every other tab in that window is their live work. This was found the hard way:
 * a `connect`ed session's registry held 21 of the user's tabs — Gmail, an iHerb
 * checkout cart, a half-filled Hetzner server form — all indistinguishable from
 * tabs Silver had opened, with `tab close`'s only guard being "don't close the
 * last one".
 *
 * Ownership cannot be recovered from the browser after the fact: CDP exposes no
 * opener and no creator, and every page sits in one browserContextId. So it is
 * recorded at creation and nowhere else, exactly like Aside's `openTab()` →
 * `ownership:'owned'` vs `attachBrowserTab()`. These tests pin the two ways that
 * claim can go wrong: claiming a tab we merely FOUND, and honouring a claim made
 * against a DIFFERENT browser instance.
 */

const GUID = '2476c960-c171-40ff-a56e-ca41cef0a2a0'
const OTHER = 'b8331d26-0000-4000-8000-000000000000'

const reg = (over: Partial<TabRegistry> = {}): TabRegistry => ({
  nextId: 3,
  activeTargetId: 'T1',
  tabs: [],
  ...over,
})

const owned: TabRecord = { id: 't1', targetId: 'T1', owned: true }
const found: TabRecord = { id: 't2', targetId: 'T2' }

describe('browserGuidOf', () => {
  it('extracts the instance id from a CDP browser endpoint', () => {
    expect(browserGuidOf(`ws://127.0.0.1:9222/devtools/browser/${GUID}`)).toBe(GUID)
  })

  it('returns empty for anything it cannot parse — which fails CLOSED', () => {
    // Empty never equals a recorded guid, so an unparseable endpoint grants
    // no ownership rather than accidentally granting all of it.
    for (const bad of [undefined, '', 'ws://127.0.0.1:9222/devtools/page/ABC', 'nonsense']) {
      expect(browserGuidOf(bad)).toBe('')
    }
  })
})

describe('ownershipValid — a claim is scoped to one browser INSTANCE', () => {
  it('holds while we are talking to the same browser', () => {
    expect(ownershipValid(reg({ browserGuid: GUID }), GUID)).toBe(true)
  })

  it('is void after the browser restarts (new instance, recycled targetIds)', () => {
    // targetIds do not survive a restart — measured 0/2 — so a persisted `owned`
    // could otherwise land on one of the user's brand-new tabs.
    expect(ownershipValid(reg({ browserGuid: GUID }), OTHER)).toBe(false)
  })

  it('is void for a registry written before ownership existed', () => {
    expect(ownershipValid(reg(), GUID)).toBe(false)
  })

  it('is void when the current browser cannot be identified', () => {
    expect(ownershipValid(reg({ browserGuid: GUID }), '')).toBe(false)
  })
})

describe('isOwnedTab — only a tab we CREATED, in a browser we still recognise', () => {
  it('true for a tab silver opened in this browser', () => {
    expect(isOwnedTab(reg({ browserGuid: GUID }), owned, GUID)).toBe(true)
  })

  it('FALSE for a discovered tab — the human-tab case', () => {
    expect(isOwnedTab(reg({ browserGuid: GUID }), found, GUID)).toBe(false)
  })

  it('FALSE for our own tab once the browser has been replaced', () => {
    expect(isOwnedTab(reg({ browserGuid: GUID }), owned, OTHER)).toBe(false)
  })

  it('FALSE on a legacy registry, even for a record that claims ownership', () => {
    // A registry with no recorded instance cannot substantiate any claim.
    expect(isOwnedTab(reg(), owned, GUID)).toBe(false)
  })
})
