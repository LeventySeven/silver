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
 *   - Short flags: `-i` interactive, `-c` compact, `-u` urls (bool); `-d`/`-s`
 *     depth/selector (value); a `-dN` / `-d N` form is accepted.
 *   - Large / unsafe payloads arrive on stdin: `--stdin` (fill/eval body) and
 *     `--password-stdin`. This module only records the flags; the CLI reads
 *     stdin (so parsing stays synchronous + testable).
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
  maxOutput?: number
  /** ON by default; `--no-content-boundaries` disables. */
  contentBoundaries: boolean
  enableActions: boolean
  confirmActions: string[]
  /** True iff `--confirm-actions` was supplied (engages the confirm gate). */
  confirmActionsProvided: boolean
  timeout?: number
  state?: string
  incognito: boolean
  passwordStdin: boolean
  // ---- perception ----
  compact: boolean
  interactive: boolean
  depth?: number
  selector?: string
  urls: boolean
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
}

/** CSV value flags → string[]. */
const CSV_FLAGS: Record<string, 'allowedDomains' | 'confirmActions'> = {
  'allowed-domains': 'allowedDomains',
  'confirm-actions': 'confirmActions',
}

/** Boolean flags. */
const BOOL_FLAGS: Record<string, keyof ParsedFlags> = {
  json: 'json',
  headed: 'headed',
  'allow-file-access': 'allowFileAccess',
  'enable-actions': 'enableActions',
  incognito: 'incognito',
  'password-stdin': 'passwordStdin',
  compact: 'compact',
  interactive: 'interactive',
  urls: 'urls',
  full: 'full',
  all: 'all',
  stdin: 'stdin',
  force: 'force',
}

/** `--load` (and `--load networkidle`): optional-value flag. */
const OPTIONAL_VALUE_FLAGS = new Set(['load'])

const SHORT_BOOL: Record<string, keyof ParsedFlags> = {
  i: 'interactive',
  c: 'compact',
  u: 'urls',
  f: 'full',
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
    incognito: false,
    passwordStdin: false,
    compact: false,
    interactive: false,
    urls: false,
    full: false,
    all: false,
    stdin: false,
    force: false,
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
