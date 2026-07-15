# Aside — ENGINE deep-dive: the harness levers, and Silver's real efficiency gap

Scope: the *engine/harness* lens on why Aside is SOTA — the single `repl`
code-execution tool, the lean persistent loop, the fixed viewport, and
concurrency — cross-read against Silver's connection model and measured
empirically. Sources: `researchfms/teardowns/_aside_parts/{95_why_sota,20_runtime_loop,96_tool_registry_full}.md`
and the Silver source at `/Users/seventyleven/Desktop/Silver/silver/src`.
Numbers labelled **MEASURED** are from a live run of `node dist/cli.js` on this
machine (2026-07-16, Node v25.9.0, stock Playwright Chromium, example.com).

---

## 1. What Aside does + HOW (the engine mechanism)

**The one-sentence thesis (`95_why_sota.md:5-7`): Aside is SOTA because of its
harness, not its model.** The benchmark repo runs the *same* shipped agent on a
frontier model (gpt-5.5, 93%) and a cheap open model (kimi-k2.6, 88%) on
BU-Bench, everything else identical (`95_why_sota.md:13-20`). The 5-point gap is
concentrated entirely in the *reasoning* categories (GAIA, BrowseComp); on the
three pure *browser-navigation* categories both models score ~59/60. Conclusion:
**the harness solves browser manipulation to near-saturation regardless of
model.** That harness has four engine levers.

### Lever A — `repl`: one code-execution tool replaces the whole action surface
The entire browser-automation surface is a single tool, `repl(title, code)`
(`96_tool_registry_full.md:27`, `20_runtime_loop.md:15-24`). There is no
`click`/`type`/`fill`/`scroll`/`navigate` tool. The daemon exposes a **persistent
sandboxed JS VM** with Playwright's `page` object injected as a global plus
helpers (`snapshot`, `openTab`, `tabs`, `attachActiveBrowserTab`,
`annotatedScreenshot`, `fs`, `sleep`, `fetch`) — verbatim surface at
`aside-02:181-209`. The model writes literal JS: `await page.locator('e3').fill(x);
await page.locator('e5').click(); const s = await snapshot(page); console.log(s.diff)`.
Two engine consequences:
- **Multi-action-per-turn.** One model round-trip batches fill → click → press
  Enter → re-snapshot + a conditional. Mean **12.9 repl calls/task**
  (`95_why_sota.md:27`) instead of ~40 atomic tool calls. Fewer turns = less
  compounding error, smaller transcript, lower cost.
- **Persistent scope.** `const`/`let` declared in call N are live in call N+1
  (`aside-02:22`) — the model accumulates state (locators, parsed data) across
  calls without re-serializing it into context. This is "the agent *programs* the
  browser," not "drives a remote control" (`aside-02:23`).

Why it beats competitors: the field's SOTA cluster (Aside + the 97% Browser-Use
run) independently converged on **CodeAct over a familiar API**; the pixel agents
(Operator, Claude CU) are a tier below on structured web tasks
(`95_why_sota.md:48-59`). Aside's stated reason for Playwright-dialect JS
specifically: *"LLMs are not trained to use CDP"* — Playwright is the
browser-automation dialect most present in pretraining, so the model emits fewer
malformed actions (`95_why_sota.md:26-27`).

### Lever B — the lean persistent loop (one process, one CDP socket)
The loop (model call + tool dispatch + context assembly + compaction) runs inside
a **single local native daemon** ("AsideDaemon", `127.0.0.1:21420`) that owns one
persistent CDP socket to the Chromium fork (`:45103`) for the whole session
(`20_runtime_loop.md:28-31`, `96_tool_registry_full.md:422`). The extension is a
thin client. The ~10K-token system prompt (half of Claude Code's,
`95_why_sota.md:42-43`) encodes a reading-escalation ladder, a recovery ladder
(dismiss popups → re-snapshot → switch strategy after 2-3 fails), actionability
retries (`waitForReady`/`checkHitTarget`/`scrollIntoViewIfNeeded`/`RefStaleError`),
and a hard completion-verification rule. The engine point: **the process, the JS
VM, and the CDP connection are all warm for the entire task** — the per-action
cost is a function call, not a process spawn or a socket handshake.

### Lever C — fixed 1440×900 viewport
A hardwired render surface (`AsideAiTabsViewport`), not a per-call
`setDeviceMetricsOverride` (`95_why_sota.md:38`). Every agent tab renders at one
canonical resolution regardless of the user's window, so vision-assisted steps
keep an in-distribution pixel→coordinate mapping. The transferable lever is
**determinism** (fixed viewport ⇒ reproducible perception); the specific 1440×900
is calibrated to Aside's bundled CUA/vision model.

