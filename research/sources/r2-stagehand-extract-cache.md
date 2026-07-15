# R2 Source Digest — Stagehand: extract() + ID-grounding + verbatim prompts + act/agent caching

Repo root read: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/stagehand`
License: **MIT**, Copyright (c) 2024 Browserbase Inc. (`LICENSE:1-21`). Free to fork/adapt with attribution ("Portions adapted from Browserbase's Stagehand, MIT License").

## Killer Insight

Stagehand solves LLM URL/value hallucination in `extract()` not by asking the model to copy URLs verbatim, but by **making it structurally impossible to emit a fabricated URL**: any `z.string().url()` field in the caller's Zod schema is transformed *before* the LLM ever sees it into `z.string().regex(/^\d+-\d+$/)` (an element-ID shaped string), the LLM is instructed to return only the DOM element ID for link fields, and the real URL is spliced back in as a **pure post-processing step** via a captured `id -> url` map from the accessibility-tree snapshot. The LLM literally cannot express a URL as free text for those fields — it can only pick an ID that provably exists in the page's live DOM/AX tree. The same "container ID must match `frameOrdinal-backendNodeId`" grounding (regex `/^\d+-\d+$/`) is reused for `act()`'s and `observe()`'s `elementId` field, so every clickable/typeable target is also constrained to a real, currently-present node — not a guessed selector or invented text.

## Exact Command Surface / API (verbatim)

### extract() contract (schema in → grounded values out)
- Entry point: `ExtractHandler.extract<T>(params)` — `packages/core/lib/v3/handlers/extractHandler.ts:109`
- No-args extract → returns `{ pageText: snap.combinedTree }` validated against `pageTextSchema` (parity path, extractHandler.ts:130-145).
- `instruction` without `schema` is allowed → falls back to `defaultExtractSchema` (extractHandler.ts:193-194).
- `instruction` is REQUIRED if `schema` is given, else throws `StagehandInvalidArgumentError("extract() requires an instruction when a schema is provided.")` (extractHandler.ts:147-151).
- `screenshot: true` is **only** supported for `llmClient.type === "aisdk"`, else throws `StagehandInvalidArgumentError("extract({ screenshot: true }) is only supported with AI SDK clients.")` (extractHandler.ts:153-157, re-checked again in `inference.ts:70-74`).
- Non-object schemas get wrapped: `factory.object({ value: baseSchema })` (`WRAP_KEY = "value"`), then unwrapped from `output.value` after inference (extractHandler.ts:196-203, 254-257).
- Pipeline: capture hybrid a11y snapshot (`captureHybridSnapshot`) → get `{combinedTree, combinedUrlMap}` → transform schema (URL→ID) → call `runExtract()` (`lib/inference.ts:extract`) → re-inject URLs via `injectUrls()` using `combinedUrlMap` → unwrap if wrapped → return typed result (extractHandler.ts:161-283).
- Return shape includes hidden fields stripped before returning to caller: `metadata:{completed}`, `prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `cached_input_tokens`, `inference_time_ms` (extractHandler.ts:53-64, 221-230) — these drive `onMetrics()` callback with signature `(functionName, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, inferenceTimeMs)`.

### URL→ID schema transform (`packages/core/lib/utils.ts`)
- `transformUrlStringsToNumericIds(schema)` → `[transformedSchema, urlFieldPaths: ZodPathSegments[]]` (extractHandler.ts:46-51, calling `transformSchema()` in utils.ts:400).
- `transformSchema(schema, currentPath)` recursively walks object/array/union/intersection/optional/nullable/pipe/effects Zod nodes (utils.ts:400-607). Detects `.url()` via string checks/format (`checks.some(c => c.kind==="url" || c.format==="url" || c._zod?.def?.check==="url" || c._zod?.def?.format==="url")` — dual Zod v3/v4 compat, utils.ts:404-420).
- On match: replaces field with `makeIdStringSchema(orig)` = `factory.string().regex(/^\d+-\d+$/).describe(...)` (utils.ts:672-686). Description literal: `"This field must be the element-ID in the form 'frameId-backendId' (e.g. \"0-432\")."`, appended with `" that follows this user-defined description: {userDesc}"` if the original field had a `.describe()`.
- Path tracking uses `*` sentinel for array indices (utils.ts:462-482) so nested `list[].link` fields are found.
- `injectUrls(obj, path, idToUrlMapping)` (utils.ts:616-661): walks the *result object* along those same paths, and for any numeric-looking or `ID_PATTERN`-matching value, replaces it with `idToUrlMapping[id] ?? ""`. `ID_PATTERN = /^\d+-\d+$/` (utils.ts:11).
- `EncodedId = \`${number}-${number}\`` — the canonical element-ID type (`packages/core/lib/v3/types/private/internal.ts:16`).

