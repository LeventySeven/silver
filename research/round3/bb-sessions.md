# Browserbase → moxxie session.ts: gap-alignment (lens: session lifecycle robustness, keyless-local only)

Source read: `BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` (§14 state machine, §15 sequence diagram, kill/release path), `BROWSERBASE_R3_01_SESSIONS_FN.md` (§0 response schema, timestamps), `BROWSERBASE_R3_03_CONTEXTS_FN.md` (context/profile persistence envelope).
Moxxie read: `skill/agent-browser/src/core/session.ts` (full file, 297 lines) and a grep pass over `src/` + `cli.ts` confirming absence of `status`, `listSessions`, `gc`/`reap`.

Browserbase is a multi-tenant cloud fleet (EKS, Firecracker microVMs, JWE-routed WebSocket proxy, argon2 auth, S3-backed recordings). Almost all of that is cloud-fleet-shaped and explicitly out of lens (routing tokens, mTLS, multi-region, billing meters, pooled warm VMs). What's transferable to a keyless single-tenant local daemon is the *lifecycle discipline* around a session: explicit state, idle reaping, crash detection, and continuity metadata — not the infrastructure that provides it.

## Findings

### 1. Idle-timeout field is captured but never enforced — dead code masquerading as a feature
- **source_does:** Browserbase's session state machine (§14) has an explicit `TIMED_OUT` transition: "idle > 30min (no activity, no keepAlive flag)" → session torn down, microVM destroyed and not returned to the pool.
- **moxxie_current:** `OpenOptions.idleTimeoutMs` exists (`session.ts:37`) with the comment "Recorded for later idle-reaping logic; unused by open itself." Confirmed via grep: no reaper, no cron, no `gc` command anywhere in `src/`. The field is accepted, presumably stored somewhere by the caller, and does nothing.
- **recommendation:** align
- **change:** In `session.ts`, either (a) delete the dead `idleTimeoutMs` option until it's wired up (truthful-surface principle), or (b) actually wire it: persist `idleTimeoutMs` and `lastActivityAt` in the sidecar (`SessionInfo`), and add a `reapIdleSessions()` function that `cli.ts`'s `session` meta-verb can call (e.g. on every `session list` or `session open` invocation, opportunistically sweep `sessionsRoot()` for sessions whose `lastActivityAt + idleTimeoutMs < now` and `closeSession()` them). A background daemon is unnecessary for a keyless CLI — a "sweep on next invocation" model matches moxxie's existing daemon-per-command architecture.
- **keyless_ok:** true
- **priority:** P1
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §14 (state machine, TIMED_OUT). moxxie: `session.ts:36-37` (dead field), confirmed absent elsewhere via `grep -rn idleTimeout src/`.

### 2. No explicit session status — liveness is inferred, not tracked
- **source_does:** Every Browserbase session carries an explicit `status` enum (`RUNNING|COMPLETED|FAILED|TIMED_OUT`) queryable via `GET /v1/sessions/{id}` (R3_01 §0), updated on crash/OOM/segfault as well as clean close.
- **moxxie_current:** `SessionInfo` (`session.ts:22-27`) has only `port, pid, wsEndpoint, createdAt` — no status field. `readSidecar()` throwing means "no such session"; a *stale* sidecar (process crashed but dir still present) is indistinguishable from a *live* one until `connect()` tries `chromium.connectOverCDP()` and fails with a raw Playwright network error.
- **recommendation:** align
- **change:** Add a lightweight `status` derivation, not a stored field requiring active bookkeeping (avoids a write-on-every-heartbeat cost): in `connect()` (`session.ts:202`), before calling `connectOverCDP`, do a cheap `process.kill(info.pid, 0)` liveness probe. If it throws ESRCH, remove the stale sidecar dir and throw a clear `'session process is no longer running (stale sidecar removed)'` instead of letting Playwright's opaque CDP-connect timeout surface to the host LLM. This directly mirrors Browserbase's crash → FAILED transition, done keyless/locally via the OS process table instead of a health-check service.
- **keyless_ok:** true
- **priority:** P0
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §14 (FAILED on "microVM crash / OOM / Chrome segfault"). moxxie: `session.ts:202-212` (`connect()` has no pid liveness check before CDP connect).

