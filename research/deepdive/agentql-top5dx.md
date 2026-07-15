# AgentQL — Top 5 DX Wins vs Every Competitor, and Silver's Gap

**Lens**: `top5dx` — not "what's technically clever" (see `research/topfive/top5-agentql.md` for the
architecture-level top 5: ID-bridge, deterministic-before-model, caching, fleet, request-id) but
specifically: what makes AgentQL/TinyFish's **developer- and agent-facing experience** beat Stagehand,
Browser Use, Skyvern, Firecrawl, and raw Playwright+LLM, with hard evidence — then whether Silver already
has the mechanism or is exposed to the same failure class.

**Sources read in full**: `/Users/seventyleven/Desktop/researchfms/agentql/AGENTQL.md` (sections 5.4–5.5,
7, 8, 23–25, specifically §24.12 "CLI vs. MCP Architecture Decision", §7.1 auth resolution, the full error
taxonomy tables), `AGENTQL_GAP_05_JS_SDK.md` (JS SDK error-message text, the `agentql`/`agentql-cli`
split-package bug, §7–13). Cross-checked against Silver: `silver/src/cli.ts`, `silver/src/core/errors.ts`,
`silver/src/core/envelope.ts`, `silver/src/core/flags.ts`, `silver/src/extract/transform.ts`,
`silver/src/actuation/actions.ts`, `silver/src/perception/walk.ts`, `silver/package.json`, `README.md`.

---

## 1. CLI-over-MCP as the delivery mechanism — empirically measured, not just asserted

**What AgentQL/TinyFish did**: TinyFish shipped an MCP server first (`agentql-mcp`), then walked it back
in favor of a CLI (`tinyfish agent run --url <url> --goal "<goal>" --sync`), and published the reasoning
with numbers in a blog post titled "We Shipped an MCP Server. Then We Shipped a CLI. The CLI Won."
(`AGENTQL.md:7536-7560`, §24.12):

- Per-MCP-tool-call overhead: **500–2,000 tokens** (schema reference + JSON-RPC envelope +
  serialization) against an actual data payload of **~200 tokens** — a 3–10x overhead ratio.
- 20 fetch operations burn **15K–40K tokens on protocol plumbing alone**.
- Production result: the CLI achieves **7x better task success rate and 40% fewer tokens** than the
  identical workload run through MCP.
- Root cause named explicitly: MCP servers are sandboxed and cannot write files or persist artifacts —
  every byte of output must transit the model's context window, so large extraction tasks fill the
  context with tool-call overhead before the task completes, causing mid-task reasoning degradation.
- Stated architectural lesson: MCP suits *low-frequency, high-value* calls (code exec, DB writes); CLI
  suits *high-frequency data fetching* where output volume exceeds what should live in-context.

**Why it beats every competitor**: this isn't a taste preference, it's a benchmarked 7x/40% number from
production traffic — most of the field (Playwright MCP, agent-browser's MCP mode, various "browser agent"
MCP wrappers) ships MCP-first and eats the schema+envelope tax on every single tool call without ever
measuring it.

**Silver's status — has it, and never had the tax to begin with.** Silver was never MCP-first: `cli.ts`
is explicitly "A THIN dispatcher: parse argv, apply the phase-quarantine registry gate, run the handler,
and turn any throw into a sanitized failure envelope" (`cli.ts:5-7`), output is one-line JSON to stdout
via `print()` (`envelope.ts:47-50`), designed for shell piping (`jq`/`grep`/`sort` composition, same
pattern TinyFish converged on). Silver's per-command envelope is `{success, data, error, warning?}` — no
schema-reference tax, no JSON-RPC framing, no persistent MCP session object. Silver's README states this
as a first-class design constraint: "**100% keyless** — no model call anywhere in the tool" and ships as
a single binary a shell invokes directly (`README.md:6-7`, `silver/package.json` `bin.silver`).

**Residual gap (small, worth naming)**: nothing stops a *host* from wrapping Silver's CLI behind an MCP
tool adapter — at that point the same 500–2,000-token schema/envelope tax TinyFish measured would
reappear at the wrapper layer, outside Silver's control. Silver's only lever here is keeping its own
per-command JSON envelope as terse as possible (already true — no wrapper metadata, no schema echo per
call) so that *if* a host wraps it in MCP, the plumbing tax is minimized rather than compounded.

