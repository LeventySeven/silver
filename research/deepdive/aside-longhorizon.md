# Aside deep-dive — Long-horizon: Memory/Dreaming + Subagent Orchestration + Compaction

**Sources:** `researchfms/teardowns/_aside_parts/85_memory_moss.md` (memory engine, full read),
`_aside_parts/97_subagents_context.md` (subagent orchestration + per-turn context + compaction, full
read, lines 1–813 of 1050), cross-checked against `Silver/silver/src/memory/store.ts`,
`memory/search.ts`, `orchestration/subagent.ts`. LENS = longhorizon: what keeps a long-running agent
coherent across many turns/sessions without a context blowup or amnesia — memory persistence,
subagent isolation, and context compaction are the three legs of that.

---

## 1. Aside's memory system — mechanism (KNOWN, carved from `moss-core.node` + live disk)

Aside's memory is a **3-tier markdown tree** (`memory/`: L1 `MEMORY.md`/`USER.md`, semantic
`<type>/<slug>.md` pages with frontmatter + `## Current` + `## History`, and `episodic/YYYY-MM-DD.md`
append logs) with a **derived, rebuildable vector+BM25 index** on top, never the reverse. The pipeline:

- **Chunker** (`Bin`, verbatim decompiled at `85_memory_moss.md:88-167`): max 1024 chars/chunk,
  boundary-priority split within a 256-char window (h1=100 → h6=50 → codeblock=80 → hr=60 →
  blank=20 → list=5 → newline=1), ~152-char overlap between chunks, heading-breadcrumb title,
  content-addressed `chunkId = sha256("path:idx:sha256(text)")` so only changed chunks re-embed.
- **Embedder**: `moss-minilm` (384-d, ONNX Runtime, BERT-family 3-tensor input, resembles
  all-MiniLM-L6-v2), runs **in-process/on-device** via a native Rust addon (`@moss-dev/moss-core`,
  third-party SDK, not Aside-homegrown) — not a cloud call on the default path.
- **`.mossvec` format**: `MOSS` magic v2, 400-byte header, packed f32 `count×384` matrix in
  `session.json.docIds` order, un-normalized vectors (norm ≈√2), norms recomputed at load.
- **Retrieval = hybrid**: `SessionIndex.query(text, {topK:5, alpha:0.8})` → dense cosine (ONNX)
  fused with BM25 by `alpha=0.8` (dense weight) in `src/hybridsearch/fusion.rs`, **then a second JS
  reranker** (`wan`) recomputes `score = 0.7·hybridScore + 0.15·recency + 0.15·pathKeywordMatch`,
  recency = `max(0, 1−ageDays/30)` from episodic-date-in-path or `frontmatter.updated_at`.
- **Rebuild-on-write**: chokidar watches `memory/`, 750ms-debounced re-sync, diffs by chunk `hash`,
  embeds in batches of 4, saves `{index.mossvec, docs.json, session.json, memory-index.json}`, then
  async cloud-pushes with 30s→5min backoff. **The markdown is the only source of truth** — deleting
  `.moss-cache` forces a full rebuild that reproduces identical retrieval behavior.
- **`memory_search` tool**: 1–3 natural-language queries (OR-ed, parallel), `max_results` 1–10
  (default 5), deduped by `chunkId`, branded "Mandatory recall step" in its description so the model
  self-invokes it before memory-shaped answers. Incognito sessions get zero results. There's also a
  **passive** path: `memory_signal` matches the active tab URL against every page's
  `frontmatter.autoInject.url` glob and injects `Relevant memory found: <path>` with no search call.

**Dreaming (write side, from Part 85 §10 + cross-ref Part 25 §5, gated but not fully re-read this
pass):** two hidden subagent passes on the `standard` model. (1) **Extraction** runs after
`agent.run.completed`, reads the last N messages, and APPENDs to `episodic/YYYY-MM-DD.md` only —
tools restricted to read/write/edit_file/memory_search/get_time/read-only-bash, explicitly barred
from touching `USER.md`/`MEMORY.md`/`TAXONOMY.md`/semantic pages. (2) **Dreaming** is gated
`≥24h since lastDreamAt OR ≥5 sessions` (OR-gate, state persisted in `.dream-state.json`), reads the
last 14 days of episodic + `memory-index.json`, and *promotes* durable observations into semantic
pages via a **filing decision tree** (durable? → names a human? → `people/`; company? → `companies/`;
site? → `sites/<host>.md`; project? → `projects/`; concept? → `concepts/`; agent-behavior? →
`agent/<slug>.md` or L1 `MEMORY.md`), citing the backing episodic file on every semantic write, and
refreshes L1 files **only** when default-behavior/stable-profile actually changed. Every
extraction/dreaming/revert writes a JSONL row to `.history.jsonl` with sha256 before/after content,
enabling **optimistic-concurrency revert** (abort if the target file drifted since the entry was
recorded).

