# All-Webwright — EVERYTHING transferable (deepdive3, beyond the round-1 digests)

Scope: an exhaustive re-read of the entire Webwright tree (`src/webwright/**`,
`skills/webwright/**`, all `config/*.yaml`) to surface every keyless-transferable
mechanism the four round-1 webwright digests **missed** — the HTTP-resilience
layer, config composition, subprocess hygiene, serialization hygiene, the
code-as-action env, the CDP-attach-real-browser path, anti-drift context
mechanisms, and the verification *protocol* (as opposed to the keyed tool).

Files read in full this round (not just skimmed): `models/base.py` (587),
`agents/default.py` (467), `environments/local_workspace.py` (296),
`environments/local_browser.py` (567), `tools/self_reflection.py` (611),
`tools/image_qa.py` (141), `tools/_model_config.py` (77), `run/cli.py` (175),
`run/doctor.py` (147), `utils/{serialize,runtime,logging}.py`, `exceptions.py`,
`config/{base,local_browser,crafted_cli}.yaml`, all skill + reference files.

**Already established by round 1 (NOT repeated here):** run-folder-as-artifact,
plan.md Critical-Points, prune/compact, the completion gate, explore→author
handoff (`webwright-longtask.md`); CDP-close persistence, encrypted-sidecar
comparison, multi-engine/Firefox gap (`webwright-browserlifecycle.md`); SKILL.md
two-tier + `commands/` + `reference/` packaging (`webwright-skillform.md`);
capture-unconditional/inject-gated vision (`webwright-perception.md`); doctor
`Fix:` text, `craft` CLI-tool mode, hard-rules (`webwright-top5dx.md`). This
digest is strictly the delta.

---

## A. Config composition: `recursive_merge` + `UNSET` sentinel (P1)

**What:** `utils/serialize.py` (23 lines) deep-merges an ordered stack of dict
layers; `UNSET = object()` lets a layer *explicitly decline* to set a field
(skipped, not overwritten with null). This is the entire mechanism behind
`-c base.yaml -c model_x.yaml -c crafted_cli.yaml -c local_browser.yaml` (cli.py:43-44,
61-85). `crafted_cli.yaml` overrides *only* the two prompt templates; `local_browser.yaml`
overrides *only* the env class + a few agent knobs — each layer is a minimal diff.
cli.py's `--debug` overlay (`:70-77`) is the same pattern applied at runtime:
one dict with `headless:False, devtools:True, keep_open_on_exit:True, slow_mo_ms:250`
merged on top, with `UNSET` for the non-debug case.

**Why it helps:** Silver has `core/flags.ts` but no *layered profile* system —
mode selection is imperative. Layered merge gives you `base + engine-profile +
mode-profile` composition where each profile is a tiny override file, and a
profile can leave a field untouched (`UNSET`) instead of forcing a default.

**Silver change:** `core/flags.ts` / a new `core/profiles.ts` — add an ordered
resolve `(defaults, profileOverrides..., cliFlags)` with an `UNSET` sentinel so
`--profile firefox --profile debug` compose. **KEYLESS:** pure dict merge, no
model. **Priority: P1** (enables the `--engine`, `--debug` and future mode work
below cheaply).

## B. Reproducibility manifest: snapshot the resolved config into the run folder (P0)

**What:** cli.py `snapshot_config_specs(...)` writes the fully-merged config to
`<output>/config_snapshot/merged_config.yaml` **before the run**, and every inner
tool later reconstructs the *exact same* settings from it (`_model_config.py`
`resolve_model_config_path` → falls back to `config_snapshot/merged_config.yaml`).
A separate process re-derives identical behavior with zero shared memory.

**Why it helps:** This is the missing piece of the round-1 P0 "compile a replay
script" gap. A `replay.sh` alone isn't reproducible if the engine/viewport/timeouts
differ. Snapshotting the *resolved run parameters* (engine, viewport, timeouts,
namespace, allowlist) into `run_<n>/` makes replay deterministic.

**Silver change:** `task/store.ts` `startRun` — write `run_<n>/run_manifest.json`
capturing the resolved session config (engine, viewport, egress allowlist, flags).
`task exec`/replay reads it back. **KEYLESS:** serialize existing config. **Priority: P0**
(pairs with the round-1 replay-script gap; without it replay is non-deterministic).

## C. HTTP-resilience taxonomy: rate-limit vs transient, cause-chain walking (P1)

