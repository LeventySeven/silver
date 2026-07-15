# R2 Source Digest: browser-use — Controller/Tools registry + Agent loop + safety

Repo root: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/browser-use`
License: MIT (Copyright (c) 2024 Gregor Zunic) — `LICENSE:1-3`. Full permissive reuse with copyright/license notice retained.

Note on naming drift: the package `browser_use/controller/` is now a 3-line
re-export shim (`browser_use/controller/__init__.py:1-3`: `from browser_use.tools.service import Controller`
— `Controller = Tools`... actually `__all__ = ['Controller']`, aliasing the real
implementation which now lives in `browser_use/tools/`). All real logic is in
`browser_use/tools/service.py` (2313 lines), `browser_use/tools/views.py`,
`browser_use/tools/registry/service.py` (612 lines), `browser_use/tools/registry/views.py`.

## Killer Insight

The action registry is a **decorator-based signature-normalizer**, not a hand-maintained
dispatch table. `Registry.action(description, param_model=None, domains=None, terminates_sequence=False)`
(`browser_use/tools/registry/service.py:291-327`) wraps any function — inferring its
Pydantic param model from type hints if none is given — into a uniform
`async def normalized_wrapper(*, params, **special_kwargs)` signature
(`_normalize_action_function_signature`, lines 75-272). This means: (1) the LLM tool
schema, (2) the runtime dispatcher, and (3) the human-readable prompt description are
ALL derived from one Python function signature + docstring-like description string — zero
duplication between "what the model sees" and "what actually runs." This is the single
most valuable pattern to fork: it is exactly the shape our agent-browser CLI needs if we
want shell subcommands to double as an LLM-callable tool schema (argparse metadata →
JSON schema → dispatch, same source of truth).

The second killer insight is the **two-layer page-change guard in `multi_act`**
(`browser_use/agent/service.py:2720-2838`): a static `terminates_sequence: bool` flag on
navigate/search/go_back/switch actions PLUS a runtime post-hoc diff of URL and focused
target id after every action — either one aborts the rest of the queued action batch.
This directly solves the "agent clicks 4 things but the 2nd click navigated to a new page,
next 2 actions hit stale DOM indices" failure class that a index-based DOM-diff automation
CLI absolutely will hit.

## Exact Command Surface / API (verbatim)

### Registry.action decorator signature
`browser_use/tools/registry/service.py:291-298`
```python
def action(
    self,
    description: str,
    param_model: type[BaseModel] | None = None,
    domains: list[str] | None = None,
    allowed_domains: list[str] | None = None,   # alias for domains, mutually exclusive
    terminates_sequence: bool = False,
):
```

### RegisteredAction model
`browser_use/tools/registry/views.py:14-29`
```python
class RegisteredAction(BaseModel):
    name: str
    description: str
    function: Callable
    param_model: type[BaseModel]
    terminates_sequence: bool = False
    domains: list[str] | None = None   # glob patterns e.g. ['*.google.com','www.bing.com']
