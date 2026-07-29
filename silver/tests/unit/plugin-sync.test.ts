import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * scripts/sync-plugin.sh owns the copy of the canonical assets under silver/ into the
 * Claude Code plugin surface (skills/ + commands/ at the repo root). `--check` is the
 * whole guard, so it is worth testing like code.
 *
 * The bug these tests pin: the original --check built its comparison set only from the
 * canonical side (`for c in silver/commands/*.md`), so a plugin-surface file whose
 * canonical source had been DELETED or RENAMED was invisible to it. Deleting
 * silver/commands/task.md made --check print "in sync (4 files)" and exit 0 while
 * commands/task.md was still sitting in the surface — and still being published to
 * installed users as /silver:task, pointing at a command that no longer exists.
 *
 * These tests also run --check against the real repo, which is what actually wires the
 * drift guard into `npm test` — the repo has no CI and nothing else invokes it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const script = path.join(repoRoot, 'scripts', 'sync-plugin.sh')

// The published npm package ships dist/ + skill-data/ only, so scripts/ is absent there.
// Windows has no bash. Either way there is nothing to assert, not a failure.
const runnable = process.platform !== 'win32' && existsSync(script)

type Run = { status: number; stdout: string; stderr: string }

function sync(root: string, ...args: string[]): Run {
  const r = spawnSync('bash', [path.join(root, 'scripts', 'sync-plugin.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * A miniature repo with the same shape the real one has: the canonical assets under
 * silver/, the two manifests the version rule reads, and a copy of the real script.
 */
async function fixture(opts: { commands?: string[] } = {}): Promise<string> {
  const commands = opts.commands ?? ['quick.md', 'task.md']
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-plugin-sync-'))
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(root, 'silver', 'commands'), { recursive: true })
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  await fs.copyFile(script, path.join(root, 'scripts', 'sync-plugin.sh'))
  await fs.writeFile(
    path.join(root, 'silver', 'SKILL.md'),
    '# silver\n\nRead `skill-data/core/reference/taxonomy.md` for the taxonomy.\n',
  )
  for (const c of commands) {
    await fs.writeFile(
      path.join(root, 'silver', 'commands', c),
      `# ${c}\n\nLoad the guide (or read \`skill-data/core/SKILL.md\`).\n`,
    )
  }
  await fs.writeFile(path.join(root, 'silver', 'package.json'), JSON.stringify({ version: '1.2.3' }))
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'silver', version: '1.2.3' }),
  )
  return root
}

describe.skipIf(!runnable)('sync-plugin.sh --check — drift in BOTH directions', () => {
  it('a freshly synced surface is in sync', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    const check = sync(root, '--check')
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('in sync (3 files)')
  })

  it('an ORPHAN — a plugin file whose canonical source was deleted — fails the check', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)

    // Retire a command from the canonical tree. The plugin copy is left behind.
    await fs.rm(path.join(root, 'silver', 'commands', 'task.md'))
    expect(existsSync(path.join(root, 'commands', 'task.md'))).toBe(true)

    const check = sync(root, '--check')
    expect(check.status).toBe(1) // the original script exited 0 here
    expect(check.stderr).toContain('orphan: commands/task.md has no canonical source')
  })

  it('an orphaned SKILL.md is caught too, not just commands', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.rm(path.join(root, 'silver', 'SKILL.md'))
    const check = sync(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('orphan: skills/silver/SKILL.md has no canonical source')
  })

  it('a plain sync PRUNES orphans, so the surface is a pure function of silver/', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.rm(path.join(root, 'silver', 'commands', 'task.md'))

    const run = sync(root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('pruned 1 orphan')
    expect(existsSync(path.join(root, 'commands', 'task.md'))).toBe(false)
    expect(sync(root, '--check').status).toBe(0)
  })

  it('a RENAME leaves no ghost copy of the old name', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.rename(
      path.join(root, 'silver', 'commands', 'quick.md'),
      path.join(root, 'silver', 'commands', 'fast.md'),
    )

    expect(sync(root).status).toBe(0)
    const listed = (await fs.readdir(path.join(root, 'commands'))).sort()
    expect(listed).toEqual(['fast.md', 'task.md'])
    expect(sync(root, '--check').status).toBe(0)
  })

  it('still catches the direction it always caught: an edited plugin copy is stale', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.appendFile(path.join(root, 'commands', 'quick.md'), 'hand edit\n')
    const check = sync(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('stale: commands/quick.md differs from silver/commands/quick.md')
  })

  it('a canonical file with no plugin copy at all is reported as missing', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.rm(path.join(root, 'commands', 'task.md'))
    const check = sync(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('missing: silver/commands/task.md')
  })

  it('an empty silver/commands/ yields zero pairs, not one literal glob pair', async () => {
    const root = await fixture({ commands: [] })
    const run = sync(root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('synced 1 files') // SKILL.md only
    expect(sync(root, '--check').status).toBe(0)
  })
})

