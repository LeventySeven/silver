# webwright → moxxie: keyless/backends + safety-posture alignment

Source read: `reference/webwright/src/webwright/{environments,models,tools}/*.py`,
`reference/webwright/README.md`, `reference/webwright/SECURITY.md`.
Moxxie read: `skill/agent-browser/src/security/{confirm,egress,injection,redact,registry}.ts`,
`skill/agent-browser/src/core/{handlers,session}.ts`.

## Headline

webwright is a *much thinner* system than moxxie on the security axis: it has
**no egress guard, no confirm gate, no verb quarantine, and no redaction
layer at all**. Its "browser environment" is raw `exec()` of LLM-authored
Python with `page`/`context`/`browser` in scope
(`environments/local_browser.py::_run_python_code`), and its "workspace
environment" is raw `subprocess.run(..., shell=True)` of LLM-authored bash
with a credentials file blanket-injected into the env
(`environments/local_workspace.py::execute` / `_load_credential_env`). There
is no analogue to moxxie's `security/` module at all. `SECURITY.md` is the
stock Microsoft template with zero repo-specific content.

Because of this, most high-value findings are **confirmations that moxxie is
already ahead** (do not weaken to match webwright) plus a small number of
genuinely adoptable *patterns* webwright does have — cwd/path containment,
static pre-execution validation, and the (model-dependent) Task2UI idea
re-expressed keyless. `Task2UI` and webwright's LLM-API retry/backoff
(`models/base.py`) are the two explicitly model-dependent things to skip.

## Findings

### 1. [P1, adopt] No filesystem containment on `screenshot`/`upload` paths
- **webwright**: `environments/local_workspace.py::_resolve_cwd` resolves any
  agent-supplied `cwd` against the workspace root and raises
  `ValueError` if `resolved.relative_to(workspace_dir)` fails — a hard,
  fail-closed jail on every command's working directory.
- **moxxie now**: `core/handlers.ts::handleScreenshot` takes
  `outPath = flags.args[0]` and passes it straight to
  `page.screenshot({ path: outPath })` — Playwright will write to *any* path
  the host LLM supplies, no containment check. `handleAct`'s `upload` verb
  (`opts.files = flags.args.slice(1)`) similarly reads arbitrary local file
  paths to upload with no allowlist. Since the LLM's tool-call arguments can
  be influenced by injected page content (the exact threat `injection.ts`
  exists to blunt for *text*), an unguarded write/read path is a live
  exfiltration/overwrite vector moxxie's own threat model already covers for
  navigation (`egress.ts`) but not for the filesystem.
- **Change**: add a small `security/fspath.ts` mirroring `egress.ts`'s
  fail-closed shape — `assertWritable(path, { rootDir, allowOutsideRoot })`
  and `assertReadable(path, { rootDir, allowOutsideRoot })` — default-deny
  any path that resolves outside a configured root (CWD or `~/.moxxie/...`
  by default), lifted only by an explicit `--allow-file-access`-style flag,
  same posture as `egress.ts`'s `allowFile`. Wire it into `handleScreenshot`
  and the `upload` branch of `handleAct` in `core/handlers.ts`.
- keyless_ok: true (pure path resolution, no model).
- priority: P1

### 2. [P2, skip-cargo-cult] Env-var-controlled CDP endpoint override
- **webwright**: `environments/local_browser.py::_resolve_local_cdp_url`
  lets `LOCAL_BROWSER_CDP_URL` / `BROWSER_CDP_URL` (or an explicit config
  value) point `chromium.connect_over_cdp` at **any** host:port — no
  localhost pin, no scheme check. Combined with `local_cdp_auto_start` and
  `_find_chromium_executable` also honoring env vars
  (`LOCAL_BROWSER_EXECUTABLE`), this is a soft SSRF/hijack surface: anything
  that can set env vars for the process can redirect the "local" browser
  session to a remote CDP endpoint it controls.
- **moxxie now**: `core/session.ts::openSession` self-spawns its own
  detached Chromium, reads the port back from `DevToolsActivePort` in the
  user-data-dir it just created, and only ever connects to the `wsEndpoint`
  it derived itself (`session.ts:118-134`, `waitForDevToolsPort` /
  `waitForWsEndpoint`). There is no external-CDP-URL input surface today.
