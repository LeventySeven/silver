# Stagehand vs moxxie — a11y tree build / backendId maps / iframe encoding

Source: `/Users/seventyleven/Desktop/moxxie/reference/stagehand` (packages/core/lib/v3/understudy/a11y/snapshot/{a11yTree.ts,capture.ts})
Moxxie: `skill/agent-browser/src/perception/{walk.ts,serialize.ts,roles.ts,refmap.ts}`, `skill/agent-browser/src/actuation/resolve.ts`

## Headline gap

moxxie's `snapshotNodes()` (walk.ts:118) opens **one** CDP session bound to
the main frame, calls `Accessibility.getFullAXTree()` with **no `frameId`**
(walk.ts:162), and hardcodes `frameId: 'main'` on every `SnapNode`
(walk.ts:245). `DOM.getDocument({depth:-1, pierce:true})` does recurse into
same-process `contentDocument`s (`collectDom`, walk.ts:284-303), so same-
origin same-process iframes' *DOM* nodes are indexed — but their *AX* nodes
never are, because `Accessibility.getFullAXTree` only returns nodes attached
to the session's own target/frame; it does not descend into an iframe's AX
subtree regardless of `pierce`. Cross-origin iframes (OOPIFs) are invisible
end-to-end: no separate CDP session is ever attached to them.

Concretely: `roles.ts:36` puts `'Iframe'` in `INTERACTIVE_ROLES`, so the
`Iframe` AX node itself gets minted a ref (e.g. `e7`) — but nothing inside it
is walkable, and even if it were, `resolve.ts`'s `toLocator`/
`stampByBackendNode` (resolve.ts:60-76) calls `DOM.resolveNode` on the single
page-level CDP session, which cannot resolve a backendNodeId living in a
different frame's/target's node-id space. The `frameId` field already exists
on `RefEntry` (refmap.ts:18) and `SnapNode` (walk.ts:49) — it's dead,
unused plumbing waiting for exactly this feature.

Stagehand's `captureHybridSnapshot` (capture.ts:59-134) solves this properly:
per-frame CDP session ownership (`ownerSession`/`sessionToIndex`, deduped by
session id so same-process frames share one `DOM.getDocument` call —
capture.ts:314-331), per-frame `Accessibility.getFullAXTree({frameId})` calls
with a defensive fallback to the unscoped tree on frame-detach races
(a11yTree.ts:27-43), frame-relative XPath maps prefixed by the absolute path
of the hosting `<iframe>` element (`computeFramePrefixes`, capture.ts:742-803),
and a final textual stitch that nests each child frame's rendered outline
under its iframe host's line in the parent tree (`mergeFramesIntoSnapshot` +
`injectSubtrees`, capture.ts:811-870).

## Findings

### 1. [P0] No per-frame AX fetch — iframe content is invisible past the host node
- **source_does**: `a11yForFrame(session, frameId, opts)` (a11yTree.ts:18-43) calls `Accessibility.getFullAXTree({frameId})` once per frame in scope, with a caught-and-retried fallback (`isFrameScopeError`) for detach races.
- **moxxie_current**: `snapshotNodes` (walk.ts:162) calls `Accessibility.getFullAXTree()` with no `frameId`, once, for the whole page. `Iframe` is `INTERACTIVE_ROLES` (roles.ts:36) so it mints a ref, but the ref points at a dead end.
- **change**: In `walk.ts`, enumerate `page.frames()`; for each in-scope frame (same-process: share the existing main-session `pierce:true` DOM index already built by `collectDom`; OOPIF/cross-origin: attach a CDP session to that frame's target — Playwright's `newCDPSession` can be pointed at a `Frame` directly for this) call `Accessibility.getFullAXTree({frameId})`, tag every resulting `SnapNode.frameId` with the real frame id (not `'main'`), and splice the frame's nodes into the DFS at the position of its hosting `Iframe` AX node.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `a11yTree.ts:18-43`; moxxie `walk.ts:118-177,245`, `roles.ts:36`

