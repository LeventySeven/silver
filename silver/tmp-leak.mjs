import { chromium } from 'playwright'
import { find } from './dist/actuation/actions.js'

const FIXTURE = `<!doctype html>
<html><body>
<button id="buy" onclick="window.__fired=(window.__fired||0)+1">Place order</button>
<div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9"></div>
</body></html>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(FIXTURE, { waitUntil: 'load' })

// Count live window-level pointerdown/mousedown capture listeners via CDP
// (DOMDebugger.getEventListeners on the window object) — ground truth, no page patching.
const cdp = await page.context().newCDPSession(page)
async function listenerCount() {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' })
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
    objectId: result.objectId,
  })
  const rel = listeners.filter((l) => l.type === 'pointerdown' || l.type === 'mousedown')
  await cdp.send('Runtime.releaseObject', { objectId: result.objectId })
  return rel.length
}
const probeState = () =>
  page.evaluate(() => ({
    down: document.getElementById('buy').__silverDown,
    off: typeof document.getElementById('buy').__silverClickOff,
    fired: window.__fired ?? 0,
  }))

console.log('baseline window pointerdown/mousedown listeners:', await listenerCount())

for (let i = 1; i <= 3; i++) {
  const env = await find(page, 'role', 'button', 'click', { name: 'Place order', timeout: 1200 })
  console.log(
    `obscured attempt ${i}: success=${env.success} code=${env.error?.code ?? '-'} listeners=${await listenerCount()}`,
    await probeState(),
  )
}

await page.evaluate(() => document.getElementById('veil').remove())
const good = await find(page, 'role', 'button', 'click', { name: 'Place order', timeout: 1200 })
console.log(
  `clean click: success=${good.success} listeners=${await listenerCount()}`,
  await probeState(),
)

await browser.close()
