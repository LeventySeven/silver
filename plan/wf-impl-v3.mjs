export const meta = {
  name: 'silver-impl-v3',
  description: 'Implement verified adopt-list-v3 P0/P1: S2 Fetch-layer egress (security hole), E6 cross-origin iframe AX, E2 --profile, D2 TOTP, D6 cookie-fetch, AC1 expect, R2/R3 detectors, S1/S3/S4 security, T1/T2/T3 durable tasks. Integrate + adversarially verify.',
  phases: [
    { title: 'Build', detail: '4 file-disjoint agents: session-security, handlers-verbs, perception-iframe, task-durable' },
    { title: 'Integrate', detail: 'full build + test + eval gate; fix cross-file; verify' },
    { title: 'Verify', detail: 'adversarial per-item verification incl the S2 exfil fixture' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/Silver'
const S = REPO + '/silver'
const SYN = REPO + '/research/synthesis'
const KEYLESS = 'Silver is 100% KEYLESS (never calls a model). ESM NodeNext .js imports, strict TS, envelope+mapThrow, no path/secret in error strings, keep all security fences. Do NOT weaken tests/evals. Do NOT commit. 280 tests currently green.'

const GROUPS = [
  {
    slug: 'session-security',
    owns: 'silver/src/core/session.ts, silver/src/security/egress.ts, silver/src/security/injection.ts, NEW silver/src/security/totp.ts, NEW silver/src/security/taint.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v3.md (S2,E2,D2,S1,S3) + ' + SYN + '/adopt-list-v3-redteam.md + the code you own. Implement:\n' +
      '- **S2 (P0 SECURITY HOLE): CDP Fetch-layer egress.** Verified ABSENT: egress guards top-level navigation only, so a page on an allowed domain can beacon/exfil to ANY host via subresource fetch()/<img>/XHR — Silver\'s documented exfil hardening is a FALSE security property. FIX: on session connect, enable CDP `Fetch.enable` (requestPaused) and, for each paused SUBRESOURCE request, enforce the SAME egress policy assertNavigable uses (deny file:/data:/blob:/non-http(s) + the known-dangerous/IP-literal denylist; if --allowed-domains is set, restrict subresources to allowed hosts too) — `Fetch.failRequest(BlockedByClient)` on deny, else `Fetch.continueRequest`. Do NOT block normal same-origin/CDN subresources when no allowlist is set (match the nav denylist default). Wire it in session.ts on the CDP session; make it robust to the per-command reconnect (re-enable on each connect). [TEST] with --allowed-domains set, a subresource fetch to a non-allowed host is blocked; with no allowlist, a normal page still loads; file:/metadata subresource always blocked. This is the top priority — land it correctly.\n' +
      '- **E2: `--profile <path>` real-Chrome-profile launch.** Add a flag to launch the browser against an EXISTING user-data-dir (the user\'s logged-in Chrome profile) instead of a throwaway one — the truest keyless auth (no credential ever enters Silver). Thread into openSession launch (persistent context). Document the isolation trade-off. [TEST] launching with --profile pointing at a temp profile dir reuses it.\n' +
      '- **D2: TOTP helper (RFC-6238, pure node:crypto, keyless).** NEW security/totp.ts: `totp(secretBase32, {t, digits=6, period=30})` HMAC-SHA1 per RFC-6238. Expose a `<totp>NAME</totp>` resolution alongside the <secret> mechanism (register a TOTP seed via --secret/env, resolve to the current 6-digit code at fill time, domain-scoped). The #1 MFA blocker. [TEST] a known RFC-6238 test vector produces the expected code.\n' +
      '- **S1 (opt-in): CaMeL-lite taint guard.** A keyless data-provenance guard reusing the ⟦untrusted⟧ fence: track that a value came from page content; when such a tainted value would be used as an action target/argument in a security-sensitive spot, warn. MUST be OPT-IN (--taint-guard) — default-on false-positives on legitimate page->resubmit flows (red-team). Small module in injection.ts or taint.ts. [TEST] tainted value flagged only when opt-in.\n' +
      '- **S3: filename chokepoint.** Extend assertContainedPath / the download-save path so a server-suggested filename with traversal/absolute components is sanitized to a safe basename within the contained dir. [TEST] a "../../../etc/x" suggested filename is contained.',
    verify: 'pnpm exec vitest run tests/unit/security.test.ts tests/integration/session.test.ts (+ your new totp/egress tests). Do NOT run full pnpm build.',
  },
  {
    slug: 'handlers-verbs',
    owns: 'silver/src/core/handlers.ts, silver/src/core/flags.ts, silver/src/security/registry.ts, silver/src/security/confirm.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v3.md (AC1,R2,R3,D6,S4) + the code you own. Implement:\n' +
      '- **AC1 (marquee trust primitive): `expect` / `--verify`.** A deterministic assertion verb collapsing "did it actually work?" into one call. `silver expect <ref|selector> <matcher> [value]` where matcher ∈ visible|hidden|enabled|checked|text-contains|value-equals|count|url-matches|title-contains — returns success:true only if the assertion holds, else a clear failure (with the actual vs expected). Read-only (registry). Add to handle() dispatch + registry READ_ONLY_VERBS. This is the "verify the goal, not just success:true" primitive the SKILL preaches. [TEST] expect on a present/absent element passes/fails correctly.\n' +
      '- **R2/R3: CAPTCHA + auth-wall DETECTION (emit the defined-but-unemitted codes).** captcha_detected and auth_required are declared in errors.ts but NEVER emitted. After navigation/snapshot, run a cheap keyless heuristic: CAPTCHA = known iframe src/host globs (recaptcha/hcaptcha/turnstile) or role/name signals; auth-wall = a login form + a redirect to /login|/signin + 401/403 signals. When detected on a read/act, surface the code (captcha_detected = detect-and-handback, NOT solve; auth_required = load state/cookies or use --profile). Wire as a warning/flag on snapshot + a hard signal where appropriate. [TEST] a fixture with a recaptcha iframe -> captcha_detected; a login-wall fixture -> auth_required.\n' +
      '- **D6: cookie-authenticated `read` fetch.** The `read <url>` browser-free fetch does NOT send the session\'s cookies today. Add: when a session exists, attach that session\'s cookies (via the browser context cookies) to the fetch Cookie header, so `read` can hit authenticated site APIs/pages cheaply (order-of-magnitude cheaper than snapshot+click). Still egress-guarded + neutralized. [TEST] read with a session that has a cookie sends it.\n' +
      '- **S4: `confirm`/`deny` two-phase gate (fix fail-closed feature-death on non-TTY).** Today a paid/destructive action on non-TTY without --confirm-actions is hard-denied (confirm_required) with no way to proceed in an automated loop except pre-approving by name. Add a two-phase protocol: the gated command returns `status:"requires_confirmation"` with a confirmation_id + the preview; a follow-up `silver confirm <id>` (or `deny <id>`) proceeds/aborts. This lets a host approve in-loop without pre-listing verbs, while keeping the human/host in the loop. Keep the existing --confirm-actions fast path. [TEST] a gated buy returns requires_confirmation + id; confirm <id> proceeds; deny aborts.',
    verify: 'pnpm exec vitest run tests/unit/security.test.ts tests/integration/verbs.test.ts (+ your new tests). Do NOT run full pnpm build.',
  },
  {
    slug: 'perception-iframe',
    owns: 'silver/src/perception/walk.ts, silver/src/actuation/resolve.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v3.md (E6) + walk.ts (current iframe splicing: same-process child frames via Accessibility.getFullAXTree({frameId})) + resolve.ts. Implement:\n' +
      '- **E6: cross-origin (OOPIF) iframe AX.** Verified: Silver splices SAME-PROCESS child frames but CROSS-ORIGIN out-of-process iframes (OOPIFs) are invisible today — the exact unresolved bug in the vercel-labs repo Silver forked from — which makes Stripe/OAuth/checkout/embedded-widget iframes (a huge real-world class) un-perceivable and un-actable. FIX: use CDP `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:false})` (+ Target.getTargets / the attachedToTarget events) to reach OOPIF frame sessions, snapshot each OOPIF frame\'s AX tree, and splice it inline under its host iframe ref line just like same-process frames (frame-prefixed refs, real frameId in RefEntry). In resolve.ts, ensure ref resolution works into an OOPIF frame (locate within the right frame/target). Bound recursion; swallow errors gracefully. [TEST] a page embedding a CROSS-ORIGIN iframe with a button -> the button gets a ref and is clickable inside the OOPIF.',
    verify: 'pnpm exec vitest run tests/integration/iframe.test.ts tests/integration/walk.test.ts (+ your new OOPIF test). Do NOT run full pnpm build.',
  },
  {
    slug: 'task-durable',
    owns: 'silver/src/task/index.ts, silver/src/task/store.ts, and their tests',
    body: 'Read ' + SYN + '/adopt-list-v3.md (T1,T2,T3) + the task code you own (task compile already exists from v2). Implement:\n' +
      '- **T1: variable auto-detection in `task compile`.** When compiling the action_log into a re-runnable script, auto-detect the literal argument values that vary run-to-run (urls, search terms, filled values, credentials-as-secrets) and promote them to named `--flag` parameters with a `# Parameters` header (Webwright shape) — so the emitted script is a parameterized macro, not a verbatim replay. Improve the existing task compile. [TEST] a task with a filled search term compiles to a script with a --flag for it.\n' +
      '- **T2 (P0): run manifest.** Write a `manifest.json` in the run folder capturing {task id, goal, start/end, verb count, outcome, checkpoint refs, the compiled-script path, silver version} — a machine-readable index of the run for `task list`/`status`/resume + external tooling. [TEST] a run produces a manifest.json with the expected fields.\n' +
      '- **T3: verb-sequence DOM-hash replay cache.** Record, per compiled task, a DOM-fingerprint (reuse the pagechange fingerprint / a DOM hash) at each step; on replay, if the DOM-hash matches the recorded one, the recorded ref/selector is known-good and the step can replay deterministically WITHOUT a host round-trip; on mismatch, fall back to fresh snapshot+host (self-heal). Keyless (no model). Store the cache in the run folder. [TEST] a replay with matching DOM-hash reuses the cached step; a mismatch triggers fallback.',
    verify: 'pnpm exec vitest run tests/unit/task.test.ts (+ your new tests). Do NOT run full pnpm build.',
  },
]

phase('Build')
const built = await parallel(GROUPS.map((g) => () =>
  agent('You have FULL tool access. IMPLEMENTATION + tests. ' + KEYLESS + '\n\nYOU OWN ONLY: ' + g.owns + '. Do NOT edit files outside your ownership (siblings own them concurrently). Repo product at ' + S + '.\n\n' + g.body + '\n\nVERIFY: ' + g.verify + ' Pre-existing tests in your area stay green.\n\nREPORT: what you built, files+lines, tests added, any function a sibling must call (signature), deviations, concerns. End: STATUS: DONE|DONE_WITH_CONCERNS|BLOCKED.',
    { label: 'build:' + g.slug, phase: 'Build', effort: 'high' }).then((r) => ({ slug: g.slug, r })).catch((e) => ({ slug: g.slug, r: 'ERROR ' + e }))))
log('Build: ' + built.map((b) => b.slug).join(', '))

phase('Integrate')
const integrate = await agent('You have FULL tool access. Four siblings applied file-disjoint v3 changes to Silver (keyless TS CLI at ' + S + '). INTEGRATE + gate:\n```\ncd ' + S + ' && pnpm build && pnpm test\ncd ' + REPO + ' && node evals/harness/run.mjs --suite smoke --k 1 && node evals/harness/trifecta.mjs\n```\nFix any cross-file integration break; re-run until build clean, ALL tests green, pass_k >= 0.8, trifecta 3/3. Do NOT weaken any assertion. ' + KEYLESS + '\nREPORT final counts, pass_k, trifecta, integration fixes, and confirm the new verbs (expect, confirm/deny) + flags are wired into dispatch+registry+SKILL-safe. End: STATUS: DONE|BLOCKED.',
  { label: 'integrate', phase: 'Integrate', effort: 'high' })

phase('Verify')
const CHECKS = [
  'S2: with --allowed-domains set, a SUBRESOURCE fetch/img to a non-allowed host is BLOCKED at the CDP Fetch layer (not just navigation); file:/metadata subresource always blocked; a normal page with no allowlist still loads. This closes a real exfil hole — verify it actually blocks, with a test.',
  'E6: a page embedding a CROSS-ORIGIN (OOPIF) iframe with a button -> the button gets a ref in the snapshot and is clickable inside the OOPIF (Target.setAutoAttach path). Verify against real code + a test.',
  'E2: --profile launches against an existing user-data-dir (reuses it). D2: TOTP produces the RFC-6238 test-vector code and <totp> resolves domain-scoped.',
  'AC1: expect verb asserts visible/text/count/etc deterministically and is read-only in the registry.',
  'R2/R3: captcha_detected + auth_required are now EMITTED by detection heuristics (were defined-but-unused). Verify with fixtures.',
  'D6: read attaches the session cookies to the fetch. S4: a gated paid action returns requires_confirmation + id, and confirm/deny proceed/abort.',
  'T1/T2/T3: task compile auto-detects variables into --flags; a run writes manifest.json; replay reuses a step on DOM-hash match and falls back on mismatch.',
]
const V = { type: 'object', additionalProperties: false, required: ['item', 'verdict', 'evidence'], properties: { item: { type: 'string' }, verdict: { type: 'string', enum: ['DONE', 'PARTIAL', 'MISSING'] }, evidence: { type: 'string' }, test: { type: 'boolean' } } }
const ver = await parallel(CHECKS.map((c, i) => () =>
  agent('You have FULL tool access (Read, Grep, Bash). Adversarially VERIFY this v3 item is correctly implemented + tested in Silver at ' + S + '. Read the ACTUAL current code. Default to MISSING without clear evidence.\n\nITEM #' + (i + 1) + ': ' + c + '\n\nReturn the structured verdict with real file:line evidence.',
    { label: 'verify:v3-' + (i + 1), phase: 'Verify', schema: V, effort: 'high' }).then((v) => v).catch(() => ({ item: c, verdict: 'MISSING', evidence: 'verifier errored' }))))
const bad = ver.filter((v) => v && v.verdict !== 'DONE')
log('Verify: ' + (ver.length - bad.length) + '/' + ver.length + ' DONE')
return { built: built.map((b) => b.slug), integrate, verified: ver, notDone: bad }
