# Aside Snapshot Builder vs moxxie perception/ — gap alignment

Source: `researchfms/teardowns/_aside_parts/91_snapshot_builder.md` (KNOWN, carved from Aside daemon binary), `40_perception.md`.
Moxxie: `moxxie/skill/agent-browser/src/perception/{walk,serialize,refmap,roles,accessible-name,diff}.ts` (all read in full, 1076 lines).

Lens: readiness gate, downsample/enrich, never-truncate, off-screen keep.

## What moxxie already does right (no gap — confirmed by reading, not assumed)

- **Never-truncate**: `serialize.ts` `render()` throws `OutputOverflowError` on `maxChars` overflow instead of slicing — matches Aside §10 exactly (error, not silent cut). Mapped to `fail("output_overflow")` in `cli.ts:80`.
- **Off-viewport kept**: `walk.ts` has no bounding-rect check gating general node inclusion (only the cursor-interactivity *classification* in `SCAN_JS` requires `rect.width>0`, which only affects whether a node is tagged `cursorInteractive`, not whether it's walked/rendered). Scrolled-out-of-view elements are not pruned — aligned with Aside §4.1 `isVisible` (off-viewport ≠ invisible).
- **Depth grows only on included nodes**: `walk.ts` `visit()` re-invokes `visit(child, level)` (same level, not `level+1`) when a node is pruned — matches Aside §3.3 exactly.
- **Diff-when-shorter**: `diff.ts` `observe()` picks `min(diff, tree)` and returns `NO_CHANGES` sentinel on identical trees — matches Aside §10 `c.length > s.length ? s : c`.
- **Ref grounding / staleness**: `refmap.ts` `groundRef()` is actually *stricter* than Aside — Aside re-derefs a stale ref by (role,name)+ordinal TreeWalker fallback (§8.2), moxxie refuses outright (`ref_stale`) rather than silently re-resolving to a possibly-wrong element. This is a deliberate, defensible design choice (correctness over convenience) — **skip-cargo-cult**: do not add Aside's fuzzy re-resolution; it reintroduces the "silent wrong click" risk moxxie's grounding gate exists to prevent.
- **Password redaction**: `walk.ts` computes `isPassword` on `input[type=password]`, serializer routes it to `security/redact.ts` — matches Aside's `[redacted]` behavior.
- **URL cleaning**: `walk.ts` `cleanUrl()` strips tracking params, matches Aside's `KZ()`.

## Gaps

### 1. No pre-snapshot readiness gate (P0)
- **Source**: Aside §11 — `snapshot()` never fires on a half-loaded page. `openTab()`/interactions block on `rVt`/`oVt`: doc `readyState!=="loading"`, then (interactiveCount>0 OR landmarkCount>0 OR textChars>=20), with same-origin in-flight-request and interactive-count-zero grace windows, before a snapshot is taken. Called out as "a second, less obvious accuracy pillar" behind the whole builder.
- **Moxxie current**: `core/handlers.ts` `handleSnapshot()` (line ~308) calls `snapshotNodes(page, ...)` immediately — no wait beforehand. The only settle logic (`actuation/pagechange.ts` `settleAndFingerprint`) runs **after** the snapshot text is already rendered, purely to set a `page_changed` warning flag for the *next* call. A snapshot taken right after `nav`/`click` can capture a still-rendering page with zero interactive elements.
- **Recommendation**: adopt. Add a cheap in-page readiness poll (`document.readyState`, count of visible elements matching a coarse interactive/landmark CSS list, `body.innerText.length`) run for up to ~2s before `snapshotNodes` executes, reusing the existing `settleAndFingerprint`-style bounded polling pattern already in `pagechange.ts` (don't duplicate — extract a shared `waitForPageReady(page, budgetMs)` helper and call it from `handleSnapshot` before the walk).
- **keyless_ok**: true — pure DOM polling, no model call.
- **priority**: P0.

### 2. `frameId` is hardcoded to `'main'` — no iframe / cross-origin frame support (P0)
- **Source**: Aside §9 — the daemon runs `__aside.takeSnapshot` in **every** frame (main + all OOPIFs via `Target.setAutoAttach{flatten:true}`) in parallel, prefixes refs `fNeM`, and splices each child frame's tree under its parent's `- iframe [ref=X]:` line. This is explicitly why Aside's snapshot can address content a single-context AX read cannot.
- **Moxxie current**: `walk.ts` line 245: `frameId: 'main'` is a literal string constant on every `SnapNode`, and `snapshotNodes` calls `Accessibility.getFullAXTree` once on a single `CDPSession` for the top page. `roles.ts` lists `'Iframe'` as an `INTERACTIVE_ROLES` member (so an `<iframe>` element itself gets a ref), but nothing ever walks *into* that iframe's own execution context — same-origin iframe content already inside the top-frame AX tree may partially surface, but any cross-origin iframe (payment widgets, embedded auth, OAuth popups-in-iframe, checkout flows) is invisible to the agent entirely.
- **Recommendation**: adopt (scoped). Full multi-frame stitching is heavy; the keyless-appropriate version is: enumerate child frames via `page.frames()` (Playwright already tracks OOPIFs), run `snapshotNodes`'s CDP walk once per frame (each frame needs its own `page.context().newCDPSession` is not directly supported per-frame in Playwright — use `frame.page()` + a `Runtime.evaluate` with `contextId` scoped to the frame, or simplify to same-process frames only first), tag `SnapNode.frameId` with the real frame id, and prefix refs `f{N}e{M}` in `serialize.ts`'s minting loop (`refmap.ts` `RefEntry.frameId` already exists as a field — it's just never populated with anything but `'main'`, so the plumbing is half-built). Even a same-origin-only version (skip true OOPIF CDP attach) is a real improvement over the current single-frame walk.
- **keyless_ok**: true.
- **priority**: P0 (this is a correctness gap: the agent silently can't act on iframe content and has no signal that it's missing).

### 3. No mutation-quiet / "stable" wait mode for snapshot (P1)
- **Source**: Aside §11 `oVt` "stable" mode additionally requires a `MutationObserver` mutation-ratio ≤0.01 for 2 consecutive 100ms samples before returning — used after actions that trigger animations/lazy content, distinct from the coarser "interactive" readiness check.
- **Moxxie current**: `actuation/wait.ts` has a rich `WaitSpec` taxonomy (`selector`, `ref`, `text`, `url`, `load`, `fn`, `ms`) but no `{ mutationQuiet }` variant, and `pagechange.ts`'s fingerprint is a coarse `url|focusedBackendId|domNodeCount` string, not a live mutation-rate observer.
- **Recommendation**: align, lower urgency than #1/#2. Add a `{ stable: true }` option to `WaitSpec` that runs a short in-page `MutationObserver` sample (bounded ~500ms, 2×100ms quiet windows) as an opt-in the host can request before a snapshot on animation-heavy pages, rather than building it into every snapshot by default (keeps the default path fast).
- **keyless_ok**: true.
- **priority**: P1.

### 4. No node-text merging (`mergeTextLeafChildren`) — snapshot is bulkier than it needs to be (P1)
- **Source**: Aside §6 `mergeTextLeafChildren`: for any node with a ref and ≤3 children where every child is a text-leaf, the child texts are folded into the node's own `name` and the children are dropped — this is called out (§13) as one of three multiplicative reductions behind the "70% smaller" claim, alongside the interactive-only filter (moxxie already has this) and generic-wrapper collapse (moxxie already has this via `serialize.ts`'s `skipLine` generic-collapse rule).
- **Moxxie current**: `serialize.ts` collapses generic wrappers (`role === 'generic' && !hasRef && tn.children.length <= 1`) and drops empty `StaticText`, but a link/button with 2-3 short text children (common in badge/pill UI, e.g. `<a><span>Fort Worth, TX</span><span>$22-25/hr</span></a>`) still renders as N+1 separate lines instead of one `link "Fort Worth, TX $22-25/hr" [ref=e18]` line. This is a token-budget gap, not a correctness gap — moxxie already keeps everything semantically, just spends more lines/tokens to say it.
- **Recommendation**: adopt as a `serialize.ts` post-pass: for a node with a ref, ≤3 children, all children unnamed structural/text nodes, fold their rendered text into the parent's `name` field and drop the child lines (mirror Aside's ≤3 threshold and whitespace-insensitive dedup-if-name-already-matches rule).
- **keyless_ok**: true.
- **priority**: P1.

### 5. `[focused]` may be wrong on background tabs — no focus emulation (P2)
- **Source**: Aside §2/§5: `Emulation.setFocusEmulationEnabled{enabled:true}` is called at frame-manager init specifically so `document.activeElement`/`:focus` (and thus the `[focused]` enrichment) behave correctly even when the agent drives a tab that isn't the OS-foreground window — called out as "load-bearing."
- **Moxxie current**: `walk.ts` reads `focused` straight from the AX node's `properties` (`props.get('focused')`), and `pagechange.ts`'s `focusedBackendId()` also reads `document.activeElement` via CDP — neither sets `Emulation.setFocusEmulationEnabled`. On a genuinely backgrounded Playwright-driven tab (uncommon for a headless keyless CLI, since Playwright tabs are usually not literally OS-backgrounded, but possible when multiple tabs/contexts are open and the "active" one isn't the visually foregrounded one), `[focused]`/the fingerprint's focus term could read stale or empty.
- **Recommendation**: adopt, cheap. Add `await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {})` once per CDP session in `walk.ts`'s `snapshotNodes` (and in `pagechange.ts`'s `focusedBackendId`) — one line, no new dependency, closes a real correctness edge for multi-tab sessions.
- **keyless_ok**: true.
- **priority**: P2.

### 6. `getFullAXTree` vs Aside's custom walker — correction, not a gap to "fix" (informational)
- **Source**: `40_perception.md` §3a originally *guessed* Aside used CDP `getFullAXTree`; `91_snapshot_builder.md` §0 issues a formal correction — Aside does NOT use `getFullAXTree` at all, precisely because a single CDP AX read can't reach cross-origin iframes and the daemon needed a bespoke per-frame injected walker to get that reach (this is the root cause behind gap #2 above).
- **Moxxie current**: `walk.ts` explicitly does use `Accessibility.getFullAXTree` (comment at top of file, and call at line 162) — this is the exact approach the corrected Aside source says doesn't scale to cross-origin content. Moxxie's choice is reasonable for a keyless CLI (far less code than a bespoke DOM walker + accname engine), but it inherits `getFullAXTree`'s single-context limitation. Recorded here as *context* for why finding #2 exists, not as a separate action item — full replacement of `getFullAXTree` with a hand-rolled walker (Aside's actual solution) is disproportionate; the scoped per-frame `Runtime.evaluate` approach in #2 gets most of the benefit without a full walker rewrite.
- **recommendation**: skip-cargo-cult on "replace getFullAXTree with a custom walker" — too much surface area for the marginal gain over #2's scoped fix.
- **keyless_ok**: n/a (analysis note).
- **priority**: P2 (informational).

