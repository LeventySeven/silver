# Deep Dive: AgentQL — Query Resolution, Deterministic-Before-Model Fallback, Caching, the Fleet

**Lens**: query (resilient resolution, cache, fleet). **Scope guard**: no full DSL recommendation —
AgentQL's own teardown flags a custom query grammar as its adoption-risk anti-pattern.

Sources read in full: `agentql-server/pipeline.py` (346 lines, the whole server-side "AI"),
`agentql-server/grounding.py` (132 lines), `agentql-server/cache.py` (57 lines),
`agentql-server/tree_serializer.py` (hash function), `agentql-server/model_router.py`,
`AGENTQL.md` (grep-verified at cited line numbers), `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md`
(1004 lines, fleet API spec section 5). Cross-checked against Silver:
`silver/src/actuation/resolve.ts` (178 lines, read in full), `silver/src/actuation/actions.ts`
(read verb definitions + doc header), `silver/src/core/errors.ts` (93 lines, read in full),
`silver/src/core/session.ts` (grepped for connect/spawn model), full `grep -rli cache
silver/src` (2 hits, both non-cache: `capture.ts` HAR field, and `resolve.ts`'s own doc comment
explicitly disclaiming caching).

---

## 1. What AgentQL does, and the mechanism

AgentQL's server-side "intelligence" is a 6–8 step pipeline, and it is genuinely a **model-first**
architecture with a **deterministic safety net bolted on after the model**, not a deterministic
system with model assistance. `pipeline.py:63-167` (`run_element_query`) is the full trace:

1. **Parse** the query string into an AST (`QueryParser`), extracting field names, whether any
   field is a list (`IdListNode`/`ContainerListNode`), and whether any field carries a natural-
   language `description`.
2. **Prune + serialize**: if `count_tree_nodes(tree) > 1000` and the query has named fields, the
   tree is pruned to just the branches relevant to those field names before serialization
   (`prune_tree_for_query`) — a token-budget mechanism, not a correctness one.
3. **Route**: `ModelRouter.select_provider(mode, pipeline, tree_node_count, query_field_count,
   has_lists, has_descriptions)` picks a model. `model_router.py:9-19` states the routing logic is
   itself INFERRED (docs say "GPT-4, Llama, Gemini... as well as our proprietary model," selection
   by "complexity + use case requirements"); the open-source reference implementation substitutes
   `gpt-4.1-mini` for the proprietary fast-path model and `claude-sonnet` for the complex fallback
   as a labeled DESIGNED stand-in, not a reverse-engineered exact match.
4. **Infer**: one LLM call with a fixed system prompt (`ELEMENT_LOCATION_SYSTEM_PROMPT`) against
   the serialized tree + query string + URL.
5. **Parse JSON** output; a `json.JSONDecodeError` here is a hard failure, not softened.
6. **Ground** (`grounding.py:33-96`, `ground_element_response`): this is the actual "resilience"
   mechanism, and it is entirely deterministic, not model-based. For every field in the LLM's
   proposed mapping, `validate_ref` checks the proposed `tf623_id` literally exists as a key in
   `build_tree_index(tree)` (an O(1) dict built once from the tree). If not, the field is
   nullified and a `GroundingError(field, "ref X does not exist in tree", proposed_ref)` is
   recorded — this is the mechanism that "catches hallucinations deterministically" (grounding.py
   docstring, line 8-9). Nested dicts/lists are walked recursively (`validate_value`,
   lines 72-91) so a query with array-of-object fields still gets every leaf ref checked.
7. **Retry once** (`pipeline.py:133-156`): if grounding produced errors, a single corrective retry
   is issued with the errors interpolated into the prompt (`CORRECTIVE_PROMPT_TEMPLATE`); the
   retry's grounding result replaces the original ONLY if it has strictly fewer errors
   (`len(retry_grounding.errors) < len(grounding_result.errors)`) — a defensive "don't make it
   worse" comparison, not blind retry-and-trust.
8. **Format** and return, with `model_used`, `latency_ms`, and summed `input_tokens`/
   `output_tokens` across both calls if a retry happened.

