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
import { ERRORS, classifyEngineError } from './core/errors.js'
import { parseFlags, type ParsedFlags } from './core/flags.js'
import { loadConfig, mergeConfig } from './core/config.js'
import { suggestVerb } from './core/suggest.js'
import { buildRegistry } from './security/registry.js'
import { buildSecretRegistry } from './security/secret.js'
import { handle, setProcessSecrets } from './core/handlers.js'
import { setNamespace, setFetchEgressPolicy } from './core/session.js'
import { setStateEncryption } from './core/state-crypto.js'
// Task-artifact / memory / subagent layers — dispatched here (NOT in
// handlers.ts) so their modules stay decoupled from the browser-verb handlers.
import { handleTask } from './task/index.js'
import { handleMemory } from './memory/index.js'
import { handleSubagent } from './orchestration/subagent.js'
import { OutputOverflowError } from './perception/serialize.js'
import { ResolveError } from './actuation/resolve.js'
import { WaitError } from './actuation/wait.js'

/**
 * Meta verbs handled outside the phase-quarantine registry. `session` is not in
 * the committed registry's verb set (registry.ts is an engine module we do not
 * modify), so it is dispatched here directly; the others are read-only-safe and
 * bypass the gate for clarity. None can mutate page state.
 */
const META_VERBS = new Set(['version', 'doctor', 'skill', 'skills', 'session', 'batch'])

/**
 * The FULL set of real verb names (read-only + actor + meta + layer), for the D5
 * typo suggester. A verb present here is never "suggested" (it is a real verb —
 * an actor verb without `--enable-actions` is a permission issue, not a typo).
 */
function knownVerbs(): string[] {
  const set = new Set<string>([
    ...buildRegistry({ enableActions: true }),
    ...META_VERBS,
    ...LAYER_VERBS,
  ])
  return [...set]
}

/**
 * Verbs owned by the task-artifact / memory / subagent layers. Registered
 * read-only in the phase-quarantine registry (so `list`/`status`/`search` need
 * no actions grant); the ACTOR sub-ops (`task exec`, `subagent spawn`) enforce
 * `--enable-actions` inside their own handlers. Dispatched via `dispatchLayer`
 * so handlers.ts (owned by a sibling) is never touched.
 */
const LAYER_VERBS = new Set(['task', 'memory', 'subagent'])

async function dispatchLayer(flags: ParsedFlags): Promise<Envelope<unknown>> {
  switch (flags.verb) {
    case 'task':
      return handleTask(flags)
    case 'memory':
      return handleMemory(flags)
    case 'subagent':
      return handleSubagent(flags)
    default:
      return fail('not_permitted')
  }
}

export type RunResult = { env: Envelope<unknown>; code: number; json: boolean }

/**
 * Parse + dispatch a single argv, returning the envelope and a process exit code.
 * Does NOT print — the caller (main, or a test) decides. This is the function
 * tests invoke directly (no child_process).
 */
