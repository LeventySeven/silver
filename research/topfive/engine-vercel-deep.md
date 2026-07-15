# Engine Deep-Dive: Vercel (rust-oracle) vs Silver — closing the latency gap

Scope: HOW Vercel achieves low latency + lean output, PRECISELY where Silver
pays more, and a concrete keyless Silver engine plan that closes the latency gap
without breaking stateless-command ergonomics. Grounded in source + measured.

Files read (Vercel): `cli/src/connection.rs`, `cli/src/native/daemon.rs`,
`cli/src/native/browser.rs`, `cli/src/native/cdp/client.rs`,
`cli/src/native/snapshot.rs`. Files read (Silver): `src/core/session.ts`,
`src/core/handlers.ts`, `src/core/lock.ts`, `src/cli.ts`,
`src/perception/*` (survey).

---

## 1. How Vercel is FAST (the connection model)

Vercel's speed is an **architecture** property, not a language property. Two
processes, one held connection:

**A resident per-session daemon** (`daemon.rs::run_daemon`). Spawned lazily and
detached on first command by `connection.rs::ensure_daemon` (setsid + piped
stderr, lines 865–908). It writes `<session>.pid` / `.version` / `.sock` sidecars
and then **owns the browser for its whole lifetime**. Liveness is a socket
connect, not a pid check (`daemon_ready`, line 399), so any caller that can reach
the socket reuses it. Idle-timeout auto-shutdown, graceful "close" via a `Notify`
(so Drop fires and Chrome isn't orphaned, lines 255–260), and a version check
that restarts a stale daemon after upgrade (`daemon_version_matches`, line 699).

**One held CDP WebSocket** (`cdp/client.rs::CdpClient`). Opened ONCE at browser
launch (`browser.rs:371`) and kept open for the daemon's life. It is a fully
multiplexed transport:
- a spawned reader task (`client.rs:100`) demuxes by message id → per-command
  `oneshot` channels (`pending: HashMap<u64, Sender>`), and events →
  `broadcast::channel(4096)`;
- an atomic `next_id` counter (line 212) lets many in-flight commands share the
  socket;
- a 30s WebSocket **keepalive ping** task (line 181) + TCP `SO_KEEPALIVE`
  (line 343) hold the connection warm through proxies.

**Connection warmth = state that never gets re-paid.** `BrowserManager`
(`browser.rs:297`) holds in **RAM** across commands: the CDP client, the page
list + active index, `next_tab_id`, `visited_origins`, and (via `DaemonState`)
the RefMap. Domains (`Page`/`Runtime`/`Network`/`Accessibility` + auto-attach)
are enabled **once** per target at attach time (`enable_domains`, line 595), not
per command. A `snapshot` therefore skips straight to `Accessibility.getFullAXTree`.

**The client↔daemon hop is deliberately cheap and per-command.**
`connection.rs::send_command_once` (line 1095) opens a FRESH unix-socket
connection, writes ONE JSON line, reads ONE line, closes. That reconnect is
microseconds because it is a local socket — the *expensive* browser WebSocket is
the one held open by the daemon. **This is the key idea to copy: persist the
DAEMON↔BROWSER connection; the CLIENT↔DAEMON connection can stay stateless.**

## 2. How Vercel is LEAN (token efficiency — orthogonal, noted not solved here)

Token-efficiency lives entirely in `snapshot.rs`, independent of the daemon.
`SnapshotOptions { interactive, compact, depth }` (line 77) drives three levers:
`interactive` renders only ref-bearing nodes (`render_tree`, line 1118);
`compact_tree` (line 1211) keeps only lines with `ref=`/values plus their
ancestor chain; `depth` caps indentation. Plus StaticText aggregation
(line 999), generic-node collapsing (line 1091), and role-scoped refs. This is a
**snapshot-format** property — Silver's parity work here belongs to the
perception task, not this engine pass. Flagging so it isn't conflated with latency.

---

## 3. Silver today — what it already has vs the gap

### Silver ALREADY has (do not rebuild)
- **Browser-as-daemon.** `session.ts::openSession` spawns a DETACHED Chromium
  with `--remote-debugging-port` and `child.unref()` (lines 233–237), so the
  BROWSER already survives CLI exit. Silver does **not** relaunch Chrome per
  command — same win as Vercel at the browser-process layer.
- **Cross-command state**, via encrypted sidecars (`session.json`, `refmap.json`;
  AES-256-GCM, `writeSidecar` line 144) — Vercel's equivalent lives in RAM.
- **Same-session serialization.** `lock.ts::withSessionLock` (advisory file lock,
  pid-liveness + heartbeat) serializes commands against one session — Vercel gets
  this free from its single-process `state.lock().await` Mutex.
- **Namespace isolation, external `connect <endpoint>` sharing, dialog/route
  re-application** on each connection (`handlers.ts:193`).

### GAP: no persistent PROCESS or held CDP connection
Every Silver command is a **cold Node process** that re-imports Playwright and
re-runs `connectOverCDP` (`handlers.ts::withConnection` → `session.ts::connect`,
line 328), enables domains, re-discovers the active page, re-attaches the dialog
handler, re-applies routes, then `browser.close()` drops the transport
(`handlers.ts:214`). Vercel re-pays NONE of this on a warm command.

## 4. Quantifying the reconnect cost (measured on this machine)

Fresh Node process per command, browser already warm (Playwright 1.x, Node
v25.9, headless Chromium, medians of 3):

| Cost component | Measured |
|---|---|
| Bare `node -e 0` boot | ~40 ms |
| `node` + `import('playwright')` | ~175 ms |
| Silver full `version` cmd (node+app boot, no browser) | ~180–200 ms |
| `connectOverCDP` + context/page + viewport, **cold first in process** | ~24–26 ms |
| same, repeated in a **warm** process | ~4 ms |
| **Silver total per warm-browser command (wall)** | **~200–210 ms** |
| Vercel Rust thin-client boot (`silver --version`) | **<5 ms** |

**Reading the numbers.** The `connectOverCDP` reconnect is real but is **~25 ms /
~12% of the cost** — NOT the dominant term. The dominant term is the **~180 ms
Node + Playwright module load paid on every process**. A daemon fixes BOTH at once
(the browser connection is held AND the runtime stays resident), but the biggest
single lever for Silver is simpler: **stop importing Playwright on the client
path.** Vercel's <5 ms boot vs Silver's ~200 ms is a ~40× fixed-overhead gap,
almost all of it runtime boot, not browser I/O.

---

## 5. Concrete Silver engine plan (keyless, stateless-ergonomics preserved)

Mirror `daemon.rs`/`connection.rs` in Node. Three phases, each shippable alone;
each keeps today's direct path as a fallback so the daemon is a pure optimization,
never a correctness dependency.

### Phase 1 — Kill the client-side Playwright import (biggest ROI, lowest risk)
`cli.ts` currently pulls `handlers.ts` (→ `session.ts` → `import { chromium }
from 'playwright'`, `session.ts:18`) into EVERY invocation. Split the dispatcher
so the fast path — flag parse (`flags.ts`) + phase-quarantine gate
(`registry.ts`) + (Phase 2) socket forward — never statically imports Playwright.
Make `import('playwright')` a **dynamic import** reached only on the direct
(no-daemon) browser branch. Expected: forwarded/meta commands drop from ~200 ms
to ~45–50 ms with zero behavior change. Do this first even before the daemon.

### Phase 2 — The persistent daemon (the Vercel port)
Add an internal `silver __daemon --session <name>` long-lived Node process:
- On first command, the client lazily spawns it **detached + unref'd**, exactly
  like `ensure_daemon` (spawn → poll `daemon.sock` readiness → write `.pid`/
  `.version`). Reuse the existing `~/.silver/<ns>/sessions/<name>/` dir; add
  `daemon.sock` (Unix) / loopback TCP + hashed port on Windows (copy
  `connection.rs::get_port_for_session`, line 377).
- The daemon calls `openSession`/`connect` ONCE, holds `Browser`/`Context`/`Page`
  + RefMap + tab registry + route rules **in memory**, and serves a JSON-line
  request loop over the socket (mirror `daemon.rs::handle_connection`, line 392).
- Client becomes a **thin forwarder**: parse → JSON request → write one line →
  read one line → print envelope (copy `send_command_once`). Client↔daemon stays
  per-command (stateless) — cheap because local socket.
- Copy the hard-won correctness bits verbatim: version-mismatch restart, idle
  auto-shutdown (`SILVER_IDLE_TIMEOUT_MS`), graceful close that lets the browser
  shut down cleanly, autosave-on-interval, stale-pid cleanup (`walk_daemons`).
- **Fallback:** if `daemon.sock` is unreachable AND the session is `external`
  (a `connect <endpoint>` browser we don't own), or the daemon fails to spawn,
  run today's direct `withConnection` path unchanged.

### Phase 3 — Connection warmth
In the daemon, enable domains / attach the dialog handler / apply route rules
**once** on the held connection instead of per command (`handlers.ts:204–210`).
Keep RefMap in RAM; still persist the sidecar on close so a cold fallback command
after an idle-shutdown resumes correctly.

### Keyless + ergonomics invariants (unchanged)
- **Keyless:** pure Unix socket + JSON lines + pid files. No model, no network,
  no secrets on the wire; the socket lives in the user-owned session dir.
- **Stateless commands:** the user still runs discrete `silver click @e3`
  invocations with identical argv and envelopes; the daemon is invisible.
- **Security choke points preserved:** run the phase-quarantine gate client-side
  (cheap, no browser) so an un-permitted verb never even reaches the socket, and
  re-assert egress/redaction/confirm **inside the daemon** where the browser is.
- **Serialization:** the daemon naturally serializes one request at a time per
  session (like Vercel's Mutex); keep the file lock only to guard the spawn race.

### Expected outcome
Warm command ~200 ms → **~50 ms** (now client-boot-dominated), a ~4× latency win.
The residual ~45 ms gap vs Vercel is Node-vs-native **client** boot — inherent to
the keyless-TS choice and not worth abandoning TS/keylessness to recover. The
reconnect gap and the runtime-reboot gap are both closed.