### Lever D — concurrency via non-focus-stealing background tabs
Agent tabs are created `Target.createTarget{background:true, focus:false}`; the
`controlTab` verb exposes only `open`/`close` — **there is no `activate` verb, so
the agent literally cannot raise a tab** (`95_why_sota.md:39`). Backgrounded tabs
are kept full-speed and made to report `document.hasFocus()===true` via
`Page.setWebLifecycleState{active}` + focus emulation. This is what makes
**concurrency 3-6** safe — the benchmark run drove many tabs at once without
disrupting a foreground user. These are *Chromium-fork patches* (`Part 92`).

---

## 2. The efficiency gap vs Silver — MEASURED, and honestly

The brief frames the gap as "Rust + persistent daemon (Vercel) vs Silver TS +
per-command CDP reconnect." I measured the actual decomposition. **The language
is nearly irrelevant; the connection model is only part of it; process+import
startup is the dominant per-command tax.**

Silver's model (`core/session.ts:1-13`): a **browser-as-daemon** — a *detached*
Chromium survives the CLI process (`openSession`, `child.unref()`,
`session.ts:204-270`); every command re-`connectOverCDP`s to it
(`connect`, `session.ts:328-348`) and drops the transport in a `finally`
(`withConnection`, `handlers.ts:193-217`). So the *browser* is persistent; the
*Node process* and the *CDP connection* are per-command.

MEASURED per-command decomposition:
| Step | Cost | Note |
|---|---|---|
| bare `node -e 1` | ~57 ms | pure runtime start |
| `silver version` (full import graph incl. Playwright) | ~235 ms | Playwright `require` alone ~200 ms |
| solo `get url` (spawn + reconnect + read + disconnect) | ~235 ms/cmd | trivial verb |
| **batch** `get url` ×6 (1 process, 6 reconnects) | **~50 ms/cmd** | 4.7× faster |
| solo `snapshot` (example.com) | ~1490 ms | perception-dominated |
| batch `snapshot` ×N | ~833 ms/cmd | ~780 ms is the a11y walk itself |
| cold `open example.com` (spawn detached Chromium + nav) | ~2378 ms | one-time |

What this proves:
1. **The CDP reconnect on loopback is cheap.** A batched trivial verb is ~50 ms
   *including* connect + read + disconnect; the pure `connectOverCDP` handshake is
   a fraction of that. The per-command reconnect is **not** the big cost.
2. **The dominant per-command tax is Node spawn + Playwright import ≈ 185 ms**
   (235 solo − 50 batched). This is exactly what a persistent daemon (Aside,
   Vercel) pays *once*. Over Aside's mean 12.9-call task, that's ~2.4 s of pure
   startup tax Silver pays that a warm daemon does not.
3. **Language (Rust vs TS) barely matters here.** Rust would shave the ~57 ms
   runtime start and maybe part of the ~185 ms import, but a *persistent TS
   daemon* recovers essentially all of it — and Silver already has a partial one:
   `batch` (`handlers.ts:2294-2326`) amortizes the 185 ms across sub-commands.
4. **Snapshot work (~780 ms even batched) dwarfs the engine tax** and is
   format/implementation-dependent (the `walk.ts` a11y walk + `diff.ts` +
   `serialize.ts`), not a connection-model artifact.

Where `batch` falls short of `repl` (the real residual gap): `batch` re-dispatches
each sub-command through `run()` (`handlers.ts:2312-2314`), so it **still
reconnects CDP per sub-command, still re-parses argv, and carries NO shared JS
scope** — it is a flat list of *pre-composed* verb strings with no control flow
and no read-a-value-then-branch inside one process. Aside's `repl` is a persistent
VM: read → branch → act, all in one round-trip, state retained.

Silver's other engine facts vs the levers:
- **Lever A:** Silver ships ~40 discrete verbs dispatched one-per-invocation
  (`security/registry.ts:24-112`, `READ_ONLY_VERBS`/`ACTOR_VERBS`). Its `eval`
  verb (`handlers.ts:2253-2274`) runs a *single* `frame.evaluate(script)` — one
  expression, **no persistent scope across calls**, no `snapshot()`/`openTab()`
  globals, and it is an ACTOR verb behind `--enable-actions` + a per-call confirm
  gate (`confirm.ts:25-44`, `eval` is in `MUTATING_VERBS`). So Silver has the raw
  material (a code-exec verb) but not the persistent-scope, helper-global,
  low-friction `repl` design.
