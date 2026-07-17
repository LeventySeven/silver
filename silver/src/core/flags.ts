/**
 * argv / flag parser (plan Task 11).
 *
 * Parses the global flag superset (a compatible superset of Vercel's
 * agent-browser) plus the positional `verb` and its args. Every value is its own
 * argv element — the CLI never builds a shell string, so an injected page value
 * can never smuggle a flag (red-team S6).
 *
 * Design:
 *   - Boolean flags set a field true.
 *   - Value flags consume the FOLLOWING argv token (or a `--flag=value` form).
 *   - `--content-boundaries` is ON by default; `--no-content-boundaries` turns it
 *     off (the only tri-state flag).
 *   - Short flags: `-i` interactive, `-c` compact; `-d`/`-s` depth/selector
 *     (value); a `-dN` / `-d N` form is accepted.
 *   - Large / unsafe payloads arrive on stdin: `--stdin` (fill/eval body). This
 *     module only records the flag; the CLI reads stdin (so parsing stays
 *     synchronous + testable).
 *
 * KEYLESS: pure string parsing, no I/O, no model.
 */

export type ParsedFlags = {
  // ---- global ----
  session: string
  /**
   * Sidecar-dir prefix isolating independent agent-GROUPS: sessions live under
   * `~/.silver/<namespace>/sessions/…` instead of `~/.silver/sessions/…`. Two
   * groups using the same `--session default` never collide across namespaces.
   */
  namespace?: string
  json: boolean
  headed: boolean
  allowedDomains: string[]
  allowFileAccess: boolean
  /** E2: launch an owned session against an EXISTING user-data-dir (the user's
   * real logged-in Chrome profile) instead of a throwaway per-session dir. */
  profile?: string
  maxOutput?: number
  /** ON by default; `--no-content-boundaries` disables. */
  contentBoundaries: boolean
  enableActions: boolean
  confirmActions: string[]
  /** True iff `--confirm-actions` was supplied (engages the confirm gate). */
  confirmActionsProvided: boolean
  /**
   * `--two-phase-confirm` (S4): opt into the decoupled confirm/deny protocol.
   * When set, a paid/destructive action that would otherwise hard-deny with
   * `confirm_required` on a non-TTY session instead returns
   * `status:"requires_confirmation"` + a `confirmation_id`; a follow-up
   * `silver confirm <id>` proceeds (or `silver deny <id>` aborts). OFF by
   * default so the existing fail-closed hard-deny behavior is unchanged.
   */
  twoPhaseConfirm: boolean
  timeout?: number
  state?: string
  incognito: boolean
  /**
   * Disable AES-256-GCM encryption-at-rest for session sidecars (write
   * plaintext JSON). For debugging / plaintext inspection; reads still accept
   * both forms. Also settable via `SILVER_NO_ENCRYPT_STATE=1`.
   */
  noEncryptState: boolean
  // ---- perception ----
  compact: boolean
  interactive: boolean
  /** `--urls`/`-u`: emit inline `url=<href>` on link nodes in the snapshot. OFF
   * by default (token-lean); pass it when the host needs raw hrefs (engine-plan T1). */
  urls: boolean
  depth?: number
  selector?: string
  full: boolean
  // ---- misc per-verb ----
  all: boolean
  stdin: boolean
  force: boolean
  scope?: string
  prefix?: string
  url?: string
  curl?: string
  schema?: string
  instruction?: string
  ids?: string
  text?: string
  /** `wait --text-gone <s>` (item #7): wait until the text DISAPPEARS (getByText →
   * state:hidden). The read-only, keyless complement of `wait --text` (which waits
   * for appearance) — no `--fn`/`--enable-actions` needed to await a spinner vanish. */
  textGone?: string
  load?: string
  /**
   * `wait --ready` (S5): dual-quiet page-ready wait — resolve when the page is
   * BOTH DOM-quiet (MutationObserver) AND network-quiet (pending requests == 0).
   * Read-only; more robust than `--load networkidle` on never-idling SPAs.
   */
  ready: boolean
  /**
   * `read --links` (S6): emit `[text](url)` markdown links in the `read <url>`
   * output. OFF by default (token-lean — just the link text).
   */
  links: boolean
  fn?: string
  name?: string
  index?: number
  /** `tab new --label <L>`: durable human-facing name for a tab. */
  label?: string
  // ---- task / memory / subagent layer flags (silver task/memory/subagent) ----
  /** `task start --id <id>` / `task <sub> --id` — explicit task id. */
  id?: string
  /** `memory add --tag <t>` — comma-separated note tags. */
  tag?: string
  /** `task checkpoint --note <t>` — free-text checkpoint note. */
  note?: string
  /** `skill --list` — enumerate the reference topics (G5). */
  list: boolean
  /** `subagent spawn --background` — non-blocking child (host collects later). */
  background: boolean
  /** `subagent spawn --tab` — child runs on its own tab in a shared browser. */
  tab: boolean
  // ---- E3 / S5 / O1 / T6a / K1 wiring flags ----
  /** `--action-policy <file.json>` (S5): a real deny/allow/confirm policy file
   * consulted ahead of the confirm gate. Absent → no policy layer. */
  actionPolicy?: string
  /** `--result-file <path>` (O1): write a full subagent result to disk instead of
   * truncating it into the envelope. */
  resultFile?: string
  /** `--echo-plan` (T6a): append the current plan/goal to each `task exec` envelope. */
  echoPlan: boolean
  /** `--no-config` (E3): skip the `~/.silver/config.json` + `silver.json` merge. */
  noConfig: boolean
  /** `--message <text>` (K1): the host message `skills resolve` scores keywords over. */
  message?: string
  /**
   * `--secret NAME=value[@domain]` (repeatable, E1): register a write-path secret
   * resolvable via `<secret>NAME</secret>` in a fill/type value. Also merged with
   * `SILVER_SECRET_<NAME>` env vars. The raw value stays in the CLI process; it
   * never enters the host context or an envelope. See security/secret.ts.
   */
  secrets: string[]
  /**
   * `--taint-guard` (opt-in, S1): reject a mutating-verb argument that still
   * carries the ⟦untrusted⟧ page-content provenance fence (a likely inject-and-act
   * / exfil vector). OFF by default — see security/taint.ts for why opt-in.
   */
  taintGuard: boolean
  // ---- network / storage verb sub-flags (Vercel-parity) ----
  /** `network requests --filter <url-substr>`. */
  filter?: string
  /** `network requests --type <resourceType>`. */
  type?: string
  /** `network requests --method <M>`. */
  method?: string
  /** `network requests --status <code>`. */
  status?: string
  /** `console --level <log|info|warn|error|debug>` (item #16): keep only messages at
   * this level (token-lean selection at the source — drop debug/info noise). */
  level?: string
  /** `dialog accept --prompt-text <t>` (item #17): the text a pre-armed `accept`
   * feeds a `prompt()` before accepting. */
  promptText?: string
  /** `screenshot --quality <0-100>` (item #5): JPEG quality (ignored for PNG). */
  quality?: number
  /** `network route --body <json>` fulfillment body. */
  body?: string
  /** `network route --content-type <ct>` (item #9): explicit fulfill Content-Type
   * (else guessed from the body shape). */
  contentType?: string
  /** `network route --headers '<json>'` (item #9): extra response headers to set on
   * a fulfilled mock (JSON object, string→string). */
  headers?: string
  /** `network route --remove-headers <csv>` (item #9): response header names to strip. */
  removeHeaders: string[]
  /** `network request <i> --part <request|response|body>` (item #11): which slice of a
   * single captured request to return (default: a compact summary of all). */
  part?: string
  /** `network route --resource-types <csv>`. */
  resourceTypes: string[]
  /** `click|dblclick --button <left|right|middle>` (item #1): mouse button for a
   * grounded click. Default left when absent. */
  button?: string
  /** `click|dblclick --modifiers <Shift,Control,Alt,Meta>` (item #1): modifier
   * keys held during a grounded click (ctrl/cmd-click, shift-select). CSV. */
  modifiers: string[]
  /** `network route --abort`. */
  abort: boolean
  /** `network requests|console|errors --clear`. */
  clear: boolean
  /** `batch --bail`: stop on the first failing sub-command. */
  bail: boolean
  /** `download --wait [path]`: await the NEXT download without a click. */
  wait: boolean
  /** `--wait networkidle`: on a mutating verb (open/click/…), opt into the full
   * network-idle wait instead of the lowered default budget (engine-plan P1b). */
  waitNetworkidle: boolean
  /**
   * `--engine chromium` (the only supported value). Silver's perception and
   * actuation are CDP-only (`context.newCDPSession`), which firefox/webkit do
   * NOT expose — a non-chromium session could open but never snapshot. So
   * `--engine firefox|webkit` is REJECTED at session launch with a clear
   * `engine_unsupported` error (F1); it is not a working fallback for
   * TLS/H2-fingerprint sites. Threaded into openSession, which enforces this.
   */
  engine?: string
  /**
   * `--grant-permissions`: on session connect, auto-grant the low-risk browser
   * permission prompts (geolocation/clipboard/notifications) so a task that hits
   * a permission dialog does not hang (E4). Flag-gated — OFF by default.
   */
  grantPermissions: boolean
  // ---- coordinate-verb fallback (B1): raw {x,y} for canvas/custom widgets with
  // no AX ref. Numeric pairs; each consumes TWO following tokens. ----
  /** `click --at <x> <y>` / `type --at <x> <y> <text>`: click/type target point. */
  at?: [number, number]
  /** `drag --from <x> <y> --to <x> <y>`: drag start point. */
  from?: [number, number]
  /** `drag --from <x> <y> --to <x> <y>`: drag end point. */
  to?: [number, number]
  /**
   * `scroll @ref --by <dx> <dy>` (FIX #6): scroll the grounded element's OWN
   * scroll box by the given delta (keyless inner-container scroll — chat pane,
   * modal body, virtualized list). Consumes TWO following numeric tokens; a
   * negative value scrolls up/left. Absent → `scroll @ref` keeps its
   * scroll-into-view behavior.
   */
  by?: [number, number]
  // ---- positionals ----
  verb: string
  args: string[]
}

