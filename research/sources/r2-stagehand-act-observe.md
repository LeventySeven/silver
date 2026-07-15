# R2 Source Digest: Stagehand — act() + observe() + Accessibility Tree

**Repo root:** `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/stagehand`
**License:** MIT — Copyright (c) 2024 Browserbase Inc. (`LICENSE`, root of repo). Fork/adapt is permitted with the standard MIT notice retained.

## Killer Insight

Stagehand does NOT feed the LLM a full DOM or a Playwright-style ref system. It builds a **hybrid CDP-derived accessibility outline** — a pruned, indented text tree where every actionable/named node is tagged with an encoded id `[frameOrdinal-backendNodeId]` (e.g. `[0-18372]`) — and asks the LLM to return that *exact* id plus a `method` name drawn from a small fixed enum (`click`, `fill`, `type`, `press`, `scrollTo`, `nextChunk`, `prevChunk`, `selectOptionFromDropdown`, `hover`, `doubleClick`, `dragAndDrop`). The handler layer then resolves `elementId → xpath` via a lookup map built during snapshot capture (never re-querying the LLM for a selector), prefixes it `xpath=...`, and dispatches through one flat `METHOD_HANDLER_MAP` dictionary to CDP-backed Locator primitives. This id-indirection (LLM never sees or emits a raw CSS/XPath selector) is the reusable core: it makes selectors robust to node-id churn, keeps prompt tokens tiny, and gives you a clean self-heal seam (re-snapshot + re-ask, same id contract) when a stale xpath fails at execution time.

## Exact Command Surface / API (verbatim)

### `Action` shape returned by `observe()` (after id→xpath resolution)
```ts
// packages/core/lib/v3/handlers/observeHandler.ts:207-216
{
  description: string,
  method?: string,
  arguments?: string[],
  selector: string,   // "xpath=<trimmed xpath>"
}
```

### LLM response schema for `observe` (Zod, verbatim shape)
`packages/core/lib/inference.ts:277-313`
```ts
z.object({
  elements: z.array(z.object({
    elementId: z.string().regex(/^\d+-\d+$/),  // e.g. "0-18372"
    description: z.string(),
    method: z.enum([...SupportedUnderstudyAction]),
    arguments: z.array(z.string()),
  })),
})
```

### LLM response schema for `act` (Zod, verbatim shape)
`packages/core/lib/inference.ts:425-461`
```ts
z.object({
  action: z.object({
    elementId: z.string().regex(/^\d+-\d+$/),
    description: z.string(),
    method: z.enum([...SupportedUnderstudyAction]),
    arguments: z.array(z.string()),
  }).nullable(),   // null == "no matching element, do not fabricate"
  twoStep: z.boolean(),  // triggers a second observe+act pass (e.g. open dropdown then pick option)
})
```

### Supported action/method enum (the entire actuation surface)
`packages/core/lib/v3/types/private/handlers.ts:36-48`
```ts
export enum SupportedUnderstudyAction {
  CLICK = "click",
  FILL = "fill",
  TYPE = "type",
  PRESS = "press",
  SCROLL = "scrollTo",
  NEXT_CHUNK = "nextChunk",
  PREV_CHUNK = "prevChunk",
  SELECT_OPTION_FROM_DROPDOWN = "selectOptionFromDropdown",
  HOVER = "hover",
  DOUBLE_CLICK = "doubleClick",
  DRAG_AND_DROP = "dragAndDrop",
}
```

### Method dispatch table (execution)
`packages/core/lib/v3/handlers/handlerUtils/actHandlerUtils.ts:124-144`
```ts
const METHOD_HANDLER_MAP: Record<string, (ctx) => Promise<void>> = {
  scrollIntoView,
  scrollByPixelOffset,
  scrollTo: scrollElementToPercentage,
  scroll: scrollElementToPercentage,
  "mouse.wheel": wheelScroll,
  fill: fillOrType,
  type: typeText,
  press: pressKey,
  click: clickElement,
  doubleClick,
  dragAndDrop,
  nextChunk: scrollToNextChunk,
  prevChunk: scrollToPreviousChunk,
  selectOptionFromDropdown: selectOption,
  selectOption: selectOption,
  hover: hover,
};
```
Dispatch entry point: `performUnderstudyMethod(page, frame, method, rawXPath, args, domSettleTimeoutMs)` — normalizes `"/"` → `"/html"`, resolves an xpath (with `>>` cross-frame hops) to a `Locator` via `resolveLocatorWithHops`, then calls `METHOD_HANDLER_MAP[method](ctx)`. Unknown method throws `UnderstudyCommandException("Method ${method} not supported")`. (`actHandlerUtils.ts:35-120`)

