# Aside "Asidewright" — Actuation Engine Digest (source: parts 90, 101, 92)

Source teardown files (all KNOWN/carved from `aside-daemon` SEA binary + fork Mach-O, byte-offset cited):
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/90_asidewright.md`
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/101_asidewright_actuation.md`
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/92_agent_chromium_patches.md`

## Killer Insight

The model never touches a CDP `backendNodeId` — it holds a short opaque string ref (`e31`, `f1e12`) that is **re-resolved fresh from the live DOM on every single action**, never cached from the snapshot. Resolution is two-hop: daemon `Locator.#r()` dispatches by selector shape → an in-page `__aside.deref(ref)` does an O(1) registry-Map hit if the node is still attached, or falls back to a bounded (≤5000 node) TreeWalker re-match keyed on **(accessibility role, accessible name) + snapshot-time ordinal** if the node detached/re-rendered (e.g. React remount). This single mechanism — late-bound, meaning-based re-resolution instead of identity-based caching — is *why* Asidewright survives SPA re-renders that would stale out a stored element handle, and it is the one pattern worth copying wholesale into the ultimate CLI's ref system.

## Patterns

### 1. Late-bound ref resolution, never cache a node handle (CORE)
**What:** Every locator action starts with `let t = await this.#r()` — a fresh resolve — never reuses a handle from a previous call or from the snapshot that minted the ref.
**Why:** A CDP `objectId`/`backendNodeId` invalidates the instant the DOM node is removed/replaced (common on any SPA re-render). Caching handles is the #1 cause of "click failed, node no longer exists" flakiness in naive CDP agents.
**How:** Model the ref as a *query*, not a pointer: `ref → (frame, role, accessibleName, ordinal)` tuple recorded at snapshot time. On every action, re-run the query against the live DOM.
**Evidence:** 101_asidewright_actuation.md §2.1 (`zQ.#r()` dispatcher, offset ~99,515,300), §2.3 (`deref`, 99,442,397).
**Tier:** core

### 2. Two-stage deref: registry hit → bounded TreeWalker fallback by (role, name, ordinal) (CORE)
**What:** `deref(ref)`: fast path `elementRegistry.get(ref)` + `isConnected` check; slow path walks `document.body` with `NodeFilter.SHOW_ELEMENT`, capped at `DEREF_WALKER_BUDGET = 5000` nodes, collecting elements whose `(role, accessibleName)` match the ref's recorded signature; if exactly one match, use it; if several, use `meta.nthAmongSameSignature` (the k-th match ordinal recorded at snapshot time); else return null.
**Why:** Re-finding by *meaning* (role+name) rather than DOM position survives re-renders/reflows/reorderings that change node identity but not semantics. The 5000-node cap bounds worst-case cost on huge pages instead of hanging.
**How:** Maintain an `elementRegistry: Map<ref, WeakRef<Element>>` populated at snapshot time, plus a parallel `lastRefs: {ref: {role, name, ordinal}}` metadata map. On cache miss, TreeWalker with a hard visited-node budget; disambiguate ties by ordinal.
**Evidence:** 101 §2.3, offset 99,442,397; `DEREF_WALKER_BUDGET` const @ 99,442,326.
**Tier:** core

### 3. Frame-prefixed refs (`fN` prefix) route deref into the correct isolated world (CORE)
**What:** Refs are `eN` for main frame, `fNeN` for the Nth child frame. The daemon parses the prefix, resolves that frame's CDP `isolatedContextId` via `resolveFrameIdForSnapshotPrefix`, and runs `Runtime.callFunctionOn` scoped to that context — so cross-origin iframes (OOPIFs) each get their own `__aside` world and resolve natively.
**Why:** Without per-frame context routing, cross-origin iframe elements are unreachable or require brittle iframe-piercing hacks.
**How:** Inject your perception/action helper script into every frame's isolated world (`Page.addScriptToEvaluateOnNewDocument` + per-frame `Runtime.callFunctionOn`), and mint refs with a frame prefix at snapshot time.
**Evidence:** 101 §2.2, offset 99,533,639; iframe refs get 3× attempts with `50*t` backoff (0/50/100ms) vs. 1 attempt for main frame.
**Tier:** core

### 4. RefStaleError as an engineered, actionable error message (CORE)
**What:** A dedicated `RefStaleError` class thrown when a ref can't resolve, with message *"Ref '{ref}' is stale — the element was removed or the page changed. Take a new snapshot and retry."* CDP-level errors (`"Cannot find object with given id"`, `"Cannot find context with specified id"`, `"Object reference chain is too long"`) are caught and reclassified into the same `RefStaleError` type via a classifier function (`_Q`).
**Why:** The error text is written as an instruction to the calling agent, not a generic exception — it tells the model exactly what recovery action to take (re-snapshot) rather than making it guess. It's explicitly *not* counted against any retry budget — treated as a normal, expected tool result to iterate on.
**How:** Wrap every CDP call that dereferences an objectId with a catch that maps known "stale handle" error substrings to your own typed error whose message states the recovery action verbatim.
**Evidence:** 101 §2.5, `YZ` class @ 99,462,856, classifier `_Q` @ 99,481,627.
**Tier:** core

