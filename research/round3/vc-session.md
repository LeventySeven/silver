# vc-session: agent-browser (vercel, Rust) vs moxxie session.ts

Lens: session/restore/worktree-id/idle-timeout/version-check/namespace.
Source read: `cli/src/connection.rs` (1598 lines), `cli/src/native/daemon.rs` (792
lines), `cli/src/native/state.rs` (~1000 lines), `cli/src/native/actions.rs`
(autosave block ~2499-2680).
Moxxie read: `skill/agent-browser/src/core/session.ts` (296 lines, full file).

Moxxie today: `openSession` spawns detached Chromium + `child.unref()`,
persists a single `session.json` sidecar (port/pid/wsEndpoint/createdAt) and
`refmap.json`. `readSidecar` throws generically if missing/corrupt. `connect`
does CDP connect, no liveness/version check beyond "file exists and JSON
parses". `closeSession` does graceful CDP close + SIGTERM + wait + SIGKILL
escalation + `fs.rm` the whole dir. `idleTimeoutMs` is accepted as an option
but literally unused ("Recorded for later idle-reaping logic; unused by open
itself" — session.ts:36-38). No namespace concept, no version stamping, no
restore/autosave, no worktree scoping beyond the session `name` string itself.

## Findings

### 1. No stale-PID / dead-process detection before reuse (P0)
- source_does: `is_pid_alive()` (connection.rs:185-203) explicitly signals the
  PID with `kill(pid, 0)`, treating ESRCH as dead and EPERM as alive (so it
  never mis-kills a live daemon owned by a different uid). `walk_daemons()`
  (connection.rs:270-358) uses this to classify every `.pid` file into
  live/`ProcessGone`/`UnreadablePidFile`/`OrphanedSocket` and cleans up stale
  sidecars as a side effect of any inventory walk.
- moxxie_current: `readSidecar` (session.ts:182-194) only checks the sidecar
  JSON parses. `connect()` (session.ts:202-212) trusts `info.wsEndpoint` and
  calls `chromium.connectOverCDP` directly — if the browser process died
  (crashed, OOM-killed, machine rebooted) but the sidecar JSON survived, the
  CDP connect will hang/timeout with an opaque Playwright error instead of
  moxxie recognizing "stale session, respawn."
- recommendation: adopt
- change: In `session.ts`, add a `isPidAlive(pid): boolean` helper (Node has
  no direct syscall, but `process.kill(pid, 0)` throws ESRCH the same way —
  it already exists as a pattern in `waitForExit`, just needs extracting and
  calling from `connect()`/`readSidecar()` up front). Before attempting
  `connectOverCDP`, check `isPidAlive(info.pid)`; if dead, clean the sidecar
  and throw a clear "session died, reopen it" error instead of a raw CDP
  timeout.
- keyless_ok: true
- priority: P0
- evidence: connection.rs:185-203, connection.rs:270-334 vs session.ts:182-212

### 2. No version stamping / mismatch-triggered auto-restart (P0)
- source_does: On daemon start, `daemon.rs:69-70` writes a `.version` sidecar
  with `env!("CARGO_PKG_VERSION")`. `ensure_daemon` (connection.rs:784-816)
  checks `daemon_version_matches()` (connection.rs:699-705) on every command;
  a missing version file is treated as a mismatch (comment: "unversioned
  daemon is most likely a stale leftover... silently reusing it is the exact
  bug this check exists to prevent"), and a mismatch triggers
  `stop_existing_daemon_for_restart` + fresh spawn, with a warning printed.
- moxxie_current: `SessionInfo` (session.ts:22-27) has no version field at
  all. If moxxie is upgraded (new Playwright pin, new CDP flags, new
  RefMap schema) while an old daemon-equivalent browser process is still
  running from a prior version, `connect()` will happily reuse it — silently
  serving stale behavior with no signal to the host agent.
- recommendation: adopt
- change: Add `version: string` to `SessionInfo` (populate from
  moxxie's own `package.json` version at `openSession` time). In `connect()`,
  compare `info.version` to the running CLI's version; on mismatch, call
  `closeSession(name)` then `openSession(name, ...)` transparently (mirroring
  `ensure_daemon`'s restart-with-warning), rather than silently connecting.
- keyless_ok: true
- priority: P0
- evidence: daemon.rs:69-70, connection.rs:693-705, connection.rs:796-816 vs session.ts:22-27,202-212

### 3. Namespace scoping for multi-worktree isolation (P1)
- source_does: `AGENT_BROWSER_NAMESPACE` env var (connection.rs:129-134,
  367-373) rewrites the socket dir to
  `<base>/namespaces/<sanitized-ns>/run` and (Windows) folds the namespace
  into the port-hash identity, so two checkouts/worktrees of the same repo
  running agents concurrently never collide on session names or ports. This
  is opt-in via env var, not automatic git-worktree detection — the source
  does NOT auto-derive a worktree ID from `git rev-parse`; it's the caller's
  (agent harness's) job to set the env var per-worktree.
- moxxie_current: `sessionsRoot()` (session.ts:53-55) is a single fixed
  `~/.moxxie/sessions` with no namespace/scoping concept. Two sub-agents in
  two git worktrees both naming a session "main" will silently share (or
  clobber) the same `session.json`/profile dir — a real collision risk for
  moxxie's stated multi-agent use case.
- recommendation: adopt
- change: In `session.ts`, honor an optional `MOXXIE_NAMESPACE` env var in
  `sessionsRoot()`: if set (and passes the same charset validation as
  `assertName`), join `sessionsRoot() -> .../namespaces/<ns>/sessions`
  before the per-session dir. Keep it purely opt-in (env var), not automatic
  worktree detection — cheap, keyless, and matches the source's own choice
  not to auto-derive from git.
- keyless_ok: true
- priority: P1
- evidence: connection.rs:97-137, connection.rs:1184-1206 (test) vs session.ts:53-60

### 4. Idle-timeout is wired end-to-end in source, decorative in moxxie (P1)
- source_does: `idle_timeout_ms` (daemon.rs:121, from
  `AGENT_BROWSER_IDLE_TIMEOUT_MS`) drives an actual `tokio::time::sleep`
  branch in the daemon's select loop (daemon.rs:204-263) that triggers
  `auto_save_restore_state` and (per regression test at daemon.rs:696-750,
  "idle timeout must fire even while the drain interval..." bug #1101)
  the loop is specifically tested to guarantee the timer isn't starved by
  other event branches.
- moxxie_current: `OpenOptions.idleTimeoutMs` (session.ts:36-38) is accepted
  and explicitly documented as unused: "Recorded for later idle-reaping
  logic; unused by open itself." Nothing in session.ts ever reaps an idle
  browser — a forgotten session's Chromium process (and its user-data-dir)
  runs forever until something explicitly calls `closeSession`.
- recommendation: adopt
- change: moxxie's CLI has no long-lived daemon process to host a select
  loop, so the source's exact mechanism doesn't transplant directly. Keyless
  equivalent: on every `connect()`/session-touching command, read/write a
  `lastTouchedAt` timestamp into the sidecar; add a lightweight `moxxie gc`
  (or auto-invoked-at-`openSession`-time) sweep that lists `sessionsRoot()`,
  and for any session whose `lastTouchedAt` exceeds its recorded
  `idleTimeoutMs` AND whose pid is still alive, calls `closeSession` on it
  before proceeding. This gets the reaping behavior without needing a
  resident process.
- keyless_ok: true
- priority: P1
- evidence: daemon.rs:121,204-263,696-750 vs session.ts:36-38 (unused field)

### 5. Restore/autosave with atomic write + rollback (P1)
- source_does: `save_auto_state_transactional` (state.rs:340-423) writes to a
  `.tmp` candidate file, validates it (`validate_state_file`), rotates the
  existing final file to `.previous`, renames candidate into place, and on
  rename failure rolls `.previous` back — a proper crash-safe write with a
  one-generation rollback. Autosave itself is gated by a quiet period
  (`AUTOSAVE_QUIET_PERIOD_MS`, actions.rs:2561-2589) so it never fires mid
  command-burst, and `restore_save` policy (`auto`/`always`/`never`) plus
  `restore_load_failed` gating (actions.rs:2629-2649) skip autosave if the
  prior restore itself failed, avoiding compounding corruption.
- moxxie_current: `saveRefMap`/`loadRefMap` (session.ts:215-233) do a direct
  `fs.writeFile` with no temp-file/rename, no validation of the written
  content, and no rollback if a write is interrupted mid-write (crash,
  power loss) — a torn RefMap write would silently corrupt cross-command
  grounding state, caught only by `loadRefMap`'s generic `JSON.parse`
  catch-and-return-null, which loses the whole RefMap rather than rolling
  back to the last-good version.
- recommendation: adopt
- change: In `saveRefMap` (session.ts:215-218), write to
  `refmap.json.tmp`, validate it round-trips through `JSON.parse`, rename
  the existing `refmap.json` to `refmap.json.previous` (best-effort), then
  rename `.tmp` to `refmap.json`; on rename failure restore `.previous`.
  Same pattern for `session.json` in `openSession` (session.ts:133).
- keyless_ok: true
- priority: P1
- evidence: state.rs:340-423, actions.rs:2561-2649 vs session.ts:133,215-233

### 6. Config-mismatch detection on daemon reuse (P2)
- source_does: `ready_existing_daemon_result` (connection.rs, around
  DaemonConfigStatus handling seen at 660-683) distinguishes `Missing` /
  `Same` / `Different` daemon config and refuses to silently reuse a daemon
  started with different launch options (headless vs headed, different
  flags) — returning `None` (forcing a restart) rather than serving a
  connection with the wrong config, with a specific error message for the
  concurrent-start race (`concurrent_daemon_config_error`, connection.rs:
  686-691).
- moxxie_current: `openSession` (session.ts:85-144) takes `opts.headed`,
  `opts.userDataDir`, `opts.port` — but has no notion of a "session already
  open with different options." If a caller calls `openSession("main", {
  headed: true })` when a headless "main" session is already running,
  moxxie's `connect()` doesn't even look at options — it just reads
  whatever sidecar exists and connects, silently returning the headless
  browser even though the caller asked for headed.
- recommendation: adopt
- change: Persist the effective `OpenOptions` (headed, userDataDir) into
  `SessionInfo` at `openSession` time. Add a check (could live in a thin
  `ensureSession` wrapper analogous to `ensure_daemon`) that compares
  requested options against the sidecar's recorded options and throws a
  clear "session 'X' already open with different options (headed=false),
  close it first or use a different name" error, instead of silently
  returning a mismatched browser.
- keyless_ok: true
- priority: P2
- evidence: connection.rs:660-691 vs session.ts:85-144,202-212

### 7. Orphan-detection sweep separate from single-session lookup (P2)
- source_does: `walk_daemons()` (connection.rs:270-358) is a first-class
  operation independent of any single session lookup — it's the mechanism
  behind whatever "list sessions" / doctor command the CLI exposes, and it
  self-heals by removing orphaned `.sock` files with no `.pid` counterpart
  (connection.rs:336-355), catching a different failure mode than the
  dead-PID case (finding 1).
- moxxie_current: there is no equivalent of `walk_daemons` in session.ts.
  `sessionsRoot()`/`sessionDir()` exist but nothing enumerates all sessions
  to detect orphans (e.g. a `profile/` dir left behind because
  `closeSession` was interrupted mid-`fs.rm`, or a `session.json` whose
  Chromium was killed out-of-band by the OS).
- recommendation: adopt
- change: Add a `listSessions(): Promise<{name, alive, orphaned}[]>` in
  session.ts that reads `sessionsRoot()`, for each subdir reads
  `session.json`, checks `isPidAlive` (finding 1's helper), and flags dirs
  with no `session.json` or a dead pid as orphaned — surfaced via a `moxxie
  sessions` or `moxxie doctor` command for the host agent to clean up.
- keyless_ok: true
- priority: P2
- evidence: connection.rs:270-358 vs session.ts (no listing function exists)

### 8. Graceful-then-forceful daemon shutdown via an app-level "close" RPC before signals (P2 — partial overlap, worth calling out)
- source_does: `stop_existing_daemon_for_restart` (connection.rs:778-782)
  first tries `request_graceful_daemon_shutdown` — an in-protocol RPC action
  (`INTERNAL_DAEMON_SHUTDOWN_ACTION`) that lets the daemon close its own
  browser/state cleanly — and only falls back to `kill_stale_daemon`
  (SIGTERM→wait→SIGKILL, connection.rs:707-753) if the RPC fails or times
  out.
- moxxie_current: `closeSession` (session.ts:246-271) already does a
  reasonable graceful-then-forceful sequence (CDP `browser.close()` then
  SIGTERM, wait, escalate to SIGKILL) — this is actually well-aligned
  already. The one gap: moxxie has no equivalent of the *first* line's
  socket-removal-before-kill ordering rationale (connection.rs:709-714,
  "remove the socket first so no new connections reach the old daemon") —
  not directly applicable since moxxie has no socket, but the general
  principle ("invalidate the entry point before killing the process, so a
  racing new `openSession` doesn't reuse it") maps to: `closeSession`
  should delete/mark-invalid the sidecar file *before* issuing SIGTERM, not
  only in the final `fs.rm` at the end (session.ts:270) — right now a
  concurrent `readSidecar` between the SIGTERM and the final `fs.rm` could
  read a sidecar pointing at a process that's already been signaled to
  die.
- recommendation: align
- change: In `closeSession` (session.ts:246-271), move sidecar
  invalidation (e.g. `fs.rm(sidecarPath(name))`) to right after the
  graceful CDP close attempt and before `process.kill(info.pid,
  'SIGTERM')`, rather than only at the very end via the whole-dir `fs.rm`.
- keyless_ok: true
- priority: P2
- evidence: connection.rs:709-714,778-782 vs session.ts:246-271

### 9. Socket-path-length preflight — SKIP (cargo-cult for moxxie's transport)
- source_does: connection.rs:828-840 validates the unix socket path won't
  exceed the 104-byte `sockaddr_un` limit, erroring early with a clear
  message.
- moxxie_current: n/a — moxxie has no unix-domain-socket IPC; it shells out
  to Chromium directly and talks CDP over a TCP loopback (`ws://127.0.0.1`).
  There is no analogous path-length ceiling.
- recommendation: skip-cargo-cult
- change: none — this is purely an artifact of the daemon's socket-file
  transport, which moxxie's architecture (no daemon, no unix socket) does
  not have.
- keyless_ok: true
- priority: P2
- evidence: connection.rs:828-840 (source-only concern)

### 10. Windows port-hashing / `.port` file resolution — SKIP for now (low priority, platform-specific)
- source_does: on Windows (no unix sockets), the source hashes the
  session+namespace identity into a deterministic port (connection.rs:
  376-397) and falls back to a `.port` sidecar written by the daemon once
  it actually binds, so restarts after a port collision are self-healing.
- moxxie_current: moxxie requests port 0 (`--remote-debugging-port=0`,
  session.ts:97) and reads the OS-assigned port from Chromium's own
  `DevToolsActivePort` file (session.ts:146-160) — this is actually a
  *better* mechanism than the source's hash-then-fallback scheme, since it
  never needs a fallback path or collision handling at all: the OS always
  hands back a free port.
- recommendation: skip-cargo-cult
- change: none — moxxie's `port:0` + `DevToolsActivePort`-read approach
  (session.ts:90-160) already strictly dominates the source's
  hash-derived-port approach; do not adopt hashing.
- keyless_ok: true
- priority: P2
- evidence: connection.rs:376-397 vs session.ts:90-160

## Top recommendation

Ship findings #1 and #2 together as one change: extend `SessionInfo` with a
`version` field and a PID-liveness check, and make `connect()` (session.ts:
202-212) fail fast with a clear, actionable error — or transparently
respawn — instead of silently handing a dead/stale/version-mismatched
session to the host agent. This is the single highest-value keyless change:
it's the exact "browser-as-daemon" robustness gap the source's
`ensure_daemon`/`daemon_version_matches`/`is_pid_alive` machinery exists to
close, moxxie's docstring already promises this is coming ("Recorded for
later idle-reaping logic"), and today a crashed/upgraded browser produces an
opaque Playwright CDP timeout instead of a clean "reopen the session"
signal.
