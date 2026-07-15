# browser-use controller/registry + multi_act guard vs moxxie actions.ts/pagechange.ts/registry.ts

Lens: Action/controller registry (decorator -> schema+dispatch+doc) + multi_act page-change guard.

Source read: `browser_use/tools/registry/service.py` (Registry.action decorator,
`_normalize_action_function_signature`, `execute_action`, `_replace_sensitive_data`),
`browser_use/tools/registry/views.py` (RegisteredAction, ActionRegistry, domain matching),
`browser_use/tools/service.py` (click/input/upload/select action bodies, `terminates_sequence`
tags on search/navigate/go_back/switch/evaluate), `browser_use/agent/service.py:2720-2838`
(`multi_act` two-layer page-change guard).

Moxxie read: `src/actuation/actions.ts` (act/find/dispatch/applyVerb/fillVerb),
`src/actuation/pagechange.ts` (settleAndFingerprint/compareFingerprint), `src/security/registry.ts`
(buildRegistry/isDispatchable phase quarantine).

Framing note: moxxie has no `multi_act` — the CLI dispatches exactly one verb per invocation and
the host LLM decides the next call after reading the envelope. So browser-use's *runtime* guard
(layer 2: diff URL/focus after each queued action) is largely subsumed by moxxie's existing
per-call `pagechange.ts` fingerprint. The useful transferable piece is the *static* layer
(`terminates_sequence`) and a couple of DOM-state heuristics baked into individual action bodies
that moxxie's `applyVerb` doesn't have yet.

## Findings

1. **New-tab-after-click is invisible to moxxie's page-change fingerprint**
   - source_does: `multi_act`'s click handler (`tools/service.py` `_click_by_index`,
     `browser_use/tools/service.py:718` `tabs_before = {t.target_id for t in await browser_session.get_tabs()}`
     ... `memory += await _detect_new_tab_opened(browser_session, tabs_before)`) snapshots the open
     tab-ID set before a click and diffs it after, explicitly because a click can open a new tab
     without changing the *current* page's URL or focused element at all.
   - moxxie_current: `settleAndFingerprint` (`src/actuation/pagechange.ts:69-83`) fingerprints only
     `url + focusedBackendNodeId + domNodeCount` of the *current* page. A `target=_blank` link click
     that opens a new tab but leaves the current tab's DOM/URL/focus untouched produces an unchanged
     fingerprint — `page_changed: false` — even though the session now has a new tab the host doesn't
     know about.
   - recommendation: adopt
   - change: in `act()` (`src/actuation/actions.ts:124-155`), capture `page.context().pages().length`
     before dispatch and compare after `dispatch()` returns (before `cleanupStamp`); if it grew, set
     an explicit `newTabOpened: true` on `ActResult`, and have the pagechange caller (wherever
     `settleAndFingerprint` is invoked in the CLI layer) OR the fingerprint itself fold in
     `context().pages().length` as a fourth fingerprint component so `page_changed`/`stale_refs` also
     trip on tab-count change even without a URL/focus delta.
   - keyless_ok: true
   - priority: P0
   - evidence: browser_use/tools/service.py:718-745 (click_by_index new-tab detection); moxxie
     src/actuation/pagechange.ts:69-83 (fingerprint composition), src/actuation/actions.ts:146-154 (act dispatch).

