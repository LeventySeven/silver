# Lens: action caching + self-heal (stagehand) vs moxxie's actuation layer

Source read: `packages/core/lib/v3/cache/{ActCache,AgentCache,CacheStorage,utils}.ts`
(browserbase/stagehand). Moxxie read: `skill/agent-browser/src/actuation/{resolve,actions,pagechange,wait}.ts`
and `skill/agent-browser/src/perception/refmap.ts`.

## Framing

Stagehand's cache exists to skip an **LLM call**: `act(instruction)` normally
asks a model to pick a selector; `ActCache`/`AgentCache` persist that model
decision to disk (`CacheStorage`, JSON files keyed by
`sha256({instruction, url, variableKeys})` for `ActCache.buildActCacheKey`,
`ActCache.ts:188-199`) and replay it deterministically next time, with
self-heal on drift.

Moxxie has **no LLM inside the actuation layer at all** — the host model
already picked the target via a snapshot ref (`refmap.ts`) or a semantic
locator (`actions.ts:find`/`locate`). So the literal "cache an LLM's action
decision" feature doesn't transplant 1:1. What *does* transplant is the
narrower mechanical pattern underneath it: **cache a resolved selector,
replay it fast, verify it before trusting it, self-heal via bounded
re-search on drift, and don't let a cache miss ever cause a silent
misclick.** Moxxie's `resolve.ts` already implements a same-process version
of this (fast path -> slow path rematch by role/name/nth) but throws it away
every generation and never persists it across CLI invocations.

## Findings

### 1. `resolve.ts::toLocator` fast path never waits for attachment before giving up
- **source_does**: `ActCache.replayCachedActions` calls
  `waitForCachedSelector({page, selector, timeout: domSettleTimeoutMs, ...})`
  (`ActCache.ts:217-223`) — a bounded `page.waitForSelector(selector,
  {state:"attached"})` — *before* dispatching the deterministic action, so a
  page still settling doesn't register as a cache/resolve failure.
- **moxxie_current**: `resolve.ts::stampAndLocate` (lines 98-107) stamps the
  backendNodeId then immediately checks `loc.count() > 0` with zero wait. If
  the node isn't attached yet (e.g. SPA still hydrating right after an
  action), the fast path silently fails and falls to the expensive
  `rematchByShape` snapshot (`resolve.ts:79-95`, bounded to 5000 nodes) even
  though the original node would have attached a moment later.
- **recommendation**: align
- **change**: In `toLocator` (`resolve.ts:117-141`), before falling from fast
  to slow path, add a short bounded `page.locator(refSelector(ref)).first().waitFor({state:'attached', timeout: <small, e.g. 300-500ms>})`
  wrapped in try/catch, after `stampByBackendNode` succeeds but `count()===0`.
  Keep the existing hard fallback to `rematchByShape` if the wait times out.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: `ActCache.ts:217-223`, `utils.ts` `waitForCachedSelector`; moxxie `resolve.ts:98-107,123-129`

### 2. No cross-invocation persistence of resolved selectors — every command re-derives from scratch
- **source_does**: `CacheStorage` (`CacheStorage.ts:14-114`) persists cache
  entries as JSON files under a configurable `cacheDir` (or an in-memory Map
  for tests), keyed by a content hash, surviving across separate
  `act()`/`agent()` calls and even process restarts.
- **moxxie_current**: `RefMap` (`refmap.ts:22-25`) is entirely in-memory,
  scoped to one snapshot `generation`, and is discarded the instant a new
  snapshot is taken (`newGeneration`, `refmap.ts:74-76`). There is no
  `find(role/name)` -> resolved-selector cache anywhere in
  `skill/agent-browser/src` (grep for `*cache*`/`*storage*` in `src/` is
  empty). Every `find` call (`actions.ts:162-192`) re-runs a fresh
  Playwright `getBy*` locator from zero context each time, and every
  ref-based `act` that hits the slow path re-walks up to 5000 DOM nodes
  (`resolve.ts:79-95`) with no memory of the last time this exact
  `(url, role, name, nth)` was resolved.
- **recommendation**: adopt
- **change**: Add `skill/agent-browser/src/actuation/refcache.ts` modeled on
  `CacheStorage.ts`: JSON-file-per-key store under (e.g.)
  `~/.cache/moxxie/refcache/` or a CLI-flag-configurable dir, key =
  `sha256({url: normalizedUrl, role, name, nth})`, value = last-successful
  CSS selector string (the `data-moxxie-ref` bridge is per-process so what's
  worth caching is a stable selector Playwright can re-locate with, e.g. an
  `nth`-qualified role/name query or an xpath, not the ephemeral attribute).
  Wire it into `resolve.ts::rematchByShape` as a **first-try hint** before
  the full 5000-node walk: try the cached selector, verify with
  `count()>0` + role/name still match, use it if valid; otherwise fall
  through to the existing full rematch and overwrite the cache entry (self-heal,
  see finding 3). This is additive — the existing fast/slow path stays as
  the correctness fallback, so it cannot introduce misclicks, only skip work.
