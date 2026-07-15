# Deep-dive: Vercel `agent-browser` perception/token-efficiency vs Silver

Scope: `native/snapshot.rs` (1607 lines, full read) — role-gated ref eligibility,
compact mode, depth cap, iframe splice, hidden-input promotion, diff snapshot —
compared byte-for-byte against Silver's `perception/walk.ts` (562 lines),
`perception/serialize.ts` (293 lines), `perception/roles.ts`, and
`perception/diff.ts` (174 lines), all read in full.

## 1. What makes Vercel's snapshot LEAN yet complete — the mechanism

Vercel's token-efficiency is a pure **snapshot-format** property (confirmed —
nothing here touches the daemon/connection layer), built from six independent
levers stacked on one CDP call (`Accessibility.getFullAXTree`, `snapshot.rs:313`):

1. **Three-tier role gating** (`snapshot.rs:11–66`, `369–391`). `INTERACTIVE_ROLES`
   (button/link/textbox/…) are ALWAYS ref-eligible. `CONTENT_ROLES`
   (heading/cell/listitem/…) are ref-eligible only when non-empty-named
   (`!node.name.is_empty()`, line 374) — this is the single biggest token saver:
   a page with 200 empty `<td>`s costs zero ref lines. `STRUCTURAL_ROLES`
   (generic/group/list/table/…) is declared (lines 45–66) but never actually
   checked in `should_ref` — it is *implicitly* excluded by falling through the
   `else { false }` branch (line 376). It exists as documentation/an allowlist
   contract, not runtime logic. Any role, including structural ones, still gets
   a ref if it is **cursor-interactive** (line 379–385) — this is the fourth,
   orthogonal gate that rescues `<div onclick>` fake-buttons the AX tree calls
   `generic`.

2. **Cursor-interactive cascade** (`find_cursor_interactive_elements`,
   `snapshot.rs:630–913`). One `Runtime.evaluate` walks `document.body
   .querySelectorAll('*')`, computing `getComputedStyle(el).cursor==='pointer'`,
   `onclick`, `tabindex!=-1`, `contenteditable`, size>0, and — critically — a
   **parent-inheritance filter** (lines 680–683): a node that merely inherits
   `cursor:pointer` from an ancestor (no own onclick/tabindex/editable) is
   dropped, so a `<nav>` wrapping 40 pointer-cursor links doesn't itself become
   a spurious ref. Matched elements get a throwaway `data-__ab-ci` tag for
   batch `backendNodeId` resolution via one `DOM.querySelectorAll` +
   parallel `DOM.describeNode` calls (lines 761–816), then the tag is stripped
   (lines 819–834). This entire scan is O(1) round trips regardless of element
   count.

3. **Hidden-input role promotion** (`promote_hidden_inputs`, `snapshot.rs:920–945`).
   The common `<label><input type="radio" hidden></label>` card-picker pattern
   makes Chrome drop the `<input>` from the AX tree entirely, leaving a
   `LabelText`/`generic` node with an EMPTY name. Vercel detects this via the
   cursor scan (which separately looks for a `display:none`/`visibility:hidden`
   `input[type=radio|checkbox]` descendant, lines 690–705) and **rewrites the
   AX node's role in place** to `radio`/`checkbox`, backfills the name from
   `textContent` if the AX name was empty, and sets `checked` from the input's
   real `.checked`/`.indeterminate` state (lines 935–943). Without this, a
   whole class of styled radio/checkbox UIs would render as unlabeled, unstated
   `generic` nodes — uncheckable by a host LLM reading the tree.

4. **StaticText aggregation + collapse** (`build_tree`, `snapshot.rs:999–1049`;
   `render_tree`, `1091–1100`). Continuous `StaticText` AX-tree siblings (an
   artifact of inline HTML formatting, not semantics) are merged into the first
   one (unbounded length, lines 1010–1039), and a StaticText child whose text
   exactly duplicates its parent's accessible name is cleared (lines 1043–1048).
   `render_tree` additionally collapses `generic` wrappers with ≤1 child and
   drops empty StaticText/RootWebArea/WebArea nodes, so 3–4 levels of `<div>`
   soup around one real control render as ONE line.

5. **Compact mode** (`compact_tree`, `snapshot.rs:1211–1248`). Post-render
   line filter: keep only lines containing `ref=` or a value (`": "`), plus
   every ancestor down to indent-0, walked backwards from each kept line
   (lines 1219–1233). This is a second, orthogonal compression pass on top of
   levers 1–4 — it strips *structural* container lines (nav/main/div wrappers)
   that carry no ref and no value, even if role-gating decided to render them
   for tree-shape context.

