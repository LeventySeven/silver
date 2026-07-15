# Top 5: What AgentQL Does Better — and Where Silver Stands

Sources read: `/Users/seventyleven/Desktop/researchfms/agentql/AGENTQL.md` (609KB primary
teardown, sections 3–4, 12), `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md` (browser-fleet
architecture), and the pre-digested `/Users/seventyleven/Desktop/Silver/research/sources/agentql.md`.
Cross-checked against Silver source: `silver/src/actuation/resolve.ts`,
`silver/src/actuation/actions.ts`, `silver/src/extract/resolve.ts`, `silver/src/extract/transform.ts`,
`silver/src/core/errors.ts`, `silver/src/core/envelope.ts`, `silver/src/core/session.ts`.

Scope note per task brief: **do not** recommend a full custom query grammar/DSL as a primary
interface — AgentQL's own teardown flags that as its own biggest adoption risk (section 5.5,
digest anti-pattern #1). Every item below is evaluated as a mechanism to steal, not syntax.

---

## 1. Resilient locator resolution via a stable-ID DOM bridge (fast path + shape re-match)

**What AgentQL does**: `generateAccessibilityTree` stamps a `tf623_id` attribute onto every
element it touches while building the compressed tree. The server only ever reasons over IDs;
the client resolves `tf623_id="42"` straight to `page.locator("[tf623_id='42']")`
(`AGENTQL.md:2618-2641`). Iframes are handled by dot-joining ids into an `iframe_path` that
becomes a chain of `frame_locator()` calls.

**Why it matters**: this is the mechanism that lets a stateless server (or any model) refer to
a concrete, clickable element by a short opaque token, without ever knowing a CSS selector
exists, and without re-running selector inference per action.

**Silver already has this — and arguably a stronger version.** `silver/src/actuation/resolve.ts`
implements the identical bridge pattern (`data-silver-ref` attribute stamped via
`DOM.resolveNode` + `Runtime.callFunctionOn`, then `page.locator('[data-silver-ref=...]')`),
but adds two hardenings AgentQL's reference implementation doesn't have:
- **Verified stamping, not blind trust**: the fast path is only accepted when
  `loc.count() > 0` actually confirms the stamp landed on a live, attached node — AgentQL's
  `resolve_to_locator` has no such verification and will silently hand back a locator for a
  detached node.
- **Slow-path shape re-match**: on a stale `backendNodeId` (SPA re-render), Silver re-snapshots
  and re-matches by `(role, name, nth, frameId)` computed the *same way* the serializer minted
  it (`resolve.ts:78-102`), rather than failing outright. This is a real answer to a gap
  AgentQL's own teardown never addresses: what happens when the id-bearing node is gone.

Verdict: **no gap — Silver's version is the more defensive implementation of the same idea.**

---

## 2. Deterministic-before-model resolution (cheap local match before spending model tokens)

