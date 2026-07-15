# Source: Aside — Perception & Snapshot Builder

**Mined from:**
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/40_perception.md` (Subsystem 40 — Page Perception & Actuation, division-of-labor teardown)
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/91_snapshot_builder.md` (Subsystem 91 — the injected accessibility-tree builder, carved verbatim from the `aside-daemon` Node.js SEA binary, offsets cited)

Both files label every claim KNOWN (read from source/binary, offset or `file:line` cited) / INFERRED / DESIGNED. Part 91 supersedes Part 40's §3a "BLACK BOX" on the snapshot mechanism — Part 40's actuation findings (CDP `Input.*`) stand uncorrected.

---

## Killer Insight

Aside's SOTA accuracy (99% Online-Mind2Web) comes from **owning the entire perception layer as injected first-party code, not from a bigger model.** The snapshot is not CDP `Accessibility.getFullAXTree`, not Playwright's `_snapshotForAI` — it is a hand-written DOM walker (not an AX-tree read) injected as one IIFE string into a CDP isolated world per frame, that (a) grows its depth budget only on *included* nodes so wrapper-soup doesn't burn the depth limit, (b) prunes to a strict 4-category filter (interactive ∪ scrollable ∪ landmark ∪ canvas) in the default "interactive" mode, (c) collapses wrapper chains and merges short text-leaf runs into parent names post-walk, and (d) refuses to ever `.slice()`/truncate a tree — it either fits or returns an actionable error telling the caller to re-scope by `ref`/`depth`. The size reduction and the completeness increase (off-viewport elements kept, cross-origin iframes inlined) are not in tension — they're both side effects of filtering by *semantic role* rather than by DOM position.

---

## Patterns

### 1. Injected-JS walker in a CDP isolated world, not `getFullAXTree` [CORE]
**What:** The builder is a self-contained IIFE (`IZ`) injected via `Page.addScriptToEvaluateOnNewDocument({source, worldName:"__aside_utility", runImmediately:true})` for the initial load, and `Page.createIsolatedWorld` + `Runtime.evaluate` for frames that attach later. Grep of the whole daemon binary for `getFullAXTree`, `_snapshotForAI`, `generateAriaTree`, `ariaSnapshot` returns **zero hits** — proof by elimination that this is not a wrapper around CDP's AX tree or Playwright's snapshot code.
**Why:** A first-party DOM walker lets you control exactly which nodes get refs, exactly how names are computed, and exactly how iframes are stitched — none of which CDP's AX tree gives you control over. It also runs in an isolated world invisible to page JS, so it can't be detected/blocked by the page and can't collide with page globals.
**How to implement:** Ship one IIFE string. On tab attach: `Page.setWebLifecycleState{state:"active"}` (keep tab logically active even backgrounded), `Emulation.setFocusEmulationEnabled{enabled:true}` (makes `document.activeElement`/`:focus` valid even off-screen — load-bearing for the `[focused]` enrichment), then inject via `addScriptToEvaluateOnNewDocument{worldName, runImmediately:true}`. For every frame (including OOPIFs via `Target.setAutoAttach{autoAttach:true, flatten:true}`), listen to `Page.frameAttached/frameNavigated/frameDetached`, call `Page.createIsolatedWorld{frameId, worldName}` + `Runtime.evaluate{expression: builderIIFE, contextId}`, verify with `Runtime.callFunctionOn` that `typeof globalThis.__aside === "object"`.
**Evidence:** `91_snapshot_builder.md` §0 lines 22-36, §2 lines 82-124 (`ABt.initialize`, w7 offset 99,434,600).
**Tier:** core.

### 2. Perception and actuation share ONE element registry [CORE]
**What:** `globalThis.__aside = { elementRegistry, snapshotEpoch:0, takeSnapshot, deref, retarget, resolvePointerTarget, waitForReady, checkHitTarget, checkEditable }` — all live in the same injected isolated world.
**Why:** The ref the model clicks is the *exact same element* the snapshot named — no separate re-resolution step that could point actuation at a different node than perception saw. Eliminates an entire class of "clicked the wrong element" bugs from having two disconnected addressing schemes.
**How to implement:** One injected module per frame owns both the snapshot builder and the action-resolution helpers (`deref`, hit-testing, editability check). Don't split perception into an extension/CDP path and actuation into a separate content-script path with a different ref scheme.
**Evidence:** `91_snapshot_builder.md` §2 lines 116-124.
**Tier:** core.