6. **`interactive` mode + `depth` cap** (`SnapshotOptions`, line 77–84):
   `interactive` renders only ref-bearing nodes but still recurses through
   non-ref ancestors to reach them (`render_tree:1118–1124`); `depth` hard-cuts
   indentation past N (`1102–1106`).

**Diff-when-changed** (`diff.rs:103–148`) is a SEPARATE lever from the
snapshot format itself: `diff_snapshots` runs `similar`'s Myers line-diff,
fast-paths identical strings (lines 108–117, `before==after` returns unchanged
count without constructing a `TextDiff`), and emits a git-style unified diff
(`context_radius(3)`, lines 135–138) with additions/removals/unchanged counts.
Notably, `diff.rs` does NOT itself choose between "diff" and "full tree" by
size — that selection, if it exists, lives outside this file (not found in
`snapshot.rs`/`diff.rs`; `top5-vercel.md:71-90` already documents this and
Silver's independent superset, see §3).

## 2. Why this beats Stagehand/browser-use/AgentQL (context, not re-litigated)

Stagehand and browser-use both emit raw/lightly-filtered DOM or AX subtrees
with per-element numeric indices and no name-emptiness gating, no cursor
cascade, no hidden-input promotion — their snapshots are longer per page and
miss `<div onclick>` and card-radio patterns entirely unless a site happens to
use real `<button>`/`<input>` tags. AgentQL is schema/query-driven (asks the
model to describe a target, then finds it), not a full-page-tree emitter, so
it isn't directly comparable on "tokens per full snapshot." Vercel's gating
scheme is the most token-disciplined of the five sources on a like-for-like
full-tree emit, which is exactly why Silver's role.ts/walk.ts synthesis
targeted it as the reference grammar.

## 3. Byte-for-byte comparison: Silver's `walk.ts`/`serialize.ts`/`diff.ts`

**Matched, verified line-for-line:**
- Role gating: `roles.ts` copies `INTERACTIVE_ROLES`/`CONTENT_ROLES`/
  `STRUCTURAL_ROLES` verbatim from `snapshot.rs:11–66` (own docstring says so).
  `walk.ts:310–312` computes `refEligible = isInteractive || (isContent &&
  name!=='') || cursorInteractive` — same three-gate logic; `STRUCTURAL_ROLES`
  is imported nowhere in `walk.ts` (grep-confirmed), exactly mirroring Vercel's
  "declared but never checked, implicit via else-false" pattern. This is a
  faithful, not accidental, port.
- Cursor cascade: `SCAN_JS` (`walk.ts:498–555`) is a near-identical
  transliteration of Vercel's in-page JS (same interactiveTags/interactiveRoles
  maps, same parent-inheritance-pointer skip at `walk.ts:526–529`, same
  `data-__uab-idx` tag-and-cleanup pattern).
- StaticText/generic collapse: `serialize.ts:164–171` skip rule (`generic` with
  ≤1 child and no ref, empty StaticText, Root/WebArea) matches
  `snapshot.rs:1091–1100` exactly, including the RootWebArea/WebArea
  child-promotion behavior.
- Compact mode: `serialize.ts:270–287` `compact()` is a faithful line-for-line
  port of `compact_tree` (`ref=`/`": "` keep-test, backward ancestor walk,
  break at indent 0) — same algorithm, same edge case handling (radio/checkbox
  attribute-before-ref case is structurally identical since both check
  substring `"ref="` not a prefix).
- Diff: `diff.ts` independently reimplements Myers (hand-rolled O(ND), no
  `similar`-crate equivalent needed) AND additionally picks the shorter of
  {diff, full tree} (`diff.ts:44`) plus a `NO_CHANGES` sentinel on an identical
  re-snapshot (`diff.ts:35–37`) — `top5-vercel.md:90–92` already flags this as
  "arguably smarter than Vercel's unconditional diff-emit." Confirmed on read;
  no further action needed here.
- Iframe splice: Silver's approach (`walk.ts:333–339`, splice child-frame nodes
  directly into the SAME flat list at `level+1` during the DFS) is structurally
  cleaner than Vercel's approach (`snapshot.rs:511–578`, which renders the
  child snapshot as a separate string then string-searches for the `[ref=...]`
  marker text and re-indents by counting leading spaces, lines 549–576). Same
  outcome, but Silver's is not fragile to marker-text collisions; a strict
  improvement, not a gap.

## 4. CONCRETE GAP — hidden-input role promotion is collected but never applied

