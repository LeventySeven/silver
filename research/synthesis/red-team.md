# Red-Team — attacking the pattern-corpus before we build

**Posture:** adversarial. No praise-padding. The synthesis is well-cited and mostly right about
the *architecture*; it is wrong about *scope*, contradicts itself on two load-bearing details,
and smuggles a keyed model-router back in through the security section while claiming to be
keyless. The single biggest threat is not a missing pattern — it's that the build order rebuilds
~80% of a shipped MIT tool for ~5% of the differentiation.

Read against: `pattern-corpus.md`, and the digests for vercel-agent-browser, baseline-skill-and-cli
(the wrapper that already exists), browser-use, prior-eval-gate, aside-05 (security), aside-06 (memory/subagents).

---

## 0. The headline: this is a build-vs-buy inversion wearing an architecture doc

Vercel `agent-browser` is a **keyless, host-LLM-is-brain, pure-Rust CLI+daemon, MIT, installable
via `npx skills add`** — and it *already ships* nearly the entire §2 command surface and most of
§6/§8:

| Corpus proposes to build (§2/§4/§5, build order 1–5, 10) | Vercel already ships |
|---|---|
| Per-session Unix-socket daemon, lazy spawn, idle-timeout, version-check | ✅ (digest §4) |
| `@eN` snapshot refs, invalidate-on-page-change, grounding gate | ✅ (§1–3) |
| `snapshot -i -c -d -s -u --json`, human + JSON serializations | ✅ (surface) |
| `find` role/text/label/testid/first/last/nth locator tier | ✅ (§18) |
| Ranked wait taxonomy, "bad waits > bad selectors" | ✅ (§16, verbatim) |
| `--session` / `--restore` / worktree-derived stable id / autosave | ✅ (§5–6) |
| Auth vault, `auth login`, `--password-stdin`, cookies-as-cURL | ✅ (§7–8) |
| `--content-boundaries`, `--max-output`, `--allowed-domains` (subresource-level) | ✅ (§9) |
| `--confirm-actions`, `--action-policy`, `--confirm-interactive` (fail-closed) | ✅ (§10) |
| Annotated screenshots sharing the ref namespace | ✅ (§13) |
| Origin-scoped `--headers` | ✅ (§14) |
| Docs-in-binary (`skills get core`), stub-redirect, lockstep-with-help | ✅ (§15) |
| `read` markdown-first no-browser fetch, `batch`, `doctor` | ✅ (§19, §11, §21) |
| Tab handles `t1`/labels, `eval --stdin` | ✅ (§12, surface) |

The corpus justifies "build our own" by citing prior-synthesis **P21**. But read P21's actual
rationale: *"it's a Node/Rust daemon that can't co-tenant a **Python backend**… the existing
[Travels] codebase already had ~70% of the primitives."* **That premise is false for a new
standalone skill.** There is no Python backend to co-tenant. The `agent_browser.py` baseline
*is a working wrapper over Vercel's CLI* — the co-tenancy problem was solved by shelling out, not
by reimplementing. So the corpus inherited P21's *conclusion* ("build your own") while its
*premise* (co-tenancy constraint) evaporated. That is textbook cargo-culting a prior decision into
a context where its reason no longer holds.

**What is actually NOT in Vercel** (the real delta, the whole justification for the project):
1. A task-completion **eval harness / `pass_k` gate** — Vercel's `benchmarks/` is pure daemon
   latency (confirmed, digest anti-pattern). This is the moat.
2. **ID-grounded `extract`** with schema URL→ID transform + reverse-map — no `extract --schema`
   command exists in Vercel's surface.
3. **Diff-when-shorter snapshot *as the returned observation*** — Vercel has `diff snapshot` as a
   file-baseline QA command, not `min(tree,diff)` returned per action.
4. A **hardened-by-default security posture + skill doc** that wires the flags Vercel already has
   into the correct defaults (most of the trifecta close is *configuration*, not code).

Everything else in build order 1–8, 10, 13–17 is re-manufacturing shipped, open, keyless
functionality. That is the risk the rest of this document is organized around.

---

## (a) KILL LIST — cut these

**K1. Reimplementing the daemon + snapshot walker + actuation engine + discrete command surface
from scratch (build order 1–5).** Vercel ships all of it, MIT, keyless, fast Rust, and a working
Python wrapper already exists. v1 = **wrap `vercel-labs/agent-browser`**; build only the four
deltas above. Fork Vercel's serializer *only if* a spike proves a delta can't be built over its
`--json` output (see R1). This single cut removes the majority of the proposed engineering.

