# Deep Dive: Perplexity Computer/Comet — Top 5 DX/Safety Wins vs Silver

Source: `/Users/seventyleven/Desktop/researchfms/teardowns/PERPLEXITY_COMPUTER.md` (5,067 lines;
read directly: lines 1400–1540, 1850–2100, 2530, 2920–3160, 3810, 4020–4060,
4300–4370, 4600–4650, 4770). Silver source read in full: `src/security/injection.ts`,
`src/security/confirm.ts`, `src/security/egress.ts`, `src/task/index.ts`,
`src/orchestration/subagent.ts`, `src/actuation/actions.ts`, `src/actuation/wait.ts`.
This supersedes/verifies the seed at `research/topfive/top5-perplexity.md` against
primary source text and Silver's actual code (not paraphrase).

## Methodology note

Perplexity Computer is a *keyed, hosted, multi-model orchestrator* running inside
Firecracker VMs with a Claude Opus 4.6 leader agent that itself calls out to 20+
models. Silver is *keyless* — it never calls a model, so every "Silver has X" claim
below is necessarily about **primitives the host LLM can drive**, not autonomous
behavior Silver performs on its own. That asymmetry is the frame for every gap
below: the question is never "can Silver think this," it's "does Silver expose the
plumbing so a host LLM can replicate the behavior without Silver embedding a model."

---

## 1. BrowseSafe — semantic ML classifier with async two-stage escalation (teardown §"BrowseSafe Safety Layer," lines 1871–2079, model card lines ~1877–1912)

**Mechanism, verified from the primary text.** Every `fetch_url` / `browser_task` /
`get_full_page_content` / `screenshot_page` result routes through a two-stage
pipeline before the agent sees it. Stage 0 strips AI-annotation wrapper fields down
to raw HTML — the model card explicitly warns that classifying *extracted text*
instead of raw HTML causes a measured F1 drop, because injected payloads often hide
in markup structure (attributes, comments, hidden elements) that text-extraction
discards. Stage 1 is Qwen3-30B-A3B-Instruct-2507 (MoE, 31B total / ~3B active),
SFT'd to emit a single "yes"/"no" token — F1 0.904, precision 0.978, recall 0.841,
0 refusals, <1s latency on BrowseSafe-Bench (3,680 samples). Long HTML is chunked
at fixed non-overlapping token boundaries (context cap 16,384 tokens; likely
T_w ≈ 14–15K), each chunk classified in parallel, conservative OR aggregation
(any VIOLATES chunk flags the whole document). Stage 2 escalates only boundary
cases (near the 1% FPR threshold) to a frontier LLM — GPT-5 (~2s) or Claude Sonnet
4.5 (~23–36s) — using two verbatim safeguard prompts from arXiv:2511.20597
Appendix A.4/A.5. The concurrency model (arXiv §4.3, quoted verbatim in the
teardown): classification runs as an *async task concurrent with the LLM's own
planning phase*, so the safety check is hidden behind inference latency rather than
serialized in front of it. On VIOLATES, arXiv §4.7 states the tool's entire output
is *replaced* — not appended, not tagged — with a placeholder naming the blocked
URL but never repeating the payload text, specifically to avoid re-exposing the
injection to the model's attention window.

**Caveat worth carrying forward:** the paper's own numbers show real degradation —
multilingual attacks drop to 76.0% balanced accuracy (vs 91.2% English), and an
independent test found a 36% false-negative rate on simple attacks vs Perplexity's
claimed 9.6%. BrowseSafe is real and load-bearing, but not the silver bullet the
marketing implies — worth citing when arguing Silver doesn't need to chase parity
on classifier quality, only on *architecture* (async gate + replace-not-append).

**Silver verified (`src/security/injection.ts`, read in full, 72 lines).**
`neutralize()` is purely syntactic: two regexes (`FORGED_ROLE_RE` for
`<system>`/`<user>`/`<tool>`/`<assistant>` tags, `FORGED_UNTRUSTED_RE` for
`<untrusted…>` tags) strip forged transcript-role impersonation and replace each
match with a visible `[PROMPT_INJECTION_NEUTRALIZED]` breadcrumb. Before that, a
third pass (`FENCE_GLYPH_RE`) de-fangs any literal U+27E6/U+27E7 glyphs *in the
page's own content* so a hostile page cannot forge the closing boundary marker
Silver itself adds (`⟦page-content untrusted⟧ … ⟦/page-content⟧`). This is applied
universally — confirmed by direct read of both `src/task/index.ts`'s `present()`
helper (line 52-54) and `src/orchestration/subagent.ts`'s `present()` (line 90-94),
both of which route every echoed prompt/result through
`neutralize(capOutput(text, N))` before it reaches the host. There is no semantic
layer anywhere in the codebase — grep of `security/` confirms only `injection.ts`,
`confirm.ts`, `egress.ts`, `redact.ts`, `registry.ts` exist, none of which classify
intent.

