# Alignment digest — webwright tests/eval-harness vs moxxie/evals

Source read: `reference/webwright/tests/{conftest.py,unit/test_doctor.py,unit/test_tool_model_routing.py}`,
`reference/webwright/src/webwright/run/doctor.py` (the module under test),
`reference/webwright/pyproject.toml`.
Moxxie read: `evals/README.md`, `evals/harness/{run.mjs,trifecta.mjs,judge.mjs,ab.mjs}`,
`evals/tasks/smoke/*.json`, `skill/agent-browser/src/{cli.ts,core/handlers.ts,core/session.ts}`,
`skill/agent-browser/tests/unit/*.ts`, `skill/agent-browser/tests/integration/*.ts`.

## Headline finding

webwright ships **no task-completion benchmark at all** — its `tests/` directory is two
small pytest unit files (doctor health-checks, model-routing config merge) plus a
one-line `conftest.py` path shim. There is no scripted-host runner, no pass@k, no
security/trifecta suite, no cross-family judge, no A/B differentiator. Moxxie's
`evals/` (deterministic `run.mjs` gate with `pass_k`, `trifecta.mjs`'s three
proof-by-runnable-code security closures, `judge.mjs`'s non-flipping cross-family
judge, `ab.mjs`'s side-by-side vs Vercel) is already a superset of what webwright
tests. So the "eval improvement" harvest from this source is small and narrow: it's
not a benchmark upgrade, it's two specific **unit-test-granularity patterns**
webwright applies to its `doctor` command and its config-resolution code that
moxxie's own `doctor` verb currently lacks entirely (moxxie has zero tests for
`handleDoctor`), plus one cargo-cult item to explicitly not import (a required
API-key check, which is structurally incompatible with a keyless tool).

## Gap-alignment findings

1. **`moxxie doctor`'s chromium check never actually launches a browser — webwright's does.**
   `webwright.run.doctor.check_screenshot` (reference/webwright/src/webwright/run/doctor.py:47-75)
   launches headless Chromium, sets page content, screenshots to a file, and asserts
   the file exists — a true end-to-end proof the automation pipeline works. Moxxie's
   `handleDoctor` (skill/agent-browser/src/core/handlers.ts:833-856) only checks
   `chromium.executablePath()` + `existsSync(exec)` — a file-presence check that
   passes even when the binary can't actually launch (missing shared libs, broken
   install, sandbox denial — common on fresh CI/containers). Add a real
   launch→setContent→screenshot→close probe as a `screenshot_ok` field in the doctor
   report, alongside (not replacing) the cheap existsSync pre-check.
   keyless_ok: true. Priority: P1.

2. **`handleDoctor` has zero unit tests; webwright tests every check function in isolation.**
   `test_doctor.py` imports each check (`check_chromium`, `check_screenshot`,
   `check_plugin_manifests`, etc.) and asserts on its `(bool, str)` return shape,
   using `tmp_path`/`monkeypatch.chdir` to make filesystem-dependent checks
   deterministic. `find skill/agent-browser/tests -iname '*doctor*'` returns nothing —
   moxxie's `handleDoctor` (handlers.ts:833) is exercised only incidentally, if at
   all, through integration tests. Refactor `handleDoctor` into small exported pure
   checks (`checkChromiumExecutable`, `checkWritable`, `checkScreenshot`) each
   returning `{ok, detail}`, and add `skill/agent-browser/tests/unit/doctor.test.ts`
   mirroring webwright's per-check assertions (type/shape checks + a
   monkeypatch-equivalent for the writable-root check, see finding 4).
   keyless_ok: true. Priority: P1.

3. **skip-cargo-cult: `check_openai_key`.** webwright's doctor
   (doctor.py:78-84) hard-requires `OPENAI_API_KEY` to report healthy — appropriate
   for webwright's model-in-the-loop design, structurally wrong for moxxie. Moxxie's
   `SKILL.md`/handlers already assert "KEYLESS: no model call anywhere" (handlers.ts:19).
   Do not add any doctor check that requires or rewards the presence of a model API
   key — that would silently reintroduce a keyed dependency into a tool whose whole
   moat is `evals/README.md`'s "always-green gate (no model required)". If a status
   field for optional host-side model keys is ever wanted (e.g. informational,
   for the optional `judge.mjs` layer), it must be clearly marked non-gating,
   exactly as `judge.mjs`'s `_advisory: true` already does.
   keyless_ok: true (the "gap" here is the discipline not to adopt).
   recommendation: skip-cargo-cult. Priority: P1 (as a guardrail against future drift).