2. **`select` failure gives no recovery hint; browser-use auto-shortcuts to listing options**
   - source_does: `browser_use/tools/service.py:735-745` — if a click lands on a `<select>`, the
     click handler catches the validation error and calls `dropdown_options(...)` as a "helpful
     shortcut", returning the actual option list in the result instead of a bare failure.
   - moxxie_current: `applyVerb`'s `select` case (`src/actuation/actions.ts:282-286`) calls
     `locator.selectOption(values, ...)` and on mismatch/failure just falls through to
     `mapActionError()` (`src/actuation/actions.ts:336-344`), which returns a generic
     `element_not_found`/`timeout` — no indication of what the valid option values/labels actually
     were.
   - recommendation: adopt
   - change: in `applyVerb`'s `select` branch, wrap `selectOption` in a try/catch; on failure, query
     `locator.locator('option').allTextContents()` (bounded, e.g. first 50) and surface it. This needs
     a place to carry the hint without violating the no-leak/fixed-message invariant in
     `errors.ts` — add an optional `hint` array field to the failure envelope (kept separate from the
     sanitized fixed `message`) so the host gets `available_options: [...]` without moxxie
     inventing free-text error strings. Cite `src/core/errors.ts:1-16` for the invariant this must respect.
   - keyless_ok: true
   - priority: P1
   - evidence: browser_use/tools/service.py:735-745; moxxie src/actuation/actions.ts:282-297,336-344.

3. **Static "always page-changing" verb classification (`terminates_sequence`) has no moxxie analog**
   - source_does: `search`, `navigate`, `go_back`, `switch` (tab), and `evaluate` are tagged
     `terminates_sequence=True` in their `@registry.action(...)` decorators (`tools/service.py:458-461,
     503-505, 583, 1003, 1821`). `multi_act` (`agent/service.py:2804-2810`) checks this flag FIRST,
     before the runtime URL/focus diff, and skips the (comparatively expensive) runtime check
     entirely for these verbs.
   - moxxie_current: `pagechange.ts` always pays the full settle cost — `waitForLoadState('domcontentloaded')`
     then up to `NETWORK_IDLE_BUDGET_MS` (1.2s) race — for every action including ones that are
     unconditionally page-changing (`goto`/`navigate`/`back`/`forward`/`reload`, all of which are
     listed as READ_ONLY_VERBS in `src/security/registry.ts:33-38`, and `close`/`tab`).
   - moxxie_current is the same settle path for all verbs (`fingerprintAfterSettle`,
     `src/actuation/pagechange.ts:69-83`); there's no verb-aware fast path.
   - recommendation: align
   - change: give `settleAndFingerprint`/the CLI dispatcher a small static set of "always-changing"
     verbs (goto/navigate/back/forward/reload/close/tab-switch) mirroring browser-use's
     `terminates_sequence` list; for those, still compute the fingerprint (moxxie needs the new value
     stored as `prev` for next time) but skip re-deriving `page_changed` via comparison — force
     `page_changed:true`/`stale_refs:true` unconditionally, saving one wasted comparison branch and
     documenting intent. Low-value on its own but free and matches upstream's reasoning; don't spend
     more than a few lines on it.
   - keyless_ok: true
   - priority: P2
   - evidence: browser_use/agent/service.py:2802-2818; browser_use/tools/service.py:458-461 etc; moxxie src/actuation/pagechange.ts:57-83.

4. **Sensitive-data placeholder templating (`<secret>name</secret>` + TOTP) is a genuine keyless capability moxxie lacks**
   - source_does: `Registry._replace_sensitive_data` (`tools/registry/service.py:427-514`) resolves
     `<secret>label</secret>` tags (and bare literal matches) in action params against a
     domain-scoped `sensitive_data` dict just before dispatch, including `pyotp.TOTP(...).now()`
     generation for keys suffixed `bu_2fa_code`. This is pure string substitution + a TOTP library —
     zero model calls.
   - moxxie_current: `fill`/`type` in `applyVerb` (`src/actuation/actions.ts:279-296`) take the raw
     `value` string as-is; there is no secrets layer anywhere in `actuation/`. The host LLM must pass
     literal credential text into the `act()` call, meaning it flows through the host's own context/
     transcript in full plaintext.
   - recommendation: adopt
   - change: add a small `src/actuation/secrets.ts` (or extend `actions.ts`) that, given an optional
     `--secrets <file>` (JSON: `{domain_pattern: {name: value}}` or flat `{name: value}`) loaded once
     at CLI startup, resolves `<secret>name</secret>` inside `value`/`selectValues`/`files` right
     before `applyVerb` dispatch, matching the current page's URL against `domain_pattern` (glob) the
     way `ActionRegistry._match_domains` does (`tools/registry/views.py:96-118`). Add TOTP support
     for `name` suffixed `_2fa_code` using a small keyless TOTP implementation (RFC 6238, no network,
     no model). This is the single highest-value adoption from this source — it removes plaintext
     credentials from the host-agent's own reasoning trace, which no other moxxie module currently
     addresses.
   - keyless_ok: true
   - priority: P0
   - evidence: browser_use/tools/registry/service.py:427-514, tools/registry/views.py:96-118; moxxie src/actuation/actions.ts:279-297 (no secrets layer present).