### 5. Actionability gate: attached → visible → enabled → stable, with precise poll timings (CORE)
**What:** `waitForReady(element, checks, timeoutMs=5000)` loops checking, in order: `attached` (`el.isConnected`), `visible` (`checkVisibility({checkOpacity:false, checkVisibilityCSS:true})` AND `rect.width>0 && rect.height>0`, re-poll every **16ms** if not yet visible), `enabled` (`!isDisabled(el)`), `stable` (bounding box identical across a **32ms** gap — measure, sleep 32ms, re-measure; if it moved and there isn't enough timeout budget left, fail with `"Element is moving"`, else loop).
**Why:** This is the exact gate list requested — attached/visible/stable/enabled — with concrete numbers: 16ms (~1 frame @ 60Hz) revisibility poll, 32ms (~2 frames) stability window. Note `checkOpacity:false` — an `opacity:0` element still counts visible for actionability (unlike a stricter "isVisible" used elsewhere for perception), because CDP can still click it.
**How:** Implement as an in-page function (runs in the injected isolated-world script, not daemon-side) so it has zero CDP round-trip cost per poll. Return `{ok:true}` or `{ok:false, error:"..."}` with one of a fixed small set of error strings your daemon-side retry loop pattern-matches on.
**Evidence:** 101 §3.1, verbatim code @ 99,447,665.
**Tier:** core

### 6. `isDisabled`: native `.disabled` + `fieldset:disabled` (excluding legend) + `aria-disabled` ancestor walk (IMPORTANT)
**What:** Checks `.disabled` on form-control tags, `closest('fieldset:disabled')` with a legend-exclusion special case (a `<legend>` inside a disabled fieldset is still interactive), and walks all ancestors for `aria-disabled="true"`.
**Why:** Naive disabled checks miss the fieldset-disables-descendants HTML semantic and ARIA-only disabled states common in custom widget libraries.
**How:** Implement exactly this three-part check as a reusable in-page primitive.
**Evidence:** 101 §3.1, offset ~99,449,x.
**Tier:** important

### 7. `checkHitTarget`: occlusion test via `elementFromPoint`, shadow-piercing, bidirectional composed-ancestor test (CORE)
**What:** At the computed click point, walk `elementFromPoint` recursively through shadow roots (`root.elementFromPoint` → if result has a `shadowRoot`, descend and re-test) to find the topmost hit element. Accept the click as OK if the target is a composed ancestor-or-descendant of the hit element **in either direction** — i.e. clicking a `<button>` whose visible child `<span>` absorbs the point still passes, and clicking a wrapper whose actual target descendant absorbs the point also passes.
**Why:** This is the exact fix for the classic false-negative of a naive `elementFromPoint(...) === target` check, which fails whenever the click point lands on a styled child (icon, span, pseudo-element) rather than the exact target node. Also correctly handles shadow DOM (web components).
**How:** `isComposedDescendant(a,b)` walks `parentNode`, treating `ShadowRoot.host` as the parent-equivalent when crossing a shadow boundary. Test both `isComposedDescendant(hitEl, target)` and `isComposedDescendant(target, hitEl)`.
**Evidence:** 101 §3.2, verbatim @ 99,446,503. Two distinct "obscured" error strings: `"Element is obscured at click point"` (off-hit-element entirely, but element itself is real/on-screen falls back to OK) vs `"Element is obscured by another element"` (genuine occlusion).
**Tier:** core

### 8. Actionability retry loop: 3 attempts, `[0, 100, 200]ms` backoff, selective retry-vs-throw (CORE)
**What:** The outer loop `SQ` tries up to 3 times, pre-sleeping `[0,100,200]ms` before each attempt. Inside each attempt: run the full `waitForReady(['attached','visible','stable','enabled'])` gate (up to 5000ms internal timeout) → compute click point → run `checkHitTarget`. A `waitForReady` failure of `"moving"` or `"obscured"` retries only if not the last attempt; any other failure (disabled/detached/timeout) throws immediately — no point retrying something structurally broken. Same policy for `checkHitTarget` "obscured" failures. `force:true` bypasses the entire loop.
**Why:** This is the retry/backoff constant list explicitly requested. Distinguishing "retry-worthy" (transient: still animating, temporarily covered) from "throw-now" (structural: disabled, detached) prevents wasting the retry budget on unrecoverable states, and prevents false "flaky" retries hiding a genuinely broken selector.
**How:** `const BACKOFF = [0, 100, 200]; for (const ms of BACKOFF) { await sleep(ms); const gate = await waitForReady(...); if (!gate.ok) { if (isTransient(gate.error) && !isLastAttempt) continue; throw ... } ... }`. Note: a single attempt's internal `waitForReady` timeout (5000ms) means one "failed" attempt can itself burn up to 5s — total worst case ≈15s across 3 attempts, not just `0+100+200ms`.
**Evidence:** 101 §3.6, verbatim @ 99,486,468; `jQ=[0,100,200]` const @ 99,512,751. Cross-corrected in 101's own evidence table: earlier parts (92, 100) named the `[0,100,200]` loop without the algorithm — this is the full spec.
**Tier:** core

### 9. `resolvePointerTarget`: retarget checkbox/radio/listitem to the real hit-carrier before clicking (CORE)
**What:** Before computing a click point, resolve the *actual* element that should receive the pointer event, in priority order: (1) native checkbox/radio with a visible `<label>` → click the label instead (input may be 0-size/visually hidden); (2) element inside a `<label>` → prefer the label if its control is 0-size, else the control; (3) element is a framework form-control host (`label`, `[role=checkbox|radio|switch]`, `mat-checkbox`, `mat-radio-button`, `mat-slide-toggle`) → descend to the nested native/aria control; (4) already has `aria-checked`/`aria-selected` → use as-is; (5) a bare `<li>`/`[role=listitem|menuitem|option]` → find the highest-priority actionable descendant (checkbox/radio/switch-like first, then any tabbable element, then first visible candidate).
**Why:** This is exactly the class of DOM shape that defeats coordinate-based clicking in real apps: Material/Angular custom checkboxes, list items where only a nested control is interactive, labels wrapping zero-size inputs. Applying this *before* computing the click point (rather than clicking the ref's raw element) is what makes clicks land correctly on real production UIs.
**How:** Implement as a priority-ordered chain of DOM queries, each returning early on first match; run it as part of "pre-click retarget" before `waitForReady`/`checkHitTarget`.
**Evidence:** 101 §3.4, verbatim @ 99,443,741.
**Tier:** core

### 10. `retarget(element, behavior)`: label→control, wrapper→focusable-ancestor, three named behaviors (IMPORTANT)
**What:** `behavior='none'` = identity. `'button-link'` = climb via `closest('button, [role=button], a, [role=link]')` if not already a form control. `'follow-label'` = same climb toward interactive roles, plus: if the element is inside a `<label>` and isn't itself a form-control/contenteditable, resolve to `label.control`. `fill`/`focus`/`blur` use `follow-label`; `click` uses a `none`-then-`resolvePointerTarget` path instead.
**Why:** Separates "find the thing you click" from "find the thing you type into" — different DOM shapes matter for each (a `<label>` should route typing to its `.control` but clicking should route to the actual hit-testable element per pattern #9).
**How:** Small named-behavior enum, not a single generic "smart retarget" function — makes call sites self-documenting about intent.
**Evidence:** 101 §3.3, verbatim @ 99,443,052.
**Tier:** important

### 11. `checkEditable`: fill precondition (disabled / readonly / aria-readonly / not-editable-tag) (IMPORTANT)
**What:** Returns `{ok:false, error}` for disabled elements, `readOnly` inputs/textareas/selects, `aria-readonly="true"`, or a tag that's neither input/textarea/select/contenteditable. Each failure has a distinct human-readable error string.
**Why:** A single guard function with distinct error messages per failure mode gives the calling agent (or its LLM) enough signal to decide what to do next (e.g. "read-only" → don't retry fill, try a different field).
**Evidence:** 101 §3.5, verbatim @ 99,449,086.
**Tier:** important

### 12. Fill: three-mode dispatch — setvalue / bulk insertText / React `_valueTracker` native-setter fallback (CORE)
**What:** In-page prep returns a mode. `setvalue` (date/color/range/time/week/month/datetime-local input types — `sHt` set) sets `.value` directly + dispatches `input`+`change` (these types don't reliably accept synthesized keystrokes). Otherwise: focus+select in-page, then daemon sends a single **bulk** `Input.insertText{text}` CDP call (not per-character); empty string clears via a `Delete` keydown/keyup pair. After typing, **re-read the value**; if it doesn't match what was intended (a controlled React/Vue input swallowed it), walk the prototype chain to find the native `value` property's setter (`Object.getOwnPropertyDescriptor` up the prototype chain), call it directly to bypass any framework override, then reset the element's `_valueTracker` (React's internal change-dedup cache) via `tracker.setValue(previousValue)` so React's own `onChange` still fires correctly, then manually dispatch `input`+`change` events.
**Why:** This is the single most valuable "real production sites are hostile" fix in the whole doc — the React `_valueTracker` trick is exactly what's needed to reliably fill controlled inputs in React apps, a documented common failure mode for naive browser agents (setting `.value` directly on a React-controlled input is silently ignored because React's synthetic event system dedupes based on `_valueTracker`).
**How:** Implement the verify-then-fallback pattern generically: (1) try the fast native path, (2) re-read to verify, (3) only pay the expensive native-setter+tracker-reset cost if verification fails.
**Evidence:** 101 §4.3, verbatim @ 99,492,636.
**Tier:** core

### 13. Typing: per-character dispatch, `insertText` for printable / real `keyDown`+`keyUp` for control keys, zero built-in jitter (IMPORTANT)
**What:** `pressSequentially`/`type` iterates characters. Printable chars → `Input.insertText{text}` (fires real `beforeinput`/`input` events like human typing). Non-printing keys (Enter, Tab, arrows, Escape, Delete, etc. — detected via `key.text.length===0`) → a full `rawKeyDown`+`keyUp` pair with proper keycode/location/isKeypad fields. Optional caller-supplied per-key delay defaults to **0** — there is no built-in randomized timing jitter (`grep Math.random` in the type path returns nothing).
**Why:** Confirms the "human-like typing" claim resolves to *event-type correctness* (real key events for control keys so search-as-you-type/validation/React-controlled inputs behave correctly), not timing randomization. Anti-pattern warning: don't over-engineer fake human delay jitter if it isn't load-bearing for site compatibility — Aside doesn't bother.
**How:** Maintain a full keycode map (`a-z`→65-90 w/ shift variants, digits w/ shifted symbols, punctuation w/ shifted variants, named keys: Backspace=8, Tab=9(\t), Enter=13(\r), Escape=27, Delete=46). Split "does this key produce text" vs "control key" and branch dispatch accordingly.
**Evidence:** 101 §4.4, `HVt` @ 99,502,082; keycode notes @ end of file.
**Tier:** important

### 14. `press` (key combo): modifiers-down → main key down+up → modifiers-up in reverse, with platform-aware ControlOrMeta (IMPORTANT)
**What:** `"Control+Shift+A"` splits into modifiers + main key. Dispatch order: each modifier key down (in order), main key down then up, then release modifiers in **reverse** order (finally block, swallowing errors). `ControlOrMeta` resolves to `Meta` on darwin, `Control` elsewhere. Mac-specific editing shortcuts map to native editor `commands[]` in the `Input.dispatchKeyEvent` payload (`Meta+A→selectAll`, `Meta+C→copy`, etc.) so `page.keyboard.press('Meta+A')` triggers the actual native select-all command, not just a raw keystroke.
**Why:** Reverse-order modifier release and the `commands[]` field are non-obvious CDP details that matter for correctness on macOS-native text editing behaviors (contenteditable rich editors especially).
**Evidence:** 101 §4.4, `zVt` @ ~99,501,700; mac shortcut table `YBt`/`oHt`.
**Tier:** nice

### 15. Click actuation: mouseMoved before press, zero inter-event delay, DOM-activation fallback for `<a href>`/checkbox/radio, obscured→DOM-activate fallback, combobox 80ms force-open (CORE)
**What:** Full click sequence: pre-click retarget (`kVt`) → combobox/control-state probe (`bQ` returns `{checked, isComboboxLike, isCheckable, isRadio, popupUrl, prefersDomActivation, expanded}`) → if `prefersDomActivation` (native `<a href>` with a real href, or native checkbox/radio) skip coordinate dispatch entirely and call `el.click()` (DOM activation), then verify the expected state change (checked flipped, or popup opened) actually happened → else run the full actionability+retry loop (`SQ`) to get a click point → dispatch `mouseMoved(button:none)` then N×`{mousePressed, mouseReleased}` pairs back-to-back with **no delay between press and release** (only CDP round-trip latency) → if the click loop threw `"obscured"` and not `force`, fall back to DOM activation (`el.click()`) instead of failing outright → for a collapsed combobox, wait **80ms** after click and re-probe `aria-expanded`; if still collapsed, force-open via DOM activation → modifier keys pressed down before mouse events, released in reverse order in a `finally`.
**Why:** The comment cited in the source explains the *why* for `prefersDomActivation`: "coordinate-based CDP dispatch can miss the link when a child element (icon span, image) at the click point absorbs the event without triggering default navigation." This is a documented, deliberate escape hatch from pure-coordinate clicking for known-fragile targets, not a fallback of last resort.
**How:** Two click strategies gated by target type: coordinate dispatch as default, DOM `.click()` for links/native-checkable-controls and as an obscured-recovery fallback. Post-click state verification (did the checked state actually flip?) rather than trusting the dispatch succeeded.
**Evidence:** 101 §4.2, full verbatim @ 99,490,421.
**Tier:** core

### 16. Click point computation: bounding-box center primary, content-quad centroid fallback (area ≥ 0.99px) (IMPORTANT)
**What:** `scrollIntoViewIfNeeded` first (CDP `DOM.scrollIntoViewIfNeeded`, falls back to in-page `scrollIntoView({block:'center', inline:'center', behavior:'instant'})`), then compute click point as the element's `getBoundingClientRect()` center if width/height > 0; if that fails, fall back to CDP `DOM.getContentQuads` and pick the first quad with shoelace-polygon area ≥ 0.99px, using its centroid.
**Why:** Bounding-box center is cheap and correct for the vast majority of elements; the content-quad fallback handles elements with complex/transformed geometry (CSS transforms, multi-line inline elements) where a single rect is misleading.
**Evidence:** 101 §4.1, `MVt` @ ~99,488,700.
**Tier:** important

### 17. Iframe coordinate translation: add owning-iframe offset, dispatch on root session (CORE)
**What:** For a ref inside a child frame, the in-page-computed click point is frame-local. `AVt` resolves the owning `<iframe>` element's `getBoundingClientRect()` (via `DOM.getDocument{pierce:true}` + `querySelectorAll('iframe,frame')` matching by `frameId`), adds that offset to the frame-local point, and dispatches `Input.dispatchMouseEvent` on the **root** CDP session (not the iframe's own session) — because `Input.*` events must be dispatched against the top-level page.
**Why:** This is the load-bearing detail that makes clicks land correctly inside nested/cross-origin iframes — a common failure point for naive multi-frame CDP automation (dispatching on the wrong session, or forgetting the coordinate-space offset).
**Evidence:** 101 §4.1, `AVt`/`jVt` @ ~99,487,600.
**Tier:** core

### 18. Post-action settle: 4-stage wait (doc-ready → hook window → same-domain net-idle → mutation-quiet) with an 8000ms hard budget (CORE — this is the full timing constant list)
**What:** After every mutating action, `cVt` runs: (1) wait for `document.readyState` settle, capped at `min(2000ms, remaining budget)`; (2) a flat **150ms hook window** letting just-fired event handlers schedule their fetches; (3) same-domain network-idle — track only same-registrable-domain requests (ignoring `WebSocket`, `EventSource`, `Ping`, `Prefetch`, `CSPViolationReport`, and `data:` URLs), budget **1200ms**, poll every **50ms**; (4a) if a navigation occurred mid-action, hand off to the separate interactive-readiness gate; (4b) else a post-settle grace window — **300ms** if the URL didn't change, **750ms** if it did (SPA route change), with an extra **500ms** grace before starting the mutation-quiet sampler on a route change — then run a DOM mutation-quiet sampler (MutationObserver-based, 50ms sample interval, considered quiet once `mutationCount/totalNodes ≤ 0.01` for 1 consecutive sample in this context). Overall hard budget: **8000ms**. On budget exhaustion during an *interactive* nav-wait, emit a soft `[warning]` and return successfully rather than throwing — the agent isn't blocked by settle timeout.
**Why:** This is the exact settle-timing constant set requested. The "relative" mutation-quiet threshold (ratio, not absolute count) is a genuinely clever detail — 5 mutations on a 10,000-node page is quiet, 5 mutations on a 100-node page is not.
**How:** Full constant list to replicate: `overallBudget=8000ms`, `docReadyCap=2000ms`, `hookWindow=150ms`, `netIdleBudget=1200ms`, `netIdlePoll=50ms`, `postSettleNoUrlChange=300ms`, `postSettleUrlChanged=750ms`, `routeChangeGrace=500ms`, `mutationQuietRatio=0.01`, `quietSampleCount=1` (post-action) or `2` (nav-readiness "stable" gate), `readinessPoll=100ms`.
**Evidence:** 101 §5.1, verbatim @ 99,478,856; constants block `CVt` fully enumerated.
**Tier:** core

### 19. Navigation `waitUntil` state machine: adds `interactive`/`stable` beyond Playwright's default set (IMPORTANT)
**What:** `goto()` defaults `waitUntil` to `'interactive'` (not Playwright's `'load'`). States: `commit` (fire-and-forget), `interactive`/`stable` (route to the readiness gate: doc not-loading + landmark-or-≥20-text-chars present + no same-origin in-flight request for 1500ms + nonzero interactive-element count for 1000ms; `stable` additionally requires 2 consecutive mutation-quiet samples), `networkidle` (500ms of zero in-flight requests), `load`/`domcontentloaded` (raw CDP lifecycle events). All page-ops cap at **30,000ms**. `waitForLoadState('networkidle'|'load')` is treated as redundant post-`openTab`/`goto` and emits a `[system]` nudge falling back to `stable` with a 5s timeout — a deliberate anti-pattern warning baked into the tool itself.
**Why:** Defaulting to a semantic "interactive" state (rather than the network-driven `load` event) is more robust against pages with long-polling/analytics beacons that never truly reach network-idle.
**Evidence:** 101 §5.2, verbatim @ ~99,600,700; gate readiness constants: `pQ=8000` (gate budget), `lVt=100` (poll), `yVt=1500`, `bVt=1000`.
**Tier:** important

### 20. Snapshot diff instead of full re-tree — the real "80% fewer tokens" mechanism (CORE, perception not actuation but load-bearing)
**What:** `snapshot()` computes a Myers O(ND) diff between the previous tree and the current tree, formatted as git-style unified `@@ -old +new @@` hunks, and returns the **diff only if it's shorter than the full tree** (`diff.length > tree.length ? tree : diff`). `"No changes detected"` when identical.
**Why:** This is the mechanism, not a tokenizer trick, behind large context savings after actions — a click that changes 5 lines on a 2000-line page costs a few `@@` hunks, not a full re-serialization.
**How:** Store previous tree per-tab; Myers diff; return whichever is shorter; anti-truncation guard that regex-scans agent code for `tree.substring/slice/split` calls and injects a `[warning]` telling the model not to hide context.
**Evidence:** 90_asidewright.md §5b, `MHt` @ 99,568,270; anti-truncation guard §5c.
**Tier:** core (belongs to the "ultimate CLI" perception loop even though it's outside strict actuation scope)

### 21. Ref regex validation and `[ref=eN]` wrapper tolerance (NICE)
**What:** `Locator` constructor accepts either a bare ref (`e31`) or a `[ref=e31]` wrapper string, stripping the wrapper via regex before dispatch. Throws immediately on empty/non-string selectors with an instructive message ("Take a fresh snapshot and verify the ref exists").
**Why:** Small ergonomic robustness — accepts the exact string format the model is likely to copy-paste from a rendered snapshot (which prints `[ref=eN]` inline) as well as the bare ref.
**Evidence:** 90 §3, `dHt`/`fHt` regexes; 101 §2.1.
**Tier:** nice

### 22. Background-tab, no-focus-steal architecture: `background:true, focus:false` + forced-active lifecycle + focus emulation (CORE — directly answers the "no-focus-steal" requirement)
**What:** Every agent tab is created via CDP `Target.createTarget{background:true, focus:false}` — never `newWindow:true`. Tabs are corralled into a dedicated `chrome.tabGroups` group titled "Agent Tabs" via a fork-added CDP verb (`Aside.ensureTabInAiTabsGroup`). The only tab-lifecycle verb exposed to the agent, `Aside.controlTab`, has exactly two actions — `open` and `close` — **no `activate`/`focus`/`foreground`/`select`** action exists at all, a structural (not just behavioral) guarantee the agent can never steal foreground. To counteract Chromium's normal background-tab throttling (frozen lifecycle, clamped timers, `document.hidden=true`), the daemon calls `Page.setWebLifecycleState{state:'active'}` (defeats freeze/throttle) and `Emulation.setFocusEmulationEnabled{enabled:true}` (renderer reports `document.hasFocus()===true`, `:focus` styles apply, autofocus works, synthesized keystrokes are accepted) on every session — this is the *only* `Emulation.*` verb the daemon ever calls.
**Why:** This is the single cleanest way to get "the agent can drive N tabs in parallel without ever disrupting the user's foreground work or each other" — and it solves the otherwise-fatal problem that a genuinely backgrounded tab is throttled by the browser and won't behave normally for automation (typing no-ops, animations don't settle, visibility-gated SPA code stalls).
**How:** On every new agent-driven tab: `Target.createTarget{background:true, focus:false}` → `Page.setWebLifecycleState{state:'active'}` → `Emulation.setFocusEmulationEnabled{enabled:true}`. Never expose an "activate/foreground" verb to the agent at all — remove the temptation structurally.
**Evidence:** 92 §1, verbatim @ daemon offsets 269399/269401/268171; `controlTab` schema @ 267037 showing exactly 2 actions.
**Tier:** core

### 23. Fixed viewport (1440×900) matching CUA/vision-model training distribution, enforced browser-side not via CDP emulation (IMPORTANT)
**What:** Default/fallback agent viewport is a hardcoded `{width:1440, height:900}` constant. Critically, this is **not** enforced via `Emulation.setDeviceMetricsOverride` (0 hits in the daemon) — instead the fork renders agent tabs into a dedicated, independently-sized contents view (`AsideAiTabsViewport`, a custom `MultiContentsView` child) decoupled from the OS window, so the render size is guaranteed browser-side and the daemon just measures it back (`refreshViewportSize()` reads `visualViewport.width/height` and falls back to the constant only if measurement fails). Screenshots fed to the model use `scale:1`, `captureBeyondViewport:false` — a deterministic 1440×900 logical-pixel image every time.
**Why:** Vision/CUA models are trained on a small set of canonical desktop resolutions; keeping every observation at a fixed, in-distribution resolution avoids coordinate-prediction drift and responsive-breakpoint mismatch that a window-relative viewport would introduce.
**How:** If your CLI drives a headless or windowed browser, pin a fixed viewport size (matching whatever vision model you use, if any) via `Emulation.setDeviceMetricsOverride` (simpler than a custom render surface if you don't control the browser fork) rather than letting it follow window size.
**Evidence:** 92 §2, consts @ 269398/269402/269404; absence of `setDeviceMetricsOverride` confirmed via grep (0 hits).
**Tier:** important (the *why* is well-grounded but the specific number is only useful if you match your own vision model's training resolution — don't cargo-cult 1440×900 itself)

### 24. Stealth posture: never enable automation mode at all, rather than patch detection APIs after the fact (IMPORTANT — anti-pattern-adjacent lesson)
**What:** No `--enable-automation` flag is ever passed. Consequently `navigator.webdriver` reads `false` naturally (it's not spoofed — automation mode was simply never turned on) and there's no "Chrome is being controlled by automated software" infobar. No `HeadlessChrome` UA token; genuine desktop Chrome UA. Driven via `chrome.debugger` from an installed, signed extension against the user's real profile (real cookies, real login sessions, real TLS/JA3 fingerprint, residential IP) — not a fresh/proxy/datacenter-IP automation profile.
**Why:** This is architecturally the strongest anti-bot-detection posture available (matches Browserbase/Browser-Use's approach) and it's cheaper than patching `navigator.webdriver` and friends after the fact, because there's nothing to patch — the standard detection surface simply isn't triggered.
**How:** For a CLI-driven agent-browser: prefer driving a real, non-headless, non-`--enable-automation`-flagged browser instance (e.g. via `chrome.debugger` extension or a real user profile connect) over launching Playwright/Puppeteer in default automation mode. If launching your own browser, explicitly avoid `--enable-automation` and consider `--disable-blink-features=AutomationControlled`.
**Evidence:** 92 §3, verbatim/grep evidence @ fw offsets 1025425/1143083/1134494/1044436.
**Tier:** important

### 25. REPL globals: `page` as a live getter/setter onto the active tab, not a fixed variable (NICE)
**What:** In the persistent `node:vm` REPL context, `page` is `Object.defineProperty`'d as a getter/setter onto `AsideBrowser`'s active-page pointer, so after `openTab`, a popup event, or a tab close, `page` transparently reflects whatever tab is now "active" without the model needing to reassign it manually (though it can: `page = tabs[N]`).
**Why:** Removes a whole class of "stale page reference after tab switch" bugs from agent code, at essentially zero cost.
**Evidence:** 90 §7a, `Object.defineProperty(this.#c, "page", ...)`.
**Tier:** nice

## Command Surface (verbatim API shapes worth adopting)

```js
// Locator construction — accepts ref, [ref=eN] wrapper, role:, text:, or raw CSS
page.locator('e31')
page.locator('[ref=e31]')
page.locator("role:button[name*='Submit'][checked=true][level=2]")  // via getByRole()
page.getByRole('button', {name: 'Submit', exact: false})
page.getByText('Sign in', {exact: true})
page.getByLabel(/email/i)
locator.first() / locator.nth(k) / locator.filter({hasText: '...'})
locator.locator('sub-selector')  // '>>' chaining under the hood

// Full Locator action surface
click, fill, selectOption, check, uncheck, setChecked, scrollIntoViewIfNeeded,
press, pressSequentially, type(=pressSequentially), hover, dblclick, tap,
focus, blur, clear(=fill('')), setInputFiles, dragTo,
evaluate, evaluateAll, isChecked, inputValue, innerHTML, innerText, textContent,
elementHandle, count, all, first, nth, filter,
getByRole, getByLabel, getByText, screenshot

// Actionability check contract (in-page function)
waitForReady(element, checks: ['attached','visible','enabled','stable'], timeoutMs=5000)
  -> {ok: true} | {ok: false, error: string}

checkHitTarget(element, point: {x,y}) -> {ok: boolean, error?: string}

// Ref-deref contract
globalThis.__aside.deref(ref: string) -> Element | null

// RefStaleError message contract
`Ref "${ref}" is stale — the element was removed or the page changed. Take a new snapshot and retry.`

// Retry backoff constant
const RETRY_BACKOFF_MS = [0, 100, 200];  // 3 attempts

// Settle constants (all ms)
const SETTLE = {
  overallBudget: 8000,
  docReadyCap: 2000,
  hookWindow: 150,
  netIdleBudget: 1200,
  netIdlePoll: 50,
  postSettleNoUrlChange: 300,
  postSettleUrlChanged: 750,
  routeChangeGrace: 500,
  mutationQuietRatio: 0.01,
};

// waitForReady internal poll constants
const VISIBLE_REPOLL_MS = 16;   // ~1 frame
const STABLE_WINDOW_MS = 32;    // ~2 frames

// Navigation waitUntil states (superset of Playwright)
goto(url, {waitUntil: 'commit'|'interactive'|'stable'|'networkidle'|'load'|'domcontentloaded'})
// default: 'interactive' (not Playwright's 'load')
// page-op cap: 30000ms; networkidle quiet window: 500ms

// Snapshot return shape — diff-if-shorter
snapshot(page, opts) -> { tree: string, refs: Record<string, ElementMeta>, diff: string }
// diff = diffLen > treeLen ? tree : diff

// Background-tab creation (no-focus-steal)
Target.createTarget({url, background: true, focus: false})
// followed by:
Page.setWebLifecycleState({state: 'active'})           // defeat background throttling
Emulation.setFocusEmulationEnabled({enabled: true})     // renderer believes it's focused
```

## Anti-patterns (do NOT copy)

1. **Do not add randomized human-like typing jitter as a stealth/reliability mechanism.** Aside's own `pressSequentially` has zero timing jitter (`grep Math.random` in the type path is empty) — reliability comes from correct event types (real `keyDown`/`keyUp` for control keys, `insertText` for printable chars), not from fake delays. Adding jitter is cargo-culting a "human-like" feature that the reference implementation deliberately skips.

2. **Do not conflate the "80% fewer tokens" / "100% identical interface" marketing numbers with verified facts.** The teardown explicitly found these literal strings absent from the binary — the *mechanism* (diff-when-shorter, compact refs, output truncation) is real and worth copying, but don't reproduce or promise the specific percentage without your own measurement.

3. **Do not treat `checkVisibility({checkOpacity:false})` as your perception-layer visibility definition.** It's deliberately looser than a "real" visibility check (an `opacity:0` element still passes) because it's used for *actionability* (can CDP click it) not for *what should appear in the snapshot tree*. Conflating these two definitions of "visible" will make your snapshot show/hide elements inconsistently with what your click gate allows.

4. **Do not skip the "throw immediately on non-transient failure" branch of the retry loop.** A tempting simplification is "just retry N times on any failure" — but Aside's loop explicitly throws immediately on `disabled`/`detached`/generic-timeout and only retries `moving`/`obscured`. Retrying a permanently-disabled element 3× wastes ~15s (since each attempt's internal `waitForReady` has its own 5s timeout) for zero benefit.

5. **Do not build a single monolithic "smart click" function that both retargets and clicks in one unstructured blob.** The reference implementation cleanly separates `retarget` (label→control semantics) from `resolvePointerTarget` (which specific descendant should receive the pointer event) from `checkHitTarget` (occlusion) from `SQ` (the retry orchestration) from `DQ` (the actual dispatch + DOM-activation-fallback decision). This separation is what makes each piece independently testable and reusable (`retarget` alone is reused by fill/focus/blur).

6. **Do not dispatch iframe clicks on the iframe's own CDP session.** `Input.*` events must go to the root/top-level session with coordinates translated to root-viewport space (owning-iframe offset added) — dispatching on the iframe's session with frame-local coordinates is a real class of bug this pattern avoids.

7. **Do not use `Emulation.setDeviceMetricsOverride` as your only viewport-fixing tool if you actually care about accuracy** — the reference system deliberately avoids it in favor of a real independent render surface, because device-metrics overrides can subtly diverge from what a real desktop browser at that resolution would render (media queries, scrollbar presence, etc.) in edge cases. For a CLI tool without a custom browser fork, `setDeviceMetricsOverride` is still the pragmatic choice — just be aware it's not what the reference implementation considered best-in-class.

## Known Gaps (honestly noted by the source, carry forward)

- The exact `globalThis.__aside.takeSnapshot` in-page serialization rules (role filtering, name computation algorithm, how `interactive` mode prunes the tree) were not fully carved — only the I/O contract is known.
- `dragTo` step count / interpolation and `setInputFiles` in-memory-buffer path are documented but lower priority for a v1 actuation engine.
