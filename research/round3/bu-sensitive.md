# browser-use → moxxie: sensitive_data / placeholder / redact / extract alignment

Source read: `browser_use/tools/registry/service.py` (`execute_action`, `_replace_sensitive_data`,
`_log_sensitive_data_usage`), `browser_use/utils.py` (`collect_sensitive_data_values`,
`redact_sensitive_string`, `match_url_with_domain_pattern`, `is_placeholder_url`),
`browser_use/agent/message_manager/service.py` (`_get_sensitive_data_description`,
`_filter_sensitive_data`, compaction-time filtering), `browser_use/agent/prompts.py`
(`<sensitive_data>` block), `browser_use/filesystem/file_system.py`.

Moxxie read: `security/redact.ts`, `security/injection.ts`, `security/egress.ts`,
`security/confirm.ts`, `security/registry.ts`, `extract/prompts.ts`, `extract/resolve.ts`,
`extract/transform.ts`, `core/handlers.ts` (fill/type dispatch at line 182-183).

## Headline gap

browser-use has an entire `sensitive_data` subsystem that moxxie has **zero** equivalent of. A
`grep -rn "secret\|sensitive" skill/agent-browser/src` turns up only comments about *error-message*
leak prevention (cli.ts:14/77, envelope.ts:30, session.ts:11, handlers.ts:7) — never a feature. Today
in moxxie, if the host LLM needs to fill a password/API-key field, it must hold the literal secret
value in its own context and pass it as the `fill --value` argument. That means every secret an
agent-browser task touches flows through the host model's transcript, tool-call log, and (if the
host logs its own history) potentially a durable log file. browser-use's whole `<secret>` design
exists to prevent exactly this, and it does it with **zero model calls** — pure regex/dict
substitution — so it is 100% portable to moxxie's keyless architecture.

## Findings

