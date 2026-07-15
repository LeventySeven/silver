# Perplexity Computer / Comet — pixel-vision vs a11y-tree lens on moxxie

Source: `/Users/seventyleven/Desktop/researchfms/teardowns/PERPLEXITY_COMPUTER.md`
Moxxie read: `skill/agent-browser/src/perception/{walk,serialize,diff,refmap,accessible-name,roles}.ts`,
`skill/agent-browser/src/core/handlers.ts`

## What the source actually does (Comet browser sub-agent, lines ~3055-3150)

Comet exposes a **dual-mode interaction model** across two tools:
- `computer` — `left_click|right_click|double_click|type|key|scroll|screenshot`, dispatched via raw
  `[x, y]` pixel coordinates (source line 3062-3068). Every `screenshot` action returns the
  post-action page state, and a completed `left_click` renders "a small blue dot at click location
  in screenshot" — a visual self-verification affordance for the model.
- `read_page` — `Accessibility.getFullAXTree` → YAML a11y tree with `ref_N` handles, params
  `depth` (default 15), `filter: interactive|all`, and `ref_id` to scope traversal to one
  element's children (line 3070-3079).
- `find` — natural-language query → up to 20 matching elements, each returned with **both** a
  `ref` and pixel **coordinates** (line 3082-3086) — the bridge between vision-space and
  a11y-space.

The system prompt states the gating rule verbatim (line 3144-3147):

> "Operate via x,y coordinates when target elements are present in latest screenshot. When
> elements are NOT present in the last screenshot, use the `read_page` tool to retrieve
> references to DOM elements... Comet avoids repeatedly scrolling down the page to read long
> web pages, instead uses `get_page_text` and `read_page` to efficiently read the content."

