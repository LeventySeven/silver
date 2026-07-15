# Stagehand: act / extract / observe — Pattern Digest

**Source repo:** `browserbase/stagehand` (v3.2.1), analyzed via full source read.
**Primary evidence files (read in full for this digest):**
- `/Users/seventyleven/Desktop/researchfms/browserbase/STAGEHAND_DEEP.md` (1249 lines)
- `/Users/seventyleven/Desktop/researchfms/browserbase/STAGEHAND_321_FULL_EXTRACTION.md` (1897 lines)

All anchors below cite section headers / line ranges in those two files, which themselves cite the original `packages/core/lib/v3/...` source paths.

---

## Killer Insight

Stagehand's three primitives are not three independent APIs — they are three **views onto one grounding substrate**: a hybrid ARIA+DOM accessibility snapshot in which every interactive node carries a stable `elementId` of the form `"{frameOrdinal}-{backendNodeId}"` (e.g. `"0-76"`, `"16-21"`) and every URL-bearing node is pre-registered in a `combinedUrlMap`. **`observe` and `act` both resolve natural-language intent down to one of these IDs (never to raw coordinates or free-text selectors)**, and **`extract` never lets the model emit a URL string at all — it forces the model to emit an integer that is looked up in the map after the fact.** This is the single most important idea to steal for an agent-browser CLI: ground every LLM output in a small enumerable ID space taken from the page snapshot, and reverse-map ID→value outside the model's control, so the model literally cannot hallucinate a URL/selector — it can only pick from a finite discrete-token menu you handed it. (Evidence: `STAGEHAND_321_FULL_EXTRACTION.md:1743-1746` "extractHandler.js key detail"; `STAGEHAND_DEEP.md` "Element ID Format" §11; `STAGEHAND_DEEP.md` Observe/Act Response Schema §6.)

---

## Patterns

### 1. Observe-before-act via a shared elementId regex-typed schema (CORE)
**What:** `observe()` and `act()` both return objects validated against `elementId: z.string().regex(/^\d+-\d+$/)`. Observe returns an *array* of `{elementId, description, method, arguments}`; act returns a *single* `{elementId, description, method, arguments, twoStep}`.
**Why:** Forcing the LLM's output schema to be a regex-constrained ID rather than a CSS selector or coordinate pair means the executor can validate the shape cheaply before ever touching the DOM, and the LLM is choosing from a menu of IDs that were already present in the snapshot it was shown — not inventing a selector from imagined DOM structure.
**How to implement:** Give your CLI's plan/act step a Zod-equivalent (jsonschema) response contract `{elementId: string matching /^\d+-\d+$/, method: enum(supportedActions), arguments: string[]}`. Build the ID space from a snapshot pass (see #2) before every act call, not from a cached/stale tree.
**Evidence:** `STAGEHAND_DEEP.md` §6 "Observe Response Schema" / "Act Response Schema" (lines ~720-743).
**Tier:** core.