### 1. [P0, adopt] Placeholder-based secret injection — never let the real value cross into the host's context
- **source_does**: `tools/registry/service.py:_replace_sensitive_data` (line 427-514). The host LLM
  is told (via `message_manager/service.py:_get_sensitive_data_description`, line 388-417) only the
  *placeholder names* ("SENSITIVE DATA - Use these placeholders... wrap the placeholder name in
  `<secret>` tags"), never the values. The host emits `fill(value="<secret>bank_password</secret>")`.
  `_replace_sensitive_data` regex-matches `<secret>(.*?)</secret>` (line 442) and swaps in the real
  value from a locally-held dict, **after** validation, **immediately before** dispatch to the DOM.
  The real value never appears in an LLM prompt, LLM completion, or the agent's own history log.
- **moxxie_current**: absent. `core/handlers.ts` `handleAct` (case 'fill'/'type', line 182-183)
  takes `flags.value` verbatim and writes it to the DOM; there is no placeholder layer at all — the
  real secret must already be in the host's tool-call arguments.
- **recommendation**: adopt.
- **change**: In `core/handlers.ts` `handleAct`, before dispatching a `fill`/`type` (and `set`)
  action, scan `flags.value` for a `^%([A-Za-z0-9_.-]+)%$`-style placeholder (pick `%name%` over
  `<secret>name</secret>` to avoid colliding with `injection.ts`'s forged-tag stripping, which
  already treats `<...>` as suspect). Resolve it against a `--secret name=value` (repeatable) CLI
  flag or a `MOXXIE_SECRETS` JSON env var read once at session start (session.ts owns session
  state — add a `secrets: Map<string,string>` there). Unresolved placeholder → fail closed with a
  new `secret_undefined` error code (never silently type the literal string `%bank_password%` into
  the page). This is a pure local dict lookup — no model, no network.
- **keyless_ok**: true.

### 2. [P0, adopt] Never echo the placeholder catalog's *values* to the host — only the names
- **source_does**: `_get_sensitive_data_description` builds a system-prompt fragment listing only
  placeholder *keys*, domain-scoped by `match_url_with_domain_pattern` (utils.py:522) against the
  current page URL, and instructs the model to use `<secret>key</secret>`. Values never enter any
  prompt.
- **moxxie_current**: N/A today because there's no secrets feature (see #1), but this is the
  companion contract that must ship WITH #1 or the moat is pointless: moxxie must expose a `secrets
  list` / `skill` verb (already read-only in `registry.ts` READ_ONLY_VERBS) that returns placeholder
  *names* only, so the host can discover what it's allowed to reference without ever being told the
  underlying value.
- **recommendation**: adopt.
- **change**: Add a `secrets` verb to `registry.ts` `READ_ONLY_VERBS` and a handler that returns
  `{ placeholders: string[] }` from `session.ts`'s secrets map — names only, and gate it so the
  verb itself never accepts or returns values.
- **keyless_ok**: true.
- **priority**: P0.

### 3. [P0, adopt] Domain-scoping for secrets, reusing moxxie's OWN suffix-match primitive
- **source_does**: new-format `sensitive_data = {domain_pattern: {key: value}}` in
  `_replace_sensitive_data` (line 452-462) only makes a secret's value applicable when
  `match_url_with_domain_pattern(current_url, domain_or_key)` matches (glob `*.example.com`,
  scheme-aware). Old flat-dict format is legacy/global and the code comments flag it as
  "only allowed for legacy reasons" — i.e. browser-use itself considers unscoped secrets the
  worse default.
- **moxxie_current**: `security/egress.ts` `matchesAnySuffix` (line 129-135) already implements
  exact-or-suffix host matching for `--allowed-domains`. This is the *identical* primitive
  browser-use needs for domain-scoped secrets, just not reused for that purpose.
- **recommendation**: adopt.
- **change**: When resolving a `%name%` placeholder (#1), accept an optional `--secret
  name=value@domain.com` form (or a JSON map `{name: {value, domains: string[]}}`) and gate
  resolution through `matchesAnySuffix(currentHost, secret.domains)` from `egress.ts` — literally
  import and reuse the existing function rather than reimplementing glob matching. Default (no
  `domains`) = allowed everywhere, matching browser-use's legacy-global fallback, but log a
  low-severity warning so operators are nudged toward scoping.
- **keyless_ok**: true.

### 4. [P1, adopt] Redact secret *values* out of ALL host-facing output, not just password-typed fields
- **source_does**: `utils.py:redact_sensitive_string` (line 76-80) scans arbitrary text — DOM
  state, compaction summaries (`message_manager/service.py:255-257`), any outgoing message
  (`_filter_sensitive_data`, line 573-588) — for the literal *values* of every known secret and
  replaces them with `<secret>key</secret>`, longest-value-first to avoid partial leaks. This
  catches the case moxxie's `redact.ts` cannot: a secret that was correctly placeholder-injected
  into a field, then echoed back by the page (e.g. a masked-but-then-revealed username field, an
  autofill preview, a confirmation page showing "you entered: correct-horse-battery-staple") would
  sail straight through moxxie's `redactValue`, because that function only fires on
  `isPassword`/role-hint/card-shape (line 44-54 of `redact.ts`) — it has no notion of "this string
  IS one of the secrets I injected."
- **moxxie_current**: `security/redact.ts` `redactValue` — structural/pattern heuristics only
  (password flag, role/name hint, card regex). No secret-value-aware scan exists anywhere in
  `security/` or `extract/`.
- **recommendation**: adopt.
- **change**: In `redact.ts`, add a second-pass exported function `redactKnownSecrets(text: string,
  secretValues: string[]): string` — same longest-value-first replace-with-sentinel approach as
  `redact_sensitive_string` — and call it from the serializer choke point (wherever `redactValue`
  is invoked, plus the `snapshot`/`read`/`get-text` output paths per `injection.ts`'s own comment
  "Applied by the CLI to snapshot / get-text / read / console output") using the session's resolved
  secret-value set from #1. This is the single highest-leverage redaction change since it closes
  the "secret leaks back out through page echo" hole that structural redaction structurally cannot
  catch.
- **keyless_ok**: true.

### 5. [P1, adopt] Fail-loud on missing/empty placeholders instead of silently typing the raw tag
- **source_does**: `_replace_sensitive_data` (line 483-484, 511-512) tracks
  `all_missing_placeholders` and logs a warning; unmatched `<secret>x</secret>` in the value is left
  as literal text placeholder-unfilled rather than crashing — but it's surfaced, not swallowed.
- **moxxie_current**: N/A (no placeholder system yet) — but moxxie's own `extract/resolve.ts`
  already has the *better* version of this exact pattern ("loud null" for unresolved element IDs,
  line 62-70) which browser-use's approach doesn't have (browser-use just warns and leaves the
  tag literal, which risks typing `<secret>foo</secret>` into a real form field on the missing
  path).
- **recommendation**: align — but moxxie should do this *better* than browser-use, using its own
  `resolve.ts` "loud null" precedent instead of copying browser-use's "leave the tag in the DOM"
  behavior.
- **change**: In the placeholder-resolution code added for #1, an unresolved `%name%` must be a
  hard `secret_undefined` error (abort the fill), never a fallback to typing the literal
  `%name%` string into the page — this is stricter than browser-use and avoids browser-use's own
  footgun (a missing secret silently typing `<secret>foo</secret>` as page content).
- **keyless_ok**: true.

### 6. [P2, adopt] TOTP/2FA-code derivation is a pure function — keyless and worth having
- **source_does**: `_replace_sensitive_data` (line 474-476, 490-492): a placeholder suffixed
  `bu_2fa_code` is treated as a TOTP seed and `pyotp.TOTP(seed).now()` is substituted instead of the
  raw seed — lets the host trigger "enter the 2FA code" without ever seeing the seed OR the
  6-digit code.
- **moxxie_current**: absent, and unrelated to redact/extract as currently scoped.
- **recommendation**: adopt (low effort, genuinely keyless — TOTP is RFC 6238 math, no model, no
  network) but low priority relative to #1-4.
- **change**: Add a `%name:totp%` placeholder suffix convention in the same resolver as #1; compute
  via any keyless TOTP library (e.g. `otpauth` npm pkg) from the secret seed. Ship only after #1-4
  land since it's a strict extension of the same mechanism.
- **keyless_ok**: true.

### 7. [P2, skip-cargo-cult] Full virtual FileSystem (todo.md / multi-format file store)
- **source_does**: `browser_use/filesystem/file_system.py` implements a whole sandboxed virtual FS
  (`FileSystem` class, line 353+) with typed file classes for md/txt/json/jsonl/csv/pdf/docx/html/xml
  (line 144-345), filename sanitization, extension allowlisting, and a `todo.md` convention the
  agent reads/writes across steps to track its own plan.
- **moxxie_current**: absent — and should stay absent. Moxxie's host is Claude Code / another
  agent harness that already owns a real filesystem, a todo/plan mechanism, and file I/O tools;
  moxxie re-implementing a sandboxed virtual FS + document-format parsers (PDF/DOCX rendering!)
  duplicates the host's own capabilities and adds a large, security-relevant surface (path
  sanitization, extension allowlists) for no marginal capability moxxie's target user doesn't
  already have.
- **recommendation**: skip-cargo-cult.
- **change**: none — explicitly do not add.
- **keyless_ok**: true (would have been keyless, but not worth the bloat).

### 8. [P2, skip-cargo-cult] `is_placeholder_url` mock-hostname heuristic
- **source_does**: `utils.py:is_placeholder_url` (line 28-39) detects benchmark-fixture-style hosts
  like `https://XXX.XX` (all-X-labels) to special-case eval harness URLs.
- **moxxie_current**: absent.
- **recommendation**: skip-cargo-cult — this is browser-use's own eval-harness footgun accommodation
  (their benchmark suite uses `XXX.XX` placeholder domains), not a general security or extraction
  primitive. Nothing in moxxie's egress/redact model needs it; adding it would just be an
  unmotivated special case with no red-team scenario behind it.
- **change**: none.
- **keyless_ok**: true (irrelevant either way).

### 9. [P1, align] Structured-output "loud null" is already ahead of browser-use — no change needed, but name it explicitly as a strength to preserve
- **source_does**: browser-use's extraction path (`tools/registry/service.py` `extraction_schema`
  param, `has_sensitive_data` context flag line 372) does not have an ID-grounding transform at all
  — extraction schemas go straight to the model with real field values/URLs in scope, relying on
  prompt instructions only (no structural guarantee against fabricated URLs).
