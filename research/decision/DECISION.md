# DECISION — Silver: the ULTIMATE keyless browser CLI/skill

**Verdict: S2 — TypeScript / consolidate.** Ship one product in TypeScript on
Playwright/CDP, built on the existing `skill/agent-browser` ("moxxie") base,
absorbing the Rust fork's architecture ideas, Webwright's task-artifact
convention, and Aside's subagent/memory patterns.

Judge consensus was unanimous (5/5 for S2) with the highest weighted average
(S2 79 · S1 75 · S3 65). After reading all eleven `ev-*`/`adv-*` digests and
re-verifying the load-bearing facts against the code, I concur. This is a
verified decision, not a rubber-stamp — below is why the owner's Rust lean loses
on the evidence, and the honest migration cost.

---

## 1. Chosen language + base, and why

**Language: TypeScript. Base: `skill/agent-browser` (moxxie), extended.**

The decision turns on separating *permanent structural advantages* from *bounded
unfinished work*, then noticing which base carries which.

### S2's advantages are structural (permanent)

- **Ecosystem fit (w2).** Playwright is TS-native — Node is its reference
  implementation; Python's is a generated binding, and Rust has *no* Playwright
  at all (hand-rolled CDP over `tokio-tungstenite` against raw
  `browser_protocol.json`, verified). Rust owns 100% of the CDP
  protocol-compatibility burden forever; TS inherits auto-wait, selector engine,
  network interception, and multi-browser support maintained upstream by
  Playwright's own authors. This gap never closes — it is the library's design.
- **Dev velocity (w3).** Verified live: moxxie is 5,117 LoC; the Rust fork is
  71,796 LoC (14×). `tsc` + 142-test vitest suite runs in ~13.6s; the Rust
  release profile (`lto=true, codegen-units=1`) costs **1m34s to rebuild on a
  one-file touch** (measured). And **46 of ~64 Rust source files already diverge
  from upstream Vercel** — every future upstream security fix is a manual
  re-merge. TS carries zero fork-rebasing tax (its `NOTICE` credits adapted
  *patterns*, not a vendored codebase).
- **Distribution (w2).** Tested live: moxxie ships a checked-in `dist/cli.js`
  that runs instantly, and the npm name `moxxie` is free (404). The Rust fork's
  distribution is **currently broken** — `package.json` name is `agent-browser`
  (taken, upstream v0.31.2 published live) and `postinstall.js` hardcodes
  `GITHUB_REPO = 'vercel-labs/agent-browser'` (verified), so it would fetch the
  wrong project's binaries; no prebuilt binaries exist in-repo, so a fresh
  sandbox must compile 332 crates.
- **Enhanceability of the Aside REPL (w3).** Aside implements its persistent
  code-exec surface via `node:vm` — native to TS. Rust "has no equivalent std
  primitive; embedding `rquickjs`/`boa` is a heavyweight dependency" (verified
  reasoning in `ev-aside-adapt.md` item 9).
- **Asset leverage (w2).** The TS base already independently **re-derived both of
  the Rust fork's headline deltas** — ID-grounded keyless extract
  (`extract/resolve.ts`) and the DNS-SSRF egress guard (`security/egress.ts`) —
  and in one documented case *improved* on the Rust original (a "loud null"
  instead of Stagehand's silent `?? ""` value-fabrication bug). S2 is not a
  green-field bet; the team has already executed at this altitude in this
  language.

### S1's advantages are bounded (finishable equally in TS)

The owner's lean rests on two claims: Rust "already has" long-running/resumable
(w3) and parallel orchestration (w3). Reading the code, both are **half-built**:

- **Long-task (w3).** Rust has excellent *browser-state* resume (AES-256-GCM
  encrypted, 30s autosave — verified `state.rs:1`). But `ev-longtask.md` is
  explicit and I confirmed it: there is **no re-runnable "task = script, logs =
  artifact" concept anywhere in `cli/src`**. That capability — Webwright's real
  contribution — is missing in **all three** bases and is "a filesystem
  convention, not a language-specific mechanism." Building it once costs the same
  in TS as in Rust. The only piece Rust has that TS lacks is encryption-at-rest,
  which is a ~30-line `node:crypto` AES-GCM addition.
- **Parallel (w3).** Rust's `--session`/`SILVER_NAMESPACE` gives N isolated
  daemons — genuinely first-class and documented, the one place S1 is ahead
  *today*. But "many agents sharing ONE browser in parallel" is **not built in
  either**: every command in a Rust daemon serializes through one
  `Arc<Mutex<DaemonState>>` (verified `daemon.rs:189,308,394`) — safe but
  turn-by-turn, not concurrent. And per Aside's own design (`ev-parallel.md`),
  sharing live tabs/form state across concurrent agents is *the wrong pattern* —
  the correct shape is own-context-per-agent, which is exactly moxxie's existing
  N-detached-processes primitive. What TS lacks is (a) documenting it and (b) a
  per-session lock guard (moxxie has **0** locking primitives — verified) — both
  small `net.createServer`/lockfile additions.

**Net:** S2 leads outright on criteria 1, 2, 5, 6, 7, 8, 9 (weight-sum 16/21) and
is behind-but-cheaply-closeable on 3 and 4 (5/21) — and even there the gap is a
lock primitive, an encryption call, and a filesystem convention, not missing
architecture. S1's structural liabilities (CDP-maintenance-forever, fork tax,
broken dist, 14× code, slow release loop) are permanent; its leads are bounded.
S3 (Python) is dominated — it discards *both* working assets, rides a secondary
Playwright binding, and its own reference (Webwright) ships non-keyless by
default (`OPENAI_API_KEY missing = FAIL`, verified live).

