# Deep Dive — Vercel (rust-oracle) ENGINE: persistent per-session daemon + one held CDP connection

Lens: engine. Goal: understand HOW the daemon/CDP model makes Vercel fast + lean,
why it beats a per-command reconnect, and the CONCRETE gap vs Silver
(`connectOverCDP` every command) with a keyless adopt plan.

Files read in full (rust-oracle = the Vercel agent-browser engine, Silver-branded):
`cli/src/connection.rs` (1598 L), `cli/src/native/daemon.rs` (792 L),
`cli/src/native/cdp/client.rs` (361 L), `browser.rs` (BrowserManager +
`enable_domains`, L297–646), `actions.rs` (`DaemonState` L276, drain loop L714,
`execute_command` L1614). Silver: `core/session.ts`, `core/handlers.ts`
(`withConnection` L193), `cli.ts`. Measurements taken on this machine (Node
v25.9, medians of 3), reported below.

---

## 1. WHAT the engine is (two processes, ONE held connection)

The architecture is a **thin stateless client** talking to a **fat stateful
daemon** over a cheap local socket. Three moving parts:

**(a) The client** (`connection.rs`). Every CLI invocation is throwaway.
`send_command_once` (L1095) opens a FRESH `UnixStream::connect` (L992), sets a
read timeout (L1098), writes ONE JSON line (`write_all`, L1104), reads ONE line
back with a `BufReader` (L1110), and drops the socket. That's the entire client
lifecycle per command. On Windows it's loopback TCP on a hash-derived port
(`get_port_for_session`, L377; `resolve_port` reads the daemon's actual `.port`
file, L391). `send_command` (L1005) wraps this in a 5-try retry loop that
distinguishes **transient** errors (EAGAIN/EOF/reset — retry same daemon,
`is_transient_error` L1045) from **unreachable** (connection-refused/socket-gone
— respawn via `ensure_daemon`, `daemon_unreachable` L1062). This taxonomy is the
correctness spine: a busy daemon is waited on, a dead one is replaced, and the two
are never confused (the `has_os_error` exact `(os error N)` match at L1073 exists
specifically so "os error 11" EAGAIN doesn't accidentally match "os error 111"
connection-refused).

**(b) Daemon lifecycle** (`ensure_daemon`, L784). Liveness is a **socket connect,
not a pid check** (`daemon_ready` L399 → `UnixStream::connect(...).is_ok()`), so
any caller that can reach the socket — even from a different PID namespace
(`unshare`) — reuses the daemon. On first command the client spawns
`silver __daemon` **detached**: `setsid()` via `pre_exec` (L874), stdin/stdout
null, **stderr piped** (L883) so an early crash's error can be surfaced (L928–970).
It then polls `daemon_ready` up to 50×100ms (L912). Two hardening details worth
copying: a **version check** (`daemon_version_matches` L699) kills+restarts a
daemon left over from an older CLI build (or "the Node.js era" — the comment at
L697 literally anticipates a TS→Rust migration), and a **config fingerprint**
(`daemon_config_fingerprint` L583, hashing debug/policy/allowed-domains/idle/
timeout/dialog flags) restarts a daemon whose launch config no longer matches the
requested one — while a **spawn-race loser** who bound second piggybacks on the
winner instead of clobbering it (L914–924, tested at L1301). No settle-sleep on
the hot path (comment L790): a fixed 150ms delay "used to dominate warm command
latency," so they deleted it and handle the rare exit-after-check race at request
time via the retry/respawn loop.

**(c) Daemon runtime** (`daemon.rs::run_daemon` L23 → `run_socket_server` L169).
Writes `.pid`/`.version` sidecars (L66–70), binds `UnixListener` (L179), and owns
a `Arc<tokio::sync::Mutex<DaemonState>>` (L189). The core is one `tokio::select!`
loop (L207):
- **accept** → `tokio::spawn(handle_connection)` (L216). `handle_connection`
  (L392) reads JSON lines, and for each takes `state.lock().await` and calls
  `execute_command` (L445). The Mutex means commands **serialize** per session
  for free (no file lock needed — Silver has to emulate this with `withSessionLock`).
- **drain tick** every 100ms (L225): reaps a hand-closed browser
  (`has_process_exited`), then `drain_cdp_events_background` (actions L714 —
  ACKs screencast frames, prunes destroyed targets, registers cross-origin iframe
  sessions) and `maybe_autosave_restore_state`. This is **background work the
  client never has to remember to trigger** — buffered CDP dialog/target events
  are consumed between commands, not lost.
