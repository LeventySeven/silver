/**
 * Actuation verbs — thin delegation to Playwright (plan Task 8, spec §6).
 *
 * Every ref-taking verb runs the SAME gate: `groundRef` (generation-checked) ->
 * `toLocator` (backendNodeId bridge) -> the matching Playwright `Locator` method.
 * Playwright owns ALL actionability (attached/visible/stable/enabled + occlusion
 * hit-testing + auto-wait) — we hand-roll NO gates and NO timing constants
 * (spec §6, red-team K2).
 *
 *   - `act(...)`   ref-based verbs (require a prior snapshot + refmap).
 *   - `find(...)`  semantic tier: role|text|label|placeholder|testid|first|last|
 *                  nth via Playwright getBy* — NO prior snapshot needed.
 *
 * `fill` is special (spec §6): `.fill(value)` then re-read `.inputValue()`; on
 * mismatch fall back to `.pressSequentially(value)` (stubborn controlled React
 * inputs). The stamped `data-silver-ref` attribute is cleaned up best-effort after
 * every act.
 *
 * NO model calls. The page-change flag is computed separately (pagechange.ts);
 * `act` returns only the action envelope.
 */
import type { Page, Locator, CDPSession } from 'playwright'
import type { RefMap } from '../perception/refmap.js'
import { groundRef } from '../perception/refmap.js'
import { ok, fail, type Envelope } from '../core/envelope.js'
import type { ErrorCode } from '../core/errors.js'
import { redactValue, REDACTED } from '../security/redact.js'
import type { SecretRegistry } from '../security/secret.js'
import { resolveTotpTokens, hasTotpToken } from '../security/totp.js'
import { toLocator, ResolveError, REF_ATTR } from './resolve.js'

/**
 * WRITE-path token resolution chokepoint (adopt-list E1/D2): resolve any
 * `<secret>NAME</secret>` then any `<totp>NAME</totp>` token in `value` against
 * the live `pageUrl`, using the domain-scoped `secrets` registry (a TOTP seed is
 * just a domain-scoped secret). Order matters: secrets first, then TOTP, so a
 * seed delivered via `<secret>` is never itself re-interpreted.
 *
 * FAIL-CLOSED: on ANY refusal (unknown name, domain-scope mismatch, invalid
 * seed) the ORIGINAL value is returned with `refused:true` — the caller MUST NOT
 * dispatch it. `sensitive` is true when a secret OR totp token was resolved, so
 * the caller force-redacts any read-back.
 */
export function resolveWriteValue(
  value: string,
  pageUrl: string,
  secrets: SecretRegistry | undefined,
): { value: string; sensitive: boolean; refused: boolean } {
  let out = value
  let sensitive = false
  if (secrets === undefined) return { value, sensitive: false, refused: false }
  if (secrets.hasTokens(out)) {
    const r = secrets.resolveValue(out, pageUrl)
    if (r.refused) return { value, sensitive: false, refused: true }
    out = r.value
    sensitive = sensitive || r.usedSecret
  }
  if (hasTotpToken(out)) {
    const r = resolveTotpTokens(out, pageUrl, secrets)
    if (r.refused) return { value, sensitive, refused: true }
    out = r.value
    sensitive = sensitive || r.usedTotp
  }
  return { value: out, sensitive, refused: false }
}

/** Ref-based actuation verbs. */
export type ActVerb =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'focus'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'scroll'
  | 'upload'
  | 'drag'

export type ActOptions = {
  /** Skip Playwright's actionability checks (maps to Playwright `force`). */
  force?: boolean
  /** Per-action timeout in ms (Playwright default when omitted). */
  timeout?: number
  /** `drag`: the destination ref (grounded against the same refmap). */
  targetRef?: string
  /** `select`: option values/labels (multiple). Falls back to `value`. */
  selectValues?: string[]
  /** `upload`: file paths (multiple). Falls back to `value`. */
  files?: string[]
  /**
   * `fill`/`type`: the CLI-process secret registry. When set and the value
   * carries a `<secret>NAME</secret>` token, it is resolved here (WRITE-path
   * choke point, symmetric to `redactValue` on the read side) against the live
   * page URL for domain scope. The raw secret NEVER enters an envelope: a
   * secret-derived read-back is force-redacted. Resolved by the CLI, so the host
   * context/argv never held the credential (adopt-list E1).
   */
  secrets?: SecretRegistry
}

export type ActResult = {
  verb: ActVerb
  ref: string
  /** `fill`: the value read back from the control after writing (verify step). */
  value?: string
}

/** Semantic locator kinds for `find` (no snapshot needed). */
export type FindKind =
  | 'role'
  | 'text'
  | 'label'
  | 'placeholder'
  | 'testid'
  | 'first'
  | 'last'
  | 'nth'

