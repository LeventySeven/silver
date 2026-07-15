# Silver ADOPT-LIST v2 — the true-synthesis backlog

**What this is:** the merged, de-duplicated, priority-ranked list of concrete capabilities Silver
**lacks or does measurably worse** than best-in-class, each mapped to a Silver file/change, each
verified keyless (no model call inside Silver), each cited to the source lens that established it.
Items where Silver already matches or beats the field are listed once at the end under *Confirmed
non-gaps* so they don't get re-litigated. Cargo-cult / needs-a-model items are excluded by design.

Sources merged: `deepdive/{vercel,aside,browseruse,stagehand,agentql,webwright,browserbase,perplexity}-top5dx.md`,
`deepdive/{measure-latency,measure-tokens,measure-parallel-coldstart}.md`,
`deepdive/{aside-engine,stagehand-extract,browseruse-actuation}.md`,
`deepdive/{anthropic-skills-1,anthropic-skills-2,usage-taxonomy}.md`.

**The single most important correction from the empirical pass:** the project brief's hypothesis —
"Silver is slow because TS + per-command CDP reconnect" — is **falsified by measurement**. The CDP
reconnect is **~3 ms** (`measure-parallel-coldstart.md §4`); rewriting perception in Rust would buy
almost nothing (`snapshotNodes` is ~5 ms). The real latency gap is two language-independent things:
a **~500–1200 ms `networkidle` settle burned on every read verb**, and a **~185 ms Node+Playwright
startup tax per command**. Token bloat is 100% serializer-format, not engine. Every engine item below
is scoped to what the numbers actually say.

---

## A. Engine efficiency & latency (empirically re-scoped)

### A0. Skip the `networkidle` settle on read-only verbs — **P0, ~free, biggest single win**
Warm `snapshot` is **1469 ms**; ~1200 ms of that is `settleAndFingerprint` racing `networkidle` on a
freshly re-attached client that never observed the load, so Playwright restarts its 500 ms idle timer
every call — measured at **~1465 ms even on `about:blank`** (zero network). Read verbs
(`snapshot`/`get`/`is`/`read`) observe an already-loaded page and should not settle at all.
- **Change:** in `actuation/pagechange.ts` + `core/handlers.ts`, gate `settleAndFingerprint`'s
  network-idle race so it runs only after mutating verbs (`open`/`goto`/`click`/`fill`/`press`/…), not
  read verbs. Cap the "never idles" budget well below the current `NETWORK_IDLE_BUDGET_MS=1200`
  (`pagechange.ts:37`) — e.g. 300 ms — or gate it behind `--wait networkidle`.
- **Impact:** warm `snapshot` drops ~1469 ms → **~230 ms** (the `get url` floor) with zero
  architectural change. Closes **~85 % of the warm-command gap** for free.
- Keyless. Source: `measure-parallel-coldstart.md §5,§7`, `measure-latency.md §"second gap"`.

### A1. Snapshot token-format defaults: URLs opt-in, drop `level=0`, trim preamble — **P0, free**
Silver's snapshot is **1.6×–3.7× fatter than Vercel** at default flags — but the encoding is *not*
bloated; stripped of three additions it is **equal-or-leaner** than Vercel (Wikipedia 0.996×, GitHub
0.88×). The entire gap is: inline `url=<href>` on every link (**35–54 %** of bytes), a `, level=0` tag
that is always 0 in flat interactive mode (**~10 %**), and a ~150-char fixed preamble that swamps small
pages (example.com 271 vs 74).
- **Change (serializer only, `perception/serialize.ts`):** (1) make inline URLs opt-in behind a `-u`
  flag mirroring Vercel; (2) drop `level=` when 0 / in flat interactive mode; (3) drop
  `# note: interactive elements only` and `generation=N` from per-snapshot output. **Keep** the
  `⟦page-content untrusted⟧` wrapper — it is load-bearing security.
- **Impact:** (1)+(2) alone bring Silver to **parity-or-better vs Vercel `-i` on every page tested.**
- Keyless, language-independent. Source: `measure-tokens.md` (headline table + decomposition).

