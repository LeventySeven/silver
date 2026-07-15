# browser-use — exhaustive transferable/keyless sweep (round 2, beyond prior digests)

Scope: everything in `research/deepdive/browseruse-{actuation,perception,top5dx}.md` already covered the DOM
serializer (occlusion + compound components), the decorator-driven action registry, `multi_act`'s two-layer
abort, the 13-file watchdog directory (crash/download/permission at a high level), and `<secret>` sensitive-data
indirection. This pass deliberately skips those and reads the parts of `browser_use/` those digests didn't touch:
`filesystem/file_system.py` (941 lines), `agent/judge.py` (225), `agent/variable_detector.py` (276),
`skills/service.py` (285) + `skills/views.py`, `dom/markdown_extractor.py` (547), `actor/mouse.py` (134),
`browser/watchdogs/popups_watchdog.py` and `storage_state_watchdog.py`, `browser/session_manager.py` (918),
`browser/chrome.py` (126), `integrations/gmail/service.py` (225), `config.py` (525). All read in full or to
completion of the relevant section. Cross-checked against `silver/src` for gap confirmation via targeted reads.

## 1. Structure-aware markdown chunking with header-preferred splits and table-header carry-forward — HIGH, keyless

`dom/markdown_extractor.py:409-546` (`chunk_markdown_by_structure`). A two-phase algorithm: Phase 1
(`_parse_atomic_blocks`, lines 221-390) walks the markdown line-by-line and groups it into indivisible blocks
(HEADER, CODE_FENCE, TABLE-row, LIST_ITEM-with-continuations, PARAGRAPH, BLANK) — a code fence is never split
mid-block even if it blows the chunk budget, and each table data row is its own block so a table CAN split
between rows but never mid-row. Phase 2 does greedy accumulation against `max_chunk_chars` (default 100k), and
when a block would overflow the current chunk, it scans backward for the nearest HEADER block and — only if the
resulting split leaves ≥50% of the budget filled — splits there instead of at the arbitrary overflow point
(lines 466-475), so a chunk boundary lands on `## Section` rather than mid-paragraph when a good split point
exists nearby. Phase 3 builds `overlap_prefix` (last N lines of the previous chunk, default 5) for context
continuity across chunk reads, with a special case: if a chunk begins mid-table, the *original table header +
separator* row is prepended (not just the last N lines) so a continuation chunk read in isolation still shows
column names (lines 502-513) — and this header is tracked forward across multiple chunks (`prev_chunk_last_table_header`,
line 488, 517-525) so a table spanning 3+ chunks doesn't lose its header after chunk 2.

**Why it matters for Silver**: this directly targets the token-efficiency axis the project is graded on. Silver's
extraction path (need to verify current chunking, if any) presumably either returns full page markdown/text
unbounded or does naive char-count slicing. Naive slicing mid-table or mid-code-fence produces garbage the host
LLM has to reconstruct mentally; header-preferred + table-aware chunking is a pure quality/reliability win with
no downside, and it is a self-contained ~150-line algorithm with no CDP/browser dependency — portable to
TypeScript almost mechanically (same block-type enum, same greedy assembly, same backward-header-scan).
**Concrete Silver change**: new `src/perception/chunk.ts` implementing the same three-phase algorithm, wired into
whatever verb currently returns extracted page text/markdown when it exceeds a size threshold; expose
`--start-from-char`/chunk-index continuation the way `chunk_markdown_by_structure`'s `start_from_char` param does
(lines 427, 541-545) so the host LLM can page through a long extraction across multiple CLI calls.
**KEYLESS check**: pure regex/string algorithm, zero LLM calls, zero CDP calls. **Priority: P1.**

## 2. SPA JSON-blob stripping from markdown extraction — MEDIUM, keyless

