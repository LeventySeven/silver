/**
 * Per-verb command handlers (plan Task 11).
 *
 * Kept out of cli.ts so every handler is unit/integration-testable without going
 * through argv. Each handler returns an `Envelope` — it NEVER throws for an
 * expected failure (it returns `fail(code)`); an UNEXPECTED throw bubbles to the
 * cli.ts dispatcher, which maps it to a sanitized envelope (no path/secret leak).
 *
 * The browser-as-daemon model (session.ts): each handler `connect()`s over CDP,
 * does its work, then closes the CDP transport (`browser.close()` on a
 * connectOverCDP browser only drops the transport — the detached browser keeps
 * running). Cross-command state (generation, previous snapshot text, page
 * fingerprint, extract value-map) lives in a per-session `uab-state.json` sidecar
 * next to session.json / refmap.json.
 *
 * KEYLESS: no model / provider call anywhere. Every "smart" step is a keyless
 * heuristic or a bundle handed to the host.
 */
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import type { Page, Locator, CDPSession } from 'playwright'

import { ok, fail, type Envelope } from './envelope.js'
import type { ParsedFlags } from './flags.js'
import {
  openSession,
  connect,
  closeSession,
  saveRefMap,
  loadRefMap,
  readSidecar,
  sessionDir,
  sessionsRoot,
  type Connection,
  type OpenOptions,
} from './session.js'
import { groundRef, newGeneration, type RefMap } from '../perception/refmap.js'
import { snapshotNodes, type SnapNode } from '../perception/walk.js'
import { render } from '../perception/serialize.js'
import { observe } from '../perception/diff.js'
import { assertNavigable } from '../security/egress.js'
import { neutralize, capOutput } from '../security/injection.js'
import { requiresConfirm, confirmGateDecision } from '../security/confirm.js'
import {
  act,
  find,
  type ActVerb,
  type ActOptions,
  type FindKind,
} from '../actuation/actions.js'
import { toLocator } from '../actuation/resolve.js'
import { settleAndFingerprint } from '../actuation/pagechange.js'
import { waitFor, WaitError, type WaitSpec, type WaitState } from '../actuation/wait.js'
import { buildBundle, type JsonSchema } from '../extract/transform.js'
import { resolveIds } from '../extract/resolve.js'

const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Per-session state sidecar (uab-state.json) — our cross-command scratch.
// ---------------------------------------------------------------------------

type ExtractState = {
  urlFieldPaths: string[]
  valueMap: Record<string, string>
  generation: number
}

type UabState = {
  /** The generation of the most recent snapshot (0 = none taken yet). */
  generation: number
  /** The most recent snapshot text, for diff-when-shorter observation. */
  prevTree: string | null
  /** The most recent page fingerprint, for the page_changed flag. */
  fingerprint: string | null
  /** The last extract bundle's reverse-map, keyed to its generation. */
  extract?: ExtractState
}

function statePath(name: string): string {
  return path.join(sessionDir(name), 'uab-state.json')
}

async function loadState(name: string): Promise<UabState | null> {
  try {
    const raw = await fs.readFile(statePath(name), 'utf8')
    return JSON.parse(raw) as UabState
  } catch {
    return null
  }
}

async function saveState(name: string, state: UabState): Promise<void> {
  await fs.mkdir(sessionDir(name), { recursive: true })
  await fs.writeFile(statePath(name), JSON.stringify(state), 'utf8')
}

async function patchState(name: string, patch: Partial<UabState>): Promise<UabState> {
  const cur: UabState = (await loadState(name)) ?? {
    generation: 0,
    prevTree: null,
    fingerprint: null,
  }
  const next: UabState = { ...cur, ...patch }
  await saveState(name, next)
  return next
}

// ---------------------------------------------------------------------------
// Connection helpers.
// ---------------------------------------------------------------------------

function openOpts(flags: ParsedFlags): OpenOptions {
  return { headed: flags.headed }
}

/** Connect to the session, auto-spawning the detached browser if none is live. */
async function ensureConnected(name: string, opts: OpenOptions): Promise<Connection> {
  try {
    return await connect(name)
  } catch {
    await openSession(name, opts)
    return await connect(name)
  }
}

