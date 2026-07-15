# Browserbase — Recording/Observability lens → moxxie gap-alignment

**Source:** `/Users/seventyleven/Desktop/researchfms/browserbase/BROWSERBASE_R2_07_RECORDING_PIPELINE.md`,
`/Users/seventyleven/Desktop/researchfms/browserbase/BROWSERBASE_INFRASTRUCTURE.md` (§HAR/tracing, §Session Logs/Debug API),
`/Users/seventyleven/Desktop/researchfms/browserbase/BROWSERBASE.md` §34.10 (FlowLogger).

**Moxxie anchor:** `/Users/seventyleven/Desktop/moxxie/skill/agent-browser/src/core/handlers.ts` (all handlers),
`core/session.ts` (sidecar files: `session.json`, `refmap.json`, `moxxie-state.json`), `security/redact.ts`.

**Lens:** Is a keyless local session log/replay worth it for moxxie debugging? Aligns with webwright's "logs are the artifact" thesis.

## Headline finding

Moxxie today has **zero action-logging**. Every `handle*` function in `handlers.ts` runs the Playwright call and returns an `Envelope` — nothing is ever written to disk describing *what ran, with what args, how long it took, or whether it succeeded*, beyond the return value the host happens to capture. `grep -rn "jsonl\|logger\|trace" src/` returns nothing action-related. Meanwhile `session.ts` already maintains three JSON sidecars per session (`session.json`, `refmap.json`, `moxxie-state.json`) — the file-per-session pattern exists, logging just isn't one of the files.

