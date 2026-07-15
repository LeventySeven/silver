# webwright vs moxxie — perception / "screenshot only when needed" gap analysis

Source read: `reference/webwright/src/webwright/{environments/local_browser.py, tools/image_qa.py, tools/self_reflection.py, agents/default.py, config/{base,local_browser,persistent_browser}.yaml}`
Moxxie read: `skill/agent-browser/src/perception/{walk.ts, serialize.ts, diff.ts, refmap.ts}`, `skill/agent-browser/src/core/handlers.ts` (`handleSnapshot`, `handleScreenshot`), `skill/agent-browser/src/actuation/pagechange.ts` (referenced, not modified).

## Framing: webwright is NOT "vision-gated" at the capture layer — it's gated at the *attachment* layer

`local_browser.py::_capture_observation` (lines 463-502) captures **both** `page.locator("body").aria_snapshot()` **and** a `page.screenshot(full_page=False)` on **every single step**, unconditionally — no branching on "is vision needed". The actual gating happens one layer up, in prompt/config wiring:

- `base.yaml`/`local_browser.yaml`: `model.attach_observation_screenshot: false` — the screenshot is saved to disk (`step_%04d.png`) and its **path** is put in the text prompt, but the PNG bytes are never attached to the model call by default.
- The agent is instructed (`base.yaml` line 110): *"Step screenshots are NOT automatically attached to your prompt... If you need visual interpretation, you must invoke the image QA tool yourself"* — `webwright.tools.image_qa` / `webwright.tools.self_reflection`, both of which make a **separate model call** with the image attached.

So the real pattern is: **cheap always-on capture-to-disk, decoupled from expensive vision-token attachment, with attachment gated behind an explicit tool the agent chooses to invoke.** Moxxie already implements the second half of this (screenshot is a distinct `moxxie screenshot` verb the host calls only when it wants pixels) but not the first half (no cheap always-on capture), and has no code-level signal for *when* the host should bother.

## Gap findings

