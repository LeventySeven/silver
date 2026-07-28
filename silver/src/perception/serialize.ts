/**
 * Serializer — line format + redaction + compact + never-truncate (plan Task 6,
 * spec §5).
 *
 * `render(nodes, refmap, opts)` turns a flat SnapNode list (from walk.ts) into
 * the canonical snapshot text AND mints the RefMap for this generation. It is
 * the single choke point where:
 *   - refs are minted (`e1, e2, ...` over ref-eligible nodes, in document order),
 *   - values are redacted (passwords / card numbers -> `[redacted]`),
 *   - the tree is NEVER truncated (overflow throws `OutputOverflowError`, which
 *     the CLI maps to `fail("output_overflow")`).
 *
 * Line grammar (2-space indent per semantic level):
 *   - <role> "<name>" [ref=eN, level=N, checked=B, expanded=B, selected, disabled, required, placeholder="…", options=[…], format="…", min=, max=, url=<cleaned>]: <value>
 * Header:  - title: "<title>" [url=<url>]
 * Token trims (engine-plan §2): `url=` is opt-in (`--urls`); `level=N` is emitted
 * only at indent > 0 and never in filtered mode; the `generation=` echo and the
 * `# note: interactive elements only` preamble are dropped (generation still
 * lives in the RefMap sidecar).
 *
 * Structural cleanup at render time (matches reference/agent-browser
 * snapshot.rs:1075-1247): RootWebArea/WebArea wrappers are skipped (children
 * promoted), empty `generic` wrappers with <=1 child collapse, empty StaticText
 * is dropped. New-since-`prevRefmap` ref-eligible nodes render with a `*` bullet.
 */
import type { SnapNode } from './walk.js'
import type { RefMap, RefEntry } from './refmap.js'
import { redactValue } from '../security/redact.js'

export type RenderOptions = {
  /** Keep only ref/value lines + their ancestor chain. */
  compact?: boolean
  /** Never-truncate cap; exceeding it throws OutputOverflowError. */
  maxChars?: number
  /** Input was interactive-filtered (interactive-only snapshot). */
  filtered?: boolean
  /** Emit inline `url=<href>` on link nodes. OFF by default — token-lean; the
   * host opts in with `--urls`/`-u` (engine-plan T1). RefEntry is unaffected, so
   * grounding/resolution do not depend on this. */
  emitUrls?: boolean
  /** Generation stamped into the minted RefMap (NOT echoed in the visible text). */
  generation: number
  /** Page title for the header line. */
  title: string
  /** Page URL for the header line. */
  url: string
  /** Previous generation's RefMap; ref-eligible nodes absent from it get `*`. */
  prevRefmap?: RefMap | null
}

/**
 * Thrown when the rendered text exceeds `maxChars`. The tree is NEVER sliced;
 * the CLI catches this and returns `fail("output_overflow")`, whose message
 * names the escape hatches (-d / -s / ref-scope).
 */
export class OutputOverflowError extends Error {
  readonly code = 'output_overflow' as const
  constructor() {
    super('output exceeded the size cap')
    this.name = 'OutputOverflowError'
  }
}

type TreeNode = { snap: SnapNode; index: number; children: TreeNode[] }

/**
 * Render the snapshot text and mint the RefMap for `opts.generation`.
 *
 * The `refmap` parameter is reserved for API symmetry with the resolver; refs
 * are always minted into a FRESH map stamped at `opts.generation` (a ref can
 * never carry a stale generation forward). The fresh map is returned.
 */