Browserbase, at every layer (cloud API *and* the open-source Stagehand client, which is the part that's actually keyless-portable), treats the log as a first-class artifact:
- Cloud: `GET /v1/sessions/{id}/logs` returns structured CDP events as JSON (`BROWSERBASE_INFRASTRUCTURE.md:1561`), stored at `s3://.../logs/{sessionId}/cdp.log` (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:342,358`).
- Client (keyless-relevant): Stagehand's **FlowLogger** (`BROWSERBASE.md:9500-9573`) is a local, structured, JSONL event tracer built on `AsyncLocalStorage` — no model call, no cloud dependency. It decorates `act`/`extract`/`observe` to emit start/complete/error events, filters known-noisy CDP event types, and writes to `session_events.jsonl` (`JsonlFileEventSink`, gated by an env var, not by having a Browserbase account).

That FlowLogger is the directly transplantable piece: it's pure local instrumentation, which is exactly what moxxie's "logs are the artifact" thesis wants, and Browserbase already proved out the schema.

## Findings

### 1. Add a per-session append-only action log (JSONL) — the core gap
- **source_does:** Stagehand's FlowLogger writes one JSON line per lifecycle event (`eventType`, `eventId`, `eventParentIds`, `eventCreatedAt`, `sessionId`, `data`) to `session_events.jsonl`, entirely local, zero network dependency (`BROWSERBASE.md:9500-9526,9561-9563`).
- **moxxie_current:** absent. `handle()` in `handlers.ts:157` dispatches to per-verb handlers that never persist a record of the call; only the returned `Envelope` exists, and only for as long as whatever invoked the CLI keeps it.
- **recommendation:** adopt
- **change:** In `handlers.ts`, wrap the `handle()` dispatcher (not each handler individually) to append one JSON line per invocation to `~/.moxxie/sessions/<name>/actions.jsonl`: `{ts, verb, args (redacted), session, success, error_code?, duration_ms, page_changed?, generation?}`. Reuse the existing `sessionDir()` helper from `session.ts` so the file lives next to `session.json`/`refmap.json`. This is the single highest-value change for debugging — when a host's multi-step run fails silently, the operator currently has nothing to replay; a flat JSONL trail is enough to reconstruct the whole session.
- **keyless_ok:** true
- **priority:** P0
- **evidence:** BROWSERBASE.md:9500-9526 (FlowLogger event model) + BROWSERBASE.md:9561-9563 (JsonlFileEventSink) vs handlers.ts:157-228 (dispatcher, no logging).

### 2. Redact secrets in the log the same way snapshots already are
- **source_does:** FlowLogger redacts any key matching `/key|secret|token|api-key|apikey|api_key|password|passwd|pwd|credential|auth/i` before writing `session.json`/logged fields (`BROWSERBASE.md:9567`), and separately never logs *substituted variable values* — only names (`BROWSERBASE.md:9490-9496`).
- **moxxie_current:** `security/redact.ts` already redacts password-shaped values, but only at the *serializer* choke point for `snapshot`/`get text` output — it is never applied to command args, so a logged action log (once built) would leak `fill @e3 hunter2` verbatim if item 1 above is added naively.
- **recommendation:** align
- **change:** In whatever writer implements finding #1, route the logged `value`/`args` field for `fill`/`type`/`cookies set`/`state load` through a small key-name-based redaction pass (mirror the `/key|secret|token|password|credential|auth/i` regex) before serializing, independent of `redactValue`'s DOM-hint logic in `security/redact.ts` (which only sees rendered nodes, not CLI args).
- **keyless_ok:** true
- **priority:** P0
- **evidence:** BROWSERBASE.md:9567 vs security/redact.ts:1-44 (redaction exists but is snapshot-output-scoped only).

### 3. Turn on Playwright's own tracing/HAR for post-hoc replay — cheapest possible win
- **source_does:** Browserbase's own docs recommend Playwright's built-in `context.tracing.start()`/`.stop({path:'trace.zip'})` and `page.routeFromHAR('trace.har')` for "detailed network activity for offline analysis" (`BROWSERBASE_INFRASTRUCTURE.md:1582-1592`) — i.e. even Browserbase, who built a whole video pipeline, still ships the zero-infra Playwright trace as the debugging primitive they document for developers.
- **moxxie_current:** absent — `openSession`/`connect` in `session.ts` never calls `context.tracing.start()` or configures `recordHar`, and no CLI flag exposes it.
- **recommendation:** adopt
- **change:** Add an opt-in `--trace <path.zip>` flag (parsed in `flags.ts`) that, when set on `open`, calls `context.tracing.start({screenshots:true, snapshots:true})` in `session.ts`'s `openSession`, and `context.tracing.stop({path})` on `close` (`handleClose` in `handlers.ts:267`). This is a Playwright built-in — no new dependency, no infra, and it gives a full DOM+network+screenshot trace viewable in `npx playwright show-trace`, which is strictly more useful than Browserbase's own rrweb path ever was (see finding #5).
- **keyless_ok:** true
- **priority:** P1
- **evidence:** BROWSERBASE_INFRASTRUCTURE.md:1582-1592 vs session.ts:80-120 (openSession, no tracing).

### 4. Cap/rotate the log so it can't grow unbounded — borrow the retention discipline, not the infra
- **source_does:** Browserbase enforces S3 lifecycle rules keyed to plan tier — 7d free/hobby, 30d Pro/Team (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:490-509`) — because unbounded per-session artifacts are an operational hazard even for them.
- **moxxie_current:** N/A today (no log exists); once finding #1 ships, `~/.moxxie/sessions/<name>/actions.jsonl` would grow forever across long-lived daemon sessions with no cap.
- **recommendation:** align
- **change:** Don't replicate S3 lifecycle policies (cargo-cult for a local CLI) — instead cap the JSONL file by simple line-count/byte-size in the same writer from #1 (e.g. keep the trailing 2000 lines, truncate on `open`/rotate on `close --all`), and delete `actions.jsonl` in `closeSession()` (`session.ts`) unless a `--keep-log` flag is passed. This is the keyless-appropriate equivalent of BB's retention discipline: bound growth locally instead of shipping to a bucket.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** BROWSERBASE_R2_07_RECORDING_PIPELINE.md:490-509 vs session.ts (no cleanup of any future log file).

### 5. Do NOT build DOM-diff/rrweb-style replay — Browserbase itself deprecated it
- **source_does:** Browserbase's own docs: *"rrweb is being deprecated. The rrweb-based DOM replay API and related tooling are being deprecated."* (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:183-193`). They moved to pixel/video capture specifically because DOM-event replay (rrweb) wasn't worth maintaining even with their full engineering team.
- **moxxie_current:** absent (correctly).
- **recommendation:** skip-cargo-cult
- **change:** none — explicitly do not build a `perception/`-level DOM mutation recorder or rrweb-style event stream. The evidence that the market leader walked this back is itself the argument for moxxie staying on Playwright's native trace (finding #3) instead.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** BROWSERBASE_R2_07_RECORDING_PIPELINE.md:183-193.

### 6. Do NOT build video/HLS recording — wrong shape for a single-machine CLI
- **source_does:** BB's new recording pipeline is PNG-frame capture → S3 → parallel `ffmpeg` encode workers → byte-patched fMP4 → CloudFront-signed HLS multi-variant playlists, with per-tab variants and just-in-time encoding economics (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:195-283, 513-646`).
- **moxxie_current:** `handleScreenshot` (`handlers.ts:372-381`) already covers the single-frame case moxxie actually needs.
- **recommendation:** skip-cargo-cult
- **change:** none. This entire pipeline exists to solve "how do I stream a remote hosted browser to a dashboard user" — a problem moxxie doesn't have (the browser runs on the same machine as the agent). Building any part of it (segment encoding, HLS, CDN signing) would be pure bloat for a keyless CLI whose debugging need is "what ran and did it work," answered by findings #1/#3.
- **keyless_ok:** false as literally described (requires S3/CloudFront/ffmpeg-worker infra); the keyless-compatible substitute is already finding #3 (Playwright trace) + existing screenshot.
- **priority:** P2
- **evidence:** BROWSERBASE_R2_07_RECORDING_PIPELINE.md:195-283 vs handlers.ts:372-381 (screenshot already exists and suffices).

### 7. `debuggerUrl`/live-view (Chrome DevTools embed) — mostly cargo-cult, but the local CDP endpoint is free and worth surfacing
- **source_does:** `GET /v1/sessions/{id}/debug` returns `debuggerUrl`, `debuggerFullscreenUrl`, `wsUrl`, and per-tab equivalents — a hosted, BB-forked Chrome DevTools Frontend wired to the session's CDP socket for human "watch/take over" (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:300-324,384-486`; `BROWSERBASE_INFRASTRUCTURE.md:1565-1580`).
- **moxxie_current:** `session.ts`'s `openSession` already launches Chromium with `--remote-debugging-port=<port>` (per `session.ts:96` region) and persists `port`/`wsEndpoint` in `session.json`, but nothing in `handlers.ts` surfaces this to the operator as a debug URL — `handleSession`'s `sub === 'list'` (`handlers.ts:788-802`) only returns `name`/`pid`/`createdAt`.
- **recommendation:** align
- **change:** In `handleSession`'s `sub === 'list'`/add a `sub === 'debug'` case, read the persisted port from the sidecar and emit `http://127.0.0.1:<port>/json` (Chromium's own built-in DevTools inspector list, which needs zero BB-style forked frontend — Chromium ships this for free) so a human operator debugging alongside the agent can open real DevTools against the exact running session. Full BB-style hosted iframe embedding (signingKey scopes, postMessage disconnect protocol, `&navbar=false` wrapper) is cargo-cult for a local tool — skip that part.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** BROWSERBASE_R2_07_RECORDING_PIPELINE.md:300-324 vs handlers.ts:779-802 (handleSession has no debug/inspect surfacing) + session.ts (port already known, just unexposed).

