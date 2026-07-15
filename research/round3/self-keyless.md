# Self-Audit: KEYLESS + No-Leak — moxxie/skill/agent-browser/src

## Audit method
Grepped all of `src/` for model/provider calls, network egress, and
path/secret leakage into error/warning strings; read `security/egress.ts`,
`security/redact.ts`, `security/injection.ts`, `core/errors.ts`,
`core/envelope.ts`, `core/session.ts`, `core/handlers.ts`, and `package.json`.

## Result: 100% keyless — CONFIRMED

- `package.json` dependencies: `{"playwright": "^1.61.0"}` only. No OpenAI/Anthropic
  SDK, no `openai`/`@anthropic-ai`/generic HTTP-LLM client anywhere in
  `dependencies` or `devDependencies`.
- `grep -rniE 'openai|anthropic|api[_-]?key|claude|gpt-|llm|process\.env'` across
  `src/` returns zero hits on a real provider call. The only `model`/`LLM`
  hits are comments describing the *host* LLM consumer (`core/errors.ts:4`,
  `extract/prompts.ts:5`, `extract/transform.ts:126`, `core/flags.ts:20`) —
  documentation of the boundary, not a violation of it.
- Only two `fetch(...)` call sites in the entire codebase:
  - `core/session.ts:166` — fetches `http://localhost:<port>/json/version` to
    read the local CDP `webSocketDebuggerUrl` for attaching to an
    already-running local browser. Local-loopback CDP handshake, not
    internet egress, not model-related.
  - `core/handlers.ts:359` (`handleRead`) — fetches the URL the *user/host*
    passed to the `read` command, and only after `assertNavigable()`
    (`security/egress.ts`) has cleared it. This is the tool doing its job
    (fetching a page on request), gated by the same egress guard as
    Playwright navigation — not a hidden backchannel.