/** Value flags: always consume the next token (or `=value`). */
const VALUE_FLAGS: Record<string, keyof ParsedFlags> = {
  session: 'session',
  namespace: 'namespace',
  'max-output': 'maxOutput',
  timeout: 'timeout',
  state: 'state',
  scope: 'scope',
  prefix: 'prefix',
  url: 'url',
  curl: 'curl',
  schema: 'schema',
  instruction: 'instruction',
  ids: 'ids',
  text: 'text',
  'text-gone': 'textGone',
  fn: 'fn',
  name: 'name',
  index: 'index',
  label: 'label',
  depth: 'depth',
  selector: 'selector',
  // task / memory / subagent layer value flags.
  id: 'id',
  tag: 'tag',
  note: 'note',
  // H1: browser engine to launch for an owned session.
  engine: 'engine',
  // E2: existing user-data-dir (real Chrome profile) to launch against.
  profile: 'profile',
  // network / storage verb sub-flags.
  filter: 'filter',
  type: 'type',
  method: 'method',
  status: 'status',
  level: 'level',
  'prompt-text': 'promptText',
  body: 'body',
  // item #1: mouse button for a grounded click/dblclick.
  button: 'button',
  // item #5: JPEG quality for screenshot.
  quality: 'quality',
  // item #9: mock response Content-Type + extra headers (JSON).
  'content-type': 'contentType',
  headers: 'headers',
  // item #11: which slice of a single captured request to return.
  part: 'part',
  // E3 / S5 / O1 / K1 wiring value flags.
  'action-policy': 'actionPolicy',
  'result-file': 'resultFile',
  message: 'message',
}

