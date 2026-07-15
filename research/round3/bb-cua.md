# Browserbase CUA Client Patterns — Gap Alignment for moxxie

Source: `/Users/seventyleven/Desktop/researchfms/browserbase/BROWSERBASE_GAP_11_CUA_CLIENTS.md`
(RE of Stagehand v3's 4 Computer-Use-Agent clients — OpenAI, Anthropic, Google,
Microsoft FARA — plus the `V3CuaAgentHandler` routing/loop wrapper.)

Moxxie modules read: `skill/agent-browser/src/perception/{serialize,diff,refmap,walk,roles,accessible-name}.ts`,
`skill/agent-browser/src/actuation/{pagechange,actions,resolve,wait}.ts`,
`skill/agent-browser/src/core/{handlers,errors,flags}.ts`.

## Framing

Stagehand's CUA clients are **vision-model loops**: a provider LLM looks at a
screenshot, emits pixel coordinates (`x,y` or a normalized 0-1000 range), and
Stagehand dispatches CDP mouse/keyboard events, then loops with a fresh
screenshot. moxxie has **no vision loop at all** — it is a ref-based
accessibility-tree CLI (`snapshot` → `eN` refs → `click e12`), and the host LLM
runs the loop, not moxxie. This is a fundamentally different (and for a
keyless tool, correct) architecture: no model call, no screenshot round-trip,
deterministic grounding via `backendNodeId` + generation (`refmap.ts`).
Most of the CUA-specific plumbing (coordinate scaling per provider, image
compression, conversation threading, safety-check acknowledgment, adaptive
thinking config) is either N/A or already superseded by moxxie's design. The
findings below extract the pieces that survive the "keyless, ref-based, host
is the brain" filter.

---

## Findings

### 1. [P0, adopt] Deterministic action replay ("record once, replay free")
- **Source does:** `V3CuaAgentHandler.executeAction` (GAP_11 §5, "Replay
  recording") — every CUA action captures the resolved xpath via
  `page.click(x, y, { returnXpath: true })` at the instant of dispatch, and
  logs it as a Stagehand "act step." A successful run becomes a deterministic
  script; subsequent runs replay the xpath sequence **without any LLM call**.
  The RE author calls this "one of the strongest architectural decisions in
  the codebase" — it turns an expensive vision loop into "expensive once,
  cheap forever."
- **moxxie current:** absent. `grep -rn "record\|replay\|macro"` across
  `core/*.ts` returns nothing but an unrelated comment
  (`handlers.ts:708 // localStorage/origins ... not replayed here`). Every
  `moxxie click/type/fill` call is a one-shot CDP dispatch; there is no way
  to capture a sequence of grounded actions and re-run it without the host
  re-issuing each command (and re-paying for a `snapshot` + reasoning pass
  each time).
- **change:** add a `moxxie session record --on` / `--off` toggle
  (`core/session.ts` + a new `actuation/record.ts`) that appends each executed
  `ActVerb` from `actuation/actions.ts` to a JSON script keyed by the
  **resolved** selector info already computed in `resolve.ts`
  (`backendNodeId` + the `rematchByShape` fallback descriptor), not the raw
  `eN` ref (refs are generation-scoped and die on the next snapshot). Add
  `moxxie replay <script.json>` that re-resolves each step via the same
  `resolve.ts` machinery (shape-rematch already handles SPA re-renders) and
  fails loudly (`element_not_found`) on the first unresolvable step rather
  than guessing. This is the single highest-leverage idea in the source: it
  is 100% keyless (no model, no screenshot), and it directly amortizes the
  cost moxxie's design otherwise pays every single run (host re-derives refs
  + re-reasons every time).
- **keyless_ok:** true
- **priority:** P0
- **evidence:** GAP_11_CUA_CLIENTS.md:1506-1525, 1686 (source); moxxie:
  `skill/agent-browser/src/actuation/resolve.ts` (rematchByShape),
  `skill/agent-browser/src/actuation/actions.ts` (ActVerb union) — read, no
  replay/record capability present.