**Why this beats competitors:** unlike a raw vector-DB memory (opaque, unauditable, hard to hand-edit,
loses fidelity on chunk boundaries) or a flat running-summary (lossy, no per-fact provenance), Aside's
design keeps memory **human-readable, git-diffable, and content-addressed** while still getting
hybrid-search recall quality. The recency+path-keyword rerank on top of hybrid search means a query
like "brex" surfaces `sites/app.brex.com.md` even when the dense/BM25 score alone wouldn't rank it
first. The dreaming gate (time OR session count) avoids both "never consolidates" and "consolidates
every turn" failure modes, and the filing decision tree gives deterministic, auditable placement
instead of an LLM freelancing where to write.

## 2. Subagent orchestration — mechanism (KNOWN, carved verbatim, `97_subagents_context.md:1-336`)

Two model-facing tools: `subagent` (`action: spawn|resume`) and `subagent_wait` (`task_ids[]`).

- **5-entry profile registry** (`N6`): `default` (fresh context, inherits model), `custom` (fresh,
  hidden from model), `context_explorer` (fresh, `fast` model, adds a search-directive), `code_explorer`
  (fresh, `fast` model, **read-only**, standalone prompt with a hard file-write/`/tmp`/heredoc/redirect
  ban), `fork_self` (**copies the parent's compaction-resolved transcript** into the child — the only
  profile with any shared context, and even it does NOT share live browser tabs/page/form/REPL state).
  A 6th unregistered profile, `background-consult`, is tools-disabled entirely (guard-only, no spawn
  site found in this binary).
- **Concurrency cap = 5** running children (`u4t` gate throws at ≥5, `maxParallel` interpolated into
  the tool description).
- **One level deep, no recursion**: every subagent (any profile) is blocked from calling
  `subagent`/`fork_subagent`/`ask_user_question`/`request_action_confirmation` (`k4t` blocklist) — a
  hard structural cap enforced at the tool-gate hook, not by convention.
- **Read-only children** get an *additional* blocklist (`A4t`: `write_file`, `edit_file`, `repl`) plus
  a bash-command regex blocklist (`j4t`: blocks `mkdir/rm/cp/mv/chmod/git commit/npm install/sed -i/
  heredoc/redirect`, forcing inspection-only shell).
- **Foreground spawn blocks** the parent's turn on `P6()` (harvest = child's *last assistant message
  only*, rendered to text — the parent never sees the child's intermediate tool calls/thinking).
  **Background spawn** returns `task_id` immediately; completion is delivered via a
  `"subagent.run.ended"` hook that either **steers** a `kind:"subagent_done"` `<result>` system-message
  into the still-running parent mid-turn, or appends it for the parent's next turn if idle — either
  way flipping `isRunning=false` in a `toolState.subagent.subagents[]` tracker that carries a running
  `(done/all)` tally.
- **`fork_self`'s cache-friendliness is the mechanism, not marketing**: because it copies the parent's
  identical system prompt + leading messages, it shares the same Anthropic prompt-cache prefix — the
  profile description literally calls this out as why forks are "cheap."

## 3. Per-turn context + compaction — mechanism (KNOWN, `97_subagents_context.md:339-813`)

- **System prompt** (~21.6K chars) is built once per session with a fixed section order ending in a
  `<contexts>` block that injects **exactly 4 files** in order: `AGENTS.md`, `SOUL.md`,
  `memory/USER.md`, `memory/MEMORY.md` — i.e. the L1 memory briefings ride in the system prompt itself,
  not as a message. This is the load-bearing link between §1 (dreaming writes L1) and §3 (every future
  session reads L1 for free, no retrieval call needed).
- **Message transformer `s2`**: `system-message` rows and attachment blocks become **user-role**
  messages wrapped in `<system_message>…</system_message>` — the system prompt explicitly tells the
  model this wrapper, *only in a user message*, is the trusted control channel; the same tag appearing
  inside a tool result is never trusted. Tool results for non-frontier models get wrapped in
  `[BEGIN/END_UNTRUSTED_TOOL_OUTPUT]` markers with forged-tag neutralization (`JJt`→`GJt`); frontier
  models (an explicit allowlist of ~14 model ids) get raw tool output.