### 3. No session enumeration — can't see what's running without guessing names
- **source_does:** `GET /v1/sessions` lists all sessions for a project (R2 §4 route table); the dashboard and SDK both rely on this for visibility/cleanup.
- **moxxie_current:** `sessionsRoot()` (`session.ts:53-55`) exists but nothing reads its directory listing — every session lookup requires already knowing the `name`. `cli.ts` registers `session` as a meta-verb (line 39) but the grep shows no `listSessions` function backing it.
- **recommendation:** align
- **change:** Add `listSessions(): Promise<{ name: string; info: SessionInfo; alive: boolean }[]>` to `session.ts` — `fs.readdir(sessionsRoot())`, read each `session.json`, and tag `alive` via the same `process.kill(pid, 0)` check from Finding 2. Wire it to `moxxie session list`. This is the single most useful keyless-local echo of Browserbase's session list endpoint: it lets the host LLM (or the human) discover/clean up orphaned detached Chromium processes, which is a real failure mode of the "browser-as-daemon" model (crashed CLI mid-session, orphaned `child.unref()`'d process with no owner).
- **keyless_ok:** true
- **priority:** P0
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §4 (`GET /v1/sessions` route). moxxie: `session.ts:53-55` (`sessionsRoot()` defined, unused for listing); `cli.ts:39` (`session` meta-verb present but no list subcommand found via grep).

### 4. Sidecar timestamps: only `createdAt`, no `startedAt`/`updatedAt`/`endedAt`
- **source_does:** Browserbase's `Session` schema (R3_01 §0) tracks `createdAt`, `startedAt` (moment pod reachable), `updatedAt`, `endedAt` — four distinct lifecycle timestamps.
- **moxxie_current:** `SessionInfo` has only `createdAt` (`session.ts:26`). There's no `updatedAt`/`lastActivityAt`, which is also *why* Finding 1's idle-reaping can't work today — there's no signal for "when was this session last touched."
- **recommendation:** align
- **change:** Add `lastActivityAt: string` to `SessionInfo` and touch it (cheap `fs.writeFile` of the sidecar with an updated timestamp) at the top of `connect()` after a successful CDP connection. This single field is the prerequisite for Finding 1's reaper and gives `listSessions` (Finding 3) something meaningful to show ("idle 47 min"). Don't bother with Browserbase's full 4-timestamp set — `createdAt` + `lastActivityAt` is the minimum that earns its keep for a single-tenant local daemon; `startedAt`/`updatedAt`/`endedAt` are cloud-fleet bookkeeping for a multi-tenant billing/dashboard system moxxie doesn't have.
- **keyless_ok:** true
- **priority:** P1
- **evidence:** source: BROWSERBASE_R3_01_SESSIONS_FN.md §0 (Session schema, 4 timestamp fields). moxxie: `session.ts:22-27` (`SessionInfo` type, single timestamp).

