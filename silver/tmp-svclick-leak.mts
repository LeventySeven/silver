import { chromium } from 'playwright'
import { find } from '/Users/seventyleven/Desktop/Silver/silver/src/actuation/actions.js'

const FIXTURE = `<!doctype html>
<html><body>
<script>
  window.__adds = []
  window.__removes = []
  const _add = window.addEventListener.bind(window)
  const _rm = window.removeEventListener.bind(window)
  window.addEventListener = function (t, f, c) { window.__adds.push(t); return _add(t, f, c) }
  window.removeEventListener = function (t, f, c) { window.__removes.push(t); return _rm(t, f, c) }
</script>
<button id="buy" onclick="window.__fired=(window.__fired||0)+1">Place order</button>
<div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9"></div>
</body></html>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(FIXTURE, { waitUntil: 'load' })

const st = () =>
  page.evaluate(() => ({
    adds: (window as any).__adds.length,
    removes: (window as any).__removes.length,
    down: (document.getElementById('buy') as any).__silverDown,
    off: typeof (document.getElementById('buy') as any).__silverClickOff,
    fired: (window as any).__fired ?? 0,
  }))

for (let i = 1; i <= 3; i++) {
  const env = await find(page, 'role', 'button', 'click', { name: 'Place order', timeout: 1200 })
  console.log(`obscured attempt ${i}: success=${env.success} code=${env.error?.code ?? '-'}`, await st())
}

// Control: same click with the overlay removed -> should clean up after itself.
await page.evaluate(() => document.getElementById('veil')!.remove())
const good = await find(page, 'role', 'button', 'click', { name: 'Place order', timeout: 1200 })
console.log(`clean click: success=${good.success}`, await st())

await browser.close()
