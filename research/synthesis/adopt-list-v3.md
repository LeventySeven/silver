# Silver ADOPT-LIST v3 — the next keyless capability backlog + roadmap

**What this is.** The next prioritized, file-mapped backlog of concrete Silver changes, mined from the
deepdive3 wide per-source pass (`agent-design-patterns`, `all-aside`, `all-browseruse`, `all-stagehand`,
`all-vercel`, `all-webwright`, `all-agentql-perplexity-bb`, `failure-modes`, `sota-2026-a/b`,
`use-cases-wide`). Every item is **new relative to v2** (`adopt-list-v2.md`) — where an item strengthens a
v2 line it says so and does not re-list the v2 work. Every item is **keyless** (Silver never calls a model;
the host LLM supplies all judgement) and mapped to a Silver file. Priority = P0 (now) … P3 (optional);
Effort = S/M/L. Grouped by theme.

**The v3 thesis in one line.** v2 closed the *latency/token/perception-encoding* gaps. v3 is about the
next tier: **auth reality** (real-Chrome-profile, TOTP, cookie-fetch), **trust-as-a-primitive**
(`expect`/`--verify`, dialog/CAPTCHA detection, taint-flow guard), **reusable durable tasks** (run
manifest + variable detection + verb-sequence cache), and **operator ergonomics** (config files, structured
doctor, `read`, `inspect`). These are the capabilities that turn Silver from "fast, safe snapshot engine"
into "the browser a host can run unattended on real logged-in sites without getting the user banned or
phished."

---

## 1. Engine / launch / connection

### E1. `silver read <url>` — browser-free static fetch with llms.txt discovery — **P0, M**
Vercel's `read.rs` (~1050L) is a pure HTTP client: `Accept: text/markdown` negotiation, same-origin `.md`
sibling fallback, nearest-ancestor `llms.txt`/`llms-full.txt` walk, `--outline`/`--filter <heading>`/`--llms
index|full`/`--require-md`. Silver has zero equivalent — every docs/API-reference lookup opens full Chromium.
- **Change:** new `perception/read.ts` + `read` verb (`handlers.ts`/`flags.ts`), reusing `egress.ts` for the
  target and wrapping output in the `⟦untrusted⟧` fence. **Keyless:** pure HTTP + markdown-heading regex.
- Source: `all-vercel #1`. Highest token/latency ROI in the sweep; a differentiator no source has.

### E2. Real-Chrome-profile detection + launch (`--use-chrome-profile <name>`) — **P1, M**
The single biggest practical unblock for logged-in tasks: point Silver at the user's *actual* Chrome profile
(with its existing session cookies) instead of a fresh automation profile — the truest keyless answer to
auth, no credential ever enters Silver. browser-use's `chrome.py` enumerates profiles cross-OS by reading
`Local State`/`Preferences` JSON; webwright auto-launches Chrome on :9222 with a dedicated profile.
- **Change:** `core/session.ts` launch branch — scan platform profile dirs, read display names, launch with
  `--user-data-dir` + `--profile-directory`. **Keyless:** filesystem probing only.
- Source: `all-browseruse #10`, `all-webwright N`.

### E3. Config file system: `~/.silver/config.json` + project `silver.json` — **P1, M**
Silver has no file-based config — every invocation repeats every flag, a real drift source (one batch call
forgets `--allowed-domains`, silently unrestricted). Vercel's `flags.rs` merges user→project→env→CLI with
**list fields concatenated**, scalars overridden; webwright's `recursive_merge` + `UNSET` sentinel is the
same idea with explicit "decline to set." Drop-in compatible with existing Vercel config files.
- **Change:** `core/config.ts` (camelCase schema mirroring `ParsedFlags`), merge before `parseFlags`; bundle
  the `<field>Explicit` shadow-boolean (Vercel `cli_*`) from day one to avoid config-vs-CLI precedence bugs.
- **Keyless:** file read + JSON merge. Source: `all-vercel #14,#15`, `all-webwright A`.

### E4. HTTP/CDP resilience retry taxonomy (`core/retry.ts`) — **P1, S-M**
Silver's `errors.ts` has a `retryableByHost` boolean but **no internal retry** — a flaky 503 / connection
reset on `page.goto`, CDP attach, or extract-fetch surfaces as a hard failure the host must babysit.
Webwright's `base.py` walks the whole `__cause__` chain, classifies rate-limit (429) vs transient
(`{408,409,425,500,502,503,504}` + needles) and gives each its own bounded backoff.
- **Change:** `withRetries(fn,{rateLimit,transient})` wrapping the three internal call sites; **hard numeric
  cap** + surface `retries_exhausted` as a distinct code (SOTA-b §4 — never loop silently). **Keyless.**
- Source: `all-webwright C`, `sota-2026-b #4`.

### E5. `connect <port|url>` — persist CDP attach into the session — **P1, S**
`--cdp` is a per-command flag; a `connect` verb that writes the CDP target into the session sidecar once
(so later `--session` commands inherit it) removes real repeated-flag friction for "attach to my already-open
logged-in Chrome." Pairs with E2. **Change:** `connect` verb in `flags.ts`/`handlers.ts`. **Keyless.**
Source: `all-vercel #10`.

### E6. Cross-origin iframe accessibility via `Target.setAutoAttach` — **P1, M**
`walk.ts:173` silently skips cross-origin frames — the **exact unresolved bug** in vercel-labs/agent-browser
#925 that Silver forked its perception from. `Accessibility.getFullAXTree({frameId})` on the parent session
can't cross a security boundary. Result: Stripe Elements, OAuth-popup iframes, Shopify checkout widgets are
**invisible to Silver today**. Fix: `Target.setAutoAttach({flatten:true})` at session open, track
`targetId→sessionId`, route AX/DOM calls for OOPIFs to their own session.
- **Change:** `core/session.ts` + `perception/walk.ts` (`resolveChildFrameId`/`walkFrame` branch). **Keyless:**
  pure CDP. Source: `sota-2026-b #5a`. High-value target class (payment/auth iframes).