/** CSV value flags → string[]. */
const CSV_FLAGS: Record<
  string,
  'allowedDomains' | 'confirmActions' | 'resourceTypes' | 'modifiers' | 'removeHeaders'
> = {
  'allowed-domains': 'allowedDomains',
  'confirm-actions': 'confirmActions',
  'resource-types': 'resourceTypes',
  'resource-type': 'resourceTypes',
  // item #1: modifier keys held during a grounded click.
  modifiers: 'modifiers',
  // item #9: response header names to strip from a fulfilled mock.
  'remove-headers': 'removeHeaders',
}

/** Boolean flags. */
const BOOL_FLAGS: Record<string, keyof ParsedFlags> = {
  json: 'json',
  headed: 'headed',
  'allow-file-access': 'allowFileAccess',
  'enable-actions': 'enableActions',
  incognito: 'incognito',
  'no-encrypt-state': 'noEncryptState',
  compact: 'compact',
  interactive: 'interactive',
  urls: 'urls',
  // S5: `wait --ready` dual-quiet page-ready. S6: `read --links` markdown links.
  ready: 'ready',
  links: 'links',
  full: 'full',
  all: 'all',
  stdin: 'stdin',
  force: 'force',
  list: 'list',
  // subagent spawn boolean flags.
  background: 'background',
  tab: 'tab',
  // network / batch verb boolean flags.
  abort: 'abort',
  clear: 'clear',
  bail: 'bail',
  // E4: opt-in permission auto-grant on connect (geolocation/clipboard/…).
  'grant-permissions': 'grantPermissions',
  // S4: opt into the decoupled confirm/deny two-phase gate.
  'two-phase-confirm': 'twoPhaseConfirm',
  // T6a / E3 wiring boolean flags.
  'echo-plan': 'echoPlan',
  'no-config': 'noConfig',
  // S1: opt-in data-provenance (taint) guard on mutating verbs.
  'taint-guard': 'taintGuard',
  // NOTE: `--wait` is handled explicitly in the parse loop (it is dual-purpose:
  // a bare boolean for `download --wait`, and `--wait networkidle` for the
  // mutating-verb full-settle opt-in), so it is intentionally NOT listed here.
}

