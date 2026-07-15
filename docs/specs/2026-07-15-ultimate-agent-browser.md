# Design Spec — `uab`, the Ultimate Agent-Browser (2026-07-15)

**Status:** approved-by-owner-mandate (full autonomous mode; approval gate waived by the user).
**Inputs:** `research/synthesis/pattern-corpus.md` (24 grounded digests, Rounds 1+2) and
`research/synthesis/red-team.md` (adversarial pass). This spec is the committed distillation and the
input to `compound-v:writing-plans`.

---

## 1. Purpose & success

**Build the ultimate browser-automation *skill* for AI agents:** a keyless CLI a sub-agent installs and
drives over the shell to perceive and act on live web pages, that is genuinely better than each tool it
synthesizes because it uniquely combines four things none of them ship together.

**Success = all of:**
1. A sub-agent can `open → snapshot → act → re-snapshot → done` on real sites with `@ref` grounding.
2. The CLI **never calls a model** (host is the brain) — installable into any sandbox with zero config/keys.
3. **Evals gate the build:** a runnable `pass_k` harness over real tasks, cross-family judge, ≥2 model
   tiers, A/B vs. real Vercel `agent-browser` — green before a capability is called "working."
4. **Security defaults close the lethal trifecta** — proven by a trifecta test suite, not prose.
5. `uab` is a **compatible superset** of Vercel's `agent-browser` surface (same verbs/refs) + our deltas.

**v1-usable test (brainstorming bar):** would *I* reach for this over raw Playwright-MCP or Vercel's CLI
for a real browse task? Yes only if snapshot+grounding+extract+security are real, not demoware.

---

## 2. Architecture decision (and the rejected alternative)

**Chosen: a self-contained Node/TypeScript CLI on Playwright.** Playwright is the engine — it already
provides actionability gates, auto-wait, occlusion hit-testing, React/Vue controlled-input handling,
iframe traversal, and a CDP session escape hatch. We reimplement **zero** actuation (this satisfies the
red-team's K2: don't port Aside's carved-from-binary timing constants — Playwright's are better-tested).

**Rejected: wrap Vercel's Rust `agent-browser`.** Steelmanned: shipped, Apache-2.0, ~80% of the surface,
a working Python wrapper exists. Rejected because (a) *install-and-use*: wrapping needs a Rust binary +
a separate 172 MB Chrome-for-Testing download vs. `npm i` + Playwright's already-present Chromium;
(b) our four deltas must own the **serializer choke point** (redaction, generation-stamped refs,
diff-as-observation, ID-grounded extract) — post-processing Vercel's `--json` couples us to its format
and can't redact at its choke point; (c) keyless is trivial when we own the process. **Disconfirming
test:** if a faithful `@ref` snapshot on Playwright proves far harder/less reliable than Vercel's Rust —
measured directly by the eval A/B; fallback = raw CDP `Accessibility.getFullAXTree` via
`page.context().newCDPSession()` if `page.accessibility` is too lossy.

**The keyless invariant (scopes everything):** the CLI is eyes+hands; the host LLM is the brain. No
provider gateway, no model router, no billing, no daemon-crypto, no memory/subagents, no CLI-side model
call anywhere. Every "smart" step is a keyless heuristic/regex **or** a bundle handed to the host.

---

## 3. Scope decomposition (Large → coupled sub-projects, one package)

Build order is the red-team's: **eval harness first**, then engine, then the deltas, each behind the gate.

- **P0 — Eval harness (the moat, built FIRST).** `evals/tasks/*.json` `{task,start_url,expectedPatterns[],
  forbiddenPatterns[]}`; a runner spawning the **real `uab` CLI** k times/task with a hard timeout; a
  **cross-family** judge with forced JSON `{reasoning,verdict,failure_reason,impossible_task,reached_captcha}`;
  deterministic regex gate is ground-truth, judge is a non-flipping secondary signal; hallucination traps
  (nonexistent commands) in `forbiddenPatterns`; prints `pass_k`; ≥2 model tiers; A/B vs. Vercel. Also a
  **trifecta security test suite** (unit-level, no model) that must pass on defaults.
- **P1 — Engine + perception.** Per-session process holding a Playwright `browser`/`page`; the snapshot
  builder (`@eN` refs, generation-stamped; role allowlists; interactive heuristic cascade; W3C accessible
  name; never-truncate; `-i/-c/-d/-s/-u/--json`); **diff-when-shorter** `{tree,diff}`; the grounding gate.