**K2. Porting Aside's carved-from-binary actuation constants (§5: 16ms/32ms polls, `[0,100,200]ms`,
300/750ms grace, 8000ms budgets, `waitForReady` ladder).** If you wrap Vercel, **actuation is not
your layer** — these are Vercel's concern and re-specifying them is cargo-cult. They are only
relevant in the "we forked the engine" world K1 rejects. Keep the *concepts* as acceptance criteria
for the eval, not as code you write. (baseline anti-pattern 5 already warns the magic constants are
tuned for a different engine's failure modes.)

**K3. `run` code-execution mode as an early/second-wave item (§3, build order 13).** The corpus
itself argues discrete commands are the correct register for a trusted host, and flags `run`/`eval`
as the two verbs needing a confirm gate **and** an fs-jail sandbox — the single most
security-expensive thing to build. Vercel already ships `eval --stdin` and `batch`, which cover the
"multiple actions + a read in one round-trip" and "UI-dead-end → hit the JSON API" cases. A
persistent JS sandbox with a Playwright-shaped `page`, helper globals, and a bespoke fs-jail is a
large build whose main beneficiary — the host — **can already write and run its own code**. Demote
to explicit v2/NICE, and make the bar for building it "the eval shows `batch`+`eval`+`read`
provably fail on the dead-end tasks."

**K4. Everything from the memory/subagents source (aside-06) for v1.** 3-tier markdown memory,
content-addressed chunker, hybrid dense+BM25 retrieval, dreaming/consolidation, subagent
orchestration (spawn/wait/profiles/fork_self). For a skill a sub-agent installs and drives via
shell, **the host (Claude Code) owns memory and orchestration.** aside-06's own anti-patterns 1–3
and the owner's NON-GOALS both say this. The corpus already parks it in NICE/v2 — make it a hard
KILL so no one builds it, and stop treating the 35KB memory digest as design input. A browser skill
does not need its own vector store, its own dreaming pass, or its own subagent tree.

**K5. Model-dependent "security" defaults that violate the keyless invariant (see §theme below).**
Specifically cut, as CLI-internal features: the **async injection classifier running concurrently**
(§6.1 "best-in-class"), the **amount-extraction AI fallback** (§6.4), and the **independent
read-only verifier subagent as a completion gate** (§6.10, build 19). Each requires the CLI to call
a model — a key, a provider gateway, a model choice — which §0 explicitly says we do not build. Keep
the keyless parts (regex forged-tag neutralizer, content-boundary fencing, regex amount extraction);
delete the model-call framing. The verifier's *pre-committed acceptance criteria* idea belongs in
the eval judge (post-hoc), not the runtime.

**K6. Component-updater / hot-updatable signed guardrail data (aside-05 pattern 18).** Chromium
Omaha-channel machinery for pushing denylists. A versioned JSON file in the repo is the entire
answer. Don't build a fetch-with-signature-verification pipeline.

**K7. Session recording / MP4, `react tree`/`renders`/`suspense`, `vitals`, `profiler`, `trace`,
pixel/`cua` coordinate mode (§14).** All present because a big system had them. None differentiate
a keyless agent-browser skill and several (`cua`) are explicitly gated fallbacks the corpus admits
score worse. Leave to Vercel's surface if free; build none.

---

## (b) SHARPEN LIST — under-specified → a builder will guess wrong

**S1. Ref model is internally contradictory — this is a latent SILENT-WRONG-CLICK bug.**
§1 grounds via *"ref ∈ current snapshot"* (string membership). §4 says *"reset counter each call"*
(remint `eN` per snapshot) **and** *"symbol-stamp unchanged elements so a re-snapshot reuses their
number."* These cannot all be true. If `e5` is reused across snapshots for a *different* element,
the string-membership gate passes and the action dispatches on the **wrong node** — silently. That
is worse than a loud stale error and is the exact catastrophe the ref system exists to prevent.
→ **Spec one coherent model:** mint a monotonic `snapshot_generation`; every ref carries its
generation; grounding gate = `ref.string ∈ current` **AND** `ref.generation == current_generation`;
any generation mismatch → `RefStaleError` regardless of string match. Drop "reuse the number," or
permit reuse only when node identity provably matches (role+name+`backendNodeId`). Add an eval case:
click a ref from snapshot N after a re-render that remints refs → **must error, must not misclick.**

**S2. Extract: WHO calls the model? (load-bearing, unspecified.)** §7 describes Stagehand's extract,
which calls Stagehand's *own* keyed model. The ultimate CLI is keyless. The corpus never says
whether `extract` (a) makes a model call (needs a key → violates §0) or (b) hands a bundle to the
host. → **Spec option (b):** `extract --schema S` returns a bundle = `{id_transformed_schema,
verbatim_extract_prompt, snapshot_with_stable_ids}`; the **host** runs the inference; a second call
`extract resolve --ids <json>` reverse-maps IDs → real values via a `combinedValueMap` **keyed to the
snapshot generation** that produced it. Stale generation → null + error (same discipline as S1).
Spell out the map lifecycle: built at snapshot time, invalidated on re-snapshot. Without this, a
builder either bricks the keyless contract or builds a resolver that silently returns fabricated
values against a stale map.

**S3. Snapshot grammar — there are TWO incompatible formats in the corpus.** §2 shows
`- <role> "name" [ref=eN, level=N, …]: value`. The Vercel/baseline digests show
`@e1 [role attrs] "name"` with `Page:`/`URL:` header. The baseline explicitly flags "doc example
doesn't match real CLI output" as an anti-pattern — and the corpus reproduces the sin. → If wrapping
Vercel (K1), you **inherit Vercel's grammar**; delete the bespoke one. Either way: publish exact
EBNF, and make "skill-doc snapshot examples are byte-for-byte copied from real CLI runs" an
**eval-enforced** rule (regex the doc's fenced examples against live output).

**S4. Re-snapshot trigger in a discrete, process-per-command CLI.** §5's "two-tier guard" assumes a
single in-process loop. In a discrete CLI, each command is a separate process; only the **daemon**
holds page state. Auto-injecting a re-snapshot into every action response = token explosion; never =
stale refs. → **Spec:** the daemon stamps every response with `{snapshot_generation, page_changed:
bool, stale_refs: bool}` computed from a cheap fingerprint (`url + focused-node-id + DOM-length/hash`
delta after the action's settle). It **flags**, it does not auto-embed a new tree. The host reads
the flag and decides to re-snapshot. Document this as the loop contract or every builder guesses.

**S5. Egress default posture is backwards for a general browser (§6.5).** The corpus ships the
hostname-suffix **allowlist as "a hard boundary by default."** For a general-purpose browsing skill
an empty/allowlist-first default **bricks ~every task** (aside-05 anti-pattern: "empty allowlist as
fail-closed is a footgun"). → **Spec the default as a scheme+host DENYLIST**, allowlist opt-in per
task: deny `file:`/`view-source:`/`data:`(top-level)/`blob:`/non-http(s) schemes and a small
known-dangerous-host list (credential/identity pages, raw-IP targets, lookalike heuristic);
`--allowed-domains` is an opt-in *hardening* layer, not the day-1 gate. The suffix-match algorithm
(`endswith("."+allowed)`, never substring) is correct and stays — it just isn't the default gate.

**S6. `file://` deny is conditioned on an un-checkable property (§6.5).** "Deny for any action
reachable from agent-non-originated content" — "reachable from untrusted content" is not a runtime
property you can evaluate. → **Flat default deny** of `file:`/`view-source:`/`data:`/`blob:`/non-http
for all agent-issued navigations; require operator flag `--allow-file-access` (Vercel already has
this exact flag) to lift it. The PerplexedBrowser calendar-invite→`~/.ssh`→POST chain is the proof;
make it an unconditional default, not a conditional heuristic.

**S7. Error taxonomy → recovery mapping (§2).** Eight codes are listed with no per-code
retryable/terminal classification and no recovery-message text. The one good example
(`RefStaleError`'s message *is* the recovery instruction) is not generalized. → **Ship a table:**
`code → {retryable_by_host: bool, literal_message}`. e.g. `element_obscured` → retryable, "another
element covers the target; re-snapshot and retry or use force"; `navigation_blocked` → terminal,
"host X is denied by policy; not retryable." Aside-05's retry classifier (deny billing/quota,
allow 5xx/timeout) is the model for the *CLI's own* transient-vs-terminal split.

**S8. "harness > model" (93/88) must be reproduced on OUR harness, not cited.** §1/§9 lean hard on
Aside's 93% vs 88% and D2Snap's 73%. Those are *other people's* numbers under *other people's*
harnesses (and P19 already warns Aside's headline is self-graded, ~90% independently). → The eval
must **produce** the ≥2-model-tier comparison on our own CLI; until it does, the "invest in harness,
model is swappable" thesis is borrowed, not owned. State this as an eval acceptance criterion.

---

## (c) DEFENSIBLE CORE — keep at all costs (this is the whole project)

These are the things that make the deliverable better than `apt-get install vercel-agent-browser`,
and every one is a *delta over the wrapped engine*, not a reimplementation of it.

**C1. The eval harness as the gate, built FIRST.** Frozen real-trace corpus, `pass_k` over repeated
sampling, cross-vendor judge (different model family than the agent — fixes the one flaw in both
Aside's and Vercel's self-family judges), regex `expectedPatterns`/`forbiddenPatterns` as the
ground-truth pass/fail with the LLM judge as a *non-flipping* secondary signal, hallucination traps
(nonexistent commands) baked into `forbiddenPatterns`, the real CLI spawned with a timeout (not the
bare model API), ≥2 model tiers. Vercel has **no task-completion benchmark at all** — this is the
single most defensible thing here, and it is what tells you whether any other pattern earns its
place. It is also the cheapest moat (per P21's own lesson: the highest-leverage move was a config
flag found *by* an eval, not a feature).

**C2. ID-grounded `extract` (keyless, host-delegated).** Schema URL→ID transform so the model
literally cannot emit a fabricated URL as free text; reverse-map post-hoc with an out-of-range ID
nulling the field (harden Stagehand's silent `?? ""` into a loud null); `list[T]` container as the
default cardinality (the N-options-collapse-to-1 bug). Vercel's surface lacks an extract-schema
command; Stagehand has it but keyed. A keyless, structurally-unfabricatable extract is genuinely
novel. (Requires S2's who-calls-model spec.)

**C3. Hardened-default security posture delivered as configuration + skill doc, not new code.** The
trifecta close is mostly *wiring Vercel's existing flags to correct defaults*: content-boundaries
ON, max-output capped, `--allow-file-access` OFF, confirm-actions fail-closed on non-TTY,
password/card redaction at the serializer choke point (post-filter if Vercel leaks it),
read-only-phase-by-default with actor verbs gated behind an explicit `--enable-actions`. Plus the
two structural moves that ARE code and ARE worth it: **reader/actor phase quarantine as
tool-registry-as-pure-function-of-flags** (a restricted verb isn't in the schema, so no prompt
bypasses it) and **regex forged-role-tag neutralization** of page-derived output. High leverage
precisely because it's ~90% config.

**C4. Diff-when-shorter as the returned observation.** `min(tree, diff)` per action, `*`-new-since
markers, "No changes detected" sentinel. The token-affordability lever (~1.7K obs-tokens/task).
Distinct from Vercel's file-baseline `diff snapshot`. Buildable as a wrapper-side diff of two
`--json` snapshots *if* the spike (R1) shows `--json` is stable enough.

**C5. The skill doc itself, as the product.** Complete surface generated lockstep from `--help`,
real-output examples, phase-scoped command set, and the ranked wait / reading-ladder / recovery
blocks as **verbatim prompt fragments** (Aside's Recovery + Completion/Verification blocks are
copy-worthy). For a host-driven tool, the doc is most of the value and is cheap.

**C6. Late-bound ref resolution + self-describing `RefStaleError` + hard grounding gate** — the
correctness core, *if* the ref layer is ours. If we wrap Vercel, Vercel already invalidates on page
change; the only marginal value is re-render survival (role+name+ordinal re-match). Verify what
Vercel already does before rebuilding (R1). Keep the concept; don't assume the rebuild.

---

## (d) Top 5 build risks + mitigations

**R1 — The reimplement-the-engine trap (highest risk, structural).**
*Failure:* the team spends the whole budget rebuilding daemon+walker+actuation+surface that Vercel
ships, ships late, and is *worse* (less battle-tested) than the tool it forked from — a worse
reimplementation, exactly the thing the brief warns against.
*Mitigation:* v1 = thin wrapper over `vercel-labs/agent-browser` (the baseline proves it works).
**First action, before any feature:** a spike that answers "does Vercel's `--json` snapshot expose
enough — stable node identity per ref, role, name, url, and a way to detect password fields — to
build C2 (ID-grounded extract), C4 (diff-as-observation), and C6 (late-bound refs) as a *wrapper*?"
If yes, never fork. If a specific delta provably can't be done over `--json`, fork *only that
serializer path*, not the whole engine. Re-run P21's "% we already have" checklist honestly against
Vercel — it's ~80% for a standalone skill, not the ~70% the Travels/co-tenancy context reported.

**R2 — Keyless invariant vs. model-dependent defaults (self-contradiction).**
*Failure:* §6/§7 features that secretly call a model (async classifier, amount AI-fallback,
read-only verifier, extract inference, `--mode fast|standard`, `cua`) either force a provider
gateway the design forbids, or ship silently broken/no-op.
*Mitigation:* one hard rule — **the CLI never calls a model.** Every "smart" step is either a
keyless heuristic/regex or a bundle handed to the host to run. Audit every §6/§7/§4 item against
"does this need a key?"; host-delegate or cut each that does. This rule is also the cleanest way to
keep the tool installable into arbitrary sandboxes with zero configuration.

**R3 — The eval harness is prose, not code (the moat evaporates).**
*Failure:* §9 names WebVoyager/Mind2Web and "frozen real traces" but wires nothing. If the gate
isn't runnable, "ships behind the eval" is theater and every feature ships unmeasured — the precise
failure the prior doc caught in itself (relabeled gate→lint).
*Mitigation:* build the eval harness as **build-order 0**, minimal but real: a dir of ≥5 task JSONs
`{task, start_url, expectedPatterns[], forbiddenPatterns[]}`, a runner that spawns the real CLI+host
k times per task, a cross-family judge with a forced-JSON verdict `{reasoning, verdict, failure_reason,
impossible_task, reached_captcha}`, and a printed `pass_k`. It must go green (even at N=5) *before*
feature 2 is built. Grow the corpus over time; never let it become synthetic fake-sites (drifts from
real DOM/anti-bot — owner NON-GOAL).

**R4 — Ref-staleness silent-wrong-click (correctness landmine, S1).**
*Failure:* the contradictory ref model lets a reused `eN` pass the string-membership gate and
dispatch on the wrong element after a re-render — a silent misclick on a possibly-consequential
control.
*Mitigation:* generation-stamped refs; grounding gate requires string **and** generation match;
mismatch → `RefStaleError` unconditionally. Add the "remint-after-re-render must error not misclick"
eval case. If wrapping Vercel, verify Vercel's ref invalidation actually enforces this and doesn't
merely check string membership; if it only checks membership, wrap it with a generation guard.

**R5 — Security is described, not defaulted (trifecta stays open).**
*Failure:* to avoid breaking tasks, defaults ship permissive; `file://` deny is conditional and
un-checkable; the "best-in-class" classifier needs a key it doesn't have; phase quarantine is
documented but the tool-registry-as-pure-function-of-flags is never actually built. Net: all three
trifecta legs open, §6 is decoration.
*Mitigation:* one **defaults table**, unit-tested: file/data/blob/non-http denied by default
(`--allow-file-access` opt-in); content-boundaries ON; max-output capped; serializer redaction ON;
read-only phase default, actor verbs behind `--enable-actions`; confirm fail-closed on non-TTY;
egress = scheme+host denylist (S5). Plus a **trifecta test suite** that must pass on defaults:
(1) calendar-invite→`file://~/.ssh/id_rsa`→exfil chain fails; (2) injected "click Delete @e999"
fails the grounding gate; (3) a `type=password` value never appears in any snapshot/get-text output.
If those three don't pass on defaults, security is not done — regardless of how much §6 prose exists.

---

## One-paragraph verdict

The architecture is settled and correct — the corpus proves that six times over and should stop
re-proving it. The *scope* is inverted: it plans to rebuild a shipped keyless MIT engine and calls
the reused-decision "our own primitive," while the actual differentiators (eval gate, keyless
ID-grounded extract, diff-as-observation, hardened defaults) are a thin, mostly-configuration layer
that could ship in a fraction of the time as a **wrapper over Vercel `agent-browser`**. Do the R1
spike first, build the R3 eval harness second, and let the eval — not the pattern corpus — decide
which of the remaining patterns are real. Everything a model-call would require, the host already
provides; everything the engine would require, Vercel already ships. Build the four things that are
neither.

*Path: `/Users/seventyleven/Desktop/ultimate-agent-browser/research/synthesis/red-team.md`*