describe.skipIf(!runnable)('sync-plugin.sh — the skill-data path transform', () => {
  it('rewrites silver/-relative doc links to plugin-root-relative ones', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)

    // Canonical copy keeps the bare path: silver/SKILL.md sits beside silver/skill-data/.
    const canonical = await fs.readFile(path.join(root, 'silver', 'SKILL.md'), 'utf8')
    expect(canonical).toContain('`skill-data/core/reference/taxonomy.md`')

    // Plugin copy is one segment down from the plugin root, so it must say silver/.
    const plugin = await fs.readFile(path.join(root, 'skills', 'silver', 'SKILL.md'), 'utf8')
    expect(plugin).toContain('`silver/skill-data/core/reference/taxonomy.md`')
    expect(plugin).not.toMatch(/[^/]skill-data\//)

    const cmd = await fs.readFile(path.join(root, 'commands', 'quick.md'), 'utf8')
    expect(cmd).toContain('`silver/skill-data/core/SKILL.md`')
  })

  it('--check compares the TRANSFORMED source, so the transform itself is what is verified', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    expect(sync(root, '--check').status).toBe(0)

    // Hand-writing the untransformed (canonical) text into the plugin copy must fail,
    // otherwise the broken bare path could be reintroduced without the check noticing.
    await fs.copyFile(
      path.join(root, 'silver', 'SKILL.md'),
      path.join(root, 'skills', 'silver', 'SKILL.md'),
    )
    expect(sync(root, '--check').status).toBe(1)
  })

  it('the transform is idempotent — re-syncing does not stack silver/ prefixes', async () => {
    const root = await fixture()
    sync(root)
    sync(root)
    sync(root)
    const plugin = await fs.readFile(path.join(root, 'skills', 'silver', 'SKILL.md'), 'utf8')
    expect(plugin).not.toContain('silver/silver/skill-data/')
    expect(sync(root, '--check').status).toBe(0)
  })
})

describe.skipIf(!runnable)('sync-plugin.sh — plugin version is the update identity', () => {
  // An explicit `version` in plugin.json pins installed users to that string until it is
  // bumped, so a forgotten bump silently ships an old prompt layer. Pinning it to the CLI
  // version makes the bump enforced rather than remembered.
  it('fails when plugin.json disagrees with silver/package.json', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'silver', version: '0.0.1' }),
    )
    const check = sync(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('version: .claude-plugin/plugin.json is 0.0.1')
  })

  it('omitting version entirely is allowed (Claude Code falls back to the commit SHA)', async () => {
    const root = await fixture()
    expect(sync(root).status).toBe(0)
    await fs.writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'silver' }),
    )
    expect(sync(root, '--check').status).toBe(0)
  })
})

describe.skipIf(!runnable)('the real repo', () => {
  // Nothing else runs the drift guard — no CI, no git hook, no npm script. This test is
  // the wiring: `npm test` now fails if the plugin surface has drifted from silver/.
  it('plugin surface is in sync with silver/', () => {
    const check = sync(repoRoot, '--check')
    expect(`${check.stdout}${check.stderr}`.trim()).toContain('in sync')
    expect(check.status).toBe(0)
  })
})
