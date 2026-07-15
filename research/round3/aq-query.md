# AgentQL vs moxxie — Query/Locator Resolution (Round 3)

Lens: resilient element finding — AgentQL's server-side `grounding.py` +
client-side `locate_interactive_element` bridge vs moxxie's
`actuation/resolve.ts` + `actuation/actions.ts`.

Source read: `/Users/seventyleven/Desktop/researchfms/agentql/agentql-server/{grounding.py,tree_serializer.py,cache.py,constants.py,generate_accessibility_tree.js}`
and `/Users/seventyleven/Desktop/researchfms/agentql/AGENTQL_IMPLEMENTATION.md` (§7 grounding, §18.6 `locate_interactive_element`/`find_element_by_id`/`_get_frame_context`, §18.7).

Moxxie read: `src/actuation/resolve.ts`, `src/actuation/actions.ts`,
`src/perception/refmap.ts` (`RefEntry`), `src/perception/walk.ts` (`SnapNode.frameId`).

---

## 1. [P0] Iframe chain is captured at snapshot time but silently dropped at resolve time

**AgentQL does:** `find_element_by_id(page, tf623_id, iframe_path)` walks a
dot-separated `iframe_path` (e.g. `"42.67"`) through `frame_locator()` calls
before resolving the element (`_get_frame_context`, IMPLEMENTATION.md
§18.6, lines ~5445-5457). The server writes `iframe_path` onto every node
inside an iframe during tree generation (`generate_accessibility_tree.js`
lines 270-291, `node.setAttribute("iframe_path", currentIframePath)`), so by
the time the client resolves a ref it knows exactly which frame chain to
descend.

**moxxie today:** `RefEntry` in `src/perception/refmap.ts` carries a
`frameId: string` field, and `SnapNode` in `src/perception/walk.ts` (line 49)
populates it from CDP's `AXNode.frameId`. But `grep -n "frameId"` on
`src/actuation/resolve.ts` and `src/actuation/actions.ts` returns **zero
matches** — `toLocator()` always does `page.locator(refSelector(ref)).first()`
against the top-level page, in both the fast path (`stampAndLocate` off
`entry.backendNodeId`) and the slow path (`rematchByShape`, which itself
never filters `nodes` by `frameId` either). Playwright's `page.locator()`
does not pierce same-origin or cross-origin `<iframe>` boundaries — it only
searches the document it was created against.

**Failure scenario:** Any target inside an `<iframe>` (payment widgets,
embedded checkout, ad-tech consent frames, third-party comment widgets) gets
a `frameId` in its `SnapNode`/`RefEntry` that is never consulted. The CDP
`DOM.resolveNode`/`Runtime.callFunctionOn` stamp in `stampByBackendNode` may
still succeed (CDP works across frames via `backendNodeId`), but the
subsequent `page.locator('[data-moxxie-ref="..."]').first()` will find
**zero** matches in the main frame and fall through to `ResolveError`
(`element_not_found`) — even though the element is live and stampable.
Worse, in the slow path, `rematchByShape` walks `snapshotNodes(page,...)`
which returns nodes from *all* frames flattened together (walk.ts stamps
each with its `frameId`), so a same-`(role,name,nth)` collision across two
different frames (e.g. a "Submit" button on the top page AND one inside an
iframe) can silently resolve to the WRONG frame's element, because
`rematchByShape` never checks `snap.frameId === entry.frameId`.

**Change:** In `src/actuation/resolve.ts`:
- Filter `rematchByShape`'s candidate `nodes` to `snap.frameId === entry.frameId`
  before computing `nth` (currently only filters `refEligible`).
