/**
 * Snapshot builder — AX walk -> nodes + accessible name + interactive cascade
 * (plan Task 5, spec §5).
 *
 * `snapshotNodes(page, opts)` returns a FLAT, DFS-preorder list of `SnapNode`s
 * describing the page's accessibility tree, joined with DOM attributes and
 * enriched with a cursor-interactive cascade (so `<div onclick>` "buttons" and
 * icon-sized clickables become ref-eligible even though the AX tree calls them
 * `generic`).
 *
 * How it works (all via one CDP session over the connected page):
 *   1. Run one page.evaluate scan classifying every element as cursor-
 *      interactive and/or computed-hidden (adapted from browser-use's dom
 *      serializer + reference/agent-browser snapshot.rs:624-907). Matched
 *      elements are tagged `data-__uab-idx` for backendNodeId resolution.
 *   2. `DOM.getDocument({depth:-1, pierce:true})` -> a backendNodeId -> DOM
 *      attributes map, and the idx -> backendNodeId map for the tagged scan.
 *   3. `Accessibility.getFullAXTree` -> the AX nodes, joined to DOM by
 *      backendNodeId.
 *   4. DFS the AX tree, pruning invisible nodes, assigning a semantic `level`
 *      that increments only on INCLUDED nodes (cap 50), and computing
 *      ref-eligibility: interactive roles always; content roles iff named;
 *      structural never; PLUS any cursor-interactive node.
 *
 * Ref MINTING and line formatting happen later, in serialize.ts. This module
 * only produces nodes. No model calls.
 */
import type { Page, CDPSession } from 'playwright'
import { INTERACTIVE_ROLES, CONTENT_ROLES } from './roles.js'
import { accessibleName } from './accessible-name.js'

/** The unit the serializer renders. Flat; nesting is recovered from `level`. */
export type SnapNode = {
  backendNodeId: number
  role: string
  name: string
  value: string
  /** Semantic depth: increments only on included nodes, 0-based, capped at 50. */
  level: number
  flags: {
    checked?: boolean | 'mixed'
    expanded?: boolean
    selected?: boolean
    disabled?: boolean
    required?: boolean
    focused?: boolean
    placeholder?: string
  }
  frameId: string
  cursorInteractive: boolean
  refEligible: boolean
  /** DOM input[type=password] — routed to redaction at the serialize choke point. */
  isPassword: boolean
  /** Cleaned href for links; absent otherwise. */
  url?: string
  // ---- C1 format hints (DOM metadata → serialize.ts renders them) ----
  /** Normalized control type for a hint: an `<input type>` (date/time/range/
   * number/email/…) or `'select'`. Absent when the node needs no format hint. */
  inputType?: string
  /** `min` attribute for range/number inputs. */
  min?: string
  /** `max` attribute for range/number inputs. */
  max?: string
  /** First few `<select>` option labels, for a "pick one of" hint. */
  options?: string[]
}

export type SnapshotOptions = {
  /** Interactive mode: fall a cursor-interactive node's name back to its text. */
  interactive?: boolean
  /** Max semantic depth to include (hard-capped at 50 regardless). */
  maxDepth?: number
  /** CSS selector to scope the walk to a subtree. */
  selectorScope?: string
}

/** Hard cap on semantic depth (spec §5: max 50 semantic levels). */
const MAX_LEVELS = 50
/** Bail out of the cursor scan on very large pages to stay responsive. */
const SCAN_ELEMENT_LIMIT = 10_000
/** The frameId sentinel for the top-level document (kept for RefEntry back-compat). */
export const MAIN_FRAME_ID = 'main'
/** Max iframe nesting we splice into the tree (bounds recursion; skip deeper). */
const MAX_FRAME_DEPTH = 5

/**
 * Thrown when `selectorScope` (`-s <css>`) is supplied but matches NO element
 * (or is an invalid selector). Without this, a zero-match scope would silently
 * return an empty tree — a scope typo would read as "the page is empty". The
 * `.code` is a real taxonomy member so cli.ts's `mapThrow` surfaces the loud
 * `element_not_found` recovery text ("no element matches that ref/selector").
 */