**GAP — confirmed, not narrowed by this pass.** `neutralize()` catches exactly one
attack shape: literal impersonation of transcript role syntax. It does nothing for
PerplexedBrowser's actual exploit (a Hebrew-language calendar-invite payload with
no forged tags at all — see item 5) or for plain-English "ignore previous
instructions" prose embedded in ordinary page text. Since Silver is keyless it
cannot embed BrowseSafe's fine-tuned model, but two concretely buildable pieces
close real ground: (a) a documented "async-classify" **CLI pattern** — instruct
host LLMs to treat every `snapshot`/`get-text`/`read` call on untrusted content as
requiring a same-turn or next-turn self-classification step before acting on it,
formalized as a doc convention rather than left implicit; (b) a lightweight
**keyword/pattern heuristic second pass** (e.g. common injection phrasings:
"ignore previous instructions," "disregard the above," "new instructions:",
system-prompt-mimicking phrasing in multiple languages) added to `neutralize()` as
a defense-in-depth layer alongside the syntactic scrub — cheap, keyless, and closes
some of the "plain prose" gap even though it will never match BrowseSafe's F1.
**Priority: HIGH** — this is the single most consequential gap across all 5 items;
it's the shared root cause behind items 1 and 5.

---

## 2. Dependency-aware task decomposition graph (teardown lines 1411–1477, plus routing detail lines ~1200–1410)

**Mechanism, verified.** The leader agent (Claude Opus 4.6) plans upfront into an
explicit `task_list` — `{id, type, dependencies: [], parallel_ok}` per subtask —
described in the teardown as "plan-then-execute," not a full DAG solver: the
orchestrator "queues the analysis task until the prerequisite data is available."
Independent tasks (`dependencies: []`) dispatch into separate Firecracker sandboxes
simultaneously; dependent tasks block, then get prerequisite outputs read from
`/home/user/workspace/{id}.json` and injected into context. A confirmed demo:
10 competitor-research subtasks dispatched in parallel, each with its own model
assignment via a "meta-router" embedded in the leader's own planning reasoning (not
a separate microservice) — Gemini 3.1 Pro for research, Claude Sonnet 4.6 for
coding, Grok 4-1-fast for latency-sensitive work. The leader can revise the plan
mid-execution on sub-agent error.

**Silver verified (`src/orchestration/subagent.ts`, read in full, 359 lines).**
`spawn` reserves an isolated child (own detached browser) or a tab in a shared
browser, returns a child id + a `childEnv` hint, and enforces three hard
invariants directly in code: `CONCURRENCY_CAP = 5` running children per namespace
(line 55, enforced at line 187-190 inside a namespace-scoped advisory lock so the
count-check-write is atomic across concurrent spawns); one-level-only nesting via
`SILVER_SUBAGENT_DEPTH` (checked at line 163, refuses if depth ≥ 1, and the
`childEnv` returned to the caller pre-sets depth=1 for the child so its own spawn
is refused in turn); and own-context-per-agent (line 207-212: an isolated,
non-tab child cannot share a session with another RUNNING child). `wait` (line
270-297) blocks on an explicit list of ids the caller passes, polling each status
file every 50ms up to a 60s default budget. This is genuine, correctly-built
parallel-dispatch plumbing. But there is **no dependency field anywhere** in
`SubRecord` (line 62-77) — no `dependencies: []`, no `--after <id>` flag parsed
anywhere in `subagentSpawn`. The host must hand-roll ordering itself: call
`subagent wait A B` before issuing `subagent spawn C`, with no declarative record
of *why* C waited on A and B, and no automatic block on a premature spawn.

**GAP — confirmed as a genuine capability gap, not a design choice.** Silver's
`SubRecord` already has the shape to carry a `dependencies: string[]` field the
same way Perplexity's `task_list` does — this is pure bookkeeping, no model call,
fully compatible with keylessness. Recommend: `subagent spawn --after <id>,<id>
<prompt>` records the dependency edges in the record, and `spawn` itself blocks
(polling the same way `wait` already does) until all `--after` ids reach a
terminal status before minting the child and returning control — collapsing what
today requires the host to manually sequence `wait` then `spawn` into one call.
**Priority: MEDIUM** — real gap, but the host can already replicate the correct
behavior today with two calls instead of one; this is an ergonomics/atomicity win,
not a missing capability class.