### inference.ts — the actual LLM calls (`packages/core/lib/inference.ts`)
- `extract({instruction, domElements, schema, llmClient, userProvidedInstructions, logInferenceToFile, screenshot})` (inference.ts:34-52) makes **two sequential LLM calls**:
  1. Extraction call — messages = `[buildExtractSystemPrompt(isUsingAnthropic, userProvidedInstructions, hasScreenshot), buildExtractUserPrompt(instruction, domElements, isUsingAnthropic, screenshotDataUrl)]`; `response_model: {schema, name: "Extraction"}`; `top_p:1, frequency_penalty:0, presence_penalty:0` (inference.ts:79-124).
  2. Metadata/completion call — separate `metadataSchema = z.object({ progress: z.string(), completed: z.boolean() })`; messages = `[buildMetadataSystemPrompt(), buildMetadataPrompt(instruction, extractedData)]`; `response_model: {name:"Metadata", schema: metadataSchema}` (inference.ts:53-64, 154-190).
  - Note: `isUsingAnthropic` flag is passed as the `isUsingPrintExtractedDataTool` boolean into the prompt builders — Anthropic path uses a `print_extracted_data` tool-call framing instead of native structured output.
- Final return merges `...extractedData, metadata:{completed, progress}, prompt_tokens, completion_tokens, reasoning_tokens, cached_input_tokens, inference_time_ms` summed across BOTH calls (inference.ts:244-255).
- `observe()` (inference.ts:258-408): schema requires `elementId: z.string().regex(/^\d+-\d+$/)`, `description: z.string()`, `method: z.enum(SupportedUnderstudyAction values)`, `arguments: z.array(z.string())`. Returns `{elements, prompt_tokens, ..., inference_time_ms}`.
- `act()` (inference.ts:410-551): same element shape as observe but singular `action` (nullable) + `twoStep: z.boolean()`. `action` schema explicitly says: `.nullable().describe("The element to act on. Return null if no element on the page matches the instruction — do NOT fabricate or guess an element, and never emit empty strings or placeholder values.")` (inference.ts:456-459).

### Verbatim system/user prompts (`packages/core/lib/prompt.ts`)

**buildExtractSystemPrompt** (prompt.ts:21-67) — base content (whitespace-collapsed at runtime via `.replace(/\s+/g, " ")`):
```
You are extracting content on behalf of a user.
  If a user asks you to extract a 'list' of information, or 'all' information, 
  YOU MUST EXTRACT ALL OF THE INFORMATION THAT THE USER REQUESTS.
   
  You will be given:
1. An instruction
2. [A list of DOM elements to extract from and a screenshot of the current viewport to extract from. Use them together to extract content from the page. | A list of DOM elements to extract from.]

Print the exact text from the DOM elements with all symbols, characters, and endlines as is.
Print null or an empty string if no new information is found.
[if tool-mode: ONLY print the content using the print_extracted_data tool provided.
ONLY print the content using the print_extracted_data tool provided.]

If a user is attempting to extract links or URLs, you MUST respond with ONLY the IDs of the link elements. 
Do not attempt to extract links directly from the text unless absolutely necessary. 
[+ buildUserInstructionsString(userProvidedInstructions) block]
```
**buildExtractUserPrompt** (prompt.ts:69-102): `"Instruction: ${instruction}\nDOM: ${domElements}"` (+ screenshot line: `"Use the screenshot of the current viewport together with the accessibility tree to extract content from the page."`; + repeated `ONLY print the content using the print_extracted_data tool provided.` twice if tool mode). Screenshot sent as `{type:"image_url", image_url:{url: screenshotDataUrl}}` content part.