- Convert `frameId` (moxxie's opaque CDP frame id) or build an `iframe_path`
  equivalent, and when `entry.frameId !== 'main'`, resolve via
  `page.frameLocator(...)` (or the equivalent CDP `Runtime` execution-context
  targeting for that frame) instead of blindly calling `page.locator()` on
  the top page. The cheapest keyless fix: track each frame's Playwright
  `Frame` handle (from `page.frames()`, matched by CDP frameId) at snapshot
  time and stamp+locate against `frame.locator(...)` instead of `page.locator(...)`.

**keyless_ok:** true — this is pure CDP/Playwright frame plumbing, no model involved.
**priority:** P0 — currently a correctness gap (misresolve or false
`element_not_found`) for any page with iframes, and the data (`frameId`) is
already collected and just discarded.

---

## 2. [P1] Slow-path rematch trusts `nth` positional index with no secondary disambiguator — a real misclick risk AgentQL avoids by failing closed

**AgentQL does:** has NO analogous "rematch by shape" step at all. If
`tf623_id` isn't found in the (freshly regenerated) tree index, `grounding.py`'s
`validate_ref` just nullifies the field / raises `ElementNotFoundError`
(`ERROR_ELEMENT_NOT_FOUND = 1006` in `constants.py`) — it fails closed rather
than guessing a replacement element from role/name/position. AgentQL's
resilience comes from a *fresh* tree + fresh LLM call each time, not from
positional recomputation of a stale ref.

**moxxie today:** `rematchByShape` (`resolve.ts` lines 78-95) recomputes
`nth` purely from `(role, name)` grouping in document order among
`refEligible` nodes, and treats the first node whose recomputed `(role,
name, nth)` triple equals the stale entry's as a positive match — no
uniqueness check, no secondary signal (href, value, placeholder, DOM
position relative to siblings). If a list re-renders and an item above the
target is removed/added (a very common SPA pattern — e.g. a toast
disappearing, a row being deleted, infinite-scroll prepending), every
subsequent same-`(role,name)` item's `nth` shifts by one, and
`rematchByShape` will confidently return the **adjacent** element's
`backendNodeId` instead of failing — this is exactly the "silent
wrong-click" class of bug the module's own header comment (line 15) warns
about for the fast path, but the slow path reintroduces it via nth-drift.

**Change:** In `src/perception/refmap.ts`, widen `RefEntry` with 1-2 cheap,
already-available disambiguators moxxie's own `SnapNode` computes anyway —
e.g. `url` (for links, already on `SnapNode.url`) and/or `value`/`flags` — and
in `rematchByShape` (`resolve.ts`), when more than one node shares
`(role,name,nth)` positionally is ambiguous or when the immediate-neighbor
count doesn't match, prefer the node whose extra field also matches; if
still ambiguous, fail closed with `ResolveError` rather than picking one.
This is the AgentQL lesson translated to keyless terms: prefer "no match" over
"confident wrong match."

**keyless_ok:** true — deterministic extra-field comparison, no model call.
**priority:** P1 — lower likelihood than #1 but higher blast radius (silent
wrong action vs. a loud failure).

---

## 3. [P2] Tree-hash-keyed result cache — SKIP as cargo-cult for moxxie's use case

**AgentQL does:** `cache.py`'s `ResultCache` keys a Redis cache on
`sha256(tree_hash:query:mode:pipeline)` with a 300s TTL (`constants.py`
`CACHE_DEFAULT_TTL_SECONDS`), and `tree_serializer.py`'s `compute_tree_hash`
hashes `role:name` pairs (ignoring `tf623_id`, which changes per load) so
structurally-identical re-renders hit cache and skip the LLM call entirely.

**moxxie current:** no cache in `resolve.ts`/`actions.ts` — every `act()`
call re-grounds and re-resolves fresh (as it should, per the module's own
"a handle is NEVER cached across commands" rule, line 26).

**Recommendation: skip-cargo-cult.** AgentQL's cache exists purely to avoid
repeat *paid LLM inference* for identical (tree, query) pairs — that
constraint doesn't apply to moxxie, which is 100% keyless and already
cheap/fast (CDP calls + a bounded DOM walk). Adding a tree-hash cache to
resolve.ts would only reintroduce staleness risk (a cached "resolution"
could point at a `backendNodeId` from a structurally-similar-but-different
DOM state) for no latency win worth the correctness risk. Confirmed
intentional design in moxxie already ("never cached across commands").