**Tier: HAS IT — Silver is architecturally ahead of where AgentQL started, not behind. No action needed
beyond keeping envelopes terse.**

---

## 2. One IR for locate-and-extract, with free-text as strict sugar (not a parallel code path)

**What AgentQL does**: `/api/v2/query` (locate → returns `tf623_id` refs) and `/api/v2/query-data`
(extract → returns typed values) share an **identical request shape** — `query`, `accessibility_tree`,
`metadata`, `params.mode`, `request_origin` — differing only in endpoint path and terminal interpretation
(`AGENTQL.md:456-476`, pattern #6 in `research/sources/agentql.md`). And `page.get_by_prompt("the login
button on the top right")` is not a separate NL pipeline — it compiles to a single-field query,
`{ page_element(the login button on the top right) }`: an `IdNode` named `page_element` whose
*description* field is the raw prompt (`AGENTQL.md:436-442`, `8700-8712`: "The description IS the
prompt."). One parser, one AST, one server contract, whether the caller writes structured AQL or plain
English.

**Why it beats every competitor on DX**: Stagehand exposes three separate primitives (`act()`,
`extract()`, `observe()`) with different mental models and different call shapes for what is
conceptually "find the right node(s), then decide what to do with them." Browser Use leans almost
entirely on free-text with no structural fallback, so callers get no client-side validation and no
predictable output shape. AgentQL's bet — one IR, NL is sugar for the degenerate single-field case — means
a developer never has to learn "which of these three functions do I call for this," and gets client-side
syntax validation (duplicate-identifier detection, unclosed-brace errors) for *free* even when they're
just typing a prompt, because the prompt gets wrapped into the same grammar before anything is sent.

**Silver's status — has the locate half, has a real gap on the extract half.**
- **Locate**: `find` (`silver/src/actuation/actions.ts:66-90`) is a genuine "no snapshot, no model call"
  semantic tier — `role|text|label|placeholder|testid|first|last|nth` — resolved directly through
  Playwright's `getBy*` locators. This is arguably a *stronger* instance of "sugar over one IR" than
  AgentQL's, because Silver is keyless: there is no server-side NL-to-query compilation step to sugar
  over in the first place. The host LLM itself picks the kind (`role`/`text`/etc.), which is the correct
  place to put that judgment call for a tool with no model of its own.
- **Extract**: `buildBundle()` (`silver/src/extract/transform.ts:149-168`) **requires a JSON Schema**
  (`schema: JsonSchema`) every time; `instruction` is only ever an optional *addendum* appended to the
  fixed system prompt (`transform.ts:158-161`) — there is no equivalent to `get_by_prompt`'s
  zero-schema, single-field convenience path for "just get me this one thing" without first authoring a
  schema. A caller who wants one string back (e.g. "the current price") must still hand-write
  `{"type":"object","properties":{"price":{"type":"string"}}}` — friction AgentQL's sugar path
  eliminates entirely for the common one-field case.

**Recommendation**: add a small, bounded convenience wrapper — e.g. `extract --field <name> --prompt
"<text>"` that auto-builds `{type:"object", properties:{<name>:{type:"string", description:<prompt>}}}`
before handing off to the existing `buildBundle()` pipeline. Zero new grammar, zero new IR — literally
the same "wrap free text into a single-field schema" trick AgentQL uses, applied to Silver's existing
schema-transform path.

**Tier: GAP — small, cheap, medium priority (removes real onboarding friction for the single most common
extract shape: "grab this one value").**

---

## 3. An explicit cost/quality dial on every perception call, not a fixed internal choice

**What AgentQL does**: `params.mode: "fast"|"standard"` is present on every locate/extract call in both
SDKs and the REST endpoint (`AGENTQL.md:993-1013`, §8.3; `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:545-573`,
`RestUrlQueryParams.mode`). `fast` (default) routes to a lighter model; `standard` escalates. TinyFish's
own benchmark framing (89.9% Mind2Web overall vs. 61.3% for OpenAI Operator, only a 15.6-point
easy→hard degradation vs. 39.9–58.0 for pure-VLM competitors) is explicitly attributed to routing most
*mechanical* steps to the cheap tier and reserving the expensive tier for the ~20-30% of steps that are
real decision points (`AGENTQL.md:6991-6995`).

**Why it beats every competitor**: most competing tools make this tradeoff invisibly and permanently
(one model, every call) or leave it to the caller to configure a whole different client. Exposing the
dial as one param on every single request lets the *caller* — not the vendor — decide per-call whether
this step is mechanical (cheap) or a real decision (expensive), which is exactly the lever TinyFish's
own numbers say matters most for cost and reliability.

**Silver's status — has the mechanism, but it's implicit/output-shaped rather than a named dial.**
Silver is keyless, so there's no model-tier axis to route on the server. The direct analog is **how much
of the page gets serialized for the host to read** — since Silver's "cost" is host-model tokens spent
reading a snapshot, not server-side inference tier. Silver already exposes this as three real flags:
`-i` (interactive-only elements — the cheap/fast tier: fewer, cleaner nodes),
`-d`/`--depth` (semantic-depth cap, `walk.ts:61-62`, hard-ceiling 50), and `-s`/`--selector` (scope to a
subtree) (`flags.ts:14`, `187-192`). The `output_overflow` error even names these two flags directly as
the escape hatch when a snapshot is too large (`errors.ts:72-76`): *"narrow the scope with -d (max
depth), -s (selector scope), or a ref to snapshot a subtree instead of the whole page."* Functionally
this **is** AgentQL's fast/standard dial, aimed at the host-token axis instead of the server-inference
axis — Silver just never names it as one dial in its own docs/help text.

**Recommendation (presentation-only, cheap)**: name `-i` explicitly as the "fast" default and full
(`-i` omitted) as "standard" in `README.md`'s Quick start and in `silver skill --full`, so agents reach
for it as a first-class cost lever rather than discovering it only after hitting `output_overflow`.

**Tier: HAS IT (mechanism) — GAP is purely discoverability/naming, low priority.**

---

## 4. Recovery-embedded error messages — but AgentQL's own split-package bug is the cautionary tale

**What AgentQL does well**: a closed, numeric error taxonomy (`APIKeyError=1000`,
`QuerySyntaxError=1010`, `AccessibilityTreeError=1005`, `ElementNotFoundError=1006`,
`PageCrashError=1013`, plus server-side `AgentQLServerError=2000`/`AgentQLServerTimeoutError=2001`),
every response (success or failure) carrying a `request_id` UUID for support correlation
(`AGENTQL.md:542-550`), and long, patient, instructive message text — e.g. the timeout message
explicitly tells the caller the server allows **up to 15 minutes** per request and to pass a longer
`timeout` argument rather than assume something hung (`AGENTQL_GAP_05_JS_SDK.md:202`), and a
`SUPPORT_MESSAGE`/`REQUEST_ID_MESSAGE` pair auto-appended to most errors pointing at
`support@tinyfish.io`/Discord (`AGENTQL_GAP_05_JS_SDK.md:198-200`).

**What AgentQL gets wrong — a real, documented DX failure**: the API-key error message says *"Please set
a valid AgentQL API key by invoking `agentql init` command..."* but the `agentql` npm package does **not**
install any CLI — `agentql init` lives in a **separate** package, `agentql-cli@1.17.2`, that the user must
`npm i -g agentql-cli` explicitly, and the error message never says so
(`AGENTQL_GAP_05_JS_SDK.md:705-718`). This is a first-error-experience bug: the very first thing a new
user hits (missing key) tells them to run a command that isn't installed.

**Silver's status — already stronger on the core mechanism, confirmed gap on correlation only.**
`silver/src/core/errors.ts` defines 12 closed codes, each pairing a `retryableByHost: boolean` with a
message that **is itself the exact recovery command** — e.g. `ref_stale`: *"run `snapshot` again and
retry with fresh refs"*; `output_overflow`: names the exact flags to pass (`errors.ts:12-86`). This is a
harder DX guarantee than AgentQL's free-text-plus-code approach: the host LLM never needs a lookup table
mapping code→action, the message *is* the action. Silver also cannot repeat AgentQL's split-package bug
by construction — it ships as one npm package with one dependency (`playwright`) and one bin entry
(`silver/package.json:8-9,24-26`), so there's no "install the other package first" failure class at all.
**Confirmed gap**: `envelope.ts`'s `fail()` deliberately does not interpolate `ctx` into the message (a
correct no-leak choice — `envelope.ts:33-41`), so there is no per-call correlation id anywhere in an
envelope; a multi-step `--json`-logged session has no cheap way to line up "this specific failed command"
against a log after the fact the way `request_id` lets AgentQL support do.

