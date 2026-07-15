# Top 5 — Webwright vs Silver (persistence, long-task handling, skill form)

Sources read: `reference/webwright/src/webwright/tools/persistent_local_browser.py`,
`reference/webwright/src/webwright/environments/local_browser.py`,
`reference/webwright/src/webwright/agents/default.py`,
`reference/webwright/skills/webwright/SKILL.md`,
`reference/webwright/skills/webwright/reference/cli_tool_mode.md`
— vs Silver `silver/src/core/session.ts`, `silver/src/task/{index,store}.ts`,
`silver/src/perception/{diff,walk}.ts`, `silver/src/core/capture.ts`.

---

## 1. Detached, persisted CDP browser (open once, reconnect per command)
**Webwright:** `tools/persistent_local_browser.py:107-169` (`_cmd_create`) spawns
Chromium with `--remote-debugging-port=0` + a per-session `--user-data-dir`,
`start_new_session=True` to detach it, parses the `DevTools listening on
ws://...` line from stderr (`_wait_for_devtools_url:81-104`), and writes
`{id, pid, connectUrl, userDataDir}` as **plaintext** JSON so any later bash
step can `connect_over_cdp` and must call `browser.disconnect()` (never
`.close()`) to keep it alive. `environments/local_browser.py:262-308`
(`_ensure_local_cdp_browser`) additionally auto-launches a *real* Chrome/Edge
app via macOS `open -na` when in `local_cdp` mode.

**Silver already has this — and a superset.** `core/session.ts:204-270`
(`openSession`) does the same detach-and-persist trick, but: sidecars are
**encrypted at rest** (AES-256-GCM by default, `writeSidecar`/`atomicWrite`,
:122-149) vs webwright's plaintext file; writes are **atomic** (temp+rename,
:122-131) vs webwright's direct `write_text`; there's a **pid-liveness check**
before reconnect (`isPidAlive`, :335) that auto-fails a stale sidecar instead
of hanging on a dead CDP endpoint (webwright's `info` subcommand only reports
liveness, it doesn't gate `connect`); and there's a distinct **external-session
mode** (`connectExternalSession`, :360-380) for attaching to a browser Silver
doesn't own (mirrors webwright's `local_cdp` mode) with correctly scoped
teardown (never signals pid 0 / the whole process group, :453-458).
**Verdict: Silver > Webwright here**, not a gap.

## 2. Re-runnable script artifact (`final_script.py` / CLI tool mode)
**Webwright:** the mandatory workspace contract
(`skills/webwright/SKILL.md:45-61`) requires every task to produce
`final_runs/run_<id>/final_script.py` — a literal, standalone Python file
that can be executed **with zero agent/LLM in the loop**:
`cd final_runs/run_<id> && python final_script.py`. `cli_tool_mode.md:56-126`
goes further: one reusable function with a Google-style `Args:` docstring,
every task-specific value promoted to an `argparse --flag` with the original
value as default, an **import-safety smoke test** (`cli_tool_mode.md:143-153`,
importing the module must not launch a browser), and a required
`step 0 params: ...` log line so a rerun's resolved inputs are auditable.

