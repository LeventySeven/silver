/**
 * Namespace-scoped sidecar roots for the task / memory / subagent layers.
 *
 * Mirrors session.ts's `sessionsRoot()` namespace logic (un-namespaced:
 * `~/.silver/<sub>`; under a namespace `ns`: `~/.silver/<ns>/<sub>`) so the
 * long-task artifacts, grep-first memory, and the subagent registry are
 * isolated per agent-GROUP exactly like sessions are. Reuses `currentNamespace()`
 * — the single source of truth for the active namespace — instead of
 * reinventing namespace resolution.
 *
 * KEYLESS: pure path math + a tiny sanitizer, no model, no network.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { currentNamespace } from './session.js'

/** `~/.silver` (un-namespaced) or `~/.silver/<ns>`. */
export function silverRoot(): string {
  const base = path.join(os.homedir(), '.silver')
  const ns = currentNamespace()
  return ns ? path.join(base, ns) : base
}

/** A namespace-scoped sidecar subdir, e.g. `nsRoot('tasks')` → `~/.silver/<ns>/tasks`. */
export function nsRoot(sub: string): string {
  return path.join(silverRoot(), sub)
}

/**
 * Validate an id / name used as a SINGLE path segment (task id, subagent id,
 * memory tag). Same charset as session names; rejects `.`/`..` traversal and any
 * separator. Returns the trimmed id on success or `null` on rejection — the
 * caller turns `null` into a clean bad-request. The id is NEVER echoed into an
 * error string, honoring the no-leak invariant.
 */
export function sanitizeSegment(id: string | undefined): string | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (trimmed.length === 0 || trimmed.length > 128) return null
  if (trimmed === '.' || trimmed === '..') return null
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  return trimmed
}
