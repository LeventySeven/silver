# Silver Engine Plan — token-competitiveness + the latency gap vs Vercel

**Author:** synthesis lead · **Date:** 2026-07-16
**Sources (empirical, this machine):** `research/deepdive/measure-latency.md`,
`measure-tokens.md`, `measure-parallel-coldstart.md`, `vercel-engine.md`,
`webwright-browserlifecycle.md`. **Code:** `silver/src/core/session.ts`,
`core/handlers.ts`, `actuation/pagechange.ts`, `perception/serialize.ts`, `cli.ts`.

---

## 0. Verdict (decisive)

1. **Token efficiency:** Silver's snapshot *format* is already competitive —
   **equal-to-leaner per node than Vercel** once you match information content.
   The 1.6–3.7× headline bloat is **three default choices, not the encoding**.
   **Keep the format; flip three defaults.** No engine change.
2. **Latency:** the gap is real but **~97% of it is two fixable things that are
   NOT the CDP reconnect.** The single biggest warm-command win is **one line**
   (stop racing `networkidle` on the read-only `snapshot` verb), is **free**, and
   needs **no daemon**. A persistent daemon is worth building but is **P3, opt-in**
   — the default per-command-spawn model buys crash isolation and a measured
   **3.5× near-linear parallelism** we must not trade away.

---

## 1. Empirical reconciliation — WHERE the 1469 ms snapshot actually goes

The three latency docs give **conflicting attributions**. This is load-bearing,
so resolve it before spending any effort:

| Doc | Claims the ~1245 ms snapshot-vs-`get` delta is… | Prescribes |
|---|---|---|
| `measure-latency.md` | **a11y-tree recomputation** (~1200 ms, rebuilt each call) | snapshot/a11y **cache** (P1) + daemon (P2) |
| `measure-parallel-coldstart.md` | **`networkidle` settle race** (500–1200 ms), reconnect-induced | **fix settle** (P1) + opt-in daemon (P2) |
| `vercel-engine.md` | (fixed term) **~150 ms Playwright module import/proc** | dynamic-import (P1) + daemon (P2) |

**`measure-parallel-coldstart.md` wins the tiebreak — it is the only doc that did
per-phase isolation AND a control experiment.** Its per-iteration trace
(`snapshotNodes=4–9 ms · settle+fingerprint=491–499 ms`) plus the decisive control
— **`snapshot` on `about:blank` (zero network) still costs ~1465 ms** — *proves*
the cost is the fixed settle budget, not page-dependent tree work. This **directly
refutes** `measure-latency.md`: the AX walk (`snapshotNodes`) is measured at **~5
ms**, so it cannot be the 1200 ms term. **`measure-latency.md`'s "a11y-tree
computation" attribution is a misread of settle time.**

**Corroborating source-read:** `get url` (224 ms) and `snapshot` (1469 ms) both go
through `withConnection`, but only `snapshot` calls `settleAndFingerprint`
(`handlers.ts:769`); `handleGet`/`handleIs` (`:1012`, `:1080`) do **not**. The
entire 1245 ms delta is that one settle call. Confirmed.

**Warm-`snapshot` decomposition (adopted):**
```
~190 ms  Node process + Playwright module import (every command, incl. `version`)
~  3 ms  connectOverCDP reconnect            (negligible — measured microbench)
~  5 ms  snapshotNodes AX walk               (fast — not a bottleneck)
500–1200 ms  settleAndFingerprint networkidle race   ← THE cost, reconnect-induced
~ small  state encrypt + 2× atomic sidecar writes
```

**Two consequences that set the whole plan:**
- **Do NOT build an a11y-tree cache.** The walk is 5 ms; a cache adds
  invalidation bugs for zero measured benefit. Reject `measure-latency.md` P1.
- **Do NOT build a "persistent CDP connection cache" for its own sake.** Reconnect
  is ~3 ms; caching it saves ~3 ms and adds lifecycle risk. Reject.

---

## 2. Token competitiveness — keep the format, flip three defaults

