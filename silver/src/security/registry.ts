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
  'screenshot',
  'open',
  'goto',
  'navigate',
  'close',
  'back',
  'forward',
  'reload',
  'tab',
  'frame',
  'state',
  'cookies',
  'skill',
  'doctor',
  'version',
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
  'find',
  'set',
  'mouse',
  'dialog',
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