**What:** `models/base.py:56-104` — two classifiers that walk the entire
`__cause__` chain: `_is_rate_limit_error` (status 429 on the exc *or* its
`.response`, plus text needles "rate limit"/"too many requests") and
`_is_transient_http_error` (httpx Timeout/NetworkError/RemoteProtocolError, the
explicit retryable status set `{408,409,425,500,502,503,504}`, and text needles
"bad gateway"/"connection reset"/"timed out"…). `_post_with_retries` (`:431-461`)
gives each class its *own* backoff schedule and budget: rate-limit `min(5*(n+1),30)`
×5, transient `min(2*(n+1),10)`×5, and logs each attempt as structured JSONL.

**Why it helps:** Silver's `core/errors.ts` has a `retryableByHost` *boolean per
error code* but no network-layer retry — the host must re-issue. Silver's own
`navigate`/extract-fetch/`connectOverCDP` calls have no internal transient-retry;
a flaky 503 or a connection reset surfaces as a hard failure the host must
babysit. Webwright's classifier + dual-budget backoff is directly portable to
those internal HTTP/CDP calls.

**Silver change:** `actuation/wait.ts` or a new `core/retry.ts` — a
`withRetries(fn, {rateLimit, transient})` wrapping `page.goto`, CDP attach, and
extract HTTP fetches, using the same status set + cause-chain walk. **KEYLESS:**
network resilience, no model. **Priority: P1** (turns a class of flaky failures
into silent recoveries; measurable task-success lift).

## D. Structured error JSONL with capped response bodies (P2)

**What:** `utils/logging.py append_runtime_log` — append-only JSONL with UTC
timestamp + source + event + arbitrary kwargs; `base.py:341-363 _log_gateway_error`
records error_type, status_code, endpoint, attempt, and the response body
**truncated to 4000 chars**. Separate `raw_responses.jsonl` sink for every raw
model reply (`_raw_response_log_path`).

**Why it helps:** Silver logs `action_log.jsonl` but not a *separate diagnostic
sink* for failed network attempts with bounded bodies. When a run fails, you want
the last 5 gateway errors with status + body, not buried in the action log.

**Silver change:** `task/store.ts` — a sibling `runtime_errors.jsonl` in the run
folder; `core/errors.ts` writes failed-attempt records there with a 4KB body cap.
**KEYLESS.** **Priority: P2.**

## E. Pre-flight `bash -n` syntax check on generated commands (P1)

**What:** `models/base.py:123-136 _validate_bash_command` runs `bash -n` (parse-only,
no execution) on the model's `bash_command` *before* the env runs it; a syntax
error becomes a targeted FormatError repair message rather than a broken run.

**Why it helps:** Directly relevant to the round-1 P0 "compile a `replay.sh`"
idea — Silver should `bash -n` the generated replay script before writing/running
it, and any shell/script Silver emits. Cheap correctness gate that catches
malformed heredocs/quotes before they waste a run.

**Silver change:** wherever Silver emits a shell artifact (the future `task compile`
→ `replay.sh`) run `bash -n` and refuse to write on failure. **KEYLESS:** `bash -n`
is a syntax check, no model. **Priority: P1** (guards the replay-script feature).

## F. Subprocess env hygiene for clean, non-blocking captured output (P1)

**What:** `base.yaml:71-76` sets `PAGER=cat, MANPAGER=cat, LESS=-R,
PIP_PROGRESS_BAR=off, TQDM_DISABLE=1` on every generated subprocess, and
`local_workspace.py:184-189` injects `WORKSPACE_DIR, TMPDIR=<ws>/.tmp,
FINAL_SCRIPT_PATH` into the command env. The PAGER/progress-bar vars prevent an
interactive pager from *hanging* the capture and progress spinners from polluting
stdout.

**Why it helps:** Silver's `task exec` dispatches subprocesses; any tool that
paginates (git, man, less) or draws a progress bar will either block the capture
or fill the observation with `\r`-spam. This is a one-line env-map fix with an
outsized reliability payoff on long unattended runs.

**Silver change:** `task/index.ts` exec dispatch — merge a fixed
`{PAGER:'cat', MANPAGER:'cat', LESS:'-R', PIP_PROGRESS_BAR:'off', TQDM_DISABLE:'1',
CI:'1', NO_COLOR:'1'}` into the child env, plus a workspace-scoped `TMPDIR`.
**KEYLESS.** **Priority: P1** (prevents a whole class of hangs).

## G. Output truncation with an explicit omitted-count marker (P2)

