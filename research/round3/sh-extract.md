# Stagehand extract() vs moxxie extract — gap alignment

Lens: extract() schema/zod + id-grounding + injectUrls vs moxxie extract (transform/resolve).

Source read: `packages/core/lib/utils.ts` (`transformSchema`, `injectUrls`, `makeIdStringSchema`,
`ID_PATTERN`), `packages/core/lib/v3/handlers/extractHandler.ts`, `packages/core/lib/v3/types/public/methods.ts`
(`defaultExtractSchema`, `pageTextSchema`).

Moxxie read: `skill/agent-browser/src/extract/transform.ts`, `resolve.ts`, `prompts.ts`,
`skill/agent-browser/src/core/handlers.ts` (`handleExtract`, `handleExtractResolve`),
`skill/agent-browser/src/perception/walk.ts` (`SnapshotOptions`), `skill/agent-browser/src/core/flags.ts`.

## Findings

### 1. [P0, adopt] ID-field description drops the user's per-field hint — thread it through
- Source: `utils.ts:672-686` `makeIdStringSchema` composes `"This field must be the
  element-ID... that follows this user-defined description: {userDesc}"` — it keeps the
  original field's `.describe()` text and appends it to the ID-shape instruction.
- Moxxie now: `transform.ts:39-45` `idField()` always returns a FIXED, context-free description
  (`"the element ID of the link, e.g. 0-18372"`) regardless of what description the caller's
  schema had on that field (e.g. `"the author's profile URL, not the article URL"`). `walk()`
  (`transform.ts:86-89`) calls `idField()` with no reference to `node.description`.
- Change: in `transform.ts`, change `idField()` to `idField(origDescription?: string)` and call
  it as `idField(node.description)` at both call sites in `walk()` (the `isUriString` branch and
  the `nameIsUrlLeaf` branch). Compose like stagehand: base ID-shape sentence + `" that follows
  this user-defined description: " + origDescription` when present.
- Why it matters: with multiple links per row (e.g. "product name" links to a details page AND
  a "seller" link to a profile), the field name/type alone often can't disambiguate which link
  a given ID field wants — the caller's description is the only signal, and it's currently
  discarded exactly on URL fields, which is where disambiguation is most needed.
- keyless_ok: true (pure string composition, no model call).
- Evidence: source `utils.ts:672-686`; moxxie `transform.ts:38-45,86-89`.

### 2. [P1, adopt] extract has no `--selector` scoping despite the primitive already existing
- Source: `extractHandler.ts:116,133,159,163-167` — `extract()` takes a `selector` param
  (XPath, `focusSelector`) and passes it into `captureHybridSnapshot(page, {focusSelector,
  ignoreSelectors})` to scope the whole extraction to one subtree.
- Moxxie now: `handlers.ts:615` `handleExtract` calls
  `snapshotNodes(page, { interactive: true })` with NO `selectorScope`, even though
  `SnapshotOptions.selectorScope` already exists (`perception/walk.ts:58-65`) and is already
  wired for the plain `snapshot` command (`handlers.ts:316`:
  `if (flags.selector !== undefined) snapOpts.selectorScope = flags.selector`). `--selector`/`-s`
  is already a parsed flag (`flags.ts:45,87,124`) — `handleExtract` just never reads it.
- Change: in `handlers.ts` `handleExtract`, add
  `const snapOpts: Parameters<typeof snapshotNodes>[1] = { interactive: true }` +
  `if (flags.selector !== undefined) snapOpts.selectorScope = flags.selector` and pass
  `snapOpts` instead of the inline literal.
- Why it matters: this is also moxxie's keyless answer to stagehand's LLM-driven chunking
  (see #6) — on a huge page, the host can narrow extraction to one container via `--selector`
  instead of the CLI silently truncating or a model re-chunking. Zero new code paths, one
  three-line wire-up of an existing flag to an existing option.
- keyless_ok: true.
- Evidence: source `extractHandler.ts:116-167`; moxxie `handlers.ts:314-316` (already does this
  for `snapshot`) vs `handlers.ts:615` (does not, for `extract`); flag definition
  `flags.ts:45,87,124`.

### 3. [P1, align] no `ignoreSelectors` — noisy chrome (nav/footer/cookie-banner) pollutes every extract bundle
- Source: `extractHandler.ts:117,163-167` threads `ignoreSelectors` into
  `captureHybridSnapshot` so callers can exclude known-noisy subtrees (nav bars, footers, cookie
  banners) from the a11y tree handed to the model.
- Moxxie now: `SnapshotOptions` (`perception/walk.ts:58-65`) has `interactive`, `maxDepth`,
  `selectorScope` — no exclude-list. `handleExtract` and the plain `snapshot` command have no way
  to drop a known-noisy subtree; the host either eats the token cost or can't extract cleanly at
  all if the target content is buried among 40 repeated nav links.
  moxxie's `--selector` (finding #2) is an *include*-one-subtree tool, not an *exclude-list*
  tool, so it doesn't fully substitute (a host still needs the whole page minus footer/cookie
  chrome, not one CSS-scoped fragment).