`measure-tokens.md` is unambiguous: strip `url=` + `level=` and Silver's node
encoding is **0.88–1.01×** Vercel's (i.e. equal or *smaller* on every page). Like-
for-like (both carrying URLs, Silver `-i` vs Vercel `-i -u`) Silver is within ~12%
and sometimes smaller. **The format is not fat; the defaults are.** All three trims
are language-independent serializer choices in `perception/serialize.ts`:

| # | Trim | File / line | Win | Risk |
|---|---|---|---|---|
| T1 | **Inline `url=` → opt-in** (mirror Vercel `-u`); gate the `attrs.push('url=…')` behind a `--urls` flag (or truncate/dedupe hrefs) | `serialize.ts:255`; add flag in `flags.ts`, thread `emitUrls` into `RenderOptions` | **35–54%** on link-dense pages — the single biggest token win | Low — pure default flip; agents that need hrefs pass `--urls`. Keep `RefEntry` unchanged so resolution is unaffected. |
| T2 | **Drop `level=` when it is 0 / in flat interactive mode** | `serialize.ts:248` (`attrs.push('level=…')`) — emit only when `renderIndent>0`, or drop entirely under `filtered` | **~10%** | Very low — indentation already encodes level; the tag is redundant. |
| T3 | **Trim preamble:** drop `# note: interactive elements only` and `generation=N` from per-snapshot text; **KEEP** the `⟦page-content untrusted⟧` wrapper (load-bearing, `security/injection.ts:22`) | `serialize.ts:118` (`generation=`) + `:121` (`# note`) | halves `example.com`; helps every small page | Low — `generation` still travels in the RefMap sidecar; only the *visible* echo is dropped. |

Applying **T1+T2 brings Silver to parity-or-better than Vercel `-i` on every page
tested**, while preserving the *option* to emit URLs. **These are format-layer
changes; they touch no engine code and are orthogonal to §3.**

> Note: `-c`/compact already has negligible effect once `-i` is set
> (`measure-tokens.md`) — interactive filtering removes the empty structural nodes
> compact targets. Do not invest further there.

---

## 3. Latency — three prioritized, file-mapped changes

### P1 — Stop racing `networkidle` on the read-only `snapshot` verb. **FREE, biggest single win, ~1469 ms → ~230 ms.** PRIORITY: HIGHEST.

`snapshot` is pure observation of an already-loaded page; it must not race the
`networkidle` load-state. Today `handleSnapshot` calls the full
`settleAndFingerprint` (`handlers.ts:769`), which runs the ≤1200 ms network-idle
race (`pagechange.ts:37`, `:72–75`) — and because each command is a *fresh*
Playwright client that never observed the load, Playwright **restarts its 500 ms
idle timer every time** (or burns the full 1200 ms budget when the page never
idles). The fingerprint itself (`url|focusedBackendId|domNodeCount`) is ~5 ms — it
is only the *race* that is expensive.

**Change (surgical):**
1. `pagechange.ts` — split settle from fingerprint. Add a `settle: boolean` (or a
   `fingerprintOnly()` export) so callers can compute the fingerprint **without**
   the `waitForLoadState('networkidle')` race (`:72–75`). Keep
   `settleAndFingerprint` for mutating verbs.
2. `handlers.ts:769` — `handleSnapshot` calls the **no-settle** path. It observes
   the page as-is (which is what the host asked for) and still emits the
   `page_changed`/`stale_refs` flag from the cheap fingerprint compare.

**Verb classification (the four other settle callsites are all MUTATING — leave
them settling):** `handleOpen` (`:472`, navigation), `handleHistory` (`:514`,
back/forward), `handleReload` (`:540`), `handleAct` (`:929`, click/fill/press).
`handleGet`/`handleIs`/`handleRead` already never settle. **So P1 is effectively a
one-handler change.** This alone closes ~85% of the warm-command gap with zero
architectural cost or concurrency surface.

**Sub-change P1b (mutating verbs):** the reconnect-induced idle-timer restart also
inflates open/click/reload. Lower `NETWORK_IDLE_BUDGET_MS` from **1200 → 400 ms**
(`pagechange.ts:37`) and gate the full idle wait behind an explicit
`--wait networkidle` flag. A page that genuinely needs full idle opts in; the
common case stops paying a 1.2 s tax on every action. (The daemon in P3 removes
this entirely for its path by retaining load-state.)

