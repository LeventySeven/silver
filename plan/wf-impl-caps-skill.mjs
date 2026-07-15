export const meta = {
  name: 'silver-impl-caps-skill',
  description: 'Implement the verified capability gaps (firefox, <secret> write-path, confirm preview, task compile, doctor probe, download/permission, coordinate verbs, extract shortcut, skill-ref serving) + the world-class SKILL, then integrate + gate.',
  phases: [
    { title: 'Build', detail: '3 file-disjoint agents: core-caps (handlers/session/flags) + action-security (actions/confirm/secret/task) + the SKILL (docs)' },
    { title: 'Integrate', detail: 'full build + test + eval gate; fix cross-file integration; verify' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const S = REPO + '/silver'
const SYN = REPO + '/research/synthesis'
const KEYLESS = 'Silver is 100% KEYLESS (never calls a model; host LLM is the brain). ESM NodeNext .js imports, strict TS, uniform {success,data,error,warning} envelope via mapThrow, no path/secret in error strings, keep the security fences (egress/redaction/injection/confirm/phase-quarantine). Do NOT weaken tests/evals. Do NOT commit. 235 tests are currently green.'

const GROUPS = [
  {
    slug: 'core-caps',
    owns: 'silver/src/core/handlers.ts, silver/src/core/session.ts, silver/src/core/flags.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v2.md (items H1, E4, F2, E2-wiring, B1-dispatch, and the skill-ref serving G5) + the code you own. Implement:\n' +
      '- H1 `--engine firefox|webkit|chromium` (default chromium): session.ts already lazy-loads chromium via loadChromium() — generalize to loadBrowser(engine) selecting playwright.firefox/webkit/chromium; thread `--engine` (flags.ts) into openSession launch. Playwright bundles all three (may need `npx playwright install firefox webkit` — run it). Real fix for TLS/H2-fingerprint sites that fail under Chromium.\n' +
      '- E4 download-detection + permission auto-grant: wire a per-session `page.on(\'download\')` handler that resolves the saved contained path, and a flag-gated `Browser.grantPermissions`/context.grantPermissions on connect (geolocation/clipboard/notifications). In session.ts. (A download VERB already exists; this adds auto-detection of PAGE-initiated downloads + permission prompts so tasks don\'t hang.)\n' +
      '- F2 doctor UX: handleDoctor does a REAL headless launch() + 1x1 screenshot + close probe (not just existsSync), attaches a static `Fix:` string per failed check (errors.ts fixed-string style), returns passed/total.\n' +
      '- E2 confirm-preview WIRING: in the confirm-gate callsite (handleAct), when a paid/destructive action is gated, include a PREVIEW in the envelope — the target accessible name + the form-field values about to submit + any extracted amount — by calling `buildConfirmPreview(...)` from security/confirm.ts (a SIBLING agent adds that function; call it, do not implement it). Keyless (data already in the snapshot/resolve layer).\n' +
      '- B1 coordinate-verb DISPATCH: add `click --at <x> <y>`, `type --at <x> <y> <text>`, `drag --from <x> <y> --to <x> <y>` dispatch cases in handle() (behind --enable-actions) that call the coordinate impls a SIBLING adds in actuation/actions.ts (e.g. `coordClick(page,x,y)`); add the `--at`/`--from`/`--to` numeric flags in flags.ts. The fallback for canvas/custom-widgets with no AX ref.\n' +
      '- G5 skill-ref serving: extend handleSkill so `silver skill <ref>` readFileSync-serves `skill-data/core/reference/<ref>.md` and `silver skill --list` enumerates the reference files (the SKILL sibling creates those files). ~15 lines, keyless.\n' +
      'Add tests for firefox launch (a quick open on firefox), doctor probe, download detection, coordinate click on a canvas fixture, skill --list.',
    verify: 'pnpm exec vitest run tests/integration tests/unit/security.test.ts (your new tests). Do NOT run full pnpm build (siblings write concurrently).',
  },
  {
    slug: 'action-security',
    owns: 'silver/src/actuation/actions.ts, silver/src/security/confirm.ts, silver/src/security/secret.ts (NEW), silver/src/task/index.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v2.md (items E1, E2-builder, B1-impl, F1) + the code you own. Implement:\n' +
      '- E1 `<secret>` write-path indirection (P0 security): NEW security/secret.ts registering secrets from `--secret name=value` / `SILVER_SECRET_<NAME>` env (resolved by the CLI process). In actuation/actions.ts fill/type, resolve `<secret>NAME</secret>` tokens in the value at the SAME choke point redactValue occupies on the read side (symmetric). DOMAIN-SCOPE resolution against the live page URL (a bank.com secret must NOT resolve on evil.com — a ~20-line glob matcher) so injection can\'t exfiltrate. The raw secret never enters the CLI argv/host context. [TEST] a registered <secret> resolves in fill on the matching domain, is refused on a mismatched domain, and never appears in any envelope/error.\n' +
      '- E2 confirm-preview BUILDER: add `buildConfirmPreview({name, formValues, pageText})` to security/confirm.ts returning a structured preview string (target name + about-to-submit field values, redacted for secrets) + `extractAmount(text)` — a local regex over ~24 checkout-total label variants + a decimal-currency pattern — so a paid confirm shows a concrete amount. Keyless (no model). The core-caps sibling calls buildConfirmPreview from handleAct.\n' +
      '- B1 coordinate impls: add `coordClick(page,x,y)`, `coordType(page,x,y,text)`, `coordDrag(page,x1,y1,x2,y2)` to actuation/actions.ts calling page.mouse/page.keyboard directly (bypassing groundRef/toLocator — the escape hatch for AX-less canvas/custom widgets). The core-caps sibling wires the dispatch + flags.\n' +
      '- F1 `task compile <id>` (High value): in task/index.ts, read the task\'s action_log.jsonl, promote literal argument values into named `--flag`s (Webwright # Parameters shape), and emit a runnable shell script of `silver` calls whose defaults reproduce the task verbatim and whose flags let you vary it. The re-runnable script IS the durable artifact. [TEST] compile a task with a couple logged commands -> a runnable .sh with a parameters header.',
    verify: 'pnpm exec vitest run tests/unit/security.test.ts tests/unit/subagent.test.ts tests/unit/task.test.ts tests/integration/actions.test.ts (your new tests). Do NOT run full pnpm build.',
  },
  {
    slug: 'skill',
    owns: 'silver/SKILL.md (stub), silver/skill-data/core/SKILL.md, silver/skill-data/core/examples.md, NEW silver/skill-data/core/reference/*.md, NEW silver/commands/*.md, NEW silver/skill-data/evals/evals.json',
    body: 'Read ' + SYN + '/skill-design.md (the FULL world-class spec) + the current silver/skill-data/core/SKILL.md + examples.md. Implement the spec WITH the red-team leaning: keep core SKILL.md LEAN (<=400 lines; REPLACE prose, do not grow to 480), progressive disclosure (core + reference/{taxonomy,security,extract,tasks,agents-memory}.md, each <=200 lines with a ToC), but do NOT over-split — only create the reference files the spec justifies. Implement: the ToC on core + examples (D5); the 3-tier stub with the dual-serve sentence + prefer-silver clause + trigger phrases (§4,§6); the decision matrix + 5-mode taxonomy + decomposition rule (§7) INLINE in core; the web-task-correctness Hard Rules (G4) + red-flags self-recognition table (§9.1) + ordering-constraint sentence (§9.2) + explicit untrusted-content sentence (§9.3) + sub-agent skill-inheritance warning (§9.4) + justified constants (§9.5) + the 6-bullet core hard-rules summary (§9.6, full text in reference/security.md); the commands/{quick,task,parallel,extract}.md dispatchers (§11); document `--urls`/`-u` (new engine flag) + `--engine firefox` in the command tables; and skill-data/evals/evals.json with the >=5 scenarios (§12, incl a should-NOT-trigger). CRITICAL HONESTY: cut the FICTIONAL `daemon --session` verb from the decision matrix (it does NOT exist) and any other verb that is not in the real dispatch — cross-check every documented verb against silver/src/core/handlers.ts + registry.ts + cli.ts. Every example copied from REAL `node dist/cli.js` output.',
    verify: 'node ' + S + '/dist/cli.js skill --full | head -30 (serves core). Cross-check every documented verb exists in the dispatch (grep src). No full build needed.',
  },
]

phase('Build')
const built = await parallel(GROUPS.map((g) => () =>
  agent('You have FULL tool access. IMPLEMENTATION + tests. ' + KEYLESS + '\n\nYOU OWN ONLY: ' + g.owns + '. Do NOT edit files outside your ownership (siblings own them concurrently); coordinate cross-calls via the exact function names given. Repo product at ' + S + '.\n\n' + g.body + '\n\nVERIFY: ' + g.verify + ' All pre-existing tests in your area stay green.\n\nREPORT: what you built, files+lines changed, tests added, the exact function signatures a sibling must call (for merge), deviations, concerns. End: STATUS: DONE|DONE_WITH_CONCERNS|BLOCKED.',
    { label: 'build:' + g.slug, phase: 'Build', effort: 'high' }).then((r) => ({ slug: g.slug, r })).catch((e) => ({ slug: g.slug, r: 'ERROR ' + e }))))
log('Build: ' + built.map((b) => b.slug).join(', '))

phase('Integrate')
const integrate = await agent('You have FULL tool access. Three sibling agents applied file-disjoint capability + SKILL changes to Silver (keyless TS CLI at ' + S + '). INTEGRATE + gate:\n```\ncd ' + S + ' && pnpm build && pnpm test\ncd ' + REPO + ' && node evals/harness/run.mjs --suite smoke --k 1 && node evals/harness/trifecta.mjs\n```\nFix any cross-file integration break (the core-caps sibling calls security/confirm.ts buildConfirmPreview + actuation/actions.ts coordClick/coordType/coordDrag; the skill sibling\'s reference files are served by handleSkill — verify the wiring lines up; add `npx playwright install firefox webkit` if a firefox test needs it). Re-run until build clean, ALL tests green, pass_k >= 0.8, trifecta 3/3. Do NOT weaken any test/eval/security assertion. ' + KEYLESS + '\nREPORT final build/test counts, pass_k, trifecta, integration fixes, and any documented verb in the SKILL that does NOT exist in the dispatch (flag it). End: STATUS: DONE|BLOCKED.',
  { label: 'integrate', phase: 'Integrate', effort: 'high' })

return { built: built.map((b) => b.slug), integrate }