### 2. [P1, adopt] Raw-coordinate click fallback for accessibility-invisible surfaces
- **Source does:** all four CUA clients dispatch on raw pixel `x,y` from a
  screenshot (GAP_11 §1-4) precisely because vision models see canvas/WebGL
  content, custom-painted widgets, and games that never appear in the
  accessibility tree at all.
- **moxxie current:** every actionable verb (`click`, `dblclick`, `hover`,
  `drag`, …) resolves exclusively through a `RefEntry`/`backendNodeId`
  (`actuation/resolve.ts`, `actuation/actions.ts`) — there is no coordinate
  parameter anywhere in `core/flags.ts` or `actuation/actions.ts`
  (`grep -n "x:\|y:\|coordinate\|--x\|--y"` over those files returns nothing
  relevant). `handleScreenshot` (`core/handlers.ts:175`) already lets the
  host *see* pixels, but moxxie gives it no way to *act* on them. A `<canvas>`
  drawing app, a map widget, or a signature pad is unreachable.
- **change:** add `moxxie click --x <n> --y <n>` (and `type`/`drag`
  coordinate variants) as an explicit escape hatch, gated the same way
  `--force` is: bypass `resolve.ts`, dispatch via CDP
  `Input.dispatchMouseEvent` directly on the active page's viewport
  coordinates (moxxie already knows the viewport — no scaling math needed,
  since moxxie doesn't run a vision model that emits a normalized range;
  the host reads the pixel position straight off the `screenshot` output
  moxxie already returns). Keep it a documented fallback, not the primary
  path — refs stay canonical for anything the ax tree exposes.
- **keyless_ok:** true (host, the vision-capable LLM, supplies x/y after
  looking at moxxie's own `screenshot` output — moxxie itself never runs a
  model)
- **priority:** P1
- **evidence:** GAP_11_CUA_CLIENTS.md:196-225 (OpenAI 1:1 coordinate pass-
  through, simplest case to imitate) (source); moxxie:
  `skill/agent-browser/src/actuation/actions.ts`,
  `skill/agent-browser/src/core/flags.ts` — read, confirmed no coordinate
  path exists.

### 3. [P2, align] Multi-step synthetic drag dispatch for finicky DnD libraries
- **Source does:** `V3CuaAgentHandler`'s drag executor clamps step count to
  `[5, 20]` based on path length with a 10ms inter-step delay
  (`page.dragAndDrop(start.x, start.y, end.x, end.y, { steps: clamp(...,5,20), delay: 10 })`)
  — a deliberate compensation for drag-and-drop libraries (sortable lists,
  HTML5 native DnD, canvas sliders) that only fire their handlers on a
  sequence of intermediate `mousemove` events, not a single teleport.
- **moxxie current:** `actuation/actions.ts:235-240` implements `drag` via
  Playwright's `locator.dragTo(target, withForce(opts))` — a single
  high-level call with no configurable intermediate-step count. This works
  for most `dragstart`/`drop`-event-based DnD but is known to under-trigger
  libraries that gate on `mousemove` deltas (react-beautiful-dnd, some
  Sortable.js configs).
- **change:** in `actuation/actions.ts`, when `dragTo` is used, consider
  exposing a `--steps <n>` flag (default unset = current Playwright
  behavior) that instead does a manual `mouse.move(...)` sequence between
  source and target centers with an intermediate step count, mirroring the
  clamp-and-delay pattern, as an opt-in for stubborn widgets — don't change
  the default path.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** GAP_11_CUA_CLIENTS.md:1458, 1468-1472 (source); moxxie
  `skill/agent-browser/src/actuation/actions.ts:235-240` (read).

### 4. [P2, skip-cargo-cult] Fixed pre/post-action sleep constants
- **Source does:** hardcodes a **300ms pre-action delay** and a **500ms
  post-action delay** (configurable via `waitBetweenActions`) around every
  single dispatched action, uniformly, regardless of what actually happened
  on the page (GAP_11 §5, "constants (verbatim)").
- **moxxie current:** already strictly better —
  `actuation/pagechange.ts::settleAndFingerprint` does an *adaptive* settle
  (`waitForLoadState('domcontentloaded')` then a bounded 1.2s
  network-idle race, never longer) and only then fingerprints
  `url|focusedBackendNodeId|domNodeCount` to flag `page_changed`/
  `stale_refs` to the host. This is data-driven, not a blind sleep.
