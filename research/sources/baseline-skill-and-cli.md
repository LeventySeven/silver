# Baseline mining: core-agent-browser SKILL.md + agent_browser.py provider/tests

Sources read in full:
- `/Users/seventyleven/Desktop/best-rust-patterns-skills/skills/core-agent-browser/SKILL.md` (117 lines)
- `/Users/seventyleven/Desktop/badresearch/src/bad_research/browse/agent_browser.py` (471 lines)
- `/Users/seventyleven/Desktop/badresearch/src/bad_research/browse/base.py` (77 lines)
- `/Users/seventyleven/Desktop/badresearch/tests/test_browse/test_agent_browser_browse.py`
- `/Users/seventyleven/Desktop/badresearch/tests/test_browse/test_agent_browser_snapshot.py`
- `/Users/seventyleven/Desktop/badresearch/tests/test_browse/test_agent_browser_cli.py`
- `/Users/seventyleven/Desktop/badresearch/tests/test_browse/conftest.py`
- `/Users/seventyleven/Desktop/badresearch/tests/test_browse/test_graceful_degradation.py`

---

## Killer Insight

The baseline's real innovation is not the CLI surface (that's a thin Playwright-ish wrapper) —
it's the **provider/ladder architecture around it**: agent-browser is treated as one *keyless,
availability-gated tier* in a fallback ladder (crawl4ai/httpx below it, LLM-extraction above
it), the CLI's own argv/stdout boundary is fully mocked out behind an injectable `Runner`
callable for 100%-hermetic tests, and the accessibility-snapshot `@eN` ref system is the single
grounding mechanism that prevents the host LLM from hallucinating a click target — a step whose
`@ref` isn't a key in the *most recent* parsed snapshot is silently skipped, never executed.
That "ref must exist in last-seen snapshot, or no-op" contract, combined with "any page-changing
action forces a mandatory re-snapshot before the next step," is the load-bearing safety
mechanism the ultimate CLI must preserve and can generalize (e.g., to a hash/generation-token
that invalidates stale refs even more strictly than a lookup miss).

---

## Patterns

### 1. Ref-normalization: accept three surface syntaxes, canonicalize to one
- **What**: `@e1`, `ref=e1`, and bare `e1` all normalize to `e1`.
- **Why**: The host LLM (Claude Code) will paraphrase refs inconsistently across turns/tools;
  strict-equality matching would silently break grounding. Accepting all three input shapes
  while storing/looking-up by one canonical form removes an entire class of "ref not found"
  false negatives without weakening the grounding check itself.
- **How**: `normalize_ref(ref)`: strip whitespace, strip leading `@`, strip leading `ref=`.
  Apply on both write (when populating `Snapshot.refs` keys) and read (`has_ref`).
- **Evidence**: `agent_browser.py:201-208` (`normalize_ref`); `refs = {normalize_ref(k): v for
  k, v in raw_refs.items() ...}` at `agent_browser.py:255`; asserted by
  `test_agent_browser_snapshot.py:24-29,32-35` (`has_ref("@e3")`, `has_ref("e3")`,
  `has_ref("ref=e3")` all True, `has_ref("@e99")` False).
- **Tier**: CORE.

### 2. Grounding gate: a step's ref must be a key in the CURRENT snapshot or it's a no-op
- **What**: Before dispatching any step, if `step.target` starts with `@` and
  `not snap.has_ref(step.target)`, the step is skipped (`continue`) — never dispatched, never
  raises.
- **Why**: This is the single mechanism preventing hallucinated/stale-ref clicks from ever
  reaching the browser. It fails closed (skip) rather than open (best-effort click on a guess),
  and it fails silently rather than crashing the whole loop over one bad step — so one bad LLM
  guess doesn't abort a 12-step plan.
