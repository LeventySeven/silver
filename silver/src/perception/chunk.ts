/**
 * Structure-aware markdown chunking (adopt-list v3 P2; browser-use's
 * `chunk_markdown_by_structure`).
 *
 * Naive character slicing of extracted markdown cuts through the middle of a
 * fenced code block or a table row, producing garbage the host must mentally
 * reconstruct (a half a ``` fence, a table with no column headers). This module
 * chunks markdown along STRUCTURAL boundaries instead:
 *
 *   1. Atomic blocks — a fenced code block (``` … ``` / ~~~ … ~~~) and every
 *      table row are treated as indivisible units and are NEVER split across a
 *      chunk boundary. (A single atomic block larger than the budget is emitted
 *      whole in its own oversized chunk — the never-split rule wins over the
 *      budget, by design, so a code fence stays valid.)
 *   2. Header-preferred split points — when the current chunk is already at or
 *      past `headerSplitFraction` of the budget (default 50%) and a Markdown
 *      heading (`#`, `##`, …) begins, the chunk is closed BEFORE the heading so
 *      a section stays whole in the next chunk.
 *   3. Table-header carry-forward — when a table's body rows spill into a new
 *      chunk, that chunk is prefixed with the table's header + delimiter rows so
 *      a continuation chunk still shows the column names.
 *   4. Overlap prefix — an optional trailing slice of the previous chunk is
 *      prepended to the next for context continuity (skipped when a table-header
 *      carry-forward already supplies the leading context).
 *
 * KEYLESS: a pure string algorithm — no model call, no I/O. Exposed as a pure
 * function for the extract/read path to call on oversized extracted text.
 *
 * `startChar`/`endChar` are offsets into the ORIGINAL markdown of the chunk's
 * own (non-injected) content — injected table headers and overlap prefixes are
 * NOT counted — so a host can resume with a `--start-from-char`/chunk-index
 * continuation by seeking `startChar`.
 */

export type ChunkOptions = {
  /** Target maximum characters per chunk (soft — a single atomic block may exceed it). */
  maxChars: number
  /**
   * Characters of the previous chunk's tail to prepend to the next chunk for
   * context continuity. Default 0 (off). Skipped when a table-header
   * carry-forward already supplies the chunk's leading context.
   */
  overlap?: number
  /**
   * Fraction of the budget (0..1) at/after which a heading becomes a preferred
   * split point (close the chunk before the heading). Default 0.5.
   */
  headerSplitFraction?: number
}

export type MarkdownChunk = {
  /** 0-based position of this chunk in the sequence. */
  index: number
  /** The chunk's rendered text (may include injected header/overlap prefixes). */
  text: string
  /** Offset into the ORIGINAL markdown where this chunk's own content starts. */
  startChar: number
  /** Offset into the ORIGINAL markdown where this chunk's own content ends. */
  endChar: number
}

type BlockKind = 'code' | 'table-header' | 'table-row' | 'heading' | 'text'

