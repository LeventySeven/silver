# Agent-design patterns for Silver: context engineering, harness-as-moat, verification, multi-agent orchestration, error-UX

Sources read in full this pass: `/Users/seventyleven/Desktop/researchfms/Transcripts/TRANSCRIPTS_CLAUDE.md`
sections 1, 4, 5 (lines 206–2101 — "Tool, skill, or subagent?" agent-decomposition workshop,
"How we Claude Code" HTML/DOM-contract verification talk, "The prompting playbook" evals/failure-mode
walkthrough); `/Users/seventyleven/Desktop/BAD_GUIDE.md` lines 255–635 ("Directing agent fleets &
harness engineering" annotations, the Cognition multi-agent pair, Thorsten Ball's "agent loop is not
the moat," Sierra/Lindy/Ronacher harness accounts). Cross-checked against Silver's actual
`src/core/envelope.ts`, `src/core/errors.ts`, `src/orchestration/subagent.ts`, and prior digests
(`deepdive/transcripts-{1,2,3}.md`, `deepdive/anthropic-skills-{1,2}.md`, `synthesis/skill-design.md`)
to isolate what is genuinely new territory. Those prior passes already mined: Claude Code's skill
matching/loading mechanics (`transcripts-badguide.md`, `anthropic-skills-1/2.md`), sub-agent
skill-inheritance (`transcripts-1.md` C1), tool-shape/MCP economics (`transcripts-1.md` A4-A5),
tombstoning/eviction (`transcripts-1.md` A7), Momentic/Comet decomposition rules (`transcripts-2.md`),
and harness-daemon/retry patterns (`transcripts-3.md`). This digest does not repeat those; it mines
the CLAUDE.md "Tool, skill, or subagent?" workshop (an unmined, load-bearing primary source — an
Anthropic engineer's own agent that regressed from accretion and was fixed live), the DOM-contract
verification talk, the prompting-playbook failure taxonomy, and BAD_GUIDE's harness-as-moat essay
annotations (Cognition, Ball, Ronacher, Sierra) — none of which appear in any prior Silver digest.

## 1. The accretion failure mode, and why it is Silver's own long-term risk, not just a customer's

The single most load-bearing new finding is Anthropic's own "Stock Pilot" case study
(`TRANSCRIPTS_CLAUDE.md:211-663`). An Applied-AI engineer's inventory agent shipped well, then
accreted capability weekly until its system prompt hit ~400 lines, 12 tools (3 of them
sub-agent-wrapping-tools), and eval pass rate fell from 83% to 62% on a live re-run. The root causes,
independently traced per failing eval:

- **F1 (inefficiency, not incorrectness)**: the agent reached the right answer via "a very winding
  path" — a tool-sourcing problem (see §2), not a reasoning problem.
- **F2 (orchestrator↔sub-agent communication breakdown)**: the sub-agent got its own sub-task right,
  but "a lot can get lost in translation" passing results back up — described as "a really common
  point of failure" once you have "complicated systems with many sub-agents." This is the exact
  failure class LangChain's typed-result pattern (already flagged in `transcripts-3.md` §5) exists
  to prevent, now independently corroborated from Anthropic's own internal post-mortems.
- **R8 (hallucinated policy, traced to a context conflict, not a capability gap)**: two contradictory
  policies living in different parts of a long system prompt caused the model to substitute `1.35`
  for the correct `3.1x` promotion multiplier — both numbers were correctly retrieved, the
  arithmetic step hallucinated because "the information surrounding the model" was self-contradictory.
  Diagnosis stated explicitly: **"this isn't a model problem."**

**Applicability to Silver.** Silver is a CLI, not a system prompt, so it cannot accrete a "long
system prompt" the way Stock Pilot did — but `skill-data/core/SKILL.md` (379 lines, already near
the 500-line ceiling per `anthropic-skills-1.md`) is exactly the artifact this failure mode targets,
and Silver's own command surface (11+ interaction verbs, `extract`, `subagent`, `session`, `resolve`)
is the tool-count axis. The concrete, keyless, doc-only lesson: **every time a new verb or flag is
added to Silver, ask which of the three fixes below it should have been instead** — this is a
review discipline, not a one-time fix. Recommend adding a short "before adding a new command" note
to Silver's own CONTRIBUTING/design doc citing this exact case study, since Silver is now mature
enough (235 tests, eval-gated) to be at genuine risk of the same accretion curve as it adds
Browserbase/Stagehand-inspired features from prior digests (record/replay, action log, daemon mode,
etc.) — each is a legitimate add, but the Stock Pilot lesson is that legitimacy-per-feature does not
prevent aggregate degradation. **Priority: P1, doc-only, zero code risk.**

## 2. The tool-sourcing decision ladder — a concrete, ordered rule Silver's docs currently lack

Will's fix for Stock Pilot's F1 (inefficient path) generalizes into an explicit **ordering
rule** (`TRANSCRIPTS_CLAUDE.md:442-456`), stated as Anthropic's own internal default:

1. **Human-like primitives first**: code execution, file-system navigation, a to-do list, web
   search. "These are foundational tools that we always start with when we build agents, and we
   remove them as needed."
2. **Custom/standalone local tools second** — built only for this agent.
3. **MCP last, and only when multiple clients need the same governed tool set** — explicitly
   flagged as an anti-pattern when done first: "we see a lot of folks run towards MCP first... they
   end up in this ecosystem where there's a lot of chaotic MCP servers... a lot of times they have
   overlap, which can create some problems."

The measured payoff of following this ladder for Stock Pilot: **200,000+ tokens on a task before →
"dramatically" less after**, by replacing "upload the entire CSV into Claude's context window" with
"give Claude a bash tool so it can write a quick Python script and reason across the results."

**Applicability to Silver.** This is a *host-side* rule (it governs what tools the host LLM's own
agent harness should reach for), but Silver's `skill-data/core/SKILL.md` is precisely the artifact
that should teach a host this ordering when the task at hand is browser-shaped. Concretely: Silver
already occupies rung 2 (custom/standalone local tool) correctly — it is not an MCP server bolted
onto everything, it is a CLI a host invokes directly via Bash, which is *already* closer to rung 1
("code execution," per Fix 2's own framing that Claude Code's primitives ARE "file system + Linux
CLI + code execution," independently corroborating `transcripts-1.md` A8's "unhobbling" finding).
The gap: Silver's skill text never states *why* a host should prefer `silver extract --instruction
"..."` (which returns structured JSON, rung-1-shaped) over the host writing raw
`page.evaluate()`-style ad hoc DOM scraping via its own code-execution tool, when both are technically
available to a code-executing host. **Adopt (doc-only, P2)**: one sentence in the extract section of
`SKILL.md`: "Prefer `silver extract` over hand-rolled DOM scraping via your own code-execution tool —
it is the tested, schema-validated, injection-neutralized path; treat it the way you'd treat a
vetted library function over rewriting it inline."

## 3. Sub-agent design: three concrete triggers, and the newly-corroborated "just fold it into the
main agent" option Silver's docs are silent on

Will's talk gives the clearest primary-source statement anywhere in this research program of *when
a sub-agent earns its complexity cost* (`TRANSCRIPTS_CLAUDE.md:457-494`), with three options, not
two:

- **(a) Parallelize** — "throw a lot of Claude at a problem" (deep research, codebase exploration).
- **(b) Fresh mind / isolation** — "I do not want to be the same person that is writing and also
  reviewing my code" — keep the reviewer's context uncontaminated by the writer's reasoning trace.
  Stock Pilot's kept forecasting sub-agent is this case: "I don't want anything in my initial
  context window to distort the forecasting process."
- **(c) Scrap it and fold the capability into the main orchestrator** — explicitly framed as
  *increasingly the right choice*, not a fallback: "frontier models have gotten intelligent enough
  to manage across more information where you just don't need as many sub-agents... a lot of
  customers [are] actually just consuming capability into their main orchestrator." Stock Pilot did
  exactly this to its other two sub-agents (report-writing, one more), keeping only the
  forecasting one.

This directly extends and sharpens the Cognition pair from BAD_GUIDE (`BAD_GUIDE.md:565-568`),
which Silver's prior digests never mined: Walden Yan (built Devin's harness) argues in "Don't Build
Multi-Agents" for the **single-threaded-context position** — "share the full agent trace, not only
the messages, and accept that parallel agents make conflicting implicit decisions that produce
broken output" — then, ten months later in "Multi-Agents: What's Actually Working," updates the
thesis: **multi-agent works only when writes stay single-threaded and the extra agents add
intelligence (review loops, hierarchical delegation) rather than actions.** This is precisely
Will's option (b) — a reviewer/forecaster that reads but does not itself mutate shared state — and
precisely NOT option (a) applied to write-heavy work.

**Applicability to Silver.** Silver's `subagent.ts` already enforces the hard invariants (CAP=5,
ONE-LEVEL nesting, own-context-per-agent — verified at `src/orchestration/subagent.ts:13-22`) that
make option (a) safe when the host chooses it. What Silver's skill text is silent on is **the
decision itself** — nothing in `SKILL.md` tells a host *when* to reach for `subagent spawn` versus
just driving more of the task in its own single session. Given the Cognition + Anthropic convergence
(both independently landing on "isolation for review, not for parallel writes, is the safe case"),
**adopt (doc-only, P1)**: add a short decision note to Silver's Subagents section distinguishing
"parallel gather across independent read-only targets" (Silver's existing PARALLEL recipe — safe,
already the CAP-enforced case) from "spawning a child to mutate a *shared* target concurrently with
the parent" (the Cognition-warned failure mode — two agents filling the same cart, submitting the
same form, or editing the same session state can produce "conflicting implicit decisions" even
though Silver's own-session-per-child invariant technically prevents literal state corruption,
because the *external* website/target state is still shared and order-of-operations-sensitive).
This is the one place Silver's existing invariants (own-context) don't fully cover the Cognition
warning (own-target still shared) — worth a one-line caveat: "own-context-per-child prevents Silver
state corruption; it does NOT prevent two children racing to mutate the SAME external page/account —
sequence writes to a shared target, parallelize only independent reads."

## 4. The DOM-contract verification pattern — a genuinely novel, keyless, adoptable idea for Silver

`TRANSCRIPTS_CLAUDE.md:1465-1704` (the "How we Claude Code" talk) describes a verification technique
Silver's prior digests never touched: instead of an agent inferring app state by scraping the DOM's
*implementation* structure, the target app **publishes a separate, stable "verify" contract into the
DOM** — e.g. `data-verify` attributes carrying `total`/`done`/`active` counts — that the agent reads
instead of the React internals. "By publishing the state here separately from the React internals,
you'd be able to run the verification independently of whatever the state of the app is." The talk
demonstrates two failure classes this catches that a naive DOM read cannot distinguish: (1) the app
itself is broken (a real bug — 3+4≠10), and (2) **the contract is broken but the app isn't**
(deleting the `data-total-stats` emission) — both surface as "verification failed," but only the
second is a false alarm about the underlying app, and a host needs to tell them apart.

**Applicability to Silver.** Silver cannot make third-party sites publish a verify contract (Silver
doesn't control the target page). But the *pattern itself* — a stable, purpose-built state surface
that is deliberately decoupled from the page's actual implementation, read by the agent as ground
truth — maps directly onto Silver's own `RefMap`/generation-stamped snapshot model, and suggests a
genuinely new, fully keyless capability: **when Silver's own `extract` is used against a page under
active development** (Silver's `skill-data/core/SKILL.md` already documents dev-loop usage: build →
open localhost → snapshot → interact → verify, per `transcripts-1.md` A6's OSWorld point and
Silver's own recipe set), a host driving Silver against its own just-built UI could be told to
instrument that UI with cheap `data-silver-verify-*` attributes analogous to the talk's `data-verify`
pattern, and Silver's `extract`/`snapshot` would then read those attributes preferentially over
inferring state from arbitrary DOM structure — closing exactly the "did I break the app, or did I
break my scraper's assumptions about the app" ambiguity the talk demonstrates. **This is a
documentation-only recommendation for now** (a recipe pattern in `SKILL.md`'s self-QA/testing
section, once named per `transcripts-badguide.md`'s already-identified GAP that self-QA isn't a
named recipe): "when testing your own just-built app with Silver, have it publish a small
`data-silver-*` state contract (counts, current-step, error-flag) — Silver's extract can then ground
on that contract instead of re-deriving state from markup, the same technique Anthropic's own Claude
Code team uses to verify its front-end changes." **Priority: P2** (real, novel, but requires the
target app's cooperation, so it's a documented technique/recipe, not a Silver mechanism change) —
worth flagging as the single most "new idea" finding in this pass, distinct from every prior
digest's Browserbase/Stagehand/browser-use-sourced adopt list.

## 5. Evals as the "bridge from vibes to actionable," and Silver's specific eval gap sharpened

`TRANSCRIPTS_CLAUDE.md:666-865` (the slide-generation evals talk) and `:1801-2101` (the prompting
playbook) both reinforce and sharpen — beyond `anthropic-skills-1.md`'s already-identified P0 gap
("no eval harness at all... nothing verifies the skill's description field actually triggers
correctly across weaker vs stronger host models") — two specific, previously-unmined mechanics
worth folding into Silver's eventual eval build:

- **The grader taxonomy, with an explicit warning against padding it.** Code-based graders (fast,
  cheap, deterministic, but brittle/no-nuance) should be used for binary presence/format checks
  ("does a slide deck exist," "did `extract` return valid JSON matching the schema"); model-based
  graders (judge/pairwise/multi-judge-consensus) for nuance; human graders least often, for spot
  checks. The explicit rule for **avoiding eval bloat**: "if you have a grader that you get no
  useful information out of, you should not have that part of your eval" — every grader must answer
  a specific, statable "what do I act on if this fails" question. For Silver, this argues an eval
  suite should be code-based-grader-heavy (Silver's outputs are structured JSON envelopes, not
  free-text — nearly every Silver eval case is naturally a code-based grader: did the envelope
  succeed, does the returned ref resolve, is the JSON schema-valid, did the action complete within N
  retries) with model-based grading reserved for the rarer "is this extraction result actually
  correct/complete" nuance case.
- **Evals are a living artifact, and calibration failures are common and expected, not a sign the
  eval methodology is broken.** The talk's own worked example: a judge scored an admittedly-bad
  slide deck 2.8–4.0/5 (miscalibrated), then after a genuine improvement, `emoji_count` (a
  code-based grader) spiked from 4 to 20 in a way the human reviewer hadn't visually noticed —
  exposing that the grader itself, not the app, needed fixing. **Lesson directly transferable to
  Silver's eventual eval build**: expect the first-pass eval graders to need their own debugging
  pass before they're trustworthy signal — budget for a calibration round, don't treat grader
  output as ground truth on the first run.
- **The three-case-type structure** (control / edge-case-from-past-failure / capability-boundary —
  "must know when to hand off... when to point-blank refuse") is a clean, directly-reusable template
  for Silver's eval design once built: a control case (`click` on a known-good ref succeeds), an
  edge case seeded from a real prior bug (e.g. a stale-ref race Silver's own test suite already
  catches), and a capability-boundary case (Silver's own destructive/paid-action confirm-gate
  refusing without `--confirm-actions` — already a tested boundary, per `transcripts-2.md`'s
  confirmation that `destructivePaidBlocks()` is wired through three call sites).

**Priority: P1** — this doesn't change the underlying P0 (build the eval harness), it sharpens *how*
to build it once undertaken, closing a "what should the graders actually look like" gap the prior
digest left open.

## 6. "Instructions don't add capability" — the sharpest single line for Silver's own doc-writing discipline

The prompting-playbook's proration failure mode (`TRANSCRIPTS_CLAUDE.md:1908-1926`) is the cleanest,
most quotable finding in this pass and applies directly to how Silver's own skill content should be
worded going forward: telling a model "critical: always calculate any prorated amounts correctly"
did nothing, because "telling the model to do a good job isn't helpful when you don't give it the
capability to do a good job" — the fix was giving it an actual `calculate_proration` tool, not a
stronger instruction. **"Instructions don't add capability."**

**Applicability to Silver.** This is a design-hygiene check Silver's skill-authors (and any future
contributor) should run against every new sentence added to `SKILL.md`: is this sentence telling the
host to try harder at something it structurally cannot do reliably (mental-math-equivalent DOM
inference, remembering ref validity across host-side context compaction, precise element targeting
without grounding), or is it pointing the host at a Silver command/flag that actually gives it the
capability? Two concrete existing examples where Silver already gets this right (worth citing as the
positive pattern, not just the risk): `extract` replaces "carefully read the page and compute X" with
a tool call; `page_changed`/`stale_refs` flags replace "be careful, the page might have changed" with
a structural signal the host can branch on programmatically. One place worth auditing against this
rule: any hedge-y prose in Silver's Hard Rules ("be careful with destructive actions," "make sure you
resolve refs correctly") that isn't backed by an actual mechanism (the confirm-gate, generation-scoped
refs) should be either deleted (redundant caution reads as noise per the accretion lesson in §1) or
converted into a pointer at the mechanism that actually enforces it. **Priority: P2, doc audit only.**

## 7. Withholding, not just hallucinating — a distinct error class worth naming in Silver's error taxonomy discussion

The hotspot failure mode (`TRANSCRIPTS_CLAUDE.md:1896-1920`) names a failure class distinct from
hallucination: a model given correct data (`5 GB` hotspot allowance) *withheld* it and deflected to
a URL instead, because an earlier defensive instruction ("never give a customer the wrong plan
details — instead, point them to the URL," originally patched in for a weaker model) had become
over-fit. **"We worry a lot about hallucinations, but actually the opposite can also happen. The
model can withhold information it actually has access to."**

**Applicability to Silver.** Silver itself doesn't generate prose the way a customer-support agent
does, so this doesn't map onto Silver's own output — but it maps onto a governance practice worth
adopting for Silver's own accreted defensive rules: **version-control every defensive addition to
`SKILL.md`'s Hard Rules with a one-line "why this was added" comment**, exactly as the talk
recommends ("wherever we are making defensive changes in the prompt, we are tracking the reason why
we've introduced these... so we can backtrack on them"). Silver's security/injection rules
(boundary glyphs, destructive-action gating) are the closest analog — each was added for a specific
threat model, and as Silver's own command surface and the host models driving it both get more
capable, some of today's defensive phrasing may become the redundant-patch-that-overfits case this
talk warns about. **Priority: P3 — process recommendation (inline comments in the skill source
noting why each Hard Rule exists), not urgent, but cheap and prevents future silent over-restriction.**

## 8. "The agent loop is not the moat" — reframes what Silver should actually protect

Thorsten Ball's "How to Build an Agent" (`BAD_GUIDE.md:570`) — the agent core is "a model, a loop and
three tools in ~315 lines of Go," and "every hard, valuable thing lives elsewhere: editor
integration, prompt craft, feedback timing, orchestration." Read alongside Anthropic's own "Effective
harnesses for long-running agents" essay annotation (`BAD_GUIDE.md:270-271` — "the harness is the
layer that compounds across model generations while the model stays swappable... a feature-list-as-
executable-spec the agent may toggle but not edit, git-as-state-machine for recovery, a progress file
as memory across context windows, and a dual initializer/worker split") and Sierra's reliability
account (`BAD_GUIDE.md:606` area — "models detect their own errors better than they avoid making
them, so they chain supervisor agents to compound past the per-model ceiling, and run a conversation
simulator that turns every fix into a permanent regression test"), the consistent claim across three
independent sources is: **the moat is not the loop/verbs themselves, it is the accumulated,
model-agnostic scaffolding around failure recovery, state durability, and regression-locking of past
fixes.**

**Applicability to Silver.** Silver's own core thesis ("host LLM is the brain, Silver never calls a
model") already IS the "swappable model, compounding harness" bet these sources independently
converge on — this validates Silver's architecture rather than gapping it. The concretely
actionable piece Silver is missing relative to Sierra's "conversation simulator that turns every fix
into a permanent regression test": Silver's own 235-test suite plays this role for Silver's *own*
code, but there is no equivalent mechanism for a *host*'s learned fixes — e.g. if a host discovers
that a particular site requires a specific sequence (dismiss cookie banner before interacting with
the form), that learning currently lives only in the host's own memory/notes (Silver's grep-first
memory store, already documented), not as something Silver itself locks in as a regression case.
This is out of scope for Silver to solve directly (Silver is deliberately not a test framework), but
worth a documentation nudge: Silver's memory-store guidance in `SKILL.md` could explicitly borrow
Sierra's framing — "treat a site-specific gotcha you discover as a permanent regression note in
memory, not a one-off aside, the same way Sierra logs every human fix as a new simulator turn." Ties
directly to Silver's existing grep-first memory feature, reframing an existing mechanism with a
sharper mental model rather than proposing new code. **Priority: P3, framing/doc only.**

## 9. Armin Ronacher's "reinforce the objective on every tool return" — an error-UX check for Silver's envelope design

BAD_GUIDE's annotation of "Agent Design Is Still Hard" (`BAD_GUIDE.md:272-273`) names a pattern not
covered in any prior Silver digest: "reinforce the objective on every tool return rather than once
up front, and isolate failures in throwaway sub-agents that report only outcomes." The first half is
a context-engineering claim about tool *output* design specifically (not input/description design,
which `transcripts-1.md` A5 already covers) — a tool's return payload is an opportunity to
re-anchor the host, not just relay a result.

**Applicability to Silver.** Checked against Silver's actual `src/core/envelope.ts`: the `fail()`
envelope already carries a fixed 4-key shape (`success, data, error, warning?`) with sanitized,
deterministic error codes (`src/core/errors.ts`), and per `transcripts-3.md` #3's still-open
recommendation, currently lacks a forensic `hint` bundle on actuation failures. Ronacher's point
sharpens that recommendation: the hint field shouldn't just describe what went wrong (the forensic
bundle already proposed), it's an opportunity to restate the invariant the host should re-orient
around — e.g. a `ref_stale` failure's hint could read not just "element no longer resolvable" but
"re-snapshot before retrying; refs are generation-scoped and do not persist across page mutations"
— turning every failure into a compact restatement of Silver's core grounding contract, not just a
diagnostic. This is a strengthening of `transcripts-3.md`'s existing #3 recommendation
(forensic-bundle-on-fail), not a new mechanism — **fold this framing into that recommendation when
it's implemented: the hint field should both diagnose AND re-teach the relevant invariant.**
**Priority: MEDIUM, ties to an already-queued recommendation, no new code surface.**

## Priority summary (this pass only)

| # | Finding | Priority | Type |
|---|---|---|---|
| 1 | Cite the Stock Pilot accretion case study in a design/contributing doc; adopt "before adding a verb, ask which of the 3 fixes it should have been" as a review discipline | P1 | doc, process |
| 2 | Tool-sourcing ladder: one sentence in `SKILL.md` telling hosts to prefer `silver extract` over hand-rolled scraping via their own code-execution tool | P2 | doc |
| 3 | Sub-agent decision caveat: own-context prevents Silver-state corruption, NOT shared-external-target races; sequence writes, parallelize only independent reads | P1 | doc |
| 4 | DOM-contract verification pattern as a named self-QA recipe (`data-silver-verify-*` convention) for testing one's own just-built app | P2 | doc/recipe, novel |
| 5 | Sharpen the future eval-harness design: code-graders for structural checks, model-graders reserved for nuance, budget a calibration round, reuse the control/edge/boundary case template | P1 | design input for the already-queued P0 eval gap |
| 6 | Audit Hard Rules prose for "instructions without capability" — delete or convert to mechanism-pointers | P2 | doc audit |
| 7 | Version-comment each defensive Hard Rule with why it exists (withholding/over-fit prevention) | P3 | process |
| 8 | Reframe memory-store guidance using Sierra's "every fix is a permanent regression note" framing | P3 | doc framing |
| 9 | When the forensic-failure-bundle (`transcripts-3.md` #3) is built, make the `hint` field re-teach the invariant, not just diagnose | MEDIUM | strengthens a queued item |

All nine are keyless and either pure documentation/process changes or framing refinements to
already-queued recommendations from prior digests — none require new runtime mechanisms beyond what
prior passes already identified, except #4 (the DOM-contract recipe), which is genuinely novel to
this pass and the standout finding: it is the one idea in this digest with no analog anywhere in
Silver's existing adopt-list corpus.