**This is the one real functional gap found.** `walk.ts`'s `SCAN_JS` collects
`hiddenInputType`/`hiddenInputChecked` per cursor-interactive element
(`walk.ts:539–546`, faithfully ported from Vercel's same detection at
`snapshot.rs:690–705`) and threads it all the way into the `CursorInfo` map
(`walk.ts:130–139`, `191–197`). But **nothing in `visit()` ever reads
`cursorInfo.hiddenInputType`/`hiddenInputChecked` to rewrite `role` or set
`flags.checked`.** Grep-confirmed: `hiddenInputType`/`hiddenInputChecked`
appear only in the scan/collection code (`walk.ts:130,131,138,139,195,196,513,
543,544,551`) — never read back out in the `visit()` function that builds
`SnapNode.role`/`SnapNode.flags`. Vercel's `promote_hidden_inputs`
(`snapshot.rs:920–945`) is the missing counterpart: Silver has no equivalent
call site anywhere in `perception/*.ts` (grep for `promote`/`LabelText` in
`silver/src/perception/` returns only the `roles.ts` docstring mention of
`LabelText`, never a promotion implementation).

**Concrete failure scenario.** A checkout page with `<label class="card">
<input type="radio" name="shipping" hidden> Standard shipping</label>` styled
radio cards: on this pattern, Chrome's AX tree drops the `<input>` and leaves
an unnamed `LabelText`/`generic` node. Vercel's snapshot shows
`- radio "Standard shipping" [checked=false, ref=e7]` — clickable, stateful,
correctly named. Silver's snapshot today shows either nothing (if `generic`
with ≤1 child and no ref gets structurally collapsed per `serialize.ts:169`)
or an unnamed, unstated node with `cursorInteractive=true` but role still
`LabelText`/`generic` and no `checked` flag — the host LLM cannot tell which
option is selected, and `ref` resolution/click still works but the click
target's *semantics* (is this the currently-checked option?) are invisible.
This is a correctness/completeness regression versus Vercel on a common
e-commerce/form UI pattern, not merely a style nit.

**Adopt recommendation: KEYLESS, PRIORITY = HIGH.** Purely mechanical, no
model calls: add a `promoteHiddenInputs(nodes, cursorByBackend)` pass in
`walk.ts` (or inline in `visit()`) mirroring `snapshot.rs:920–945` — when a
node's role is `LabelText` or `generic` AND its `cursorInfo.hiddenInputType`
is `radio`/`checkbox`, overwrite `role` to that type, backfill `name` from
`cursorInfo.text` if empty, and set `flags.checked` from
`hiddenInputChecked` (`'mixed'`/`true`/`false`, same tri-state as Vercel).
Since the data is already threaded through, this is a ~15–20 line addition
with no new CDP round trips and no test-surface risk beyond the existing
cursor-cascade fixtures. This should ship before any further engine-latency
work, since it is a page-class correctness gap (checkout/onboarding radio
cards), not a nice-to-have.

## 5. Minor secondary note (LOW priority, not a gap): text-leaf cap vs unbounded aggregation

Vercel's StaticText aggregation (`snapshot.rs:999–1049`) merges an UNBOUNDED
run of continuous StaticText siblings into the first one. Silver's
`mergeTextLeaves` (`serialize.ts:209–231`) folds at most 3 leaf children into
an unnamed parent's display name and truncates the joined string to 100 chars
(`serialize.ts:229`) — this is a different mechanism (folding into the
non-text PARENT line, which Vercel does not do; Vercel only merges among
StaticText nodes themselves) that is more aggressive at collapsing structure
but silently drops text beyond the 3-leaf/100-char cap. This sits in tension
with the module's own "never truncate" framing (`serialize.ts:11`, which is
about the overall `maxChars` cap, not this local fold) — worth a one-line
docstring clarification or a widening of the cap, but not a functional gap
since `serialize.ts` doesn't drop UNMERGED sibling lines, only the folded
display-name preview; the full StaticText leaf still exists as a discrete
`renderNode` skip-and-recurse would show it if not absorbed. Priority: LOW,
documentation/tuning only.

## Summary table

| Lever | Vercel (`snapshot.rs`) | Silver (`walk.ts`/`serialize.ts`) | Verdict |
|---|---|---|---|
| 3-tier role gating | 11–66, 369–391 | `roles.ts` + `walk.ts:310–312` | Matched, byte-faithful |
| Cursor-interactive cascade | 630–913 | `walk.ts:498–555` | Matched, byte-faithful |
| Hidden-input role promotion | 920–945 | data collected, never applied | **GAP — HIGH priority, keyless fix** |
| StaticText aggregate/collapse | 999–1049, 1091–1100 | `serialize.ts:164–231` | Different mechanism, net equal-or-better, unbounded-vs-capped noted (LOW) |
| Compact mode | 1211–1248 | `serialize.ts:270–287` | Matched, byte-faithful |
| Iframe splice | 511–578 (string-search) | `walk.ts:333–339` (structural) | Silver stronger |
| Diff snapshot | `diff.rs:103–148` | `diff.ts` (Myers + shorter-of + sentinel) | Silver stronger (already documented in top5-vercel.md) |
