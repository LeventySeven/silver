# Deep-dive: Vercel's top 5 + agent DX (two-tier skills, --json envelope, error UX) vs Silver

Sources read directly (full functions, not excerpts): `rust-oracle/cli/src/native/daemon.rs`,
`connection.rs`, `native/cdp/client.rs`, `native/browser.rs`, `native/snapshot.rs`,
`native/diff.rs`, `native/state.rs`, `skills.rs` (622 lines, full), `output.rs`
(lines 1–1740 of 3952: the entire `print_response_with_opts` dispatcher + all
help text through the Keyboard section), `commands.rs` (`ParseError` + `format()`),
`main.rs` (error-exit call sites, `print_json_error_with_type`), `validation.rs`
(full, 60 lines). Cross-checked against Silver's `core/session.ts`, `core/lock.ts`,
`core/envelope.ts` (full, 67 lines), `core/errors.ts` (full, 93 lines), `cli.ts`
(dispatcher + `mapThrow`), `security/injection.ts` (full, 71 lines),
`core/handlers.ts` (`handleSkill`), `perception/refmap.ts`, `perception/diff.ts`.
Seeds `top5-vercel.md` and `engine-vercel-deep.md` verified against source, not
copied verbatim — findings below extend them with the requested DX lens.

---

## The top 5 (verified against seeds, one correction)