### E7. Standard proxy env-var inheritance + human-friendly durations — **P2/P3, S**
Fall proxy resolution through `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` after `SILVER_PROXY` (corporate
deploys "just work"); accept `10s`/`3m`/`1h` on duration flags via one shared `parseHumanDuration`. Also bypass
env proxy on localhost DevTools JSON probes (webwright N — a silent failure class). `flags.ts`. **Keyless.**
Source: `all-vercel #16,#17`, `all-webwright N`.

---

## 2. Perception / serializer

### P1. Fallback-name nodes with non-empty ARIA role + empty accessible name — **P1, S**
The measured **"ARIA paradox"**: pages *with* ARIA average more a11y errors than pages without — a
`<div role="button" aria-label="">` reads as ref-eligible-but-nameless. A 2026 study traced ~half of open-web
task failures to degraded a11y trees. Extend `walk.ts`'s cursor-interactive text fallback to fire on
non-empty-role + empty-name (not just `generic`), treating "confidently-wrong ARIA" like "missing ARIA."
- **Change:** `perception/walk.ts` (~10-20 lines). **Keyless:** DOM/AX inspection. Source: `sota-2026-b #1`.

### P2. Structure-aware markdown chunking (`perception/chunk.ts`) — **P1, M**
browser-use's `chunk_markdown_by_structure`: atomic-block parse (never split a code-fence or mid-table-row),
header-preferred split points (split at `## Section` when ≥50% budget filled), overlap prefix, and
**table-header carry-forward** across chunks so a continuation chunk still shows column names. Naive char
slicing mid-table/mid-fence produces garbage the host must mentally reconstruct.
- **Change:** new `perception/chunk.ts`, wired to whatever verb returns oversized extracted text, with a
  `--start-from-char`/chunk-index continuation. **Keyless:** pure string algorithm. Source: `all-browseruse #1`.

### P3. `[selected]`/`[checked]` inline state badges + distinct `input:file` role — **P2, S**
Stagehand appends boolean state straight onto the outline line (from AXNode props already read) so the host
doesn't double-toggle an already-checked box — a common silent-wrong-action. Also relabel `<input type=file>`
off Chrome's generic `role:"button"`. Narrower/cheaper complement to v2-C1 (which is `<select>`/date hints).
- **Change:** `perception/serialize.ts`, formatting only. **Keyless.** Source: `all-agentql-perplexity-bb #3`.

### P4. Set-of-marks overlay renderer for the vision-fallback screenshot (`perception/overlay.ts`) — **P2, M**
When the host falls back to a screenshot (canvas apps: Figma/Sheets/WebGL, unreachable by AX), ship a
*pre-annotated* image: draw numbered boxes at the bounding rects of the elements the walk **did** find, using
the same `eN` ref IDs the tree minted. Host sees "e12" on the picture → `click e12`, no coordinate math, and
the existing refmap/generation gate still guards it. Composes with B-series coordinate verbs.
- **Change:** new `perception/overlay.ts` (CDP `DOM.getBoxModel` + canvas compositing). **Keyless.**
  Source: `sota-2026-b #2`.

### P5. SPA JSON-blob stripping in markdown extraction — **P2, S**
LinkedIn/Facebook/React-Relay sites embed multi-KB hydration-state JSON as inline text nodes that dominate
token count with ~zero info value. browser-use's three-regex + parse-and-drop pass (`{"$type":...}`, fenced
JSON, any >100-char line that `JSON.parse`s) removes them. **Change:** post-filter after markdown conversion
in the extraction path. **Keyless.** Source: `all-browseruse #2`.

### P6. Scored node pruning with `--max-nodes` graceful degrade — **P2, M**
`walk.ts` today hard-stops at `SCAN_ELEMENT_LIMIT=10_000` (a bail-out, not a degrade). Prune4Web-style
per-node relevance score (role class + ancestor-of-interactive + text-density) lets a `--max-nodes` budget
rank (interactive > named-content > structural) and truncate the tail with a `# N more nodes omitted` marker.
- **Change:** `perception/serialize.ts`. **Keyless.** Source: `sota-2026-b #3a`. (P3 companion: pre-walk DOM
  noise strip `#3b`; TODO-only CI4A agent-interface probe `#3c`.)

---

## 3. Actuation

### AC1. `expect` / `assert` verb + `--verify` on mutating verbs — **P1, M — marquee reliability primitive**
The single highest-value keyless addition to Silver's *trustworthiness*: today the host must issue a separate
`snapshot`/`get` after every action to confirm the goal state ("did the thing I expected happen?"). Ship
verification-as-a-verb: `silver expect --text "Order confirmed"` / `expect @eN --state visible` /
`expect --url-matches` (thin wrapper over `wait.ts`'s existing selector/ref/text/url/fn specs), **and** a
`--verify <role>:<name>[:state]` flag on `click`/`fill`/`select` that resolves the target once more post-settle
and returns `{expected, observed, matched}` from data Silver already holds. Operationalizes v2-G4's
"re-verify selected state after a drawer closes" as *code, not prose the host forgets under context pressure*.
- **Change:** `actuation/actions.ts` (post-action) + `core/envelope.ts` + new `expect` handler over `wait.ts`.
  **Keyless:** Playwright waits + accessible-name/value reads. Source: `failure-modes #12`, `sota-2026-a #3`,
  `all-webwright L`.

### AC2. Screenshot pixel-diff with rendered diff image — **P1, S-M**
Vercel's `diff.rs::diff_screenshot`: per-pixel Euclidean RGB distance against a `--threshold`, structured
`dimension_mismatch` payload, and it **renders an actual diff PNG** (mismatched pixels red, matched dimmed) as
a usable artifact. Silver's `diff.ts` is a11y-tree diff only — the *visual*-regression half (design QA,
pre/post-deploy compare) is a named agent use case Silver can't do today.
- **Change:** `perception/screenshotDiff.ts` (`pngjs`), `diff --screenshot <a> <b> [--threshold][--out]`.
  **Keyless:** pixel math. Source: `all-vercel #13`.