export type FindOptions = ActOptions & {
  /** `role`: accessible-name filter for getByRole. */
  name?: string
  /** exact match for text/label/placeholder/role name. */
  exact?: boolean
  /** `nth`: zero-based index. */
  index?: number
  /** value for a subaction that needs one (fill text, type text, press key). */
  value?: string
}

export type FindResult = {
  kind: FindKind
  val: string
  matched: number
  text?: string
  verb?: ActVerb
}

/** Typed action failure carrying an ErrorCode for the envelope mapper. */
class ActionError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(code)
    this.code = code
    this.name = 'ActionError'
  }
}

/**
 * `fail()` is typed `Envelope<null>`, and `Envelope<T>` is covariant in `T`, so
 * `Envelope<null>` is not assignable to `Envelope<ActResult>` under strict null
 * checks (`null` is not `<: ActResult`). A failure envelope carries no data
 * (`data: null`), so re-typing it to the caller's `T` is sound. A one-line
 * `fail(): Envelope<never>` in core/envelope.ts would remove the need for this
 * (noted in the report).
 */
function actFail<T>(code: ErrorCode): Envelope<T> {
  return fail(code) as Envelope<T>
}

/**
 * Perform a ref-based actuation verb.
 *
 * On a grounding failure the action NEVER dispatches — a stale/unknown ref
 * returns its envelope (`ref_stale` / `element_not_found`) before any Playwright
 * call, which is the red-team R4 no-misclick guarantee.
 */
export async function act(
  page: Page,
  cdp: CDPSession,
  verb: ActVerb,
  ref: string,
  value: string | undefined,
  refmap: RefMap,
  opts: ActOptions = {},
): Promise<Envelope<ActResult>> {
  // 1. Grounding gate FIRST — a stale ref must fail before we touch the page.
  const grounded = groundRef(refmap, ref)
  if (!grounded.ok) return actFail<ActResult>(grounded.code)

  // 2. Bridge the grounded ref to a live Locator.
  let locator: Locator
  try {
    locator = await toLocator(page, cdp, grounded.entry, grounded.ref)
  } catch (err) {
    if (err instanceof ResolveError) return actFail<ActResult>(err.code)
    return actFail<ActResult>('element_not_found')
  }

  // 2b. WRITE-path secret + TOTP indirection (adopt-list E1/D2): resolve any
  // `<secret>NAME</secret>` and `<totp>NAME</totp>` token in a fill/type value at
  // the SAME choke point `redactValue` occupies on the read side (symmetric).
  // Domain-scoped against the live page URL, so a bank.com secret/seed refuses on
  // evil.com even under injection. Refusal FAILS CLOSED — the literal token is
  // never dispatched.
  let effectiveValue = value
  let usedSecret = false
  if (value !== undefined && (verb === 'fill' || verb === 'type')) {
    const r = resolveWriteValue(value, page.url(), opts.secrets)
    if (r.refused) return actFail<ActResult>('not_permitted')
    effectiveValue = r.value
    usedSecret = r.sensitive
  }

  // 3. Dispatch to Playwright; cleanup the stamped attribute regardless.
  try {
    const result = await dispatch(page, cdp, locator, verb, grounded.ref, effectiveValue, refmap, opts)
    // Redact the `fill` read-back through the SAME choke point `get value` uses
    // (fix F5): a raw read-back would otherwise ECHO a just-typed password/card
    // un-redacted back to the host. A secret-derived value is ALWAYS masked
    // (it may land in a plain text field redactValue would not otherwise catch).
    // isPassword comes from the live DOM `type`; role/name come from the grounded
    // ref for the password-hint check.
    if (result.value !== undefined) {
      if (usedSecret) {
        result.value = REDACTED
      } else {
        const type = ((await locator.getAttribute('type').catch(() => null)) ?? '').toLowerCase()
        const isPassword = type === 'password'
        result.value = redactValue(grounded.entry.role, grounded.entry.name, result.value, isPassword)
      }
    }
    return ok(result)
  } catch (err) {
    return actFail<ActResult>(mapActionError(err))
  } finally {
    await cleanupStamp(page).catch(() => {})
  }
}

/**
 * Semantic locate (+ optional subaction) via Playwright getBy*. No snapshot,
 * no refmap — this is the "find by meaning" tier. With no subaction it reports
 * match count + the first match's text; with a subaction it performs that verb.
 */