type Block = {
  kind: BlockKind
  /** The block's own text (as it appears in the original). */
  text: string
  /** Start offset in the original markdown. */
  start: number
  /** End offset in the original markdown (exclusive). */
  end: number
  /** For table-row blocks: the header+delimiter text to carry forward on a split. */
  tableHeader?: string
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/
/** A GFM table delimiter row: pipes, dashes, colons, spaces — with at least one dash. */
const DELIM_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
/** A line that participates in a table (contains a pipe). */
const ROW_RE = /\|/
/** A Markdown ATX heading line. */
const HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/

/**
 * Chunk `markdown` into structural units no larger than `opts.maxChars` where
 * possible, never splitting a code fence or a table row and carrying a table's
 * header rows forward into continuation chunks.
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions): MarkdownChunk[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars))
  const overlap = Math.max(0, Math.floor(opts.overlap ?? 0))
  const headerFraction = clamp01(opts.headerSplitFraction ?? 0.5)
  const headerThreshold = maxChars * headerFraction

  if (markdown === '') return []

  const blocks = parseBlocks(markdown)
  if (blocks.length === 0) return []

  const chunks: MarkdownChunk[] = []

  // Accumulator for the chunk being built.
  let parts: string[] = [] // rendered pieces (may include injected prefixes)
  let len = 0 // running character length of `parts` (joined by '\n')
  let ownStart = -1 // original offset of this chunk's first own block
  let ownEnd = -1 // original offset of this chunk's last own block
  let pendingOverlap = '' // tail of the previously emitted chunk, if overlap > 0

  const isEmpty = (): boolean => parts.length === 0

  const flush = (): void => {
    if (isEmpty()) return
    const text = parts.join('\n')
    chunks.push({ index: chunks.length, text, startChar: ownStart, endChar: ownEnd })
    if (overlap > 0) pendingOverlap = text.slice(-overlap)
    parts = []
    len = 0
    ownStart = -1
    ownEnd = -1
  }

  const push = (piece: string): void => {
    parts.push(piece)
    len += piece.length + 1 // +1 for the '\n' join
  }

  const addBlock = (block: Block): void => {
    if (isEmpty()) {
      // Fresh chunk: inject the leading context prefix (table header wins over
      // a generic overlap slice — it is the more useful continuation context).
      if (block.kind === 'table-row' && block.tableHeader) {
        push(block.tableHeader)
      } else if (pendingOverlap !== '') {
        push(pendingOverlap)
      }
      pendingOverlap = ''
      ownStart = block.start
    }
    push(block.text)
    ownEnd = block.end
  }

  for (const block of blocks) {
    const addedLen = block.text.length + 1
    const wouldOverflow = !isEmpty() && len + addedLen > maxChars
    const headerBreak = block.kind === 'heading' && !isEmpty() && len >= headerThreshold
    if (wouldOverflow || headerBreak) flush()
    addBlock(block)
  }
  flush()

  return chunks
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Split the markdown into a flat list of structural blocks, grouping fenced
 * code and tables. Fences are consumed first (so a `#`/`|` INSIDE a fence is
 * never mistaken for a heading/table), then tables (header + delimiter + rows),
 * then headings, then plain-text lines.
 */
function parseBlocks(md: string): Block[] {
  const lines = md.split('\n')
  const lineStart: number[] = []
  {
    let off = 0
    for (const ln of lines) {
      lineStart.push(off)
      off += ln.length + 1
    }
  }
  const startOf = (i: number): number => lineStart[i]
  const endOf = (i: number): number => lineStart[i] + lines[i].length

  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // --- fenced code block: consume to the matching closing fence -----------
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1][0] // '`' or '~'
      const minLen = fence[1].length
      const startLine = i
      i++
      while (i < lines.length) {
        const t = lines[i].trimStart()
        if (
          t.startsWith(marker.repeat(minLen)) &&
          /^[`~]+\s*$/.test(t) // a bare closing fence line
        ) {
          i++
          break
        }
        i++
      }
      const lastLine = i - 1
      blocks.push({
        kind: 'code',
        text: lines.slice(startLine, lastLine + 1).join('\n'),
        start: startOf(startLine),
        end: endOf(lastLine),
      })
      continue
    }

    // --- table: a row line immediately followed by a delimiter row ----------
    if (ROW_RE.test(line) && i + 1 < lines.length && DELIM_RE.test(lines[i + 1])) {
      const headerText = `${lines[i]}\n${lines[i + 1]}`
      blocks.push({
        kind: 'table-header',
        text: headerText,
        start: startOf(i),
        end: endOf(i + 1),
        tableHeader: headerText,
      })
      i += 2
      while (i < lines.length && ROW_RE.test(lines[i]) && !FENCE_RE.test(lines[i])) {
        blocks.push({
          kind: 'table-row',
          text: lines[i],
          start: startOf(i),
          end: endOf(i),
          tableHeader: headerText,
        })
        i++
      }
      continue
    }

    // --- heading or plain-text line -----------------------------------------
    blocks.push({
      kind: HEADING_RE.test(line) ? 'heading' : 'text',
      text: line,
      start: startOf(i),
      end: endOf(i),
    })
    i++
  }

  return blocks
}