### AC3. Coordinate→ref resolution (strengthens v2-B1) — **P1, S (folds into B1)**
v2-B1 adds blind `click --at x y`. Stagehand's `coordinateResolver.js` makes it non-blind: CDP
`DOM.getNodeForLocation` at the point → walk up through nested iframes to a real node identity, *without a full
snapshot* (keeps B1's latency win) — populate the response `ref`/`role`/`name` instead of leaving them null.
- **Change:** in the same `actuation/actions.ts` B1 work. **Keyless.** Source: `all-agentql-perplexity-bb #4`.

### AC4. CAPTCHA-solving primitives: `dragPath` + `region-screenshot` — **HIGH/P1, S-M**
Aside solves sliders/checkboxes with **zero third-party solver** — CDP input events + the agent's own vision.
Silver has atomic `dragTo` and full-page screenshot but not the two primitives shaped for this: `dragPath(from,
to,{steps})` (interpolated multi-step mouse drag for slider puzzles) and `region-screenshot --clip x,y,w,h`
(returns base64 for the host to OCR — Silver never reads). Same division of labor as everything else.
- **Change:** `actuation/actions.ts` + `capture.ts`. **Keyless:** Silver supplies mechanics, host supplies
  vision. Source: `all-aside #7`. (Pairs with the *detection* side, R2 below.)

### AC5. `highlight <selector>` visual debug overlay — **P2, S**
`silver highlight <sel> && silver screenshot` gives visual ground truth for the grounding-mismatch failure
mode Silver's own docs flag as hard — box the resolved node (CDP `Overlay.highlightNode` or injected outline),
auto-clear after N ms. **Change:** `actuation/highlight.ts`. **Keyless.** Source: `all-vercel #7`.

### AC6. `act --batch <json>` — validated multi-action in one call — **P2, S-M**
External benchmark: batched independent actions cut tool-call count 74% / wall-clock 57% on form-filling.
Validate *every* sub-action against the same generation before executing any, abort the whole batch on first
`stale_refs` (respects v2's staleness invariant + E4's cap). Verify `task` doesn't already cover this.
- **Change:** `actuation/actions.ts`. **Keyless.** Source: `sota-2026-b #6`.

### AC7. `trace`/`profiler` perf capture, `record restart`, DeepLocator `>>` selector, `tap`/`swipe`, clipboard `copy/paste` — **P2/P3, S each**
Grab-bag of small keyless verbs from Vercel/Stagehand: Chromium `Tracing.start` flame-chart capture for
perf-regression agents (`actuation/tracing.ts`); mid-run `record restart` for per-checkpoint video segments;
`>>`-hop / iframe-aware-XPath selector syntax for cache-recipe direct targeting (`actuation/resolve.ts`);
real `Input.dispatchTouchEvent` `tap`/`swipe` for mobile-emulation UIs; `Input`-key-event `copy`/`paste` for
sites that block the `navigator.clipboard` JS API but not real key events. **Keyless.** Sources:
`all-vercel #5,#6,#8,#9`, `all-stagehand #8`.

---

## 4. Reliability / failure-mode detectors

*(All emit a typed error/flag the host reads; Silver never blocks silently. Each should land as a frozen
regression fixture — "no eval = the #1 cause of failed AI products.")*

### R1. Native-dialog auto-handler (`page.on('dialog')`) — **P1, S — fixes a silent hang**
No dialog handler exists in `src/`. A site `window.confirm()`/`alert()`/`beforeunload` mid-`click` **hangs the
command** until the 60 s lock budget or Playwright timeout, losing the dialog text. browser-use's
`popups_watchdog` gives the exact recipe: type-specific policy (accept alert/confirm/beforeunload, dismiss
prompt), a 3-tier session fallback chain, and capture the message into the next state.
- **Change:** register handler at connect (`core/session.ts`), record message into sidecar → surface
  `[dialog] "<msg>"` (neutralized) on next snapshot. **Keyless.** Source: `failure-modes #7`, `all-browseruse #9`.

### R2. CAPTCHA detection advisory flag — **P1, S — a dead error code today**
`captcha_detected` is *defined but emitted nowhere* (grep-confirmed) — a visible reliability hole. Without
detection a CAPTCHA becomes an infinite retry loop that burns the human's trust. Deterministic detect: iframe
`src` matching `recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha`, or a role named "I'm not a robot" → emit
the advisory flag so the host stops and escalates (detect + surface, never solve — pairs with AC4's primitives).
- **Change:** snapshot path. **Keyless:** substring match. Source: `failure-modes #10`.

### R3. `auth_required` login-wall detection — **P2, S — the other dead error code**
`auth_required` is also defined-but-never-emitted, though the recovery path (`state load`/`cookies set`) exists.
Heuristic: password-field present + URL/title matching `login|signin|sso|auth` + requested content absent →
advisory flag. **Change:** snapshot/nav path. **Keyless.** Source: `failure-modes #9`.

### R4. Bump generation on `page_changed` act — **P1, S**
The residual silent-misclick window: generation only bumps on `snapshot`, so a mutating `act` that changes the
DOM leaves same-generation refs nominally valid but physically stale. On `act` with `page_changed:true`, bump
`map.generation` so the *next* stale ref hard-fails. **Change:** `actuation/pagechange.ts` + session sidecar.
**Keyless:** fingerprint string-equality. Source: `failure-modes #1`.

### R5. Empty-DOM `page_empty` flag + repetition/stagnation detector — **P2, S each**
(a) After `open`/`goto`, if `domNodeCount < N` or the tree is empty, emit `page_empty` (anti-bot blank shells,
429 interstitials). (b) Extend the sidecar with a ring of last-K `(verb,ref,fingerprint)` tuples; on ≥K repeats
with unchanged fingerprint stamp `repetition_detected` (advisory, never block — parity with browser-use's soft
nudge). Turns Silver's stateless design into a reliability asset. **Change:** `core/session.ts` sidecar +
`pagechange.ts`. **Keyless:** node-count + SHA-256 counter. Source: `failure-modes #5,#6`.

### R6. Crash/CDP-drop → `page_crash` + one-shot reconnect; net::ERR_* → `navigation_failed` — **P2/P3, S**
Map `browser has been closed`/`websocket closed`/`Target closed` to `page_crash` (retryable) with a single
reconnect attempt before failing; map Chromium `net::ERR_NAME_NOT_RESOLVED`/`ERR_CONNECTION_REFUSED` to a
`navigation_failed` code *distinct from* policy `navigation_blocked` (so the host doesn't confuse "site down,
back off" with "policy forbids, never retry"). **Change:** `core/session.ts`, `errors.ts`. **Keyless.**
Source: `failure-modes #14,#15`.

### R7. LifecycleWatcher loader-id / follow-up-navigation tracking — **P2, M (bundle with v2-C2)**
A click that triggers a client-side redirect (meta-refresh, `location.replace`, SSO bounce) can settle Silver's
wait against the *wrong* intermediate page. Track the main-frame `Page.frameNavigated` loader-id sequence and
restart the idle-wait if a new navigation supersedes the one being waited on — fold into v2-C2's network-quiet
gate rather than shipping a naive single-shot wait. Also audit that click-induced redirects surface
`pageChanged:true`+new URL explicitly (SOTA-a §7). **Change:** `actuation/wait.ts`/`pagechange.ts`. **Keyless.**
Source: `all-stagehand #10`, `sota-2026-a #7`.

### R8. Downloads / http_status / cross-origin-frame variant — **P3, S each**
`page.on('download')` → contained path in the envelope; capture main-response `http_status` on nav (429/403 +
blank → `page_empty`); add `element_cross_origin_frame` so an OOPIF-unreachable ref is distinct from "gone."
**Keyless.** Source: `failure-modes #8,#11,#2`. *(Note v2-E4 already scopes download detection — de-dupe there.)*

---

## 5. Extract / document handling

### X1. CSV auto-repair on write + IDF-ranked PDF page selection — **P2, S / P2-P1**
browser-use's `CsvFile._normalize_csv`: re-parse/re-serialize every CSV write to fix the LLM-through-JSON-tool
double-escape (`\n`/`\"`) that silently produces a one-line garbled CSV. `read_file_structured`: for oversized
PDFs, IDF-score pages (words on fewer pages score higher) and pack the most *distinctive* content into budget
rather than truncating from page 1 — the principled sibling of P2 chunking. **Change:** wherever Silver writes
CSV / reads PDF. **Keyless.** Source: `all-browseruse #5`.

### X2. Cite-by-snippet-id extract guidance — **P3, doc**
One SKILL sentence: when answering from `extract`'s ID-grounded rows, cite the specific row id, not "the page"
— keeps host claims auditable against Silver's grounding guarantee instead of discarding it at the last step.
Source: `all-agentql-perplexity-bb #14`.

*(v2-D1 cache and v2-I1 zero-schema extract stand; strengthen D1 with §7 ActCache URL-param-sort and the §2
verb-sequence cache below.)*

---

## 6. Tasks — durability, reuse, replay

### T1. Reusable-variable auto-detection (`memory/variableDetect.ts`) — **P1, M — makes memory general-purpose**
The missing piece that turns a raw action trace into a *parameterized macro* with **no model call**.
browser-use's `variable_detector` walks a completed run and, per typed value, (1) inspects the DOM element
actually interacted with (`type=email`→email, id/name/placeholder/aria-label keyword table for
name/address/phone/date/…) then (2) falls back to value-shape regex. Detected values become `{{email}}`,
`{{shipping_address}}` slots the host overrides per run via `--var name=value`. This is what makes a saved
Silver task reusable with different data instead of a fixed script.
- **Change:** new `memory/variableDetect.ts`, run on task save; annotate the task JSON with slots. **Keyless:**
  pure regex/DOM-attr heuristics. Source: `all-browseruse #3`.

### T2. Run manifest for deterministic replay (strengthens v2-F1) — **P0, S**
v2-F1 (`task compile → replay script`) is non-deterministic without capturing the resolved run params. Write
`run_<n>/run_manifest.json` (engine, viewport, egress allowlist, timeouts, namespace) at `startRun`; replay
reads it back. Add a `bash -n` syntax gate before writing any emitted shell artifact (webwright E — refuse on
failure). **Change:** `task/store.ts`, `task/index.ts`. **Keyless.** Source: `all-webwright B,E`.

### T3. Verb-sequence DOM-hash replay cache (extends v2-D1+F1) — **P1, M — biggest ETL throughput win**
Skyvern's "code caching": on replay of a recorded action_log against the same normalized URL + **DOM-hash**,
skip straight to dispatching verbs (no re-snapshot, no re-resolve) unless the hash differs, else fall back and
rewrite the entry. Eliminates the *entire host round-trip* on cache hit, not just an LLM call. The DOM-hash
(over the flat interactive-node list, already computed for diffing) is the only new primitive.
- **Change:** `task/store.ts` + `perception/refmap.ts` generation gate. **Keyless.** Source: `sota-2026-a #2`.

### T4. Log hygiene: strip base64 on persist, screenshot dedup/externalize, error sink, truncation marker — **P1/P2, S each**
(a) `task/store.ts appendLog` must replace any base64 image/data-URL with `<omitted:base64 N bytes>` before
writing — one screenshot in a log bloats the run folder by MB (webwright H, **P1**). (b) Externalize task
screenshots to `screenshots/<seq>.png` referenced by path (reuse `assertContainedPath`), with an opt-in
MSE-then-SSIM near-duplicate dedup pass (~20 lines pixel math, no `sharp`) — Stagehand `evidence.js`
(agentql-bb #6, **P2**). (c) Sibling `runtime_errors.jsonl` with 4KB-capped bodies (webwright D, **P2**).
(d) For `task exec` stdout, bounded-with-`[N chars omitted]`-marker truncation (distinct from the snapshot
never-truncate contract) (webwright G, **P2**). **Keyless.** Sources: `all-webwright D,G,H`, `all-agentql-perplexity-bb #6`.

### T5. Subprocess env hygiene for `task exec` — **P1, S — prevents a whole class of hangs**
Any child that paginates (git/man/less) or draws a progress bar blocks the capture or spams `\r`. Merge a fixed
`{PAGER:'cat', MANPAGER:'cat', LESS:'-R', PIP_PROGRESS_BAR:'off', TQDM_DISABLE:'1', CI:'1', NO_COLOR:'1'}` +
a workspace-scoped `TMPDIR` into the child env. **Change:** `task/index.ts` exec dispatch. **Keyless.**
Source: `all-webwright F`.

### T6. `--echo-plan` anti-drift + status enrichments — **P1/P2, S**
(a) Opt-in `--echo-plan` appends the current `plan.md` checklist (open items first) + original goal to each
`task exec` envelope — keeps the goal fresh on long loops where context rots (webwright J, **P1**). (b) `task
status` adds `recentFiles` (mtime-sorted top-N), a truncated artifact preview, and keyless byte accounting
(`cumulativeBytes`/`lastCommandBytes`/`snapshotCount` from action_log — a keyless analog of a token meter)
(webwright K,I, **P2**). (c) Fail-safe compaction: frame the host summary with unmistakable markers, keep the
prior baseline if compaction errors (webwright P, **P2**). **Change:** `task/index.ts`, `task/store.ts`.
**Keyless.** Source: `all-webwright I,J,K,P`.

### T7. Local recipe catalog keyed by hostname (`silver recipe find <domain>`) — **HIGH differentiation, M**
Stagehand's Browse.sh is a shared registry of per-site automation recipes ("look up a known-working strategy
before automating from scratch"). Silver already owns the storage (`task/store.ts`, `memory/store.ts`) — the
missing piece is a **cross-run, keyed-by-site index**: index past successful runs by `hostname`, expose the
last N successful ref/selector sequences for a domain as a purely local on-disk cache (no network catalog for
v1). Converts repeat-site automation from O(exploration) to O(lookup). Bake in Stagehand `AgentCache`'s
`SENSITIVE_CONFIG_KEYS` redaction + defensive-clone-before-write so a recipe file never leaks a credential.
- **Change:** `silver recipe` namespace + `domain→[taskIds]` index. **Keyless.** Source: `all-stagehand #5,#9`.

### T8. `task report <id>` — self-contained HTML run digest + artifact retrieval — **P3, S-M**
Render `plan.md` + `action_log.jsonl` + screenshots to one self-contained HTML page (an Artifact) for long-run
debugging; extend the run manifest with `artifacts:[{id,filename,path}]` + `task artifact get <task> <id>` so a
downloaded PDF/screenshot is retrievable by id, not just on-disk path. **Keyless.** Source: `all-webwright R`,
`all-agentql-perplexity-bb #11`.

---

## 7. Orchestration / multi-agent

### O1. Subagent result-file handoff (`--result-file`) — **P1, S — a real gap vs Silver's own code**
`subagent done <id> --text` caps the result at `MAX_PROMPT` via `capOutput()` — a long subagent output is
**silently truncated**. Perplexity's orchestrator writes the full result to a shared file and returns only
`{task_id, result_path, status}`; the parent reads it *only if needed*. Add `--result-file <path>` (or make it
the default when `--text` exceeds `MAX_PROMPT`): move the file into `.silver/subagents/`, record `resultPath` in
`SubRecord`, surface it from `list`/`wait`. **Change:** `orchestration/subagent.ts`. **Keyless.**
Source: `all-agentql-perplexity-bb #7`.

### O2. Subagent shared-target caveat + typed id namespace — **P1 doc / P2, S**
(a) **Doc (P1):** own-context-per-child prevents Silver *state* corruption; it does **not** prevent two children
racing to mutate the SAME external page/account — sequence writes to a shared target, parallelize only
independent reads (the Cognition + Anthropic convergence). One-line caveat in the Subagents SKILL section.
(b) **P2:** adopt the Comet `{type}:{index}` id convention (`tab:2`, `row:7`, `mem:14`) as a cosmetic labeling
layer across `tabs`/`extract`/`memory` output so a host can pass `attached_ids:["tab:2","row:7"]` into
`subagent spawn --context` without re-serializing content (pairs with O1). **Keyless.** Source:
`agent-design-patterns #3`, `all-agentql-perplexity-bb #8`.

### O3. Parallelize/don't-parallelize litmus in the SKILL — **P2, doc**
Port Comet's crisp worked pair verbatim (Silver verbs substituted): *"add iPhone, iPad, MacBook to cart → three
parallel tasks; fill billing form then submit → single task."* Sequential-dependent steps combine; only
independent actions split. Source: `all-agentql-perplexity-bb #13`.

---

## 8. Security (all keyless; several close real threat-model gaps)

### S1. CaMeL-lite taint-flow guard on mutating-verb args — **P1, S-M — novel, this round's top security item**
DeepMind's CaMeL near-eliminates prompt injection on AgentDojo with a **non-model** data-provenance mechanism:
untrusted-origin data can't reach a sensitive tool call without an explicit grant, regardless of what the string
*says*. Silver already has the natural taint boundary — anything from `snapshot`/`extract`/`get`/`read` is
untrusted page content, already wrapped in the `⟦page-content untrusted⟧` fence on the read side. Add the
**data-flow half**: tag `origin:"page"` on extracted values in the envelope, and an opt-in
`--no-untrusted-args` guard where mutating verbs reject an argument that still carries the fence marker
(host echoed untrusted page content verbatim into `fill --value`/a URL) — return a structured "argument appears
to be untrusted page content, confirm or reformulate" error. One guard check + one marker convention, reusing
the fence Silver already emits.
- **Change:** `security/injection.ts` + `actuation/actions.ts` (mutating-verb dispatch) + `core/envelope.ts`.
  **Keyless:** string-marker + regex. Source: `sota-2026-a #6`.

### S2. CDP `Fetch`-layer egress enforcement — **P1, M — closes an exfiltration hole**
`security/egress.ts` guards *navigation* only (grep-confirmed: called from `page.goto`/redirect hops, never a
subresource interceptor). So a page on an allowed domain can still exfiltrate via `<img src>`/`fetch()`/beacon
to a disallowed host — invisible to Silver's own egress guard, directly contradicting its stated exfil threat
model. Wire `--allowed-domains` to `Fetch.enable` (or `Network.setBlockedURLs` for a pure blocklist) at session
start, continue/fail per the same suffix-match logic, reusing Stagehand `domainPolicy.ts`'s pattern generation
(pure function, portable verbatim).
- **Change:** `security/egress.ts` + `core/session.ts`. **Keyless:** CDP + existing match logic.
  Source: `all-stagehand #7`.

### S3. Filename sanitization chokepoint (`resolveFilename()`) — **P1, S**
Any verb taking an LLM-suppliable path (`extract --out`, saved-task names, screenshot/pdf paths) is exposed to
`../../secrets.json` traversal from injected page content or a malformed host command. browser-use routes every
file op through basename-first → regex-validate → one-shot-sanitize-with-fallback (helpful "auto-corrected X→Y"
message, never touches disk unsanitized). Route Silver's disk-writing paths through one `resolveFilename()`
chokepoint, mirroring the `redactValue`/`groundRef` single-choke pattern. **Change:** new module + audit.
**Keyless.** Source: `all-browseruse #4`, `all-stagehand #11`.

### S4. `confirm`/`deny` decoupled two-phase gate — **P0, S-M — fixes fail-closed feature-death**
Silver's confirm gate fails closed on non-TTY unless the action was pre-listed in `--confirm-actions` — so
confirmable actions are effectively *impossible* in Silver's actual deployment shape (fresh process per verb, no
blocking stdin between turns). Vercel returns a `confirmationId` (pending, not executed); the host issues a
*separate* `silver confirm <id>`/`deny <id>` to resolve it after inspecting the pending action. Persist pending
actions (verb+args+target) keyed by id with a TTL in the session sidecar.
- **Change:** `handlers.ts` mutating path + `confirm`/`deny` verbs. **Keyless.** Source: `all-vercel #2`.

### S5. `--action-policy <file.json>` with a real deny concept — **P1, S**
`confirmActions` is CSV-only and additive — Silver has **no hard deny** ("never allow `download` regardless of
confirmation"). Vercel's `ActionPolicy` JSON (`default`/`allow`/`deny`/`confirm`, precedence deny>confirm>allow>
default, hot-reloadable) fixes this and is the right shape for a repo-checked-in fleet policy. Same JSON schema
= drop-in for existing Vercel policy files. **Change:** `security/policy.ts`, wired ahead of the confirm gate.
**Keyless.** Source: `all-vercel #3`.

### S6. Verbatim amount-extraction regex (strengthens v2-E2) + PII/card value-gate — **P1/P2, S**
(a) Aside's `amount_pattern` + 24-label `keyword_pattern` are now extracted **verbatim** — drop them into
`security/confirm.ts` as `extractCheckoutAmount(text)`, run against snapshot text before a paid/destructive verb,
surface the matched dollar figure in the confirm preview (turns v2-E2 from "port the regex" into paste-and-wire).
(b) Extend the trigger set with value-inspection: Luhn-checkable 13-19-digit card-shape + SSN-shape regex on the
*value* being submitted (not just verb name), confirm-gated never blocking (Fara-7B's broader critical-point set).
**Change:** `security/confirm.ts` + `registry.ts`. **Keyless.** Source: `all-aside #9`, `sota-2026-a #5`.

### S7. Secret-blind fill (`fill --secret-env <VAR>`) — **P1, S**
Complements v2-E1's `<secret>` write-path: read the value from an env var / OS keychain **server-side** and fill
the resolved locator directly, returning only `{filled:true, length:N}` — the value never appears in stdout,
logs, or the host's tool result. No vault needed (reuse `state-crypto.ts` patterns). **Change:**
`actuation/actions.ts`. **Keyless:** IPC/env-var. Source: `all-aside #3`.

### S8. Unconditional baseline navigation denylist + per-site rate-limiter — **P2, S-M**
(a) Ship a bundled `blocklist.json` (credential-management hosts: `accounts.google.com`, `myaccount.google.com`,
`passwords.google.com`, `*.okta.com/login`, password-reset paths) enforced in `egress.ts` **unconditionally**
(not behind `--allowed-domains`) so it binds regardless of which verb drives nav — Aside's harder second gate.
(b) `security/ratelimit.ts` — per-`(verb,hostname)` sliding-window counter persisted in the namespace dir,
policy-file-driven, soft-block (`rate_limited` field) before actor verbs on matched domains. The single most
concrete "don't get the user's account banned" mechanism in the whole corpus; nothing in Silver tracks call
cadence today. Bundle a default policy for LinkedIn/X/Instagram. **Change:** `security/egress.ts`, new
`security/ratelimit.ts`. **Keyless.** Source: `all-aside #4,#6`.

### S9. Lookalike/typosquat domain warning + daemon hardening defaults (folds into v2-A3) — **P2/P1**
(a) Optional `--warn-lookalike` on nav: Levenshtein/confusable-char distance against a small trusted-domain
reference (or `--trusted-domains`) → `{warning:"lookalike_domain", target, closestMatch}`, host decides. Phishing
defense for checkout/login (Aside #5, **P2**). (b) **Fold into A3 from day one:** default the opt-in daemon bind
to `127.0.0.1`/Unix-socket only (never `0.0.0.0`), no CORS surface, `Origin`/`Host` allowlist + startup banner to
stderr if TCP ever added — the "0.0.0.0-day" class Perplexity's own MCP server shipped and never patched on npm
(perplexity #10, **P1**). **Keyless.** Source: `all-aside #5`, `all-agentql-perplexity-bb #10`.

---

## 9. Skill packaging / docs (high ROI-per-effort, mostly prose)

### K1. Skill auto-injection matcher (`skills/index.ts`) — **HIGH/P1, M**
Silver's skill system is a static single-shot read; Aside resolves which of N skills apply via two keyless
scorers — `hat` (host-glob × path-glob, `100·hostChars + 10·pathChars − wildcards`, minimatch) and `gat`
(keyword-in-URL, word-boundary). Non-site-specific skills always on (name+desc+path, progressive disclosure);
site-specific hidden until a URL/message match fires. Implements the auto-injection Silver's own skill-design doc
specs but nothing runs. **Change:** load SKILL frontmatter (`autoInject.keywords[]`/`url[]`/`siteSpecific`),
`silver skills resolve --url|--message` with the identical scoring. **Keyless:** pure string/regex math.
Source: `all-aside #1`.

### K2. Verification protocol + honest-completion rubric (doc) — **P1, doc**
Port webwright's two-stage keyless rubric as the host-run `task verify` protocol: per-checkpoint-screenshot harsh
1-5 score + one-line reason, then one aggregate pass over all evidence + the action log ending in a trailing
`Status: success|failure`; parse defensively — take the **last** `Status:`, **treat unparsed as FAIL**. This is
the doc half of the honest-completion gate (Silver only checks evidence *exists* on disk). Pair with the
`image_qa` output contract `{answer, evidence[], unknown:bool, confidence}` — abstain rather than hallucinate.
Source: `all-webwright L,M`.

### K3. Accretion review discipline + tool-sourcing + instructions-≠-capability audit (doc) — **P1/P2, doc**
From the Anthropic "Stock Pilot" case study (an agent that regressed 83%→62% eval from capability accretion):
(a) **P1** — a "before adding a verb/flag, ask which of {fold into main, custom local tool, MCP} it should have
been" note in Silver's design/contributing doc; Silver's ~379-line SKILL.md is exactly the artifact this failure
targets. (b) **P2** — audit Hard Rules for "instructions without capability" (hedge-y prose not backed by a
mechanism): delete or convert to a pointer at the confirm-gate / generation-scoped refs that actually enforce it
("*instructions don't add capability*"). (c) **P2** — one SKILL sentence: prefer `silver extract` over
hand-rolled DOM scraping via the host's own code-exec tool (the tested, schema-validated, injection-neutralized
path). Source: `agent-design-patterns #1,#2,#6`.

### K4. Structured doctor report — **HIGH/P1, S**
`handleDoctor` returns a flat `{playwright, chromium, uab_writable}` triple — a host hitting a failure gets three
booleans and must guess the fix. Stagehand/webwright shape: `{checks:[{name,status,message,fix,details}], verdict,
next}`, each check carrying a **remediation command** (`chromium`-missing → `"npx playwright install chromium"`),
plus a real headless launch probe (v2-F2), `playwright install --dry-run` completeness check (catches partial
installs `existsSync` misses), session-lock staleness, CDP-reachability, and a `passed/total` count. Directly
improves host self-repair loops. **Change:** `core/handlers.ts handleDoctor`. **Keyless.** Source:
`all-stagehand #2`, `all-webwright O`.

### K5. Explicit non-retry guidance + Nova Act atomic-commands citation + eval-design sharpening (doc) — **P1/P2, doc**
(a) Audit SKILL for "don't retry X unchanged, do Y" guidance on every error class where blind retry is a known
failure (Stagehand bakes anti-loop instructions into agent-facing docs) (**P2**). (b) One-line SKILL citation:
Amazon Nova Act found atomic decomposition takes UI-task success ~50%→90%+ — *"prefer many small silver verb
calls over one free-text instruction; this is an industry-wide finding"* — and `repl` (v2-B0) must stay additive
(**P2**). (c) Sharpen the v2-G2 eval harness: code-graders for structural checks (envelope success, ref resolves,
schema-valid), model-graders reserved for nuance, cross-reference browser-use's `FAILURE_CONDITIONS` (captcha /
claimed-done-but-state-disagrees / fabricated content) as deterministic eval-coverage, budget a grader
calibration round, reuse the control/edge/boundary case template (**P1** design input). Source:
`all-stagehand #12`, `sota-2026-a #4`, `agent-design-patterns #5`, `all-browseruse #8`.

### K6. DOM-contract self-QA recipe + memory-as-regression framing (doc) — **P2/P3, doc**
(a) **Novel (P2):** when a host drives Silver against its *own* just-built app, have it publish a small
`data-silver-verify-*` state contract (counts, current-step, error-flag); Silver's `extract` grounds on that
contract instead of re-deriving state from markup — the technique Anthropic's own Claude Code team uses,
disambiguating "did I break the app or my scraper's assumptions." (b) **P3:** reframe memory-store guidance with
Sierra's "treat a site gotcha as a permanent regression note, not a one-off aside"; version-comment each
defensive Hard Rule with why it was added (withholding/over-fit prevention). Source: `agent-design-patterns #4,#7,#8`.

---

## 10. Ergonomics / DX

### D1. `silver inspect` — DevTools-proxy bridge — **P1, S-M**
A tiny `127.0.0.1:0` HTTP+WS server that serves Chrome's own bundled DevTools frontend and proxies a fresh
`Target.attachToTarget` CDP session per connection — a live real DevTools UI into the exact session the CLI is
driving (debug a non-grounding selector, watch network waterfalls) with zero competitor parity. Print the URL to
**stderr** (keeps `--json` clean). **Change:** `actuation/inspect.ts` (~200L). **Keyless.** Source: `all-vercel #4`.

### D2. TOTP helper (`silver totp <secret>`) — **P1, S — biggest MFA unblock across verticals**
The use-case map's #1 cross-cutting blocker: Silver has no TOTP generator, so MFA blocks finance/healthcare/
jobs/gov automation and the OTP must come out-of-band. A pure **RFC-6238** `totp <secret>` verb (zero deps, no
model) lets the host complete MFA without a third party. **Change:** new small module + verb. **Keyless:**
HMAC-SHA1/256 math. Source: `use-cases-wide X1`.

### D3. Cloud-browser provider matrix (`-p/--provider`) — **P1, M**
Silver has no cloud story beyond `--cdp <url>`. Vercel's `providers.rs` ships Browserbase/Browserless/browser-use/
Kernel as plain REST-POST-with-API-key connectors (+ symmetric cleanup so cloud sessions don't bill forever) —
same "bring your own key for infra, never for cognition" boundary Silver already draws for proxies. Extends
Silver's market to teams already paying for that infra who want Silver's engine/security on top. Port the four
simple REST providers; skip AgentCore's SigV4 signer initially. **Change:** `actuation/providers.ts`. **Keyless.**
Source: `all-vercel #12`.

### D4. `scroll --until-stable` harvest helper — **P2, S**
Every host currently re-writes the infinite-scroll loop (scroll → wait predicate → get count → repeat until
stable). A `scroll --until-stable [--extract-per-tick]` primitive (host still owns the stop threshold; extracts
per scroll-tick to survive virtualized/windowed lists) removes real boilerplate. **Change:** `actuation/actions.ts`.
**Keyless.** Source: `use-cases-wide X2`.

### D5. Command-not-found typo suggestion + isTTY-adaptive output — **P2, S**
(a) Two-tier "did you mean": explicit alias map (`goto`→`open`) then Levenshtein over the real verb table, on a
**sanitized token prefix only** (`/^[A-Za-z][A-Za-z0-9_-]*$/`) so URLs/selectors/values never leak into the error
string — saves a host round-trip on `silver clik @e5`. (b) `isTTY ? table : json` default for any future
human-facing list verb. **Change:** `cli.ts`/new `core/suggest.ts`, `core/output.ts`. **Keyless** (hand-roll
Levenshtein, no dep). Source: `all-stagehand #3,#4`.

### D6. Cookie-authenticated direct-API fetch (`fetch --use-cookies`) — **P1, M**
Aside's biggest practical differentiator isn't the browser — read-heavy site ops (search email, list threads) hit
the site's internal API directly over the user's existing cookies, never opening a tab: order-of-magnitude
cheaper than snapshot+click. Silver has cookie *storage* but no cookie-authenticated *fetch* verb. Add `fetch`
that does `context.request.get(url,{headers:{Cookie:<jar-for-origin>}})` and returns raw text/JSON (optionally
markdown-converted) — an accelerant, host still falls back to UI automation. Composes with E1's `read` and D3.
**Change:** new fetch verb + `core/handlers.ts`. **Keyless:** plain HTTP. Source: `all-aside #2`.

### D7. `silver network on|off|path|clear` — per-request capture to disk — **P1, S-M**
No `network` verb / per-request capture today. Stagehand's `NetworkCapture`: `Network.enable` with buffer caps,
one directory per request (`{n}-{METHOD}-{domain}/{request,response}.json`) under the session runtime dir,
base64 bodies truncated to a preview. Lets a host debug "why did this submit fail / what API did this SPA call"
by `Read`ing the JSON — composes with Silver's "host reads files, not a live UI" model. **Change:**
`actuation/network.ts`, reuse `nsdirs.ts`. **Keyless:** CDP + filesystem. Source: `all-stagehand #6`.

### D8. `stream enable --port` — MJPEG screencast for human oversight — **P2/P3, L**
The heaviest item: an HTTP endpoint serving `Page.startScreencast` frames as MJPEG so a human can *watch* a
long unattended agent task live without a VNC setup. Scope to MJPEG-only first; skip Vercel's chat-overlay layer.
**Change:** `actuation/stream.ts`. **Keyless.** Source: `all-vercel #11`.

---

## Priority index (do-order)

**P0 (now):** E1 `read` · S4 `confirm`/`deny` two-phase · T2 run manifest (makes v2-F1 replay honest).

**P1 (soon):** E2 real-Chrome-profile · E3 config files · E4 retry+`retries_exhausted` cap · E5 `connect` ·
E6 cross-origin iframe AX · P1 ARIA-paradox fallback-name · P2 markdown chunking · AC1 `expect`/`--verify`
(marquee) · AC2 screenshot-diff · AC3 coord→ref (fold B1) · AC4 CAPTCHA primitives · R1 dialog handler ·
R2 CAPTCHA detect · R4 gen-bump-on-act · T1 variable auto-detect · T3 verb-sequence cache · T4a strip-base64 ·
T5 subprocess env hygiene · T6a `--echo-plan` · O1 subagent result-file · O2a shared-target caveat ·
S1 taint guard (novel) · S2 CDP Fetch egress · S3 filename chokepoint · S5 action-policy · S6a amount regex ·
S7 secret-blind fill · S9b daemon hardening · K1 skill matcher · K2 verify protocol · K3a accretion discipline ·
K4 structured doctor · K5c eval sharpening · D1 `inspect` · D2 TOTP · D3 providers · D6 cookie-fetch · D7 network.

**P2 (when convenient):** E7 proxy/duration · P3 state badges · P4 SoM overlay · P5 SPA-blob strip · P6 max-nodes ·
AC5 highlight · AC6 `act --batch` · AC7 trace/record/touch/clipboard · R3 auth-wall · R5 empty/repetition ·
R6 crash/nav · R7 lifecycle-watcher · X1 CSV/PDF · T4bcd log hygiene · T6bc status/compaction · T7 recipe catalog ·
O2b typed ids · O3 parallel litmus · S6b PII gate · S8 denylist+ratelimit · S9a lookalike · K3bc audit ·
K5ab non-retry/Nova · K6a DOM-contract recipe · D4 scroll-harvest · D5 typo suggest · D8 stream.

**P3 / optional:** R8 downloads/status/OOPIF-variant · X2 cite-by-snippet · T8 task report/artifacts ·
K6b memory-regression framing · P6-companions (DOM strip, CI4A TODO) · shadow-root doctor count.

---

## Cross-cutting notes

- **Every new detector (R1-R8) ships with a frozen hostile-fixture regression eval** — a defined-but-never-emitted
  code (`captcha_detected`, `auth_required`) is a *visible* reliability hole. This is the largest single reliability
  debt: two dead error codes and one silent-hang class (dialogs).
- **The four "auth reality" items (E2 profile, D2 TOTP, D6 cookie-fetch, E6 iframe AX) together unblock the
  verticals the use-case map flags as blocked** (finance/healthcare/jobs/gov) — the highest-leverage cluster for
  "can Silver do useful logged-in work at all."
- **S1 (taint guard) + S2 (Fetch-layer egress) + S3 (filename chokepoint)** are the three genuine security-gap
  closures (vs. polish) — Silver currently claims exfil hardening its egress guard doesn't actually enforce, and
  has no data-flow defense.
- **Do NOT build (re-confirmed exclusions):** vision-primary grounding, residential-proxy/fingerprint stealth,
  captcha *solvers*, Web Bot Auth, LLM-judge inside Silver (coherence-trap + breaks keyless), test-time tree
  search (host's loop), AgentQL DOM-attribute stamping (out-of-band `eN` is better), browser-use's decorator
  registry, remote/paid skill APIs, in-CLI scheduler (host/OS owns cron — document the handoff). New this round:
  the `repl` (v2-B0) should default to **stateless-per-call globals over a persisted CDP connection**, not a
  long-lived JS heap — Perplexity A/B-tested and chose filesystem-serde over persistent-REPL for long-trajectory
  reliability (agentql-bb #9).
