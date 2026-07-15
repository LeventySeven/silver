#!/usr/bin/env node
/**
 * `silver` CLI dispatcher (plan Task 11, spec §5/§7).
 *
 * A THIN dispatcher: parse argv, apply the phase-quarantine registry gate, run
 * the handler, and turn any throw into a sanitized failure envelope. All real
 * logic lives in handlers.ts so it is testable without argv.
 *
 * Security wiring done HERE (the choke points):
 *   - phase quarantine: `buildRegistry({enableActions, readOnly:!enableActions})`
 *     decides dispatchability. An actor verb absent from the set → `not_permitted`
 *     and the handler is NEVER reached (quarantine-as-code, red-team C3/R5).
 *   - no leak: every throw becomes `fail(...)` from the fixed error taxonomy;
 *     a raw stack / path / secret can never reach the envelope.
 *
 * Navigation egress, page-output neutralization, and redaction are applied
 * inside the handlers / engine modules at the lowest layer they control.
 *
 * KEYLESS: no model call anywhere.
 */
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { fail, print, type Envelope } from './core/envelope.js'
import type { ErrorCode } from './core/errors.js'
import { ERRORS } from './core/errors.js'
import { parseFlags, type ParsedFlags } from './core/flags.js'
import { buildRegistry } from './security/registry.js'
import { handle } from './core/handlers.js'
import { OutputOverflowError } from './perception/serialize.js'
import { ResolveError } from './actuation/resolve.js'
import { WaitError } from './actuation/wait.js'

/**
 * Meta verbs handled outside the phase-quarantine registry. `session` is not in
 * the committed registry's verb set (registry.ts is an engine module we do not
 * modify), so it is dispatched here directly; the others are read-only-safe and
 * bypass the gate for clarity. None can mutate page state.
 */
const META_VERBS = new Set(['version', 'doctor', 'skill', 'session'])

export type RunResult = { env: Envelope<unknown>; code: number; json: boolean }

/**
 * Parse + dispatch a single argv, returning the envelope and a process exit code.
 * Does NOT print — the caller (main, or a test) decides. This is the function
 * tests invoke directly (no child_process).
 */
export async function run(argv: string[]): Promise<RunResult> {
  const flags = parseFlags(argv)
  const json = flags.json

  if (flags.verb === '' || flags.verb === 'help' || flags.verb === '--help') {
    return { env: usage(), code: 0, json }
  }

  // Phase-quarantine gate: read-only by default; actor verbs require
  // --enable-actions. A verb outside the dispatchable set is not runnable.
  const registry = buildRegistry({
    enableActions: flags.enableActions,
    readOnly: !flags.enableActions,
  })
  if (!META_VERBS.has(flags.verb) && !registry.has(flags.verb)) {
    return { env: fail('not_permitted'), code: 1, json }
  }

  try {
    const env = await handle(flags)
    return { env, code: env.success ? 0 : 1, json }
  } catch (err) {
    return { env: mapThrow(err), code: 1, json }
  }
}

/**
 * Map any thrown value to a sanitized failure envelope. Known typed errors map
 * to their code; everything else falls back to `page_crash`. A raw message
 * (which could embed a path/secret) is NEVER surfaced.
 */
export function mapThrow(err: unknown): Envelope<never> {
  if (err instanceof OutputOverflowError) return fail('output_overflow')
  if (err instanceof ResolveError) return fail('element_not_found')
  if (err instanceof WaitError) return fail(err.code)

  // Any engine error carrying a `.code` that is a real taxonomy member.
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string' && isErrorCode(code)) return fail(code)
  }

  if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout')

  // Unknown → safe generic fallback (message is fixed; nothing from `err` leaks).
  return fail('page_crash')
}

function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERRORS, code)
}

function usage(): Envelope<unknown> {
  return {
    success: true,
    data: {
      name: 'silver',
      usage: 'silver <verb> [args] [flags]',
      lean_loop: 'open <url> -> snapshot -i -> (--enable-actions) click/fill @eN -> snapshot',
      verbs: {
        lifecycle: ['open', 'goto', 'navigate', 'close', 'back', 'forward', 'reload'],
        perception: ['snapshot', 'read', 'screenshot'],
        interaction: [
          'click',
          'dblclick',
          'hover',
          'focus',
          'fill',
          'type',
          'press',
          'select',
          'check',
          'uncheck',
          'scroll',
          'upload',
          'drag',
          'find',
        ],
        query: ['get', 'is', 'wait'],
        extract: ['extract', 'extract resolve'],
        auth: ['state', 'cookies', 'session'],
        meta: ['version', 'doctor', 'skill'],
      },
      note: 'read-only by default; actor verbs require --enable-actions',
    },
    error: null,
  }
}

// ---------------------------------------------------------------------------
// Entrypoint: run only when invoked as the CLI binary, not when imported by a
// test. (Under vitest, process.argv[1] is the test runner, not this module.)
// ---------------------------------------------------------------------------
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  run(process.argv.slice(2))
    .then(({ env, code, json }) => {
      print(env, json)
      process.exitCode = code
    })
    .catch((err: unknown) => {
      // Last-ditch guard: never leak a stack. Map to a sanitized envelope.
      print(mapThrow(err), process.argv.includes('--json'))
      process.exitCode = 1
    })
}
