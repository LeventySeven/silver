import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from '../../src/perception/markdown.js'

// Regression tests for the two review-confirmed defects in the S6 markdown
// converter, both rooted in the untrusted-HTML string tokenizer.
const NUL = String.fromCharCode(0)

describe('htmlToMarkdown — security + correctness hardening (review S6-fix)', () => {
  it('does NOT let NUL-byte page content forge a markdown link', () => {
    // The internal link sentinels are NUL-delimited. Before the fix, page text
    // carrying literal NUL bytes could inject the sentinel run and synthesize a
    // `[label](url)` link that never existed as an <a> tag (content spoofing —
    // e.g. pointing a downstream agent at an attacker URL). The input NUL-strip
    // makes the sentinels collision-proof.
    const payload =
      'Before ' +
      NUL + 'AHREF:http://evil.example.com' +
      NUL + '/AHREF' +
      NUL + 'Click official site' +
      NUL + 'ACLOSE' + NUL +
      ' after'
    const md = htmlToMarkdown('<p>' + payload + '</p>', {
      links: true,
      baseUrl: 'https://real-site.example.com',
    })
    expect(md).not.toContain('](http://evil.example.com)')
    expect(md).not.toContain('[Click official site]')
    // The visible text survives (just as inert text, no link structure).
    expect(md).toContain('Before')
    expect(md).toContain('after')
  })

  it('does NOT drop content after a <script> whose body contains a bare "<"', () => {
    // `for(i=0;i<n;i++)` inside inline JS has a bare `<` the HTML tokenizer would
    // misread as a tag, swallowing the real </script> and every node after it.
    // Rawtext bodies are now pre-stripped, so following content survives.
    const md = htmlToMarkdown(
      '<h1>Title</h1><script>for(var i=0;i<n;i++){doThing()}</script><h2>After</h2><p>Body text here.</p>',
    )
    expect(md).toContain('# Title')
    expect(md).toContain('## After')
    expect(md).toContain('Body text here.')
    // The script source itself must never appear in the output.
    expect(md).not.toContain('doThing')
  })

  it('handles a bare "<" inside <style> the same way', () => {
    const md = htmlToMarkdown('<style>.a{}/* i<n */</style><p>Visible.</p>')
    expect(md).toContain('Visible.')
    expect(md).not.toContain('i<n')
  })

  it('still converts real structure: headings, lists, and opt-in links', () => {
    const html =
      '<nav><a href="/skip">SkipNav</a></nav>' +
      '<article><h1>Main</h1><h2>Sub</h2>' +
      '<p>Hi <a href="/deep">deep</a>.</p>' +
      '<ul><li>one</li><li>two</li></ul></article>' +
      '<footer>SkipFoot</footer>'
    const withLinks = htmlToMarkdown(html, { links: true, baseUrl: 'https://ex.com' })
    expect(withLinks).toContain('# Main')
    expect(withLinks).toContain('## Sub')
    expect(withLinks).toContain('[deep](https://ex.com/deep)')
    expect(withLinks).toContain('- one')
    expect(withLinks).not.toContain('SkipNav')
    expect(withLinks).not.toContain('SkipFoot')
    // Without --links, no link markup, just the text.
    const noLinks = htmlToMarkdown(html, { links: false })
    expect(noLinks).not.toContain('](')
    expect(noLinks).toContain('deep')
  })

  it('never emits a javascript: URL even from a real anchor', () => {
    const md = htmlToMarkdown('<p><a href="javascript:alert(1)">x</a></p>', { links: true })
    expect(md).not.toContain('javascript:')
  })
})
