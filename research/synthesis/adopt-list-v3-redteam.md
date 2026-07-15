# Silver ADOPT-LIST v3 — RED TEAM

**Verdict up front.** The list is mostly sound on the *net-new* capabilities (auth reality,
trust primitives, durable tasks), but it was written against a **stale snapshot of `src/`**.
At least seven items — including one of its three P0s — are **already implemented in the current
tree**. Several "Silver has zero X / grep-confirmed" premises are false today. Two more items are
already ~80% built and the list overstates the remaining work by an order of magnitude. And a
handful are cargo-cult ports (a keyless imitation of a model-trained technique) that add risk and
surface without earning it.

Blunt summary of what changed under the list's feet (all verified against `silver/src`):

| Claim in v3 | Reality in current `src/` |
|---|---|
| E1: "Silver has zero equivalent — every docs lookup opens full Chromium" | **FALSE.** `read` verb exists (`handlers.ts:399/841`), does browser-free `fetchGuarded`+`htmlToText`. Only the llms.txt/`Accept: text/markdown` layer is missing. |
| E5: "`--cdp` is per-command; add a `connect` verb" | **DONE.** `connect` verb exists (`handlers.ts:434/751`), persists CDP attach into the session sidecar, reseeds the tab registry. |
| R1: "No dialog handler exists in `src/`" | **FALSE.** Dialog handler registered at `handlers.ts:243` ("fix P0-7"), message stamped to an encrypted `dialog.json` sidecar, `dialog` verb reads it. |
| S6a: "port Aside's amount regex → confirm preview" | **DONE.** `confirm.ts:117-223` — `AMOUNT_PATTERN`, 24-label keyword table, `buildConfirmPreview`, wired into `destructivePaidBlocks`/`confirmRequiredWithPreview`. |
| K4: "doctor returns a flat `{playwright,chromium,uab_writable}` triple" | **~80% DONE.** `handleDoctor` (`handlers.ts:1663`) already has a `DOCTOR_FIXES` remediation table + the real headless-launch probe (F2). Only the array-of-objects shape and 2-3 extra checks remain. |
| R4: "generation only bumps on snapshot; act leaves stale refs valid" | **HALF-DONE.** `handleAct` (`handlers.ts:998-1014`) already computes and surfaces `page_changed`/`stale_refs` on every action. The advisory exists; only the hard-fail-next-ref bump is missing. |
| D7: "no `network` verb / per-request capture today" | **MOSTLY DONE.** `network` verb exists (`handlers.ts:453/1830`) with `requests`/`route`/`unroute`/`har` + a capped in-page capture ring. Only the "one dir per request on disk" flavor is absent. |

The genuinely-absent, genuinely-valuable core is smaller and cleaner than the 60-item list
implies: **S2, S1, D2, T1, AC1, E4, K1, R2, E3, P2, S5, S8, T7** plus the real-auth cluster
(**E2, E6, D6**). Everything else is already built, polish, doc, or scope creep.

---

## Confirm / Cut / Trim table

Verdicts: **CUT-DONE** (already in `src/`) · **CUT-CARGO** (imitation of a model technique / not worth
the risk+surface) · **TRIM** (real but overstated — downgrade scope/priority) · **CONFIRM** (high-value,
keep) · **PROMOTE** (undersold — raise priority).

### Engine / launch