- **How**: `if step.target.startswith("@") and not snap.has_ref(step.target): continue`. Ref
  membership is checked against whatever `snap` currently is — meaning it MUST be updated after
  every page-changing step (see #3) or grounding becomes stale and permissive.
- **Evidence**: `agent_browser.py:404-406`; test:
  `test_step_grounding_skips_refs_absent_from_snapshot` in
  `test_agent_browser_browse.py:88-96` (click @e99 → `cmds.count("click") == 0`).
- **Tier**: CORE.

### 3. Mandatory re-snapshot after page-changing actions
- **What**: A fixed set `_PAGE_CHANGING = {"click", "press", "select"}` (note: NOT `fill` or
  `type`) triggers `cli.wait_load("networkidle")` then a full re-`snapshot()` immediately after
  dispatch, updating the `snap` variable used by the grounding gate on the next loop iteration.
- **Why**: Refs are only valid for the DOM state they were captured from. Any action that can
  navigate, submit, or re-render must invalidate old refs before the next grounding check —
  otherwise you get "found ref stale DOM node" failures class of bugs common in LLM-driven
  browser agents.
- **How**: `if step.kind in _PAGE_CHANGING: cli.wait_load("networkidle"); snap =
  parse_snapshot(cli.snapshot(interactive=True))`. Fill/type are excluded because they don't
  navigate or typically re-render the whole page — a defensible but debatable optimization
  (worth reconsidering: some SPAs re-render on every keystroke via controlled inputs).
- **Evidence**: `agent_browser.py:330,409-411`; test:
  `test_browse_executes_supplied_steps_then_resnapshots` in
  `test_agent_browser_browse.py:49-66` (fill×2 + click → `cmds.count("snapshot") >= 2`).
- **Tier**: CORE.

### 4. Injectable subprocess Runner seam for 100%-hermetic tests
- **What**: `Runner = Callable[..., tuple[int, str, str]]` — `(argv, *, timeout, env, stdin) ->
  (returncode, stdout, stderr)`. Production uses `_default_runner` (`subprocess.run`); every
  test injects a `FakeRunner` that records argv and returns canned stdout, routed either by
  a `replies` queue (pop in order) or a `route` dict keyed by the parsed command word. NO real
  subprocess ever spawns in the test suite.
- **Why**: Lets you assert exact argv construction (flag order, quoting-by-argv-element, stdin
  vs argv routing) without ever touching a real browser — fast, deterministic, no flake from
  actual page loads. This is the single most valuable *engineering* pattern to copy into the
  ultimate CLI's own test harness, and into any Python/agent orchestration layer that wraps it.
- **How**: `_first_command_word(argv)` in the fake skips the program name and any
  `_GLOBAL_VALUE_FLAGS = {"--engine","--session","--state","--headers"}` (2-token skip) or bare
  `--flag` (1-token skip) to find the actual subcommand word, so routing works regardless of
  how many global flags precede it.
- **Evidence**: `agent_browser.py:43-56` (Runner type + `_default_runner`); full FakeRunner at
  `conftest.py:101-153`.
- **Tier**: CORE (for the orchestration layer, not the Rust CLI itself).

### 5. Tolerant, never-raise snapshot parsing — degrade to empty, not exception
- **What**: `parse_snapshot(stdout)` catches `JSONDecodeError`/`TypeError` → empty `Snapshot()`;
  checks `payload.get("success")` truthy and `data` is a dict, else empty; checks
  `data["snapshot"]` is `str` else `""`; checks `data["refs"]` is `dict` else `{}`; filters
  individual `raw_refs` entries to only those whose value `isinstance(v, dict)`.
- **Why**: A CLI's JSON contract can drift (a field becomes a list instead of a dict, a number
  instead of a string) — this function is defensively typed against every one of those
  divergences so the caller never has to try/except around parsing; it always gets a valid
  (possibly empty) `Snapshot` to reason about.
- **How**: Layered `isinstance` checks at every field access, each with a safe fallback, no
  `dict[...]` direct indexing without a prior type check.
- **Evidence**: `agent_browser.py:237-263`; tests:
  `test_malformed_json_returns_empty_snapshot_no_raise`,
  `test_success_false_returns_empty_snapshot`,
  `test_type_divergent_refs_degrade_no_raise` (refs as `[1,2]` list → `{}`),
  `test_type_divergent_snapshot_degrade_no_raise` (snapshot as `123` int → `""`),
  `test_non_dict_data_returns_empty_snapshot_no_raise` — all in
  `test_agent_browser_snapshot.py:49-80`.
- **Tier**: CORE.

