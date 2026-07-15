# Browser-Use — Pattern Digest for agent-browser CLI

Source: `browser-use/browser-use` (MIT, Python, ~64k LOC), mined from `/Users/seventyleven/Desktop/researchfms/teardowns/BROWSER_USE.md` (1,899-line teardown, Tier-1A source read of the actual repo).

---

## Killer Insight

**Indexed-DOM-as-action-target eliminates the dominant failure mode of LLM browser agents (selector hallucination) by making the framework, not the model, enumerate the action space.** Every interactive element gets a stable integer index (`[i]<tag attr=val/>`) assigned by a 15-step rules-based clickability detector; the LLM can only click/type into indices that exist because it picks from a finite rendered menu, not free-text CSS/XPath. This is strictly better than "give the model a ref-snapshot and hope it copies the ref string correctly" — indices are shorter, harder to typo, and the framework can validate `index in selector_map` before dispatching, turning a hallucination into a clean `ActionResult(error=...)` instead of a wrong click. Everything else in browser-use (event bus, watchdogs, memory compaction, loop detection) is in service of keeping that index→element mapping fresh and trustworthy every single step.

---

## Patterns

### 1. Indexed clickable-element serialization as the action space (CORE)
**What:** Every step, the live DOM is walked, scored for interactivity, and rendered as `[i]<tag attr=value/>` tokens with parent/child indentation. The LLM's click/input/select actions take an `index: int` (not a selector).
**Why:** Removes selector hallucination entirely — the model physically cannot reference a non-existent element; invalid indices produce a clean, recoverable error (`"Element with index {N} does not exist."`) instead of a silent no-op or wrong click.
**How:** Maintain a `selector_map: dict[int, Node]` rebuilt fresh every observation. Assign indices depth-first, starting at 1, only to nodes the interactivity detector marks true. Render as indented text tree with a stable, terse token format. Index space is *not* stable across steps — every action that could mutate the page must be followed by a fresh state fetch before the next index-based action.
**Evidence:** `dom/serializer/serializer.py:100-148` (`serialize_accessible_elements`), teardown §5.4/§Round2.B, format sample in system_prompt.md quoted at teardown line 580-596.
**Tier:** core.

### 2. 15-step ordered clickability decision tree (CORE)
**What:** A deterministic, ordered rule cascade decides whether a DOM node is "interactive" — no ML, no LLM call, pure heuristics evaluated top-to-bottom with early exit.
**Why:** Cheap (single CDP pass + cache), reproducible, and explainable when it misses something — you can debug it like code, not like a black-box classifier. Order matters: exclusions (label `for=`) must run before generic inclusions (interactive tags) or you double-count.
**How (verbatim order):** (1) non-ELEMENT_NODE → false; (2) html/body → false; (3) has JS click listener (CDP-detected, catches React onClick/Vue @click/Angular (click)) → true; (4) iframe/frame >100×100px → true; (5) `<label>` wrapping a form control within 2 levels, but reject if it has a `for=` attr (avoids double-fire with the referenced input) → true; (6) `<span>` wrapping a form control within 2 levels (catches Ant-Design-style custom checkbox/radio wrappers) → true; (7) class/id/data-* contains a search keyword from a 10-string set (`search, magnify, glass, lookup, find, query, search-icon, search-btn, search-button, searchbox`) → true; (8) AX properties: disabled/hidden → false, focusable/editable/settable/checked/expanded/pressed/selected/required/autocomplete/keyshortcuts → true; (9) tag in `{button, input, select, textarea, a, details, summary, option, optgroup}` → true; (10) interactive DOM attrs (`onclick, onmousedown, onmouseup, onkeydown, onkeyup, tabindex`) → true; (11) ARIA role in a 16-role set (`button, link, menuitem, option, radio, checkbox, tab, textbox, combobox, slider, spinbutton, search, searchbox, row, cell, gridcell`) → true; (12) AX role in same set + `listbox` → true; (13) icon-size heuristic: bbox 10-50px both dims AND has class/role/onclick/data-action/aria-label → true; (14) `cursor: pointer` computed style fallback → true; (15) else → false.
**Evidence:** `dom/serializer/clickable_elements.py:6-246`, teardown §Round2.B "clickability decision tree", constants table Round2.M.
**Tier:** core — port this verbatim, it's battle-tested against real-world SPA markup.

