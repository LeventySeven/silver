# Coming from the Playwright MCP → silver

You already know the Playwright MCP's `browser_*` tools. silver is a **capability superset** of
them, delivered as a keyless CLI + skill instead of an MCP server (silver never calls a model; the
host is the brain). This table translates a Playwright-MCP session to silver 1:1 so you can swap
without relearning. **The lean loop is the same idea:** `open` → `snapshot -i` (get `@eN` refs) →
act by ref with `--enable-actions` → re-`snapshot`.

**Two silver-isms to internalize first:**
- **Read-only by default.** Anything that changes the page needs `--enable-actions` (a disabled verb
  isn't even dispatchable — this is the security model, not a nag).
- **Refs are `@eN`, generation-scoped.** A stale ref fails LOUD (`ref_stale`) and never misclicks —
  re-`snapshot` after any `page_changed`/`stale_refs`, never guess a ref.

## Tool → verb map

| Playwright MCP tool | silver verb | Notes |
|---|---|---|
| `browser_navigate` | `open <url>` (aliases `goto`/`navigate`) | egress-guarded |
| `browser_navigate_back` | `back` | + silver has `forward`, `reload` |
| `browser_snapshot` | `snapshot -i` | start here (interactive-only, cheapest); full `snapshot`, `-c` compact, `-d`/`-s` depth/scope. Re-snapshots return a **diff** |
| `browser_click` | `click @eN --enable-actions` | `--button right/middle`, `--modifiers Shift,Control,…`; `dblclick` is a sibling |
| `browser_type` | `fill @eN "<t>" --enable-actions` | `fill` verifies the write; `type` is key-by-key |
| `browser_fill_form` | `batch "fill @e1 a" "fill @e2 b" …` | one process, one session |
| `browser_press_key` | `press @eN "<key>"` | or `keyboard press` |
| `browser_hover` / `browser_select_option` | `hover @eN` / `select @eN <val…>` | select fails fast on a missing option |
| `browser_file_upload` | `upload @eN <file…>` | path-contained |
| `browser_drag` / `browser_drop` | `drag @src @dst` | interpolated (fires DnD intermediate moves) |
| `browser_handle_dialog` | `dialog accept [--prompt-text]` / `dialog dismiss` | pre-armed; default is auto-accept |
| `browser_wait_for` | `wait --text "<s>"` / `wait --text-gone "<s>"` / `wait <ms>` | + `wait --ready` (dual-quiet), `wait @eN`, `wait <css>` |
| `browser_evaluate` | `eval "<js>"` / `eval @eN "el => …"` | in-page JS only (NOT the Playwright driver — that's the `run_code_unsafe` leak class silver refuses) |
| `browser_run_code_unsafe` | *(refused)* — use `eval` | exposing the page/context object is an RCE/exfil vector silver deliberately omits |
| `browser_take_screenshot` | `screenshot [@eN] [--full] [--type jpeg]` | `screenshot --annotated` = set-of-marks (numbered boxes = the `@eN` refs) |
| `browser_console_messages` | `console [--level error]` | + `errors` for uncaught exceptions |
| `browser_network_requests` | `network requests [--filter/--type/--method/--status]` | each carries an `index` |
| `browser_network_request` | `network request <index> [--part body]` | bounded, redacted response body |
| `browser_route` / `browser_unroute` | `network route <glob> [--abort/--body/--status/--headers]` / `network unroute` | + `network routes` (list) |
| `browser_network_state_set` | `set offline <t/f>` | |
| `browser_cookie_*` | `cookies list/get/delete/clear` + `cookies set --curl` | values redacted on read (they're session tokens) |
| `browser_localstorage_*` / `browser_sessionstorage_*` | `storage local\|session get/set/delete/clear` | |
| `browser_storage_state` / `browser_set_storage_state` | `state save <path>` / `state load <path>` | replays cookies **and** localStorage |
| `browser_tabs` | `tab list/new/close/<tN>` | + labels |
| `browser_resize` | `set viewport <w> <h>` | + `set color-scheme/geolocation/timezone/locale` |
| `browser_pdf_save` | `pdf [path]` | |
| `browser_mouse_*` (vision) | `mouse move/click/down/up/wheel <x> <y>` · `drag --from --to` | coordinate escape hatch |
| `browser_find` | `find <role\|text\|label\|…> <value>` | read-only locate; regex value `/…/`; add a subaction to act |
| `browser_verify_*` (testing) | `expect <ref\|selector> <matcher>` | visible/hidden/enabled/checked/text-contains/value-equals/count/url-matches/title-contains/text-visible |
| `browser_close` | `close` | |
| `browser_install` | `npx playwright install chromium` | first-run only |
| tracing / video / highlight / annotate | *(not shipped)* | dev-theater with no value for a keyless host-is-brain driver |

## What you GAIN by swapping
- **ID-grounded `extract`** — links come back as element IDs, so a fabricated URL is structurally
  impossible (`extract --schema` → `extract resolve --ids`).
- **Errors that ARE the recovery instruction** (retryable-tagged), not a generic throw.
- **Durable long tasks** (`task start/exec/resume`, survive a crashed agent), **parallel sessions +
  subagents**, and **grep-first memory** — all keyless.
- **The skill loads once** instead of re-teaching a ~13K-token JSON tool schema every turn.

Full guide: `silver skill --full`.