```

### Prompt description format (verbatim, per action)
`browser_use/tools/registry/views.py:31-56`
```
{action.name}: {description}. (param1=type (desc), param2=type, ...)
```
e.g. `click: Click element by index.. (index=integer (Element index from browser_state))`

### execute_action signature (the actual dispatcher)
`browser_use/tools/registry/service.py:331-341`
```python
async def execute_action(
    self,
    action_name: str,
    params: dict,
    browser_session: BrowserSession | None = None,
    page_extraction_llm: BaseChatModel | None = None,
    file_system: FileSystem | None = None,
    sensitive_data: dict[str, str | dict[str, str]] | None = None,
    available_file_paths: list[str] | None = None,
    extraction_schema: dict | None = None,
) -> Any:
```

### SpecialActionParameters — the fixed set of "injectable" dependencies
`browser_use/tools/registry/views.py:149-179` — any action function parameter
named one of: `context`, `browser_session`, `page_url`, `cdp_client`,
`page_extraction_llm`, `file_system`, `available_file_paths`, `has_sensitive_data`,
`extraction_schema` gets auto-injected by name rather than treated as an LLM-visible
param. `get_browser_requiring_params()` returns `{'browser_session','cdp_client','page_url'}`.

### create_action_model — Union-of-single-field-models pattern for tool schemas
`browser_use/tools/registry/service.py:517-603`: for each registered action, builds
`{Name}ActionModel` = `ActionModel` subclass with exactly ONE field (`action_name`) typed
as that action's param model. Then unions all of them via `RootModel[Union[...]]` so the
LLM's structured output for "the action to take" is literally
`{"click": {"index": 5}}` rather than a flat parameter bag — this is what lets
`ActionModel.get_index()` / `.set_index()` (views.py:68-88) work generically: it introspects
`model_dump(exclude_unset=True)` for a dict value with an `'index'` key.

### Sensitive-data placeholder format
`browser_use/tools/registry/service.py:427-514`
- Tagged: `<secret>placeholder_name</secret>` embedded anywhere in a string param.
- Untagged fallback: exact string match against a placeholder key (`value in applicable_secrets`).
- 2FA convenience: any placeholder key ending in `bu_2fa_code` is treated as a TOTP secret
  seed and replaced with `pyotp.TOTP(secret, digits=6).now()` (lines 474-476, 490-492) —
  the LLM never sees the seed, only the 6-digit code, and only at the moment of use.
- Two sensitive_data dict shapes, both supported simultaneously in one dict
  (lines 452-465):
  - legacy/global: `{key: value}` — exposed to ALL domains ("only allowed for legacy reasons").
  - domain-scoped: `{domain_glob_pattern: {key: value}}` — only merged into
    `applicable_secrets` if `match_url_with_domain_pattern(current_url, domain_or_key)` is
    true for the CURRENT page URL at the moment the action executes (not at agent-start time).
- Replacement happens on the **validated params dict** (`params.model_dump()` →
  recursive walk → `type(params).model_validate(processed_params)`), i.e. secrets never
  touch the LLM-visible action JSON, only the post-validation execution payload.
- Missing placeholders are logged as a warning, not a hard failure
  (`logger.warning(f'Missing or empty keys in sensitive_data dictionary: ...')`, line 512).

### Domain allowlist safety check at Agent construction time
`browser_use/agent/service.py:530-577` — if `sensitive_data` is set but
`Browser(allowed_domains=[...])` is NOT configured, logs a loud warning:
```
⚠️ Agent(sensitive_data=••••••••) was provided but Browser(allowed_domains=[...]) is not locked down! ⚠️
   ☠️ If the agent visits a malicious website and encounters a prompt-injection attack, your sensitive_data may be exposed!
```
If domain-scoped secrets ARE used, each domain pattern key is checked for coverage by
`allowed_domains` (supports `*` wildcard-all and `*.example.com` subdomain patterns) and
warns (not blocks) per-uncovered-pattern (lines 573-577).

### done action — two variants, mutually exclusive, chosen by whether a structured
output schema was configured
`browser_use/tools/service.py:1994-2076` (`_register_done_action`)
- Free-text: `param_model=DoneAction` (`browser_use/tools/views.py:89-101`):
  `text: str`, `success: bool = True`, `files_to_display: list[str] | None = []`.
- Structured: `param_model=StructuredOutputAction[output_model]`
  (`browser_use/tools/views.py:114-119`): `success: bool`, `data: T`, `files_to_display`.
  Triggered via `Tools.use_structured_output_action(output_model)`
  (`browser_use/tools/service.py:2078-2080`).
- `ActionResult.success=True` can ONLY be set when `is_done=True` — enforced by a Pydantic
  `model_validator(mode='after')` (`browser_use/agent/views.py:340-349`), preventing the
  common bug of a regular action silently declaring itself "successful" in a way that gets
  confused with task completion.
- `done` is special-cased in `multi_act`: `browser_use/agent/service.py:2750-2755` — if
  `done` appears anywhere except as the FIRST action in a batch, execution stops before
  running it (`"Done action is allowed only as a single action"`).

### Agent max-steps / max-failures / retry knobs (verbatim defaults)
`browser_use/agent/views.py:59-92` (`AgentSettings`)
```python
max_failures: int = 5
max_actions_per_step: int = 5
use_thinking: bool = True
flash_mode: bool = False
max_history_items: int | None = None
enable_planning: bool = True
planning_replan_on_stall: int = 3     # consecutive failures before replan nudge; 0=disabled
planning_exploration_limit: int = 5   # steps w/o a plan before nudge; 0=disabled
llm_timeout: int = 60
step_timeout: int = 180
final_response_after_failure: bool = True  # attempt one final recovery call after max_failures
loop_detection_window: int = 20
loop_detection_enabled: bool = True
max_clickable_elements_length: int = 40000
```
Failure-forced-termination: `browser_use/agent/service.py:1574-1580` — once
`consecutive_failures >= max_failures` AND `final_response_after_failure`, the agent
force-injects a "you failed N times, therefore we terminate" message and forces a `done`
call rather than looping forever.
`max_total_failures = max_failures + int(final_response_after_failure)` (line 1289) — the
"+1" gives one extra grace attempt for the agent to self-report before hard stop.

### AgentStepInfo.is_last_step
`browser_use/agent/views.py:278-285`
```python
@dataclass
class AgentStepInfo:
    step_number: int
    max_steps: int
    def is_last_step(self) -> bool:
        return self.step_number >= self.max_steps - 1
