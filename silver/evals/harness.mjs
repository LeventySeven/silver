/**
 * Silver eval harness (keyless, model-free) — the measurement foundation.
 *
 * Aside's #1 SOTA lesson is "prove the harness is the independent variable": on a
 * browser-TASK leaderboard the scaffold, not the model, wins. Silver is a PURE
 * harness (it never calls a model), so its only levers are perception cleanliness,
 * ref reliability, actuation, and recovery — and they must be MEASURED, not tuned
 * by taste.
 *
 * This harness measures exactly that with NO model in the loop: a "dumb driver"
 * mechanically executes a fixed plan per fixture (snapshot → regex the grounded
 * @ref for a known role+name → act on it), then the run is SCORED by Silver's own
 * keyless completion gate (`task done` re-running pre-committed grounded `expect`
 * criteria). A rising `passK` means the harness reliably lands a fixed plan; the
 * obs-token metrics track representation efficiency. Both move independent of any
 * host model — the north-star Aside's model-swap datapoint isolates.
 *
 * The fixtures + driver logic live here; `run.mjs` drives them via the built CLI
 * for the metrics report, and `tests/integration/evals.test.ts` drives the same
 * fixtures as a CI gate (passK must stay 1.0). `runCmd` is injected so both
 * consumers share one definition.
 */
import { createServer } from 'node:http'

/** Rough token anchor (chars/4) — the standard estimate; a host's real tokenizer differs. */
export function estTokens(s) {
  return Math.ceil(s.length / 4)
}

/**
 * Extract the FIRST minted @ref for a (role, name) from snapshot text. Lines look
 * like `  - button "Submit" [ref=e3, level=1]` (optional `*` new-bullet / indent).
 * Returns `eN` or null. This is the whole "dumb driver" — no model, just the
 * grounded tree the harness already produced.
 */
export function refFor(snapshot, role, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`(?:^|\\n)\\s*[-*]\\s+${role}\\s+"${esc}"\\s*\\[ref=(e\\d+)`)
  const m = rx.exec(snapshot)
  return m ? m[1] : null
}

const A = ['--enable-actions'] // the actor grant a mechanical fill/click needs

/**
 * The fixture corpus. Each: a served page + a pre-committed set of GROUNDED
 * acceptance criteria (raw `expect` argv) + a mechanical `drive` plan. Extend this
 * array to widen coverage — passK/obs-tokens recompute automatically.
 */
export const FIXTURES = [
  {
    name: 'form-fill',
    path: '/form',
    // A text field + a submit button that reveals a confirmation (no navigation).
    html: `<!doctype html><html><head><title>Form</title></head><body>
      <form><label>Email <input aria-label="Email"></label>
      <button type="button" onclick="document.getElementById('r').textContent='Thanks, submitted!'">Submit</button></form>
      <div id="r"></div></body></html>`,
    // Two grounded criteria so BOTH actions are load-bearing: `value-equals` grounds
    // the FILL (the button's onclick sets the confirmation unconditionally, so
    // without this a broken `fill` would still pass), `text-visible` grounds the
    // CLICK. A regression in either verb now drops passK — the coverage the fixture
    // is named for. value-equals reads inputValue via a CSS selector (no ref needed).
    criteria: [
      ['[aria-label="Email"]', 'value-equals', 'a@b.com'],
      ['text-visible', 'Thanks, submitted!'],
    ],
    async drive({ cmd, snap }) {
      const s1 = await snap()
      const email = refFor(s1, 'textbox', 'Email')
      if (email) await cmd(['fill', email, 'a@b.com', ...A])
      const s2 = await snap()
      const btn = refFor(s2, 'button', 'Submit')
      if (btn) await cmd(['click', btn, ...A])
      await snap()
    },
  },
  {
    name: 'list-count',
    path: '/list',
    // Five rows + a button that drops one — the count criterion must fall to 4.
    // Neutral name ("Trim list") so this measures click-reliability, NOT the
    // destructive-name confirm gate (a "remove"/"delete"-named control correctly
    // requires confirmation — a separate axis the eval deliberately isolates from).
    html: `<!doctype html><html><head><title>List</title></head><body>
      <ul>${'<li class="item">x</li>'.repeat(5)}</ul>
      <button type="button" onclick="document.querySelector('.item').remove()">Trim list</button>
      </body></html>`,
    criteria: [['.item', 'count', '4']],
    async drive({ cmd, snap }) {
      const s = await snap()
      const btn = refFor(s, 'button', 'Trim list')
      if (btn) await cmd(['click', btn, ...A])
      await snap()
    },
  },
  {
    name: 'multi-step',
    path: '/multi',
    // A two-step reveal: clicking Next hides step 1 and shows step 2's heading.
    html: `<!doctype html><html><head><title>Steps</title></head><body>
      <div id="s1"><button type="button" onclick="document.getElementById('s2').hidden=false;this.hidden=true">Next</button></div>
      <div id="s2" hidden><h2>Step 2 complete</h2></div></body></html>`,
    criteria: [['text-visible', 'Step 2 complete']],
    async drive({ cmd, snap }) {
      const s = await snap()
      const next = refFor(s, 'button', 'Next')
      if (next) await cmd(['click', next, ...A])
      await snap()
    },
  },
  {
    name: 'dynamic-mount',
    path: '/dynamic',
    // Content mounts 400ms after load — exercises dual-quiet pageready (the open
    // must not return the "Loading…" shell). No action needed; the gate verifies.
    html: `<!doctype html><html><head><title>Dyn</title></head><body>
      <div id="app">Loading…</div>
      <script>setTimeout(function(){document.getElementById('app').innerHTML='<button type=button>Loaded</button>'},400)</script>
      </body></html>`,
    criteria: [['text-visible', 'Loaded']],
    async drive({ snap }) {
      await snap() // observe the settled page (obs-token sample)
    },
  },
]