/** Run `fn` with a fresh connection, always dropping the CDP transport after. */
async function withConnection<T>(
  flags: ParsedFlags,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const conn = await ensureConnected(flags.session, openOpts(flags))
  try {
    return await fn(conn)
  } finally {
    await conn.browser.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Output presentation: cap the untrusted content FIRST, then wrap in the
// boundary markers so the markers themselves are never sliced off (spec §7).
// ---------------------------------------------------------------------------

function presentPageText(text: string, flags: ParsedFlags): string {
  const capped = capOutput(text, flags.maxOutput)
  return flags.contentBoundaries ? neutralize(capped) : capped
}

// ---------------------------------------------------------------------------
// The dispatch entry the CLI calls.
// ---------------------------------------------------------------------------

export async function handle(flags: ParsedFlags): Promise<Envelope<unknown>> {
  switch (flags.verb) {
    // lifecycle
    case 'open':
    case 'goto':
    case 'navigate':
      return handleOpen(flags)
    case 'close':
      return handleClose(flags)
    case 'back':
    case 'forward':
    case 'reload':
      return handleHistory(flags)
    // perception
    case 'snapshot':
      return handleSnapshot(flags)
    case 'read':
      return handleRead(flags)
    case 'screenshot':
      return handleScreenshot(flags)
    // interaction (registry-gated upstream)
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'fill':
    case 'type':
    case 'press':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'scroll':
    case 'upload':
    case 'drag':
      return handleAct(flags)
    case 'find':
      return handleFind(flags)
    // query
    case 'get':
      return handleGet(flags)
    case 'is':
      return handleIs(flags)
    case 'wait':
      return handleWait(flags)
    // extract
    case 'extract':
      return handleExtract(flags)
    // auth / session
    case 'state':
      return handleStateVerb(flags)
    case 'cookies':
      return handleCookies(flags)
    case 'session':
      return handleSession(flags)
    // meta
    case 'version':
      return ok({ name: 'uab', version: VERSION })
    case 'doctor':
      return handleDoctor()
    case 'skill':
      return handleSkill(flags)
    // nice-to-have — honestly unimplemented (never faked).
    case 'tab':
    case 'frame':
    case 'network':
    case 'dialog':
    case 'pdf':
      return notImplemented()
    default:
      return notImplemented()
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function handleOpen(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[0]
  if (!url) return badRequest('a URL is required (usage: uab open <url>)')

  // Egress guard at the FIRST layer — before any browser is spawned/navigated.
  const nav = assertNavigable(url, {
    allowFile: flags.allowFileAccess,
    allowedDomains: flags.allowedDomains,
  })
  if (!nav.ok) return fail('navigation_blocked')

  return withConnection(flags, async ({ page }) => {
    await page.goto(url, gotoOpts(flags))
    const prev = await loadState(flags.session)
    // Navigation invalidates prior refs: bump the generation, write an EMPTY
    // refmap at that generation (so a stale `eN` fails element_not_found), reset
    // the diff baseline, and drop any extract bundle.
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: null,
      fingerprint: fp.fingerprint,
    })
    return ok({
      url: page.url(),
      title: await page.title().catch(() => ''),
      page_changed: fp.page_changed,
    })
  })
}

async function handleClose(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.all) {
    const names = await listSessionNames()
    for (const name of names) {
      await closeSession(name).catch(() => {})
    }
    return ok({ closed: names.length })
  }
  await closeSession(flags.session)
  return ok({ closed: 1, session: flags.session })
}

async function handleHistory(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    if (flags.verb === 'back') await page.goBack(gotoOpts(flags))
    else if (flags.verb === 'forward') await page.goForward(gotoOpts(flags))
    else await page.reload(gotoOpts(flags))

    const prev = await loadState(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)
    await saveRefMap(flags.session, { generation: gen, entries: {} })
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: null,
      fingerprint: fp.fingerprint,
    })
    return ok({ url: page.url(), page_changed: fp.page_changed })
  })
}

function gotoOpts(flags: ParsedFlags): { waitUntil: 'domcontentloaded'; timeout?: number } {
  const o: { waitUntil: 'domcontentloaded'; timeout?: number } = { waitUntil: 'domcontentloaded' }
  if (flags.timeout !== undefined) o.timeout = flags.timeout
  return o
}

