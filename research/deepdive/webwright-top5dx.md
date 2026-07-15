# Deep dive: Webwright — Top 5 DX wins vs Silver

Scope: what Webwright does better than every other source (Vercel agent-browser, Aside,
browser-use, Stagehand, AgentQL) specifically on **developer/agent experience** — the things
that make a host LLM (or a human) *succeed on the first try* and *diagnose failure fast* —
and whether Silver already has each, matches it, or has a concrete gap.

Files read in full: `reference/webwright/skills/webwright/SKILL.md`,
`reference/webwright/skills/webwright/reference/{cli_tool_mode,workflow,playwright_patterns}.md`,
`reference/webwright/skills/webwright/commands/{run,craft}.md`,
`reference/webwright/src/webwright/run/{doctor,cli}.py`,
`reference/webwright/src/webwright/tools/{self_reflection,image_qa}.py`
— cross-checked against Silver `silver/src/cli.ts`, `silver/src/core/handlers.ts`,
`silver/src/core/errors.ts`, `silver/skill-data/core/SKILL.md`, `silver/src/task/{index,store}.ts`.

---

## 1. `doctor` with per-check remediation text, not just a pass/fail bit

**Webwright:** `run/doctor.py:14-115` defines six checks (`Python`, `Playwright`,
`Chromium`, `Screenshot`, `OpenAI Key`, `Plugins`), each returning `(ok: bool, message: str)`.
On failure the message is *always* a two-line `"<what's wrong>\nFix: <exact command>"` —
e.g. `check_chromium` (:30-44) returns `"chromium missing\nFix: playwright install chromium"`,
`check_screenshot` (:47-75) actually **launches Chromium and takes a real screenshot** to
catch a broken sandbox/font/library install, not just check a binary exists, and returns
`"unable to launch Chromium for screenshot validation\nFix: playwright install"`. `run_doctor`
(:118-147) renders all six as a Rich `Table` (`Check | Status | Details`) plus a
`"<passed>/<total> checks passed"` summary line. `cli.py:166-171` wires it as `webwright doctor`,
a first-class Typer subcommand next to the task runner.