- **idle timeout** (L239, `SILVER_IDLE_TIMEOUT_MS`): auto-saves state and closes
  the browser after inactivity. The pinned `idle_sleep` is created ONCE outside
  the loop (L204) and only reset on the `reset_rx` channel (L250) — a fixed
  regression (test L701, bug #1101) where recreating it each drain tick meant the
  deadline never arrived.
- **graceful close** via a `Notify` (L255): a `close` command signals the loop to
  `break` and run destructors rather than `process::exit()`, so Chrome isn't
  orphaned (issue #1113, L198).

## 2. The ONE held CDP WebSocket — why "warm" is cheap

`CdpClient` (`cdp/client.rs:29`) is opened **exactly once** at browser launch
(`browser.rs:371`, `CdpClient::connect(&ws_url)`) and lives for the daemon's whole
life inside `BrowserManager.client: Arc<CdpClient>` (browser L298). It is a fully
multiplexed transport, not a request/response socket:
- `connect_with_headers` (L53) splits the WS into `ws_tx`/`ws_rx` and spawns a
  **reader task** (L100) that demuxes: messages with an `id` → look up the
  `oneshot::Sender` in `pending: HashMap<u64, Sender>` and deliver (L150–155);
  messages with a `method` → `broadcast::channel(4096)` for events (L156–164).
- `send_command` (L206) does `next_id.fetch_add(1, SeqCst)` (L212, an atomic so
  many in-flight commands share the socket), inserts a `oneshot` into `pending`,
  writes the frame, and awaits its reply with a 30s timeout (L239). Many commands
  can be in flight concurrently over the single socket.
- **Warmth = state that never gets re-paid.** Domains are enabled ONCE per target
  at attach (`enable_domains` browser L595): `Page.enable`, `Runtime.enable`,
  `runIfWaitingForDebugger`, `Network.enable`, `Target.setAutoAttach{flatten}`.
  A later `snapshot` skips straight to `Accessibility.getFullAXTree` — it never
  re-enables anything. `BrowserManager` also holds in RAM the page list +
  `active_page_index`, `next_tab_id`, `visited_origins`, `ignore_https_errors`,
  and (via `DaemonState`) the `RefMap`, `iframe_sessions`, `routes`,
  `origin_headers`, `proxy_credentials`, `event_tracker` (actions L276–330). None
  of this is reconstructed per command.
- **Connection kept warm through proxies**: a 30s WebSocket **Ping** keepalive
  task (L181) plus TCP `SO_KEEPALIVE` (L343, 30s idle / 10s probe) hold the socket
  open across Envoy/nginx/cloud-LB idle timeouts — critical for remote CDP
  providers (Browserbase, AgentCore). The reader also accepts Binary frames (L106)
  because some proxies wrap responses that way.

**The key insight to steal:** the client↔daemon hop is deliberately *stateless
and re-opened per command* (L1096) because it's a **local socket = microseconds**;
the *expensive* browser WebSocket + domain setup is the one held open. Persist the
DAEMON↔BROWSER connection; the CLIENT↔DAEMON connection can stay cold and cheap.

## 3. Why it BEATS a per-command reconnect (the mechanism, quantified)

Per Vercel command, the ONLY cost is: local socket connect + one JSON line each
way + the actual CDP round-trip inside a warm, already-multiplexed socket. The CDP
handshake, `Runtime.enable`/`Accessibility.enable`, target discovery, iframe
auto-attach, and frame bookkeeping are all **amortized to once per browser
session**. Thin-client boot is native Rust (<5ms). Background event draining and
autosave happen between commands the client never triggers.

## 4. Silver's engine today — what it HAS vs the GAP

**Silver already has browser-as-daemon at the PROCESS layer.** `session.ts`
header (L1–13) documents the exact model; `openSession` (L204) spawns detached
Chromium with `--remote-debugging-port` (L216) and `child.unref()` (L237), so the
**browser survives CLI exit** — same win as Vercel at the process layer. It also
has cross-command state via encrypted sidecars (AES-256-GCM `session.json`/
`refmap.json`, a security edge Vercel's plain-JSON `state.rs` lacks), per-session
serialization via `withSessionLock` (an advisory file lock emulating Vercel's free
Mutex), namespace isolation, and external `connect <endpoint>` sharing.

**The GAP: no persistent PROCESS and no held CDP connection.** Every Silver
command is a **cold Node process**. `cli.ts` statically imports `handle` from
`handlers.js` (L27), which statically imports `chromium` from `playwright`
(handlers L24; session L18) — so Playwright loads on EVERY invocation, even
browserless meta verbs. `withConnection` (handlers L193) then, per command:
`ensureConnected` → `session.connect` → `chromium.connectOverCDP(wsEndpoint)`
(session L338), re-discovers context/page (L339–344), re-sets viewport,
re-attaches the dialog handler (handlers L204), re-applies route rules
(`applyRoutes`, L210) — Playwright re-enables domains under the hood on the fresh
CDP session — and finally `conn.browser.close()` drops the transport (L214).
**Vercel re-pays NONE of this on a warm command.** Silver's browser persists; its
*connection and connection-warmth* do not.

## 5. Quantifying the cost (MEASURED on this machine, Node v25.9)

| Cost component | Measured |
|---|---|
| Bare `node -e 0` | ~40 ms |
| `node` + `import('playwright')` | ~200–300 ms |
| `node` importing `session.js` (pulls playwright) | ~200 ms |
| **`silver version`** (META verb, NO browser at all) warm | **~190 ms** |
| Vercel Rust thin-client boot | **<5 ms** |

**Reading the numbers — the surprising, load-bearing finding:** the
`connectOverCDP` reconnect is real but is NOT the dominant term (~25ms / ~12% per
the seed's isolated measurement). The dominant term is the **~150ms Playwright
module import paid on every process**, and — confirmed here — Silver pays it even
on `version`, which never touches a browser, purely because `cli.ts →
handlers.js → import { chromium }` is a static import chain (grep-confirmed:
`dist/core/handlers.js:24` and `dist/core/session.js:18`). Vercel's <5ms vs
Silver's ~190ms is a ~40× fixed-overhead gap, and **most of it is runtime+module
boot, not browser I/O.** A daemon closes BOTH (connection held AND runtime stays
resident), but the single biggest lever is cheaper than a daemon: stop importing
Playwright on the client/meta path.

## 6. Keyless adopt recommendation + priority

Everything here is keyless — pure Unix socket + JSON lines + pid/version/config
sidecars, no model, no network, no secrets on the wire. Adopt in three shippable
phases, each a pure optimization with today's direct path kept as fallback.

**Phase 1 — Kill the client-side Playwright import. PRIORITY: HIGHEST (biggest
ROI, lowest risk, no daemon needed).** Make `import('playwright')` a **dynamic
import** reached only on the actual browser branch; keep flag-parse + registry
gate + (later) socket-forward free of it. Split `handlers.ts` so meta/forwarded
verbs never statically pull `session.ts`. Measured target: meta/forwarded commands
drop ~190ms → ~45–50ms with zero behavior change. Do this FIRST, even before the
daemon — it's a refactor, not an architecture change.

**Phase 2 — The persistent daemon (the Vercel port). PRIORITY: HIGH.** Add
`silver __daemon --session <name>`: client lazily spawns it detached+unref'd
(mirror `ensure_daemon` — spawn, poll `daemon.sock`, write `.pid`/`.version`/
`.config`), daemon calls `openSession`/`connect` ONCE and holds
Browser/Context/Page + RefMap + tab registry + routes in memory, serving a
JSON-line request loop (mirror `handle_connection`). Client becomes a thin
forwarder (`send_command_once`). **Copy the hard-won correctness bits verbatim:**
version-mismatch restart (L699), config-fingerprint restart (L583), spawn-race
piggyback (L914), transient-vs-unreachable taxonomy (L1045/L1062, retry vs
respawn), idle auto-shutdown, graceful close-via-Notify so Chrome isn't orphaned
(L255), no settle-sleep on the hot path. **Fallback:** if the socket is
unreachable OR the session is `external` (a `connect <endpoint>` browser we don't
own), run today's `withConnection` unchanged — the daemon is never a correctness
dependency.

**Phase 3 — Connection warmth. PRIORITY: MEDIUM.** In the daemon, enable domains /
attach dialog handler / apply routes ONCE on the held connection instead of per
command; keep RefMap in RAM; still persist the sidecar on close so a cold fallback
after idle-shutdown resumes correctly.

**Invariants preserved:** run the phase-quarantine gate client-side (cheap, no
browser) so an un-permitted verb never reaches the socket; re-assert
egress/redaction/confirm INSIDE the daemon where the browser is; keep the file
lock only to guard the spawn race (the daemon's single-request loop serializes
the rest, like Vercel's Mutex).

**Expected outcome:** warm command ~190ms → ~50ms (~4× win), now client-boot
dominated. The residual ~45ms vs Vercel is native-vs-Node **client** boot —
inherent to the keyless-TS choice and not worth abandoning TS to recover. Both the
reconnect gap and the runtime-reboot gap close; token-efficiency (the snapshot
format) is orthogonal and belongs to the perception pass, not here.