```

### AgentOutput — the structured LLM response shape (verbatim fields)
`browser_use/agent/views.py:388-401`
```python
class AgentOutput(BaseModel):
    thinking: str | None = None
    evaluation_previous_goal: str | None = None
    memory: str | None = None
    next_goal: str | None = None
    current_plan_item: int | None = None
    plan_update: list[str] | None = None
    action: list[ActionModel] = Field(..., json_schema_extra={'min_items': 1})
```
`model_json_schema()` override forces `required = ['evaluation_previous_goal','memory','next_goal','action']`
(lines 402-406). Three schema-trimmed variants exist for different modes:
`type_with_custom_actions_no_thinking` (drops `thinking`) and
`type_with_custom_actions_flash_mode` (drops `thinking`, `evaluation_previous_goal`,
`next_goal`, plan fields — only `memory`+`action` required) — a direct "reasoning budget"
dial (`browser_use/agent/views.py:433-486`).

### act() — single-action executor with per-action wall-clock timeout
`browser_use/tools/service.py:2164-2252` — wraps `registry.execute_action` in
`asyncio.wait_for(..., timeout=timeout_s)`. Default timeout resolves via
`BROWSER_USE_ACTION_TIMEOUT_S` env var or 180s (comment notes this is intentionally above
the 120s page_extraction_llm cap used by `extract`). On timeout returns an `ActionResult`
with a clear recovery-oriented error string rather than raising, so the agent loop can
react instead of crashing.

### multi_act() — batched action executor with page-change guards
`browser_use/agent/service.py:2720-2838` (full logic; see Killer Insight above). Key
control flow, verbatim order of checks per action `i`:
1. if `i>0` and this action is `done` → break (done must be first/only).
2. `await asyncio.sleep(browser_profile.wait_between_actions)` between actions (i>0).
3. `_check_stop_or_pause()` (Ctrl+C / pause support).
4. capture `pre_action_url`, `pre_action_focus = browser_session.agent_focus_target_id`.
5. `tools.act(...)`.
6. if `result.error` or `result.is_done` or last action → break.
7. Layer 1 guard: `registered_action.terminates_sequence` → break.
8. Layer 2 guard: URL or focus target id changed post-action → break.
9. any other exception (not `InterruptedError`, not "connection-like") → append an
   `ActionResult(error=...)` and **return early** (rest of batch abandoned).

### Loop detection (soft nudges, never blocks)
`browser_use/agent/views.py:157-` `ActionLoopDetector`: rolling window of
`compute_action_hash(action_name, params)` over `window_size=20` actions; escalating nudge
thresholds at repetition counts 5, 8, 12 (`get_nudge_message`, lines 211+); separate page
"stagnation" tracking via `PageFingerprint` = `sha256(dom_text)[:16]` + url + element_count
(`browser_use/agent/views.py:95-107`), counting `consecutive_stagnant_pages`.
Action-hash normalization is action-type-aware (`_normalize_action_for_hash`,
lines 110+): search actions hash sorted/lowercased query tokens (ignoring keyword-order
noise), click actions hash by element type + rough text (ignoring the literal index which
changes every DOM diff), navigate hashes by domain only.

## Patterns

1. **name**: Signature-driven action registration (decorator infers Pydantic model from function signature)
   **what**: One `@registry.action(description, ...)` decorator turns any async function into an LLM tool + validated dispatcher + prompt doc entry.
   **how**: `_normalize_action_function_signature` (registry/service.py:75-272) inspects `inspect.signature(func)`, splits params into "special" (injected deps, matched by exact param NAME against a fixed dict in `_get_special_param_types`, lines 57-73) vs "action" params, builds a `pydantic.create_model(f'{func.__name__}_Params', __base__=ActionModel, **params_dict)` if no explicit `param_model` given, and rewraps the function into `async def normalized_wrapper(*, params=None, **special_kwargs)`. Two calling conventions supported ("Type 1": func's first arg IS already a BaseModel param object; "Type 2": func takes plain keyword args and registry synthesizes the model).
   **evidence**: browser_use/tools/registry/service.py:75-272, 291-327
   **tier**: core

2. **name**: Union-of-singleton-models action schema for LLM tool calling
   **what**: Instead of one big action struct with all-but-one field null, each registered action gets its OWN single-field model, and all of them are OR'd via `RootModel[Union[...]]`.
   **how**: `create_action_model()` (registry/service.py:517-603) builds `{Name}ActionModel` per action then a `class ActionModelUnion(RootModel[Union[tuple(models)]])` with delegate methods `get_index`/`set_index`/`model_dump` proxying to `self.root`. Reduces prompt/schema noise and avoids the classic "23 nullable fields" bloat in function-calling schemas.
   **evidence**: browser_use/tools/registry/service.py:517-603; browser_use/tools/registry/views.py:59-88
   **tier**: core

3. **name**: sensitive_data placeholder substitution happens post-validation, pre-execution, domain-scoped
   **what**: LLM emits `<secret>name</secret>` tokens; real secret values are substituted only into the validated param object right before the action executes, filtered by current page URL domain match.
   **how**: `Registry._replace_sensitive_data` (registry/service.py:427-514) — `secret_pattern = re.compile(r'<secret>(.*?)</secret>')`; recursive walk over `params.model_dump()`; domain filtering via `match_url_with_domain_pattern(current_url, domain_or_key)` only for dict-shaped (`{domain: {key:val}}`) entries; TOTP auto-generation for keys ending `bu_2fa_code` via `pyotp.TOTP(secret, digits=6).now()`.
   **evidence**: browser_use/tools/registry/service.py:427-514, 354-365
   **tier**: core

4. **name**: allowed_domains cross-check warning at Agent construction (not enforcement, just loud warning)
   **what**: If `sensitive_data` is configured without a locked-down `allowed_domains`, or with domain patterns not covered by `allowed_domains`, log an explicit security warning with skull emoji naming the exact prompt-injection risk.
   **how**: browser_use/agent/service.py:530-577, wildcard/subdomain coverage check via string prefix logic (`allowed_domain_part.startswith('*.')`).
   **evidence**: browser_use/agent/service.py:530-577
   **tier**: important — good UX pattern for a CLI: warn loudly, don't silently fail closed or silently proceed.

5. **name**: Two-tier page-change guard aborts stale multi-action batches
   **what**: static per-action `terminates_sequence` flag + runtime URL/focus diff both independently abort a queued action batch to avoid acting on stale DOM state.
   **how**: see Exact Command Surface above; browser_use/agent/service.py:2720-2838.
   **tier**: core — directly solves the "index drift after navigation mid-batch" bug class.

6. **name**: done-as-terminal-action, single-action-only enforcement
   **what**: `done` can only be the sole action in a step; if queued after other actions in the same LLM turn, remaining actions including `done` are simply skipped/broken out of.
   **how**: browser_use/agent/service.py:2750-2755; browser_use/tools/service.py:1994-2076 registers two mutually-exclusive `done` variants (free text vs Pydantic-typed structured output) depending on whether `use_structured_output_action()` was called.
   **evidence**: as above
   **tier**: core

7. **name**: `success=True` is structurally coupled to `is_done=True` via Pydantic validator
   **what**: prevents "successful sub-action" from being confused with "task complete" in agent history / judge logic.
   **how**: `ActionResult.validate_success_requires_done` — `model_validator(mode='after')`, raises `ValueError` if `success is True` and `is_done is not True`.
   **evidence**: browser_use/agent/views.py:340-349
   **tier**: important

8. **name**: max_failures grace period ("+1 final recovery attempt")
   **what**: agent doesn't hard-stop the instant `consecutive_failures == max_failures`; if `final_response_after_failure=True` it gets one more forced attempt to self-report via `done` before termination.
   **how**: `max_total_failures = max_failures + int(final_response_after_failure)` (agent/service.py:1289); forced-done injection at agent/service.py:1574-1580.
   **evidence**: browser_use/agent/service.py:1250-1300, 1574-1580, 2600-2604
   **tier**: important

9. **name**: soft loop-detection nudges instead of hard loop-breaking
   **what**: never blocks a repeated action; instead injects escalating textual nudges into the next prompt at repetition thresholds 5/8/12, plus separate page-stagnation tracking via DOM-text hashing.
   **how**: `ActionLoopDetector` in browser_use/agent/views.py:157+, action-type-aware normalization in `_normalize_action_for_hash` (lines 110+).
   **evidence**: browser_use/agent/views.py:110-230 (approx)
   **tier**: nice — good inspiration for a CLI-side "you've run the same command 5 times" hint, but pure-LLM-nudge approach is heavier than a CLI needs; a CLI can just hard-fail after N identical retries.

10. **name**: per-action wall-clock timeout distinct from per-LLM-call timeout and per-step timeout
    **what**: three independent timeout layers — `action_timeout` (default 180s, env `BROWSER_USE_ACTION_TIMEOUT_S`), `llm_timeout` (default 60s), `step_timeout` (default 180s) — each returns a structured, recoverable error rather than crashing the loop.
    **how**: `Tools.act` wraps `execute_action` in `asyncio.wait_for` (tools/service.py:2206-2235); `_get_next_action` wraps the LLM call the same way (agent/service.py:1176-1190).
    **evidence**: browser_use/tools/service.py:2164-2252; browser_use/agent/service.py:1167-1201; AgentSettings fields at agent/views.py:85-86
    **tier**: important — directly reusable for a shell CLI wrapping subprocess calls with per-command timeouts.

11. **name**: `__getattr__`-based direct action invocation (`tools.click(index=5, browser_session=...)`) that still routes through `act()`
    **what**: lets tests/callers invoke any registered action as if it were a plain method, but internally builds a one-field dynamic ActionModel and calls the real `act()` path so error handling/observability stays uniform — no bypass shortcut exists.
    **how**: browser_use/tools/service.py:2254-2306.
    **evidence**: as above
    **tier**: nice — convenience/ergonomics pattern for a Python SDK wrapper around a CLI, less relevant if agent-browser is pure-shell.

12. **anti-pattern**: `execute_action`'s exception handling re-stringifies almost everything into `RuntimeError(f'Error executing action {action_name}: {str(e)}')`, discarding exception type/traceback except for a few hardcoded substring checks (`registry/service.py:399-419`) — fragile string-matching (`'requires browser_session but none provided' in str(e)`) to decide control flow. Don't copy this — use typed exceptions/error codes instead of substring sniffing.
    **evidence**: browser_use/tools/registry/service.py:399-419
    **tier**: anti-pattern

## Reusable code (fork candidates)

- `browser_use/tools/registry/service.py` — `Registry` class (whole file, 612 lines):
  the decorator + signature-normalization + Union-schema-builder + sensitive-data
  substitution engine. Directly forkable as the backbone of a shell-CLI action registry if
  we build agent-browser's dispatcher in Python; otherwise port the *pattern* (one
  declaration → schema + dispatch + docs) to whatever language the CLI dispatcher uses.
- `browser_use/tools/registry/views.py` — `ActionModel`, `RegisteredAction`,
  `ActionRegistry`, `SpecialActionParameters`: minimal, well-factored Pydantic scaffolding
  worth copying near-verbatim.
- `browser_use/tools/views.py` — `DoneAction`, `StructuredOutputAction[T]`,
  `NoParamsAction` (has the Gemini-empty-object workaround comment, line 145-149) — good
  reference for done-action / structured-output param shapes.
- `browser_use/agent/service.py:2720-2838` (`multi_act`) — the page-change-guard logic,
  worth porting almost line-for-line into any CLI that executes queued actions against a
  stateful browser/DOM.
- `browser_use/agent/views.py:157-` (`ActionLoopDetector`) and `95-155`
  (`PageFingerprint`, `_normalize_action_for_hash`) — soft loop/stagnation detection, fork
  if agent-browser wants LLM-facing nudges rather than hard limits.
- `browser_use/agent/service.py:530-577` — the sensitive_data/allowed_domains
  cross-validation warning block; copy the wording and the wildcard-domain coverage check
  logic directly into any CLI that accepts secrets + a domain allowlist.

## Anti-patterns

- Exception handling in `Registry.execute_action` collapses all errors to
  `RuntimeError(str(e))` with substring-based control flow for a few special cases
  (registry/service.py:399-419) — brittle, avoid.
- `browser_use/controller/__init__.py` is a bare re-export shim kept only for backward
  compatibility (`Controller = Tools`); don't name things "Controller" then rename the real
  implementation to "Tools" without updating the compat shim's naming — mildly confusing
  when reading the codebase fresh (we had to grep past the empty `controller/` package to
  find the real 2313-line `tools/service.py`).
- Old-format sensitive_data (`{key: value}`, no domain scoping) is "only allowed for legacy
  reasons" per the comment (registry/service.py:461) — i.e. even upstream considers it a
  wart to be phased out; don't default agent-browser's design to the unscoped form.

## License

MIT License, Copyright (c) 2024 Gregor Zunic (`LICENSE:1-3` of the repo). Permits
copy/modify/merge/publish/distribute/sublicense/sell with only the requirement to retain
the copyright notice and license text in copies/substantial portions of the software. Safe
to fork/adapt code directly with attribution.