**Silver — partial gap.** `cli.ts:46` and `security/registry.ts:52` already expose `doctor` as
a first-class meta verb (bypasses the phase-quarantine gate, matching Webwright's design), and
`handlers.ts:1477-1500` (`handleDoctor`) does three checks: `playwright` (hardcoded `true`,
:1479), `chromium` (`chromium.executablePath()` exists on disk, :1483-1488), and
`uab_writable` (a real write+delete probe into `~/.silver`, :1489-1498 — this one check *is*
as good as Webwright's, it actually exercises the filesystem). But the envelope is bare
booleans (`{playwright, chromium, uab_writable}`) with **no remediation text, no aggregate
pass count, and no functional Chromium-launch probe** — a broken sandbox/missing shared
library (the single most common CI failure mode) reads as `chromium:true` because only
`existsSync(exec)` is checked, never an actual `chromium.launch()`. **Adopt, keyless, cheap:**
(a) add a fourth check that does a real headless launch + 1×1 screenshot + close, mirroring
`check_screenshot`; (b) attach a static `Fix:` string per failed field from the existing
`ERRORS`-style fixed-string convention Silver already uses in `core/errors.ts` (no new
pattern needed, just apply it here too); (c) return a `passed/total` count. **Priority:
Medium** — no new capability, but every failed `doctor` call currently forces the host LLM to
guess the fix instead of reading it.

## 2. Firefox-first default engine as a documented anti-fingerprinting decision

**Webwright:** `SKILL.md:62-66` and `playwright_patterns.md:9-13` are explicit and load-bearing:
every session launches `playwright.firefox.launch(headless=True)` (never Chromium) *because*
"some sites fail under Chromium with `ERR_HTTP2_PROTOCOL_ERROR` due to TLS/H2 fingerprinting"
— cars.com and other Akamai-fronted sites are named as concrete failure cases. This is not an
incidental default; it's called out twice, in both the skill contract and the pattern
reference, as a decision that changes task success rate.

**Silver — confirmed GAP.** `core/session.ts:18` imports only `{ chromium }` from
`playwright`; `openSession` (session.ts:204-270) has no engine parameter and every session is
`chromium.executablePath()` (session.ts:210). Grep across `silver/src` for `firefox`/`webkit`
returns zero hits. Playwright already bundles Firefox (Webwright's own prerequisite is just
`playwright install firefox`), so this is not a new dependency — Silver simply never wires the
alternate engine through. Any site that TLS/H2-fingerprints Chromium's client hello (a known,
named class of sites) fails outright in Silver today with no documented workaround; the same
task would have succeeded under Webwright's default. **Adopt, keyless: `--engine
firefox|chromium` on `session open`** (default stays chromium for back-compat / CDP-console
parity, since Firefox's remote-debugging story differs), threaded through `openSession`'s
launch branch. **Priority: High** — this is a task-failure class Silver has zero mitigation
for, and the fix is bounded (one launch-args branch + a flag), not an architectural change.

## 3. The task *becomes* a reusable, parameterized CLI tool (`/webwright:craft`)

**Webwright:** `cli_tool_mode.md` (entire file) and `commands/craft.md` define a second mode,
triggered by `/webwright:craft` or "make it reusable" / "parameterize" language, whose
completion gate (`cli_tool_mode.md:167-187`) requires ALL of: (1) `plan.md` carries a
`# Parameters` table (name/type/source-phrase/default/format) *in addition to* Critical
Points (:24-44); (2) `final_script.py` has exactly **one** reusable function with a
Google-style `Args:` docstring covering every parameter (:56-84); (3) every parameter maps
1:1 to both a function arg and an `argparse --flag` whose default reproduces the *original*
task verbatim (:86-107, so `python final_script.py` with zero args redoes exactly what the
user asked for); (4) the script is **import-safe** — no browser/network/file I/O at module
top level, verified by an actual `importlib` smoke test run in a separate process
(:109-111, :143-153); (5) the first log line after reset is a machine-parseable
`step 0 params: name=value ...` echo (:113-121) so a rerun's *resolved* inputs are always
auditable; (6) the user is shown `--help` output before done (:161-165, commands/craft.md:56-59).
This turns a one-off automation into a durable, arg-driven tool a human or cron job can
re-invoke with different values — with zero further LLM involvement.

**GAP — Silver does not have this; confirmed against `task/store.ts` and `task/index.ts`.**
Silver's task layer records *what happened* (`plan.md` Critical-Points, `action_log.jsonl`,
`checkpoint.json`) but produces no executable artifact with parameterized inputs; `task exec`
(`task/index.ts:227-269`) requires the *host* to come back and re-issue `silver` verb calls —
there is no `--flag`-driven standalone script a non-agent process could run. Silver's own code
comment (`store.ts:4-6`) cites "the script IS the artifact; re-running it is the resume" as
the intended design but does not deliver a compiled/parameterized script today. **Adopt,
keyless:** a `silver task compile <id>` verb that reads `action_log.jsonl`'s recorded verb
invocations, promotes the literal argument values into named `--flag`s (mirroring Webwright's
`# Parameters` table), and emits a runnable shell script of `silver` calls (or an equivalent
Playwright script) with an auto-generated header documenting each flag — a bash/shell
analog of the Python contract above (no docstring/argparse needed since it's shell, but the
same "defaults reproduce the original task, flags let you vary it" property). **Priority:
High** — this is the single biggest structural DX gap: Webwright ships a durable, rerunnable
product from every task; Silver ships a durable *log* of one.

## 4. Prescriptive web-task correctness rules baked into the skill contract

**Webwright:** `SKILL.md:114-134` ("Hard Rules") and `playwright_patterns.md:74-119`
("Prefer interactive form filling over deep-link URLs") encode a set of *task-domain*
heuristics that prevent specific, named LLM failure modes — not tool-mechanics rules, but
web-task-correctness rules:
- Ranking language (`cheapest`, `best-selling`, `highest-rated`, …) "must be grounded in the
  site's actual sort/filter — not in your own ordering of results" (SKILL.md:121-123).
- Numeric/date/quantity constraints are exact; "wider buckets or broader defaults are
  failures" (SKILL.md:124-126).
- If a selected state becomes hidden after a drawer/accordion/modal closes, "reopen it or
  capture a visible chip/summary before treating the state as verified" (SKILL.md:127-129).
- Deep-link URLs are explicitly discouraged as the *primary* strategy for parameterized
  search because "sites silently drop parameters they cannot parse" and "URL parsers vary by
  locale, A/B bucket, and signed-in state" (playwright_patterns.md:74-92) — interactive form
  filling via `get_by_role`/`aria-label` is mandated as primary, with a documented pattern for
  paired-field modals (open once, `Tab` between siblings, :107-115).