- `security/egress.ts` (`assertNavigable`): scheme+host denylist, blocks
  `file:`/`data:`/`blob:`/`view-source:`/raw-IP literals/known credential
  hosts by default; `--allowed-domains` is opt-in suffix-match hardening
  (never substring). This is the single choke point for all navigation, per
  its own doc comment ("the CLI is expected to call it on the lowest
  navigation primitive it controls").
- `security/redact.ts` (`redactValue`): password fields (DOM-flag OR
  role/name heuristic) and card-shaped values (13-19 digit regex) are
  replaced with `[redacted]` at the serializer choke point before any output
  reaches the host — purely local regex/flag logic, explicitly documented as
  "purely local (keyless) — no model, no network."
- `core/errors.ts`: explicit **INVARIANT (no-leak)** comment — "messages are
  fixed, sanitized strings. They must never embed a filesystem path, URL,
  host, or secret." All 10 entries in the `ERRORS` table are verified
  hardcoded, parameter-free strings (no template interpolation).
- `core/envelope.ts` `fail(code, ctx?)`: `ctx` is documented and verified
  **NOT** interpolated into the emitted message — it exists only for
  internal logging/branching, never serialized to the host.
- The two places a real filesystem path is constructed
  (`core/session.ts:54` → `path.join(os.homedir(), '.moxxie', 'sessions')`,
  `core/handlers.ts:846` → `path.join(os.homedir(), '.moxxie')`,
  `core/handlers.ts:782` → `process.cwd()`) are used to build session-storage
  paths, not embedded into error/warning strings shown to the host — no
  contradiction of the no-leak invariant found.
- `security/injection.ts`: `neutralize()` strips forged transcript-role tags
  (`<system>`, `</assistant>`, `<untrusted>`, etc.) from page-derived output
  and wraps it in unforgeable boundary markers before it ever reaches the
  host LLM — pure regex, no model call, defends the reverse direction (page
  → host) of the keyless boundary.

**No violations found.** The codebase already treats "keyless" and "no-leak"
as first-class, load-bearing invariants with inline doc comments naming the
guarantee at each choke point (egress, redact, errors, envelope, injection).

## Gap: the guarantee is asserted in comments but not tested as a regression gate

`tests/unit/security.test.ts` (299 lines) tests `assertNavigable` scheme/IP/
allowlist behavior thoroughly, but there is no test anywhere in `tests/`
that would catch a *future* regression where someone adds a `fetch()` to
`api.openai.com`, an `ANTHROPIC_API_KEY` read, or a path/host interpolated
into an `ERRORS` message. The invariants currently rely entirely on doc
comments and reviewer discipline.

## Findings (gap-alignment, framed as hardening moxxie's own gate)

Since this is a self-audit rather than a comparison to an external agent,
findings below are "what moxxie should add to itself" to convert the
verified-by-reading invariants above into an enforced, automated gate — so
the guarantee survives future contributors who haven't read this audit.

1. **Add a static keyless-regression test over `src/`.** No test currently
   fails if a future PR adds an LLM/provider dependency or call.
   `tests/unit/keyless.test.ts` should read every file under `src/` (via
   `fs.readdirSync` recursively, no new deps) and assert none of
   `/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|
   ANTHROPIC_API_KEY|OPENAI_API_KEY|new\s+OpenAI\(|Anthropic\(/i` match
   outside of comment lines, plus assert `package.json` `dependencies` keys
   are exactly `['playwright']` (or an allowlisted set). Cheap, deterministic,
   catches the exact regression class this audit was asked to find. P0,
   keyless_ok: true (it's a plain grep-in-a-test, no model call).

2. **Add a static no-leak-in-errors test.** Assert every value in
   `ERRORS[*].message` (`core/errors.ts`) is free of `/[/\\]/` path
   separators, `://` URL markers, and matches no template-literal
   interpolation marker (`${`) — i.e. programmatically enforce the
   "INVARIANT (no-leak)" comment instead of relying on it being read. P0,
   keyless_ok: true.

3. **Add an explicit test that `fail()`'s `ctx` argument never reaches the
   emitted envelope.** `core/envelope.ts` documents this but
   `tests/unit/errors.test.ts` should assert it directly: call
   `fail('timeout', {path: '/Users/x/secret', token: 'abc'})` and assert the
   serialized envelope JSON does not contain the substrings `'/Users/x/secret'`
   or `'abc'`. Currently this behavior is verified by reading the source, not
   by a test that would fail if someone "helpfully" wired `ctx` into the
   message later. P1, keyless_ok: true.

4. **Pin `handleRead`'s bare `fetch(url)` (`core/handlers.ts:359`) to the same
   redirect/scheme re-validation as Playwright navigation, or document why
   it's exempt.** `fetch()` follows redirects by default; a URL that passes
   `assertNavigable()` pre-redirect could still land on a denied host (e.g.
   `file:` via a redirect chain is blocked by fetch's own scheme handling,
   but an SSRF-shaped redirect to a raw-IP/localhost target is not
   re-checked post-redirect the way it would be if this went through the
   Playwright page's navigation events). Either set `redirect: 'manual'` and
   re-run `assertNavigable` per hop, or add a code comment + test recording
   this as an accepted risk. P1, keyless_ok: true (pure fetch-option change,
   no model).

5. **Skip-cargo-cult: do not add an LLM-based "is this a secret?" classifier
   to `redact.ts`.** A bigger, keyed system in this space would plausibly
   reach for a model to classify free-text values as PII/secrets. moxxie's
   current `redactValue` (DOM flag + role/name regex + card-shape regex) is
   the correct keyless-appropriate design: fast, deterministic, auditable in
   a 55-line file, and it already ships the two signals that matter most
   (password fields, card numbers). Adding a "smarter" heuristic engine here
   would violate the keyless mandate for marginal recall gain. Recommendation:
   skip. keyless_ok: n/a (this is a "don't build" finding).

6. **Skip-cargo-cult: do not add telemetry/analytics egress.** Grep confirmed
   zero outbound calls beyond the two documented `fetch()` sites (local CDP
   handshake, user-requested `read`). Larger agent frameworks in this
   reference class often add usage-telemetry beacons "for product analytics."
   moxxie should explicitly keep this at zero — any telemetry beacon, even to
   a first-party endpoint, is undisclosed network egress from an agent tool
   and should require an opt-in flag if ever added, not ship by default. This
   is a "stay as-is" finding, not a code change. keyless_ok: n/a.

7. **Document the `session.ts:166` CDP-fetch as an explicit exemption in
   `security/egress.ts`'s doc comment.** The egress doc comment currently
   frames `assertNavigable` as covering "every navigation the CLI performs,"
   but the CDP discovery fetch in `core/session.ts` intentionally bypasses it
   (it's a `localhost` control-plane call, not a navigation). A one-line
   comment cross-reference prevents a future reader from either (a) treating
   this as an undocumented gap, or (b) "fixing" it by routing it through
   `assertNavigable`, which would break local browser attach (loopback IPs
   are in the raw-IP denylist). P2, keyless_ok: true.
</content>