1. **[P1, adopt] No signal when the AX tree is too sparse to trust — canvas/WebGL/embed-heavy pages render an almost-empty snapshot with zero hint to fall back to `screenshot`.**
   - Source: webwright never automates this either (it's a prompt instruction: "if you need visual interpretation, invoke image QA yourself") — but the underlying need (tell the agent when text perception is unreliable) is real and webwright's docs treat it as first-class guidance.
   - Moxxie today (`skill/agent-browser/src/perception/serialize.ts::render`): the only conditional note line is `# note: interactive elements only` for `--interactive`. There is no check on ref-eligible node count vs. DOM size, and `walk.ts::SCAN_JS` doesn't special-case `<canvas>`/`<embed>`/`<object>`/`<video>` dominance.
   - Change: in `render()` (serialize.ts), when `nodes.filter(n => n.refEligible).length` is very low (e.g. <3) relative to a non-trivial page, OR `walk.ts`'s in-page scan detects a `<canvas>`/`<embed>`/`<object>` covering most of the viewport, emit a note line like `# note: sparse accessibility tree — page may be canvas/plugin-rendered; try 'moxxie screenshot' for visual context`. Pure heuristic, no model call.
   - keyless_ok: true. Priority: P1 (cheap, directly answers "when is vision needed" for the lens).

2. **[P1, adopt] No automatic console/page-error capture attached to snapshot output.**
   - Source: `local_browser.py::_attach_page_listeners`/`_on_console_message`/`_on_page_error` (lines 370-386) plus `_capture_observation` (lines 500-501) attach `console_output` (last 20 lines since the previous step) and `recent_console` (last 50 overall) to **every** observation automatically, at zero extra round trip.
   - Moxxie current: `grep -n console skill/agent-browser/src/core/handlers.ts` returns nothing — `handleSnapshot` (handlers.ts:308-335) has no console/pageerror listener at all; `dialog`/`network` verbs are `notImplemented()` (handlers.ts:219-224), so JS errors are invisible to the host unless it separately screenshots and eyeballs a devtools overlay (it can't) or asks a human.
   - Change: add a lightweight `page.on('console'/'pageerror')` ring-buffer (session-scoped, e.g. last 20 lines) in the connection/session layer, and surface it as an optional `console` field or trailing note in `handleSnapshot`'s envelope (handlers.ts:308) — purely mechanical, no model call.
   - keyless_ok: true. Priority: P1 — this is the single highest-value, cleanly keyless capability webwright has that moxxie's perception layer entirely lacks.

3. **[P2, align] Screenshot response is a bare, uncorrelated blob — no pairing with the state that produced it.**
   - Source: `self_reflection.py::run_self_reflection_async` (lines 379-447) always pairs screenshots with `action_history_log` (from `final_script_log.txt`) in the same judge call, specifically so the verdict is grounded in *what led to this pixel state*, not just the pixel state alone.
   - Moxxie current: `handleScreenshot` (handlers.ts:372-381) returns only `{encoding, image}` or `{saved:true}` — no URL, no title, no reference to the current refmap generation or the last diff.
   - Change: have `handleScreenshot` include `url`/`title`/`generation` (same header fields `render()` already computes for snapshot, serialize.ts:118) in its envelope, so the host can correlate a screenshot with a specific snapshot generation without a second `moxxie snapshot` round trip.
   - keyless_ok: true. Priority: P2 (nice-to-have correlation, not a missing capability).

4. **[P2, skip-cargo-cult] Do NOT adopt "screenshot to disk on every step unconditionally."**
   - Source: `local_browser.py::_capture_observation` screenshots every step regardless of whether the host asked, to build a benchmark-judge evidence trail (`final_runs/run_<id>/screenshots/`) consumed later by `self_reflection.py`'s two-stage judge.
   - Moxxie current: `handleScreenshot` (handlers.ts:372) is an explicit, host-invoked verb — this is already the correct design for a keyless CLI where the host (not an offline judge) decides when pixels matter. Making every `moxxie snapshot` also silently write a PNG would double I/O cost and disk usage on every text-only turn for a benefit (post-hoc judge replay) moxxie's architecture doesn't need — moxxie has no offline grading pipeline reading `final_runs/*/screenshots/*`.
   - keyless_ok: true (trivially, since it's "don't do it"). Priority: P2 informational — flagged so this doesn't get re-proposed as "webwright always screenshots, we should too."

5. **[P2, skip-cargo-cult] Do NOT port `image_qa` / `self_reflection` as moxxie tools.**
   - Source: `tools/image_qa.py` (`run_image_qa`, lines 71-97) and `tools/self_reflection.py` (`run_self_reflection_async`, lines 379-447) both make a **separate LLM call** (`model_client(...)`, via `webwright.models.base`) to interpret an image — this is exactly the pattern the task's HARD RULE forbids for moxxie.
   - Moxxie current: N/A — no vision-model tool exists, correctly.
   - Change: none. The host LLM (already multimodal) IS webwright's `image_qa`/`self_reflection` model — moxxie's job is only to hand back `{encoding: base64, image}` (already does, handlers.ts:379) so the host can look at it itself. Any moxxie feature that calls out to a model to describe a screenshot is invalid.
   - keyless_ok: false as a literal port; true as "no-op, already correct." Priority: P2 (documented so it isn't reinvented).

6. **[P2, align] "Never full-page screenshot" hard rule is enforced by convention in webwright's prompts, not in code — moxxie should make its own default a code-level guarantee it already has, and document it.**
   - Source: `config/persistent_browser.yaml`/`base.yaml`: *"Always Avoid taking full page screenshot using Playwright... Never do `page.screenshot(full_page=True)`"* — stated only as agent instructions the LLM must remember and follow every time; nothing in `local_browser.py` prevents `full_page=True`.
   - Moxxie current: `handleScreenshot` (handlers.ts:375) already defaults `fullPage: flags.full` where `flags.full` must be explicitly passed — the safe default is structural, not prompt-enforced.
   - Change: none required functionally. Worth a one-line comment in `handlers.ts` near `handleScreenshot` noting *why* `fullPage` defaults false (huge base64 payloads / token blowup for tall pages) so a future edit doesn't flip the default — this is the one place moxxie is already ahead and should stay that way.
   - keyless_ok: true. Priority: P2 (defensive documentation, not a behavior change).

7. **[P1, align] `keep_last_n_observations` / ARIA-snapshot pruning across turns — moxxie's diff already solves the sharper version of this problem, but only for one hop back; there's no way for the host to force a fresh full-tree baseline mid-session without losing the diff-savings property.**
   - Source: `agents/default.py::_prune_old_observation_aria_snapshots` (lines 275-301) strips the ARIA text out of every observation older than the last N (`keep_last_n_observations: 1` in `local_browser.yaml`), replacing it with a placeholder, purely to bound prompt growth over long multi-step runs — since the agent loop keeps full conversation history and old ARIA dumps are useless once superseded.
   - Moxxie current: `perception/diff.ts::observe` (lines 28-46) already only ever diffs against the immediately-previous tree (`prevTree`) and returns whichever is shorter — this is strictly better than webwright's blunt "keep last N, blank the rest," since a stable page produces `NO_CHANGES` instead of a full re-dump, and a small change produces a short diff instead of full ARIA every time. **No gap here — moxxie's design already dominates webwright's for this specific problem.**
   - Change: none needed. Noting explicitly as a confirmed strength, not a gap, so it isn't miscounted as something to "fix."
   - keyless_ok: true. Priority: N/A (informational, included because the lens asked about diff/vision gating together).

8. **[P0, adopt] `_wait_for_observation_ready` — settle-before-capture is present in both, confirm parity but tighten the failure story.**
   - Source: `local_browser.py::_wait_for_observation_ready` (lines 452-461) waits for `domcontentloaded` with a bounded timeout (`observation_timeout_ms`, default 5000ms) **before every observation capture**, and swallows the timeout (best-effort) rather than failing the step.
   - Moxxie current: `handleSnapshot`/`handleScreenshot` both call `settleAndFingerprint(page, prev?.fingerprint, gen)` (handlers.ts:335, :253, :288) before rendering — confirmed present in `actuation/pagechange.ts` (not modified in this pass, referenced only). This looks structurally equivalent or stronger (fingerprint-based settle vs. a flat timeout).
   - Change: none identified from this read alone — flagged P0 only in the sense that if a future audit of `pagechange.ts` finds `settleAndFingerprint` does NOT bound its own wait the way webwright's flat `observation_timeout_ms` does, that would be the actual gap. Out of scope for this pass since `pagechange.ts` wasn't read in depth here.
   - keyless_ok: true. Priority: informational / follow-up, not a confirmed gap.

## Top recommendation

Add automatic console/page-error capture to the snapshot envelope (finding 2) and a sparse-AX-tree note that nudges the host toward `moxxie screenshot` (finding 1). Both are pure-heuristic, zero-model-call changes that close the two places where moxxie's host currently has to guess blind — "did that click actually throw a JS error?" and "is this AX tree lying to me because the page is a canvas app?" — which is exactly the class of thing webwright's always-on capture + prompt-level vision-fallback instruction exists to prevent.
