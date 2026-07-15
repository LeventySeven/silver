# Deep dive — Aside's snapshot builder vs Silver's perception layer

Sources read in full: `researchfms/teardowns/_aside_parts/91_snapshot_builder.md` (766 lines,
carved from the `aside-daemon` binary, offsets cited), `40_perception.md` (648 lines, the
pre-correction extension-side teardown), `Silver/research/topfive/top5-aside.md` (seed).
Silver code read in full: `perception/walk.ts` (561 lines), `perception/serialize.ts` (293
lines), `perception/accessible-name.ts` (67 lines), `perception/refmap.ts` (77 lines),
`perception/diff.ts` (173 lines), `perception/roles.ts` (74 lines), `actuation/wait.ts`,
`actuation/pagechange.ts`, `security/redact.ts`, and the `handleSnapshot` call path in
`core/handlers.ts:742-780`.

## 1. What Aside's snapshot builder does, and how (mechanism)

Aside's snapshot is **not** CDP `Accessibility.getFullAXTree` and **not** Playwright's
`ariaSnapshot` — it's a hand-written DOM walker (`generateAccessibilityTree`, carved
verbatim, offset ~99,417,700–99,433,000) injected as one IIFE string into a **CDP isolated
world** (`__aside_utility`) per frame via `Page.addScriptToEvaluateOnNewDocument` +
`Page.createIsolatedWorld`, invoked through `Runtime.callFunctionOn`
(`globalThis.__aside.takeSnapshot`). The mechanism, piece by piece:

- **Role resolution**: explicit `@role` (validated against a 77-role allowlist) falls back
  to an HTML-tag → implicit-role map (`91_snapshot_builder.md:130-146`).
- **Accessible name**: a from-scratch W3C accname algorithm (`getAccNameInternal`, depth
  cap 10, cycle-guarded) walking `aria-labelledby → aria-label → label/for → alt →
  fieldset/legend → name-from-content (incl. `::before`/`::after` CSS content) → value/
  placeholder/title`, memoized per snapshot, capped 300 then 100 chars (§3.2).
- **The DOM walk** (`traverse`, not an AX-tree read): recurses `document.body`, and
  crucially **`nextDepth` only increments on INCLUDED nodes** — skipped wrapper `<div>`s
  don't consume the `maxDepth=50` budget, so 50 levels means 50 *semantic* levels, not DOM
  levels. Shadow DOM is pierced (light+shadow children unioned); `aria-owns` reparents
  elements to where ARIA says they belong (§3.3).
- **Two pruning gates**: `shouldTraverse` drops whole invisible subtrees (except off-screen
  radio/checkbox, which are kept because they matter) via a thorough `isVisible` (ancestor
  walk: display/visibility/opacity/clip + `element.checkVisibility()`); off-viewport is
  explicitly **not** invisible — scrolled-below-fold elements stay. `shouldIncludeNode` in
  `{interactive:true}` mode keeps only `interactive ∪ scrollable ∪ landmark ∪ canvas`; full
  mode adds any node with a non-empty accessible name (§4).
- **"Clickable" detection** (`getInteractivitySignals`): native tag, `onclick`, `tabindex`,
  ARIA button/link, contenteditable, OR a genuine `cursor:pointer` — but a `cursor:pointer`
  that's merely *inherited* from a clickable parent is suppressed, so a card's 12 descendant
  spans don't each get flagged (§4.2) — a precision detail Silver's cursor scan does not
  replicate (see gap 3 below).
- **Three normalization passes** post-walk: merge adjacent text, unwrap bare `generic`
  wrappers with ≤1 ref-carrying child, and fold ≤3 text-leaf children into the parent's name
  (§6) — this is "the other half of the 70% size reduction," and it runs *after* the walk,
  not just as an inclusion filter.
- **Enrichments emitted per node** (`snapshotNodeToString`): `[ref=eN]`, `[level=N]`,
  `[hidden]`, `[scrollable]`, `[checked]`, `[disabled]`, `[focused]`, `[selected]`,
  `[placeholder="…"]`, `[size=WxH]` (canvas only) — confirmed with real occurrence counts
  from Mind2Web trajectories (`[focused]`: 1,320 hits; `[scrollable]`: 1,884; `[disabled]`:
  4,643) (§5). `[focused]` is made meaningful even on **background tabs** by
  `Emulation.setFocusEmulationEnabled(enabled:true)`, called once at frame-manager init
  (§2) — without it, `document.activeElement` on a non-foregrounded tab is unreliable.
- **Refs**: `eN` (or `fNeM` inside iframe N) minted in document order, reset to `e1` every
  snapshot, but **stamped on the element via a JS Symbol** so the *same* element gets the
  *same* ref back across snapshots if its role+name+prefix are unchanged — refs are stable
  for unchanged elements even though the counter restarts (§8.1). `deref(ref)` does a
  registry hit first, then falls back to a bounded (5,000-node) `TreeWalker` re-match by
  `(role,name)` + ordinal if the element detached/re-rendered — a ref survives a React
  re-render because it's re-matched by *meaning*, not pointer (§8.2).
