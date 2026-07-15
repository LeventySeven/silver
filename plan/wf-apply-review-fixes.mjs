export const meta = {
  name: 'silver-apply-review-fixes',
  description: 'Apply the 15 verified code-review findings in file-disjoint parallel groups, integrate+gate, then adversarially verify every fix landed.',
  phases: [
    { title: 'Fix', detail: '5 file-disjoint agents apply the findings + add regression tests' },
    { title: 'Integrate', detail: 'full build + test + eval gate; fix any cross-file integration break until green' },
    { title: 'Verify', detail: 'adversarial per-finding verification that each fix is correct + covered' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const S = REPO + '/silver'
const KEYLESS = 'Silver is 100% KEYLESS (never calls a model; host LLM is the brain). ESM NodeNext .js imports, strict TS, uniform {success,data,error,warning} envelope via mapThrow, no path/secret in error strings. Do NOT weaken any test/eval to go green. Do NOT commit.'

const GROUPS = [
  {
    slug: 'A-handlers-security',
    owns: 'silver/src/core/handlers.ts, silver/src/actuation/actions.ts, silver/src/core/session.ts (ADD exports + wire --incognito only), silver/src/security/confirm.ts (if needed), and their test files',
    work: [
      'F3 (handlers.ts ~1847): mouse click + keyboard press/type are ACTOR verbs but skip the paid/destructive confirm gate. For `mouse click`, hit-test the element at the click point (Playwright elementFromPoint / evaluate) and apply the SAME isDestructivePaidName + confirmGateDecision check handleAct uses on its accessible name; for `keyboard press` submit-like keys, gate when the focused element name is destructive/paid. Keep --enable-actions gating. TEST: mouse click on a "Buy now" element -> confirm_required on non-TTY.',
      'F4/F8 (handlers.ts ~130-143): silver-state.json (holds prevTree=full page text AND extract.valueMap=the REAL urls the extract moat hides) and dialog.json are written via raw fs+JSON, bypassing state-crypto. Export writeSidecar/readSidecarObject from session.ts (or add equivalents) and route silver-state.json + dialog.json through the SAME AES-GCM encryption + plaintext-legacy migration used for session.json/refmap.json. TEST: silver-state.json on disk is not plaintext JSON by default; round-trips; legacy plaintext still readable.',
      'F5 (actions.ts ~245): fill read-back res.value is returned verbatim by handleAct -> a password typed via fill echoes un-redacted. Redact the read-back like get value does (live type / grounded role+name -> redactValue). TEST: fill on a password input -> read-back is [redacted].',
      'F6 (handlers.ts ~1557): network requests returns attacker-controlled url strings without neutralize/cap. Route each request url (+ free-text fields) through presentPageText/neutralize (like console/errors).',
      'F7 (handlers.ts ~1756): storage local|session whole-store dump returns every value raw+uncapped. Map each value through presentPageText(v, flags).',
      'BONUS (only if cheap + you own session.ts): --incognito is parsed in flags.ts but unused. Wire it as an ephemeral session (no cookie/state persistence, throwaway profile). If wiring is non-trivial, SKIP it and say so (sibling D will leave the flag alone).',
    ],
    verify: 'pnpm exec vitest run tests/integration/verbs.test.ts tests/integration/actions.test.ts tests/unit/security.test.ts (+ your new tests). Do NOT run full pnpm build (siblings write concurrently).',
  },
  {
    slug: 'B-lock',
    owns: 'silver/src/core/lock.ts and its test',
    work: [
      'F1 (lock.ts:71): isStale() ORs an age check (Date.now()-rec.at > HARD_STALE_MS=120s) with pid-liveness, and acquire() never refreshes `at`. A long `wait --timeout 200000` legitimately holds the lock >120s; a concurrent same-session command steals it -> both drive the same browser + race sidecars. FIX: only steal on a DEAD pid (isPidAlive(rec.pid)===false); use age AND !pidAlive (age purely as a last-resort bound for a dead-but-pid-reused holder), OR add a heartbeat that rewrites `at` while fn() runs so a live holder is never stolen. Keep the release() token-safety. TEST: a live-pid lock older than HARD_STALE_MS is NOT stealable; a dead-pid lock IS.',
    ],
    verify: 'pnpm exec vitest run tests/unit/lock.test.ts (+ your additions).',
  },
  {
    slug: 'C-subagent',
    owns: 'silver/src/orchestration/subagent.ts and its test',
    work: [
      'F2 (subagent.ts:144): subagentSpawn does an UNLOCKED read-check-write (allRecords -> cap check -> nextId scan -> writeRecord). Concurrent same-namespace spawns bypass cap 5, collide on saN ids (silent clobber), and duplicate auto-session ids. FIX: serialize the read-check-write with a namespace-scoped advisory lock (reuse core/lock.ts withSessionLock-style, a lockfile under subagentsRoot()) AND mint the id atomically via fs.open(recordPath(id),"wx") retried on EEXIST so cap+id+session-clash checks hold under mutual exclusion. Use the EXISTING withSessionLock API from core/lock.ts (a sibling may edit lock.ts internals but not its signature). TEST: cap/id invariant holds under a simulated concurrent spawn (two spawns interleaved).',
    ],
    verify: 'pnpm exec vitest run tests/unit/subagent.test.ts (+ your additions).',
  },
  {
    slug: 'D-misc',
    owns: 'silver/src/core/flags.ts (remove --password-stdin + -u/--urls ONLY; leave --incognito for sibling A), silver/src/core/capture.ts, silver/src/extract/prompts.ts, silver/src/task/index.ts, evals/harness/ab.mjs, evals/harness/llm.mjs, silver/tests/unit/extract.test.ts and other affected tests',
    work: [
      'F9 (task/index.ts:320): captureScreenshot uses conn.context.pages()[0] not resolveActivePage -> wrong tab. Import resolveActivePage from core/tabs.js and use it.',
      'F10 (ab.mjs:36 + llm.mjs:25): hardcoded dead path skill/agent-browser/dist/cli.js. Change to path.join(REPO_ROOT,"silver","dist","cli.js") (match run.mjs/trifecta.mjs). Re-run ab.mjs to confirm.',
      'F11 (flags.ts:46): --password-stdin is dead (the existing --stdin covers secret input). REMOVE --password-stdin (from ParsedFlags, ALIASES, defaults, and any reference). Do NOT touch --incognito (sibling A wires it).',
      'F12 (flags.ts:58): -u/--urls is parsed but never read (snapshots already emit url=). REMOVE -u/--urls entirely (ParsedFlags, ALIASES, defaults).',
      'F13 (capture.ts:91): network --status/--method + HAR present PerformanceObserver-sourced (non-fetch) entries as if authoritative. Add a `source` field ("fetch"|"observer") to each captured entry; scope --status/--method filters + HAR header fidelity to real fetch/XHR entries; mark observer entries best-effort so data is not presented as authoritative when it is not.',
      'F14 (prompts.ts:17): ACT_SYSTEM_PROMPT + OBSERVE_SYSTEM_PROMPT are dead exports (only EXTRACT_SYSTEM_PROMPT is used). Delete them and their extract.test.ts assertions.',
    ],
    verify: 'pnpm exec vitest run tests/unit/extract.test.ts (+ affected). Then run: node ' + REPO + '/evals/harness/ab.mjs --suite smoke 2>&1 | tail -5 (confirm it runs after the path fix). Do NOT run full pnpm build.',
  },
  {
    slug: 'E-eval-coverage',
    owns: 'evals/tasks/smoke/*.json (NEW files only) and evals/fixtures/*.html (new if needed)',
    work: [
      'F15: no smoke eval exercises the new layer verbs. ADD new task JSONs under evals/tasks/smoke/ exercising: tab new + tab list (assert two tabs / stable t-ids), network requests (assert captured requests after a page load), memory add + memory search (assert the added note is found), task start + task status (assert run folder / status), subagent list (assert cap 5). Follow the EXISTING task JSON shape (read an existing evals/tasks/smoke/*.json + evals/harness/run.mjs to learn the schema: id, task, start_url, script [[verb,args...]...], expectedPatterns, forbiddenPatterns, enableActions?). Keep them deterministic (use the local fixture server the harness already serves, or example.com). Do NOT modify evals/harness/*.mjs (sibling D owns ab/llm; run.mjs is shared read-only).',
    ],
    verify: 'node ' + REPO + '/evals/harness/run.mjs --suite smoke --k 1 2>&1 | tail -8 (your new tasks must PASS; overall pass_k must stay >= 0.8).',
  },
]

phase('Fix')
const fixResults = await parallel(GROUPS.map((g) => () =>
  agent(
    'You have FULL tool access. IMPLEMENTATION + tests. Apply verified code-review fixes to Silver, a keyless Node/TS browser CLI on Playwright at ' + S + ' (build `pnpm build`, test `pnpm test`, binary `node dist/cli.js`; 207 tests currently green). ' + KEYLESS + '\n\nYOU OWN ONLY: ' + g.owns + '. Do NOT edit files outside your ownership (siblings own them concurrently) — if a fix truly needs a shared file you do not own, note it in your report.\n\nFIXES TO APPLY (each verified against real line numbers — confirm against the code, then apply, add a regression test where noted):\n- ' + g.work.join('\n- ') + '\n\nVERIFY: ' + g.verify + '\nAll pre-existing tests in your area must stay green; your new regression tests must pass.\n\nREPORT: each fix applied (or pushed-back with why), the exact files+lines changed, tests added, your vitest result, concerns. End with STATUS: DONE|DONE_WITH_CONCERNS|BLOCKED.',
    { label: 'fix:' + g.slug, phase: 'Fix', effort: g.slug.startsWith('D') || g.slug.startsWith('E') ? 'medium' : 'high' }
  ).then((r) => ({ slug: g.slug, report: r })).catch((e) => ({ slug: g.slug, report: 'ERROR ' + String(e) }))
))
log('Fix groups done: ' + fixResults.map((r) => r.slug).join(', '))

phase('Integrate')
const integrate = await agent(
  'You have FULL tool access. Five sibling agents just applied file-disjoint code-review fixes to Silver (keyless TS browser CLI at ' + S + '). Now INTEGRATE + gate the merged tree. Run:\n```\ncd ' + S + ' && pnpm build && pnpm test\ncd ' + REPO + ' && node evals/harness/run.mjs --suite smoke --k 1 && node evals/harness/trifecta.mjs && node evals/harness/ab.mjs --suite smoke 2>&1 | tail -6\n```\nIf pnpm build fails (cross-file type mismatch from the disjoint merges) or any test/eval fails, FIX the integration breakage (minimal, correct edits) and re-run until: build clean, ALL tests green, pass_k >= 0.8, trifecta 3/3, ab.mjs runs. Do NOT weaken any test/eval/security assertion — fix the code. ' + KEYLESS + '\nREPORT: the final build/test counts, pass_k, trifecta, ab summary, and any integration fix you made. End with STATUS: DONE|BLOCKED.',
  { label: 'integrate', phase: 'Integrate', effort: 'high' }
)

phase('Verify')
const FINDINGS = [
  'F1 lock.ts: a live-pid lock older than HARD_STALE_MS is NOT stealable (steal only on dead pid or via heartbeat).',
  'F2 subagent.ts: subagentSpawn read-check-write is serialized (lock or atomic wx id reservation) so cap 5 + unique saN id + no duplicate session hold under concurrent same-namespace spawn.',
  'F3 handlers.ts: mouse click / keyboard submit run the paid/destructive confirm gate (isDestructivePaidName) on the target element name.',
  'F4/F8 handlers.ts+session.ts: silver-state.json and dialog.json are AES-GCM encrypted at rest (not plaintext) with legacy-plaintext migration.',
  'F5 actions.ts/handlers.ts: the fill read-back value is redacted for password/secret fields.',
  'F6 handlers.ts: network requests urls are neutralized+capped before return.',
  'F7 handlers.ts: storage whole-store dump values are neutralized+capped.',
  'F9 task/index.ts: checkpoint screenshot uses resolveActivePage (active tab), not pages()[0].',
  'F10 evals: ab.mjs + llm.mjs point at silver/dist/cli.js (not the dead skill/agent-browser path).',
  'F11 flags.ts: --password-stdin dead flag removed.',
  'F12 flags.ts: -u/--urls dead flag removed.',
  'F13 capture.ts: captured entries carry a source field and observer-sourced entries are not presented as authoritative status/method.',
  'F14 prompts.ts: dead ACT_SYSTEM_PROMPT/OBSERVE_SYSTEM_PROMPT removed.',
  'F15 evals/tasks: new smoke tasks cover tab/network/memory/task/subagent and pass.',
]
const V = { type: 'object', additionalProperties: false, required: ['finding', 'verdict', 'evidence'], properties: { finding: { type: 'string' }, verdict: { type: 'string', enum: ['FIXED', 'PARTIAL', 'NOT_FIXED'] }, evidence: { type: 'string', description: 'the file:line you read proving the verdict' }, regression_test: { type: 'boolean', description: 'is there a test locking this fix in?' } } }
const verifms = await parallel(FINDINGS.map((f, i) => () =>
  agent(
    'You have FULL tool access (Read, Grep, Bash). Adversarially VERIFY that this code-review fix was correctly applied to Silver at ' + S + '. Read the ACTUAL current code (the fixes were just applied). Confirm the fix is present AND correct AND (where applicable) covered by a regression test. Default to NOT_FIXED if you cannot find clear evidence.\n\nFINDING #' + (i + 1) + ': ' + f + '\n\nReturn the structured verdict with the real file:line evidence you read.',
    { label: 'verify:F' + (i + 1), phase: 'Verify', schema: V, effort: 'high' }
  ).then((v) => v).catch(() => ({ finding: f, verdict: 'NOT_FIXED', evidence: 'verifier errored' }))
))
const notFixed = verifms.filter((v) => v && v.verdict !== 'FIXED')
log('Verify: ' + (verifms.length - notFixed.length) + '/' + verifms.length + ' FIXED')

return {
  fixGroups: fixResults.map((r) => r.slug),
  integrate,
  verified: verifms.map((v) => ({ finding: v.finding, verdict: v.verdict, test: v.regression_test, evidence: v.evidence })),
  notFixed: notFixed.map((v) => ({ finding: v.finding, verdict: v.verdict, evidence: v.evidence })),
}