### Encoded element id format (the "ref" system)
`[frameOrdinal-backendNodeId]`, e.g. `[0-18372]` — frame ordinal is a per-page counter (`page.getOrdinal(frameId)`), backendNodeId is Chrome DevTools Protocol's `backendDOMNodeId`. Regex validated server-side and in the Zod schema: `/^\d+-\d+$/`. Encoder: `(backendNodeId) => \`${page.getOrdinal(frameId)}-${backendNodeId}\`` (`capture.ts:242-243, 384, 406`).

### Text outline line format (what the LLM actually sees)
`packages/core/lib/v3/understudy/a11y/snapshot/treeFormatUtils.ts:8-16`
```ts
function formatTreeLine(node, level = 0): string {
  const indent = "  ".repeat(level);
  const labelId = node.encodedId ?? node.nodeId;
  const stateFlags = formatStateFlags(node); // " [selected]" / " [checked]"
  const label = `[${labelId}] ${node.role}${node.name ? `: ${cleanText(node.name)}` : ""}${stateFlags}`;
  ...
}
```
Example line: `  [0-18372] button: Sign in`

### CDP calls used to build the tree
- `Accessibility.enable`, `Runtime.enable`, `DOM.enable` (`a11yTree.ts:23-25`)
- `Accessibility.getFullAXTree` with optional `{ frameId }`, falling back to the whole-target call if frame-scoped call errors with "Frame with the given/does not belong to the target/is not found" (`a11yTree.ts:27-43`)
- `DOM.describeNode` to map a resolved selector's `objectId` → `backendNodeId` for scoped snapshots (`a11yTree.ts:55-59`)
- `DOM.getFrameOwner` to find the backend node hosting a child iframe, for building absolute cross-frame XPath prefixes (`capture.ts:649-652, 723-726, 774-776`)
- `DOM.scrollIntoViewIfNeeded`, `Runtime.callFunctionOn` (chunk scroll), `Input.dispatchMouseEvent` (wheel), `Runtime.releaseObject` (cleanup after object handles)

### `observe()` handler signature and flow
`packages/core/lib/v3/handlers/observeHandler.ts:66-242`
```ts
async observe(params: ObserveHandlerParams): Promise<Action[]>
// params: { instruction, page, timeout, selector, ignoreSelectors, model, variables }
```
1. Default instruction if none given: `"Find elements that can be used for any future actions in the page..."` (line 84-86)
2. `captureHybridSnapshot(page, { experimental, focusSelector, ignoreSelectors })` → `{ combinedTree, combinedXpathMap }`
3. `runObserve({ instruction, domElements: combinedTree, llmClient, supportedActions, variables })` — LLM call
4. For each returned `elementId`, look up `combinedXpathMap[elementId]`, trim trailing text node, prefix `xpath=`. **`dragAndDrop`'s first argument is itself an elementId** — it gets resolved the same way and rewritten to `xpath=...` in `arguments[0]` (lines 160-205).
5. Shadow-DOM fallback: if `elementId` doesn't match `\d+-\d+`, return a placeholder `{ method: "not-supported", selector: "not-supported" }` (line 218-224) rather than crashing.