**Recommendation**: add a monotonic per-command sequence number (not a UUID — no new entropy/dependency)
scoped to the session sidecar, purely for log correlation; leave the no-leak invariant on `error` itself
untouched. (Same recommendation as `top5-agentql.md` item 5 — restated here because it is squarely a DX
gap, not just an architecture nit.)

**Tier: HAS IT (core mechanism, stronger) — GAP (correlation id) small, low priority.**

---

## 5. Zero-setup-friction entry point — and keyless removes an entire DX category outright

**What AgentQL does (well, relative to hand-rolled auth)**: a predictable 4-tier credential resolution —
explicit `configure(api_key=...)` > `AGENTQL_API_KEY` env var > `~/.agentql/config/config.ini` > legacy
`~/.agentql/config/agentql_api_key.ini`, auto-migrated to the new path on first read
(`AGENTQL.md:536-541`, pattern #13). This is genuinely good config-file DX: standard precedence order,
plus graceful migration so upgrading the SDK never silently breaks an existing install.

**Why it still loses to Silver on DX, structurally**: every one of AgentQL's competitors (and AgentQL
itself) requires a signup, an API key, a billing tier, and a 4-tier resolution dance *before the first
successful call* — Free Trial caps at 300 total calls / 10-per-minute, Starter is metered per-call past
50 free (`AGENTQL.md:` Pricing table, §6). None of that is a code-quality problem, it's an unavoidable
consequence of being a hosted, server-side-AI product.