export class SelectorScopeError extends Error {
  readonly code = 'element_not_found' as const
  constructor(message = 'the selector matched no elements') {
    super(message)
    this.name = 'SelectorScopeError'
  }
}

// ---- CDP response shapes (minimal; Playwright types send() loosely here) ----

type AXValue = { type?: string; value?: unknown }
type AXProperty = { name: string; value?: AXValue }
type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
  frameId?: string
}
type DomNode = {
  backendNodeId?: number
  nodeName?: string
  attributes?: string[]
  children?: DomNode[]
  contentDocument?: DomNode
  shadowRoots?: DomNode[]
  nodeId?: number
  /** For an <iframe> DOM node: the CDP frameId of its content document. */
  frameId?: string
}

/** CDP Page.getFrameTree node (minimal). */
type FrameTreeNode = {
  frame: { id: string; url?: string }
  childFrames?: FrameTreeNode[]
}

/** C1: a form-control's format metadata, captured in the in-page scan. */
type FormHint = {
  /** Normalized control type: an `<input type>` or `'select'`. */
  type: string
  min: string | null
  max: string | null
  /** First few `<select>` option labels; null for non-selects. */
  options: string[] | null
}
type ScanRecord = {
  cur: boolean
  kind: string
  hints: string[]
  text: string
  hiddenInputType: string | null
  hiddenInputChecked: string | null
  prune: boolean
  /** C1: present iff this element is a hint-bearing form control (select / typed input). */
  formHint: FormHint | null
}
type CursorInfo = {
  kind: string
  hints: string[]
  text: string
  hiddenInputType: string | null
  hiddenInputChecked: string | null
}

/**
 * Build the flat SnapNode list for the given page.
 *
 * The main frame is walked first; then each child `iframe` node has its OWN
 * accessibility subtree fetched (via `Accessibility.getFullAXTree({frameId})`
 * over the SAME CDP session — same-process iframes share the page's target) and
 * SPLICED inline directly under the host `Iframe` node, one semantic level
 * deeper, so a `<button>` inside an iframe becomes ref-eligible and clickable.
 * Each spliced node carries the child frame's real CDP `frameId` so the resolver
 * can act inside the owning frame. Recursion is bounded (`MAX_FRAME_DEPTH`) and
 * cross-origin / detached frames are skipped silently (they simply don't appear).
 */
