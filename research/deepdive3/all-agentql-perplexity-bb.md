# AgentQL + Perplexity Computer/Comet + Browserbase/Stagehand — everything transferable, keyless-local

Sources read directly (not the prior top5/deepdive digests, which are assumed as the floor —
this pass goes past `deepdive/{agentql,perplexity,browserbase}-top5dx.md`, `deepdive/agentql-query.md`,
`deepdive/perplexity-security.md`, `deepdive/browserbase-sessions.md`, and `synthesis/adopt-list-v2.md`):
`researchfms/agentql/AGENTQL_R4_2026-07-13.md`, `AGENTQL_GAP_03_ACCESSIBILITY_TREE.md` (full);
`researchfms/teardowns/PERPLEXITY_COMPUTER.md` (5067 lines, full — leaked Comet system prompt,
PerplexedBrowser attack chain, Orchestrator Implementation Deep-Dive, and the 2026-07-13 Round-2
SDK delta including the "Search as Code" article); `researchfms/browserbase/BROWSERBASE_R4_2026-07-13.md`
(full — Stagehand 3.2.1→3.6.0 delta) and `BROWSERBASE_GAP_12_STEALTH_INFRA.md`. Each item below is
checked against Silver's actual source (`/Users/seventyleven/Desktop/Silver/silver/src`) to confirm
it is a real, unclaimed gap, not something already in `adopt-list-v2.md` under a different name.

---

## 1. WebMCP bridging — a page-level CDP tool-discovery channel (NOVEL, 2026-era, keyless) — **P2, forward-looking**

Stagehand 3.6.0 added `page.listWebMCPTools()`/`page.invokeWebMCPTool()` over a new Chromium CDP domain
(`WebMCP.enable` → `WebMCP.toolsAdded`/`toolsRemoved`; `WebMCP.invokeTool` → async `WebMCP.toolResponded`,
requires Chromium ≥149, launched via `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`). This is a
brand-new web platform primitive: a page can **register agent-callable tools directly in its own DOM/JS**
(name, JSON-Schema input, an invocation handler) instead of relying on an agent to grope through the a11y
tree to find a button. It is purely mechanical — no model involved on either side of the CDP call — so it
is keyless by construction; Silver's own `session.ts` already owns the CDP connection.
- **Change:** add `silver webmcp list` (enumerate tools a cooperative page has registered) and
  `silver webmcp call <name> --input '<json>'` (invoke one), both thin wrappers over the CDP domain,
  gated behind a Chromium-version probe (fail with a clear "requires Chromium ≥149" error, not a crash)
  and behind `--enable-actions` like other mutating verbs. This is a **new perception+action channel**
  orthogonal to the a11y-tree/ref system — for the (currently small but growing) set of sites that ship
  WebMCP tool declarations, it gives Silver a zero-DOM-guessing action path no other keyless tool in this
  survey has wired up yet (Stagehand only exposes the raw CDP calls, does not auto-bridge to its own agent
  loop either — 3.6.0 explicitly ships it unbridged, §11 of the R4 delta).
