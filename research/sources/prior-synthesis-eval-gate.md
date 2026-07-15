# Source digest: prior:eval-gate synthesis (Travels/ASIDE/Verso)

**Primary paths read in full:**
- `/Users/seventyleven/Desktop/travels/docs/plans/2026-07-08-agent-browser-and-evals.md` (106 lines)
- `/Users/seventyleven/Desktop/travels/docs/plans/2026-07-06-travels-automation-from-aside.md` (75 lines)

These are the owner's own committed synthesis of a prior deep investigation (26 grounded
agents across two `workflow-investigation` DEEP sweeps) into ASIDE (a desktop
browser-automation agent teardown), Verso (an agent-framework PRD), and the Travels codebase
itself. Because this is a *synthesis of a synthesis*, most patterns below are already
distilled — where the source doc cites a deeper evidence line (e.g. `95_why_sota.md:27`), that
citation is preserved as-is; I did not re-open those underlying teardown files (out of scope for
this pass), so treat those as second-hand citations already vetted by the owner.

---

## Killer Insight

**Evals are the moat, and they must gate the browser build, not follow it — "the browser ships
BEHIND a `pass_k` eval, not before it."** The single most expensive mistake this doc catches in
retrospect is that a 7-adversary re-mine overturned the *original* build order (browser-first)
after discovering the actual highest-leverage move was a config flag (`TRAVELPAYOUTS_TOKEN`) that
needed zero new code. The lesson for the ultimate agent-browser CLI: don't let "build the
snapshot→ref→action loop" become the whole roadmap — the harness quality is *measured*, not
assumed, and every claimed capability (reliability fix, defended-commerce workaround, browser
vertical) must survive an adversarial "do we actually need this, and does the evidence support
it" pass before it's built. The second-order insight riding shotgun: **the convergent
architecture (AX-snapshot → stable ref → action → re-snapshot, done-as-tool, vision-only-to-
disambiguate, ID-grounded extract) is genuinely settled across independent implementations**
(ASIDE, Stagehand, browser-use, AgentQL, Firecrawl, Vercel `agent-browser`) — so the CLI should
stop re-litigating that architecture and spend its differentiation budget on the harness quality
levers (observation compression, ref resolution, actionability gating, recovery ladders, HITL
safety) that the source ranks explicitly.

---

## Patterns

### P1 — Convergent core loop: snapshot → ref → action → re-snapshot, `done` as a tool
**What:** Every independent implementation studied (ASIDE, Stagehand, browser-use, AgentQL,
Firecrawl, Vercel `agent-browser`) converges on the same loop: take an accessibility-tree
snapshot, have the LLM pick a **stable ref** (never a raw CSS selector or URL), execute a
deterministic action by that ref, then re-snapshot. Completion is signaled by calling a `done`
tool, not by free-text.
**Why:** This is the load-bearing abstraction that makes browser actions replayable,
diffable, and immune to selector rot — cross-validated by five independent production systems
converging on it without coordination.
**How to implement:** Build the CLI's primary loop exactly this shape: `snapshot → LLM ref
choice → act(ref, action) → snapshot`. Register a `done(summary)` tool the agent must call to
end a task; never let the loop terminate on prose alone.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:23-26` ("The architecture is settled...").
**Tier:** core.

### P2 — Vision only to disambiguate, never as primary perception
**What:** The default modality is the AX-tree/DOM snapshot; screenshots/vision are invoked only
when the tree is ambiguous (e.g. multiple visually-distinct-but-structurally-identical
elements).
**Why:** Academically corroborated cost/accuracy tradeoff — a downsampled a11y tree beat
screenshots and raw DOM in benchmarks (see P5). Vision is expensive and imprecise for exact
ref selection.
**How to implement:** Gate screenshot calls behind an explicit "disambiguate" tool the agent
invokes only after a snapshot-based action fails or returns >1 plausible match.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:23-26`.
**Tier:** core.

### P3 — ID-grounded `extract()`: URL→integer-ID grounding kills hallucinated data
**What:** `extract()` uses URL→integer-ID grounding so a reported price/link is guaranteed to be
a real DOM value — structurally impossible to hallucinate, because the extraction schema forces
the model to cite an ID that resolves back to an actual node.
**Why:** This is the single concrete anti-hallucination mechanism named in the whole doc for the
extract path specifically (as opposed to general grounding rhetoric).
**How to implement:** Assign every extractable node a stable integer ID in the flattened
snapshot; require extraction outputs to reference those IDs; validate post-hoc that the ID
resolves to a node whose text/attr matches the extracted value before accepting it.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:25-26`.
**Tier:** core.