Data extraction (`run_data_query`, lines 169-248) is a **two-phase-with-fallback** design worth
noting as a mechanism, not a query-syntax feature: phase 1 runs the SAME element-location pipeline
to find which tree nodes match each field, then phase 2 walks each matched node's subtree
programmatically (`_recursive_text`, lines 266-276, string-joins `name` fields depth-first) to pull
literal text — the model never touches the actual extracted values, only which nodes to look at.
If phase 1 throws, it falls back to a single-phase direct-LLM-extraction path with its own
`ground_data_response` (looser: type/length checks only, `grounding.py:99-131`, `MAX_DATA_VALUE_LENGTH`
truncation at 10K chars to catch runaway hallucinated strings). This fallback-of-fallbacks
structure — deterministic-node-then-extract, falling back to model-reads-values-directly — is the
one AgentQL mechanism Silver's `extract/transform.ts` does not currently mirror (see gap #3 below).

**Locator resolution** (the client-side half, `AGENTQL.md:2618-2641`): `generateAccessibilityTree`
stamps a `tf623_id` on every element client-side as it's serialized; a returned ref resolves via
`page.locator("[tf623_id='N']")`, with iframe refs dot-joined into `iframe_path` chained through
`frame_locator()`. This is the identical bridge pattern Silver already independently implements —
see verdict below.

**Caching** (`cache.py`, entirely read): `ResultCache` is a thin Redis wrapper. The cache key is
`sha256(f"{tree_hash}:{query}:{mode}:{pipeline}")[:24]` (line 27-29), TTL defaults to 300s
(5 minutes, line 21). `tree_hash` itself (`tree_serializer.py:119-134`) is computed by walking the
tree and joining `f"{role}:{name}"` per node with `|`, **explicitly excluding `tf623_id` values**
("Ignores tf623_id values (which change per page load)" — the hash is a structural fingerprint of
the page shape, not its identity-per-load). So the cache hits when: same query text, same mode,
same pipeline, AND the page's role/name tree shape hasn't changed — a full LLM round trip is
skipped and the previously-validated result is replayed directly. Separately, `Node.get_cache_key()`
(`AGENTQL.md:4709`, `8191`) is `f"{name}({description})"` — the query AST node's own canonical
string form doubles as a cache key with no separate hashing scheme, used server-side for
per-field caching inside a single query's resolution.

**"Codified learning"** (TinyFish/Mino, qualitative per `AGENTQL.md:1451`, `2586`, `2898`, `7007`,
`6247` — explicitly NOT source-code-verified, described only in blog language): per-workflow-node
decisions get versioned into deterministic artifacts over time; on a repeat run of a known
workflow (e.g. checkout), only ~2 of 6 steps still need model involvement — the rest replay a
prior resolved decision and fall back to the model only if replay fails validation. Pricing is
explicitly framed around "distinct decisions" rather than raw tokens/browser-minutes, implying the
replay path is metered cheaper or free. This is a design target inferred from blog prose, not
reverse-engineered code — flag it as such when citing it.

**The fleet** (`AGENTQL_R2_05_TETRA_BROWSER_FLEET.md`, OpenAPI spec read in full for section 5):
`POST /v1/tetra/sessions` (`BrowserRequest`, lines 452-462) takes `browser_ua_preset`
(windows/macos/linux), `browser_profile` (light/stealth/tf-browser — a Chromium fork), `shutdown_mode`
(`on_disconnect` vs `on_inactivity_timeout` with a 5s–86400s TTL, default 300s), proxy config
(built-in `TetraProxy{country_code}` or BYO `CustomProxy{url,username,password}`), `sub_user_id`
for multi-tenant attribution, and a `branding` flag. Response (`BrowserSession`, lines 484-494) is
exactly 3 required fields: `session_id`, `cdp_url`, `base_url` — no `DELETE` endpoint;
disconnecting the CDP WebSocket IS the teardown. Telemetry (lines 507-524) bills on
`proxy_trg_rx_bytes`/`proxy_trg_tx_bytes` — proxy traffic bytes, not VM-minutes. The query endpoint
(`RestWebPageQueryRequest`, lines 553-568) accepts either a compiled `query` OR a free-text
`prompt` (server compiles prompt→query first if only prompt given), and the response
(`ResponseMetadata`, lines 590-598) echoes the compiled `generated_query` back to the caller
specifically so it can be persisted and replayed without paying recompilation cost next time — a
deliberate "cache-seed echo" product decision, called out in the source doc itself as "one of the
most reasonable design decisions in the API" (line 601).