### 7. No `annotatedScreenshot` visual-grounding fallback (P2, likely skip-cargo-cult)
- **Source**: Aside §12 — when the text tree is ambiguous (canvas-heavy/visual pages), the agent escalates to a screenshot with ref-numbered red boxes overlaid, using the *same* `eN` ids as the text tree, so the model can cross-reference visually.
- **Moxxie current**: no equivalent found under `perception/`; screenshot capability (if any) would live elsewhere in moxxie and wasn't in scope here.
- **Recommendation**: mark **skip-cargo-cult for now** unless moxxie already has a `screenshot` verb elsewhere — building ref-overlay annotation is real engineering weight (bounding-rect collection + canvas draw + PNG capture) for a fallback path; only worth it if eval failures show the host LLM genuinely needs visual grounding beyond the text tree. Flagging for awareness, not recommending immediate build.
- **keyless_ok**: true if built (screenshot + overlay is pure CDP, no model call).
- **priority**: P2.

## Top recommendation

Fix the `frameId: 'main'` hardcode in `walk.ts` (finding #2) combined with adding a pre-snapshot readiness poll (finding #1) — these are the two places where moxxie's current perception layer can silently hand the host LLM an incomplete or premature tree with no error signal, which is exactly the failure mode Aside's two "less obvious" accuracy pillars (readiness gate + per-frame injection) were built to close.