| Item | Verdict | Reason |
|---|---|---|
| **E1** `read` llms.txt | **TRIM → P3** | Browser-free `read` already ships. Only the llms.txt walk + `text/markdown` negotiation remain — a nice token-saver, not a P0. The "zero equivalent" premise is false. Remove from P0. |
| **E2** real-Chrome-profile | **CONFIRM P1** | Genuinely absent. The single biggest keyless auth unblock (user's own cookies, no credential enters Silver). Filesystem probing only — keep. |
| **E3** config files | **CONFIRM P1** | Absent. Real drift source (one batch call silently drops `--allowed-domains`). Ship with the `<field>Explicit` shadow-boolean as the list says. |
| **E4** retry taxonomy | **CONFIRM P1** | `withRetries`/`retries_exhausted` genuinely absent (`errors.ts` has only the `retryableByHost` boolean). Real babysitting cost. Keep the hard numeric cap — no silent loops. |
| **E5** `connect` | **CUT-DONE** | Fully implemented. Delete. |
| **E6** cross-origin iframe AX | **CONFIRM P1** | `walk.ts` still skips OOPIFs. High-value target class (Stripe/OAuth/checkout iframes). Real. Keep. |
| **E7** proxy env / durations | **CONFIRM P2** | Small, correct. Fine as P2. |

### Perception

| Item | Verdict | Reason |
|---|---|---|
| **P1** ARIA-paradox fallback-name | **CONFIRM P1** | ~15 lines in `walk.ts`, addresses a measured failure class. Cheap, keyless, high ROI. |
| **P2** markdown chunking | **CONFIRM P1** | Absent, pure string algorithm, prevents mid-table/mid-fence garbage. Keep. |
| **P3** state badges / file-input role | **CONFIRM P2** | Formatting-only, cheap. Fine. |
| **P4** Set-of-marks overlay | **CUT-CARGO / defer P3** | Canvas compositing (M effort) for a vision-fallback path Silver deliberately de-emphasizes. Only pays off if the host is already doing vision — in which case coordinate verbs + `screenshot` suffice. Heavy surface, thin payoff. Defer. |
| **P5** SPA JSON-blob strip | **CONFIRM P2** | Cheap regex, real token win on LinkedIn/FB. Fine. |
| **P6** scored node pruning `--max-nodes` | **CUT-CARGO** | Prune4Web is a *model-trained* relevance ranker; the keyless "role class + text density" imitation is a heuristic that can **silently drop the exact node the host needed** and hide it behind "N more nodes omitted". The existing honest hard-stop at 10k is safer. If a budget is truly wanted, ship a *count* truncation with a loud marker — not a pseudo-relevance score that fabricates confidence. |

### Actuation

| Item | Verdict | Reason |
|---|---|---|
| **AC1** `expect`/`--verify` | **CONFIRM P1 (marquee)** | Absent. Turns "did it work?" from host-remembered prose into code. Highest trust-per-effort actuation item. Keep. |
| **AC2** screenshot pixel-diff | **CONFIRM P1** | `diff.ts` is a11y-only; visual-regression is genuinely absent and a named use case. Keep (one dep: `pngjs`). |
| **AC3** coord→ref resolution | **CONFIRM P1** | Folds into existing B1 coord path (`handleCoordAct` already exists at `handlers.ts:929`). Cheap upgrade. Keep. |
| **AC4** CAPTCHA primitives (dragPath/region-shot) | **TRIM P2** | Keyless-compatible (mechanics only, host does vision). But it's speculative until R2 detection lands and a real host loop needs it. Sequence *after* R2. |
| **AC5** `highlight` | **CONFIRM P2** | Trivial debug aid. Fine. |
| **AC6** `act --batch` | **CUT-DONE-ish → TRIM P3** | A `batch` verb already exists (`handlers.ts:486/2547`) running multiple commands in one process with `--bail`. The list's own "verify `task` doesn't already cover this" caveat resolves *against* it. The only delta is same-generation validation-before-execute; small. Downgrade hard. |
| **AC7** trace/record/`>>`/tap/swipe/clipboard | **CUT-CARGO (mostly)** | Grab-bag scope creep. `clipboard` already ships (`handlers.ts` case `'clipboard'`). The rest (Tracing flame-charts, touch events, `>>` selector hop) are each a "someone might want it" verb with no demonstrated Silver use case. Cut the bag; let real demand pull individual verbs later. |

### Reliability / detectors

| Item | Verdict | Reason |
|---|---|---|
| **R1** dialog handler | **CUT-DONE** | Already registered and sidecar-persisted. Delete. |
| **R2** CAPTCHA detect | **CONFIRM P1** | `captcha_detected` is a defined-but-unemitted code (verified `errors.ts:37`, no emitter). Cheap substring match, high trust value. Keep — top detector. |
| **R3** `auth_required` detect | **CONFIRM P2** | Same dead-code situation (`errors.ts:46`). Cheap. Fine at P2. |
| **R4** gen-bump-on-act | **TRIM → P2** | The advisory `page_changed`/`stale_refs` flag is **already emitted on every act** (`handlers.ts:1011-1013`). This item only adds the belt-and-suspenders hard-fail. Real but not P1 — the silent-misclick window is already narrowed by the flag. |
| **R5** page_empty / repetition | **CONFIRM P2** | Absent, cheap, turns statelessness into a reliability asset. Fine. |
| **R6** crash/nav codes | **CONFIRM P2** | The `page_crash` vs `navigation_failed` vs `navigation_blocked` distinction is a real host-confusion fix. Fine. |
| **R7** lifecycle-watcher | **CONFIRM P2** | Bundle with v2-C2 as stated. Real (SSO-bounce mis-settle). Fine. |
| **R8** downloads/status/OOPIF | **CONFIRM P3** | De-dupe download against v2-E4 as the list already flags. Fine. |

### Extract / tasks

| Item | Verdict | Reason |
|---|---|---|
| **X1** CSV repair / IDF PDF | **CONFIRM P2** | Real double-escape bug + principled PDF budgeting. Fine. |
| **X2** cite-by-snippet-id | **CONFIRM P3 (doc)** | One sentence. Fine. |
| **T1** variable auto-detect | **CONFIRM P1** | Absent. The thing that makes a saved task *reusable* instead of a fixed script. Pure regex/DOM-attr. Keep — highest task-durability item. |
| **T2** run manifest | **CONFIRM P0** | Legit P0: v2-F1 replay is non-deterministic without it. Small. Keep. |
| **T3** verb-sequence DOM-hash cache | **CONFIRM P1** | Biggest ETL throughput win, DOM-hash already computed for diffing. Keep — but land *after* T1/T2 (it depends on the recorded run being stable). |
| **T4** log hygiene (a/b/c/d) | **CONFIRM: a=P1, rest P2** | (a) strip-base64-on-persist is a real MB-bloat bug — P1. b/c/d are polish. As scoped. |
| **T5** subprocess env hygiene | **CONFIRM P1** | Prevents a whole hang class (`PAGER`/progress bars). Cheap, high value. Keep. |
| **T6** `--echo-plan` / status | **CONFIRM: a=P1, rest P2** | Anti-drift echo is cheap and real. Fine. |
| **T7** local recipe catalog | **CONFIRM P2** | Absent, genuine differentiation, O(exploration)→O(lookup). Keep the `SENSITIVE_CONFIG_KEYS` redaction as stated — it's the whole safety story. |
| **T8** `task report` HTML | **CONFIRM P3** | Nice-to-have. Fine at P3. |

### Orchestration

| Item | Verdict | Reason |
|---|---|---|
| **O1** subagent `--result-file` | **CONFIRM P1** | Verified real: `subagent done --text` is `capOutput(text, MAX_PROMPT=20_000)` (`subagent.ts:305`) — silent truncation of long results. Keep. |
| **O2** shared-target caveat / typed ids | **CONFIRM: a=P1 doc, b=P2** | (a) The doc caveat (own-context ≠ safe concurrent writes to one account) is important and free. (b) typed ids cosmetic. As scoped. |
| **O3** parallel litmus | **CONFIRM P2 (doc)** | One worked example. Fine. |

### Security

| Item | Verdict | Reason |
|---|---|---|
| **S2** CDP Fetch-layer egress | **PROMOTE P1 → P0** | **The most important item in the list.** Verified: egress guards navigation only; **no `Fetch.enable`/`setBlockedURLs` anywhere in `src/`.** Silver's docs *claim* exfil hardening its egress guard does not enforce — a page on an allowed domain can beacon to any host. That's not a feature gap, it's a **false security property**. Fix before shipping more auth features that put real cookies behind it. |
| **S1** CaMeL-lite taint guard | **CONFIRM P1 (opt-in only)** | The data-flow half is genuinely absent (fence exists read-side only, `injection.ts:22`). Novel and cheap. **Steelman-simple caveat:** keep it strictly opt-in (`--no-untrusted-args`) — a page legitimately echoes text a host legitimately re-submits (search terms, edited content), so default-on would false-positive and train hosts to disable it. Opt-in + structured "confirm or reformulate" error is the right risk posture. |
| **S3** filename chokepoint | **TRIM → P2** | Path containment already exists and is used (`assertContainedPath`, e.g. upload at `handlers.ts:980`, `egress.ts`). This is a *refactor to one choke + audit*, not a missing capability. Real hygiene, but P2 polish — the traversal hole is already closed on the known write paths. |
| **S4** `confirm`/`deny` two-phase | **TRIM → P1 (reframe)** | No `confirm`/`deny` verbs exist — true. But the "feature-death / impossible in deployment" framing is **overstated**: the confirm gate only engages when `--confirm-actions` is supplied (`handlers.ts:939`), so the default agent path is *not* bricked. The real value is pending-action inspection UX, not rescuing a dead feature. Keep at P1, drop the P0 alarm. |
| **S5** action-policy JSON | **CONFIRM P1** | Absent, and "no hard deny" is a real gap. Drop-in Vercel schema. Keep. |
| **S6** amount regex / PII gate | **a=CUT-DONE, b=CONFIRM P2** | (a) **Already built** (`confirm.ts:117-223`, labelled "adopt-list E2"). Delete S6a. (b) Luhn card/SSN *value* gate is absent and worth it — keep S6b only. |
| **S7** secret-blind fill | **CONFIRM P1** | Complements existing `<secret>` write-path (`actions.ts:59-66`). Absent env/keychain read. Keep. |
| **S8** navigation denylist + ratelimit | **CONFIRM P2** | Absent; the single most concrete "don't get the account banned" mechanism. Keep the unconditional (not-behind-`--allowed-domains`) enforcement as specified. |
| **S9** lookalike / daemon hardening | **CONFIRM: a=P2, b=P1** | (b) daemon-bind-to-loopback-by-default is a real 0.0.0.0-day class bug to pre-empt — fold into A3 from day one as stated. (a) lookalike warning is P2. |

### Skill / docs

| Item | Verdict | Reason |
|---|---|---|
| **K1** skill auto-injection matcher | **CONFIRM P1** | Skill system is static single-shot today; the matcher the design doc specs doesn't run. Pure string math. Keep. |
| **K2** verification rubric | **CONFIRM P1 (doc)** | Host-run (host's model, Silver stays keyless). Prose. Fine. |
| **K3** accretion discipline | **CONFIRM P1/P2 (doc)** | Cheap, and directly relevant — this red-team is itself evidence the list accretes. Keep the "fold vs custom-tool vs MCP" note. |
| **K4** structured doctor | **TRIM → P2 (S)** | Remediation table **and** the real headless-launch probe already exist (`handlers.ts:1656-1712`). Only the `{checks:[…], verdict, next}` reshape + CDP-reachability/lock-staleness checks remain. Real but small — downgrade from "HIGH/P1". |
| **K5** non-retry / Nova / eval | **CONFIRM P1/P2 (doc)** | Eval sharpening (c) is a genuine P1 design input. Rest doc. Fine. |
| **K6** DOM-contract self-QA | **CONFIRM P2/P3 (doc)** | Novel and cheap. Fine. |

### Ergonomics / DX

| Item | Verdict | Reason |
|---|---|---|
| **D1** `inspect` DevTools bridge | **CONFIRM P1** | Absent, zero competitor parity, composes with the file-based model. Keep. |
| **D2** TOTP | **CONFIRM P1** | Absent, RFC-6238, zero deps, the #1 cross-vertical MFA unblock. Best effort-to-unblock ratio in the list. Keep. |
| **D3** cloud-provider matrix | **TRIM → P2 / optional** | Keyless, yes — but this is the item **most in tension with "keep Silver simple."** Four REST connectors to paid third-party clouds + billing-cleanup surface + ongoing API churn, for teams that already have `--cdp <url>`. It's a business-scope decision, not a capability gap. Demote from P1; ship only if a concrete user is paying for Browserbase *today*. |
| **D4** `scroll --until-stable` | **CONFIRM P2** | Removes real boilerplate. Fine. |
| **D5** typo suggestion | **CONFIRM P2** | Keep the sanitized-prefix-only detail (don't leak URLs/values into errors). Fine. |
| **D6** cookie-authenticated `fetch` | **CONFIRM P1** | Absent (only cookie *storage* exists). Order-of-magnitude cheaper read path. Keep — part of the auth-reality cluster. |
| **D7** `network` to disk | **TRIM → P2** | The `network` verb + `requests`/`har`/`route` already give observability (`handlers.ts:1830-1927`). The "one dir per request on disk" flavor is marginal over what exists. Downgrade from P1. |
| **D8** MJPEG stream | **CUT-CARGO / defer P3** | Heaviest item (L), a human-oversight nicety, large always-on HTTP+screencast surface. No agent-capability payoff. Defer indefinitely; a host that wants to watch can use `--cdp` + real DevTools (which D1 also provides). |

---

## Corrected priority order

**P0 (now) — 2 items, both about honesty of a claimed property:**
1. **S2** CDP Fetch-layer egress — *promoted*. Closes the exfiltration hole that makes Silver's stated
   threat model a lie. Must precede any expansion of auth surface.
2. **T2** run manifest — makes v2-F1 replay deterministic. Small, unblocks T1/T3.

*(Removed from P0: E1 `read` — the P0 part is already built. S4 — reframed to P1, not feature-death.)*

**P1 (soon) — the real net-new capability core:**
- Auth reality: **E2** chrome-profile · **E6** OOPIF AX · **D6** cookie-fetch · **D2** TOTP
- Trust primitives: **AC1** `expect`/`--verify` · **R2** CAPTCHA-detect · **S1** taint-guard (opt-in) ·
  **S5** action-policy · **S7** secret-blind-fill · **S9b** daemon hardening
- Durability: **T1** variable-detect · **T3** verb-seq cache · **T4a** strip-base64 · **T5** subproc env ·
  **T6a** echo-plan · **O1** result-file
- Engine/DX: **E3** config · **E4** retry+cap · **AC2** screenshot-diff · **AC3** coord→ref ·
  **K1** skill-matcher · **D1** `inspect`
- Doc: **O2a** shared-target caveat · **K2** verify rubric · **K3a** accretion · **K5c** eval

**P2 (when convenient):**
E7 · P1-ARIA(*cheap, could pull to P1*) · P3 · P5 · R3 · **R4 (demoted)** · R5 · R6 · R7 · X1 ·
T4bcd · T6bc · T7 · O2b · O3 · **S3 (demoted)** · **S4 (reframed here-or-P1)** · S6b · S8 · S9a ·
**K4 (demoted)** · K3bc · K5ab · K6a · AC4(*after R2*) · AC5 · D4 · D5 · **D7 (demoted)** ·
**D3 (demoted, optional)**

**P3 / optional:**
**E1-llms.txt (demoted from P0)** · R8 · X2 · **AC6 (demoted, `batch` exists)** · T8 · K6b · **D8 (cut-cargo)** ·
**P4 (cut-cargo)** · **P6 (cut-cargo)**

**CUT entirely (already in `src/`):**
E5 · R1 · S6a · (and treat E1-core, K4-remediation, R4-advisory, D7-observability, AC6-batch,
AC7-clipboard as *done sub-parts* — only their small deltas remain).

**CUT as cargo-cult / not worth the risk:**
P6 (pseudo-relevance pruning that can silently hide the target) · P4 (canvas SoM for a de-emphasized
path) · D8 (MJPEG surface, no capability payoff) · AC7-bag (verbs with no demonstrated use case).

---

## Steelman: where keeping Silver simple beats the list

- **P6 and P4 fabricate confidence.** A keyless "relevance score" is not Prune4Web; it's a heuristic that
  hides nodes and lies about why. Silver's honest 10k hard-stop is *better* engineering than a scored
  truncation that drops the target and blames the budget. Simplicity here is a correctness argument.
- **D3 (cloud providers) and D8 (stream) are product scope, not capability.** They add third-party API
  churn and always-on network surface to a tool whose whole thesis is "fast, safe, local, keyless." Every
  provider connector is a maintenance tax and a new billing-leak/credential path. `--cdp <url>` already
  covers the real need. Don't grow the surface until a paying user forces it.
- **S1 must stay opt-in.** The correct-looking version (default-on taint rejection) breaks legitimate
  page→submit flows and trains hosts to pass `--no-untrusted-args` reflexively, killing the defense. The
  simple opt-in guard is the *more* secure design because it's the one that stays enabled.
- **The list's own K3 warns about capability accretion — and the list is the accretion.** ~60 items, of
  which ~7 are already built and ~5 are cargo-cult. Ship S2/T2 (P0), the auth-reality cluster, and the
  trust primitives. Hold the rest until a real host loop pulls them. "No eval = the #1 cause of failed AI
  products" cuts both ways: an unbuilt verb with no failing eval behind it is debt, not backlog.