- **moxxie_current**: `extract/transform.ts` (`transformSchema`, "THE MOAT" comment line 6) and
  `extract/resolve.ts` (generation-gated ID resolution, "loud null" for unknown IDs) are
  structurally stronger than anything in browser-use's extraction path — browser-use has no
  ID-pattern-constrained schema, so a hallucinated URL is only "discouraged," not
  "structurally impossible" the way moxxie already makes it.
- **recommendation**: align (i.e., no code change — but this is a place moxxie should NOT
  regress toward browser-use's weaker free-text-URL extraction just because browser-use is the
  "reference" for other patterns; keep transform.ts/resolve.ts as-is).
- **change**: none required; note only.
- **keyless_ok**: true.

## Top recommendation

Ship #1 + #2 + #3 + #4 as one cohesive feature: a keyless `%placeholder%` secrets layer
(session-held name→value map, optional domain scoping via the *existing* `egress.ts`
`matchesAnySuffix`, resolved only at DOM-dispatch time in `handleAct`) plus a symmetric
value-aware redaction pass (`redactKnownSecrets` in `redact.ts`) applied to every host-facing
read path (snapshot/read/get-text/console, per `injection.ts`'s existing choke-point comment).
Without this, moxxie's `redact.ts` only prevents secrets from leaking via password-typed *field
metadata* — it does nothing to keep the actual secret bytes out of the host LLM's context in the
first place, which is the more important half of what browser-use's `sensitive_data` subsystem
buys, and the whole mechanism is provably keyless (regex/dict substitution + suffix matching,
zero model calls, zero network calls).
