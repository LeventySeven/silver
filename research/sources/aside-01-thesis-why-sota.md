# Aside — Thesis & Why-SOTA Digest

**Mined for:** ultimate-agent-browser (agent-browser CLI/skill)
**Source teardown:** `_aside_parts/10_overview.md`, `95_why_sota.md`, `93_benchmark_analysis.md`, `94_competitor_context.md`
**Focus:** "agent as code-execution over the live web," why the HARNESS wins independent of the model, D2Snap, the 300-trajectory benchmark, fixed-viewport + concurrency claims.

---

## Killer Insight

**Aside is SOTA because of the harness, not the model — and the harness's single highest-leverage decision is representation, not tooling.** The winning run is a commodity frontier model (`gpt-5.5`) wrapped in: (1) a single `repl` tool where the model writes Playwright TypeScript instead of choosing from a click/type schema, and (2) an observation that is a **downsampled, hierarchy-preserving accessibility tree with stable ref handles**, diffed between turns. The model-swap proof (`93_benchmark_analysis.md:1-20`, `95_why_sota.md:9-20`): the *same* harness scores 93% with GPT-5.5 and 88% with cheap open Kimi-k2.6 on BU-Bench-V1, and the entire gap is concentrated in reasoning-heavy categories (GAIA, BrowseComp) — on pure browser-navigation both models land at ~59/60. This is independently corroborated by the academic literature (D2Snap, arXiv 2508.04412: downsampled tree 73% > screenshot 65% > raw DOM 38%, "image input demonstrates little value for backend LLMs") and by a rival (Browser Use's own benchmark-winning 97% run abandoned click/type tools and became a Python-writing coding agent — independent convergence on the same "agent as code-execution" thesis). **For the ultimate CLI: the representation (downsampled a11y tree + diff + stable refs) and the action surface (one REPL, not N tools) are the two decisions that matter more than model choice.**

---

## Patterns

