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
import { redactValue, REDACTED } from './redact.js'

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

// ---------------------------------------------------------------------------
// Structured confirm-gate preview + amount extraction (adopt-list E2, keyless).
//
// The boolean gate above says "may this proceed"; this builds the HUMAN-facing
// preview so a paid confirm shows a CONCRETE artifact ("here is exactly what
// will be submitted, for $49.99") instead of "buy something". No model call —
// the target name + form values already exist in the resolve/snapshot layer, and
// the amount is a local regex over the visible page text.
// ---------------------------------------------------------------------------

/**
 * ~24 checkout/total label variants (longest-first so "grand total" wins over a
 * bare "total"). Matched case-insensitively; an amount is sought in the ~40
 * chars following the label before falling back to the first amount on the page.
 */
const TOTAL_LABELS: readonly string[] = [
  'total to be charged',
  'order summary total',
  'amount to pay',
  'total to pay',
  'total payment',
  'payment total',
  'you will pay',
  'grand total',
  'order total',
  'total amount',
  'total charge',
  'charged today',
  'total price',
  'final total',
  'balance due',
  'amount due',
  'total cost',
  'cart total',
  'net total',
  'total due',
  'due today',
  'you pay',
  'total',
  'amount',
].slice().sort((a, b) => b.length - a.length)

/**
 * Decimal-currency amount: a currency symbol/code adjacent to a grouped number,
 * either order. Matches `$49.99`, `£1,299`, `USD 49.99`, `49.99 EUR`, `12 dollars`.
 */
const AMOUNT_RE =
  /(?:[$£€¥₹]\s?\d[\d,]*(?:\.\d{1,2})?)|(?:(?:USD|EUR|GBP|CAD|AUD)\s?\d[\d,]*(?:\.\d{1,2})?)|(?:\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD|dollars?|euros?))/i

/**
 * Extract a checkout total from free page text — label-anchored first, then the
 * first standalone currency amount anywhere. Returns the matched amount string
 * (original casing/symbol preserved) or null. Keyless; a local regex only.
 */
export function extractAmount(text: string): string | null {
  const s = String(text ?? '')
  if (!s) return null
  const lower = s.toLowerCase()
  for (const label of TOTAL_LABELS) {
    let from = 0
    let idx = lower.indexOf(label, from)
    while (idx !== -1) {
      const window = s.slice(idx + label.length, idx + label.length + 40)
      const m = window.match(AMOUNT_RE)
      if (m) return m[0].trim()
      from = idx + label.length
      idx = lower.indexOf(label, from)
    }
  }
  const m = s.match(AMOUNT_RE)
  return m ? m[0].trim() : null
}

export type ConfirmPreviewInput = {
  /** The grounded control's accessible name (the thing about to be activated). */
  name: string
  /** The form field values about to be submitted (field name → value). */
  formValues?: Record<string, string>
  /** Visible page text, used to surface the checkout total (optional). */
  pageText?: string
}

/** One-line whitespace-collapse + hard length cap for a value shown in a preview. */
function clip(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * Redact a form value for display: any `<secret>` token, password-hinted field,
 * or card-shaped value is masked via the read-path `redactValue` choke point so
 * the preview never leaks a credential the way the raw submission would.
 */
function previewValue(field: string, value: string): string {
  const v = String(value ?? '')
  if (/<secret>/i.test(v)) return REDACTED
  return clip(redactValue('', field, v, /password|passwd|pwd/i.test(field)), 80)
}

/**
 * Build the structured confirm preview string a paid/destructive confirm shows.
 * Keyless — echoes the target name, the amount (if any), and the redacted field
 * values already present in the resolve layer. The caller (handleAct) passes
 * these in; this module invents nothing.
 */
export function buildConfirmPreview(input: ConfirmPreviewInput): string {
  const name = clip(input.name, 120) || '(unnamed control)'
  const lines: string[] = [`About to submit via: "${name}"`]

  const amount = input.pageText ? extractAmount(input.pageText) : null
  if (amount) lines.push(`Amount: ${amount}`)

  const fv = input.formValues ?? {}
  const keys = Object.keys(fv)
  if (keys.length > 0) {
    lines.push('Fields to submit:')
    for (const k of keys) lines.push(`  ${clip(k, 60)} = ${previewValue(k, fv[k])}`)
  }
  return lines.join('\n')
}