### P2 — Kill the client-side Playwright import on the meta/read fast path. **~190 ms → ~50 ms on non-browser + cheaper everywhere.** PRIORITY: HIGH.

`cli.ts:28` statically imports `handle` from `handlers.ts`, which statically
imports `{ chromium }` (`handlers.ts:24`), which pulls `session.ts:18`
(`import { chromium } from 'playwright'`). So **Playwright's ~150 ms module load is
paid on EVERY invocation — even `silver version`, which never touches a browser**
(`vercel-engine.md` §5, grep-confirmed). Vercel's thin client boots in <5 ms.

**Change:**
1. Make `import('playwright')` a **dynamic import** reached only inside
   `session.ts`'s `openSession`/`connect`/`closeSession` (the actual browser
   branch), not at module top (`session.ts:18`, `handlers.ts:24`).
2. Split `handlers.ts` so meta/registry/flag-parse verbs never statically pull
   `session.ts`. Keep the phase-quarantine + registry gate (`cli.ts:27`) on the
   Playwright-free path so an un-permitted verb is rejected before any browser
   module loads.

**Target (measured floor):** meta/forwarded commands ~190 ms → ~45–50 ms; browser
commands shed the import from their critical path too. Pure refactor, no
architecture change, keeps today's behavior. Low risk.

### P3 — Opt-in persistent daemon (`--daemon`). Closes the residual ~190 ms AND retains load-state. PRIORITY: MEDIUM, OPT-IN.

Silver already has **browser-as-daemon at the process layer** — `openSession`
spawns detached Chromium + `child.unref()` (`session.ts:233–237`), browser
survives CLI exit, and its lifecycle is *safer* than Webwright's (encrypted+atomic
sidecars, stale-pid gating, resurrection-safe teardown — `webwright-browserlifecycle.md`
§3 scores Silver the winner point-by-point). **What it lacks is a persistent
*controller process* and a *held CDP connection*.** A `--daemon` mode adds them:

- `silver __daemon --session <name>`: client lazily spawns it detached+unref'd,
  polls `daemon.sock`, writes `.pid`/`.version`/`.config` sidecars. Daemon calls
  `openSession`/`connect` **once**, holds Browser/Context/Page + RefMap + tab
  registry + routes **in memory**, and serves a JSON-line request loop. Client
  becomes a thin Unix-socket forwarder.
