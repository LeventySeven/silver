# vc-snapshot: agent-browser snapshot.rs vs moxxie walk.ts/serialize.ts

Lens: 3-source AX merge (AX tree + cursor scan + hidden-input promotion), compact,
iframe splice, empty-states. Source read in full:
`/Users/seventyleven/Desktop/moxxie/reference/agent-browser/cli/src/native/snapshot.rs`
(1601 lines). Moxxie read in full:
`skill/agent-browser/src/perception/walk.ts` (445 lines),
`skill/agent-browser/src/perception/serialize.ts` (243 lines),
plus caller `skill/agent-browser/src/core/handlers.ts:308-344` and
`skill/agent-browser/src/perception/roles.ts`.

Overall: moxxie is a faithful, close port of the AX-merge + cursor-scan +
hidden-input-promotion + compact algorithm (build_tree StaticText handling
partially ported, role tables copied verbatim, compact_tree ported almost
line-for-line). The real gaps cluster around three things source does that
moxxie silently drops or gets wrong: (1) iframe recursion/splice is entirely
absent despite the plumbing (Iframe ref-eligibility) being copied over, (2)
StaticText run-aggregation/dedup from `build_tree` (snapshot.rs:993-1043) was
not ported, and (3) two silent-fallback-to-wrong-behavior bugs (href
resolution, selector-scope failure) where source fails loud and moxxie fails
quiet.

## Findings

### 1. [P0] No iframe recursion/splice — `Iframe` role is ref-eligible but always a dead end
- **Source**: `snapshot.rs:509-572` (`take_snapshot`, `frame_id.is_none()` block) recursively
  calls `take_snapshot` for every `role=="Iframe"` node that got a ref, resolving
  the child frame via `resolve_iframe_frame_id` (`snapshot.rs:591-622`,
  `DOM.describeNode` → `contentDocument.frameId`), snapshotting the child frame's
  own AX tree with a **separate CDP session** when cross-origin
  (`resolve_ax_session`, tested at `snapshot.rs:1479-1517`), and splicing the
  child's rendered text back into the parent output indented under the
  `[ref=eN]` iframe line (`snapshot.rs:542-571`).
- **Moxxie now**: `walk.ts:49` declares `frameId: string` on `SnapNode` but every
  node is stamped `frameId: 'main'` unconditionally (`walk.ts:245`). There is no
  iframe-frame resolution, no per-frame CDP session, and no splice step anywhere
  in `walk.ts` or `serialize.ts` (confirmed via `grep -rn "iframe" perception/`
  — zero hits besides the unused field and `contentDocument` DOM-attribute
  walking, which only reaches DOM attributes, never the AX tree). `roles.ts:36`
  still marks `'Iframe'` as an `INTERACTIVE_ROLES` member (copied verbatim from
  source), so an `<iframe>` DOES mint a ref in moxxie's output — but that ref
  has no children and no way to address anything inside the frame. Any flow
  behind an iframe (Stripe/payment Elements, reCAPTCHA, embedded chat widgets,
  same-origin help panels) is invisible and unreachable to the host agent.
- **Recommendation**: adopt. Add a post-pass in `handleSnapshot`
  (`core/handlers.ts:308`) or inside `snapshotNodes` itself: for each SnapNode
  with `role === 'Iframe'` and a resolved `backendNodeId`, use
  `DOM.describeNode({backendNodeId, depth: 1})` to get
  `contentDocument.frameId`, open a CDP session scoped to that frame (Playwright:
  `page.frames()` lookup by frameId, or a dedicated `context.newCDPSession`
  targeting the frame's execution context — cross-origin iframes need their own
  session same as source), run `snapshotNodes` again against that frame, and
  splice the resulting SnapNode list into the parent list at the Iframe node's
  position with `level = parentLevel + 1`. This is fully keyless (pure CDP/DOM
  wiring, no model call). Recursion should be bounded to one level like source
  (`frame_id.is_none()` guard) to avoid unbounded iframe-in-iframe depth.

### 2. [P0] StaticText run-aggregation and same-name dedup missing from `build_tree` equivalent
- **Source**: `snapshot.rs:993-1043` (inside `build_tree`) does two passes after
  parent/child wiring: (a) collapses *runs* of consecutive `StaticText` siblings
  into the first one's `name` (concatenated), clearing the rest via
  `TreeNode::clear()` — this un-splits text that Chrome's AX tree breaks apart
  across inline tags/formatting; (b) if a node has exactly one `StaticText`
  child whose name equals the parent's own name, the child is cleared (avoids
  rendering the same text twice, once on the parent line and once as a nested
  `- text: "..."` line).
