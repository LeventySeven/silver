# Round 2 — browser-use: DOM + Accessibility Serialization / Indexed-Element System

Repo: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/browser-use`
License: MIT (Copyright (c) 2024 Gregor Zunic) — see `LICENSE`

## Killer Insight

browser-use does **not** inject a `buildDomTree.js` script anymore (no JS files exist under `dom/` — confirmed via `find . -iname '*.js'` returning nothing under the dom tree). The current architecture is 100% CDP-driven Python: it fires three parallel CDP calls per step — `DOMSnapshot.captureSnapshot` (layout/paint/computed-style data), `DOM.getDocument(depth=-1, pierce=True)` (full DOM incl. shadow roots), and `Accessibility.getFullAXTree` per frame (merged across all frames) — then joins all three by `backendNodeId` into one `EnhancedDOMTreeNode` tree (`browser_use/dom/service.py:722-1018`, `_construct_enhanced_node`). Interactivity is decided by a giant heuristic cascade (`ClickableElementDetector.is_interactive`, `browser_use/dom/serializer/clickable_elements.py`) that layers: JS click-listener detection via `getEventListeners()` injected through `Runtime.evaluate` (`service.py:453-544`), native interactive tags, ARIA roles/properties, cursor:pointer fallback, icon-sized-element heuristics, and search-icon class/id sniffing. The **selector-map key the LLM outputs as an element index is the CDP `backendNodeId` itself** — not a synthetic sequential counter (`serializer.py:713`: `self._selector_map[node.original_node.backend_node_id] = node.original_node`). This is architecturally different from the `@eN` synthetic-ref approach or older browser-use `highlight_index` schemes: there is no separate ID space to keep in sync, the ID is stable across DOM diffs as long as Chrome doesn't recycle the backend node, and lookups are O(1) dict access (`browser_session.get_dom_element_by_index` → `self._cached_selector_map[index]`, `browser_use/browser/session.py:2386-2401`).

## Exact Command Surface / API (verbatim)

CDP calls used to build the tree (`browser_use/dom/service.py`):
```python
# service.py:547-557 — snapshot with paint order + rects, no text-color-opacity/background-blend
cdp_session.cdp_client.send.DOMSnapshot.captureSnapshot(
    params={
        'computedStyles': REQUIRED_COMPUTED_STYLES,
        'includePaintOrder': True,
        'includeDOMRects': True,
        'includeBlendedBackgroundColors': False,
        'includeTextColorOpacities': False,
    },
    session_id=cdp_session.session_id,
)

# service.py:559-562 — full DOM, pierce shadow roots/iframes
cdp_session.cdp_client.send.DOM.getDocument(
    params={'depth': -1, 'pierce': True}, session_id=cdp_session.session_id
)

# service.py:369-372 — per-frame AX tree, merged across all frames (frame IDs from Page.getFrameTree)
cdp_session.cdp_client.send.Accessibility.getFullAXTree(
    params={'frameId': frame_id}, session_id=cdp_session.session_id
)

# service.py:218 — layout metrics for viewport/DPR calc (uses cssVisualViewport, NOT device px)
cdp_session.cdp_client.send.Page.getLayoutMetrics(session_id=cdp_session.session_id)
```

JS click-listener detection (devtools-only API, requires `includeCommandLineAPI: True`), `service.py:455-492`:
```python
await cdp_session.cdp_client.send.Runtime.evaluate(
    params={
        'expression': """
        (() => {
            if (typeof getEventListeners !== 'function') return null;
            const allElements = document.querySelectorAll('*');
            if (allElements.length > 10000) return null;  // bail on heavy pages
            const elementsWithListeners = [];
            for (const el of allElements) {
                try {
                    const listeners = getEventListeners(el);
                    if (listeners.click || listeners.mousedown || listeners.mouseup ||
                        listeners.pointerdown || listeners.pointerup) {
                        elementsWithListeners.push(el);
                    }
                } catch (e) {}
            }
            return elementsWithListeners;
        })()
        """,
        'includeCommandLineAPI': True,
        'returnByValue': False,
    },
    session_id=cdp_session.session_id,
)
# then Runtime.getProperties on the returned objectId, then DOM.describeNode per element
# to resolve backendNodeId, batched via asyncio.gather (service.py:497-530)
```

Timeout/retry pattern for the 4 parallel CDP fetches (`service.py:564-622`): `asyncio.wait(tasks.values(), timeout=10.0)`, cancel pending, retry once with `timeout=2.0`, then raise `TimeoutError` if anything is still missing — no silent partial state.

Public entry points:
```python
DomService(browser_session, logger=None, cross_origin_iframes=False, paint_order_filtering=True,
           max_iframes=100, max_iframe_depth=5, viewport_threshold=1000)   # service.py:46-55