**1. Persistent daemon + one warm CDP WebSocket — Silver: real GAP, unclosed.**
`daemon.rs` (`run_daemon`) owns the browser and a single `CdpClient` for the
process's whole life; `connection.rs::send_command_once` (line 1095) opens a
FRESH Unix-socket connection per CLI call but that hop is cheap (local socket)
— the expensive WebSocket handshake, `Runtime.enable`/`Accessibility.enable`,
and target bookkeeping are paid ONCE. Silver's `session.ts::connect` (line 328)
calls `chromium.connectOverCDP` fresh on every invocation; the browser process
persists (parity) but the connection/session-warmth does not. Measured on this
machine (`engine-vercel-deep.md`): Silver's warm-browser command is ~200ms wall
vs Vercel's <5ms thin-client boot — and the dominant cost is **not** the CDP
reconnect (~25ms/~12%) but the ~180ms Node+Playwright module load paid on every
process. **Adopt, priority P0**: port `daemon.rs`/`connection.rs` to Node —
Phase 1 (dynamic `import('playwright')` off the client path, ~150ms win, zero
behavior change, ship first) then Phase 2 (`silver __daemon`, detached +
unref'd, JSON-line socket protocol mirroring `handle_connection`) then Phase 3
(enable domains/attach handlers once on the held connection). Full 3-phase plan
already drafted in `engine-vercel-deep.md` §5 — this digest confirms it against
source and adds nothing new to the plan itself.

**2–3. `eN` ref format + diff-when-shorter snapshots — Silver already matches
and extends both**, per the prior sweep (`refmap.ts`'s `generation`/staleness
gate has no Vercel equivalent in `native/element.rs`; `diff.ts`'s
shorter-of-diff-or-full-tree fallback is a strictly smarter default than
Vercel's unconditional-diff-when-changed in `diff.rs:103-148`). Re-verified,
no correction needed.

**4. Two-tier docs-in-binary skill system — Silver: PARTIAL GAP, worse than
previously scoped.** `skills.rs` ships a genuine two-directory design:
`skills/` (hidden, npm-discovery stubs) + `skill-data/` (real content: comment
at `skills.rs:20-29` names `core`, `electron`, `slack`, `dogfood`). `skills
list` (`run_list`, `skills.rs:214-256`) prints name + a word-boundary-truncated
description (`truncate_description`, `skills.rs:165-177`, cuts at 70 chars,
multibyte-safe per its own test at `skills.rs:597-602`); `skills get <name>`
(`run_get`, `skills.rs:258-366`) returns the full `SKILL.md` and, with
`--full`, every file under that skill's `references/`/`templates/` subdirs
(`collect_supplementary_files`, `skills.rs:185-212`, sorted by filename). Both
subcommands support `--json` with a clean `{success,data}` shape and a
`skills path` command for direct filesystem access. Checking Silver against
this on disk (`find skill-data -maxdepth 1 -type d` → only `core` exists):
Silver has exactly ONE skill, no `list`/`get` split at all — `handleSkill`
(`handlers.ts:1500`) is a single-shot handler that reads one hardcoded path
(`path.join(PACKAGE_ROOT, 'skill-data', 'core', 'SKILL.md')`) and returns
either `compactHead(onDisk)` or, with `--full`, the whole file. That
compact/full split is a real (if narrow) parallel to Vercel's list/get
two-tier, but it only tiers ONE skill's detail level — it cannot discover or
address a second topic, there is no `references/`/`templates/` supplementary
mechanism, and there is no name-addressed `get <name>`. **Adopt, priority P1**:
add a `skill-data/<topic>/SKILL.md` convention with YAML frontmatter
(`name`/`description`), a `skill list` that scans and truncates descriptions,
and keep `skill get <name> [--full]` as the addressed form — 1-2 new topic
skills (e.g. `extract`, `security`) would let an agent pull only what's
relevant instead of the current all-or-nothing.

**5. Session/storage save-restore — matched, Silver adds encryption.**
Re-verified: `state.rs:248-320` (`save_state`) collects cookies +
localStorage/sessionStorage (including unvisited origins via a temp target) to
plain `serde_json::to_string_pretty` JSON. Silver's sidecars
(`session.ts:144-162`, AES-256-GCM via `state-crypto.ts`) cover the same
ground and encrypt at rest by default. No gap; Silver ahead here.

---

## Agent DX: `--json` envelope, error UX, prompt-injection fencing

### `--json` envelope shape: structurally near-identical, human-mode UX diverges hard
Vercel's `Response` (`connection.rs:34-40`): `{success, data, error,
warning?}`. Silver's `Envelope<T>` (`envelope.ts:10-15`): `{success, data,
error, warning?}` — the same four fields, same optional-warning convention.
**No gap on the JSON contract itself.** The divergence is in the NON-json
render path, which matters because a host LLM sometimes runs Silver
interactively without `--json` (e.g. through a shell tool) and gets whatever
the human-mode formatter produces. Vercel's `output.rs::print_response_with_opts`
is a ~930-line (and growing — file is 3952 lines total) hand-written dispatcher
that pattern-matches on the response shape and action name to produce
purpose-built text for every single verb family: dialogs get a `? JavaScript
{type} dialog is open: "{msg}"` with resolution instructions inline
(`output.rs:325-350`), confirmation prompts print the exact `silver confirm
<id>` / `silver deny <id>` follow-up commands (`print_confirmation_required`,
`output.rs:165-187`), Web Vitals get a computed multi-line report
(`format_vitals_text`, `output.rs:217-279`), tabs/cookies/network requests/iOS
devices/auth profiles/state files each get their own compact table-like
renderer. Silver's `envelope.ts::humanForm` (`envelope.ts:52-67`) is 15 lines
total: on success it does `typeof data === 'string' ? data :
JSON.stringify(data, null, 2)` — i.e. every non-string success payload in
human mode is a generic pretty-printed JSON blob, none of Vercel's per-action
formatting (no confirmation follow-up hint, no dialog-specific phrasing, no
"Screenshot saved to X" / "Tab [3] closed" style success lines). **GAP,
priority P2** (below the daemon and skill catalog — `--json` is Silver's
primary/documented mode per its header comment, so this mostly matters for
interactive/manual use, not the host-LLM hot path): port a handful of
Vercel's highest-value text renderers (confirmation prompt with the literal
follow-up command, dialog status, tabs, path-based "X saved to Y") into
`humanForm` or a thin wrapper around it, gated by `action` the same way Vercel
gates by `action: Option<&str>`.

### Error taxonomy: Silver's design is MORE disciplined where it counts, narrower where Vercel is stronger
This is a genuine two-way split, not a one-directional gap.

Vercel's `ParseError` (`commands.rs:11-31`, `format()` at `commands.rs:34-60`)
covers exactly argv-parsing failures: `UnknownCommand`, `UnknownSubcommand`
(with a `valid_options: &'static [&'static str]` list baked into the message,
`commands.rs:42-48`), `MissingArguments`/`InvalidValue` (both append `"Usage:
silver {usage}"` from a `&'static str` literal owned by the call site,
`commands.rs:49-57`), `InvalidSessionName`. Only THIS path gets a `"type"`
field in JSON mode — `main.rs:1088-1095` maps each `ParseError` variant to a
string like `"unknown_subcommand"` via `print_json_error_with_type`. Grepped
for `"type":` as an error-classification field anywhere else in the runtime
(daemon-side command execution, `native/*.rs`) — every hit is an unrelated CDP
event-type field (`actions.rs` mouse/touch/key event payloads), confirming
**Vercel's actual command-execution failures (the ones surfaced from inside
the daemon, i.e. the vast majority of real-world errors an agent hits) carry
no error code/type at all — just a free-form `error: Option<String>`.** No
retryability signal anywhere in the Rust code.