**metadataSystemPrompt** (prompt.ts:104-110), verbatim:
```
You are an AI assistant tasked with evaluating the progress and completion status of an extraction task.
Analyze the extraction response and determine if the task is completed or if more information is needed.
Strictly abide by the following criteria:
1. Once the instruction has been satisfied by the current extraction response, ALWAYS set completion status to true and stop processing, regardless of remaining chunks.
2. Only set completion status to false if BOTH of these conditions are true:
   - The instruction has not been satisfied yet
   - There are still chunks left to process (chunksTotal > chunksSeen)
```
**buildMetadataPrompt** (prompt.ts:119-128): `"Instruction: ${instruction}\nExtracted content: ${JSON.stringify(extractionResponse, null, 2)}"`.

**buildObserveSystemPrompt** (prompt.ts:131-169), verbatim core:
```
You are helping the user automate the browser by finding elements based on what the user wants to observe in the page.

You will be given:
1. a instruction of elements to observe
2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

Return an array of elements that match the instruction if they exist, otherwise return an empty array.
When returning elements, include the appropriate method from the supported actions list.[ Supported actions: ...][ Available variables: ...]. When choosing non-left click actions, provide right or middle as the argument.

Each element in the accessibility tree has an ID in square brackets, like [0-18372]. The ID has two parts: frame ordinal and backend node ID. Always copy the complete ID exactly as shown inside the brackets into elementId, including the frame ordinal and hyphen. For example, if the tree shows [0-18372], return elementId "0-18372"; never return only "18372".
```
Variables substitution format: `"%${name}% (${description})"` joined by `", "`, with trailing instruction `"When an action needs a dynamic or sensitive value, return the matching %variableName% placeholder in the action arguments instead of a literal value"` (prompt.ts:139-148) — this is the secrets-never-touch-the-LLM pattern.

**buildActSystemPrompt** (prompt.ts:182-201), verbatim:
```
You are helping the user automate the browser by finding elements based on what action the user wants to take on the page

You will be given:
1. a user defined instruction about what action to take
2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

Return the element that matches the instruction if it exists. If no element on the page matches the instruction, set `action` to null. Do not fabricate or guess an element — empty strings or placeholder values for elementId/description/method are not acceptable.
```

**buildActPrompt** (prompt.ts:217-252) — full dropdown-handling logic, verbatim key rules:
```
Find the most relevant element to perform an action on given the following action: ${action}.
IF AND ONLY IF the action EXPLICITLY includes the word 'dropdown' and implies choosing/selecting an option from a dropdown, ignore the 'General Instructions' section, and follow the 'Dropdown Specific Instructions' section carefully.

General Instructions:
  Provide an action for this element such as ${supportedActions.join(", ")}. Remember that to users, buttons and links look the same in most cases.
  When choosing non-left click actions, provide right or middle as the argument
  If the action is completely unrelated to a potential action to be taken on the page, or no matching element exists, set `action` to null. Do not fabricate or guess an element.
  ONLY return one action. If multiple actions are relevant, return the most relevant one.
  If the user is asking to scroll to a position on the page, e.g., 'halfway' or 0.75, etc, you must return the argument formatted as the correct percentage, e.g., '50%' or '75%', etc.
  If the user is asking to scroll to the next chunk/previous chunk, choose the nextChunk/prevChunk method. No arguments are required here.
  If the action implies a key press, e.g., 'press enter', 'press a', 'press space', etc., always choose the press method with the appropriate key as argument — e.g. 'a', 'Enter', 'Space'. Do not choose a click action on an on-screen keyboard. Capitalize the first character like 'Enter', 'Tab', 'Escape' only for special keys.

Dropdown Specific Instructions:
  For interacting with dropdowns, there are two specific cases that you need to handle.

  CASE 1: the element is a 'select' element.
    - choose the selectOptionFromDropdown method,
    - set the argument to the exact text of the option that should be selected,
    - set twoStep to false.
  CASE 2: the element is NOT a 'select' element:
    - do not attempt to directly choose the element from the dropdown. You will need to click to expand the dropdown first. You will achieve this by following these instructions:
      - choose the node that most closely corresponds to the given instruction EVEN if it is a 'StaticText' element, or otherwise does not appear to be interactable.
      - choose the 'click' method
      - set twoStep to true.
```
Variables note appended: `" The user has provided the following variables to be used in the action: ${variableNames} \n Note that these are the variable names/keys, and not the actual variable values. \n To use the variables in the action, you must respond with the variable name inside the 'arguments' array. The variable name must be wrapped in percentage signs (eg, %variableNameHere%) so that it can be replaced with the actual variable value before the action is taken. \n"` (prompt.ts:203-215).