- **P2 — Actuation (thin delegation).** Resolve `@ref` → Playwright `Locator`; click/fill/type/press/
  select/check/hover/scroll/upload; `find` semantic tier; ranked wait taxonomy; page-change **flag** in
  every response (not auto-embedded re-snapshot).
- **P3 — Security defaults.** scheme+host **denylist** egress (not allowlist); flat `file:`/`data:`/
  `blob:`/`view-source:` deny (`--allow-file-access` opt-in); redaction at the serializer; **phase
  quarantine** (tool-registry = pure function of flags; read-only default, actor verbs behind
  `--enable-actions`); **forged-role-tag neutralization** of page output; content-boundary fencing +
  `--max-output`; confirm gate for actor/destructive verbs (fail-closed on non-TTY).
- **P4 — Keyless ID-grounded `extract`.** `extract --schema S` returns a **bundle**
  `{id_transformed_schema, verbatim_prompt, snapshot_with_ids}`; host runs inference; `extract resolve
  --ids J` reverse-maps IDs→values via a `valueMap` **keyed to the snapshot generation**; out-of-range ID
  → loud null. `list[T]` container default.
- **P5 — The skill doc as product.** `SKILL.md` generated **lockstep with `--help`**, phase-scoped verbs,
  real copy-pasted output examples (eval-enforced to match live), verbatim recovery/wait/reading-ladder
  prompt fragments. Plus `install.sh`/`npm` self-contained install + `uab skill` (docs-in-binary).

---

## 4. The `@ref` model (red-team S1 — the correctness landmine, spec'd coherently)

One coherent model, no reuse ambiguity:
- Each `snapshot` bumps a monotonic **`generation`** counter. Refs mint `eN` sequentially within a
  generation (`fNeM` for iframe N); iframe subtrees splice inline under the parent's `[ref=eN]` line.
- The **RefMap** stores per ref: `{generation, backendNodeId, role, accessibleName, nth, frameId}`.
- **Grounding gate on every ref-taking command:** `ref.string ∈ current_refmap` **AND**
  `ref.generation == current_generation`. Any mismatch → typed `RefStaleError` whose **message *is* the
  recovery instruction** ("refs from snapshot #N are stale; take a new snapshot and retry"), and it is
  **not** counted against the failure budget. No silent number reuse — a stale `e5` can never dispatch
  on a different node.
- **Resolution** (late-bound, red-team C6): fast path = re-locate by `backendNodeId` via CDP
  `DOM.resolveNode`; on miss (SPA re-render), bounded re-match (≤5000 nodes) by `(role, accessibleName,
  nth)`. Playwright `Locator` is built from the resolved handle so all actionability is Playwright's.
- **Eval case (mandatory):** click a ref from generation N after a re-render that reminted refs → **must
  `RefStaleError`, must not misclick.** (Red-team R4.)

---

## 5. Snapshot format (one grammar — red-team S3)

Adopt Vercel's grammar (we ship a compatible superset), one line per node, 2-space indent per semantic
depth:
```
- <role> "<accessible name, escaped, ≤100 chars>" [ref=eN, level=N, checked=B, expanded=B, selected,
    disabled, required, placeholder="…", url=<cleaned>]: <value>
```
Header line `- title: "…" [url=…, generation=N]`; `# note:` when filtered. `@eN` on input; stored bare
`eN`. Ref-input tolerance `@e12`|`ref=e12`|`e12` (one `parseRef`). **Which nodes get a ref:** interactive
roles always; content roles only if named; structural never; plus cursor-interactive (div-as-button)
nodes. **Never truncate** — on `maxChars` overflow return a structured error naming escape hatches
(`-d`, `-s`, ref-scope). `--compact` keeps only `ref=`/`: value` lines + ancestors. `password`/card
values → `[redacted]` at this choke point. Off-viewport kept; `display:none`/`visibility:hidden` pruned
(except off-screen radio/checkbox). Mark new-since-last with `*`. `snapshot()` returns
`min(tree, diff)` (Myers O(ND) unified hunks; "No changes detected" sentinel); example doc snippets
eval-enforced to equal live output.

## 6. Actuation (delegate to Playwright — red-team K2)

