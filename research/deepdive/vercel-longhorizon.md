# Deep dive — Vercel (rust-oracle) sessions/restore/persistence vs Silver `session.ts`

Source read in full: `rust-oracle/cli/src/native/state.rs` (1062 lines), `native/actions.rs`
restore block (~lines 280-2729), `native/daemon.rs` (idle-timeout/autosave tick loop,
lines ~90-380), `main.rs` (session id/list/info, lines 440-880), `connection.rs`
(daemon config fingerprinting, namespace/port derivation), `flags.rs` (`--restore`,
`--session`, `--namespace`, `--idle-timeout` parsing, lines 1-100 + 600-710).
Compared against `silver/src/core/session.ts` (495 lines, full read), `core/handlers.ts`
(`handleSession`/`handleStateVerb`, lines 1274-1460), `core/state-crypto.ts` (164 lines).

## What Vercel does, and how (mechanism)

**1. Restore key + auto-load on daemon launch.** `--restore[=<name>]` or bare `--restore`
after a command sets `flags.restore_uses_session = true`, which makes the *session name
itself* double as the restore key (`main.rs:934-936`: `restore_uses_session` → `flags.restore
= Some(flags.session.clone())`). `restore_key_from_flags` (`main.rs:98-100`) prefers an
explicit `--restore <name>` over the session name. This key rides into the daemon spawn as
`SILVER_SESSION_NAME` env (`connection.rs:534`) and into the launch command as `restoreKey`
(`attach_restore_config_to_command`, `main.rs:152-168`). On every browser launch,
`try_auto_restore_state` (`actions.rs:2482-2524`) calls `state::find_auto_state_file(&session_name)`
(`state.rs:753-788` — globs `<sessions_dir>/<name>-*.json[.enc]`, picks the most-recently-modified
match) and, if found, `state::load_state` replays cookies via CDP `Network.setCookie` plus
localStorage/sessionStorage **per origin** by opening a temp CDP target, navigating it to each
recorded origin, and running `localStorage.setItem`/`sessionStorage.setItem` (`state.rs:463-538`).
This is a real multi-origin replay, not just cookies.

**2. Restore validation ("did the restore actually work").** Three optional checks — `--restore-check-url
<pattern>`, `--restore-check-text <substring>`, `--restore-check-fn <js-expr>` — are stored on
`DaemonState` and evaluated post-launch by `validate_restored_state` (`actions.rs:2546-2572`),
which waits (capped at `min(default_timeout_ms, 2000)`) for a URL-pattern match, a text
appearance, or a JS predicate to go true. Failure flips `restore_status` to
`"loaded_but_invalid"` and sets `restore_load_failed = true`, which then **gates future saves**
(see #3). This directly answers "did the cookie/session survive" (e.g. "am I still logged in")
instead of blindly trusting a loaded cookie jar. Validation is re-triggered any time the check
config itself changes mid-session (`reconcile_restore_check_change`, `actions.rs:1375-1397`).

**3. Restore-save policy (`auto` / `always` / `never`).** `--restore-save <policy>`
(`is_valid_restore_save_policy`, `main.rs:102-107`). In `auto_save_restore_state`
(`actions.rs:2645-2708`): `never` short-circuits; `auto` **skips saving if the just-loaded
restore was invalid** (`restore_load_failed`) — so a corrupted/expired session snapshot is not
silently perpetuated; `always` saves unconditionally. This is a genuinely useful three-state
policy Silver has zero equivalent of.

**4. Periodic autosave + save-on-idle-close + save-on-close.** The daemon's socket-server tick
loop (`daemon.rs:207-268`, both Unix and Windows variants) runs three independent triggers:
   - a 100ms `drain_interval` that calls `maybe_autosave_restore_state` (`actions.rs:2629-2643`)
     whenever a browser is open — gated by a 2s "quiet period" since the last command
     (`AUTOSAVE_QUIET_PERIOD_MS`, `actions.rs:2588-2617`) so a save never stalls a live command
     burst, and by the configured `SILVER_AUTOSAVE_INTERVAL_MS` (default 30s,
     `autosave_interval_ms_from_env`, `daemon.rs:161-166`);
   - the idle-timeout branch (`idle_sleep_pin` firing after `SILVER_IDLE_TIMEOUT_MS` of socket
     inactivity) calls `auto_save_restore_state` **then** `close_current_browser` before exiting
     the daemon (`daemon.rs:239-249`);
   - `shutdown_signal()` (SIGTERM/SIGINT) does the identical save-then-close.
   The doc comment at `actions.rs:2619-2628` is explicit about *why* periodic saving matters even
   with no new commands: "the page itself can mutate cookies and storage while idle (token
   refreshes, background requests)" — a real failure mode (silent session invalidation) that a
   save-only-on-explicit-close model misses entirely.