**What:** `local_workspace.py:112-116 _truncate`: `text[:limit] + "\n\n...
[{omitted} characters omitted]"`, `output_truncation_chars=24000`. The marker
tells the reader exactly how much was cut, so the host knows to re-fetch narrower.

**Why it helps:** Silver's serializer has a *never-truncate / fail-loud*
`output_overflow` contract (errors.ts:70-73, handlers.ts:1218). That's correct for
snapshots, but for *command stdout* in `task exec` a bounded-with-marker truncation
is friendlier than a hard overflow error — the host still sees the head + a precise
omitted count.

**Silver change:** `task/index.ts` exec — truncate captured stdout to N chars with
the `[N characters omitted]` marker (distinct from the snapshot overflow path).
**KEYLESS.** **Priority: P2.**

## H. Serialization hygiene: strip base64 image data-URLs before persisting (P1)

**What:** `agents/default.py:49-56 _sanitize_message_for_disk` deep-copies each
message and replaces any `input_image.image_url` (a multi-MB `data:...base64,`
blob) with `"<omitted:data-url>"` before writing `trajectory.json`. Without it the
saved trajectory bloats by megabytes per screenshot.

**Why it helps:** Silver's `screenshot` verb can return `{encoding:'base64', image}`
and `task checkpoint`/`action_log.jsonl` could capture responses. Any log/trajectory
that ever holds a base64 image blob will bloat the run folder and slow reads. A
strip-on-persist guard is essential the moment Silver persists any envelope that
*might* contain an image.

**Silver change:** `task/store.ts appendLog` — before writing, replace any
base64 `image`/data-URL field in the event with a `<omitted:base64 N bytes>`
placeholder. **KEYLESS.** **Priority: P1** (prevents unbounded run-folder growth).

## I. Keyless byte/char accounting surface (cumulative + last) (P2)

**What:** `base.py:160-185, 291-339` computes per-request `message_count,
text_part_count, image_part_count, text_chars, serialized_chars` and maintains
**cumulative** totals, exposed as Jinja template vars (`cumulative_serialized_chars`,
`last_request_text_chars`, …). Even absent token counts, the *char/byte* metrics
are computed with zero model calls.

**Why it helps:** Silver is keyless so it can't report tokens — but it *can* report
bytes/chars per command and cumulatively for a session/task, giving the host a
budget signal ("this session has emitted 480 KB of snapshots; consider compacting").
This is a keyless analog of a token meter.

**Silver change:** `task/index.ts status` — include `cumulativeBytes`,
`lastCommandBytes`, `snapshotCount` derived from `action_log.jsonl`. **KEYLESS.**
**Priority: P2.**

## J. Anti-goal-drift: re-attach instructions + live plan.md each step (P1)

**What:** `agents/default.py:428-436` — `attach_instance_template_after_observation`
re-injects the full task instructions after each observation, and
`attach_plan_md_after_observation` + `_plan_md_message` (`:190-200`) re-reads
`plan.md` from disk and re-injects the *current* checklist every step. On a
100-step run the goal + live plan never fall out of the window.

**Why it helps:** Distinct from compaction (which summarizes the *past*); this
keeps the *goal and remaining CPs* fresh. Silver's `task exec` returns only the
command result — a host driving a long loop can lose the goal to context rot.

**Silver change:** `task/index.ts exec` — an opt-in `--echo-plan` that appends the
current `plan.md` checklist (open CPs first) and the original goal to each exec
envelope. **KEYLESS:** reads `plan.md` from disk. **Priority: P1** (cheap
anti-drift; complements the round-1 compaction gap).

## K. Always-visible artifact preview + recent-files list in each observation (P2)

**What:** `local_workspace.py:243-272 _capture_observation` folds into *every*
observation: a 4000-char `final_script_preview` (current artifact state, no
re-read needed), `recent_screenshots` (mtime-sorted, top 10), and `workspace_files`
(mtime-sorted, top 40). The agent always sees "what the artifact looks like now"
and "what changed most recently."

**Why it helps:** Silver's `task status` reports CPs but not a preview of the
current replay artifact or a "recently modified" list. A host resuming after a
crash benefits from a mtime-sorted recent-files view of the run folder.

**Silver change:** `task/index.ts status` — add `recentFiles` (mtime-sorted top-N
of the run folder) + a truncated preview of the plan/replay artifact. **KEYLESS.**
**Priority: P2.**

## L. The verification *protocol* (keyless-portable), not the keyed tool (P1)