- **change:** none — do not adopt Stagehand's fixed-delay model. Recorded
  explicitly so a future contributor doesn't "helpfully" reintroduce
  `setTimeout(300)`/`setTimeout(500)` thinking it's a Browserbase-endorsed
  best practice; moxxie's bounded adaptive settle is the superior pattern
  and should stay as-is.
- **keyless_ok:** true (moot — recommending against adoption)
- **priority:** P2
- **evidence:** GAP_11_CUA_CLIENTS.md:1348-1364, 1630-1631 (source); moxxie
  `skill/agent-browser/src/actuation/pagechange.ts` (read in full).

### 5. [P1, skip-cargo-cult] CAPTCHA auto-solve + post-solve click guard
- **Source does:** a `CaptchaSolver` listens for Browserbase's managed-
  browser console events (`browserbase-solving-started/finished/errored`),
  blocks the agent loop for up to 90s while Browserbase's (paid, external)
  captcha-solving infrastructure works, then guards the next 3 clicks
  against re-hitting captcha selectors and injects a context note telling
  the model to stop clicking the widget.
- **moxxie current:** `core/errors.ts` already has a deliberate, opposite
  design: `captcha_detected` → `retryableByHost: false`, message "a CAPTCHA
  was detected; human action is required — this agent does not solve
  CAPTCHAs." This is the correct call for a 100% keyless CLI: CAPTCHA
  solving requires either a model or a paid third-party solving service,
  neither of which fits moxxie's contract.
- **change:** none. Confirmed as intentional and correct; flagging so it's
  not miscategorized as a "gap" in a future pass. If moxxie ever wants the
  narrower, keyless-safe half of this pattern — the *click-guard* idea (skip
  clicks whose target matches a known-blocking-overlay selector list and
  surface an advisory) — that could be revisited independently of solving,
  but it is not this source's contribution; it's a generic overlay-detection
  heuristic and out of scope here.
- **keyless_ok:** false (the thing being skipped requires external paid
  infra or a model; correctly not replicated)
- **priority:** P1 (confidence-building, not implementation work)
- **evidence:** GAP_11_CUA_CLIENTS.md:1366-1421 (source); moxxie
  `skill/agent-browser/src/core/errors.ts:41-44` (read).

### 6. [P2, skip-cargo-cult] Per-provider coordinate normalization / vision-loop plumbing
- **Source does:** the bulk of GAP_11 (coordinate scaling per provider —
  OpenAI/Anthropic 1:1, Google 0-1000 normalized, FARA Qwen `smart_resize`;
  conversation threading — `previous_response_id` vs full history vs dual
  history; image compression; adaptive-thinking config; safety-check
  acknowledgment; per-provider routing table `modelToAgentProviderMap`).
- **moxxie current:** N/A by design — moxxie never calls a model, so there
  is no "provider," no screenshot-in-the-loop, no coordinate space to
  normalize, no conversation history to compress. `perception/serialize.ts`
  and `perception/diff.ts` already solve the analogous problem (bound what
  the host sees, diff-when-shorter, never silently truncate) at the
  accessibility-tree layer instead.
- **change:** none. Explicitly out of scope — re-introducing any of this
  would require moxxie to embed a model client, which violates the
  100%-keyless invariant. Listed so the volume of this source doesn't get
  mistaken for volume of applicable findings.
- **keyless_ok:** false
- **priority:** P2 (documentation-only)
- **evidence:** GAP_11_CUA_CLIENTS.md:63-70, 360-387, 710-736, 949-989,
  1264-1317 (source).

---

## Top recommendation

**Adopt #1 (deterministic action replay)** — record resolved-selector action
sequences during normal `moxxie click/type/fill/…` calls and add a
`moxxie replay <script>` command that re-executes them via the existing
`resolve.ts` shape-rematch machinery. This is the one idea in Stagehand's CUA
stack that (a) is fully keyless, (b) doesn't already have a superior moxxie
analog, and (c) attacks moxxie's actual cost model — every host-driven run
currently re-pays snapshot + reasoning from scratch, and Stagehand's own
authors call the record-once/replay-free pattern their strongest
architectural decision.