- Change: add `ignoreSelectors?: string[]` to `SnapshotOptions`, apply it in the same in-page
  `SCAN_JS` prune pass that already computes `prune` for hidden elements (`walk.ts:381-406`) — a
  node whose closest ancestor matches any ignore selector gets pruned exactly like a hidden node.
  Wire an `--ignore <css,css>` flag through to `extract` (and optionally `snapshot`).
- keyless_ok: true (pure CSS `matches`/`closest` filtering, no model call).
- Priority note: P1 not P0 because `--selector` scoping (#2) covers the common case
  (target content lives in one known container); this is the complement for "can't cleanly
  scope in, must scope out" pages.
- Evidence: source `extractHandler.ts:117,163-167`; moxxie `perception/walk.ts:58-65,381-406`
  (no ignore-list equivalent exists).

### 4. [P2, skip-cargo-cult] no-schema/no-instruction "pageText" fallback — moxxie already has this as `snapshot`
- Source: `extractHandler.ts:130-145` — calling `extract()` with neither instruction nor schema
  returns `{ pageText: combinedTree }` directly (validated against `pageTextSchema`,
  `methods.ts:72-74`), with NO model call — pure snapshot passthrough "for v2 parity."
- Moxxie now: `handleExtract` (`handlers.ts:608-609`) hard-requires `--schema` and returns
  `badRequest` otherwise.
- Recommendation: do NOT add a no-schema extract mode. Moxxie's `snapshot` command
  (`handlers.ts` ~line 314) already IS this feature — full a11y tree text, no schema, no
  inference. Adding a second no-args path under `extract` would be a redundant surface for the
  same host action (`moxxie snapshot` vs `moxxie extract`) and is exactly the kind of API-parity
  cargo-cult that doesn't earn its keep once you already have one primitive that does it.
- keyless_ok: true, but recommendation is skip.
- Evidence: source `extractHandler.ts:130-145`, `methods.ts:72-74`; moxxie `handlers.ts:608-609`
  (schema required) and the pre-existing `snapshot` command (`handlers.ts:~310-320`).

### 5. [P2, skip-cargo-cult] non-object top-level schema wrap/unwrap (`{value: schema}`) — moxxie's path-based transform already handles bare root schemas
- Source: `extractHandler.ts:193-203,254-257` — if the caller's top-level schema isn't an
  object (e.g. bare `z.string()`, `z.array(...)`), stagehand wraps it in
  `z.object({ value: schema })` before running `transformSchema`/inference, then unwraps
  `output.value` after. This exists because stagehand's `transformSchema` recursion
  (`utils.ts:400-608`) is driven by Zod's shape API which needs an object to attach named
  `ZodPathSegments`.
- Moxxie now: `transform.ts`'s `walk()` handles a root URL leaf directly — `walk(schema, [], ...)`
  checks `isUriString(node)` / `nameIsUrlLeaf` on the ROOT node itself and returns
  `path.join('.') === ''`, which `resolve.ts:53-56` already special-cases
  (`if (path === '') { data = resolveLeaf(data, ...) }`). No wrap step is needed because moxxie's
  transform operates on plain JSON Schema with dot-paths, not Zod's shape-introspection API.
- Recommendation: do not port the wrap/unwrap step — it is scaffolding stagehand needs only
  because of its Zod-shape-driven implementation. Moxxie's simpler path-based approach already
  covers the case moxxie's own `resolve.ts` comments call out. Confirm with a regression test
  (bare `{type:"string",format:"uri"}` root schema round-trips through `transformSchema` +
  `resolveIds`) if one doesn't already exist, but no code change.
- keyless_ok: true, but recommendation is skip (already-superior design, not a gap).
- Evidence: source `extractHandler.ts:193-203,254-257`; moxxie `transform.ts:79-89`,
  `resolve.ts:53-56`.

### 6. [P2, skip-cargo-cult] screenshot-augmented extraction (vision fallback) — not worth building into the CLI
- Source: `extractHandler.ts:120,153-179,218` — `extract({screenshot: true})` captures a
  viewport PNG and passes it alongside the a11y tree to an AI-SDK-capable model for
  visually-dependent extraction (e.g. content only conveyed by color/layout, not text).
- Moxxie now: no equivalent; `handleExtract` only ever builds a text bundle.
- Recommendation: skip as a CLI feature. This only has value because stagehand's model call is
  INSIDE the library; moxxie's host is the one running inference and the host already has its
  own `screenshot` primitive (moxxie is a superset — verify the screenshot command exists) it
  can call and look at directly when text extraction won't cut it. Baking screenshot bytes into
  every extract bundle would bloat payload size for the common (non-visual) case. If ever
  revisited, it should be an explicit opt-in flag (`--with-screenshot`) that base64-embeds a PNG
  into the bundle for the host's own multimodal read — but this is speculative, not evidenced by
  a moxxie eval gap, so leave it out for now.
- keyless_ok: true if ever built (CLI never calls a model, just hands bytes to host), but
  recommendation is skip.
- Evidence: source `extractHandler.ts:120,153-179`.

### 7. [P2, skip-cargo-cult] token/timing metrics plumbing (`prompt_tokens`, `inference_time_ms`, `onMetrics`)
- Source: `extractHandler.ts:53-107,221-240,266-281` — extensive metrics bookkeeping
  (`prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `cached_input_tokens`,
  `inference_time_ms`) threaded through every extract call and reported via `onMetrics`.
- Moxxie now: `handleExtract`/`buildBundle` have no equivalent, correctly — moxxie's CLI never
  runs inference, so there is no token/latency data to report. This is 100% an artifact of
  stagehand calling a model in-process.
- Recommendation: explicit skip-cargo-cult. Flagging only so it's not mistakenly re-proposed in
  a later round as "observability parity" — it has zero keyless meaning for moxxie.
- keyless_ok: n/a (not applicable to moxxie's model).
- Evidence: source `extractHandler.ts:53-107,221-240,266-281`.

### 8. [confirmed-already-ahead, no action] `injectUrls`'s silent `?? ""` vs moxxie's loud-null — moxxie is already the stronger design
- Source: `utils.ts:616-661` `injectUrls` — an ID with no entry in `idToUrlMapping` resolves to
  `idToUrlMapping[id] ?? ""`, i.e. an unresolved link silently becomes an empty string with no
  signal to the caller that grounding failed.
- Moxxie now: `resolve.ts:76-91` `resolveLeaf` — an unknown ID becomes `null` PLUS a `warning`
  string that names every unresolved ID (`resolve.ts:62-69`), and `resolve.ts` additionally adds
  a generation-staleness gate (`bundleGeneration !== currentGeneration` → `ref_stale`,
  `resolve.ts:44-47`) that stagehand's `injectUrls` has no equivalent of at all.
- Recommendation: none — this is moxxie already surpassing the source on the exact lens
  (id-grounding / injectUrls) this digest is about. No change needed; cited here as evidence the
  "loud null" design documented in moxxie's own comments (`resolve.ts:9-19`) is a real, verified
  improvement over stagehand's current behavior, not an assumption.
- keyless_ok: true (already shipped).
- Evidence: source `utils.ts:638-639,654-655`; moxxie `resolve.ts:44-47,62-91`.

## Top recommendation

Fix #1 (thread the caller's field `description` through `idField()` in `transform.ts`) — it's a
~10-line change with no new flags/state, and it directly addresses the failure mode this whole
lens exists to prevent: with multiple links per extracted row, an ID-shape field with a generic
"the element ID of the link" description gives the host LLM no way to pick the RIGHT link among
several plausible candidates, silently reintroducing the ambiguity ID-grounding was built to
remove. Stagehand already solved this with `makeIdStringSchema`'s description composition
(`utils.ts:672-686`); moxxie has the field-level `description` in its `JsonSchema` type
(`transform.ts:22-30`) but drops it exactly where it matters most.