**What AgentQL does NOT do well here — this is explicitly AgentQL's own flagged weakness**,
not a strength: every single locate/extract call requires a full network round trip to
`api.agentql.com`, even for cases a local exact match (stable `id`/`data-testid`, exact text)
could resolve instantly and free (`AGENTQL.md` section 5.3, "No offline capability... Single
point of failure" — digest anti-pattern #2). The task brief asked us to check this pattern
because it's the *right instinct* AgentQL gestures at but never ships.

**Silver already has this.** `silver/src/actuation/actions.ts` implements a `find` verb — a
"semantic tier" (`role|text|label|placeholder|testid|first|last|nth`) that resolves directly
via Playwright's `getBy*` locators with **no prior snapshot and no model call needed**
(`actions.ts:66-90`, doc comment: `'find(...)' semantic tier ... — NO prior snapshot needed`).
This is precisely the deterministic pre-model fallback AgentQL's own researchers wished AgentQL
had. It costs zero tokens and zero server round-trips when the caller (host LLM) already knows
a stable selector-ish hint (test id, exact label) instead of needing a full tree re-read.

Verdict: **no gap — Silver ships the fix AgentQL's teardown says AgentQL itself is missing.**

---

## 3. GAP: Query/decision caching — "codified learning" and cache-seed echo

**What AgentQL/TinyFish does**: two related but distinct caching ideas, both real gaps in
Silver:
- **`Node.get_cache_key()`** (`AGENTQL.md:4709`, `8191`): the query AST's own canonical
  serialization (`f"{name}({description})"`) IS the cache key — no separate hashing scheme.
- **TinyFish's "codified learning"** (qualitative, not code — `AGENTQL.md:7007`, `6247`):
  per-workflow-node decisions are cached and replayed; only ~2 of 6 checkout steps need model
  involvement on repeat runs, the rest replay a previously-resolved action deterministically and
  fall back to the model only on replay failure. Pricing is explicitly framed around "distinct
  decisions," not raw token/browser-minute cost.
- **`generated_query` echo** (`AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:574-589`): when a caller
  sends free-text `prompt`, the server returns the compiled query alongside the result, both for
  debuggability and so the caller can persist and replay it, skipping recompilation cost next run.

**Silver's actual state (verified, not inferred)**: `silver/src/actuation/resolve.ts`'s own doc
comment is explicit — *"A handle is NEVER cached across commands."* Grepping the full
`silver/src` tree for cache/memoization logic (`grep -rli cache`) turns up nothing but an
unrelated HAR-format field (`core/capture.ts:357`, a literal `{}` placeholder in network-log
serialization, not a cache). There is no locator cache, no per-(site, step) decision replay, and
`silver/src/extract/transform.ts` (the ID-grounded schema moat) never echoes the compiled
ID-schema back to the caller for reuse — every `extract` call re-derives the transform from
scratch even against an unchanged page.

**Recommendation (bounded, not a DSL)**: a session-scoped `(site/workflow-tag, step-id) →
{ref shape, action}` replay cache keyed the same defensive way `find`/`resolve.ts` already
compute matches (`role name nth`), with a short-timeout replay-first / fall-back-to-full-resolve
policy. This is Silver's single highest-leverage caching gap versus AgentQL's stack, but per
`agentql.md`'s own honest caveat, TinyFish's version is described qualitatively, not
reverse-engineered code — treat it as a design target to prototype and measure replay-failure
rate against, not a ready-made algorithm.

**Tier: GAP — worth adopting, scoped to a replay cache, explicitly not a query-DSL cache.**

---

## 4. GAP: Browser-fleet session API (hosted remote browsers, byte-metered)

**What AgentQL/TinyFish (Tetra) does**: `POST /v1/tetra/sessions` takes three knobs
(`browser_ua_preset`, `browser_profile`, `shutdown_mode` with a 5s–86400s inactivity TTL) plus
proxy/multi-tenant tags, and returns exactly 3 fields (`session_id`, `cdp_url`, `base_url`).
No `DELETE` endpoint — disconnecting the CDP WebSocket *is* session teardown. Billing is
byte-metered on proxy traffic, not VM-minutes (`AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:451-608`).

**Silver's actual state**: `silver/src/core/session.ts` is a local "browser-as-daemon" model —
`openSession` spawns a detached, locally-owned Chromium with a per-session profile dir; every
command reconnects over CDP and disconnects, but the *browser process itself* persists across
commands (mitigating, not eliminating, the per-command-reconnect cost this whole project is
tracking). Silver does support attaching to an *already-running* external browser via
`connect <endpoint>` (`SessionInfo.external`), but there is no hosted multi-tenant fleet: no UA
presets, no proxy country-code selection, no byte-metered billing hooks, no inactivity-TTL
shutdown mode — because Silver has no server component at all (by design: keyless, local-first).

**Verdict**: real gap relative to AgentQL/Tetra's capability set, but **conditionally
out of scope** — Tetra's fleet exists to solve remote/scaled/multi-tenant browser provisioning
for a hosted SaaS; Silver is explicitly a local, keyless CLI. Building fleet infrastructure would
be scope creep unless/until Silver grows a genuinely remote/hosted execution mode. Flag as
**GAP — do not build now**, revisit only if a hosted-Silver mode is ever scoped.

---

## 5. GAP (minor): Request-correlation IDs threaded through the error taxonomy

**What AgentQL does**: every server response — success or error — carries a `request_id`
(UUIDv4), surfaced in error messages for support/debugging correlation (`AGENTQL.md:542-550`).
Combined with ~7 typed error classes (`APIKeyError=1000`, `QuerySyntaxError=1010`, etc.), an
agent can programmatically branch on failure class while a human can still correlate a specific
failed call against server-side logs.

**Silver already has the harder half of this well** — `silver/src/core/errors.ts` defines a
comparable closed taxonomy (`ref_stale`, `element_not_found`, `element_obscured`, `timeout`,
`navigation_blocked`, `captcha_detected`, `page_crash`, `auth_required`, `not_permitted`,
`confirm_required`, `path_denied`, `output_overflow`, plus a lock-timeout code) and goes further
than AgentQL by attaching a `retryableByHost: boolean` to every code and making the message
itself the recovery instruction (`errors.ts:1-9`) — a genuinely better design than AgentQL's
free-text-plus-code approach, since the host LLM doesn't need a lookup table to know what to do
next.

**What's missing**: `core/envelope.ts`'s `fail()` deliberately does NOT interpolate any context
into the message (a correct no-leak design choice — paths/secrets never appear in output), but
as a side effect there is no per-call correlation id at all, anywhere in an envelope. For a
multi-step session with `--json` logging, there's no cheap way to line up "this specific failed
command" against a session-level debug log after the fact, the way `request_id` lets AgentQL
support correlate a single failed call.

**Recommendation**: add a monotonic per-command sequence number (not a UUID — no new
entropy/dependency needed) to the envelope, scoped to the session sidecar, purely for
log-correlation; keep the no-leak invariant on the `error` message field untouched.

**Tier: GAP — small, cheap, low priority.**

---

## Summary Table

| # | Capability | AgentQL mechanism | Silver status |
|---|---|---|---|
| 1 | Resilient ID-bridge locator resolution | `tf623_id` stamp + `resolve_to_locator` | **Has it — stronger** (verified stamp + shape re-match) |
| 2 | Deterministic-before-model fallback | *(AgentQL's own flagged gap, not a strength)* | **Has it** — `find` verb, no snapshot/model needed |
| 3 | Query/decision caching | `get_cache_key()`, "codified learning", `generated_query` echo | **GAP** — no locator/decision cache anywhere in `silver/src` |
| 4 | Browser fleet (hosted, byte-metered) | Tetra `/v1/tetra/sessions` | **GAP, but out of scope** — Silver is local-first by design |
| 5 | Request-correlation IDs | `request_id` UUID on every response | **GAP, minor** — error taxonomy is otherwise stronger |
