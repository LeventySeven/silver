import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * silver/commands/*.md is the shipped PROMPT layer: package.json lists `commands`
 * in `files`, and scripts/sync-plugin.sh copies each one into the Claude Code
 * plugin surface as `/silver:<name>`. Claude Code parses the YAML frontmatter, so
 * a missing `description:` / `argument-hint:` ships a broken slash command. Until
 * now these files had zero test coverage.
 *
 * The second half of this file widens that to the OTHER shipped prose — README.md,
 * SKILL.md, skill-data/ — because the regressions that actually reached users were
 * there, not in commands/. See the block comment above it.
 */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const commandsDir = path.join(pkgRoot, 'commands')

// The published npm package ships dist/ + skill-data/ + commands/; a source
// checkout always has commands/. Nothing to assert if it is absent.
const files = existsSync(commandsDir)
  ? readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : []

function read(name: string): string {
  return readFileSync(path.join(commandsDir, name), 'utf8')
}

describe.skipIf(files.length === 0)('shipped command docs (silver/commands/*.md)', () => {
  it('every command doc opens with parseable frontmatter carrying both keys', () => {
    for (const f of files) {
      const body = read(f)
      const m = /^---\n([\s\S]*?)\n---\n/.exec(body)
      expect(m, `${f} has no leading frontmatter block`).not.toBeNull()
      const fm = m![1]
      expect(/^description:\s*\S.+$/m.test(fm), `${f}: empty/missing description`).toBe(true)
      expect(/^argument-hint:\s*\S.+$/m.test(fm), `${f}: empty/missing argument-hint`).toBe(true)
      // The body is a prompt template — it must actually use its arguments.
      expect(body.includes('$ARGUMENTS'), `${f}: never references $ARGUMENTS`).toBe(true)
    }
  })
})

describe.skipIf(!existsSync(path.join(commandsDir, 'preview.md')))('/preview (issue #1)', () => {
  const doc = read('preview.md')

  it('states the invariant verbatim — it is the whole point of the command', () => {
    expect(doc).toContain('silver never hands over a URL it has not itself loaded')
  })

  it('tells the host to read the observed status and stop on an HTTP error', () => {
    expect(doc).toContain('data.status')
    expect(doc).toContain('http_error')
    // `status: null` (a same-document nav) is NOT observed — never read as 200.
    expect(doc).toMatch(/status: null/)
  })

  it('keeps the 127.0.0.1 -> localhost rewrite, which most dev servers need', () => {
    // The egress guard denies a loopback IP literal BEFORE the allowlist is
    // consulted, so --allowed-domains provably cannot lift it. Drop this line and
    // the command fails against every Vite/Next default.
    expect(doc).toContain('127.0.0.1')
    expect(doc).toContain('localhost')
  })

  it('does not ask silver to do what silver deliberately cannot (git / spawning)', () => {
    // silver's only child process is Chromium and it reads no git metadata; those
    // steps belong to the host's own Bash. A `silver <git|npm|serve>` instruction
    // here would be a promise the CLI cannot keep.
    expect(doc).not.toMatch(/silver\s+(git|npm|pnpm|yarn|serve|spawn|exec\s)/)
  })
})

// ---------------------------------------------------------------------------
// The install line, across EVERY shipped doc — not just commands/.
// ---------------------------------------------------------------------------

/**
 * `silver` on npm belongs to a squatter; silver publishes as `agent-silver` (the
 * command is still `silver`). The wrong install line has actually shipped once and
 * was hand-fixed — it is the single most expensive typo in the package, because it
 * is the FIRST line a new user runs and it installs someone else's code.
 *
 * The block above globs `commands/` only, so the two files that carry the install
 * line (README.md, SKILL.md) had zero coverage. This closes that: every doc listed
 * in package.json `files` that a human reads before typing anything.
 *
 * Deliberately NOT asserted here: that extract examples show grounded URLs. The
 * other shipped-prose regression was a README extract example whose `url` was
 * ungrounded — but README.md shows a *shape* (`{"links":[{"title":"string","url":
 * "string"}]}`) that is grounded only because silver ID-transforms it, while
 * skill-data/core/examples.md shows real URLs that are correct precisely because
 * they are `resolve` OUTPUT. No mechanical rule separates those two from a
 * regression, and a rule that cannot be stated mechanically is a flaky test that
 * the next person deletes. Leave it to review.
 */

