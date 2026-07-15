# Gap-alignment digest: core-agent-browser SKILL.md patterns vs. moxxie's `handleSkill()`

**Source**: `/Users/seventyleven/Desktop/best-rust-patterns-skills/skills/core-agent-browser/SKILL.md`
**Lens**: SKILL.md design lessons — command tables, worked examples, the look-act-look loop, phase-scoping (when to invoke this tool at all vs. defer to something else).
**Moxxie anchors read**: `skill/agent-browser/src/core/handlers.ts` — `handle()` dispatcher (L157-228), `handleSkill()` (L858-879), `handleAct`/`handleFind`/`handleGet`/`handleWait`/`buildWaitSpec` (L387-599).

**Relation to prior digest**: `research/round3/ww-skill.md` already covers the *headline* gap — moxxie has no on-disk `SKILL.md` at all, `handleSkill()` is a hardcoded blurb with a literal "(Full SKILL.md ships in a later task.)" comment (L875). This digest does not re-litigate that; it supplies the **content shape** that on-disk file should take, using core-agent-browser's SKILL.md as a worked template for a tool that is architecturally close to moxxie (ref-based CLI wrapping Playwright, host is the brain, `@e1`-style refs).

---

## Findings

### 1. Command reference organized as short category tables — moxxie's skill text has none
- **source_does**: Body is organized into `### Navigation`, `### Snapshot`, `### Interactions`, `### Get information`, `### Screenshots`, `### Wait`, `### Semantic locators` — each a 3-8 line fenced code block of `agent-browser <verb> <args>  # one-line purpose` (L41-102). A host scanning this can find "how do I check a checkbox" in one glance without reading prose.
- **moxxie_current**: `handleSkill()` (handlers.ts L858-879) is two paragraphs of running prose ("Lean loop: `open <url>` -> `snapshot -i` ... Extract is host-run: ..."). It mentions maybe 6 of moxxie's ~25 verbs (open, snapshot, click, fill, extract, doctor) and never enumerates `get text/value/attr/title/url/count` (L462-509), `is visible/enabled/checked` (L511-529), the `wait` variants (L574-599), or `state save/load` / `cookies set` (L686-732) at all.
- **recommendation**: adopt
- **change**: When building the on-disk SKILL.md (per ww-skill.md finding #1), lay it out as category tables mirroring moxxie's actual verb groups from `handle()`'s switch comments (L159-227: lifecycle / perception / interaction / query / extract / auth-session / meta) — one fenced block per group, one line per verb, terse purpose comment. This is a documentation-only change; requires no handler code changes.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `SKILL.md:39-102`; moxxie `handlers.ts:157-228,462-529,574-599,686-732`.

### 2. Explicit numbered "Core workflow" loop before the command tables
- **source_does**: A 4-line numbered loop precedes all commands (L32-37): "1. Navigate ... 2. Snapshot (returns refs) ... 3. Interact using refs ... 4. Re-snapshot after navigation or significant DOM changes." This is the single most load-bearing sentence in the file — it tells the host *when* to re-perceive, which is exactly the failure mode (acting on stale refs) moxxie's generation-gated refmap exists to catch.
- **moxxie_current**: moxxie's `short` text (L860-866) does state the loop ("`open <url>` -> `snapshot -i` -> act -> re-`snapshot`") but folds it into one run-on sentence, and never states the *trigger* for re-snapshotting (source's "after navigation or significant DOM changes"). moxxie's own action responses already carry `page_changed`/`stale_refs` flags (L430-435, from `settleAndFingerprint`) that are the mechanical signal for exactly this — but that signal isn't surfaced in the skill text as "re-snapshot when you see `page_changed: true`".
- **recommendation**: align
- **change**: In the new SKILL.md, give the loop its own numbered section, and explicitly wire it to moxxie's own envelope fields: "4. If the last action's response has `page_changed: true` or `stale_refs` non-empty, re-snapshot before continuing — do not reuse old `@eN` refs." This ties the doc to a real, already-implemented signal instead of just "and then re-snapshot" prose.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `SKILL.md:32-37`; moxxie `handlers.ts:334,424-435` (`fp.page_changed`, `fp.stale_refs`).