**5. Transactional, crash-safe persistence.** `save_auto_state_transactional`
(`state.rs:340-423`) writes the new snapshot to a `.tmp/` candidate file, validates it parses
(`validate_state_file`), rotates the current file to `<name>.previous`, renames the candidate
into place, and only then deletes the `.previous` backup — with rollback (`fs::rename` the
`.previous` back) if the final `rename` fails. This survives a crash mid-write without losing the
last-known-good snapshot, and is tested (`test_state_clear_removes_transactional_backups`,
`state.rs:923-942`, confirms `.previous`/`.enc.previous` are cleaned by `state_clear`).

**6. Encryption at rest — opt-in, passphrase-derived.** `SILVER_ENCRYPTION_KEY` env, if set,
SHA-256-hashes the passphrase into an AES-256-GCM key, prepends a random 12-byte nonce to the
ciphertext, and suffixes the file with `.enc` (`encrypt_data`/`decrypt_data`, `state.rs:717-751`).
Off by default — a plain `.json` file is written if the env is unset. Read path
(`read_state_json`, `state.rs:425-454`) transparently tries the `.enc` sibling if the plain file
is missing and a key is set.

**7. Worktree-scoped session IDs.** `silver session id [--scope worktree|cwd|git-root] [--prefix
p]` (`main.rs:440-528`) resolves a path (git toplevel via `git rev-parse --show-toplevel`
subprocess, `main.rs:400-438`, or plain cwd), SHA-256-hashes the path string, and emits
`<prefix->`+first-12-hex-chars as a deterministic session name — so re-running from the same
worktree always reproduces the same session/restore key without the caller tracking one by hand.

**8. Namespace isolation.** `SILVER_NAMESPACE` (sanitized via `sanitize_session_component`)
reroutes `get_state_dir()` to `~/.silver/namespaces/<ns>/state` (`state.rs:825-843`) and the
daemon socket dir to `.../namespaces/<ns>/run` (`connection.rs:126-133`), and is folded into the
port-derivation hash (`port_identity_for_session`, `connection.rs:366-373`) so two namespaces
never collide on the same local TCP port on Windows. `session info`/`session list` surface the
active namespace (`main.rs:557-573`).

**9. GC / cleanup.** `walk_daemons()` (`connection.rs:205-360`) scans the socket dir once,
reaping stale `.pid`/`.sock`/`.version`/`.config`/`.port` files for dead daemons
(`cleanup_stale_files`, `connection.rs:157-204`) as a side effect of any session-listing/status
call — no separate `gc` verb is needed because every `session list`/`close --all` call
self-heals. `state_clean(max_age_days)` (`state.rs:662-696`, default 30 days, exposed as `state
clean --older-than <days>`) age-prunes saved-state files independently of daemon liveness.

## Why this beats other sources (competitive framing)

Stagehand/browser-use/AgentQL have no daemon-level restore concept at all — state
save/load is a single explicit call the *agent* must remember to make. Aside/Webwright are
closer to Vercel's shape but do not have the three-way `auto/always/never` save policy or the
restore-check validation trio; they either always overwrite on close or never validate that a
restored cookie jar actually produced a logged-in page. Vercel's real edge over all of them is
treating restore as a **daemon-owned lifecycle concern** (auto-load on launch, periodic
background save, save-on-idle-shutdown, crash-safe promote) rather than something the caller must
explicitly invoke at the right moments.

## Concrete gap vs Silver (`session.ts` / `handlers.ts`)

Silver has genuinely matched or **better** primitives on three axes:
- **Encryption at rest is default-ON** (`state-crypto.ts:47-60`, opt out via
  `--no-encrypt-state`) vs. Vercel's default-OFF opt-in passphrase. Silver's key is a random
  32-byte per-machine file (`~/.silver/.state-key`, mode 0600) rather than a SHA-256'd
  passphrase — stronger key material, no key-reuse-across-installs risk. Silver also tags blobs
  with a `SLV1` magic + GCM auth tag it checks on decrypt, giving tamper detection Vercel's
  raw-nonce-prefix format doesn't call out.
- `session id --scope worktree|cwd|git-root`, `session list`, `session gc`, and namespace
  isolation are already ported near 1:1 (`handlers.ts:1374-1455`), including the same
  SHA-256-first-12-hex derivation and the "GC only touches dead-pid non-external sessions" rule.