### 3. The compact indented ARIA-ish tree format (exact grammar) [CORE]
**What:** Verbatim node line: `role "name" [ref=eN] [level=N] [hidden] [scrollable] [checked] [disabled] [focused] [selected] [placeholder="…"] [size=WxH]`. Two-space indent per depth level. A node with exactly one text child and no element children collapses to `role "name" [ref]: "text"` instead of a nested text-child line. `<select>` inlines its `<option>`s as child lines (`- option "label" (selected) value="v"`). Root synthetic node (`role:"fragment"`) is never printed.
**Why:** This is the exact "compact indented tree with ephemeral ref IDs" format the source targets. It reads like Playwright's aria-snapshot from the outside but is generated by different code — worth copying the *format* even though the internals differ from Playwright.
**How to implement:** `snapshotNodeToString(node)` builds the `parts` array in this exact order (role, name, ref, level, hidden, scrollable, checked, disabled, focused, selected, placeholder, size) then `.join(" ")`. `renderSnapshotTree(node, depth, lines)` recurses: `indent = "  ".repeat(depth)`; if the node has exactly 1 text child and 0 element children and isn't a `<select>`, emit `${indent}- ${s}: "${escapedText}"`; else emit `${indent}- ${s}${hasChildren?":":""}` and recurse into children at `depth+1`.
**Evidence:** `91_snapshot_builder.md` §5 lines 320-336, §7 lines 389-431 (verbatim algorithm + worked Walmart trajectory example).
**Tier:** core.

### 4. Ephemeral ref IDs `eN` / `fNeM` — minted per snapshot, Symbol-stamped for stability [CORE]
**What:** `ref = refPrefix + "e" + (++_refCounter)` — main frame prefix is `""`, frame N's prefix is `fN`, so nested-iframe refs read `f1e12`, `f105e4` (confirmed to 100+ frame depth in real trajectories). Counter resets to 0 every snapshot call, so refs are meaningless across snapshots. The element gets a JS `Symbol` stamp `{role, name, ref}`; if the same element is re-snapshotted with unchanged role+name+prefix, it **reuses its old ref** (stability across snapshots for unchanged elements).
**Why:** Small stable per-snapshot integers are cheap for the model to reason about ("click e12") without growing unbounded ref IDs across a long session. The Symbol-stamp reuse means refs don't spuriously churn on every snapshot even though the counter resets — an element that hasn't changed keeps its number.
**How to implement:** `getOrCreateRefId(element, role, name, refPrefix)`: check the Symbol stamp first, reuse if role/name/prefix match; else mint `refPrefix + "e" + ++counter`, stamp element, `registry.set(ref, element)`, and store metadata `{role, name<=100, tagName, inputType, ariaLabel, placeholder, nthAmongSameSignature}` in a side `_refs` map for later disambiguation. Also count a `role::name` "signature" so ties can be broken positionally (`nth-among-same-signature`).
**Evidence:** `91_snapshot_builder.md` §8.1 lines 440-454.
**Tier:** core.

### 5. `deref(ref)` — resilient re-resolution across re-renders, not a raw node handle [CORE]
**What:** Fast path: `elementRegistry.get(ref)` if still `.isConnected`. Slow path (element detached, e.g. after a SPA re-render): bounded `TreeWalker` over `document.body` (budget **5000 nodes**), collect all elements whose `(role, accessibleName)` match the stored signature, and if there are multiple candidates, pick by stored ordinal `nthAmongSameSignature`.
**Why:** A ref survives a React re-render because it's re-matched by *meaning* (role+name+position), not by DOM node pointer or CDP `backendNodeId` (which invalidate on re-render). This directly prevents "the model's earlier click target silently resolves to nothing" after an SPA mutates under it.
**How to implement:** Never key refs purely to a live node handle. Store enough metadata (role, accessible name, ordinal-among-same-signature) at mint time to re-find the node with a bounded tree walk if the fast-path lookup misses.
**Evidence:** `91_snapshot_builder.md` §8.2 lines 456-473.
**Tier:** core.