---

## 2. Migration plan (winner is NOT the current Rust fork)

The Rust fork (`silver/`) and Webwright become **reference material**, not the
shipping product. The shipping product is moxxie, renamed **Silver** and
completed. Honest reuse map:

### Keep from the TS CLI (moxxie) — the base, ship as-is
- Entire `security/` stack: `registry.ts` (phase-quarantine as a pure function of
  flags), `egress.ts` (DNS-SSRF guard), `confirm.ts` (fail-closed-on-non-TTY
  mutating-verb gate), `redact.ts`, `injection.ts`.
- `core/session.ts` browser-as-daemon (detached Chromium, atomic sidecar writes,
  PID-liveness-gated reconnect, the profile-resurrection-safe close sequence).
- `extract/resolve.ts` (keyless ID-grounded extract), `perception/diff.ts`
  (diff-when-shorter), the 142-test vitest suite as the regression net.
- The `SKILL.md` discovery-stub pattern (`silver skill --full` loads the real
  contract from the binary).

### Port from the Rust fork (`silver/`) — architecture ideas, re-implement in TS
These are *design ports*, not code ports (different language):
- **Encrypted-state-at-rest** → add AES-256-GCM over the session sidecars via
  `node:crypto` (Rust's `state.rs` is the spec).
- **`--session` / `--namespace` as first-class, documented features** → moxxie
  already threads `flags.session` through 40+ call sites; surface it as headline,
  add `session list` / `session gc` (Rust's `walk_daemons`/`cleanup_stale_files`
  is the spec).
- **`session id --scope worktree|cwd|git-root`** → deterministic session keys so a
  restarted agent reconnects to the same browser without coordination.
- **`connect <port|url>`** → attach to an already-running CDP endpoint (the
  "share one browser someone else launched" branch).
- The 60+ verb surface as the parity target for moxxie's honest stubs
  (`tab`/`frame`/`network`/`pdf` are `notImplemented()` today — verified — build
  them on real Playwright tab/context APIs).
- MCP server wrapper (`mcp.rs`'s per-tool `session` routing arg is the spec) as
  the second host interface alongside the CLI.

### Port from Webwright (Python) — the task-artifact convention
- The **`skills/webwright/` keyless mode** is the load-bearing precedent: the
  host LLM plays the loop, Webwright writes no model call. Port its convention,
  not its keyed binary:
  `plan.md` (Critical-Points checklist) → numbered `runs/<task_id>/run_<n>/` →
  `action_log.jsonl` → per-checkpoint screenshots → judge-gated `done`.
- The `/webwright:craft` **CLI-tool mode** (one-off run → parameterized,
  import-safe, `argparse`-style reusable tool) → Silver's equivalent that emits a
  re-runnable script as the durable artifact.
- **Discard**: Webwright's `models/`, `image_qa.py`, `self_reflection.py` — the
  keyed loop the host LLM replaces.

---

## 3. Target architecture

```
                    ┌─────────────────────────────────────────────┐
   host LLM ──CLI──▶│  silver (Node bin) — stateless per-invocation │
   (the brain)      │  connect() over CDP, act, disconnect          │
                    └──────────────┬────────────────────────────────┘
                                   │ CDP
     ┌─────────────────────────────┼─────────────────────────────┐
     ▼                             ▼                             ▼
 session "agent1"            session "agent2"            session "shared"
 detached Chromium          detached Chromium           detached Chromium
 own user-data-dir          own user-data-dir           ├─ tab t1 (agentA)
 ~/.silver/sessions/agent1  .../agent2                  └─ tab t2 (agentB)
```

**Agent-ergonomic CLI + general SKILL.md.** Phase-grouped verbs, `--json`
sanitized failure envelopes (`mapThrow`), stable `@eN` refs + `t{n}` tab ids, the
discovery-stub `SKILL.md`. Registry-as-pure-function gates the actor verbs behind
`--enable-actions` (quarantine-as-code, prompt-injection-resistant).

**Fast quick tasks.** Browser-as-daemon: first `open` spawns a detached Chromium;
subsequent commands `connectOverCDP` to the warm browser — no relaunch cost.
Diff-when-shorter trims perception payloads.

**Long-running / resumable (two layers).**
- *Session persistence*: encrypted (AES-GCM) sidecar state, autosaved, PID-gated
  reconnect — survives a crashed agent.
- *Task-as-artifact*: a `silver task` namespace writing
  `runs/<id>/run_<n>/{plan.md, action_log.jsonl, screenshots/, checkpoint.json}`
  as a keyless side effect, driven by the host LLM (Webwright's proven pattern),
  with Aside's "Mistakes & Avoidance" field in the checkpoint template. The
  script IS the artifact; re-running it is the resume.

**Parallel multi-agent / multi-browser.**
- *Own browser per agent* (the correct default, per Aside): N named sessions = N
  detached processes, already the primitive. Add a per-session **lock guard**
  (`net.createServer` Unix socket or lockfile) so concurrent commands against one
  session serialize instead of racing `pages()[0]`.
- *Shared browser*: `connect <endpoint>` + real tab/context API; each subagent
  gets its **own tab/context**, never shared live page state.
- *Subagent surface*: Aside's minimal two verbs — `subagent spawn [--background]`
  / `subagent wait <id>` — one level of nesting, concurrency cap (~5), tool-gated
  allowlist. Enforced via lockfile-semaphore (no daemon registry needed).

**Keyless.** No model call anywhere — verified in the base today; the host LLM is
the only brain. Every Aside/Webwright pattern adopted is keyless-compatible; the
keyed layers are explicitly excluded.

---

## 4. Patterns to adapt, mapped to the design

| Source | Pattern | Maps to |
|---|---|---|
| **Vercel/moxxie** | Phase-grouped verbs, `@eN` refs, `--json` envelope, discovery-stub SKILL.md | Agent-ergonomic CLI |
| **Vercel/moxxie** | Registry-as-pure-function-of-flags, egress/confirm/redact/injection | Security substrate |
| **Vercel/moxxie** | ID-grounded keyless extract (+ loud-null fix), diff-when-shorter | Extraction / perception |
| **Rust fork** | AES-GCM state-at-rest, `--namespace`, `session id --scope`, `connect <port>`, MCP wrapper, 60+ verb parity | Persistence, parallel, host interfaces |
| **Webwright** | `plan.md` → numbered run folders → action log → screenshots → judge-gated `done`; `/craft` CLI-tool mode | Long-task artifact |
| **Aside** | Subagent = restricted child session, `spawn`/`wait`, cap 5, one-level nesting; own-tab-per-agent; untrusted-output wrapping; "Mistakes & Avoidance" field; grep-first markdown memory | Parallel orchestration, memory, safety |
| **Stagehand** | Extract/observe design (already the ancestor of `resolve.ts`) | Extraction |
| **Browser Use** | Interactive-element heuristic cascade, page-change-guard mid-batch | Perception, action safety |
| **AgentQL / Perplexity** | Query-shaped extract selectors (later); computer-use security precedent | Extract v2, security |

Deferred (per `ev-aside-adapt.md`): bespoke persistent `node:vm` REPL (the host's
own shell already loops `silver eval`), "dreaming" memory consolidation, the
command-envelope/event-stream (no home until an agent-loop daemon exists — Silver
never runs one).

---

## 5. Build order

0. **Rename & unblock distribution.** Flip `private:false`, confirm `silver`/
   chosen npm name is free, finish publish config. *(Unblocks criterion 5 that
   the Rust fork cannot pass today.)*
1. **Verb parity.** Implement the honest stubs on Playwright: `tab`/`frame`/
   `network`/`pdf` + fill remaining gaps toward the 60+ surface. Decompose the
   1,211-line `handlers.ts` as it grows.
2. **Parallel hardening.** Document `--session`/`--namespace` as first-class; add
   the per-session lock guard; add `session list`/`session gc`.
3. **Encrypted state-at-rest.** AES-GCM over sidecars via `node:crypto`;
   `session id --scope` deterministic keys.
4. **Task-as-artifact.** `silver task` run-folder convention (plan/log/
   screenshots/checkpoint), keyless, host-LLM-driven; `/craft`-style re-runnable
   script emission.
5. **Subagent layer.** `subagent spawn|wait`, cap, one-level nesting, tool-gate;
   own-tab-per-agent + `connect` for the shared-browser branch.
6. **MCP wrapper + memory.** MCP tools with `session` routing; grep-first
   markdown memory (embeddings optional/later).
7. **Eval harness.** Port a `silver/evals`-style pass@k harness (moxxie lacks one
   — the "pass_k 1.000" claim is currently unverified) to lock the surface.

The 142-test suite gates every step; each new capability ships with tests, per
the base's existing discipline.