- **Moxxie now**: `walk.ts` has no equivalent pass — nodes are emitted 1:1 from
  the AX tree walk with no cross-sibling merge. `serialize.ts:169` only drops a
  *single* `StaticText` node if `snap.name === ''`; it never merges adjacent
  StaticText runs and never dedupes a StaticText child against its parent's
  name. Concretely: `<p>Hello <b>world</b>, click <a href=..>here</a></p>` in
  Chrome's AX tree produces 3+ StaticText children; source renders one merged
  "Hello world, click " (plus the link), moxxie renders each fragment as a
  separate `- text: "Hello "` / `- text: "world, click "` line (or worse, drops
  indentation context), and a `<button>Save</button>` with a StaticText "Save"
  child renders twice in moxxie (`button "Save"` line, then a redundant nested
  `text: "Save"` line) where source shows it once.
- **Recommendation**: adopt. Port both passes into `walk.ts` as a post-DFS
  cleanup on the flat `out` array (group by `level`+parent adjacency, same
  logic as source since moxxie already tracks `level`), or do it in
  `serialize.ts`'s `buildTree` since that already reconstructs parent/child
  structure from `level`. Cheapest integration point: after `buildTree(nodes)`
  in `serialize.ts:111`, walk each `TreeNode`'s children once to merge
  consecutive `role==='StaticText'` runs and to clear a lone StaticText child
  whose name matches the parent's name. Pure text/string logic, fully keyless.

### 3. [P1] `cleanUrl` doesn't resolve relative hrefs against the page URL — silently wrong `url=` attribute
- **Source**: gates URL resolution behind `options.urls` and, when enabled, does
  live `Runtime.callFunctionOn(objectId, "function(){return this.href||''}")`
  against the *resolved DOM object* for each ref-bearing `link` node
  (`snapshot.rs:431-497`) — `this.href` is the browser's own absolute-resolved
  URL (relative/root-relative/`../` hrefs are all normalized by the DOM itself).
- **Moxxie now**: `walk.ts:250-251` reads the raw `href` attribute string off
  every node (not gated to link role or ref-eligibility) and passes it through
  `cleanUrl` (`walk.ts:361-375`), which does `new URL(trimmed)` with **no base
  URL**. For any relative href (`/login`, `../account`, `?tab=2`, extremely
  common), `new URL()` throws and the `catch` branch returns the **raw
  unresolved string** as `snap.url`. The host agent then sees `url=/login`
  presented as if it were the actual attribute (fine for `navigate` matching
  against `page.url()` manually, but silently different from source's
  contract of always-absolute URLs, and outright wrong if the agent treats it
  as a directly fetchable/comparable absolute URL).
- **Recommendation**: adopt, keyless, cheap fix. In `cleanUrl` (or its caller in
  `walk.ts`), pass `page.url()` as the base: `new URL(trimmed, base)`. Thread
  the page's current URL into `snapshotNodes`'s closure (it's already available
  as a `Page` in scope) so `cleanUrl(href, page.url())` always resolves
  absolutely, matching source's guarantee without needing the extra
  `DOM.resolveNode` + `Runtime.callFunctionOn` round trips source pays for.

### 4. [P1] Selector-scope failure silently falls back to full-page snapshot instead of erroring
- **Source**: an invalid CSS selector or a selector matching zero elements is a
  hard, explicit error surfaced to the caller — `snapshot.rs:257-266` returns
  `Err("Invalid selector '...': ...")` on a throwing `querySelector`, and
  `snapshot.rs:345-350` returns `Err("No accessibility node found for
  selector '...'")` when the selector matches DOM but no AX node maps into it.
- **Moxxie now**: `resolveSelectorScope` (`walk.ts:316-342`) wraps the whole
  resolution in `try { ... } catch { return null }`. Downstream, `null` and "an
  empty resolved scope that produces zero roots" are BOTH silently treated as
  "no scoping" — `findRoots` (`walk.ts:262-282`): if `scopeSet` is truthy but
  yields zero roots (valid selector, zero matches — `resolveSelectorScope`
  returns `new Set()`, which is truthy), the function falls through past the
  `if (roots.length > 0) return roots` and returns the **unscoped full-page
  roots** (`walk.ts:281`). Net effect: `-s "#typo-selector"` or a selector that
  matches nothing quietly returns the whole page instead of telling the
  caller their selector was wrong — a genuinely worse failure mode than
  source's (loud, actionable error) because the host agent has no signal that
  scoping was ignored.
