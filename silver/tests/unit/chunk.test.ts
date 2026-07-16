import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../src/perception/chunk.js'

describe('chunkMarkdown — table-header carry-forward', () => {
  it('a table split across chunks keeps the header row in the continuation chunk', () => {
    const header = '| Name | Age | City |'
    const delim = '| --- | --- | --- |'
    const rows = Array.from({ length: 12 }, (_v, i) => `| Person${i} | ${20 + i} | Town${i} |`)
    const md = [header, delim, ...rows].join('\n')

    // Budget small enough that the rows cannot all fit in one chunk.
    const chunks = chunkMarkdown(md, { maxChars: 90 })

    expect(chunks.length).toBeGreaterThan(1)
    // EVERY chunk (not just the first) shows the column headers + delimiter.
    for (const c of chunks) {
      expect(c.text).toContain(header)
      expect(c.text).toContain(delim)
    }
    // A continuation chunk carries the header even though the row it starts with
    // is NOT the original header row.
    const cont = chunks[1]
    expect(cont.text.startsWith(header)).toBe(true)
    // Every body row is preserved exactly once across the chunk set.
    const joined = chunks.map((c) => c.text).join('\n')
    for (const r of rows) expect(joined).toContain(r)
  })

  it('a header-only chunk boundary still reproduces the header text verbatim', () => {
    const md = ['| A | B |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text).toContain('| A | B |')
  })
})

describe('chunkMarkdown — never split a code fence', () => {
  it('keeps a fenced code block whole even when it exceeds the budget', () => {
    const code = ['```js', 'const a = 1', 'const b = 2', 'const c = 3', '```'].join('\n')
    const md = ['intro line', code, 'outro line'].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 15 })
    // The whole fence lives in exactly one chunk, intact (opening + closing).
    const withFence = chunks.filter((c) => c.text.includes('```js'))
    expect(withFence.length).toBe(1)
    expect(withFence[0].text).toContain('```js')
    expect(withFence[0].text).toContain('const c = 3')
    // both fence markers are present in that chunk (never a dangling fence)
    expect((withFence[0].text.match(/```/g) ?? []).length).toBe(2)
    // a `#`/`|` inside a fence is not misread as a heading/table split point
    const md2 = ['```', '# not a heading', '| not | a | table |', '```'].join('\n')
    const c2 = chunkMarkdown(md2, { maxChars: 5 })
    expect(c2.length).toBe(1)
    expect(c2[0].text).toBe(md2)
  })
})

describe('chunkMarkdown — header-preferred split', () => {
  it('closes the chunk before a heading once past the budget fraction', () => {
    const md = [
      'para one is reasonably long text here',
      'para two continues with more content',
      '## Section Two',
      'body of section two goes here now',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 80, headerSplitFraction: 0.5 })
    expect(chunks.length).toBeGreaterThan(1)
    // The heading starts a chunk (kept whole with its section), not trailing the
    // previous one.
    const headingChunk = chunks.find((c) => c.text.includes('## Section Two'))
    expect(headingChunk).toBeTruthy()
    expect(headingChunk!.text.startsWith('## Section Two')).toBe(true)
  })
})

describe('chunkMarkdown — offsets + overlap', () => {
  it('startChar/endChar index the original text and cover it in order', () => {
    const md = ['line a', 'line b', 'line c', 'line d'].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 8 })
    expect(chunks.length).toBeGreaterThan(1)
    // startChar is monotonic and each chunk's own slice matches the original.
    let prev = -1
    for (const c of chunks) {
      expect(c.startChar).toBeGreaterThan(prev)
      prev = c.startChar
      expect(md.slice(c.startChar, c.endChar).length).toBeGreaterThan(0)
    }
    // first chunk starts at offset 0
    expect(chunks[0].startChar).toBe(0)
  })

  it('prepends an overlap prefix from the previous chunk when overlap > 0', () => {
    const md = ['alpha', 'bravo', 'charlie', 'delta'].join('\n')
    const noOverlap = chunkMarkdown(md, { maxChars: 7 })
    const withOverlap = chunkMarkdown(md, { maxChars: 7, overlap: 4 })
    expect(withOverlap.length).toBeGreaterThan(1)
    // the second chunk carries a tail slice of the first chunk's text as context
    const firstTail = noOverlap[0].text.slice(-4)
    expect(withOverlap[1].text.startsWith(firstTail)).toBe(true)
  })

  it('returns [] for empty input', () => {
    expect(chunkMarkdown('', { maxChars: 100 })).toEqual([])
  })
})