### 6. `is_empty` heuristic + engine-fallback ladder (lightpanda → chrome)
- **What**: `Snapshot.is_empty` is `len(self.refs) < MIN_REFS_FOR_NONEMPTY` where
  `MIN_REFS_FOR_NONEMPTY = 2`. In `browse()`, if `engine == "lightpanda" and snap.is_empty`, the
  provider transparently re-runs `open` + `wait_load` + `snapshot` on `engine = "chrome"` — same
  command surface, just a different `--engine` flag value.
  `MIN_REFS_FOR_NONEMPTY = 2` rather than 0 deliberately treats a near-empty page (e.g. just a
  loading spinner with 1 ref) as still "failed to hydrate."
- **Why**: Lightpanda (lightweight non-Chromium engine) is fast/cheap but fails on JS-heavy SPAs
  that never hydrate content into the accessibility tree. Rather than surfacing that failure to
  the caller, the provider silently escalates to a full Chrome engine — cost/speed optimization
  with a correctness safety net, and it's a two-rung ladder inside a single provider (distinct
  from the outer browse-provider ladder in `base.py`/`ladder.py`).
- **How**: constant threshold (2) chosen empirically ("dossier 14 §12.5 lightpanda→chrome
  fallback floor" per the module's own comment) — worth re-deriving/tuning rather than copying
  the literal `2`, but the *mechanism* (retry same op on a stronger engine when output looks too
  thin) is directly transferable, e.g. to a "static fetch → headless browser" escalation.
- **Evidence**: `agent_browser.py:39,222-224,393-397`; test:
  `test_lightpanda_empty_snapshot_falls_back_to_chrome` in
  `test_agent_browser_browse.py:69-86` (asserts both `"lightpanda"` and `"chrome"` appear in
  engines used, final `result.metadata["engine"] == "chrome"`).
- **Tier**: IMPORTANT (great pattern; specific engine choice is baseline-specific).

### 7. Auth is engine-forced to Chrome, and split into two distinct flows
- **What**: (a) `--state <path>` (Playwright-style StorageState JSON: cookies + localStorage +
  sessionStorage) and `--headers <json>` (e.g. `Authorization: Bearer`) are both **incompatible
  with lightpanda** — supplying either forces `engine = "chrome"` unconditionally, overriding
  whatever engine the provider was constructed with. (b) Two separate auth-*acquisition* helper
  methods exist outside the ReAct loop: `save_state(path)` → `agent-browser state save <path>`
  (persist current session's storage state) and `cookies_set_curl(curl_file)` → `agent-browser
  cookies set --curl <curl_file>` (replay a "Copy as cURL" browser devtools dump's cookies
  without ever running an automated login — the LLM never sees a password).
- **Why**: This is the auth-contract the ultimate CLI must nail: never require the agent to
  handle credentials directly; support both "record once, replay everywhere" (StorageState) and
  "human logs in manually, exports cookies, agent imports" (curl-cookie replay) as two distinct,
  legitimate no-automated-login paths.
- **How**: `engine = "chrome" if (state is not None or headers is not None) else self.engine`
  (`agent_browser.py:391`). CLI methods: `state.save(path) → ["state","save",path]`;
  `cookies.set(curl_file) → ["cookies","set","--curl",curl_file]`.
- **Evidence**: `agent_browser.py:192-197,390-391,462-471`; tests:
  `test_state_flag_threads_to_open_and_forces_chrome`,
  `test_headers_flag_threads_through`, `test_save_state_builds_state_save_argv`,
  `test_cookies_set_curl_builds_argv` in `test_agent_browser_browse.py:118-155` and
  `test_agent_browser_cli.py`.
- **Tier**: CORE.

### 8. `eval` sends JS payload on **stdin**, never as an argv element
- **What**: `eval_js(js)` calls `self._run("eval", "--stdin", stdin=js)` — the JS source is
  passed via the runner's `stdin=` kwarg, not appended to argv.
- **Why**: Arbitrary JS can contain quotes, newlines, shell metacharacters, and can be
  arbitrarily long — passing it as an argv element risks shell-escaping bugs and OS argv length
  limits. stdin sidesteps both. It also cleanly separates "the command" from "the payload" in
  logs/telemetry (argv stays short and greppable).
- **How**: `_run()` first checks `_runner_accepts_stdin(self._runner)` via
  `inspect.signature` (falls back to calling without `stdin=` if the runner doesn't declare or
  accept `**kwargs`/`stdin`) — defensive against runners with a narrower signature.
  Argv itself is exactly `["eval", "--stdin"]`.
- **Evidence**: `agent_browser.py:64-72,116-124,154-157`; test:
  `test_eval_stdin_passes_js_on_stdin_not_argv` in `test_agent_browser_cli.py:50-58`
  (`runner.last() == [..., "eval", "--stdin"]`, `runner.stdin == js`).
- **Tier**: CORE — this is a general "large/unsafe payload → stdin, not argv" rule that should
  extend to any command taking free-form text (fill values with newlines, JSON headers, etc.
  — note `fill`/`headers` in this baseline do NOT use stdin, which is arguably a latent bug/gap,
  see Anti-patterns).

### 9. Values are separate argv elements — no shell string-building, no manual quoting
- **What**: `cli.fill("@e3", "user@example.com")` → argv
  `["agent-browser","--engine","chrome","fill","@e3","user@example.com"]` — the value is its
  own list element, never interpolated into a shell command string.
- **Why**: Eliminates an entire class of shell-injection and quoting bugs (spaces, quotes,
  `$()`, backticks in a fill value). `subprocess.run(argv, ...)` with a list never invokes a
  shell.
- **How**: Build `list[str]` argv throughout; never `shlex.join`+`shell=True`.
- **Evidence**: `agent_browser.py:52-56` (`subprocess.run(argv, capture_output=True, text=True,
  ...)` — no `shell=True`); test `test_fill_quotes_value_as_separate_argv` explicitly comments
  "value is its own argv element (no shell quoting needed — argv list, not a string)" at
  `test_agent_browser_cli.py:33-40`.
- **Tier**: CORE (baseline security hygiene, non-negotiable).

### 10. Global flags precede the subcommand, in a stable, test-asserted order
- **What**: Argv shape is always `[program, --engine <e>, (--session <s>), (--state <p>),
  (--headers <h>), <subcommand>, <args...>]`. The order `--engine, --session, --state, --headers`
  is fixed and asserted by tests.
- **Why**: A stable, predictable flag order makes the CLI's own argv parsing simpler (all global
  config front-loaded before the verb) and makes test/log diffing deterministic.
- **How**: `_prefix()` builds `[program, "--engine", engine]` then conditionally appends
  `--session`/`--state`/`--headers` in that fixed order; `_run(*args)` appends the subcommand +
  its args after the prefix.
- **Evidence**: `agent_browser.py:99-107`; test:
  `test_session_and_state_global_flags_threaded` in `test_agent_browser_cli.py:70-79`.
- **Tier**: NICE (organizational hygiene, easy to replicate, low leverage on its own).

### 11. `--json` output mode is used everywhere for machine parsing, but the *skill* (LLM-facing
    doc) hides it
- **What**: The Python provider always calls `snapshot -i --json` and `network requests --type
  xhr,fetch --json` — i.e., the deterministic caller always requests JSON. But SKILL.md (the
  doc a *host LLM* reads) never mentions `--json` at all; its examples show plain
  human-readable snapshot output (`textbox "Email" [ref=e1]`) that the LLM reads and reasons
  over directly.
- **Why**: Two different consumers, two different serializations: a deterministic orchestration
  layer wants strict JSON to parse into a `Snapshot` dataclass; an LLM reasoning turn-by-turn
  benefits from a terser, more token-efficient human-readable tree it can pattern-match visually
  (`@e1 [heading] "Log in"`). The baseline explicitly chose to drop `--json` from the LLM-facing
  doc/prompt because "Claude Code IS the agent brain" and doesn't need JSON scaffolding —
  confirmed by the module docstring's explicit design note: *"We DROP the --json-ban and
  command-allowlist (those exist because Vercel doesn't trust its LLM; Claude Code is trusted
  and --json is useful)"*.
- **How**: Maintain BOTH a `--json` machine mode (for any deterministic layer/tests) and a plain
  human-readable mode (for direct LLM consumption via the skill) from the same underlying data;
  don't force the LLM to parse JSON when a terser tree format is available and works.
  See `AGENT_LOOP_SYSTEM_PROMPT` embedding this exact policy choice at `agent_browser.py:301-315`.
- **Evidence**: SKILL.md never shows `--json`; `agent_browser.py:145` (`args.append("--json")`
  unconditionally in the Python `snapshot()` builder); docstring at `agent_browser.py:1-18,301-315`.
- **Tier**: IMPORTANT — directly informs whether the ultimate CLI should default to
  human-readable stdout for interactive/skill use and require an explicit `--json` for scripted/
  orchestration use (which the SKILL.md quick-start already implies: no `--json` in any example).

### 12. Compact accessibility-tree text format: `@refID [role attrs] "name"`
- **What**: The exact snapshot text line format shown in both SKILL.md and the canned test
  fixture: `@e5 [button type="submit"] "Continue"`, `@e3 [input type="email"] placeholder="Email"`,
  `@e1 [heading] "Log in"`, `@e2 [form]` (no attrs/name when absent), nested with 2-space indent
  under a parent, plus a `Page: <title>\nURL: <url>\n\n` header block before the tree.
- **Why**: This is a genuinely dense, LLM-token-efficient encoding: role + key attrs + accessible
  name in one line, ref prefix always `@e<n>` sortable/greppable, indentation conveys DOM nesting
  without full XML/JSON overhead.
- **How**: Regex-extractable header (`^Page:\s*(.+)$`, `^URL:\s*(\S+)$` — both `re.MULTILINE`)
  followed by a tree body; refs map built from a structured (JSON) side-channel (`data.refs`)
  rather than re-parsed out of the text — i.e., the text is for LLM eyes, the JSON `refs` dict is
  for grounding lookups. This text/json duality is itself a portable idea (#11 above extends it).
- **Evidence**: `conftest.py:70-92` (`SNAPSHOT_JSON` fixture body); `_TITLE_RE`/`_URL_RE` at
  `agent_browser.py:233-234`; SKILL.md:109 (`textbox "Email" [ref=e1]` — note the doc's own prose
  example uses a *slightly different* order/format than the fixture, a minor internal
  inconsistency worth resolving in the ultimate CLI's docs).
- **Tier**: CORE.

### 13. Snapshot flag surface: `-i` interactive-only, `-c` compact, `-d N` depth limit, `-s`
    scope, `-u` links
- **What**: SKILL.md's documented flags: `snapshot` (full tree), `-i` (interactive elements
  only, "recommended"), `-c` (compact), `-d 3` (depth limit). The Python CLI additionally builds
  `-s <scope>` (scope selector) and `-u` (include links) — flags present in the provider but NOT
  documented in SKILL.md, i.e. the skill doc under-documents the full command surface the
  provider already exercises.
- **Why**: `-i` (interactive-only filter) is the single highest-leverage flag for token economy
  — most of a full accessibility tree is decorative (static text, layout containers) and
  irrelevant to action selection; filtering to only clickable/fillable/actionable elements before
  the LLM even sees the tree is a major context-budget win at the source (cheaper than
  post-hoc truncation).
- **How**: `snapshot(interactive, compact, links, scope)` builds args conditionally:
  `-i` if interactive, `-c` if compact, `-u` if links, `["-s", scope]` if scope given, then always
  `--json` (see #11).
- **Evidence**: SKILL.md:50-56; `agent_browser.py:134-146`.
- **Tier**: CORE (`-i` filter) / NICE (`-c`, `-d`, `-s`, `-u` as supplementary levers).

### 14. Semantic (non-ref) locator fallback: `find role|text|label ... <verb> [--name]`
- **What**: SKILL.md documents an alternative interaction mode that bypasses refs entirely:
  `agent-browser find role button click --name "Submit"`, `find text "Sign In" click`, `find
  label "Email" fill "user@test.com"`.
- **Why**: Refs require a prior snapshot round-trip; semantic finders let an agent act in one
  shot when it already knows the target's accessible role/text/label from context (e.g. a
  well-known site pattern), trading a grounding guarantee for fewer round-trips. Also gives a
  fallback locator strategy when accessibility-tree refs are unstable/missing for a given
  element.
- **How**: Command shape `find <locator-type> <locator-value> <verb> [--name <accessible-name>]`
  — locator-type ∈ {role, text, label}; verb is any interaction (click, fill, ...).
- **Evidence**: SKILL.md:97-102. (Not present in the Python provider — provider only drives
  `@ref`-based steps; this is skill-doc-only surface, meaning the CLI supports it but the
  Python orchestration layer never emits it.)
- **Tier**: IMPORTANT — worth having in the ultimate CLI as an escape hatch, but the grounding
  guarantees (#2) don't apply to it, so any orchestration layer using it accepts more risk.

### 15. `wait` has four distinct modes: element, ms, `--text`, `--load <state>`
- **What**: SKILL.md: `wait @e1` (element), `wait 2000` (ms), `wait --text "Success"` (text
  appears), `wait --load networkidle` (network-idle load state). Python provider additionally
  exposes `wait --url <pattern>` (URL match) not shown in SKILL.md.
- **Why**: Different page-change signals need different wait strategies — a distinct-mode wait
  primitive (vs. one generic "wait for X ms" sleep) is what makes the mandatory-re-snapshot
  pattern (#3) reliable: `wait_load("networkidle")` is *always* called before re-snapshotting
  after a page-changing action, specifically to avoid racing a still-loading DOM.
- **How**: `WAIT_TIMEOUT_MS = 25_000` constant, chosen "below the 30s IPC read timeout" per
  the module comment — i.e. tuned against a specific host/runtime constraint the ultimate CLI
  will need its own equivalent of (whatever RPC/exec timeout wraps it).
- **Evidence**: SKILL.md:89-95; `agent_browser.py:36,176-186`; constant comment at
  `agent_browser.py:36`.
- **Tier**: CORE.

### 16. Provider-level `is_available()` / factory-return-None keyless-degradation contract
- **What**: `is_available(program)` = `shutil.which(program) is not None`. `get_browse_provider()`
  in `base.py` returns `None` (never raises, never constructs) if the CLI binary isn't on PATH.
  Keyed/removed backends (`browserbase`, `browser-use`, `agentql`, `stagehand`) always return
  `None` regardless of availability — a deliberate architectural decision to stay 100% keyless.
- **Why**: Lets a higher-level fallback ladder (`fetch_tiered` in `ladder.py`, not fully read but
  referenced) treat "tool not installed" as a normal, silent degrade-to-lower-tier condition
  rather than an exception to catch. Also makes "keyless-only" an enforceable architectural
  invariant, testable by asserting keyed names always resolve to `None`.
- **How**: `shutil.which` check; factory functions return `Optional[Provider]`; callers `is None`
  check rather than try/except around construction.
- **Evidence**: `agent_browser.py:59-61`; `base.py:67-77`; tests:
  `test_agent_browser_absent_factory_returns_none`, `test_no_keyed_backends_resolve` in
  `test_graceful_degradation.py:26-33,59-63`.
- **Tier**: CORE (for any Python/agent orchestration wrapper around the CLI).

### 17. `WebResult` return shape carries operational metadata, not just content
- **What**: Every `browse()` call returns `WebResult(url=snap.url or url, title=snap.title,
  content=snap.text, metadata={engine, provider, refs: [...], steps_executed, replay_key})`.
  On CLI-absent, returns `WebResult(url=url, title="", content="", metadata={"unavailable":
  True, "provider": name})` rather than raising or returning `None`.
- **Why**: Callers get a uniform, always-present return type whether the browse succeeded,
  partially executed (some steps skipped by grounding), or couldn't run at all — `metadata`
  carries enough forensic detail (which engine actually ran, how many of the requested steps
  executed, what refs were available) to debug/log without needing separate exception handling
  paths per failure mode.
- **How**: Always construct and return `WebResult`; encode failure/degradation *inside* metadata
  fields (`unavailable`, `engine` fallback, `steps_executed` < `len(steps)`) rather than via
  exceptions or `None`.
- **Evidence**: `agent_browser.py:386-388,413-426`; test:
  `test_cli_absent_returns_empty_webresult_no_raise` in `test_agent_browser_browse.py:99-106`.
- **Tier**: IMPORTANT (shape is Python/orchestration-specific, but the underlying idea —
  "always return a structured result with a status/metadata channel, never raise for expected
  degradation" — is directly portable to the CLI's own JSON output envelope, e.g. the
  `{"success": bool, "data": ..., "error": ...}` envelope already visible in `parse_snapshot`'s
  expectations).

### 18. `max_steps` execution cap enforced inside the loop, defaulting to 12
- **What**: `DEFAULT_MAX_STEPS = 12`. The loop increments `executed` only on steps actually
  dispatched (grounding-skipped steps don't count against the budget... actually re-check: the
  `if executed >= max_steps: break` check happens BEFORE the grounding check, so a skipped step
  still consumes loop iteration but does NOT increment `executed` — meaning skipped steps do
  not count toward the cap, but the loop still iterates through the full `steps` list one at a
  time up to `max_steps` *executed* actions.
- **Why**: Hard ceiling prevents runaway agent loops (e.g. an LLM stuck re-issuing failing
  actions) from spinning indefinitely or racking up execution cost; keeping it configurable
  per-call (not just a global) lets callers tune for task complexity.
- **How**: `for step in (steps or []): if executed >= max_steps: break; ...; executed += 1`.
- **Evidence**: `agent_browser.py:35,400-411`.
- **Tier**: NICE — sensible default cap, but the *value* 12 is baseline-arbitrary; the
  *mechanism* (hard step ceiling, configurable) is what to keep.

---

## Command Surface (verbatim, from SKILL.md)

```bash
# Navigation
agent-browser open <url>
agent-browser back
agent-browser forward
agent-browser reload
agent-browser close

# Snapshot (page analysis)
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3

# Interactions (use @refs from snapshot)
agent-browser click @e1
agent-browser dblclick @e1
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter
agent-browser press Control+a
agent-browser hover @e1
agent-browser check @e1
agent-browser uncheck @e1
agent-browser select @e1 "value"
agent-browser scroll down 500
agent-browser scrollintoview @e1

# Get information
agent-browser get text @e1
agent-browser get value @e1
agent-browser get title
agent-browser get url

# Screenshots
agent-browser screenshot
agent-browser screenshot path.png
agent-browser screenshot --full

# Wait
agent-browser wait @e1
agent-browser wait 2000
agent-browser wait --text "Success"
agent-browser wait --load networkidle

# Semantic locators (alternative to refs)
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
```

### Additional surface exercised only by the Python provider (not in SKILL.md)

```bash
agent-browser --engine <lightpanda|chrome> [--session <id>] [--state <path>] [--headers <json>] <subcommand> ...
agent-browser snapshot -i -u -s <scope> --json
agent-browser get attr <ref> <attr>
agent-browser eval --stdin              # JS payload delivered on stdin, not argv
agent-browser wait --url <pattern>
agent-browser network requests --type xhr,fetch --json
agent-browser state save <path>                  # persist StorageState JSON (cookies+localStorage+sessionStorage)
agent-browser cookies set --curl <curl_file>      # replay cookies from a Copy-as-cURL dump
```

### Global flag order (stable, test-asserted)
```
agent-browser --engine <engine> [--session <id>] [--state <path>] [--headers <json>] <cmd> [args...]
```

### Example: form submission (verbatim from SKILL.md)
```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

### Snapshot JSON envelope (from the canonical test fixture, `conftest.py:70-92`)
```json
{
  "success": true,
  "data": {
    "snapshot": "Page: Example - Log in\nURL: https://example.com/login\n\n@e1 [heading] \"Log in\"\n@e2 [form]\n  @e3 [input type=\"email\"] placeholder=\"Email\"\n  @e4 [input type=\"password\"] placeholder=\"Password\"\n  @e5 [button type=\"submit\"] \"Continue\"\n  @e6 [link] \"Forgot password?\"",
    "refs": {
      "e1": {"role": "heading", "name": "Log in"},
      "e2": {"role": "form", "name": ""},
      "e3": {"role": "textbox", "name": "Email"},
      "e4": {"role": "textbox", "name": "Password"},
      "e5": {"role": "button", "name": "Continue"},
      "e6": {"role": "link", "name": "Forgot password?"}
    }
  }
}
```
Failure/degenerate envelope: `{"success": false, "error": "..."}` → parsed to an empty
`Snapshot()`.

---

## Anti-patterns (do NOT copy as-is)

1. **Skill doc under-documents the real command surface.** SKILL.md omits `-s` (scope), `-u`
   (links), `get attr`, `eval --stdin`, `wait --url`, `network requests`, `state save`,
   `cookies set --curl`, and the `--engine`/`--session`/`--state`/`--headers` global flags
   entirely — an LLM reading only the skill doc cannot discover auth or JS-eval capabilities
   that the provider itself relies on. **Fix in the ultimate skill: the doc must be the complete,
   authoritative command surface, generated from or kept in lockstep with the actual CLI's
   `--help`, not a hand-maintained subset.**
   Evidence: compare SKILL.md:22-116 to `agent_browser.py:99-198`.

2. **Internal format inconsistency between the skill's own prose example and its own snapshot
   flag docs.** SKILL.md:109 shows `textbox "Email" [ref=e1]` (role-first, ref in brackets at
   end) while the fixture/actual format is `@e3 [input type="email"] placeholder="Email"`
   (ref-first prefix). A doc that doesn't match real CLI output will mislead the LLM's
   pattern-matching. **Fix: snapshot output examples in docs must be copy-pasted from real CLI
   runs, not hand-typed approximations.**

3. **`fill`/`type` excluded from the page-changing re-snapshot set is a silent assumption that
   may not hold.** Many modern SPAs (controlled React inputs, live-search/autocomplete,
   client-side validation) re-render meaningfully on every keystroke or on blur, which can
   invalidate refs for nearby elements without a `click`/`press`/`select` ever happening. The
   baseline's `_PAGE_CHANGING = {"click","press","select"}` will silently miss this. **Fix: make
   the page-changing detection dynamic (diff a cheap DOM/URL fingerprint before/after any action,
   not a hardcoded verb allowlist) rather than static.**
   Evidence: `agent_browser.py:330`.

4. **`fill`/`headers` values go through argv, not stdin, despite `eval` proving stdin is the
   safer channel for arbitrary payloads.** A `fill` value or a `--headers` JSON blob containing
   newlines, extremely long content, or binary-adjacent text could hit argv length limits or
   encoding edge cases that `eval --stdin` was specifically designed to avoid. **Fix: extend the
   stdin-for-payload pattern (#8) uniformly to every command whose value argument is
   user/LLM-controlled free text, not just `eval`.**
   Evidence: `agent_browser.py:163-165` (`fill`/`type_text` pass value via argv) vs.
   `agent_browser.py:154-157` (`eval_js` via stdin).

5. **`MIN_REFS_FOR_NONEMPTY = 2` and `AXTREE_MAX_CHARS = 280_000` are unexplained magic
   constants** carried over from an external "dossier" reference the ultimate CLI won't have
   access to — copying the literal numbers without re-deriving them against your own target
   sites/engines risks cargo-culting a threshold tuned for a different engine's failure modes
   (lightpanda vs. whatever engine(s) the ultimate CLI drives). **Fix: treat these as
   starting points to re-benchmark, not as ground truth.**
   Evidence: `agent_browser.py:38-39`.

6. **The AQL/Stagehand-style verbatim system prompts (`ACT_SYSTEM_PROMPT`,
   `EXTRACT_SYSTEM_PROMPT`, `OBSERVE_SYSTEM_PROMPT`) are designed for a scenario where the
   accessibility tree is fed to a SEPARATE, less-trusted paid LLM call** (Stagehand's original
   use case) that must be tightly constrained via "print_extracted_data tool" and "ONLY the
   IDs" instructions. In the ultimate CLI's actual target use case (a single trusted host agent
   reading the tree directly, as the module's own docstring notes for `AGENT_LOOP_SYSTEM_PROMPT`
   at `agent_browser.py:301-315`), these three prompts are vestigial — don't copy them wholesale
   into a skill meant for a single trusted reasoning agent; the `AGENT_LOOP_SYSTEM_PROMPT`'s
   simpler five-rule form (re-snapshot after page change, one command at a time, never invent a
   ref, etc.) is the right register.
   Evidence: `agent_browser.py:266-315` (module's own comment explicitly separates the two use
   cases).
