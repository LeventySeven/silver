import { describe, it, expect } from 'vitest'
import { shouldEmulateViewport } from '../../src/core/session.js'

/**
 * The viewport override is a STRUCTURAL-COHERENCE check, not a preference.
 *
 * `connect()` used to force `setViewportSize(1280×900)` on every command, while
 * the launch arg already sets 1280×900 as the WINDOW size. Headless those two are
 * the same number and the browser is telling the truth — a headless Chromium has
 * no tab strip and no omnibox, so `outerHeight === innerHeight` is what a real
 * headless browser reports. Headed they are NOT the same number: a real window
 * spends ~80-90px on chrome, so forcing the content box to the window's own
 * height produces a browser claiming a window with zero chrome. FingerprintJS
 * scores that combination as a VM/automation tell — the emulation was the thing
 * creating the tell it was supposed to avoid.
 *
 * The `external` case is worse than a tell: that browser is the USER'S, opened by
 * them, with their tabs in it. Forcing a size on it resized a real window in
 * front of a real person on every single command.
 *
 * These are pure-predicate tests on purpose. The predicate is what both call
 * sites (`connect`, `tab new`) consult, so pinning it here means a future edit
 * that "simplifies" the gate away fails in 3ms rather than in a fingerprint
 * score nobody is watching.
 */
describe('shouldEmulateViewport — never emulate a window that could not exist', () => {
  it('emulates for an ordinary owned headless session', () => {
    expect(shouldEmulateViewport({})).toBe(true)
    expect(shouldEmulateViewport({ headed: false, external: false })).toBe(true)
  })

  it('does NOT emulate a headed session — a real window has chrome above the content', () => {
    expect(shouldEmulateViewport({ headed: true })).toBe(false)
    expect(shouldEmulateViewport({ headed: true, external: false })).toBe(false)
  })

  it('does NOT emulate an external session — that window belongs to the user', () => {
    expect(shouldEmulateViewport({ external: true })).toBe(false)
    // Headless-but-external is still someone else's browser: ownership decides,
    // not whether the window happens to be visible.
    expect(shouldEmulateViewport({ headed: false, external: true })).toBe(false)
  })

  it('does NOT emulate when both are set', () => {
    expect(shouldEmulateViewport({ headed: true, external: true })).toBe(false)
  })
})
