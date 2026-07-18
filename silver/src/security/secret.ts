/**
 * `<secret>` WRITE-PATH indirection (adopt-list E1, P0 security).
 *
 * `redact.ts` guards the READ path (masks passwords/cards in outbound snapshots).
 * This is its SYMMETRIC mirror on the WRITE path: a `fill`/`type` value may carry
 * a `<secret>NAME</secret>` token instead of the literal credential. The raw
 * secret is registered ONCE by the CLI process (from `--secret NAME=VALUE` or a
 * `SILVER_SECRET_<NAME>` env var) and resolved at the SAME choke point
 * `redactValue` occupies inside `actions.ts` — so the credential never enters the
 * host LLM's context, the CLI argv the host authored, or any envelope/error.
 *
 * DOMAIN SCOPE (the anti-exfiltration property): every secret carries a domain
 * glob. Resolution is checked against the LIVE PAGE URL, so a `bank.com` secret
 * refuses to resolve on `evil.com` even if a prompt-injected page convinces the
 * host to type `<secret>BANK_PW</secret>` into an attacker field. A refusal fails
 * the action closed; it never falls back to emitting the literal token.
 *
 * KEYLESS: pure string/URL parsing + a tiny glob matcher. No model, no network.
 */

/** The write-path token the host embeds in a fill/type value. Case-insensitive
 * tag; the NAME is `[A-Za-z0-9_.-]+`. Global+ignore-case so every occurrence in
 * a value is resolved. */
export const SECRET_TOKEN_RE = /<secret>\s*([A-Za-z0-9_.-]+)\s*<\/secret>/gi

/** Quick presence check (does this value contain any `<secret>` token at all?). */
export function hasSecretToken(value: string): boolean {
  return /<secret>/i.test(String(value ?? ''))
}

/** One registered secret: an uppercased NAME, its raw VALUE, and a domain glob. */
export type SecretEntry = { name: string; value: string; domain: string }

/**
 * Glob-match a domain spec against a hostname (~20 lines, the whole scope check).
 *
 *  - `*`            → matches any host (explicit opt-out of scoping).
 *  - a glob with `*`→ `*` expands to `.*`, anchored full-string
 *                     (`*.bank.com` matches `login.bank.com`, `a.b.bank.com`).
 *  - a plain domain → exact host OR a subdomain suffix (`bank.com` matches
 *                     `bank.com` and `login.bank.com`, NEVER `bank.com.evil.com`
 *                     — the suffix is on a dot boundary — and NEVER `evil.com`).
 */
export function domainMatches(glob: string, host: string): boolean {
  const g = String(glob ?? '').toLowerCase().trim().replace(/^\.+/, '')
  const h = String(host ?? '').toLowerCase().trim()
  if (!g || !h) return false
  if (g === '*') return true
  if (g.includes('*')) {
    const re = new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(h)
  }
  return h === g || h.endsWith('.' + g)
}