export async function find(
  page: Page,
  kind: FindKind,
  val: string,
  subaction?: Exclude<ActVerb, 'drag'>,
  opts: FindOptions = {},
): Promise<Envelope<FindResult>> {
  let locator: Locator
  try {
    locator = locate(page, kind, val, opts)
  } catch {
    return actFail<FindResult>('element_not_found')
  }

  const count = await locator.count().catch(() => 0)
  if (count === 0) return actFail<FindResult>('element_not_found')

  if (subaction === undefined) {
    const text = await locator.textContent({ timeout: opts.timeout }).catch(() => null)
    const res: FindResult = { kind, val, matched: count }
    if (text !== null && text !== '') res.text = text
    return ok(res)
  }

  // WRITE-path secret/TOTP resolution for a fill/type subaction (E1/D2 parity
  // with `act`): a `find label "Password" fill "<secret>PW</secret>"` must
  // resolve the token against the live URL, fail-closed on refusal, and never
  // dispatch the literal token. Other subactions carry no secret value.
  let subValue = opts.value
  if ((subaction === 'fill' || subaction === 'type') && subValue !== undefined) {
    const r = resolveWriteValue(subValue, page.url(), opts.secrets)
    if (r.refused) return actFail<FindResult>('not_permitted')
    subValue = r.value
  }

  try {
    await applyVerb(locator, subaction, subValue, opts)
    return ok({ kind, val, matched: count, verb: subaction })
  } catch (err) {
    return actFail<FindResult>(mapActionError(err))
  }
}

/** Build a Playwright Locator from a semantic (kind, val) pair. */
export function locate(page: Page, kind: FindKind, val: string, opts: FindOptions = {}): Locator {
  switch (kind) {
    case 'role': {
      const roleOpts: { name?: string; exact?: boolean } = {}
      if (opts.name !== undefined) roleOpts.name = opts.name
      if (opts.exact !== undefined) roleOpts.exact = opts.exact
      return page.getByRole(val as Parameters<Page['getByRole']>[0], roleOpts).first()
    }
    case 'text':
      return page.getByText(val, exactOpt(opts)).first()
    case 'label':
      return page.getByLabel(val, exactOpt(opts)).first()
    case 'placeholder':
      return page.getByPlaceholder(val, exactOpt(opts)).first()
    case 'testid':
      return page.getByTestId(val).first()
    case 'first':
      return page.locator(val).first()
    case 'last':
      return page.locator(val).last()
    case 'nth':
      return page.locator(val).nth(opts.index ?? 0)
  }
}

function exactOpt(opts: FindOptions): { exact?: boolean } {
  return opts.exact !== undefined ? { exact: opts.exact } : {}
}

/** Dispatch one verb against an already-resolved Locator. */
async function dispatch(
  page: Page,
  cdp: CDPSession,
  locator: Locator,
  verb: ActVerb,
  ref: string,
  value: string | undefined,
  refmap: RefMap,
  opts: ActOptions,
): Promise<ActResult> {
  if (verb === 'drag') {
    if (opts.targetRef === undefined) throw new ActionError('element_not_found')
    const g = groundRef(refmap, opts.targetRef)
    if (!g.ok) throw new ActionError(g.code)
    const target = await toLocator(page, cdp, g.entry, g.ref)
    await locator.dragTo(target, withForce(opts))
    return { verb, ref }
  }
  const readback = await applyVerb(locator, verb, value, opts)
  const res: ActResult = { verb, ref }
  if (readback !== undefined) res.value = readback
  return res
}

/** Apply a non-drag verb to a Locator; returns the read-back value for `fill`. */
async function applyVerb(
  locator: Locator,
  verb: Exclude<ActVerb, 'drag'>,
  value: string | undefined,
  opts: ActOptions,
): Promise<string | undefined> {
  const timeout = opts.timeout
  switch (verb) {
    case 'click':
      await locator.click(withForce(opts))
      return undefined
    case 'dblclick':
      await locator.dblclick(withForce(opts))
      return undefined
    case 'hover':
      await locator.hover(withForce(opts))
      return undefined
    case 'focus':
      await locator.focus({ timeout })
      return undefined
    case 'check':
      await locator.check(withForce(opts))
      return undefined
    case 'uncheck':
      await locator.uncheck(withForce(opts))
      return undefined
    case 'press':
      await locator.press(value ?? '', { timeout })
      return undefined
    case 'type':
      await locator.pressSequentially(value ?? '', { timeout })
      return undefined
    case 'select': {
      const values = opts.selectValues ?? (value !== undefined ? [value] : [])
      await locator.selectOption(values, { timeout })
      return undefined
    }
    case 'upload': {
      const files = opts.files ?? (value !== undefined ? [value] : [])
      await locator.setInputFiles(files, { timeout })
      return undefined
    }
    case 'scroll':
      await locator.scrollIntoViewIfNeeded({ timeout })
      return undefined
    case 'fill':
      return await fillVerb(locator, value ?? '', opts)
  }
}

/**
 * `fill` with the spec §6 verify+fallback: fill, re-read the value, and if it
 * did not stick (stubborn controlled input) clear + type it character by
 * character. Returns the final read-back value.
 */
