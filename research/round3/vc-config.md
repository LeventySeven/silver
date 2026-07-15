# Lens: config JSON Schema + plugin/capability model (agent-browser) vs moxxie flags.ts

Source read: `/Users/seventyleven/Desktop/moxxie/reference/agent-browser/agent-browser.schema.json` (252 lines, draft-07 schema, `additionalProperties: true`).
Moxxie read: `src/core/flags.ts` (argv parser, no persistence), `src/cli.ts` (dispatcher), `src/core/session.ts` (session lifecycle), `src/security/confirm.ts`, `src/core/handlers.ts` (doctor/skill/state/cookies/session verbs).

**Headline finding: moxxie has NO config file concept at all.** `flags.ts` only parses `argv` into `ParsedFlags`; `cli.ts` calls `parseFlags(argv)` directly with no file read anywhere in the dispatch path. Every invocation is a cold, independent process with zero persisted defaults — confirmed by `grep -rn config src` turning up nothing in `core/` or `cli.ts` (only `security/egress.ts` uses the word in a comment). agent-browser, by contrast, ships a full schema for `agent-browser.json` / `~/.agent-browser/config.json` with layered user+project merge semantics (`extensions` "concatenated", `plugins` "appended... duplicate names resolve to the later entry").

## Findings

### 1. No config file → security flags must be re-specified every call (P0, adopt, keyless)
- **Source does:** `allowedDomains`, `maxOutput`, `contentBoundaries`, `confirmActions`, `restoreSave`, `namespace` etc. all live in a project/user config file, so a project can pin its security posture once.
- **moxxie now:** `flags.ts` `defaults()` (lines 129-152) hardcodes `allowedDomains: []` (open egress unless the CALLER remembers `--allowed-domains` on every single invocation) and `contentBoundaries: true`/`confirmActions: []`. Since moxxie is invoked fresh per command by a host LLM, there is no mechanism to make "always restrict to these domains" durable — it depends on the host LLM never forgetting the flag on any of dozens of calls in a session.
- **Change:** In `cli.ts::run()`, before/after `parseFlags(argv)`, read an optional `moxxie.config.json` (cwd, walking up) and `~/.moxxie/config.json`, shallow-merge as defaults into `ParsedFlags` (CLI-supplied flags win — same precedence agent-browser uses for project-over-user). Add a new pure function `mergeConfigDefaults(flags, config)` in `flags.ts` so it stays unit-testable with no I/O in the parser itself (config *loading* is I/O and belongs in `cli.ts`, matching the file's own stated design goal of keeping `flags.ts` "pure string parsing, no I/O, no model").
- **keyless_ok:** true — pure JSON file read + merge, no model call.
- **Evidence:** schema.json:157-171 (`allowedDomains`, `actionPolicy`, `confirmActions`); flags.ts:129-152 (`defaults()`).

### 2. moxxie has no self-describing JSON Schema for its own flags (P1, adopt, keyless)
- **Source does:** publishes `agent-browser.schema.json` — a machine-readable contract for every flag/config key, usable by editors and by the config-merge logic itself for validation.
- **moxxie now:** flag surface is documented only in TS types (`ParsedFlags`) and prose comments; nothing published for tooling or for the host LLM to introspect programmatically (only `moxxie skill`/`moxxie doctor` prose in `handlers.ts`).
- **Change:** Once (1) lands, derive/hand-write `moxxie.config.schema.json` mirroring the new config keys, and validate the loaded config against it in the same merge step (reject unknown-typed values, not unknown keys — keep `additionalProperties: true` like the source, since moxxie should stay forward-compatible and never crash on an extra key).
- **keyless_ok:** true.
- **Evidence:** schema.json:1-6 (`$schema`, title/description); no equivalent artifact found anywhere under moxxie `src/`.

### 3. `idleTimeout` is a real source flag; moxxie's counterpart is a dead field (P1, adopt, keyless)
- **Source does:** `idleTimeout` config key ("Auto-shutdown the daemon after inactivity") is a first-class, implemented setting.
- **moxxie now:** `OpenOptions.idleTimeoutMs` exists in `session.ts:37` but the comment says outright: *"Recorded for later idle-reaping logic; unused by open itself."* It is dead — nothing reaps stale detached Chromium processes. A crashed/abandoned agent session leaves an orphaned headless Chromium + user-data-dir under `~/.moxxie/sessions/<name>` forever.
- **Change:** Implement idle-reaping keyed off `SessionInfo`/sidecar mtime: on `session` verb dispatch (or lazily on `connect()` in `session.ts`), check `Date.now() - createdAt`/last-touch against a configurable `idleTimeoutMs` (sourced from the new config file, default e.g. 30m) and `closeSession()` if exceeded before reconnecting. Purely local filesystem/process-signal logic, no model.
- **keyless_ok:** true.
- **Evidence:** schema.json:197-200; session.ts:36-37 (`idleTimeoutMs` field, "unused by open itself").

### 4. No `namespace` isolation → single global `~/.moxxie/sessions` (P2, adopt, keyless)
- **Source does:** `namespace` config key "isolates daemon sockets and restore-state directories" so multiple concurrent agent-browser instances (different projects/users on one machine) don't collide.
- **moxxie now:** `sessionsRoot()` in `session.ts:52-55` is a single hardcoded `path.join(os.homedir(), '.moxxie', 'sessions')` — any two agents on the same machine that pick the same session `name` (e.g. both default to `'default'`, per `flags.ts:131`) will stomp each other's sidecar/profile dir.
- **Change:** Add an optional `namespace` config/flag that inserts a segment into `sessionsRoot()` (`~/.moxxie/sessions/<namespace>/<name>`), defaulting to unnamespaced for backward compat. Trivial path-join change.
- **keyless_ok:** true.
- **Evidence:** schema.json:45-48; session.ts:52-55, flags.ts:131 (`session: 'default'`).

### 5. Plugin/capability model — SKIP as cargo-cult, actively dangerous for moxxie's threat model (P0, skip-cargo-cult)
- **Source does:** `plugins` config array declares external processes (`command`, `args`, `capabilities` such as `credential.read`, `browser.provider`, `launch.mutate`, `command.run`, or custom ones like `captcha.solve`) that agent-browser spawns and grants capabilities to.
- **moxxie now:** `cli.ts` is explicitly designed as "A THIN dispatcher" that never shells out to arbitrary named processes; the whole security model (`security/registry.ts` phase-quarantine, `security/confirm.ts` fail-closed gate, `security/egress.ts` denylist) is built on the invariant that the CLI's own code is the only thing that touches the browser/filesystem.
- **Why skip:** A `plugins[].command` entry in a config file is an arbitrary-code-execution primitive — if an attacker (or a compromised project repo) can edit `moxxie.config.json`, they get `command.run` capability for free. Worse, a `captcha.solve`-style plugin is explicitly a "call out to a solver service", and a `credential.read` plugin is exactly the shape of thing that could silently become a model/provider call — a direct violation of moxxie's 100%-keyless invariant. This is scope agent-browser needs as a general-purpose daemon with a product ecosystem; moxxie is a narrow, auditable keyless primitive for a host LLM that already has arbitrary tool access itself (the host can just shell out if it needs to extend behavior). Do not add plugins.
- **keyless_ok:** false (as designed by the source, capabilities like `credential.read`/`captcha.solve` are explicitly a doorway to a provider call).
- **Evidence:** schema.json:213-249 (`plugins`, capability list); cli.ts:5-19 (module doc: "A THIN dispatcher... All real logic lives in handlers.ts").

### 6. `restoreSave`/`restoreCheckUrl`/`restoreCheckText`/`restoreCheckFn` conditional auto-persist — SKIP, moxxie's manual `state save` is the right amount of machinery (P2, skip-cargo-cult)
- **Source does:** gates auto-saving restored browser state on a URL glob / visible-text check / arbitrary JS-expression check, to avoid persisting a broken/half-authenticated session.
- **moxxie now:** `state`/`cookies` are explicit, host-invoked verbs (`handleStateVerb`, `handleCookies` in `handlers.ts:686,716`) — the host LLM decides *when* to save, after it has already verified (via `snapshot`/`read`) that the page is in the state it wants captured.
- **Why skip:** moxxie's whole model is "host LLM is the brain, moxxie is dumb hands" — auto-save gating with a mini JS-expression evaluator (`restoreCheckFn`) re-introduces a decision-making component into the keyless tool, duplicating what the host already does for free by choosing when to call `state save`. Adding it would be solving a problem moxxie's architecture doesn't have.
- **keyless_ok:** true in principle, but net-negative complexity — recommend explicitly not building it.
- **Evidence:** schema.json:23-44; handlers.ts:686-715 (manual `state save`/`state load`).

### 7. Launch-time browser options config surface is largely absent from moxxie (P1, adopt selectively, keyless)
- **Source does:** config-level `proxy`, `proxyBypass`, `userAgent`, `colorScheme`, `ignoreHttpsErrors`, `executablePath`, `args`, `hideScrollbars`, `webgpu`.
- **moxxie now:** `OpenOptions` (session.ts:29-38) exposes only `headed`, `userDataDir`, `port`, `idleTimeoutMs`. The launch `args` array (session.ts:96-105) is fully hardcoded — no way to set a proxy, custom UA, or `ignoreHttpsErrors` at all. This means moxxie cannot be used to automate a site behind a corporate proxy, or a self-signed-cert staging environment, or with a specific UA for bot-detection testing — all common, legitimate agent-browsing needs.
- **Change:** Extend `OpenOptions` + the config file (item 1) with `proxy`, `userAgent`, `ignoreHttpsErrors`, `colorScheme` at minimum (skip `webgpu`/`hideScrollbars`/`device`/`provider` — niche, agent-browser-specific device-emulation features moxxie's eval gate doesn't need). Thread them into the `args`/`chromium.connectOverCDP` or context-creation call in `session.ts`.
- **keyless_ok:** true — these are just Chromium launch/context flags.
- **Evidence:** schema.json:87-122; session.ts:29-38, 96-105 (hardcoded args array).

### 8. `actionPolicy` (path to a JSON policy file) vs moxxie's flat `confirmActions` CSV — do NOT adopt the richer form (P2, skip-cargo-cult / align as-is)
- **Source does:** `actionPolicy` points to an external JSON file for fine-grained per-action policy, separate from the simpler `confirmActions` CSV string.
- **moxxie now:** `confirm.ts`'s `confirmGateDecision` + `flags.ts`'s `confirmActions`/`confirmActionsProvided` CSV flag already give a fail-closed, TTY-aware confirm gate (confirm.ts:83-100) that is simpler and easier to audit than a second policy-file format layered on top.
- **Why skip the extra file, but still adopt via item 1:** once moxxie has a general config file, `confirmActions` becomes a settable config key for free — no need for a *second*, richer policy-file schema/parser (`actionPolicy`) alongside it. Two overlapping mechanisms for the same decision (flat CSV + a JSON policy file) is exactly the kind of redundant surface moxxie should avoid.
- **keyless_ok:** true either way; recommendation is scope discipline, not a keyless concern.
- **Evidence:** schema.json:164-171; confirm.ts:56-100.

## Top recommendation
Add a single optional project/user config file (`moxxie.config.json` + `~/.moxxie/config.json`, project overrides user, CLI flags override both) that supplies defaults for the security-relevant flags moxxie already has — `allowedDomains`, `maxOutput`, `contentBoundaries`, `confirmActions` — plus `namespace` and `idleTimeoutMs`. This is the one change with outsized leverage: today a host LLM that forgets `--allowed-domains` on any single call in a long session silently reopens egress for that call, because there is no durable, out-of-band way to pin the policy. A config file closes that gap without adding a single ounce of the source's plugin/capability/auto-restore machinery, all of which is either dangerous (plugins) or solves a problem moxxie's host-is-the-brain architecture doesn't have (auto-restore gating).