export function render(
  nodes: SnapNode[],
  refmap: RefMap,
  opts: RenderOptions,
): { text: string; refmap: RefMap } {
  void refmap

  const fresh: RefMap = { generation: opts.generation, entries: {} }

  // --- mint refs over ref-eligible nodes in document order ---
  const refByIndex = new Map<number, string>()
  const nthCounts = new Map<string, number>()
  let n = 0
  nodes.forEach((snap, index) => {
    if (!snap.refEligible) return
    n += 1
    const ref = `e${n}`
    const key = refGroupKey(snap.role, snap.name)
    const nth = nthCounts.get(key) ?? 0
    nthCounts.set(key, nth + 1)
    const entry: RefEntry = {
      generation: opts.generation,
      backendNodeId: snap.backendNodeId,
      role: snap.role,
      name: snap.name,
      nth,
      frameId: snap.frameId,
      // Record the mint mode so the slow-path re-match re-snapshots identically
      // (else a nameless cursor/scroll generic shifts its (role,name,nth) bucket).
      interactive: opts.filtered,
    }
    fresh.entries[ref] = entry
    refByIndex.set(index, ref)
  })

  // --- new-since-prev detection (by backendNodeId + role + name) ---
  const prevKeys = new Set<string>()
  if (opts.prevRefmap) {
    for (const e of Object.values(opts.prevRefmap.entries)) {
      prevKeys.add(nodeKey(e.backendNodeId, e.role, e.name))
    }
  }
  const isNew = (snap: SnapNode): boolean =>
    opts.prevRefmap != null &&
    snap.refEligible &&
    !prevKeys.has(nodeKey(snap.backendNodeId, snap.role, snap.name))

  // --- duplicate-label detection (design 2b) ---
  // A (role,name) minted more than once is a DUPLICATE group: N identical
  // `button "Add to cart" [ref=eN]` lines the host cannot tell apart, so it may
  // action the WRONG item while the tool still reports success:true. `nthCounts`
  // above already holds each key's TOTAL, and it is the SAME bucket resolve.ts
  // grounds on (role+name+nth) — so duplication is free (no second walk), and the
  // disambiguator can never drift from the bucket that causes the mis-action. A
  // ref with a UNIQUE label is not dup and gets no hint (token-lean).
  const isDup = (snap: SnapNode): boolean =>
    snap.refEligible && (nthCounts.get(refGroupKey(snap.role, snap.name)) ?? 0) > 1

  // --- render body ---
  const roots = buildTree(nodes)
  // Disambiguator hints: nearest distinctive ancestor text for DUP refs only,
  // computed from the tree the walk already built (no new DOM round-trip),
  // display-only (the RefMap/grounding is untouched — like mergeTextLeaves).
  const hintByIndex = computeDupHints(roots, isDup)
  const body: string[] = []
  for (const root of roots) {
    renderNode(root, 0, body, refByIndex, isNew, opts.filtered ?? false, opts.emitUrls ?? false, hintByIndex)
  }

  // --- assemble ---
  // Preamble trim (engine-plan T3): drop the `generation=N` echo from the header
  // and the `# note: interactive elements only` line. `generation` still travels
  // in the returned RefMap sidecar; only the token-costly VISIBLE echo is dropped.
  // The `⟦page-content untrusted⟧` security wrapper is applied downstream (in the
  // handler's presentPageText) and is untouched.
  const header = `- title: ${JSON.stringify(opts.title)} [url=${opts.url}]`
  const finalBody = opts.compact ? compact(body) : body
  const lines = [header, ...finalBody]
  const text = lines.join('\n')

  // --- never truncate ---
  if (opts.maxChars !== undefined && text.length > opts.maxChars) {
    throw new OutputOverflowError()
  }

  return { text, refmap: fresh }
}

function nodeKey(backendNodeId: number, role: string, name: string): string {
  return `${backendNodeId}\u0000${role}\u0000${name}`
}

/**
 * The (role,name) grouping key for ref minting and duplicate detection. Uses a
 * NUL separator (via the readable escape, NEVER a raw NUL byte — that
 * makes the source a "binary" file and is invisible/fragile to edit), NOT a
 * space: a real space is AMBIGUOUS (role "button" + name "Add to cart" collides
 * with role "button Add" + name "to cart"), whereas role/name never contain NUL.
 * The mint loop's `nth` counter and the 2b `isDup`/hint keys route through this
 * one helper so they can never drift — a mismatch silently disables dup detection
 * (the accessible name has spaces, so a space-keyed lookup misses the NUL-keyed map).
 */
function refGroupKey(role: string, name: string): string {
  return `${role}\u0000${name}`
}

