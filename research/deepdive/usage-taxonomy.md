# Usage Taxonomy — what AI agents actually do with a browser, and which Silver verb/mode serves each

Scope: a broad, generalized map of browser-agent use cases (not the reductive
"Vercel = quick, Aside/Webwright = long"). For each category: the **goal**, the
**Silver command sequence**, and the **mode** it wants (quick / long-task /
parallel-session / shared-tab / subagent-fanout). This is the decision spine for
the SKILL's "which shape do I reach for" guidance.

All claims below are grounded in Silver's actual code. The five real modes Silver
exposes (not marketing labels) are:

1. **Quick / lean loop** — `open → snapshot -i → act → re-snapshot`, one shell
   invocation per step, browser-as-daemon persists between invocations
   (`src/core/handlers.ts:193` `withConnection`, `:175` `ensureConnected`
   auto-spawns/reconnects over CDP). This is the atom every other mode composes.
2. **Batch** — many verbs in ONE process, one shared session, per-command
   pass/fail (`handlers.ts:2294` `handleBatch`). Cuts per-command Node+CDP
   startup for fire-and-forget setup.
3. **Long-task** — durable run folder (plan.md + append-only action_log.jsonl +
   screenshots/ + checkpoint.json) that survives a crashed host and is resumable
   (`src/task/index.ts:84` `taskStart`, `:200` `taskResume`, `:227` `taskExec`).
4. **Parallel** — two shapes: **own-browser-per-agent** (`--session <name>`, the
   safe default, live state never shared, per-session advisory lock at
   `src/core/lock.ts`), and **shared-browser-one-tab-per-agent** (`connect
   <endpoint>` then `tab new`, `handlers.ts:698`/`:583`). Groups isolate under
   `--namespace`.
5. **Subagent fan-out** — scoped child units of work (own session OR own tab),
   cap 5, one-level nesting, own-context-per-agent, all enforced in code
   (`src/orchestration/subagent.ts:157` `subagentSpawn`). Silver is keyless, so a
   "subagent" is a reserved scope + recorded task the HOST's own sub-agent drives
   — never an in-CLI model loop.

Cross-cutting: **read-only by default**; actor verbs are quarantined behind
`--enable-actions` at the registry gate (`src/cli.ts:98`), and actor sub-ops
(`network route`, `storage set`, `wait --fn`, `task exec`, `subagent spawn`,
`eval`, `clipboard write`) re-check the grant inside their handler. Page output is
untrusted-fenced + neutralized + capped (`presentPageText`, `handlers.ts:270`).
Grep-first `memory` (`src/memory/index.ts`) is orthogonal and layers onto any
category for cross-run recall.

---

## 1. Quick lookup / read ("what does this page say?")

**Goal:** pull a fact, price, status, or short answer off one known page. No
interaction, no login. The single most common thing an agent does.

**Mode:** Quick. Often a *single* command — the cheapest possible path.

**Sequence:**
```
silver read https://example.com/status          # fetch → plain text, no browser spawn needed for the URL form
# or, for a page already open in a session:
silver open <url> --session s
silver get text --session s                      # whole body, neutralized+capped
silver get title --session s                     # just the title
```
`read <url>` (`handlers.ts:785`) fetches server-side with a per-hop egress
re-check (`fetchGuarded`, `:810`) and runs `htmlToText` — no Chromium spawn, the
lightest read. For JS-rendered pages, `open` then `get text`. Use `--max-output`
to bound a big dump; it fails loud with `output_overflow` rather than silently
truncating.

**When to escalate:** if the fact is behind a "Load more"/tab/expander, this
becomes lean-loop (§2). If it's one field in structured data, use `extract` (§5).

---

## 2. Navigate + click + read a specific value (single-page interaction)

**Goal:** reach a value that needs a click, expand, or tab switch first
(accordion, "show details", pagination).

**Mode:** Quick / lean loop.