/** Files (not dirs) that ship and carry onboarding prose. SKILL.md sits OUTSIDE
 * skill-data/, so a `skill-data/**` glob alone would miss the doc that Claude Code
 * actually loads. */
const DOC_FILES = ['README.md', 'SKILL.md']
/** Dirs walked for *.md. skill-data/ ships whole (package.json `files`). */
const DOC_DIRS = ['skill-data']

/**
 * Hand-rolled walk instead of `fs.glob` (Node 22+) or `readdirSync(…, {recursive:
 * true})` (Node 20.1+): package.json declares `engines: {"node": ">=20"}`, and
 * @types/node is ^24, so TypeScript would happily typecheck an API that throws on
 * the oldest Node we claim to support. `withFileTypes` predates every Node we run.
 */
function walkMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkMarkdown(full))
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full)
  }
  return out
}

const shippedDocs: string[] = [
  ...DOC_FILES.map((f) => path.join(pkgRoot, f)).filter(
    (p) => existsSync(p) && statSync(p).isFile(),
  ),
  ...DOC_DIRS.map((d) => path.join(pkgRoot, d))
    .filter((p) => existsSync(p))
    .flatMap(walkMarkdown),
]

/**
 * The matcher is anchored on purpose. `/npm\s+i\s+-g\s+.*silver/` — the obvious
 * first attempt — matches the CORRECT line `npm i -g agent-silver` and so can
 * never fail, i.e. it is a test that only ever lies. These require WHITESPACE
 * immediately before `silver`, which `agent-silver` cannot satisfy (the char
 * before `silver` there is `-`), and a trailing lookahead so a legitimate
 * `silver-foo` package name is not a false hit while `silver@latest` — still the
 * squatter — is. Both flag orderings, because either would ship the same mistake.
 */
const SQUATTED_INSTALL: ReadonlyArray<{ what: string; re: RegExp }> = [
  {
    what: 'flag before name',
    re: /\bnpm\s+(?:i|install|add)\s+(?:-g|--global)\s+silver(?![\w./-])/,
  },
  {
    what: 'flag after name',
    re: /\bnpm\s+(?:i|install|add)\s+silver(?![\w./-])[^\n]*(?:-g\b|--global\b)/,
  },
]

describe.skipIf(shippedDocs.length === 0)('shipped docs name agent-silver, not the squatter', () => {
  it('no doc tells a new user to install the squatted `silver` package', () => {
    for (const file of shippedDocs) {
      const body = readFileSync(file, 'utf8')
      const rel = path.relative(pkgRoot, file)
      for (const { what, re } of SQUATTED_INSTALL) {
        const hit = re.exec(body)
        expect(
          hit,
          `${rel} installs the squatted npm package (${what}): ${JSON.stringify(hit?.[0])} — ` +
            'the package is `agent-silver`, the command is `silver`',
        ).toBeNull()
      }
    }
  })

  it('covers README.md and SKILL.md, the two files that actually carry it', () => {
    // A future refactor that moves a doc under skill-data/ must not silently drop
    // the two paths this test exists for. Cheap tripwire on the glob itself.
    const rels = shippedDocs.map((f) => path.relative(pkgRoot, f))
    expect(rels).toContain('README.md')
    expect(rels).toContain('SKILL.md')
    expect(rels.some((r) => r.startsWith(`skill-data${path.sep}`))).toBe(true)
  })
})