export async function snapshotNodes(page: Page, opts: SnapshotOptions = {}): Promise<SnapNode[]> {
  const interactive = opts.interactive ?? false
  const cap = Math.min(opts.maxDepth ?? MAX_LEVELS, MAX_LEVELS)

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable').catch(() => {})
    await cdp.send('Accessibility.enable').catch(() => {})
    await cdp.send('Page.enable').catch(() => {})

    // 1. Cursor + hidden scan (main frame only; tags matched elements with
    //    data-__uab-idx). Child frames rely on the AX tree for ref-eligibility
    //    (real controls: button/link/input/…), which the cursor cascade is not
    //    needed for — keeping the scan single-frame avoids idx collisions.
    const scan = (await page.evaluate(SCAN_JS)) as { bail: boolean; records: ScanRecord[] }

    // 2. DOM tree (pierced) -> attribute map + idx->backendNodeId. `pierce:true`
    //    already descends into every iframe's contentDocument, so child-frame
    //    node attributes are indexed here too (one fetch covers all frames).
    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode
    }
    const domByBackend = new Map<number, { nodeName: string; attrs: Record<string, string> }>()
    const idxToBackend = new Map<number, number>()
    collectDom(doc.root, domByBackend, idxToBackend)

    // Best-effort cleanup of the tags we injected.
    await page.evaluate(CLEANUP_JS).catch(() => {})

    // Build cursor + prune + form-hint maps keyed by backendNodeId.
    const cursorByBackend = new Map<number, CursorInfo>()
    const pruneSet = new Set<number>()
    const hintByBackend = new Map<number, FormHint>()
    if (!scan.bail) {
      scan.records.forEach((rec, idx) => {
        const backend = idxToBackend.get(idx)
        if (backend === undefined) return
        if (rec.cur) {
          cursorByBackend.set(backend, {
            kind: rec.kind,
            hints: rec.hints,
            text: rec.text,
            hiddenInputType: rec.hiddenInputType,
            hiddenInputChecked: rec.hiddenInputChecked,
          })
        }
        if (rec.prune) pruneSet.add(backend)
        if (rec.formHint) hintByBackend.set(backend, rec.formHint)
      })
    }

    // frameId -> document base URL, so relative hrefs resolve per frame (P1-P2).
    const pageUrl = page.url()
    const frameBaseUrl = new Map<string, string>()
    try {
      const ft = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTreeNode }
      collectFrameUrls(ft.frameTree, frameBaseUrl)
    } catch {
      /* best-effort — falls back to the page URL */
    }

    // Optional selector scoping (main frame). Fail LOUD on zero/invalid match
    // (P1-P3) instead of silently returning an empty tree.
    let scopeSet: Set<number> | null = null
    if (opts.selectorScope !== undefined) {
      scopeSet = await resolveSelectorScope(cdp, doc.root, opts.selectorScope)
      if (scopeSet === null || scopeSet.size === 0) {
        throw new SelectorScopeError()
      }
    }

    // Walk the main frame, then recursively splice child frames inline.
    return await walkFrame(MAIN_FRAME_ID, 0, 0)

    /**
     * Walk ONE frame's accessibility subtree into a flat SnapNode list, splicing
     * any nested iframe content inline under its host node.
     */
    async function walkFrame(
      frameId: string,
      baseLevel: number,
      depth: number,
    ): Promise<SnapNode[]> {
      let axNodes: AXNode[]
      try {
        const resp = (await (frameId === MAIN_FRAME_ID
          ? cdp.send('Accessibility.getFullAXTree')
          : cdp.send('Accessibility.getFullAXTree', { frameId }))) as { nodes: AXNode[] }
        axNodes = resp.nodes
      } catch {
        return [] // cross-origin / detached child frame — skip silently.
      }
      const axById = new Map<string, AXNode>()
      for (const n of axNodes) axById.set(n.nodeId, n)

      const isMain = frameId === MAIN_FRAME_ID
      const useScope = isMain ? scopeSet : null
      const baseUrl = isMain ? pageUrl : (frameBaseUrl.get(frameId) ?? pageUrl)

      const result: SnapNode[] = []
      const roots = findRoots(axNodes, axById, useScope)
      for (const rootId of roots) await visit(rootId, baseLevel)
      return result

      async function visit(nodeId: string, level: number): Promise<void> {
        if (level > cap) return
        const node = axById.get(nodeId)
        if (!node) return
        const backend = node.backendDOMNodeId ?? -1
        const role = asString(node.role?.value)

        // Selector scope: skip out-of-scope nodes but keep traversing to reach
        // in-scope descendants (defensive; roots are chosen in-scope).
        const inScope = useScope === null || (backend >= 0 && useScope.has(backend))

        const cursorInfo = isMain && backend >= 0 ? cursorByBackend.get(backend) : undefined
        const cursorInteractive = cursorInfo !== undefined
        const keepException = cursorInteractive || role === 'checkbox' || role === 'radio'
        const ignored = node.ignored === true
        const hiddenPruned = isMain && backend >= 0 && pruneSet.has(backend)
        const prune = (ignored || hiddenPruned) && !keepException

        if (prune || !inScope) {
          for (const child of node.childIds ?? []) await visit(child, level)
          return
        }

        const dom = backend >= 0 ? domByBackend.get(backend) : undefined
        const attrs = dom?.attrs ?? {}
        const rawName = asString(node.name?.value)
        const name = accessibleName(rawName, {
          ariaLabel: attrs['aria-label'],
          alt: attrs['alt'],
          title: attrs['title'],
          placeholder: attrs['placeholder'],
          textContent: interactive ? cursorInfo?.text : undefined,
        })
        const value = asString(node.value?.value)

        const props = new Map<string, unknown>()
        for (const p of node.properties ?? []) props.set(p.name, p.value?.value)

        const flags: SnapNode['flags'] = {}
        if (props.has('checked')) {
          const c = props.get('checked')
          flags.checked = c === 'mixed' ? 'mixed' : c === true || c === 'true'
        }
        if (props.has('expanded')) flags.expanded = truthy(props.get('expanded'))
        if (props.has('selected')) flags.selected = truthy(props.get('selected'))
        if (props.has('disabled')) flags.disabled = truthy(props.get('disabled'))
        if (props.has('required')) flags.required = truthy(props.get('required'))
        if (props.has('focused')) flags.focused = truthy(props.get('focused'))
        if (attrs['placeholder']) flags.placeholder = attrs['placeholder']

        const nodeName = (dom?.nodeName ?? '').toLowerCase()
        const isPassword =
          nodeName === 'input' && (attrs['type'] ?? '').toLowerCase() === 'password'

        const isInteractive = INTERACTIVE_ROLES.has(role)
        const isContent = CONTENT_ROLES.has(role)
        const refEligible = isInteractive || (isContent && name !== '') || cursorInteractive

        const snap: SnapNode = {
          backendNodeId: backend,
          role,
          name,
          value,
          level,
          flags,
          frameId,
          cursorInteractive,
          refEligible,
          isPassword,
        }
        const href = attrs['href']
        if (href) snap.url = cleanUrl(href, baseUrl)

        // C1: attach captured format metadata (main frame only — the scan runs on
        // the main frame). Options/min/max/type help the serializer emit hints.
        const hint = isMain && backend >= 0 ? hintByBackend.get(backend) : undefined
        if (hint) {
          if (hint.type) snap.inputType = hint.type
          if (hint.min !== null) snap.min = hint.min
          if (hint.max !== null) snap.max = hint.max
          if (hint.options && hint.options.length > 0) snap.options = hint.options
        }

        result.push(snap)

        // Splice the child frame's subtree directly under this Iframe host node,
        // one level deeper, so its contents nest correctly in the serializer.
        if (role === 'Iframe' && backend >= 0 && depth < MAX_FRAME_DEPTH) {
          const childFrameId = await resolveChildFrameId(cdp, backend)
          if (childFrameId && childFrameId !== frameId) {
            const childNodes = await walkFrame(childFrameId, level + 1, depth + 1)
            for (const cn of childNodes) result.push(cn)
          }
        }

        for (const child of node.childIds ?? []) await visit(child, level + 1)
      }
    }
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/**
 * Resolve the CDP frameId of an <iframe> element's content document, given the
 * iframe's backendNodeId. `depth:1` includes `contentDocument` in the response.
 */