await dom_service.get_dom_tree(target_id, all_frames=None, ...) \
    -> tuple[EnhancedDOMTreeNode, dict[str, float]]                       # service.py:671-1047

await dom_service.get_serialized_dom_tree(previous_cached_state=None) \
    -> tuple[SerializedDOMState, EnhancedDOMTreeNode, dict[str, float]]   # service.py:1050-1104

DomService.detect_pagination_buttons(selector_map: dict[int, EnhancedDOMTreeNode]) \
    -> list[dict[str, str|int|bool]]                                      # service.py:1106-1182
```

Serializer entry point:
```python
DOMTreeSerializer(
    root_node: EnhancedDOMTreeNode,
    previous_cached_state: SerializedDOMState | None = None,
    enable_bbox_filtering: bool = True,
    containment_threshold: float | None = None,   # default 0.99 (serializer.py:57)
    paint_order_filtering: bool = True,
    session_id: str | None = None,
).serialize_accessible_elements() -> tuple[SerializedDOMState, dict[str, float]]   # serializer.py:59-148

# static, produces the actual string the LLM sees
DOMTreeSerializer.serialize_tree(node: SimplifiedNode|None, include_attributes: list[str], depth=0) -> str  # serializer.py:882
```

Index → element resolution (what an agent-browser CLI must replicate for `click <id>` / `type <id> "text"`):
```python
# browser_use/browser/session.py:2386-2401
async def get_dom_element_by_index(self, index: int) -> EnhancedDOMTreeNode | None:
    if self._cached_selector_map and index in self._cached_selector_map:
        return self._cached_selector_map[index]
    return None

# browser_use/browser/session.py:2414-2416
async def get_element_by_index(self, index: int) -> EnhancedDOMTreeNode | None:
    return await self.get_dom_element_by_index(index)  # alias