`dom/markdown_extractor.py:_preprocess_markdown_content` (lines 146-191). Three regexes specifically target
embedded state blobs that `markdownify` doesn't know to drop: JSON inside code-fenced spans (`` `{"key":...}` ``),
`{"$type":...}` (a common Facebook/React-Relay serialization marker), and generic nested-JSON-with-100+-char-values
patterns. A final pass walks each non-blank line and, for any line >100 chars starting with `{`/`[`, attempts
`json.loads` and drops it if it parses (lines 178-184) — catching SPA hydration-state dumps (LinkedIn, Facebook,
many React sites embed multi-KB JSON blobs as inline text nodes) that would otherwise dominate token count in a
markdown extraction with near-zero information value to the LLM.

**Silver gap**: whatever Silver's markdown/text extraction path does today (needs confirming against
`src/perception/`), this specific SPA-blob-noise problem is a named, recurring failure mode not addressed by
generic whitespace trimming. **Concrete Silver change**: add the same three-regex + parse-and-drop pass as a
post-filter step in the extraction path, immediately after markdown conversion. Cheap (few regexes), high
payoff on the specific site category (component-library-heavy SPAs) that also shows up as the "modal occlusion"
problem in the prior perception digest — same site category, different symptom. **Priority: P2** (real but
narrower than #1 — only triggers on a specific class of site).

## 3. Auto-detected reusable variables from action history — HIGH, novel, fully keyless (no LLM call needed)

`agent/variable_detector.py` (276 lines, read in full) — genuinely missed by both prior digests, which focused
on actuation/perception, not agent history post-processing. `detect_variables_in_history` walks a completed
agent run's `AgentHistoryList` and, for every text-bearing action param (`text`/`query` fields), tries two
**pure heuristic, zero-LLM** strategies in priority order: (1) `_detect_from_attributes` (lines 123-210) inspects
the DOM element that was actually interacted with — `type="email"` → `email`, `type="tel"` → `phone`,
`id`/`name`/`placeholder`/`aria-label` substring matching against a curated keyword table (`address`, `billing`,
`shipping`, `comment`, `phone`, `first`/`last`/`full name`, `date`/`dob`, `city`, `state`, `zip`/`postal`,
`company`) — this is the reliable path because it uses ground-truth DOM semantics, not the value's shape; (2)
`_detect_from_value_pattern` (lines 213-256) is the fallback when no element context exists — regex/format
sniffing on the raw string itself (email regex, digit-count phone heuristic, `YYYY-MM-DD` date regex, capitalized-word
name heuristic, pure-digit number heuristic). Detected variables get de-duplicated by exact value and
uniquified by name (`first_name` → `first_name_2` on collision, lines 259-276).

**Why this is a big, underexploited idea for Silver specifically**: Silver already has a `memory`/task-replay
concept per the project brief ("full verb parity + tasks + subagents + memory"). This is the missing piece that
turns a raw action trace into a **parameterized, reusable macro** without ever calling a model — after a
successful run, Silver could emit a diff between "what values were typed" and "what the DOM told us this field
semantically is" and surface it as `{{email}}`, `{{first_name}}`, `{{shipping_address}}` placeholders in a saved
task/skill file. This is the mechanism that would let a saved Silver task become genuinely reusable across
different runs with different data (e.g., "fill out this signup form" → replay with a new email each time)
instead of a fixed script with hardcoded values baked in from the recording. **Concrete Silver change**: new
`src/memory/variableDetect.ts` mirroring the two-strategy cascade, run as a post-process step when saving a task
recording (wherever Silver's `memory`/task-save path lives), annotating the saved task JSON with detected
variable slots the host LLM can then override per-invocation via `--var name=value`. **KEYLESS check**: 100%
pure regex/string heuristics over already-captured DOM attributes and action params — no model call anywhere in
this file. **Priority: P1** — this is a capability gap, not a polish item; it's the mechanism that makes "memory"
actually general-purpose instead of single-use.

## 4. Filename sanitization + directory-traversal-safe file resolution — MEDIUM, keyless, security-relevant

`filesystem/file_system.py:_resolve_filename` (lines 451-470) and `sanitize_filename` (423-449). Every file
operation (`read_file`, `write_file`, `append_file`, `replace_file_str`) routes through `_resolve_filename`,
which first calls `os.path.basename(file_name)` (line 460) — stripping any path components — *before* validating
against the filename regex, explicitly to defeat `../../../etc/passwd`-style traversal from an LLM-controlled
filename argument (the docstring says this outright, line 454: "Normalizes to basename first to prevent
directory traversal"). If the basename still doesn't match the allowed pattern (`_is_valid_filename`, regex at
line 415 — alphanumeric + underscore/hyphen/dot/parens/spaces/CJK, must end in an allowed extension), it attempts
one round of `sanitize_filename` (replace spaces with hyphens, strip disallowed chars, collapse repeat hyphens,
falls back to literal `'file'` if the name becomes empty) and only proceeds if *that* now validates — giving the
LLM a helpful "auto-corrected from X to Y" message (line 705) rather than a hard failure, while never touching
the filesystem with an unsanitized path.

**Silver relevance**: any Silver verb that takes a filename from the host LLM (`extract --out`, saved-task names,
memory file names, screenshot save paths) is exposed to the identical class of risk — a prompt-injected page
content or a malformed host instruction constructing `../../secrets.json` as a save target. **Concrete Silver
change**: audit every Silver code path that writes to disk based on an LLM-suppliable string argument and route
through a single `resolveFilename()` chokepoint doing exactly this basename-first + regex-validate + one-shot-
sanitize-with-fallback sequence, mirroring the existing pattern of `redactValue`/`groundRef` as a single
enforced choke point rather than scattered ad-hoc checks. **KEYLESS check**: pure path/string logic.
**Priority: P1** — this is a security hardening item in the same family as the `<secret>` write-path gap the
prior digest flagged P0/P1; worth checking now rather than after an incident.

## 5. Format-specific file writers: CSV auto-repair, IDF-ranked PDF page prioritization — MEDIUM-HIGH, keyless

`filesystem/file_system.py`, two distinct mechanisms:

- **CSV auto-normalization** (`CsvFile._normalize_csv`, lines 180-229): every CSV write/append is re-parsed
  through Python's `csv` module and re-serialized, specifically to fix "common LLM mistakes" per the docstring —
  unquoted fields containing commas, unescaped internal quotes, inconsistent empty fields, and a clever
  double-escape detector: if content has no real newlines but contains literal `\n` and `\"` sequences (line
  196), it's almost certainly a JSON-tool-call round-trip that mangled the payload, so it un-escapes before
  parsing. This closes a very real failure mode: an LLM emitting CSV content through a JSON-encoded tool-call
  argument routinely double-escapes newlines, and a naive "write string to file" verb would silently produce a
  single-line garbled CSV.
- **IDF-weighted PDF page selection for large PDFs** (`read_file_structured`, lines 574-660): for a PDF whose
  total extracted text exceeds a 60,000-char budget, rather than truncating from page 1, it computes an
  inverse-document-frequency score per page — words appearing on fewer pages score higher (`math.log(num_pages /
  pages_with_word)`, line 599) — and prioritizes pages with the most *distinctive* content (page 1 always
  included first, line 604), packing pages into the budget by score order, then reports exactly which pages were
  skipped (line 647) so the LLM knows to re-query with `start_from_char` if it needs a skipped page. This is a
  genuinely well-thought-out large-document strategy: naive truncation reads page 1-N and silently misses
  content on page N+1 even if page N+1 is where the unique/relevant information lives (e.g., an appendix, a
  distinctive clause in a long contract).

**Silver relevance**: if Silver's `extract`/file-write verbs handle CSV or PDF at all, both of these are direct,
low-effort ports. Even if Silver currently has no PDF-reading path, the IDF-ranking technique generalizes to
*any* oversized-document truncation problem Silver faces (large page extractions, large `--out` writes) — it's
the more principled sibling of the structure-aware chunking in item #1: chunking preserves order and readability,
IDF-ranking optimizes for "what's least likely to be redundant with content already shown." **Priority: P2 for
CSV auto-repair** (narrow but a real, concrete LLM-tool-call failure mode with a one-function fix); **P3 for
IDF PDF ranking** unless Silver already has meaningful PDF-extraction traffic, in which case P1.

## 6. `describe()` — asymmetric head/tail file preview for a multi-file workspace listing — LOW-MEDIUM, keyless

`filesystem/file_system.py:describe` (lines 814-885). When listing all files in the agent's working directory
(analogous to a Silver `memory`/workspace listing), files under ~600 chars are shown in full; larger files get a
head-preview and tail-preview built by walking lines forward/backward until a `DISPLAY_CHARS/2` budget is
exhausted on each end (lines 846-865), with the omitted middle summarized as `"... N more lines ..."` — giving
the LLM a workspace overview without spending full-file token budget on every file, while still showing both the
start (usually headers/context) and end (usually the most recent/conclusion) of long files. Small, cheap, and
directly reusable anywhere Silver shows a directory/file listing to the host LLM with size constraints (memory
listing, downloaded-file listing). **Priority: P3** — nice-to-have UX polish, not a capability gap.

## 7. Skills-as-typed-parameterized-macros with cookie-injection — MEDIUM, architecture worth mirroring keylessly

`skills/service.py` (285 lines) + `skills/views.py` describe browser-use's **paid**, cloud-hosted "Skill" concept
— NOT keyless as implemented (requires `BROWSER_USE_API_KEY`, fetches skill definitions + executes them via a
remote API call, `execute_skill`, line 165). Flag this explicitly as non-adoptable *as implemented*. But the
**pattern** is worth extracting on its own: a Skill has a declared Pydantic parameter schema (validated locally
before dispatch, lines 226-252) plus a special parameter *type* — `cookie` — that the framework auto-fills from
the live browser session's cookie jar rather than requiring the caller to supply it (lines 194-224): if a skill
declares a required `cookie` param and the session doesn't currently hold a cookie with that name, it raises a
typed `MissingCookieException` carrying a human-readable description (`cookie_description`) rather than a bare
KeyError — this is a clean "declare what live session state a saved macro needs, get an actionable error if it's
missing" pattern. **Silver relevance**: Silver's saved-task/memory format (mentioned in the project brief) could
adopt the same idea *without any remote execution* — a saved task declares required cookies/storage-state keys
(e.g., "requires a `session_id` cookie on `example.com`"), and replay checks the live session's cookie jar
before running, failing fast with an actionable message instead of failing mysteriously mid-task on an
auth-gated action. Combine with item #3 (variable detection) for a genuinely reusable local task format: detected
*input* variables + declared *session-state* prerequisites. **Priority: P2** — the cookie-prerequisite-check
piece is cheap and valuable; do not adopt the remote-skill-fetch architecture (violates keyless).

## 8. LLM-judge rubric structure — the rubric itself is portable even though judging isn't keyless — LOW

`agent/judge.py` (225 lines). Not itself adoptable (it's an explicit LLM-call construction for eval scoring), but
the **rubric structure** is a genuinely well-designed eval framework worth mining for Silver's own eval-gating
process (the project brief mentions Silver is "eval-gated," 235 tests): explicit `FAILURE_CONDITIONS` list that
auto-fails regardless of subjective quality (captcha-blocked, wrong output format, infinite loops, agent moved
on from a required step without completing it, agent fabricated content not present in the actual page/screenshot
state, agent called `done` before completing all task requirements) — this is a checklist of the exact classes
of silent-failure Silver's own eval harness should be independently checking for on recorded traces, not
something requiring an LLM judge to detect (page-crash, captcha-detected, and "claimed done but page state
disagrees" are all mechanically checkable from Silver's own structured action/error log without any model call).
**Concrete Silver change**: none directly executable — this is a checklist to cross-reference against Silver's
existing eval-gate test suite to confirm the same failure classes are covered by deterministic checks, not left
implicit. **Priority: P3 / audit item, not a build item.**

## 9. Dialog auto-handling with a three-tier fallback chain — HIGH, keyless, confirmed zero-coverage gap in Silver

`browser/watchdogs/popups_watchdog.py` (full read of the dialog-handling section, lines 1-160+). Distinct from
and more detailed than what the prior digest's watchdog section covered at a summary level. On `TabCreatedEvent`,
enables the CDP `Page` domain on both the specific tab's session AND the root CDP client (lines 44-57) so dialogs
are caught regardless of which frame/session raises them. The dialog handler applies a **type-specific accept
policy** (lines 74-79): `alert`/`confirm`/`beforeunload` → auto-accept (click OK / allow navigation — chosen as
"safer for automation" since blocking on these stalls the whole session); `prompt` → auto-dismiss (Cancel),
since there's no mechanism to supply free-text input to a native browser prompt. Dismissal itself is attempted
through **three fallback approaches** in sequence, each with its own 0.5s timeout: (1) the exact CDP session that
detected the dialog, (2) the session currently holding agent focus, (3) presumably a root-client broadcast
(cut off in the read, but the pattern of graduated fallback is clear from approaches 1-2). Popup messages are
also captured into `_closed_popup_messages` for inclusion in the next browser-state report to the LLM (line 68),
so the agent knows a dialog appeared and what it said even though it was auto-dismissed without agent
involvement — this prevents both a silent hang (a `window.confirm()` a naive automation would block on forever)
and information loss.

**Silver: confirmed zero coverage**, consistent with the prior digest's blanket "no dialog/popup handler module
anywhere" finding but now with the specific mechanism to port. **Concrete Silver change**: in Silver's
connection/session layer, on session connect, enable `Page` domain and register a `Page.javascriptDialogOpening`
handler applying the same type-specific accept/dismiss policy, with the message captured into whatever
per-command result/log structure the host LLM sees (so the host isn't surprised by a dialog it never knew fired).
This is a correctness fix, not a nice-to-have — any Silver command that inadvertently triggers a native
`confirm()`/`alert()` (form validation, "are you sure" flows, `beforeunload` on navigation away from a filled
form) will currently hang the CDP call until timeout with no informative error. **Priority: P1** — same tier as
the previously-flagged download/permission gap, same root cause (no proactive dialog-lifecycle handling), and
this specific mechanism (type-specific policy + fallback chain + message capture) is a complete, portable
recipe, not just a "watchdogs exist" observation.

## 10. Existing-Chrome-profile detection across macOS/Linux/Windows — MEDIUM, keyless, high practical value

`browser/chrome.py` (126 lines, read in full). `find_chrome_executable()` (line 38) probes a platform-specific
list of standard install paths; `list_chrome_profiles()` (line 95) enumerates the user's actual local Chrome
profile directories (reading `Local State`/`Preferences` JSON to surface profile display names, not just
directory names) so an agent can be pointed at "use my personal Chrome profile" rather than a fresh, logged-out
automation profile. `_chrome_user_data_dir_for_executable` derives the correct `--user-data-dir` for whichever
Chrome variant is found (stable/beta/canary/Chromium have different default profile dirs per OS).

**Why this matters for a keyless agent CLI specifically**: the single biggest practical blocker for browser
automation on real sites is authentication — most useful tasks are on logged-in surfaces (email, banking-adjacent,
internal tools, shopping accounts). Launching against the user's real Chrome profile (with its existing session
cookies) sidesteps that entirely without needing any credential-handling machinery at all — it's the "keyless"
answer to auth in the truest sense: no secret ever enters Silver's process, the browser is just pointed at
storage state that already exists on disk. **Concrete Silver change**: a `--profile <name>` / `--use-chrome-profile`
launch flag in Silver's session/launch code that shells out to the equivalent of `list_chrome_profiles()` (read
`Local State` for profile display names on macOS `~/Library/Application Support/Google/Chrome/`, Linux
`~/.config/google-chrome/`, Windows `%LOCALAPPDATA%\Google\Chrome\User Data\`) and launches with that
`--user-data-dir`+`--profile-directory`. **KEYLESS check**: filesystem probing only, no credentials, no API keys
— strictly stronger than Silver's current presumed default of a fresh/incognito-style profile per session.
**Priority: P1** — this is disproportionately high-leverage for "browser agent that can actually do useful
logged-in tasks" relative to its implementation cost (a directory-scan + JSON-read + launch-flag change).

## 11. Storage-state save/load with cookie-change diffing and non-destructive merge — MEDIUM, keyless

`browser/watchdogs/storage_state_watchdog.py`. `_save_storage_state`/`_load_storage_state` (line ranges 167-233,
233-324) persist cookies + localStorage/sessionStorage to a JSON file compatible with Playwright's own
`storageState` format, but two details go beyond a naive dump: (a) `_have_cookies_changed` (144) is a cheap
pre-check (compares against the last-saved snapshot) so the watchdog doesn't do wasteful CDP round-trips
re-saving unchanged state on every step; (b) `_merge_storage_states` (324, static method) merges *new* state into
*existing* saved state rather than overwriting wholesale — so saving state for `siteA.com` after a prior save
already captured `siteB.com` cookies doesn't destroy the `siteB.com` entries, letting a single storage-state file
accumulate auth across multiple sites/sessions over time rather than being scoped to "whatever the last session
touched." Directly composable with item #10 (real-Chrome-profile) as an alternative auth-persistence mechanism
for Silver's own launched/managed profiles (as opposed to piggybacking on an existing Chrome install) — save
state after a successful login flow once, replay it on every subsequent Silver session without re-authenticating.
**Concrete Silver change**: `--save-storage-state <path>` / `--load-storage-state <path>` flags with the same
diff-before-save and merge-not-overwrite semantics, in Silver's session lifecycle code. **Priority: P2** —
valuable but item #10 (real Chrome profile) covers the same underlying need (persistent auth) with less
implementation surface for the common case of "just use my browser."

## Priority summary

| # | Item | Priority | Keyless? |
|---|---|---|---|
| 9 | Dialog auto-handling (3-tier fallback, type-specific policy) | **P1** | Yes — confirmed zero-coverage gap |
| 10 | Real-Chrome-profile detection + launch | **P1** | Yes — no credentials ever touch Silver |
| 3 | Auto-detected reusable variables from action history | **P1** | Yes — pure regex/DOM-attr heuristics |
| 1 | Structure-aware markdown chunking (header-preferred splits) | **P1** | Yes — pure string algorithm |
| 4 | Filename sanitization / traversal-safe file resolution | **P1** | Yes — security hardening |
| 7 | Cookie/session-prerequisite declaration for saved tasks | P2 | Yes (pattern only, not the paid skill API) |
| 5 | CSV auto-repair on write / IDF-ranked PDF page selection | P2 (CSV) / P3-P1 (PDF, usage-dependent) | Yes |
| 2 | SPA JSON-blob stripping in markdown extraction | P2 | Yes |
| 11 | Storage-state save/load with merge-not-overwrite | P2 | Yes |
| 6 | Head/tail file-listing preview (`describe()`) | P3 | Yes |
| 8 | LLM-judge rubric as an eval-gate coverage checklist | P3 (audit only) | N/A — not adopted as code |
| — | Gmail OAuth 2FA-code service | Not adopted | No — requires Google OAuth credentials, contradicts keyless framing |