### 3. One end-to-end worked example ("Example: Form submission") — moxxie's skill text has zero examples
- **source_does**: L104-116 shows a complete session: open a form page, snapshot -i, read the sample output showing three refs, then three fill/click/wait calls followed by a re-snapshot to check the result. It is copy-pasteable and shows the ref-naming convention (`[ref=e1]`) in context.
- **moxxie_current**: `handleSkill()` never shows a single example invocation or sample output. A host agent seeing moxxie for the first time has to infer the snapshot output shape (moxxie's is `id=<gen>-<n>` for extract, `ref=eN` for interactive elements per `render()` in perception/serialize.ts, referenced at handlers.ts L319-331) from trial and error.
- **recommendation**: adopt
- **change**: Add one worked example to the SKILL.md body: `open` a page, show real `snapshot -i` output text (element list with `ref=eN`), then `fill @e1 ...`, `click @e2 ...`, then note the `page_changed` flag in the response and the re-snapshot. Reuse moxxie's own `render()` output format so the example is truthful, not aspirational.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `SKILL.md:104-116`; moxxie `handlers.ts:308-345` (`handleSnapshot`, `render()` call).

### 4. Semantic locators documented as a first-class alternative to refs — moxxie has the capability but never advertises it
- **source_does**: A dedicated `### Semantic locators (alternative to refs)` section (L97-102) documents `find role button click --name "Submit"` / `find text "Sign In" click` / `find label "Email" fill "user@test.com"` as a way to act on elements *without* a prior snapshot — useful when the host knows the target semantically but hasn't (or can't) enumerate refs first.
- **moxxie_current**: moxxie already implements this — `handleFind()` (handlers.ts L442-456) dispatches to `find(page, kind, val, subaction, opts)` in `actuation/actions.ts`, supporting a `kind`/`value`/optional `subaction`/`subValue` shape that maps directly onto the source's `find <kind> <value> [action] [text]` pattern. But `handleSkill()`'s text never mentions `find` at all — a host relying only on the built-in skill text would never discover this exists and would always pay for a full `snapshot` first.
- **recommendation**: adopt (documentation only — the feature is already built)
- **change**: Add a `find` line/example to the SKILL.md: `moxxie find role button --name "Submit" click` (verify exact flag/arg order against `handleFind`'s actual parsing at L442-456 before publishing) with a one-line note: "skip snapshot when you already know the semantic target." This is pure doc debt, zero code change.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: source `SKILL.md:97-102`; moxxie `handlers.ts:192-193,442-456`.

### 5. `wait` variants documented as one table with 5 distinct forms — moxxie's richer wait spec is entirely undocumented
- **source_does**: `### Wait` (L89-95) shows 4 forms: wait-for-element, wait-ms, wait-for-text, wait-for-load-state.
- **moxxie_current**: `buildWaitSpec()` (handlers.ts L574-599) actually supports a *superset*: ref, ms, CSS selector (fallback when the arg isn't a ref or a bare number), `--text`, `--url`, `--load`, and `--fn` (a custom predicate) — the `--url` and `--fn` forms have no analog in the source at all and are moxxie strictly ahead here. None of this is in `handleSkill()`'s text.
- **recommendation**: adopt the source's *table shape*, not its content (moxxie's wait is already a superset — skip importing anything functional, just document what's there).
- **change**: Add a `### Wait` table to SKILL.md enumerating all 7 moxxie forms (ref/ms/selector/--text/--url/--load/--fn), each with a one-line purpose, mirroring the source's format exactly.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `SKILL.md:89-95`; moxxie `handlers.ts:574-599`.

### 6. Priority note ("use this only as last resort after actionbook/rust-learner") — skip-cargo-cult
- **source_does**: L10-20, "Priority Note": for Rust/crate info, prefer a pre-computed-selector MCP (`actionbook`) and an orchestrating skill (`rust-learner`) over raw browser automation; use agent-browser directly "only when actionbook has no pre-computed selectors ... or you need interactive testing/screenshots." This is phase-scoping for a *multi-tool ecosystem* where core-agent-browser is the fallback tier of a 3-tier stack.
- **moxxie_current**: moxxie is not one tier of a larger stack from its own vantage point — it IS the browser-automation primitive a host reaches for. There is no equivalent "prefer X over moxxie" ecosystem note to write, and inventing one (e.g., "prefer `curl`/`fetch` over moxxie for pure GETs") would be a different, unrelated finding, not a translation of this one.
- **recommendation**: skip-cargo-cult
- **change**: none — do not add a "when NOT to use moxxie vs. some other internal tool" section modeled on this; it's solving a problem (multi-tool routing within one team's private skill library) moxxie's SKILL.md doesn't have. (Moxxie's `handleRead()` already has its own honest fetch-vs-browser split — plain `fetch()` for a bare `read <url>` without a session at L351-370 — which is the closest real analog and needs no doc borrowed from this source.)
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `SKILL.md:10-20`; moxxie `handlers.ts:351-370` (existing `fetch()`-based fast path, unrelated to source's routing note).

### 7. Flag-based snapshot shaping (`-i`, `-c`, `-d N`) shown inline in the command table — moxxie's flags exist but aren't cross-referenced to the verb table
- **source_does**: `### Snapshot` table (L50-56) shows `snapshot`, `snapshot -i`, `snapshot -c`, `snapshot -d 3` as four distinct lines under one verb, each flag's effect spelled out in the trailing comment — so a host sees flag combinations, not just the bare verb list.
- **moxxie_current**: `handleSnapshot()` (handlers.ts L308-345) supports `flags.interactive`, `flags.compact`, `flags.depth`, `flags.selector`, `flags.maxOutput` — a superset of the source's three flags, but `handleSkill()`'s text mentions only `snapshot -i`.
- **recommendation**: adopt
- **change**: In the SKILL.md's snapshot table, list `snapshot`, `snapshot -i` (interactive-only, recommended), `snapshot -c` (compact), `snapshot -d N` (max depth), and `snapshot --selector <css>` (scope to a subtree) as separate documented lines, matching moxxie's real flag surface at L314-317.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: source `SKILL.md:50-56`; moxxie `handlers.ts:308-317`.

### 8. `disable-model-invocation: true` + `user-invocable: false` frontmatter — cargo-cult for moxxie's target use case
- **source_does**: Frontmatter (L4-5) marks this skill as *not* directly invocable by the user or auto-routable by the model — it's a support skill only reachable via orchestration from `rust-learner`/`docs-researcher`/`crate-researcher`.
- **moxxie_current**: N/A — moxxie's planned SKILL.md (per ww-skill.md #1) is meant to be the primary, directly-discoverable entry point for browser automation, not a hidden internal dependency of another skill.
- **recommendation**: skip-cargo-cult
- **change**: none — moxxie's frontmatter should keep `user-invocable`/auto-routing on (the opposite of this source's setting); copying this flag verbatim would make moxxie undiscoverable by design, which is the wrong outcome for a general-purpose tool.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: source `SKILL.md:4-5`.

---

## Top recommendation

Findings #1, #3, #4, and #7 are all "moxxie already has the capability, the SKILL.md content just doesn't say so" — they compound into one action: when writing the on-disk SKILL.md (already flagged P0 in `ww-skill.md`), use core-agent-browser's *category-table + one-worked-example* shape as the literal template, populated with moxxie's real (and in several cases strictly richer — `wait`, `find`) verb surface pulled straight from `handle()`'s switch and each handler's actual flag parsing, not from the current `handleSkill()` prose. This is a pure-documentation change (zero handler code touched) with the highest leverage-to-effort ratio of anything in this digest.
