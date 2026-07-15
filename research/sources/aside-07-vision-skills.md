# Source Digest — Aside: Vision Loop + Skills Engine

**Source label:** aside:vision+skills
**Primary paths read in full:**
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/98_vision_loop.md` (743 lines)
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/99_skills_engine.md` (628 lines)

Both are Tier-1A carves from the `aside-daemon` v1.26.702.2347 binary (`strings` dump, byte-offset
cited), on-disk `SKILL.md` files, and a 300-task Mind2Web benchmark trajectory corpus. All claims below
are labeled KNOWN unless noted INFERRED/DESIGNED, matching the source's own labeling.

---

## Killer Insight

Vision is not a perception channel, it's an **escalation of last resort that costs friction on
purpose** — every screenshot API returns inert bytes that require an explicit `display()` call to
enter the model's context, so the *model has to decide to look*, and that one design choice (no
auto-injected images) is what kept measured vision usage at 10.7% of 300 real tasks (5.7%
non-captcaptcha) instead of every-turn. Paired with that: the skill system is a **URL/keyword-scored
glob matcher** (`host_specificity*100 + path_specificity*10 - wildcard_count`) that auto-injects a
tiny "site skill" cheat sheet (or a compiled native API client) only when the active tab or the user's
message names the site — so an agent never burns context on 400+ skills, it sees name+description+path
for the always-on set and gets the *exact* right playbook auto-attached only when needed. Together these
are the same principle: **default to the cheap channel (text tree / no skill), escalate to the
expensive channel (pixels / site playbook) only when scored evidence says the cheap channel can't do
the job** — and log/score that decision so you can audit it.

---

## Patterns

### 1. Reading escalation ladder — text always before pixels (CORE)
**What:** System prompt enforces a strict order: `snapshot({interactive:true})` → `snapshot()` → wait+resnapshot → `annotatedScreenshot()` → raw `page.screenshot()`. Vision is explicitly framed as "visual **confirmation**," not primary reading.
**Why:** This ordering, not a vision model's cleverness, is what produces the 89.3% zero-vision result. An agent CLI that defaults to screenshots-first will burn tokens and money on every turn for no accuracy gain on ordinary pages.
**How to implement:** Bake a literal "Reading Escalation" section into the system prompt with this exact 4-5 step order; make screenshot/`display()` two separate calls (not implicit) so the escalation to step 4 is a deliberate model decision, not free.
**Evidence:** `98_vision_loop.md:52-100` (verbatim system prompt block, `25_daemon_brain.md:126,368,378-381`).
**Tier:** core

### 2. `display()` friction is deliberate — screenshots return inert bytes, not context blocks (CORE)
**What:** `page.screenshot()`, `locator.screenshot()`, `annotatedScreenshot()` all return raw bytes/base64/`{base64Image}`. Nothing auto-injects an image into the model's context — the agent must separately call `display(bytes)`.
**Why:** This is the mechanistic reason vision usage stays low; it's a deliberate two-step (capture, then decide-to-show) rather than a one-step screenshot-tool-that-shows-automatically.
**How to implement:** In the CLI's tool surface, split "capture" (returns a file path / buffer) from "show" (a separate `display`/`view_image` call that actually returns an image content block to the model). Never auto-attach screenshots to every tool result.
**Evidence:** `98_vision_loop.md:94-96`.
**Tier:** core