**Silver's status — has it, structurally superior, not just "no bug to have."** Silver is
**keyless by construction** (`README.md:6-7`, `cli.ts:19`: "KEYLESS: no model call anywhere") — there is
no credential-resolution surface to design well or badly, because there is no credential. Install is
`pnpm install && pnpm build && npx playwright install chromium` and the tool works
(`README.md:31-35`); there is no signup, no rate-limited free tier, no metered-per-call pricing gate
between a fresh clone and a working first command. This isn't "Silver copied AgentQL's auth pattern and
did it better" — it's that Silver's keyless design **eliminates the entire problem class** AgentQL had to
solve gracefully. Silver's own README explicitly frames "installable into any sandbox with zero config"
as a top-line differentiator (`README.md:6-7`), and the Quick start block runs six real commands with zero
credentials in any of them (`README.md:47-53`).

**Tier: HAS IT — structural advantage, no gap, nothing to adopt (AgentQL's 4-tier resolution pattern is
worth knowing as *prior art* only if Silver ever grows an optional hosted/keyed mode).**

---

## Summary Table

| # | DX dimension | AgentQL's beats-competitors mechanism | Silver status |
|---|---|---|---|
| 1 | CLI over MCP | Measured 7x task success, 40% fewer tokens vs. MCP (`AGENTQL.md:7536-7560`) | **Has it** — CLI-native from the start, never paid the MCP tax |
| 2 | One IR, prompt = sugar | Same request shape for locate/extract; `get_by_prompt` = single-field query | **Has it (locate)** via `find`; **GAP (extract)** — no zero-schema single-field shortcut |
| 3 | Explicit cost/quality dial | `params.mode: fast\|standard` on every call | **Has it** via `-i`/`-d`/`-s`; **GAP is naming/discoverability only** |
| 4 | Recovery-embedded errors + correlation | Numeric taxonomy + `request_id`, but real "agentql init" split-package bug | **Has it, stronger** (message = exact recovery command); **GAP** — no per-call correlation id |
| 5 | Zero-friction entry point | 4-tier key resolution w/ legacy auto-migration | **Has it, structurally ahead** — keyless removes the whole category |

**Net read**: on all five DX axes AgentQL is genuinely praised for, Silver already has the underlying
mechanism — in three cases (#1 CLI-vs-MCP, #4 error-message quality, #5 zero-friction install) Silver is
architecturally ahead rather than merely at parity, because being CLI-native and keyless from day one
sidesteps problems AgentQL had to engineer solutions for after the fact. The two real, bounded gaps are
cheap: a zero-schema single-field `extract` shortcut (#2) and a per-command correlation sequence number
(#4) — both small, additive, no new dependency, no DSL, no scope creep.
