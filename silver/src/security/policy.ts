/**
 * Action policy (adopt-list S5) — `--action-policy <file.json>` with a REAL hard
 * deny, the concept Silver's CSV-only, additive `--confirm-actions` lacks
 * ("never allow `download`, regardless of any confirmation").
 *
 * Schema (Vercel `ActionPolicy` parity — drop-in for existing policy files):
 *
 *   {
 *     "default": "allow" | "deny" | "confirm",   // fallback when nothing matches
 *     "allow":   ["click", "fill", "select"],
 *     "deny":    ["download", "buy*"],
 *     "confirm": ["submit", "pay*"]
 *   }
 *
 * Precedence — deny > confirm > allow > default. A deny match is a TERMINAL hard
 * stop: it wins even if the same verb also appears in `allow` or `confirm`. This
 * is the whole point of the item — a policy-level "no" that a confirmation cannot
 * override.
 *
 * Patterns are matched against the verb, and (when a pattern carries an `@host`
 * suffix) against `"<verb>@<host>"` using the `ctx.host`/`ctx.url` the caller
 * passes — so a fleet can write `download@*.corp.example` without special-casing.
 * Matching is a tiny glob (`*` = any run, `?` = one char); everything else is a
 * literal, case-insensitive compare.
 *
 * KEYLESS: file read + string match, no model, no network.
 *
 * NO-LEAK: {@link loadPolicy} throws only FIXED, sanitized messages (never the
 * file path / contents) so the hub's `mapThrow` surfaces no path or secret.
 */
import { readFileSync } from 'node:fs'

/** A resolved policy decision. */
export type ActionDecision = 'allow' | 'deny' | 'confirm'

/** A normalized, ready-to-evaluate action policy. */
export type ActionPolicy = {
  default: ActionDecision
  allow: string[]
  deny: string[]
  confirm: string[]
}

/** Context a caller may pass so `@host`-scoped patterns can match. */
export type ActionContext = {
  /** Target hostname (already parsed by the caller), e.g. `www.example.com`. */
  host?: string
  /** Target URL; the hostname is derived from it when `host` is absent. */
  url?: string
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'confirm'])

/** Convert a glob (`*` any-run, `?` one-char) to an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (const ch of glob) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  re += '$'
  return new RegExp(re, 'i')
}

/** Does `pattern` match `verb` (or `verb@host`)? */
function patternMatches(pattern: string, verb: string, host: string | undefined): boolean {
  const p = pattern.trim()
  if (p.length === 0) return false
  const re = globToRegExp(p)
  if (re.test(verb)) return true
  // `@host`-scoped patterns test against the composite identity.
  if (p.includes('@') && host) return re.test(`${verb}@${host}`)
  return false
}

/** True iff ANY pattern in `list` matches. */
function anyMatch(list: string[], verb: string, host: string | undefined): boolean {
  for (const pattern of list) if (patternMatches(pattern, verb, host)) return true
  return false
}

/** Coerce a raw JSON value to a string[] of trimmed, non-empty patterns. */
function toPatternList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

/**
 * Normalize a raw parsed object into an {@link ActionPolicy}. An absent/invalid
 * `default` falls back to `"allow"` (a policy file that only pins denies should
 * not accidentally deny everything). Unknown keys are ignored.
 */
export function normalizePolicy(raw: unknown): ActionPolicy {
  const rec =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const rawDefault = typeof rec.default === 'string' ? rec.default.trim().toLowerCase() : ''
  const def: ActionDecision = VALID_DECISIONS.has(rawDefault)
    ? (rawDefault as ActionDecision)
    : 'allow'
  return {
    default: def,
    allow: toPatternList(rec.allow),
    deny: toPatternList(rec.deny),
    confirm: toPatternList(rec.confirm),
  }
}

/** Parse a policy from JSON TEXT (no disk) — the testable core of {@link loadPolicy}. */
export function parsePolicy(text: string): ActionPolicy {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('action policy is not valid JSON')
  }
  return normalizePolicy(parsed)
}

/**
 * Load + normalize an action policy from disk. Throws a FIXED, path-free message
 * on read/parse failure (the hub maps it to a fail envelope). A security file
 * failing to load must fail LOUD — never silently ignored.
 */
export function loadPolicy(path: string): ActionPolicy {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error('action policy file could not be read')
  }
  return parsePolicy(text)
}

/**
 * Decide `allow` / `deny` / `confirm` for `verb` under `policy`.
 *
 * Precedence deny > confirm > allow > default. `deny` is terminal: it wins over
 * a `confirm`/`allow` match for the same verb (a real hard deny). `ctx` supplies
 * the hostname for any `@host`-scoped pattern.
 */
export function decideAction(
  policy: ActionPolicy,
  verb: string,
  ctx: ActionContext = {},
): ActionDecision {
  const v = String(verb ?? '').trim().toLowerCase()
  let host = ctx.host
  if (!host && ctx.url) {
    try {
      host = new URL(ctx.url).hostname
    } catch {
      host = undefined
    }
  }

  if (anyMatch(policy.deny, v, host)) return 'deny'
  if (anyMatch(policy.confirm, v, host)) return 'confirm'
  if (anyMatch(policy.allow, v, host)) return 'allow'
  return policy.default
}