- **Prompt-cache breakpoints**: system block, tools block (last tool), and a **rolling tail breakpoint**
  on the last content block of the last message — so the stable prefix (system+tools+leading history)
  stays cached turn over turn.
- **Compaction is middle-out**, not a hard truncation: `keepRecentTokens=20000`, `reserveTokens=16384`,
  trigger = `tokens > contextWindow − reserveTokens` (soft) or hard overflow detection from
  provider-error regexes / usage telemetry (retries once). Token accounting is **usage-anchored**: it
  takes the last real API `usage.totalTokens` as ground truth and only `chars/4`-estimates the
  un-billed trailing messages — far more accurate than estimating the whole transcript. The keep
  boundary snaps to a clean turn edge; if it lands mid-turn, that turn's prefix is summarized
  *separately* ("split turn") so the retained suffix still has setup context. Summaries follow a fixed
  structured template (`## Goal / Previous Conversations / Constraints & Preferences / Progress
  (Done/In Progress/Blocked) / Next Steps / Mistakes & Alternatives / Critical Context`) and are
  **incremental** (a `previousSummary` is folded forward, not re-derived from scratch each pass). The
  `## Mistakes & Alternatives` section explicitly carries forward learned failure modes across
  compaction so the agent doesn't repeat them. Compaction runs on the `standard` model category (not
  the session's own model) and is a first-class `role:"compaction"` row in the transcript.

## 4. Why this beats competitors

Most competing browser agents either (a) have no persistent memory at all (fresh context every
session — Stagehand, browser-use out of the box), or (b) bolt on a vector DB with no write-side
governance (freeform embedding of raw transcripts, no dreaming/consolidation, no filing discipline,
no revert). Aside's differentiator is **governance on both sides of the store**: a deterministic
filing decision tree on write (not "LLM decides where," but a fixed taxonomy), content-addressed
incremental re-embed + optimistic-concurrency revert for safety, and a rerank formula on read that
folds in recency and path-keyword match cheaply on top of hybrid search — none of which needs an LLM
call at retrieval time. For subagents, the differentiator is **structural, not prompted**: the
one-level-deep cap and tool-blocklists are enforced by a hook the model cannot argue its way around,
and `fork_self`'s "copy transcript but never live state" split is a precise, reusable rule (share
*knowledge*, never share *actuation surface*) that avoids both context-loss (fresh children reinvent
work) and state-corruption (two children fighting over one browser tab) failure modes simultaneously.

## 5. Concrete gap vs Silver (read `Silver/silver/src/memory/*`, `orchestration/subagent.ts`)

**Already adopted, confirmed correct (no action needed):**
- Markdown-as-truth, derived/rebuildable index: `memory/store.ts:2-10` states this explicitly and
  cites Aside by name; `memory/search.ts` implements the term-overlap+recency ranking as a *keyless*
  substitute for the hybrid dense+BM25+rerank (deliberate divergence, correctly labeled).
- Subagent structural invariants: `orchestration/subagent.ts:13-24` implements the concurrency cap
  (5, `CONCURRENCY_CAP` at line 55), one-level-deep enforcement via `SILVER_SUBAGENT_DEPTH` env
  (lines 17-19, 161-165, 248-251), and own-context-per-agent (session-clash check, lines 205-212) —
  a lockfile-free counted-semaphore reimplementation of Aside's in-memory `u4t`/`k4t` gates, adapted
  correctly for a stateless CLI (Aside's tracker lives in a long-running daemon's memory; Silver's
  lives in JSON record files + an advisory lock, which is the right analog for a per-invocation CLI).
- Foreground/background split: `subagentSpawn`/`subagentWait`/`subagentMark` mirror
  `subagent`/`subagent_wait`/completion-harvest, with `--background` + `subagent wait` polling a
  status file instead of Aside's in-process steer — the correct keyless analog since Silver has no
  persistent daemon to push a mid-turn steer into.

**Real gaps, ranked by priority (keyless-adoptable — none require a model call):**