Ref → resolved `Locator`; every interaction goes through Playwright's built-in actionability
(attached/visible/stable/enabled + hit-testing) — no hand-rolled gates/constants. Fill uses Playwright
`.fill()` (handles controlled inputs) with a `.value` re-read verify + `pressSequentially` fallback for
stubborn React inputs. **Page-change contract (red-team S4):** the daemon stamps every response with
`{generation, page_changed, stale_refs}` from a cheap fingerprint (`url + focusedId + domLength/hash`
after settle); it **flags**, never auto-embeds a re-snapshot. Ranked wait taxonomy; demote bare
`wait <ms>` to last resort in docs. Native dialogs auto-accept with a `[system]` note (destructive
patterns routed through the confirm gate).

## 7. Security defaults (red-team S5/S6/R5 — a unit-tested defaults table + trifecta suite)

Defaults table (all unit-tested): `file:`/`data:`/`blob:`/`view-source:`/non-http **denied**
(`--allow-file-access` lifts `file:`); egress = scheme+host **denylist** + suffix-match `--allowed-domains`
opt-in hardening (never substring: `endsWith("."+d)`); content-boundaries **ON**; `--max-output` capped;
serializer redaction **ON**; **read-only phase default** (only `snapshot/read/extract/get/is/wait/screenshot`
in the registry), actor verbs (`click/fill/type/press/select/check/upload/eval`) present only with
`--enable-actions`; confirm gate **fail-closed** on non-TTY for actor/destructive/paid verbs (single
tool-call/turn, re-confirm on material change, mutating verbs tagged `idempotent=false`). **Forged-tag
neutralization:** regex-strip `</?system>|</?user>|</?tool>|<untrusted…>` from page-derived output →
`[PROMPT_INJECTION_NEUTRALIZED]`; wrap page output in stable boundary markers. **Phase quarantine is
code** (registry = pure function of flags → a disabled verb literally isn't dispatchable). CAPTCHA =
detect-and-handback (never solve). **Trifecta suite (must pass on defaults):** (1) `file://~/.ssh/id_rsa`
navigation denied; (2) injected "click Delete @e999" fails the grounding gate; (3) a `type=password`
value never appears in any snapshot/get-text output.

## 8. Keyless extract (red-team S2/C2), auth/sessions, non-goals

- **Extract** is host-delegated (§3 P4) — the CLI never infers. `valueMap`/`urlMap` keyed to the snapshot
  generation; stale generation → null+error. Harden Stagehand's silent `?? ""` into a loud null.
- **Auth/sessions:** StorageState (`state save/load`), cookies-as-cURL (`cookies set --curl`), `--session
  <name>` isolated instances, worktree-derived stable ids, `--restore` autosave, `--incognito`. Passwords
  via `--password-stdin` only. No vault crypto stack (host/OS owns secrets).
- **NON-GOALS (hard kill):** reimplementing an engine; porting Aside timing constants; `run` JS-sandbox
  as v1 (Playwright users can `eval`; revisit only if evals prove `eval`+`batch`+`read` fail dead-ends);
  memory/dreaming/vector store; subagent orchestration; any CLI-side model call (async classifier, amount
  AI-fallback, verifier subagent — keep only their keyless/regex parts); model router/gateway/billing;
  cloud fleet/recording/`cua` pixel mode/react-devtools; component-updater; custom query DSL; vision as
  default (gated escalation only, and only if evals demand it).

## 9. Testing

- **Unit** (no browser): `parseRef`, snapshot serializer (golden fixtures), diff-when-shorter, RefMap
  generation gate, redaction, forged-tag neutralizer, egress denylist, extract schema-transform +
  reverse-map, phase-quarantine registry assembly.
- **Integration** (real Chromium via Playwright, local fixture HTML pages under `evals/fixtures/`):
  open/snapshot/click/fill/extract round-trips; stale-ref-must-error; iframe splice; page-change flag.
- **Eval** (P0): `pass_k` on real+fixture tasks, cross-family judge, ≥2 tiers, A/B vs. Vercel; trifecta
  suite. **Gate:** evals+trifecta green before a capability ships or a round closes.

---

*Design self-review (four checks): no TBDs (all placeholders resolved to decisions above); no internal
contradiction (ref model §4 reconciles the corpus §1/§4 clash the red-team flagged); scope is one
coherent package built in ordered batches, not several products; ambiguities (who-calls-model, egress
default, re-snapshot trigger, snapshot grammar) each resolved to one explicit choice. Material decisions
made during review — reject-wrap-Vercel, binary name `uab`, read-only-default phase, `run` mode cut to
post-eval — are recorded here for the owner.*
