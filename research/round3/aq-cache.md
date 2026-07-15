# AgentQL — Caching Resolved Queries + Deterministic-Before-Model Fallbacks vs Moxxie

Lens: keyless caching. Source read: `agentql-server/cache.py`, `pipeline.py`,
`model_router.py`, `grounding.py`, `tree_serializer.py`, `constants.py`.
Moxxie read: `src/actuation/{resolve,actions,wait,pagechange}.ts`,
`src/perception/{refmap,diff,walk}.ts`, `src/core/handlers.ts`,
`src/extract/transform.ts`.

## Context

AgentQL is NOT keyless: `pipeline.py` calls an LLM (routed by `model_router.py`)
to map a query string to element refs, then deterministically **grounds**
the LLM's output against the real accessibility tree (`grounding.py`) and
retries once with a corrective prompt if grounding finds hallucinated refs
(`pipeline.py::run_element_query` steps 6-7, `MAX_RETRIES=1`). `cache.py`
wraps the whole (tree_hash, query, mode, pipeline) -> validated-result
mapping in Redis with a 300s TTL, purely to avoid repeat LLM spend on
structurally identical pages.

Moxxie has **no LLM in this path at all** — `actuation/resolve.ts` and
`actuation/actions.ts` are 100% deterministic Playwright dispatch, and
`extract/transform.ts` makes hallucination *structurally impossible*
(ID-pattern-constrained schema fields) rather than validating it after the
fact. So AgentQL's literal "cache the LLM call" mechanism has no direct
translation — there is no LLM call to cache. **skip-cargo-cult: do not add a
Redis-style result cache keyed on an LLM call moxxie never makes.**

What DOES translate is the *shape* of AgentQL's caching discipline:
(1) a structural hash that strips volatile per-load IDs so structurally
identical pages hit the same cache key, (2) short-circuiting expensive work
when nothing has changed, (3) a TTL that bounds how long a cached
snapshot/result is trusted. Moxxie has partial, inconsistent versions of all
three and should converge them.

## Findings

### F1 — P1 — adopt — `handleSnapshot` always redoes the full AX walk even when nothing changed
- **source_does**: `cache.py::get()` is consulted BEFORE the expensive LLM
  call (`pipeline.py` step 3-4) and returns the cached validated result
  without ever invoking `provider.complete(...)` when `(tree_hash, query,
  mode, pipeline)` matches within the 300s TTL.
- **moxxie_current**: `core/handlers.ts::handleSnapshot` (lines 308-345)
  unconditionally calls `snapshotNodes(page, snapOpts)` — the full CDP
  `DOM.getDocument`+`Accessibility.getFullAXTree` walk — on *every*
  `snapshot` invocation, THEN calls `settleAndFingerprint` (line 335) to
  compute the cheap `url|focusedBackendNodeId|domNodeCount` fingerprint, and
  only AFTER both expensive steps does `observe()` (`perception/diff.ts`)
  discover the tree was byte-identical and emit `"No changes detected"`. The
  cheap check runs last, gating nothing.
- **evidence**: `handlers.ts:308-345` (order: snapshotNodes -> render ->
  observe -> settleAndFingerprint); `perception/diff.ts:28-46`
  (`observe()` already has the "nothing changed" short-circuit, it's just
  reached too late to save the walk). `handleAct` (`handlers.ts:387-434`)
  never bumps `generation` and already computes+persists a fresh fingerprint
  after every action (line 426) — that fingerprint is available and unused
  by the next `snapshot` call.
- **change**: In `handleSnapshot`, before calling `snapshotNodes`, do a cheap
  pre-check: read `page.url()` + a lightweight `domNodeCount` evaluate (the
  same primitive `pagechange.ts::fingerprintAfterSettle` already uses) and
  compare against `prev.fingerprint`. If it matches AND `prev.generation`
  == the generation that produced `prev.fingerprint` (i.e. no navigation
  happened), return `prev.prevTree` directly with a `cached: true` /
  `"No changes detected"` response, skipping `snapshotNodes` entirely. Fall
  back to the full walk on any mismatch or on first call. This is the direct
  keyless analogue of `cache.py::get()` — same "cheap key check before
  expensive resource" shape, just gating a CDP walk instead of an LLM call.
- **keyless_ok**: true — pure comparison of two already-computed strings/CDP
  primitives, no model involved.
- **priority**: P1

### F2 — P1 — align — three inconsistent "did the page change" granularities where AgentQL has one canonical hash
- **source_does**: `tree_serializer.py::compute_tree_hash` (lines 119-135) is
  the SINGLE structural-hash function, explicitly built to ignore volatile
  `tf623_id` values ("Ignores tf623_id values (which change per page load)")
  and hash only `role:name` pairs in document order. It is reused as the
  cache key (`cache.py::_make_key`) AND implicitly as the basis for
  `grounding.py`'s existence checks via `build_tree_index` on the same tree.
  One canonical notion of "structurally the same."
