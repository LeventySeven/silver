/**
 * Skill auto-injection matcher (adopt-list K1) — the keyless scorers that decide
 * which of N skills apply to the current page/message, implementing the
 * progressive-disclosure design Silver's skill doc specs but nothing ran.
 *
 * Two scorers (Aside `hat`/`gat` parity):
 *
 *   - `hat(hostGlob, pathGlob)` — a SPECIFICITY score for a URL-glob rule:
 *       `100·hostLiteralChars + 10·pathLiteralChars − wildcards`.
 *     More literal host characters dominate (host is the strong signal), path
 *     characters break ties, and each `*`/`?` costs a point (a broad rule ranks
 *     below a precise one). Pure function of the two globs — the URL match itself
 *     is tested separately.
 *
 *   - `gat(keywords, url)` — a word-boundary keyword count: how many of the
 *     skill's keywords appear (as whole words, case-insensitive) in `url` (or a
 *     message). Used for skills that trigger on topical words rather than a host.
 *
 * `resolveSkills(url, message, skills)` returns the applicable skills, ranked:
 *   - NON-site-specific skills are ALWAYS on (progressive disclosure — their
 *     name/description/path is always available to the host).
 *   - SITE-specific skills stay hidden until a URL-glob or keyword match fires,
 *     so a checkout-only skill never clutters an unrelated page.
 *
 * KEYLESS: pure string/regex math, no model, no network.
 */

/** A skill's auto-injection frontmatter (loaded from SKILL frontmatter by the hub). */
export type SkillAutoInject = {
  /** URL glob patterns, e.g. `"*.stripe.com/checkout/*"` (host[/path]). */
  url?: string[]
  /** Topical keywords matched (word-boundary) against the URL / message. */
  keywords?: string[]
}

/** The minimal skill descriptor the matcher scores over. */
export type Skill = {
  name: string
  description?: string
  path?: string
  /** When true, hidden until a URL/keyword match; when false/absent, always on. */
  siteSpecific?: boolean
  autoInject?: SkillAutoInject
}

/** A resolved match (only applicable skills are returned). */
export type SkillMatch = {
  skill: Skill
  /** Higher = more specific / stronger match; always-on skills score 0. */
  score: number
  /** Why the skill applies. */
  reason: 'always' | 'url' | 'keyword'
}

/** Count literal (non-wildcard) characters in a glob. */
function literalChars(glob: string): number {
  let n = 0
  for (const ch of glob) if (ch !== '*' && ch !== '?') n++
  return n
}

/** Count wildcard characters (`*`, `?`) in a glob. */
function wildcardChars(glob: string): number {
  let n = 0
  for (const ch of glob) if (ch === '*' || ch === '?') n++
  return n
}

/**
 * Specificity score of a `hostGlob` / `pathGlob` rule:
 * `100·hostLiteral + 10·pathLiteral − wildcards`. Pure; does not test the URL.
 */
export function hat(hostGlob: string, pathGlob: string): number {
  const host = String(hostGlob ?? '')
  const path = String(pathGlob ?? '')
  const wildcards = wildcardChars(host) + wildcardChars(path)
  return 100 * literalChars(host) + 10 * literalChars(path) - wildcards
}

/** Escape a keyword for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Count how many `keywords` appear as whole words (case-insensitive) in `text`
 * (a URL or a message). Word boundaries use `(?:^|[^a-z0-9])…(?:[^a-z0-9]|$)` so
 * `pay` matches `/pay` but not `paypal`.
 */
export function gat(keywords: readonly string[], text: string): number {
  const hay = String(text ?? '').toLowerCase()
  if (hay.length === 0) return 0
  let matches = 0
  for (const kw of keywords) {
    const k = String(kw ?? '').toLowerCase().trim()
    if (k.length === 0) continue
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(k)}(?:[^a-z0-9]|$)`)
    if (re.test(hay)) matches++
  }
  return matches
}

/** Glob (`**` any incl `/`, `*` any excl `/`, `?` one non-`/`) → anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  re += '$'
  return new RegExp(re, 'i')
}

/** Split a URL glob into its host and (optional) path glob parts. */
function splitUrlGlob(pattern: string): { host: string; path?: string } {
  let p = String(pattern ?? '').trim()
  // Strip an explicit scheme if present.
  const schemeIdx = p.indexOf('://')
  if (schemeIdx >= 0) p = p.slice(schemeIdx + 3)
  const slash = p.indexOf('/')
  if (slash < 0) return { host: p }
  const host = p.slice(0, slash)
  const path = p.slice(slash) // includes the leading '/'
  return { host, path: path === '/' ? undefined : path }
}

/** Parse a URL into `{ host, path }`, tolerating a scheme-less input. */
function parseUrl(url: string): { host: string; path: string } | null {
  const raw = String(url ?? '').trim()
  if (raw.length === 0) return null
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      const u = new URL(candidate)
      return { host: u.host, path: u.pathname || '/' }
    } catch {
      // try next
    }
  }
  return null
}

/** Does `url` match a `host[/path]` glob pattern? */
function urlMatchesGlob(url: string, pattern: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return false
  const { host, path } = splitUrlGlob(pattern)
  if (host.length === 0) return false
  if (!globToRegExp(host).test(parsed.host)) return false
  if (path === undefined) return true
  return globToRegExp(path).test(parsed.path)
}

/**
 * Resolve which `skills` apply to the current `url` + `message`.
 *
 * - Non-site-specific skills are always included (`reason:"always"`, score 0).
 * - Site-specific skills are included only if a URL-glob matches (ranked by
 *   {@link hat} specificity, `reason:"url"`) or a keyword matches the url/message
 *   (`reason:"keyword"`, score = keyword count). A URL match outranks a keyword
 *   match for the same skill.
 *
 * Returns the applicable skills sorted by score descending (stable for ties).
 */
export function resolveSkills(
  url: string,
  message: string,
  skills: readonly Skill[],
): SkillMatch[] {
  const out: SkillMatch[] = []

  for (const skill of skills) {
    if (!skill.siteSpecific) {
      out.push({ skill, score: 0, reason: 'always' })
      continue
    }

    const ai = skill.autoInject ?? {}
    const patterns = ai.url ?? []
    const keywords = ai.keywords ?? []

    // Best URL-glob match (by specificity).
    let urlScore = -1
    for (const pattern of patterns) {
      if (urlMatchesGlob(url, pattern)) {
        const { host, path } = splitUrlGlob(pattern)
        const s = hat(host, path ?? '')
        if (s > urlScore) urlScore = s
      }
    }

    if (urlScore >= 0) {
      out.push({ skill, score: urlScore, reason: 'url' })
      continue
    }

    // Keyword match against the URL and the message.
    const kw = gat(keywords, url) + gat(keywords, message)
    if (kw > 0) {
      out.push({ skill, score: kw, reason: 'keyword' })
    }
  }

  // Stable sort by score descending.
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map((x) => x.m)
}
