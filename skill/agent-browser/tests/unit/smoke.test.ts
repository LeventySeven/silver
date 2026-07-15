import { describe, it, expect } from 'vitest'
import { chromium } from 'playwright'

// Task 1: prove the toolchain resolves Playwright and knows where Chromium is.
describe('smoke: playwright is installed and Chromium is resolvable', () => {
  it('imports { chromium } from playwright', () => {
    expect(chromium).toBeDefined()
    expect(typeof chromium.launch).toBe('function')
  })

  it('chromium.executablePath() is a non-empty string', () => {
    const p = chromium.executablePath()
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
  })
})
