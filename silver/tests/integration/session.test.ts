import { describe, it, expect, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import {
  openSession,
  connect,
  closeSession,
  saveRefMap,
  loadRefMap,
  sessionDir,
} from '../../src/core/session.js'
import type { RefMap } from '../../src/perception/refmap.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-it-${process.pid}-${Date.now()}`

describe('session lifecycle (real Chromium, detached, CDP reconnect)', () => {
  afterAll(async () => {
    // Belt-and-suspenders cleanup even if an assertion above threw.
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'LOAD-BEARING: detached browser survives across two separate connect() calls',
    async () => {
      // --- open: spawns a DETACHED Chromium; the CLI-side spawn is unref'd ---
      const info = await openSession(NAME, { headed: false })
      expect(info.pid).toBeGreaterThan(0)
      expect(info.port).toBeGreaterThan(0)
      expect(info.wsEndpoint.startsWith('ws')).toBe(true)
      expect(existsSync(sessionDir(NAME))).toBe(true)

      // --- connect #1 (fresh CDP session): navigate, then DISCONNECT only ---
      {
        const { browser, page } = await connect(NAME)
        await page.goto('data:text/html,<h1>hi</h1>')
        // browser.close() on a connectOverCDP browser only drops the CDP
        // transport; the detached browser process keeps running.
        await browser.close()
      }

      // --- connect #2 (a SEPARATE connect): the browser must still be alive,
      // and it must still hold the page state from connect #1 ---
      {
        const { browser, page } = await connect(NAME)
        const text = await page.evaluate(
          () => document.querySelector('h1')?.textContent ?? '',
        )
        expect(text).toBe('hi')
        await browser.close()
      }

      // --- refmap sidecar round-trips across "commands" ---
      const map: RefMap = {
        generation: 1,
        entries: {
          e1: {
            generation: 1,
            backendNodeId: 7,
            role: 'button',
            name: 'Go',
            nth: 0,
            frameId: 'main',
          },
        },
      }
      await saveRefMap(NAME, map)
      const loaded = await loadRefMap(NAME)
      expect(loaded).toEqual(map)

      // --- close: kills the detached process and removes the sidecar dir ---
      await closeSession(NAME)
      expect(existsSync(sessionDir(NAME))).toBe(false)
    },
  )
})
