# Top 5 things Aside does better than every competitor — status in Silver

Sources read: `research/sources/aside-01-thesis-why-sota.md`, `aside-02-runtime-loop-tools.md`,
`aside-03-perception-snapshot.md`, `aside-05-security-guardrails.md`, `aside-06-memory-subagents.md`
(each itself mined from `researchfms/teardowns/_aside_parts/{10,20,30,40,60,85,89,91,93,94,95,96,97,100}*.md`).
Cross-checked against Silver source at `/Users/seventyleven/Desktop/Silver/silver/src`.

---

## 1. The why-SOTA harness thesis: representation + action-surface beat model choice

**What/why:** Aside's own model-swap proof (gpt-5.5 93% vs cheap Kimi-k2.6 88% on BU-Bench-V1, gap concentrated in
reasoning categories, ~59/60 on pure navigation for both) plus D2Snap (arXiv 2508.04412: downsampled a11y
tree 73% > screenshot 65% > raw DOM 38%) says the two decisions that matter more than the model are (a) a
downsampled, hierarchy-preserving a11y-tree observation and (b) a single code-execution action surface instead
of N granular tools.

**Silver status — SPLIT.**
- (a) Already has it: `silver/src/perception/walk.ts` (561 lines) implements the exact downsample/filter/collapse
  pipeline (interactive ∪ landmark ∪ scrollable filter at `walk.ts:310-312`, `MAX_LEVELS` depth cap,
  100-char name truncation). This is genuinely SOTA-aligned, independently arrived at.
- (b) **GAP:** Silver ships ~40 discrete verbs (`click`, `fill`, `type`, `scroll`, …, `security/registry.ts`
  `READ_ONLY_VERBS`/`ACTOR_VERBS`) dispatched one-per-CLI-invocation, not a single `repl`/code-exec surface.
  See item 2 below — this is the single biggest architectural gap vs Aside.

---

## 2. The `repl` single-tool, code-execution action surface

**What/why:** Aside's entire browser-automation surface is one tool (`repl(title, code)`) running Playwright-flavored
JS in a persistent, sandboxed, per-session-scoped REPL with helper globals (`page`, `tabs`, `openTab`, `snapshot`,
`webfetch`, `websearch`, `annotatedScreenshot`, `fs`, `sleep`). This lets one model turn batch several actions plus
a read (fill → click → press Enter → re-snapshot) in a single round-trip, cutting round-trips and letting the model
use real control flow (loops, conditionals, retries) instead of one atomic action per turn. Both Aside and Browser
Use's own benchmark-winning run independently converged on "agent as code-execution," away from click/type schemas.