/** An http server that serves each fixture's html at its path. */
export function startFixtureServer() {
  const byPath = new Map(FIXTURES.map((f) => [f.path, f.html]))
  return createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const html = byPath.get(url)
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' })
    res.end(html ?? '<!doctype html><body>not found</body>')
  })
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0)
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : 0)

/**
 * Run every fixture through the dumb driver + the grounded completion gate.
 * `runCmd(argv) -> {env}` is the injected Silver entrypoint (built CLI or src).
 * Returns per-fixture results + aggregate metrics. Makes NO model call.
 */
export async function runEval({ runCmd, baseUrl, session, namespace }) {
  const ns = ['--namespace', namespace]
  const sess = ['--session', session, ...ns]
  const results = []
  const allObsTokens = []

  for (const f of FIXTURES) {
    const id = `eval-${f.name}`
    let acts = 0
    const obsTokens = []
    // Every browser command flows through here so acts are counted and snapshot
    // sizes captured — the two efficiency levers, measured not guessed.
    const cmd = async (argv) => {
      acts++
      const r = await runCmd([...argv, ...sess])
      if (argv[0] === 'snapshot' && typeof r.env.data === 'string') {
        const t = estTokens(r.env.data)
        obsTokens.push(t)
        allObsTokens.push(t)
      }
      return r
    }
    const snap = async (interactive = true) => {
      const r = await cmd(interactive ? ['snapshot', '-i'] : ['snapshot'])
      return typeof r.env.data === 'string' ? r.env.data : ''
    }

    await runCmd(['task', 'start', f.name, '--id', id, ...ns])
    for (const c of f.criteria) await runCmd(['task', 'criteria', id, ...c, ...ns])

    await cmd(['open', `${baseUrl}${f.path}`])
    let driveErr = null
    try {
      await f.drive({ cmd, snap })
    } catch (e) {
      driveErr = String((e && e.message) || e)
    }

    // Score with Silver's own grounded, keyless completion gate.
    const done = await runCmd(['task', 'done', id, ...sess])
    const passed = done.env.success === true
    const data = (done.env.data || {})
    results.push({
      name: f.name,
      passed,
      acts,
      obsTokens,
      ...(driveErr ? { driveErr } : {}),
      ...(passed ? {} : { unmet: data.unmet ?? [] }),
    })
  }

  const passK = results.length ? results.filter((r) => r.passed).length / results.length : 0
  const metrics = {
    passK,
    fixtures: results.length,
    passed: results.filter((r) => r.passed).length,
    obsTokenMedian: median(allObsTokens),
    obsTokenP90: p90(allObsTokens),
    actsMedian: median(results.map((r) => r.acts)),
  }
  return { results, metrics }
}