### 2. Element ID = `frameOrdinal-backendNodeId`, solves cross-frame ID collisions (CORE)
**What:** CDP's `backendNodeId` is only unique *within* a frame, not across the whole page (iframes reuse the numbering). Stagehand's snapshot builder assigns each frame an ordinal and prefixes: `"0-76"`, `"16-21"`.
**Why:** Without the frame prefix, two different elements in different iframes could collide on the same ID and the wrong one gets clicked. This is a real, non-obvious CDP correctness bug class that a naive "just use backendNodeId" implementation would hit in production the first time it touches a page with ads/embeds/OAuth iframes.
**How to implement:** When building your own snapshot (via CDP `DOM.getDocument` + `Accessibility.getFullAXTree` per frame, or Playwright's accessibility snapshot per frame), enumerate frames in document order, assign `frameOrdinal`, and key every element as `f"{frameOrdinal}-{nodeId}"`.
**Evidence:** `STAGEHAND_DEEP.md` §11 "Element ID Format" (lines 1041-1043); `STAGEHAND_321_FULL_EXTRACTION.md:1315` "encodedId format: `{frameOrdinal}-{backendDOMNodeId}`".
**Tier:** core.

### 3. Extract's URL-hallucination guard: schema field swap + integer-ID grounding (CORE — the flagship pattern)
**What:** Before calling the LLM for extraction, `transformUrlStringsToNumericIds(schema)` walks the user's Zod/JSON schema and replaces every `z.string().url()` field with `z.number()`. The LLM is then asked to extract a *link element*, not a URL string, and returns an integer. That integer is looked up post-hoc in `combinedUrlMap` (built during the snapshot pass, mapping element-index → actual `href`) and the real URL is substituted back into the result before it's returned to the caller/agent.
**Why:** LLMs frequently invent plausible-looking URLs (wrong path, wrong domain, truncated query string) when asked to "extract the link." By stripping the *ability* to emit a string in that field and replacing it with "pick the integer ID of the DOM element that has that link," the ID space is exhaustively enumerable and finite — the model cannot emit anything that isn't a real link that was actually present on the page.
**How to implement (concrete algorithm for your CLI):**
1. During DOM snapshot, walk all `<a href>` / URL-bearing nodes, assign each a sequential integer index, store `{index: href}` in a map (`combinedUrlMap`).
2. Before the extraction call, transform the caller-provided output schema: any field typed as URL/link → replace with `integer`.
3. Prompt: "if extracting links/URLs, respond with ONLY the numeric ID of the link element, do not read the href out of text."
4. After the LLM responds, walk the result tree and reverse-substitute every integer in a URL-typed field back to `map[id]`.
5. If `id` not in map → treat as extraction failure for that field (null it out), never trust an out-of-range ID as a fabricated link.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1743-1746` ("extractHandler.js key detail"); `STAGEHAND_DEEP.md` Extract System Prompt verbatim (lines 521-539): *"If a user is attempting to extract links or URLs, you MUST respond with ONLY the IDs of the link elements. Do not attempt to extract links directly from the text unless absolutely necessary."*
**Tier:** core — this is the single highest-value pattern in the source for the "reported value can't be hallucinated" goal.

### 4. Extract is a 2-LLM-call pipeline: content extraction + completion-metadata assessment (CORE)
**What:** `extract()` runs two separate LLM calls per invocation. Call 1 extracts the actual structured data against the user's Zod schema (temperature 0.1, or 1 for GPT-5; `top_p:1, frequency_penalty:0, presence_penalty:0`). Call 2 is a *separate* system-prompted call that takes the instruction + the just-extracted JSON and returns `{progress: string, completed: boolean}` — an explicit self-assessment of whether the instruction has actually been satisfied yet, used for chunked/paginated extraction loops.
**Why:** Decoupling "did I get the data" from "is the data what was actually asked for" avoids a single LLM call conflating format-compliance with semantic completeness, and gives the caller a structured completion signal to drive chunk-by-chunk extraction loops (e.g., paginated tables) without re-parsing free text.
**How to implement:** Extract-call returns the payload. Second, cheap classifier-style call: system prompt says "set completed=true the instant instruction is satisfied even if chunks remain; only false if BOTH unsatisfied AND chunks remain" — this stop-early bias avoids wasted extraction cycles.
**Evidence:** `STAGEHAND_DEEP.md` §6 "Extract Pipeline (2 LLM calls)" (lines 702-718); Metadata System Prompt verbatim (lines 625-635).
**Tier:** core (for any extract-over-pagination use case) / important otherwise.

### 5. Verbatim extract system prompt: "print exact text, don't paraphrase, null on nothing found" (CORE)
**What:** Full verbatim prompt:
```
You are extracting content on behalf of a user.
If a user asks you to extract a 'list' of information, or 'all' information,
YOU MUST EXTRACT ALL OF THE INFORMATION THAT THE USER REQUESTS.

You will be given:
1. An instruction
2. A list of DOM elements to extract from.

Print the exact text from the DOM elements with all symbols, characters, and endlines as is.
Print null or an empty string if no new information is found.

ONLY print the content using the print_extracted_data tool provided. (Anthropic only)

If a user is attempting to extract links or URLs, you MUST respond with ONLY the IDs of the link elements.
Do not attempt to extract links directly from the text unless absolutely necessary.
```
**Why to copy verbatim:** Every line is a hallucination-suppression rule earned from real failure modes: "print exact text... as is" stops paraphrase-drift; "null... if no new information" gives the model an explicit escape hatch instead of inventing a plausible value; the ALL-CAPS "list/all" instruction fixes a known LLM laziness failure (stopping after 3-5 items); the link-ID rule is the enforcement clause for pattern #3 above.
**Evidence:** `STAGEHAND_DEEP.md` §4 "Extract System Prompt (verbatim)" (lines 521-539).
**Tier:** core.

### 6. Verbatim observe and act system prompts are near-identical, differ only in output cardinality (IMPORTANT)
**What:** Observe: *"Return an array of elements that match the instruction if they exist, otherwise return an empty array."* Act: *"Return the element that matches the instruction if it exists. Otherwise, return an empty object."* Both take the same input shape: "1. an instruction... 2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree."
**Why:** This confirms observe and act share one grounding function under the hood — act literally is "observe, then take the top-1 result and execute it." Building them as two prompt variants over the same underlying tree-to-ID resolver (rather than as fully separate code paths) is the efficient design.
**How to implement:** Implement one `resolve(instruction, tree) -> ElementRef[]` function; `observe` returns the full list, `act` takes `resolve(...)[0]` and executes.
**Evidence:** `STAGEHAND_DEEP.md` §4 "Observe System Prompt (verbatim)" / "Act System Prompt (verbatim)" (lines 541-564).
**Tier:** important — architecture pattern to steal even though the exact prompt bodies are short and possibly easy to reinvent.

### 7. Dropdown handling forces a hard prompt branch + optional two-step act (IMPORTANT)
**What:** Act's schema includes `twoStep: boolean`. The act prompt has an explicit branch: *"IF AND ONLY IF the action EXPLICITLY includes the word 'dropdown'..."* → CASE 1 (native `<select>`): use `selectOptionFromDropdown` method, `twoStep=false`. CASE 2 (non-native / custom dropdown, e.g. div-based combobox): click to open it (`twoStep=true`), then a *second* LLM call (`buildStepTwoPrompt`) re-snapshots the now-open dropdown and picks the actual option.
**Why:** Custom (non-`<select>`) dropdowns don't expose their options in the DOM until opened — you literally cannot resolve the target option's elementId until after the click that reveals it. A single-shot act call structurally cannot handle this; a two-step protocol is the only correct fix, and gating it on the literal word "dropdown" in the instruction avoids paying the 2x-LLM-call cost for ordinary clicks.
**How to implement:** In your act/click flow, detect "select from dropdown"-style instructions; if the target isn't a native `<select>`, execute step 1 (open), take a fresh snapshot, diff against the pre-open snapshot (see #8) to find newly-revealed nodes, then resolve step 2 against that diff/fresh tree.
**Evidence:** `STAGEHAND_DEEP.md` §6 "Act Prompt Logic (Dropdown Handling, verbatim excerpt)" (lines 745-761); `STAGEHAND_321_FULL_EXTRACTION.md:1729-1734` "Single act() call path" step 7.
**Tier:** important.

### 8. Diff-based context on the second step of a two-step act (IMPORTANT)
**What:** After the first action in a twoStep sequence, the handler takes a fresh snapshot and computes `diffCombinedTrees(tree1, tree2)`. If the diff is empty (nothing changed — e.g. click didn't open anything), it falls back to sending the *full* fresh tree instead of an empty diff.
**Why:** Sending only the diff to the second LLM call is a token-efficiency + signal-boosting move (the model doesn't have to re-read the entire page to find "what's new"), but the fallback-to-full-tree-on-empty-diff guards against silently giving the model zero context when the diff algorithm (or the page) produces no visible delta.
**How to implement:** Snapshot before action → snapshot after action → structural diff (added/removed/changed nodes by elementId) → if diff is empty, resend full tree; else send just the diff plus enough surrounding context to disambiguate.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1729-1732`.
**Tier:** important.

### 9. Act cache: SHA-256(instruction+url+variableKeys) key, deterministic replay, self-healing on selector drift (CORE)
**What:** `ActCache` (packages/core/lib/v3/cache/ActCache.ts) caches to local filesystem JSON files keyed by `SHA256(JSON.stringify({instruction, url, variableKeys}))`. Cache entry:
```typescript
interface CachedActEntry {
  version: 1;
  instruction: string;
  url: string;
  variableKeys: string[];
  actions: Action[];
  actionDescription: string;
  message: string;
}
```
On cache hit, actions are replayed **deterministically** via `handler.takeDeterministicAction()` — i.e. no LLM call at all, just re-execute the recorded Playwright calls (by XPath). **Self-healing:** if a replayed action's XPath selector fails to resolve on the live page (page changed since caching), the handler falls back to a fresh snapshot + fresh LLM inference to re-resolve, and the cache entry is refreshed with the new selector.
**Why:** This is the "expensive first run, free subsequent runs" pattern every browser-agent CLI needs — most real automations are re-run against the same site/flow repeatedly, and paying an LLM call per click every single run is both slow and non-deterministic. The self-heal fallback is what makes this *safe* to ship: a stale cache silently degrades to "do the LLM call anyway" instead of silently clicking the wrong element or hard-failing.
**How to implement:**
1. Cache key = hash of `(instruction, current_url, sorted variable names — NOT values)`.
2. Cache value = the resolved action list (method + selector/XPath) + a human-readable description.
3. On hit: try replaying by selector directly (no model call).
4. On selector-resolution failure: re-snapshot, re-infer, re-execute, and overwrite the cache entry with the new resolution — cache heals itself rather than requiring manual invalidation.
5. Variable *values* are substituted at replay time, not baked into the cache key (so the same cached flow works for different login credentials, etc. — see pattern #10).
**Evidence:** `STAGEHAND_DEEP.md` §8 "Act Cache (Local Filesystem)" (lines 820-843); `STAGEHAND_321_FULL_EXTRACTION.md:1736-1741` "takeDeterministicAction() — self-heal path" (`this.selfHeal` flag, default true).
**Tier:** core.

### 10. Variable substitution: `%token%` placeholders, values never enter the cache/model-visible history (IMPORTANT — security-relevant)
**What:** Sensitive values (passwords, etc.) are passed as `variables = {password: "secret123"}` or richer `{value, description}` objects. Text sent to the LLM and stored in caches/replay logs uses `%password%` tokens; only at the final Playwright `.type()` call is `substituteVariables()` invoked to swap in the real value. The tool result and cache entry retain the **original `%token%` text**, never the resolved secret.
**Why:** This is a real secret-hygiene pattern — it means transcripts, act-cache JSON files, and agent replay logs on disk never contain plaintext credentials, and the LLM itself never sees the actual secret value in its context (only the description, via `getVariablePromptEntries()` which strips values entirely for the system-prompt `<variables>` block).
**How to implement:** Any CLI accepting form-fill data with secrets should: (1) let the agent/LLM only ever see `%name%` tokens + a human description, never the raw value; (2) perform substitution as the very last step immediately before the actual keystroke/type call; (3) when recording action history/cache/logs, log the token form, not the substituted form.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1793-1805` "Variable System — Complete Implementation"; `STAGEHAND_DEEP.md` "type" tool description (line 287) "original `%token%` text returned to model (never exposes sensitive values)".
**Tier:** important (security pattern, not core to primitive design but cheap and high value to copy).

### 11. AriaTree ≠ extract — a fast, unstructured "read the page" tool distinct from schema-based extract (CORE)
**What:** `ariaTree` tool takes no parameters and calls `v3.extract()` **without an instruction** to get the raw hybrid ARIA+DOM tree as text, truncated at 70,000 estimated tokens (280K chars, 4-chars/token heuristic), appending `"[CONTENT TRUNCATED: Exceeded 70,000 token limit]"` when hit. The agent system prompt explicitly instructs: *"Use extract ONLY when the task explicitly requires structured data output... For reading page content or understanding elements, always use ariaTree or screenshot instead — it's faster and more reliable."*
**Why:** This is a deliberate cost/reliability split: unstructured page comprehension (does this page have what I need? where are the elements?) is cheap and doesn't need a schema-validated LLM call, while *structured* extraction (give me this exact typed JSON) is a more expensive, schema-constrained, hallucination-guarded call. Conflating them (using schema-extract for "look around") wastes tokens and adds unnecessary LLM round trips to what should be a fast page-read.
**How to implement:** Expose two distinct primitives in your CLI: `snapshot`/`read` (cheap, tree-to-text, truncated, no schema) vs `extract` (schema-bound, ID-grounded per pattern #3). Route agent guidance to strongly prefer the cheap one for exploration.
**Evidence:** `STAGEHAND_DEEP.md` §3 tool #2 "ariaTree" (lines 258-264); Agent System Prompt strategy item (line 484).
**Tier:** core.

### 12. Hybrid ARIA+DOM tree is the *only* input given to act/extract/observe LLM calls — no raw HTML (CORE)
**What:** All three primitives feed the LLM a "hierarchical accessibility tree showing the semantic structure of the page... a hybrid of the DOM and the accessibility tree" — never raw HTML. The tree filtering pipeline (`a11yTree.js`) prunes: nodes with role `generic`/`none`/`inlineTextbox` and no children are dropped; static-text children matching the parent's accessible name are collapsed; `generic`/`none` roles get replaced by actual HTML tag name; combobox+`<select>` collapses to role `select`; scrollable elements get a `scrollable, tagName` role prefix.
**Why:** Raw HTML is enormous, noisy, and full of irrelevant markup (wrapper divs, styling hooks) that burns tokens and distracts the model from actionable elements. The pruning rules specifically target "structurally present but semantically empty" nodes (generic/none wrappers) while preserving anything that carries interaction affordance or text.
**How to implement:** Build a snapshot pipeline: (1) get AX tree via CDP `Accessibility.getFullAXTree` per frame; (2) get DOM tree via `DOM.getDocument`; (3) merge: for each AX node, attach tag name, computed role, bounding rect, backendNodeId; (4) prune per the rules above; (5) serialize to a compact indented-text or JSON-lines format the LLM sees. This is worth building even if your CLI is much simpler than Stagehand — a naive `innerText`/full-HTML dump will burn far more context and produce worse grounding.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1309-1315` "a11yTree.js — tree filtering"; observe/act prompt bodies (`STAGEHAND_DEEP.md` lines 546-548, 559-561).
**Tier:** core.

### 13. Multi-frame snapshot merge with computed absolute XPath prefixes (IMPORTANT — shadow DOM / iframe correctness)
**What:** `HybridSnapshot` (`understudy/a11y/snapshot/capture.js`) is a 5-step pipeline: (1) try a scoped/fast-path snapshot for a single element if possible; (2) build one DOM index per unique CDP session (one `DOM.getDocument` call per session, not per frame — sessions can be shared); (3) collect per-frame DOM maps + AX trees; (4) compute absolute iframe XPath prefixes by walking the frame tree; (5) merge all frames into a single snapshot with a combined XPath map, URL map, and text outline. Separately, `nodeToAbsoluteXPath()` converts any DOM node to an absolute XPath while crossing shadow-DOM boundaries using `//` notation, and a `Piercer` (two-phase: entry script + runtime script) re-renders shadow content into the tree.
**Why:** Cross-origin iframes and shadow DOM are the two biggest sources of "the agent says the element doesn't exist" failures in browser automation. Doing this correctly (rather than only querying the top document) is why Stagehand can act reliably inside embedded widgets, payment iframes, web-component-based UIs.
**How to implement:** Don't just query `document.querySelectorAll` from the top frame. Walk the CDP frame tree, attach a CDP session per frame (reuse across same-origin frames when possible), compute each frame's absolute XPath prefix relative to its parent iframe element, and merge trees with those prefixes so a "single" XPath can address an element nested arbitrarily deep across frame/shadow boundaries.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1302-1308` (HybridSnapshot 5-step pipeline); `STAGEHAND_DEEP.md` §11 "Shadow DOM Piercing" (lines 1025-1029), "AXTree Processing" `nodeToAbsoluteXPath()` (line 1023).
**Tier:** important — high implementation cost, but a real differentiator for reliability on modern component-heavy sites.

### 14. DOM-depth retry ladder for large/pathological pages (NICE)
**What:** `DOM_DEPTH_ATTEMPTS = [-1, 256, 128, 64, 32, 16, 8, 4, 2, 1]` and `DESCRIBE_DEPTH_ATTEMPTS = [-1, 64, 32, 16, 8, 4, 2, 1]` — snapshot attempts start unlimited (`-1`), and on failure (likely CDP timeout/OOM on huge/deeply-nested pages) retry with progressively shallower depth caps until one succeeds.
**Why:** Pathological pages (deeply nested component trees, infinite-scroll grids) can make a full unlimited-depth AX tree walk hang or blow memory. A graceful depth-degradation ladder trades completeness for reliability rather than hard-failing the whole snapshot.
**How to implement:** Wrap your snapshot call in a retry loop over a fixed depth-cap list; catch timeout/resource errors and step down; surface to the caller (or the LLM) that the tree was depth-limited so downstream reasoning knows it may be incomplete.
**Evidence:** `STAGEHAND_321_FULL_EXTRACTION.md:1317-1322`.
**Tier:** nice-to-have — good defensive engineering, not core to the primitive contracts.

### 15. Tool-timeout wrapping with per-tool actionable error hints, fed back to the LLM (IMPORTANT)
**What:** All I/O tools except `think`/`wait` are wrapped by `wrapToolWithTimeout()` (default `45000ms`). On timeout, the tool returns `{success: false, error: "TimeoutError: ..."}` **to the LLM**, with tool-specific hints appended: act → "(it may continue executing in the background) — try using a different description for the action"; ariaTree → "— the page may be too large"; extract → "— try using a smaller or simpler schema"; fillForm → "(it may continue executing in the background) — try filling fewer fields at once or use a different tool".
**Why:** A bare "timeout" error gives the LLM no actionable next step and it tends to retry the identical failing call. Per-tool hints steer the model toward the actual likely fix (shrink schema, split the batch, rephrase), which is cheap to add and meaningfully reduces retry-loop thrash.
**How to implement:** Standardize a timeout wrapper around every tool execution; catch, and instead of a generic message, return a tool-specific "here's probably why, here's what to try" string as part of the tool result content (not just an HTTP-style error code) so it's directly visible to the LLM's next turn.
**Evidence:** `STAGEHAND_DEEP.md` §3 "Tool Timeout Wrapping" (lines 438-445).
**Tier:** important — cheap, high leverage for agent loop robustness.

### 16. Agent-level cache is a separate, higher-level replay system from ActCache (NICE)
**What:** `AgentCache` records `AgentReplayStep[]` during a full agent run (step types: `act`, `goto`, `scroll`, `wait`, `navback`, `fillForm`, `search`) — i.e. the whole multi-step task, not just a single act call. Server-side, `__internalCreateInMemoryAgentCacheHandle()` swaps in an in-memory cache during execution and restores the original on complete/discard, enabling "record once, replay the whole flow" for a server product.
**Why:** Distinguishes single-action caching (ActCache, pattern #9) from whole-task caching (AgentCache) — a CLI wanting "run this recorded macro again" needs the higher-level structure; a CLI wanting "don't re-resolve this one click every time" needs the lower-level one. Building both as separate layers (rather than one omnibus cache) keeps each simple.
**Evidence:** `STAGEHAND_DEEP.md` §8 "Agent Cache (Replay System)" (lines 844-851).
**Tier:** nice-to-have — useful architectural separation to note, lower priority to implement first.

### 17. Explicit stop-condition contract: last-step tool-call check + hard step cap + forced "done" call (IMPORTANT)
**What:** `handleStop()` returns true iff the *last* completed step's tool calls include a call to `done`, OR `stepCountIs(maxSteps)` (default 20 for the DOM/hybrid agent, 10 for CUA agents) is satisfied. If the loop ends via the step cap without `done` ever being called, `ensureDone()` forces one more `generateText` call with `toolChoice: {type:"tool", toolName:"done"}` and a schema `{reasoning, taskComplete, output?}`, guaranteeing every agent run terminates with a structured self-report rather than silently trailing off.
**Why:** This guarantees the caller always gets a machine-parseable "did it actually finish, and what happened" answer even when the model runs out of steps mid-task — a common failure mode in naive agent loops is returning nothing/empty on step-cap exhaustion.
**How to implement:** Make "done" a first-class tool in your loop's toolset; check for it after each step; on cap-exhaustion, force one final call with `tool_choice` pinned to the done tool so the model *must* emit a structured completion assessment, not free text.
**Evidence:** `STAGEHAND_DEEP.md` §2 "Stop Conditions" / "ensureDone()" (lines 205-223); Done Tool System Prompt verbatim (lines 610-623).
**Tier:** important.

### 18. Mode-gated tool sets: DOM-mode vs Hybrid-mode as two disjoint tool registries sharing `act` as fallback (NICE)
**What:** DOM mode exposes `act, fillForm, ariaTree, screenshot, extract, goto, wait, navback, scroll, keys, think, search` and explicitly removes `click, type, dragAndDrop, clickAndHold, fillFormVision`. Hybrid mode exposes the coordinate-based tools (`click, type, dragAndDrop, clickAndHold, fillFormVision`) plus `act` as fallback, and removes `fillForm`. A warning is logged if the hybrid-mode model isn't `gemini-3-flash` or a `claude` family model (coordinate grounding is model-quality-dependent).
**Why:** Coordinate-based interaction only works well with models that have been specifically trained/verified for visual grounding; ID/selector-based interaction works with any capable text model. Making this an explicit, enforced mode switch (not "give the model everything and hope it picks right") avoids the model reaching for pixel-coordinate tools on a model that can't reliably estimate pixel coordinates.
**Evidence:** `STAGEHAND_DEEP.md` §2 "Two Agent Modes" (lines 196-204).
**Tier:** nice-to-have — relevant if your CLI ever adds a vision/coordinate fallback mode, otherwise skip (see anti-patterns).

---

## Command Surface (verbatim / near-verbatim)

**HTTP API surface** (server-v3, Fastify):
```
POST /v1/sessions/start            -- create session
POST /v1/sessions/:id/act          -- execute act()
POST /v1/sessions/:id/extract      -- execute extract()
POST /v1/sessions/:id/observe      -- execute observe()
POST /v1/sessions/:id/navigate     -- navigate to URL
POST /v1/sessions/:id/agentExecute -- run full agent
POST /v1/sessions/:id/replay       -- replay cached actions
POST /v1/sessions/:id/end          -- end session
GET  /healthcheck
GET  /readiness
```
(`STAGEHAND_DEEP.md` §9, lines 862-873)

**observe/act response schema** (Zod, verbatim shape):
```typescript
// observe
z.object({
  elements: z.array(z.object({
    elementId: z.string().regex(/^\d+-\d+$/),
    description: z.string(),
    method: z.enum(Object.values(SupportedUnderstudyAction)),
    arguments: z.array(z.string())
  }))
})
// act
z.object({
  elementId: z.string().regex(/^\d+-\d+$/),
  description: z.string(),
  method: z.enum(Object.values(SupportedUnderstudyAction)),
  arguments: z.array(z.string()),
  twoStep: z.boolean()
})
```
(`STAGEHAND_DEEP.md` §6, lines 722-743)

**extract tool input schema** (JSON-Schema-esque, passed through `jsonSchemaToZod()`):
```typescript
z.object({
  instruction: z.string(),
  schema: z.object({
    type: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    items: z.unknown().optional(),
    enum: z.array(z.string()).optional(),
    format: z.enum(["url","email","uuid"]).optional()
  }).passthrough().optional()
})
```
(`STAGEHAND_321_FULL_EXTRACTION.md:917-925`)

**act cache entry format:**
```typescript
interface CachedActEntry {
  version: 1;
  instruction: string;
  url: string;
  variableKeys: string[];
  actions: Action[];
  actionDescription: string;
  message: string;
}
```
Cache key = `SHA256(JSON.stringify({instruction, url, variableKeys}))`.
(`STAGEHAND_DEEP.md` §8, lines 826-839)

**Extract system prompt (verbatim, copy this):**
```
You are extracting content on behalf of a user.
If a user asks you to extract a 'list' of information, or 'all' information,
YOU MUST EXTRACT ALL OF THE INFORMATION THAT THE USER REQUESTS.

You will be given:
1. An instruction
2. A list of DOM elements to extract from.

Print the exact text from the DOM elements with all symbols, characters, and endlines as is.
Print null or an empty string if no new information is found.

ONLY print the content using the print_extracted_data tool provided. (Anthropic only)

If a user is attempting to extract links or URLs, you MUST respond with ONLY the IDs of the link elements.
Do not attempt to extract links directly from the text unless absolutely necessary.
```

**Observe system prompt (verbatim):**
```
You are helping the user automate the browser by finding elements based on what the user wants to observe in the page.

You will be given:
1. a instruction of elements to observe
2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

Return an array of elements that match the instruction if they exist, otherwise return an empty array.
When returning elements, include the appropriate method from the supported actions list.
```

**Act system prompt (verbatim):**
```
You are helping the user automate the browser by finding elements based on what action the user wants to take on the page

You will be given:
1. a user defined instruction about what action to take
2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

Return the element that matches the instruction if it exists. Otherwise, return an empty object.
```

**Dropdown branch logic (verbatim excerpt, act prompt):**
```
IF AND ONLY IF the action EXPLICITLY includes the word 'dropdown' and implies choosing/selecting an option from a dropdown, ignore the 'General Instructions' section, and follow the 'Dropdown Specific Instructions' section carefully.

CASE 1: the element is a 'select' element.
  - choose the selectOptionFromDropdown method
  - set the argument to the exact text of the option
  - set twoStep to false

CASE 2: the element is NOT a 'select' element:
  - choose the node that most closely corresponds to the given instruction EVEN if it is a 'StaticText' element
  - choose the 'click' method
  - set twoStep to true
```

**Metadata / completion-assessment system prompt (verbatim, extract's second LLM call):**
```
You are an AI assistant tasked with evaluating the progress and completion status of an extraction task.
Analyze the extraction response and determine if the task is completed or if more information is needed.
Strictly abide by the following criteria:
1. Once the instruction has been satisfied by the current extraction response, ALWAYS set completion status to true and stop processing, regardless of remaining chunks.
2. Only set completion status to false if BOTH of these conditions are true:
   - The instruction has not been satisfied yet
   - There are still chunks left to process (chunksTotal > chunksSeen)
```

**Key constants:**
| Constant | Value | Anchor |
|---|---|---|
| Extract/observe/act temperature | `0.1` (or `1` for GPT-5) | `STAGEHAND_DEEP.md:1055` |
| Extract `top_p` / `frequency_penalty` / `presence_penalty` | `1` / `0` / `0` | `STAGEHAND_DEEP.md:1056-1058` |
| AriaTree truncation | `70000` tokens / `280000` chars (4 chars/token heuristic) | `STAGEHAND_DEEP.md:1061` |
| Agent max steps (DOM/hybrid) | `20` | `STAGEHAND_DEEP.md:1059` |
| Agent max steps (CUA) | `10` | `STAGEHAND_DEEP.md:1060` |
| Default tool timeout | `45000ms` | `STAGEHAND_DEEP.md §12` |
| DOM depth retry ladder | `[-1,256,128,64,32,16,8,4,2,1]` | `STAGEHAND_321_FULL_EXTRACTION.md:1319` |
| Describe depth retry ladder | `[-1,64,32,16,8,4,2,1]` | `STAGEHAND_321_FULL_EXTRACTION.md:1320` |
| ElementId format | `/^\d+-\d+$/` i.e. `{frameOrdinal}-{backendNodeId}` | `STAGEHAND_DEEP.md:1041-1043`, `STAGEHAND_321_FULL_EXTRACTION.md:1315` |

---

## Anti-patterns (do NOT copy as-is)

1. **Two entirely separate agent architectures (V3AgentHandler tool-loop vs V3CuaAgentHandler screenshot-in/action-out CUA loop) coexisting in one codebase.** Justified for Stagehand because it supports 4 different CUA providers (OpenAI/Anthropic/Google/Microsoft) each with incompatible native APIs, but for a single-agent-browser CLI targeting one or two model families, maintaining two fully parallel execution engines is unnecessary complexity. Pick ID-grounded act/observe/extract (patterns #1-#3) as the primary path; only add a coordinate/vision fallback if you specifically need to support models with no reliable AX-tree-based tool use.
2. **Coordinate-based `click`/`type`/`fillFormVision` tools as a first-class parallel interaction mode.** These require constant per-provider coordinate normalization (`processCoordinates()`, Google's 0-1000 scaled coords vs raw pixels) and only work reliably with vision-verified models (explicit warning in source: "if model is not `gemini-3-flash` or `claude` family"). This is a maintenance and reliability tax; the ID-grounded `act`/`observe` path (pattern #1) is strictly more portable across models and should be the default and, for a v1 CLI, likely the *only* interaction path.
3. **4 fully separate CUA provider clients (OpenAI Responses API, Anthropic beta Computer Use, Google GenAI, Microsoft FARA with XML-based tool parsing)**, each with distinct wire formats (`computer_call` items vs `beta.messages` tool_use vs GenAI function calls vs XML tags). This is provider-lock-in complexity worth avoiding — building against one clean tool-calling abstraction (e.g. always going through a single structured-output/function-calling contract) avoids maintaining 4 divergent parsers.
4. **15 AI-SDK providers + a legacy "model name without provider prefix" fallback map** (`gpt-4.1` → `openai`, `gemini-1.5-flash` → `google`, etc., `STAGEHAND_DEEP.md` lines 779-809) is legacy-compat cruft carried for backward compatibility with older Stagehand API users. Don't replicate the dual-format (`provider/model` vs bare legacy string) resolution logic from scratch — pick one canonical model-id format (`provider/model`) from day one.
5. **`ariaTree` truncation via naive `chars/4` token heuristic with a hard cutoff and no summarization** (`"[CONTENT TRUNCATED: Exceeded 70,000 token limit]"`) silently drops page content past the limit with no chunking/pagination fallback for that specific tool. Fine as a v1 safety valve, but a more robust CLI should offer paginated/scrollable reads rather than silent truncation when a page genuinely exceeds the budget.
6. **Local filesystem JSON act-cache with no eviction/TTL policy mentioned** — usable for a single-machine CLI but not multi-tenant-safe; if building a shared/server CLI, add explicit TTL + eviction rather than copying the bare "JSON file per hash" scheme verbatim.
