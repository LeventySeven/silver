# Silver — Parallel Throughput & Cold-Start / Engine-Efficiency Measurement

**Date:** 2026-07-16
**Host:** macOS (darwin 25.2), Apple Silicon, Node v25.9.0
**Silver:** `node /Users/seventyleven/Desktop/Silver/silver/dist/cli.js`
**Vercel:** `agent-browser 0.31.2` (Homebrew, Rust)
**Method:** `time.perf_counter()` wall-clock wrappers; medians of 5–15 trials; a
tiny local HTTP page and `https://example.com/` (shared for both tools) to keep
navigation constant. Raw scripts in the session scratchpad
(`timeit.py`, `cold_open.sh`, `reconnect_bench.mjs`, `snap_attrib.mjs`,
`networkidle_bench.mjs`, `parallel.sh`).

---

## TL;DR

The "engine gap vs Vercel" is **real but almost entirely NOT where the brief
hypothesized.** The per-command `connectOverCDP` reconnect that was suspected as
the cost is **~3 ms — negligible.** The gap is two other things:

1. **Node process startup: ~190 ms per command** (fixed tax; Vercel's Rust
   binary is ~3 ms). Every Silver verb pays this because each invocation is a
   fresh `node` process.
2. **A ~500–1200 ms `networkidle` settle burned on *every* snapshot/action**,
   because a fresh per-command Playwright client re-observes load-state from
   scratch. This — not the language, not the CDP reconnect — is why Silver's
   `snapshot` is **1469 ms** vs Vercel's daemon-served **5.5 ms**.