// ---------------------------------------------------------------------------
// perception
// ---------------------------------------------------------------------------

async function handleSnapshot(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    const prev = await loadState(flags.session)
    const prevRefmap = await loadRefMap(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)

    const snapOpts: Parameters<typeof snapshotNodes>[1] = { interactive: flags.interactive }
    if (flags.depth !== undefined) snapOpts.maxDepth = flags.depth
    if (flags.selector !== undefined) snapOpts.selectorScope = flags.selector
    const nodes = await snapshotNodes(page, snapOpts)

    const { text, refmap } = render(
      nodes,
      { generation: gen, entries: {} },
      {
        generation: gen,
        title: await page.title().catch(() => ''),
        url: page.url(),
        compact: flags.compact,
        filtered: flags.interactive,
        prevRefmap,
        ...(flags.maxOutput !== undefined ? { maxChars: flags.maxOutput } : {}),
      },
    )
    await saveRefMap(flags.session, refmap)

    const obsv = observe(prev?.prevTree ?? null, text)
    const fp = await settleAndFingerprint(page, prev?.fingerprint, gen)
    await saveState(flags.session, {
      generation: gen,
      prevTree: text,
      fingerprint: fp.fingerprint,
      ...(prev?.extract ? { extract: prev.extract } : {}),
    })

    return ok(presentPageText(obsv.output, flags), warnIf(fp.page_changed))
  })
}

function warnIf(pageChanged: boolean): string | undefined {
  return pageChanged ? 'the page changed during this command; refs may be stale' : undefined
}

async function handleRead(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const url = flags.args[0]
  if (url) {
    const nav = assertNavigable(url, {
      allowFile: flags.allowFileAccess,
      allowedDomains: flags.allowedDomains,
    })
    if (!nav.ok) return fail('navigation_blocked')
    const res = await fetch(url, flags.timeout ? { signal: AbortSignal.timeout(flags.timeout) } : {})
    if (!res.ok) return fail('page_crash')
    const html = await res.text()
    return ok(presentPageText(htmlToText(html), flags))
  }
  return withConnection(flags, async ({ page }) => {
    const text = (await page.evaluate(
      "document.body ? document.body.innerText : ''",
    )) as string
    return ok(presentPageText(text ?? '', flags))
  })
}

async function handleScreenshot(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const outPath = flags.args[0]
  return withConnection(flags, async ({ page }) => {
    const shotOpts: { fullPage: boolean; path?: string } = { fullPage: flags.full }
    if (outPath) shotOpts.path = outPath
    const buf = await page.screenshot(shotOpts)
    if (outPath) return ok({ saved: true })
    return ok({ encoding: 'base64', image: buf.toString('base64') })
  })
}

// ---------------------------------------------------------------------------
// interaction (behind --enable-actions via the registry)
// ---------------------------------------------------------------------------

