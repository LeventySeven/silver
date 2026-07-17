/**
 * Phase-quarantine registry — the tool set as a PURE FUNCTION of flags.
 *
 * The load-bearing security move (spec §7, red-team C3/R5): a disabled verb is
 * literally NOT in the dispatchable set, so no prompt — however cleverly
 * injected — can make the CLI dispatch it. The CLI rejects any verb outside the
 * set with `not_permitted`. This is quarantine-as-code, not quarantine-as-doc:
 * there is no runtime toggle a compromised agent loop could flip.
 *
 * Read-only is the DEFAULT. Actor verbs appear only under `--enable-actions`,
 * and an explicit `readOnly:true` hard-pins read-only even if actions were
 * requested (belt-and-suspenders for a locked-down phase).
 */

export type RegistryFlags = {
  enableActions?: boolean
  readOnly?: boolean
}

/**
 * Verbs always dispatchable — the read-only phase. Observation, navigation,
 * and session/meta commands that cannot mutate page state.
 */
const READ_ONLY_VERBS: readonly string[] = [
  'snapshot',
  'read',
  'extract',
  'get',
  'is',
  'wait',
  // AC1: `expect <ref|selector> <matcher> [value]` — a deterministic, READ-ONLY
  // assertion verb ("did it actually work?"). It only READS page/element state
  // (visibility, enabled, checked, text, value, count, url, title) and never
  // mutates, so it lives in the read-only set (no --enable-actions needed).
  'expect',
  'screenshot',
  'open',
  'goto',
  'navigate',
  'close',
  'back',
  'forward',
  'reload',
  // `tab` is lifecycle, not page-state mutation: its subcommands (new/list/
  // switch/close) mirror open/navigate/close — all read-only-dispatchable, all
  // still bounded by the egress guard on any navigation. `tab list` in
  // particular must never require --enable-actions.
  'tab',
  'frame',
  // `connect` attaches the session to an already-running CDP browser instead of
  // spawning one. It is session setup (like `open`), operator-supplied argv (not
  // page-injected), and touches no page state — so it lives in the read-only set.
  'connect',
  'state',
  'cookies',
  'skill',
  // K1: `skills resolve --url|--message` runs the keyless skill auto-injection
  // matcher (pure string/regex math, no page state) — read-only-dispatchable. The
  // `skills` alias routes to the same handler as `skill`.
  'skills',
  'doctor',
  'version',
  // S4: the decoupled two-phase confirm gate. `confirm <id>` / `deny <id>`
  // resolve a PENDING paid/destructive action that was gated with
  // `--two-phase-confirm`. They are operator-supplied session ops (not
  // page-injected), so they are read-only-dispatchable at the VERB level;
  // `confirm` re-runs the actual actor verb and therefore checks
  // `--enable-actions` INSIDE its handler (mirrors `wait --fn` / `task exec`).
  'confirm',
  'deny',
  // Long-task artifact / grep-first memory / subagent orchestration layers.
  // Read-only-dispatchable at the VERB level so `task list|status|resume`,
  // `memory add|search|list`, and `subagent wait|list|status` never require an
  // actions grant. The ACTOR sub-ops — `task exec` and `subagent spawn` — check
  // `--enable-actions` INSIDE their handlers (mirrors how `wait --fn` is gated),
  // because the registry gate is verb-level and cannot split by subcommand.
  'task',
  'memory',
  'subagent',
  // Vercel-parity observation/introspection verbs. Read-only-dispatchable at the
  // VERB level; their ACTOR sub-ops gate on `--enable-actions` INSIDE the handler
  // (the registry gate is verb-level and cannot split by subcommand — the same
  // pattern as `wait --fn`, `task exec`, `subagent spawn`):
  //   network  — `requests` / `har` read; `route` / `unroute` gated in-handler.
  //   storage  — `get` reads; `set` / `clear` gated in-handler.
  //   clipboard— `read` reads; `write` gated in-handler.
  //   console / errors — captured page-derived logs (read-only).
  //   pdf      — a render of the current page (no page mutation).
  'network',
  'storage',
  'console',
  'errors',
  'clipboard',
  'pdf',
  // Item #4: `find` LOCATES an element (read: match count + first text) — a read,
  // not a mutation — so bare `find <kind> <value>` is read-only-dispatchable,
  // aligning it with the read-only-default soul (a read-only agent can locate).
  // The ACTING form `find <kind> <value> <subaction>` gates `--enable-actions`
  // INSIDE handleFind (the registry gate is verb-level and cannot split by
  // subcommand — same pattern as `network route` / `storage set` / `wait --fn`).
  'find',
]

/**
 * Actor verbs — added to the set ONLY when actions are enabled. These can
 * mutate page state, spend money, or run arbitrary code, so they are quarantined
 * behind `--enable-actions` by default.
 */
const ACTOR_VERBS: readonly string[] = [
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'keydown',
  'keyup',
  'keyboard',
  'select',
  'check',
  'uncheck',
  'upload',
  'download',
  'drag',
  'scroll',
  'scrollintoview',
  'hover',
  'focus',
  'eval',
  'set',
  'mouse',
  'dialog',
  // `scrollinto` is the Rust oracle's alias for `scrollintoview` (both scroll a
  // grounded ref into view) — quarantined as an actor for parity.
  'scrollinto',
]

/**
 * Build the set of dispatchable verb names for the given flags. Pure: same flags
 * → same set, no I/O, no globals.
 */
export function buildRegistry(flags: RegistryFlags = {}): Set<string> {
  const set = new Set<string>(READ_ONLY_VERBS)
  // Actor verbs require actions ON *and* readOnly not force-pinned.
  if (flags.enableActions === true && flags.readOnly !== true) {
    for (const v of ACTOR_VERBS) set.add(v)
  }
  return set
}

/** True iff `verb` is dispatchable under `flags`. */
export function isDispatchable(verb: string, flags: RegistryFlags = {}): boolean {
  return buildRegistry(flags).has(verb)
}