### A2. Snapshot a11y-tree cache + dirty-tracking — **P1, biggest absolute single-command win**
Even after A0, recomputing the tree from scratch every call is the residual algorithmic cost. Vercel
caches the tree (cold snap1 ~500 ms, then **~8 ms**); Silver rebuilds every time. This is orthogonal to
transport — a daemon alone would not fix it.
- **Change:** cache the built tree/refmap keyed on generation, invalidate on mutation (reuse the
  `pagechange.ts` fingerprint as the dirty signal), in `perception/walk.ts` + `refmap.ts`.
- Keyless. Source: `measure-latency.md §"snapshot computation"`, `browseruse-top5dx.md #4`.

### A3. Opt-in persistent daemon (`silver serve` / `--daemon`) — **P1, closes the rest of the gap**
The **~185 ms Node+Playwright startup tax is paid on every command** (`silver version` 190 ms vs
Vercel's Rust 3 ms) and cannot be erased without stopping the per-command process spawn. `batch`
already proves ~4.7× is reachable by amortizing it. A long-lived Node process holding the connection +
page handles + refmap in memory, with the CLI a thin Unix-socket client, removes the 185 ms **and**
retains Playwright load-state (which also eliminates A0's re-observation) — mirroring
Vercel/Aside without a Rust rewrite.
- **Change:** port the shape of Vercel's `daemon.rs`/`connection.rs` to Node — detached+unref'd
  `silver __daemon`, JSON-line socket protocol, enable-domains-once. Keep per-command spawn as the
  **default** (it buys the measured clean 3.5× parallelism and crash-isolation); daemon is opt-in for
  latency-sensitive interactive loops.
- **Explicitly do NOT** build a standalone "persistent CDP connection cache" — reconnect is ~3 ms;
  rejected on evidence.
- Keyless. Source: `vercel-top5dx.md #1`, `aside-engine.md §3 P1`, `measure-parallel-coldstart.md §7`.

### A4. CDP-session reuse + page-change short-circuit inside `batch` — **P1 / P2**
`batch` runs sub-commands in one process but still re-dispatches each through `run()`, reconnecting CDP
and re-parsing argv per sub-command, with no shared scope (`aside-engine.md §2`). Two fixes:
- **P1:** hold one CDP connection open across a `batch` invocation's sub-commands
  (`core/session.ts` connection lifecycle, batch path only) — removes N-1 reconnects.
  Source: `browseruse-top5dx.md #4b`.
- **P2:** after each sub-command, check the `pagechange.ts` fingerprint delta and stop remaining
  sub-commands with a logged skip-reason instead of letting them fail one-by-one against stale refs
  (`cli.ts` batch handler). Source: `browseruse-actuation.md #2`, `browseruse-top5dx.md #3`.
- Keyless.

### A5. (Strategic, deferred) Understudy-style owned CDP layer to drop the Playwright dep — **P2**
Stagehand v3 proves a **TS** codebase gets engine-level control by owning the CDP session/frame
registry directly instead of going through Playwright — falsifying "Rust is why Vercel is faster." A
few-hundred-line Silver-owned `Page`/`FrameRegistry` for the reconnect-and-execute path (keep Playwright
only for launch) would cut reconnect overhead and dependency surface. Large; the daemon (A3) captures
most of the practical win, so this is a strategic note, not urgent.
- Keyless. Source: `stagehand-top5dx.md #1`.

---

## B. Action surface

### B0. `silver repl` — persistent-scope code-execution verb — **P0 (High effort), marquee item**
The single largest architectural divergence from best-in-class. Aside and browser-use **independently
converged** on CodeAct: one `repl(code)` surface over Playwright-dialect JS with a persistent scope and
helper globals, batching fill→click→press→re-snapshot into **one** round-trip (mean 12.9 repl calls/task
vs ~34 messages). Silver ships ~40 discrete verbs, one process+reconnect each, and its `eval`
(`handlers.ts:2253`) is a *single* expression with no persistent scope, no `snapshot()`/`openTab()`
globals, gated as arbitrary-code behind a per-call confirm.
- **Change:** add a `repl` mode that opens one CDP connection, keeps one JS execution context alive
  across statements, and exposes `snapshot()`, `openTab()`, `tabs[]`, and the extract/webfetch
  equivalents as callable globals. Host authors the JS — Silver still never calls a model.
- **Impact:** collapses N verbs / N reconnects / N round-trips → 1. Round-trip win is independent of and
  additive to A3's connection win.
- Keyless. Source: `aside-top5dx.md #1`, `aside-engine.md §1,§3 P1`.

### B1. Coordinate-based fallback verbs (`click --at x y`, `type --at`, `drag --from --to`) — **P2**
Silver's action surface is **exclusively** ref/locator-based (`actuation/actions.ts` — verified: no
`{x,y}` param anywhere). Canvas widgets, custom `<div>` controls with no accessible name, virtualized
lists, and shadow-DOM-heavy SPAs have **no AX-tree node**, so they are currently **un-actable by Silver
regardless of what the host's vision model can see** in a screenshot. Two independent lenses flag the
identical missing primitive.
- **Change:** add coordinate verbs bypassing `groundRef`/`toLocator`, calling `page.mouse`/`page.keyboard`
  directly, gated behind the existing `--enable-actions`. Screenshot capture already exists — mostly
  wiring. Document the fallback contract ("if `find` returns `element_not_found`, screenshot → host
  eyeballs coords → coordinate verb").
- Keyless. Source: `browserbase-top5dx.md #5`, `perplexity-top5dx.md #4`.

---

## C. Perception / serializer quality

### C1. Compound-component synthesis + date/select format hints — **P1, small**
Silver's `serialize.ts` is a flat renderer: a `<select>` or `<input type=date>` emits a bare
`role name value` line with no disambiguating hint, so the host must **guess** the format and can
silently submit a wrong locale date. browser-use synthesizes virtual nodes: `<input type=range>` → a
`slider` node carrying min/max; `<select>` → first-4-options + a numeric/date/email `format_hint`;
date/time inputs → an ISO-format hint. Pure output-quality: fewer wrong actions, fewer retries.
- **Change:** new synthesis pass in `perception/serialize.ts` hanging off DOM metadata `walk.ts` already
  carries (input type, min/max, option values). No architecture change.
- Keyless. Source: `browseruse-top5dx.md #1`.

### C2. Automatic network-quiet gate before snapshot capture (post-action) — **P2**
Complements A0: on **read** verbs skip settle entirely; on **action** verbs replace Playwright's
deprecated-flaky `networkidle` with Stagehand's in-flight-request-counter heuristic (CDP
`Network.enable` + `requestWillBeSent`/`loadingFinished`/`loadingFailed`, quiet 500 ms after in-flight
hits 0, stalled-sweep >2 s, hard cap). A snapshot taken right after a click that kicks off async content
otherwise races a still-loading DOM.
- **Change:** `actuation/pagechange.ts`. Keyless. Source: `stagehand-extract.md #2`.

### C3. DOM-depth retry ladder — **P2 (low), cheap defensive win**
`walk.ts:173` calls `DOM.getDocument({depth:-1, pierce:true})` **once**; a single unlimited-depth
timeout on a pathologically nested page fails the whole snapshot. Stagehand steps down
`[-1,256,128,64,32,16,8,4,2,1]` on timeout/OOM.
- **Change:** wrap the single call in a retry loop over a fixed depth-cap list; tell the caller the tree
  was depth-limited. Keyless. Source: `stagehand-extract.md #3`.

---

## D. Repeatability / caching

### D1. Self-healing action/resolution cache — **P1, largest *relative* latency win for a keyless tool**
No cache anywhere (`grep cache|replay|sha256` on `memory/`+`task/` → **zero hits**). Every repeat of the
same instruction against the same page re-runs the full snapshot → host-reasoning → resolution path.
Three independent lenses (Stagehand `ActCache`, Browserbase, Stagehand-extract) flag this. Silver's win
is **bigger than Stagehand's**: Stagehand skips only the LLM call; Silver skips **the whole host
round-trip** and possibly the re-serialize/re-send of the tree.
- **Change:** opt-in local cache keyed on `sha256({instruction, normalizedUrl, refSelectorOrRole})` →
  last-good `{ref, backendNodeId, role, name}` resolution, stored as flat JSON under the session sidecar
  (matches existing `silver-state.json` pattern). On hit, **re-validate the cached selector against the
  current DOM before acting** (self-heal — reuse `perception/accessible-name.ts`); on drift, silently
  rewrite the entry rather than error, preserving Silver's staleness invariant. Two-backend design
  (fs-JSON + in-memory Map) ported from `CacheStorage.ts`.
- Keyless (the cache path calls no model). Source: `stagehand-extract.md #1`, `stagehand-top5dx.md #2`,
  `browserbase-top5dx.md #1`.

---

## E. Security (all keyless; several are real gaps vs Silver's *own* threat model)

### E1. `<secret>` write-path indirection — **P0, the one measurable security-posture gap**
`redact.ts` guards only the **read** path (masks passwords in outbound snapshots). There is **no
write-path equivalent** — `fill`/`type` take the literal secret as a CLI argument, so whatever produced
that command line (the host LLM's context) already had the raw credential in view. This is in tension
not with "keyless" but with the unstated guarantee browser-use provides for free: the secret never
enters **any** LLM's context.
- **Change:** `--secret name=value` / `SILVER_SECRET_<NAME>` env registration resolved by the CLI
  process itself; resolve `<secret>name</secret>` inside `fill`/`type` at the **same choke point
  `redactValue` occupies on the read side** (clean symmetric design); **domain-scope** resolution
  against the live page URL (a `bank.com` secret can't resolve on `evil.com` even under injection) — a
  ~20-line glob matcher. `actuation/actions.ts` + a new small module. TOTP is a nice-to-have, not parity.
- Keyless. Source: `browseruse-top5dx.md #5`, `browseruse-actuation.md #4`.

### E2. Structured confirm-gate preview + amount-extraction regex — **P1**
Silver's confirm gate is boolean yes/no (`security/confirm.ts`). Aside shows a **draft artifact** —
"here is exactly what will be sent" — and a checkout-total amount extractor so the human sees a concrete
dollar figure, not "buy something."
- **Change:** for verbs already flagged by `isDestructivePaidName`, echo the target's accessible name +
  the form-field values about to be submitted (data already exists in the snapshot/resolve layer — no
  model call). Optionally port the amount-extraction regex (label-match over ~24 checkout-total variants
  + decimal-currency pattern) as a local library feeding the preview.
- Keyless. Source: `aside-top5dx.md #3`.

### E3. Semantic-injection keyword heuristic (2nd pass) + documented "classify-before-act" convention — **P1**
`neutralize()` catches exactly one shape: literal forged transcript-role tags. It does **nothing** for
the actual disclosed exploit class — plain-prose "ignore previous instructions" / multilingual injection
embedded in ordinary page text (the PerplexedBrowser CVE-class attack). Silver is keyless so it can't
embed BrowseSafe's model, but two cheap pieces close real ground.
- **Change:** (a) add a keyword/pattern second pass to `security/injection.ts` (common injection
  phrasings across languages) as defense-in-depth alongside the syntactic scrub — will never match
  BrowseSafe's F1, but closes the plain-prose gap; (b) document the host-side "treat every
  `snapshot`/`get-text`/`read` on untrusted content as requiring a self-classification step before
  acting" convention in the SKILL, formalizing what is now implicit.
- Keyless. Source: `perplexity-top5dx.md #1,#5`.

### E4. Download detection + permission auto-grant on connect — **P2, zero current coverage**
`find` for `*download*`/`*dialog*`/`*permission*` in `src/` → **zero files**. A task that clicks a
download link or hits a camera/geolocation prompt presumably hangs today.
- **Change (narrow mechanisms, NOT browser-use's 13-file event bus):** (a) one `page.on('download')`
  handler wired per session that resolves the saved (contained) path; (b) a one-line
  `Browser.grantPermissions` CDP call in the session-connect path, flag-gated. In `core/session.ts`.
  *(Note: `usage-taxonomy §16` shows a `download`/`upload` verb already exists — verify current coverage;
  the gap the lens found is auto-detection of page-initiated downloads and permission prompts.)*
- Keyless. Source: `browseruse-actuation.md #3`.

### E5. Pre-flight `elementsFromPoint` hit-test + checkbox/radio state-verification — **P2/P3**
Aside runs a hit-test before every click to catch overlay/clickjacking misclicks. Silver only classifies
`element_obscured` **reactively** after Playwright throws (`actions.ts:351`). *Reconciliation:* the two
Aside lenses disagree — `aside-engine.md §2` notes Playwright's built-in actionability already
hit-tests, so this is a **proactive-vs-reactive** refinement, not a hard gap. Low priority.
- **Change:** after `scrollIntoViewIfNeeded`, `elementsFromPoint(center)` and verify the resolved element
  is in the list before dispatch; for checkbox/radio, read `checked` before+after and flag a mismatch.
- Keyless. Source: `aside-top5dx.md #4` (vs `aside-engine.md §2` caveat).

### E6. Static JS stealth defaults — **P2 (low-med)**
Silver's only stealth is `--headless=new` + not passing `--enable-automation`. Add the standard,
zero-key init-script patches (`navigator.webdriver=undefined`, realistic `navigator.plugins`/`mimeTypes`,
`window.chrome` shape) injected before navigation. **Explicitly do NOT** chase network/reputation stealth
(proxy fleets, Cloudflare whitelisting) — paid infra, contradicts keyless-local.
- Keyless. Source: `browserbase-top5dx.md #3`.

---

## F. Task durability & reusability

### F1. `silver task compile <id>` → parameterized, rerunnable script artifact — **P1 (High value)**
Biggest structural DX gap in the task layer: Webwright turns every task into a durable, `--flag`-driven
**executable a human/cron can re-invoke** with zero further LLM. Silver ships a durable **log** of one
run (`plan.md`/`action_log.jsonl`/`checkpoint.json`); `task/store.ts:4-6` even names "the script IS the
artifact" as the intent but doesn't deliver it.
- **Change:** `task compile <id>` reads `action_log.jsonl`'s recorded verb invocations, promotes literal
  argument values into named `--flag`s (Webwright's `# Parameters` table shape), and emits a runnable
  shell script of `silver` calls whose defaults reproduce the original task verbatim and whose flags let
  you vary it. `task/index.ts`.
- Keyless. Source: `webwright-top5dx.md #3`.

### F2. `doctor` with per-check `Fix:` text + real Chromium-launch probe + pass count — **P2**
`handleDoctor` returns bare booleans and checks Chromium only via `existsSync(exec)` — so a broken
sandbox/missing shared lib (the #1 CI failure) reads `chromium:true`. Every failed `doctor` forces the
host to guess the fix.
- **Change (`core/handlers.ts` `handleDoctor`):** (a) add a real headless `launch()` + 1×1 screenshot +
  close probe; (b) attach a static `Fix:` string per failed field (reuse the `errors.ts` fixed-string
  convention); (c) return `passed/total`.
- Keyless. Source: `webwright-top5dx.md #1`.

---

## G. Skill packaging (mostly pure `SKILL.md`/`skill-data` prose — high ROI/effort)

### G1. Add a `## Contents` ToC to the 378-line SKILL.md and 458-line examples.md — **P0, ~zero cost**
Both exceed the 100-line ToC threshold; neither has one. Anthropic documents the exact failure this
causes: partial `head -100` reads silently truncate scope. Cheapest fix in the entire backlog.
- Source: `anthropic-skills-1.md Gap B`.

### G2. Build an eval harness (`evals/evals.json`, with-skill vs without, Haiku/Sonnet/Opus) — **P0**
`find -iname "eval*"` → nothing. Nothing verifies the skill `description` triggers across weak vs strong
host models, nor that `compactHead`'s 1200-char cut doesn't decapitate a load-bearing instruction for a
Haiku-class host. Only gap here needing new methodology, not a file edit; directly actionable via
`skill-creator`'s evals.json format.
- Source: `anthropic-skills-1.md Gap C`.

### G3. Link `skill-data/` files by relative path from SKILL.md (or document the CLI-serving contract) — **P1**
Deep content is served via `silver skill --full`, invisible to the filesystem-navigation heuristics
Anthropic's own training assumes — the host can't `Read skill-data/core/examples.md` unless it knows the
path. Either link the files by relative path (cheap, no CLI round-trip) or explicitly document
"reference content is served via `silver skill --full`, not file links."
- Source: `anthropic-skills-1.md Gap A`.

### G4. Port Webwright's web-task-correctness Hard Rules — **P1, doc-only, highest ROI-per-effort**
Silver's SKILL covers **tool mechanics** exhaustively but has **no task-correctness heuristics** — the
failure modes that make agentic tasks silently *wrong* rather than loudly broken, which Silver's
grounding machinery cannot prevent (a ref can be valid and still point at a misjudged UI state). Port:
ranking claims (`cheapest`/`best-rated`) must be grounded in the site's actual sort/filter not the
model's ordering; numeric/date constraints are exact (wider buckets = failure); re-verify selected state
after a drawer/modal closes; prefer interactive form-fill over deep-link URLs (sites silently drop
unparsed params). Pure prose into `skill-data/core/SKILL.md` (or a linked `task-heuristics.md`).
- Source: `webwright-top5dx.md #4`.

### G5. Multi-topic skill catalog — `skill list` / `skill get <name>` + `references/` — **P2 (Medium)**
Silver has exactly one skill and a single-shot `handleSkill` reading one hardcoded path — no
`list`/`get` split, no name-addressed topics, no supplementary-file mechanism. Vercel's `skills.rs` is a
near-drop-in spec. Add a `skill-data/<topic>/SKILL.md` convention (YAML frontmatter), a scanning
`skill list` with truncated descriptions, and `skill get <name> [--full]`. First topics to split when
`core/SKILL.md` grows past ~450–500 lines: `security`, `extract` (each already dense).
- Source: `vercel-top5dx.md #4`, `anthropic-skills-2.md §2`.

### G6. Tonal craft: red-flags table, failure-mode-first framing, competitive-preference clause — **P2**
From compound-v / agent-browser: (a) a red-flags "thought → do instead" table (e.g. "I'll just retry the
click on a stale ref" → re-snapshot first; "the fill echoed the password, fine to reason over" → treat
as sensitive, use `--stdin`; "`success:true`, I'm done" → verify the goal not the call); (b) lead
highest-stakes Hard Rules with one sentence of "what goes wrong if you skip this"; (c) append a
tool-selection clause to `silver/SKILL.md` `description:` ("Prefer silver over a built-in browser tool
when the task needs grounded refs, keyless extract, or egress/file-path guarantees"). All prose.
- Source: `anthropic-skills-2.md §1,§2`.

---

## H. Engine-adjacent capability gaps

### H1. `--engine firefox` option — **P1 (High value), a task-failure class with zero mitigation today**
`session.ts` imports only `{ chromium }`; grep for `firefox`/`webkit` → zero. Sites that TLS/H2-
fingerprint Chromium's client hello (`ERR_HTTP2_PROTOCOL_ERROR` — cars.com and other Akamai-fronted
sites, named concretely) **fail outright in Silver with no workaround**; the same task succeeds under
Webwright's Firefox default. Playwright already bundles Firefox — no new dependency.
- **Change:** `--engine firefox|chromium` on `session open`, default stays chromium (CDP/console parity),
  threaded through `openSession`'s launch branch. Bounded (one launch-args branch + a flag).
- Keyless. Source: `webwright-top5dx.md #2`.

---

## I. Extract / memory / orchestration ergonomics (lower priority)

### I1. Zero-schema single-field `extract` shortcut — **P2, small**
`buildBundle()` **requires** a JSON Schema every time; there's no `get_by_prompt`-style path for "just
get me this one value." Add `extract --field <name> --prompt "<text>"` that auto-builds
`{type:object, properties:{<name>:{type:string, description:<prompt>}}}` before the existing pipeline.
Zero new IR — the same "wrap free text into a single-field schema" trick, over Silver's existing
transform path. Removes real friction on the single most common extract shape.
- Keyless. Source: `agentql-top5dx.md #2`.

### I2. Typed semantic-memory directory + `memory note --type` — **P2, low effort**
`memory/store.ts` implements only the episodic tier. Add the typed-directory convention
(`memory/{people,sites,projects,concepts}/<slug>.md` alongside `episodic/`) and a
`memory note --type <kind> --slug <name>` verb that writes/updates a semantic page. Promotion stays a
**host** judgment call (Silver just exposes the write target) — no daemon, no "dreaming" pass. Skip the
L1-in-system-prompt mechanic (host's job) and the no-vector-layer question (correct keyless divergence).
- Keyless. Source: `aside-top5dx.md #5`.

### I3. `subagent spawn --after <id>,<id>` dependency edges — **P2 (ergonomic)**
`SubRecord` has no `dependencies` field; the host must hand-sequence `wait` then `spawn`. Add `--after`
to record dependency edges and have `spawn` block (polling as `wait` already does) until those ids reach
terminal status before minting the child — collapsing two calls into one. Pure bookkeeping.
- Keyless. Source: `perplexity-top5dx.md #2`.

### I4. Port ~5 high-value Vercel human-mode text renderers into `humanForm` — **P2**
`envelope.ts::humanForm` (15 lines) pretty-prints JSON for every non-string success payload; Vercel's
`output.rs` has per-action renderers. Port the highest-value ones (confirmation prompt **with the literal
follow-up command**, dialog status, "X saved to Y", tabs table), gated by `action`. Matters for
interactive/manual use, not the `--json` host hot path.
- Keyless. Source: `vercel-top5dx.md §"--json envelope"`.

### I5. Per-command correlation sequence number — **P3**
No per-call id in the envelope, so a `--json`-logged multi-step session can't line up a specific failed
command against a log. Add a monotonic per-command sequence number scoped to the session sidecar (not a
UUID — no new entropy/dep); leave the no-leak invariant on `error` untouched.
- Keyless. Source: `agentql-top5dx.md #4`.

---

## Priority index (do-order)

**P0 (now):** A0 skip-settle-on-reads · A1 token-format defaults · B0 `repl` (High effort) ·
E1 `<secret>` write-path · G1 SKILL ToC · G2 eval harness.

**P1 (soon):** A2 tree cache · A3 opt-in daemon · A4a batch conn-reuse · C1 format-hints ·
D1 self-healing resolution cache · E2 confirm preview · E3 semantic-injection heuristic ·
F1 `task compile` · G3 relative-path links · G4 web-task Hard Rules · H1 `--engine firefox`.

**P2 (when convenient):** A4b batch short-circuit · A5 owned-CDP (strategic) · B1 coordinate verbs ·
C2 network-quiet gate · C3 depth ladder · E4 download/permission · E6 static stealth · F2 doctor UX ·
G5 skill catalog · G6 tonal craft · I1 extract shortcut · I2 semantic memory · I3 subagent `--after` ·
I4 human-mode renderers.

**P3 / optional:** E5 pre-flight hit-test · I5 correlation id · viewport 1440 alignment ·
focus-emulation multi-tab · proactive crash detection.

---

## Confirmed non-gaps — Silver already matches or beats (do NOT re-adopt)

- **Perception representation:** downsampled/diffed a11y-tree, `eN` refs + generation-staleness gate,
  shorter-of-diff-or-full-tree, never-truncate contract, password redaction. Independently converged,
  and the per-node encoding is *leaner* than Vercel once url/level are stripped (A1).
  (`aside-top5dx #2`, `vercel-top5dx #2-3`, `measure-tokens`)
- **Runtime error taxonomy:** 13 closed codes, each message = the recovery instruction, plus
  `retryableByHost` — stronger and better-fit than Vercel's typeless runtime errors and Stagehand's
  21-class hierarchy. Do NOT port the OOP class shape. (`vercel-top5dx`, `stagehand-top5dx #4`,
  `agentql-top5dx #4`)
- **Extract ID-grounding:** ported and *hardened* — forced `list[T]` container, named-warning on
  unresolved ids (vs Stagehand's silent `?? ""`), generation-gated resolve. (`stagehand-extract`)
- **Egress / SSRF / confirm gate:** DNS-rebinding closure + fail-closed non-TTY default *exceed* what's
  documented for Perplexity; three independent defense layers. (`perplexity-top5dx #5`)
- **Content-boundary injection fencing:** active glyph de-fang + on-by-default, stronger than Vercel's
  passive-unpredictability opt-in. (`vercel-top5dx`, `perplexity-top5dx #1`)
- **Session/storage save-restore:** matched, plus AES-256-GCM encryption Vercel lacks. (`vercel-top5dx #5`)
- **Fixed-viewport determinism, subagent cap/depth/own-context invariants, browser-as-daemon isolation +
  3.5× parallelism, CLI-over-MCP (never paid the MCP tax), keyless zero-config install.**
  (`aside-engine §1`, `measure-parallel-coldstart §6`, `agentql-top5dx #1,#5`)

**Do NOT build (excluded — cargo-cult, needs-a-model, or paid-infra):** Rust perception rewrite
(perception is ~5 ms); standalone CDP-reconnect cache (~3 ms); browser-use's decorator action registry
(reopens the quarantine attack surface); Stagehand's two-call extract (doubles latency for a signal one
schema field carries); BrowseSafe's fine-tuned classifier, Web Bot Auth / Ed25519 identity, captcha
solving, network/reputation stealth (all keyed/paid/model-bound); an in-CLI scheduler for
condition-based waits (host/OS schedules — document the recipe instead).