But the **restore lifecycle itself is almost entirely missing**:

1. **No `--restore` key / auto-load-on-open.** `openSession` (`session.ts:204-270`) has no
   restore-key concept at all; `state save`/`state load` (`handlers.ts:1274-1306`) are two
   separate, always-manual verbs the caller must invoke by hand at the right moment — there is no
   "open this session and if a prior snapshot exists for it, load it automatically."
2. **`state load` doesn't replay localStorage/sessionStorage** — only cookies
   (`handlers.ts:1288-1306`, explicit `NOTE (v1)` comment admitting this). Vercel's `load_state`
   replays cookies **and** per-origin local/session storage via a temp-target navigate-and-inject
   loop (`state.rs:463-538`). This is a real functional gap, not just a lifecycle gap — any app
   that keys auth/state off localStorage (very common with SPA session tokens) does not actually
   restore under Silver today.
3. **No periodic autosave.** Nothing in Silver's tick/loop model saves state while a session sits
   idle; a session only gets a snapshot if the agent explicitly calls `state save`. Silver has no
   daemon "tick" loop at all in the Vercel sense (`session.ts` docstring: browser persists,
   "connection/session-warmth does not" — confirmed no background timer exists).
4. **No idle-timeout-triggered save+close.** `OpenOptions.idleTimeoutMs` is explicitly declared
   dead: "Recorded for later idle-reaping logic; unused by open itself" (`session.ts:44-45`).
   Sessions live until `close`/`session gc` reaps a dead pid; there is no timer that ever fires
   inside Silver's own process (each CLI invocation is short-lived, so there is nowhere for such a
   timer to live without a persistent daemon — this is coupled to gap #7/engine architecture).
5. **No restore-save policy.** No `auto`/`always`/`never` equivalent; `state save` always
   overwrites whatever path it's given.
6. **No restore validation.** No URL-pattern / text-wait / JS-predicate check after a load — a
   caller has no built-in way to know "the cookies loaded but the site logged me out anyway."
7. **No transactional promote-with-backup.** `state save` writes straight to the target path via
   `context.storageState({ path })`; a crash mid-write can corrupt the file with no `.previous`
   fallback (contrast `state.rs:340-423`'s tmp→validate→rotate→rename→cleanup sequence).
8. **`state save`/`state load` are unencrypted.** Unlike the session sidecars, the storage-state
   file written by `context.storageState({ path })` is plain Playwright JSON — Silver's
   default-on encryption does not extend to this file, so the one file most likely to contain
   session cookies is the one left in plaintext.

## Recommendation (keyless, no model calls needed — this is pure daemon/file-lifecycle logic)

**Priority: HIGH.** This is one of the highest-leverage remaining gaps because it's orthogonal to
the Rust-daemon-vs-TS-reconnect engine question — it's pure state-management logic portable to
TS regardless of connection model.

Concrete adoption order:
1. **(P0)** Fix localStorage/sessionStorage replay in `state load` — currently silently drops
   the majority of real-world SPA session state. Cheapest, highest-value fix; port
   `state.rs:463-538`'s per-origin temp-navigate-and-inject approach onto Playwright's existing
   `context.addInitScript`/temp-page primitives.
2. **(P0)** Add a `--restore <name>` flag that auto-loads the newest `<name>-*.json[.enc]`
   snapshot on `open`/session-connect, mirroring `find_auto_state_file` + `try_auto_restore_state`.
   Extend it to encrypt via the existing `state-crypto.ts` path (closes gap #8 for free).
3. **(P1)** Add `--restore-save auto|always|never` and gate saves the same way
   (`auto_save_restore_state`'s policy switch, `actions.rs:2656-2676`).
4. **(P1)** Add transactional save (tmp-write → validate JSON parses → rename current to
   `.previous` → rename tmp into place) — cheap, prevents corruption, no daemon required.
5. **(P2)** Add `--restore-check-url/text/fn` validation post-restore — most valuable once
   periodic/auto-save exists, since it's the signal that decides whether `auto` should keep the
   snapshot.
6. **(P2, coupled to engine work)** Periodic autosave and idle-triggered save-then-close are
   genuinely blocked on Silver adopting *some* persistent process (even a lightweight
   Node-side timer daemon short of Vercel's full Rust daemon) — track this alongside the
   engine-efficiency gap rather than as a standalone task, since a stateless per-command CLI
   process has nowhere to host a tick loop.