**buildStepTwoPrompt** (prompt.ts:254-279) — the twoStep dropdown-expansion follow-up prompt, references "step 1 of 2"/"step 2 of 2".

**buildOperatorSystemPrompt(goal)** (prompt.ts:281-314) — agent orchestrator prompt listing tools `act, extract, goto, wait, navback, refresh, close`, with explicit anti-narration instruction: `"# CRITICAL: You MUST use the provided tools to take actions. Do not just describe what you want to do - actually call the appropriate tools."`

**Custom user instructions wrapper** (prompt.ts:5-18), reused across all system prompts:
```
\n\n# Custom Instructions Provided by the User
    
Please keep the user's instructions in mind when performing actions. If the user's instructions are not relevant to the current task, ignore them.

User Instructions:
${userProvidedInstructions}
```

### ID-grounding regex used everywhere
`/^\d+-\d+$/` — the canonical "frameOrdinal-backendNodeId" element-ID format. Appears in: `utils.ts:11` (`ID_PATTERN`), `utils.ts:685` (`makeIdStringSchema`), `inference.ts:283` (observe `elementId`), `inference.ts:430` (act `elementId`). Prompt text explains it as `[0-18372]` = frame ordinal `0`, backend node ID `18372`.

### Action-cache (`ActCache`) contract (`packages/core/lib/v3/cache/ActCache.ts`)
- Cache key: `sha256(JSON.stringify({instruction, url: normalizeUrlForCacheKey(pageUrl), variableKeys: sortedKeys}))` (ActCache.ts:188-199, utils.ts:24-33 for URL normalization — sorts query params so equivalent URLs collapse to same key).
- Cache entry shape `CachedActEntry` (`types/private/cache.ts:76-84`): `{version:1, instruction, url, variableKeys, actions: Action[], actionDescription?, message?}`.
- `Action` shape (`types/public/methods.ts:39-44`): `{selector: string, description: string, method?: string, arguments?: string[]}`.
- Replay (`tryReplay` → `replayCachedActions`, ActCache.ts:71-146, 201-285): version must be `1`; variable-key sets must match exactly (sorted comparison, ActCache.ts:362-377); if variables are required, all values must be present in context before replay (ActCache.ts:110-124); before executing each cached action, `waitForCachedSelector()` waits up to `domSettleTimeoutMs ?? 15000` for `state:"attached"`, logs and proceeds on timeout rather than failing hard (cache/utils.ts:39-65).
- **Self-heal**: after replay, `haveActionsChanged(original, updated)` diff-checks selector/description/method/arguments; if the live re-resolved actions differ from what's cached, `refreshCacheEntry()` overwrites the cache file with the corrected actions (ActCache.ts:264-360). This is the "self-heal" loop: cache is trusted for fast replay but silently repaired when the DOM has drifted.
- Storage: `CacheStorage` (`CacheStorage.ts`) — either filesystem JSON files under a resolved cache dir (`fs.promises.readFile/writeFile`, pretty-printed `JSON.stringify(data, null, 2)`) or an in-memory `Map` (`CacheStorage.createMemory`), selected once at construction; `enabled = !!dir || !!memoryStore`. File name pattern used by callers: `${cacheKey}.json`.

### Agent-cache (`AgentCache.ts`, types/private/cache.ts:20-160)
- Broader replay unit: `CachedAgentEntry = {version:1, instruction, startUrl, options: {maxSteps?, highlightCursor?}, configSignature, steps: AgentReplayStep[], result: AgentResult, timestamp}`.
- `AgentReplayStep` is a discriminated union: `act | fillForm | goto | scroll | wait | navback | keys | {type:string,...}` (types/private/cache.ts:86-144) — i.e., the agent caches its entire multi-step plan (not just one act), keyed additionally by a `configSignature` (captures model/options fingerprint) so a cached run only replays if the agent config matches.

