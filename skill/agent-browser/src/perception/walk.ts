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
}

type ScanRecord = {
  cur: boolean
  kind: string
  hints: string[]
  text: string
  hiddenInputType: string | null
  hiddenInputChecked: string | null
  prune: boolean
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
 */
export async function snapshotNodes(page: Page, opts: SnapshotOptions = {}): Promise<SnapNode[]> {
  const interactive = opts.interactive ?? false
  const cap = Math.min(opts.maxDepth ?? MAX_LEVELS, MAX_LEVELS)

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable').catch(() => {})
    await cdp.send('Accessibility.enable').catch(() => {})

    // 1. Cursor + hidden scan (tags matched elements with data-__uab-idx).
    const scan = (await page.evaluate(SCAN_JS)) as { bail: boolean; records: ScanRecord[] }

    // 2. DOM tree -> attribute map + idx->backendNodeId (tags live here now).
    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode
    }
    const domByBackend = new Map<number, { nodeName: string; attrs: Record<string, string> }>()
    const idxToBackend = new Map<number, number>()
    collectDom(doc.root, domByBackend, idxToBackend)

    // Best-effort cleanup of the tags we injected.
    await page.evaluate(CLEANUP_JS).catch(() => {})

    // Build cursor + prune maps keyed by backendNodeId.
    const cursorByBackend = new Map<number, CursorInfo>()
    const pruneSet = new Set<number>()
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
      })
    }

    // 3. AX tree.
    const ax = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] }
    const axById = new Map<string, AXNode>()
    for (const n of ax.nodes) axById.set(n.nodeId, n)

    // Optional selector scoping.
    const scopeSet = opts.selectorScope
      ? await resolveSelectorScope(cdp, doc.root, opts.selectorScope)
      : null

    // 4. DFS.
    const roots = findRoots(ax.nodes, axById, scopeSet)
    const out: SnapNode[] = []
    for (const rootId of roots) {
      visit(rootId, 0)
    }
    return out

    function visit(nodeId: string, level: number): void {
      if (level > cap) return
      const node = axById.get(nodeId)
      if (!node) return
      const backend = node.backendDOMNodeId ?? -1
      const role = asString(node.role?.value)

      // Selector scope: skip out-of-scope nodes but keep traversing to reach
      // in-scope descendants (should not happen if roots are chosen well, but
      // defensive).
      const inScope = scopeSet === null || (backend >= 0 && scopeSet.has(backend))

      const cursorInfo = backend >= 0 ? cursorByBackend.get(backend) : undefined
      const cursorInteractive = cursorInfo !== undefined
      const keepException =
        cursorInteractive || role === 'checkbox' || role === 'radio'
      const ignored = node.ignored === true
      const hiddenPruned = backend >= 0 && pruneSet.has(backend)
      const prune = (ignored || hiddenPruned) && !keepException

      if (prune || !inScope) {
        for (const child of node.childIds ?? []) visit(child, level)
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
      const isPassword = nodeName === 'input' && (attrs['type'] ?? '').toLowerCase() === 'password'

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
        frameId: 'main',
        cursorInteractive,
        refEligible,
        isPassword,
      }
      const href = attrs['href']
      if (href) snap.url = cleanUrl(href)

      out.push(snap)
      for (const child of node.childIds ?? []) visit(child, level + 1)
    }
  } finally {
    await cdp.detach().catch(() => {})
  }
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

/** Strip common tracking params so URLs stay stable + noise-free. */
export function cleanUrl(href: string): string {
  const trimmed = href.trim()
  try {
    const u = new URL(trimmed)
    const drop: string[] = []
    u.searchParams.forEach((_v, k) => {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|_hs)/i.test(k)) drop.push(k)
    })
    for (const k of drop) u.searchParams.delete(k)
    return u.toString()
  } catch {
    // Relative / non-absolute href — return as-is (trimmed).
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

    if (cur || prune) {
      el.setAttribute('data-__uab-idx', String(out.length));
      out.push({ cur: cur, kind: kind, hints: hints, text: text, hiddenInputType: hiddenInputType, hiddenInputChecked: hiddenInputChecked, prune: prune });
    }
  }
  return { bail: false, records: out };
})()`

const CLEANUP_JS = `(function () {
  var els = document.querySelectorAll('[data-__uab-idx]');
  for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-__uab-idx');
  return els.length;
})()`
