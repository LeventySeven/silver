# Latency: Silver (per-command CDP reconnect) vs Vercel agent-browser (persistent daemon)

**Date:** 2026-07-16 · **Host:** darwin arm64 (Apple Silicon), macOS 25.2
**Silver:** `node /Users/seventyleven/Desktop/Silver/silver/dist/cli.js` (Playwright/TS; browser persists, but each command = fresh `node` process + CDP reconnect)
**Vercel:** `agent-browser` v (chrome-150) — persistent native daemon (`agent-browser-darwin-arm64`, holds the browser + CDP connection alive; CLI is a thin client over a local socket)
**Method:** `gdate +%s%N` wall-clock around each command; 3 trials/URL; every command verified exit 0 (see note on the zsh bug below). Warm snapshot = snap2–5 (Vercel caches, so snap1 is cold-cache and reported separately).

## Isolation of fixed overhead (median of 5, no browser work)
| Component | ms |
|---|---|
| bare `node -e ''` | 42 |
| `silver version` (loads CLI/Playwright bundle, no browser I/O) | **189** |
| `agent-browser get url` (thin client → warm daemon roundtrip) | **6** |

→ Silver pays **~189 ms per command just to start the process** (42 ms node + ~147 ms bundle/Playwright import) *before touching the browser*. Vercel's client reaches the already-connected browser in **~6 ms**.

## Medians (ms)

### https://example.com
| Phase | Silver | Vercel |
|---|---|---|
| cold `open` (spawn/attach) | **2237** | **822** |
| warm `snapshot -i` (snap2–5) | **1469** | **8** |
| (Vercel snap1, cold cache) | — | ~550 |
| `get title` | **258** | **6** |

### https://en.wikipedia.org/wiki/Web_browser
| Phase | Silver | Vercel |
|---|---|---|
| cold `open` | **2640** | **1704** |
| warm `snapshot -i` (snap2–5) | **1610** | **11** (trial 1 ran ~50) |
| (Vercel snap1, cold cache) | — | ~500 |
| `get title` | **243** | **6** |

## Per-command reconnect overhead (the connection-model gap)
`get title` is the cleanest probe (minimal browser work), so its cost is almost entirely connection overhead:

- **Silver ≈ 250 ms** = 189 ms process/bundle startup + **~60 ms CDP reconnect handshake** + query.
- **Vercel ≈ 6 ms** = thin client + unix-socket roundtrip to warm daemon.
- **Silver per-command penalty ≈ +244 ms**, of which **~189 ms is process/bundle reload** and **~60 ms is CDP reconnect**.

This is *per command* and compounds. A 20-step agent loop pays **~4.9 s of pure overhead** in Silver vs **~0.12 s** in Vercel — before any real page work.

## A second, separate gap: snapshot computation
Silver's warm `snapshot -i` is **~1469–1610 ms** vs Vercel's **~8–11 ms**. Only ~250 ms of Silver's number is connection overhead (per `get title`); the remaining **~1200–1350 ms is snapshot/a11y-tree computation**, rebuilt from scratch every call. Vercel caches the tree after the first snapshot (snap1 ~500 ms, then ~8 ms). This gap is **algorithmic, not connection-model** — a persistent daemon would NOT fix it.

## Is a persistent-connection change warranted? — YES, and it's the cheaper of two wins
- A long-lived Silver daemon (one node process holding the Playwright connection; thin client sends verbs over a socket) removes **both** the ~189 ms bundle reload **and** the ~60 ms reconnect, pulling per-command overhead from **~250 ms → single-digit ms**, matching Vercel. High leverage on every command, low algorithmic risk.
- **But it is not the only gap.** Silver's snapshot is ~150× slower than Vercel's warm snapshot due to recomputation. Even with a daemon, a `snapshot -i` would still cost ~1200 ms unless Silver also (a) caches the a11y tree and invalidates on mutation, and (b) speeds up tree extraction. **The snapshot cache is the bigger absolute latency win** (~1200 ms/call vs ~244 ms/call from the daemon), but the daemon is simpler and helps *every* verb.

**Recommendation (priority order):**
1. **Snapshot tree cache + dirty-tracking** — biggest single-command win (~1.2 s → ~tens of ms), independent of transport.
2. **Persistent daemon / long-lived connection** — removes the ~244 ms fixed tax on every command; essential for multi-step agent loops where it compounds.
Both are warranted; neither substitutes for the other.

## Honesty / rigor notes
- First harness pass reported Silver at 2–4 ms — a **measurement bug**, not a result: zsh does not word-split an unquoted `$SILVER="node …/cli.js"`, so the command failed instantly (below node's 42 ms floor) with stderr suppressed. Fixed by using shell arrays and asserting exit 0. Lesson: any "browser command" faster than ~189 ms (Silver's startup floor) is a failed command, not a fast one.
- Cold `open` includes ~700–800 ms of Chrome launch for both tools; the tool-attributable difference there is smaller than the warm-command gap and dominated by browser startup, so warm commands are the fairer comparison of the connection model.
- Vercel warm snapshot showed variance (wikipedia trial 1 ~50 ms vs ~10 ms elsewhere), likely cache warmup; reported as a range.

## Raw data
Harness: `scratchpad/bench2.sh`. All commands exited 0. Trials inline above (3/URL).