## Patterns

1. **name**: Schema-transform grounding for extract() URLs
   **what**: Client-declared `z.string().url()` fields are silently swapped for regex-constrained ID strings before hitting the LLM, then values are re-substituted from a live DOM ID→URL map after the LLM responds.
   **how**: Recursive Zod-schema walker (`transformSchema`) that clones every branch type (object/array/union/intersection/optional/nullable/pipe/effects), replacing only leaf `.url()` strings via `makeIdStringSchema()` (`factory.string().regex(/^\d+-\d+$/)`), while recording a path list; post-inference, `injectUrls()` walks the *same* paths in the output object and swaps the ID for `idToUrlMapping[id] ?? ""`.
   **evidence**: `packages/core/lib/utils.ts:400-607` (transform), `:616-661` (inject), `packages/core/lib/v3/handlers/extractHandler.ts:205-206,242-253` (wiring)
   **tier**: core

2. **name**: Two-call extract (content + completion-metadata)
   **what**: extract() is not one LLM call — it's an extraction call for the schema, then a SEPARATE metadata call asking "is this instruction now satisfied?" (`completed`/`progress`), summed for token accounting.
   **how**: `metadataSchema = z.object({progress: z.string(), completed: z.boolean()})`; second call takes the first call's JSON output as input text.
   **evidence**: `packages/core/lib/inference.ts:53-64,154-199,244-255`
   **tier**: important (useful if you ever paginate/chunk extraction; for a single-shot CLI extract this may be overkill — see anti-patterns)

3. **name**: Uniform element-ID grounding across act/observe/extract
   **what**: One regex (`/^\d+-\d+$/`) and one wire format (`[frameOrdinal-backendNodeId]` shown in brackets in the AX tree) is reused as the *only* way an LLM can reference a page element in any of act/observe/extract-links, closing off hallucinated selectors.
   **how**: Same regex baked into 3 independent Zod schemas (`extract` URL fields, `observe.elements[].elementId`, `act.action.elementId`) plus explicit prompt instruction to copy the ID exactly including the hyphen.
   **evidence**: `packages/core/lib/utils.ts:11,685`; `packages/core/lib/inference.ts:283,430`; `packages/core/lib/prompt.ts:160`
   **tier**: core

4. **name**: `action:null` explicit-abstention contract for act/observe/extract link resolution
   **what**: Schema/prompt pairs explicitly permit and instruct "return null / empty array" rather than guessing, with strong language ("Do not fabricate or guess an element").
   **how**: `actSchema.action` is `.nullable()` with description forbidding placeholder values (inference.ts:456-459); prompt text repeats "Do not fabricate or guess an element" 3x across prompt.ts (192, 229, 269).
   **evidence**: `packages/core/lib/inference.ts:425-461`; `packages/core/lib/prompt.ts:182-252`
   **tier**: core

5. **name**: Variable-placeholder secrecy pattern
   **what**: Sensitive values (passwords, API keys) are never sent to the LLM — only variable *names* wrapped in `%name%` are, and substitution happens locally after the LLM returns the action.
   **how**: `buildActVariablesPrompt`/observe variables string list only `%key%` (+ optional description), never the value; `act.ts`/`ActCache.ts` pass `context.variables` only at execution time to `handler.takeDeterministicAction`.
   **evidence**: `packages/core/lib/prompt.ts:139-148,203-215`; `packages/core/lib/v3/cache/ActCache.ts:224-231`
   **tier**: core

6. **name**: URL-normalized, variable-key-aware cache key for act() replay
   **what**: Cache key hashes `{instruction, normalizedUrl, sortedVariableKeys}` — NOT variable values — so a cache entry is reusable across different secret values but invalidated by URL/query changes and by different variable sets.
   **how**: `sha256(JSON.stringify({instruction, url, variableKeys}))`; URL normalized by sorting query params via `URL.searchParams.sort()`.
   **evidence**: `packages/core/lib/v3/cache/ActCache.ts:188-199`; `packages/core/lib/v3/cache/utils.ts:24-33`
   **tier**: important