**GAP — Silver does not have this.** `src/task/store.ts` and
`src/task/index.ts` persist `plan.md` + `action_log.jsonl` + `checkpoint.json`
— a *record of what happened*, not an executable reproduction of it.
`task resume` (`index.ts:200-225`) and `task exec` (`index.ts:227-269`)
explicitly require the **host to come back and re-issue `silver` commands**;
there is no artifact a human, cron job, or CI runner can execute standalone
to redo the task with different arguments. Silver should add something like
`silver task compile <id>` that turns `action_log.jsonl`'s recorded
`silver` invocations into a runnable script (shell script of `silver`
calls, or a Playwright script) with the constant values parameterized as
flags — the "the script is the artifact" idea Silver's own code comments
cite (`store.ts:4-6`, "DECISION §3 the script IS the artifact; re-running it
is the resume") but does not yet deliver on.

## 3. `plan.md` Critical-Points checklist scaffold
**Webwright:** `SKILL.md:73-83` requires a numbered checklist of every
explicit constraint/filter/sort/datum, each tickable `[x]` only with cited
screenshot/log evidence, plus a harsh self-verification pass
(`SKILL.md:98-112`) that re-opens every cited screenshot and refuses to tick
ambiguous states.

**Silver already has this — directly ported.** `task/store.ts:105-119`
(`planTemplate`) writes essentially the same Critical-Points contract
verbatim (own comment: "Webwright's keyless task convention, ported",
`store.ts:2`), and `task/index.ts:98` scaffolds `screenshots/` +
`checkpoint.json.lastScreenshot` for the same cited-evidence discipline.
Neither system enforces "harsh verification" in code — in both, that
discipline lives in the calling agent/skill prompt, not the harness. Not a
gap; already adopted.

## 4. Firefox fallback to dodge Chromium TLS/H2 fingerprint blocks
**Webwright:** `SKILL.md:62-66` deliberately launches
`playwright.firefox.launch(headless=True)` instead of Chromium, explicitly
because "some sites fail under Chromium with `ERR_HTTP2_PROTOCOL_ERROR` due
to TLS/H2 fingerprinting." This is a documented, load-bearing engine choice,
not an incidental default.

**GAP — Silver is Chromium-only.** `core/session.ts:18` imports only
`{ chromium }` from `playwright`, and `openSession` (:204-270) has no engine
parameter — every session is a Chromium process
(`chromium.executablePath()`, :210). Grepping Silver's src for
`firefox`/`webkit` returns nothing. Any site that fingerprint-blocks
Chromium's TLS/H2 client hello has no fallback engine in Silver today; a
task simply fails where webwright's default would have worked. This is a
concrete, cheap-to-close gap (Playwright already bundles Firefox) worth
adding as `--engine firefox|chromium` on `session open`.

## 5. Automatic per-step observation capture baked into the execution loop
**Webwright:** `environments/local_browser.py:_execute_async` (:391-420)
wraps every action in a hard `asyncio.wait_for(..., timeout=
step_execution_timeout_ms)`, and unconditionally calls `_capture_observation`
(:463-502) after **every single step** — url, title, a full `aria_snapshot()`,
a screenshot, and the last-20-lines of console output — with no separate
call required. Page-level `console`/`pageerror` listeners
(`_attach_page_listeners`, :370-386) accumulate a rolling history
automatically for the life of the environment.

**Partial gap, by design tradeoff.** Silver's snapshot capture
(`perception/diff.ts`) is arguably *more* sophisticated per call — it emits a
git-style unified diff against the previous tree instead of a flat
`aria_snapshot()` every time (`diff.ts:8-45`), which is a real token-economy
win webwright doesn't have. But Silver's task artifact only gets a
screenshot on an explicit `silver task checkpoint` call
(`task/index.ts:119-161`, `captureScreenshot`, :317-331) — nothing is
captured automatically after ordinary browser actions (`click`, `type`,
`goto`, etc.) the way webwright's harness captures on every step
unconditionally. Silver also deliberately avoids `page.on('console')`
listeners in favor of in-page buffers (`core/capture.ts:4-5`, explained as a
consequence of the stateless per-command CDP reconnect model) — a defensible
design choice, not a bug, but it means nothing forces evidence capture
during a long unattended run unless the *host* remembers to call
`task checkpoint`. Worth considering a lightweight opt-in
(`--auto-checkpoint-every N`) on `task` so long runs get periodic evidence
without relying on host discipline.

---

## Summary of verdicts
| # | Capability | Verdict |
|---|---|---|
| 1 | Detached/persisted CDP browser | Silver already has it — superset (encryption, atomicity, pid-liveness, external mode) |
| 2 | Re-runnable script artifact | **GAP** — Silver logs the run, webwright produces an executable one |
| 3 | plan.md Critical-Points checklist | Silver already has it — directly ported |
| 4 | Firefox fallback for fingerprint blocks | **GAP** — Silver is Chromium-only |
| 5 | Automatic per-step observation capture | **Partial gap** — Silver's diff format is better; capture cadence is host-driven, not automatic |