**Partial gap — Silver's `skill-data/core/SKILL.md` (378 lines, read in full) is comprehensive
on *tool mechanics*** (ref grounding/staleness, generation-gating, extract's ID-indirection
against hallucinated URLs, phase quarantine, session/namespace model) **but contains no
equivalent web-task-correctness heuristics.** Nothing in Silver's skill doc tells the host LLM
"ranking claims must cite an actual site control" or "don't trust a drawer's selected-state
after it closes" or "prefer interactive fill over URL-param construction." These are exactly
the failure modes that make agentic web tasks silently wrong (a plausible-looking but
mis-filtered result set) rather than loudly broken, and Silver's own grounding machinery
(refs, generations) doesn't prevent them — a ref can be perfectly valid and still point at a
UI state the agent misjudged. **Adopt, keyless, zero code:** port Webwright's Hard Rules list
and the deep-link-vs-interactive-fill guidance directly into `skill-data/core/SKILL.md` (or a
new `skill-data/core/task-heuristics.md` referenced from it) — this is pure documentation, no
new verb or engine change required. **Priority: Medium-high** — highest ROI-per-effort item on
this list (a doc edit vs a code change) with direct task-success-rate impact.

## 5. Named, individually-invocable skill entry points per mode (`/webwright:run` vs `/webwright:craft`)

**Webwright:** `commands/run.md` and `commands/craft.md` are two separate, minimal slash-command
files, each with its own `argument-hint` and a short mode-specific procedure that defers to
the shared `SKILL.md`/`reference/*.md` for the full contract. A user (or the host agent) picks
the mode explicitly and unambiguously — `/webwright:run <task>` for one-shot,
`/webwright:craft <task>` for the parameterized-tool contract — rather than the skill having to
infer mode from free-text intent alone (SKILL.md:23-33 does support intent-based auto-trigger
too, but the slash commands give a zero-ambiguity fast path with tab-completion and inline
argument hints in any client that supports the Claude Code slash-command convention).

**GAP — Silver ships no slash-command layer at all.** `find silver -iname commands` and a
search for skill-adjacent `commands/*.md` return nothing; Silver's only agent-facing surface is
the single `skill-data/core/SKILL.md` (served via `silver skill` / `silver skill --full`,
`handlers.ts:1502-1537`) plus `examples.md`. There is no equivalent of "explicitly invoke task
mode vs one-shot mode" as a discoverable, named entry point — a host has to read the whole
skill doc and infer which `task` subverbs to chain. **Adopt, keyless, low cost:** ship
`commands/*.md`-equivalent short-form entry points (e.g. `silver-task-start.md`,
`silver-extract.md`) alongside the existing SKILL.md for the handful of Silver's own
"modes" (quick verb loop vs `task` durable-run mode vs `subagent` fan-out) so a host can
`/silver:task <goal>` instead of re-deriving the same three-verb sequence from prose every
time. **Priority: Low** — nice-to-have; Silver's single-SKILL.md-with-tables approach already
achieves comparable discoverability for a well-primed host LLM, so this is polish, not a
correctness or capability gap.

---

## Summary table

| # | Webwright DX win | Where (webwright) | Silver status | Verdict | Priority |
|---|---|---|---|---|---|
| 1 | `doctor` with per-check `Fix:` text + real Chromium launch probe + pass count | `run/doctor.py:14-147` | Has the verb + a real fs-write probe, but booleans only, no remediation text, no functional launch probe | **Partial GAP** | Medium |
| 2 | Firefox-default engine to dodge Chromium TLS/H2 fingerprint blocks | `SKILL.md:62-66`, `playwright_patterns.md:9-13` | Chromium-only, no engine flag | **GAP** | High |
| 3 | Task → reusable parameterized CLI script (`argparse`, docstring, import-safety, `step 0 params`) | `cli_tool_mode.md` (whole file) | Logs the run; no compiled/parameterized executable artifact | **GAP** | High |
| 4 | Prescriptive web-task-correctness Hard Rules (ranking grounding, exact constraints, hidden-state, deep-link avoidance) | `SKILL.md:114-134`, `playwright_patterns.md:74-119` | SKILL.md covers tool mechanics only, no task-correctness heuristics | **GAP** (doc-only fix) | Medium-high |
| 5 | Named per-mode slash-command entry points | `commands/{run,craft}.md` | Single SKILL.md, no slash-command layer | **GAP** (polish) | Low |

Note: Webwright's browser-lifecycle/persistence engine and its `plan.md` Critical-Points
device are **not** repeated here — prior digests (`research/topfive/top5-webwright.md`,
`research/topfield/engine-webwright-deep.md`) already established Silver matches or beats
Webwright on those (encrypted sidecars, atomic writes, pid-liveness gating, `DevToolsActivePort`
readiness detection vs stderr-scraping, safe teardown ordering). This digest is scoped to DX
items not already covered there — `doctor` UX, engine choice, script-artifact reusability,
skill-doc task heuristics, and command-surface discoverability.
