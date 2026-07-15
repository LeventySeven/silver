# R2 Source Digest: vercel:cli-surface (agent-browser)

Repo root read: `/Users/seventyleven/Desktop/ultimate-agent-browser/reference/agent-browser`
Language: Rust CLI (`cli/src/*.rs`) + JS launcher (`bin/agent-browser.js`), daemon architecture
(CLI process talks to a background daemon over a Unix socket / named pipe).

## License

**Apache License 2.0** (`LICENSE:1-2`, full Apache-2.0 text). Fork/adapt is permitted with
attribution + NOTICE preservation + stating changes; no copyleft on our own code.

## Killer Insight

The command surface is a thin CLI parser (`cli/src/commands.rs`, `parse_command`) that
translates argv into a **flat JSON `{id, action, ...fields}` request** sent over a persistent
per-session Unix-socket daemon connection (`cli/src/connection.rs`), and the daemon replies with
a uniform **`{success: bool, data: Option<Value>, error: Option<String>, warning?: Option<String>}`**
envelope (`cli/src/connection.rs:33-40`). The snapshot's accessibility-tree-to-ref mechanism
(`@e1`, `@e2`...) is generated fresh per snapshot from the CDP `DOM.getFullAXTree`/AX node walk
(`cli/src/native/snapshot.rs`), numbering only nodes worth being interacted with (interactive
roles always ref'd, content roles ref'd only if they have a non-empty accessible name), and refs
are accepted back on any selector-taking command in three interchangeable forms: `@e12`,
`ref=e12`, or bare `e12` (`cli/src/native/element.rs:124-147`, `parse_ref`). This ref-as-first-
class-selector design is the single most valuable pattern to copy: it lets an LLM refer to
elements by a short opaque token instead of writing/guessing CSS selectors, and the daemon
tracks `(backend_node_id, role, name, nth, frame_id)` behind each token so subsequent commands in
the same session resolve reliably even across re-renders.

## Exact Command Surface / API (verbatim)

All subcommands are dispatched in `cli/src/commands.rs`, function `parse_command` (match starts
at line 347). Format: CLI verb -> daemon `action` field -> required JSON fields. `id` (a
generated request id) and `action` are always present; extra fields per action shown below.

### Global flags (`cli/src/flags.rs`)
Value-taking global flags (list at `cli/src/flags.rs:245-278`, duplicated at `1039-1073`):
```
--session <name>            --restore-save <auto|always|never>
--restore-check-url <glob>  --restore-check-text <text>
--restore-check-fn <js>     --namespace <ns>
--headers <json>            --executable-path <path>
--cdp <endpoint>            --extension <path>          (repeatable)
--init-script <path>        (repeatable)
--enable <feature>          (repeatable; e.g. react-devtools)
--profile <path>            --state <path>
--proxy <url>                --proxy-bypass <domains>
--args <comma-list>          --user-agent <ua>
-p, --provider <name>        --device <name>
--session-name <name>        --color-scheme <dark|light|no-preference>
--download-path <dir>        --max-output <n>
--allowed-domains <csv>      --action-policy <path>
--confirm-actions <csv>      --config <path>
--engine <chrome|lightpanda> --screenshot-dir <dir>
--screenshot-quality <0-100> --screenshot-format <png|jpeg>
--idle-timeout <dur>         --model <provider/model>
```
Boolean flags (`cli/src/flags.rs:1016-1035`):
```
--json --headed --webgpu --debug --ignore-https-errors --allow-file-access
--hide-scrollbars --auto-connect --annotate --content-boundaries
--confirm-interactive --no-auto-dialog -v/--verbose -q/--quiet
--offline --quick --fix
```
`--restore` also accepts `--restore=<key>` inline form (`flags.rs:625-634`); a bare `--restore`
with no value reuses the current `--session` value (`restore_key_from_flags`, `main.rs:98-100`).

Incompatible combos enforced (`main.rs:106-150`): `--cdp` + `-p/--provider`; `--auto-connect` +
`--cdp`; `--auto-connect` + `-p/--provider`; `-p/--provider` + `--extension`; `--cdp` +
`--extension`; `--webgpu` + any of `--cdp`/`-p`/`--auto-connect` (WebGPU preset requires a
locally-launched browser).

