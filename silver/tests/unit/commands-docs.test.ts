import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * silver/commands/*.md is the shipped PROMPT layer: package.json lists `commands`
 * in `files`, and scripts/sync-plugin.sh copies each one into the Claude Code
 * plugin surface as `/silver:<name>`. Claude Code parses the YAML frontmatter, so
 * a missing `description:` / `argument-hint:` ships a broken slash command. Until
 * now these files had zero test coverage.
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