5. **File-upload proximity fallback (find hidden file input near the visible control) is missing**
   - source_does: the `upload_file` action (`tools/service.py` ~905-960) doesn't require the ref/index
     to *be* the file input; it looks up `find_file_input_near_element(node)` first, falling back to
     "closest file input to current scroll position" across the whole selector map if nothing is
     found nearby — because most real upload UIs are a styled button that triggers a hidden
     `<input type=file>` elsewhere in the DOM.
   - moxxie_current: `upload` in `applyVerb` (`src/actuation/actions.ts:287-291`) calls
     `locator.setInputFiles(files, ...)` directly on whatever the ref resolved to. If the ref is the
     visible upload button (not literally the `<input type=file>`), Playwright's `setInputFiles`
     throws and moxxie reports `element_not_found`/generic failure with no fallback.
   - recommendation: adopt
   - change: in the `upload` branch of `applyVerb`, on a caught error from `setInputFiles`, retry
     against `locator.locator('input[type=file]').first()` (descendant search) and, if that also
     fails, `page.locator('input[type=file]')` filtered to the nearest one by DOM/viewport proximity
     to the original ref's bounding box, before giving up. Bounded, cheap, no model call.
   - keyless_ok: true
   - priority: P1
   - evidence: browser_use/tools/service.py:905-960 (proximity search over selector_map); moxxie src/actuation/actions.ts:287-291.