Config schema mirrors these flags 1:1 — see `agent-browser.schema.json:1-252` (properties:
headed, json, debug, session, restore, restoreSave, restoreCheckUrl, restoreCheckText,
restoreCheckFn, namespace, sessionName, executablePath, extensions[], initScripts[],
enable[react-devtools], profile, state, proxy, proxyBypass, args, userAgent, provider, device,
hideScrollbars, webgpu, ignoreHttpsErrors, allowFileAccess, cdp, autoConnect, annotate,
colorScheme, downloadPath, contentBoundaries, maxOutput, allowedDomains, actionPolicy,
confirmActions, confirmInteractive, engine[chrome|lightpanda], screenshotDir,
screenshotQuality, screenshotFormat, idleTimeout, model, noAutoDialog, headers, plugins[]).
Plugin entries: `{name, command, args?, capabilities?[credential.read|browser.provider|
launch.mutate|command.run|...], source?}` (`agent-browser.schema.json:213-249`).

### Navigation
- `open|goto|navigate <url> [--headers ...]` -> action `"navigate"` `{url}` ; bare `open` with no
  URL instead emits `{"action":"launch","headless": !headed}` (`commands.rs:350-403`). URL gets
  `https://` prepended if no scheme (`about:`, `data:`, `file:`, `chrome://`,
  `chrome-extension://`, `http(s)://` pass through) (`commands.rs:369-381`).
  `--headers '<json>'` parsed as JSON and attached as `headers` field (`commands.rs:386-395`).
- `back` -> `{"action":"back"}`; `forward` -> `{"action":"forward"}`; `reload` -> `{"action":"reload"}`
  (`commands.rs:404-406`).

### Core interaction
- `click <selector> [--new-tab]` -> `"click"` `{selector, newTab?}` (`commands.rs:410-424`).
- `dblclick <selector>` -> `"dblclick"` `{selector}` (`commands.rs:425-430`).
- `fill <selector> <text...>` -> `"fill"` `{selector, value}` (rest joined with spaces)
  (`commands.rs:432-437`).
- `type <selector> <text> [--clear] [--delay <ms>]` -> `"type"` `{selector, text, clear?, delay?}`
  (`commands.rs:439-481`).
- `hover <selector>` -> `"hover"`; `focus <selector>` -> `"focus"`; `check <selector>` ->
  `"check"`; `uncheck <selector>` -> `"uncheck"` (all `{selector}`) (`commands.rs:482-509`).
- `select <selector> <value...>` -> `"select"` `{selector, values}` — single value scalar,
  multiple values as array (`commands.rs:510-525`).
- `drag <source> <target>` -> `"drag"` `{source, target}` (`commands.rs:526-535`).
- `upload <selector> <files...>` -> `"upload"` `{selector, files: [...]}` (`commands.rs:537-542`).
- `download <selector> <path>` -> `"download"` `{selector, path}` (`commands.rs:544-553`).

### Keyboard
- `press|key <key>` -> `"press"` `{key}`; `keydown <key>` -> `"keydown"`; `keyup <key>` ->
  `"keyup"` (`commands.rs:557-577`).
- `keyboard type <text>` -> `"keyboard"` `{subaction:"type", text}`;
  `keyboard inserttext <text>` -> `{subaction:"insertText", text}` (`commands.rs:578-610`).

### Scroll
- `scroll [direction] [amount] [-s/--selector <sel>]` -> `"scroll"` `{direction?, amount?,
  selector?}` positional parse (`commands.rs:614-...`).
- `scrollintoview|scrollinto <selector>` -> `"scrollintoview"` `{selector}` (`commands.rs:658-663`).

### Wait (`commands.rs:667-779`)
`wait` supports (mutually exclusive) forms, all accept a shared `[--timeout <ms>]` extracted
first and re-attached:
- `wait --url|-u <pattern>` -> `"waitforurl"` `{url}`
- `wait --load|-l <state>` -> `"waitforloadstate"` `{state}`
- `wait --fn|-f <expr>` -> `"waitforfunction"` `{expression}`
- `wait --text|-t <text>` -> `"wait"` `{text}`
- `wait --download|-d [path]` -> `"waitfordownload"` `{path?}`
- `wait <ms:number>` -> `"wait"` `{timeout}`
- `wait <selector>` -> `"wait"` `{selector, timeout?}`