**Silver status — GAP (the load-bearing one).** Confirmed by reading `security/registry.ts` and `core/handlers.ts`:
Silver is a per-verb CLI (`silver click @e3`, `silver fill @e10 "text"`, `silver snapshot`, …), each a separate
process invocation with its own CDP reconnect (see the project brief's stated "per-command CDP reconnect" cost).
There is an `eval` verb (`registry.ts:104`, gated as an ACTOR verb requiring `--enable-actions` and tagged
non-idempotent in `security/confirm.ts:41`) that runs `page.evaluate`, but it is:
- a single JS expression per call, not a persistent multi-statement REPL scope carrying state across calls,
- not wired to a `snapshot`/`openTab`/`webfetch`/`websearch` helper-global surface the model can compose inside one
  script,
- gated behind a confirm prompt every call (by design, since it's flagged as arbitrary-code-execution), which is
  the opposite of Aside's stance (repl is the PRIMARY, low-friction surface, not a rare escape hatch).

**Recommendation:** This is the one adoption that would most change Silver's latency/round-trip profile independent
of the CDP-reconnect fix — a `silver repl` verb (or a host-side wrapper) that keeps one CDP connection + one JS
context alive across a sequence of statements, exposing `snapshot()`, `openTab()`, `tabs[]`, and the existing
webfetch-equivalent as globals, would collapse N stateless invocations into 1.

---

## 3. The compact, diffed, ephemeral-ref accessibility snapshot (the "centerpiece" perception layer)

**What/why:** Injected-JS DOM walker (not CDP `getFullAXTree`) that: filters to a strict interactive ∪ scrollable ∪
landmark ∪ canvas set (the size-reduction mechanism), grows depth budget only on included nodes (wrapper-soup
doesn't burn the budget), never truncates (errors with a re-scope hint instead), mints ephemeral `eN`/`fNeM` refs
invalidated every snapshot but stable across unchanged elements via a Symbol-stamp, Myers-diffs against the prior
tree and returns whichever is shorter (diff or full tree), and computes accessible names via the real W3C accname
algorithm (not `innerText`).

**Silver status — ALREADY HAS THIS, closely.** Verified directly:
- `perception/walk.ts`: interactive-role filter, depth cap, per-node accessible-name computation
  (`perception/accessible-name.ts`, 67 lines — dedicated W3C-accname-style module, not innerText).
- `perception/refmap.ts` (76 lines): ref minting/lookup.
- `perception/diff.ts` (173 lines): hand-rolled Myers O(ND) line diff, unified `@@` hunks, `output = diff.length <
  tree.length ? diff : tree` — this is a byte-identical strategy to Aside's `diff: c.length > s.length ? s : c`
  (`diff.ts:44` mirrors the exact "return whichever is shorter" rule, including a `NO_CHANGES` sentinel matching
  Aside's `"No changes detected"`).
- `perception/serialize.ts` (292 lines): the rendering layer.
- Never-truncate contract: `security/injection.ts:13-16` explicitly calls out that the snapshot serializer's
  "never-truncate contract" is distinct from the opt-in `capOutput()` used for free-form dumps — i.e. Silver already
  encodes Aside's anti-pattern-6 lesson (don't silently truncate a ref-carrying tree) as an explicit design
  decision, not an oversight.

**Minor gaps still open (not verified fixed, worth a follow-up pass):** cross-origin iframe inlining via parallel
per-frame snapshot + string-splice merge (Aside pattern 11); the Symbol-stamp ref-reuse-across-snapshots-for-
unchanged-elements optimization (Aside pattern 4, `91_snapshot_builder.md` §8.1); password-field value redaction
in the tree (Aside pattern 18) — did not confirm presence/absence in `walk.ts` beyond the 100-char name truncation
seen at `walk.ts:538`. Flag these for a targeted check rather than asserting a gap outright.

---

## 4. Long-horizon loop discipline: recovery ladder, verification-before-completion, actionability gates

**What/why:** Aside's system prompt bakes in a reading-escalation ladder, a failure-recovery ladder (re-snapshot on
error, switch strategy after 2-3 fails), and a hard completion-verification rule ("verify you accomplished it, not
just attempted"), backed by typed `RefStaleError`s and pre-flight `waitForReady`/`checkHitTarget`/
`scrollIntoViewIfNeeded` actionability gates that absorb most transient DOM flakiness below the model
(credited with the 99% Mind2Web pass rate).

**Silver status — PARTIAL / host-dependent by design.** Silver is a CLI the host LLM drives, not a bundled
loop+system-prompt product — so "verification ladder" and "recovery ladder" are HOST responsibilities in Silver's
architecture, not something the CLI itself can enforce (unlike Aside, which owns both the daemon loop and the
model call). What Silver DOES own and ships:
- Stale-ref handling: `actuation/pagechange.ts` / `core/handlers.ts:782` returns an explicit
  `'the page changed during this command; refs may be stale'` message — matches Aside's `RefStaleError` contract
  in spirit (instructive, not silent).
- `actuation/wait.ts` — waiting primitives exist as a first-class verb.
- **GAP:** No evidence of Aside-style pre-flight actionability gates (`checkHitTarget` — verify the click point
  isn't covered by an overlay/cookie-banner before clicking) inside `actuation/actions.ts`; did not confirm this
  is implemented — worth a direct read of `actuation/actions.ts` and `actuation/resolve.ts` before claiming either
  way. This is the mechanism Aside's own teardown ties to real security relevance (clickjacking-style misclicks on
  overlays), not just reliability, so it's worth verifying rather than leaving unstated.
- **GAP (real, confirmed by design):** No independent read-only verifier subagent as a completion gate (Aside
  pattern 14, `aside-05`). Silver's `orchestration/subagent.ts` supports spawning read-only children
  (`readOnly` flag at line 70) but nothing in the read files shows a criteria-generated-blind, PASS/FAIL
  verification pass wired into the main flow — this would need to be a host-orchestration pattern layered on top
  of Silver's subagent primitive, since Silver itself has no persistent loop to hook it into.

---

## 5. Memory + subagents as one clean primitive, and injection defense as a first-class citizen

**What/why:** (a) Markdown-on-disk as sole source of truth, vectors/indices as disposable derived cache — Aside's
`.mossvec`/BM25 are 100% rebuildable. (b) Subagent = literally another session with a restricted tool-gate
(blocklist, not a different context), one level deep, concurrency-capped at 5, no live browser-tab state shared
even on `fork_self`. (c) A strict trusted-channel rule: `<system_message>` only trusted in a user-role wrapper;
ALL tool output — page content, search results — gets wrapped in `[BEGIN_UNTRUSTED_TOOL_OUTPUT]` markers with a
neutralizer that strips forged role/boundary tags.

**Silver status — ALREADY HAS ALL THREE, and cites Aside directly in its own comments.**
- (a) `memory/store.ts:2-10`: "Grep-first markdown memory store (Aside's design, keyless) ... There is NO
  embedding / vector index ... Deleting any derived state loses nothing because the markdown IS [the truth]."
  `memory/search.ts:2-9`: "Grep-first memory ranking (keyless — no embeddings, no model)." Silver deliberately
  went FURTHER than Aside here per its own anti-pattern-2 read of the source material: no vector layer at all
  (keyless constraint), not even a local-embedding one — a defensible simplification given Silver's no-model
  design goal, but worth naming explicitly as a deliberate divergence, not an oversight.
- (b) `orchestration/subagent.ts:17-19`: "ONE LEVEL: a child cannot spawn. Enforced via `SILVER_SUBAGENT_DEPTH`"
  — direct structural match to Aside's `k4t`/one-level-deep tool-gate hook. `CONCURRENCY_CAP` enforced at
  `subagent.ts:189` (own lock-file/namespace scheme rather than Aside's in-memory session tracker — matches
  `aside-06`'s own anti-pattern-8 recommendation: "A CLI spawning subprocesses should enforce the same invariants
  via simpler means ... a lockfile or counted semaphore," which is exactly what Silver did).
- (c) `security/injection.ts` implements `neutralize()` — strips forged `<system>/<user>/<tool>/<assistant>`
  and `<untrusted>` tags, replaces with `[PROMPT_INJECTION_NEUTRALIZED]`, wraps in stable boundary markers
  (`⟦page-content untrusted⟧` / `⟦/page-content⟧`) that also de-fang the fence glyphs themselves so a page can't
  forge a fence-close. This is a closer, more careful implementation of Aside's pattern 15
  (`[BEGIN_UNTRUSTED_TOOL_OUTPUT]`) — Silver's fence-glyph de-fanging (using non-ASCII `⟦⟧` a page can't type,
  then still scrubbing them if present) is arguably MORE robust than Aside's plain-bracket tags, which a
  sufficiently adversarial page could imitate more easily.

**One real gap in this bucket:** Aside's `request_action_confirmation` requires a structured draft ARTIFACT
(gmail-draft, x-tweet-draft, etc., or a screenshot) before any consequential action — the human sees exactly what
will be sent, not just a yes/no. Silver's `security/confirm.ts` (`confirmGateDecision`) is a boolean fail-closed
gate (deny on non-TTY unless pre-approved via `--confirm-actions`) with no structured "here is the draft you're
about to submit" artifact step. **GAP:** worth adding an optional structured-preview step for `--confirm-actions`
mode, at least for the destructive/paid-name-matched verbs already flagged by `isDestructivePaidName`.

---

## Summary of gaps to prioritize

1. **CORE GAP:** No single code-execution (`repl`) action surface — Silver's N-verb, per-invocation dispatch is
   the opposite design axis from Aside/Browser-Use's converged "agent as code-execution" thesis. This compounds
   with the per-command CDP reconnect cost the project brief already flags.
2. **VERIFY, DON'T ASSUME:** Pre-flight actionability gates (`checkHitTarget` for overlay-covered clicks) and
   password-field redaction in the snapshot tree — read `actuation/actions.ts` directly before claiming gap or
   parity.
3. **NICE-TO-HAVE:** Structured draft-artifact preview inside the confirm gate, cross-origin iframe inlining,
   ref-reuse-for-unchanged-elements across snapshots.
4. **NOT a gap, a deliberate and well-justified divergence:** no vector/embedding memory layer — consistent with
   Silver's keyless constraint and actually the choice Aside's own material recommends for a CLI-shaped tool.