**Sequence:**
```
silver open <url> --session s
silver snapshot -i --session s                    # interactive-only tree, @eN refs
silver click @e4 --session s --enable-actions     # act on a grounded ref
silver snapshot -i --session s                     # re-perceive: unified diff / "No changes detected"
silver get text @e7 --session s                    # read the now-visible value
```
The re-snapshot is mandatory after any `page_changed:true`/`stale_refs:true` —
refs are generation-scoped and a stale ref fails LOUD (`element_not_found`), never
misclicks (see examples.md §1). `snapshot -c` (compact) and `snapshot -d <n>`
(depth cap) narrow the tree on dense pages.

---

## 3. Deep multi-source research ("compare X across N sites")

**Goal:** gather and cross-reference facts from many pages/sites to synthesize an
answer. The host reasons; Silver is the eyes.

**Mode:** Parallel (own-session-per-source) for speed, OR subagent fan-out when
each source needs its own multi-step sub-investigation. Layer `memory` to
accumulate findings across the run.

**Sequence (parallel sessions):**
```
silver open https://a.com/q --session src-a &
silver open https://b.com/q --session src-b &
silver open https://c.com/q --session src-c &
wait
silver get text --session src-a ; silver get text --session src-b ; ...
silver memory add "A quotes $40, B quotes $38, C out of stock" --tag research,pricing
```
Different sessions never block each other (per-session lock only serializes
same-session commands, `handlers.ts:197`). For 3+ sources each needing several
steps, prefer subagent fan-out (§11) so the host tracks child status explicitly.

**When quick suffices:** 2 sources, one read each → just two `read`/`get text`
calls sequentially. Don't reach for parallelism under ~3 independent units.

---

## 4. Form-filling + auth flows (login, signup, multi-field forms)

**Goal:** fill fields and submit; often to authenticate before the real task.

**Mode:** Quick lean-loop for the form itself; the resulting auth state feeds
§16 (session reuse) so you log in once.

**Sequence:**
```
silver open <login-url> --session s
silver snapshot -i --session s
printf '%s' "$PASSWORD" | silver fill @e3 --stdin --session s --enable-actions   # secret via stdin, never argv
silver fill @e2 "alice" --session s --enable-actions
silver click @e4 --session s --enable-actions                                     # submit
silver get text --session s                                                        # verify "Signed in as alice"
```
`fill` clears + sets + reads back to verify, falling back to char-by-char
(SKILL table). Passwords render `[redacted]` in snapshots and `get value`
(`handlers.ts:1043`), but the `fill` *response* echoes the value — hence
`--stdin` for real secrets (examples.md §2). `submit`/`send`/`subscribe` are
deliberately NOT gated; only paid/destructive names are (§5, §5-gate).
`find role textbox --name username fill "alice"` locates + fills in one call when
you'd rather not snapshot.

---

## 5. Checkout / booking (paid, gated actions)

**Goal:** complete a purchase, booking, or other irreversible/paid action.

**Mode:** Quick lean-loop, but tripping the **paid/destructive confirm gate** on
purpose — this is the category the gate exists for.

**Sequence:**
```
silver open <cart-url> --session s
silver snapshot -i --session s
silver click @e5 --session s --enable-actions
  → error: this looks like a paid/destructive action; re-run with --confirm-actions
silver click @e5 --session s --enable-actions --confirm-actions click             # explicit approval
```
On a non-TTY session, a `click`/`dblclick`/`press` (also `find … click`, raw
`mouse click`, submit-like `keyboard press`) on a control whose accessible name
matches `buy|purchase|checkout|pay|payment|order|delete|remove` is refused with
`confirm_required` BEFORE dispatch (`destructivePaidBlocks`, `handlers.ts:284`;
gate hit-tests raw coords `:307` and focused element `:317` so no bypass). The
host must consciously re-run with `--confirm-actions <verb>`. Grounding runs
first, so a hallucinated `@e999` fails grounding before the gate (examples.md §3).
For a multi-step booking that can crash mid-flow, wrap it in long-task (§10).