export async function run(argv: string[]): Promise<RunResult> {
  let flags = parseFlags(argv)

  // E3: merge the file/env config UNDER the CLI flags before any dispatch, so a
  // fleet stops repeating every flag (the drift source where one batch call
  // silently forgets `--allowed-domains` and runs unrestricted). Lists concat
  // (config ∪ CLI); scalars the CLI set explicitly win; config fills the rest.
  // Default-ON; `--no-config` opts out. Fail-open: a malformed config is skipped
  // with a warning (never a thrown error), never bricking every command.
  if (!flags.noConfig) {
    const loaded = loadConfig()
    flags = mergeConfig(loaded.config, flags).flags
  }

  const json = flags.json

  // Namespace is a per-invocation, process-wide setting that scopes ALL session
  // paths (`~/.silver/<ns>/sessions/…`). Apply it before any path is computed —
  // before the registry gate, before dispatch — so `session list/gc`, the lock,
  // and every sidecar resolve within this namespace. (No --namespace → default.)
  setNamespace(flags.namespace)

  // S2: load the operator's egress policy into the CDP Fetch-layer subresource
  // guard so `--allowed-domains` / `--allow-file-access` actually restrict
  // subresource fetch()/img/XHR/beacon (not just top-level navigation). Without
  // this the guard armed on every connect with the default empty allowlist, so a
  // page on an allowed domain could still exfiltrate anywhere — the real hole.
  setFetchEgressPolicy({ allowFile: flags.allowFileAccess, allowedDomains: flags.allowedDomains })

  // Encryption-at-rest for session sidecars is ON by default; `--no-encrypt-state`
  // opts out (plaintext JSON) for debugging. Reads accept both forms, so this is
  // safe to toggle per-invocation. `SILVER_NO_ENCRYPT_STATE=1` is the env opt-out.
  if (flags.noEncryptState) setStateEncryption(false)

  // E1/D2: build the write-path secret registry ONCE per run from `--secret`
  // specs + `SILVER_SECRET_<NAME>` env vars, and install it for the write-path
  // handlers. The raw values live only in this process — a `<secret>NAME</secret>`
  // / `<totp>NAME</totp>` token in a fill/type value resolves at the actions.ts
  // choke point, so the credential never enters the host context or an envelope.
  setProcessSecrets(buildSecretRegistry(flags.secrets, process.env))

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
    // D5: a not-found verb may be a typo. Compute a suggestion over the FULL
    // known-verb table (so a real actor verb missing its --enable-actions grant is
    // NOT "suggested" — suggestVerb returns null for an exact known verb, leaving
    // the plain not_permitted). The suggestion is derived from a SANITIZED token
    // prefix only and returns a verb from our own table, so no URL/selector/secret
    // ever reaches the error string (the load-bearing no-leak detail).
    const sug = suggestVerb(flags.verb, knownVerbs())
    if (sug) {
      return {
        env: {
          success: false,
          data: null,
          error: `unknown verb "${sug.input}"; did you mean \`${sug.suggestion}\`? (pass --enable-actions if it is an actor verb)`,
        },
        code: 1,
        json,
      }
    }
    return { env: fail('not_permitted'), code: 1, json }
  }

  try {
    const env = LAYER_VERBS.has(flags.verb) ? await dispatchLayer(flags) : await handle(flags)
    return { env, code: env.success ? 0 : 1, json }
  } catch (err) {
    return { env: mapThrow(err), code: 1, json }
  }
}

/**
 * Map any thrown value to a sanitized failure envelope. Known typed errors map
 * to their code; a truly-unclassified throw falls back to the NEUTRAL
 * `engine_error` (S4) — not `page_crash`, whose `reload` advice is destructive
 * and wrong when nothing actually crashed. A raw message (which could embed a
 * path/secret) is NEVER surfaced.
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

  // R6/S4: classify a raw engine throw by message needle BEFORE the generic
  // fallback — an unreachable-host `net::ERR_*` becomes retryable
  // `navigation_failed` (DISTINCT from the never-retry policy `navigation_blocked`),
  // a type-mismatch throw becomes non-destructive `wrong_element_type`, and a real
  // CDP/transport drop becomes `page_crash`. Needles only — nothing from the error
  // object is interpolated into the surfaced string (no-leak).
  const engineCode = classifyEngineError(err)
  if (engineCode) return fail(engineCode)

  // Unknown → NEUTRAL fallback (message is fixed; nothing from `err` leaks). NOT
  // `page_crash`: an unclassified throw is not evidence the page died, so we must
  // not advise the host to destructively `reload` (S4).
  return fail('engine_error')
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
        tabs: ['tab', 'tab new [url] [--label L]', 'tab list', 'tab <tN|label>', 'tab close [tN]'],
        multi_browser: ['connect <ws|http://127.0.0.1:PORT|port>'],
        auth: ['state', 'cookies'],
        session: ['session list', 'session gc', 'session id'],
        meta: ['version', 'doctor', 'skill'],
      },
      parallel: {
        session: '--session <name> — one detached browser per name (own-context-per-agent, the safe default for parallel agents)',
        namespace: '--namespace <ns> — isolate independent agent-GROUPS under ~/.silver/<ns>/sessions so they never collide',
        shared_browser: '`connect <endpoint>` then `tab new` — many agents share ONE browser, each on its own tab',
        locking: 'commands against ONE session serialize via a per-session advisory lock; different sessions never block',
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