### 3. `annotatedScreenshot()` — in-page DOM overlay, refs shared with text tree (CORE)
**What:** Draws a real `<div id="__aside_annotations__">` container into the page DOM via `Runtime.callFunctionOn` in the isolated execution context, one bounding box per interactive element (same `eN` ref ids as the a11y snapshot), screenshots via CDP, then tears the overlay down in a `finally`.
**Why:** Because it's drawn in-page by the browser's own layout engine, boxes are pixel-perfect regardless of zoom/DPR/transforms — no server-side coordinate math needed. And because the label IS the same ref id as the text snapshot, the model can cross-reference "box e17 in the image" ↔ `link "..." [ref=e17]` in the tree, unifying the two channels instead of running a separate vision-grounding step.
**How to implement:** (a) take an interactive snapshot first to get refs; (b) inject one absolutely-positioned, `pointer-events:none`, `z-index:2147483647` container div; (c) per ref, `getBoundingClientRect()` → red `2px solid rgba(255,0,0,0.8)` box at `rect.{x,y}+scroll{X,Y}` (page coords, not viewport) with a `bold 11px/14px monospace` label = the integer ref number, positioned `-14px` above (or `+2px` inside if near top so it doesn't clip); (d) CDP `Page.captureScreenshot({format:'png'})`; (e) remove the container in a `finally` so it never leaks into the next real snapshot. Skip zero-size elements and refs that no longer deref to a live element.
**Evidence:** `98_vision_loop.md:104-220` (verbatim `annotatedScreenshot`/`LHt`/`RHt`, strings offset 16,051,395 / 16,040,487).
**Tier:** core

### 4. Screenshot capture: CDP-direct, PNG default, viewport fallback on full-page failure (important)
**What:** `page.screenshot()` wraps CDP `Page.captureScreenshot({format,captureBeyondViewport,quality,clip})`. `fullPage` measures the content box via `Page.getLayoutMetrics` (`cssContentSize`) and sets `captureBeyondViewport:true`; on OOM/timeout it auto-retries a **viewport-only** shot with a warning instead of hard-failing. `locator.screenshot` defaults to webp with `margin:8`; `annotatedScreenshot` is always PNG.
**Why:** Full-page screenshots on huge pages can OOM the browser process; a silent fallback keeps the agent loop alive instead of crashing the turn.
**How to implement:** Wrap capture with a try/catch that, on `fullPage` failure only (not on explicit `clip`), retries with `captureBeyondViewport:false` and logs `[system] full-page screenshot failed; returned viewport fallback.` Clamp capture dimensions to a max (Aside uses `16384/devicePixelRatio` per axis, constant `cUt=16384`) before ever sending to CDP.
**Evidence:** `98_vision_loop.md:222-286` (verbatim `screenshot()`, strings offset 16,075,510; constants `cUt=16384`, default timeout `30000ms`, default viewport 1440×900).
**Tier:** important

### 5. Image resize pipeline: 2000×2000/4.5MB budget, dual-encode-keep-smaller, quality/scale ladder (CORE)
**What:** `L3()` uses Photon (Rust→WASM image lib) to downscale any image to fit **2000×2000px / 4.5MB**, Lanczos3 filter. It encodes BOTH PNG and JPEG at each candidate size and keeps whichever is smaller. If still over budget: walk JPEG quality **85→70→55→40**, then walk scale **75%→50%→35%→25%** (retrying the quality ladder at each scale step), never shrinking an axis below **100px**. Images already within budget pass through untouched.
**Why:** This is the actual cost-control lever — there's no per-image token accounting in the daemon at all; the resize budget IS the cost control. It also means UI screenshots (which compress well as PNG) stay crisp PNG while photographic content automatically goes JPEG, without hand-coded format logic.
**How to implement:** Implement as: `resize(image) -> {data, mediaType, wasResized, originalWidth, originalHeight, width, height}`. First check if `w<=2000 && h<=2000 && bytes<=4.5MB` → passthrough. Else compute aspect-preserving target box ≤2000×2000. For each of a quality ladder `[80(initial),85,70,55,40]` try `min(png_bytes, jpeg_bytes)`; if still over budget, for each scale in `[1,.75,.5,.35,.25]` (floor 100px per axis) retry the quality ladder. Give up and return smallest tried if budget still exceeded.
**Evidence:** `98_vision_loop.md:344-386` (verbatim `L3`, `a0t` config, strings offset ~16,522,600-16,525,638).
**Tier:** core

### 6. Coordinate-mapping note — mandatory scale-factor text alongside every resized image (CORE)
**What:** Whenever an image is resized before display, a companion text block is prepended: `[Image: original {W}x{H}, displayed at {w}x{h}. Multiply coordinates by {ratio} to map to original image.]`. Observed verbatim in trajectories on retina full-page (5456×3300 → 2000×1210, ×2.73) and 2×-DPR viewport (2880×1800 → 2000×1250, ×1.44) shots.
**Why:** Without this, coordinate-mode clicking (`cua.click({x,y})`) would systematically miss because the model reasons in downscaled-image pixels but the browser expects original-device pixels. This is the single cheapest fix for the #1 failure mode of vision-based clicking in any agent-browser.
**How to implement:** Any tool that both (a) resizes an image before showing it to the model and (b) later accepts pixel coordinates from the model MUST emit this exact style of note with the multiplier, and any coordinate-click tool must multiply model-given coordinates by that same ratio before dispatching the real click.
**Evidence:** `98_vision_loop.md:387-408` (verbatim `i0t`, trajectory quotes).
**Tier:** core

### 7. MIME-sniff whitelist by magic bytes, not by declared type (important)
**What:** `display()` reads the first 4100 bytes and magic-byte-sniffs the format, accepting only `image/jpeg|png|gif|webp`. Anything else throws `invalid image input: display() expects raw base64, a data URL, or image bytes as Uint8Array/Buffer (jpeg, png, gif, webp)`.
**Why:** Defends against malformed/mislabeled bytes reaching the model API and producing an opaque provider-side error deep in the call stack; fails fast and legibly instead.
**How to implement:** Before shipping any image to a provider, sniff magic bytes over a small prefix window (~4KB) and validate against an explicit format whitelist; reject with a clear, actionable error message rather than a raw exception.
**Evidence:** `98_vision_loop.md:332-342` (verbatim `j3`, strings offset 16,497,721).
**Tier:** important

### 8. Two vision consumers, two different model slots (CORE)
**What:** In-loop vision (`display()` of a screenshot) is read by the **session model itself** — whatever the current chat/agent model is. Captcha OCR (`captcha.readText()`) is a **separate one-shot completion** against a dedicated `visual` model category — a distinct configured slot, not the chat model, and it never enters the agent's reasoning context.
**Why:** Keeps the OCR sub-call cheap/fast (small `maxTokens:64`, no conversation history) and avoids the OCR request/response polluting the main agent's context window or costing full session-model rates. It also lets a user route OCR to a cheaper/faster model independently.
**How to implement:** Define ≥2 model routing categories (e.g. `chat`/`session` and `visual`/`ocr`); route in-loop "look at page" calls through the session model's normal content-block mechanism, but route narrow sub-tasks (OCR, classification) through a dedicated cheap-model one-shot `completeSimple`-style call with a tight system prompt and small `maxTokens`, keeping results out of the main transcript except as plain text.
**Evidence:** `98_vision_loop.md:30-49, 485-549` (verbatim `readText`, strings offset ~16,613,700).
**Tier:** core

### 9. Model routing: 4 categories, each independently configurable (important)
**What:** Every model call routes through one of four categories: `fast`, `standard`, `deep`, `visual`, each a separate slot in settings with its own default per-provider (e.g. OpenAI: fast=gpt-5.4-mini, standard=gpt-5.4, deep=gpt-5.5, visual=gpt-5.5-medium). `resolveByCategory(cat)` resolves against whatever provider the user has auth for, throwing a clear error (`No visual model configured. Set one in Settings → AI Models.`) if unset — no silent fallback to chat model.
**Why:** Different sub-tasks have wildly different cost/latency/quality tradeoffs (background OCR vs. main reasoning loop); a single hardcoded model wastes money on trivial calls and under-resources hard ones.
**How to implement:** Define a small enum of routing categories tied to task shape, not to "the model" — `fast` (cheap classification/routing), `standard` (default chat), `deep` (hard reasoning), `visual` (OCR/vision sub-calls). Let each resolve independently per provider with explicit defaults; fail loud if a category has no configured model rather than silently reusing another category's model.
**Evidence:** `98_vision_loop.md:552-597` (verbatim `resolveByCategory`, table of defaults, strings offset ~12,508,944/~12,509,100).
**Tier:** important

### 10. Coordinate-mode fallback (`cua`) is a gated skill, not always-on (CORE)
**What:** A `visual-browse` builtin SKILL.md documents when the agent should switch to a `cua` (computer-use) global for coordinate-addressed clicking: canvas apps, custom drag/slider/crop controls, unstable/missing refs, visual verification. Explicit "when NOT to use" list: ordinary text reading, navigation, simple buttons/links with usable refs, repeated blind coordinate guesses. Operating rules: always screenshot fresh before acting if coordinates unknown; verify after every mutating action; return to `snapshot()`/refs as soon as the visual task ends; if the same coordinate approach fails 2-3 times, switch strategy instead of repeating.
**Why:** This is the single clearest transferable design for "when is vision actually needed" — it's not a vague heuristic, it's an enumerated decision table the agent reads (progressive disclosure) only when it suspects it needs coordinate mode.
**How to implement:** Ship a documented decision policy (as a loadable skill/prompt fragment, not baked into every system prompt) listing concrete trigger conditions (canvas surfaces, custom widgets, missing refs) and anti-triggers (ordinary buttons/links), plus a hard rule like "2-3 failed coordinate attempts → switch strategy" to prevent infinite blind-coordinate loops.
**Evidence:** `98_vision_loop.md:412-482` (verbatim SKILL.md excerpts + `f3t` class, strings offset ~16,616,200).
**Tier:** core

### 11. `cua` is dumb pixels-in/mouse-out — no model call inside it (important)
**What:** `cua.getVisibleScreenshot()` = raw `page.screenshot({type:'png'})`.toBase64() — no overlay, no crop. `cua.click/drag/scroll/type` route through the exact same `page.mouse.*`/`page.keyboard.*` synthetic-input relay as ref-based locator actions. There is no separate "computer use model" — the session model reads the screenshot via `display()` and emits coordinates itself.
**Why:** Keeps the architecture simple: one input-dispatch subsystem serves both ref-based and coordinate-based actions; "computer use" is just a different way of choosing a target, not a separate automation stack.
**How to implement:** Implement click/type/scroll/drag as a single low-level input-dispatch layer (CDP `Input.*` or Playwright mouse/keyboard); build both ref-resolution ("click ref e17") and coordinate-based ("click x,y") targeting on top of that same layer, so behavior (hover states, event dispatch, modifier-key handling) is identical either way.
**Evidence:** `98_vision_loop.md:452-482` (verbatim `f3t` class).
**Tier:** important

### 12. Captcha OCR: crop-aware, tight prompt, tiny token budget, no third-party solver (CORE)
**What:** `captcha.readText()` screenshots (or DPR-aware Photon-crops) the captcha region, resizes via the same `L3` pipeline, then calls the `visual` category model with system prompt `"Read the distorted/styled text in this image from left to right. Respond with ONLY the characters in order. No quotes, no explanation."` and `maxTokens:64`. Image-**grid** captchas ("select all buses") instead reuse `annotatedScreenshot()` + the session model (path 1), not this OCR path. There is confirmed **zero** third-party captcha solver integration (no 2Captcha/anti-captcha/CapMonster strings) — the "solver" is purely a model doing OCR plus synthetic mouse events.
**Why:** Demonstrates that captchas don't need a specialized solving service; a well-scoped, cheap vision sub-call handles text/number captchas, while grid-selection captchas are just another `annotatedScreenshot` targeting problem.
**How to implement:** Branch captcha handling by type: text/character captchas → crop region, tight OCR-only system prompt, small `maxTokens`, cheap visual-category model; grid/image-selection captchas → route through the normal annotated-overlay + session-model click flow, since it's fundamentally a "pick the right ref(s)" task, not OCR.
**Evidence:** `98_vision_loop.md:485-549` (verbatim `readText`/`#r`, `#n` DPR-aware crop; correction note re: Part 89's earlier mis-citation).
**Tier:** core

### 13. Empirical measurement discipline — grep trajectories for the ground truth, don't assume (nice)
**What:** The teardown doesn't just assert "text-first" — it greps 300 real Mind2Web trajectories for every vision primitive and reports hard numbers: 89.3% zero-vision, 10.7% any vision, 5.7% non-captcha vision, snapshot():screenshot() call ratio ~30:1. It further hand-inspects all 17 non-captcha-vision task prompts and buckets them into exactly two categories (task-mandated visual output, canvas/interactive-widget manipulation) — finding **zero** cases of "vision used to read text the tree already had."
**Why:** This is the methodological pattern worth copying for building/tuning the ultimate CLI: instrument the agent to log every screenshot/display/OCR call per task, then periodically audit real transcripts to see whether vision is being used appropriately or as a crutch, rather than trusting a system prompt's stated policy.
**How to implement:** Log a per-task counter of {snapshot calls, screenshot calls, display calls, images actually rendered, OCR calls} and periodically compute ratios like Aside's; if the "vision touches a non-captcha, non-canvas task" rate creeps up, that's a signal the ref/snapshot targeting logic has regressed (missing refs, stale DOM), not that the task genuinely needed pixels.
**Evidence:** `98_vision_loop.md:600-677` (§8, full table + trajectory quotes).
**Tier:** nice

### 14. Skill frontmatter schema — exactly three injection controls, no priority field (CORE)
**What:** Every skill is `--- YAML frontmatter --- \n markdown body`, validated by a Zod-like schema with fields `name`, `description`, `icon?`, `disabled` (default false), `library?` (relative `./x.js` path), `siteSpecific` (default false), `autoInject: {keywords?: string[], url?: string[]}`. That's it — no priority number, no explicit `match` regex, no `autoInject:true` boolean. Injection is entirely derived from `siteSpecific` + `keywords`/`url` glob lists.
**Why:** A minimal, declarative schema keeps skill authoring simple (a user or the agent itself can author one from a conversation) while still supporting precise per-site targeting via URL globs.
**How to implement:** Model a "site skill" / actionbook file as YAML frontmatter (`name`, `description`, `autoInject.keywords[]`, `autoInject.url[]` host+path glob strings, `siteSpecific` bool, optional `library` path to an attachable script) + markdown body. Resist adding a manual priority/weight field — derive ranking algorithmically instead (pattern 15).
**Evidence:** `99_skills_engine.md:14-39` (verbatim `vat` schema, strings offset L266523).
**Tier:** core

### 15. URL matcher: host+path glob with a specificity score, not first-match (CORE)
**What:** `hat(url, skill)` splits each `autoInject.url` pattern at the first `/` into a host-glob and a path-glob (default `/**`); both must match the live URL (case-insensitive minimatch) for the pattern to count. Score = `100*(host non-wildcard char count) + 10*(path non-wildcard char count) - (total wildcard count)`. The max score across all patterns on a skill wins; skills are then ranked by score, ties broken by name. Keyword matching (`gat`) is a fallback: match keyword as whole word (regex word-boundary) against the URL href, scored by keyword length.
**Why:** This is the "site skill cache" resolution algorithm worth copying verbatim — it correctly disambiguates overlapping patterns, e.g. on `docs.google.com/forms/...` both `google-docs` (`docs.google.com/document/**`) and `google-forms` (`docs.google.com/forms/**`) are host-matched but only forms path-matches; and Jira's three path-scoped globs (`/jira/**`,`/browse/**`,`/issues/**`) avoid colliding with `confluence`'s `*.atlassian.net/wiki/**` at the same bare host.
**How to implement:** Implement pattern matching as `{hostGlob, pathGlob}` pairs using a minimatch-style glob library (case-insensitive), score `100*len(hostGlob.replace(/\*/g,'')) + 10*len(pathGlob.replace(/\*/g,'')) - totalWildcardCount`, take max across all patterns on the skill, sort candidates descending by score. For message-based matching (no URL yet, or user typed a plain question), separately match skill name/keywords as whole words against the message text, AND extract any `https?://...` URLs embedded in the message and run them through the same URL matcher.
**Evidence:** `99_skills_engine.md:41-142` (verbatim `hat`/`gat`/`IM.resolve`/`IM.resolveForMessage`, strings offset L266523).
**Tier:** core

### 16. Two delivery channels: always-on name+description list vs. URL-gated auto-inject (CORE)
**What:** Non-`siteSpecific` skills go into an always-on `<skills_instructions>` prompt block containing ONLY `name: description (path: ...)` for each skill — the model must `read_file` the SKILL.md body itself (progressive disclosure). `siteSpecific` skills are excluded entirely from that list and only surface when the active-tab URL or user message matches, at which point they enter as (a) a `buildSignal(url)` page signal (a sha1-keyed set of matched skill names) and (b) if the skill has a `library`, its JS globals get attached to the REPL.
**Why:** Prevents the always-on prompt from bloating with 16+ site-specific cheat sheets that are irrelevant 95% of the time, while still guaranteeing the *exact right* playbook is available the moment it becomes relevant — without the model needing to search or guess.
**How to implement:** Split any "skill library" / actionbook store into two tiers: (1) small, universally-relevant skills always listed by name+one-line description+path in the system prompt (model self-serves the body via a file-read tool); (2) larger number of site-specific playbooks, hidden from that list, injected as a lightweight "here's what matched" signal only when the current URL or user message triggers them.
**Evidence:** `99_skills_engine.md:143-186` (verbatim `<skills_instructions>` builder, strings offset L269539-269556).
**Tier:** core

### 17. Attach/detach loop on URL change — skills as REPL-scoped, not global, capabilities (CORE)
**What:** After every tool execution / navigation, a sync step (`#v`) resolves the current tab URL against the skill matcher, diffs the resulting site-specific-skills-with-a-library set against the currently-attached set, calls `cleanup()` on any that no longer match and detaches them, and attaches (runs an installer function against) any newly-matched libraries. Idempotent — an already-attached library is skipped. Also exposed to the agent directly as a `reloadSkillLibraries()` call.
**Why:** Prevents leaking one site's helper globals/state into an unrelated page after the agent navigates away — capabilities are automatically scoped to "am I currently on a page this skill applies to," not manually managed.
**How to implement:** After every navigation/tool-call, recompute the matched-skill set for the current URL; for skills previously attached but no longer matching, call their teardown hook; for newly matching skills with attach hooks, call an install function that both mutates the execution environment (adds helper globals/functions) and returns an optional cleanup callback. Store attachment state keyed by a stable identity (e.g. skill+library path) so re-attach is a no-op if already active.
**Evidence:** `99_skills_engine.md:191-244` (verbatim `#v` and installer contract, strings offset L271807-271817).
**Tier:** core

### 18. Sandboxed library runtime — locked-down VM, no `require`, path-jailed bundle (important)
**What:** Skill JS bundles run in `node:vm` inside the same isolated context as the REPL. The loader requires the bundle to evaluate to a function (`__asideSkillBundle(exports, require, module, __filename, __dirname)`, the shape esbuild/webpack CJS wrappers produce), synthesizes a minimal CJS shim where `require` **always throws** (`Skill libraries can't require additional modules at runtime.`), and the installer must be the default export (a function receiving REPL state, optionally returning a cleanup fn). A separate path-jail (`fat`) enforces that a skill's declared `library:` path must start with `./`, end in `.js`, and resolve inside the skill's own directory — never escape it.
**Why:** Lets user/third-party-authored skills extend the agent's capabilities (new REPL globals) without giving them filesystem/network/module-loading access beyond what's explicitly bundled — a real security boundary for "install a skill" as a first-class action.
**How to implement:** If supporting user-authored capability plugins for a browser-agent CLI: run them in a restricted sandbox (VM/isolate) with no ambient `require`/filesystem/network access; require them to export a single install function of the shape `(sharedState) => optionalCleanupFn`; validate any file paths they reference stay within their own package directory before ever reading them.
**Evidence:** `99_skills_engine.md:245-283` (verbatim `#y`, strings offset L271807-271817; `fat` sandboxing note L266523).
**Tier:** important

### 19. Skills as reverse-engineered site playbooks, not generic instructions (CORE)
**What:** The highest-value skills are pure markdown documenting a **native compiled-in API client**, not a generic "how to use this website" guide: `gmail` (direct HTTP against Gmail's internal sync API, multi-account `uid` handling), `slack` (extracts `xoxc-` token from localStorage, hands off to the real `@slack/web-api` SDK), `notion` (extracts `token_v2`, uses a packaged internal-API SDK), `x-twitter` (full GraphQL client, method names hiding internal query-ids), `linkedin` (423-line Voyager API playbook — the richest skill shipped, including a full bot-detection/throttling operations manual: per-action risk tiers, daily/weekly caps, backoff on 429/999/checkpoint, "slide & spike" account-age multipliers). Simpler site-specific skills (amazon, github, jira, google-calendar, ...) are 36-54 line cheat sheets of canonical URLs, keyboard shortcuts, and DOM-narrowing selectors, sometimes with a self-maintenance note ("if it's updated, please update this SKILL.md to reflect the new selector").
**Why:** This is the actual product value of a "skill" — not prompt engineering, but distilled reverse-engineering of a site's real API/auth mechanism so the agent can act via HTTP/SDK calls instead of clicking through a slow, brittle UI. It's also a durable pattern: rate-limit/anti-bot operating knowledge (the LinkedIn throttling table) belongs *in the skill*, not scattered through agent reasoning.
**How to implement:** For high-value target sites, invest in RE'ing the site's actual internal API (session cookie/token extraction, internal GraphQL/REST endpoints) and ship it as a skill exposing a typed client + concrete rate-limit/safe-defaults guidance, rather than only shipping DOM selector hints. For lower-value sites, a lightweight cheat-sheet skill (canonical URL patterns, keyboard shortcuts, narrowing selectors for `snapshot()`) is still worth it and much cheaper to produce/maintain.
**Evidence:** `99_skills_engine.md:287-517` (§3-4, all skills verbatim from disk).
**Tier:** core

### 20. Secret-blind credential API — never let the model see the secret (important, security)
**What:** The `password-manager` skill documents an API where the model can `listItems()` (metadata only — title, urls, category, username, never the secret value), `autofillItem(page, itemId)` (fills login/card/identity fields natively, including hosted iframes, without exposing values to the model), `generatePassword()` returns only an opaque `GeneratedPasswordRef` symbol (never plaintext), and `fillPassword(page, fieldRef, ref)` resolves it natively at fill time. `createItem` similarly resolves a `GeneratedPasswordRef` inside the credential manager, never surfacing plaintext to the LLM.
**Why:** A concrete, reusable pattern for any agent that needs to touch credentials/payment data: keep secret material entirely out of the model's context window by using opaque handles resolved by a trusted native layer, not by prompting the model to "not print the password."
**How to implement:** For any capability touching secrets (passwords, card numbers, API keys) design the tool contract so the LLM only ever sees metadata + opaque reference handles; perform the actual value-fill/substitution in a native/trusted code path that the LLM triggers but never reads through.
**Evidence:** `99_skills_engine.md:421-449` (verbatim `PasswordManagerApi` TS interface).
**Tier:** important

### 21. Content-addressed skill sync with self-healing (nice)
**What:** On boot, a `.bootstrap-manifest.json` (`{files: {relpath: sha256}}`, 414 entries) drives a diff-and-rewrite sync of builtin skills from the app bundle into each agent's local skills dir: only files whose hash differs (or is missing) get rewritten; files present in the old manifest but absent from the new set get deleted (with empty parent dirs pruned). Hand-editing a builtin skill file gets silently reverted on next boot.
**Why:** Anti-tamper + guaranteed-fresh distribution without re-copying unchanged files every boot; log line `[Skills] Synced +A ~M -D` gives an auditable diff.
**How to implement:** If shipping a bundled skill/playbook library to a local install, sync via content hash (only write files whose sha256 changed), delete orphaned files not in the current manifest, and log the add/update/delete counts for observability.
**Evidence:** `99_skills_engine.md:521-563` (verbatim `Eat`/`Tat`/`Sat`/`Cat`).
**Tier:** nice

### 22. Agent-authored skill creation with fuzzy dedup and update-vs-override logic (nice)
**What:** A `create_custom_skill` tool lets the agent mint a new skill from conversation, but first fuzzy-matches against existing skills (normalized-name/slug equal=100, keyword-set Jaccard≥0.70=85, name substring both≥8 chars=80, keyword/urlPattern overlap=75, description similarity≥0.65=70; threshold ≥70 to be a candidate). If the best match is a user skill → in-place `update`; if it's a builtin → `customize` (writes a user-owned override in a separate `user/` dir which outranks builtin by a simple priority: user=3>builtin=2>other=1); otherwise `create` new. Supplying `urlPatterns` auto-promotes the new skill to `siteSpecific:true`. The tool pauses for explicit user confirmation before writing.
**Why:** A robust "teach the agent a new site playbook from this conversation" flow needs dedup logic to avoid skill sprawl, and a builtin-override mechanism so users can customize shipped playbooks without losing future updates to the underlying builtin.
**How to implement:** If supporting agent/user-authored skills: run a lightweight fuzzy match (name equality, token-set similarity, keyword/URL-pattern overlap) against the existing library before creating; route to update/override/create accordingly; require human confirmation before persisting; auto-derive `siteSpecific` from whether URL patterns were supplied rather than requiring the author to flag it.
**Evidence:** `99_skills_engine.md:569-613` (verbatim `nrn`, `frn`/`drn` scoring, strings offset L271822-271831).
**Tier:** nice

---

## Command Surface (verbatim)

Vision / display tool signatures (from `98_vision_loop.md`):
```
page.screenshot(options?) => Promise<Buffer>
  # options: path, fullPage, clip:{x,y,width,height}, type ('png'|'jpeg'|'webp', default png),
  #          quality, timeout

locator.screenshot(options?) => Promise<Buffer>
  # options: path, type (default 'webp'), quality, timeout, margin (default 8)

annotatedScreenshot(page) => Promise<{ base64Image: string }>
  # PNG only, ref-labeled bounding boxes

display(input: string | Uint8Array | Buffer)
  # accepts raw base64, data URL, or image bytes; MIME-sniffed + auto-resized

cua.getVisibleScreenshot() => Promise<string>   # base64 PNG, raw viewport
cua.click({x,y,button?,keypress?})
cua.doubleClick({x,y,keypress?})
cua.drag({path:[{x,y}...], keys?})
cua.keypress({keys})
cua.move({x,y,keys?})
cua.scroll({x,y,scrollX,scrollY,keypress?})
cua.type({text})

captcha.readText(locator, bounds?)
  # crop-aware OCR, 'visual' model category, maxTokens:64
```

Resize/coordinate-note constants (from `98_vision_loop.md` §4):
```
maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80  (initial)
quality ladder: [85, 70, 55, 40]
scale ladder:   [1, 0.75, 0.5, 0.35, 0.25]  (floor 100px per axis)
filter: Lanczos3
MIME whitelist: image/jpeg, image/png, image/gif, image/webp  (sniff window: first 4100 bytes)
capture clip clamp: 16384 / devicePixelRatio  per axis
default screenshot timeout: 30000ms
default viewport: 1440x900 (min 960x540)

Coordinate note format:
"[Image: original {W}x{H}, displayed at {w}x{h}. Multiply coordinates by {ratio} to map to original image.]"
```

Model routing categories (from `98_vision_loop.md` §7):
```
categories: ['fast', 'standard', 'deep', 'visual']
resolveByCategory(category) -> throws "No visual model configured. Set one in Settings → AI Models."
                                 if category unset (no silent fallback)
```

Skill frontmatter schema (from `99_skills_engine.md` §1.1):
```yaml
---
name: string           # required
description: string    # required
icon: string            # optional
disabled: boolean        # default false
library: "./lib.js"      # optional, relative path, must stay inside skill dir
siteSpecific: boolean    # default false; true = hidden from always-on list, URL/keyword-gated only
autoInject:
  keywords: [string]     # matched word-boundary, case-insensitive, against URL href or message text
  url: ["host.glob/path/glob/**"]  # scheme omitted; splits at first "/" into host-glob + path-glob (default "/**")
---
<markdown body>
```

URL match score formula (from `99_skills_engine.md` §1.2):
```
score = 100 * (host-glob non-wildcard char count)
      + 10  * (path-glob non-wildcard char count)
      -       (total wildcard '*' count across both globs)
# max score across all url patterns on a skill; null if no pattern matches
# keyword score = length of the longest matched keyword; used as fallback when no url pattern set
# final skill score for a URL = url_score ?? keyword_score
```

Skill library install contract (from `99_skills_engine.md` §2.3):
```js
// bundle.js must evaluate (via node:vm) to:
function __asideSkillBundle(exports, require, module, __filename, __dirname) {
  // require() always throws inside this sandbox — no runtime deps, everything pre-bundled
  module.exports = function install(replState) {
    // mutate replState to add globals/helpers
    return function cleanup() { /* optional teardown, called on URL-unmatch or detach */ };
  };
}
```

`create_custom_skill` fuzzy-match scoring (from `99_skills_engine.md` §6.2):
```
100  normalized-name equal OR slug equal
 85  keyword-set Jaccard similarity >= 0.70
 80  both names >=8 chars and one includes the other
 75  any keyword overlap OR any urlPattern overlap
 70  description token-set similarity >= 0.65
  0  otherwise
# candidates kept if score >= 70; sorted desc, tie-break user-over-builtin then name
```

Captcha OCR system prompt (verbatim, from `98_vision_loop.md` §6):
```
"Read the distorted/styled text in this image from left to right.
Respond with ONLY the characters in order. No quotes, no explanation."
```
User-turn text: `"Read the text in this CAPTCHA image from left to right."` (a distinct message, not the system prompt — the earlier teardown had conflated them).

---

## Anti-patterns (what NOT to copy)

1. **Auto-injecting screenshots into every tool result.** Aside deliberately does NOT do this — capture and display are separate calls. Copying a design where every navigate/click automatically returns an image would recreate the "every-turn vision" cost problem this architecture explicitly avoids. (Evidence: `98_vision_loop.md:94-96`.)

2. **Treating vision-mode coordinate clicking as a primary interaction method.** `cua`/computer-use coordinate mode is explicitly gated behind a skill with a "when NOT to use" list and a "2-3 failures → switch strategy" rule. Building a browser agent CLI that defaults to screenshot+click-coordinates (the common naive approach) reproduces exactly the failure mode this system is designed to avoid — it's slow, expensive, and less reliable than ref-based targeting when refs are available. (Evidence: `98_vision_loop.md:412-482`.)

3. **No per-image token/cost accounting.** The daemon has zero local image-token tracking (confirmed absence of any `imageTokens`/`tokensPerImage` symbol) — cost control is entirely the resize-to-2000px/4.5MB step, with actual billing left to provider-reported totals. This is a real gap: an agent CLI wanting tighter cost governance should NOT copy this "resize is our only lever" approach without adding explicit per-image cost estimation/budgeting, especially for high vision-usage workloads. (Evidence: `98_vision_loop.md:591-596`.)

4. **Trajectory-observed `display()` fragility caused wasted retries.** In one benchmark trajectory the model repeatedly hit `invalid image input` errors trying `display(Buffer)` then `display(rawBase64)` before landing on the correct `data:image/...;base64,` prefix form — 132 total `display()` invocations across only 26 tasks that used it at all, i.e. real retry waste from an ambiguous/strict input contract. Don't copy an input parser that's this easy to get wrong from first principles; either accept more input shapes unambiguously or give a corrective error message with a working example inline. (Evidence: `98_vision_loop.md:664-671`.)

5. **Flat priority scheme for skill precedence (user=3 > builtin=2 > other=1) is a minimal hack, not a real ACL.** It works for Aside's 2-tier (user/builtin) model but doesn't generalize to a multi-tenant or multi-source skill marketplace (e.g. org-shared skills, third-party marketplace skills) without redesign. Don't copy the numeric constant scheme verbatim into a system with more than 2 provenance tiers — model provenance/trust as an explicit enum with defined merge rules instead.

6. **No priority/weight field on skills; ranking is entirely inferred from glob specificity.** This mostly works (the `100*host+10*path-wildcards` formula is genuinely clever) but breaks down for skills that want to say "prefer me over that other skill even at equal specificity" — there's no escape hatch besides name-based tie-breaking. Copy the specificity-scoring idea, but consider adding an optional low-weight priority override for edge cases before you hit this limitation in production.

---

## Notes on freshness

Per the source's own freshness note: the *mechanism* (matcher math, sandboxed library contract, resize pipeline, escalation ladder) is durable architecture and safe to copy structurally. The *specific numbers* (2000px/4.5MB budget, model names like gpt-5.5/claude-sonnet-5, LinkedIn's exact rate-limit figures, GraphQL query-ids) are volatile and were captured from a specific daemon build (1.26.702.2347, 2026-07) — treat as a reference point for the *shape* of good numbers, not literal values to hardcode without re-verification.
