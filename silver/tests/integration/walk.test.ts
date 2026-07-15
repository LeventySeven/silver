import { describe, it, expect, afterAll } from 'vitest'
import { openSession, connect, closeSession } from '../../src/core/session.js'
import { snapshotNodes, type SnapNode } from '../../src/perception/walk.js'

// Unique per run so parallel/retry invocations never collide.
const NAME = `silver-walk-${process.pid}-${Date.now()}`

const FIXTURE = `<!doctype html>
<html><body>
  <button>Go</button>
  <div onclick="void 0" style="cursor:pointer">Card</div>
  <p>hello paragraph</p>
  <input type="checkbox" checked aria-label="offscreen check"
         style="position:absolute; left:-9999px">
  <input type="password" aria-label="Secret" value="hunter2">
</body></html>`

function find(nodes: SnapNode[], pred: (n: SnapNode) => boolean): SnapNode | undefined {
  return nodes.find(pred)
}

describe('snapshotNodes (real Chromium AX walk + cursor cascade)', () => {
  afterAll(async () => {
    try {
      await closeSession(NAME)
    } catch {
      /* ignore */
    }
  })

  it(
    'joins AX + DOM, marks cursor-interactive divs, keeps off-screen checkboxes',
    async () => {
      await openSession(NAME, { headed: false })
      const { browser, page } = await connect(NAME)
      let nodes: SnapNode[]
      try {
        await page.setContent(FIXTURE, { waitUntil: 'load' })
        nodes = await snapshotNodes(page, { interactive: true })
      } finally {
        await browser.close()
      }

      // --- native <button> -> role button, ref-eligible ---
      const button = find(nodes, (n) => n.role === 'button' && n.name === 'Go')
      expect(button, 'button "Go" present').toBeTruthy()
      expect(button!.refEligible).toBe(true)

      // --- <div onclick> -> cursor-interactive -> ref-eligible (name from text) ---
      const card = find(nodes, (n) => n.cursorInteractive && n.name === 'Card')
      expect(card, 'cursor-interactive div present').toBeTruthy()
      expect(card!.refEligible).toBe(true)

      // --- a <p>'s text is NOT ref-eligible (no ref for plain paragraph text) ---
      const paraRefd = find(
        nodes,
        (n) => n.refEligible && (n.role === 'paragraph' || n.name.includes('hello paragraph')),
      )
      expect(paraRefd, 'paragraph text must not be ref-eligible').toBeUndefined()

      // --- off-screen checked checkbox -> kept, checked flag set, ref-eligible ---
      const checkbox = find(nodes, (n) => n.role === 'checkbox')
      expect(checkbox, 'off-screen checkbox kept').toBeTruthy()
      expect(checkbox!.flags.checked).toBe(true)
      expect(checkbox!.refEligible).toBe(true)

      // --- password input flagged for downstream redaction ---
      const password = find(nodes, (n) => n.isPassword)
      expect(password, 'password input flagged isPassword').toBeTruthy()

      // sanity: at least one non-ref-eligible node exists (structure/text kept)
      expect(nodes.some((n) => !n.refEligible)).toBe(true)
    },
  )
})
