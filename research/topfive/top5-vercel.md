# Top 5 things Vercel agent-browser does better than everyone — and Silver's status

Sources read directly: `/Users/seventyleven/Desktop/Silver/rust-oracle/cli/src/native/daemon.rs`,
`connection.rs`, `native/cdp/client.rs`, `native/snapshot.rs`, `native/diff.rs`,
`native/storage.rs`, `native/state.rs`, `skills.rs`; and Silver's
`core/session.ts`, `core/lock.ts`, `perception/refmap.ts`, `perception/diff.ts`,
`core/handlers.ts`. `researchfms/teardowns/VERCEL.md` used for cross-checking, not
as a substitute for the code.

---

## 1. Persistent per-session daemon holding ONE live CDP connection

**What it is.** `silver daemon` (Rust) is a long-lived process per session. It
binds a Unix socket (`native/daemon.rs:179` `UnixListener::bind`), holds a
`DaemonState` behind a `tokio::sync::Mutex` (`daemon.rs:189-191`) that owns the
browser + a single `Arc<CdpClient>`, and runs a `tokio::select!` event loop that
services one command at a time per connection while draining CDP events and
doing periodic autosave in the background (`daemon.rs:207-268`, drain interval
at `daemon.rs:201-202`, `225-238`). Every CLI invocation is a *thin client*:
`connection.rs:1005` `send_command()` opens a Unix-socket connection
(`connection.rs:992` `UnixStream::connect`), writes one JSON line, reads one
JSON line back, and exits — the daemon and its CDP WebSocket never tear down.

**Why it wins.** The CDP handshake, `Runtime.enable`/`Accessibility.enable`
setup, and warmed frame/target bookkeeping happen ONCE per browser session, not
once per CLI invocation. Every subsequent command amortizes that cost to a
local-socket round trip (microseconds) instead of a fresh WebSocket connect
(tens of milliseconds, more under load). It also lets the daemon do background
work between commands the client never has to remember to trigger — draining
buffered CDP events (dialog state in particular, `daemon.rs:236`) and periodic
session autosave (`daemon.rs:236`, `maybe_autosave_restore_state`).