async function fillVerb(locator: Locator, text: string, opts: ActOptions): Promise<string> {
  const timeout = opts.timeout
  await locator.fill(text, withForce(opts))
  let readback = await readInputValue(locator, timeout)
  if (readback !== text) {
    await locator.fill('', withForce(opts)).catch(() => {})
    await locator.pressSequentially(text, { timeout })
    readback = await readInputValue(locator, timeout)
  }
  return readback
}

async function readInputValue(locator: Locator, timeout: number | undefined): Promise<string> {
  try {
    return await locator.inputValue({ timeout })
  } catch {
    // Not an input-like control (e.g. contenteditable) — signal a mismatch so
    // the caller retries via pressSequentially.
    return ''
  }
}

/** Playwright click/hover/etc. option object, only including set fields. */
function withForce(opts: ActOptions): { force?: boolean; timeout?: number } {
  const o: { force?: boolean; timeout?: number } = {}
  if (opts.force !== undefined) o.force = opts.force
  if (opts.timeout !== undefined) o.timeout = opts.timeout
  return o
}

/** Map a thrown error (Playwright or ActionError) to an envelope ErrorCode. */
function mapActionError(err: unknown): ErrorCode {
  if (err instanceof ActionError) return err.code
  const name = err instanceof Error ? err.name : ''
  const msg = err instanceof Error ? err.message : ''
  if (name === 'TimeoutError') return 'timeout'
  if (/intercepts pointer events|subtree intercepts/i.test(msg)) return 'element_obscured'
  if (/crash/i.test(msg)) return 'page_crash'
  return 'element_not_found'
}

/**
 * Best-effort removal of every stamped ref attribute (string JS: no DOM lib).
 *
 * Runs in EVERY frame (fix I2): `page.evaluate` alone touches only the main
 * frame, so an iframe-scoped stamp would leak permanently. We mirror
 * locateStamped's frame loop so a stamp landed in a child frame is also cleared.
 * Idempotent and non-throwing — safe to call from any read/act/wait finally.
 */
export async function cleanupStamp(page: Page): Promise<void> {
  const js = `(function(){var e=document.querySelectorAll('[${REF_ATTR}]');for(var i=0;i<e.length;i++){e[i].removeAttribute('${REF_ATTR}');}return e.length;})()`
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(js)
    } catch {
      /* frame detached / cross-origin / navigating — best effort, never throw */
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinate fallback verbs (adopt-list B1) — the AX-less escape hatch.
//
// Canvas widgets, custom no-name <div> controls, virtualized lists, and
// shadow-DOM SPAs have NO accessible-name / AX node, so ref/`find` grounding
// returns `element_not_found` and they are otherwise un-actable. These verbs
// bypass groundRef/toLocator ENTIRELY and drive page.mouse/page.keyboard at raw
// (x, y) viewport coordinates the host derived from a screenshot. There is no
// grounding gate here by design — the fixed viewport makes coordinates stable,
// and the caller (CLI) still gates these behind --enable-actions + confirm.
// ---------------------------------------------------------------------------

export type CoordResult = {
  verb: 'click' | 'type' | 'drag'
  x: number
  y: number
  /** `drag`: destination coordinates. */
  x2?: number
  y2?: number
}

export type CoordOptions = {
  /** `coordType`: secret registry for `<secret>` token resolution (E1 parity). */
  secrets?: SecretRegistry
}

/** Click at raw viewport coordinates via page.mouse (no ref, no locator). */
export async function coordClick(page: Page, x: number, y: number): Promise<Envelope<CoordResult>> {
  try {
    await page.mouse.click(x, y)
    return ok({ verb: 'click', x, y })
  } catch (err) {
    return actFail<CoordResult>(mapActionError(err))
  }
}

/**
 * Focus a point (click) then type `text` via page.keyboard. The typed text is
 * NEVER echoed in the envelope (it may be a credential); `<secret>` tokens are
 * resolved against the live page URL when a registry is supplied (E1 parity).
 */
export async function coordType(
  page: Page,
  x: number,
  y: number,
  text: string,
  opts: CoordOptions = {},
): Promise<Envelope<CoordResult>> {
  const resolved = resolveWriteValue(text, page.url(), opts.secrets)
  if (resolved.refused) return actFail<CoordResult>('not_permitted')
  const effective = resolved.value
  try {
    await page.mouse.click(x, y)
    await page.keyboard.type(effective)
    return ok({ verb: 'type', x, y })
  } catch (err) {
    return actFail<CoordResult>(mapActionError(err))
  }
}

/** Press-drag from (x1,y1) to (x2,y2) via page.mouse (no ref, no locator). */
export async function coordDrag(
  page: Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<Envelope<CoordResult>> {
  try {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2)
    await page.mouse.up()
    return ok({ verb: 'drag', x: x1, y: y1, x2, y2 })
  } catch (err) {
    return actFail<CoordResult>(mapActionError(err))
  }
}
