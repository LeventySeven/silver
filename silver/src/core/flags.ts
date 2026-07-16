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
  load?: string
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
  /** `--use-config` (E3): explicitly opt into the config-file merge (the default). */
  useConfig: boolean
  /** `--message <text>` (K1): the host message `skills resolve` scores keywords over. */
  message?: string
  // ---- network / storage verb sub-flags (Vercel-parity) ----
  /** `network requests --filter <url-substr>`. */
  filter?: string
  /** `network requests --type <resourceType>`. */
  type?: string
  /** `network requests --method <M>`. */
  method?: string
  /** `network requests --status <code>`. */
  status?: string
  /** `network route --body <json>` fulfillment body. */
  body?: string
  /** `network route --resource-types <csv>`. */
  resourceTypes: string[]
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
   * `--engine firefox|webkit|chromium` (default chromium): the Playwright
   * browser type to LAUNCH for an owned session (H1). Default stays chromium for
   * CDP/console parity; firefox/webkit are the real fix for TLS/H2-fingerprint
   * sites that fail under Chromium (cars.com et al). Threaded into openSession.
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
  body: 'body',
  // E3 / S5 / O1 / K1 wiring value flags.
  'action-policy': 'actionPolicy',
  'result-file': 'resultFile',
  message: 'message',
}

/** CSV value flags → string[]. */
const CSV_FLAGS: Record<string, 'allowedDomains' | 'confirmActions' | 'resourceTypes'> = {
  'allowed-domains': 'allowedDomains',
  'confirm-actions': 'confirmActions',
  'resource-types': 'resourceTypes',
  'resource-type': 'resourceTypes',
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
  'use-config': 'useConfig',
  // NOTE: `--wait` is handled explicitly in the parse loop (it is dual-purpose:
  // a bare boolean for `download --wait`, and `--wait networkidle` for the
  // mutating-verb full-settle opt-in), so it is intentionally NOT listed here.
}

/** `--load` (and `--load networkidle`): optional-value flag. */
const OPTIONAL_VALUE_FLAGS = new Set(['load'])

/** Coordinate-pair flags (B1): each consumes TWO following numeric tokens. */
const PAIR_FLAGS: Record<string, 'at' | 'from' | 'to'> = {
  at: 'at',
  from: 'from',
  to: 'to',
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

const NUMERIC_FIELDS = new Set<keyof ParsedFlags>(['maxOutput', 'timeout', 'depth', 'index'])

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
    full: false,
    all: false,
    stdin: false,
    force: false,
    list: false,
    background: false,
    tab: false,
    echoPlan: false,
    noConfig: false,
    useConfig: false,
    resourceTypes: [],
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
      if (name in CSV_FLAGS) {
        const key = CSV_FLAGS[name]
        const raw = inlineValue ?? argv[++i] ?? ''
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
        const value = inlineValue ?? argv[++i] ?? ''
        assignValue(f, VALUE_FLAGS[name], value)
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
        const value = body.length > 1 ? body.slice(1) : (argv[++i] ?? '')
        assignValue(f, key, value)
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