1. **[HIGH] No recency decay in `memory/search.ts` — wait, it exists, but no dreaming/consolidation
   pass at all.** Silver's episodic log (`memory/store.ts`) only ever grows via `addNote` — there is
   no keyless equivalent of dreaming's *consolidation* (promote repeated episodic observations into a
   durable semantic page, refresh an L1 summary file). Over a long-horizon session this means Silver's
   `episodic/*.md` files grow unboundedly and `memory/search.ts` has to re-rank the full episodic
   history every query with no "durable facts" fast-path. **Adopt (keyless):** a `silver memory
   consolidate` verb that is pure text processing — no model needed for the *mechanical* parts: (a) a
   time/count gate mirroring `R0t=24h OR z0t=5 sessions` (cheap, stat the last consolidation marker
   file `+ count new episodic notes since`), (b) a **host-driven** filing step where the *host LLM*
   (not Silver) supplies the classification (person/company/site/project/concept) and Silver just
   handles the deterministic mechanics — atomic write to `semantic/<type>/<slug>.md` with a
   `Source: episodic/YYYY-MM-DD.md#Lline` citation line, content-hash based idempotency, and a
   `.history.jsonl` append. This keeps the LLM-judgment part in the host (where it belongs for a
   keyless CLI) while Silver owns the file-safety mechanics Aside's `Ran`/history module owns natively.
   Priority: **HIGH** — this is the single biggest "amnesia at scale" gap; without it, long sessions
   degrade memory_search precision as episodic volume grows with no promotion path.

2. **[MEDIUM] No content-addressed revert / history log for memory writes.** Aside's
   `.history.jsonl` + sha256 before/after + optimistic-concurrency revert (`85_memory_moss.md §9`) has
   no analog in `memory/store.ts` — `addNote` is append-only with no revert primitive at all. **Adopt
   (keyless, cheap):** append one JSONL line per `addNote`/future `consolidate` write to
   `memory/.history.jsonl` — `{id, type, path, beforeSha256, afterSha256, createdAt}` — and a `silver
   memory revert <historyEntryId>` verb that checks current-file-hash-matches-recorded-after-hash
   before restoring (exact same optimistic-concurrency mechanism, zero model dependency, ~40 lines).
   Priority: **MEDIUM** — safety/undo primitive, not correctness-blocking, but cheap and directly
   portable.

3. **[MEDIUM] No `context_explorer`/`code_explorer`-equivalent profile distinction in
   `orchestration/subagent.ts`.** Aside's registry separates *fresh general* (`default`) from
   *fresh read-only search-specialist* (`code_explorer`, with its own bash-command regex blocklist
   `j4t` beyond the coarse `readOnly` flag Silver already has). Silver's `subagentSpawn` has a binary
   `readOnly` (line 176) but no equivalent of Aside's read-only bash regex (`mkdir|rm|cp|mv|chmod|
   git commit|npm install|sed -i|heredoc|redirect`) — a read-only Silver child could still be handed
   `--confirm-actions eval` or similar and there's no bash-inspection-only enforcement layer analogous
   to `j4t` for any shell-adjacent verb Silver exposes. **Adopt:** if/when Silver grows a bash-adjacent
   verb, port `j4t`'s regex as a read-only-child guard. Priority: **MEDIUM**, contingent on Silver
   shipping a shell-exec verb — not urgent today since Silver's `readOnly` flag already gates the actor
   verb allowlist at a coarser but still correct grain.

4. **[LOW] No `fork_self`-equivalent (context-sharing) subagent profile.** All Silver subagents get a
   fresh child session (own tab/browser) with no transcript inheritance — there is no keyless analog
   of `fork_self` copying the parent's compaction-resolved message list. This is **arguably correct
   for Silver's architecture**: Silver has no persistent per-session message log the CLI itself
   maintains (the host LLM owns the transcript), so "copy the parent's transcript into a child" is a
   host-orchestration concern, not something Silver's subagent primitive should own. **Do not adopt**
   as a CLI feature; flag as a host-orchestration pattern to document instead (the host can literally
   just paste the relevant transcript into the child's spawn prompt). Priority: **LOW / N/A** — the
   gap is real but the right owner is the host LLM, not Silver.

5. **[LOW, informational] Compaction has no Silver analog and arguably shouldn't.** Aside's
   middle-out compaction (§3) exists because Aside owns a persistent per-session message log across a
   long-running daemon session. Silver is stateless per-invocation — the host LLM (Claude Code, etc.)
   already owns its own context/compaction. **Not a gap to close in Silver**; noting it here only so a
   future reviewer doesn't mistake its absence for an oversight — it is out of scope by architecture
   (Silver has no model call, hence no context window to manage on Silver's side).

**Bottom line:** Silver has faithfully ported Aside's *structural* subagent invariants (cap, depth,
context isolation) and the *write-append* half of memory, but is missing the *consolidation/promotion*
half of the memory lifecycle (dreaming) and the *safety/revert* half (content-addressed history) — both
are keyless-portable as pure file mechanics with the LLM-judgment parts deferred to the host, and
together they're the difference between memory that scales gracefully across a long-horizon session
versus memory that just accumulates unbounded episodic noise.