**keyless_ok:** true (trivially, since it'd be skipped) — flagged skip regardless.
**priority:** P2 (informational — do not implement).

---

## 4. [P2] Query-guided subtree pruning — SKIP, already flagged anti-pattern territory

**AgentQL does:** `prune_tree_for_query` in `tree_serializer.py` scores
every node against query field names (word-overlap + role-hint heuristics,
lines 195-230) and prunes the tree to relevant subtrees before sending to
the LLM, for pages over `PRUNING_MAX_TOKENS` (15K tokens).

**moxxie current:** no equivalent — `resolve.ts`'s `REMATCH_LIMIT = 5000`
node cap and `walk.ts`'s `MAX_LEVELS = 50` depth cap already bound cost
without needing query-aware relevance scoring, because moxxie has no
free-text query field to score against (that's the DSL moxxie deliberately
doesn't have).

**Recommendation: skip-cargo-cult.** This pruning exists to fit AgentQL's
tree into an LLM context window and reduce token cost — it is a
consequence of AgentQL routing the tree *through a model*. Moxxie's
resolve path never serializes a tree for a model to read; its existing
node/depth caps already serve the analogous "bound the work" purpose without
needing field-name string-matching heuristics. Building this would be
reintroducing DSL-adjacent machinery for a cost moxxie doesn't pay.

**keyless_ok:** true (as skip). **priority:** P2.

---

## 5. [P1] AgentQL's "role plausibility" grounding check is aspirational only in the real code — do not adopt the docstring's promise, the actual behavior is existence+uniqueness only (useful negative finding)

**AgentQL does (verified across BOTH `agentql-server/grounding.py` and the
fuller `AGENTQL_IMPLEMENTATION.md` §7.1 copy):** the module docstring/comment
promises three checks — "1. EXISTENCE... 2. ROLE CHECK: is the element's role
plausible... 3. UNIQUENESS" — but the actual `ground_element_response`/
`validate_ref` code only implements #1 (ref exists in `build_tree_index`) and
a no-op #3 (`used_refs.add(ref_str)` — collisions are tracked but never
rejected, comment literally says "warn but don't nullify", no warning is
ever emitted). There is no role-compatibility table or check anywhere in
`grounding.py`.

**moxxie today:** `groundRef` (`refmap.ts`) checks ref existence +
generation-staleness (a strictly *stronger* guarantee than AgentQL's
existence-only check, since it also invalidates refs across snapshot
generations). `rematchByShape` additionally requires an exact `(role, name)`
match, which is already a stronger uniqueness/plausibility gate than
AgentQL ships.

**Recommendation:** do not chase AgentQL's docstring-promised role-check —
it doesn't exist in their shipped code, so there's no real technique to
port. moxxie's generation-based staleness gate (`groundRef`) is already
ahead of what AgentQL actually enforces; the actionable work is #1/#2 above
(frame-scoping and disambiguation), not a role-compatibility matrix.

**keyless_ok:** true. **priority:** P1 informational — prevents the team
from wasting a cycle "catching up" to a feature that was never real.

---

## 6. [P2] Accessible-name multi-attribute fallback chain — check for parity, low-risk polish

**AgentQL does:** `getName()` in `generate_accessibility_tree.js` (lines
177-193) tries, in order: `aria-label`, `placeholder`, `alt`, `title`,
`value`, `name` — falling back to element text content only in
`createNode`'s later text-child logic (line ~323, and only for buttons or
when there's exactly one text child).

**moxxie today:** name computation lives in `src/perception/accessible-name.ts`
(not read in this pass — out of the resolve/actions lens boundary named in
the task). Flagging for a follow-up lens rather than asserting a gap here
without having read that file under this task's scope.

**keyless_ok:** n/a (not verified this round). **priority:** P2 — pointer
for a future accessible-name-focused pass, not a claim.

---

## Summary of priorities

| # | Finding | Priority | Action |
|---|---------|----------|--------|
| 1 | `frameId`/iframe chain captured but never used in resolve.ts | P0 | adopt (frame-scoped stamp+locate) |
| 2 | Slow-path `nth` rematch has no secondary disambiguator, fails open not closed | P1 | adopt (add disambiguator, fail closed on ambiguity) |
| 3 | Tree-hash result cache (cache.py) | P2 | skip-cargo-cult (LLM-cost-avoidance, N/A keyless) |
| 4 | Query-guided pruning (tree_serializer.py) | P2 | skip-cargo-cott (DSL-adjacent, moxxie has no free-text query) |
| 5 | "Role plausibility" grounding check | P1 (informational) | skip — doesn't exist in AgentQL's real code, don't chase it |
| 6 | Accessible-name fallback chain | P2 | out of scope this pass — flag for accessible-name.ts lens |

**Top recommendation:** fix #1 — wire the already-captured `RefEntry.frameId`
/ `SnapNode.frameId` through `toLocator()`/`rematchByShape()` in
`src/actuation/resolve.ts` so cross-frame elements resolve correctly instead
of silently failing or (worse) matching a same-named element in the wrong
frame. This is the highest-leverage change: the data already exists, the
plumbing to use it is missing, and it is a strict correctness fix with zero
new dependencies.