- **Never-truncate**: if `maxChars` is exceeded, the builder returns an **error string**
  ("Output exceeds N character limit... use ref_id to focus on a specific element") instead
  of silently cutting the tree mid-node, which would strip refs (§10). The system prompt
  reinforces this: any `tree.substring()/slice()/split()` in host code triggers an explicit
  warning.
- **Diff-when-shorter**: a hand-rolled Myers O(ND) line diff produces a unified `@@` hunk
  format; the daemon returns `diff.length > tree.length ? tree : diff` — never a delta
  bigger than a fresh read (§10).
- **Multi-frame stitching** (`THt`, §9): every frame (including OOPIFs) is snapshotted in
  **parallel**, each gets its own `fN` ref-prefix, and child-frame trees are spliced inline
  under the parent's `- iframe [ref=X]:` line via pure string-splice (`SHt`) at +2 indent —
  this is how the tree spans cross-origin iframes, which a single-context AX read cannot do.
- **Readiness gate before every snapshot** (§11): `doc.readyState !== "loading"`, then
  `interactiveCount>0 || landmarkCount>0 || textChars>=20` ("ready" vs "sparse"), and for
  "stable" mode a MutationObserver quiet-window (`mutationCount/totalNodes <= 0.01` for 2×
  100ms). Aside "almost never snapshots a half-loaded page" — `openTab()`/`click()` block on
  this before the model ever sees a tree. This is called out as "a second, less obvious
  accuracy pillar" behind the builder itself.
- **Escalation ladder**: `snapshot({interactive:true})` → full `snapshot()` → wait+resnapshot
  → `annotatedScreenshot()` (red boxes + the *same* `eN` ref numbers drawn over a real
  screenshot, so text and vision cross-reference by identical id) (§12).

## 2. Why this beats competitors

