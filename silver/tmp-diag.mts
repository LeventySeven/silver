import { chromium } from 'playwright'

const FIXTURE = `<!doctype html>
<html><body>
<button id="buy" onclick="window.__fired=(window.__fired||0)+1">Place order</button>
</body></html>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(FIXTURE, { waitUntil: 'load' })

const locator = page.getByRole('button', { name: 'Place order' })
const handle = await locator.elementHandle({ timeout: 5000 })
console.log('handle?', handle !== null)

// EXACT copy of the arm step from src/actuation/actions.ts:622-641, but with the
// error surfaced instead of swallowed.
const armResult = await handle!
  .evaluate((el: any) => {
    const probe = el
    probe.__silverDown = 0
    const w = el.ownerDocument.defaultView
    if (w === null) return 'w-null'
    const bump = () => {
      probe.__silverDown = (probe.__silverDown ?? 0) + 1
    }
    w.addEventListener('pointerdown', bump, true)
    w.addEventListener('mousedown', bump, true)
    probe.__silverClickOff = () => {
      w.removeEventListener('pointerdown', bump, true)
      w.removeEventListener('mousedown', bump, true)
    }
    return 'armed'
  })
  .catch((e) => `THREW: ${String(e).slice(0, 200)}`)
console.log('arm ->', armResult)

await locator.click()

const check = await handle!
  .evaluate((el: any) => ({ down: el.__silverDown, off: typeof el.__silverClickOff }))
  .catch((e) => `THREW: ${String(e).slice(0, 200)}`)
console.log('check ->', check)
console.log('fired ->', await page.evaluate(() => (window as any).__fired ?? 0))

await browser.close()