### 3. Bounding-box containment collapse for compound clickables (CORE)
**What:** A `PROPAGATING_ELEMENTS` list (`a`, `button`, `div[role=button]`, `div[role=combobox]`, `span[role=button]`, `span[role=combobox]`, `input[role=combobox]`) triggers bbox-propagation to children; any child whose bbox is ≥99% contained within a propagating parent's bbox is collapsed/dropped from the tree.
**Why:** Without this, `<button><span class="icon"/><span>Click me</span></button>` renders as 3 separate indexed clickable rows and the LLM might click the wrong sub-element or get confused about which index is "the button." Collapsing to one index matches what a human sees: one clickable target.
**How:** `DEFAULT_CONTAINMENT_THRESHOLD = 0.99`. After clickability detection, for nodes matching a (tag, role) pair in the propagating list, project children's bboxes onto parent; if containment ≥ threshold, drop the child node from the serialized tree (parent absorbs its text as label content).
**Evidence:** `serializer.py:45-56`, teardown §Round2.B Phase B.4.
**Tier:** core.

### 4. Paint-order (z-index) occlusion filtering via CDP, not authored CSS (IMPORTANT)
**What:** Elements visually covered by other elements (modals, sticky headers, absolute overlays) are dropped from the interactive list using Chrome's internal `LayoutTreeNode.paintOrder` field from CDP — not by parsing CSS z-index.
**Why:** Reporting a covered element as clickable wastes an LLM turn on a click that silently hits the overlay instead. Using CDP's actual paint order (not CSS z-index math) is correct even when stacking order isn't explicitly authored (e.g. DOM order determines paint order within a stacking context).
**How:** Walk the simplified tree, collect each leaf interactive node's (x,y,w,h,paint_order); for overlapping pairs, if A has lower paint_order and is >50% covered by B, drop A.
**Evidence:** `dom/serializer/paint_order.py:212 lines`, `PaintOrderRemover`, teardown §Round2.B Phase B.2.
**Tier:** important — a ref-snapshot approach could adopt this even without full indexing, since occlusion is orthogonal to selector strategy.

### 5. Tree optimization: collapse single-child wrapper divs (NICE)
**What:** After clickability + paint filtering, `_optimize_tree` removes nodes with a single non-informative child (nested wrapper divs) so `<div><div><div><button>Click</button></div></div></div>` becomes just `<button>Click</button>`.
**Why:** Keeps the LLM-facing token tree compact; every wrapper div is pure token waste with zero interactivity content.
**Evidence:** teardown §Round2.B Phase B.3.
**Tier:** nice-to-have but cheap and high-value for token budget.

