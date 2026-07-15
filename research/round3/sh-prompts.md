# Gap-alignment digest: Stagehand act/extract/observe/operator prompts vs moxxie extract/prompts.ts

Source read: `reference/stagehand/packages/core/lib/prompt.ts` (the current V3 prompt builders —
`buildExtractSystemPrompt`, `buildExtractUserPrompt`, `buildMetadataSystemPrompt`,
`buildObserveSystemPrompt`, `buildActSystemPrompt`, `buildActPrompt`, `buildStepTwoPrompt`,
`buildOperatorSystemPrompt`, `buildCuaDefaultSystemPrompt`, `buildGoogleCUASystemPrompt`).

Moxxie read: `skill/agent-browser/src/extract/prompts.ts` (verbatim older-generation copy of
ACT/EXTRACT/OBSERVE system prompts), `extract/transform.ts` (`buildBundle`, `EXTRACT_SYSTEM_PROMPT`
usage), `extract/resolve.ts` (`resolveIds`, ID_PATTERN), `actuation/actions.ts` (`act`, `ActVerb`),
`core/handlers.ts` (`handleExtract`), `perception/refmap.ts` (`parseRef`, `groundRef`).

Architectural note established by reading both sides: Stagehand's act/observe are themselves
LLM calls (a second model call grounds "click the sign in button" against the DOM tree and
returns an elementId). Moxxie's `act`/`find` are **not** LLM calls — the host LLM (the "brain")
reads the accessibility snapshot directly and passes a ref (`eN`) or a semantic locator
(role/text/label/testid) to a deterministic Playwright dispatch. This is a real, already-shipped
architectural improvement over Stagehand (one fewer model call, one less hallucination surface),
not a gap. The findings below are about what's left over in prompts.ts as a result of that
architecture change (dead/stale content) and what Stagehand's newer act/observe/extract prompt
text encodes as genuinely portable, keyless guidance moxxie should fold into SKILL.md or into its
verb implementations.

## Findings

### 1. EXTRACT_SYSTEM_PROMPT references a `print_extracted_data` tool moxxie doesn't have
- **source_does**: `buildExtractSystemPrompt` (prompt.ts:43-48) conditionally appends "ONLY print
  the content using the print_extracted_data tool provided" (repeated twice) — meaningful in
  Stagehand because extract is a tool-calling flow against `print_extracted_data`.
- **moxxie_current**: `extract/prompts.ts:25-34` `EXTRACT_SYSTEM_PROMPT` copies this line verbatim
  ("ONLY print the content using the print_extracted_data tool provided") even though
  `transform.ts:buildBundle` never defines or exposes any such tool — the host is expected to
  return JSON matching `id_transformed_schema` directly, not call a tool by that name.
- **recommendation**: align. Replace that clause with something schema-native, e.g. "Respond with
  JSON that validates against the provided schema; do not add commentary." Leaving the current
  wording risks the host LLM looking for a nonexistent tool and stalling or hedging.
- **change**: edit `EXTRACT_SYSTEM_PROMPT` in `extract/prompts.ts` to drop/replace the
  `print_extracted_data` sentence.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: prompt.ts:43-48 vs extract/prompts.ts:31 (`'ONLY print the content using the print_extracted_data tool provided.'`)

### 2. ACT_SYSTEM_PROMPT / OBSERVE_SYSTEM_PROMPT are dead exports
- **source_does**: `buildActSystemPrompt`/`buildObserveSystemPrompt` are live, wired into
  Stagehand's two-phase act/observe LLM calls.
- **moxxie_current**: `extract/prompts.ts` exports `ACT_SYSTEM_PROMPT` and `OBSERVE_SYSTEM_PROMPT`
  verbatim, but `grep -rln "ACT_SYSTEM_PROMPT|OBSERVE_SYSTEM_PROMPT"` across `src/` shows only
  `extract/prompts.ts` itself — no consumer. `actuation/actions.ts` and `core/handlers.ts` never
  import them; moxxie's act path is ref/locator-based (`groundRef` + Playwright), not an LLM
  bundle.
- **recommendation**: skip-cargo-cult, with an escape hatch. Since moxxie has no act/observe
  bundle command today, these two exports are pure surface area nobody calls — either delete them
  or (if a future "semantic act bundle" fallback for elements missing from the a11y tree is
  planned) gate them behind that real feature instead of shipping unused prompt strings now.
- **change**: in `extract/prompts.ts`, remove `ACT_SYSTEM_PROMPT` and `OBSERVE_SYSTEM_PROMPT` (or
  move them into a `future/` note) unless a concrete act/observe-bundle command is being built in
  the same change.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: extract/prompts.ts:17-23,36-42 vs `grep` showing zero importers outside the file itself.

