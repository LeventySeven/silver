# Implementation Plan — `uab` (Ultimate Agent-Browser) — 2026-07-15

Executes `docs/specs/2026-07-15-ultimate-agent-browser.md`. Built by `compound-v:batched-implementation`
(parallel, file-disjoint agents where marked).

## Preamble (every implementer inherits this)

**Goal:** a keyless Node/TS CLI (`uab`) on Playwright — an `agent-browser`-compatible superset — that lets
a sub-agent `open → snapshot → act → re-snapshot → done` on live pages with `@ref` grounding, ID-grounded
extract, diff-as-observation, and security that closes the lethal trifecta by default.

**Done = (plan-level, machine-checkable):**
```
cd skill/agent-browser && pnpm build && pnpm test          # unit+integration green
node ../../evals/harness/run.mjs --suite smoke --k 3        # pass_k ≥ 0.8 on smoke tasks
node ../../evals/harness/trifecta.mjs                       # 3/3 trifecta tests pass on DEFAULT flags
```

**Approach:** TypeScript (ESM, strict), Playwright is the ONLY browser dependency and the ONLY actuation
engine — we reimplement none of it. Persistence model = **browser-as-daemon**: `open` spawns a *detached*
Playwright-Chromium with `--remote-debugging-port=<port>` + a per-session `--user-data-dir`; every later
command `chromium.connectOverCDP('http://127.0.0.1:<port>')`, does its work, disconnects. Cross-command
state (RefMap + generation + endpoint) lives in a JSON **session sidecar** under
`~/.uab/sessions/<name>/`. Refs re-resolve across commands via CDP `DOM.resolveNode({backendNodeId})`.
Tests: **vitest**. The host LLM is the brain; the CLI never calls a model.

**Global constraints (each task must honor; a fresh implementer sees only its own task):**
- Node ≥ 24, TS strict, ESM (`"type":"module"`). Playwright `^1.61`. No other runtime browser dep.
- **KEYLESS:** zero model/provider calls anywhere in `src/`. Enforced by `tests/unit/keyless.test.ts`
  (greps `src/` for provider SDKs / `api.openai.com|api.anthropic.com|googleapis` — must find none).
- **No leak:** no filesystem path or secret substring may appear in any `error`/`warning` string
  (`tests/unit/no-leak.test.ts`).