**What:** `self_reflection.py` is keyed, but its *protocol* is fully specified in
`base.yaml:250-314` as verbatim prompt content the host can run natively:
(1) per-image **harsh 1-5 score + one-line reasoning** ("5 = clearly evidences a
CP, 1 = no relevant evidence"); (2) an **aggregate verdict** over ALL images + the
`final_script_log.txt` action log that must end with a trailing
`Status: success|failure`. Parsing is defensive: `_parse_final_verdict:283-291`
takes the **last** `Status:` occurrence, tolerates smart-quotes/whitespace, and
**treats unparsed as FAIL**; `_judge_one_image` retries parse 3× then records
`Score:0, ParseFailed:true` without failing the batch (`:340-348`).

**Why it helps:** Round-1 perception said "host does its own vision" but didn't
lift the *specific two-stage rubric + the fail-closed parse discipline*. That
rubric is a ready-made `task verify` protocol section: score each checkpoint
screenshot 1-5, then one aggregate pass over all evidence + the action log,
fail-closed on ambiguity. It's the honest-completion contract in keyless form.

**Silver change:** `skill-data/core/` (or a new `task-verify.md`) — port the
two-stage harsh rubric + "trailing verdict, unparsed = FAIL, be harsh on occluded
evidence" as the host-run verification protocol for `task verify`. **KEYLESS:** the
host is the judge; Silver only checks evidence *exists* on disk (round-1 GAP-3).
**Priority: P1** (the doc half of the honest-completion gate).

## M. `image_qa` structured contract as a keyless prompt shape (P2)

**What:** `image_qa.py:14-20 _build_prompt` forces `{answer, evidence[], unknown:bool,
confidence:number}` and `_parse_json_response:57-68` recovers JSON even from prose
by slicing the first `{` … last `}`. The `unknown` boolean + `evidence[]` array is
a disciplined "don't guess, cite or abstain" shape.

**Why it helps:** When Silver's host reasons over a `screenshot` payload, this is
the exact output contract to recommend — abstain (`unknown:true`) rather than
hallucinate, cite `evidence`. Pure doc guidance.

**Silver change:** `skill-data/core/SKILL.md` vision section — recommend the
`{answer, evidence[], unknown, confidence}` shape + the brace-slice fallback.
**KEYLESS.** **Priority: P2.**

## N. Real-Chrome CDP attach with auto-start + proxy-bypass probing (P2)

**What:** `local_browser.py` `local_cdp` mode: `_ensure_local_cdp_browser:262-308`
attaches to a real Chrome/Edge on :9222, and if absent **auto-launches** it
(`_CHROMIUM_EXECUTABLE_CANDIDATES` list incl. macOS `open -na "Google Chrome"
--args --remote-debugging-port`), with a dedicated `~/.cache/webwright/edge-profile`.
Readiness probes hit `/json/version`; page targets via `/json/list`; a target is
force-created via PUT `/json/new`. Critically, `_LOCAL_CDP_OPENER =
build_opener(ProxyHandler({}))` (`:35`) **bypasses `HTTP_PROXY`/`HTTPS_PROXY` env
vars** for localhost CDP probes — a real gotcha, since a corp proxy env breaks
`127.0.0.1:9222` probing. `local_cdp_new_page:true` creates a *fresh* tab each run
rather than inheriting a stale one (`:74`, `:337-339`).

**Why it helps:** Silver's `connectExternalSession` (session.ts:360-380) attaches
to an external browser but (per round-1) doesn't auto-start-if-absent, and Silver's
`/json/version` readiness probe should also bypass the proxy for localhost. The
"manual Google login persists in a real profile, then agent drives it" use case is
a distinct capability worth documenting.

**Silver change:** (1) `core/session.ts` — bypass env proxy on all localhost
DevTools JSON probes; (2) create a fresh page on external attach; (3) optional
auto-start of a real browser with a dedicated profile for login-required flows.
**KEYLESS.** **Priority: P2** (proxy-bypass is the sharpest sub-item — a silent
failure class).

## O. `doctor` details worth stealing beyond the `Fix:` text (P2)

**What:** beyond round-1's `Fix:`-text point: `check_chromium` uses
`playwright install --dry-run` **return code** as the "is everything present"
probe (`doctor.py:30-44`) — one command that reports any missing browser; and the
whole doctor prints a `passed/total` count as a Rich table (`:118-143`). The
`--dry-run` trick is a cheaper full-install check than per-binary `existsSync`.

**Why it helps:** Silver's `handleDoctor` checks `chromium.executablePath()` exists
but not that the *install is complete*; `playwright install --dry-run` catches a
partial install `existsSync` misses.

**Silver change:** `core/handlers.ts handleDoctor` — add a `--dry-run` completeness
check + `passed/total` count (complements the round-1 real-launch-probe + `Fix:`
recommendations). **KEYLESS.** **Priority: P2.**

## P. Fail-safe compaction + framed summary markers (P2)

**What:** `_compact_history:303-339` wraps the summary in explicit
`## Compacted History Summary … ## End of Compacted Summary` markers **and swallows
any exception** (`except Exception: return` — "never fail the run due to
compaction"). The compaction is best-effort: if it errors, the run continues with
the un-compacted transcript rather than dying.

**Why it helps:** For the round-1 P1 "host-fillable compaction template" gap, the
transferable discipline is: (a) frame the compacted region with unmistakable
markers so it's never re-summarized, and (b) make compaction non-fatal.

**Silver change:** `task/store.ts` compact — store the host summary between framed
markers; if the compact step fails, keep the prior baseline. **KEYLESS.**
**Priority: P2.**

## Q. Per-step timeout + settle-before-observe (P2)

**What:** `local_browser.py:402-406` wraps each action in `asyncio.wait_for(...,
step_execution_timeout_ms)` and then `_wait_for_observation_ready` does a
best-effort `wait_for_load_state("domcontentloaded")` (swallowing timeout) *before*
snapshotting — so the observation reflects a settled page. Every observation field
is in its own `try/except` so one failure (screenshot on a closing tab) doesn't
blank the rest (`:470-502`).

**Why it helps:** Silver has `actuation/pagechange.ts`/`wait.ts`; the explicit
"settle then observe, each observation field independently guarded" ordering is a
robustness detail for `task checkpoint` capture.

**Silver change:** `task/index.ts captureScreenshot` — best-effort settle before
the snapshot; wrap each captured field independently. **KEYLESS.** **Priority: P2.**

## R. Trajectory-viewer assets: render a run folder to HTML (P3)

**What:** `assets/task_showcase/app.py` (Flask) renders `task.json` + `report.json`
per task into a dashboard, and `assets/compare_trajectory/` is a static
trajectory-*diff* viewer (index.html + app.js). Webwright ships tooling to *inspect*
run folders visually.

**Why it helps:** Silver's run folders are inspectable only via raw files. A
`silver task report <id>` that renders `plan.md` + `action_log.jsonl` + screenshots
to a self-contained HTML page (an Artifact) would make long-run debugging far
easier.

**Silver change:** new `task report` verb emitting a single self-contained HTML
digest of a run folder. **KEYLESS.** **Priority: P3** (DX polish).

## S. Deliberate non-adoptions (documented so nobody re-litigates)

- **`exec`-with-injected-scope** (`local_browser.py:432-450`: wrap code in
  `async def __agent_step__(page, context, browser, playwright, task)`, `exec`,
  await, capture stdout via `redirect_stdout`). Powerful but it's *arbitrary
  code execution* — Silver's verb model is deliberately safer; do **not** adopt.
- **`run_async` guard** (`utils/runtime.py`: refuses to run inside an active
  event loop) — a Python asyncio quirk irrelevant to Node.
- **`image_qa`/`self_reflection` as tools** — keyed; round 1 already deleted them.

---

## Priority roll-up (new items only)

- **P0:** B (run manifest — makes replay deterministic).
- **P1:** A (config layering), C (HTTP retry taxonomy), E (`bash -n` guard),
  F (subprocess env hygiene), H (strip base64 on persist), J (re-attach
  plan/goal anti-drift), L (verification protocol as keyless doc).
- **P2:** D (error JSONL), G (truncation marker), I (byte accounting),
  K (artifact preview + recent files), M (image_qa contract),
  N (proxy-bypass + auto-start CDP), O (doctor `--dry-run` + count),
  P (fail-safe compaction), Q (settle-before-observe).
- **P3:** R (HTML run-folder report).

**Single highest-leverage new find:** the **HTTP-resilience taxonomy (C)** +
**subprocess env hygiene (F)** — both are pure keyless reliability infrastructure
that Silver lacks entirely, both turn a class of flaky/hanging failures into silent
recoveries, and neither touches the model. After those, **B (run manifest)** is
what actually makes the round-1 P0 replay-script honest.
