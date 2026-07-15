# Advocate brief: S3 — Python / consolidate

**Role:** strongest honest case for S3. Grounded in code read directly under
`silver/`, `skill/agent-browser/`, `reference/webwright/`, and the source
digests under `research/sources/` and `research/decision/`. Weaknesses are
stated, not hidden — a case that hides them is worthless to whoever decides.

## The one argument that actually matters: what "adapt the best of all
sources" costs in each language

The project brief names six things to consolidate: Vercel agent-browser,
Webwright, Aside, Browser Use, Stagehand, AgentQL (+ Perplexity as a security
precedent). I checked what language each one actually *is*, because that
determines whether "adapt" means **fork working code** or **re-derive a
pattern from a prose digest**:

| Source | Language | License | Directly forkable into S3? |
|---|---|---|---|
| Webwright | Python, ~4,686 LoC (`find ... -iname '*.py' \| wc -l`) | MIT (Microsoft) | **Yes** |
| Browser Use | Python, ~64k LoC | MIT (Gregor Zunic) | **Yes** |
| AgentQL SDK | Python *and* JS, dual-published | proprietary SDK | Python SDK usable as-is |
| Vercel agent-browser | Rust (CDP) | — | pattern only, any language |
| Stagehand | TypeScript | — | pattern only |
| Aside | TypeScript (`node:vm` REPL, per `ev-aside-adapt.md` F8) | not in repo, digest-only | pattern only, any language |

Two of the six reference implementations — Webwright and Browser Use — are
Python, MIT-licensed, and sitting on disk (`reference/webwright`) or mined
line-by-line in the digests (`research/sources/browser-use.md`,
`r2-browseruse-controller.md`). That is not a stylistic preference; it is the
difference between **importing/porting real, tested modules with attribution**
and **re-implementing a paragraph of prose from scratch in a language that has
never run that code**. Concretely, S3 gets to fork, not just read about:

- `browser_use/tools/registry/service.py` (612 lines) — a decorator that
  turns any function signature into simultaneously an LLM tool schema, a
  validated dispatcher, and a human-readable doc string, with zero
  duplication between "what the model sees" and "what runs"
  (`r2-browseruse-controller.md:15-26`). This is exactly the "one
  declaration → CLI verb → tool schema → docs" shape Silver wants, already
  written, already battle-tested against real-world sites, in the language
  S3 would ship.
- `dom/serializer/clickable_elements.py` — the 15-step ordered clickability
  decision tree, `paint_order.py` — CDP-paint-order occlusion filtering, both
  flagged "core — port this verbatim, it's battle-tested against real-world
  SPA markup" (`browser-use.md:22-41`).
- `agent/service.py:2720-2838` `multi_act` — the two-layer page-change guard
  that stops a queued action batch the instant a navigation invalidates DOM
  indices mid-batch. Directly solves a failure class any index/ref-based CLI
  will hit.
- Sensitive-data substitution: `<secret>name</secret>` tokens resolved
  post-validation, pre-execution, domain-scoped, with a TOTP 2FA convenience
  path (`pyotp.TOTP(...)`) — a complete, tested secrets-handling design ready
  to adapt, not a con we'd invent from a two-line teardown mention.
- Webwright's `persistent_local_browser.py` (314 lines, read directly,
  `create`/`info`/`release` subcommands) — a working, minimal CDP-attach
  sidecar pattern for a browser that survives across discrete steps; the
  judge-gated `done` completion contract (`default.py:202-268`); the
  context-compaction/observation-pruning mechanism (`default.py:275-339`).
  These are real, running Python today, not a spec to write.