### 5. Escalating SIGTERM→SIGKILL close is already correctly aligned — no change needed
- **source_does:** Browserbase's terminal states destroy the microVM outright (§14: "Once a session is COMPLETED or FAILED, the microVM is destroyed, not returned to pool").
- **moxxie_current:** `closeSession()` (`session.ts:246-271`) already does graceful CDP disconnect → `SIGTERM` → `waitForExit()` with escalation to `SIGKILL` at the halfway point of a 4s budget → directory removal. This is *already* more careful than what's inferrable about Browserbase's teardown (which relies on Firecracker's fast microVM-kill primitive, not applicable locally).
- **recommendation:** skip-cargo-cult
- **change:** none — flag this explicitly as "moxxie already does the keyless-appropriate version of this correctly," so a future pass doesn't waste effort re-deriving it.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §14 (terminal-state VM destruction). moxxie: `session.ts:246-296` (`closeSession` + `waitForExit`, SIGTERM→SIGKILL escalation logic).

### 6. Warm-pool pre-allocation — pure cargo cult for a local single-user daemon
- **source_does:** Browserbase maintains a pre-warmed microVM pool (30-min cron rebuild, R2 §5/§11) specifically to hide the 4-14s cold-boot latency of Firecracker+Chrome behind a shared multi-tenant fleet, at the cost of a whole allocator service (`browser-boss`) and OS/locale/proxy-partitioned pool keys.
- **moxxie_current:** `openSession()` spawns Chromium directly on demand (`session.ts:85-144`), bounded by an 8s `READY_BUDGET_MS`.
- **recommendation:** skip-cargo-cult
- **change:** none. A warm pool solves a multi-tenant fleet-utilization problem (many concurrent unknown customers). For a keyless local CLI where the host LLM opens roughly one browser per task, on-demand spawn is strictly simpler and the ~1-2s local Chromium cold start is not the multi-second cost Browserbase is optimizing away (no network hop, no VM boot, no proxy negotiation). Do not add pooling.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §5, §11 (warm pool sizing, proxy-triggered cold path). moxxie: `session.ts:85-144` (`openSession`, direct spawn, no pool).

### 7. Envelope-encrypted profile/context persistence — cargo cult for local filesystem
- **source_does:** Browserbase Contexts (`BROWSERBASE_R3_03_CONTEXTS_FN.md` §2) are AES-256-CBC-encrypted server-side with an RSA-wrapped data key before landing in S3 — because the customer's cookies/localStorage are crossing the network to a third party's multi-tenant storage.
- **moxxie_current:** `userDataDir` (`session.ts:87`, `path.join(dir, 'profile')`) is a plain local directory under `~/.moxxie/sessions/<name>/profile`, no encryption.
- **recommendation:** skip-cargo-cult
- **change:** none. This encryption exists because Browserbase is a third party holding another company's session cookies at rest in shared cloud storage — a trust boundary that doesn't exist for a local CLI writing to the invoking user's own home directory (already protected by OS file permissions/disk encryption if the user has FileVault/LUKS on). Adding client-side envelope encryption here would be security theater with real complexity cost (key management, no keyless way to hold a private key meaningfully) and zero threat-model benefit.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** source: BROWSERBASE_R3_03_CONTEXTS_FN.md §2.3 ("Browserbase encrypts at rest with a per-context-version key... only the BB-controlled key-management service can unwrap"). moxxie: `session.ts:87` (`userDataDir`, plain fs path, no crypto).

### 8. Sessions are immutable post-create — moxxie already matches this by construction
- **source_does:** No `PUT`/`PATCH /v1/sessions/{id}` exists (R2 §4); once created a session's browserSettings/region/proxy are fixed for its lifetime.
- **moxxie_current:** `openSession()` takes `OpenOptions` once at creation; there is no `updateSession()`/mutate-in-place API — later commands only `connect()`/`closeSession()`.
- **recommendation:** skip-cargo-cult (already aligned, nothing to change)
- **change:** none — note only, so this isn't mistakenly proposed as a gap in a future round.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** source: BROWSERBASE_R2_04_SESSION_LIFECYCLE.md §4 (no PUT/PATCH on sessions). moxxie: `session.ts` (no update/mutate function exists across the whole file).

## Top recommendation

Findings 1–4 form a single coherent unit of work: today `session.ts` has a **write-only, never-read** `idleTimeoutMs` field and no liveness/visibility primitives at all, meaning a crashed or forgotten detached Chromium process is invisible and immortal until the user manually finds and kills it. The highest-value keyless change is to add `listSessions()` (Finding 3) backed by a cheap `process.kill(pid, 0)` liveness probe (Finding 2) and a `lastActivityAt` timestamp (Finding 4) — this closes the loop that makes the existing dead `idleTimeoutMs` field (Finding 1) finally do something, all without any network calls, model calls, or new dependencies. It directly echoes Browserbase's `GET /v1/sessions` + status-enum + `TIMED_OUT` design, re-expressed as three local filesystem/process-table primitives instead of a fleet allocator.