6. **Domain-scoped action allowlisting (`RegisteredAction.domains` / `_match_domains`) has no moxxie equivalent beyond the phase flag**
   - source_does: individual actions can be registered with `domains=['*.example.com', ...]`
     (`tools/registry/views.py:26-27,96-118`); `create_action_model`/`get_prompt_description` filter
     the *available* action set by matching the current page URL against those glob patterns, so an
     action can be scoped to specific sites even when the agent is otherwise fully enabled.
   - moxxie_current: `buildRegistry`/`isDispatchable` (`src/security/registry.ts:83-95`) gate purely
     on a boolean phase flag (`enableActions`/`readOnly`) — a verb is either globally on or globally
     off for the whole session; there is no per-URL restriction (e.g. "allow `fill`/`click` on
     `*.mycompany-internal.com` but not on arbitrary third-party domains reached via navigation").
   - recommendation: adopt
   - change: extend `RegistryFlags` with an optional `allowedDomains?: string[]` and thread the
     current `page.url()` into `isDispatchable(verb, flags, url)`; when `allowedDomains` is set,
     ACTOR_VERBS additionally require the current page URL to glob-match one of the patterns (reuse
     the same glob-match approach as `match_url_with_domain_pattern`). This is real defense-in-depth
     for the "host got injected into visiting an attacker page" scenario the read-only default
     already partially defends — pure config + a URL match, no model.
   - keyless_ok: true
   - priority: P2
   - evidence: browser_use/tools/registry/views.py:26-27,96-118; moxxie src/security/registry.ts:15-95.

7. **skip-cargo-cult: dynamic decorator → Pydantic param-model synthesis (`_normalize_action_function_signature`, `create_action_model`, `ActionModelUnion`)**
   - source_does: ~250 lines (`tools/registry/service.py:75-272,516-603`) of runtime introspection
     that turns arbitrary Python function signatures into Pydantic models, unions them into one
     tool-calling schema, and reflows special-parameter injection (`browser_session`, `cdp_client`,
     `file_system`, etc.) — because browser-use exposes a *pluggable*, user-extensible action set to
     an LLM tool-calling API and needs to generate that schema at runtime from whatever functions
     third-party code registers.
   - moxxie_current: `ActVerb`/`FindKind` are closed TS union types (`src/actuation/actions.ts:30-44,
     66-74`) and `buildRegistry` is a pure `Set<string>` builder (`src/security/registry.ts:83-90`).
     moxxie's verb set is fixed at build time and typechecked; there is no third-party action
     plugin surface and no LLM tool-schema to synthesize (moxxie never calls a model).
   - recommendation: skip-cargo-cult
   - change: none. A dynamic decorator/schema-synthesis registry would add real complexity
     (reflection, special-param injection, union-type schema generation) to solve a problem moxxie
     structurally doesn't have. The current static-union + pure-Set design is simpler and equally
     correct for a closed, host-driven action surface.
   - keyless_ok: true
   - priority: P2
   - evidence: browser_use/tools/registry/service.py:75-272; moxxie src/actuation/actions.ts:30-44, src/security/registry.ts:83-90.

8. **skip-cargo-cult: `get_prompt_description()`/`prompt_description()` dynamic LLM-tool-doc generation**
   - source_does: `ActionRegistry.get_prompt_description`/`RegisteredAction.prompt_description`
     (`tools/registry/views.py:31-56,120-146`) render each action's Pydantic schema into a
     natural-language blurb injected into the *model's* system prompt, because browser-use's own
     agent loop calls an LLM that needs a text description of available tools.
   - moxxie_current: has no equivalent, correctly — moxxie is a CLI the *host* LLM invokes directly
     (with `--help`/its own tool-definition JSON owned by the host harness, not moxxie). There is no
     internal model call moxxie needs to prompt.
   - recommendation: skip-cargo-cult
   - change: none — building a prompt-description generator inside moxxie would exist for a caller
     (an internal LLM) that never exists in a 100%-keyless CLI.
   - keyless_ok: true
   - priority: P2
   - evidence: browser_use/tools/registry/views.py:31-56,120-146; moxxie has no `getPromptDescription`-equivalent, confirmed absent in src/actuation and src/security.

9. **moxxie's `fill` verify+fallback is already stronger than browser-use's `input` mismatch handling — no change needed**
   - source_does: `input` (`tools/service.py:840-855`ish) detects a post-type value mismatch and
     appends a warning string to the memory text (`"⚠️ Note: the field's actual value ... differs"`)
     but does not retry — it just tells the LLM the field may have reformatted, and leaves recovery
     to another LLM turn.
   - moxxie_current: `fillVerb` (`src/actuation/actions.ts:305-315`) actively retries on mismatch —
     re-reads via `inputValue()`, and if it doesn't match, clears + `pressSequentially` character by
     character (the stubborn-controlled-React-input fallback) — resolving the problem within the
     single action instead of pushing a retry decision back to the caller.
   - recommendation: skip-cargo-cult
   - change: none. This is a place moxxie is already ahead; flagging so a future pass doesn't
     "align" moxxie backward toward browser-use's weaker warn-only behavior.
   - keyless_ok: true
   - priority: P2
   - evidence: browser_use/tools/service.py (input action, actual_value mismatch warning path); moxxie src/actuation/actions.ts:305-325.

## Top recommendation

Adopt finding 4 (sensitive-data `<secret>name</secret>` + TOTP templating) as the single highest-value
keyless change: it's a pure string-substitution + RFC-6238 TOTP feature (zero model calls, zero new
dependencies beyond a small totp helper) that closes a real security gap — today moxxie's `fill`/`type`
force the host LLM to carry raw credentials in its own plaintext reasoning/transcript, and nothing in
`actuation/` or `security/` intercepts that. It directly extends the same "host never sees the secret"
posture that `security/registry.ts`'s phase-quarantine already establishes for actions.