Rust and TypeScript get the *same six sources* to adapt, but for two of the
six their only option is "read the prose digest and reimplement the idea" —
Rust has no CDP-Python-binding shortcut and no `node:vm`; TypeScript can
mine Stagehand and (loosely) Aside's REPL shape natively, but has to
re-derive everything from Browser Use and Webwright the same way Rust does.
S3 is the only strategy where the majority of the reference corpus is
same-language, license-compatible, line-readable source rather than a
digest. That is a direct, measurable answer to criterion 6 (enhanceability)
and part of criterion 9 (ecosystem fit, scoped honestly to "browser-agent
tooling," not general web dev — see Weaknesses).

## Criterion-by-criterion

**1. Agent-ergonomics (w=3).** Neutral-to-good. Typer (webwright's CLI
framework) gives declarative subcommands/flags on par with `clap`/`commander`.
The stronger asset is Browser Use's `Registry` pattern above: it gives S3 a
proven way to keep "what the LLM sees" and "what actually runs" as one
source of truth, which is precisely the agent-ergonomics failure mode (drift
between a hand-written SKILL.md and the real CLI surface) that `ev-ts-moxxie.md`
praises moxxie for solving with a *discovery-stub* pattern (`moxxie skill
--full` loads the real contract from the binary). S3 can get the same
property for free by forking Browser Use's registry instead of hand-rolling
it.

**2. Quick-task speed (w=2).** This is S3's weakest criterion and I will not
pretend otherwise. `ev-language.md` confirms webwright, as shipped, has **no
daemon/detach code** — it drives Playwright inside its own process lifetime,
consistent with its "one-shot resumable script" design, not a "fast quick
task" design. There is nothing structural stopping a *consolidated* Python
CLI from adopting the same detached-subprocess-plus-CDP-reattach pattern
moxxie already proves works (`session.ts:118-184`, `child.unref()`) —
Python's `subprocess.Popen(..., start_new_session=True)` is the direct
equivalent, and `playwright.chromium.connect_over_cdp` is exactly what
`persistent_local_browser.py` already does. But that daemon does not exist
today; S3 would be building it from the TS pattern, not inheriting it. Cold
interpreter start is also real: Python starts slower than a native Rust
binary and comparably to Node, though `ev-distribution.md` measured Python's
raw *install* (via `uv`) as the fastest of the three (5.0s wall) — that is
install speed, not per-command runtime latency, and I won't conflate them.

**3. Long-running/resumable tasks (w=3).** This is S3's strongest criterion,
and it is not close. Per `ev-longtask.md`, Webwright's script-as-artifact
model is the only one of the three bases with a **real, code-enforced**
completion gate: `_tool_gate_error`/`_self_reflection_gate_error`
mechanically block `done=true` until a judge file with
`predicted_label==1` exists for the latest run folder
(`default.py:202-268`) — "stronger than a prompt-only 'please verify'
instruction." Silver (Rust) has excellent *session/browser-state* resume
(encrypted storage-state, 30s autosave) but explicitly **no task-progress
artifact** — no plan/checklist/step-log/screenshot-per-checkpoint equivalent
was found anywhere in `native/*.rs` (`ev-longtask.md` lines 96-103).
TypeScript has the same gap (`ev-ts-moxxie.md`: "no Webwright-style
'task = re-runnable script, logs are the artifact' concept here"). Only
Python has this already built, tested, and running: numbered
`final_runs/run_<id>/` folders, `final_script.py` + `final_script_log.txt` +
per-checkpoint screenshots, a **keyless-proven** variant
(`skills/webwright/`) where the host LLM plays the judge/loop role with zero
model calls of Webwright's own, and a `/webwright:craft` mode that upgrades
a one-off run into a reusable, `argparse`-based, importable CLI tool
(`cli_tool_mode.md:44-70`) — i.e. long-horizon tasks become durable, replayable
*tools*, not just logs. Context compaction (`_compact_history`) and
ARIA-observation pruning are real, tested token-budget mechanisms, not design
notes. S3 does not have to invent this half of criterion (c); it has to
**port it into the daemon it also needs to build**, which is strictly less
work than Rust or TS's "design this from zero, using only a philosophy
borrowed from a different language" position.

**4. Parallel multi-agent/multi-browser orchestration (w=3).** Mixed, and I
will state the real gap plainly: `ev-parallel.md` confirms webwright's own
README **explicitly disclaims** multi-agent orchestration ("No multi-agent
system, no graph engine... just a terminal, a browser, and a model") and no
async fan-out of multiple browser sessions exists in the driver code. Silver
(Rust) is materially ahead here today — a documented, README-first-class
`--session`/`--namespace` daemon model plus an MCP `session` argument for
routing concurrent tool-call streams. Where S3 earns real credit: (a)
Python's `asyncio` gives the same I/O-bound concurrency shape as Node's event
loop — adequate for many concurrent CDP sockets, the actual workload here —
and the GIL ceiling `ev-language.md` flags only bites CPU-bound work, which
none of the three drivers do in their browser-control hot path; (b) for the
"N sub-agents, N processes" branch specifically (not shared-tab concurrency,
which Aside's own design explicitly argues *against* — `ev-parallel.md`
lines 98-125, "sharing open CDP targets/tabs across concurrent agents would
create races and undefined ownership"), Python's `subprocess`/
`concurrent.futures.ProcessPoolExecutor`/`multiprocessing` stdlib is at least
as mature as Rust's `tokio::spawn` or Node's `child_process.spawn` for
fanning out N independent detached-Chromium sessions, and Webwright's own
`persistent_local_browser.py` sidecar (id/pid/connectUrl JSON) is the exact
per-session isolation primitive moxxie and Silver both already use, just
not yet wired into a fan-out orchestrator. (c) Aside's own hard-won verdict
— always give each subagent its own tab/context, one level of nesting, a
concurrency cap around 5, a two-verb `spawn`/`wait` surface — is
language-agnostic and equally cheap to bolt onto any of the three bases; it
does not favor Rust or TS over Python. Net: S3 starts one rung behind
Silver's Rust daemon on *this specific criterion as currently built*, but the
substrate needed to catch up (asyncio + subprocess fan-out + Webwright's
session-sidecar convention) is already present in the Python ecosystem, not
missing.

**5. Install-and-use / zero-config (w=2).** Genuinely mixed, tested live in
`ev-distribution.md`. Python via `uv` was the *fastest raw package install*
measured of the three (5.0s wall, warm cache) and needs no compiler
toolchain, unlike Rust which today has a **broken** distribution path
(`postinstall.js` points at `vercel-labs/agent-browser`'s GitHub releases,
not a Silver-owned repo; the npm name `agent-browser` is already taken by
the live upstream package, verified `npm view` v0.31.2). Against that: raw
Webwright's own `doctor` command fails zero-config out of the box —
`OPENAI_API_KEY missing = FAIL` — because upstream Webwright calls a model
itself. I will not soften this: it is a real defect in the reference
implementation. But it is a defect of *that specific product's design*, not
of Python as a substrate — moxxie (TS) proves a Playwright-based CLI can be
100% keyless with a clean `doctor`, and a consolidated S3 product would
follow moxxie's own precedent (never call a model, `doctor` never checks for
an API key) rather than webwright's. What S3 does inherit unavoidably is a
Python ≥3.10 runtime requirement plus the same one-time Playwright browser
download that TS also pays — a shared cost, not a Python-specific tax
(`ev-distribution.md`, "Shared cost across TS and Python" section).

**6. Enhanceability / dev velocity (w=3).** S3's second-strongest criterion.
Beyond the fork-not-reimplement argument above: Python's dynamic typing and
huge standard library make it the fastest language of the three for the
kind of glue/orchestration/subprocess-management code a long-task-and-fan-out
CLI is mostly made of (this is explicitly *not* a claim that dynamic typing
is better for correctness — Rust's `838 #[test]` culture and TS's 142-test
suite both buy earlier bug-catching that Python's runtime-typed code does
not get for free; that tradeoff is real and I score it honestly below). The
Webwright codebase itself is a data point for this: ~1.5k LoC agent loop
(per its own README) implementing a judge-gated completion contract,
context compaction, and a persistent-browser sidecar — genuinely small and
readable, "cheap to fully read and mine for ideas, which we just did"
(`ev-webwright-python.md` Pros #5). A Rust or TS rewrite of the same idea set
is estimated at "a day or two" of reimplementation per `ev-webwright-python.md`
line 37 — real but non-trivial cost that S3 avoids for this slice of the
product, while still paying it for the daemon/parallel-orchestration slice
where Rust/TS are ahead.

**7. Keyless fit (w=1).** Fully achievable, same as the other two — this
criterion doesn't differentiate. The one asterisk: Python is the only base
where the primary reference implementation (Webwright's own CLI) *ships
non-keyless by default* and must be deliberately stripped of its
model-calling layer to reach parity with Silver's and moxxie's
keyless-by-construction posture. That stripping is straightforward (delete
`models/`, `image_qa.py`, `self_reflection.py`, keep the judge-*gate*
mechanism and drive it from the host LLM instead, exactly as
`skills/webwright/` already proves) but it is real integration work Rust and
TS don't have to do, since neither of their reference bases ever called a
model.

**8. Leverage of existing assets (w=2).** This is S3's honest, unavoidable
weak point, and I state it without hedging: the project already has a
**working, tested Rust fork** (silver, 838 `#[test]` functions, two shipped
deltas — `extract.rs`, `egress.rs` — already merged and building) and a
**working, tested TypeScript CLI** (moxxie, 142/142 tests passing, verified
live). It has **zero existing Python code of our own**. Choosing S3 means
discarding both of those built-and-verified assets as the shipping product
(they'd become reference material at best) and starting the actual product
code from nothing. No amount of "Browser Use is forkable" changes that this
criterion, weighted 2, scores lowest for S3 of the three strategies — S1 and
S2 both get to point at code that runs today and has our own security/extract
deltas already in it; S3 does not.

**9. Ecosystem fit (w=2).** Split verdict, and I'll separate the two things
this criterion conflates. (a) *Browser-control ecosystem maturity*:
Playwright-Python is officially Microsoft-maintained but is, per
`ev-language.md`, "a generated/wrapped port of the Node implementation, not
the primary implementation surface" — a real, measurable step below
TypeScript's native-Playwright position. I won't spin this as equivalent;
it isn't. It is still production-grade (Browser Use, Webwright, and a large
share of the browser-automation industry ship on it daily), just not the
reference implementation. (b) *Fit with the specific reference corpus this
project must consolidate*: as argued above, Python is the native language of
Webwright and Browser Use — two of the six named sources, and per LoC the
single largest source in the whole corpus (Browser Use, ~64k LoC vs.
Webwright's ~4.7k, vs. Stagehand/Aside as digest-only prose). On the narrower
but directly relevant question — "which language lets us absorb the
most of the actual reference implementations as code rather than as
patterns re-derived from a summary" — Python wins outright. On the broader
question — "which language has the deepest, most current browser-automation
library" — TypeScript wins. Both are legitimate readings of "ecosystem fit";
I present both rather than picking the one favorable to S3.

## Bottom line, argued honestly

S3's case is not "Python is faster or safer or better-tooled" — on quick-task
speed, existing-asset leverage, and native browser-automation-library
primacy, it is the weakest of the three, and I've said so directly above with
the same evidence a skeptic would cite. S3's case is narrower and sharper:
**criterion (c) long-running/resumable tasks is already solved, in
running code, only in Python** (judge-gated completion + context compaction +
persistent-CDP-sidecar, all real and tested in `reference/webwright`), and
**criterion 6 enhanceability is measurably cheaper in Python for the
majority of the reference corpus**, because Webwright and Browser Use — one
small and immediately readable, one large and exhaustively pattern-mined in
`research/sources/browser-use.md` — are both MIT-licensed Python we can fork
line-by-line rather than prose we must re-derive. Those two criteria are
weighted 3 and 3 out of the rubric's 21 total points — enough to matter, not
enough to overcome S3's real deficits on (2) speed, (4) parallel
orchestration as currently built, (8) existing assets, and (9) native
browser-library primacy, all of which favor Rust or TypeScript today. The
honest recommendation *if* S3 is chosen: don't port webwright wholesale —
graft its judge-gated run-folder/checkpoint convention and Browser Use's
registry + DOM-indexing + page-change-guard modules onto a freshly built
asyncio daemon modeled directly on moxxie's `session.ts` detached-Chromium
pattern (the one part of the "fast quick task" story S3 does not have to
invent, only translate from TS to Python).