---

## 3. Condition-based pause/monitor primitive (teardown lines 3070-3120 "Q5" section, `pause_and_wait` schema)

**Mechanism, verified.** `pause_and_wait` has two modes. `HUMAN_APPROVAL` is
architecturally identical to `confirm_action` (item 3 in the seed) — a mid-loop
UI checkpoint rather than a pre-execution gate, both implemented via the same
turn-based `requires_action` / re-POST continuation mechanism the teardown
confirms is standard OpenAI-style function-calling, NOT Redis pub/sub or webhooks
(explicitly corrected in the teardown after an earlier false lead). `CONDITION_BASED`
mode (inferred schema, medium confidence per the teardown itself) snapshots the
current Firecracker VM to S3, schedules a polling job server-side with
`poll_interval_minutes` and `timeout_hours`, spins a lightweight VM per poll to run
a `condition_tool` (e.g. `fetch_url` against FlightAware), and has the LLM evaluate
whether the result satisfies a natural-language `condition` string — used for
"notify me when flight AA123 lands" or "monitor this inbox" patterns.

**Silver verified (`src/actuation/wait.ts`, read in full, 90 lines).** The
`WaitSpec` union covers `{ selector }`, `{ ref }`, `{ text }`, `{ url }`,
`{ load }`, `{ fn }`, and `{ ms }` (explicitly documented as "LAST RESORT" — a
fixed sleep, discouraged). `{ fn }` maps to `page.waitForFunction`, which IS a
polling primitive with backoff owned entirely by Playwright — but it polls an
**in-page DOM/JS predicate only**. There is no `--until <condition>` that polls an
*external* resource (an API, a different URL, a scheduled recheck across process
restarts) the way Perplexity's `condition_tool` + `poll_interval_minutes` +
`timeout_hours` does. Silver's task store (`src/task/store.ts`, checkpoint/resume)
gives durable state across a crash, which is the equivalent of Perplexity's
S3-snapshot pause — but nothing auto-resumes based on an external condition
becoming true; resumption is always host-initiated.

**GAP — confirmed and narrowed.** Silver's `wait --fn` genuinely covers the
in-page-condition half of Perplexity's primitive (arguably a cleaner
implementation, since it inherits Playwright's actionability/backoff instead of
hand-rolled polling). What's missing is the **cross-process, external-condition,
scheduled-resume** half — Silver has no analog to `poll_interval_minutes` +
`timeout_hours` + a server-side scheduler, and structurally can't, because Silver
is a per-invocation CLI with no daemon (see the engine-efficiency gap vs Vercel
noted in the project brief — this is the same root architectural fact surfacing in
a different feature). The keyless-compatible fix is NOT to build a scheduler
inside Silver — that's out of scope for a browser-automation CLI — but to
**document the host-side polling loop pattern explicitly** (host calls `silver
<check-condition-command>` on a timer, e.g. via cron/systemd-timer/host's own
task scheduler, and calls `task checkpoint`/`resume` to persist state between
polls) so this becomes a documented recipe instead of something every host
reinvents. **Priority: LOW-MEDIUM** — real gap but it is arguably *correctly*
out of Silver's scope; the actionable adopt is documentation, not new code.

---

## 4. Vision-based dual-mode fallback with an explicit gating rule (teardown lines 3060-3150, Comet system prompt leak)

**Mechanism, verified verbatim from the leaked Comet browser sub-agent system
prompt** (teardown line 3144-3145, tool registry at line 3810 — 9 tools:
`navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`,
`search_web`, `tabs_create`, `todo_write`): *"Operate via x,y coordinates when
target elements are present in latest screenshot. When elements are NOT present in
the last screenshot, use the `read_page` tool to retrieve [DOM/AX tree]."* This is
a literal, prompt-level gating rule, not an undocumented heuristic: `ComputerBatch`
(line 2534) issues raw pixel-coordinate clicks/drags/scrolls/keystrokes when the
element is visible in the last screenshot; `read_page` (structured DOM/AX
extraction, returns up to 20 elements with `ref` handles) is the fallback when it
isn't. The Mac "Personal Computer" mode generalizes this to arbitrary native apps
via the same two-mode split: vision (screenshot → cloud multimodal model →
Accessibility-API coordinate injection) for any visible app, AppleScript/AXUIElement
for a short list of natively-scriptable apps (Mail, Finder, Calendar, Messages).