7. **name**: Self-healing act cache
   **what**: Cached actions are replayed blind, but the *live* re-resolved result is diffed against what was cached; if the DOM has drifted (different selector/description/method/args), the cache file is silently rewritten with the healed version instead of erroring.
   **how**: `haveActionsChanged()` field-by-field diff; `refreshCacheEntry()` overwrites `${cacheKey}.json` via `CacheStorage.writeJson`.
   **evidence**: `packages/core/lib/v3/cache/ActCache.ts:264-325,327-360`
   **tier**: important

8. **name**: Pluggable cache storage (fs JSON files or in-memory Map), same interface
   **what**: `CacheStorage` abstracts persistence so the same `readJson`/`writeJson` API works for a durable on-disk cache or an ephemeral in-process cache (e.g. tests / serverless), decided once at construction.
   **how**: `CacheStorage.create(cacheDir, logger)` for fs (mkdir -p, JSON.stringify(...,null,2)); `CacheStorage.createMemory(logger)` for a `Map`; both go through `jsonClone()` to prevent aliasing bugs when returning cached objects.
   **evidence**: `packages/core/lib/v3/cache/CacheStorage.ts:14-114`
   **tier**: nice

9. **name**: Whitespace-collapsed prompt authoring
   **what**: System prompts are written as readable multi-line/indented template literals in source, then `.replace(/\s+/g, " ")` collapses them to single-line before sending — keeps source diff-able without bloating token count with literal newlines/indentation.
   **how**: Applied to `buildExtractSystemPrompt`, `buildObserveSystemPrompt`, `buildActSystemPrompt` content strings.
   **evidence**: `packages/core/lib/prompt.ts:61,161,193`
   **tier**: nice

## Reusable code (fork candidates)

- `packages/core/lib/utils.ts` (`transformSchema`, `injectUrls`, `makeIdStringSchema`, `getZodType`/`getZFactory` Zod v3/v4 compat shims) — the entire URL-grounding subsystem is schema-library-agnostic in design (path-list in, path-list out) and could be ported almost verbatim to any Zod-based extract contract.
- `packages/core/lib/prompt.ts` — every system/user prompt builder; verbatim text is directly reusable/adaptable for a CLI's act/extract/observe LLM calls.
- `packages/core/lib/inference.ts` (`extract`, `observe`, `act` functions) — the full two-call extract pattern and the act/observe Zod schemas (`elementId` regex, `method` enum, `arguments` array) are a ready-made contract to copy.
- `packages/core/lib/v3/cache/ActCache.ts` + `CacheStorage.ts` + `cache/utils.ts` — a complete, small (< 500 LOC combined), dependency-light cache+self-heal implementation directly forkable for a CLI's own action cache (fs-JSON or in-memory, sha256 key, diff-based self-heal).
- `packages/core/lib/v3/types/private/cache.ts` — the exact TS shapes (`CachedActEntry`, `CachedAgentEntry`, `AgentReplayStep` union) worth copying as the on-disk cache schema.

## Anti-patterns

- **Two sequential LLM calls per extract() invocation** (content + metadata/completion) doubles latency and cost for what a single well-designed schema (e.g. a `completed: boolean` field baked into the same schema) could answer in one call — reasonable for Stagehand's chunked/paginated extraction use case, but likely unnecessary overhead for a simpler single-page CLI extract.
- **Whitespace-collapse via regex on prompt strings** (`.replace(/\s+/g, " ")`) is a mild code smell — it makes the *shipped* prompt hard to diff-review from source without running the transform; a plain constant string (or a template literal without leading indentation) achieves the same token efficiency without the runtime transform.
- `injectUrls`'s fallback `idToUrlMapping[id] ?? ""` silently replaces an unresolvable ID with an **empty string** rather than surfacing an error — a schema-validation-breaking hallucinated ID from the LLM becomes an invisible empty URL in the final output instead of a loud failure.

## Digest path

`/Users/seventyleven/Desktop/ultimate-agent-browser/research/sources/r2-stagehand-extract-cache.md`