**Silver: GAP.** `silver/src/core/session.ts:1-13` documents the model
explicitly: "Every later command `connect()`s over CDP, does its work, and
disconnects — the browser keeps running." `connect()` at `session.ts:328-348`
calls `chromium.connectOverCDP(info.wsEndpoint)` fresh on every single CLI
invocation, and the caller "MUST `browser.close()` when done" — this closes the
Playwright-side CDP session, not the browser process. Silver's browser process
persists (matches Vercel's browser persistence) but its *connection* does not —
there is no in-process daemon that keeps a warm CDP client, no background event
draining loop, no daemon-side autosave tick. This is the core "engine" gap
named in the task: Silver is TS-per-command-reconnect, Vercel is
Rust-daemon-with-warm-socket. This is a connection-model difference (latency),
not a language difference, and it is real and unclosed as of this read.

---

## 2. The `@eN` / `eN` snapshot ref format itself — Silver has fully matched this

**What it is.** Vercel mints short accessibility-tree refs (`e1`, `e2`, ...) at
`native/snapshot.rs:404` (`let ref_id = format!("e{}", next_ref);`) keyed to
`backend_node_id` via `RefMap` in `native/element.rs`.

**Silver: ALREADY HAS THIS, in a strictly stronger form.** `perception/refmap.ts`
implements the identical bare-`eN` convention (`parseRef` at
`refmap.ts:36-45` accepts `@e12`, `ref=e12`, or bare `e12`) — explicitly
"Adapted from reference/agent-browser/cli/src/native/element.rs" per the file's
own header comment (`refmap.ts:8`). Silver goes further: it adds a
`generation` field to every `RefEntry` (`refmap.ts:13-19`) and a `groundRef`
gate (`refmap.ts:55-60`) that fails loudly (`ref_stale`) if a ref minted in an
old snapshot generation is used after a re-render, instead of silently
resolving to whatever node now occupies that backend-node-id. Vercel's format
was copied faithfully; Silver's grounding-gate addition is a genuine
improvement Vercel does not have (checked: no `generation`/staleness field in
Vercel's `RefEntry` at `native/element.rs`). No gap here — call this a wash
that tips slightly in Silver's favor.

---

## 3. Diff-when-shorter unified-diff snapshots — Silver has fully matched this

**What it is.** `native/diff.rs:103-148` `diff_snapshots()` runs a Myers
line-diff (via the `similar` crate) between the previous and current
accessibility-tree text and returns a git-style unified diff
(`text_diff.unified_diff().context_radius(3)`, `diff.rs:135-138`) plus
add/remove/unchanged counts. It has a fast-path identical-input short-circuit
(`diff.rs:104-117`) to skip the diff machinery entirely on a no-op re-snapshot.

**Silver: ALREADY HAS THIS.** `perception/diff.ts` implements the same idea
independently: `observe(prev, tree)` (`diff.ts:28-46`) returns the full tree on
first observation, the `NO_CHANGES` sentinel on a byte-identical repeat
(`diff.ts:35-37`), and otherwise picks whichever is textually shorter — the
unified diff or the full tree (`diff.ts:44`, `output = diff.length <
tree.length ? diff : tree`). The diff itself is a hand-rolled Myers O(ND) line
diff with 3 lines of context (`diff.ts:19-20`, git-default `CONTEXT = 3`,
matching Vercel's `context_radius(3)`), explicitly built to avoid pulling in a
new dependency (`diff.ts:11-13`). Functionally equivalent to Vercel's
mechanism, and Silver's "pick whichever representation is shorter" rule is
slightly smarter than Vercel's "always emit the diff" default (Vercel emits
the diff unconditionally when changed; Silver falls back to the full tree if
the diff would be longer, e.g. a near-total re-render). No gap.

---

## 4. Docs-in-binary two-tier skill system — Silver has the mechanism but a much thinner catalog

**What it is.** `skills.rs` ships two directories inside the npm/binary
package, `skills/` (discovery stubs, `hidden: true`, exist only to redirect
external tools like `npx skills add` to `skills get core`) and `skill-data/`
(the real runtime content: `core`, `electron`, `slack`, `dogfood`, etc. per the
comment at `skills.rs:20-29`). `skills list` shows only name + truncated
description (`run_list`, `skills.rs:213-249`, `truncate_description` at
`skills.rs:165-177`) — a short, token-cheap index. `skills get <name>` returns
the full `SKILL.md` plus everything under that skill's `references/` and
`templates/` subdirs (`collect_supplementary_files`, `skills.rs:182-211`,
`run_get` at `skills.rs:255+`). This is a genuine two-tier design: cheap
discovery, expensive full-fetch only on demand, and it scales to many topics.

**Silver: PARTIAL — GAP on catalog breadth and the two-tier list/get split.**
Silver has exactly one skill: `silver/skill-data/core/SKILL.md`, served
unconditionally in full by the `skill` verb handler
(`core/handlers.ts:1506`, `path.join(PACKAGE_ROOT, 'skill-data', 'core',
'SKILL.md')`) via `case 'skill':` at `handlers.ts:395`. There is no `skills
list` (cheap index) vs `skills get <name>` (full fetch) split — Silver's
`skill` verb is a single meta-verb (`cli.ts:46` `META_VERBS`) that always
returns the one document. `find` confirms only `skill-data/core` exists on
disk; there is no `electron`, `slack`, `dogfood`, or any per-topic directory,
and no `references/`/`templates/` supplementary-file mechanism. GAP: Silver
should (a) split into a cheap list + full get, and (b) grow the catalog beyond
one monolithic skill if it wants topic-scoped docs (e.g. a `security` or
`extract` skill an agent can fetch only when relevant) — the current design
forces every session to either skip the skill or ingest the whole thing.

---

## 5. Session save/restore (`storage_get/set/clear`, cookies + localStorage snapshot) — Silver has equivalent coverage

**What it is.** `native/state.rs:248-` `save_state()` collects cookies
(`cookies::get_all_cookies`) plus localStorage/sessionStorage across every
visited origin — including origins not currently loaded, via a disposable temp
target (`collect_storage_via_temp_target`, referenced at `state.rs:301`) — and
serializes it to a `StorageState` JSON written under the session dir
(`state.rs:308-320`). `native/storage.rs` gives direct `storage get/set/clear`
verbs against `localStorage`/`sessionStorage` via `Runtime.evaluate`
(`storage.rs:6-67`).

**Silver: ALREADY HAS THIS at the sidecar layer, differently structured.**
Silver persists session identity (`SIDECAR = 'session.json'`, `session.ts:54`)
and the RefMap (`REFMAP = 'refmap.json'`) as encrypted-at-rest sidecars
(`writeSidecar`/`readSidecarObject`, `session.ts:144-162`, AES-256-GCM via
`state-crypto.ts`), and `handlers.ts` maintains a `silver-state.json` sidecar
for page-tree/extract state per the comment at `session.ts:141-142`. This is
architecturally different from Vercel's single portable `StorageState` JSON
(Playwright's own storage-state format vs. Silver's per-purpose sidecar files)
but covers the same ground: cookies/origin storage restoration and
cross-command grounding state survive process exit. One notable Silver
advantage Vercel's code (as read here) does not show: sidecars are encrypted
at rest by default (`session.ts:134-149`) — Vercel's `save_state` writes plain
`serde_json::to_string_pretty` JSON to disk (`state.rs:308-310`), no
encryption layer visible in the file. Not a functional gap; if anything a
security edge for Silver, worth flagging as a claim to verify against Vercel's
full `state.rs` (only lines 240-320 read here) before asserting Vercel has
zero encryption anywhere in that file.

---

## Summary table

| # | Vercel strength | Silver status |
|---|---|---|
| 1 | Persistent daemon + one warm CDP connection, thin-client socket per command | **GAP** — Silver reconnects CDP fresh every command; browser process persists but the connection/session-warmth does not |
| 2 | `eN` ref format | **Matched, Silver extends it** (generation/staleness gate) |
| 3 | Diff-when-changed unified snapshot diff | **Matched** (independent Myers implementation, arguably smarter fallback rule) |
| 4 | Two-tier docs-in-binary skill system, multi-topic catalog | **Partial GAP** — mechanism absent (no list/get split), catalog is 1 skill vs Vercel's several |
| 5 | Session/storage save-restore | **Matched**, different architecture (sidecars vs single StorageState file), Silver adds at-rest encryption |

**Bottom line for the stated pass goal:** of the two flagged as the crux —
engine efficiency and the two-tier skill system — #1 (the daemon/connection
gap) is confirmed real and is the single biggest lever left: it is a latency
problem independent of TS-vs-Rust, since Silver's own `session.ts` header
already names the target model ("browser-as-daemon") but has not yet closed
the last mile of also daemonizing the *connection*. #4 is a smaller, cheaper
fix (add a list/get split and 1-2 more topic skills) that does not require
touching the connection architecture at all.
