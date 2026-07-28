import { chromium } from 'playwright'
import { snapshotNodes } from '/Users/seventyleven/Desktop/Silver/silver/dist/perception/walk.js'
import { render } from '/Users/seventyleven/Desktop/Silver/silver/dist/perception/serialize.js'

const b = await chromium.launch()
const p = await b.newPage()
await p.goto('file:///private/tmp/claude-501/-Users-seventyleven-Desktop-Silver/237cbce6-26e1-4d1a-a275-2defc8ee8d5e/scratchpad/page.html')

for (const mode of [false, true]) {
  const nodes = await snapshotNodes(p, { interactive: mode })
  const { text } = render(nodes, { generation: 1, entries: {} },
    { generation: 1, title: 'Probe', url: p.url(), filtered: mode })
  console.log(`===== interactive=${mode} =====`)
  console.log(text)
  console.log('--- refEligible nodes ---')
  for (const n of nodes) if (n.refEligible) console.log(`  ${n.role} | ${JSON.stringify(n.name)} | cur=${n.cursorInteractive}`)
}
await b.close()