async function resolveChildFrameId(
  cdp: CDPSession,
  backendNodeId: number,
): Promise<string | null> {
  try {
    const d = (await cdp.send('DOM.describeNode', { backendNodeId, depth: 1 })) as {
      node?: DomNode
    }
    const fid = d.node?.contentDocument?.frameId ?? d.node?.frameId
    return typeof fid === 'string' && fid.length > 0 ? fid : null
  } catch {
    return null
  }
}

/** Recursively index each frame's document URL by CDP frameId. */
function collectFrameUrls(node: FrameTreeNode, out: Map<string, string>): void {
  if (node.frame.url) out.set(node.frame.id, node.frame.url)
  for (const child of node.childFrames ?? []) collectFrameUrls(child, out)
}

/** AX roots: nodes with no parent in the tree (or, when scoped, the top-of-scope nodes). */
function findRoots(
  nodes: AXNode[],
  byId: Map<string, AXNode>,
  scopeSet: Set<number> | null,
): string[] {
  if (scopeSet) {
    // Top-of-scope: in-scope nodes whose AX parent is not in scope.
    const inScope = (n: AXNode): boolean => {
      const b = n.backendDOMNodeId ?? -1
      return b >= 0 && scopeSet.has(b)
    }
    const roots: string[] = []
    for (const n of nodes) {
      if (!inScope(n)) continue
      const parent = n.parentId ? byId.get(n.parentId) : undefined
      if (!parent || !inScope(parent)) roots.push(n.nodeId)
    }
    if (roots.length > 0) return roots
  }
  return nodes.filter((n) => !n.parentId || !byId.has(n.parentId)).map((n) => n.nodeId)
}