- **moxxie_current**: moxxie has THREE separate, non-shared notions of "did
  the page change," at three granularities:
  1. `perception/diff.ts::observe()` — exact string equality of the full
     serialized tree text (catches everything, including value-only
     mutations, but is only reached after the full walk — see F1).
  2. `actuation/pagechange.ts::fingerprintAfterSettle` — `url + focused
     BackendNodeId + domNodeCount` (lines 77-82). This is coarser than (1):
     it does NOT hash names/roles/values at all, so a page that mutates
     visible text/values in place (a price ticker, a live counter, a status
     label changing from "Pending" to "Failed") while keeping the same DOM
     node count reports `page_changed: false`. This is the flag the host
     actually reads after every `act()` (`handlers.ts:426`,
     `warnIf(fp.page_changed)`) to decide whether refs might be stale — so
     the coarsest of the three signals is the one gating the host's
     re-snapshot decision.
  3. `actuation/resolve.ts::rematchByShape` — `${role} ${name}` keyed by nth
     occurrence (lines 84-93), scoped to ref-eligible nodes only. This is
     AgentQL's `compute_tree_hash` idea applied per-node instead of
     whole-tree, and only used for slow-path ref re-matching, not exposed as
     a page-level signal at all.
- **evidence**: `pagechange.ts:15-19` (fingerprint definition doc comment,
  confirms domNodeCount-only, no content hash); `diff.ts:28-46`;
  `resolve.ts:78-95`.
- **change**: Extract a single `structuralHash(nodes: SnapNode[]): string` in
  `perception/` (role+name+value per ref-eligible node, in document order —
  AgentQL's `compute_tree_hash` shape, extended to include `value`/text
  content so it also catches in-place mutations that (2) currently misses).
  Use it as: the cache key basis for F1's snapshot short-circuit, the input
  to `pagechange.ts`'s fingerprint (replacing or augmenting the
  domNodeCount-only signal), and the shape `rematchByShape` already computes
  ad hoc. One function, three call sites, no duplicated "what counts as
  structurally the same" logic.
- **keyless_ok**: true.
- **priority**: P1

### F3 — P1 — adopt — persisted session state has no staleness bound (AgentQL's cache has an explicit 300s TTL, moxxie's sidecar has none)
- **source_does**: `cache.py::DEFAULT_TTL = 300` — every cached result
  expires after 5 minutes; a stale cache entry is never trusted indefinitely.
- **moxxie_current**: `core/handlers.ts`'s `moxxie-state.json` sidecar
  (`UabState`: `generation`, `prevTree`, `fingerprint`, `extract`) has NO
  timestamp field anywhere (`grep` for `capturedAt`/`timestamp`/`ttl` across
  `handlers.ts`, `session.ts`, `perception/*.ts`, `actuation/*.ts` returns
  nothing relevant). A `prevTree`/`fingerprint` from a session abandoned
  hours or days ago is loaded and diffed against exactly as trustingly as
  one from two seconds ago (`loadState` at `handlers.ts:87-94` just reads
  whatever JSON is on disk).
- **evidence**: `handlers.ts:66-94` (`UabState` type + `loadState`, no time
  field); `constants.py:52` (`CACHE_DEFAULT_TTL_SECONDS = 300`) for contrast.
- **change**: Add `capturedAt: number` (epoch ms) to `UabState` in
  `handlers.ts`, set on every `saveState` call. On `loadState`, if
  `Date.now() - capturedAt` exceeds a small bound (e.g. a few minutes,
  configurable), treat `prevTree`/`fingerprint` as absent (force the F1
  short-circuit to miss and do a full fresh walk, and let `observe()` treat
  it as a first observation) rather than diffing against a possibly
  unrelated page state from an out-of-band navigation or long-idle session.
- **keyless_ok**: true — a plain epoch-ms comparison.
- **priority**: P1

### F4 — P2 — align — no bounded retry around the slow-path structural rematch
- **source_does**: `pipeline.py::run_element_query` step 7 retries the LLM
  call ONCE with a corrective prompt when `grounding_result.errors` is
  non-empty, and only keeps the retry if it strictly improved
  (`len(retry_grounding.errors) < len(grounding_result.errors)`,
  `pipeline.py:153`) — a deterministic "retry only if provably better" gate
  around a probabilistic step.
- **moxxie_current**: `actuation/resolve.ts::toLocator` (lines 117-141) tries
  the fast path once, then the slow path (`rematchByShape`, a full
  `snapshotNodes` re-walk) exactly once, and throws `ResolveError` on any
  failure of either. There is no retry for the case where the slow path
  fails because the SPA is mid-transition (element not yet re-attached at
  the moment of the walk) — a purely timing-based failure a single bounded
  retry after a short delay would often resolve, no model needed.