4. **Session/doctor storage root is hardcoded to `os.homedir()` with no override — webwright's config resolution is fully injectable and precedence-tested.**
   `sessionsRoot()` (skill/agent-browser/src/core/session.ts:52-55) and the doctor
   writable-probe (handlers.ts:846, `path.join(os.homedir(), '.moxxie')`) always
   touch the real home directory; there is no env-var or flag override, so both
   production runs and any future unit test for these paths mutate the operator's
   real `~/.moxxie`. Contrast webwright's `resolve_model_config_path`
   (tested in test_tool_model_routing.py:39-69): three cleanly separated,
   independently-tested precedence tiers — explicit arg wins, else a workspace
   snapshot file, else a `FileNotFoundError` with a matched, actionable message —
   all exercised via `tmp_path` with zero real-FS pollution. Add a
   `MOXXIE_HOME`/`--home` override (checked before `os.homedir()`) to
   `sessionsRoot()` and the doctor writable-probe, then add a
   precedence-tiered unit test (override present → override used; override absent →
   `os.homedir()`) so `doctor.test.ts` and `session.test.ts` never need to touch the
   real home directory.
   keyless_ok: true. Priority: P1.

5. **align, low priority: plugin-manifest presence check.** webwright's
   `check_plugin_manifests` (doctor.py:87-105) verifies `.claude-plugin/plugin.json`
   and `.codex-plugin/plugin.json` exist, for its dual Claude/Codex plugin
   distribution model. `find . -iname 'plugin.json'` over moxxie's repo (excluding
   `reference/`) returns nothing — moxxie doesn't yet ship as a discoverable
   Claude/Codex plugin (only `skill/agent-browser`'s own `SKILL.md`, itself not yet
   written per handlers.ts:875's "Full SKILL.md ships in a later task" comment).
   No action now; when moxxie's plugin manifests are added, mirror this pattern as
   an additional `handleDoctor` check ("is this install correctly registered as a
   plugin") rather than inventing a new shape.
   keyless_ok: true. recommendation: align (deferred). Priority: P2.

6. **conftest.py's one-line sys.path shim has no moxxie analogue and needs none.**
   webwright's `tests/conftest.py` only adds `src/` to `sys.path` because pytest
   needs it for an unpackaged layout. Moxxie's vitest config + `tsconfig`/ESM
   imports already resolve `src/` correctly (confirmed: all of
   `skill/agent-browser/tests/unit/*.ts` import directly from `../../src/...`
   without any path shim). Nothing to adopt.
   keyless_ok: true. recommendation: skip-cargo-cult. Priority: P2 (informational only).

7. **skip-cargo-cult: `test_tool_model_routing.py`'s model-class/tool-override merge tests.**
   This file (reference/webwright/tests/unit/test_tool_model_routing.py) tests
   YAML config merging for *which model class routes to which tool call*
   (`config["model"]["model_class"] == "anthropic"`, per-tool override rejection).
   This entire subsystem — routing tool calls to a chosen LLM provider — has no
   moxxie equivalent and must not gain one: moxxie never calls a model
   (cli.ts:19, "KEYLESS: no model call anywhere"). The only transferable piece is
   the *testing pattern* (precedence tiers, tested independently, via `tmp_path`),
   which is captured separately in finding 4 as it applies to moxxie's actual
   config surface (session/doctor home-dir resolution), not to a model router that
   shouldn't exist.
   keyless_ok: true. recommendation: skip-cargo-cult. Priority: P2.

8. **Confirms moxxie's eval scoring design already exceeds this source; no benchmark-shape import needed.**
   webwright's `pyproject.toml` declares no eval/benchmark dependency (no
   `pytest-benchmark`, no scoring harness) and its `tests/` directory has no
   task-completion suite to compare scoring methodology against. Moxxie's
   `pass_k` threshold gate (evals/harness/run.mjs:242-251, exits non-zero below
   0.8), global hallucination-trap forbidden-set injected into every task
   (run.mjs:50-60), and non-flipping cross-family judge design (judge.mjs:1-19)
   have no counterpart to borrow from webwright at all. Recorded here so a future
   pass doesn't waste time re-deriving "webwright has no eval scoring to adopt."
   keyless_ok: true. recommendation: skip-cargo-cult (nothing to import).
   Priority: P2 (documentation of a negative result).

## Top recommendation

Close the two P1 doctor gaps together as one change: refactor
`handleDoctor` (skill/agent-browser/src/core/handlers.ts:833) into small exported
check functions, add a real launch→screenshot probe (mirroring
`check_screenshot` in reference/webwright/src/webwright/run/doctor.py:47-75), make
the writable/home-dir probe overridable via `MOXXIE_HOME` (mirroring the
tested precedence pattern in
reference/webwright/tests/unit/test_tool_model_routing.py:39-69), and add
`skill/agent-browser/tests/unit/doctor.test.ts` covering both — this is the one
change that turns an currently-untested, partially-fake-passing health check into
one that (a) proves the browser actually launches and (b) is testable without
touching the operator's real home directory.