### Screenshot / PDF (`commands.rs:782-851`)
- `screenshot [selector] [path] [--full|-f]` -> `"screenshot"` `{path, selector, fullPage,
  annotate}` plus optional `format` (from `--screenshot-format`), `quality` (from
  `--screenshot-quality`, warns if format isn't jpeg), `screenshotDir`. Heuristic disambiguates
  a single positional arg as selector (starts with `.`/`#`/`@`, or not path-like) vs. path
  (`./`, `../`, contains `/`, or `.png/.jpg/.jpeg/.webp` extension) (`commands.rs:798-822`).
- `pdf <path>` -> `"pdf"` `{path}` (`commands.rs:845-850`).

### Snapshot (`commands.rs:854-891`)
`snapshot [-i|--interactive] [-c|--compact] [-C|--cursor] [-u|--urls] [-d|--depth <n>]
[-s|--selector <sel>]` -> `"snapshot"` `{interactive?, compact?, cursor?, urls?, maxDepth?,
selector?}`.

**Ref/`@eN` format** (`cli/src/native/snapshot.rs`):
- Only nodes whose role is in `INTERACTIVE_ROLES` (button, link, textbox, checkbox, radio,
  combobox, listbox, menuitem, menuitemcheckbox, menuitemradio, option, searchbox, slider,
  spinbutton, switch, tab, treeitem, Iframe — `snapshot.rs:11-28`) are always given a ref;
  `CONTENT_ROLES` (heading, cell, gridcell, columnheader, rowheader, listitem, article, region,
  main, navigation — `snapshot.rs:31-41`) get a ref only if they have a non-empty accessible
  name; `STRUCTURAL_ROLES` (generic, group, list, table, row, ... — `snapshot.rs:44-62`) never
  get refs directly. Nodes with a matching CDP-detected "cursor-interactive" element (custom
  click handlers on non-semantic elements) are force-ref'd too (`snapshot.rs:379-385`).
- Ref IDs are minted sequentially as `format!("e{}", next_ref)` (`snapshot.rs:404-405`), i.e.
  `e1`, `e2`, `e3`... global counter across the whole snapshot (continues across nested iframe
  recursion via `ref_map.set_next_ref_num`).
- Each ref is stored in `RefMap` (`cli/src/native/element.rs:18-122`) as a `RefEntry{
  backend_node_id, role, name, nth, selector, frame_id}` keyed by the ref string (e.g. `"e12"`,
  no `@`/`ref=` prefix stored — those are input-side syntax only).
- Rendered snapshot line format (`snapshot.rs:1120-1198`), one node per line, 2-space indent per
  depth level:
  `  - <role> "<json-escaped name>" [level=N, checked=X, expanded=B, selected, disabled,
  required, ref=eN, url=<href>]: <value>`
  — attributes are only emitted when present/true; `ref=eN` is appended inside the same
  bracket group as other attrs, not a separate marker. Cursor-interactive nodes append
  ` <kind> [<hints>]` after the bracket group. RootWebArea/WebArea wrapper nodes are skipped
  (children promoted); empty generic wrapper nodes with ≤1 child are collapsed
  (`snapshot.rs:1085-1110`).
- `--compact` (`compact_tree`, `snapshot.rs:1205-1242`) keeps only lines containing `ref=` or
  `: ` (a value) plus their ancestor chain up to the nearest root, dropping everything else —
  this is how the CLI trims a huge tree to just the actionable subset.
- Nested/cross-frame iframes: for `role == "Iframe"` nodes with a ref, the daemon resolves the
  frame ID via `DOM.describeNode{backendNodeId, depth:1}.node.contentDocument.frameId`
  (fallback `.node.frameId`), recursively snapshots that frame, and **splices the indented
  child tree directly under the `[ref=eN]` Iframe line** in the parent's text output
  (`snapshot.rs:505-572`, `resolve_iframe_frame_id` at `591-622`). Errors (e.g. cross-origin)
  are silently swallowed.
- Empty results: `"(empty page)"` if nothing at all; `"(no interactive elements)"` if
  `--interactive` filtered everything out (`snapshot.rs:580-585`, `compact_tree` return at
  `1238-1240`).

### Selector / ref syntax accepted by every selector-taking command
`parse_ref` (`cli/src/native/element.rs:124-147`) accepts, in this input:
1. `@e<digits>` (canonical form shown in snapshot output prefixed with `@` on the CLI side)
2. `ref=e<digits>`
3. bare `e<digits>` (no prefix) — as long as it's literally `e` followed only by ASCII digits.
Anything else falls through to being treated as a plain CSS/text selector by the daemon.

### Eval (`commands.rs:894-933`)
`eval <script...>` -> `"evaluate"` `{script}`. Flags: `eval -b|--base64 <b64-script>` (decodes
base64 then requires valid UTF-8); `eval --stdin` (reads full script from stdin, one line per
`read_line`, joined with `\n`).

### get / is / find / mouse / set / network / storage — sub-dispatch tables

`get` (`parse_get`, `commands.rs:2424-2495`), valid subcommands:
`text|html|value|attr|url|title|count|box|styles|cdp-url`
```
get text <selector>          -> "gettext"      {selector}
get html <selector>          -> "innerhtml"    {selector}
get value <selector>         -> "inputvalue"   {selector}
get attr <selector> <attr>   -> "getattribute" {selector, attribute}
get url                      -> "url"          {}
get cdp-url                  -> "cdp_url"      {}
get title                    -> "title"        {}
get count <selector>         -> "count"        {selector}
get box <selector>           -> "boundingbox"  {selector}
get styles <selector>        -> "styles"       {selector}
```

`is` (`parse_is`, `commands.rs:2497-2531`): `visible|enabled|checked`
```
is visible <selector> -> "isvisible" {selector}
is enabled <selector> -> "isenabled" {selector}
is checked <selector> -> "ischecked" {selector}
```

`find` (`parse_find`, `commands.rs:2533-2695`): locators `role|text|label|placeholder|alt|
title|testid|first|last|nth`. Common trailing args: `[action]` (subaction, default `"click"`),
optional fill text, `--name <n>` (role only), `--exact`.
```
find role <role> [action] [--name <n>] [--exact] -> "getbyrole"        {role, subaction, name, exact, value?}
find text <text> [action] [--exact]               -> "getbytext"        {text, subaction, exact}
find label <label> [action] [text] [--exact]       -> "getbylabel"       {label, subaction, exact, value?}
find placeholder <t> [action] [text] [--exact]      -> "getbyplaceholder" {placeholder, subaction, exact, value?}
find alt <text> [action] [--exact]                  -> "getbyalttext"     {text, subaction, exact}
find title <text> [action] [--exact]                -> "getbytitle"       {text, subaction, exact}
find testid <id> [action] [text]                    -> "getbytestid"      {testId, subaction, value?}
find first <selector> [action] [text]               -> "nth" {selector, index:0, subaction, value?}
find last <selector> [action] [text]                -> "nth" {selector, index:-1, subaction, value?}
find nth <idx> <selector> [action] [text]            -> "nth" {selector, index, subaction, value?}
```

`network` (`parse_network`, `commands.rs:2886-2980`): `route|unroute|requests|request|har`
```
network route <url> [--abort] [--body <json>] [--resource-type|--resource-types <csv>]
    -> "route" {url, abort, response:{body}?, resourceType?}
network unroute [url] -> "unroute" {url?}
network requests [--clear] [--filter <f>] [--type <t>] [--method <m>] [--status <s>]
    -> "requests" {clear, filter?, type?, method?, status?}
network request <requestId> -> "request_detail" {requestId}
network har start -> "har_start" {}
network har stop [path] -> "har_stop" {path?}
```

`storage` (`parse_storage`, `commands.rs:2982+`): `local|session` sub-namespaces (get/set/clear
per type — see `commands.rs:2982-3020+`).

`cookies` (`commands.rs:1318-1479`):
```
cookies                 -> "cookies_get" {}   (default op when no subcommand)
cookies set <name> <value> [--url u] [--domain d] [--path p] [--httpOnly] [--secure]
  [--sameSite Strict|Lax|None] [--expires <unix_ts>]
    -> "cookies_set" {cookies:[{name,value,url?,domain?,path?,httpOnly?,secure?,sameSite?,expires?}]}
cookies set --curl <file> [--domain d] [--url u]
    -> "cookies_set" {cookies:[...]}   (parses a JSON array, raw curl dump, or bare Cookie header)
cookies clear -> "cookies_clear" {}
```

`state` (`commands.rs:1740-1859`): `save|load|list|clear|show|clean|rename`
```
state save <path>                    -> "state_save"  {path}
state load <path>                    -> "state_load"  {path}
state list                           -> "state_list"  {}
state clear [name] [--all|-a]        -> "state_clear"  {all?, sessionName?}
state show <filename>                -> "state_show"  {path}
state clean --older-than <days>      -> "state_clean"  {days}
state rename <old> <new>             -> "state_rename" {oldName, newName}  (".json" suffix stripped)
```

### Misc top-level actions
`close|quit|exit` -> `"close"` {}; `inspect` -> `"inspect"` {}; `confirm`/`deny` (confirmation
flow, `commands.rs:1179-1194`); `connect` (`1195+`); `stream <subcmd>` (`1241+`); `tab`
(`1480+`); `window` (`1531+`); `frame` (`1547+`); `dialog` (`1560+`); `trace` (`1590+`);
`profiler` (`1613+`); `record` (`1650+`); `console`/`errors` (`1702-1709`); `highlight`
(`1710+`); `clipboard` (`1719+`); `tap`/`swipe` (iOS, `1860+`); `device` (`1890+`); `diff`
(`parse_diff`, `2151+`); `batch` (`1906+`); `react ...` (`parse_react`, `2083+`, plus
`react tree|inspect|renders start|stop|suspense` at `2101-2133`); `vitals|web-vitals`
(`1920+`); `pushstate`/`removeinitscript` (`1933+`); `mouse move|down|up|wheel`
(`parse_mouse`, `2697+`); `set ...` (`parse_set`, `2749+`); `auth save|...` (vault,
`942-1178`).

### Wire protocol / daemon response envelope
Request sent to daemon socket (`cli/src/connection.rs:24-31`):
```rust
struct Request { id: String, action: String, #[serde(flatten)] extra: Value }
```
Response received (`connection.rs:33-40`):
```rust
struct Response {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}
```
CLI's own JSON stdout on parse/serialize failure falls back to:
`{"success":false,"error":"Failed to serialize JSON response"}` (`main.rs:43-47`).

Socket/session files live under a per-namespace run dir (`connection.rs:97-165`):
`<socket_dir>/<session>.sock`, `.pid`, `.version`, `.config`, `.stream`. Namespace override via
`AGENT_BROWSER_NAMESPACE` env var, sanitized (`connection.rs:129-132`).

### Confirmation flow (action-policy gated actions)
When a command requires confirmation, daemon response `data` contains
`{confirmation_required:true, action, category, description, confirmation_id}`
(`main.rs:202-236`, `confirmation_prompt_from_data`). CLI then sends a follow-up
`{"id":..., "action":"confirm"|"deny", "confirmationId":...}` request
(`main.rs:265-277`), looping until no more confirmation prompts are nested in `data.result.data`.

## Patterns

1. **Ref-token selector system (`@eN`)** — tier: core
   - What: Every interactable/labelled AX node gets an ephemeral, session-scoped token (`eN`)
     minted at snapshot time; all interaction commands accept that token interchangeably with
     CSS selectors.
   - How to reimplement: after computing the accessibility tree, walk nodes; assign `eN` (global
     incrementing counter) only to nodes matching an "interactive roles" allowlist or "content
     roles with a non-empty name" rule; store `{backend_node_id/equivalent, role, name, nth,
     frame_id}` in a map keyed by the ref string; accept `@eN`, `ref=eN`, and bare `eN` as valid
     selector syntax on every selector-taking verb via a single `parse_ref()` gate function.
   - Evidence: `cli/src/native/snapshot.rs:371-417`, `cli/src/native/element.rs:18-147`.
   - Tier: core.

2. **Uniform `{success,data,error,warning}` response envelope over a persistent daemon socket**
   - What: single small IPC contract for every action, so the CLI's output formatter and error
     handling are action-agnostic.
   - How: request = `{id, action, ...fields}` flattened JSON; response = fixed 4-field struct;
     `warning` is optional/omit-if-none.
   - Evidence: `cli/src/connection.rs:24-40`.
   - Tier: core.

3. **`--compact` snapshot trimming by "keep node if it has a ref or a value, plus its full
   ancestor chain"** — dramatically cuts token cost of large trees while preserving both
   actionable elements and their structural context (needed for disambiguating "the 3rd row's
   button" etc.).
   - Evidence: `cli/src/native/snapshot.rs:1205-1242`.
   - Tier: important.

4. **Iframe recursion spliced inline under the parent `[ref=eN]` Iframe line**, rather than as a
   separate top-level tree — keeps the whole page (including same-process nested frames)
   representable as one flat text blob addressable by refs, with graceful silent fallback on
   cross-origin failures.
   - Evidence: `cli/src/native/snapshot.rs:505-572`.
   - Tier: important.

5. **Single dispatch-table sub-parsers per noun (`get`, `is`, `find`, `network`, `storage`,
   `cookies`, `state`) each returning a `ParseError::UnknownSubcommand{subcommand,
   valid_options}` with the exact valid list** — gives consistent, self-documenting CLI error
   messages for free and makes it trivial to enumerate the whole surface (`const VALID: &[&str]`
   at the top of every parser).
   - Evidence: e.g. `commands.rs:2424-2427` (get), `2497-2499` (is), `2533-2545` (find),
     `2886-2887` (network).
   - Tier: important.

6. **URL scheme auto-completion + explicit verb triad (`open`/`goto`/`navigate` all map to the
     same action, but `open` alone with no URL launches without navigating)** — cheap ergonomic
     win: an agent can type a bare domain and get `https://` prefixed automatically, and can
     "pre-launch" the browser via `open` (no URL) to set cookies/routes before the first real
     navigation.
   - Evidence: `commands.rs:350-403`.
   - Tier: nice.