---

## 6. Structured data extraction (records with links, prices, IDs)

**Goal:** turn a listing/table into clean structured records — the classic
scraping-to-JSON job — WITHOUT the host fabricating URLs.

**Mode:** Quick, via the keyless ID-grounded `extract` moat. Two-call handshake.

**Sequence:**
```
silver extract --schema '{"type":"object","properties":{"name":{"type":"string"},"url":{"type":"string","format":"uri"}}}' \
  --instruction "list every product with its link" --session s
  → bundle: id_transformed_schema (url field constrained to ^\d+-\d+$),
            prompt, snapshot_with_ids (real url= stripped, links carry id=13-2)
# host runs inference over the bundle, picks IDs:
silver extract resolve --ids '[{"name":"Widget A","url":"13-2"}]' --session s
  → [{"name":"Widget A","url":"http://.../widget-a.html"}]   # CLI maps IDs → real values
```
The host only ever sees element IDs, never real URLs, so a fabricated URL is
*structurally impossible* (`src/extract/transform.ts:1`, the moat;
`handlers.ts:1185`). Object schemas auto-wrap to `list[T]` to stop the
N-collapses-to-1 bug (`ensureContainer`, `transform.ts:113`). Resolve is
generation-gated: re-snapshot between extract and resolve → `ref_stale`, re-extract
(examples.md §4). This is the AgentQL/Stagehand capability, keyless.

---

## 7. Data extraction PIPELINES (many pages → one dataset)

**Goal:** run the §6 extract across a paginated set or a list of URLs and
accumulate a dataset.

**Mode:** Long-task (durable, resumable across a large set) + optionally parallel
sessions per page-shard. Batch for the per-page setup.

**Sequence:**
```
silver task start "scrape all 40 product pages" --id scrape-catalog
for url in $(cat urls.txt); do
  silver task exec scrape-catalog --enable-actions -- open "$url" --session pipe
  silver task exec scrape-catalog --enable-actions -- extract --schema @schema.json --session pipe
  silver task checkpoint scrape-catalog --note "done $url" --session pipe
done
# crash? →
silver task resume scrape-catalog        # remaining plan + last checkpoint + log tail
```
`task exec` re-dispatches each command through the full gate AND auto-logs it
(`task/index.ts:227`); the run folder is the durable artifact so a mid-run crash
loses nothing. For throughput, shard URLs across N `--session` names (§3 pattern)
or N subagents (§11). Persist extracted rows to disk yourself (Silver writes
scaffold, you own the data).

---

## 8. Monitoring / price-watch (recurring check for change)

**Goal:** re-check a page on a schedule and report when a value crosses a
threshold or a "diff" appears.

**Mode:** Quick per-run, invoked by an external scheduler (cron/loop); `memory`
for the baseline; session reuse so auth persists between checks.

**Sequence (one tick):**
```
silver open <watch-url> --session watch
silver get text @e-price --session watch                      # current value
silver memory search "baseline price watch-url"               # recall last seen
# host compares; if changed:
silver memory add "watch-url price dropped to $38 at $(date)" --tag pricewatch
```
Silver has no built-in scheduler by design — the host/OS schedules; each tick is a
cheap lean-loop. The diff-aware snapshot (`observe`, `perception/diff.ts`, wired at
`handlers.ts:768`) returns "No changes detected" or a unified diff, so change
detection is nearly free if you snapshot instead of `get text`. Session reuse
(§16) keeps you logged in across ticks without re-auth.

---

## 9. Testing / QA of a web app (assertions, console, network)

**Goal:** drive an app and assert on state, console errors, network calls,
responsive layout — an agent doing exploratory or scripted QA.

**Mode:** Batch (scripted deterministic sequence) or quick lean-loop
(exploratory). Uses Silver's Playwright-parity surface heavily.