/** `--load` (and `--load networkidle`): optional-value flag. */
const OPTIONAL_VALUE_FLAGS = new Set(['load'])

/** Coordinate-pair flags (B1): each consumes TWO following numeric tokens.
 * `by` (FIX #6) is a delta-pair on the same machinery: `scroll @ref --by dx dy`. */
const PAIR_FLAGS: Record<string, 'at' | 'from' | 'to' | 'by'> = {
  at: 'at',
  from: 'from',
  to: 'to',
  by: 'by',
}

const SHORT_BOOL: Record<string, keyof ParsedFlags> = {
  i: 'interactive',
  c: 'compact',
  f: 'full',
  u: 'urls',
}
const SHORT_VALUE: Record<string, 'depth' | 'selector'> = {
  d: 'depth',
  s: 'selector',
}

const NUMERIC_FIELDS = new Set<keyof ParsedFlags>([
  'maxOutput',
  'timeout',
  'depth',
  'index',
  'quality',
])

function defaults(): ParsedFlags {
  return {
    session: 'default',
    json: false,
    headed: false,
    allowedDomains: [],
    allowFileAccess: false,
    contentBoundaries: true,
    enableActions: false,
    confirmActions: [],
    confirmActionsProvided: false,
    twoPhaseConfirm: false,
    incognito: false,
    noEncryptState: false,
    compact: false,
    interactive: false,
    urls: false,
    ready: false,
    links: false,
    full: false,
    all: false,
    stdin: false,
    force: false,
    list: false,
    background: false,
    tab: false,
    echoPlan: false,
    noConfig: false,
    secrets: [],
    taintGuard: false,
    resourceTypes: [],
    modifiers: [],
    removeHeaders: [],
    abort: false,
    clear: false,
    bail: false,
    wait: false,
    waitNetworkidle: false,
    grantPermissions: false,
    verb: '',
    args: [],
  }
}

