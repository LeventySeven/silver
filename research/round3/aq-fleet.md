# AgentQL/Tetra vs moxxie — Browser Fleet / Parallel Sessions

Source: `/Users/seventyleven/Desktop/researchfms/agentql` (Tier-1B server-side RE: leaked
`/openapi.json`, `browser_pool.py` server source, `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md`).
Moxxie: `/Users/seventyleven/Desktop/moxxie/skill/agent-browser/src/core/session.ts` (+
`handlers.ts` session subcommands, `flags.ts` default session name).

## What AgentQL actually does (grounded)

Two distinct session models exist in the source, both instructive:

1. **Tetra fleet** (`/v1/tetra/sessions`, `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md` §5.3-5.7):
   each call provisions one remote Chromium on a dedicated EC2 box. Session-level lifecycle
   knobs are `shutdown_mode: on_disconnect | on_inactivity_timeout` +
   `inactivity_timeout_seconds` (int, 5–86400, default 300). Telemetry
   (`TelemetryEntry`, §5.7) is a **binary** `status: running|ended` — no paused/queued state.
   There is **no session-list endpoint**; no `DELETE`; the customer tracks its own
   `session_id`s and kills a session by disconnecting the WS. Multi-tenant `sub_user_id`
   tags sessions for a reselling customer's own attribution.

2. **Server-side pool** (`agentql-server/browser_pool.py`, read in full): a warm,
   bounded pool (`min_size=2, max_size=10`) of pre-launched Playwright Chromium instances
   behind `/v1/query-data`. `acquire()` reuses an idle instance matching the requested
   `profile`, else launches one up to `max_size`, else raises `"Browser pool exhausted"`.
   `release()` navigates the page back to `about:blank` and **replaces the instance** if
   that navigation throws (crash-then-recycle). A `_cleanup_loop()` background task
   (30s tick) closes any instance idle `> max_idle_seconds` as long as `len(instances) >
   min_size` is preserved (never dips below the warm floor).

## moxxie today (read, not guessed)

`session.ts` already gives moxxie a **named, persistent, multi-session** model that is
structurally closer to Tetra's per-session dedicated-box design than to the pooled
server: `openSession(name, opts)` spawns a **detached** Chromium with its own
remote-debugging port and its own `~/.moxxie/sessions/<name>/profile` user-data-dir,
`child.unref()`s it so it survives the CLI process, and persists `{port, pid,
wsEndpoint, createdAt}` to `session.json`. Every later CLI invocation `connect()`s over
CDP and disconnects without killing the browser — so N named sessions running
concurrently is already fully supported and requires zero code change (verified:
`assertName` + `sessionDir(name)` give each name an isolated port/profile, `flags.ts:131`
defaults to `session: 'default'` only when the caller omits `--session`).
`handlers.ts:788-801` (`handleSession`, `sub === 'list'`) already lists sessions from disk.
`closeSession` (session.ts:246-271) does the graceful-SIGTERM → wait-for-exit →
SIGKILL-escalate → rm-dir teardown Tetra's "on_disconnect" spec describes conceptually,
just invoked explicitly instead of on socket-drop (moxxie has no persistent socket to
watch — each CLI call is stateless).

Two concrete gaps stood out on read:

- `OpenOptions.idleTimeoutMs` (session.ts:36-37) is accepted but the type comment says
  it verbatim: `"Recorded for later idle-reaping logic; unused by open itself."` It is
  **not even written into `SessionInfo`/the sidecar** — grep confirms zero references to
  `idleTimeoutMs`, `reap`, `max_idle`, or `inactivity` anywhere else in `src/`. There is no
  reaper, scheduled or lazy.
- `handleSession('list')` (handlers.ts:788-799) reads each sidecar and reports
  `{name, pid, createdAt}` with **no liveness check** — a crashed/OOM-killed Chromium
  leaves a `session.json` behind forever, and `list` will happily report a dead pid as if
  it were live.

## Gap-alignment findings

1. **Wire up the dead `idleTimeoutMs` knob into an actual reaper.** (P0, keyless)
   AgentQL's `inactivity_timeout_seconds` (spec-level) + `browser_pool.py`
   `_cleanup_loop()` (implementation-level) both prove idle reaping is core to *any*
   multi-session browser fleet — otherwise sessions accumulate as leaked processes.
   Moxxie's `idleTimeoutMs` is currently decorative. Change: (a) add `idleTimeoutMs` and
   a `lastUsedAt` timestamp to `SessionInfo` in `session.ts`, write `lastUsedAt` on every
   `connect()`; (b) add `reapIdleSessions()` that iterates `listSessionNames()`
   (`handlers.ts:814`), and for any session past its `idleTimeoutMs` (default e.g. 30 min
   if unset), calls `closeSession(name)`; (c) invoke it lazily at the top of `openSession`
   and `handleSession('list')` rather than a background daemon — no persistent process,
   still fully keyless, fits the CLI's "connect, do work, disconnect" model instead of
   Tetra's live socket.