- **Change**: none needed — this is a "do not add" flag. If a future feature
  wants to attach to an externally-running browser (e.g. a `--connect`
  flag), hard-pin the host to `127.0.0.1`/`::1` and reject any URL whose
  host resolves elsewhere, reusing `egress.ts`'s raw-IP/host-matching logic
  rather than trusting a bare env var.
- keyless_ok: true (it's a "don't build this" note).
- priority: P2

### 3. [P2, skip-cargo-cult] Credentials file blanket-injected into every subprocess, logged unredacted
- **webwright**: `environments/local_workspace.py::_load_credential_env`
  parses a dotenv-style `credentials_file` and merges it into **every**
  subprocess env via `execute()` (`command_env = os.environ |
  self._credential_env | ...`). Command stdout/stderr (which could easily
  echo an env var) is then persisted unredacted to
  `logs/step_XXXX.log` and `command_history.sh`
  (`_write_step_log`, `_persist_step_command`) with zero pass through
  anything like moxxie's `redact.ts`.
- **moxxie now**: has no equivalent "credentials file forwarded to shell"
  feature, and its one redaction choke point (`security/redact.ts
  ::redactValue`) already sits at the serializer so password/card values
  never reach a snapshot.
- **Change**: none required today — explicitly do not add a "credentials
  file merged into subprocess env" feature. If moxxie ever needs to carry
  auth material for `state`/`cookies` verbs, route any values that might
  echo into command output or logs through `redact.ts`'s `redactValue`
  choke point before they are ever written to disk or returned in an
  envelope, the same way `injection.ts::capOutput`/`neutralize` already gate
  `presentPageText` output (`core/handlers.ts:149-150`).
- keyless_ok: true.
- priority: P2

### 4. [P1, adopt-reexpressed-keyless] Task2UI → keyless templated HTML report
- **webwright**: README news entry (2026-05-11): "Support Task2UI mode:
  Webwright completes the task and renders task results into an HTML-based
  web app you can easily view and reuse." This is model-dependent — the LLM
  itself authors the HTML/JS as part of finishing the task (there is no
  dedicated Task2UI module in `src/`; it is agent-authored output, not a
  CLI feature).
- **HARD RULE**: moxxie cannot call a model to do this. Re-expressed
  keyless: the *value* (a single browsable artifact bundle from a session)
  does not require a model — it requires assembling already-captured data
  (snapshot text, `screenshots/*.png`, console/network logs, final
  `moxxie-state.json`) into a static page via a fixed template.
- **Change**: add a `report/render.ts` (new module) + `moxxie report
  <session>` verb that walks `~/.moxxie/sessions/<name>/` (sidecars already
  written by `core/session.ts` and `core/handlers.ts::saveState`) and emits
  a single self-contained HTML file (inline base64 screenshots, a `<pre>`
  of the last snapshot text, `console`/`network` sections) via string
  templating — no LLM call, no external assets. This gives the host LLM (or
  a human) the "reusable local artifact" win Task2UI advertises, at zero
  API cost.
- keyless_ok: true (explicitly re-expressed to avoid the model dependency).
- priority: P1

### 5. [P2, align] Pre-execution static validation before dispatch
- **webwright**: `models/base.py::_validate_bash_command` runs `bash -n`
  against the LLM's `bash_command` *before* the workspace environment ever
  executes it, turning a malformed command into an immediate, cheap
  `FormatError` retry instead of a wasted subprocess round-trip
  (`_query_async` calls it right after JSON-parsing the model's action).
- **moxxie now**: the `eval` verb is already reserved in the security layer
  (`security/registry.ts::ACTOR_VERBS`, `security/confirm.ts
  ::MUTATING_VERBS` both list `'eval'`) but is not yet dispatched in
  `core/handlers.ts::dispatch` (falls through to `notImplemented()`). When
  it is implemented, there is no static pre-check analogue in scope.
- **Change**: when wiring `eval` to `page.evaluate`, parse the JS snippet
  first with `new vm.Script(code)` (parse-only — the `vm` module compiles
  without executing) inside a `try/catch`; on `SyntaxError` return a
  `bad_request`-style envelope immediately, same shape as
  `_validate_bash_command`'s early reject. Pure static check, zero model
  cost, avoids burning a `page.evaluate` round-trip (and any confirm-gate
  friction) on code that can't even parse.
- keyless_ok: true.
- priority: P2

### 6. [P0, validate-no-action] Total absence of an egress guard in webwright
- **webwright**: `environments/local_browser.py::_run_python_code` `exec()`s
  arbitrary LLM-authored Python with `page`, `context`, `browser` bound —
  the agent can call `await page.goto(...)` to any URL, `file:` included,
  with zero scheme/host check anywhere in the module. `_prepare_async`'s own
  `page.goto(self.config.start_url, ...)` is likewise unguarded.
- **moxxie now**: `security/egress.ts::assertNavigable` is called at the
  lowest layer moxxie controls (`core/handlers.ts::handleOpen` and
  `handleRead`, *before* a browser is spawned/connected) — scheme denylist,
  raw-IP denylist, known-dangerous-host denylist, and opt-in suffix
  allowlist hardening, all fail-closed.
- **Change**: none — this confirms moxxie's posture is already well ahead
  of this reference on egress. Do not simplify `egress.ts` toward
  webwright's "no guard" model when reconciling the two; if anything this
  is the pattern webwright's own README's `local_cdp` mode (attach to the
  operator's real logged-in browser profile,
  `_DEFAULT_LOCAL_CDP_USER_DATA_DIR = ~/.cache/webwright/edge-profile`)
  makes MORE dangerous, not less, since the agent inherits real session
  cookies with no navigation guard rails.
- keyless_ok: true (no-op / confirmation finding).
- priority: P0 (highest-value finding is "don't regress this")

### 7. [P2, skip-cargo-cult] LLM-API rate-limit/backoff machinery is model-dependent
- **webwright**: `models/base.py::_is_rate_limit_error`,
  `_is_transient_http_error`, `_rate_limit_backoff`, `_transient_backoff`,
  `_post_with_retries` — a substantial retry/backoff stack, but it exists
  entirely to paper over **calling a model provider's HTTP API** (429s,
  gateway timeouts against OpenAI/Anthropic/OpenRouter).
- **moxxie now**: makes no model calls, so there is no analogous "provider
  429" surface. Its actual equivalent problem — a transient Playwright
  failure — is handled by tagging errors `retryableByHost: true/false` in
  `core/errors.ts` and pushing the retry decision to the host LLM, rather
  than looping internally. That is the correct keyless shape (the CLI
  itself never blocks on a sleep/backoff loop it can't be told to abandon).
- **Change**: none — do not port `_rate_limit_backoff`-style internal retry
  loops into moxxie; `retryableByHost` tagging in `core/errors.ts` is
  already the right keyless replacement. Flagging explicitly per the HARD
  RULE since this is the clearest "model-dependent, must be skipped"
  pattern in the source.
- keyless_ok: false as literally implemented in webwright (it exists only
  to retry model-provider calls); the moxxie-side equivalent
  (`retryableByHost`) is already keyless and needs no change.
- priority: P2 (documentation-only; nothing to build)

### 8. [P2, align] No SECURITY.md in moxxie
- **webwright**: ships the stock Microsoft `SECURITY.md` template (generic
  vulnerability-reporting boilerplate, zero repo-specific content) at
  `reference/webwright/SECURITY.md`.
- **moxxie now**: no `SECURITY.md` exists in the repo root (checked:
  `find /Users/seventyleven/Desktop/moxxie -maxdepth 2 -iname SECURITY.md`
  → empty).
- **Change**: add a short `SECURITY.md` at moxxie's repo root describing
  the actual threat model moxxie already implements in code
  (`security/egress.ts`, `security/confirm.ts`, `security/injection.ts`,
  `security/redact.ts`, `security/registry.ts`) and a reporting contact —
  documentation only, but cheap and closes an obvious gap a security-minded
  adopter would look for first.
- keyless_ok: true (docs, not code).
- priority: P2

## Top recommendation

**Finding 1** (path containment on `screenshot`/`upload`): it is the one
place moxxie's own stated threat model (page-derived content can influence
the host LLM's next tool call — the exact premise `injection.ts` and
`egress.ts` are built to blunt) has a live, unguarded filesystem read/write
surface, and webwright's `_resolve_cwd` is a directly portable, tiny,
keyless pattern to close it.