### 1. Single `repl` tool, not a click/type schema (CORE)
**What:** The agent's entire tool surface is one `repl` tool. The model writes TypeScript that runs in a persistent, sandboxless-to-the-web REPL against a Playwright-like `page` object: `openTab`, `snapshot(page)`, `page.locator('e31')`, `annotatedScreenshot`, `fs`, `fetch`, `sleep`, `display`. 120s timeout, no imports, scope persists across calls.
**Why:** CodeAct lets one turn batch several actions + a read (fill; click; press Enter; snapshot) in a single round-trip — cuts round-trips and compounding error. LLMs are heavily pre-trained on Playwright syntax; a bespoke JSON tool schema is a novel abstraction the model has to be taught in-context.
**How to implement:** Expose exactly one tool (`repl`/`exec_js` or similar) that runs against a real Playwright `page` handle in a persistent process-scoped REPL. Give it helper globals (`openTab`, `snapshot`, `tabs[]`, `webfetch`, `websearch`) rather than teaching the model raw CDP. Do NOT spend prompt budget re-teaching the Playwright API — assume pre-training familiarity ("we just say 'Playwright is available'" vs. Playwright-MCP's 13K-token API explanation).
**Evidence:** `10_overview.md:60` ("LIVE-proven: … model emitted `await openTab(...); const s1 = await snapshot(page); console.log(s1.tree);`"); `95_why_sota.md:27` ("LLMs are not trained to use CDP"); `94_competitor_context.md:38` (Playwright MCP 13K-token teach cost vs. Aside's terse mention).
**Tier:** CORE

### 2. Downsampled, enriched, hierarchy-preserving a11y tree as THE observation (CORE — centerpiece)
**What:** `snapshot(page, {interactive:true})` returns a compact indented accessibility tree: `- heading "Example Domain" [level=1]`, `- link "Learn more" [ref=e1]`. Three simultaneous moves: (a) **downsample** — keep only interactive ∪ scrollable ∪ landmark ∪ canvas nodes, collapse bare generics, fold text-leaf children into parent name, never silently truncate (a re-scope error instead); (b) **enrich** — annotate `[focused] [scrollable] [checked] [disabled] [selected] [placeholder] [size=WxH]`, inline child-iframe subtrees under an `- iframe` line with an `fN` ref prefix, include off-viewport elements; (c) **diff-when-shorter** — after an action, return a git-style `@@` unified diff vs. the prior snapshot, not a full re-serialization.
**Why:** This is exactly what the literature says wins. D2Snap (arXiv 2508.04412): raw DOM 38% success, screenshot baseline 65%, downsampled hierarchy-preserving tree 73% (+8% over baseline) — and "hierarchy represents a significant UI feature for LLMs." Off-screen/iframe completeness means the model doesn't need to scroll-and-rescreenshot to discover content. Stable refs survive across a turn but are invalidated by the next snapshot, forcing correct re-grounding instead of stale-coordinate clicks.
**How to implement:** Build a page-injected accessibility-tree walker (not raw DOM serialization). Filter to interactive/scrollable/landmark/canvas node classes; collapse non-semantic wrapper divs; assign short opaque ref IDs (`e1`, `e2`, iframe-prefixed `f1e1`) resolved server-side to live element handles, invalidated on next snapshot. Compute and return a text diff of the tree between calls, falling back to full tree on first snapshot or if `!diff`. Never `.slice()`/truncate the output silently.
**Evidence:** `10_overview.md:64`; `95_why_sota.md:29-36`; `94_competitor_context.md:139-176` (D2Snap table: Raw DOM 38%/8121 tok, Grounded GUI 65%/3754 tok, D2Snap best 73%/18943 tok).
**Tier:** CORE

### 3. Two-tier snapshot: cheap `{interactive:true}` to act, scoped/full snapshot to read (CORE)
**What:** Default observation is `snapshot(page, {interactive:true})` (clickable/focusable only, annotated with a `# note:` line telling the model it's filtered). The agent escalates only when needed: `{selector:'main'}` / `{selector:'[role="dialog"]'}` (CSS-scoped subtree), `{ref:'e276'}` (rooted at a prior handle), `{showHidden:true}` (dig for collapsed content), `{interactive:false}` (full tree to read prices/tables/text).
**Why:** Token-budget strategy — cheap snap to *act*, targeted snap to *read*. Keeps median observation cost at ~1,699 tokens/task despite ~13 snapshots/task.
**How to implement:** Give `snapshot()` an options bag: `interactive` (bool, default true), `selector` (CSS scope), `ref` (root at element handle), `showHidden` (bool). Document the escalation ladder in the system prompt: interactive snapshot → scoped/full snapshot → screenshot, only as needed.
**Evidence:** `93_benchmark_analysis.md:281-296` (§3.2, all four scoping options observed in the wild across 300 trajectories).
**Tier:** CORE

### 4. Diff-based incremental observation (CORE — the real token-saver)
**What:** The snapshot result object carries both `.tree` (full serialization) and `.diff` (delta vs. previous snapshot). Dominant idiom in 278/300 trajectories: `console.log(s3.diff || s3.tree)`.
**Why:** After the first full tree, the model is fed only the mutated subtree — this is why median observation cost stays ~1.7k tokens despite ~13 snapshots/task, directly fighting context rot on long tasks.
**How to implement:** Maintain a per-tab "last snapshot" cache; on each new snapshot compute a structural diff (added/removed/changed nodes) and return both `tree` and `diff` fields, with `diff` being `null`/absent on the first call. Encourage `diff || tree` as the canonical logging pattern in the system prompt/examples.
**Evidence:** `93_benchmark_analysis.md:298-312` (§3.3: `sN.tree` 1,035× / `sN.diff` 961× / `sN.diff || sN.tree` 831× across 300 tasks).
**Tier:** CORE

### 5. Stable, short-lived ref handles resolved server-side (CORE)
**What:** Refs like `e12`, `f1e1` (iframe-prefixed) are ephemeral locator handles resolved daemon-side to real Playwright locators; every new snapshot invalidates old refs.
**Why:** Unambiguous addressing — a `<select>` or checkbox is one addressable node (`page.locator('e31').selectOption(...)`), vs. a pixel model that must localize a coordinate and hope the click lands. Forces the model to re-ground rather than act on stale references after DOM mutation.
**How to implement:** Assign short opaque IDs per snapshot call, keep a server-side map ref→ElementHandle scoped to that snapshot generation; any locator call against a stale ref should throw a distinct `RefStaleError` so the model can recognize "re-snapshot and retry" as the correct recovery, not a generic failure.
**Evidence:** `10_overview.md:64`; `94_competitor_context.md:127-131` (mechanistic argument for why this beats pixel coordinates).
**Tier:** CORE

### 6. Fixed viewport for perception, regardless of window size (IMPORTANT)
**What:** A hardwired 1440×900 render surface for every agent tab (`AsideAiTabsViewport`), not a per-call `setDeviceMetricsOverride`.
**Why:** Every agent tab renders at one canonical resolution, keeping screenshots/vision steps in the pixel distribution the CUA/vision models were trained on — pixel→coordinate mapping stays accurate whenever the vision escape hatch is used.
**How to implement:** Force a constant viewport size at tab-creation time for all agent-controlled tabs, decoupled from any visible browser window size. If you support vision-fallback grounding at all, this determinism matters; if you're 100% a11y-tree-based, it's lower priority.
**Evidence:** `95_why_sota.md:38`; `10_overview.md` Part-56 index references Part 92 (Chromium accuracy patches).
**Tier:** IMPORTANT

### 7. Structural no-focus-steal + high concurrency via backgrounded tabs (IMPORTANT)
**What:** Agent tabs are created via `Target.createTarget{background:true, focus:false}` in a separate "Agent Tabs" group; the control API exposes only `open`/`close`, no `activate` verb — the agent structurally cannot raise/focus a tab. Backgrounded tabs are kept full-speed (`document.hasFocus()===true` via `Page.setWebLifecycleState{active}` + focus emulation) so they don't get browser-throttled.
**Why:** This is what makes concurrency 3–6 safe and non-disruptive to a foreground human user — a structural guarantee, not a convention the model has to respect.
**How to implement:** If building on CDP/Playwright directly: create automation tabs backgrounded, never call `bringToFront()`/`Target.activateTarget` from agent code paths, and explicitly counteract Chrome's background-tab throttling (page visibility API spoofing / lifecycle state pinning) so timers/animations/network don't degrade in hidden tabs.
**Evidence:** `95_why_sota.md:39` (§3.3).
**Tier:** IMPORTANT

### 8. Stealth-by-authenticity, not spoofing (IMPORTANT)
**What:** Drives a real, non-headless, code-signed browser with the user's real profile/cookies/TLS fingerprint and never sets `--enable-automation`. Result: clears live-site anti-bot without active fingerprint spoofing. Still hits captcha/blocks on 68/300 tasks, handled by an in-house OCR/mouse captcha loop.
**Why:** Real browser + real session state beats trying to fake a fingerprint. Anti-bot systems that key off `navigator.webdriver`/automation flags are avoided by simply not setting them, rather than by elaborate spoofing.
**How to implement:** Run a genuine, persistently-profiled browser instance (real cookies, real extensions state where relevant) rather than a fresh headless/incognito instance per task; avoid automation-flag-setting launch args where the automation protocol allows it (CDP-only control, no `--enable-automation`).
**Evidence:** `95_why_sota.md:40`.
**Tier:** IMPORTANT

### 9. Web-search/webfetch escape hatches that bypass the DOM entirely (CORE)
**What:** Non-browser tools available inside the same REPL: `webfetch(url, format, timeout)` — headless HTTP fetch returning markdown, used to hit raw JSON APIs directly (`recreation.gov/api/search`, `api.openalex.org/works`), read `web.archive.org` snapshots, or `r.jina.ai` reader-proxy URLs; and `websearch(objective, search_queries[], mode:"agentic")` returning citeable results with `<citation refs="...">` tags. Used in 78/300 tasks (26%).
**Why:** The agent should choose the cheapest tool for an information-retrieval sub-task rather than always driving the UI. One example task (Qatar baggage) is solved in 2 browser acts total: open homepage → `websearch()` → answer with citation, no clicking at all.
**How to implement:** Give the REPL two first-class async functions alongside browser primitives: `webfetch(url, {format:'markdown'|'html', timeout})` for direct HTTP/API access, and `websearch(objective, queries[])` for a real search backend, with citation-tagged results. Prompt the model explicitly that these are valid alternatives to browser navigation, not just a last resort.
**Evidence:** `93_benchmark_analysis.md:314-330` (§3.4, 243 webfetch occurrences/45 tasks, 129 websearch/65 tasks); example at line 328.
**Tier:** CORE

### 10. A lean, disciplined system prompt encoding recovery + verification ladders, not raw capability (CORE)
**What:** ~10K-token system prompt (half of Claude Code's) that encodes: a **reading-escalation ladder** (interactive snapshot → full → screenshot), a **recovery ladder** (dismiss popups/cookie-banners first; re-snapshot before retry; switch strategy after 2–3 fails; solve captchas), **actionability retries** (`waitForReady`/`checkHitTarget`/`scrollIntoViewIfNeeded`/`RefStaleError`), and a hard **completion-verification** rule: "verify you accomplished it, not just attempted."
**Why:** Behavioral prevalence across 300 trajectories confirms this is load-bearing, not aspirational: 262/300 tasks show explicit verify/confirm language before answering; 200/300 show retry/strategy-switch language; 191/300 hit cookie-consent UI and it's almost never the failure cause; 122/300 hit at least one `Error:` in a repl result yet 297/300 still pass — because each act is code, a throw returns an error string into the next observation and the model writes a new approach.
**How to implement:** Bake three explicit ladders into the system prompt: (1) observation escalation (cheap→expensive snapshot→vision), (2) failure recovery (re-snapshot on error/timeout → try semantic locator (`getByRole`/`getByText`) if ref is stale → try URL-query-param manipulation or `webfetch` against a JSON API if the UI is a dead end), (3) a mandatory "read back the resulting state before claiming done" step — never trust that a click "probably worked."
**Evidence:** `95_why_sota.md:42-43`; `93_benchmark_analysis.md:334-397` (§4, behavioral prevalence table + Rotten Tomatoes popup example + Best-Buy recovery escalation).
**Tier:** CORE

### 11. Completion-verification via a final confirming snapshot (CORE)
**What:** Before emitting a final answer, the agent takes one more snapshot to confirm the actual resulting page state (e.g., confirming "13 open roles" and a filter's `[selected]` state) rather than trusting that its own prior actions succeeded.
**Why:** Directly rewarded/punished by both grader designs referenced in the benchmark: Odysseys grader explicitly requires "Filtering / sorting / form requirements must be applied **and confirmed**"; BU grader auto-fails "the agent calls done action before completing all key points of the task."
**How to implement:** Add an explicit final-step instruction: "Before answering, take one more observation of the current state and verify every claim you're about to make against it." Make this a structural step, not just a prompt suggestion — e.g., require the last tool call before a text-only final turn to be a `snapshot`/read call.
**Evidence:** `93_benchmark_analysis.md:378-387` (§4.3); grader quotes at `93_benchmark_analysis.md:140,161-162`.
**Tier:** CORE

### 12. Multi-tab as a first-class capability, addressed by index (IMPORTANT)
**What:** `openTab()` returns a handle; tabs are addressed as `tabs[0]`, `tabs[1]`, etc. 123/300 tasks open ≥2 tabs (max 12 on one task) — opening a second tab to compare listings or read a detail page while keeping results live.
**Why:** Lets the agent parallelize information-gathering within a single task without losing a working page's state.
**How to implement:** Expose a `tabs[]` array/collection in the REPL global scope; `openTab(url)` appends and returns a handle; support closing individual tabs without tearing down the session. No special multi-tab orchestration logic needed — it falls out naturally from exposing tabs as ordinary objects the code can hold references to.
**Evidence:** `93_benchmark_analysis.md:389-396` (§4.4).
**Tier:** IMPORTANT

### 13. Actionability gates before every interaction, with typed retry errors (IMPORTANT)
**What:** Before clicking/filling, the runtime performs `waitForReady`/`checkHitTarget`/`scrollIntoViewIfNeeded` gates; stale refs raise a distinct `RefStaleError`.
**Why:** Converts silent failures (click lands on nothing, or on the wrong element after a reflow) into typed, recoverable errors the model can reason about and retry against, rather than opaque timeouts.
**How to implement:** Wrap every locator-based action with pre-flight checks: is the element attached, visible, not covered by another element (hit-target check), and scrolled into view; on failure raise a specific typed error (not a generic timeout) so the model's recovery ladder (pattern #10) can match on it.
**Evidence:** `95_why_sota.md:43` (§3.4).
**Tier:** IMPORTANT

### 14. Sub-2-second single-op execution as the floor for a viable REPL (NICE — perf target)
**What:** LIVE-measured: for "read example.com's H1," the daemon executed `openTab` + `snapshot` in 752ms end-to-end.
**Why:** Sets a rough perf bar — a REPL-driven browser agent needs each round-trip fast enough that a 12-30 step task (the observed mean/hard-case range) completes in a reasonable wall-clock window (observed median wall-time 136s, p90 7.3min).
**How to implement:** Benchmark your own `openTab`+`snapshot` round-trip; treat sub-second single-op latency as a target for the perception layer specifically (separate from model thinking latency, which dominates total wall-time — browser-side `elapsed_time` was mean 29s/median 14s per task vs. much larger total wall-time).
**Evidence:** `10_overview.md:60`; `93_benchmark_analysis.md:216` (§2.2, browser-side elapsed_time vs total wall-time split).
**Tier:** NICE

### 15. Report step counts as "acts" (repl/tool calls), not raw message counts (NICE — eval methodology)
**What:** Two different "step" notions tracked: `messageCount` (every assistant/tool message) vs. **repl-call count** (true number of code executions). Mean 12.9 repl calls/task vs. mean 34.0 messages/task — messages overcount by ~2.6x because thinking/text turns aren't acts.
**Why:** If you're building eval/observability tooling for your own agent-browser, counting "turns" naively will misrepresent efficiency; the meaningful unit is one code-execution round-trip.
**How to implement:** In telemetry/eval harnesses, track both metrics but report "acts" (tool-call count) as the headline efficiency number, and break it down by task difficulty (the source shows a clean scaling: easy 7.8 → medium 11.9 → hard 20.2 repl calls).
**Evidence:** `93_benchmark_analysis.md:190-202` (§2.1 table).
**Tier:** NICE

### 16. Grading discipline for a self-built eval harness: cross-vendor judge, temperature 0, explicit "be doubtful" instruction, impossible-task bucket (IMPORTANT — if you build evals)
**What:** BU-Bench grader = `gemini-2.5-flash` (different vendor from the `gpt-5.5` agent), temperature 0, structured-output schema forcing `{reasoning, verdict:bool, failure_reason, impossible_task:bool, reached_captcha:bool}`, explicit prompt instruction "Be initially doubtful of the agent's self-reported success," and a ground-truth-takes-absolute-precedence override block when an answer key exists. Odysseys grader is per-rubric (not holistic), grades on full screenshots + action history, "Do not invent state," "Filtering/sorting/form requirements must be applied and confirmed."
**Why:** Cross-vendor grading (Gemini judging a GPT/OpenAI-Codex agent) reduces same-model self-preference bias — the strongest mitigant against a self-reported-benchmark critique. An explicit impossible-task bucket prevents silently laundering unwinnable tasks into failures or successes.
**How to implement:** If building your own eval suite for the agent-browser: use a different model family as judge than your agent's default model; force structured JSON verdicts (not free text) with an explicit `impossible_task` escape valve; set judge temperature 0; publish per-task traces so results are independently auditable (this is exactly the gap the competitor-context part flags against Aside's own unpublished Mind2Web grader — see anti-patterns).
**Evidence:** `93_benchmark_analysis.md:124-168` (§1.3, verbatim grader prompts); `94_competitor_context.md:308-320` (grader-validation ledger).
**Tier:** IMPORTANT

---

## Command Surface (verbatim / near-verbatim)

REPL globals and call patterns observed directly in the 300-trajectory `trajectory.txt` corpus:

```js
// canonical open+observe (first act of nearly every task)
const p1 = await openTab('https://careers.walmart.com/');
const s1 = await snapshot(page, {interactive: true});
console.log(s1.tree);
// → "✔︎ Opened a new tab and set it active: tabs[0], page → Walmart Careers (…)"
//    "# note: interactive (clickable / focusable) elements only."
//    "- button "Career areas" [ref=e2] … - textbox "Search…" [ref=e10] … - button "Search icon" [ref=e11]"

// act on a ref handle
await page.locator('e10').fill('support services');
await page.locator('e11').click();

// diff-based re-observe (the dominant idiom, 831/300 tasks-worth of occurrences)
const s3 = await snapshot(page, { interactive: true });
console.log(s3.diff || s3.tree);

// scoped/full snapshot variants
snapshot(page, {selector: 'main'})
snapshot(page, {selector: '[role="dialog"]'})
snapshot(page, {selector: '[data-component-type="s-search-results"]'})
snapshot(page, {ref: 'e276'})
snapshot(page, {showHidden: true})
snapshot(page, {interactive: false})   // full tree, for reading text/prices/tables

// non-browser escape hatches
await webfetch('https://www.recreation.gov/api/search?activity=HORSE&lat=…', 'markdown', 30);
await websearch({
  objective: '…',
  search_queries: ['site:qatarairways.com baggage allowance economy', '…'],
  mode: 'agentic',
});
// results come back citeable: <citation refs="search_…#1">…</citation>

// locator API surface actually used (Playwright-compatible)
page.locator('eN').click()
page.locator('eN').fill(text)
page.locator('eN').selectOption(value)
page.locator('eN').press(key) / page.keyboard.*
page.locator('eN').type(text)   // rare — char-by-char
page.locator('eN').hover()
page.getByRole(role, {name}) / page.getByText(text)   // semantic fallback when a ref goes stale
page.evaluate(fn)   // raw in-page JS escape hatch
```

Real CLI invocation used to run the shipped agent in the benchmark harness (proves it's not a special scaffold):

```
aside exec --model <provider>/<modelId> --thinking <off|minimal|low|medium|high|xhigh> \
  --log-dump <events.jsonl> "<prompt>"
```
(`93_benchmark_analysis.md:57-69` — argv assembly, spawn via Node `spawn()`, `stdio: ['ignore','pipe','pipe']`, timeout `DEFAULT_TIMEOUT_MS = 30*60_000` with SIGTERM then SIGKILL after 10s, worker-pool concurrency default 6.)

CLI event/log format (`--log-dump` NDJSON, one JSON object per line):
```js
// assistant message
{ role: 'assistant', content: [
  { type: 'toolCall', id, name: 'repl', arguments: { title, code } },
  { type: 'text', text },
]}
// tool result
{ role: 'toolResult', toolCallId, content: [
  { type: 'text', text: '...' },
  { type: 'image', mimeType, data: '<base64>' },
]}
```
Tool-result truncation for downstream grading: repl results 1,200+1,200 chars (head+tail), other tools 1,000+1,000 chars.

Result quality/verdict schema (BU grader, structured output):
```json
{"reasoning": "...", "verdict": true, "failure_reason": "...", "impossible_task": false, "reached_captcha": false}
```

---

## Anti-patterns (what NOT to copy)

1. **Don't ship a per-vendor-graded "SOTA" number as ground truth for your own calibration target.** Aside's headline 99.0% is self-run, self-graded (by an unvalidated `gpt-5.4` judge, no human-agreement measurement, no independently republished per-task traces), and sits inside the ~13-15% disagreement band of the official WebJudge grader relative to the ~90% independently-reproduced frontier (ABP+Opus 4.6, 90.53%, Steel leaderboard). If you calibrate the agent-browser against a self-graded number you'll overfit to grader leniency, not real capability. **Anti-pattern:** treating a vendor's own self-graded benchmark as the design target. **Do instead:** calibrate to the independently-reproduced ~90% ceiling and grade with a human-validated judge (WebJudge or equivalent), publishing per-task traces. (`94_competitor_context.md:285-320,351-365`)

2. **Don't conflate "fast mode" / config claims in docs with what the code actually does.** The benchmark repo's README claims "fast mode: true" but neither in-repo runner passes any `--fast` flag and both hardcode `fast_mode:false` in their own summary objects — a real doc/code drift caught only by reading the runner source, not the README. **Lesson for building agent-browser docs/config:** keep README config claims mechanically verified against the actual CLI flags, not aspirational. (`93_benchmark_analysis.md:461-467`, CAVEAT-A)

3. **Don't grade your own agent with the same model family it runs on.** The one part of Aside's benchmark suite where the grader vendor matches the agent vendor (the unpublished Mind2Web runner, claimed `gpt-5.4` judging `gpt-5.5`/openai-codex output) is exactly the suite whose grading is least trustworthy and whose source isn't even available to audit. Cross-vendor grading (Gemini judging GPT) is the stronger, verified pattern used elsewhere in the same repo. (`93_benchmark_analysis.md:170-181`, `94_competitor_context.md:308-320`)

4. **Don't chase pixel/vision-first architecture for a *browser* agent.** Full computer-use/pixel agents (OpenAI CUA/Operator, Anthropic Computer Use) score dramatically worse on structured web tasks (Operator 61.3% human-eval on Online-Mind2Web) than DOM/a11y-tree agents (~90% independent), even though vision-specialized training (Fara-1.5-27B, 72%) narrows but doesn't close the gap. Vision should be a fallback for canvas/image-only content, never the primary perception channel, per D2Snap's own finding that "image input demonstrates little value for backend LLMs." (`94_competitor_context.md:68-133`, §A.6-A.7)

5. **Don't build N granular tools (click(x,y), type(selector,text), scroll(dir), ...) as the primary action interface.** Both Aside's design and Browser Use's own benchmark-winning run independently converged away from enumerated click/type tool schemas and toward a code-writing surface. An indexed-element tool schema (Browser Use's shipped `bu-2-0` product design: `click(index=34)`) is the intermediate, weaker option — it's a step up from pixels but a step down from full code-execution. (`94_competitor_context.md:46-67,101-111`)

6. **Don't silently truncate or slice a large observation.** Aside's snapshot builder explicitly returns a re-scope error on overflow rather than truncating — silent truncation would hide critical page state from the model without it knowing information was dropped. The system prompt explicitly warns never to `.slice()`/`.substring()` the tree. (`10_overview.md:64`)

7. **Don't assume a lightly-obfuscated eval dataset ("`.enc`-base64'd to prevent AI from training the data") is a real integrity control** — Aside's own benchmark repo does this and the teardown correctly flags it as mild obfuscation, not real protection, and a barrier to independent verification. If you publish eval data for your own harness, don't rely on this as a substitute for genuine access control or for enabling reproducibility. (`93_benchmark_analysis.md:504-513`, CAVEAT-E)