- **keyless_ok**: true (pure heuristic acceleration, no model call)
- **priority**: P1
- **evidence**: `CacheStorage.ts:14-114`; moxxie `refmap.ts:22-25`, `resolve.ts:79-95` (no cache file anywhere under `src/`)

### 3. No self-heal write-back — a corrected resolution is thrown away instead of persisted
- **source_does**: `ActCache.replayCachedActions` detects drift via
  `haveActionsChanged(entry.actions, actions)` (`ActCache.ts:264-275,287-325`)
  and calls `refreshCacheEntry` to persist the *corrected* selector back to
  disk, so the next replay starts from the healed entry instead of
  re-healing every time.
- **moxxie_current**: `resolve.ts::toLocator` already does the equivalent
  "detect drift, re-resolve" step in-process (fast path fails -> slow path
  rematch by shape, lines 131-140) but the corrected `backendNodeId`/selector
  is never written anywhere durable — the next CLI invocation (next
  snapshot generation) starts from zero again, so the same class of drift
  gets re-paid in full every time.
- **recommendation**: adopt
- **change**: Once finding 2's `refcache.ts` exists, call its write path
  whenever `rematchByShape` succeeds (`resolve.ts:132`) — persist the newly
  matched selector under the same `(url, role, name, nth)` key, overwriting
  any stale cached hint. This is the same "cache the decision, replay,
  repair on drift" loop as stagehand's, just scoped to selector resolution
  instead of LLM action-planning.
- **keyless_ok**: true
- **priority**: P1
- **evidence**: `ActCache.ts:264-275,327-360`; moxxie `resolve.ts:131-140`

### 4. Cache entries have no schema version — a format change would silently misbehave
- **source_does**: Every cached entry carries `version: 1`
  (`ActCache.ts:151-159`, `AgentCache.ts:361-370`) and both `tryReplay` paths
  hard-check `entry.version !== 1` and treat mismatches as a cache miss
  (`ActCache.ts:96`, `AgentCache.ts:207-209`), so old-format files on disk
  never get mis-parsed as new-format ones.
- **moxxie_current**: absent — no cache exists yet to version, but this is a
  concrete lesson to build in from day one rather than retrofit.
- **recommendation**: adopt
- **change**: When building `refcache.ts` (finding 2), give the on-disk
  entry shape a `{version: 1, ...}` envelope and treat any
  missing/mismatched version as a hard miss (fall through to full rematch),
  never a hard error.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: `ActCache.ts:96,151-159`; `AgentCache.ts:207-209,361-370`

### 5. URL normalization before hashing into a cache key
- **source_does**: `normalizeUrlForCacheKey` (`utils.ts`) parses the URL and
  sorts query params so `?a=1&b=2` and `?b=2&a=1` hash to the same cache
  key (`ActCache.ts:59` uses it when building `buildActCacheKey`).
- **moxxie_current**: `pagechange.ts::fingerprintAfterSettle` uses the raw
  `page.url()` string directly in its fingerprint (`pagechange.ts` line
  ~84) — fine for its purpose (detecting *any* change), but if finding 2's
  refcache keys off URL, an un-normalized URL would fragment the cache
  needlessly (same page, different query-param order treated as different
  keys).
- **recommendation**: align
- **change**: When implementing `refcache.ts`'s key builder, add a small
  `normalizeUrlForCacheKey`-equivalent (parse + sort search params, catch
  and fall back to raw string on parse failure) rather than hashing
  `page.url()` verbatim.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: stagehand `utils.ts` `normalizeUrlForCacheKey`; moxxie `pagechange.ts` fingerprint construction

### 6. Cache must be opt-in / cheaply disableable, not silently always-on
- **source_does**: `CacheStorage.enabled` (`CacheStorage.ts:56-58`) is
  `false` unless a `cacheDir` or memory store was explicitly constructed;
  every `ActCache`/`AgentCache` method short-circuits on `!this.enabled`
  before touching disk.
