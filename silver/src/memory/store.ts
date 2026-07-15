/**
 * Grep-first markdown memory store (Aside's design, keyless).
 *
 * Files-are-truth: every note is appended as a `## <timestamp> [tags]` block to
 * a dated episodic markdown file under `~/.silver/<ns>/memory/episodic/`. There
 * is NO embedding / vector index — that would need a model or a native dep;
 * Silver stays keyless + zero-dep, so retrieval is grep over the markdown
 * (search.ts). Deleting any derived state loses nothing because the markdown IS
 * the state (Aside pattern 1).
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { nsRoot } from '../core/nsdirs.js'
import { capOutput } from '../security/injection.js'

export const MEMORY_SUB = 'memory'
const MAX_NOTE = 20_000

export function memoryRoot(): string {
  return nsRoot(MEMORY_SUB)
}
export function episodicRoot(): string {
  return path.join(memoryRoot(), 'episodic')
}

/** A parsed note block: one `## …` section of an episodic file. */
export type Note = {
  file: string // absolute path
  line: number // 1-based line of the `## ` heading
  at: string | null // ISO timestamp parsed from the heading, if any
  tags: string[]
  heading: string
  body: string
}

/** The dated episodic file for `when` (UTC date). */
function episodicFileFor(when: Date): string {
  const day = when.toISOString().slice(0, 10) // YYYY-MM-DD
  return path.join(episodicRoot(), `${day}.md`)
}

/**
 * Append a note. Returns { file, line, at, tags }. The text is bounded (a
 * hostile page value cannot write an unbounded file) and tags are sanitized to
 * a safe token set.
 */
export async function addNote(
  text: string,
  tags: string[],
): Promise<{ file: string; line: number; at: string; tags: string[] }> {
  const now = new Date()
  const at = now.toISOString()
  const cleanTags = tags
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ''))
    .filter((t) => t.length > 0)
    .slice(0, 8)
  const body = capOutput(String(text ?? '').trim(), MAX_NOTE)
  const tagStr = cleanTags.length > 0 ? `  [${cleanTags.join(', ')}]` : ''
  const block = `## ${at}${tagStr}\n${body}\n\n`

  await fs.mkdir(episodicRoot(), { recursive: true })
  const file = episodicFileFor(now)

  // The heading line number = existing line count + 1 (files end with a newline
  // or are empty). Computed BEFORE appending so it points at the new `## ` line.
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch {
    existing = ''
  }
  const line = existing.length === 0 ? 1 : existing.split('\n').length - (existing.endsWith('\n') ? 1 : 0) + 1
  await fs.appendFile(file, block, 'utf8')
  return { file, line, at, tags: cleanTags }
}

/** Recursively collect every `.md` file under the memory root. */
export async function listMarkdownFiles(): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
    }
  }
  await walk(memoryRoot())
  return out.sort()
}

/** Parse one markdown file into note blocks (split on `## ` headings). */
export function parseNotes(file: string, content: string): Note[] {
  const lines = content.split('\n')
  const notes: Note[] = []
  let cur: { line: number; heading: string; bodyLines: string[] } | null = null
  const flush = () => {
    if (!cur) return
    const heading = cur.heading
    const at = parseTimestamp(heading)
    const tags = parseTags(heading)
    notes.push({
      file,
      line: cur.line,
      at,
      tags,
      heading,
      body: cur.bodyLines.join('\n').trim(),
    })
    cur = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) {
      flush()
      cur = { line: i + 1, heading: line.replace(/^##\s*/, '').trim(), bodyLines: [] }
    } else if (cur) {
      cur.bodyLines.push(line)
    }
  }
  flush()
  return notes
}

/** Load + parse every note across the memory tree, newest-first by timestamp. */
export async function loadAllNotes(): Promise<Note[]> {
  const files = await listMarkdownFiles()
  const all: Note[] = []
  for (const f of files) {
    let content: string
    try {
      content = await fs.readFile(f, 'utf8')
    } catch {
      continue
    }
    all.push(...parseNotes(f, content))
  }
  all.sort((a, b) => tsMillis(b) - tsMillis(a))
  return all
}

export function tsMillis(n: Note): number {
  if (n.at) {
    const t = Date.parse(n.at)
    if (Number.isFinite(t)) return t
  }
  return 0
}

function parseTimestamp(heading: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(heading)
  return m ? m[1] : null
}

function parseTags(heading: string): string[] {
  const m = /\[([^\]]+)\]/.exec(heading)
  if (!m) return []
  return m[1]
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}
