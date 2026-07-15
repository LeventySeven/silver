# ASIDE-as-harness → moxxie gap alignment (round 3)

Lens: why-SOTA harness levers (95_why_sota.md, 20_runtime_loop.md, 96_tool_registry_full.md)
vs moxxie's actual current code (`src/core/handlers.ts`, `src/core/session.ts`, plus
`src/actuation/actions.ts`, `src/perception/walk.ts`, `src/perception/diff.ts` read for
grounding). moxxie is keyless — Aside's daemon/model-loop machinery (§0-1, §10 of
20_runtime_loop.md; the whole ReAct/compaction/model-routing stack) is **not** a moxxie
target by construction; the only transferable levers are the ones that don't require a
model call: fixed viewport, lean prompt/skill discipline, recovery/verification ladders,
local-only tool backends, diffed observation.

## What moxxie already has right (not gaps — noted so we don't re-litigate)

- **Diff-when-shorter observation** — Aside's §3.2 "diff, don't re-serialize" is already
  implemented: `handleSnapshot` in `handlers.ts:308-345` calls `observe(prev.prevTree, text)`
  from `src/perception/diff.ts`, storing `prevTree` in the `moxxie-state.json` sidecar
  (`UabState.prevTree`, `handlers.ts:76`). This is the single highest-value Aside lever and
  moxxie has it. No change needed.
- **Enriched a11y nodes** — `checked/selected/disabled/focused/placeholder` flags exist in
  `src/perception/walk.ts:41-47, 220-229`, matching Aside's enrichment fields (95_why_sota.md
  §3.2). Missing only `size=WxH` and iframe-inlining (see Finding 6).
- **No `--enable-automation` flag** — `session.ts` spawns Chromium directly via
  `spawn(execPath, args, ...)` (session.ts:107-110) bypassing Playwright's launcher, which is
  what normally injects `--enable-automation`/`--disable-extensions` etc. This is Aside's
  §3.3 "stealth-by-authenticity" lever, already achieved for free. No change needed.
- **fill-with-readback retry** — `actions.ts:305-315` (`fillVerb`) already does Aside's
  actionability-retry pattern locally: fill, read back, and if the value didn't stick, clear +
  `pressSequentially` char-by-char. Playwright's built-in actionability checks (visible,
  stable, receives-events, auto-scroll-into-view) already cover Aside's
  `waitForReady`/`checkHitTarget`/`scrollIntoViewIfNeeded` ladder (95_why_sota.md §3.4) for
  free — no bespoke reimplementation needed.

## Gap findings

See structured findings below (`moxxie_gaps`). Digest continues with detail for the two
findings that need extra grounding not fully captured in the structured summary:

**Finding: no fixed viewport.** Grepped the entire `src/` tree for
`viewport|setViewportSize|1280|1440` — zero hits outside a docstring in `confirm.ts`. Chromium
is spawned in `session.ts:96-105` with no `--window-size` and no
`context.setViewportSize(...)` call anywhere, and `connect()` in `session.ts:202-212` just
takes `context.pages()[0]`. Every run therefore inherits whatever the OS/window-manager gives
headless Chromium (historically 800x600 on headless=new unless overridden) — non-deterministic
screenshot geometry across machines/CI and no principled reason to pick one size over another.
Aside hardwires 1440x900 specifically because vision-assisted steps and pixel/coordinate
reasoning are trained on canonical resolutions (95_why_sota.md §3.3) — moxxie doesn't do
vision/coordinate acting today, but a fixed default viewport is still a pure win: reproducible
screenshots, reproducible snapshot geometry (`size=WxH` becomes meaningful once added),
reproducible eval runs. Zero model calls required — purely a `--window-size=1280,800` launch
arg or a `context.setViewportSize()` call.

**Finding: webfetch/`read` quality gap.** `handlers.ts:920-936` (`htmlToText`) is a regex
tag-stripper: drop script/style, strip all tags, decode 5 entities, collapse whitespace. Aside's
`webfetch` (96_tool_registry_full.md §2) runs a **local, keyless** Readability-style article
extractor + Turndown markdown converter (`$Ze`/`eQe`/`GZe`, offset 13397230) — no network
dependency beyond the fetch itself, fully replicable without a model. moxxie's flat-strip
produces noisy nav/footer/ad text; a bundled Readability+Turndown pass (both are permissively-
licensed local npm libs, not services) would materially raise the signal of `moxxie read <url>`
without adding any keyed dependency. This is the single most direct "adopt, not skip" lever in
the whole tool-registry file because it's *provably local* (96_tool_registry_full.md §2's whole
point is correcting the assumption that this needs Exa/Jina — it doesn't, and neither does
moxxie).

## Explicitly skip (cargo-cult for a keyless CLI)

- **websearch backend** (`POST api.asidehq.com/search`) — requires Aside's own hosted search
  index; not reproducible keylessly. moxxie has no `search` verb and shouldn't grow one that
  calls a third-party paid API; if the host wants search, that's the host's own tool, outside
  moxxie's scope.
- **Daemon/WS runtime loop, steer/queue/interrupt, resume-cursor replay, auto-compaction,
  auto-retry-with-backoff on model calls, "dreaming" memory consolidation, subagent
  orchestration tree** (20_runtime_loop.md §1-9, §11-12) — all of this exists to manage a
  long-lived *model* loop state machine. moxxie is a stateless-per-invocation CLI the host
  calls once per verb; there is no in-process model loop to steer, queue, interrupt, retry, or
  compact. Re-introducing any of this would be pure bloat against moxxie's own design
  (`browser-as-daemon`, not `agent-as-daemon`).
- **Captcha-solving OCR/mouse loop** — inherently a vision-model-in-the-loop capability; skip.
- **Skills-as-per-site-strategy files (28+16 SKILL.md set)** — real lever for a shipped product
  with curated site knowledge, but out of scope for moxxie's OSS core; better left to the host
  (moxxie's own SKILL.md is the single skill; per-site playbooks belong to whoever operates the
  agent, not to the keyless tool).
- **YouTube InnerTube backend, Chrome-extension bridge, Apple Passwords autofill** — Chromium-
  fork-specific integrations with no keyless-CLI analog; skip.

## Priority summary

- P0: fixed default viewport (`session.ts` openSession) — cheap, load-bearing for screenshot/
  eval reproducibility.
- P1: Readability+Turndown for `moxxie read` (`handlers.ts:handleRead`/`htmlToText`) — direct
  quality lift, fully local.
- P1: SKILL.md recovery/verification/reading-escalation ladder (`handlers.ts:handleSkill`) —
  encodes Aside's §3.4 lean-prompt discipline as host-facing guidance text, not code.
- P2: batched/chained actions to cut host↔CLI round-trips (CodeAct lesson, re-expressed as a
  keyless multi-verb batch flag).
- P2: `size=WxH` + iframe-inlining in the snapshot serializer (`walk.ts`/`serialize.ts`).