### 2. [P0] `RefEntry.frameId` / `SnapNode.frameId` is dead plumbing — actions can't dispatch cross-frame
- **source_does**: every DOM/AX map key is frame-qualified (`encode: (be) => \`${ordinal(frameId)}-${be}\`\`, a11yTree.ts:96-97,242-243), and action resolution always goes through the session that owns that frame (`ownerSession(page, frameId)`, capture.ts:216,357).
- **moxxie_current**: `resolve.ts`'s `toLocator` (resolve.ts:117-141) takes one `cdp: CDPSession` argument, always the page-level session created once by the CLI, and calls `DOM.resolveNode({backendNodeId})` on it unconditionally (resolve.ts:65). There is no code path that picks a different session based on `entry.frameId`.
- **change**: Once (1) lands, thread `entry.frameId` through `toLocator`: look up (or lazily create) the CDP session owning that frame before `stampByBackendNode`/`DOM.resolveNode`, and use `page.frame(frameId).locator(...)` instead of `page.locator(...)` for the stamped-attribute fallback query so `[data-moxxie-ref=...]` is queried inside the correct frame's document.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `capture.ts:216-227,357`; moxxie `resolve.ts:60-76,117-141`, `refmap.ts:18`, `walk.ts:245`

### 3. [P1] StaticText children duplicating the parent's own accessible name are never deduped
- **source_does**: `removeRedundantStaticTextChildren(parent, children)` (a11yTree.ts:262-278) drops StaticText children whose whitespace-normalized concatenated text equals the parent's own name, so a `button "Submit"` doesn't also render a child `StaticText "Submit"` line.
- **moxxie_current**: `serialize.ts`'s `skipLine` (serialize.ts:165-171) only special-cases `role === 'StaticText' && snap.name === ''` — i.e. it drops *empty* StaticText, but a named interactive element whose AX name derives from its own single text child still emits both the parent line and a redundant child StaticText line in the default (non-compact) render.
- **change**: In `serialize.ts`, before/while building the tree, when a node's single StaticText child's `name` (normalized) equals the parent's `name`, mark that child skipped the same way empty StaticText is skipped now (extend the `skipLine` predicate to compare against a `renderIndent`-adjacent parent name, or precompute during `buildTree`).
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `a11yTree.ts:262-278`; moxxie `serialize.ts:160-184`

### 4. [P1] Frame-relative outlines are stitched into the parent tree at the iframe host line
- **source_does**: `mergeFramesIntoSnapshot` (capture.ts:811-870) + `injectSubtrees` nest each child frame's rendered outline under the encoded id of the `<iframe>` element that hosts it, so the final text is one coherent, indent-correct tree spanning frames.
- **moxxie_current**: no equivalent exists because there is no multi-frame walk yet (see #1). Once #1 lands, naively concatenating per-frame node lists without frame-relative indentation/nesting would produce a disconnected or mis-indented tree.
- **change**: Reuse `serialize.ts`'s existing `level`-based indent recovery (`buildTree`, serialize.ts:138-150): when a frame's root nodes are appended, offset their `level` by the hosting `Iframe` node's render depth so `renderNode` naturally nests them, rather than inventing a new stitching mechanism.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `capture.ts:811-870,841-855`; moxxie `serialize.ts:138-150`

### 5. [P2] `role="none"` is declared structural but never collapsed
- **source_does**: `isStructural(role)` (a11yTree.ts:226-229) treats `generic`, `none`, AND `inlinetextbox` as collapsible wrapper roles, pruned bottom-up (`pruneStructuralSafe`, a11yTree.ts:192-223).
- **moxxie_current**: `roles.ts:70` already lists `'none'` in `STRUCTURAL_ROLES` — but that set is never imported by `walk.ts` or `serialize.ts`. `serialize.ts`'s `skipLine` (serialize.ts:165-171) only special-cases the literal string `role === 'generic'`, so `role="none"` wrapper nodes (common on decorative/ARIA-suppressed layout elements, e.g. `role="none"` tables) always render as noise lines even when they carry no name and a single child.
- **change**: In `serialize.ts:169`, widen the generic-collapse condition to also match `role === 'none'` (and consider importing `STRUCTURAL_ROLES` from `roles.ts` instead of hardcoding the string, so the declared set and the enforced behavior can't drift again).
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `a11yTree.ts:226-229`; moxxie `roles.ts:52-73`, `serialize.ts:165-171`

### 6. [P2] Scrollable-container role annotation is a free, keyless signal moxxie doesn't surface
- **source_does**: `decorateRoles` (a11yTree.ts:107-158) rewrites a node's role to `"scrollable, <tag>"` whenever a purely computed DOM check (`scrollableMap`, built once per session) says the element is scrollable — telling the host agent "you can scroll this container" without any extra probe call.
- **moxxie_current**: `SCAN_JS` (walk.ts:381-438) already runs one `page.evaluate` pass over every element computing `getComputedStyle`, cursor, tabindex, etc. — it has all the machinery to also check `scrollHeight > clientHeight` cheaply in the same pass, but doesn't; there is no scrollable flag anywhere in `SnapNode`.
- **change**: Add a `scrollable: boolean` computed field to the existing `SCAN_JS` element loop (walk.ts, inside the per-element loop starting ~walk.ts:387), thread it into `SnapNode.flags` or a new field, and surface it in `formatLine` (serialize.ts:186-214) as e.g. `[scrollable]` so the host agent knows to try scroll actions on that ref without guessing.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `a11yTree.ts:107-136`; moxxie `walk.ts:381-438` (SCAN_JS), `walk.ts:33-56` (SnapNode)

### 7. [P2] Frame-scope CDP error fallback pattern (contingent on #1)
- **source_does**: `a11yForFrame` (a11yTree.ts:27-43) catches specific CDP error substrings ("Frame with the given…", "does not belong to the target", "is not found") when a scoped `getFullAXTree({frameId})` fails — e.g. because the iframe detached mid-capture during an SPA re-render — and falls back to the unscoped call instead of throwing.
- **moxxie_current**: n/a today (no per-frame calls exist); once #1 is implemented, a bare `cdp.send('Accessibility.getFullAXTree', {frameId})` with no error handling would make the *entire* `page.snapshot` fail just because one iframe navigated away during the walk.
- **change**: When implementing #1, wrap the per-frame `getFullAXTree` call in the same catch-and-fallback (or catch-and-skip-that-frame) pattern rather than letting one detached frame abort the whole snapshot.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `a11yTree.ts:27-43`

### 8. [skip-cargo-cult] Selector-based cross-frame exclusion-interval machinery
- **source_does**: `buildFrameExclusionIntervals` / `resolveIgnoredNodes` / `makeIsIgnoredBackendNode` (capture.ts:416-696, ~280 lines) build a binary-searchable interval tree over DOM pre/post-order traversal indices, per frame, so a caller-supplied `ignoreSelectors: string[]` option can exclude a subtree (e.g. a cookie-banner iframe) from the AX walk, cascading exclusion into any nested frames hosted inside the excluded subtree.
- **moxxie_current**: absent — moxxie has no `ignoreSelectors` snapshot option, only `selectorScope` (scope IN to one selector, walk.ts:167-169,316-342).
- **recommendation**: skip-cargo-cult. This machinery exists to serve Stagehand's productized `extract`/`observe` API surface (callers pre-declare "ignore this ad slot" across a whole session). For a single keyless agent driving its own snapshots, the same outcome — "don't act on the cookie banner" — is achieved for free by the host LLM simply not clicking refs inside it, or by moxxie's existing `selectorScope` inverted use (scope to `body > *:not(.ad)` is awkward but rare enough not to justify a 280-line interval-tree subsystem). Re-introducing this would be scope creep disproportionate to moxxie's single-session CLI shape.
- **keyless_ok**: true (but not worth building)
- **priority**: P2
- **evidence**: source `capture.ts:416-696`; moxxie has no analog (walk.ts:167 `selectorScope` is the closest, and is scope-IN not scope-OUT)

## Top recommendation

Ship findings **#1 + #2 together** as one change: they're two halves of the
same feature (per-frame AX fetch + frame-aware ref resolution) and neither is
useful without the other — `RefEntry.frameId` already exists in the schema,
so this is closing a gap the code already anticipated, not adding new surface
area. Everything else here (StaticText dedup, `none` collapse, scrollable
flag) is incremental fidelity/noise cleanup that can land independently and
cheaply on top.