### 6. `[NEW]` marker on elements absent from the previous snapshot (IMPORTANT)
**What:** Serializer accepts a `previous_cached_state` and marks any node that wasn't present last step with a `*[i]` (NEW) prefix.
**Why:** Directly cues the LLM to notice dynamically-appeared UI (dropdown menus, autocomplete lists, toasts) without re-deriving it from a diff itself. Cheap because clickability results are already cached per-node identity.
**How:** Track node identity across serialization calls (e.g. via a stable content/position hash since DOM node objects don't persist), diff against previous run's index set, prefix new ones with `*`.
**Evidence:** teardown §5.4 format example (`*[38]<button aria-label=Submit form />`), §Round2.B Phase B.5.
**Tier:** important — directly transferable to any snapshot-diffing approach, independent of indexing scheme.

### 7. Zero-LLM-cost "grep"/"find" actions over the page (CORE)
**What:** `search_page` (regex/plain text search with context window, css_scope, max_results) and `find_elements` (CSS selector query returning tag/text/attrs) run as raw JS via CDP `Runtime.evaluate` — no LLM call, no screenshot, instant.
**Why:** For verification tasks ("does this page contain 'Order confirmed'?") or targeted lookup, spending a full LLM turn + DOM-serialization pass is wasteful. These actions are the agent's local "grep"/"find", separate from the expensive `extract` action which does call an LLM over markdown.
**How:** `SearchPageAction{pattern, regex, case_sensitive, context_chars=150, css_scope, max_results=25}`; `FindElementsAction{selector, attributes, max_results=50, include_text}`. Both build a JS snippet and eval via CDP.
**Evidence:** `tools/service.py`, teardown §4.5, description text quoted verbatim: *"Search page text for a pattern (like grep). Zero LLM cost, instant."*
**Tier:** core — extremely cheap, high-value action class every browser-agent CLI should offer.

### 8. Structure-aware chunked markdown extraction with continuation (`extract`) (CORE)
**What:** The most expensive action: converts page to clean markdown (noise/ad-stripped), chunks by structure at `max_chunk_chars=100000` with `chunk.overlap_prefix` (so a table's header row carries into the next chunk), and lets the LLM continue via `start_from_char` on subsequent calls. Supports both schema-constrained (Pydantic→JSON-Schema) and free-text extraction with distinct system prompts.
**Why:** Naive "dump full page text to LLM" blows context budgets and breaks tables/lists mid-structure. Chunk boundaries that respect markdown structure (not raw character counts) keep each chunk locally coherent; overlap_prefix specifically solves the "table header lost on page 2" problem.
**How:** `MAX_CHAR_LIMIT=100000`; store extracted content <10000 chars directly in `long_term_memory`, else save to a file and reference it (`"Content in {file} and once in <read_state>."`). Auto-enables `extract_images` when the query mentions image/photo/thumbnail keywords. 120s timeout on the extraction LLM call. Dedup via `already_collected: list[str]` param passed back in on repeated calls.
**Evidence:** `tools/service.py:1034-1271`, both system prompts quoted verbatim in teardown §4.4, `dom/markdown_extractor.py`.
**Tier:** core.

### 9. Once-only `read_state` channel, separate from long-term memory (CORE)
**What:** Action outputs flagged `include_extracted_content_only_once=True` (extract results, read_file output, dropdown options) go into a `read_state` block that appears in the *next* message only, then is discarded — never re-injected into every subsequent turn.
**Why:** Prevents the classic memory-bloat failure where every large extraction result gets re-sent on every subsequent turn forever, burning tokens on stale data the agent already acted on. Distinguishes "I need this once to decide the next action" from "this is a durable fact I should keep remembering."
**How:** Separate the message-manager state into three tiers: `agent_history_items` (durable, compactable), `read_state_description`/`read_state_images` (single-use, cleared after being shown once), `compacted_memory` (summary of old history). Render `<read_state>` as its own XML block distinct from `<agent_history>`.
**Evidence:** teardown §6.4, `agent/message_manager/service.py`.
**Tier:** core — this is a genuinely underused pattern; most agent harnesses just append everything to history forever.

### 10. Message compaction with an explicit anti-hallucination instruction (CORE)
**What:** Every 25 steps (or when history exceeds 40,000 chars, ~10k tokens), older history is summarized by an LLM into ≤6000 chars, keeping the first item + last 6 items verbatim, replacing the rest with the summary.
**Why + How:** The compaction prompt (verbatim): *"Capture task requirements, key facts, decisions, partial progress, errors, and next steps... CRITICAL: Only mark a step as completed if you see explicit success confirmation in the history. If a step was started but not explicitly confirmed complete, mark it as 'IN-PROGRESS'. Never infer completion from context — only report what was confirmed."* This directly targets the failure mode where a summarizing LLM assumes a step succeeded because it "sounds like" it should have.
**Evidence:** `message_manager/service.py:213-301`, `MessageCompactionSettings` (views.py:35-56): `compact_every_n_steps=25, trigger_char_count=40000, chars_per_token=4.0, keep_last_items=6, summary_max_chars=6000`.
**Tier:** core — the anti-hallucination clause is the transferable insight, not just "summarize old history."

### 11. Single-message-per-step prompt reconstruction (not append-only) for cache-friendliness (IMPORTANT)
**What:** The per-step user message is fully rebuilt from structured state each turn (`<agent_history><agent_state><browser_state><read_state>`) rather than appending a growing transcript. Only the system prompt is marked `cache=True` for provider-level prompt caching.
**Why:** Rebuilding from state (vs. literal message-append) lets the framework prune/compact/reformat freely without corrupting a linear conversation log, and keeps the system prompt (the cache-eligible, static part) separate from the highly dynamic DOM state.
**Evidence:** `agent/message_manager/service.py`, `agent/prompts.py:AgentMessagePrompt`, full structure quoted teardown §6.2.
**Tier:** important.

### 12. Provider-aware, auto-tuned per-call timeouts (IMPORTANT)
**What:** `llm_timeout` is auto-detected from the model name string, not a single global constant: gemini→75s, gemini-3-pro→90s, groq→30s, o3/claude/sonnet/deepseek→90s, default 75s. `step_timeout=180s` global ceiling. `extract` action's page_extraction_llm call gets its own 120s timeout separate from the main loop.
**Why:** A single global LLM timeout either kills fast providers unnecessarily short or leaves slow providers to hang past a reasonable step budget — this is hard-won operational tuning worth copying verbatim rather than re-deriving.
**Evidence:** `service.py:266-282`, constants table §9.
**Tier:** important — copy the specific per-provider numbers as a starting point.

### 13. Failure budget separate from — and orthogonal to — loop detection (CORE)
**What:** Two independent circuit breakers: (a) `max_failures=5` hard-abort counter incremented per single-action step error, reset on success, with one bonus "final recovery" attempt (`final_response_after_failure=True`); (b) `ActionLoopDetector`, a soft advisory system that never aborts, just injects escalating nudge text at repetition thresholds 5/8/12 and page-stagnation threshold 5.
**Why:** Conflating "the agent keeps erroring" with "the agent keeps repeating a non-erroring but unproductive action" leads to either false aborts (agent legitimately scrolling 6 times) or missed stalls (agent successfully clicking the same non-functional button forever). Separating them means the hard-abort only fires on genuine tool/API failure, while the soft nudge handles behavioral loops without ever taking control away from the model.
**How — action hash:** `sha256(f"{action_name}::{json.dumps(params, sort_keys=True)}")[:16]` in a rolling window of 20; **page fingerprint:** `(url, element_count, sha256(dom_text)[:16])` tracked over a window of 5, stagnation = identical fingerprint N times in a row.
**Evidence:** `agent/views.py:157-249` (`ActionLoopDetector`), `views.py:66` (`max_failures`), teardown §Round2.J — note the teardown's own Round-1→Round-2 correction: Round 1 mistakenly said loop detection hard-aborts after 3 repeats; Round 2 confirmed it is purely advisory and never aborts.
**Tier:** core.

### 14. Sensitive-data redaction at the log/history layer, not the CDP layer (CORE)
**What:** `sensitive_data={"username": "alice", "password": "secret"}` (flat or domain-scoped: `{"example.com": {...}}`). When the LLM's `input` action text matches a known sensitive value, the *logged/history* text becomes `<sensitive_key_name>` while the *actual* browser dispatch (via CDP `TypeTextEvent`) still receives the real value.
**Why:** The LLM never needs to see the real secret in its own context (protects against secret leakage into logs, traces, or a compromised/malicious downstream summarization step) while the browser still gets typed the correct credential.
**How:** `TypeTextEvent(node, text, clear, is_sensitive, sensitive_key_name)` — the event carries both a redaction flag and the real payload; redaction happens at the point history/log entries are constructed, not by mutating what's sent to the browser.
**Evidence:** `tools/service.py:749-833` input action, `utils.collect_sensitive_data_values`, `utils.redact_sensitive_string`, `_detect_sensitive_key_name`, teardown §6.7.
**Tier:** core — directly transferable secrets-handling pattern for any CLI agent that fills credentials.

### 15. Provider-native structured output, not a normalized format (IMPORTANT, with caveat)
**What:** Rather than forcing one JSON-parsing strategy across all 14 LLM providers, each gets its native mechanism: OpenAI strict `response_format` JSON Schema; Anthropic single-tool `tool_choice` forcing a `tool_use` block; Gemini `response_schema` constrained decoding; browser-use cloud sends `model_json_schema()` server-side. A `SchemaOptimizer` transforms the same Pydantic model into each provider's dialect (e.g. OpenAI strict mode disallows `oneOf`, requires `additionalProperties:false`, and all fields effectively required).
**Why:** Normalizing to a lowest-common-denominator format throws away each provider's actual constrained-decoding guarantees. Using each provider's native enforcement gets the strongest guarantee available per provider, at the cost of per-provider serializer code.
**How — Anthropic double-serialization workaround (concrete, copy-worthy):** Claude sometimes returns `{"actions": "[{...}]"}` (a JSON string where an array was expected). On Pydantic validation failure, browser-use retries by `json.loads`-ing any string value starting with `[` or `{`, and if that fails, escapes `\n\r\t` and retries once more before giving up. Fallback path for unlisted/custom models: parse ```json fenced blocks out of free text.
**Evidence:** `llm/anthropic/chat.py:225-251`, comparison table teardown §Round2.G, decision tree §Round2.H.
**Tier:** important — the per-provider dispatch is high-effort; the Anthropic double-serialization fix specifically is a cheap, concrete thing worth copying regardless of overall architecture.

### 16. Event-bus + watchdog decomposition, with a callback bypass for latency-sensitive coordination (IMPORTANT, heavier-weight)
**What:** No action directly calls the browser driver; every mutation dispatches a typed event (`ClickEvent`, `TypeTextEvent`, `NavigateToUrlEvent`, etc.) on an internal bus. ~15 independent "watchdogs" (avg 630 lines each, total ~9,500 lines — over 2x the core session class) each own one concern (downloads, popups/dialogs, crashes, security/domain-allowlisting, recording, captcha wait). Watchdogs never call each other directly — except one deliberate exception: `DownloadsWatchdog` exposes `register_download_callbacks(on_start, on_progress, on_complete)` that `DefaultActionWatchdog.click()` uses to synchronously await a download completing, bypassing the async event queue.
**Why:** Clean separation of concerns scales to complex browser semantics (crash recovery, CAPTCHA proxying, HAR recording) without one god-class. But pure pub/sub is too slow for "click triggered a download, and the caller needs to know synchronously" — that's the direct-callback escape hatch. Pattern to steal: "events for everyone, direct callbacks for the originator who needs synchronous confirmation."
**Evidence:** `browser/events.py` (667 lines), `browser/watchdogs/*.py` (15 files), teardown §Round2.A (full inventory + the download-callback bypass walkthrough).
**Tier:** important but heavy — only worth it once the CLI needs to support downloads, popups, crash recovery, and recording simultaneously; for a leaner CLI, a simpler direct-dispatch model is fine, but the callback-bypass idea for latency-sensitive coordination is cheap and worth keeping regardless.

### 17. Empty-DOM retry with escalating recovery before failing navigation (CORE, cheap)
**What:** After `navigate`, if the DOM appears empty (`root is None` or the LLM-facing text is blank), wait 3s and recheck; if still empty, reload the page and wait 5s; only then return a diagnostic error (*"Page loaded but returned empty content... may require JavaScript that failed to render, use anti-bot measures, or have a connection issue."*).
**Why:** SPA hydration races are the single most common false-navigation-failure cause in browser agents. A cheap two-stage retry (wait, then reload+wait) resolves the overwhelming majority without burning an LLM turn on "try navigating again."
**Evidence:** `tools/service.py:485-561`, teardown §4.1.
**Tier:** core — trivially portable, high value-per-line.

### 18. Page statistics + heuristic "still loading" flags injected into context (NICE)
**What:** Every step, a `<page_stats>` block reports link/iframe/image/interactive-element/total-element/text-char counts plus shadow-DOM and scroll-container counts, with two derived heuristic warnings: `total_elements < 10` → *"Page appears empty (SPA not loaded?)"*; `total_elements > 20 AND text_chars < 5*total_elements` → *"Page appears to show skeleton/placeholder content (still loading?)"*.
**Why:** Gives the LLM a cheap, deterministic signal to decide "should I wait/retry" vs "should I act now" without needing a screenshot comparison or a second LLM call.
**Evidence:** `agent/prompts.py:_extract_page_statistics`, teardown §5.5.
**Tier:** nice-to-have, cheap to add.

### 19. Autocomplete-field detection changes the type-action's behavior (NICE)
**What:** Before typing, `input` checks if the target has `role="combobox"` or `aria-autocomplete`; if so it injects a prompt hint (*"This is an autocomplete field. Wait for suggestions to appear, then click the correct suggestion instead of pressing Enter."*) and sleeps 0.4s to let a JS dropdown populate before returning control.
**Why:** LLMs default to "type then press Enter," which fails on autocomplete widgets that expect a suggestion click. A field-type-aware hint plus a short deterministic wait fixes a whole category of failures cheaply.
**Evidence:** `tools/service.py:749-833`, teardown §4.2.
**Tier:** nice-to-have.

### 20. Post-hoc LLM judge, never gating execution (IMPORTANT for eval/calibration, not runtime)
**What:** Optional (`use_judge=True` or `ground_truth=...`) separate LLM evaluates the full trace after the run completes — verdict, failure_reason, `impossible_task` flag, `reached_captcha` flag (or in the fuller Round-2 schema: `success, score 0-1, reasoning, failure_mode enum`). Never retries or alters agent behavior mid-run.
**Why:** A judge that gates execution becomes a bottleneck and a source of false negatives (explicit design tradeoff cited in the source). Keeping it strictly post-hoc makes it safe to run cheaply for eval pipelines / training-data curation without touching the runtime hot path.
**Evidence:** `agent/judge.py` (~250 lines), `views.py:288-303` (`JudgementResult`), teardown §2.4 and §Round2.I.
**Tier:** important for building an eval harness around the CLI; not a runtime primitive.

---

## Command Surface (verbatim / near-verbatim)

Action registry (~30 actions total, `tools/service.py`):

```
search(query, engine='duckduckgo'|'google'|'bing')
  - duckduckgo: https://duckduckgo.com/?q={q}
  - google:     https://www.google.com/search?q={q}&udm=14   # udm=14 strips AI overviews
  - bing:       https://www.bing.com/search?q={q}
navigate(url, new_tab=False)
go_back()
wait(seconds=3)                       # capped 0-30s, subtracts 1s for LLM call time already elapsed
click(index: int>=1)                  # or click(index?, coordinate_x?, coordinate_y?) on models with coord support
input(index: int>=0, text: str, clear: bool=True)
upload_file(index: int, path: str)
switch(tab_id: str[4 chars])          # last 4 chars of CDP target_id
close(tab_id: str[4 chars])
extract(query, extract_links=False, extract_images=False, start_from_char=0, output_schema=None, already_collected=[])
search_page(pattern, regex=False, case_sensitive=False, context_chars=150, css_scope=None, max_results=25)   # zero LLM cost
find_elements(selector, attributes=None, max_results=50, include_text=True)                                    # zero LLM cost
scroll(down=True, pages=1.0, index=None)     # index=0 => whole page; pages<1.0 => partial scroll
find_text(text: str)                         # scroll-to-text
send_keys(keys: str)                         # e.g. "Enter", "Escape", "PageDown", "Control+o"
screenshot(file_name=None)
save_as_pdf(file_name=None, print_background=True, landscape=False, scale=1.0, paper_format='Letter'|'Legal'|'A4'|'A3'|'Tabloid')
dropdown_options(index: int)
select_dropdown(index: int, text: str)
write_file(file_name, content, append, trailing_newline, leading_newline)   # .txt .md .json .jsonl .csv .html .xml .pdf .docx only
replace_file(file_name, old_str, new_str)     # targeted in-file replacement, no full rewrite
read_file(file_name, available_file_paths)
evaluate(code: str)                            # sandboxed JS via CDP Runtime.evaluate, IIFE + try-catch convention
done(text, success=True, files_to_display=[])  # or StructuredOutputAction[T] for schema-typed output
```

MCP server tool surface (`mcp/server.py`, 15 tools):
```
browser_navigate(url, new_tab=False)
browser_click(index? | coordinate_x+coordinate_y, new_tab=False)
browser_type(index, text)                     # empty text = clear
browser_get_state(include_screenshot=False)
browser_extract_content(query, extract_links=False)
browser_get_html(selector?)
browser_screenshot(full_page=False)
browser_scroll(direction='down'|'up')
browser_go_back()
browser_list_tabs()
browser_switch_tab(tab_id[4 chars])
browser_close_tab(tab_id[4 chars])
retry_with_browser_use_agent(task, max_steps=100, model?, allowed_domains?, use_vision=True)   # escape hatch: hands off to the full internal Agent
browser_list_sessions()
browser_close_session(session_id)
browser_close_all()
```

Serialized DOM token format:
```
[33]<div />
    User form
    [35]<input type=text placeholder=Enter name />
    *[38]<button aria-label=Submit form />
        Submit
[40]<a />
    About us
```
`[i]` = interactive index. `*[i]` = new since last step. `|SCROLL|` = scrollable container prefix. `|SHADOW(open|closed)|` = shadow DOM prefix. Tab indentation = tree structure. Unbracketed text = non-interactive content.

Plan-item output fields (part of `AgentOutput`, not a tool call): `current_plan_item: int|None`, `plan_update: list[str]|None` with marker syntax `[x]=done [>]=current [ ]=pending [-]=skipped`.

Full `AgentOutput` JSON shape (default/thinking mode):
```json
{
  "thinking": "...",
  "evaluation_previous_goal": "...",
  "memory": "...",
  "next_goal": "...",
  "current_plan_item": 0,
  "plan_update": ["item1", "item2"],
  "action": [{"navigate": {"url": "..."}}, ...]
}
```
Flash mode strips everything except `memory` and `action`.

---

## Anti-patterns (do NOT copy as-is)

1. **~70-keyword-argument monolithic constructor** (`Agent.__init__`, service.py:133-209). Configurability is good; cramming every knob into one flat constructor signature is not — makes the surface hard to document/discover and invites silent misconfiguration. A CLI should expose the same knobs as named flags/config-file sections, grouped by concern (loop, memory, tools, browser), not one giant kwargs blob.

2. **`bu-30b-a3b-preview` / cloud-model coupling as a load-bearing feature.** Several prompt variants exist *solely* to match a proprietary fine-tuned model's expected format (e.g. `system_prompt_browser_use.md` at 18 lines only works because the model was trained on that exact minimal schema). Don't build a CLI that silently degrades to worse behavior on any model except one you happen to sell — keep the default prompt/schema provider-agnostic and treat any fine-tuned-model shortcuts as strictly optional.

3. **8 separately-maintained system prompt variants selected by a branching `if` chain** (`_load_prompt_template`, teardown §7). This is real technical debt: variant drift is guaranteed over time (Round 1→Round 2 already had to correct stale claims about loop detection). Prefer one templated prompt with conditional sections/flags over N fully-forked prompt files, unless a specific model's caching/token requirements truly force a hard split (Anthropic's ≥4096-token cache-hit requirement is the one legitimate case in this codebase).

4. **Single-captcha tracking with silent premature-release bug acknowledged in the docstring** (`CaptchaWatchdog`, teardown §Round2.A.2): "If multiple captchas overlap... only the latest one is tracked and earlier in-flight waits may return prematurely." Don't ship a wait/gate primitive that can silently release the wrong waiter under concurrency — track captchas (or any async external event) by identity/target, not as one global flag.

5. **Judge and loop-detector results have zero teeth by design.** This is *usually* correct (see pattern 20/13's rationale), but note the actual risk it accepts: a genuinely stuck agent can burn its entire step budget on advisory-only nudges that a small/cheap model may simply not act on. If porting this pattern, keep the *option* to make nudges a hard interrupt (e.g., escalate to blocking replan-or-abort at threshold 3× the soft nudge) for cost-sensitive deployments, rather than assuming "advisory only" is always the right default.

6. **`retry_with_browser_use_agent` as an MCP escape hatch that spins up a second, fully autonomous agent from inside a tool call** (teardown §2.7, §Round2.C). Elegant but risky if adopted uncritically for a CLI — a tool-call that can silently launch an unbounded sub-agent (with its own `max_steps=100` budget) inside another agent's tool loop is a resource/cost-control hazard and a debugging nightmare (two nested agent loops running simultaneously). If you add an "escalate to full agent" escape hatch, make its step/cost budget and identity clearly surfaced to the calling agent, not implicit.

7. **Cloud-only CAPTCHA solving with no local fallback beyond "the LLM tries and usually fails."** Not a design flaw exactly, but a trap for anyone assuming feature parity between the open-source local mode and the cloud product — document loudly if your CLI has a similar tiered-capability split, since silent capability gaps between "local" and "cloud" modes are a common source of confused bug reports.

---

## Section anchors used (for follow-up reads)

- Action registry: `browser_use/tools/service.py`, `tools/views.py` — teardown §4
- DOM extraction + clickability: `browser_use/dom/service.py`, `dom/serializer/serializer.py`, `dom/serializer/clickable_elements.py`, `dom/serializer/paint_order.py` — teardown §5.4, §Round2.B
- Memory/compaction: `browser_use/agent/message_manager/service.py`, `agent/views.py:MessageCompactionSettings` — teardown §6
- Loop detection: `agent/views.py:157-249 ActionLoopDetector` — teardown §2.5, §Round2.J
- Sensitive data: `tools/service.py` (input action), `utils.py` — teardown §6.7
- Structured output per provider: `browser_use/llm/{openai,anthropic,google,...}/chat.py`, `llm/schema.py:SchemaOptimizer` — teardown §Round2.G/H
- Event bus + watchdogs: `browser_use/browser/events.py`, `browser/watchdogs/*.py` — teardown §5.3, §Round2.A
- MCP server: `browser_use/mcp/server.py` — teardown §2.7, §Round2.C
- Constants: teardown §9 and §Round2.M (two full tables, ~70 constants total)