### 8. Adaptive/change-triggered capture cadence — apply the *principle* to the action log, not to frames
- **source_does:** BB's capture sidecar explicitly avoids constant-rate recording: "If nothing changes for ten seconds, we capture nothing. If the page is animating, we capture more." (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md:199-209`).
- **moxxie_current:** N/A (no capture loop exists — moxxie is command-driven, not a background recorder).
- **recommendation:** align
- **change:** This doesn't map to a frame-rate problem for moxxie (there's no idle polling loop to throttle), but the *principle* — log signal, not noise — maps directly onto finding #1's writer: don't log raw CDP protocol chatter (moxxie already opens ad-hoc `CDPSession`s per action in `handleAct`/`withLocator`), only log the one structured line per CLI verb invocation. This is effectively free since moxxie's architecture is already one-shot-per-command rather than continuously polling.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** BROWSERBASE_R2_07_RECORDING_PIPELINE.md:199-209 vs handlers.ts:412-440 (handleAct opens/detaches a CDPSession per call — no persistent noisy stream to begin with, so this is already the right shape; just don't undo it when adding logging).

### 9. `PrettyStderrEventSink` toggle — cheap human-readable variant, low priority
- **source_does:** FlowLogger supports a second sink, `PrettyStderrEventSink`, gated by `BROWSERBASE_FLOW_LOGS=1`, that pretty-prints the same events to stderr with truncation (`BROWSERBASE.md:9564-9573`).
- **moxxie_current:** absent; moxxie's stdout contract is the JSON `Envelope` only (per `envelope.ts`/`ok`/`fail` used throughout handlers.ts) — stderr is unused for structured output.
- **recommendation:** align
- **change:** Once #1 exists, add an opt-in `MOXXIE_TRACE=1` (or `--trace-stderr`) that echoes each appended JSONL line to stderr in one-line form (`verb args -> ok/fail (Nms)`), for a human tailing a long agent run without needing to `tail -f actions.jsonl` in a second terminal. Purely additive, no schema change.
- **keyless_ok:** true
- **priority:** P2
- **evidence:** BROWSERBASE.md:9564-9573 vs handlers.ts (stdout-Envelope-only today).

## Top recommendation

**Finding #1 (append-only per-session `actions.jsonl`)** is the single highest-value keyless change: it costs one `fs.appendFile` in the `handle()` dispatcher, reuses `session.ts`'s existing `sessionDir()` sidecar pattern, and directly answers the "logs are the artifact" thesis — currently a failed multi-step moxxie run leaves *zero* forensic trail. Pair it immediately with #2 (redaction) so it doesn't reopen the secret-leak surface `security/redact.ts` was built to close.