Reading between those two rules: **the a11y tree (`read_page`/`get_page_text`) is the default,
cheap path; pixel/vision (`computer` coordinates) is the fallback path used specifically when
the target is visually present but not addressable through the AX tree** (canvas/WebGL widgets,
custom-drawn controls, elements outside the last screenshot's known ref set). Screenshot-per-
action is NOT the default loop — it's invoked opportunistically.

## Moxxie's current behavior (read from source)

- `perception/walk.ts` builds a flat a11y-tree snapshot via CDP `Accessibility.getFullAXTree`
  joined to DOM attrs, with a cursor-interactive cascade layered on top (`walk.ts:1-27`,
  `SCAN_JS` at `walk.ts:381-438`) — this is moxxie's only "sees the page" primitive besides raw
  screenshot bytes.
- `refmap.ts` mints grounded `eN` refs keyed to `{generation, backendNodeId, role, name, nth}`
  (`refmap.ts:12-25`) — **no bounding box / coordinates are ever captured or stored**.
- `serialize.ts` renders role/name/flags/url per line — again, **no x/y/width/height** anywhere
  in the line grammar (`formatLine`, `serialize.ts:186-214`).
- `core/handlers.ts::handleScreenshot` (`handlers.ts:372-381`) is a bare wrapper: only a `--full`
  (fullPage) flag and an optional output path. No element-scoped clip, no annotation, no
  post-action marker.
- `core/handlers.ts::handleAct` (`handlers.ts:387-...`) only accepts `@eN` refs pulled from the
  refmap — there is **no coordinate-based click/type verb anywhere in the CLI** (`grep` for
  `coordinate|mouse\.` in handlers.ts returns nothing beyond imports).
- `handleSnapshot`'s `selectorScope` option (`walk.ts:58-65`, `SnapshotOptions.selectorScope`)
  only accepts a **CSS selector** — there is no way to scope a re-walk to a previously-grounded
  `eN`'s subtree the way Comet's `read_page(ref_id=...)` does.
- `handleSkill`'s help text (`handlers.ts:858-879`) documents the `open → snapshot -i → act →
  re-snapshot` loop but never mentions `screenshot` or gives the host any guidance on *when*
  vision is the right call vs the a11y tree.

## Gap-alignment findings

1. **No pixel coordinates on refs — the vision/a11y bridge is missing entirely.** Comet's `find`
   returns ref *and* coordinates together so the host can correlate what it sees in a screenshot
   with what it can act on structurally. Moxxie's `RefEntry` (`refmap.ts:12-19`) carries no
   geometry at all, so a host that takes a screenshot to visually locate something (e.g. a
   canvas-drawn button) has no way to hand that location back to `act` in ref terms, and no way
   to check "is the thing I clicked in the screenshot the same as `e7`?". Fix: capture a box
   model per node during the walk (CDP `DOM.getBoxModel` on `backendNodeId`, already resolved in
   `walk.ts:204`) and store `{x,y,w,h}` on `RefEntry`; expose it as an optional `coords=` snapshot
   attribute and/or a `moxxie resolve @eN --coords` subcommand. This is the single highest-value
   change from this source. Priority P0, keyless (pure CDP geometry, no model call).

2. **No coordinate-based act fallback for non-AX-addressable UI.** Comet's `computer` tool
   dispatches raw `[x,y]` clicks specifically for elements that don't show up in `read_page`
   (canvas/WebGL apps, custom drag surfaces, map widgets, PDF viewers rendered as `<canvas>`).
   Moxxie's `handleAct` (`handlers.ts:387-446`) is 100% ref-based; there is no escape hatch when
   `snapshotNodes` legitimately returns nothing useful for the target (a `generic`/`canvas` node
   with no cursor-interactive tag and no AX role). Fix: add a `click-at <x> <y>` (and maybe
   `type-at`) verb that maps straight to Playwright `page.mouse.click(x,y)` / `page.mouse.type`,
   gated behind the existing `--enable-actions` registry (`security/registry.ts:31`) exactly like
   every other actor verb. Host does the vision reasoning (reads the screenshot, decides x/y);
   moxxie just executes the mechanical click. Priority P0, keyless.

3. **No element-scoped screenshot.** `handleScreenshot` (`handlers.ts:372-381`) only takes
   `--full` (viewport vs fullPage) — there's no way to clip to one element's bounding box.
   Comet doesn't have this either (its `computer screenshot` is always full-viewport), but given
   finding 1 gives moxxie box-model data for free, a `screenshot @eN` that clips via Playwright's
   `page.screenshot({clip})` is a cheap, purely mechanical add that reduces the image payload the
   host has to reason over when it only needs to visually verify one control (e.g. "does this
   checkbox actually look checked"). Priority P1, keyless.

4. **No `ref_id`-style subtree scoping — only CSS-selector scoping.** `SnapshotOptions.selectorScope`
   (`walk.ts:58-65`) requires the host to already know a CSS selector. Comet's `read_page(ref_id=...)`
   lets the host scope a re-walk to a node it already has a grounded reference to (e.g., after
   spotting a modal in a screenshot and grounding its container via one `find`/`snapshot` call, it
   drills in without guessing CSS). Fix: accept `--scope-ref e12` in `handleSnapshot`, resolve it
   through the current `RefMap` to a `backendNodeId`, and reuse the existing selector-scope
   machinery (`resolveSelectorScope`/`collectBackendIds` in `walk.ts:316-348`) rooted at that node
   instead of a CSS query. Priority P1, keyless.

5. **No vision-gating guidance in the skill help text.** Comet's system prompt states its
   coordinate-vs-ref decision rule explicitly (source line 3144-3147); moxxie's `handleSkill`
   short/full text (`handlers.ts:858-879`) documents the snapshot→act loop but says nothing about
   `screenshot` or when the host should reach for it. Since moxxie is keyless and the *host* does
   all visual reasoning, this is pure documentation, but it's a real behavioral gap: a host agent
   reading only `moxxie skill` today has no signal that vision is even an available fallback.
   Fix: add one or two sentences to the `full` skill text: "snapshot (a11y tree) is the default,
   cheap path; fall back to `screenshot` + the new `click-at`/`coords` primitives only when a
   target is visually present but has no ref (canvas, WebGL, custom-drawn widgets) — never
   screenshot on every step, that's the expensive path." Priority P1, keyless.

6. **No post-action visual marker for host self-verification.** Comet's `computer` tool overlays
   "a small blue dot at click location" on the screenshot returned right after a `left_click`, so
   the model can visually confirm the click landed where intended. Moxxie's `handleScreenshot`
   returns raw bytes with no annotation, and there's no linkage between "the last action's target
   coordinates" and a subsequent screenshot call. Fix (small, optional): thread the last acted
   ref/coordinate through session state (already tracked per-session, see `handlers.ts:73-75`) and
   let `screenshot --mark-last` draw a crosshair via a `page.evaluate` DOM overlay before
   capturing. Priority P2 (nice-to-have, not load-bearing), keyless.

7. **`get_page_text`-style "don't scroll to read" guidance is already satisfied — no change
   needed.** Comet's prompt explicitly discourages scroll-based reading in favor of
   `get_page_text`/`read_page` (source line 3144-3149). Moxxie already has this exact shape:
   `handleRead` (`handlers.ts:351-370`) returns `document.body.innerText` directly, and
   `handleSnapshot` gives the structured a11y view — neither requires scrolling. No action; flag
   as confirmed-aligned, not a gap.

8. **Skip-cargo-cult: screenshot-per-action as the default loop.** Comet's `computer` tool
   returns a fresh screenshot after every dispatched action, and macOS "Personal Computer" mode
   (source line 4049-4053) runs a full vision loop (screenshot → cloud multimodal model →
   coordinate dispatch) as its *primary* control path for arbitrary desktop apps, gated behind
   OS-level Screen Recording + Accessibility permissions. None of that belongs in moxxie: (a) the
   OS permission dance is desktop-agent surface, irrelevant to a browser CLI; (b) the "cloud
   multimodal model decides pixel coordinates" loop is by definition non-keyless (it requires a
   vision model call) and is exactly the shape moxxie's whole design (grounded refs + text diff,
   `diff.ts`) exists to avoid paying for on every step. Do not add a default screenshot-after-
   every-action mode; the diff-when-shorter text loop (`diff.ts:1-46`) is already the cheaper,
   keyless-correct default and should stay the default. Recommendation: skip-cargo-cult.

9. **Skip-cargo-cult: consolidating verbs into one multiplexed `computer` tool.** Comet bundles
   click/type/key/scroll/screenshot behind a single `computer` tool discriminated by an `action`
   field plus a mandatory `tab_id`. Moxxie's per-verb CLI commands (`click`, `fill`, `select`,
   etc., dispatched through `handleAct`'s `ActVerb` switch, `handlers.ts:387-446`) are already
   more ergonomic for a CLI/shell-driven host (composable, greppable, scriptable individually) and
   multi-tab isn't in scope the same way. No need to collapse them into one meta-tool just because
   Comet does. Recommendation: skip-cargo-cult.

## Top recommendation

Add bounding-box geometry to `RefEntry`/snapshot output (finding 1) plus a coordinate-based
`click-at` action verb (finding 2). Together these are the minimal keyless pair that actually
lets a host bridge "I see something in a screenshot" to "I can act on it precisely" — which is
the entire point of the vision/a11y tradeoff this source demonstrates. Everything else (scoped
screenshot, ref-scoped re-walk, help-text guidance, click marker) is incremental on top of that
one bridge.
