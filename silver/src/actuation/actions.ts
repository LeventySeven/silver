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
import { classifyEngineError, type ErrorCode } from '../core/errors.js'
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
  /**
   * `scroll`: an optional `[dx, dy]` delta (FIX #6). When present, `scroll @ref`
   * scrolls the grounded element's OWN scroll box by (dx, dy) via `el.scrollBy`
   * (keyless inner-container scroll — chat pane / modal body / virtualized list)
   * instead of scrolling the ref into view. Absent → the into-view behavior is kept
   * (also the `scrollintoview`/`scrollinto` alias path).
   */
  by?: [number, number]
  /**
   * `click`/`dblclick` (item #1): the mouse button and/or modifier keys to hold
   * during the click. Faithful re-exposure of a Playwright/base capability
   * (right-click context menus, Ctrl/Cmd-click open-in-new-tab, Shift-select) —
   * still @ref-grounded and behind the existing actor gate. Ignored by other verbs.
   */
  button?: 'left' | 'right' | 'middle'
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
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

/**
 * Item #4: a `/pattern/flags` value becomes a RegExp matcher (a keyless, deterministic
 * opt-in — NOT a query DSL). Applies to text/label/placeholder and the role `--name`
 * filter, which all accept `string | RegExp`. An invalid pattern falls back to the
 * literal string. A plain value (no slashes) is unchanged, so existing calls are byte-identical.
 */
function asMatcher(v: string): string | RegExp {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(v)
  if (!m) return v
  try {
    return new RegExp(m[1], m[2])
  } catch {
    return v
  }
}