### 6. Refs invalidate every snapshot — enforced by both code and system prompt [CORE]
**What:** `takeSnapshot(options)` clones the previous registry (for rollback), then `elementRegistry.clear()` and restarts `_refCounter` at 0 before rebuilding. On any generation error, it rolls back to the previous registry and throws rather than leave a half-built state. Stale refs throw `RefStaleError`: *"Ref '…' is stale — the element was removed or the page changed. Take a new snapshot and retry."* The system prompt states explicitly: *"Each new snapshot invalidates all earlier ref IDs. Take a new snapshot after each action."*
**Why:** Makes the contract unambiguous to the model — no silent staleness, an explicit error names the fix. Prevents the model from reasoning about refs as durable IDs across turns.
**How to implement:** Wipe and re-mint on every `takeSnapshot` call (transactionally — roll back registry on failure). Surface a distinct, actionable error class for stale-ref resolution failures, and state the invalidation contract in the tool description / system prompt, not just in code behavior.
**Evidence:** `91_snapshot_builder.md` §8.3 lines 476-490.
**Tier:** core.

### 7. Depth budget grows only on INCLUDED nodes [CORE]
**What:** In the recursive walk, `nextDepth = (include && currentNode) ? currentDepth+1 : currentDepth` — skipped wrapper `<div>`s do not consume the depth budget. `maxDepth` defaults to 50, but because only semantically-included nodes increment depth, that's 50 *semantic* levels, not 50 raw DOM levels.
**Why:** Modern framework markup (React/Vue wrapper soup) can nest 10-20 non-semantic divs per real UI level. Counting DOM depth would blow the budget on wrapper cruft alone; counting semantic depth means deeply-wrapped pages still snapshot fully.
**How to implement:** In your traversal function, only increment the depth counter passed to recursive calls when the current node was actually included in the output tree (i.e., passed the include filter, not merely traversed).
**Evidence:** `91_snapshot_builder.md` §3.3 lines 188-221 (traverse algorithm, esp. lines 204-206, 213-216).
**Tier:** core.

### 8. The strict 4-category "interactive mode" node filter — the primary size reduction [CORE]
**What:** `shouldIncludeNode` in `{interactive:true}` mode returns true iff: `role==="canvas" || isInteractive(el) || isScrollable(el) || isLandmark(el)`. In "full" mode it additionally includes any node with a non-empty accessible name, and drops bare `generic`/`image` roles. This alone is credited as "the dominant cut" in the size-reduction analysis (§13) — a typical content page's interactive+landmark set is a small single-digit percentage of all DOM elements.
**Why:** This is the actual mechanism behind "70% smaller than [a competitor]'s tree" — not truncation, not summarization, but structural exclusion of nodes that carry no actionable or semantic information for an agent.
**How to implement:** Define `isInteractive` = native interactive tag (a/button/input/select/textarea/details/summary) OR has `onclick` OR has `tabindex != -1` OR `role` is button/link OR `contenteditable==="true"` OR has a genuine (non-inherited) `cursor:pointer`. Define `isLandmark` = heading (h1-h6) or nav/main/header/footer/section/article/aside tags, or any explicit non-presentation ARIA role. `isScrollable` = overflow-x/y is auto/scroll/overlay AND scrollHeight>clientHeight+1 or scrollWidth>clientWidth+1 (excluding html/body). Offer two modes: `interactive` (tight, default) and `full` (adds named + semantically-typed nodes) — let the agent escalate mode rather than always emitting the full tree.
**Evidence:** `91_snapshot_builder.md` §4.3 lines 290-315, §13 lines 661-689.
**Tier:** core.

### 9. Inherited-`cursor:pointer` suppression in interactivity detection [IMPORTANT]
**What:** `hasPointerInteraction = getComputedStyle(el).cursor === "pointer"`, BUT this is suppressed to false if the element's `cursor:pointer` is only inherited from a pointer-cursor parent AND the element itself has no own `onclick`/`tabindex`.
**Why:** Prevents tagging every one of a clickable card's 12 descendant `<span>`s as individually interactive just because CSS cursor cascades. Only the actual click-target (the onclick/tabindex owner) gets flagged — a precision win that keeps refs meaningful.
**How to implement:** When computing "is this cursor:pointer element interactive," check whether the parent also has `cursor:pointer` computed style; if so and this element has no own interaction attribute, don't count the cursor style as a signal.
**Evidence:** `91_snapshot_builder.md` §4.2 lines 270-288.
**Tier:** important.

