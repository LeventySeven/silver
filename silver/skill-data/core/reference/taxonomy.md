# silver — The decision spine (which mode for which goal)

The compact decision matrix lives in `core/SKILL.md §5`. This file is the deep version: the
five real modes, the decomposition rule, and a category-by-category map from a concrete goal to
a command sequence and the mode that fits it. Every verb here exists in the real dispatch.

## Contents
1. The five real modes
2. The decomposition rule (combine dependent, split independent)
3. Default posture
4. Category → sequence → mode (the 16 categories)

---

## 1. The five real modes

1. **Quick / lean loop** — `open → snapshot -i → act → re-snapshot`, one invocation per step;
   the browser-as-daemon persists between calls. The atom every other mode composes.
2. **Batch** — many verbs, one process, one session, per-command pass/fail (`batch "…" "…"`).
   Fire-and-forget setup.
3. **Long-task** — a durable run folder (plan + append-only log + screenshots + checkpoint)
   that survives a crashed host and resumes (`task start/exec/checkpoint/resume`).
4. **Parallel** — own-browser-per-agent (`--session <name>`, the safe default) OR
   shared-browser-one-tab-per-agent (`connect` + `tab new`). Groups isolate under `--namespace`.
5. **Subagent fan-out** — scoped child units of work (`subagent spawn`, cap 5, one-level
   nesting, own context). silver reserves the scope; YOUR sub-agent drives each child.

---

## 2. The decomposition rule

**Combine dependent steps into one sequential session; split independent steps into parallel
sessions.** The litmus is a single question — *does step B need step A's result or state?*

- **"Add iPhone, iPad, MacBook to cart" → three parallel sessions.** Each add is independent; no
  add depends on another's outcome.
- **"Fill the billing form then submit" → one session.** The submit depends on the fill; running
  them apart races an empty form against the button.

Sequential-dependent steps combine; only genuinely independent actions split. Don't reach for
parallelism below ~3 independent units — the coordination cost dominates the win. And note the
**shared-target caveat** (`reference/agents-memory.md`): "independent" means independent
*targets* too — three parallel writes to one cart/account are NOT independent.

---

## 3. Default posture

Start read-only and quick; add `--enable-actions` only when you must mutate; escalate to
long-task the moment a job can crash mid-flow; go parallel/subagent only at ≥3 genuinely
independent units; keep whole agent-groups apart with `--namespace`. Memory and session-reuse
layer onto everything.

---

## 3a. Accretion discipline (when you wish silver had one more verb)

silver's surface is deliberately small, and *keeping* it small is a correctness property, not
just taste — a widely-cited case study watched an agent regress 83%→62% on its own eval purely
from capability accretion. So before reaching for (or requesting) a new verb or flag, sort the
need into one of three:

- **Fold-in** — an existing verb/flag already covers it, or covers it with one more argument
  (prefer this; e.g. verification is `expect`, not a new `assert-*` family).
- **Local tool** — it belongs in a small tool the *host* owns, not in silver (silver stays the
  keyless browser; bespoke post-processing is yours).
- **Skip** — no demonstrated, failing-eval-backed use case yet. An unbuilt verb with no failing
  eval behind it is debt, not backlog; wait until a real loop pulls it.

If none of the three fits and the need is real and recurring, *then* it's a candidate — with a
regression fixture shipped alongside it.

---

## 4. Category → sequence → mode

| # | Goal | Command sequence | Mode |
|---|---|---|---|
| 1 | One fact off one page | `read <url>` or `open`+`get text` | quick, often 1 cmd |
| 2 | Reach a value behind a click | `open`→`snapshot -i`→`click`→`snapshot` | quick lean-loop |
| 3 | Structured records with links | `extract --schema` → `extract resolve` | quick + extract moat |
| 4 | Log in / fill a form | `snapshot -i`→`fill`→`click`; secrets on `--stdin` | quick |
| 5 | Buy / pay / delete | `click … --enable-actions --confirm-actions <verb>` | quick + confirm gate |
| 6 | A multi-step goal that may crash | `task start`/`exec`/`checkpoint`/`resume` | long-task |
| 7 | Many pages → one dataset | `task exec … -- extract`, parallel sessions | long-task + shards |
| 8 | 3+ independent sub-jobs at once | `subagent spawn`/`wait`/`done` | subagent fan-out |
| 9 | Several tabs, shared auth | `tab new`/`tab <tN>`/`tab list` | shared-browser tabs |
| 10 | Several sources, no shared state | `--session <name>` + `--namespace` | own-session-per-agent |
| 11 | QA / assert / mock network | `expect`, `is`, `get count`, `console`, `errors`, `network route`, `set viewport` | batch |
| 12 | Recurring watch | external scheduler → `open`+diff-`snapshot`; `memory add/search` | quick per-tick + memory |
| 13 | Fact-check a claim | `read` / `find text` / `get text` | quick, read-only |
| 14 | Ref nameless/ambiguous | `get html @eN` (its code) | quick, escape hatch |
| 14b | Tree insufficient (canvas/visual — see `sparse_tree`) | `screenshot` → `get box @eN` → `click --at <x> <y>` / `pdf` | quick, vision fallback |
| 15 | Pull / push a file | `download [--wait]` / `upload` | quick, actor |
| 16 | Skip re-auth next time | `state save`+`state load` / `cookies set --curl` | session reuse |

Notes:

- **Category 1 (`read`)** is the cheapest door — plain-text body, no snapshot, redirect-guarded.
  Use it when you only need text and don't need to click.
- **Category 3** — see `reference/extract.md`. The `list[T]` wrap returns every match.
- **Category 5** — the gate trips on `buy|purchase|checkout|pay|payment|order|delete|remove`
  accessible names; clear it with `--confirm-actions <verb>`, or use the decoupled
  `--two-phase-confirm` → inspect the pending action → `confirm <id>`/`deny <id>` protocol (and
  `--action-policy <file.json>` for a hard fleet-wide deny). See `reference/security.md`.
- **Verify the goal, not `success:true`** — `expect <target> <matcher> [value]` is a read-only
  assertion (`visible`/`hidden`/`enabled`/`checked`/`text-contains`/`value-equals`/`count`, or
  page-level `url-matches`/`title-contains`); it returns `success:true` **only** when the
  assertion holds, else a failure carrying `{matched, matcher, expected, observed}`. Use it to
  collapse "did it actually work?" into one call instead of a snapshot you re-read by eye.
- **Category 6/7** — see `reference/tasks.md`. Put `--enable-actions` before the `--`.
- **Category 8** — see `reference/agents-memory.md`, including the sub-agent inheritance warning.
- **Category 16** — session reuse is via `state save`/`state load` and `cookies set`; the
  detached browser also persists between CLI calls within a `--session`. (There is no `daemon`
  verb — the daemon is the session model itself.)