- **evidence**: `resolve.ts:117-141` (single fast-path try, single slow-path
  try, no loop).
- **change**: In `toLocator`, if the slow path's `rematchByShape` returns
  `null` (or the `stampAndLocate` after it fails), do ONE bounded retry after
  a short delay (e.g. 150-300ms) before throwing `ResolveError` — mirrors
  AgentQL's "retry once, deterministically bounded" pattern without adding
  unbounded polling (Playwright already owns actionability polling per the
  module's own doc comment; this is specifically about the ref-to-node
  bridge, not the action itself).
- **keyless_ok**: true — a fixed-count retry with a fixed delay, not a
  fixed-cost busy-loop; consistent with `wait.ts`'s existing stance that
  fixed delays are "last resort" but sometimes correct.
- **priority**: P2

### F5 — P2 — skip-cargo-cult — do not add an LLM-result cache, complexity-based model router, or query-generation retry loop
- **source_does**: `model_router.py::select_provider` routes between
  `gpt-4.1-mini` / `claude-sonnet` / etc. by tree-node-count and
  query-field-count complexity thresholds (`COMPLEX_TREE_NODE_THRESHOLD=500`,
  `COMPLEX_QUERY_FIELD_THRESHOLD=10`, `model_router.py:88-93`);
  `pipeline.py::generate_query_from_prompt` retries NL-to-query generation up
  to `MAX_QUERY_GENERATION_RETRIES=2` times against a live model.
- **moxxie_current**: absent, and correctly so — moxxie never converts
  natural language to a query via a model call; the host LLM does that
  reasoning and moxxie only executes already-resolved refs/selectors.
- **change**: none. Flagging explicitly so a future round doesn't
  reintroduce "model routing by complexity" or "query-generation retry loop"
  as if they were caching features — they are LLM-cost-management features
  for a system that calls a model in the hot path, which moxxie's
  actuation layer structurally does not.
- **keyless_ok**: n/a (recommendation is to skip).
- **priority**: P2

### F6 — P2 — skip-cargo-cult — do not port `cache.py`'s Redis dependency or its `(tree_hash, query, mode, pipeline)` key shape verbatim
- **source_does**: Redis-backed cache keyed on
  `sha256(tree_hash:query:mode:pipeline)[:24]` (`cache.py:27-29`) — `mode`
  and `pipeline` are LLM-routing dimensions (`"fast"/"standard"`,
  `"automation"/"data"/"query_generation"`) that only exist because AgentQL
  has multiple LLM pipelines to disambiguate between.
  `query` is the AgentQL query string being resolved by the LLM.
- **moxxie_current**: no query language, no pipeline modes, no external
  cache service (Redis) anywhere in the CLI (it's a per-invocation process
  with a JSON sidecar file, not a long-lived server).
- **change**: none. F1-F3 already extract the load-bearing idea (cheap
  structural key gates expensive work, with a TTL) without the Redis
  dependency or the LLM-mode dimensions in the key — a plain JSON sidecar
  field is the right-sized keyless equivalent, not a new external service.
- **keyless_ok**: n/a (recommendation is to skip).
- **priority**: P2

### F7 — P2 — adopt — centralize scattered magic-number constants the way `constants.py` does
- **source_does**: every threshold/timeout/TTL lives in one file,
  `constants.py`, each annotated with its source (SDK vs server-side vs
  DESIGNED-because-undisclosed) — e.g. `CACHE_DEFAULT_TTL_SECONDS = 300 #
  DESIGNED — server-side TTL not disclosed`.
- **moxxie_current**: equivalent constants are scattered inline with no
  shared file: `REMATCH_LIMIT = 5000` in `actuation/resolve.ts:36`,
  `NETWORK_IDLE_BUDGET_MS = 1_200` in `actuation/pagechange.ts:37`. No
  `constants.ts` exists anywhere under `src/` (`find ... -iname
  "constants*"` returns nothing).
- **evidence**: `resolve.ts:36`, `pagechange.ts:37`.
- **change**: Low priority housekeeping, but once F1/F3 add a TTL/staleness
  bound and F2 adds a shared structural-hash helper, those new constants
  (staleness window ms, hash granularity) should land in one place, not a
  fourth scattered `const`, so the next contributor can find and tune every
  timing/threshold knob in one file the way `constants.py` makes AgentQL's
  tunables auditable at a glance.
- **keyless_ok**: true.
- **priority**: P2

## Top recommendation

**F1**: gate `handleSnapshot`'s expensive `snapshotNodes` AX-tree walk behind
a cheap pre-check (URL + domNodeCount vs. the fingerprint already persisted
by the prior command) and return the cached `prevTree` unchanged when it
matches — the direct keyless translation of `cache.py::get()` short-
circuiting AgentQL's LLM call, applied to moxxie's actual expensive
resource (the CDP accessibility-tree walk) instead of a model call it never
makes.
