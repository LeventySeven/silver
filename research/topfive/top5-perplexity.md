# Top 5: What Perplexity Computer/Comet Does Better

Source: `/Users/seventyleven/Desktop/researchfms/teardowns/PERPLEXITY_COMPUTER.md` (5,067 lines).
Silver source read: `src/security/injection.ts`, `src/security/confirm.ts`, `src/security/egress.ts`,
`src/task/index.ts`, `src/orchestration/subagent.ts`.

---

## 1. BrowseSafe — ML-classifier injection defense with async two-stage escalation

**What (teardown lines 1871–2079):** Every tool that fetches external web content
(`fetch_url`, `browser_task`, `get_full_page_content`, `screenshot_page`) routes its
output through BrowseSafe before the agent sees it. Stage 0 strips AI-annotation
wrapper fields, keeping only raw HTML (classifying extracted text instead of raw HTML
causes a measured F1 drop). Stage 1 is a dedicated fine-tuned classifier —
Qwen3-30B-A3B-Instruct-2507 (MoE, ~3B active params), SFT'd to emit a single
"yes"/"no" token, F1 0.904 on a 3,680-sample benchmark, <1s latency. Long HTML is
split into non-overlapping token chunks classified in parallel with conservative OR
aggregation (any VIOLATES chunk flags the whole doc). Stage 2 escalates boundary
cases (near the 1% FPR operating threshold) to a frontier LLM (GPT-5 ~2s, Claude
Sonnet 4.5 ~23–36s) with two verbatim safeguard prompts (arXiv Appendix A.4/A.5).
Crucially, classification runs as an **async task concurrent with the LLM's own
planning phase** — the safety overhead is hidden behind inference latency, not
serial. On VIOLATES, the tool's raw output is **replaced** (not appended/tagged)
with a placeholder that names the blocked URL but never repeats the payload text
— avoiding re-exposing the injection to the model's attention.