- **moxxie_current**: n/a (no cache yet) but directly relevant to rollout:
  moxxie is passing an eval gate today with zero caching behavior, so any
  new refcache must be strictly additive and defaultable to off (or to a
  scratch dir that's a pure no-op if absent) so it can't change pass/fail
  behavior of the existing gate, only latency.
- **recommendation**: adopt
- **change**: Gate `refcache.ts` behind an explicit flag/env var (e.g.
  `MOXXIE_REFCACHE_DIR`); when unset, `enabled` is `false` and every
  refcache call is a no-op, identical to today's behavior.
- **keyless_ok**: true
- **priority**: P1 (rollout safety, blocks 2/3/4/5 landing safely)
- **evidence**: `CacheStorage.ts:21-58`; moxxie has no existing cache/config surface to reuse (`grep -r cache src/` empty)

### 7. AgentCache's full-step recording/replay (goto/scroll/wait/keys/fillForm sequences) — SKIP as cargo-cult
- **source_does**: `AgentCache` (`AgentCache.ts:42-912`) records an entire
  multi-step agent loop (its *own* internal LLM-driven agent —
  `beginRecording`/`recordStep`/`endRecording`, replay dispatch over
  `goto|scroll|wait|navback|keys|act|fillForm` step types) and persists it
  keyed by `(instruction, startUrl, options, configSignature)` including a
  serialized LLM model name (`buildConfigSignature`, `serializeAgentModelForCache`,
  lines 115-148, 508-524) and API-key sanitization
  (`SENSITIVE_CONFIG_KEYS`, line 40).
- **moxxie_current**: absent, and structurally inapplicable — moxxie has no
  internal multi-step agent loop to record. The host LLM does that looping;
  moxxie only executes atomic, host-issued verbs (`actions.ts::act`/`find`)
  and returns a page-change flag (`pagechange.ts`) so the host decides the
  next step itself.
- **recommendation**: skip-cargo-cult
- **change**: none — do not build a moxxie-side "record a macro of
  host-issued commands and replay it," at least not as a caching feature.
  If the host wants replay-a-script behavior, that's a host-side
  responsibility (host can already re-issue the same `find(role,text)`
  calls deterministically since moxxie is stateless per command). Building
  AgentCache's step-recording machinery into moxxie would duplicate logic
  the host already owns and would require moxxie to track "am I inside a
  recording" state that has no keyless purpose.
- **keyless_ok**: true (it *could* be built keylessly) but not worth building — no gap it closes for moxxie's actual usage shape.
- **priority**: P2 (explicitly reject, so it doesn't get re-proposed later)
- **evidence**: `AgentCache.ts:42-912`; moxxie `actions.ts` has no loop/step-sequence concept, `pagechange.ts` is the only "what happened" signal and is intentionally a flag, not a recording

### 8. Server-side cache tier and LLM-model-keyed config signature — SKIP, not keyless-compatible
- **source_does**: `serverAgentCache.ts` (present in the cache dir) and the
  `isAutoModel`/`shouldAttemptCache` gate in `AgentCache.ts:85-93` explicitly
  route "auto" (server-managed) sessions to a **remote, API-backed cache**
  instead of local self-heal, because local replay needs "a local LLM
  client for replay self-heal."
- **moxxie_current**: n/a — moxxie never calls a model, so there is no
  "local LLM client for replay self-heal" to gate on, and no server-side
  cache tier makes sense for a keyless CLI.
- **recommendation**: skip-cargo-cult
- **change**: none. Do not add any network-backed cache tier or any
  model-name-keyed cache-signature field (`buildConfigSignature`'s
  `v3Model`/`systemPrompt`/model options) — moxxie's cache key space
  (finding 2) should stay purely `(url, role, name, nth)`, with zero model
  or provider awareness, since that awareness doesn't exist in moxxie by
  design.
- **keyless_ok**: false (as literally implemented; the underlying idea is model-dependent)
- **priority**: P2 (guardrail note)
- **evidence**: `AgentCache.ts:85-93,115-148`; `cache/serverAgentCache.ts` present in source tree; moxxie has zero model/provider references in `src/actuation`

### 9. Bulk-field pruning before persisting (screenshots stripped from cached results)
- **source_does**: `pruneAgentResult` (`AgentCache.ts:454-467`) strips
  `action.base64` screenshot blobs from cached `AgentResult.actions` before
  writing to disk, keeping cache files small.
- **moxxie_current**: n/a today, but directly relevant once finding 2 lands:
  moxxie's envelopes (`core/envelope.ts`, referenced from `actions.ts:25`)
  are small (verb/ref/value), so this isn't an urgent problem, but if a
  future refcache entry ever grows to include serialized DOM snapshots or
  screenshots it should follow the same discipline.
- **recommendation**: align (preventively, low cost)
- **change**: When designing `refcache.ts`'s entry shape, keep it to
  primitives only (`selector: string`, `role/name/nth`, `lastSeenAt`) —
  explicitly do not let anyone later bolt a screenshot or full DOM snapshot
  onto a cache entry without a pruning step.
- **keyless_ok**: true
- **priority**: P2
- **evidence**: `AgentCache.ts:454-467`; moxxie has no cache entry shape yet — this is a design constraint to bake in

## Top recommendation

Build a small, opt-in, on-disk **ref-resolution cache** (`refcache.ts`) that
sits in front of `resolve.ts::rematchByShape` — key
`sha256({normalizedUrl, role, name, nth})` -> last-known-good selector,
version-tagged, gated behind an env var / flag so it's a strict no-op when
unset. Try the cached selector as a cheap first attempt (with a short
bounded attach-wait, per finding 1) before paying for the full 5000-node
`snapshotNodes` walk; on a miss or mismatch, fall through to the existing
correctness-preserving slow path unchanged, and write the healed result
back (self-heal write-back, finding 3). This is the one piece of
stagehand's "cache the decision, replay, repair on drift" pattern that
transplants cleanly into moxxie's keyless, host-brain architecture — it
accelerates the *mechanical* resolution step moxxie already owns, without
ever touching the *decision* step (which is, correctly, the host's job and
therefore never moxxie's to cache).