7. **`--curl <file>` cookie import** — accepts either a JSON cookie array, a raw curl command
   dump, or a bare `Cookie:` header string and normalizes to the daemon's cookie schema, with
   optional `--domain`/`--url` override applied to every parsed cookie.
   - Evidence: `commands.rs:1324-1364` (see also `parse_curl_cookies` helper referenced there).
   - Tier: nice.

8. **Chained confirmation loop for policy-gated actions** — a single response can nest another
     `confirmation_required` prompt inside `data.result.data`, so the CLI walks that chain in a
     `while let Some(prompt) = ...` loop rather than assuming one confirmation per command.
   - Evidence: `main.rs:202-296`.
   - Tier: nice.

## Reusable code (fork candidates)

- `cli/src/native/element.rs` (`parse_ref`, `RefMap`, `RefEntry`) — the entire ref-selector
  resolution primitive; small, self-contained, directly portable to any language.
- `cli/src/native/snapshot.rs` (role allowlists `INTERACTIVE_ROLES`/`CONTENT_ROLES`/
  `STRUCTURAL_ROLES`, `render_tree`, `compact_tree`) — the AX-tree-to-text-with-refs renderer;
  the line format and compaction algorithm are worth copying verbatim.
  `cli/src/native/snapshot.rs:11-62` (role lists), `1075-1247` (render/compact).