- **Lever B:** Silver has no in-process loop by design — it is keyless, the host
  LLM is the brain. The loop *discipline* (reading/recovery/verification ladders)
  is therefore a HOST responsibility, not something the CLI bakes in. Actionability
  is fully delegated to Playwright's auto-wait + occlusion hit-testing
  (`actuation/actions.ts:5-8, 268-308`; `element_obscured` is surfaced at
  `actions.ts:351`) — so Aside's `checkHitTarget` concern is *already covered* by
  Playwright, not a gap.
- **Lever C:** Silver already uses a **fixed 1280×900** viewport as a launch arg
  and per-connect `setViewportSize` (`session.ts:59-63, 221-222, 345-346`;
  `handlers.ts:609`). Parity on the *principle* (determinism); the number differs
  (1280 vs 1440) and matters only to whatever vision model the host runs.
- **Lever D:** Silver's concurrency is a *different shape* — per-session detached
  browsers (own-context-per-agent) + a per-session advisory lock
  (`core/lock.ts` `withSessionLock`, `handlers.ts:197`) + subagent
  `CONCURRENCY_CAP = 5`, one-level-deep (`orchestration/subagent.ts:17, 55,
  186-189`). It cannot patch Chromium, so it has no background-tab/focus-emulation
  trick; parallel agents get *separate browsers*, serialized per session.

---

## 3. Concrete gaps + keyless adopt recommendations (prioritized)

**P1 — Add a persistent "attach/serve" mode that keeps ONE Node process + ONE CDP
connection + ONE JS scope warm across many verbs.** This is the single biggest
keyless latency win and it does NOT require Rust. Two layers, both keyless:
- *(engine)* A `silver serve`/attach daemon the host talks to over a local socket
  (or a long-lived stdin REPL): holds `connect()` open, reuses the page handle,
  and dispatches the *existing* verbs against it. Kills the ~185 ms/cmd
  import+spawn tax **and** the ~50 ms/cmd reconnect → per-verb cost drops toward
  a few ms. Over a 13-action task this is the difference between ~3 s and ~0.3 s
  of pure overhead. Silver's `batch` already proves ~4.7× of this is reachable;
  a warm connection captures the rest.
- *(expressiveness)* Promote `eval` into a real `repl`: a **persistent JS scope**
  (`const`/`let` survive across calls) with `snapshot()`, `openTab()`, `tabs[]`,
  and the webfetch-equivalent exposed as globals, so the host writes
  `fill; click; press Enter; const s = await snapshot(); return s.diff` in ONE
  call with control flow. Keep it keyless (host authors the JS, Silver never calls
  a model). This collapses N round-trips into 1 — the round-trip win is
  independent of the connection fix and independent of language.

**P2 — Do NOT chase Rust for the engine gap.** The measurement shows Rust buys at
most the ~57 ms runtime start + part of the import; the persistent-daemon lever
(P1) recovers the whole ~185 ms in TS. Spend the effort on the warm-connection
daemon, not a rewrite.

**P3 — Optional: focus-emulation for headed multi-tab concurrency.** If Silver
ever runs multiple agent tabs in ONE headed browser (`connect` + `tab new`),
adopt Aside's Lever D via CDP `Emulation.setFocusEmulationEnabled` +
`Page.setWebLifecycleState{active}` so backgrounded tabs stay full-speed and pass
`document.hasFocus()` checks without stealing the user's foreground. Headless
sessions already don't steal focus, so this is only for the shared-headed-browser
path. Low priority.

**P4 — Nice-to-have: align the viewport default to 1440×900** *iff* the host's
vision model is CUA-family; otherwise the current deterministic 1280×900 is fine.
This is a one-constant change (`session.ts:63`), not an architecture gap.

**Bottom line:** Silver already matches Aside on the perception representation,
the fixed-viewport determinism, and the subagent-concurrency invariants, and
Playwright already gives it Aside's actionability gates for free. The genuine
engine gaps are exactly two, both closable in TS without a model: **(1) a warm
persistent connection** (kills the measured ~185 ms + ~50 ms/cmd tax) and **(2) a
persistent-scope `repl` code-exec surface** (kills the N-round-trips-per-task
tax). `batch` is the down-payment on both; finishing the job is P1.