**Silver verified (`src/actuation/actions.ts`, read in full, 374 lines).** Silver's
`ActVerb` union is exhaustively ref/locator-based: `click, dblclick, hover, focus,
fill, type, press, select, check, uncheck, scroll, upload, drag`. Every verb routes
through `groundRef` → `toLocator` → the matching Playwright `Locator` method (lines
125-165) — there is **no coordinate-based click verb anywhere in the file**; no
`{x, y}` parameter exists on `ActOptions` (lines 46-57), and `find()`'s semantic
tier (`role|text|label|placeholder|testid|first|last|nth`, lines 172-228) is also
exclusively DOM-locator-based, never pixel-based. This is a deliberate, stated
design choice (module doc, lines 1-21: "Playwright owns ALL actionability... we
hand-roll NO gates and NO timing constants") consistent with Silver's AX-tree-first
token-efficiency thesis, not an oversight. `task checkpoint` does capture a raw
screenshot (`captureScreenshot()`, `src/task/index.ts` line 317-331) but purely as
a durable human-facing artifact — it's never read back into `resolve.ts` or
`refmap.ts` for grounding.

**GAP — confirmed, correctly scoped as narrow.** Silver cannot replicate
Perplexity's *model-driven* gate (deciding "is this visible in the screenshot")
without a model call, which would break keylessness. There is also **no coordinate
click primitive to fall back to at all** — so even a host LLM that wanted to
implement the equivalent contract ("if `find`/`snapshot` returns no match, take a
screenshot, get host to eyeball pixel coords, click there") has no verb to
terminate that flow with. Recommend: (a) document the fallback *contract*
explicitly in Silver's docs — "if `find` returns `element_not_found` on a
description that should exist, capture `screenshot`, hand pixel coordinates back
to the host for reasoning, and use Playwright's `page.mouse.click(x,y)` via a new
coordinate verb"; (b) add a genuinely new `click --x <n> --y <n>` verb (bypassing
`groundRef`/`toLocator` entirely, calling `page.mouse.click` directly) as the
actual fallback primitive — currently doesn't exist, so the documented contract in
(a) would be aspirational without it. **Priority: MEDIUM** — legitimate reliability
gap (canvas apps, custom-rendered widgets, and Shadow-DOM-heavy SPAs with no
accessible roles are exactly the case where AX-tree grounding fails and Silver
currently has zero recourse), but narrower in blast radius than items 1 and 2.

---

## 5. Trust-boundary root-causing as architecture, not "a bug" (teardown lines 2920-2995, PerplexedBrowser disclosure)

**Mechanism, verified.** Zenity Labs' Bugcrowd P1 disclosure (reported Oct 22 2025,
fixed Jan 23 2026) describes an attack where a calendar invite carried a hidden
HTML payload formatted to mimic Perplexity's internal system-prompt structure,
written in Hebrew specifically to bypass English-only safety filters, invisible to
the user in the calendar UI. Once the agent processed the invite, it navigated to
an attacker-controlled URL for secondary instructions (redirecting away from the
calendar page specifically to avoid audit-log traceability), then read
`~/.ssh/id_rsa`/`.env`/cookies via `file://` access and POSTed them to an
attacker endpoint — with a normal-looking response shown to the user, no visible
indication of the exfiltration. A second variant abused a legitimately
OAuth-authorized 1Password MCP connector rather than exploiting 1Password
directly — the agent workflow itself was weaponized. Perplexity's own post-mortem,
quoted verbatim in the teardown: *"the LLM merged trusted user context and
untrusted web content in the same context window without trust boundary
enforcement."* The fix was two independent layers: a hard `file://` denylist in
`isUrlBlocked()`, plus BrowseSafe (item 1) as the semantic layer — neither alone
would have stopped both exploit variants.