### 3. Observe's "copy the elementId exactly, never truncate" warning is real defense-in-depth moxxie's docs are missing
- **source_does**: `buildObserveSystemPrompt` (prompt.ts:150-160) explicitly warns: "Each element
  in the accessibility tree has an ID in square brackets... Always copy the complete ID exactly as
  shown... never return only '18372'" — because Stagehand's IDs are compound
  (`frameOrdinal-backendNodeId`) and models like to drop the prefix.
- **moxxie_current**: `perception/refmap.ts:parseRef` structurally tolerates `@e12`/`ref=e12`/`e12`
  forms and `groundRef` rejects unknown/stale refs loudly — good structural mitigation. But nothing
  in the (not-yet-written) SKILL.md tells the host model to copy the `eN` token verbatim rather
  than inventing/renumbering one, and `extract/resolve.ts`'s separate `N-N` element-ID namespace
  (`ID_PATTERN = /^\d+-\d+$/`) has the exact same compound-ID truncation risk Stagehand's prompt is
  guarding against.
- **recommendation**: adopt as SKILL.md prose, not as a new runtime prompt. Add one line to the
  future SKILL.md's ref/ID section: "Copy `ref` (`eN`) and extract element-IDs (`N-N`) exactly as
  printed in the snapshot — never split, renumber, or reconstruct them from memory." Cheap, and it
  reinforces (doesn't replace) the structural `groundRef`/`resolveIds` gates.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: prompt.ts:159-160 vs refmap.ts `parseRef`/`groundRef`, resolve.ts:22 `ID_PATTERN`.

### 4. Custom "user instructions" injection point is redundant with moxxie's single `--instruction` flow — skip
- **source_does**: `buildUserInstructionsString` (prompt.ts:5-18) appends a distinct "# Custom
  Instructions Provided by the User" block to every act/extract/observe system prompt, separate
  from the per-call instruction, so a caller can set standing preferences once.
- **moxxie_current**: `extract/transform.ts:buildBundle` takes one `instruction?: string` and
  concatenates it after `EXTRACT_SYSTEM_PROMPT`. There's no separate "standing instructions" slot.
- **recommendation**: skip-cargo-cult. In moxxie's architecture the host LLM is the caller of
  `buildBundle` — it already fully controls the `instruction` string it passes and can prepend any
  standing preferences itself before invoking `extract`. A structurally separate channel adds a
  parameter and a prompt-assembly branch for something the host can already do for free.
- **change**: none — explicitly do not add a second instruction parameter to `buildBundle`.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: prompt.ts:5-18 vs transform.ts:149-168 (`buildBundle` signature).

### 5. Custom-dropdown two-step interaction pattern is a real capability gap, not just a prompt fragment
- **source_does**: `buildActPrompt`'s "Dropdown Specific Instructions" (prompt.ts:235-246) encodes
  a genuinely useful, model-agnostic UX fact: native `<select>` elements can be set directly
  (`selectOptionFromDropdown`), but custom (`div`/`li`-based) dropdown widgets require a two-step
  interaction — click to expand, then click the now-visible option (`twoStep: true`).
- **moxxie_current**: `actuation/actions.ts` `select` verb (line 282-286) calls
  `locator.selectOption(...)` unconditionally — this only works on a native HTML `<select>`. There
  is no verb or documented procedure for the very common custom-combobox case; a host that tries
  `select` on a `div[role=listbox]` trigger just gets a Playwright error with no guidance on the
  fix.
- **recommendation**: align via documentation, not a new verb — moxxie already has the primitives
  (`click` + re-snapshot + `click` the revealed option); it's a procedure gap, not a code gap.
  Document it explicitly in SKILL.md's actuation section: "For a native `<select>`, use `act select`
  directly. For a custom dropdown (no native `<select>` in the ref's ancestry), `click` to open it,
  re-snapshot, then `click` the revealed option — do not call `select` on non-`<select>` elements."
- **change**: add this two-path guidance to the future SKILL.md; optionally have `select`'s error
  path (when `selectOption` throws on a non-select element) surface a hint pointing at the
  click-then-click pattern instead of a bare Playwright error.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: prompt.ts:235-246 vs actuation/actions.ts:282-286.

### 6. `press` verb has no key-name normalization guidance — silent failure risk on casing
- **source_does**: `buildActPrompt`/`buildStepTwoPrompt` (prompt.ts:233, 273) spell out Playwright's
  key-name casing rule explicitly: single characters lowercase (`'a'`), special keys capitalized
  only on the first character (`'Enter'`, `'Tab'`, `'Escape'`) — because Playwright's `.press()` is
  case-sensitive for named keys and a lowercase `'enter'` throws/no-ops.
  Verified in source's own downstream consumer: `packages/core/lib/v3/handlers/actHandler.ts`
  passes this argument straight to Playwright `press`.
- **moxxie_current**: `actuation/actions.ts:276-278` — `case 'press': await
  locator.press(value ?? '', { timeout })` — passes the host-supplied `value` straight to
  Playwright with zero normalization or validation. A host that emits `'enter'` (lowercase, the
  natural-language-adjacent guess) gets a Playwright "Unknown key" throw instead of the intended
  keypress.
- **recommendation**: align. This is the single highest-signal, cheapest fix in this digest: either
  (a) document the exact casing rule in SKILL.md's `press` section (matches Stagehand's proven
  wording), or (b) go one step further than Stagehand and normalize keyless in code — map common
  lowercase aliases (`enter`→`Enter`, `esc`/`escape`→`Escape`, `tab`→`Tab`, arrow variants, etc.)
  before calling `.press()`, which removes the failure mode structurally instead of relying on the
  host getting the prompt right.
- **change**: `actuation/actions.ts` `case 'press'` — add a small alias-normalization step (or, at
  minimum, document the exact-casing requirement in SKILL.md) before `locator.press(value, ...)`.
- **keyless_ok**: true
- **priority**: P0
- **evidence**: prompt.ts:233 ("Capitalize the first character like 'Enter', 'Tab', 'Escape' only
  for special keys") vs actuation/actions.ts:276-278 (no normalization).

### 7. No page-level scroll primitive (percentage / chunk) — real gap for long-page tasks
- **source_does**: `buildActPrompt` (prompt.ts:231-232) supports scrolling to a percentage of the
  page ("halfway", "75%") and `nextChunk`/`prevChunk` for paginated reading, because Stagehand
  chunks long pages for extraction and needs the model able to navigate chunks.
- **moxxie_current**: `grep -rn "scroll"` across `src/` shows only `scrollIntoViewIfNeeded` on a
  single ref (`actuation/actions.ts:292-293`) — there is no page-level "scroll to N%" or "scroll by
  viewport" command. A host trying to reach content far down an infinite-scroll page has no
  deterministic keyless primitive; it must click something to trigger a native scroll.
- **recommendation**: adopt, scoped down. Moxxie doesn't need Stagehand's chunk-based extraction
  concept (extract already operates over a full snapshot, not a windowed chunk), but a
  page-level scroll verb (`scroll --to 50%` or `scroll --by 800`) implemented with
  `page.mouse.wheel()`/`page.evaluate(() => window.scrollTo(...))` is a small, purely mechanical,
  keyless addition that closes a real gap for infinite-scroll / lazy-load pages without any model
  involvement.
- **change**: add a page-level scroll verb to `actuation/actions.ts` (distinct from the existing
  ref-scoped `scroll` = `scrollIntoViewIfNeeded`), wired through `core/handlers.ts` and
  `security/registry.ts` alongside the existing `'scroll'`/`'scrollintoview'` actor verbs.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: prompt.ts:231-232 vs actuation/actions.ts:292-294 and registry.ts:68-69 (only
  element-relative scroll registered).

### 8. Stagehand's operator "tool menu" is a good SKILL.md organizing pattern, not a runtime prompt to ship
- **source_does**: `buildOperatorSystemPrompt` (prompt.ts:281-314) gives the operator-agent LLM a
  short "Available tools and when to use them" table (`act`/`extract`/`goto`/`wait`/`navback`/
  `refresh`/`close`) plus guardrails ("ALWAYS use tools", "one atomic action per act call", "only
  close when genuinely done").
- **moxxie_current**: there is no SKILL.md yet (per task framing, it's a future deliverable); the
  host LLM currently has to infer moxxie's command surface from `cli.ts`/`--help` output alone.
- **recommendation**: adopt the *pattern*, not the text — this is not a model-facing prompt for
  moxxie to embed anywhere at runtime (moxxie never calls a model), it's a template for the
  SKILL.md's own top-level structure: a short table mapping moxxie verbs (`act`, `find`, `extract`,
  `extract resolve`, `snapshot`/observe-diff, `wait`) to "when to use this one", plus the same
  atomicity guardrail ("one action per `act` call; don't chain multiple verbs in one instruction")
  since moxxie's `act` is exactly as single-action as Stagehand's.
  Do NOT port `close`/`refresh`/CUA-specific tool names — those are Stagehand agent-loop artifacts
  moxxie has no equivalent of and shouldn't invent equivalents for just to match the shape.
- **change**: use this table shape as the SKILL.md outline when it's written; no source change to
  `extract/prompts.ts` needed for this finding.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: prompt.ts:293-301 (tool table) vs absence of SKILL.md; actuation/actions.ts `ActVerb` union as moxxie's actual verb set.

## Top recommendation

Fix finding #6 first (`press` casing) — it is a one-line, zero-risk, structural fix (alias
normalization in `actuation/actions.ts`) that removes a silent-failure class entirely, is strictly
better than Stagehand's prompt-only mitigation, and needs no SKILL.md to exist yet to land.