2. **`session list` should report actual liveness, not just sidecar presence.** (P1, keyless)
   AgentQL's `TelemetryEntry.status` is authoritative (`running`/`ended`) because the
   fleet scheduler tracks real process state (R2_05 §5.7). Moxxie's `list` (handlers.ts
   line 793-797) trusts the sidecar blindly. Change: in the `list` loop, add
   `process.kill(info.pid, 0)` (already used this exact pattern in
   `session.ts:waitForExit`) to classify each session `alive`/`dead`, and auto-`rm` the
   session dir for dead ones (self-healing instead of accumulating stale directories from
   crashes).

3. **Add a soft cap on concurrent named sessions.** (P1, keyless)
   `browser_pool.py`'s `max_size=10` + explicit `"Browser pool exhausted"` error
   (`acquire()`) is the resource-bound analogue moxxie is missing. Moxxie's
   `openSession` currently has no limit — a host agent (or a buggy loop) can spawn
   unbounded detached Chromium processes, each a real OS process + profile dir on the
   *local machine* (unlike AgentQL's cloud fleet, this directly competes with the user's
   own RAM/CPU, so the risk is arguably worse for moxxie). Change: in `openSession`,
   before spawning, count live sessions via `listSessionNames()` + a liveness check
   (share code with finding 2) and reject with a clear error (e.g. `"N sessions already
   open (cap M) — close one with \`session close <name>\` first"`) past a default cap
   (configurable via an env var, no model call).

4. **Skip: AgentQL's `shutdown_mode: on_disconnect`.** (skip-cargo-cult)
   This is a fleet-scheduler concept tied to a live WSS control channel the server can
   watch drop. Moxxie's CLI has no persistent connection to "disconnect" from — every
   invocation already connects, works, and disconnects while leaving the browser running
   by design (the whole point of the "browser-as-daemon" model in session.ts's own
   header comment). Do not add a connection-watching shutdown mode; idle-timeout reaping
   (finding 1) is the correct keyless substitute already implied by the existing
   (currently dead) `idleTimeoutMs` field.

5. **Skip: warm instance pool (`min_size`/pre-launch, profile-matched acquire/release).**
   (skip-cargo-cult) `browser_pool.py`'s pool exists to serve *many concurrent unrelated
   API customers* off a shared fleet cheaply. Moxxie is a single local operator's CLI;
   each named session is already a dedicated, persistent, reusable browser (better fit
   than pooling — no cross-tenant profile bleed, no "profile-matched acquire" needed
   since the caller picks the session by name already). Do not build a pool.

6. **Skip: `sub_user_id` multi-tenant attribution tag.** (skip-cargo-cult) Exists in
   `BrowserRequest` purely for a reselling customer to attribute fleet usage to their own
   end users for billing/telemetry (R2_05 §5.3). Moxxie has one operator and no billing
   surface; there's nothing to attribute. Do not add.

7. **Skip: `browser_profile` tri-state (`light`/`stealth`/`tf-browser`) as a
   user-selectable session param.** (skip-cargo-cult) Moxxie's `session.ts` already hard-codes
   the stealth flags unconditionally (`--headless=new` unless `headed`, no
   `AutomationControlled` advertisement — session.ts:96-105, comment: `"stealth: never
   advertise automation (spec §7)"`). AgentQL exposes this as a knob because its "light"
   profile trades stealth for speed across a huge multi-tenant fleet under cost pressure;
   moxxie has one browser per session and no cost pressure to trade against. Keep the
   always-stealth default; don't add profile selection.

8. **Adopt (low cost): treat a session's `status` as derivable, not stored.** (P2, keyless)
   AgentQL keeps `status: running|ended` as a first-class stored field (R2_05 §5.7).
   Moxxie shouldn't literally add a `status` field to the sidecar (that's a second
   source of truth that can go stale exactly like the liveness bug in finding 2) — instead
   compute it on read (`process.kill(pid, 0)` at `list`-time, per finding 2) so it can
   never desync from reality. Noting this explicitly so a future change doesn't
   cargo-cult the *stored-field* version of AgentQL's design.

9. **Adopt: expose parallel-session usage more visibly to the host agent.** (P2, keyless,
   docs/prompt-level not code) `flags.ts:131` defaults every unqualified call to
   `--session default`, so a host agent that never passes `--session <name>` gets
   moxxie's existing multi-session capability but never uses it — functionally
   single-session by omission, same ergonomic trap AgentQL avoids by forcing every Tetra
   call to carry an explicit `session_id`. No code change needed (the mechanism already
   works, per the `session.ts`/`handlers.ts` read above); the gap is that nothing in the
   CLI's help/skill text currently tells the host LLM "pass distinct `--session` names to
   run independent browsers in parallel." Recommend adding one line to the tool's
   description/skill doc, not new code.

## Top recommendation

Wire the already-declared-but-dead `idleTimeoutMs` field (session.ts:36-37) into a real
lazy reaper plus a liveness-checked `session list` (findings 1+2) — this is the single
highest-value, purely local, purely keyless change: it turns moxxie's already-correct
multi-session architecture from "leaks a Chromium process per forgotten session forever"
into "self-heals," matching what both AgentQL's spec-level `inactivity_timeout_seconds`
and its actual pool implementation's `_cleanup_loop()` treat as non-optional for any
multi-session browser fleet.