/** Parse argv (already sliced past `node script`). */
export function parseFlags(argv: string[]): ParsedFlags {
  const f = defaults()
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    // `--` sentinel: everything after is positional.
    if (token === '--') {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j])
      break
    }

    if (token.startsWith('--')) {
      let name = token.slice(2)
      let inlineValue: string | undefined
      const eq = name.indexOf('=')
      if (eq >= 0) {
        inlineValue = name.slice(eq + 1)
        name = name.slice(0, eq)
      }

      if (name === 'content-boundaries') {
        f.contentBoundaries = true
        continue
      }
      if (name === 'no-content-boundaries') {
        f.contentBoundaries = false
        continue
      }
      // `--wait` is dual-purpose. As a bare boolean it drives `download --wait`.
      // As `--wait networkidle` (or `--wait=networkidle`) it opts a mutating verb
      // into the full network-idle settle (engine-plan P1b). We ONLY consume the
      // following token when it is literally `networkidle`, so `download --wait
      // <path>` keeps `<path>` as a positional.
      if (name === 'wait') {
        f.wait = true
        const val = inlineValue ?? (argv[i + 1] === 'networkidle' ? argv[++i] : undefined)
        if (val === 'networkidle') f.waitNetworkidle = true
        continue
      }
      // Coordinate-pair flags (B1): `--at x y`, `--from x y`, `--to x y`. Each
      // consumes the next TWO tokens as finite numbers; a `--at=x,y` inline form
      // is also accepted. A malformed pair leaves the field undefined (the verb
      // handler then reports a clean usage error), never a partial coordinate.
      if (name in PAIR_FLAGS) {
        const key = PAIR_FLAGS[name]
        let xs: string | undefined
        let ys: string | undefined
        if (inlineValue !== undefined) {
          ;[xs, ys] = inlineValue.split(',')
        } else {
          xs = argv[++i]
          ys = argv[++i]
        }
        const x = Number(xs)
        const y = Number(ys)
        if (Number.isFinite(x) && Number.isFinite(y)) f[key] = [x, y]
        continue
      }
      // `--secret NAME=value[@domain]` (E1): REPEATABLE — each occurrence appends
      // one spec. Parsed/validated later by buildSecretRegistry; the parser only
      // collects the raw specs (never logs/echoes them). F7-guarded: a bare
      // `--secret --session s` does not swallow `--session`.
      if (name === 'secret') {
        const t = takeValue(argv, i, inlineValue)
        i = t.i
        if (t.value !== undefined) f.secrets.push(t.value)
        continue
      }
      if (name in CSV_FLAGS) {
        const key = CSV_FLAGS[name]
        const t = takeValue(argv, i, inlineValue)
        i = t.i
        const raw = t.value ?? ''
        f[key] = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        if (name === 'confirm-actions') f.confirmActionsProvided = true
        continue
      }
      if (name in BOOL_FLAGS) {
        assignBool(f, BOOL_FLAGS[name])
        continue
      }
      if (OPTIONAL_VALUE_FLAGS.has(name)) {
        const next = argv[i + 1]
        if (inlineValue !== undefined) f.load = inlineValue
        else if (next !== undefined && !next.startsWith('-')) {
          f.load = next
          i++
        } else f.load = 'load'
        continue
      }
      if (name in VALUE_FLAGS) {
        // F7: do not consume a following token that itself looks like a flag —
        // leave the field unset rather than eating the next flag as this value.
        const t = takeValue(argv, i, inlineValue)
        i = t.i
        if (t.value !== undefined) assignValue(f, VALUE_FLAGS[name], t.value)
        continue
      }
      // Unknown long flag: record as a bool-ish no-op so it never becomes a
      // positional / verb. Lenient by design.
      continue
    }

    if (token.startsWith('-') && token.length > 1 && !isNegativeNumber(token)) {
      const body = token.slice(1)
      const char = body[0]
      if (char in SHORT_VALUE) {
        const key = SHORT_VALUE[char]
        if (body.length > 1) {
          // Attached form `-d5`: the value rides on the same token.
          assignValue(f, key, body.slice(1))
        } else {
          // Detached form `-d 5`: consume the next token ONLY when it is not
          // itself a flag (F7) — `-d --session s` must not eat `--session`.
          const t = takeValue(argv, i, undefined)
          i = t.i
          if (t.value !== undefined) assignValue(f, key, t.value)
        }
        continue
      }
      if (char in SHORT_BOOL) {
        // Support simple bundling of boolean shorts (e.g. -ic).
        for (const c of body) {
          if (c in SHORT_BOOL) assignBool(f, SHORT_BOOL[c])
        }
        continue
      }
      // Unknown short flag: ignore.
      continue
    }

    positionals.push(token)
  }

  f.verb = positionals[0] ?? ''
  f.args = positionals.slice(1)
  return f
}

function assignBool(f: ParsedFlags, key: keyof ParsedFlags): void {
  ;(f as Record<string, unknown>)[key] = true
}

function assignValue(f: ParsedFlags, key: keyof ParsedFlags, raw: string): void {
  if (NUMERIC_FIELDS.has(key)) {
    const n = Number(raw)
    if (Number.isFinite(n)) (f as Record<string, unknown>)[key] = n
    return
  }
  ;(f as Record<string, unknown>)[key] = raw
}

function isNegativeNumber(token: string): boolean {
  return /^-\d/.test(token)
}

/**
 * F7: does `token` look like a flag (so a value flag must NOT swallow it)? A
 * `-`/`--` prefixed token that is not a negative number. Without this guard a
 * value flag with no value (`-d --session s`) consumes the FOLLOWING flag as its
 * value, silently dropping `--session`. A negative number (`-1`) is still a
 * legitimate value, so it is explicitly excluded.
 */
function looksLikeFlag(token: string | undefined): boolean {
  if (token === undefined) return false
  if (!token.startsWith('-') || token.length < 2) return false
  return !isNegativeNumber(token)
}

/**
 * Resolve the value for a value-flag: the inline `=value`, else the next token —
 * but ONLY when that token does not itself look like a flag (F7). Returns the
 * value (or undefined when none is available) and the new loop index.
 */
function takeValue(
  argv: string[],
  i: number,
  inlineValue: string | undefined,
): { value: string | undefined; i: number } {
  if (inlineValue !== undefined) return { value: inlineValue, i }
  const next = argv[i + 1]
  if (next !== undefined && !looksLikeFlag(next)) return { value: next, i: i + 1 }
  return { value: undefined, i }
}