### 10. Off-viewport elements are kept; only rendered-hidden elements are pruned [CORE]
**What:** `isVisible` walks ancestors checking `display:none`, `visibility:hidden`, `opacity:0`, `display:contents`, zero-box `overflow:hidden` clipping, zero-size iframes, plus `element.checkVisibility({checkOpacity, checkVisibilityCSS})`. Explicitly: scrolling an element below the fold does NOT make it "invisible" — it's still snapshotted. `shouldTraverse` drops the whole subtree only for rendered-hidden elements, with one carve-out: off-screen `<input type=radio|checkbox>` is always kept (its state matters even unseen).
**Why:** This is the "tree includes elements outside the scroll viewport" completeness guarantee — the agent doesn't need to scroll-then-snapshot repeatedly just to discover what's below the fold.
**How to implement:** Separate "off-viewport" (still include) from "rendered-hidden via CSS" (exclude) as two entirely different concepts in your visibility check. Special-case radio/checkbox inputs to survive the invisible-subtree prune.
**Evidence:** `91_snapshot_builder.md` §4.1 lines 253-268.
**Tier:** core.

### 11. Cross-origin iframe inlining via parallel per-frame snapshot + string-splice merge [CORE]
**What:** The daemon orchestrator (`THt`) BFS-collects all descendant frames, assigns each a prefix (`f1`, `f2`, …), snapshots ALL frames **in parallel** (`Promise.all`, each via `Runtime.callFunctionOn(__aside.takeSnapshot, {refPrefix: fN, ...})` in its own isolated world/CDP session), then merges **deepest-first**: for each non-root frame, find the parent's `- iframe [ref=X]` line and splice the child tree's lines beneath it, each indented +2 spaces (`SHt`). If a frame wasn't already ref'd in its parent (no matching iframe ref found), append a fresh `- iframe [origin=…]:` node instead (`CHt`). Frame trees confirmed 100+ deep in real traces (`f105e4`).
**Why:** A single-context AX tree read (CDP `getFullAXTree`) cannot see into cross-origin iframes at all. Per-frame injection + string-level splice is what makes iframe content actually appear inline in the tree the model reads, at arbitrary nesting depth.
**How to implement:** Maintain a frame prefix map (`Map<frameId,prefix>` and inverse). Snapshot all frames concurrently for latency. Merge by string manipulation of the rendered tree text (not by re-walking DOM across frame boundaries, which CDP forbids) — find the anchor line via regex, splice indented child lines under it.
**Evidence:** `91_snapshot_builder.md` §9 lines 494-542.
**Tier:** core.