/** Build a Playwright Locator from a semantic (kind, val) pair. */
export function locate(page: Page, kind: FindKind, val: string, opts: FindOptions = {}): Locator {
  switch (kind) {
    case 'role': {
      const roleOpts: { name?: string | RegExp; exact?: boolean } = {}
      if (opts.name !== undefined) {
        const nm = asMatcher(opts.name)
        roleOpts.name = nm
        // `exact` only affects STRING name matching; Playwright rejects it with a
        // RegExp name, so set it only for the string case.
        if (opts.exact !== undefined && typeof nm === 'string') roleOpts.exact = opts.exact
      } else if (opts.exact !== undefined) {
        roleOpts.exact = opts.exact
      }
      return page.getByRole(val as Parameters<Page['getByRole']>[0], roleOpts).first()
    }
    case 'text':
      return byTextLike(asMatcher(val), (m, o) => page.getByText(m, o), opts)
    case 'label':
      return byTextLike(asMatcher(val), (m, o) => page.getByLabel(m, o), opts)
    case 'placeholder':
      return byTextLike(asMatcher(val), (m, o) => page.getByPlaceholder(m, o), opts)
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

/** Apply a getBy* text-like matcher, passing `exact` only for a string (a RegExp
 * matcher ignores/rejects exact). Returns the `.first()` locator. */
function byTextLike(
  matcher: string | RegExp,
  get: (m: string | RegExp, o?: { exact?: boolean }) => Locator,
  opts: FindOptions,
): Locator {
  return (matcher instanceof RegExp ? get(matcher) : get(matcher, exactOpt(opts))).first()
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
    // Aside-alignment: Playwright's `dragTo` fires only a source-hover + target-hover
    // (two endpoint moves), so drag-and-drop libraries (SortableJS, React-DnD, range
    // sliders, drag-based captchas) that require INTERMEDIATE `mousemove` events
    // between down and up silently no-op — exactly the controls that most need `drag`.
    // Drive a stepped page.mouse path (the same interpolation `coordDrag` uses),
    // using the grounded locators for actionability. Scroll BOTH into view (target
    // then source, so the source anchors the final viewport), read both boxes, and
    // if EITHER box is unavailable OR its center is OUTSIDE the viewport (a drag
    // across a scroll boundary the flat interpolation can't reach), FALL BACK to
    // Playwright's `dragTo` (which auto-scrolls during the drag) — never a silent
    // no-op on an off-screen target.
    await target.scrollIntoViewIfNeeded({ timeout: opts.timeout }).catch(() => {})
    await locator.scrollIntoViewIfNeeded({ timeout: opts.timeout }).catch(() => {})
    const sb = await locator.boundingBox({ timeout: opts.timeout }).catch(() => null)
    const tb = await target.boundingBox({ timeout: opts.timeout }).catch(() => null)
    const vp = page.viewportSize()
    const inViewport = (b: { x: number; y: number; width: number; height: number }): boolean => {
      if (vp === null) return true
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      return cx >= 0 && cx <= vp.width && cy >= 0 && cy <= vp.height
    }
    if (!sb || !tb || !inViewport(sb) || !inViewport(tb)) {
      await locator.dragTo(target, withForce(opts))
      return { verb, ref }
    }
    const x1 = sb.x + sb.width / 2
    const y1 = sb.y + sb.height / 2
    const x2 = tb.x + tb.width / 2
    const y2 = tb.y + tb.height / 2
    const steps = Math.round(Math.min(20, Math.max(5, Math.hypot(x2 - x1, y2 - y1) / 40)))
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    try {
      await page.mouse.move(x2, y2, { steps })
    } finally {
      // Always release: a throw mid-move must not leave the virtual button pressed
      // (it would corrupt the next command's pointer state).
      await page.mouse.up().catch(() => {})
    }
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
      await locator.click(withClickOpts(opts))
      return undefined
    case 'dblclick':
      await locator.dblclick(withClickOpts(opts))
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
      // FIX #4: enumerate the native <select> options in ONE keyless DOM read and
      // fail FAST when a requested value matches none. Playwright's selectOption()
      // otherwise WAITS the full timeout (default 30s) for a matching option to
      // appear, then throws TimeoutError → mapped to `timeout`, whose "increase
      // --timeout" advice is actively WRONG (a longer wait can never conjure a
      // missing option). Every other type/target mismatch fails in <1s; select was
      // the lone 30s outlier. `el` is untyped (tsconfig has no DOM lib; mirror the
      // `get html` `el.outerHTML` / scroll `el.scrollBy` convention).
      const options = (await locator.evaluate((el) =>
        el.options
          ? Array.from(el.options as ArrayLike<any>).map((o) => ({
              value: o.value,
              label: o.label,
              text: (o.textContent || '').trim(),
            }))
          : null,
      )) as { value: string; label: string; text: string }[] | null
      // No `.options` → not a <select>: wrong element type. Do NOT selectOption
      // (which would itself wait/throw); surface the non-destructive advisory.
      if (options === null) throw new ActionError('wrong_element_type')
      // Mirror Playwright's string match (an option's value OR label — `.label`
      // already falls back to the option text) plus a trimmed text compare. EVERY
      // requested value must hit SOME option; a multi-value select fails fast if
      // ANY requested value is absent.
      const present = (req: string): boolean => {
        const trimmed = req.trim()
        return options.some(
          (o) =>
            o.value === req ||
            o.label === req ||
            o.text === req ||
            o.value === trimmed ||
            o.label === trimmed ||
            o.text === trimmed,
        )
      }
      if (!values.every(present)) throw new ActionError('no_matching_option')
      await locator.selectOption(values, { timeout })
      return undefined
    }
    case 'upload': {
      const files = opts.files ?? (value !== undefined ? [value] : [])
      await locator.setInputFiles(files, { timeout })
      return undefined
    }
    case 'scroll':
      // DELTA form (`scroll @ref --by dx dy`, FIX #6): scroll the element's OWN
      // scroll box by (dx, dy). Keyless — the host's numeric delta applied to the
      // already-grounded Locator. `el` is untyped (tsconfig has no DOM lib; mirror
      // the `get html` `loc.evaluate((el) => el.outerHTML)` convention).
      if (opts.by) {
        await locator.evaluate((el, d) => el.scrollBy(d[0], d[1]), opts.by)
        return undefined
      }
      // Default: scroll the ref INTO VIEW (also the scrollintoview/scrollinto path).
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

export async function readInputValue(locator: Locator, timeout: number | undefined): Promise<string> {
  try {
    return await locator.inputValue({ timeout })
  } catch {
    // Not an input-like control (e.g. contenteditable): inputValue() only works
    // on <input>/<textarea>/<select> and THROWS otherwise. Fall back to the
    // element's TEXT so the readback is truthful — coercing to '' here made
    // fillVerb see a spurious mismatch (always re-typing) and returned an empty
    // ActResult.value for every contenteditable (rich-text/chat/comment widgets).
    try {
      return await locator.evaluate((el) =>
        el.isContentEditable ? (el.innerText ?? el.textContent ?? '') : (el.textContent ?? ''),
      )
    } catch {
      return ''
    }
  }
}

/** Playwright click/hover/etc. option object, only including set fields. */
function withForce(opts: ActOptions): { force?: boolean; timeout?: number } {
  const o: { force?: boolean; timeout?: number } = {}
  if (opts.force !== undefined) o.force = opts.force
  if (opts.timeout !== undefined) o.timeout = opts.timeout
  return o
}

/**
 * click/dblclick options (item #1): withForce plus the optional mouse `button`
 * and held `modifiers`. Only set fields are included, so a plain click is
 * byte-identical to the old `withForce` call.
 */
function withClickOpts(
  opts: ActOptions,
): {
  force?: boolean
  timeout?: number
  button?: 'left' | 'right' | 'middle'
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
} {
  const o = withForce(opts) as ReturnType<typeof withForce> & {
    button?: 'left' | 'right' | 'middle'
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  }
  if (opts.button !== undefined) o.button = opts.button
  if (opts.modifiers !== undefined && opts.modifiers.length > 0) o.modifiers = opts.modifiers
  return o
}

/**
 * Map a thrown error (Playwright or ActionError) to an envelope ErrorCode.
 *
 * The `ActionError`, `TimeoutError` (name-based), and pointer-intercept checks
 * are kept ahead of `classifyEngineError` — they are more specific and the
 * message-needle classifier does not cover them. `classifyEngineError` then
 * catches the classes the old narrow `/crash/i` regex missed: a mid-action
 * transport death ("Target closed"/"websocket closed" → `page_crash`, retryable
 * so the host's reload → session respawn recovers instead of re-snapshotting a
 * DEAD session forever), a wrong-element-type throw (`wrong_element_type`), and
 * an unreachable-host `net::ERR_*` (`navigation_failed`). `element_not_found`
 * stays the final default for a genuinely unclassified miss.
 */
function mapActionError(err: unknown): ErrorCode {
  if (err instanceof ActionError) return err.code
  const name = err instanceof Error ? err.name : ''
  const msg = err instanceof Error ? err.message : ''
  if (name === 'TimeoutError') return 'timeout'
  if (/intercepts pointer events|subtree intercepts/i.test(msg)) return 'element_obscured'
  const classified = classifyEngineError(err)
  if (classified !== null) return classified
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

/**
 * Press-drag from (x1,y1) to (x2,y2) via page.mouse (no ref, no locator).
 *
 * The middle move is INTERPOLATED into N steps (S8): a single teleporting
 * `mouse.move(x2,y2)` fires only one intermediate `mousemove`, and drag-and-drop
 * libraries (SortableJS, range sliders, HTML5 DnD) require intermediate
 * `mousemove` events to register the drag — so the drop no-ops while we still
 * returned `success:true`. Playwright's native `{ steps }` fires the intermediate
 * `mousemove`s those libs need. Step count scales with distance (5..20).
 */
export async function coordDrag(
  page: Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<Envelope<CoordResult>> {
  const steps = Math.round(Math.min(20, Math.max(5, Math.hypot(x2 - x1, y2 - y1) / 40)))
  try {
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2, { steps })
    await page.mouse.up()
    return ok({ verb: 'drag', x: x1, y: y1, x2, y2 })
  } catch (err) {
    return actFail<CoordResult>(mapActionError(err))
  }
}