/** Recursively index every DOM element by backendNodeId, and pick up scan tags. */
function collectDom(
  node: DomNode,
  byBackend: Map<number, { nodeName: string; attrs: Record<string, string> }>,
  idxToBackend: Map<number, number>,
): void {
  const backend = node.backendNodeId
  if (backend !== undefined) {
    const attrs = flatAttrs(node.attributes)
    byBackend.set(backend, { nodeName: node.nodeName ?? '', attrs })
    const idx = attrs['data-__uab-idx']
    if (idx !== undefined) {
      const n = Number.parseInt(idx, 10)
      if (Number.isInteger(n)) idxToBackend.set(n, backend)
    }
  }
  for (const child of node.children ?? []) collectDom(child, byBackend, idxToBackend)
  if (node.contentDocument) collectDom(node.contentDocument, byBackend, idxToBackend)
  for (const sr of node.shadowRoots ?? []) collectDom(sr, byBackend, idxToBackend)
}

/** CDP attributes come as a flat [name, value, name, value, ...] array. */
function flatAttrs(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!flat) return out
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[flat[i]] = flat[i + 1]
  }
  return out
}

/** Resolve the set of backendNodeIds inside every element matching `selector`. */
async function resolveSelectorScope(
  cdp: CDPSession,
  root: DomNode,
  selector: string,
): Promise<Set<number> | null> {
  try {
    const rootNodeId = root.nodeId
    if (rootNodeId === undefined) return null
    const q = (await cdp.send('DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector,
    })) as { nodeIds: number[] }
    if (!q.nodeIds.length) return new Set()
    const set = new Set<number>()
    for (const nodeId of q.nodeIds) {
      const desc = (await cdp.send('DOM.describeNode', {
        nodeId,
        depth: -1,
        pierce: true,
      })) as { node: DomNode }
      collectBackendIds(desc.node, set)
    }
    return set
  } catch {
    return null
  }
}

function collectBackendIds(node: DomNode, set: Set<number>): void {
  if (node.backendNodeId !== undefined) set.add(node.backendNodeId)
  for (const c of node.children ?? []) collectBackendIds(c, set)
  if (node.contentDocument) collectBackendIds(node.contentDocument, set)
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true'
}

/**
 * Strip common tracking params so URLs stay stable + noise-free. When `base` is
 * supplied, RELATIVE hrefs (`/login`, `../x`) are resolved against it so the host
 * sees an absolute URL (P1-P2) instead of the raw relative string.
 */
export function cleanUrl(href: string, base?: string): string {
  const trimmed = href.trim()
  try {
    const u = base !== undefined ? new URL(trimmed, base) : new URL(trimmed)
    const drop: string[] = []
    u.searchParams.forEach((_v, k) => {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|_hs)/i.test(k)) drop.push(k)
    })
    for (const k of drop) u.searchParams.delete(k)
    return u.toString()
  } catch {
    // Un-resolvable (e.g. relative href with no/opaque base) — return as-is.
    return trimmed
  }
}