**Sequence:**
```
silver batch \
  "open http://localhost:3000" \
  "is visible @e2" "is enabled @e5" \
  "get count .todo-item" \
  "console" "errors" \
  --session qa --bail
silver set viewport 375 812 --session qa --enable-actions ; silver screenshot mobile.png --session qa
silver network requests --filter /api --method POST --session qa
silver network route "**/api/flaky" --abort --session qa --enable-actions      # fault injection
```
`is visible|enabled|checked` (`handlers.ts:1080`), `get count` (`:1021`),
`console`/`errors` capture (`:1853`/`:1866`), `network requests` with
filter/type/method/status (`:1593`), `network route --abort|--body` for
mock/fault-injection (`:1643`), `set viewport|geo|offline|timezone|locale` for
emulation (`:2137`), `pdf`/`screenshot --full` for visual artifacts. `--bail`
stops the batch on first failure. Emulation overrides are per-connection — set
them in the same flow that needs them (`:2149` note).

---

## 10. Long autonomous tasks (resumable, crash-surviving)

**Goal:** a multi-step goal ("book the cheapest flight under $X, pay, save
confirmation") that may span minutes and must survive a host crash mid-flow.

**Mode:** Long-task. The run folder IS the durability primitive.

**Sequence:**
```
silver task start "Buy cheapest widget under $40" --id buy-widget
# fill plan.md with Critical Points, then drive THROUGH the task so every step logs:
silver task exec buy-widget --enable-actions -- open http://shop/products --session t
silver task exec buy-widget --enable-actions -- click @e5 --confirm-actions click --session t
silver task checkpoint buy-widget --note "order placed" --session t     # + best-effort screenshot
silver task status buy-widget          # plan total/checked/remaining, log size
# fresh agent after crash:
silver task resume buy-widget          # checkpoint + remaining plan + recent log tail → pick up mid-flow
```
`taskStart` scaffolds plan.md/action_log.jsonl/screenshots/checkpoint.json
(`task/index.ts:84`); `taskResume` returns remaining plan + nextSteps +
mistakesAndAvoidance + criticalContext + last screenshot + log tail (`:200`) so a
NEW host session continues without re-deriving context. This is Webwright's
long-horizon capability. Pair with the confirm gate (§5) for the paid step and
memory (§8/§15) for cross-run lessons.

---

## 11. Multi-agent fan-out (parallel child workers under one goal)

**Goal:** decompose a goal into N independent child jobs run concurrently ("scrape
these 5 categories", "fill 3 forms in parallel"), then join results.

**Mode:** Subagent fan-out. The host drives each child; Silver reserves the scope
and enforces the invariants.

**Sequence:**
```
silver subagent spawn "scrape category books"  --name c1 --enable-actions          # own browser, read-only
silver subagent spawn "scrape category music"  --name c2 --enable-actions
silver subagent spawn "fill checkout" --tab --session shared --confirm-actions click,fill --enable-actions
# host drives each child in its own session/tab using the returned childEnv, then:
silver subagent done c1 --text "42 rows"
silver subagent wait c1 c2 sa3            # block until terminal (honors --timeout)
silver subagent list                       # cap 5, running count, each record
```
Enforced in code (`orchestration/subagent.ts:157`): **cap 5** running per
namespace (`:186`), **one level** (a child can't spawn — `SILVER_SUBAGENT_DEPTH`
env, `:163`), **own-context-per-agent** (two isolated children can't share a
session, `:207`). Children default read-only; `--confirm-actions <verbs>` grants a
tool-gated allowlist (`:175`). `--tab` = shared browser/own tab (cheaper RAM,
shares cookies); no `--tab` = own detached browser (full isolation). This is
Aside's subagent design, keyless. Isolate whole agent-GROUPS with `--namespace`.

---

## 12. Parallel multi-tab gather (one browser, many tabs)

**Goal:** open several related pages at once and harvest from each — cheaper than N
browsers, when pages can share cookies/storage (e.g. same logged-in site).

**Mode:** Parallel, shared-browser via tabs.

**Sequence:**
```
silver open https://site/dash --session s
silver tab new https://site/orders   --label orders   --session s
silver tab new https://site/invoices --label invoices --session s
silver tab orders --session s ; silver snapshot -i --session s ; silver get text --session s
silver tab invoices --session s ; silver extract --schema @inv.json --session s
silver tab list --session s          # ids t1.., labels, urls, which active
```
Every non-tab verb operates on the ACTIVE tab (`resolveActivePage` in
`withConnection`, `handlers.ts:199`); switching tabs invalidates refs
(`invalidateRefs`, `:536`) so you re-snapshot per tab. Tab ids are stable across
the stateless reconnects (keyed by CDP targetId, `tabs.json` sidecar). Use this
when tabs SHOULD share auth; use separate `--session`s (§3) when they must not.

---

## 13. Competitive scraping (consented, at scale)

**Goal:** systematically pull public competitor data (catalog, pricing) with
consent, at volume, into a dataset.

**Mode:** Long-task (durable) + subagent/parallel shards + `--allowed-domains`
egress hardening to stay on-target.

**Sequence:**
```
silver task start "competitor catalog Q3" --id comp-scan
silver open https://competitor.com --session scan --allowed-domains competitor.com
# shard across subagents, each pinned to the allowlist:
silver subagent spawn "scan /category/a" --session shard-a --confirm-actions '' --enable-actions
silver task exec comp-scan --enable-actions -- extract --schema @catalog.json --session scan
silver network har start --session scan ; ... ; silver network har stop catalog.har --session scan
```
`--allowed-domains` hardens egress to a SUFFIX allowlist (`competitor.com` allows
`m.competitor.com`, denies `competitor.com.evil.com`; SKILL Hard Rules,
`security/egress.ts`), keeping a runaway scrape on-domain. HAR export
(`handlers.ts:1674`) captures the full network trace for audit. `extract` (§6)
keeps URLs grounded. Durable run folder means a 10k-page scan resumes after a
crash. (Consent/ToS is the operator's responsibility; Silver enforces egress +
paid-gate, not legality.)

---

## 14. Verification / fact-check (confirm a claim against a live source)

**Goal:** given a claim + a source URL, confirm/refute it against the live page —
grounding an answer in a real DOM rather than model memory.

**Mode:** Quick. Read-only is sufficient and is the safe default.

**Sequence:**
```
silver read https://source/article        # or open + get text for JS pages
silver find text "the specific claim string" --session s --enable-actions   # locate exact text on page
silver get text @e-match --session s        # pull surrounding context
```
`find text` (`handlers.ts:945`, needs `--enable-actions` even to locate — it's
registry-classified actor) does a semantic locate without a snapshot and returns
match count + text. All page text is untrusted-fenced (`presentPageText`) so the
host treats it as data, not instructions — critical for fact-check where the page
may try to inject. No actions needed beyond locate; keep it read-only.

---

## 15. Screenshot / vision-when-needed (fall back to pixels)

**Goal:** when the accessibility tree is insufficient (canvas, chart, visual bug,
CAPTCHA-shaped layout), capture pixels for the host's vision model.

**Mode:** Quick, on demand. Vision is the fallback, not the default — the a11y
snapshot is token-cheaper and should be tried first.

**Sequence:**
```
silver screenshot shot.png --session s              # viewport PNG to contained path
silver screenshot --full page.png --session s        # full-page
silver screenshot --session s                         # base64 in data.image (no path) → hand to host vision
silver pdf page.pdf --session s                       # print-to-PDF artifact
```
`handleScreenshot` (`:844`) writes to a CONTAINED path (`assertContainedPath`) or
returns base64. `pdf` (`:1711`) renders headless. The DEFAULT loop is
snapshot-driven (token-efficient); reach for pixels only when structure fails.
Checkpoints in long-task also grab a best-effort screenshot automatically
(`task/index.ts:317`).

---

## 16. Download / upload (files in and out)

**Goal:** pull a file the page offers (invoice PDF, export CSV) or push a file into
a file input (attach, import).

**Mode:** Quick lean-loop; actor verbs, contained paths.

**Sequence:**
```
silver download @e9 invoice.pdf --session s --enable-actions          # click target, capture download, save
silver download --wait export.csv --session s --enable-actions         # await NEXT download w/o a click
silver upload @e3 ./resume.pdf --session s --enable-actions            # set a file input (each path contained)
```
`handleDownload` (`:2048`) arms the download listener BEFORE the click so the event
is never missed, saves to a contained path (never echoed), and neutralizes the
server-suggested filename. `upload` (via `handleAct`, `:906`) requires every file
to resolve inside cwd or refuses with `path_denied`. Both are actor verbs.

---

## 17. Session reuse across runs (log in once, reuse everywhere)

**Goal:** authenticate once and reuse the session across many later invocations /
tasks / agents without re-logging-in.

**Mode:** Cross-cutting — enables §4/§8/§10/§13 to skip re-auth. Two mechanisms:
live browser-as-daemon, and portable storage-state.

**Sequence:**
```
# live reuse: the detached browser persists between CLI calls (browser-as-daemon)
silver open <url> --session work        # spawns detached browser
# ... minutes later, different shell, same session name → reconnects, still logged in
silver snapshot -i --session work

# portable reuse: save/load cookies to a contained file
silver state save auth.json --session work
silver state load auth.json --session fresh
silver cookies set --curl cookies.txt --session fresh      # from JSON array / Cookie: header / pasted curl
```
The session is a detached browser that keeps running between invocations
(`ensureConnected` reconnects over CDP, `handlers.ts:175`); `session list` shows
liveness/pid/tabs (`:1394`), `session gc` reaps dead ones (`:1420`), `session id
--scope worktree` mints a stable per-project name (`:1376`). `state save/load`
(`:1274`) persists cookies to a contained file (localStorage not replayed in v1).
This is the Browserbase/persistent-session capability, local and keyless.

---

## Decision matrix (for the SKILL)

| If the goal is… | Reach for | Key verbs |
|---|---|---|
| one fact off one page | **quick**, often 1 cmd | `read` / `open`+`get text` |
| reach a value behind a click | **quick lean-loop** | `open`→`snapshot -i`→`click`→`snapshot` |
| structured records w/ links | **quick + extract moat** | `extract --schema` → `extract resolve` |
| log in / fill a form | **quick**, secrets on `--stdin` | `snapshot`→`fill`→`click`; `find … fill` |
| buy / pay / delete | **quick + confirm gate** | `click … --confirm-actions <verb>` |
| a multi-step goal that may crash | **long-task** | `task start`/`exec`/`checkpoint`/`resume` |
| many pages → one dataset | **long-task + shards** | `task exec … extract`, parallel sessions |
| 3+ independent sub-jobs at once | **subagent fan-out** | `subagent spawn/wait/done` |
| several tabs, shared auth | **shared-browser tabs** | `tab new/switch/list` |
| several sources, no shared state | **own-session-per-agent** | `--session <name>` + `--namespace` |
| QA / assert / mock network | **batch** | `is`,`get count`,`console`,`errors`,`network route`,`set viewport` |
| recurring watch | **quick per-tick + memory** | external scheduler → `open`+diff-snapshot; `memory add/search` |
| fact-check a claim | **quick, read-only** | `read` / `find text` / `get text` |
| tree insufficient (visual) | **quick, vision fallback** | `screenshot [--full]` / `pdf` |
| pull/push a file | **quick, actor** | `download [--wait]` / `upload` |
| skip re-auth next time | **session reuse** | daemon `--session` / `state save`+`load` / `cookies set` |

**Default posture:** start read-only and quick; add `--enable-actions` only when
you must mutate; escalate to long-task the moment a job can crash mid-flow; go
parallel/subagent only at ≥3 genuinely independent units; keep whole agent-groups
apart with `--namespace`. Memory and session-reuse layer onto everything.