- **Recommendation**: adopt source's fail-loud contract. In `walk.ts`, when
  `opts.selectorScope` is set: throw/surface a specific error if
  `DOM.querySelectorAll` matches 0 elements ("No element matched selector
  '...'") and a distinct error if the CDP call itself throws ("Invalid
  selector '...'"), instead of returning `null`/empty-set-then-silently-ignore.
  `handleSnapshot` (`core/handlers.ts:308`) should map that thrown error to a
  proper `fail(...)` envelope the same way it already does for other
  perception errors. Keyless, small, and closes a real "confidently wrong
  output" bug class.

### 5. [P2] `RoleNameTracker`/nth is conditional in source, unconditional in moxxie — likely harmless, verify downstream
- **Source**: `RoleNameTracker` (`snapshot.rs:185-214`) only assigns `Some(nth)`
  into the ref_map entry when the `role:name` key actually has duplicates
  (`get_duplicates()` filters `count > 1`, `snapshot.rs:395-402`); unique
  role/name pairs get `nth: None`.
- **Moxxie now**: `serialize.ts:77-95` always computes and stores `nth` on
  every `RefEntry`, duplicate or not (`nthCounts.get(key) ?? 0`, always used).
- **Recommendation**: skip-cargo-cult / no functional gap — storing `nth: 0`
  for a unique element is strictly more information than `None` and should
  resolve identically in `actuation/resolve.ts` (nth=0 matches the sole
  element either way). Flagging only so a reviewer confirms `resolve.ts`
  doesn't special-case "nth is absent" vs "nth is 0" in a way that diverges;
  read `actuation/resolve.ts` if this needs a real answer, but based on the
  ref-entry shape alone this is not worth changing.

### 6. [P2] Moxxie's hidden-element pruning (opacity/visibility) is an improvement over source, not a gap — keep it
- **Source**: `find_cursor_interactive_elements`'s in-page JS (`snapshot.rs:637-715`)
  only ever *adds* cursor-interactive elements; it has no separate
  visibility/opacity pruning pass — reliance is entirely on Chrome's own AX
  `ignored` flag to drop hidden nodes.
- **Moxxie now**: `SCAN_JS` (`walk.ts:381-438`) additionally computes
  `isHidden = style.visibility === 'hidden' || style.opacity === '0'` and
  prunes those nodes unless they're a radio/checkbox exception
  (`walk.ts:196-197`, `keepException`). Chrome's AX tree does NOT always mark
  `opacity:0` elements as `ignored` (only `display:none`/`visibility:hidden`
  reliably are), so this closes a real fidelity hole source itself has
  (opacity-0 decoy elements leaking into the snapshot).
- **Recommendation**: skip-cargo-cult (in reverse) — no change needed; noting
  it so a future "align moxxie to source" pass doesn't regress this by
  reverting to source's narrower behavior.

### 7. [P2] Source's `options.urls` on-demand live-resolution vs moxxie's always-on static-attribute read
- **Source**: url resolution is opt-in (`--urls` flag) and, when on, pays for
  two extra CDP round trips per ref-bearing `link` node (`DOM.resolveNode` +
  `Runtime.callFunctionOn`) — a deliberate cost/fidelity tradeoff gated behind
  a flag (`snapshot.rs:431-497`).
- **Moxxie now**: computes `snap.url` unconditionally for *every* node
  carrying an `href` attribute regardless of role or ref-eligibility
  (`walk.ts:250-251`), with no flag to disable it. This is cheap (no extra CDP
  calls, since attrs are already collected from `DOM.getDocument`) so keeping
  it always-on is reasonable and arguably better UX (no flag to remember) —
  but it does mean non-link elements with stray `href`-like attributes (rare,
  but e.g. SVG `<a xlink:href>` wrappers picked up as `link` role, or any
  future custom element misusing the attribute) get a `url=` shown even when
  not ref-eligible, which is harmless noise today.
- **Recommendation**: adopt-partial — no flag needed (keeping it always-on is
  fine and simpler), but pair with finding #3's base-URL fix so the
  always-on behavior is also always-correct. No priority beyond that; this
  entry exists to document the deliberate scope difference for future
  readers, not because it needs code change beyond #3.

## Summary table

| # | Finding | keyless_ok | priority | recommendation |
|---|---|---|---|---|
| 1 | Iframe recursion/splice missing | yes | P0 | adopt |
| 2 | StaticText run-aggregation/dedup missing | yes | P0 | adopt |
| 3 | `cleanUrl` has no base URL, relative hrefs unresolved | yes | P1 | adopt |
| 4 | Selector-scope failure silently ignored instead of erroring | yes | P1 | adopt |
| 5 | Unconditional `nth` vs conditional `Some(nth)` | yes | P2 | skip-cargo-cult (verify only) |
| 6 | Moxxie's opacity/visibility pruning beyond source | yes | P2 | skip-cargo-cult (keep, don't revert) |
| 7 | Always-on url attr read vs source's opt-in live resolve | yes | P2 | adopt-partial (folds into #3) |

## Top recommendation

Fix #1 (iframe recursion/splice) first — it's the highest-leverage gap because
the ref-eligibility plumbing for `Iframe` nodes is already copied from source
(`roles.ts:36`), so moxxie currently mints refs that point at nothing,
actively misleading the host agent into thinking iframe content is reachable
when it silently isn't. This blocks entire classes of real tasks (payment
forms, embedded auth, chat widgets) that agent-browser can already handle.