**Why:** This directly closes the exact class of attack Silver's own confirm gate
guards against downstream (PerplexedBrowser, teardown lines 2935–2988: a Hebrew-
language calendar-invite payload smuggled instructions past English-only filters,
then had the agent read `~/.ssh/id_rsa` and exfiltrate via POST — root cause was
"LLM merged trusted user context and untrusted web content in the same context
window without trust boundary enforcement").

**Silver has (partial):** `src/security/injection.ts` — `neutralize()` regex-strips
forged transcript-role tags (`<system>`, `</assistant>`, `<untrusted…>`) and wraps
all page-derived output in stable Unicode fence markers (`⟦page-content
untrusted⟧…⟦/page-content⟧`), including de-fanging any literal fence glyphs the
page itself contains so a hostile page can't forge the closing boundary. This is a
real, load-bearing defense against the "impersonate the transcript" injection
vector and it's applied by the CLI to every snapshot/get-text/read/console call
(task/index.ts's `present()` helper reuses it, confirming universal application).

**GAP: Silver should adopt —** BrowseSafe is a *semantic* classifier (does this
content try to manipulate agent behavior or exfiltrate data?), not a *syntactic*
one (does this content contain forged role tags?). `neutralize()` only catches
injections that literally impersonate transcript structure — it does nothing
against a plain-English or non-English instruction embedded in ordinary page
prose ("Ignore prior instructions and…", or PerplexedBrowser's Hebrew-language
payload). Silver is keyless by design, so it cannot run BrowseSafe's fine-tuned
model itself, but it could: (a) ship a lightweight local heuristic/keyword-and-
pattern layer for common injection phrasings as a second pass alongside
`neutralize()`, and (b) more importantly, expose an explicit `--classify-injection`
escape hatch or documented pattern where the calling host LLM itself is asked to
classify fetched content before acting on it — i.e., make the async-classify
architecture (fetch → classify concurrently with next-step planning → gate) a
documented CLI *pattern* for host LLMs to follow, since Silver can't embed the
classifier but can structure the tool-output contract so hosts follow the same
discipline. Currently there is no explicit gate step or placeholder-replacement
convention comparable to BrowseSafe's "replace, don't append" rule — a host that
naively echoes `neutralize()`'d output still sees the substance of the injected
text, just de-fanged of role-tag syntax.

---

## 2. Task decomposition — leader/meta-router with a dependency-aware task graph

**What (teardown lines 1411–1477):** The leader agent (Claude Opus 4.6) plans
upfront into an explicit graph: `{id, type, dependencies[], parallel_ok}` per
subtask. Independent tasks (`dependencies: []`) dispatch simultaneously into
separate Firecracker sandboxes; dependent tasks block until prerequisite outputs
land on the shared filesystem (`/home/user/workspace/{id}.json`), then get those
outputs injected into context. The leader can revise the plan mid-execution on
sub-agent error. A confirmed demo showed 10 competitor-research subtasks spawned
in parallel, each a separate `/v1/responses` call with its own model assignment
(Gemini 3.1 Pro for research, Claude Sonnet 4.6 for coding, Grok 4-1-fast for
simple/latency-sensitive work) — a genuine multi-model routing layer, not a
single model doing everything serially.

**Why:** This is real cost/latency optimization via heterogeneous model routing
plus real parallelism with dependency correctness (never runs t3 before t1+t2
land).

**Silver has (by design, delegated):** Silver is keyless — it never plans or
routes models itself; the *host* LLM is the planner. `src/task/index.ts` is
purely an artifact/scaffold store: `task start` creates `plan.md` + `action_log.jsonl`
+ `checkpoint.json`; `task log`/`checkpoint`/`resume` let the host record and
recover progress. `src/orchestration/subagent.ts` gives real parallel execution
primitives — `spawn` reserves an isolated child session or tab (own DOM, own
browser optionally), enforces a concurrency cap of 5, one-level-only nesting via
`SILVER_SUBAGENT_DEPTH`, and `wait` blocks on child status files. This is a
legitimate parallel-dispatch primitive Perplexity's teardown doesn't need to
build (they own the orchestrator; Silver hands the primitive to whatever host
model is orchestrating).

**GAP: Silver should adopt —** Silver has the *plumbing* for parallel dispatch
(`subagent spawn`/`wait`) but no *dependency graph* concept at all — no way to
express "child C depends on children A and B's output" declaratively, so the
host LLM must hand-roll dependency ordering itself every time by polling
`subagent wait <A> <B>` before spawning C. A `task graph` or `subagent spawn
--after <id>,<id>` primitive that records dependency edges and blocks
automatically would close this gap without violating keylessness (it's pure
bookkeeping, no model call). This is a genuine capability gap, not a design
choice — Silver's task store already tracks state that could carry a
`dependencies: []` field the way Perplexity's task_list does.

---

## 3. Verification via mandatory pre-execution confirmation + condition-based pauses

**What (teardown lines 1523–1531, 4331, 4360):** Two related mechanisms.
`confirm_action` is a **mandatory pre-execution gate** for irreversible operations
(email send, git push, deploy, file delete, external API mutations) — surfaced to
the user with a description before executing, not after. `pause_and_wait` has two
modes: `HUMAN_APPROVAL` (mid-loop review checkpoint, semantically distinct from
`confirm_action` only in being mid-loop vs pre-gate) and `CONDITION_BASED` (polls
external state — email arrival, file change, flight status, calendar trigger —
used for "monitor X and act when Y happens" patterns).

**Silver has (equivalent or stronger on the gate, absent on condition-based
pause):** `src/security/confirm.ts` implements essentially the same mandatory
pre-execution gate, and does it more conservatively: `MUTATING_VERBS` (click,
fill, type, select, upload, download, eval, drag, …) all require confirmation;
`isDestructivePaidName()` adds a second narrow regex gate
(`buy|purchase|checkout|pay|payment|order|delete|remove`) applied post-grounding
to catch destructive/paid controls by accessible name. The key difference: Silver
**fails closed on non-TTY** — `confirmGateDecision()` denies any mutating verb
outright unless pre-approved via `--confirm-actions`, when there's no human to
prompt. This is arguably stricter than Perplexity's model (which surfaces a UI
checkpoint but doesn't document a fail-closed default for headless/API-driven use).
Silver has no `CONDITION_BASED` pause primitive — no built-in "poll until X" loop
tool (though `task checkpoint`/`resume` gives the durable state Perplexity's
S3-snapshot pause/resume gives, just without an automatic external-condition
trigger).

**GAP: Silver should adopt —** a `wait --until <condition>` polling primitive
(Perplexity's `CONDITION_BASED` pause) is missing. Silver has `wait --fn` per the
comment in `task/index.ts` referencing it as already actor-gated elsewhere, so the
scaffolding may partially exist — worth confirming whether it supports polling an
arbitrary DOM/network condition with backoff, or only a fixed timeout. If it's
timeout-only, that's the gap: no monitor-and-fire-on-condition capability
comparable to Perplexity's flight-status/email-arrival triggers.

---

## 4. Vision-based control as an explicit dual-mode fallback

**What (teardown lines 4041–4050, 4618):** Perplexity's Mac "Personal Computer"
mode uses **dual-mode app control**: native API where available, and a documented
vision-based fallback (screenshot → multimodal cloud model → pixel-coordinate
click/keystroke/scroll dispatch via macOS Accessibility injection) for arbitrary
apps with no API surface. The Comet browser agent's own leaked system prompt
(lines 3144–3145) makes the fallback rule explicit: "Operate via x,y coordinates
when target elements are present in latest screenshot. When elements are NOT
present in the last screenshot, use the `read_page` tool to retrieve [DOM/AX
tree]." This is a **documented, prompt-level gating rule** — coordinates first
when visible in the screenshot, structured DOM query as the fallback — not an
undocumented heuristic.

**Why:** This is a real reliability lever: screenshot+coordinates is fast but
brittle to layout drift; DOM/AX-tree queries are robust but slower/costlier.
Explicitly gating between them by "is it in the last screenshot" is a genuinely
useful pattern for any agent CLI mixing perception modes.

**Silver has (different default, same raw capability, no gating rule):** Silver's
`src/perception/` (walk.ts, serialize.ts, accessible-name.ts, roles.ts, diff.ts,
refmap.ts) is accessibility-tree-first by construction — snapshots are structured
AX-tree serializations, not screenshots, which is the token-efficient design
choice the project is explicitly optimizing (per the project brief: "token-
efficiency = a property of the snapshot format"). `task checkpoint` in
`src/task/index.ts` does capture a raw screenshot (`captureScreenshot()`,
best-effort, degrades to null if no live browser) purely as a durable artifact
for a human/host reviewing the run later — it is not fed back into perception or
action-grounding. So Silver has the primitive (screenshot capture exists) but
zero vision-gating logic: no rule anywhere for "when should the host fall back to
pixel coordinates because the AX tree failed to expose an element."

**GAP: Silver should adopt (narrow) —** since Silver is keyless and can't itself
decide "is this element visible in a screenshot," it can't replicate Perplexity's
model-driven gate. But it could document the equivalent CLI-level fallback
contract explicitly (e.g., "if `find`/`snapshot` returns no match for a described
element, take a `screenshot` and hand it to the host for manual coordinate
grounding, then use `click --x --y` if that verb exists") so host LLMs have a
consistent, discoverable fallback path instead of improvising one per-session.
Worth confirming whether Silver's actuation layer (`src/actuation/`, not read in
this pass) exposes raw x,y click/coordinate verbs at all — if it's AX-ref-only
with no coordinate fallback, that's a harder capability gap, not just a
documentation gap.

---

## 5. Trust-boundary enforcement as the stated root cause of a real CVE-class bug

**What (teardown lines 2935–2988, PerplexedBrowser):** Zenity Labs' disclosed
attack chain is instructive precisely because Perplexity's own post-mortem names
the root cause architecturally, not as "a bug": *"the LLM merged trusted user
context and untrusted web content in the same context window without trust
boundary enforcement."* The fix was two-pronged: (1) `isUrlBlocked()` updated to
block `file://` protocol access outright at the tool layer, (2) BrowseSafe added
as the semantic classifier layer (item #1 above). Notably the `file://` block is
a **hard tool-level denylist**, independent of the ML classifier — defense in
depth, not reliance on the classifier alone.

**Why it matters as its own item (distinct from #1):** the lesson isn't just
"have a classifier" — it's "never let a single defense layer be the only thing
between untrusted content and filesystem/credential access." Perplexity needed
both the hard `file://` denylist AND the semantic classifier; neither alone
would have stopped both exploit variants (file exfiltration used `file://`
access; credential theft used an authorized MCP connector, not import — for that
their fix was the trust-boundary/classifier layer, since the 1Password call
itself was legitimately authorized).

**Silver has:** `src/security/egress.ts` — `assertNavigable()` /
`assertNavigableResolved()` and `isBlockedAddress()` implement exactly this
class of hard denylist at the navigation layer (blocking private/internal
addresses — SSRF-class protection), and `assertContainedPath()` sandboxes
file-path targets to a root directory, which is Silver's analog to blocking
`file://` escape. Combined with `neutralize()` (item #1) and the fail-closed
`confirm.ts` gate (item #3), Silver already has defense-in-depth across three
independent layers (network egress denylist, filesystem path containment,
prompt-injection syntactic scrub) — structurally the same "don't rely on one
layer" philosophy PerplexedBrowser's post-mortem argues for.

**GAP: none structural, one depth gap** — the missing piece is exactly item #1's
gap: Silver's third layer (`neutralize()`) is syntactic, not semantic, so the
"intent collision" failure mode from PerplexedBrowser (malicious instructions in
ordinary prose treated as legitimate task) isn't fully covered by Silver's
current three layers the way BrowseSafe covers it for Perplexity. The egress and
path-containment layers are solid and comparable; the semantic-classification
layer is the one gap repeated across items #1 and #5.

---

## Summary Table

| # | Capability | Silver status |
|---|---|---|
| 1 | BrowseSafe semantic ML injection classifier | **GAP** — Silver has syntactic tag-stripping only (`injection.ts`); no semantic classifier or async escalation pattern |
| 2 | Dependency-aware task decomposition graph | **GAP** (partial) — parallel dispatch primitives exist (`subagent.ts`), no declarative dependency-edge tracking |
| 3 | Condition-based pause/monitor trigger | **GAP** — no confirmed `wait --until <condition>` poll-and-fire primitive found |
| 4 | Vision-based fallback gating rule | **GAP** (narrow) — screenshot capture exists (`task.ts`) but no documented/enforced perception-fallback contract |
| 5 | Defense-in-depth trust boundaries | **Silver already has this** — `egress.ts` + `confirm.ts` + `injection.ts` mirror the three-layer philosophy; only the semantic-classifier layer (shared with #1) is missing |