async function handleAct(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const verb = flags.verb as ActVerb
  const ref = flags.args[0]
  if (!ref) return badRequest('a ref is required (usage: uab <verb> @eN [value])')

  // Confirm gate: engaged only when the operator supplies --confirm-actions
  // (an explicit allowlist of auto-approved mutating verbs). Without it,
  // --enable-actions alone permits actor verbs so the primary non-TTY
  // agent-driving path (and the eval harness) is not bricked. See report.
  if (flags.confirmActionsProvided && requiresConfirm(verb)) {
    const decision = confirmGateDecision({
      verb,
      isTTY: Boolean(process.stdout.isTTY),
      confirmActions: flags.confirmActions,
    })
    if (!decision.allow) return fail('not_permitted')
  }

  const refmap = await loadRefMap(flags.session)
  if (!refmap) return fail('element_not_found')

  // Value: positional arg, or stdin for large/unsafe payloads.
  let value = flags.args[1]
  if (flags.stdin) value = await readStdin()

  return withConnection(flags, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    try {
      const opts: ActOptions = {}
      if (flags.force) opts.force = true
      if (flags.timeout !== undefined) opts.timeout = flags.timeout
      if (verb === 'select') opts.selectValues = flags.args.slice(1)
      if (verb === 'upload') opts.files = flags.args.slice(1)
      if (verb === 'drag') opts.targetRef = flags.args[1]

      const env = await act(page, cdp, verb, ref, value, refmap, opts)

      // Stamp the page-change contract onto every action response (spec §6).
      const prev = await loadState(flags.session)
      const fp = await settleAndFingerprint(page, prev?.fingerprint, refmap.generation)
      await patchState(flags.session, { fingerprint: fp.fingerprint })

      if (!env.success) return env
      return ok({
        ...env.data,
        page_changed: fp.page_changed,
        stale_refs: fp.stale_refs,
        generation: refmap.generation,
      })
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
}

async function handleFind(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0] as FindKind
  const val = flags.args[1]
  if (!kind || !val) return badRequest('usage: uab find <kind> <value> [action] [text]')
  const subaction = flags.args[2] as Exclude<ActVerb, 'drag'> | undefined
  const subValue = flags.args[3]

  return withConnection(flags, async ({ page }) => {
    const opts: Parameters<typeof find>[4] = {}
    if (subValue !== undefined) opts.value = subValue
    if (flags.name !== undefined) opts.name = flags.name
    if (flags.index !== undefined) opts.index = flags.index
    return (await find(page, kind, val, subaction, opts)) as Envelope<unknown>
  })
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

async function handleGet(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0]
  const rest = flags.args.slice(1)
  return withConnection(flags, async ({ page }) => {
    switch (kind) {
      case 'title':
        return ok({ title: await page.title() })
      case 'url':
        return ok({ url: page.url() })
      case 'count': {
        const target = rest[0]
        if (!target) return badRequest('usage: uab get count <selector>')
        const n = await page.locator(target).count()
        return ok({ count: n })
      }
      case 'text': {
        const ref = rest[0]
        if (!ref) {
          const text = (await page.evaluate(
            "document.body ? document.body.innerText : ''",
          )) as string
          return ok(presentPageText(text ?? '', flags))
        }
        return withLocator(page, flags.session, ref, async (loc) => {
          const t = (await loc.textContent()) ?? ''
          return ok(presentPageText(t, flags))
        })
      }
      case 'value': {
        const ref = rest[0]
        if (!ref) return badRequest('usage: uab get value @eN')
        return withLocator(page, flags.session, ref, async (loc) =>
          ok({ value: await loc.inputValue() }),
        )
      }
      case 'attr': {
        const ref = rest[0]
        const attrName = rest[1]
        if (!ref || !attrName) return badRequest('usage: uab get attr @eN <attribute>')
        return withLocator(page, flags.session, ref, async (loc) =>
          ok({ attribute: attrName, value: await loc.getAttribute(attrName) }),
        )
      }
      default:
        return badRequest('usage: uab get text|value|attr|title|url|count [ref]')
    }
  })
}

async function handleIs(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const kind = flags.args[0]
  const ref = flags.args[1]
  if (!kind || !ref) return badRequest('usage: uab is visible|enabled|checked @eN')
  return withConnection(flags, async ({ page }) =>
    withLocator(page, flags.session, ref, async (loc) => {
      switch (kind) {
        case 'visible':
          return ok({ visible: await loc.isVisible() })
        case 'enabled':
          return ok({ enabled: await loc.isEnabled() })
        case 'checked':
          return ok({ checked: await loc.isChecked() })
        default:
          return badRequest('usage: uab is visible|enabled|checked @eN')
      }
    }),
  )
}

/** Ground + resolve a ref to a Locator, then run `fn`; returns fail(code) on a
 * grounding miss (a ResolveError throw bubbles to the dispatcher). */
async function withLocator(
  page: Page,
  session: string,
  ref: string,
  fn: (loc: Locator) => Promise<Envelope<unknown>>,
): Promise<Envelope<unknown>> {
  const refmap = await loadRefMap(session)
  if (!refmap) return fail('element_not_found')
  const g = groundRef(refmap, ref)
  if (!g.ok) return fail(g.code)
  const cdp: CDPSession = await page.context().newCDPSession(page)
  try {
    const loc = await toLocator(page, cdp, g.entry, g.ref)
    return await fn(loc)
  } finally {
    await cdp.detach().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

async function handleWait(flags: ParsedFlags): Promise<Envelope<unknown>> {
  return withConnection(flags, async ({ page }) => {
    const cdp: CDPSession = await page.context().newCDPSession(page)
    try {
      const spec = await buildWaitSpec(flags, page, cdp)
      if ('error' in spec) return spec.error
      await waitFor(page, spec.spec)
      return ok({ waited: true })
    } catch (err) {
      if (err instanceof WaitError) return fail(err.code)
      if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout')
      throw err
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
}

async function buildWaitSpec(
  flags: ParsedFlags,
  page: Page,
  cdp: CDPSession,
): Promise<{ spec: WaitSpec } | { error: Envelope<unknown> }> {
  const timeout = flags.timeout
  if (flags.text !== undefined) return { spec: { text: flags.text, timeout } }
  if (flags.url !== undefined) return { spec: { url: flags.url, timeout } }
  if (flags.fn !== undefined) return { spec: { fn: flags.fn, timeout } }
  if (flags.load !== undefined) {
    const load = flags.load as 'load' | 'domcontentloaded' | 'networkidle'
    return { spec: { load, timeout } }
  }
  const arg = flags.args[0]
  if (!arg) return { error: badRequest('usage: uab wait <ref|ms|selector|--text|--url|--load|--fn>') }
  if (/^\d+$/.test(arg)) return { spec: { ms: Number(arg) } }
  // A ref → grounded wait; anything else is treated as a CSS selector.
  if (/^(@|ref=)?e\d+$/.test(arg)) {
    const refmap = await loadRefMap(flags.session)
    if (!refmap) return { error: fail('element_not_found') }
    const state: WaitState = 'visible'
    return { spec: { ref: arg, refmap, cdp, state, timeout } }
  }
  void page
  return { spec: { selector: arg, timeout } }
}

// ---------------------------------------------------------------------------
// extract (keyless, ID-grounded)
// ---------------------------------------------------------------------------

async function handleExtract(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.args[0] === 'resolve') return handleExtractResolve(flags)

  const schema = parseSchemaArg(flags.schema)
  if (schema === null) return badRequest('a --schema <json|@file> is required for extract')

  return withConnection(flags, async ({ page }) => {
    const prev = await loadState(flags.session)
    const gen = newGeneration(prev?.generation ?? 0)

    const nodes = await snapshotNodes(page, { interactive: true })
    const { text, refmap } = render(
      nodes,
      { generation: gen, entries: {} },
      { generation: gen, title: await page.title().catch(() => ''), url: page.url() },
    )
    await saveRefMap(flags.session, refmap)

    // Element IDs are `<generation>-<n>` (the ^\d+-\d+$ shape transform.ts
    // constrains url fields to). Build the id→value map and an id-annotated
    // snapshot the host reads. The host only ever sees IDs, never real URLs.
    const nodeByBackend = new Map<number, SnapNode>()
    for (const n of nodes) nodeByBackend.set(n.backendNodeId, n)

    const valueMap: Record<string, string> = {}
    const idToUrl = new Map<string, string>()
    for (const [ref, entry] of Object.entries(refmap.entries)) {
      const id = `${gen}-${ref.slice(1)}` // "e3" -> "<gen>-3"
      const node = nodeByBackend.get(entry.backendNodeId)
      valueMap[id] = node?.url ?? node?.name ?? node?.value ?? ''
      if (node?.url) idToUrl.set(id, node.url)
    }

    // The host must see IDs, NEVER real URLs (the moat, spec §8): the id-pattern
    // schema alone is not enough, because resolveIds passes a non-ID string
    // through untouched — so a host that COPIED a real URL out of the snapshot
    // would bypass grounding. We therefore strip each link's real `url=` token
    // from the host-facing snapshot; the CLI-retained valueMap holds the truth.
    const idText = text
      .replace(/ref=e(\d+)/g, (_m, n: string) => `id=${gen}-${n}`)
      .split('\n')
      .map((line) => {
        const m = /id=(\d+-\d+)/.exec(line)
        if (!m) return line // header/non-ref lines keep their url (page context)
        const u = idToUrl.get(m[1])
        return u ? line.replace(`, url=${u}]`, ']').replace(` url=${u}`, '') : line
      })
      .join('\n')
    const safeIdText = flags.contentBoundaries ? neutralize(idText) : idText

    const bundle = buildBundle(schema, safeIdText, valueMap, flags.instruction)

    await saveState(flags.session, {
      generation: gen,
      prevTree: text,
      fingerprint: prev?.fingerprint ?? null,
      extract: { urlFieldPaths: bundle.url_field_paths, valueMap, generation: gen },
    })

    return ok(bundle)
  })
}

async function handleExtractResolve(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const result = parseJsonArg(flags.ids)
  if (result === undefined) return badRequest('extract resolve requires --ids <json|@file>')

  const state = await loadState(flags.session)
  const ex = state?.extract
  if (!ex) return badRequest('no extract bundle in this session; run `extract --schema` first')

  const currentGeneration = state?.generation ?? ex.generation
  const res = resolveIds(result, ex.urlFieldPaths, ex.valueMap, ex.generation, currentGeneration)
  if (!res.ok) return fail(res.code)
  return ok(res.data, res.warning)
}

// ---------------------------------------------------------------------------
// auth / sessions
// ---------------------------------------------------------------------------

async function handleStateVerb(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  const target = flags.args[1] ?? flags.state
  if (sub === 'save') {
    if (!target) return badRequest('usage: uab state save <path>')
    return withConnection(flags, async ({ context }) => {
      await context.storageState({ path: target })
      return ok({ saved: true })
    })
  }
  if (sub === 'load') {
    if (!target) return badRequest('usage: uab state load <path>')
    let parsed: { cookies?: unknown }
    try {
      parsed = JSON.parse(await fs.readFile(target, 'utf8')) as { cookies?: unknown }
    } catch {
      return badRequest('could not read the storage-state file')
    }
    return withConnection(flags, async ({ context }) => {
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        await context.addCookies(parsed.cookies as Parameters<typeof context.addCookies>[0])
      }
      // NOTE (v1): localStorage/origins from storageState are not replayed here
      // (would require navigating each origin). Cookies are applied. See report.
      return ok({ loaded: true, cookies: Array.isArray(parsed.cookies) ? parsed.cookies.length : 0 })
    })
  }
  return badRequest('usage: uab state save|load <path>')
}

async function handleCookies(flags: ParsedFlags): Promise<Envelope<unknown>> {
  if (flags.args[0] !== 'set') return badRequest('usage: uab cookies set --curl <file>')
  if (!flags.curl) return badRequest('usage: uab cookies set --curl <file>')
  let raw: string
  try {
    raw = await fs.readFile(flags.curl, 'utf8')
  } catch {
    return badRequest('could not read the cookies file')
  }
  return withConnection(flags, async ({ context, page }) => {
    const origin = flags.url ?? page.url()
    const cookies = parseCookies(raw, origin)
    if (cookies.length === 0) return badRequest('no cookies found in the supplied file')
    await context.addCookies(cookies as Parameters<typeof context.addCookies>[0])
    return ok({ set: cookies.length })
  })
}

type SimpleCookie = { name: string; value: string; url?: string; domain?: string; path?: string }

/** Parse a cookies payload: a JSON array, a raw cURL command, or a bare
 * `Cookie:` header / `k=v; k2=v2` string. */
function parseCookies(raw: string, originUrl: string): SimpleCookie[] {
  const trimmed = raw.trim()
  // 1. JSON array of cookie objects.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr)) {
        return arr
          .filter((c): c is SimpleCookie => typeof c === 'object' && c !== null && 'name' in c)
          .map((c) => (c.domain || c.url ? c : { ...c, url: safeOrigin(originUrl) }))
      }
    } catch {
      /* fall through */
    }
  }
  // 2. A `Cookie:` header line embedded in a curl command or on its own.
  const headerMatch = /(?:cookie:\s*)([^\n'"]+)/i.exec(trimmed)
  const pairSource = headerMatch ? headerMatch[1] : trimmed
  return pairSource
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .map((p) => {
      const eq = p.indexOf('=')
      return {
        name: p.slice(0, eq).trim(),
        value: p.slice(eq + 1).trim(),
        url: safeOrigin(originUrl),
      }
    })
    .filter((c) => c.name.length > 0)
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'http://localhost'
  }
}

async function handleSession(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const sub = flags.args[0]
  if (sub === 'id') {
    const base = flags.scope === 'worktree' ? worktreeRoot(process.cwd()) : process.cwd()
    const prefix = flags.prefix ?? 'uab'
    const id = `${prefix}-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`
    // Deliberately omit `base` (a path) from the envelope — no-leak invariant.
    return ok({ id, scope: flags.scope ?? 'cwd' })
  }
  if (sub === 'list') {
    const names = await listSessionNames()
    const sessions: Array<{ name: string; pid?: number; createdAt?: string }> = []
    for (const name of names) {
      try {
        const info = await readSidecar(name)
        sessions.push({ name, pid: info.pid, createdAt: info.createdAt })
      } catch {
        sessions.push({ name })
      }
    }
    return ok({ sessions })
  }
  return badRequest('usage: uab session id|list')
}

function worktreeRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

async function listSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsRoot(), { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory() && existsSync(path.join(sessionsRoot(), e.name, 'session.json'))) {
        out.push(e.name)
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

async function handleDoctor(): Promise<Envelope<unknown>> {
  const report: { playwright: boolean; chromium: boolean; uab_writable: boolean } = {
    playwright: true,
    chromium: false,
    uab_writable: false,
  }
  try {
    const exec = chromium.executablePath()
    report.chromium = Boolean(exec) && existsSync(exec)
  } catch {
    report.chromium = false
  }
  try {
    const root = path.join(os.homedir(), '.uab')
    await fs.mkdir(root, { recursive: true })
    const probe = path.join(root, `.doctor-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.rm(probe, { force: true })
    report.uab_writable = true
  } catch {
    report.uab_writable = false
  }
  return ok(report)
}

function handleSkill(flags: ParsedFlags): Envelope<unknown> {
  const short =
    'uab — keyless browser automation for AI agents. Lean loop: ' +
    '`open <url>` -> `snapshot -i` (grounded @eN refs) -> act with `--enable-actions` ' +
    '(`click @eN`, `fill @eN <text>`) -> re-`snapshot` to observe the diff. ' +
    'Read-only by default; actor verbs need `--enable-actions`. IDs are grounded: ' +
    'a stale ref fails loudly (re-snapshot, never guess). Extract is host-run: ' +
    '`extract --schema <json>` prints a bundle you infer over, then `extract resolve --ids <json>` ' +
    'maps element IDs back to real values. `uab doctor` checks your install.'
  if (flags.full) {
    return ok(
      short +
        '\n\nSecurity posture: file:/data:/blob: navigation denied by default ' +
        '(`--allow-file-access` lifts file:); egress is a scheme+host denylist with ' +
        'opt-in `--allowed-domains` suffix hardening; page output is neutralized + ' +
        'boundary-fenced (`--no-content-boundaries` off, `--max-output` caps free-form dumps); ' +
        'passwords/cards are redacted at the serializer. The CLI NEVER calls a model — ' +
        'the host is the brain. (Full SKILL.md ships in a later task.)',
    )
  }
  return ok(short)
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** A clean, non-leaking bad-request envelope (static message only). */
function badRequest(message: string): Envelope<never> {
  return { success: false, data: null, error: message }
}

function notImplemented(): Envelope<never> {
  return { success: false, data: null, error: 'not implemented in v1' }
}

function parseSchemaArg(arg: string | undefined): JsonSchema | null {
  const parsed = parseJsonArg(arg)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return null
  return parsed as JsonSchema
}

/** Parse a `--schema`/`--ids` value: `@file` reads+parses the file, else inline JSON. */
function parseJsonArg(arg: string | undefined): unknown {
  if (arg === undefined) return undefined
  try {
    if (arg.startsWith('@')) {
      // Synchronous read keeps parsing simple; the file is operator-supplied.
      return JSON.parse(readFileSync(arg.slice(1), 'utf8'))
    }
    return JSON.parse(arg)
  } catch {
    return undefined
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Minimal HTML → text: drop script/style, strip tags, decode a few entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
