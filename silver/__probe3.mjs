import { chromium } from 'playwright'
import { snapshotNodes } from './dist/perception/walk.js'
import { render } from './dist/perception/serialize.js'

const b = await chromium.launch()
const p = await b.newPage()
await p.goto('file:///Users/seventyleven/Desktop/Silver/silver/__page3.html')

const nodes = await snapshotNodes(p, { interactive: true })
const { text } = render(nodes, { generation: 1, entries: {} },
  { generation: 1, title: 'Checkout', url: p.url(), filtered: true })
console.log('===== interactive snapshot =====')
console.log(text)

console.log('\n===== selector scope on a display:none element =====')
try {
  const n2 = await snapshotNodes(p, { interactive: false, selectorScope: '#scopeme' })
  const r2 = render(n2, { generation: 2, entries: {} },
    { generation: 2, title: 'Checkout', url: p.url() })
  console.log('nodes:', n2.length)
  console.log(JSON.stringify(r2.text))
} catch (e) { console.log('THREW', e.name, e.code, e.message) }

console.log('\n===== selector scope that matches nothing =====')
try {
  const n3 = await snapshotNodes(p, { selectorScope: '#nope' })
  console.log('nodes:', n3.length)
} catch (e) { console.log('THREW', e.name, e.code, e.message) }
await b.close()