// ------------------------- in-page scan (string) ----------------------------
// Written as a string so the Node/TS build never pulls in the DOM lib. Runs in
// the page: classifies every element as cursor-interactive and/or hidden, tags
// matches with data-__uab-idx for backendNodeId resolution.
const SCAN_JS = `(function () {
  var out = [];
  var all = document.querySelectorAll('*');
  if (all.length > ${SCAN_ELEMENT_LIMIT}) return { bail: true, records: out };
  var interactiveRoles = {button:1,link:1,textbox:1,checkbox:1,radio:1,combobox:1,listbox:1,menuitem:1,menuitemcheckbox:1,menuitemradio:1,option:1,searchbox:1,slider:1,spinbutton:1,switch:1,tab:1,treeitem:1};
  var interactiveTags = {a:1,button:1,input:1,select:1,textarea:1,details:1,summary:1};
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    var style = getComputedStyle(el);
    var type = (el.getAttribute('type') || '').toLowerCase();
    var isRadioCheck = tag === 'input' && (type === 'radio' || type === 'checkbox');
    var isHidden = style.visibility === 'hidden' || style.opacity === '0';
    var prune = isHidden && !isRadioCheck;

    var cur = false, kind = '', hints = [], text = '', hiddenInputType = null, hiddenInputChecked = null;
    (function () {
      if (interactiveTags[tag]) return;
      var role = el.getAttribute('role');
      if (role && interactiveRoles[role.toLowerCase()]) return;
      if (el.closest && el.closest('[hidden], [aria-hidden="true"]')) return;
      var hasPointer = style.cursor === 'pointer';
      var hasOnClick = el.hasAttribute('onclick') || el.onclick !== null;
      var ti = el.getAttribute('tabindex');
      var hasTab = ti !== null && ti !== '-1';
      var ce = el.getAttribute('contenteditable');
      var editable = ce === '' || ce === 'true';
      if (!hasPointer && !hasOnClick && !hasTab && !editable) return;
      if (hasPointer && !hasOnClick && !hasTab && !editable) {
        var p = el.parentElement;
        if (p && getComputedStyle(p).cursor === 'pointer') return;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      cur = true;
      kind = (hasPointer || hasOnClick) ? 'clickable' : (editable ? 'editable' : 'focusable');
      if (hasPointer) hints.push('cursor:pointer');
      if (hasOnClick) hints.push('onclick');
      if (hasTab) hints.push('tabindex');
      if (editable) hints.push('contenteditable');
      text = (el.textContent || '').trim().slice(0, 100);
      var hi = el.querySelector('input[type="radio"], input[type="checkbox"]');
      if (hi) {
        var hs = getComputedStyle(hi);
        if (hs.display === 'none' || hs.visibility === 'hidden' || hi.hidden) {
          hiddenInputType = hi.type;
          hiddenInputChecked = hi.indeterminate ? 'mixed' : String(hi.checked);
        }
      }
    })();

    // C1 format hints: capture select options + typed-input metadata so the
    // serializer can tell the agent the shape to fill. Runs for EVERY element
    // (many are interactive tags the cursor scan skips) — cheap attribute reads.
    var fh = null;
    if (tag === 'select') {
      var opts = [];
      var os = el.options || el.querySelectorAll('option');
      for (var oi = 0; oi < os.length && opts.length < 6; oi++) {
        var ot = ((os[oi].label || os[oi].textContent || os[oi].value) || '').replace(/\\s+/g, ' ').trim();
        if (ot) opts.push(ot.slice(0, 40));
      }
      fh = { type: 'select', min: null, max: null, options: opts };
    } else if (tag === 'input') {
      var hintTypes = { date: 1, 'datetime-local': 1, time: 1, month: 1, week: 1, range: 1, number: 1, email: 1 };
      if (hintTypes[type]) {
        fh = { type: type, min: el.getAttribute('min'), max: el.getAttribute('max'), options: null };
      }
    }

    if (cur || prune || fh) {
      el.setAttribute('data-__uab-idx', String(out.length));
      out.push({ cur: cur, kind: kind, hints: hints, text: text, hiddenInputType: hiddenInputType, hiddenInputChecked: hiddenInputChecked, prune: prune, formHint: fh });
    }
  }
  return { bail: false, records: out };
})()`

const CLEANUP_JS = `(function () {
  var els = document.querySelectorAll('[data-__uab-idx]');
  for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-__uab-idx');
  return els.length;
})()`