### `act()` handler flow (two-call architecture + optional two-step)
`packages/core/lib/v3/handlers/actHandler.ts:137-266`
1. `waitForDomNetworkQuiet(page.mainFrame(), domSettleTimeoutMs)` — waits for network+DOM settle before snapshotting (custom impl, not Playwright's networkidle — see below).
2. `captureHybridSnapshot(page, { experimental: true })`
3. `buildActPrompt(instruction, supportedActions, variables)` then `actInference(...)` — single LLM call returns `{ action | null, twoStep }`.
4. `takeDeterministicAction(action, ...)` executes via `performUnderstudyMethod`.
5. **If `twoStep === true`** (e.g. custom dropdown that needs a click-to-open then a second selection): re-snapshot, `diffCombinedTrees(prevTree, nextTree)` to get only the *newly appeared* outline lines (fallback to full new tree if diff is empty), build `buildStepTwoPrompt(originalInstruction, previousActionDescription, supportedActionsMinusSelectOption, variables)`, run a second LLM call + second `takeDeterministicAction`, and merge both `ActResult`s (`success = first.success && second.success`, messages joined with `" → "`).

### Self-heal retry (verbatim logic)
`actHandler.ts:327-433`, inside `takeDeterministicAction`'s catch block, only if `this.selfHeal` is true:
1. Build a retry instruction: `action.description` if it already starts with the method name, else `${method} ${action.description}`.
2. Take a **fresh** `captureHybridSnapshot`.
3. Call `getActionFromLLM` again with `requireMethodAndArguments: false` (so a partial/degenerate LLM response is still usable for its selector).
4. Take `fallbackAction.selector` as the new xpath, but **keep the original `method` and `resolvedArgs`** — only the selector is replaced.
5. Retry `performUnderstudyMethod` once with the new selector. Any failure here is terminal (`"Failed to perform act after self-heal: ${retryMsg}"`), no further retries.
6. `ActTimeoutError` is always re-thrown immediately, bypassing self-heal, at both the outer and retry `catch` sites.

### Variable substitution (secrets/dynamic values without exposing them to the LLM)
`actHandler.ts:518-534`: LLM is told to return `%variableName%` placeholders in `arguments`; `substituteVariablesInArguments` does literal `split/join` token replacement against the caller-supplied `variables` map just before execution, so raw secret values never appear in the prompt or model output.

### DOM-settle wait (network-quiet heuristic, not Playwright networkidle)
`actHandlerUtils.ts:528-684` `waitForDomNetworkQuiet(frame, timeoutMs = 5000)`:
- Waits for `document.readyState` in `{interactive, complete}` (or `domcontentloaded` event) first.
- Then tracks in-flight `Network.requestWillBeSent` minus `finished/failed/servedFromCache/data:` responses; ignores `WebSocket`/`EventSource` resource types.
- Declares "quiet" 500ms after in-flight count hits 0.
- A 2000ms stalled-request sweep forcibly drops requests older than 2s (assumed hung, e.g. long-poll/analytics beacons).
- Hard overall timeout (default 5000ms) forces completion regardless.

## Patterns

| # | What | How to reimplement | Evidence | Tier |
|---|------|---------------------|----------|------|
| 1 | Id-indirection selector contract | Snapshot builds `encodedId → xpath` map; LLM only ever emits `encodedId` (format `frameOrdinal-backendNodeId`, regex-validated `^\d+-\d+$`), never a raw selector. Resolve to `xpath=...` server-side just before execution. | `observeHandler.ts:150-217`, `inference.ts:281-286` | core |
| 2 | Fixed, small action-method enum shared by observe+act+execution | One `SupportedUnderstudyAction` enum feeds the Zod schema's `method` field AND is the exact key-set of the dispatch map — schema and executor can never drift. | `handlers.ts:36-48`, `actHandlerUtils.ts:124-144` | core |
| 3 | Text-outline accessibility tree with inline ref ids | `[frameOrdinal-backendNodeId] role: name [flags]`, 2-space indent per depth, cross-frame subtrees spliced in under their host iframe's ref line via `injectSubtrees`. Cheap to diff, cheap in tokens, trivially greppable. | `treeFormatUtils.ts:8-65`, `capture.ts:841-855` | core |
| 4 | Structural pruning of the AX tree before serializing | Drop `generic`/`none`/`inlinetextbox` roles unless they have a name or children; collapse single-child structural wrappers; strip StaticText children whose concatenated text duplicates the parent's accessible name (avoids "Sign in Sign in" duplication). | `a11yTree.ts:160-224, 262-278` | core |
| 5 | LLM returns `null`/no-match instead of guessing | Both act and observe schemas explicitly instruct + type-allow "no element" as a valid response (`action: z.object(...).nullable()`), preventing hallucinated selectors. | `inference.ts:456-459`, `prompt.ts:192, 229` | core |
| 6 | Two-step actions via tree diffing | For actions needing a click-then-select (e.g. custom dropdowns), diff before/after outlines (`diffCombinedTrees`) to give the second LLM call only the *newly revealed* nodes, not the whole page again. Falls back to full tree if diff is empty. | `actHandler.ts:202-229`, `treeFormatUtils.ts:80-111` | important |
| 7 | Self-heal = re-snapshot + re-ask, same id contract, method/args preserved | On execution failure, don't retry blindly — take a fresh snapshot (page state may have changed), re-run inference for a fresh selector only, but keep the originally-decided method+arguments. One retry, no loop. | `actHandler.ts:333-419` | important |
| 8 | Secrets never touch the LLM | Prompt tells the model to emit `%varName%` tokens; substitution happens after inference, client-side, via plain string split/join. | `prompt.ts:203-215`, `actHandler.ts:518-534` | important |
| 9 | Network-quiet heuristic before snapshotting for `act` (not for `observe`) | Custom in-flight-request tracker with a stalled-request sweep and hard timeout, rather than relying on Playwright's `networkidle` (which Playwright itself deprecated as flaky). Only `act()` calls this — `observe()` snapshots immediately. | `actHandlerUtils.ts:528-684`, `actHandler.ts:146-150` vs `observeHandler.ts` (no equivalent call) | important |
| 10 | Frame-scoped AX fetch with graceful fallback | Try `Accessibility.getFullAXTree({frameId})`; on frame-scope errors (moved/detached frame), fall back to unscoped call rather than throwing. | `a11yTree.ts:27-43` | nice |
| 11 | Selector-scoped fast path (avoid full-page snapshot) | If caller passes a `selector`/`focusSelector`, resolve just that node's frame + subtree via `DOM.describeNode`/BFS over `childIds`, and only fall back to the full multi-frame snapshot if scoping fails. | `capture.ts:162-307` | nice |
| 12 | dragAndDrop's target arg is itself an element-id needing resolution | Special-cased in both `observeHandler.ts` and `actHandler.ts` normalizer: `arguments[0]` for `dragAndDrop` is checked against `/^\d+-\d+$/`, resolved via the same xpathMap, and rewritten to `xpath=...` before being handed to the executor, which does a second `resolveLocatorWithHops` on it. | `observeHandler.ts:160-205`, `actHandlerUtils.ts:348-423` | nice |

## Reusable code (fork candidates)

- `packages/core/lib/v3/understudy/a11y/snapshot/capture.ts` — `captureHybridSnapshot()`: the entire multi-frame, multi-CDP-session DOM+AX snapshot pipeline (scoped fast-path, session indexing, per-frame outline+maps, cross-frame XPath prefixing, merge). This is the single most valuable file to port — it is the "give the agent a token-cheap, ref-stable view of the page" primitive.
- `packages/core/lib/v3/understudy/a11y/snapshot/a11yTree.ts` — `a11yForFrame()`, `decorateRoles()`, `buildHierarchicalTree()`: CDP → pruned AX tree with role/scrollable/file-input decoration.
- `packages/core/lib/v3/understudy/a11y/snapshot/treeFormatUtils.ts` — `formatTreeLine()`, `injectSubtrees()`, `diffCombinedTrees()`, `cleanText()`: tiny, dependency-free formatting/diffing utilities, easy to port verbatim.
- `packages/core/lib/v3/handlers/handlerUtils/actHandlerUtils.ts` — `performUnderstudyMethod()` + `METHOD_HANDLER_MAP` + `waitForDomNetworkQuiet()`: the actuation dispatch table and the network-quiet heuristic. Directly reusable as the "execute a canonical action" layer sitting under any snapshot/selection strategy.
- `packages/core/lib/inference.ts` — `observe()` / `act()`: the exact Zod schemas + LLM call shape for grounding candidate actions and single-action decisions; good template for a structured-output prompt regardless of model provider.
- `packages/core/lib/prompt.ts` — `buildObserveSystemPrompt`, `buildActSystemPrompt`, `buildActPrompt`, `buildStepTwoPrompt`: verbatim prompt text, directly reusable/adaptable.

## Anti-patterns

- **Regex-based whitespace collapsing on system prompts** (`.replace(/\s+/g, " ")` in `prompt.ts:161,193`) is a code smell — it makes prompt text hard to diff/review in source form; fine to keep behaviorally but don't copy the pattern of writing multi-line template literals purely to squash them.
- **Best-effort catch-and-ignore CDP calls** (`.catch(() => {})`) are pervasive (`Accessibility.enable`, `Runtime.releaseObject`, `Target.setAutoAttach`, etc.). This is deliberate defensive coding against CDP domain-already-enabled/target-gone races — replicate the pattern, but be aware it can silently swallow real connection failures; add logging if porting to a context without Stagehand's existing logger discipline.
- **Two independent near-duplicate elementId→xpath resolution blocks** exist in `observeHandler.ts:150-227` and `actHandler.ts` (`normalizeActInferenceElement`, lines 445-516) — including the dragAndDrop special case copy-pasted almost verbatim in both places. When forking, factor this into one shared resolver instead of carrying the duplication forward.
- **`selfHeal` retries exactly once and only on the *first* action of a two-step act** — the second action of a `twoStep` sequence (`secondResult`) does not go through `takeDeterministicAction`'s self-heal wrapper distinctly; it does (it calls the same method), but there's no additional resilience layered on top of the two-step flow itself if step one succeeds but step two's target vanished due to step one's side effects — worth hardening if you build on this.

## License

MIT License, Copyright (c) 2024 Browserbase Inc. Full text at repo root `LICENSE`. Permits copy/modify/merge/publish/distribute/sublicense/sell with retention of copyright + permission notice; no warranty.