```
`_cached_selector_map` is refreshed each step from `dom_watchdog.py:660`: `self.browser_session.update_cached_selector_map(self.selector_map)`.

`DOMSelectorMap = dict[int, EnhancedDOMTreeNode]` (`browser_use/dom/views.py:913`) — **key is `backend_node_id`**, confirmed at the write site: `serializer.py:713`:
```python
self._selector_map[node.original_node.backend_node_id] = node.original_node
```

Serialized line formats emitted by `serialize_tree` (`serializer.py:1000-1020`):
- Interactive element: `{tabs}{shadow_prefix}{'*' if new else ''}[{backend_node_id}]<tag attr1=val1 attr2=val2 />`
- Interactive + scrollable: same but `|scroll element[{backend_node_id}]<tag ... />`
- Scrollable, non-interactive: `{tabs}|scroll element|<tag ... /> (scroll_info_text)`
- Iframe (non-interactive container): `{tabs}|IFRAME|<iframe ... />` / `|FRAME|<frame ... />`
- SVG (children always collapsed): `{tabs}{shadow_prefix}{'*'}[{backend_node_id}]<svg attrs /> <!-- SVG content collapsed -->`
- Shadow DOM boundary markers: `Open Shadow` / `Closed Shadow` ... `Shadow End` (serializer.py:1030-1047)
- Hidden-below-viewport hint for iframes with known interactive elements (serializer.py:1074-1083):
  `... (N more elements below - scroll to reveal):` then `    <tag> "text" ~P pages down` per element.
- `*` prefix marks an element newly appeared vs `previous_cached_state.selector_map` (diffing across steps) — `serializer.py:709-723`.

`DEFAULT_INCLUDE_ATTRIBUTES` (`browser_use/dom/views.py:18-70`, partial, defines exactly which attrs get serialized into the `<tag k=v />` line): `title, type, checked, id, name, role, value, placeholder, data-date-format, alt, aria-label, aria-expanded, data-state, aria-checked, aria-valuemin, aria-valuemax, aria-valuenow, aria-placeholder, pattern, min, max, minlength, maxlength, step, accept, multiple, inputmode, autocomplete, aria-autocomplete, list, data-mask, data-inputmask, data-datepicker, format, expected_format, contenteditable, pseudo, ...` (class is explicitly commented out to save tokens).

## Patterns

1. **backendNodeId-as-index** (tier: core) — What: use the browser's own stable CDP node identity as the agent-facing element handle instead of minting a synthetic sequential/ref ID. How: after building the interactive-element set, `selector_map[backend_node_id] = node`; the LLM is told to reference elements by that same integer printed in `[N]` in the serialized tree; resolution is a dict lookup, no XPath/CSS re-query needed, and it survives partial re-serialization because Chrome doesn't renumber backend IDs on incremental DOM changes (only true page reload changes them). Evidence: `browser_use/dom/serializer/serializer.py:713`, `browser_use/browser/session.py:2386-2401`. This is the single most portable idea for a CLI's `@eN`/index scheme — consider mapping `@eN` → backendNodeId directly, skip an extra ID table.

2. **Three-tree fusion, one node type** (tier: core) — What: fuse `DOM.getDocument`, `DOMSnapshot.captureSnapshot`, and `Accessibility.getFullAXTree` into a single `EnhancedDOMTreeNode` dataclass carrying `attributes`, `snapshot_node` (bounds/computed styles/paint order/cursor), and `ax_node` (role/name/properties) together. How: build an `ax_tree_lookup: dict[backendDOMNodeId, AXNode]` and a `snapshot_lookup: dict[backendNodeId, EnhancedSnapshotNode]` up front (`service.py:709-719`, `enhanced_snapshot.py:build_snapshot_lookup`), then walk `DOM.getDocument`'s node tree recursively, joining both lookups by `backendNodeId` at each node (`service.py:722-1018`). Evidence: `browser_use/dom/service.py:707-719`, `browser_use/dom/views.py:373-459`. Reimplement as: single CDP session, 3 concurrent calls, join by backendNodeId, one struct downstream — avoids re-querying the DOM per element.

3. **Interactivity heuristic cascade with JS-listener augmentation** (tier: core) — What: a layered `is_interactive()` classifier that doesn't rely solely on tag/role — it also detects framework event handlers (`@click`, `onClick`, `(click)`) via `getEventListeners()` executed in DevTools context, so React/Vue/Angular custom widgets with no semantic HTML are still exposed as clickable. How: exact precedence order in `clickable_elements.py`: (1) `has_js_click_listener` short-circuits true; (2) large-enough IFRAME/FRAME (>100x100px); (3) `<label>`/`<span>` wrapper-of-form-control detection up to depth 2 (`has_form_control_descendant`); (4) search-icon class/id/data-attr sniffing; (5) AX property signals (`disabled`/`hidden` short-circuit false, `focusable`/`editable`/`settable`/`checked`/`expanded`/`pressed`/`selected`/`required`/`autocomplete`/`keyshortcuts` → true); (6) native interactive tag set `{button,input,select,textarea,a,details,summary,option,optgroup}`; (7) `onclick`/`onmousedown`/etc attribute or `tabindex` presence; (8) ARIA `role` in an explicit interactive-roles set (both HTML attr and AX role checked separately); (9) icon-sized element (10-50px both dims) + one of `{class,role,onclick,data-action,aria-label}`; (10) final fallback `cursor_style == 'pointer'`. Evidence: `browser_use/dom/serializer/clickable_elements.py:1-247`.

4. **Two-phase viewport visibility with iframe-chain coordinate translation** (tier: important) — What: visibility isn't a single CSS check; it walks the full chain of ancestor `<iframe>`/`<html>` frame nodes, translating bounds by each iframe's offset and subtracting scroll, then does a threshold-relaxed intersection test against each frame's own viewport (default `viewport_threshold=1000px`, i.e. elements up to 1000px below the fold still count "visible" so scroll-to-reveal isn't required for near-viewport elements). How: `is_element_visible_according_to_all_parents(node, html_frames, viewport_threshold)` — CSS check first (`display:none`/`visibility:hidden`/`opacity<=0` → false), then `for frame in reversed(html_frames)`: adjust `current_bounds` by iframe bounds offset, and for HTML frame nodes compute `frame_intersects` using `viewport_bottom + viewport_threshold` / `viewport_top - viewport_threshold` slack. Evidence: `browser_use/dom/service.py:242-345`.

5. **Bounding-box "propagating parent" child suppression** (tier: important) — What: to avoid serializing every inner `<span>`/`<svg>`/text node inside a `<button>` or `<a>` as separate noise, elements matching a `PROPAGATING_ELEMENTS` pattern list (`a`, `button`, `div[role=button|combobox]`, `span[role=button|combobox]`, `input[role=combobox]`) "own" their descendants: any descendant ≥99% contained in the parent's bounds gets `excluded_by_parent = True` and is collapsed out of the tree (children still recurse into `serialize_tree` and re-parent their own children if not excluded). Exceptions preserved even if contained: form elements (`input/select/textarea/label`), other propagating elements, elements with `onclick`, elements with meaningful `aria-label`, elements with independently-interactive roles (`button/link/checkbox/radio/tab/menuitem/option`). Evidence: `browser_use/dom/serializer/serializer.py:44-57, 746-838`.

6. **Paint-order occlusion filtering** (tier: important) — What: elements fully covered by a later-painted, non-transparent sibling (e.g. a modal overlay covering the page behind it) are excluded from the interactive set even though they're technically "visible" by CSS, using an actual rectangle-union algorithm over paint order, not just z-index. How: `PaintOrderRemover(simplified_tree).calculate_paint_order()` runs after tree simplification and before optimization (`serializer.py:117-122`); backed by `RectUnionPure`, a disjoint-rectangle-set structure with a `_MAX_RECTS = 5000` safety cap that conservatively stops excluding once pages get too complex (fail-open, never over-hide). Evidence: `browser_use/dom/serializer/paint_order.py:1-50` (class + cap), invocation at `serializer.py:117-122`.

7. **Compound-control synthetic children** (tier: nice) — What: native controls that are actually multiple sub-widgets (date/number/range/color/file inputs, `<select>`, `<details>`, `<audio>`/`<video>`) get synthetic `_compound_children` describing their parts (e.g. number input → Increment/Decrement buttons + Value textbox with min/max), rendered into the attribute string as `compound_components=(role=...,name=...,min=...,...)`. This gives the LLM sub-affordances without needing separate DOM nodes/indices for each. Evidence: `browser_use/dom/serializer/serializer.py:150-333, 953-987`.

8. **Format hints injected as synthetic attributes for date/time/masked inputs** (tier: nice) — What: HTML5 `date`/`time`/`datetime-local`/`month`/`week` inputs get a synthetic `format=YYYY-MM-DD` (etc.) attribute injected purely for the LLM's benefit (never sent to the page), because the displayed locale format ≠ the required `.value` format; jQuery/Bootstrap/AngularJS UI datepicker inputs get format sniffed from `uib-datepicker-popup` / `data-date-format` / class-name heuristics. Evidence: `browser_use/dom/serializer/serializer.py:1102-1177`.

9. **Password-value redaction at the serialization boundary** (tier: important, security) — What: `value`/`valuetext` AX properties are explicitly dropped for `<input type=password>` before ever reaching the string the LLM sees — prevents secret exfiltration via prompt injection reading DOM snapshots. Evidence: `browser_use/dom/serializer/serializer.py:1178-1225` (comment: "must not leak into DOM snapshots sent to the LLM, where prompt injection could exfiltrate them").

10. **Hidden-below-viewport interactive-element hints per iframe** (tier: nice) — What: rather than silently omitting off-screen interactive elements inside iframes, the tree collects up to 10 of them (sorted by distance) and renders a hint line with tag/label/pages-to-scroll so the LLM knows to scroll instead of assuming the iframe is empty. Evidence: `browser_use/dom/service.py:70-182` (`_count_hidden_elements_in_iframes`), rendered at `serializer.py:1068-1083`.

11. **Cross-origin iframe target-hopping via `frameId`→`targetId` resolution with URL-match fallback** (tier: nice) — What: when a same-process CDP walk hits a cross-origin iframe (no `contentDocument` in `DOM.getDocument`), it looks up the iframe's own CDP `TargetID` via a pre-fetched `all_frames` map and recursively calls `get_dom_tree` on that target, merging the resulting subtree back in — with a fallback that matches by `src` URL if `frameId` isn't yet registered (handles late-injected widgets like chat popups). Evidence: `browser_use/dom/service.py:922-1017`. Gated behind `cross_origin_iframes: bool` (default False) and `max_iframe_depth` (default 5) to bound recursion.

## Reusable code (fork candidates)

- `browser_use/dom/serializer/clickable_elements.py` (246 lines) — the entire `ClickableElementDetector.is_interactive` heuristic cascade is a self-contained, dependency-light function (only needs the node's tag/attributes/ax properties/snapshot bounds). Directly portable to any DOM-diffing agent CLI.
- `browser_use/dom/serializer/paint_order.py` — `RectUnionPure`/`Rect` occlusion algorithm, pure-Python, no external deps, capped for safety. Good drop-in for "don't index elements hidden behind a modal."
- `browser_use/dom/service.py:242-345` (`is_element_visible_according_to_all_parents`) — iframe-chain-aware visibility check with a configurable viewport slack threshold; reusable as-is if you also drive via CDP snapshot bounds + scrollRects.
- `browser_use/dom/service.py:453-544` (JS click-listener detection via `getEventListeners()` + batched `DOM.describeNode`) — a clever CDP trick for catching framework-only interactivity without DOM mutation; worth forking verbatim including the `>10000 elements` heavy-page bailout.
- `browser_use/dom/views.py:18-70` (`DEFAULT_INCLUDE_ATTRIBUTES`) — a curated, token-conscious attribute allowlist tuned over real usage (comments explain *why* `class` is excluded, why validation attrs like `pattern`/`min`/`max` are included "to help agents avoid brute force attempts"). Worth copying as a starting default list.
- `browser_use/dom/service.py:1106-1182` (`detect_pagination_buttons`) — multi-locale (en/es/fr/de/nl) prev/next/first/last button detector over the selector map; reusable heuristic for any "go to next page" tool action.

## Anti-patterns

- **Re-fetches/recomputes CDP session per node during tree construction**: `_construct_enhanced_node` calls `self.browser_session.get_or_create_cdp_session(target_id, focus=False)` inside the per-node recursive constructor (`service.py:804-809`) — even though the session is almost always already cached, this is an avoidable await-per-node in a function invoked for every single DOM node on the page. A forked implementation should hoist this once outside the recursion.
- **Comment-documented but literally dead code path**: `# if ax_node and node.ax_node.ignored: return False` is commented out in `clickable_elements.py:31-33` — the AX "ignored" signal is computed (`enhanced_ax_node.ignored` field exists, `service.py:184-210`) but never actually consulted for interactivity filtering. Same for the SVG-interactivity block (`clickable_elements.py:154-172`, fully commented out) — SVG interactivity is instead handled entirely by the generic heuristics above it, but the dead code suggests an abandoned, more precise design that a fork could resurrect and test.
- **Heuristic cascade has no test-derivable confidence score**: `is_interactive` is a boolean cascade of ~10 independent heuristics with no scoring/ranking — a single false-positive heuristic (e.g. the icon-sized-element check at `clickable_elements.py:229-240`, which fires on any 10-50px element with a `class` or `aria-label` attribute) can't be tuned down without touching the whole function. A fork should consider an explicit weighted-scoring version instead of first-match-wins boolean OR chains.
- **`js_click_listener_backend_ids` detection is silently skipped above 10,000 elements** with no fallback strategy or partial-sampling (`service.py:467-469`) — large SPA pages lose this signal entirely rather than degrading gracefully (e.g. sampling only the viewport-visible subset).

## License

MIT License, Copyright (c) 2024 Gregor Zunic — full permissive reuse/fork/adapt with attribution (`LICENSE` at repo root).
