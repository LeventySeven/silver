# SOTA 2026-B — a11y-tree vs pixels, set-of-marks, DOM compaction, self-correction, reliability

**Task:** sota-2026-b · **Scope:** WebSearch/WebFetch of 2025–2026 research/engineering on
perception (a11y-tree vs pixel), set-of-marks, DOM distillation, self-correction/verification
loops, reliability. Goes beyond `research/synthesis/engine-plan.md` and `adopt-list-v2.md`
(token/latency already resolved there) into **new** perception-robustness and
reliability-architecture findings. **Code anchors:** `silver/src/perception/{walk,serialize,
refmap,diff}.ts`.

---

## 1. Accessibility-tree perception is directionally right — but has a measured cliff

A 2026 UC Berkeley/Michigan study found web-agent task success **drops from 78% → 42%** when
the accessibility tree is degraded (missing roles/names) — nearly half the failures traced to
"the structural information the agent needed was not there" (searchenginejournal.com/…
accessibility-tree-is-how-ai-agents-read-your-site). The 2026 WebAIM Million cross-tab: **46.3%
empty links, 30.6% empty buttons, 51% missing form labels, 53.1% missing alt text** on the open
web. Worse, the **"ARIA paradox"**: pages *with* ARIA attributes average **59.1** a11y errors vs
**42** on pages with none — a wrong/empty ARIA attribute doesn't leave the tree blank, it fills
it with *confident, wrong* information (same source). This is directly Silver's exposure
surface: `walk.ts`'s AX-tree join trusts `role`/`name` from the browser's AX computation. A
`<div role="button" aria-label="">` reads as ref-eligible-but-nameless — exactly the case
`accessible-name.ts` and the cursor-interactive cascade (walk.ts:12-15, adapted from
browser-use) already partially cover by falling back to visible text. **Concrete Silver
change:** extend the existing cursor-interactive fallback in `walk.ts` to also fire when a node
has a **non-empty ARIA role but an empty/whitespace accessible name** (not just when AX marks it
`generic`) — i.e. treat "confidently-wrong ARIA" the same as "missing ARIA" rather than trusting
a hollow role. **KEYLESS check:** pure DOM/AX inspection, zero model calls. **Priority: P1** —
cheap, closes a documented, measured failure class (half of open-web task failures per the
Berkeley/Michigan number), and is a 10-20 line addition to an existing code path.

## 2. Set-of-marks is a vision-fallback concern, not a Silver-engine concern — but Silver should make the *handoff* first-class