- **Grounding:** every ref-taking command passes through `groundRef()` (§Task 3) before any action.
- Binary name **`uab`** (Vercel's `agent-browser` is installed on PATH — never collide). Package
  `agent-browser` (private). Our code is **MIT**; ship a `NOTICE` crediting adapted patterns from
  vercel-labs/agent-browser (Apache-2.0), browserbase/stagehand (MIT), browser-use/browser-use (MIT).
- Uniform response envelope `{success,data,error,warning?}` on every command; never throw into the CLI
  top-level (catch → envelope). `--json` prints the envelope; default prints the human form.
- Snapshot grammar is fixed (§Task 6); SKILL.md examples are byte-checked against live output (§Task 15).

**Research fold-in (real anchors the implementer should copy, not re-derive):**
- `@eN` RefMap + `parseRef` (accept `@e12|ref=e12|e12`): adapt `reference/agent-browser/cli/src/native/
  element.rs:18-147` and `snapshot.rs:371-417`. Role allowlists verbatim: `snapshot.rs:11-62`
  (INTERACTIVE/CONTENT/STRUCTURAL). Snapshot line format + `--compact` (keep `ref=`/`: value` + ancestors):
  `snapshot.rs:1075-1247`. Response envelope: `connection.rs:24-40`.
- Interactive heuristic cascade (layered, early-exit): browser-use `reference/browser-use` dom serializer
  (`serializer.py` / dom watchdog) — JS click-listener → native tags → ARIA → label-wrapper → icon-size →
  `cursor:pointer` (suppress *inherited* pointer). Selector-map = `backendNodeId` (`serializer.py:713`).
- ID-grounded extract: Stagehand `reference/stagehand` `transformSchema`/`makeIdStringSchema` +
  `injectUrls` — swap `url` fields → `^\d+-\d+$` ID fields; reverse-map after. Verbatim extract/observe
  prompts already captured in `src/bad_research/browse/agent_browser.py:271-299` (copy those constants).
- Diff-when-shorter + never-truncate + W3C accessible-name + off-screen radio/checkbox keep + password
  redaction at serializer choke point: `research/sources/aside-03-perception-snapshot.md`,
  `aside-04-actuation-webright.md`. Security defaults + trifecta + forged-tag neutralization:
  `research/sources/aside-05-security-guardrails.md`, `perplexity-computer.md`, and red-team §7.
- **Canonical vs anti-pattern to bake in** (`compound-v:searching-patterns` result, red-team S1/S5/S6):
  ref grounding MUST be `string ∈ refmap AND generation == current` (anti-pattern: string-membership only
  → silent wrong-click); egress default = **denylist** (anti-pattern: empty allowlist → bricks every task);
  `file:`/`data:`/`blob:` = **flat default deny** (anti-pattern: conditional "reachable-from-untrusted" —
  un-checkable at runtime).

**Divergence rule:** if a load-bearing assumption proves false (e.g. Playwright `page.accessibility` /
CDP `Accessibility.getFullAXTree` can't expose `backendNodeId` per node, or detached-CDP reconnect is
unstable), STOP after ~3 attempts and report back with the concrete failure — do not improvise a different
architecture in code. The fallback (raw CDP `Accessibility.getFullAXTree` + `DOM.getDocument`) is
pre-authorized; anything beyond it needs a plan revision.

**⚠️ User Review Required (surface before autonomous prod use):** the actor phase can act on live sites,
use imported cookies/credentials, and reach checkout/payment flows. Default is **read-only**; actor verbs
require `--enable-actions` and destructive/paid verbs require the confirm gate. Real-site *acting* evals
(vs. read-only/fixture evals) should be human-reviewed before running unattended. The CLI spawns detached
browser processes (cleaned up by `uab close`/idle-timeout). No writes outside `~/.uab/` and an explicit
`--download-path`.

---

## Batch A — Foundation (serial; shared by all later tasks)

### Task 1: Package scaffold + prove Playwright launches (riskiest-first: toolchain)
**Files:** `[NEW] skill/agent-browser/package.json`, `tsconfig.json`, `vitest.config.ts`,
`src/index.ts`, `tests/unit/smoke.test.ts`, `NOTICE`, `LICENSE`.
- [ ] `package.json`: `"type":"module"`, `bin:{"uab":"./dist/cli.js"}`, deps `playwright@^1.61`,
      devDeps `typescript vitest @types/node tsx`, scripts `build:"tsc -p ."`, `test:"vitest run"`,
      `dev:"tsx src/cli.ts"`. `tsconfig`: `strict`, `module:"NodeNext"`, `outDir:"dist"`, `rootDir:"src"`.
- [ ] `tests/unit/smoke.test.ts`: assert `import { chromium } from 'playwright'` resolves and
      `chromium.executablePath()` is a non-empty string. Run `pnpm test` → PASS.
- [ ] `LICENSE` = MIT; `NOTICE` = adapted-pattern credits (see constraints).
- [ ] Commit: `feat(uab): scaffold package + toolchain`.
- **Est:** 1h.

### Task 2: Response envelope + typed error taxonomy → recovery table
**Files:** `[NEW] src/core/envelope.ts`, `src/core/errors.ts`, `[TEST] tests/unit/errors.test.ts`.
- [ ] `envelope.ts`: `type Envelope<T> = {success:boolean, data:T|null, error:string|null, warning?:string}`;
      `ok(data,warning?)`, `fail(code, ctx?)` (builds sanitized message from the table — never interpolates
      raw paths/secrets), `print(env, json:boolean)`.
- [ ] `errors.ts`: exact table (red-team S7) — each `{code, retryableByHost:boolean, message:string}`:
      ```ts
      export const ERRORS = {
        ref_stale:         {retryableByHost:true,  message:"refs are stale (a new snapshot was taken or the page changed); run `snapshot` again and retry with fresh refs"},
        element_not_found: {retryableByHost:true,  message:"no element matches that ref/selector; re-snapshot and pick a ref from the current tree"},
        element_obscured:  {retryableByHost:true,  message:"another element covers the target; re-snapshot, scroll it into view, or pass --force"},
        timeout:           {retryableByHost:true,  message:"the element/condition did not become ready in time; re-snapshot or increase --timeout"},
        navigation_blocked:{retryableByHost:false, message:"navigation to that target is denied by policy (scheme/host not allowed); not retryable"},
        captcha_detected:  {retryableByHost:false, message:"a CAPTCHA was detected; human action is required — this agent does not solve CAPTCHAs"},
        page_crash:        {retryableByHost:true,  message:"the page crashed; run `reload` then re-snapshot"},
        auth_required:     {retryableByHost:false, message:"the page requires authentication; load a saved state (`state load`) or cookies (`cookies set --curl`)"},
        not_permitted:     {retryableByHost:false, message:"that action is not enabled in the current phase; the session is read-only (pass --enable-actions to allow acting)"},
      } as const
      ```
- [ ] `errors.test.ts`: every code has non-empty message; `fail("navigation_blocked", {host:"/Users/secret"})`
      output contains neither `/Users` nor `secret`. Run → PASS. Commit `feat(uab): envelope + error taxonomy`.
- **Est:** 2h.

### Task 3: RefMap + parseRef + generation grounding gate (the correctness core, red-team S1/R4)
**Files:** `[NEW] src/perception/refmap.ts`, `[TEST] tests/unit/refmap.test.ts`.
- [ ] Types + functions:
      ```ts
      export type RefEntry = {generation:number, backendNodeId:number, role:string, name:string, nth:number, frameId:string}
      export type RefMap = {generation:number, entries:Record<string, RefEntry>}  // key = "e12" (bare)
      export function parseRef(s:string):string|null   // "@e12"|"ref=e12"|"e12" -> "e12"; else null
      export function groundRef(map:RefMap, raw:string):{ok:true, entry:RefEntry, ref:string}|{ok:false, code:"ref_stale"|"element_not_found"}
      // groundRef: r=parseRef(raw); if r not in map.entries -> element_not_found;
      //            if map.entries[r].generation !== map.generation -> ref_stale; else ok.
      export function newGeneration(prev:number):number  // prev+1
      ```
- [ ] `refmap.test.ts` (the landmine tests): (a) `parseRef` accepts all three forms, rejects `foo`,
      `e`, `e1x`; (b) grounding passes for a current-generation ref; (c) **a ref whose generation ≠ map
      generation → `ref_stale` even if the string key still exists** (the silent-wrong-click guard);
      (d) unknown string → `element_not_found`. Run → PASS. Commit `feat(uab): refmap + grounding gate`.
- **Est:** 2h.

---

## Batch B — Perception (parallel after A; file-disjoint)

### Task 4: Session lifecycle — detached Chromium + CDP reconnect + sidecar (LOAD-BEARING)
**Files:** `[NEW] src/core/session.ts`, `[TEST] tests/integration/session.test.ts`.
- [ ] `session.ts`: `openSession(name, {headed,userDataDir,port})` → spawn `chromium.executablePath()`
      **detached** (`child.unref()`) with `--remote-debugging-port=<port>` `--user-data-dir=<dir>`
      `--no-first-run --no-default-browser-check` (+ stealth: never `--enable-automation`); poll
      `http://127.0.0.1:<port>/json/version` until ready (≤8s); write sidecar `~/.uab/sessions/<name>/
      session.json = {port, pid, wsEndpoint, createdAt}`. `connect(name)` → read sidecar,
      `chromium.connectOverCDP(wsEndpoint)`, return `{browser, context, page}` (first context/page).
      `saveRefMap(name, map)` / `loadRefMap(name)` → `refmap.json`. `closeSession(name)` → connect, close,
      `process.kill(pid)`, rm sidecar. Idle-timeout param recorded for later.
- [ ] `session.test.ts` (real Chromium): open a session, connect from a *separate* call, `page.goto`
      a `data:text/html,<h1>hi</h1>` (allowed in tests via flag), read title "hi", close. Assert the
      detached browser survived between the two connects. Run → PASS. Commit `feat(uab): session persistence`.
- **Est:** 4h. **Risk: high — build/validate this before breadth.**

### Task 5: Snapshot builder — AX walk → nodes + accessible name + interactive cascade
**Files:** `[NEW] src/perception/roles.ts`, `src/perception/accessible-name.ts`,
`src/perception/walk.ts`, `[TEST] tests/unit/roles.test.ts`, `tests/integration/walk.test.ts`.
- [ ] `roles.ts`: `INTERACTIVE_ROLES`, `CONTENT_ROLES`, `STRUCTURAL_ROLES` sets (copy verbatim from
      `reference/agent-browser/cli/src/native/snapshot.rs:11-62`).
- [ ] `walk.ts`: `snapshotNodes(cdp, {interactive,maxDepth,selectorScope})` → uses CDP
      `Accessibility.getFullAXTree` + `DOM.getDocument(depth:-1,pierce:true)` joined by `backendNodeId`;
      returns `Node[]` `{backendNodeId, role, name, value, level, flags, frameId, cursorInteractive}`.
      Ref-eligibility: interactive always; content iff named; structural never; plus cursor-interactive
      (inject one `page.evaluate` scan: JS click-listener via getEventListeners → native tags → ARIA →
      label-wrapper(≤2) → icon-size(10-50px)+class/aria → `cursor:pointer` **suppressing inherited**;
      bail >10k els). Depth increments only on *included* nodes (50 semantic levels). Off-viewport kept;
      `display:none/visibility:hidden/opacity:0` pruned EXCEPT off-screen radio/checkbox.
      `accessible-name.ts`: W3C algo (aria-labelledby→aria-label→`<label>`→alt→name-from-content incl.
      `::before/::after`), ≤100 chars, escaped.
- [ ] Tests: `roles.test.ts` set membership; `walk.test.ts` (fixture HTML) — a `<button>Go</button>`,
      a `<div onclick>` (cursor-interactive → ref-eligible), a `<p>` (not), an off-screen `<input
      type=checkbox checked>` (kept). Run → PASS. Commit `feat(uab): ax-tree walker + accessible name`.
- **Est:** 6h.

### Task 6: Serializer — line format + redaction + compact + never-truncate (+ golden tests)
**Files:** `[NEW] src/perception/serialize.ts`, `src/security/redact.ts`,
`[TEST] tests/unit/serialize.test.ts`.
- [ ] `serialize.ts`: `render(nodes, refmap, {compact,maxChars,filtered})` → lines
      `- <role> "<name>" [ref=eN, level=N, checked=B, …]: <value>` (2-space indent per semantic level;
      attrs only when present; RootWebArea skipped, empty generic ≤1-child collapsed). Header
      `- title: "…" [url=…, generation=N]`; `# note:` when filtered. `--compact` keeps `ref=`/`: value`
      lines + ancestor chain. **Never truncate:** on `maxChars` overflow return `fail("output_overflow"…)`
      naming `-d/-s/ref` escape hatches (add that code to §Task 2 table during this task).
- [ ] `redact.ts`: `redactValue(role, name, rawValue)` → `[redacted]` for `input[type=password]` and
      card-shaped values (`\b(?:\d[ -]?){13,19}\b`). Called at the serializer choke point.
- [ ] `serialize.test.ts`: golden fixture (nodes → exact expected text); password node → `[redacted]`;
      compact drops structural-only lines; overflow → error not truncation. Run → PASS. Commit
      `feat(uab): snapshot serializer + redaction`.
- **Est:** 5h.

### Task 7: Diff-when-shorter observation
**Files:** `[NEW] src/perception/diff.ts`, `[TEST] tests/unit/diff.test.ts`.
- [ ] `diff.ts`: `observe(prevTree:string|null, tree:string)` → `{tree, diff, output}` where `diff` =
      git-style unified `@@` hunks (Myers O(ND) line diff); `output = prev===null ? tree :
      (identical ? "No changes detected" : (diff.length < tree.length ? diff : tree))`. Mark new lines
      with `*` prefix.
- [ ] `diff.test.ts`: identical → sentinel; small change → diff shorter than full; huge change → returns
      full tree (diff longer); `*` marks appear on added lines. Run → PASS. Commit `feat(uab): diff-as-observation`.
- **Est:** 3h.

---

## Batch C — Actuation (after B; delegates to Playwright)

### Task 8: Ref→Locator resolution + actions + wait + page-change flag
**Files:** `[NEW] src/actuation/resolve.ts`, `src/actuation/actions.ts`, `src/actuation/wait.ts`,
`src/actuation/pagechange.ts`, `[TEST] tests/integration/actions.test.ts`.
- [ ] `resolve.ts`: `toLocator(page, cdp, entry:RefEntry)` → fast path CDP `DOM.resolveNode(
      {backendNodeId})` → JSHandle → `page.locator` via `evaluateHandle`; on miss, bounded (≤5000)
      re-match by `(role, accessibleName, nth)`. Never cache a handle across commands.
- [ ] `actions.ts`: `click|dblclick|hover|focus|fill|type|press|select|check|uncheck|scroll|upload|drag`
      — each resolves the ref (via `groundRef`+`toLocator`) then calls the matching Playwright `Locator`
      method (Playwright owns actionability/occlusion/auto-wait). `fill`: `.fill()` then re-read `.value`;
      mismatch → `pressSequentially` fallback. `find role|text|label|placeholder|testid|first|last|nth`
      maps to `page.getByRole/getByText/...` (no prior snapshot needed).
- [ ] `wait.ts`: `wait <selector|@ref>|<ms>|--text|--url|--load|--fn` ranked; bare-ms documented as last
      resort. `pagechange.ts`: `fingerprint(page)` = `url + focusedBackendId + domLength` after a settle
      (Playwright `waitForLoadState('domcontentloaded')` + short network-idle race); every action response
      carries `{generation, page_changed, stale_refs}` — **flag only, never auto-embed a new tree**.
- [ ] `actions.test.ts` (fixture): snapshot → `fill @eN` a text input → value set; `click @eN` a button
      that mutates DOM → response `page_changed:true, stale_refs:true`; **click a ref from generation N
      after re-snapshot (gen N+1) → `ref_stale`, no misclick** (red-team R4). Run → PASS. Commit
      `feat(uab): actuation via Playwright + page-change flag`.
- **Est:** 6h.

---

## Batch D — Security (after A; mostly file-disjoint from B/C)

### Task 9: Egress denylist + injection neutralizer + phase-quarantine registry + confirm gate
**Files:** `[NEW] src/security/egress.ts`, `src/security/injection.ts`, `src/security/registry.ts`,
`src/security/confirm.ts`, `[TEST] tests/unit/security.test.ts`.
- [ ] `egress.ts`: `assertNavigable(url, {allowFile, allowedDomains})` — deny `file:`/`data:`(top-level)/
      `blob:`/`view-source:`/non-http(s) unless `allowFile` (only lifts `file:`); if `allowedDomains`
      set, host must `endsWith("."+d) || ===d` (suffix, never substring); deny raw-IP + a small
      known-dangerous host list. Returns `navigation_blocked` on deny.
- [ ] `injection.ts`: `neutralize(pageOutput)` → regex-strip `</?(system|user|tool|assistant)>` and
      `<untrusted[^>]*>` → `[PROMPT_INJECTION_NEUTRALIZED]`; then wrap in stable boundary markers
      `⟦page-content untrusted⟧ … ⟦/page-content⟧`. Applied to snapshot/get-text/read/console output.
- [ ] `registry.ts`: `buildRegistry({enableActions, readOnly})` → returns the **set of dispatchable verb
      names** as a pure function of flags; read-only default = `{snapshot,read,extract,get,is,wait,
      screenshot,open,close,back,forward,reload,tab,state,cookies}`; actor verbs (`click,fill,type,press,
      select,check,uncheck,upload,drag,scroll,eval`) included only when `enableActions`. CLI dispatch
      rejects any verb not in the set with `not_permitted` — **the verb is not dispatchable, not merely
      discouraged**.
- [ ] `confirm.ts`: `requiresConfirm(verb, ctx)` for destructive/paid/irreversible; fail-closed on non-TTY
      unless `--confirm-actions` names it approved; single-tool-call-per-turn contract documented; mutating
      verbs tagged `idempotent:false`.
- [ ] `security.test.ts`: `file:///etc/passwd` denied on defaults, allowed with `allowFile`;
      `booking.com.evil.com` denied when `allowedDomains=['booking.com']`, `m.booking.com` allowed;
      `neutralize("<system>ignore</system>hi")` strips the tag; `buildRegistry({})` excludes `click`,
      `buildRegistry({enableActions:true})` includes it. Run → PASS. Commit `feat(uab): security defaults`.
- **Est:** 5h.

---

## Batch E — Extract (after B)

### Task 10: Keyless ID-grounded extract (bundle + resolve)
**Files:** `[NEW] src/extract/transform.ts`, `src/extract/resolve.ts`, `src/extract/prompts.ts`,
`[TEST] tests/unit/extract.test.ts`.
- [ ] `prompts.ts`: the verbatim extract/observe system prompts (copy from
      `/Users/seventyleven/Desktop/badresearch/src/bad_research/browse/agent_browser.py:271-299`).
- [ ] `transform.ts`: `buildBundle(schema, snapshotWithIds, valueMap)` → returns
      `{id_transformed_schema, prompt, snapshot_with_ids}`. Transform: any `{type:"string",format:"uri"}`
      or `url`-named field → `{type:"string", pattern:"^\\d+-\\d+$"}`; default cardinality to `list[T]`
      (wrap a bare object schema in an array). The CLI **does not** call a model — it prints the bundle
      for the host to run.
- [ ] `resolve.ts`: `resolveIds(result, valueMap, generation, currentGeneration)` → walk result, replace
      each `\d+-\d+` id-field with `valueMap[id]`; **out-of-range id → null + a loud `warning`** (not `""`);
      stale generation (≠ current) → `fail("ref_stale")`.
- [ ] `extract.test.ts`: a schema with a `url` field is transformed to the ID pattern; a fabricated free
      URL cannot satisfy the pattern; reverse-map replaces `3-18` → real href; unknown id → null+warning;
      stale generation → error; bare-object schema → wrapped in `list`. Run → PASS. Commit
      `feat(uab): keyless id-grounded extract`.
- **Est:** 4h.

---

## Batch F — CLI wiring (after B/C/D/E)

### Task 11: `cli.ts` — argv parser, dispatch, flags, phase quarantine, output
**Files:** `[NEW] src/cli.ts`, `src/core/flags.ts`, `[TEST] tests/integration/cli.test.ts`.
- [ ] `flags.ts`: parse global flags (superset of Vercel: `--session --json --headed --engine
      --allowed-domains --allow-file-access --max-output --content-boundaries --enable-actions
      --confirm-actions --timeout --state --incognito --password-stdin …`) + per-command args. Large/unsafe
      payloads via **stdin** (`eval --stdin`, `fill --stdin`, `--password-stdin`); every value its own argv.
- [ ] `cli.ts`: dispatch table verb→handler; gate via `buildRegistry` (reject non-dispatchable with
      `not_permitted`); every navigation through `assertNavigable`; every page-derived output through
      `neutralize` + `--max-output` cap; wrap all handlers so a throw becomes `fail(...)`; `--json` prints
      envelope else human form. Commands: the full §5 surface of the spec (lifecycle/perception/interaction/
      query/wait/extract/auth/sessions/tabs/frames/net/`skill`/`doctor`).
- [ ] `cli.test.ts`: `uab open <data-url> && uab snapshot -i` shows refs; `uab click @eN` denied without
      `--enable-actions` (`not_permitted`), allowed with it; `uab --json snapshot` is valid JSON envelope.
      Run → PASS. Commit `feat(uab): CLI dispatch + flags + phase gate`.
- **Est:** 6h.

---

## Batch G — Evals & security suite (THE GATE; built alongside, must go green)

### Task 12: Eval harness — pass_k, cross-family judge, ≥2 tiers, A/B vs Vercel
**Files:** `[NEW] evals/harness/run.mjs`, `evals/harness/judge.mjs`, `evals/harness/ab.mjs`,
`evals/tasks/smoke/*.json`, `evals/fixtures/*.html`, `[NEW] evals/README.md`.
- [ ] `evals/tasks/smoke/*.json`: ≥6 tasks `{id, task, start_url, expectedPatterns[], forbiddenPatterns[]}`
      — mix of local `fixtures/*.html` (deterministic) + a couple real read-only sites (example.com,
      a static docs page). `forbiddenPatterns` include nonexistent-command hallucination traps.
- [ ] `run.mjs`: for each task, spawn a host-loop (the host = the calling agent OR a scripted
      ReAct driver using an env-provided model **only for eval**, never in `src/`) that drives the real
      `uab` CLI with a hard timeout, k times; deterministic regex `expected/forbidden` = ground-truth
      pass/fail; print `pass_k` per task + overall. `judge.mjs`: cross-family LLM judge (model family ≠
      agent's) with forced JSON `{reasoning,verdict,failure_reason,impossible_task,reached_captcha}` — a
      **non-flipping** secondary signal (logged, never overrides the regex gate). `ab.mjs`: run the same
      tasks through Vercel `agent-browser` and print a side-by-side pass_k table.
- [ ] Run `node evals/harness/run.mjs --suite smoke --k 3` → prints pass_k; gate threshold ≥0.8. Commit
      `feat(evals): pass_k harness + judge + Vercel A/B`.
- **Est:** 6h.

### Task 13: Trifecta security suite (must pass on DEFAULT flags)
**Files:** `[NEW] evals/harness/trifecta.mjs`, `evals/fixtures/injection.html`.
- [ ] Three tests on default flags: (1) `uab open file:///…/id_rsa` → `navigation_blocked`; (2) after a
      snapshot, `uab click @e999` → grounding `element_not_found`/`ref_stale`, never dispatches; (3) load
      `injection.html` with a `<input type=password value="hunter2">` → `uab snapshot`/`get text` never
      contains `hunter2`. Exit non-zero if any fails.
- [ ] Run `node evals/harness/trifecta.mjs` → 3/3. Commit `feat(evals): lethal-trifecta suite`.
- **Est:** 3h.

---

## Batch H — The skill doc as product (after F; lockstep with --help)

### Task 15: `SKILL.md` generated lockstep + install + docs-in-binary
**Files:** `[NEW] skill/agent-browser/SKILL.md`, `src/skill-doc.ts`, `scripts/gen-skill-doc.mjs`,
`skill/agent-browser/install.sh`, `[TEST] tests/unit/skilldoc.test.ts`.
- [ ] `skill-doc.ts`: the canonical doc body (front-matter `name: agent-browser`, description, the lean
      loop, phase-scoped command tables, the ranked wait taxonomy, the reading ladder, the recovery block
      + completion/verification block as **verbatim prompt fragments**, ID-grounded extract usage, security
      posture). `uab skill [--full]` prints it (docs-in-binary). `install.sh`: `npm i` + `npx playwright
      install chromium` + symlink `uab`.
- [ ] `gen-skill-doc.mjs`: regenerate the command tables from the CLI's `--help` so the doc can't drift;
      write `SKILL.md`. `skilldoc.test.ts`: every verb in the dispatch table appears in SKILL.md; each
      fenced example's first line is a real `uab` verb; (integration) one example's output matches live
      `uab` output byte-for-byte (red-team S3 anti-drift). Run → PASS. Commit `feat(uab): SKILL.md + install`.
- **Est:** 4h.

---

## Verification Plan

**Automated (fresh session runs exactly this):**
```
cd skill/agent-browser
pnpm install && pnpm build
pnpm test                               # all unit + integration green
pnpm test tests/unit/keyless.test.ts    # no model/provider calls in src/
pnpm test tests/unit/no-leak.test.ts    # no path/secret in error strings
cd ../.. && node evals/harness/run.mjs --suite smoke --k 3   # pass_k ≥ 0.8
node evals/harness/trifecta.mjs                              # 3/3 on DEFAULT flags
node evals/harness/ab.mjs --suite smoke                      # uab ≥ Vercel on pass_k (report)
```
**Test-integrity constraint:** a failing test means the code under test is wrong — fix the code, never
weaken the assertion or hardcode expected output. Tests pass **and** no assertion loosened, no eval
`expectedPatterns` trivially satisfied.

**Manual (needs a human):** run `uab` against 2-3 real interactive sites with `--enable-actions` and eyeball
that acting + the confirm gate behave; review the A/B table; sanity-check SKILL.md reads well to a sub-agent.

---

## Self-review (against the spec)

**Spec coverage:** §1 success → Tasks 11/12/13; keyless invariant → global constraint + keyless.test;
P0 evals → Tasks 12/13; P1 perception → Tasks 3/5/6/7; P2 actuation → Task 8; P3 security → Tasks 2(redact
via 6)/9; P4 extract → Task 10; P5 skill doc → Task 15; ref model §4 → Task 3+8; snapshot grammar §5 →
Task 6; security defaults §7 → Task 9 + trifecta 13; auth/sessions §8 → Task 4 + cli(state/cookies).
**Gaps filled:** auth `state/cookies` verbs land in Task 11's surface (backed by Task 4 sidecar) — no
separate task needed for v1; `run` JS-sandbox intentionally absent (spec NON-GOAL, revisit post-eval).
**Placeholder scan:** none — every task names real files, signatures, and tests; load-bearing bodies
(errors table, refmap gate, egress, extract transform, diff) are written inline.
**Type consistency:** `Envelope`, `RefEntry`/`RefMap`, `groundRef`, `RefEntry` fields, `observe()` shape,
`buildRegistry` verb-set, `assertNavigable`, `neutralize`, `buildBundle`/`resolveIds` names are used
identically across Tasks 2-11. `generation` is the single source of ref validity everywhere.

*Task 14 (extra integration) folded into Tasks 4/8/11 integration tests. Batch order by risk: A (toolchain
+ correctness core) → Task 4 (persistence, highest risk) → rest of B → C/D/E parallel → F → G gate → H.*