- Keyless. Source: `BROWSERBASE_R4_2026-07-13.md §11` ("WebMCP (#2178) is a page-level CDP API, NOT an
  agent tool... 3.6.0 does not auto-bridge").

## 2. `tf623_id`-style in-DOM stamped IDs as an alternative/companion to Silver's `eN` refmap — **P3, evaluative note**

AgentQL's walker mutates the live DOM, writing `tf623_id="N"` onto every visited element
(`check_and_assign_tfid`, collision-safe via a `Set`), so the LLM's returned id maps straight to
`page.locator('[tf623_id="N"]')` with zero indirection. Silver's `eN` refs are an out-of-band map
(`perception/refmap.ts`) rather than a DOM mutation — this is almost certainly the *better* design
(no DOM pollution visible to page JS/CSS selectors, no risk of colliding with a site's own attribute,
survives a page's own mutation-observer-driven re-render without leaving stale garbage attributes
behind). **Recorded as a confirmed non-gap** — do not adopt DOM-stamping — but AgentQL's **iframe-path
chaining** mechanism is worth lifting on its own:
- **Change (the actually-transferable half):** AgentQL threads a dotted `iframe_path` (e.g. `"42.107"`)
  through nested iframes and resolves actions by chaining `page.frame_locator('[tf623_id="42"]')
  .frame_locator('[tf623_id="107"]')` (5-line mechanism, `AGENTQL_GAP_03 §2.7a`). Check whether Silver's
  `perception/walk.ts` already threads a frame path through nested/OOPIF iframes into the refmap for
  cross-frame action resolution, or whether iframe content is currently flattened without a resolvable
  path back to the correct frame chain — if the latter, port the dotted-path convention (cheap, and it's
  the concrete mechanism, not the AgentQL-specific attribute name, that's the reusable idea).
- Keyless. Source: `AGENTQL_GAP_03_ACCESSIBILITY_TREE.md §2.7a`.

## 3. `[selected]`/`[checked]` state badges directly in the serializer outline — **P2, small, confirms + extends C1**

Stagehand 3.6.0 (#2116) appends `[selected]`/`[checked]` flags straight onto the a11y-outline text line
for checkbox/radio/option nodes, sourced from CDP `AXNode` properties already being read
(`treeFormatUtils.js:24`, `a11yTree.js:128`) — zero extra CDP round-trip, pure serializer formatting.
Same round also relabeled `<input type=file>` from Chrome's generic `role:"button"` to a distinct
`role:"input, file"` (`a11yTree.js:118`) so the host doesn't mistake an upload control for a plain button.
This is adjacent to (not a duplicate of) `adopt-list-v2.md` C1's "compound-component synthesis" item —
C1 is about `<select>`/`<input type=date>` format hints; this is the narrower, cheaper win of surfacing
**current boolean state** inline so the host doesn't have to infer "is this already checked?" from role+name
alone, which is a common silent-wrong-action cause (double-toggling a checkbox that was already set).
- **Change:** `perception/serialize.ts` — append `[selected]`/`[checked]` when the corresponding CDP AXNode
  property is true; give `<input type=file>` its own role string distinct from `button`. Data already flows
  through `walk.ts`'s CDP read; this is formatting only.
- Keyless. Source: `BROWSERBASE_R4_2026-07-13.md §11` ("#2116... #1975").

## 4. Coordinate→ref resolution without a full snapshot (`resolveXpathForLocation`) — **P1, directly strengthens the already-planned B1 coordinate verbs**

`adopt-list-v2.md` B1 proposes coordinate-based fallback verbs (`click --at x y`) that bypass
`groundRef`/`toLocator` entirely and go straight to `page.mouse`. Stagehand's `understudy/coordinateResolver.js`
shows a materially better version of the same idea: `resolveXpathForLocation(page, x, y)` calls CDP
`DOM.getNodeForLocation` at that viewport point, then walks the returned backend node **up through nested
iframes** to build a full cross-frame absolute XPath — all **without running a full hybrid/a11y snapshot**
(the "fast path for CUA/coordinate clicks"). This means a coordinate click doesn't have to stay a blind,
un-groundable action: it can resolve back to a real node identity (role/name/selector) for the response
envelope and for any downstream re-verification, closing the exact "un-actable, ungroundable" gap B1 flags
while keeping B1's stated latency win (no full snapshot).
- **Change:** in the same `actuation/actions.ts` coordinate-verb work B1 already scopes, wire the click
  through CDP `DOM.getNodeForLocation` first, resolve upward through `perception/walk.ts`'s frame
  bookkeeping, and populate the response's `ref`/`role`/`name` fields from the resolved node instead of
  leaving them null — turns B1's "blind mouse click" into a "coordinate-seeded, ref-verified click."
- Keyless. Source: `BROWSERBASE_R4_2026-07-13.md §11` (`coordinateResolver.js`).

## 5. ActCache key must sort query params before hashing — **P0, tiny, directly strengthens the already-planned D1 cache**

`adopt-list-v2.md` D1 proposes a self-healing resolution cache keyed on
`sha256({instruction, normalizedUrl, refSelectorOrRole})`. Stagehand shipped exactly this cache years ago
and only in 3.6.0 (#2233) fixed a real, silent bug in it: `ActCache.buildActCacheKey` was hashing the raw
page URL, so `?id=42&utm_source=email` and `?utm_source=email&id=42` — semantically the same page — missed
the cache. The fix is one line: `new URL(rawUrl).searchParams.sort()` before stringifying, with an
unparseable-URL passthrough. This is a **known, dated failure mode** in the exact mechanism Silver is about
to build — worth baking the normalization in from day one rather than discovering the same bug later.
- **Change:** in D1's cache-key construction (wherever `normalizedUrl` gets built), sort query-string keys
  alphabetically before hashing; leave fragments and duplicate keys untouched (stable sort); fall back to
  the raw string on a parse failure. Zero new dependency (`URL`/`URLSearchParams` are Node built-ins).
- Keyless. Source: `BROWSERBASE_R4_2026-07-13.md §12`.

## 6. Trajectory/evidence dedup + externalized screenshots — **P2, cuts task-log bloat, a real Silver gap**

Stagehand's new `verifier/` subsystem is model-bound (an offline LLM-judge) and out of scope for a keyless
tool, but its **evidence-capture plumbing** underneath is pure, keyless bookkeeping and solves a problem
Silver's own `task/store.ts` (`action_log.jsonl`/`checkpoint.json`) has not addressed: screenshots pile up
as raw bytes in a growing log with no dedup. Stagehand's `evidence.js` does two cheap, model-free things:
(a) **perceptual near-duplicate dedup** — always keep the first and last frame of a run, keep a middle
frame only if it differs from the last-kept frame by a fast **MSE** pass (threshold 30, computed on both
images resampled to 400×300) escalating to **SSIM** only when MSE says they differ (threshold 0.75,
grayscale, `c1=0.0001,c2=0.0009`) — no model call anywhere in that comparison; (b) **content-addressed
externalization** — `writeTrajectoryDir` writes each unique screenshot once to
`screenshots/{probe,agent}/<N>.png` on disk and references it by path from `trajectory.json`, deduping by
raw buffer identity so a frame shared across several steps is stored once, with a path-traversal guard on
load (a `screenshotPath` that escapes the trajectory dir throws).
- **Change:** in `task/store.ts`, when a task step captures a screenshot, (a) externalize it to
  `<task-dir>/screenshots/<seq>.png` and reference by relative path from `action_log.jsonl` instead of
  inlining base64 (Silver's existing `assertContainedPath` from `security/egress.ts` already gives the
  path-traversal guard for free — reuse it verbatim, don't reinvent it); (b) add an opt-in MSE-then-SSIM
  dedup pass (pure pixel math, no `sharp` dependency required — a hand-rolled 400×300 nearest-neighbor
  downsample + MSE is ~20 lines) before writing a new screenshot, skipping the write if it's a
  near-duplicate of the last kept frame. This directly serves the already-planned `F1 task compile` and
  general task-log hygiene without adding any model dependency.
- Keyless. Source: `BROWSERBASE_R4_2026-07-13.md §3.1-3.4, §4` (`evidence.js`, `trajectory.js`).

## 7. Subagent result handoff via a written file + path reference, not an inline-capped string — **P1, a real gap vs Silver's own code**

Checked directly against `orchestration/subagent.ts`: `subagent done <id> --text <result>` stores the
result **inline**, capped at `MAX_PROMPT` via `capOutput()` (`subagent.ts:305`) — a long subagent output is
silently **truncated**, not preserved. Perplexity's Orchestrator Implementation Deep-Dive documents the
opposite pattern for its own internal `run_subagent` tool: the sub-agent's full result is written to
`/home/user/workspace/{task_id}.json` on a shared filesystem, and the tool call returns only
`{"task_id":..., "result_path": "/home/user/workspace/t1.json", "status":"completed"}` back to the parent
model's context — the parent reads the file itself (or hands the path to yet another subagent) only when
and if it actually needs the full content, instead of the orchestrator eating the whole payload's tokens on
every completion regardless of whether it's used.
- **Change:** add a `subagent done <id> --result-file <path>` alternative (or make it the default when the
  `--text` payload exceeds `MAX_PROMPT`) that copies/moves the file into the subagent sidecar directory
  (`.silver/subagents/`, same convention `subagent.ts` already uses) and records a `resultPath` field
  alongside (or instead of) the capped `result` string in `SubRecord`. `subagent list`/`wait` then surface
  the path so the host can `Read` it directly rather than losing data to truncation. Small, additive schema
  change — `orchestration/subagent.ts`.
- Keyless. Source: `PERPLEXITY_COMPUTER.md` Orchestrator Implementation Deep-Dive, Q2 (Architecture A,
  `run_subagent` result-write pattern).

## 8. Typed `{type}:{index}` id namespace for non-DOM referents — **P2, ergonomic, extends beyond `eN`**

The leaked Comet Browser Assistant system prompt documents a typed ID system: every piece of information
handed back to the model — a browser tab, a history item, a search result, a generated image — gets an id
of the shape `{type}:{index}` (`tab:2`, `web:3`, `calendar_event:5`), and the model is told to dereference
these ids explicitly rather than re-stating content. Silver's `eN` refs already do exactly this for DOM
elements, but Silver's **other** addressable surfaces — `tabs` list entries, `extract` result rows, `memory`
episodic entries — currently have no unified, typed, cross-referenceable id scheme; each subsystem invents
its own indexing ad hoc (checked: `core/tabs.ts` uses raw array/target indices, not a stable typed id).
- **Change:** adopt the `{type}:{index}` convention as a **cosmetic, additive** id format across
  `tabs list`, `extract`, and `memory list` output (e.g. `tab:2`, `row:7`, `mem:14`) — purely a labeling
  convention on data Silver already returns, not a new subsystem. The payoff is that a host can pass
  `attached_ids: ["tab:2", "row:7"]`-style references into a `subagent spawn --context` call (pairs
  naturally with item 7 above) without re-serializing the full content into the spawn command.
- Keyless. Source: `PERPLEXITY_COMPUTER.md` lines 2180-2194 (leaked Comet prompt, "## ID System").

## 9. Filesystem-serde over REPL-persisted state for cross-turn continuity — **evaluative note, informs B0's design, not a new item**

`adopt-list-v2.md` B0 (marquee `silver repl`) proposes a persistent JS execution context across statements,
explicitly modeled on Aside/browser-use's CodeAct pattern. Perplexity's "Search as Code" research article
(read in full, `PERPLEXITY_COMPUTER.md` Round-2 §11) is directly relevant prior art on the **exact** design
question B0 will hit once it's live: how should state persist across turns? Perplexity evaluated both
options head-to-head inside their own sandboxed code-execution agent — **persistent REPL** (variables
referenced by name across turns, more token-efficient, but suffers "the 100-cell Jupyter notebook problem":
namespace clutter makes it hard to track what's still alive and why) vs **filesystem + explicit
serialize/deserialize code the model writes itself** (more token overhead per turn, but "provides better
reliability on particularly long trajectories") — and **chose filesystem-based serde**, explicitly flagged
as their production decision (not tentative marketing) after empirical A/B testing, though they note they
"will continue to iterate."
- **Recommendation for B0's design, not a separate backlog item:** Silver's `repl` should default to
  exposing `snapshot()`/`openTab()`/etc. as **stateless-per-call globals over a persisted CDP connection**
  (state = "browser stayed open", not "JS variables stayed alive") rather than trying to keep a long-lived
  JS heap alive across statements — closer to Perplexity's filesystem-serde choice than to a raw
  Node `vm` context with survivor variables. If B0 does want variable persistence, budget for exactly the
  failure mode Perplexity names (unbounded namespace growth over a long session) and consider a periodic
  "what's still live" summary rather than assuming persistence is free reliability.
- Keyless (a design note; the underlying mechanism is host/CLI-side bookkeeping, no model call inside
  Silver). Source: `PERPLEXITY_COMPUTER.md` Round-2 §11, "Cross-turn intermediate-state persistence."

## 10. MCP-server hardening checklist for Silver's planned opt-in daemon — **P1, applies directly to A3**

`adopt-list-v2.md` A3 plans an opt-in `silver serve`/`--daemon` — a long-lived process a client connects to
over a Unix socket. Perplexity's own `@perplexity-ai/mcp-server` shipped with, then had to retroactively
patch, the textbook "0.0.0.0-day" local-tool-server vulnerability class: `BIND_ADDRESS` defaulting to
`0.0.0.0` (every interface) and `ALLOWED_ORIGINS` defaulting to `"*"` (wildcard CORS), so any page in any
browser tab on the same machine (or LAN) could `fetch()` the local server and silently ride the operator's
credentials — and, as of the 2026-07-13 round, **the committed fix sits on `main` but was never cut into an
npm release**, so every real-world install is still vulnerable months later. This is a directly avoidable
class of bug for Silver's daemon if the hardening is the *starting* default, not a v2 patch:
- **Change (bake into A3's initial implementation, not a follow-up):** default `--daemon` bind address to
  `127.0.0.1` only (never `0.0.0.0` without an explicit, loudly-logged opt-in flag); no HTTP/CORS surface
  at all if the socket is a Unix domain socket (the strongest fix — Perplexity's own bug only exists
  because their transport is HTTP; Silver's daemon plan is already scoped to a Unix-socket JSON-line
  protocol per A3, which sidesteps this whole class if it stays that way); if a TCP fallback is ever added
  for cross-platform reasons, port Perplexity's exact fixed shape: reject `Origin: null` unless
  allowlisted, a `Host`-header allowlist (loopback-only by default), a structured `403` on rejection, and a
  **startup banner to stderr** (not behind a log-level gate — Perplexity's own postmortem notes the
  original insecure-config warning was itself swallowed by a level-gated logger defaulting to `ERROR`).
- Keyless. Source: `PERPLEXITY_COMPUTER.md` Round-2 §7 (commits `1c3994e`/`f69c72e`, `SECURITY.md` verbatim
  threat model, and the confirmed still-vulnerable-on-npm finding).

## 11. `share_file` / durable sandbox-artifact retrieval pattern — informs F1 `task compile` artifact story — **P3, small**

Perplexity's `/v1/responses` gained two new routes (`GET .../files`, `GET .../files/{id}/content`) backing
an implicit `share_file` sandbox affordance: any file a sandboxed task produces can be persisted out of the
otherwise-ephemeral execution environment and retrieved after the fact by id, with the original filename
preserved via `Content-Disposition`, streamed as raw bytes. This is the same "task run produces durable,
individually-addressable artifacts" shape `adopt-list-v2.md` F1 (`task compile`) is already aiming at for
*scripts*; worth explicitly scoping F1 (or a sibling verb) to also cover **file artifacts** a task run
produces (a downloaded PDF, a generated screenshot, an extract-to-file result) with a stable per-artifact id
and filename, not just the replayable command script.
- **Change:** extend `task/store.ts`'s run manifest with an `artifacts: [{id, filename, path}]` list
  populated whenever a task step downloads/saves/screenshots a file, and add `task artifact get <task-id>
  <artifact-id>` to retrieve one by id instead of requiring the host to already know the on-disk path.
- Keyless. Source: `PERPLEXITY_COMPUTER.md` Round-2 §2.

## 12. `HTTP 424 Failed Dependency` as the distinct error code for "the thing you told me to call is unreachable" — **P3, taxonomy nuance**

Perplexity's new `mcp` tool returns a specific `424 Failed Dependency` (not a generic 500/502) when a
caller-supplied remote MCP server can't be reached at discovery time — a deliberate signal that the failure
is in the caller's declared dependency, not Perplexity's own service. Silver's 13-code closed error taxonomy
(`core/errors.ts`, confirmed non-gap elsewhere in the corpus) is already stronger than most of this survey's
sources, but doesn't currently have a distinct code for "a `--allowed-domains`/webmcp/external resource the
*agent itself* pointed at is unreachable" vs. Silver's own internal failure — worth a one-line audit of
whether `navigation_blocked`/`element_not_found`-class codes already cover this distinction cleanly or
whether a `dependency_unreachable` code would remove ambiguity for the host's retry logic (retry Silver's
own transient failure vs. don't retry, the target the agent chose is simply down).
- Keyless, doc/taxonomy-only. Source: `PERPLEXITY_COMPUTER.md` Round-2 §3.

## 13. Parallel-vs-sequential subagent dispatch heuristic, worth porting into the SKILL verbatim — **P2, doc-only**

The leaked Comet prompt gives an unusually crisp, copy-pasteable rule for when to fan work into parallel
hidden-tab tasks vs. keep it as one sequential task, with worked positive/negative examples: *"Should
parallelize: add iPhone, iPad, and MacBook to my Amazon cart → three separate parallel tasks... Don't
parallelize: fill out the billing form, then submit the order → single task"* — the general rule being
sequential-dependent steps must be combined into one task, and only truly independent actions get split.
Silver's subagent-parallel machinery already exists (`adopt-list-v2.md` "Confirmed non-gaps" lists
"subagent cap/depth/own-context invariants" as matched), but the SKILL prose doesn't yet give the host a
crisp litmus test for *when* to reach for `subagent spawn` at all vs. running steps sequentially in one
session — this is pure, reusable guidance text.
- **Change:** port the parallelize/don't-parallelize worked-example pair (with Silver's own verb names
  substituted) into `skill-data/core/SKILL.md` alongside the existing subagent section. Zero code.
- Keyless. Source: `PERPLEXITY_COMPUTER.md` lines 2269-2278.

## 14. Cite-by-snippet-id, not by-document, when consuming subagent/extract output — **P3, doc-only**

The same Comet prompt instructs the model: when producing a final answer from `control_browser` task
results, "cite the results... by the id of the snippets rather than citing the document" — i.e. attribute
claims to the specific granular unit that was actually read, not the coarse container it came from. This is
a cheap, portable instruction for Silver's own extract/subagent-result consumption guidance: when a host
uses `extract`'s ID-grounded rows (already a confirmed Silver strength per `adopt-list-v2.md`) to answer a
user, it should cite the specific extracted row id, not just "the page," which keeps the host's downstream
claims auditable against Silver's own grounding guarantee instead of throwing it away at the last step.
- **Change:** one sentence in the SKILL's extract section reinforcing this practice, tying it explicitly to
  the ID-grounding Silver already does mechanically.
- Keyless. Source: `PERPLEXITY_COMPUTER.md` lines 2286-2288.

---

## Priority index (do-order, this batch only)

**P0:** #5 ActCache URL-normalization (fold into D1 before it ships).

**P1:** #4 coordinate→ref resolution (fold into B1 before it ships) · #7 subagent result-file handoff ·
#10 daemon bind/CORS hardening defaults (fold into A3 before it ships).

**P2:** #1 WebMCP bridge (forward-looking, small surface) · #3 selected/checked state badges ·
#6 trajectory screenshot dedup/externalization · #8 typed `{type}:{index}` id convention ·
#13 parallel-dispatch SKILL prose.

**P3 / doc-only / evaluative:** #2 iframe-path chaining audit (confirmed non-gap on the DOM-stamping half) ·
#9 filesystem-serde design note for B0 · #11 task-artifact retrieval · #12 `424`-class error-code audit ·
#14 cite-by-snippet-id SKILL sentence.

## Explicitly NOT adopted from this batch (checked, rejected on evidence)

- AgentQL's `tf623_id` DOM-attribute-stamping identity scheme — Silver's out-of-band `eN` refmap is the
  better design (no page pollution, no collision risk with site JS/CSS); only the iframe-path *chaining
  mechanism* is worth auditing (item #2), not the stamping technique itself.
- Stagehand's `verifier/` rubric-judge subsystem wholesale — it is a multimodal LLM-as-judge (rubric
  generation + relevance scoring + fused judgment all require model calls); flatly excluded by Silver's
  keyless invariant. Only its pixel-math evidence-dedup plumbing (item #6) is model-free and portable.
- AgentQL's Tetra remote-browser fleet (`BrowserProfile.STEALTH`/`TF_BROWSER`), Browserbase's captcha
  solver, Web Bot Auth, and Fingerprint.com stealth partnership — all paid/hosted/keyed infra, already
  correctly excluded by `adopt-list-v2.md`'s "Do NOT build" list; re-confirmed, not re-litigated here.
- Perplexity's `previous_response_id`/`store` server-managed multi-turn continuation and the `mcp` tool's
  remote-server bridging — both require Perplexity's own hosted `/v1/responses` backend; the *design
  lesson* (filesystem-serde over REPL-state, item #9) is portable, the mechanism itself is not.
