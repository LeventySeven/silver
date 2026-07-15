/**
 * Confirm gate — fail-closed consent for consequential actions (spec §7).
 *
 * The gate is the last layer of the trifecta close: even with actions enabled,
 * destructive / paid / irreversible verbs require explicit human consent. On a
 * NON-TTY (the common agent-driving case) the gate FAILS CLOSED — the action is
 * denied unless the operator pre-approved that verb via `--confirm-actions`.
 *
 * Contract notes:
 *  - Single tool-call per turn: the host issues at most one confirmable action
 *    per turn, and must re-confirm on any material change to the target.
 *  - Mutating verbs are tagged `idempotent:false` (see `MUTATING_VERBS`); the
 *    host must treat a retry of a mutating verb as a fresh consequential action,
 *    never a safe idempotent replay.
 */

/**
 * Verbs tagged `idempotent:false` — state-mutating, spending, or irreversible.
 * `requiresConfirm` returns true for every member. Deliberately EXCLUDES the
 * benign actor verbs (`scroll`, `scrollintoview`, `hover`, `focus`, `find`,
 * `frame`) which move the viewport/focus but do not mutate, spend, or destroy.
 * Includes `download`/`upload`/`eval` by default-cautious policy (file egress /
 * ingress and arbitrary code execution).
 */
export const MUTATING_VERBS: Set<string> = new Set<string>([
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
  'set',
  'eval',
  'mouse',
  'dialog',
])

/**
 * NARROW paid/destructive accessible-name lexicon (spec §7, red-team P0-4).
 *
 * Deliberately limited to genuinely irreversible or money-moving controls. It
 * MUST NOT match ordinary form controls — `submit`, `send`, `post`, `confirm`,
 * `subscribe`, `cancel` are excluded on purpose, because a keyless regex cannot
 * tell "Submit expense report" from "Submit payment", and gating those would
 * brick ordinary agent flows. Used AFTER grounding to gate a click/press-like
 * activation of a control whose accessible name looks paid/destructive.
 */
const DESTRUCTIVE_PAID_RE = /(buy|purchase|checkout|pay\b|payment|order|delete|remove)/i

/** True iff a grounded control's accessible name looks paid/destructive. */
export function isDestructivePaidName(name: string): boolean {
  return DESTRUCTIVE_PAID_RE.test(String(name ?? ''))
}

/**
 * Whether `verb` requires confirmation: true iff `verb` is a mutating verb.
 *
 * The paid/destructive-name check is a SEPARATE gate (`isDestructivePaidName`,
 * applied post-grounding in the handlers), so there is no per-invocation context
 * to thread through here.
 */
export function requiresConfirm(verb: string): boolean {
  return MUTATING_VERBS.has(verb)
}

export type ConfirmGateInput = {
  verb: string
  isTTY: boolean
  confirmActions?: string[]
}

export type ConfirmGateDecision = {
  allow: boolean
  reason: string
}

/**
 * Decide whether a verb may proceed through the confirm gate.
 *
 *  - Verb needs no confirmation                → allow (nothing to gate).
 *  - Pre-approved via `--confirm-actions`      → allow (operator opted in).
 *  - Needs confirmation, interactive TTY       → allow (a human prompt follows).
 *  - Needs confirmation, NON-TTY, not approved → DENY (fail-closed).
 *
 * This function makes the yes/no policy decision; the actual interactive prompt
 * (when `allow` is true on a TTY) is performed by the caller.
 */
export function confirmGateDecision(input: ConfirmGateInput): ConfirmGateDecision {
  const { verb, isTTY } = input
  const confirmActions = input.confirmActions ?? []

  if (!requiresConfirm(verb)) {
    return { allow: true, reason: 'verb does not require confirmation' }
  }
  if (confirmActions.includes(verb)) {
    return { allow: true, reason: 'pre-approved via --confirm-actions' }
  }
  if (isTTY) {
    return { allow: true, reason: 'interactive confirmation available (TTY)' }
  }
  return {
    allow: false,
    reason: 'confirmation required but no TTY and verb not pre-approved (fail-closed)',
  }
}