SoM (numbered/boxed overlays on a screenshot so a VLM can say "click #5" instead of describing
pixels) only matters when the **host** LLM is vision-capable and the page has non-DOM content
(canvas: Figma, Google Sheets, WebGL) that the AX tree cannot represent at all — confirmed by
`arxiv.org/html/2511.19477v1` ("Building Browser Agents"): a11y trees miss canvas content
entirely, forcing a hybrid where vision is the fallback, not the primary. Silver already has
screenshot capture and `adopt-list-v2.md` §C notes the host-vision-fallback contract is mostly
wiring. **The gap this research surfaces beyond that prior note:** Silver's fallback should ship
a **SoM overlay renderer**, not a bare screenshot — inject numbered/lettered marks at the
bounding boxes of the elements the AX walk *did* find (even if it couldn't name them), so when
the host asks for a screenshot after a `find`/`click` miss, the image is pre-annotated with the
same ref IDs (`e12`, `e13`…) the tree already minted. This closes the loop: host sees "e12" on
the picture, calls `click e12` — no coordinate math, no new ref scheme, and the *existing*
refmap/generation gate (`refmap.ts`) still guards it. **Concrete change:** new
`perception/overlay.ts` — canvas-draw boxes+labels from `SnapNode.backendNodeId`'s bounding
rect (already fetchable via `DOM.getBoxModel`) onto the PNG buffer before returning it.
**KEYLESS check:** pure CDP + canvas compositing, no model call. **Priority: P2** — real
capability gap (canvas apps are unreachable today) but lower frequency than P1/P3.

## 3. DOM distillation/compaction: Silver's serializer plan is sound; add *scored* pruning as a stretch goal

Confirms `engine-plan.md`'s T1-T3 direction (raw DOM is 10k-100k+ tokens per **Prune4Web**,
arxiv 2511.21398, and "Agentic Compilation" arxiv 2604.09718 — both frame the fix as
*programmatic* filtering, not model-based summarization, matching Silver's keyless constraint).
Two techniques neither prior digest covered:

- **Prune4Web-style scored retention over binary include/exclude.** Rather than Silver's current
  binary `refEligible` boolean (walk.ts:51), a lightweight per-node relevance score (role class +
  ancestor-of-interactive + text-density) would let a size-budget mode ("give me the top N
  nodes") degrade gracefully on huge pages instead of hard-truncating. Today Silver has no
  documented cap-and-rank behavior for pathological DOMs (10k+ interactive elements) — only the
  `SCAN_ELEMENT_LIMIT = 10_000` bail-out (walk.ts:80), which is a hard stop, not a graceful
  degrade. **Concrete change:** `serialize.ts` — add an optional `--max-nodes` budget that, when
  the walk exceeds it, ranks nodes (interactive > named-content > structural-with-named-child)
  and truncates the tail with a `# N more nodes omitted (raise --max-nodes)` marker instead of
  silently stopping. **Priority: P2.**
- **DOM Sanitization Module (Agentic Compilation, DSM)** — strip elements programmatically
  *before* the AX walk even runs (ads, trackers, hidden-but-in-DOM widgets, `display:none`
  subtrees) rather than relying on AX visibility pruning alone. Silver's `walk.ts` already prunes
  invisible nodes post-hoc; a pre-filter at the `page.evaluate` cursor-scan stage (walk.ts:12-15)
  that skips known-noise selectors (cookie banners, `[aria-hidden=true]` ad iframes) before CDP
  even builds the DOM tree would cut wall-clock, not just tokens. **Priority: P3** (token/latency
  win, but Silver already prunes invisible nodes — this is marginal, not a gap).
- **CI4A ("Semantic Component Interfaces for Agents", arxiv 2601.14790)** proposes sites publish
  structured component metadata (role/purpose/action-schema) beyond ARIA, explicitly for
  agents. This is not something Silver can force sites to adopt, but Silver *could* opportunistically
  detect and prefer such a channel if present — e.g. probe for a well-known `<meta>`/JSON-LD
  agent-interface block and short-circuit the AX walk when found, falling back to today's path
  otherwise. **Priority: P3/speculative** — protocol not yet standardized or seen in the wild;
  worth a `TODO` comment in `walk.ts`, not code yet.

## 4. Self-correction/verification: the 2026 literature is a *warning*, and it validates Silver's architecture

The most important finding this task surfaces: **intrinsic self-correction (LLM re-checking its
own output with no new evidence) does not reliably work and can degrade.** Huang et al. (ICLR
2024) established this; a 2026 preprint on Preprints.org formalizes it information-theoretically
— when the generator and evaluator share correlated error modes, self-evaluation is weak
evidence, and iterative self-critique can produce a **"coherence trap"**: increasingly polished,
still-wrong reasoning (zylos.ai/research/2026-05-12-agent-self-correction). The literature's own
counter is **execution-based verification** — agents that self-correct via *external* ground
truth (retrieval, calculator, DB query, or here: actual DOM/page state) succeed 70.3% of the
time vs. much lower for pure self-critique. **This is exactly what Silver already is**: because
Silver never calls a model, every "verification" Silver performs is execution-based by
construction — `groundRef`'s generation check (refmap.ts:55-71) is a hard, non-LLM-judged
correctness gate, and `diff.ts`'s post-action snapshot diff is literal DOM ground truth, not a
model's opinion about the DOM. **The finding to act on:** Silver should document and *lean into*
this framing explicitly — position the ref/generation gate and the mandatory post-action
re-snapshot as Silver's version of "execution-based verification," and resist any temptation to
add an LLM-judged confidence score inside Silver (that would be the coherence-trap failure mode,
and it would also break the keyless invariant). **Concrete, actionable gap:** Silver does not yet
enforce a **correction budget** at the CLI level — the 2026 production guidance explicitly warns
"unbounded retry loops are an availability risk; design correction cycles with maximum attempts
and a human escalation path." Silver's retry ladder (`adopt-list-v2.md` §C3, DOM-depth retry) has
no stated cap independent of the host's own loop. **Change:** any Silver-internal retry (e.g. the
depth-cap ladder, or a future auto-retry-on-`stale_refs`) must carry a hard numeric cap and
surface `retries_exhausted` as a distinct error code the host can branch on — never loop silently.
**Priority: P1** — small, and it's the direct, literature-backed guardrail against a known
failure class. **KEYLESS check:** pure control-flow change, no model call.

## 5. Reliability architecture: two concrete gaps found by reading Silver's own dependency lineage

- **Cross-origin iframe accessibility is silently broken — and it's the *exact same* bug in
  Silver's ancestor.** `walk.ts:173` documents: "cross-origin / detached frames are skipped
  silently (they simply don't appear)." `vercel-labs/agent-browser` issue #925 (the repo Silver's
  snapshot/ref design is explicitly adapted from, walk.ts:14) diagnoses the identical root cause:
  `Accessibility.getFullAXTree({frameId})` on the **parent session** cannot cross a cross-origin
  security boundary — CDP requires a **separate session** per cross-origin target. The documented
  fix: enable `Target.setAutoAttach({flatten:true})` at session setup so Chrome attaches a
  distinct `sessionId` to each cross-origin iframe target, maintain a `targetId → sessionId` map,
  and route `Accessibility.getFullAXTree`/DOM calls for those frames to their own session instead
  of passing `frameId` on the parent's. This is a **known, unresolved gap in the exact codebase
  Silver forked its perception model from**, meaning Shopify checkout widgets, OAuth popups-as-
  iframes, and payment iframes (Stripe Elements) are invisible to Silver today. **Change:**
  `session.ts`/`walk.ts` — add `Target.setAutoAttach` during session open, track
  `targetId→sessionId`, and in `resolveChildFrameId`/`walkFrame` (walk.ts:254-270, 386-401) branch
  on same-origin (today's `frameId`-on-parent path) vs. cross-origin (new session-routed path)
  instead of the current silent skip. **Priority: P1** — real capability gap, directly measured
  in the reference lineage, high-value target class (payment/auth iframes).
- **Shadow DOM is handled for open roots (`walk.ts:448` walks `node.shadowRoots`) but closed
  shadow roots remain structurally unreachable** — this is a platform limit, not a Silver bug
  (whatwg/dom#1290, confirmed no CDP/AX bypass exists for `mode:'closed'`), but **Reference
  Target for Cross-Root ARIA** (Chromium origin trial as of May 2025) is the emerging
  standards-track fix for shadow-root ARIA relationships generally. **Action:** no code change
  now; add a doctor-check note (`handleDoctor`, per `adopt-list-v2.md` §context) that surfaces
  "N closed shadow roots detected, some interactive elements may be unreachable" as a diagnostic,
  so hosts get a loud signal instead of a silently-incomplete tree. **Priority: P3.**

## 6. Snapshot-versioning validation and one adjacent idea

Independent confirmation Silver's generation-gated ref scheme is the right shape: a survey of
"three architectures of browser agents" (dev.to/…runtime-snapshots-16) converges on the identical
`version:elementId` pattern for the same reason Silver's `red-team S1/R4` did — stale-ref
misclicks ("Cancel" becomes "Delete" at the same id across renders). No change needed;
`refmap.ts` already implements this correctly and matches 2026 external consensus. One adjacent,
not-yet-covered idea from the same source: **bulk/batched actions cut tool-call count 74% and
wall-clock 57%** on form-filling by letting the host issue an array of independent actions in one
call. Silver's `task`/`orchestration` layers may already batch at a higher level — worth a
follow-up grep, but if the `act` verb is strictly one-action-per-invocation today, a
`--batch <json>` mode on `act` (validating each sub-action against the *same* generation before
executing any, aborting the whole batch on first `stale_refs`) would be a meaningful latency win
compatible with the P1 correction-budget rule above. **Priority: P2**, pending confirmation
Silver doesn't already have this via `task`.

---

## Priority summary

| # | Idea | File | Priority |
|---|---|---|---|
| 1 | Fallback-name cursor-interactive nodes with non-empty role + empty accessible name | `perception/walk.ts` | P1 |
| 4 | Hard cap + `retries_exhausted` code on any internal retry ladder | wherever retry lives (cli/handlers) | P1 |
| 5a | Cross-origin iframe AX via `Target.setAutoAttach` + per-session routing | `core/session.ts`, `perception/walk.ts` | P1 |
| 2 | Set-of-marks overlay renderer for vision-fallback screenshots | new `perception/overlay.ts` | P2 |
| 3a | Scored/ranked node pruning with `--max-nodes` graceful degrade | `perception/serialize.ts` | P2 |
| 6 | `act --batch` for independent multi-action calls | `actuation/actions.ts` (verify vs `task`) | P2 |
| 3b | Pre-walk DOM noise strip (DSM-style) | `perception/walk.ts` | P3 |
| 3c | Detect/prefer CI4A-style agent-interface metadata if present | `perception/walk.ts` (TODO only) | P3 |
| 5b | Doctor-check surfacing closed-shadow-root count | `core/handlers.ts` (`handleDoctor`) | P3 |

All nine are keyless — every check above is either pure CDP/DOM inspection, control-flow, or
canvas compositing; none call a model from inside Silver.

Sources: searchenginejournal.com (accessibility-tree-is-how-ai-agents-read-your-site,
WebAIM Million 2026 data), arxiv.org/html/2511.19477v1 (Building Browser Agents), arxiv.org/abs/
2511.21398 (Prune4Web), arxiv.org/abs/2604.09718 (Agentic Compilation / DSM), arxiv.org/abs/
2601.14790 (CI4A), zylos.ai/research/2026-05-12-agent-self-correction-reflexion-to-prm,
github.com/vercel-labs/agent-browser/issues/925, dev.to/…/runtime-snapshots-16, github.com/
whatwg/dom/issues/1290, futureagi.com/blog/evaluating-browser-use-agents-2026.