Silver's actual perception walk (`snapshotNodes`) is **~5 ms** — competitive
with anything. The token-efficiency of the snapshot format is unaffected by all
of this (it's a property of the serializer, not the engine).

---

## 1. Cold-start (process overhead, no browser)

| Command | Median | Min–Max | n |
|---|---|---|---|
| Silver `version` | **191.7 ms** | 189.0–200.5 | 11 |
| Vercel `--version` | **3.2 ms** | 2.8–4.0 | 11 |

**~188 ms fixed Node-vs-Rust startup tax per command.** This is the language
floor and it is paid on *every* Silver invocation.

## 2. Cold `open` (fresh browser spawn + navigate example.com)

| Tool | Median | Samples (ms) |
|---|---|---|
| Silver | **~2115 ms** | 2067, 2102, 2253, 2215, 2100, 2128 |
| Vercel | **~940 ms** | 1331(warmup), 1003, 938, 943, 902, 893 |

Both spawn a real Chromium, so the browser binary launch is common. Silver's
extra ~1.1 s is harness overhead (Node start + Playwright launch + its readiness
polling of `DevToolsActivePort` + `/json/version`, budgeted to 8 s).

## 3. Warm commands (browser already running)

| Command | Silver median | Vercel median | Ratio |
|---|---|---|---|
| `get url` | **224.8 ms** | 4.7 ms | 48× |
| `snapshot` | **1469 ms** | 5.5 ms | 267× |

Vercel's 4–6 ms warm latency ⇒ it is serving from a **persistent warm client**:
its Chrome lives under `~/.agent-browser/browsers/…` and the Rust CLI talks to
it holding cached page + load-state. It never re-pays startup or settle.

---

## 4. The `connectOverCDP` reconnect cost — MEASURED, and it is NOT the problem

Direct microbench (spawn one detached browser, then repeat exactly what every
Silver command does: `connectOverCDP` → trivial op → `browser.close()`):

```
connectOverCDP_ms:            median 3.1   (samples 40.2(jit),5.7,4.3,3.8,3.1,3.0,…,2.5)
reconnect_envelope (c+op+cl): median 4.0
```

**The per-command CDP reconnect is ~3 ms.** It is a localhost WebSocket to an
already-running browser — cheap. A "persistent connection cache" would save
**~3 ms/command**. That optimization is not worth building on its own.

## 5. Where the 1469 ms snapshot actually goes (per-phase, warm, isolated)

```
iter: connect=4-7  snapshotNodes=4-9  title=1  settle+fingerprint=491-499  close=1-2   (ms)
```

- **`snapshotNodes` (the AX walk, refmap, interactive cascade): ~5 ms.** Fast.
- **`settleAndFingerprint`: ~500 ms** — and on a page where `networkidle` never
  re-fires on the re-attached client it runs to the full **1200 ms** budget
  (`NETWORK_IDLE_BUDGET_MS`, `src/actuation/pagechange.ts:37`).

Confirmation that settle is reconnect-induced, not page-induced:

- `snapshot` on **`about:blank`** (zero network) is still **~1465 ms** — the
  settle budget is burned even with no network at all.
- `waitForLoadState('networkidle')` on a freshly re-attached, already-loaded
  page costs **~500 ms every time** (Playwright restarts its 500 ms idle timer
  because this client never observed the load) — measured 4/4 iterations at
  498–501 ms.

So the snapshot cost = Node startup (190) + module load (~35) + **settle
(500–1200)** + state encrypt/atomic-write ×2 + render/observe. **The settle
dominates, and it exists only because each command is a new Playwright client
with no load-state memory** — the direct consequence of the per-command
connection model (not the reconnect *handshake*, but the *loss of client
state* across reconnects).

---

## 6. Parallel throughput & isolation

4 sessions (`p1`–`p4`), each `open`+`snapshot` on a different site:

| Mode | Total wall-clock |
|---|---|
| Sequential (4×) | **15595 ms** |
| Parallel (4 concurrent) | **4446 ms** |
| **Speedup** | **3.5×** (near-linear) |

**Isolation: clean.** Post-run each session reported its own distinct URL
(example.com / example.org / iana.org / httpbin) with zero cross-contamination.
Each `--session` is a separate detached Chromium with its own
`--user-data-dir` and `--remote-debugging-port`; the browser-as-daemon model
(`openSession` → `child.unref()`) gives real process-level isolation and
crash-independence. Parallelism scales to core/spawn-CPU limits, not to a shared
engine bottleneck.

---

## 7. Engine-change recommendation

**Do NOT build a "persistent CDP connection cache."** Empirically the reconnect
is ~3 ms; caching it saves ~3 ms/command and adds lifecycle complexity. Rejected
on evidence.

**Priority 1 — Fix the settle logic (free, biggest single win, ~500–1200 ms/cmd).**
`snapshot` is read-only observation of an already-loaded page; it should not race
`networkidle` at all. Options, in order:
- Skip `settleAndFingerprint`'s network-idle race on pure `snapshot`/`get`/`is`
  (read verbs). Only settle after `open`/`goto`/`click`/`fill`/`press` — the
  verbs that actually mutate the page. This alone drops warm `snapshot` from
  ~1469 ms toward **~230 ms** (the `get url` floor) with no daemon.
- Where a settle *is* wanted after an action, cap the "never idles" budget far
  below 1200 ms (e.g. 300 ms) or gate it behind `--wait networkidle`.

**Priority 2 — Opt-in daemon for the Node-startup tax (~190 ms/cmd).** The only
way to erase the 190 ms is to stop spawning a Node process per command. A
long-lived Silver daemon (one warm Node process holding the CDP connection +
page handles + refmap in memory), with the CLI becoming a thin Unix-socket
client, would:
- remove the 190 ms startup on every command,
- and — critically — **retain Playwright load-state**, which *also* eliminates
  the settle re-observation from Priority 1 the way Vercel's does.
Keep per-command spawn as the **default** (it buys the crash-isolation and the
clean 3.5× parallelism measured above). Make the daemon `--daemon` opt-in for
latency-sensitive interactive loops. This mirrors Vercel's architecture without
a Rust rewrite.

**Do NOT rewrite perception in Rust for speed.** `snapshotNodes` is ~5 ms; the
language is not the bottleneck for the work that defines Silver's value. Token
efficiency lives in the serializer and is orthogonal to all of the above.

**Net:** Priority 1 closes ~85% of the warm-command gap for zero architectural
cost. Priority 2 (opt-in daemon) closes the rest and matches Vercel's warm
latency profile, while the default spawn model keeps Silver's isolation and
parallelism advantages.