### P4 — Extract must return a container, not a row (cardinality fix)
**What:** The adversarial correction to the naive extract design: `scrape/extract.py::extract`
originally returns a single `T`; for browse-extract use cases the **schema itself** must be a
container (`options: list[...]`), not a single row, or the tool silently drops all-but-one
result when a page has N comparable items (e.g. N flight options).
**Why:** This is exactly the kind of bug that looks fine in a demo (one result) and fails
silently in production (list pages). Called out explicitly as something "the adversary
corrected... do these, not the naive version."
**How to implement:** Default every list-shaped extraction schema to `list[T]` at the type
level; make single-item extraction the special case, not the default.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:40-41` ("Extract cardinality...").
**Tier:** core.

### P5 — Compact, diffed, downsampled, enriched a11y-tree observation (the "centerpiece" lever)
**What:** Ranked #1 of ASIDE's durable levers. Keep only interactive ∪ scrollable ∪ landmark ∪
canvas nodes; enrich each line with state flags `[focused][checked][disabled][selected]
[placeholder][size]`; return a **git-style diff** of the snapshot after each action
(`No changes detected` or unified `@@` hunks), sending the full tree only on the first call or
when the diff would be longer than the full tree. Academically corroborated: D2Snap
(arXiv 2508.04412) — downsampled tree **73%** task success > screenshot **65%** > raw DOM **38%**.
Measured cost: median **~1.7K observation-tokens/task**.
**Why:** This is the actual token/accuracy lever, not the loop shape — it's what makes the loop
affordable and keeps the model's attention on what changed rather than re-parsing a full page
every turn.
**How to implement:** Serializer filters to the four node classes above; every action handler
computes a diff of the flattened snapshot against the pre-action snapshot and returns that diff
(not the full re-snapshot) unless it's the first observation of a task or the diff exceeds
full-tree length.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:23` (cites `94_competitor_context.md:154-158`,
`93_benchmark_analysis.md:212`).
**Tier:** core.