The headline number (99% Online-Mind2Web) is attributed to the tree being simultaneously
**small** (interactive-only filter removes the vast majority of nodes; wrapper-collapse and
terse per-line formatting shrink what remains — §13) and **complete** (off-viewport kept,
cross-origin iframes inlined, shadow DOM pierced, `aria-owns` honored — nothing addressable
is dropped). Competing designs pick one or the other: a raw DOM/AX dump is complete but huge
(D2Snap: raw DOM scores 38% vs downsampled a11y tree's 73%, screenshot 65% — cited in
`top5-aside.md:12-14`); a naive interactive-only filter without the name-hoisting and
wrapper-collapse passes loses semantic context. Aside's specific edge is doing **both**
reductions (node-filter + structural-collapse) while adding back the two things a plain CDP
AX read can't reach (cross-origin iframes, off-screen radios/checkboxes) — plus refs that
survive re-renders (`deref`'s TreeWalker fallback) and a readiness gate that keeps the
model from ever grounding against a half-rendered page.

## 3. Concrete gap vs Silver, verified by direct read

Silver's `perception/walk.ts` independently converged on most of the same shape — CDP
`Accessibility.getFullAXTree` (not custom walk, but the AX tree already encodes role +
computed W3C name so this is a legitimate simplification, not a shortfall), depth-grows-
only-on-included-nodes (`walk.ts:256,341` — `level` only increments past `visit`, matching
Aside's semantic-depth rule), a cursor-interactive cascade for `<div onclick>` "buttons"
(the `SCAN_JS` in-page scan, `walk.ts:498-555`, closely mirrors Aside's `hasPointer` +
inherited-cursor suppression at lines 526-529), never-truncate via `OutputOverflowError`
(`serialize.ts:49-55`, `126-128`), Myers diff-when-shorter (`diff.ts`, byte-identical
"return whichever is shorter" rule), generation-stamped refs with a hard grounding gate
(`refmap.ts` — arguably *stricter* than Aside's stale-ref recovery, since Silver refuses a
stale ref outright rather than attempting TreeWalker re-resolution), cross-origin iframe
splicing (`walk.ts:333-339`, `resolveChildFrameId` via `DOM.describeNode`), and password/
card redaction at a single serializer choke point (`redact.ts` — actually broader than
Aside's password-only `USER_PASSWORD_REDACTED`, since it also catches card-shaped values).

Four gaps survive this direct comparison, in priority order:

**GAP 1 — No pre-snapshot readiness gate (highest priority, confirmed).**
`handleSnapshot` (`core/handlers.ts:742-751`) calls `snapshotNodes(page, snapOpts)`
immediately with no readiness check beforehand. The only settle logic in the codebase,
`settleAndFingerprint` (`actuation/pagechange.ts:56-75`), runs **after** the snapshot is
already captured and rendered (`handlers.ts:768`), and its purpose is different — it
computes a post-hoc fingerprint to flag `page_changed` for the *next* command, not to gate
*this* snapshot's fidelity. There is no equivalent of Aside's `rVt`/`oVt`
(`readyState!=="loading"` → interactive-or-landmark-or-text-present → mutation-quiet for
"stable" mode) before the walk runs. Concretely: `silver open <url> && silver snapshot` can
capture a DOM that's still streaming in (SPA hydration, lazy-loaded content), where Aside
would block until at least one interactive/landmark element or 20+ chars of text exists.
**Recommendation: adopt, keyless, high priority.** This is a pure algorithm (poll
`document.readyState`, `querySelectorAll(interactiveSelector).length`, `body.innerText`
length, optionally a `MutationObserver` quiet-window) with Aside's own published constants
as a starting point (`uQ=2000ms` doc-ready budget, `bVt=1000ms` zero-interactive grace,
`dQ=0.01` mutation ratio × 2 samples for "stable" mode) — no model call needed, and it is
the single most attributable "accuracy pillar" left unadopted.

**GAP 2 — `focused` is computed but never rendered (confirmed, cheap fix).**
`walk.ts:303` sets `flags.focused = truthy(props.get('focused'))` from the AX tree, and the
`SnapNode.flags` type declares `focused?: boolean` (`walk.ts:46`) — but
`serialize.ts:formatLine` (`244-256`) never pushes it into `attrs`. The data is captured
and silently dropped at render time. Aside's `[focused]` enrichment is one of its three
named accuracy enrichments and appears 1,320 times in real trajectories — it's how the
model knows "this is the field my last keystroke landed in" without re-deriving it.
**Recommendation: adopt, keyless, trivial priority (one-line fix)** — add
`if (snap.flags.focused === true) attrs.push('focused')` to `formatLine`. Also worth adding
`Emulation.setFocusEmulationEnabled({enabled:true})` alongside the existing
`DOM.enable`/`Accessibility.enable` calls in `walk.ts:160-162` so `[focused]` stays accurate
if Silver ever drives a backgrounded tab.

**GAP 3 — No `scrollable` detection or ref-eligibility (confirmed, medium priority).**
There is no `scrollable` field on `SnapNode` at all (`walk.ts:33-56`), no `isScrollable`
helper, and `roles.ts` has no scrollable-container concept — `refEligible` is exactly
`isInteractive || (isContent && name!=='') || cursorInteractive` (`walk.ts:312`). Aside's
`shouldIncludeNode` always includes scroll containers (`isScrollable` = overflow ∈
{auto,scroll,overlay} AND scrollHeight>clientHeight/scrollWidth>clientWidth), giving them a
ref and a `[scrollable]` tag even with no name and no interactive role (1,884 occurrences in
trajectories). Without this, an agent driving Silver has no ref to target "scroll this
specific panel" — only whole-page or CSS-selector scroll, which is strictly less precise
when a page has multiple independent scroll regions (a common pattern: sidebar list +
modal + main content, each independently scrollable). **Recommendation: adopt, keyless,
medium priority.** Requires: (a) an `isScrollable` check in the in-page `SCAN_JS` (cheap —
`overflow` style + `scrollHeight>clientHeight`), (b) folding scrollable elements into
`refEligible` in `walk.ts:312`, (c) a `[scrollable]` attr in `serialize.ts:formatLine`.

**GAP 4 — Cursor-interactive scan doesn't suppress inherited-pointer children on iframes/
generally is single-frame only (confirmed, lower priority).** `walk.ts:164-167` explicitly
notes the cursor scan runs main-frame only ("keeping the scan single-frame avoids idx
collisions"), so `<div onclick>`-style "fake buttons" inside iframes rely purely on the
iframe's own AX tree, not the cursor cascade — a reasonable, documented tradeoff, not an
oversight, but it means iframe-embedded custom-widget clickables (common in payment/embed
widgets) that Aside's per-frame injection would catch (Aside injects its builder into
*every* frame including OOPIFs) can be invisible to Silver's ref set. **Recommendation:
low priority / defer** — fixing this needs either an in-frame `page.evaluate` scoped per
child frame (Playwright supports `frame.evaluate`) or accepting the documented gap; not
worth the idx-collision-handling complexity unless a real workload surfaces it.

## Non-gaps worth naming (already verified, don't re-flag)
Password/card redaction (`security/redact.ts`) is present and arguably broader than Aside's.
Never-truncate, diff-when-shorter, ref generation-grounding, and depth-grows-on-included-
nodes are all present and functionally equivalent or stricter. Cross-origin iframe splicing
exists (`walk.ts:333-339`) though capped at `MAX_FRAME_DEPTH=5` vs Aside's demonstrated
100+-deep frame trees — worth noting as a scale difference, not a design gap.
