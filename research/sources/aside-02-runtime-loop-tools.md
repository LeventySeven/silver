# Aside — Runtime Loop + Tool Registry: Digest for agent-browser

**Source:** Aside browsing agent (Chromium-fork browser + local native daemon "AsideDaemon").
Files read in full:
- `researchfms/teardowns/_aside_parts/20_runtime_loop.md` (747 lines)
- `researchfms/teardowns/_aside_parts/96_tool_registry_full.md` (465 lines, current-binary re-verification)
- `researchfms/teardowns/_aside_parts/30_tools.md` (561 lines, original 19-tool catalog)

All citations below are `file:section` or `file:offset` as given in the source teardowns (themselves KNOWN, read from the daemon's bundled JS / binary strings).

---

## Killer Insight

**The entire browser-automation surface is ONE tool: `repl`.** There is no `navigate`/`click`/`type`/`scroll`/`fill`/`screenshot` tool — the daemon exposes a persistent JS sandbox with Playwright's `page` object injected as a global, and the model writes literal JavaScript (`await page.locator('e3').click()`) as the `code` argument of a single `repl` tool call (`30_tools.md:182-219`). Every other tool in the registry (webfetch, websearch, memory_search, subagent, etc.) is a *thin, single-purpose, narrowly-schema'd* function — the opposite design axis from `repl`. This N-discrete-tools-plus-one-open-code-tool split, combined with an accessibility-tree ref-ID scheme (`e12`, `f1e1`) that is explicitly *not* a DOM property and is invalidated on every snapshot, is the single most important transferable architecture decision for an agent-browser CLI: **give the agent a code-execution channel for the browser, not a wall of granular action tools**, and pair it with an ephemeral, LLM-legible reference scheme instead of raw CSS/XPath selectors.

---

## Patterns

### 1. `repl`: single code-execution tool replaces the entire action surface — CORE
**What:** One tool, `repl(title, code)`, `executionMode:'sequential'`, runs arbitrary ES2023+ JS in a persistent sandboxed VM with a curated global surface (`page`, `tabs`, `openTab`, `snapshot`, `annotatedScreenshot`, `display`, `fs`, `sleep`, `fetch`). No `import`/`require`. 120s timeout. State (`const`/`let`) persists across calls in the same session.
**Why:** Collapses ~15 candidate action-tools (navigate/click/type/scroll/select/hover/drag/wait/find/extract/…) into one flexible surface. The model can compose multi-step logic (loops, conditionals, error handling) in a single tool call instead of round-tripping the model for every atomic action — this is a massive latency/cost win for an agent loop, and it's the difference between "the agent drives a remote control" and "the agent programs the browser."
**How to implement:** Expose a Node/Python sandboxed eval context to the agent as one tool. Inject a live Playwright (or CDP) `page` handle plus helper functions (`snapshot`, `openTab`, `attachTab`, `display`). Cap wall-clock execution (e.g. 60-120s). Persist the VM/interpreter state across tool calls within one session (don't spin a fresh interpreter per call) so variables declared in call N are visible in call N+1. Forbid dynamic module loading to keep the sandbox bounded. Return `console.log`/`display()` output as the tool result content (NOT return-value — the doc explicitly says `return` does not propagate, only console.log/last side-effect capture does).
**Evidence:** `30_tools.md:14-35` (Verdict A), `30_tools.md:182-219` (full `repl` description, verbatim system prompt).
**Tier:** core.

### 2. Ephemeral virtual ref-ID element scheme (`e12`, `f1e1`) — CORE
**What:** `snapshot(page)` walks the accessibility tree and mints short virtual IDs per interactive node: `e<N>` for the main document, `f<frameIndex>e<N>` for nodes inside iframes. These are **not** DOM properties — never usable in CSS selectors — but ARE directly usable as `page.locator('e31')` strings. Every new `snapshot()` call invalidates all previously-issued ref IDs.
**Why:** Solves the two hardest problems in DOM-grounded agent action: (a) giving the LLM short, stable, guessable-proof tokens to refer to elements instead of asking it to write brittle CSS/XPath, and (b) forcing staleness-safety — since refs die on every snapshot, the agent can never act on a stale reference from 5 turns ago without re-observing the page first.
**How to implement:** Build an accessibility-tree walker that assigns short incrementing IDs to interactive elements (buttons, links, inputs, etc.) on each "observe" call. Return a compact serialized tree (not raw DOM/HTML) alongside a `diff` against the previous snapshot to keep tokens down. Bind IDs to a locator strategy your automation layer understands directly (Playwright locator, CDP nodeId, etc.) so `act(ref)` is O(1) resolution, not a search. Explicitly instruct the model refs expire on next snapshot — bake this into the tool description, not just docs.
**Evidence:** `30_tools.md:22-36` (system-prompt quote on ref IDs), `30_tools.md:208-216` (`snapshot`, `annotatedScreenshot` in `repl` docs).
**Tier:** core.

### 3. `annotatedScreenshot` — visual ref-ID overlay for disambiguation — IMPORTANT
**What:** A helper (`annotatedScreenshot(page) => {base64Image}`) renders the same ref IDs as bounding-box labels burned into a screenshot image, letting the model cross-check the accessibility-tree snapshot against a visual render.
**Why:** Accessibility trees can misjudge visibility, z-order, or overlapping elements (modals, sticky headers). A visual fallback with the *same* ID namespace as the text snapshot lets the agent disambiguate without a second incompatible addressing scheme.
**How:** Implement as a second "observe" primitive that draws numbered boxes at the same coordinates used to build the ref-based locator, using the identical ID space as the tree/diff snapshot. Keep it cheap — call on-demand, not every turn.
**Evidence:** `30_tools.md:212, 217`.
**Tier:** important.

### 4. Local daemon owns the loop; the "client" is just a console — CORE (architecture)
**What:** Neither the cloud API nor the browser extension/UI runs the ReAct loop. A local native daemon process (`AsideDaemon`, `http://127.0.0.1:21420`) owns context assembly, model calls, tool dispatch, compaction, and retries. The extension/UI is purely a thin client that (a) renders the chat stream, (b) executes browser-only actions the daemon can't reach directly (Chrome APIs via a bridge), and (c) does session CRUD over tRPC.
**Why:** For a CLI-based agent-browser skill, this validates the "local orchestrator process + thin driven surface" split: the agent brain (loop/model calls/tool dispatch) should live in one durable, resumable local process, decoupled from any UI. This is exactly the shape a CLI needs — a persistent daemon-like session the CLI attaches/reattaches to, rather than a stateless one-shot script.
**How to implement:** For a CLI tool, this maps to: run the agent loop as a background process (or a long-lived CLI session) that owns model calls + tool orchestration; keep the browser driver (Playwright/CDP) as a separate concern the loop calls into, not baked into the "UI". Persist run state (event log, cursor) so a disconnected terminal can reattach.
**Evidence:** `20_runtime_loop.md:26-100` (architecture diagram + trace).
**Tier:** core (architectural framing, not code-literal for a CLI).

### 5. Resumable event stream: `runId` + monotonic `seq`, replay by `afterSeq` — CORE
**What:** Every agent event carries `{runId, seq}`. Client enforces `seq === lastSeq+1`, drops out-of-order/duplicate/foreign-run events, tracks last-seq per run capped at 8 runs (LRU evict). On reconnect, the client requests replay via `{runId, afterSeq}` and the daemon re-streams everything missed. This yields exactly-once, gap-free delivery across a dropped socket or dead process.
**Why:** Long browser tasks (minutes) will outlive terminal disconnects, SSH drops, laptop sleep. A CLI-driven agent needs the same durable resume primitive: never lose or duplicate a tool result because the terminal closed mid-task.
**How to implement:** Give every agent turn a `runId`; number every emitted event with an incrementing `seq` starting at the resume point. Persist the event log server/daemon-side (even just append-only JSONL per run). On CLI reattach, pass the last-seen `seq` and replay from there. Reject/drop events for a stale or superseded `runId`.
**Evidence:** `20_runtime_loop.md:188-224` (§2a-2c), constants table `20_runtime_loop.md:608-643`.
**Tier:** core.

### 6. Exponential backoff reconnect: `min(1000 * 2^(n-1), 16000)`, 5 attempts — IMPORTANT
**What:** Exact reconnect backoff schedule: 1000, 2000, 4000, 8000, 16000 ms, capped at `W3=5` attempts before failing hard.
**Why:** A concrete, copy-pasteable backoff constant set for reconnect logic against a flaky local daemon/browser-driver connection (e.g., CDP websocket drops).
**How:** `delay(attempt) = min(1000 * 2**(attempt-1), 16000)`; hard-fail after 5 attempts, surfacing a clear terminal error rather than hanging.
**Evidence:** `20_runtime_loop.md:209-224`, constants `20_runtime_loop.md:628-631`.
**Tier:** important.

### 7. Command envelope discriminated union: prompt / continue / steer / queue / interrupt — CORE
**What:** All mid-run control is expressed as one of five command types over the same channel: `prompt` (new turn, rejected if a run is already streaming), `continue` (resume with no new input), `steer` (inject into the live run, optional `interrupt:true` to preempt the in-flight model call vs. apply at next boundary), `queue` (buffer a message to run after the current run completes), `interrupt` (abort the run, mute further events from it).
**Why:** This is a clean, minimal vocabulary for all the ways a human/CLI operator wants to intervene in a running agent — and it distinguishes "cut in now" (steer+interrupt) from "add to my to-do list for the agent" (queue) from "stop everything" (interrupt). Most single-shot CLI agent harnesses only have "cancel"; this gives a much richer, still-simple control surface for interactive use.
**How to implement:** Model the agent loop as accepting a small discriminated command union even in a CLI. `steer(msg, interrupt=false)`: if interrupt, abort the current model call and splice the message in; else append to context and let the model finish its current step first. `queue(msg)`: append to a buffer drained only once `agent_end` fires. `interrupt()`: mark session `interrupted`, preserve any queued messages so the user can resume later.
**Evidence:** `20_runtime_loop.md:260-273` (schema), `20_runtime_loop.md:341-389` (§4, full semantics + composer wiring).
**Tier:** core.

### 8. Assistant delta assembler: typed streaming events, not raw text chunks — IMPORTANT
**What:** Assistant output streams as typed deltas (`text_start/delta/end`, `thinking_start/delta/end` with signature, `toolcall_start/delta/end` with incremental JSON parsed by a tolerant partial-JSON parser at `toolcall_end`), folded by a stateful assembler (`t3.apply(delta)`) into one working message object. Non-text/thinking/toolcall content (full messages, e.g. tool results) is upserted wholesale rather than deltas.
**Why:** Gives a concrete, implementable event grammar for streaming an agent's output to a terminal UI that needs partial rendering (live "thinking…" + partial tool-call JSON display) without re-parsing full JSON each token.
**How:** Define delta types keyed by `contentIndex` (position in the message's content-block array): `*_start` inserts an empty typed block, `*_delta` appends to it, `*_end` finalizes/parses it. Use a tolerant partial-JSON parser to show in-progress tool-call arguments before the call is complete (useful for a CLI spinner/preview of "about to call webfetch(url=...)").
**Evidence:** `20_runtime_loop.md:307-330` (§3e).
**Tier:** nice-to-have for a CLI (matters more for a rich TUI than a plain terminal), but the *parsing pattern* (tolerant partial-JSON for streaming tool args) is broadly useful.

### 9. 80ms batched publish for assistant text, immediate for everything else — NICE
**What:** Streamed assistant text/thinking deltas are coalesced and re-rendered at most every 80ms (~12.5fps); lifecycle events, tool results, and non-assistant messages render immediately.
**Why:** Concrete UI throttling constant — avoids re-rendering a terminal on every single token while keeping structurally important events (tool call started/finished) instant.
**How:** Debounce text-delta rendering at ~80ms; never debounce control-plane events (tool_start/tool_end/error).
**Evidence:** `20_runtime_loop.md:332-337`, constant table `20_runtime_loop.md:632`.
**Tier:** nice.

### 10. Session-level `permissionMode` + `runtimeConfig` gate tool availability and behavior — CORE
**What:** A `permissionMode` enum (`read-only`, `guard`, `full-access` — seen in the `routine_update` schema, `30_tools.md:470`) plus a `runtimeConfig` object (`memoryExtractionDisabled`, `proactiveMode`, `strictModelSelection`, `finalConfirm`, `takeScreenshotOnEverySnapshot`, `workingDirs[]`) gate which tools are even registered for a session, not just whether calls are approved. E.g. read-only sessions drop `write_file`/`edit_file`/`create_custom_skill`/`request_action_confirmation`; incognito sessions drop `browsing_history_search`/`memory_search`/`create_custom_skill`; subagents drop the 5 coordination tools unless `fork_self`.
**Why:** This is a much stronger safety model than a runtime "ask before every write" check: the tool doesn't exist in the schema sent to the model at all for a restricted session, so the model can't even attempt to call it (no wasted turn, no possible bypass via clever prompting of an existing tool).
**How to implement:** Build tool-registry assembly as a *function of session flags*, not a static list with per-call permission checks. `buildToolset(session) -> Tool[]`: start with a base set (repl/code-exec, read_file, bash, webfetch, websearch, get_time), then conditionally push write tools (unless read-only), history/memory tools (unless incognito/private), and orchestration tools (unless a restricted sub-session). For a CLI, expose `--read-only`, `--incognito`, `--profile <name>` flags that map directly to this gating function.
**Evidence:** `96_tool_registry_full.md:20-70` (verbatim `yon` assembly function + gating table), `30_tools.md:44-121` (equivalent older-binary version, `Snn`, with full availability matrix).
**Tier:** core.

### 11. `finalConfirm` → `request_action_confirmation` tool, added only when the flag is on — CORE
**What:** A dedicated tool that pauses the whole session (`e.suspend('action-confirmation', ...)`) and requires the model to submit either a structured "draft artifact" (gmail-draft, linkedin-message-draft, slack-message-draft, calendar-event-draft, x-tweet-draft, linkedin-post-draft, skill-draft) or a screenshot fallback, before performing any "externally visible, destructive, paid, or hard-to-reverse" action. Returns either "confirmed, proceed" or the user's alternate instruction.
**Why:** Concrete design for human-in-the-loop gating on consequential browser actions (submitting a form that sends money/email/a public post) — the model must literally construct and show what it's about to do, not just get a yes/no.
**How to implement:** Add an optional tool, present only when a `--confirm-destructive` (or similar) flag is set, whose schema forces the model to pass a `{title, message, artifact:{type, data|screenshot}}` and whose execute() blocks (suspends the loop) on a real human y/n (or edit-instruction) response in the terminal. Return the human's free-text redirect instruction back to the model on rejection, not just a boolean.
**Evidence:** `96_tool_registry_full.md:386-410`, `30_tools.md:521-543`.
**Tier:** core (for any agent-browser CLI meant to touch real accounts/money/public posts) — otherwise nice-to-have.

### 12. `ask_user_question` — structured mid-run human input, session suspend — CORE
**What:** A dedicated tool distinct from free-text: `questions[]`, each with `question`, `header` (≤30 chars), `options[{label, description}]`, `multiple?`, `custom?` (default true, allows free-text override). Execute calls `e.suspend('ask-user-question', ...)`, blocking the whole run until answered.
**Why:** Gives the model a structured way to ask clarifying questions with a bounded option set (good UX, easy to render as a CLI select-prompt) while still allowing free-text escape hatch. This is a much better contract than "the model just writes a question in its final text output and the harness has to guess it's asking something."
**How:** Implement as a first-class tool whose execute blocks on stdin (or an interactive prompt library) presenting the options; support multi-select and a custom/free-text option by default.
**Evidence:** `96_tool_registry_full.md:362-366`, `30_tools.md:423-443`.
**Tier:** core.

### 13. `webfetch` fully local pipeline — raw https.request + local Readability + Turndown, Chromium fallback only for Cloudflare — CORE
**What:** `webfetch(url, timeout≤120s default 30s, include_images=false, useCookies=false)` does: hand-rolled `https.request`/`http.request` (5 redirect follow, 64KB max header) with a desktop Chrome-143-Windows UA string; reddit.com rewritten to old.reddit.com for parseable HTML; 5MB hard response cap (both content-length pre-check and streamed enforcement); non-HTML/attachment responses downloaded to disk instead of extracted; HTML responses run through a bundled Readability-style extractor + Turndown markdown converter, with an automatic re-run scoped to `<body>` if the first pass extracts <150 words but the page clearly has much more text; only falls back to the local Chromium browser (open tab, poll up to 5x 1s apart) when Cloudflare-challenge heuristics fire. NO third-party read/extract service (no Exa, no Jina, no r.jina.ai).
**Why:** This is a complete, reimplementable "fetch → markdown" tool spec that avoids depending on paid third-party extraction APIs, which matters a lot for a self-hostable CLI skill. The Cloudflare-detection-then-browser-fallback pattern is the right layered design: cheap raw HTTP first, expensive real-browser render only when actually blocked.
**How to implement:**
- Constants: `MAX_RESPONSE=5*1024*1024`, `DEFAULT_TIMEOUT=30s`, `MAX_TIMEOUT=120s`, only `text/html`/`text/plain` get markdown/text treatment (everything else → save-to-disk).
- Header set: a real desktop Chrome UA + standard Accept/Accept-Language headers (avoids trivial bot-detection).
- Follow ≤5 redirects manually via raw `http(s).request`, not a high-level fetch wrapper, to keep max-header-size and redirect-count under your own control.
- Cloudflare detector: scan first 200KB (lowercased) for `cf-mitigated: challenge` header, `cf_chl_`, `cf-browser-verification`, "checking if the site connection is secure", or `<title>just a moment` + "cloudflare" in body.
- Extraction: bundle Mozilla Readability (or similar) + Turndown; if word count is too low relative to raw body text, retry extraction scoped to `<body>`.
- Mint a `source_id` per fetch and prepend a citation tag to the returned text so the model can cite it later (see pattern 15).
- Optional `useCookies` flag threading real browser-session cookies into the fetch for logged-in-page access.
**Evidence:** `96_tool_registry_full.md:74-192` (§2, full pipeline, verbatim carved code).
**Tier:** core.

### 14. `websearch` as a thin server-side RPC, NOT the extraction path — CORE
**What:** `websearch(objective, search_queries[exactly 3, 3-6 words each, diverse angles], mode='basic'|'advanced')` posts to a single backend endpoint (`POST https://api.asidehq.com/search`) with `{objective, search_queries, mode, max_chars_total:25000, session_id, client_model}`, 10s timeout, 2 linear retries on null/408/429/5xx. Response is `{session_id, results:[{source_id, url, title, publish_date, excerpts[]}]}`. Excerpts are pre-extracted markdown snippets, not raw HTML — the backend already ran extraction.
**Why:** Cleanly separates "search" (needs a real search index/API you probably can't self-host — Brave/Bing/SerpAPI/Exa) from "fetch+extract" (which Aside keeps fully local, pattern 13). Confirms the exact request shape to mirror for a self-built or third-party-backed search tool, including forwarding `client_model` so the search backend could in theory tune result compression to the calling model.
**How to implement:** Design a `websearch` tool with objective + a small fixed number of diverse keyword queries (not full sentences, no `site:` operators enforced in schema description) + a basic/advanced mode toggle for latency vs. quality. Behind it, plug in whatever search API you have (Brave Search API, Exa, SerpAPI, Bing) — return `{source_id, url, title, publishDate, excerpt}` per result and mint IDs consistent with the fetch tool's citation IDs (pattern 15).
**Evidence:** `96_tool_registry_full.md:195-258` (full backend trace + response parser), `30_tools.md:295-311` (schema).
**Tier:** core (shape/schema) — actual search provider is a build choice, not a pattern to copy.

### 15. Unified citation contract across webfetch + websearch — CORE
**What:** Every result from webfetch/websearch mints a random `source_id`. Webfetch prepends `<webfetch-citation source_id="…"/>` to its returned text; websearch tags each result object with `source_id`. The system prompt then instructs: `<citation refs="source_id#1">quoted supporting text</citation>` immediately after any factual claim sourced from web content, never inside code fences/inline code/markdown links, with `<quote>` sub-tags for multi-source citations. `details.sources` (id/url/title/excerpt/faviconUrl) is threaded separately from the model-visible text so a UI/CLI can render clickable source chips without polluting the model's context with that metadata twice.
**Why:** A concrete, low-overhead grounding/citation mechanism: cheap unique IDs threaded through tool results let the agent (and downstream verification/audit tooling) know exactly which fetched/searched source backs a claim, without needing full URLs repeated inline in every citation.
**How to implement:** Have every information-retrieval tool (webfetch, websearch, and any future "read_file"/"repl output" source) mint a short random ID per distinct source and return it embedded in the tool result text. Instruct the model via system prompt to wrap cited claims in a citation tag referencing that ID. Keep a parallel `sources[]` array (id→url/title/excerpt) out of the model's visible text but available to your CLI's output renderer for a "Sources" footer.
**Evidence:** `96_tool_registry_full.md:262-278` (§4, verbatim prompt fragment + mechanics).
**Tier:** core.

### 16. Tool registry assembled as a pure function of session state, not static config — CORE
**What:** `yon(session, tools) -> Tool[]` (and its older-binary twin `Snn`) is a single function, called once per session, that pushes tools onto an array conditioned on `isSubagent`, `incognito`, `readOnly`, `fork_self`, and `runtimeConfig.finalConfirm`. Gate helpers (`A6(session)` for read-only, `c4t(session)` for fork_self exemption) are small, separately named predicates, not scattered inline conditionals.
**Why:** Directly reusable design for any CLI agent: keep tool-list construction as one auditable function with named boolean gates, so it's trivial to reason about "what tools does THIS invocation get" and to add a new restricted mode later without touching every call site.
**How:** `def build_tools(session_flags) -> list[Tool]: tools = [core_tools...]; if not session_flags.read_only: tools += [write_file, edit_file]; if not session_flags.incognito: tools += [history_search, memory_search]; if not session_flags.is_subagent or session_flags.fork_self: tools += [subagent, ask_user, confirm_action, ...]; return tools`.
**Evidence:** `96_tool_registry_full.md:16-70`, `30_tools.md:39-121`.
**Tier:** core.

### 17. `memory_search` — local vector index (native addon), not a cloud call — IMPORTANT
**What:** A semantic-recall tool over a markdown `memory/` directory, backed by a local native addon (`moss-core.node`) + a local MiniLM embedding model (`moss-minilm`), with an on-disk `memory-index.json` per agent dir. Schema: `queries[]` (OR-ed, 1-3, natural language), `max_results` (1-10, default 5). Description explicitly frames it as a "mandatory recall step" before answering questions about prior work/decisions/preferences. Results are `{path, line, excerpt}` triples the model can then `read_file` for full context. There is a dormant cloud-query code path (`MOSS_INDEX_URL`) but it's unused by default — local wins.
**Why:** Demonstrates that "agent memory" doesn't need a hosted vector DB — a small local embedding model + native/WASM vector index over markdown files is enough, and it keeps memory fully private/local (excluded in incognito sessions entirely, by design).
**How to implement:** Use a small local sentence-embedding model (MiniLM-class, runnable via ONNX/sentence-transformers or a native binding) over a directory of markdown "memory" files. Chunk at line granularity, embed chunks, store an index file on disk. Tool returns `path#Lline` + excerpt so the model can `read_file` to get full context rather than dumping full content inline. OR multiple queries together and dedup results by chunk id.
**Evidence:** `96_tool_registry_full.md:333-350`, `30_tools.md:374-387`.
**Tier:** important.

### 18. Subagent-as-child-session, not a special call type — CORE (multi-agent)
**What:** `subagent(action='spawn'|'resume', description, subagent_profile, model_category='inherit'|'fast'|'standard'|'deep'|'visual', prompt, run_in_background, task_id)` and `subagent_wait(task_ids[])` are the *entire* multi-agent surface. Spawning a subagent = creating a full child session (its own `runId` event stream) via the exact same daemon session machinery used for top-level sessions. The parent's `toolState.subagent.subagents: [{sessionId, description, isRunning}]` is the join between parent and children, streamed live into the UI. Concurrency is capped per parent. Subagents lose the 5 coordination tools (subagent/subagent_wait/ask_user_question/routine_update/notification) and skill/confirm tools UNLESS they're a `fork_self` profile — a deliberate anti-recursion-explosion + anti-distraction gate. `subagent_wait` explicitly warns "do not call subagent resume just to read completed results" — i.e. join semantics are a distinct primitive from resume/continue semantics.
**Why:** Cleanest multi-agent design in the whole corpus: "spawn a subagent" is not a bespoke orchestration mechanism, it's just "create another session of the same kind, restricted tool-wise, and track its id." Memory extraction and "dreaming" (pattern 19) reuse this exact primitive rather than being special-cased.
**How to implement:** Implement `spawn_subagent` as literally recursing into your own session-creation function with a restricted tool list and a `parent_session_id` pointer, then register `{child_id, description, running:true}` in the parent's state. `subagent_wait(ids)` blocks on the children's completion events and returns their final text results. Restrict spawned sessions' tool registry via the same gating function as pattern 16 (`is_subagent=True` strips coordination tools).
**Evidence:** `20_runtime_loop.md:708-747` (§12), `96_tool_registry_full.md:352-360`, `30_tools.md:391-419`.
**Tier:** core (if the CLI supports sub-tasking/parallel research at all) — otherwise skip for v1.

### 19. Two-phase memory: per-session extraction + gated batch "dreaming" consolidation — NICE
**What:** After each session (unless `runtimeExtractionDisabled`), a subagent is spawned with the literal first message `"You are now acting as the memory extraction subagent."` to read the transcript and write/update memory markdown files, replying `DONE`/`NONE`. Separately, a periodic "dreaming" pass — literal trigger `"Run a dreaming pass over the current memory store."` — re-organizes/consolidates the memory store semantically, but only fires after N sessions have accrued since the last dream (`getDreamState` returns `{lastDreamAt, sessionsSinceLastDream}`). Every memory mutation is a content-addressed (`beforeSha256`/`afterSha256`), revertable, cost-accounted history entry.
**Why:** A concrete two-tier memory design: cheap-and-frequent (per-session capture) vs expensive-and-rare (batched semantic reorg), gated by an accrual counter rather than a timer — avoids re-consolidating on every session while still keeping memory from becoming an ever-growing unstructured pile.
**How:** For a CLI agent with persistent memory, run a lightweight post-session "extract facts worth remembering into memory/*.md" step (itself just an LLM call, not a special mechanism — reuses pattern 18's subagent primitive), and a separate, rarer "reorganize/merge memory files" pass triggered by a session counter, not a cron schedule. Track before/after content hashes for auditability/revert.
**Evidence:** `20_runtime_loop.md:562-605` (§8).
**Tier:** nice (valuable but a v2 feature, not core for an MVP CLI).

### 20. `write_todos` — first-class plan/task-progress tool with explicit merge semantics — IMPORTANT
**What:** `write_todos(todos:[{id, content(≤200 chars), status: pending|in_progress|completed|cancelled}], merge=true)`. When `merge=true`, updates merge into existing todos by `id`; when `false`, the incoming list replaces all existing todos entirely. Purely in-memory session state (`toolState.todo`), no backend — rendered live as a "Task progress" checklist in the UI while the session is active.
**Why:** A minimal, copy-pasteable plan/progress-tracking tool schema (same family as Claude Code's TodoWrite) that gives the agent an explicit, inspectable working plan without any persistence complexity — and the `merge` boolean is a nice small detail (lets the agent either patch one item's status or replace the whole plan in one call).
**How:** Implement as pure in-memory state on the session object; no I/O. Render it to the CLI terminal (e.g., a checklist block) whenever it changes, so a human watching the terminal can track progress on long multi-step browser tasks.
**Evidence:** `96_tool_registry_full.md:286-298`, `30_tools.md:223-241`.
**Tier:** important.

### 21. `open_tool_result` — paged retrieval of compacted tool output, sub-agent verifier only — NICE
**What:** Not in the main tool registry — added only to a specialized verifier/compaction tool set paired with `webfetch`: `open_tool_result(toolCallId, offset=0, limit=12000, max=30000)` lets a reviewer/subagent page into the FULL (pre-compaction) text of a tool result the main trajectory only shows truncated/summarized, by referencing a short numeric id from the compacted transcript.
**Why:** Solves the "context got compacted and now the details are gone but the sub-verifier needs them" problem cleanly — rather than re-fetching a URL, page into the same evidence store the compaction step already retained (`evidenceById`).
**How:** When you implement context compaction/summarization for long tool outputs (especially `webfetch` results), keep the full uncompacted text addressable by a short numeric id in a side store, and give any downstream verifier/subagent a paging tool over that store instead of forcing it to re-fetch.
**Evidence:** `96_tool_registry_full.md:412-414`, `30_tools.md:547-560`.
**Tier:** nice (v2 — only matters once you have compaction + a verifier subagent).

---

## Command Surface (verbatim / near-verbatim)

### Tool: `repl`
```
name: repl
executionMode: sequential
parameters: { title: string, code: string }
description (verbatim excerpt):
  "Executes JavaScript in a persistent sandboxed REPL context to interact with the browser.
   Environment: ES2023+ JavaScript; Playwright API available; 120 second timeout;
   no default modules; no external modules (import/require forbidden);
   all tool calls share a single persistent scope.
   Available functions (ONLY these):
   - console.log(x) — read contents back to yourself (return does NOT work)
   - display(input: string | Uint8Array | Buffer)
   - page — Playwright page of the last opened tab
   - tabs — list of current opened tabs (Page[])
   - listBrowserTabs() => Promise<OpenBrowserTab[]>
   - attachBrowserTab(targetId) => Promise<Page>
   - attachActiveBrowserTab() => Promise<Page>
   - getTabByTargetId(targetId) => Page | undefined
   - openTab(url) => Promise<Page>
   - closeTab(tab) => Promise<void>
   - snapshot(page, options?) => Promise<{ tree, diff }>  — PRIMARY METHOD of reading a webpage
   - page.screenshot(options?) => Promise<Buffer>
   - locator.screenshot(options?) => Promise<Buffer>
   - page.pdf(options?) => Promise<Buffer>
   - annotatedScreenshot(page) => Promise<{ base64Image }>
   - fs, pwd, path, Buffer, sleep(ms), fetch(url) (with user's cookies)
   Rules: never use unavailable globals; always console.log to return data;
   the REPL starts neutral; call listBrowserTabs()/attachActiveBrowserTab() before
   snapshot(page,{interactive:true}); only openTab() when no relevant tab exists.
   Example: await page.locator('e3').click(); const s1 = await snapshot(page); console.log(s1.diff);"
```
Ref-ID contract (verbatim): *"Snapshot returns a compact accessibility tree with unique ref IDs such as `e12` or `f1e1`. Ref IDs are virtual locator IDs, not actual DOM properties. Safe to pass them directly to `page.locator('e31')`. NEVER treat ref IDs as DOM properties or mix them into CSS selectors. Each new snapshot invalidates all earlier ref IDs."*

### Tool: `write_todos`
```
parameters: {
  todos: [{ id: string, content: string(maxLength:200), status: enum[pending,in_progress,completed,cancelled] }] (minItems:1),
  merge: boolean (default true)
}
description: "Manage and plan current tasks using a structured todo list.
Use for complex or multi-step work.
When merge=true, updates merge by id.
When merge=false, incoming todos replace all existing todos."
```

### Tool: `webfetch`
```
parameters: { url: string, timeout?: number (default 30, max 120), include_images?: boolean (default false), useCookies?: boolean }
description: "Fetch content from a URL and return it as markdown. Use this tool when you need to
inspect search results or read-heavy web URL."
constants: MAX_RESPONSE_BYTES=5*1024*1024; DEFAULT_TIMEOUT_S=30; MAX_TIMEOUT_S=120;
  MARKDOWN_MIME_SET={text/html, text/plain}; MAX_REDIRECTS=5; MAX_HEADER_SIZE=64*1024
UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
result: {content:[{type:'text', text:'<webfetch-citation source_id="…"/>\n<markdown>'}],
         details:{sources:[{id,url,title,excerpt}], title, faviconUrl}}
```

### Tool: `websearch`
```
parameters: {
  objective: string,
  search_queries: string[] (exactly 3, 3-6 words each, diverse),
  mode?: enum[basic, advanced] (default basic)
}
description: "Searches the web for current and factual information, returning relevant results
with titles, URLs, and content snippets."
backend: POST https://api.asidehq.com/search
  body: { objective, search_queries, mode, max_chars_total:25000, session_id, client_model }
  timeout: 10s, retries: 2 linear (delay 1000ms) on null/408/429/5xx
response: { session_id, results:[{source_id, url, title, publish_date, excerpts:[...]}] }
```

### Tool: `get_time`
```
parameters: {}
description: "Get the user's current date, time, and timezone."
execute: new Date().toLocaleString('en-US', {dateStyle:'full', timeStyle:'long'})
```

### Tool: `ask_user_question`
```
executionMode: sequential
parameters: {
  questions: [{
    question: string,
    header: string(maxLength:30),
    options: [{label:string, description:string}],
    multiple?: boolean,
    custom?: boolean (default true)
  }] (minItems:1)
}
description: "Ask the user a question with predefined options. The session will pause until the
user responds. Use when you need clarification, confirmation, or a choice from the user."
```

### Tool: `request_action_confirmation` (only when runtimeConfig.finalConfirm=true, not read-only)
```
executionMode: sequential
parameters: {
  title: string,
  message: string,
  artifact: {
    type: string  // gmail-draft | linkedin-message-draft | slack-message-draft |
                   // calendar-event-draft | x-tweet-draft | linkedin-post-draft |
                   // skill-draft | screenshot
    data?: object,
    path?: string,   // screenshot fallback
    alt?: string,
    caption?: string
  }
}
description: "Ask the user to review and confirm an externally visible, destructive, paid, or
hard-to-reverse web action before doing it. The session pauses until the user confirms or cancels.
You MUST include a structured draft artifact or a screenshot fallback artifact."
```

### Tool: `subagent` / `subagent_wait`
```
subagent params: {
  action: enum[spawn, resume],
  description?: string (spawn only, 3-5 words),
  subagent_profile?: string (spawn only; default/context_explorer/code_explorer/fork_self/custom),
  model_category?: enum[inherit, fast, standard, deep, visual] (spawn only),
  prompt?: string,
  run_in_background?: boolean (spawn only),
  task_id?: string (resume only)
}
subagent_wait params: { task_ids: string[] }
description (subagent_wait): "Wait for subagents to reach a final status and return their final
results. Do not call subagent resume just to read completed results."
```

### Tool: `memory_search`
```
parameters: {
  queries: string[] (minItems:1, maxItems:3, minLength:1 each, OR-ed together),
  max_results?: integer (1-10, default 5)
}
description: "Mandatory recall step: semantically search everything under `memory/` before
answering questions about prior work, decisions, dates, people, preferences, websites, or todos.
Multiple queries are OR-ed together. Returns top snippets with absolute file paths and starting
line. Use `read_file` to fetch the full file body when a snippet is promising."
backend: local moss-core.node native addon + moss-minilm embedding model, memory-index.json on disk
```

### WS command/event protocol constants (for a resumable session channel)
```
protocolVersion: 1
command types: prompt | continue | steer | queue | interrupt
max messages per command: 32
max command payload: 256,000 chars
max tracked runs (dedup LRU): 8
max reconnect attempts: 5
reconnect delay: min(1000 * 2^(attempt-1), 16000) ms  → 1000,2000,4000,8000,16000
streaming publish debounce: 80ms (assistant text/thinking only; control events immediate)
```

### Daemon auth handshake (for a local-daemon-style CLI architecture)
```
1. GET /auth/daemon/challenge?clientKind=<id>          -> {challenge, challengeId}
2. sign(utf8("Aside Daemon Auth v1\0") + b64decode(challenge)) via a private signer
3. POST /auth/daemon/session {challengeId, signedChallenge} -> {access_token, expiresInSeconds}
4. Authorization: AsideDaemonSessionToken <token>  on every subsequent request
   WS subprotocol: "aside.daemon.auth.<token>"
   token TTL: 12h, refresh margin: 10s before expiry
```

---

## Anti-patterns (what NOT to copy)

1. **Do not build N granular DOM-action tools (navigate/click/type/scroll/…) as separate schemas.** Aside deliberately rejected this — a wall of narrow action tools burns context on schemas, forces a model round-trip per atomic action, and can't express control flow (loops, conditionals, retries) without extra turns. Use one code-execution tool instead (pattern 1). If you DO want discrete action tools for a simpler/cheaper model, keep them to an absolute minimum and still offer a code-exec escape hatch.

2. **Do not use raw CSS/XPath selectors as the model-facing addressing scheme.** Selectors are verbose, brittle across re-renders, and easy for the model to hallucinate against text it can't see. Ephemeral numeric/short ref IDs bound to a fresh accessibility-tree snapshot (pattern 2) are shorter, harder to hallucinate plausibly, and force explicit re-observation before every action sequence.

3. **Do not let the model reuse stale element references across turns without re-snapshotting.** The Aside design intentionally invalidates all refs on every `snapshot()` call — copy the invalidation, not just the ID format, or you'll get "click on element that moved/disappeared" bugs.

4. **Do not proxy simple content-fetching through a paid third-party extraction API by default.** Aside's `webfetch` proves a local `https.request` + Readability + Turndown pipeline handles the vast majority of pages; only fall back to a real headless-browser render for the specific, detectable case of anti-bot challenges (Cloudflare). Defaulting to an expensive headless render (or an external SaaS like Jina/Exa reader) for every fetch is wasted cost/latency — reserve it for the fallback path only.

5. **Do not scatter tool-availability checks as inline `if` statements across many call sites.** Aside centralizes ALL registry gating (read-only/incognito/subagent/finalConfirm) into one function that assembles the tool array once per session (pattern 16). Scattered checks are how you accidentally leave a write tool reachable in a "read-only" mode.

6. **Do not conflate "ephemeral streaming status" with "persistent task status."** Aside explicitly keeps two separate status machines — client-socket status (`ready|streaming|error`, resets on reconnect) vs. persistent session status (`idle|running|suspended|interrupted`, daemon-authoritative). Collapsing these into one field is a documented source of UI/state bugs in the source system; keep them distinct if you build any kind of resumable/suspendable CLI session.

7. **Do not treat "search" and "fetch/extract" as one tool.** Aside splits them: `websearch` is a thin, provider-opaque RPC that returns already-extracted snippets; `webfetch` is a fully local, general-purpose extraction pipeline. Merging them forces you to either always pay for search-API extraction (expensive, and often lower quality than local Readability) or lose the ability to deep-read a specific URL the model already has.

8. **Do not skip a citation/source-ID contract "for later."** Retrofit is expensive; Aside mints a `source_id` at the moment of every fetch/search result and threads it through the model's visible text from day one (pattern 15). If your CLI ever needs to show "sources used" or support any grounding/verification pass, build the ID-minting into the tool result format from the start, not after the fact.

---

## Notes on source reliability / version drift (carried through from the teardown)

- `96_tool_registry_full.md` is a **re-verification pass against a newer binary** (v1.26.702.2347) than `30_tools.md`'s original extraction — factory var names differ (`Snn`→`yon`, etc.) but the *structure* (18-19 tool registry, same gating logic) is confirmed identical across both passes. Trust `96_tool_registry_full.md`'s backend claims over `30_tools.md`'s where they conflict (webfetch backend, websearch backend — see corrections list in `96_tool_registry_full.md:453-460`).
- `websearch`'s underlying search provider is explicitly **NOT determinable** from the client-side binary — earlier speculation ("Perplexity Sonar via vercel-ai-gateway") is flagged UNVERIFIED/superseded; only the wire contract (endpoint, request/response shape) is KNOWN. Do not copy the "Perplexity" claim as fact.
- The runtime-loop file marks the daemon's *cognitive* loop internals (max-steps, temperature, tool_choice policy, compaction threshold/algorithm) as INFERRED/not observable — only the *event grammar* the loop emits is KNOWN. Treat "compact when nearing context window, emit `auto_compaction_start/end`" as a design pattern to adopt, not a literal algorithm to copy verbatim.
