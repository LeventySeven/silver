/**
 * `node evals/run.mjs` (or `npm run eval`) — the keyless eval metrics report.
 *
 * Drives every fixture through the built CLI (the real stateless-per-command
 * entrypoint a host uses) and prints + persists passK / obs-tokens / acts-per-task.
 * Run it before and after a perception/actuation change: a rise in passK or a drop
 * in obs-token median at equal passK is a real, model-independent harness win.
 * Requires a build first (imports ../dist/cli.js).
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from '../dist/cli.js'
import { startFixtureServer, runEval } from './harness.mjs'
import { sanitizeNamespace } from '../dist/core/session.js'

const server = startFixtureServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://localhost:${port}`
const session = 'eval'
const namespace = `eval-run-${process.pid}`

try {
  const { results, metrics } = await runEval({ runCmd: (argv) => run(argv), baseUrl, session, namespace })

  console.log('\nSilver eval — keyless, model-free (harness-as-moat metric)\n')
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL'
    const extra = r.passed ? '' : `  unmet=${JSON.stringify(r.unmet)}${r.driveErr ? ` err=${r.driveErr}` : ''}`
    console.log(`  ${tag}  ${r.name.padEnd(14)} acts=${r.acts}  obsTokens=[${r.obsTokens.join(', ')}]${extra}`)
  }
  console.log(
    `\n  passK=${(metrics.passK * 100).toFixed(1)}% (${metrics.passed}/${metrics.fixtures})  ` +
      `obsTokens median=${metrics.obsTokenMedian} p90=${metrics.obsTokenP90}  acts median=${metrics.actsMedian}\n`,
  )

  const report = { at: new Date().toISOString(), metrics, results }
  await fs.writeFile(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2))
  console.log('  wrote evals/report.json\n')
} finally {
  await run(['close', '--all', '--namespace', namespace]).catch(() => {})
  await fs
    .rm(path.join(os.homedir(), '.silver', sanitizeNamespace(namespace)), { recursive: true, force: true })
    .catch(() => {})
  server.close()
}