- `cli/src/commands.rs` `parse_command` + all `parse_*` sub-dispatchers — the full argv-to-JSON
  action mapping; use directly as the spec for our own flag/verb table (verbatim signatures
  captured above).
- `cli/src/connection.rs` (`Request`/`Response` structs, socket-dir/session-file layout,
  `AGENT_BROWSER_NAMESPACE` handling) — minimal daemon IPC contract to imitate.
- `agent-browser.schema.json` — ready-made JSON Schema for the global config surface; can be
  adapted wholesale for our own config file validation.

## Anti-patterns

- `type` command historically joined every remaining arg (including `--clear`/`--delay`) into
  the typed text, so `--clear` got literally typed into the field — the current code explicitly
  guards against this by parsing flags out before joining remaining tokens
  (`commands.rs:444-472`, see the comment at 444-446). Lesson: when a trailing free-text argument
  coexists with flags, parse flags first and error loudly on malformed flag values rather than
  silently swallowing them into the text (same defensive pattern repeated for `wait --timeout`,
  see comment at `commands.rs:668-671, 675-676`).
- Screenshot selector-vs-path disambiguation is a fragile heuristic stack (leading `.`/`#`/`@`,
  relative-path prefixes, known image extensions) rather than an explicit flag
  (`commands.rs:798-822`) — copyable for ergonomics but worth exposing an explicit `--path`/
  `--selector` escape hatch too, which this design lacks.
- `cookies set` silently skips unknown flags (`_ => { i += 1; }` at `commands.rs:1470-1473`)
  rather than erroring — inconsistent with the "error loudly" philosophy used elsewhere (e.g.
  `type`/`wait`); worth NOT copying this specific inconsistency.

## Notes on scope not covered here

This digest is command-surface-focused per the assignment. `cli/src/native/{browser,cdp,
webdriver,react,stream}/*` (engine internals, CDP client, React devtools bridge, streaming/
dashboard) were only skimmed for cross-references and were intentionally left to other R2
digests focused on execution engine internals.