## 2. Why this beats naive competitors

The core competitive edge is NOT the query syntax — it's **ground-then-retry-once-then-nullify**
as a hard architectural law that runs on every single call, with zero configuration and zero
model trust. Compare to a system that just JSON-parses an LLM's output and hands it to a locator:
that system silently clicks whatever node the model hallucinated. AgentQL's `ground_element_response`
makes a hallucinated ref structurally impossible to survive to the client — it's either a real
`tf623_id` present in `build_tree_index(tree)` or it's nulled and reported as an error the caller
can act on. This is a correctness property purchased with an O(n) index build and O(1) lookups per
field, cheap relative to the LLM call it's guarding. Competitors that skip grounding (raw
model-output-as-locator) fail unpredictably on exactly the cases that matter most — dynamic,
JS-heavy pages where the DOM and the model's mental model of the DOM diverge.

The cache (`cache.py`) is a second real edge: because `tree_hash` deliberately excludes the
per-load `tf623_id` values, the SAME structural page (e.g., a product listing page re-rendered
with fresh IDs but the same shape) hits cache even though every element identity changed
underneath it — this is a non-obvious design choice (most naive caches would hash the raw tree and
never hit).

## 3. The concrete gap vs Silver — three items, ranked

**GAP 1 — no replay/decision cache (HIGH priority, ADOPT).** Confirmed empirically:
`grep -rli cache silver/src` returns only `core/capture.ts` (an unrelated HAR-format literal `{}`
field) and `resolve.ts`'s own doc comment, which explicitly states "A handle is NEVER cached
across commands" (`resolve.ts:26`). There is no `(tree_hash, query) → result` cache, no
`(site, step) → prior decision` replay cache anywhere in `silver/src`. Recommendation, scoped
deliberately NOT as a query-DSL cache: a session-scoped `(workflow-tag, step-id) → {ref shape
(role,name,nth,frameId), verb, args}` replay cache, keyed the same defensive way
`resolve.ts:78-102`'s `rematchByShape` already computes matches — reuse that exact matching logic
as the cache-hit validator (attempt replay; if the shape re-match fails, fall through to full
host-LLM-driven resolution, never trust a stale replay blindly). This mirrors AgentQL's
`tree_hash`-excludes-identity insight (structural fingerprint, not per-load identity) and
TinyFish's qualitative "codified learning" pattern (replay first, fall back to full reasoning on
replay failure) — but grounded in code Silver already has (the shape-matcher), not new machinery.
Tier: cheap to prototype, directly addresses the "per-command CDP reconnect + full re-resolve"
cost this whole investigation is tracking, since a cache hit skips both the host-LLM round trip
AND a fresh snapshot.

**GAP 2 — extract/transform.ts lacks the two-phase-with-fallback + node-then-extract split
(MEDIUM priority, ADOPT the mechanism only).** AgentQL's `run_data_query` separates "which nodes
match" (model-assisted, grounded) from "what text is in those nodes" (pure programmatic walk,
`_recursive_text`, zero model tokens) and only falls back to single-phase direct-LLM-value
extraction if phase 1 throws. Silver's `extract/transform.ts` (168 lines) is the ID-grounded
schema moat already, but per the seed cross-check it re-derives the transform from scratch every
call with no equivalent split-then-fallback structure documented in its own comments. Recommend:
verify (read `transform.ts` in a follow-up pass) whether the "grounded node-list, then
programmatic text pull" split already exists implicitly via the ref-map, or whether it's a true
gap — if genuinely absent, adopting AgentQL's split would let a caller skip a second host-LLM
round trip for the "read the text of nodes I already identified" step.