- This removes the ~190 ms per-command boot *and* — because the daemon keeps one
  Playwright client alive — **retains load-state, which is what makes even the
  mutating-verb settle cheap** (the same reason Vercel's warm commands are ~5 ms).

**Copy Vercel's hard-won correctness bits verbatim** (`vercel-engine.md` §1):
version-mismatch restart, config-fingerprint restart, spawn-race piggyback (loser
attaches, never clobbers), transient-vs-unreachable error taxonomy (retry vs
respawn — the exact `(os error N)` match that keeps EAGAIN≠ECONNREFUSED), idle
auto-shutdown, graceful close-via-`Notify` so Chrome is never orphaned, **no
settle-sleep on the hot path**.

**Why opt-in, not default:** `measure-parallel-coldstart.md` §6 measured the
default spawn model at **3.5× near-linear parallel speedup with clean isolation**
(each `--session` a separate detached Chromium, own `--user-data-dir`, zero cross-
contamination) and crash-independence. Keep that as default; `--daemon` is for
latency-sensitive interactive/agent loops where the 190 ms compounds
(20-step loop ≈ 3.8 s of pure boot tax).

**Fallback = today's path, unchanged:** if the socket is unreachable, or the
session is `external` (a `connect <endpoint>` browser we don't own,
`session.ts:360`), run `withConnection` (`handlers.ts:193`) as-is. **The daemon is
never a correctness dependency.**

---

## 4. Not reintroducing the concurrency bugs the code-review fought

The daemon must not resurrect the races that `withSessionLock` and the sidecar
crypto were built to prevent. Rules:

- **Serialize per session inside the daemon** with a single-request loop / in-
  process mutex (mirrors Vercel's free `state.lock().await`). This *replaces* the
  advisory file lock for request ordering — keep the file lock **only** to guard
  the daemon **spawn race** (spawn-race piggyback, as Vercel does).
- **Re-assert security INSIDE the daemon**, where the browser is: egress/DNS-rebind
  guard (`egress.ts`), redaction, the destructive-paid confirm gate
  (`handlers.ts:284`). Run the cheap phase-quarantine/registry gate **client-side**
  (no browser) so an un-permitted verb never reaches the socket.
- **Keep sidecars authoritative on close.** Daemon holds RefMap/state in RAM for
  speed but still writes the encrypted+atomic sidecar (`writeSidecar`,
  `session.ts:144`) on idle-shutdown/close, so a cold fallback after the daemon
  exits resumes correctly. No plaintext on the wire or at rest.
- **Keyless throughout:** Unix socket + JSON lines + pid/version/config sidecars.
  No model, no network, no secrets on the wire.

---

## 5. Prioritized change table

| Pri | Change | Files (anchors) | Expected | Risk |
|---|---|---|---|---|
| **P1** | No `networkidle` race on `snapshot` (read verb) | `handlers.ts:769`; `pagechange.ts:57,72–75` (add `settle:false`/`fingerprintOnly`) | warm `snapshot` **1469→~230 ms** | Low (1 handler) |
| **P1b** | Lower idle budget; full wait opt-in | `pagechange.ts:37` (1200→400); `flags.ts` (`--wait networkidle`) | mutating verbs shed up to ~800 ms | Low |
| **P2** | Dynamic-import Playwright off meta/client path | `session.ts:18`; `handlers.ts:24`; `cli.ts:28` | meta/read **190→~50 ms** | Low (refactor) |
| **T1** | `url=` opt-in (`--urls`) | `serialize.ts:255`; `flags.ts`; `RenderOptions` | **−35–54%** tokens | Low |
| **T2** | Drop `level=` when 0/flat | `serialize.ts:248` | **−10%** tokens | Very low |
| **T3** | Trim `# note` + `generation=` (keep `⟦untrusted⟧`) | `serialize.ts:118,121` | −preamble | Low |
| **P3** | Opt-in `--daemon` (Vercel port) + fallback | new `core/daemon.ts`; client in `cli.ts`; reuse `session.ts` lifecycle | warm ~190→~50 ms + settle-free; interactive/agent loops | Medium (contained; fallback preserved) |
| — | **Rejected on evidence:** a11y-tree cache; standalone CDP-connection cache | — | AX walk 5 ms, reconnect 3 ms — no win | — |

---

## 6. Expected outcome & how to verify

- **After P1 alone:** warm `snapshot` ~230 ms (matches the `get` floor), ~85% of
  the warm gap closed, **zero** new architecture. Ship first.
- **After P1+P2:** every command ~50 ms boot + real work; meta verbs ~40× faster.
- **After +T1/T2/T3:** snapshot tokens at parity-or-better than Vercel `-i`.
- **After +P3 (opt-in):** interactive/agent-loop warm latency in Vercel's single-
  digit-ms class, while default spawn keeps the measured 3.5× parallelism +
  isolation. Residual ~45 ms vs Vercel is native-vs-Node **client** boot — inherent
  to the keyless-TS choice and not worth a Rust rewrite (`snapshotNodes` is 5 ms;
  the language is not the bottleneck for the work that defines Silver's value).

**Verify with the existing harnesses** (`scratchpad/bench2.sh`, `timeit.py`,
`reconnect_bench.mjs`, `snap_attrib.mjs`) re-run after each phase; assert exit 0 on
every command (the `measure-latency.md` zsh word-split bug is the reminder that any
"browser command" faster than Silver's ~190 ms boot floor is a *failed* command,
not a fast one). Token deltas re-measured with `wc -c` on identical
session×page×mode as in `measure-tokens.md`.