### 12. Never `.slice()`/truncate the tree — error out and force re-scoping instead [CORE — explicitly named in the brief]
**What:** If `options.maxChars` is set and the rendered tree exceeds it, the builder returns an **error string** — *"Output exceeds N character limit (M characters). Try specifying a smaller depth parameter or use ref_id to focus on a specific element."* — never a silently truncated tree (which would strip refs mid-node and desync the model's addressable elements from what it can see). The system prompt/REPL layer reinforces this from the other direction: calling `tree.substring()/slice()/split()` in agent-written code triggers a `[system][warning] DO NOT USE …` message.
**Why:** Silent truncation is worse than an error: it can cut a node's `[ref=eN]` mid-line, making the model reference a ref that either doesn't exist or belongs to a different element than intended. An explicit error with actionable guidance (use `ref`/`depth` to re-scope) keeps the ref→element mapping always exact.
**How to implement:** Enforce a `maxChars` guard at serialization time. On overflow, return a structured error naming the two escape hatches (narrow by `selector`/`refId`, or reduce `maxDepth`) instead of ever truncating output text. If you expose a REPL/code-exec surface over the tree, detect and block string-slicing operations on the tree with a warning.
**Evidence:** `91_snapshot_builder.md` §10 lines 572-579 (offset 99,440,500 builder; offset 100,666,700 REPL warning).
**Tier:** core.

### 13. Myers diff, return whichever is smaller: diff or full tree [CORE — "DIFF-when-shorter" mechanism named in the brief]
**What:** After each snapshot, compute a classic Myers O(ND) line diff (`Int32Array` V-arrays, per-D snapshots, backtrack to `{type:equal|insert|delete,line}[]`) between the previous tree and the new one, group runs into unified-diff hunks (`@@ -oldStart,oldCount +newStart,newCount @@`), and return: `diff: c.length > s.length ? s : c` — i.e., if the unified-diff text would be *longer* than just re-emitting the whole new tree, return the full tree instead of the diff. Equal trees return `"No changes detected\n"`.
**Why:** Post-action, the model reads only the delta most of the time (cheap), but the format never regresses to something larger than a plain re-read — you get the compression benefit without a worst-case blowup when the page changed extensively.
**How to implement:** Store the previous rendered tree text per tab/page. On each new snapshot: run Myers diff line-by-line, format as unified diff with `@@` hunk headers, compare byte length of the diff text vs. the new full tree text, return the shorter one as the primary payload alongside the always-present full `tree` and `refs`.
**Evidence:** `91_snapshot_builder.md` §10 lines 546-589 (verbatim `snapshot()` method), confirmed in real trajectories (`@@ -2 +2,2 @@`, `No changes detected`).
**Tier:** core.

### 14. From-scratch W3C accessible-name computation, not innerText [CORE]
**What:** `getAccNameInternal` implements the real ARIA accname algorithm in strict precedence order: (1) `aria-labelledby` (recursive join of referenced elements' names), (2) `aria-label`, (3) associated `<label>` for form controls, (4) `alt` for img/area/input[type=image], (5) legend/figcaption/caption/selected-option for fieldset/figure/table/select, (6) name-from-content (concatenate `::before` CSS content + text nodes + recursive child names + `::after`, only for roles in an explicit `NAME_FROM_CONTENT_ROLES` set: button, link, heading, cell, tab, menuitem, treeitem, option, listitem, row, etc.), (7) value/placeholder/title fallback for submit/button inputs. Roles in `PROHIBITS_NAMING` (generic, presentation, paragraph, mark, time, etc.) get no name at all. Depth-limited to 10, cycle-guarded, name capped at 300 chars then re-capped to 100 when written into a node, memoized via two caches (hidden-included / not) per snapshot.
**Why:** This is what makes `link "Career areas"` read correctly instead of dumping raw innerHTML or truncated text. It also captures CSS-injected icon labels (`::before{content:"Search"}`) that pure DOM-text scraping would miss entirely — a genuine accuracy edge.
**How to implement:** Implement the precedence chain exactly as above rather than falling back to `innerText`/`textContent`. Parse `getComputedStyle(el, "::before"/"::after").content`, unquote and unescape it, treat `none`/`normal`/hidden as empty. Cap names to a fixed length (100 chars is Aside's number) for line-length discipline in the rendered tree.
**Evidence:** `91_snapshot_builder.md` §3.2 lines 148-174.
**Tier:** core.

### 15. Post-walk tree-normalization passes collapse wrapper cruft [CORE — the other half of size reduction]
**What:** Three passes run after the raw walk, before serialization: `normalizeStringChildren` (merge adjacent text children into one string, with space-insertion only between two alphanumerics at the boundary); `normalizeGenericRoles` (delete a `hidden` node with no ref anywhere in its subtree entirely; unwrap a bare unnamed `generic` node with ≤1 ref-carrying child by hoisting the child up and discarding the wrapper — this is what turns `generic > generic > button` into just `button`; flatten nested bare `paragraph`s); `mergeTextLeafChildren` (for a ref-carrying node with ≤3 children, if every child is a text-leaf — a string or an unnamed generic/heading/paragraph/label — join their text into the node's own `name` and drop the children; if the merged text equals the existing name, just drop children). Finally `findDuplicateRefIds` walks the final tree and **errors** (does not silently proceed) if any ref appears twice.
**Why:** This is what compresses wrapper-dense framework markup (`div>div>div>button`) down to one line, in bytes as well as node count — indentation itself is a real cost at 2 spaces/level across thousands of nodes.
**How to implement:** Run these three passes as a fixed post-processing pipeline over the intermediate node tree before you serialize to text. Add a final duplicate-ref sanity check as a correctness guard, not just a nice-to-have — return a clear "take a new snapshot" error rather than emitting an ambiguous tree.
**Evidence:** `91_snapshot_builder.md` §6 lines 361-385.
**Tier:** core.

### 16. Page-readiness gating before every snapshot (interactive vs. stable modes) [IMPORTANT]
**What:** Before opening a tab or clicking, and before snapshotting, the daemon races a readiness poll against an 8s timeout, polling every 100ms. Readiness = `interactiveCount>0 || landmarkCount>0 || textChars>=20` computed via a coarse CSS selector list capped at `slice(0,25)` interactive / `slice(0,10)` landmark matches (deliberately cheaper than the full `isInteractive` used for the actual tree). "Interactive" mode returns as soon as that's true (plus: `readyState!=="loading"`, no same-origin request in flight >1500ms, no zero-interactive-count streak >1000ms). "Stable" mode additionally requires DOM-mutation-quiet: `mutationCount/totalNodes <= 0.01` for 2 consecutive 100ms samples. PDFs short-circuit to ready.
**Why:** A snapshot taken on a half-loaded/still-mutating page is systematically less faithful regardless of how good the tree-building algorithm is. This is a second, separate accuracy pillar independent of the walker itself.
**How to implement:** Maintain a cheap, separate (coarser) "is this page ready" selector-based check distinct from your full interactivity-detection logic — don't reuse the expensive per-node walk just to gate readiness. Offer two readiness tiers (interactive-only vs. full DOM-mutation-quiet) so callers can choose speed vs. certainty.
**Evidence:** `91_snapshot_builder.md` §11 lines 597-624 (full constant table: `uQ=2000, lVt=100, dQ=0.01, fQ=2, pQ=8000, yVt=1500, bVt=1000`, etc).
**Tier:** important.

### 17. Reading escalation ladder — cheap tree first, vision last [IMPORTANT]
**What:** Model-facing tool contract instructs escalation in order: (1) `snapshot({interactive:true})` — small clickable-only tree, the default reach; (2) `snapshot()` (full mode) if interactive mode wasn't enough; (3) wait briefly and re-snapshot if still changing; (4) `annotatedScreenshot()` (bounding boxes + the SAME `eN` ref labels drawn on a PNG) or raw `page.screenshot()` for genuinely visual/canvas-heavy pages.
**Why:** Keeps the common case cheap (text tree) and reserves vision tokens for the minority of pages where text isn't enough (canvas apps, dense visual layouts) — and when it does escalate to vision, the overlay uses identical ref numbers so the model can cross-reference tree and image by ID rather than by coordinates.
**How to implement:** `annotatedScreenshot`: take an interactive snapshot to get `refs`, for each ref `deref()` to a live element, `getBoundingClientRect()` (skip zero-size), draw a red 2px box + monospace ref-number label positioned above (or inside, if within 14px of top) each box in an absolute-positioned overlay div at max z-index, screenshot, then remove the overlay. Encode the escalation order directly in the tool description shown to the model, not just as internal logic.
**Evidence:** `91_snapshot_builder.md` §12 lines 628-657.
**Tier:** important.

### 18. Password fields redact their value in the snapshot [IMPORTANT]
**What:** `getTextboxValue`: for `contentEditable` → innerText; for input/textarea → `.value`; but `type="password"` → literal string `"[redacted]"` (constant `USER_PASSWORD_REDACTED`); checkbox/radio/file → `null`.
**Why:** The model never sees a typed password in its context even though it can see that a password field exists and has *a* value (useful for verifying "field is filled" without exfiltrating the secret to the LLM/logs).
**How to implement:** Special-case `input[type=password]` in your value-extraction function to emit a fixed redaction sentinel rather than the real value, regardless of what generic text-extraction logic would otherwise return.
**Evidence:** `91_snapshot_builder.md` §3.4 lines 241-244.
**Tier:** important.

### 19. URL cleaning at the title line — strip tracking params, cap length, same-origin shortening [NICE]
**What:** `KZ(url)` deletes a hardcoded set of tracking params (`utm_*, gclid, gclsrc, fbclid, mc_cid, mc_eid, msclkid, twclid, li_fat_id, _ga, _gl, _t, _ts, _nc`), shortens same-origin URLs to path+search+hash, and caps the whole thing to 128 chars with an ellipsis. Rendered as `- title: "Page Title" [url=cleaned]`.
**Why:** Keeps the model's URL context short and signal-dense instead of burning tokens on marketing-attribution query strings.
**How to implement:** Maintain a fixed denylist of tracking-param names, strip them from the URL before rendering, truncate with an ellipsis at a fixed char cap, and only show a shortened path form for same-origin links.
**Evidence:** `91_snapshot_builder.md` §10 lines 568-571.
**Tier:** nice.

### 20. Password-manager iframe origin labeling [NICE]
**What:** `HQ(url)` matches known password-manager extension URL prefixes (1Password, Bitwarden, Dashlane, LastPass, "Aside Password Manager") and tags the corresponding iframe node with `[origin="1Password"]` etc.
**Why:** Flags credential-autofill iframes explicitly for the model so it can reason about "this iframe is a password manager overlay" rather than treating it as generic unlabeled content.
**How to implement:** Maintain a small URL-prefix→label map for known credential-manager extensions/services; apply it when labeling iframe origins during frame-merge.
**Evidence:** `91_snapshot_builder.md` §9 lines 527-530.
**Tier:** nice.

---

## Command Surface (verbatim / near-verbatim)

**Tool signature (daemon-facing, exposed to model):**
```
snapshot(page, options): Promise<{ tree: string; diff: string }>
options: { interactive?: boolean, showHidden?: boolean, ref?: string, selector?: string }
// `refs` (ref→element metadata) exists internally but is NOT surfaced to the model —
// only consumed by page.locator(ref) internally.
```

**In-page builder API (`globalThis.__aside`):**
```
__aside.takeSnapshot(options: {interactive, maxDepth:50, showHidden, refPrefix:"", refId, selector, maxChars})
  → { tree: string, refs: {...} }
__aside.deref(ref: string) → Element | null
__aside.elementRegistry: Map<ref, Element>
__aside.retarget / resolvePointerTarget / checkHitTarget / checkEditable / waitForReady
```

**Rendered node line grammar:**
```
<indent>- <role> "<name, ≤100 chars, escaped>" [ref=<eN|fNeM>] [level=N] [hidden] [scrollable]
    [checked] [disabled] [focused] [selected] [placeholder="…"] [size=WxH]
<indent>- <role> "<name>" [ref=eN]: "<raw merged inner text>"     # single-text-child collapse
<indent>  - option "<label>" (selected) value="<v>"                # <select> inline
<indent>  - text: "<raw text>"                                     # bare text-leaf child
```

**Whole-response envelope:**
```
# note: interactive (clickable / focusable) elements only.     [only when interactive:true]
# note: hidden elements are shown.                              [only when showHidden:true]
- title: "<page title>" [url=<cleaned, ≤128 chars>]
<tree lines...>
```

**Errors (verbatim strings):**
- `"Output exceeds N character limit (M characters). Try specifying a smaller depth parameter or use ref_id to focus on a specific element."`
- `"Ref '…' is stale — the element was removed or the page changed. Take a new snapshot and retry."`
- `"Snapshot produced duplicate refs. Take a new snapshot and retry."`
- `"Selector "…" matched no elements"`
- REPL guard: `[system][warning] DO NOT USE …` when agent code calls `.substring()/.slice()/.split()` on a tree string.

**Diff format (unified, Myers-based):**
```
No changes detected\n
@@ -oldStart,oldCount +newStart,newCount @@
-removed line
+added line
```
Rule: `diff = diffText.length > fullTreeText.length ? fullTreeText : diffText` (never return a payload larger than a fresh full read).

**CDP calls used for injection (per tab/frame):**
```
Page.setWebLifecycleState {state: "active"}
Emulation.setFocusEmulationEnabled {enabled: true}
Browser.setDownloadBehavior {behavior: "default", eventsEnabled: true}
Page.addScriptToEvaluateOnNewDocument {source: IZ, worldName: "__aside_utility", runImmediately: true}
Page.createIsolatedWorld {frameId, worldName: "__aside_utility"}      # per new frame
Runtime.evaluate {expression: IZ, contextId}                          # define __aside in that world
Runtime.callFunctionOn {functionDeclaration: "function(o){return globalThis.__aside.takeSnapshot(o)}", ...}
Target.setAutoAttach {autoAttach: true, flatten: true}                # for OOPIFs
```

**Interactivity CSS selector (coarse, readiness-gate only — NOT the tree's interactivity filter):**
```
a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],
[role=menuitem],[role=option],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]
```
capped `slice(0,25)` for interactive count, `slice(0,10)` for landmark count.

**Readiness constants:** `readyStateTimeout=2000ms, pollInterval=100ms, mutationQuietRatio=0.01, mutationQuietSamples=2, minTextChars=20, overallTimeout=8000ms, networkIdleWindow=1500ms, zeroInteractiveGrace=1000ms, postActionSettle(urlChanged)=750ms, postActionSettle(same-page)=300ms`.

**DEREF_WALKER_BUDGET = 5000** nodes (bounded TreeWalker re-resolution).

**Viewport constants:** default `1440×900`, min `960×540`, max screenshot dimension `16384px`, UA string references `Chrome/148.0.0.0`.

---

## Anti-patterns (do NOT copy)

1. **Do NOT rely on CDP `Accessibility.getFullAXTree` as your only snapshot source.** It cannot reach cross-origin iframes as a single tree, offers no control over role/name computation, and Aside abandoned it (zero references in the whole binary) in favor of an injected walker. Use it at most as a documented fallback path, not primary.

2. **Do NOT truncate the tree text when it's too long.** Aside deliberately treats mid-tree truncation as a correctness bug (it can sever a node's `[ref=eN]` and desync perception from actuation) and instead errors with actionable re-scoping guidance. Never `.slice()` a serialized tree — this is explicitly called out as a banned operation even for agent-authored code operating on tree output.

3. **Do NOT count DOM depth for the depth budget; count semantic (included-node) depth.** Counting raw DOM nesting will exhaust `maxDepth` on wrapper divs before reaching real content on any modern framework-rendered page.

4. **Do NOT key refs to raw CDP node handles (`backendNodeId`) or live object references alone.** A pure handle invalidates the instant the DOM re-renders. Aside's `deref` fallback (bounded TreeWalker re-match by role+name+ordinal) is the thing that makes refs survive SPA re-renders — a raw handle scheme would break constantly on modern web apps.

5. **Do NOT let refs persist meaningfully across snapshots.** Aside resets the ref counter to 0 every snapshot on purpose (small numbers, cheap for the model) — but this means the CALLER (agent loop / system prompt) MUST be told explicitly that old refs are dead after a new snapshot. Don't build a "refs are forever" mental model into your tool description; state the invalidation contract as plainly as Aside does.

6. **Do NOT tag every descendant of a `cursor:pointer` container as individually interactive.** Without the inherited-cursor suppression (pattern #9), a single clickable card produces a dozen spuriously-interactive child refs, bloating the tree and confusing click targeting.

7. **Do NOT treat the manual/user-triggered perception paths (React-fiber grab, lasso region grab) as the automated agent's perception mechanism.** In Aside these are architecturally completely separate systems (content-script, UUID-attribute-based, ephemeral, user-initiated) from the daemon's automated CDP-driven snapshot. Confusing the two — or building only the manual path and assuming it scales to autonomous agent loops — was literally the initial misreading this teardown had to correct (see `40_perception.md` §3c).

8. **Do NOT confuse tabCapture/`getUserMedia` live-preview video with model vision.** Aside's `tabCapture`→`<video>` pipeline (24fps, 1440×900, blank-frame luma/edge heuristic) exists purely so a human user can watch the agent work in the sidepanel — it is never what the model sees. Model vision, when used, is `Page.captureScreenshot`/`annotatedScreenshot`, an entirely separate CDP path.