/** Extract the lowercased hostname from a page URL, or '' when unparseable. */
function hostOf(pageUrl: string): string {
  try {
    return new URL(String(pageUrl ?? '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Parse one `--secret` spec. Accepted shapes (domain optional, defaults to `*`):
 *   NAME=VALUE
 *   NAME@DOMAIN=VALUE           (glob domain scope — recommended)
 * The split is on the FIRST `=` so a VALUE may itself contain `=`. Returns null
 * for a malformed spec (no `=`, empty name). NAME is uppercased for lookup.
 */
export function parseSecretSpec(spec: string): SecretEntry | null {
  const raw = String(spec ?? '')
  const eq = raw.indexOf('=')
  if (eq < 0) return null
  const left = raw.slice(0, eq).trim()
  const value = raw.slice(eq + 1)
  if (!left) return null
  const at = left.indexOf('@')
  const name = (at >= 0 ? left.slice(0, at) : left).trim().toUpperCase()
  const domain = at >= 0 ? left.slice(at + 1).trim() || '*' : '*'
  if (!name) return null
  return { name, value, domain }
}

/**
 * Registry of resolvable secrets, keyed by uppercased NAME. Holds raw values in
 * THIS (CLI) process only — that is the entire point: the value lives here and
 * reaches the page, but never the host context or an envelope.
 */
export class SecretRegistry {
  private readonly byName = new Map<string, SecretEntry>()

  /** Number of registered secrets (does not expose any value). */
  get size(): number {
    return this.byName.size
  }

  /** Register/overwrite a secret. Later registrations win (env can override). */
  add(entry: SecretEntry): void {
    this.byName.set(entry.name.toUpperCase(), entry)
  }

  /**
   * The registered (name, domain) SCOPES — NEVER the values. For `doctor
   * --trifecta` / audit: a `*` domain means the secret resolves on ANY host (the
   * exfil leg is un-scoped), which the trifecta report flags as a risk.
   */
  scopes(): Array<{ name: string; domain: string }> {
    return [...this.byName.values()].map((e) => ({ name: e.name, domain: e.domain }))
  }

  private lookup(name: string): SecretEntry | undefined {
    return this.byName.get(String(name ?? '').toUpperCase())
  }

  /** Does `value` contain any `<secret>` token? (thin re-export for callers). */
  hasTokens(value: string): boolean {
    return hasSecretToken(value)
  }

  /**
   * Resolve every `<secret>NAME</secret>` token in `value` against `pageUrl`.
   *
   *  - No token          → `{ value, usedSecret:false, refused:false }` (pass-through).
   *  - Unknown NAME       → REFUSED (never emit the literal token to the page).
   *  - Domain mismatch    → REFUSED (the anti-exfiltration guarantee).
   *  - All tokens resolve → `{ value:<resolved>, usedSecret:true, refused:false }`.
   *
   * On refusal the ORIGINAL value is returned unchanged and `refused:true` — the
   * caller MUST fail the action closed and MUST NOT dispatch the original value.
   */
  resolveValue(
    value: string,
    pageUrl: string,
  ): { value: string; usedSecret: boolean; refused: boolean; reason?: string } {
    const input = String(value ?? '')
    if (!hasSecretToken(input)) return { value: input, usedSecret: false, refused: false }

    const host = hostOf(pageUrl)
    let refused = false
    let reason: string | undefined
    let usedSecret = false

    const out = input.replace(SECRET_TOKEN_RE, (_m, rawName: string) => {
      const entry = this.lookup(rawName)
      if (!entry) {
        refused = true
        reason = 'unknown secret'
        return _m
      }
      if (!domainMatches(entry.domain, host)) {
        refused = true
        reason = 'domain scope mismatch'
        return _m
      }
      usedSecret = true
      return entry.value
    })

    if (refused) return { value: input, usedSecret: false, refused: true, reason }
    return { value: out, usedSecret, refused: false }
  }
}

/**
 * Build a registry from CLI `--secret` specs plus `SILVER_SECRET_<NAME>` env vars.
 *
 * Env form: `SILVER_SECRET_<NAME>=VALUE`, or `SILVER_SECRET_<NAME>=DOMAIN|VALUE`
 * to carry a domain glob (no `|` ⇒ domain `*`). Explicit `--secret` specs are
 * applied AFTER env, so a flag overrides an env secret of the same name.
 */
export function buildSecretRegistry(
  specs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): SecretRegistry {
  const reg = new SecretRegistry()
  const PREFIX = 'SILVER_SECRET_'
  for (const [key, rawVal] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || rawVal === undefined) continue
    const name = key.slice(PREFIX.length).toUpperCase()
    if (!name) continue
    const bar = rawVal.indexOf('|')
    const entry: SecretEntry =
      bar >= 0
        ? { name, domain: rawVal.slice(0, bar).trim() || '*', value: rawVal.slice(bar + 1) }
        : { name, domain: '*', value: rawVal }
    reg.add(entry)
  }
  for (const spec of specs) {
    const entry = parseSecretSpec(spec)
    if (entry) reg.add(entry)
  }
  return reg
}