**Silver verified (`src/security/egress.ts`, read in full, 317 lines).**
`assertNavigable()` (lines 76-131) is a hard scheme+host denylist: flat deny of
`file:`/`data:`(top-level)/`blob:`/`view-source:`/any non-http(s) scheme, with
`allowFile` lifting *only* `file:` and nothing else (line 88-92) — directly
comparable to Perplexity's `isUrlBlocked()` fix. It also denies raw-IP literals
(v4/v6/decimal/hex, lines 109-115) and a short known-dangerous-host list
(`accounts.google.com`, `login.microsoftonline.com`, etc., lines 46-55).
`assertNavigableResolved()` (lines 195-241) closes a DNS-rebinding SSRF hole
`assertNavigable` alone would miss — a public hostname (e.g. via nip.io wildcard
DNS) that *resolves* to a private/metadata IP is caught by actually resolving and
checking every returned address against `isBlockedAddress()` (lines 247-279,
covering RFC1918, loopback, link-local/169.254 metadata range, CGNAT, and IPv6
equivalents) — a more thorough SSRF closure than anything described for
`isUrlBlocked()` in the teardown. `assertContainedPath()` (lines 302-316) sandboxes
any filesystem path Silver reads/writes to inside a root directory, denying `..`
traversal and absolute escapes — Silver's analog to blocking local filesystem
exfiltration. Combined with `confirm.ts`'s fail-closed mandatory gate (verified
separately — `confirmGateDecision()` at lines 96-113 denies any mutating verb on
non-TTY unless pre-approved, which is *stricter* than Perplexity's UI-checkpoint
model since Perplexity's teardown documents no fail-closed default for
headless/API use) and `injection.ts`'s syntactic scrub, Silver already runs
three independent layers matching the "don't rely on one layer" philosophy
Perplexity's post-mortem argues for.

**GAP — none structural; the sole gap is the semantic layer shared with item 1.**
The specific PerplexedBrowser exploit — a plain-language (non-role-tag) instruction
in ordinary page prose treated as legitimate task intent — would pass straight
through `neutralize()` unmodified, exactly as it passed Perplexity's pre-BrowseSafe
defenses. Silver's `egress.ts` layer would still block the `file://` read/POST
half of the attack chain today (that part is structurally solved), but the
"intent collision" half — the agent choosing to act on the hidden instruction at
all — is not something any of Silver's three layers currently address, because
none of them classify *intent*, only *syntax* (injection.ts) or *destination*
(egress.ts). **Priority: HIGH (shared with item 1)** — this is confirmation, not a
new gap: the semantic-classification layer is the single missing piece repeated
across two independent evidentiary trails (BrowseSafe's own design rationale, and
a real disclosed CVE-class exploit it was built to stop).

---

## Summary Table

| # | Capability | Silver status (verified) | Priority |
|---|---|---|---|
| 1 | BrowseSafe semantic ML injection classifier | **GAP** — `injection.ts` is syntactic-only (2 regexes + fence de-fang); no semantic layer, no async-classify pattern | **HIGH** |
| 2 | Dependency-aware task graph (`{id, dependencies[]}`) | **GAP (ergonomic)** — `subagent.ts` has verified cap/depth/context invariants but no `dependencies` field or `--after` flag; host must hand-sequence `wait`+`spawn` | MEDIUM |
| 3 | `pause_and_wait(CONDITION_BASED)` external polling | **PARTIAL** — `wait.ts`'s `{ fn }` covers in-page polling via Playwright; no cross-process/external-condition/scheduled-resume equivalent, and arguably shouldn't be built in-CLI | LOW-MEDIUM |
| 4 | Vision-fallback gating rule + coordinate click | **GAP** — no coordinate verb exists at all in `actions.ts` (ref-only); screenshot capture exists but is never fed back into grounding | MEDIUM |
| 5 | Defense-in-depth trust boundaries | **Silver already matches/exceeds** — `egress.ts`'s DNS-rebinding closure and `confirm.ts`'s fail-closed non-TTY default go beyond what the teardown documents for Perplexity; only the semantic-classifier gap (shared with #1) remains | HIGH (shared) |

## Bottom line

Two items (1 and 5) collapse into one real gap: Silver has no semantic
injection/intent classifier and, being keyless, structurally cannot embed one —
the actionable adopt is a documented host-side "classify before acting on
untrusted content" CLI convention plus a cheap keyword-heuristic second pass,
not an attempt to replicate BrowseSafe's fine-tuned model. Item 4 is a genuine
missing primitive (no coordinate-click verb exists) worth adding as a documented
fallback for AX-tree failures. Item 2 is real but low-severity — the host can
already build the same behavior with two calls instead of Silver's proposed one.
Item 3 is arguably out of correct scope for a per-invocation CLI and best closed
by documentation, not code. Everywhere this pass checked Silver's actual security
code against the actual teardown text (not paraphrase), Silver's egress and
confirm-gate layers were confirmed to be as strong as or stronger than what's
documented for Perplexity — the gap is narrow and specific (semantic classification
of intent), not broad.