/** Recover nesting from the flat list using each node's semantic `level`. */
function buildTree(nodes: SnapNode[]): TreeNode[] {
  const roots: TreeNode[] = []
  const stack: TreeNode[] = []
  nodes.forEach((snap, index) => {
    // Token fix: drop InlineTextBox from the TREE (not just at render). They are
    // Chrome AX line-fragment leaves whose text the parent StaticText already
    // carries. Keeping them here left a StaticText with children (length>0), so
    // `isTextLeaf` was false and `mergeTextLeaves` could NOT fold it — every
    // StaticText re-emitted as its own line on the full path. Removing them makes a
    // StaticText a true leaf, so it folds into its parent's line. Never ref-eligible,
    // so `refByIndex` (keyed by original flat index) is untouched; no text is lost.
    if (snap.role === 'InlineTextBox') return
    const tn: TreeNode = { snap, index, children: [] }
    while (stack.length && stack[stack.length - 1].snap.level >= snap.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(tn)
    else roots.push(tn)
    stack.push(tn)
  })
  return roots
}

function renderNode(
  tn: TreeNode,
  renderIndent: number,
  out: string[],
  refByIndex: Map<number, string>,
  isNew: (s: SnapNode) => boolean,
  filtered: boolean,
  emitUrls: boolean,
  hintByIndex: Map<number, string>,
): void {
  const { snap } = tn
  const role = snap.role
  const hasRef = refByIndex.has(tn.index)

  // Structural skips (children still render at the SAME indent).
  const skipLine =
    role === '' ||
    role === 'RootWebArea' ||
    role === 'WebArea' ||
    // InlineTextBox are Chrome AX line-fragment leaves: their name is a substring
    // of the parent StaticText's name (which is always emitted), they are never
    // refEligible, carry no ref/value/flags, and have no children — so on the full
    // (non-`-i`) snapshot they were 42% pure byte/token noise. `-i`/filtered mode
    // already dropped them via `filtered && !refEligible`; drop them everywhere.
    // No text is lost (the StaticText parent keeps it) and the RefMap is untouched.
    role === 'InlineTextBox' ||
    (role === 'generic' && !hasRef && tn.children.length <= 1) ||
    (role === 'StaticText' && snap.name === '') ||
    (filtered && !snap.refEligible)

  if (skipLine) {
    for (const child of tn.children) {
      renderNode(child, renderIndent, out, refByIndex, isNew, filtered, emitUrls, hintByIndex)
    }
    return
  }

  // Text-leaf merge (P1-P1): fold pure StaticText leaf children into THIS line
  // rather than re-emitting them as their own lines. A leaf that merely echoes
  // this node's name is dropped (dedup: `button "Save"` won't also print a
  // `StaticText "Save"`); when this node is unnamed, up to 3 leaves are folded
  // into its DISPLAY name so no text is lost. This is display-only — the minted
  // RefEntry keeps the node's real (unfolded) name, so resolve.ts still matches.
  const merged = mergeTextLeaves(snap, tn.children)

  out.push(
    formatLine(
      snap,
      renderIndent,
      refByIndex.get(tn.index),
      isNew(snap),
      merged.displayName,
      filtered,
      emitUrls,
      hintByIndex.get(tn.index),
    ),
  )
  for (const child of tn.children) {
    if (merged.absorbed.has(child)) continue
    renderNode(child, renderIndent + 1, out, refByIndex, isNew, filtered, emitUrls, hintByIndex)
  }
}

/** A StaticText node with no children of its own and a non-empty name. */
function isTextLeaf(tn: TreeNode): boolean {
  return tn.snap.role === 'StaticText' && tn.children.length === 0 && tn.snap.name !== ''
}

function normText(s: string): string {
  return s.trim().toLowerCase()
}

/** Collapse whitespace + cap a disambiguator hint (token-lean). */
function clipHint(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * Design 2b — nearest-distinctive-ancestor hints for DUPLICATED refs.
 *
 * When N refs share a (role,name) — 3 identical "Add to cart"/"Reply"/"Delete" —
 * the host cannot tell them apart from the snapshot text and may action the WRONG
 * one while the tool still reports success:true. For each such ref this finds the
 * nearest distinctive ancestor label and returns it keyed by node index; the
 * renderer emits it as a `near="…"` attribute.
 *
 * DISPLAY-ONLY (like mergeTextLeaves): the minted RefEntry is untouched, so the
 * refmap/grounding shape-match is unchanged. Computed from the tree the walk
 * already built — NO extra DOM round-trip. O(nodes): `firstHeading` is memoized.
 *
 * Precedence per ancestor level (nearest first): a heading among the siblings that
 * PRECEDE the branch to our node (a per-item title), else the ancestor's OWN
 * accessible name (a named region / aria-label). Preceding-heading-before-own-name
 * makes `heading "A", btnA, heading "B", btnB` under one region yield A/B, not the
 * region's shared name on both. A final pass drops a group's hints when they are
 * all identical (a hint identical on every member disambiguates nothing).
 */
function computeDupHints(
  roots: TreeNode[],
  isDup: (snap: SnapNode) => boolean,
): Map<number, string> {
  const hints = new Map<number, string>()
  const keyByIndex = new Map<number, string>() // index -> dup key, for the final filter

  // firstHeading(tn): name of the first `heading` in tn's subtree in document
  // order, '' if none. Memoized → the whole precompute is O(nodes).
  const headingCache = new Map<TreeNode, string>()
  const firstHeading = (tn: TreeNode): string => {
    const cached = headingCache.get(tn)
    if (cached !== undefined) return cached
    let res = ''
    if (tn.snap.role === 'heading' && tn.snap.name !== '') {
      res = tn.snap.name
    } else {
      for (const c of tn.children) {
        const h = firstHeading(c)
        if (h !== '') {
          res = h
          break
        }
      }
    }
    headingCache.set(tn, res)
    return res
  }

  const stack: { node: TreeNode; childPos: number }[] = []
  const walk = (tn: TreeNode): void => {
    if (isDup(tn.snap)) {
      const own = normText(tn.snap.name) // never pick the node's own label
      let label = ''
      for (let k = stack.length - 1; k >= 0 && label === ''; k--) {
        const { node: a, childPos } = stack[k]
        // (1) nearest preceding-sibling heading (per-item title wins).
        for (let i = childPos - 1; i >= 0; i--) {
          const h = firstHeading(a.children[i])
          if (h !== '' && normText(h) !== own) {
            label = h
            break
          }
        }
        // (2) the ancestor's own accessible name (named region / aria-label).
        if (label === '' && a.snap.name !== '' && normText(a.snap.name) !== own) {
          label = a.snap.name
        }
      }
      if (label !== '') {
        hints.set(tn.index, clipHint(label))
        keyByIndex.set(tn.index, refGroupKey(tn.snap.role, tn.snap.name))
      }
    }
    tn.children.forEach((c, i) => {
      stack.push({ node: tn, childPos: i })
      walk(c)
      stack.pop()
    })
  }
  for (const r of roots) walk(r)

  // Token-lean final pass: within a dup group, a hint IDENTICAL on every member
  // disambiguates nothing — drop it (e.g. 20 "Add to cart" under one unnamed list
  // all resolving to the same list heading).
  const byKey = new Map<string, number[]>()
  for (const [index, key] of keyByIndex) {
    const arr = byKey.get(key)
    if (arr) arr.push(index)
    else byKey.set(key, [index])
  }
  for (const indices of byKey.values()) {
    if (new Set(indices.map((i) => hints.get(i))).size <= 1) {
      for (const i of indices) hints.delete(i)
    }
  }
  return hints
}

/**
 * Compute a node's DISPLAY name and the set of its direct children to swallow.
 * Named node: drop text-leaf children that duplicate its name. Unnamed node:
 * absorb up to 3 text-leaf children into the display name.
 */
function mergeTextLeaves(
  snap: SnapNode,
  children: TreeNode[],
): { displayName: string; absorbed: Set<TreeNode> } {
  const absorbed = new Set<TreeNode>()
  if (snap.name !== '') {
    const key = normText(snap.name)
    for (const c of children) {
      if (isTextLeaf(c) && normText(c.snap.name) === key) absorbed.add(c)
    }
    return { displayName: snap.name, absorbed }
  }
  const leaves = children.filter(isTextLeaf)
  if (leaves.length === 0) return { displayName: '', absorbed }
  const picked = leaves.slice(0, 3)
  for (const c of picked) absorbed.add(c)
  const folded = picked
    .map((c) => c.snap.name)
    .join(' ')
    .trim()
    .slice(0, 100)
  return { displayName: folded, absorbed }
}

/**
 * Neutralize the characters that STRUCTURE the snapshot attribute list (`[`, `]`,
 * `,`) and the line format (control chars incl. `\n`/`\r`) out of an
 * attacker-controlled, UNQUOTED attribute value: `min`/`max` come straight from
 * the page's HTML min/max attributes and `url` from cleanUrl() (neither is
 * percent-/JSON-escaped). Without this a hostile page could put `]`, `,`, or an
 * encoded newline into a value to close the `[…]` list early, inject a fake
 * comma-separated token (e.g. `ref=e99`), or forge an ENTIRELY NEW
 * `* role "name" [ref=eN]` line that a host LLM reads as trusted Silver
 * structure (a spoofed "Wire $500" button reusing a real ref id). Replacing each
 * with a single space closes the forgery while PRESERVING the documented
 * unquoted `min=`/`max=`/`url=` format (we deliberately do NOT JSON.stringify —
 * that would change the format and break examples/tests). Safe because the real
 * link target is grounded via the refmap, not the displayed url.
 */
function sanitizeAttrValue(v: string): string {
  return v.replace(/[\[\],\u0000-\u001f\u007f]/g, ' ')
}

/**
 * Neutralize LINE structure only, for the trailing `: <value>` tail.
 *
 * The tail is the last thing on the line, so `[`/`]`/`,` cannot forge attribute
 * structure there — only a control character can, by ending the line and starting
 * a forged one (`- button "Wire $500" [ref=e1]`) that a host LLM reads as trusted
 * Silver output. So this strips exactly the control characters and nothing else.
 *
 * Deliberately NOT `sanitizeAttrValue`: that also replaces brackets, which would
 * mangle the `[redacted]` sentinel the redaction choke point emits into this very
 * field — turning a security marker into ordinary-looking text.
 */
function sanitizeValueTail(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function formatLine(
  snap: SnapNode,
  renderIndent: number,
  ref: string | undefined,
  markNew: boolean,
  displayName: string,
  filtered: boolean,
  emitUrls: boolean,
  dupHint: string | undefined,
): string {
  const indent = '  '.repeat(renderIndent)
  const bullet = markNew ? '*' : '-'
  let line = `${indent}${bullet} ${snap.role}`

  if (displayName !== '') line += ` ${JSON.stringify(displayName)}`

  const attrs: string[] = []
  if (ref) attrs.push(`ref=${ref}`)
  // `level=` trim (engine-plan T2): the 2-space indent already encodes depth, so
  // emit `level=N` only when the indent is non-zero, and never in filtered
  // (interactive) mode — where the flat interactive list makes it pure noise.
  if (!filtered && renderIndent > 0) attrs.push(`level=${renderIndent}`)
  // Design 2b — nearest distinctive ancestor text, ONLY for duplicated (role,name)
  // refs (undefined for unique labels → nothing pushed → token-lean, goldens
  // unchanged). Placed right after ref/level so the disambiguator sits next to the
  // ref it disambiguates. QUOTED via JSON.stringify exactly like name/placeholder,
  // so a hostile heading/aria-label cannot forge `]`/`,` attribute structure (the
  // unquoted sanitizeAttrValue path is for min/max/url only).
  if (dupHint) attrs.push(`near=${JSON.stringify(dupHint)}`)
  if (snap.flags.checked !== undefined) attrs.push(`checked=${snap.flags.checked}`)
  if (snap.flags.expanded !== undefined) attrs.push(`expanded=${snap.flags.expanded}`)
  if (snap.flags.selected === true) attrs.push('selected')
  if (snap.flags.disabled === true) attrs.push('disabled')
  if (snap.flags.required === true) attrs.push('required')
  // Aside-alignment: surface the control that currently holds keyboard focus, so
  // the host knows where `press Enter` / typing lands without a separate probe.
  // The flag is already captured on the node (walk.ts) — this just renders it.
  // At most one element is focused, so it costs ~1 token/snapshot (token-lean).
  if (snap.flags.focused === true) attrs.push('focused')
  // Aside-alignment: mark a scroll container so the host knows it can `scroll @ref
  // --by dx dy` this box (a chat pane / modal body / virtualized list). Without the
  // ref (now minted for nameless scroll boxes) the inner-scroll capability was undiscoverable.
  if (snap.flags.scrollable === true) attrs.push('scrollable')
  if (snap.flags.placeholder) attrs.push(`placeholder=${JSON.stringify(snap.flags.placeholder)}`)
  // P3: relabel a native `<input type=file>` off Chrome's generic `button` role
  // so the host knows this ref opens a file picker (drives `upload`, not `click`).
  if (snap.inputType === 'file') attrs.push('file-upload')
  // C1 format hints: give the agent the shape it must produce (select options,
  // date/time ISO format, range/number min-max, email) so it stops mis-filling.
  for (const hint of formatHints(snap)) attrs.push(hint)
  // Inline href is opt-in (engine-plan T1): only when the host passed `--urls`.
  if (emitUrls && snap.url) attrs.push(`url=${sanitizeAttrValue(snap.url)}`)
  if (attrs.length) line += ` [${attrs.join(', ')}]`

  // Redaction hint uses the node's REAL name (not the folded display name).
  //
  // SANITIZED for the same reason every other attacker-reachable field is: this
  // is the ONE field that was emitted raw, and `snap.value` comes straight off the
  // AX node, which a page sets directly via an input's `value`. A newline in it
  // forged an entire extra line — `- button "Wire $500" [ref=e1]` — that a host
  // LLM reads as trusted Silver structure, complete with a real ref id. Names and
  // near-hints are quoted (JSON.stringify) and min/max/url go through
  // sanitizeAttrValue; the tail needs the same treatment and deliberately NOT
  // quoting, because `: value` unquoted is the documented, golden-tested format.
  const value = sanitizeValueTail(redactValue(snap.role, snap.name, snap.value, snap.isPassword))
  if (value !== '' && value !== displayName) line += `: ${value}`

  return line
}

/**
 * C1 — turn the DOM metadata walk.ts carries (input type, min/max, select
 * options) into compact `[…]` hints so an agent fills the RIGHT shape:
 *   - `<select>`                  → `options=["A","B",…]` (first 4)
 *   - date/datetime/time/month/week → `format="YYYY-MM-DD"`-style ISO hint
 *   - range / number              → `min=` / `max=` (+ `format_hint=number`)
 *   - email                       → `format_hint=email`
 */
function formatHints(snap: SnapNode): string[] {
  const out: string[] = []
  if (snap.options && snap.options.length > 0) {
    out.push(`options=${JSON.stringify(snap.options.slice(0, 4))}`)
  }
  switch (snap.inputType) {
    case 'date':
      out.push('format="YYYY-MM-DD"')
      break
    case 'datetime-local':
      out.push('format="YYYY-MM-DDThh:mm"')
      break
    case 'time':
      out.push('format="hh:mm"')
      break
    case 'month':
      out.push('format="YYYY-MM"')
      break
    case 'week':
      out.push('format="YYYY-Www"')
      break
    case 'range':
    case 'number':
      if (snap.min !== undefined) out.push(`min=${sanitizeAttrValue(snap.min)}`)
      if (snap.max !== undefined) out.push(`max=${sanitizeAttrValue(snap.max)}`)
      if (snap.inputType === 'number') out.push('format_hint=number')
      break
    case 'email':
      out.push('format_hint=email')
      break
    default:
      break
  }
  return out
}

/**
 * Compact: keep only lines carrying a `ref=` or a `: value`, plus each kept
 * line's ancestor chain (by 2-space indentation). Mirrors reference
 * snapshot.rs:1205-1247.
 */
function compact(lines: string[]): string[] {
  if (lines.length === 0) return lines
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('ref=') && !line.includes(': ')) continue
    keep[i] = true
    const myIndent = countIndent(line)
    for (let j = i - 1; j >= 0; j--) {
      const ancestorIndent = countIndent(lines[j])
      if (ancestorIndent < myIndent) {
        keep[j] = true
        if (ancestorIndent === 0) break
      }
    }
  }
  return lines.filter((_l, i) => keep[i])
}

function countIndent(line: string): number {
  const trimmed = line.replace(/^\s+/, '')
  return (line.length - trimmed.length) / 2
}