**GAP 3 — request-correlation id (LOW priority, ADOPT, cheap).** AgentQL threads a `request_id`
UUIDv4 through every response (`AGENTQL.md:542-550`, `ResponseMetadata`, fleet spec line 590) for
support/debug correlation. Silver's `errors.ts` taxonomy (12 codes + `retryableByHost` +
recovery-instruction-as-message, read in full) is architecturally stronger than AgentQL's
free-text-plus-numeric-code scheme, but `core/envelope.ts`'s `fail()` intentionally does not
interpolate context into messages (correct no-leak design) — meaning there is no per-call
correlation id anywhere. Recommend a monotonic per-command sequence number (not a UUID — avoids a
new entropy/dependency) added to the envelope, scoped to the session sidecar, purely for
`--json`-log correlation across a multi-step session. Keep the no-leak invariant on the error
`message` field untouched.

**NOT a gap — resolution mechanism**: Silver's `resolve.ts` independently reimplements AgentQL's
`tf623_id`-stamp-and-locate bridge (attribute stamp via CDP `DOM.resolveNode` +
`Runtime.callFunctionOn`, then `page.locator([...])`) and strictly exceeds it: (a) verified
stamping — `locateStamped` only accepts a fast-path match when `loc.count() > 0` confirms the
stamp landed on a live, attached node (`resolve.ts:117-118`), where AgentQL's reference
`resolve_to_locator` has no such check; (b) a slow-path shape re-match (`rematchByShape`,
lines 79-102) that AgentQL's own teardown never addresses — what happens when the id-bearing node
is gone entirely (SPA re-render). AgentQL's server-side `ground_element_response` is the model-
output-hallucination guard; Silver's `resolve.ts` is the DOM-staleness guard — different problems,
both handled, and Silver's version of the DOM-staleness half is more defensive.

**NOT a gap — deterministic-before-model**: Silver's `find` verb (`actions.ts`, `FindKind =
'role'|'text'|'label'|'placeholder'|'testid'|'first'|'last'|'nth'`, doc header: "NO prior snapshot
needed") is precisely the local-exact-match-before-spending-a-model-call pattern AgentQL's own
teardown flags as AgentQL's missing capability (`AGENTQL.md` §5.3, "No offline capability... Single
point of failure"). Silver ships this; AgentQL does not.

**NOT adopted — the fleet.** Tetra's hosted, byte-metered, multi-tenant browser fleet
(`/v1/tetra/sessions`) solves remote/scaled provisioning for a hosted SaaS. Silver's
`session.ts` model (spawn a detached local Chromium; every command reconnects over CDP; browser
process persists across commands; optional `connect <endpoint>` to an already-running external
browser) is architecturally a different problem — local-first, keyless, no server component by
design. Building fleet infrastructure (UA presets, proxy country selection, byte-metered billing
hooks, inactivity-TTL shutdown) would be scope creep unless/until a hosted-Silver mode is
explicitly scoped. Correctly flagged as GAP-but-out-of-scope, not silently ignored.

## Priority summary

1. **Adopt now (HIGH)**: session-scoped replay cache keyed on `(workflow-tag, step-id) → ref
   shape + verb`, validated via the existing `rematchByShape` logic — closes the single largest
   AgentQL/TinyFish capability gap and directly reduces the reconnect/re-resolve cost this
   investigation is tracking.
2. **Adopt after verification (MEDIUM)**: audit `extract/transform.ts` for the
   node-then-extract-text split; port AgentQL's fallback-to-single-phase structure only if
   genuinely missing.
3. **Adopt, cheap (LOW)**: per-command monotonic sequence number in the envelope for log
   correlation, keeping the no-leak message invariant intact.
4. **Do not build**: hosted multi-tenant browser fleet — out of scope for a keyless local CLI.
5. **No action needed**: locator-resolution bridge and deterministic-before-model fallback —
   Silver already has stronger versions of both.
