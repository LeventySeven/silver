/**
 * `silver memory …` — grep-first markdown memory (Aside, keyless).
 *
 * Subcommands:
 *   memory add <text> [--tag t]   append a dated markdown note
 *   memory search <query>         grep-rank the markdown (overlap + recency)
 *   memory list                   recent notes, newest first
 *
 * KEYLESS + zero-dep: no embeddings, no vectors, no model. Files are truth; the
 * markdown tree is grep-able by hand (`grep -rn <query> ~/.silver/<ns>/memory`).
 * All echoed note text is routed through the injection scrub (`neutralize`) +
 * a length cap, since a note body may itself be page-derived.
 */
import { ok, type Envelope } from '../core/envelope.js'
import type { ParsedFlags } from '../core/flags.js'
import { neutralize, capOutput } from '../security/injection.js'
import { addNote, loadAllNotes, memoryRoot, type Note } from './store.js'
import { rank } from './search.js'

const EXCERPT = 400
const DEFAULT_RESULTS = 5

function badRequest(message: string): Envelope<never> {
  return { success: false, data: null, error: message }
}

/** Scrub + cap a note excerpt before it goes back to the host. */
function excerpt(text: string): string {
  return neutralize(capOutput(String(text ?? ''), EXCERPT))
}

export async function handleMemory(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  switch (sub) {
    case 'add':
      return memoryAdd(flags)
    case 'search':
      return memorySearch(flags)
    case undefined:
    case 'list':
      return memoryList()
    default:
      return badRequest('usage: silver memory add|search|list')
  }
}

async function memoryAdd(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const text = flags.args.slice(1).join(' ').trim()
  if (!text) return badRequest('usage: silver memory add <text> [--tag <tag>]')
  // --tag is a single value flag; also accept comma-separated tags.
  const tags = (flags.tag ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const added = await addNote(text, tags)
  return ok({
    added: true,
    at: added.at,
    tags: added.tags,
    // A locatable path#Lline so a follow-up grep/read can pull the full note.
    ref: `${added.file}#L${added.line}`,
  })
}

async function memorySearch(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const query = flags.args.slice(1).join(' ').trim()
  if (!query) return badRequest('usage: silver memory search <query>')
  const notes = await loadAllNotes()
  const limit = clampLimit(flags.index) ?? DEFAULT_RESULTS
  const hits = rank(notes, query, limit)
  return ok({
    query,
    count: hits.length,
    results: hits.map((h, i) => ({
      n: i + 1,
      ref: `${h.note.file}#L${h.note.line}`,
      at: h.note.at,
      tags: h.note.tags,
      matched: h.matched,
      score: Math.round(h.score * 100) / 100,
      excerpt: excerpt(h.note.body || h.note.heading),
    })),
    note: hits.length === 0 ? 'no matching memories found in memory/' : undefined,
  })
}

async function memoryList(): Promise<Envelope<unknown>> {
  const notes = await loadAllNotes() // already newest-first
  const recent = notes.slice(0, 20).map((n: Note) => ({
    ref: `${n.file}#L${n.line}`,
    at: n.at,
    tags: n.tags,
    excerpt: excerpt(firstLine(n.body) || n.heading),
  }))
  return ok({ root: memoryRoot(), total: notes.length, recent })
}

function firstLine(body: string): string {
  return body.split('\n', 1)[0] ?? ''
}

/** `--index N` optionally overrides the result count (bounded 1..20). */
function clampLimit(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined
  return Math.min(20, Math.max(1, Math.floor(n)))
}