Silver inverts this: `errors.ts` defines a CLOSED taxonomy of 13 codes
(`ref_stale`, `element_not_found`, `element_obscured`, `timeout`,
`navigation_blocked`, `captcha_detected`, `page_crash`, `auth_required`,
`not_permitted`, `confirm_required`, `path_denied`, `output_overflow`,
`session_busy`) where EVERY entry carries both a fixed recovery-instruction
`message` (documented as "the message IS the recovery instruction handed to
the host LLM", `errors.ts:4`) and a `retryableByHost: boolean`. `mapThrow`
(`cli.ts:120-135`) is the single choke point that converts any thrown value —
typed engine errors (`OutputOverflowError`, `ResolveError`, `WaitError`), any
object carrying a `.code` that's a real taxonomy member, or a bare
`TimeoutError` — into one of these codes, with an explicit fallback to
`page_crash` for anything unrecognized so a raw stack/path/secret can never
leak into `error` (enforced by `no-leak.test.ts` per the doc comment). This
is a fundamentally more agent-usable design for the command-execution path:
every failure an agent sees is one of 13 known strings it can branch on, each
telling it exactly what to do next (`'refs are stale...; run snapshot again
and retry'`), plus a machine-checkable retry signal Vercel's runtime path does
not have at all. **No gap — Silver is ahead on runtime error UX.** The one
place Vercel is ahead: `UnknownSubcommand`'s `valid_options` list
(`commands.rs:42-48`) gives an explicit enumerated menu of what WAS valid,
which Silver's `not_permitted`/generic parse failures don't reproduce (Silver
doesn't need per-subcommand valid-option enumeration since `flags.ts` doesn't
appear to build one — worth a look if precise argv-typo UX becomes a priority,
but it's a minor, P3 item since neither CLI implements fuzzy "did you mean"
matching — grepped for `levenshtein`/`did_you_mean`/`closest` across all of
`rust-oracle/cli/src`, zero hits outside unrelated DOM `.closest()` calls).

### Prompt-injection / content-boundary fencing: Silver's mechanism is stronger
Vercel's `content_boundaries` (`output.rs:61-93`) wraps free-form output in
`--- SILVER_PAGE_CONTENT nonce={hex} origin={url} ---` / `--- END_... ---`,
where the nonce is a per-PROCESS CSPRNG value (`getrandom`, `output.rs:11-17`)
unpredictable to a hostile page. It does NOT strip anything from the body
first — a page that emits text resembling the boundary format just sits there
unmodified; unforgeability relies entirely on the page not being able to guess
the nonce for THIS run. Flag is opt-in, default `false`
(`flags.rs:549-550`, `content_boundaries.unwrap_or(false)`).

Silver's `neutralize()` (`security/injection.ts:47-56`) uses STABLE markers
(`⟦page-content untrusted⟧` / `⟦/page-content⟧`, U+27E6/U+27E7 — chosen
because they're "not producible by plain HTML") but actively de-fangs the
glyphs themselves inside the body BEFORE wrapping
(`FENCE_GLYPH_RE`, `injection.ts:38-44`, replacing any `⟦`/`⟧` a hostile page
injected with plain `[`/`]`) and separately regex-strips forged
transcript-role tags (`<system>`, `</assistant>`, `<untrusted ...>`,
`FORGED_ROLE_RE`/`FORGED_UNTRUSTED_RE`, `injection.ts:29-32`), replacing each
with a visible `[PROMPT_INJECTION_NEUTRALIZED]` breadcrumb. Both defaults
differ per Silver's own header comment (flags.ts:12: `--content-boundaries` is
ON by default in Silver, opt-out via `--no-content-boundaries`) — the opposite
default from Vercel's opt-in. **No gap — Silver's mechanism is strictly
stronger** (active content sanitization + on-by-default, vs Vercel's
passive-unpredictability + opt-in), worth flagging as a real Silver
differentiator to keep, not something to reconcile toward Vercel.

---

## Priority-ranked adopt list

| P | Item | Effort | Source |
|---|---|---|---|
| P0 | Persistent daemon + warm CDP connection (3-phase plan, Phase 1 first) | High, phased | `daemon.rs`, `connection.rs`, `cdp/client.rs` |
| P1 | Multi-topic skill catalog + `skill list`/`skill get <name>` split, `references/`/`templates/` supplementary files | Medium | `skills.rs` (full file is a near-drop-in spec) |
| P2 | Port ~5 of Vercel's highest-value human-mode text renderers (confirm prompt w/ follow-up command, dialog status, path-saved messages, tabs) into `humanForm` | Low | `output.rs:165-187, 325-350, 900-1000` |
| P3 | (Optional, low value) `UnknownSubcommand`-style enumerated valid-options list on Silver's parse errors | Low | `commands.rs:39-48` |

**No action needed** (Silver already matches or beats): `eN` refs +
generation-staleness gate, diff-when-shorter snapshots, session/storage
save-restore with encryption, the core `--json` envelope contract, the
runtime error taxonomy + retryability signal, and content-boundary
prompt-injection fencing.