### P6 — Serializer: interactive-only refs, offscreen-culling behind a flag defaulting OFF for extract
**What:** The adversarial correction to the a11y serializer (`scrape/ax_tree.py`): tag
**interactive-only** elements with refs (don't ref every span); gate offscreen-culling and the
40k-char cap behind an explicit path flag that **defaults OFF for the extract path** specifically
— because the extractor consumes the same `flat` output the action loop does, and culling
offscreen content is correct for "what can I click right now" but wrong for "what data is on
this page" (extraction needs the full page even if scrolled out of view). Also: since
`has_js_click_listener` is un-observable from `page.evaluate`, substitute `cursor:pointer` CSS +
icon-sized-element heuristics as the interactivity signal.
**Why:** A single global truncation/culling policy silently breaks extraction on long pages
while looking correct on the action-loop path — a subtle two-consumers-one-serializer bug class.
**How to implement:** Parameterize the snapshot serializer with a `path: "act" | "extract"` flag;
only cull offscreen/cap length on the `act` path. Detect interactivity via
`getComputedStyle(el).cursor === 'pointer'` + bounding-box-size heuristics, not JS listener
introspection (which CDP/Playwright can't see).
**Evidence:** `2026-07-08-agent-browser-and-evals.md:38-39`.
**Tier:** core.

### P7 — Late-bound ref resolution (query re-run at action time, not a cached handle)
**What:** A ref is **not** a cached DOM handle — it's a query (role + accessible name + ordinal
index) re-run at the moment of action. This kills stale-element flakiness because the DOM may
have re-rendered between snapshot and action.
**Why:** Cached handles are the #1 cause of "element not found / detached from DOM" flakiness in
naive Playwright automation; re-resolving by (role, name, ordinal) at click-time survives
re-renders that don't change the semantic structure.
**How to implement:** Store refs as `{role, accessibleName, ordinal}` tuples, not
`ElementHandle`s. Implement `deref(ref)` as a bounded role+name+ordinal re-match against the
live DOM immediately before acting.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:25` (cites
`101_asidewright_actuation.md:130,299-328,670-684`); reinforced by the Travels gap analysis
noting existing ids are "one-shot, meaningless after re-render" and naming `deref(aql_id)` as
required new work (`2026-07-06...md:36`).
**Tier:** core.

### P8 — Actionability gate ladder + verify-state-not-dispatch
**What:** Before any action: gate `attached → visible → stable → enabled` with `16ms/32ms`
polls, then hit-test (`elementFromPoint`), inside a bounded `[0,100,200]ms` retry ladder. After a
fill, **re-read `input.value`** to confirm the value actually landed (the React
`_valueTracker` trick — dispatching a DOM event does not guarantee a controlled React input
actually updated its state).
**Why:** "Dispatching ≠ effecting" — a click/fill event can be dispatched successfully by
Playwright while the page's JS framework silently ignores or overwrites it. Verifying the
resulting *state* (not just that the dispatch didn't throw) is the only way to catch this.
**How to implement:** `wait_until_actionable()`: poll attached→visible→stable(bbox unchanged
across 2 frames)→enabled→hittable, retry at `[0, 100, 200]ms` classifying failures as
transient-vs-terminal. `PageActions.fill()`: dispatch, then read back `input.value`; if it
doesn't match, fall back to the native property setter + input-event trick used to defeat React's
`_valueTracker`.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:25` (cites
`101_asidewright_actuation.md`); confirmed as SHIPPED in Travels at
`2026-07-06-travels-automation-from-aside.md:60` (`tbrowse/actions.py`, 282 tests green,
live-tested against headless chromium).
**Tier:** core.

### P9 — Playwright vocabulary, not raw CDP
**What:** Actions are expressed in Playwright's action vocabulary (click, fill, press, etc.),
not raw Chrome DevTools Protocol calls — because "LLMs are not trained on CDP"; Playwright is the
dialect the model saw most during pretraining, so it's model-agnostic and survives model swaps.
**Why:** Direct empirical framing from the source: harness quality (not the model) is the
differentiator, but the *vocabulary* still has to match what the model can reason about
zero-shot; CDP action names would require few-shot teaching that Playwright names don't.
**How to implement:** Expose the CLI's action surface as Playwright-shaped verbs
(`click(ref)`, `fill(ref, text)`, `press(key)`, `select_option(ref, value)`), even if the
underlying engine is not literally Playwright.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:24` (cites `95_why_sota.md:27`).
**Tier:** core.

### P10 — Fixed viewport + no-focus-steal background tabs
**What:** Pin viewport to a fixed size (**1440×900**) so element geometry stays in-distribution
for the model (it has seen countless screenshots/DOMs at common desktop sizes, and varying
viewport shifts element positions unpredictably). Run concurrent tabs `background:true,
focus:false` so parallel automation doesn't steal OS focus from each other or the user.
**Why:** Named as a durable, low-effort lever; directly ports to any pooled-browser-context CLI.
**How to implement:** `page.set_viewport_size(1440, 900)` always; bound concurrency with a
semaphore (Travels uses `max_size=3`) and open background tabs without focus.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:26` (cites
`92_agent_chromium_patches.md:34,325-330`); Travels' adoption noted same line.
**Tier:** important.

### P11 — Recovery/verification ladder with escape hatches
**What:** Lean loop pattern: dismiss-popups-first → re-snapshot-before-retry → switch-strategy-
after-2-3-fails → completion-verification ("verify you *accomplished* it," not just that the last
action didn't error). Escape hatches (web-search / direct HTTP fetch to JSON APIs / archive.org)
fire when the UI itself is a dead end — measured at **26% of tasks** in the source benchmark.
**Why:** A pure click-loop agent gets stuck on cookie banners, paywalls, and JS-broken pages;
naming a quarter of tasks as UI-dead-ends justifies building the escape hatch as a first-class
tool, not an afterthought.
**How to implement:** Standing recovery policy inside the loop controller: on failure, first try
"find and dismiss overlay," then re-snapshot and retry the same ref resolution, and only after
2-3 consecutive failures suggest an alternate strategy (different selector strategy, or escalate
to the escape-hatch tools). Final step before `done`: an explicit verification pass comparing
task goal to observed end state.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:27` (cites
`93_benchmark_analysis.md:241`).
**Tier:** important.

### P12 — Reader/actor phase-filtered tool quarantine, enforced at dispatch not in the prompt
**What:** Trust is modeled as **phase-filtered tool bindings** — which tools are even callable
is enforced by the dispatcher based on the current phase (read-only "reader" phase vs. mutating
"actor" phase), not by asking the model nicely in the system prompt to "only read, don't act."
The first shipped slice is deliberately read-only (`browse_page`, `browse_search`,
`browse_extract`) specifically because it requires **no HITL channel** — no human-in-the-loop
approval plumbing exists yet, so the safe move is to restrict the tool surface to something that
structurally cannot cause harm, rather than trust a system-prompt instruction.
**Why:** This is the load-bearing security move of the whole doc: capability restriction at the
binding/dispatch layer is unbypassable by prompt injection in a way that a system-prompt
instruction ("don't submit forms") is not.
**How to implement:** Two (or more) named tool-sets registered against two loop "phases."
Phase transition (reader → actor) requires an explicit gate (e.g., a human-approved
confirmation) before actor-phase tools become dispatchable at all — the model literally cannot
invoke `submit_payment` while in reader phase, regardless of what the prompt says.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:42-46` (safety bullet: "Trust =
phase-filtered tool bindings, enforced at dispatch, not in the prompt (reader/actor
quarantine)").
**Tier:** core.

### P13 — `final_confirm` / action-confirmation as the sole tool call in its turn
**What:** Before any paid/destructive/irreversible action, the agent MUST call a confirmation
tool that is **the only tool call allowed in that turn** and that echoes a full review artifact
(dates/pax/**total price**/cancellation policy) back to the human. This confirmation must be
**re-asked on material change** — if the underlying price/availability shifts between
confirmation and execution, the approval is invalidated.
**Why:** Prevents two failure modes at once: (1) the model bundling a confirmation call with
other tool calls in the same turn (which could let a mutating action slip through alongside the
"confirm" call), and (2) stale approvals being used to execute against changed terms (price
drift, sold-out inventory).
**How to implement:** `ConfirmationRequest` object carrying price/dates/pax/cancellation +
`material_change` detection + `approval_valid_for` TTL; **fail-closed** — treat as unapproved
unless explicitly approved AND nothing material has changed since approval. Enforce
single-tool-call-per-turn at the loop controller when the confirmation tool is invoked.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:28` (cites
`89_guardrails_captcha.md:419-431`); shipped primitive at
`tbrowse/confirmation.py` (`2026-07-06...md:62`, 7 tests, fail-closed semantics).
**Tier:** core.

### P14 — Partner-domain allowlist as hard egress boundary (suffix-match, not substring)
**What:** `assert_navigable()` — a navigation allowlist checked by **suffix match**, so
`m.getyourguide.com` correctly passes (subdomain of an allowed domain) while
`booking.com.evil.com` is correctly blocked (a naive substring/prefix match would wrongly allow
this phishing-style domain).
**Why:** This is a specific, easy-to-get-wrong security primitive: the natural first
implementation ("does the URL contain the allowed string") is exploitable; suffix-matching on the
hostname is the correct algorithm.
**How to implement:** Parse the URL, take the hostname, check
`hostname == allowed or hostname.endswith("." + allowed)` for each allowlisted domain — never
raw substring/`in` checks on the full URL string.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:62` (`tbrowse/allowlist.py`, 15
tests, explicit example `m.getyourguide.com` passes / `booking.com.evil.com` blocked).
**Tier:** core.

### P15 — Stop-on-injection when acting (not when merely reading/summarizing)
**What:** The prompt-injection defense posture is **phase-dependent**: when the agent is in a
read-only/summarize phase, suspicious page content can be flagged and handled leniently (e.g.
spotlighted/quoted back); when the agent is in an *acting* phase, detected injection triggers a
hard halt and hand-back to the human rather than a soft warning. `assert_safe_to_act` combines
the (hard) allowlist boundary with an `is_suspicious` heuristic that is explicitly documented as
**defense-in-depth, not the sole control** — the allowlist remains the authoritative gate.
**Why:** A single "detect injection, ask model to ignore it" strategy is not a security boundary
by itself (models can still be swayed); layering a hard structural boundary (allowlist) under a
soft heuristic (suspicious-content detection) matches the stated security principle: "authoritative
controls are system-level..., not the model noticing."
**How to implement:** `assert_safe_to_act(page_content)`: first check hard allowlist (raises/halts
if violated), then run heuristic injection detection as a secondary halt-and-handback signal
(logged, surfaced to human) — never rely on the heuristic alone.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:28,62` (`tbrowse/act_safety.py`, 3
tests); doc explicitly: "authoritative controls are system-level (allowlist + human gate), not
the model noticing" (built per the `agent-security` skill).
**Tier:** core.

### P16 — Detect-and-hand-back CAPTCHAs, never solve them
**What:** Explicit legal/ToS-driven rule: the agent must **detect** a CAPTCHA challenge and hand
control back to the human — it must never attempt to solve it, and (per the sibling doc) a
CAPTCHA solver is itself flagged as a paid third-party dependency that even Browserbase declines
to self-host.
**Why:** Solving CAPTCHAs programmatically is a ToS violation on most target sites and a legal
exposure the source explicitly refuses to take on, independent of technical feasibility.
**How to implement:** A `captcha_detect` module runs on every navigation/snapshot; on positive
detection, halt the actor phase and surface a "human needed" state rather than attempting any
bypass tool.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:28,62` (`tbrowse/captcha_detect.py`
exists, cites `89_guardrails_captcha.md:131`); reinforced in
`2026-07-08-agent-browser-and-evals.md:8-12` (residential IPs + CAPTCHA solvers named as the two
load-bearing paid third-party pieces self-hosted browsing cannot avoid on defended commerce
sites).
**Tier:** core.

### P17 — Actor-tagged audit log for every booking/mutating action
**What:** Every acting-phase action gets logged with an explicit actor tag (agent vs. human,
which confirmation it was gated by) — named as still-pending infra but explicitly required
before any acting capability ships.
**Why:** Without actor-tagging, a post-hoc audit cannot distinguish "the agent did this
autonomously" from "the human approved and the agent executed" — critical for both debugging and
liability/trust once real bookings happen.
**How to implement:** Every mutating tool call writes a log row: `{actor: agent|human,
confirmation_id, action, target_url, timestamp, result}`. Wire this before any acting tool is
enabled in production, not after.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:62` (listed under "Still pending
(wired into AUTO-3)").
**Tier:** important.

### P18 — Evals as the actual gate, not a green demo run; `pass_k` over a real task, not one trace
**What:** The explicit standard for "does this work": `pass_k` measured over a repeated task
("plan 3 days in Lisbon," run many times) rather than a single successful demo run. The source
also self-corrects mid-doc: an earlier eval implementation was **relabeled from "gate" to "lint"**
once the team realized it wasn't actually the frozen, adversarially-scored corpus originally
intended — the *real* gate is "a frozen real-SSE-trace corpus scored by `pass_k`," which was
still unbuilt as of the doc.
**Why:** This is the doc's own honesty check on itself — it caught its own eval infra
overclaiming its rigor and downgraded its label rather than let a weak eval masquerade as the
gate. That kind of self-correction is exactly the discipline the ultimate CLI's eval story needs.
**How to implement:** Two-tier eval framing: (1) cheap "lint" checks that run on every change
(schema validity, relevance heuristics) — necessary but not sufficient; (2) a frozen corpus of
real traces (not synthetic) scored via repeated sampling (`pass_k`) by an independent judge
(never self-graded) before anything ships as "working." Explicitly calibrate expectations to
~90%, not a vendor-reported 99% headline (see P19).
**Evidence:** `2026-07-08-agent-browser-and-evals.md:19-20,76-77`; `2026-07-06-...md:63`
("Grade with an independent WebJudge-style rubric, not self-grading; calibrate to ~90%, not the
99% headline").
**Tier:** core.

### P19 — Distrust vendor-self-graded benchmark headlines; use independent reproduction numbers
**What:** ASIDE's own reported 99%/#1 ranking is called out as **vendor self-graded**; the best
*independent* reproduction the source found was **≈90%**. The doc explicitly recalibrates its
own target to that lower, independently-verified number rather than the marketing figure.
**Why:** A concrete, source-grounded instance of "don't trust the benchmark someone has an
incentive to inflate" — directly actionable for how the ultimate CLI should evaluate any
competitor claims (Stagehand, browser-use, etc.) during synthesis.
**How to implement:** When citing any other browser-agent system's success rate, note whether
it's self-reported or independently reproduced, and prefer the latter for calibration targets.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:21` (cites `ASIDE.md:85`,
`95_why_sota.md:62-63`).
**Tier:** important (methodology, not a CLI feature per se).

### P20 — Same harness, different models: harness is the moat, model is swappable
**What:** Concrete evidence cited: the *same* harness scored **93% with GPT-5.5** vs **88% with
a cheaper "Kimi" model** — a 5-point gap on a much cheaper model, arguing the harness (not the
model) is doing most of the work and the model choice is a swappable cost/quality dial.
**Why:** Directly informs the ultimate CLI's design stance: invest in harness quality
(perception compression, ref resolution, actionability gating, recovery) over prompt engineering
for a specific model — those investments should be portable across model swaps.
**How to implement:** When benchmarking the CLI, always run at least two model tiers against the
identical harness to confirm the harness (not prompt-tuning to one model) is what's carrying
performance.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:21` (cites `95_why_sota.md:11-16`).
**Tier:** important.

### P21 — Build on your own primitive; adopt a reference implementation as a design spec, not a runtime dependency
**What:** Vercel's `agent-browser` is judged to be a real, production implementation of this
exact architecture — but it's a Node/Rust daemon that "can't co-tenant" the target service
(a Python backend). Decision: **adopt it as the design spec, keep building the owned
implementation**, because the existing codebase already had ~70% of the needed primitives (pool,
circuit breaker, gated `PageActions`, `scroll_collect`, `ax_snapshot`, allowlist,
captcha-detect, an AgentQL-shaped `scrape/` stack).
**Why:** This is a direct, load-bearing precedent for the ultimate-agent-browser project itself:
mining prior art for *architecture* while building your own runtime is exactly the mode this
whole project is in.
**How to implement:** Track "what % of the converged architecture do we already have" explicitly
(a checklist), and treat competitor/reference tools as architecture proof + a source of specific
API-shape decisions (command surface below) rather than as a dependency to wrap.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:27-32`.
**Tier:** important (process pattern, not a runtime pattern).

### P22 — One typed tool over the browser engine, `{ok, data, error}`, never raises into the loop
**What:** The browser is exposed to the agent loop as a small number of durable, typed,
bounded-operation tools (`browse_page(url)`, `browse_search(...)`, `browse_extract(...)`) — NOT
a REPL and NOT a sub-agent/planner/graph. Each call returns a uniform envelope `{ok, data,
error}` and is documented to **never raise into the calling loop** — all failures are captured
and returned as data. Errors returned to the model are **sanitized** (raw exceptions logged
server-side only; tested that secret/path text never leaks into the tool's returned error
string).
**Why:** Keeps the loop controller simple (no exception handling scattered through the ReAct
loop) and closes an information-leak vector (stack traces / internal paths / secrets in error
messages reaching the model, which could then reach an untrusted page or user).
**How to implement:** Every browser tool function wraps its body in a try/except that converts
any exception into `{ok: false, error: <sanitized message>}`, logs the full exception
server-side, and returns normally. Unit-test specifically that no path/secret substring appears
in any returned error string.
**Evidence:** `2026-07-08-agent-browser-and-evals.md:42-43`; `2026-07-06-...md:51,61` (Verso
framing: "a single `@tool`-shaped `browser` action returning `{ok, data, error}` that never
raises into the loop," marked `privileged=True`/`idempotent=False` so booking/submit actions are
never auto-retried).
**Tier:** core.

### P23 — Mark mutating browser actions `idempotent=False` / `privileged=True` so the framework never auto-retries them
**What:** At the tool-registration level (not just in the eval-gate logic), a booking/submit
action is tagged non-idempotent and privileged so that generic retry middleware in the agent
framework structurally cannot re-fire it (e.g. on a transient network blip that looks like a
failure but actually succeeded server-side — a classic double-booking bug).
**Why:** Retry-on-failure is a reasonable default for read tools (re-navigate, re-snapshot) but
actively dangerous for a submit/purchase action; encoding this as tool metadata (not a
convention someone has to remember) makes the safety property structural.
**How to implement:** Tool registration schema includes `idempotent: bool` and `privileged:
bool` fields; the dispatch/retry layer reads these flags and refuses to auto-retry anything
marked `idempotent=False` — it must instead surface the ambiguous state to the confirmation/HITL
layer.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:51` (Verso `tool.py:54-59`).
**Tier:** core.

### P24 — Password/secret redaction at the serializer layer, closing a real leaking bug
**What:** A concrete, named security gap: `ax_tree.py:153` was found to leak raw `value` for
`type=password` and card-like inputs into the snapshot returned to the model. Fix: redact any
password/secret/card-shaped field's `value` at serialization time (`[redacted]`), before the
snapshot ever reaches the LLM context.
**Why:** This is a live example of exactly the failure the CLI must design against from day one
— an a11y/DOM serializer is a strict superset of "what's on screen," including form field
*values*, which can include secrets typed by a human in an interleaved session or leaked from
autofill.
**How to implement:** In the snapshot serializer, before including any node's `value`/`text`
field, check `type in {password, ...}` or a card-number-shaped regex, and substitute
`[redacted]` — do this at the single choke point where nodes are flattened, not ad hoc at each
call site.
**Evidence:** `2026-07-06-travels-automation-from-aside.md:36,59` (named as security gap +
AUTO-1 fix item "(a) password/secret redaction (type=password/card-like → [redacted])
— security").
**Tier:** core.

---

## Command Surface (verbatim / near-verbatim, worth adopting)

- **Loop shape:** `snapshot → LLM picks ref → act(ref) → re-snapshot`, with `done` as a callable
  tool (not implicit).
  (`2026-07-08-agent-browser-and-evals.md:24-25`)

- **Actionability gate function name/shape:** `wait_until_actionable()` — gates
  `attached → visible → stable → enabled → hittable`; retry backoff literally `[0, 100, 200]ms`;
  stability polls at `16ms/32ms` intervals.
  (`2026-07-06-...md:25,60`)

- **Action class:** `PageActions.click(ref)` / `PageActions.fill(ref, value)` with **post-fill
  verification** (re-read `input.value`) and a native-setter (`_valueTracker`) fallback for React
  controlled inputs.
  (`2026-07-06-...md:60`)

- **Viewport constant:** `AUTOMATION_VIEWPORT = 1440x900` (fixed, always).
  (`2026-07-06-...md:26,60`)

- **Egress boundary function:** `assert_navigable(url)` — suffix-match allowlist check, raises
  on violation. Concrete test cases named: `m.getyourguide.com` → pass; `booking.com.evil.com` →
  blocked. 15 unit tests.
  (`2026-07-06-...md:62`, `tbrowse/allowlist.py`)

- **Confirmation object:** `ConfirmationRequest` — fields include price/dates/pax/cancellation +
  `material_change` (bool/detector) + `approval_valid_for` (TTL); semantics are **fail-closed**
  unless approved AND nothing material changed. 7 unit tests.
  (`2026-07-06-...md:62`, `tbrowse/confirmation.py`)

- **Act-safety gate:** `assert_safe_to_act(page_content)` — combines allowlist (hard) +
  `is_suspicious(...)` heuristic (soft, defense-in-depth only) → halt+handback. 3 unit tests.
  (`2026-07-06-...md:62`, `tbrowse/act_safety.py`)

- **CAPTCHA module:** `tbrowse/captcha_detect.py` — detect-only, never solve.
  (`2026-07-06-...md:62`)

- **Browser tool signature:** `browse_page(url) -> {ok, data, error}` — a single bounded op,
  navigates an allowlisted partner, settles, returns a **redacted** flat-refs snapshot.
  (`2026-07-06-...md:61`, `tools/browse.py::make_browse_page_tool`)

- **Eval metric:** `pass_k` — repeated-sampling success rate over a fixed task (e.g. "plan 3
  days in Lisbon"), graded by an independent judge ("WebJudge-style rubric"), calibrated target
  **~90%** (not a vendor-reported 99%).
  (`2026-07-08-...md:19-20`; `2026-07-06-...md:63`)

- **Snapshot diff format:** git-style unified diff (`@@` hunks) of the flattened snapshot
  between actions; literal sentinel `"No changes detected"` when nothing changed; falls back to
  full tree when the diff would be longer than the tree itself.
  (`2026-07-06-...md:23`)

- **State-enrichment tags on snapshot lines:** `[focused][checked][disabled][selected]
  [placeholder][size]`.
  (`2026-07-06-...md:23,59`)

- **Concurrency pool constant:** `max_size=3` semaphore on browser context pool; background tabs
  opened with `background:true, focus:false`.
  (`2026-07-06-...md:26,37`)

- **Config gating for a not-yet-safe tool:** a Chromium-touching, acts-on-untrusted-pages tool
  is **deliberately not registered** in the orchestrator until a "browsing phase" flag confirms
  the runtime is Chromium-ready — described as "structural absence," not a bug.
  (`2026-07-06-...md:61`)

---

## Anti-patterns (do NOT copy — explicit "do NOT build" list)

Verbatim cargo-cult list, called out by name as wrong-stage for a pre-PMF product (each item is
a real thing some browser-agent system in the corpus actually built, which is exactly why it's
worth naming here as a trap):

> Bi-temporal ADD-only memory · a simulation sandbox of fake OTA sites · Temporal-grade durable
> execution for a minutes-long confirm · best-of-N / model ensembles on the planning loop ·
> group-chat / multi-traveler surface · usage-based pricing/metering · RRF fusion + 4-tier TTL
> memory taxonomy · OTel/trace-context before evals exist · multi-model constellations /
> fine-tuning.
(`2026-07-08-agent-browser-and-evals.md:53-59`)

Additional anti-patterns named in the sibling doc's Verso "RESIST list":

> the on-device daemon / persistent local runtime; vault crypto / bespoke secret store; multi-
> channel routines / A2A message bus ("A2A is unsolved → not v1"); dreaming/sleep-time
> consolidation as core ("opt-in, not core"); skills-as-synthesis-engine.
(`2026-07-06-travels-automation-from-aside.md:53`)

Why these matter for the ultimate agent-browser CLI specifically:

- **A simulation sandbox of fake sites** is the most directly relevant trap for a browser-agent
  CLI — it's tempting to build a fake-site test harness for eval speed/determinism, but the
  source explicitly rejects this in favor of frozen **real-SSE-trace** corpora (P18). Simulated
  sites drift from real DOM/anti-bot behavior and give false confidence.
- **OTel/trace-context before evals exist** — don't build observability infra before you have a
  way to judge whether outcomes are good; the eval corpus IS the trace corpus you need first.
- **Best-of-N / model ensembles on the planning loop** and **multi-model constellations** — the
  source's own P20 finding (harness > model, 93% vs 88% on the *same* harness with a cheaper
  model) directly argues against spending complexity budget on multi-model tricks before the
  harness itself is solid.
- **Temporal-grade durable execution for a minutes-long confirm** — over-engineering durability
  for a task duration where a simple checkpoint-resume (P: "promote to durable with one flag,
  never a rewrite" — the tactical↔durable seam) suffices; only promote once evals show the
  returns justify it (explicit build-order step AUTO-6, gated behind evals passing).

### Additional structural anti-pattern (own-doc self-correction, not a list item but worth
extracting): **guarding against non-existent state.**
The 2026-07-08 doc explicitly flags that four previously-planned "reliability fixes"
(`repair_history` / output-offload / `classify` / source-first) were found to **defend states
that don't exist** in the actual system — e.g. guarding against assistant `tool_use` blocks being
persisted mid-stream, when in fact they're never persisted mid-stream at all in this
architecture. The corrective habit: before building a reliability/recovery mechanism, verify the
failure state it guards against is actually reachable in the real system, not just
theoretically possible in the abstract architecture.
(`2026-07-08-agent-browser-and-evals.md:78-81`)

### Anti-pattern: treating a defended-commerce site as a scraping target instead of routing to an affiliate channel
The doc found that "Activities" (GetYourGuide/Tiqets) scraping was ToS-exposed, forfeited
commission, and literally 403'd — its stealth tier (`scrape/tier2_stealth.py`) is **dead code,
zero call sites**. The fix was routing to the existing affiliate deeplink builder instead. For a
general-purpose agent-browser CLI: recognize when a target site has a paid/affiliate API path and
prefer it over adversarial scraping — the source calls the residential-IP + CAPTCHA-solver combo
required for defended commerce scraping "themselves paid third-parties that even Browserbase
refuses to self-host."
(`2026-07-08-agent-browser-and-evals.md:8-16,72-75`)
