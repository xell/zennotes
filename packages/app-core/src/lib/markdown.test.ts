// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('sanitizes raw HTML and javascript URLs', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src="x" onerror="alert(1)">',
        '<a href="javascript:alert(1)">bad</a>'
      ].join('\n')
    )

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('javascript:alert(1)')
  })

  it('preserves GFM table column alignment through render + sanitize', () => {
    const html = renderMarkdown(
      ['| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n')
    )

    // remark-gfm emits the `align` attribute on aligned cells; the sanitizer
    // must keep it so the CSS attribute selectors can honor the alignment.
    expect(html).toContain('align="center"')
    expect(html).toContain('align="right"')
  })

  it('preserves task checkboxes, wikilink metadata, and diagram placeholders', () => {
    const html = renderMarkdown(
      [
        '- [x] done',
        '',
        '[[Course Map]]',
        '',
        '```mermaid',
        'graph TD; A-->B',
        '```'
      ].join('\n')
    )

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
    expect(html).toContain('data-wikilink="Course Map"')
    expect(html).toContain('class="mermaid"')
    expect(html).toContain('graph TD; A--&gt;B')
  })

  it('renders Obsidian image embeds as local image nodes', () => {
    const html = renderMarkdown('![[CleanShot 2026-04-13 at 14.31.31@2x.png]]')

    expect(html).toContain('<img')
    expect(html).toContain('src="CleanShot%202026-04-13%20at%2014.31.31@2x.png"')
    expect(html).toContain('alt="CleanShot 2026-04-13 at 14.31.31@2x.png"')
  })

  it('renders excalidraw embeds as placeholder divs', () => {
    const html = renderMarkdown('![[diagram.excalidraw]]')

    expect(html).toContain('data-excalidraw-embed="diagram.excalidraw"')
    expect(html).toContain('class="excalidraw-embed-host"')
    expect(html).not.toContain('<img')
  })

  it('parses size hints on excalidraw embeds', () => {
    const html = renderMarkdown('![[diagram.excalidraw|600x400]]')

    expect(html).toContain('data-excalidraw-embed="diagram.excalidraw"')
    expect(html).toContain('data-embed-width="600"')
    expect(html).toContain('data-embed-height="400"')
  })

  it('renders excalidraw embeds without size hint when label is the target', () => {
    const html = renderMarkdown('![[diagram.excalidraw]]')

    expect(html).not.toContain('data-embed-width')
    expect(html).not.toContain('data-embed-height')
  })

  it('renders ==text== as <mark> (and survives the sanitizer)', () => {
    expect(renderMarkdown('==highlighted==')).toContain('<mark>highlighted</mark>')
    const two = renderMarkdown('==a== and ==b==')
    expect(two).toContain('<mark>a</mark>')
    expect(two).toContain('<mark>b</mark>')
    // Unicode content (the #218 examples).
    expect(renderMarkdown('Научное применение ==Fortran==')).toContain('<mark>Fortran</mark>')
    expect(renderMarkdown('==важно==')).toContain('<mark>важно</mark>')
  })

  it('does not treat spaced == or code-span == as a highlight', () => {
    expect(renderMarkdown('x == y == z')).not.toContain('<mark>')
    expect(renderMarkdown('`==nothighlight==`')).not.toContain('<mark>')
  })

  it('keeps colored <mark class="hl-..."> highlights through the sanitizer', () => {
    const html = renderMarkdown('<mark class="hl-green">green</mark>')
    expect(html).toContain('<mark')
    expect(html).toContain('class="hl-green"')
    expect(html).toContain('green')
  })
})

describe('table column widths (#294)', () => {
  it('renders a <colgroup> from a trailing zen:cols comment', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- zen:cols=120,200 -->\n')
    expect(html).toContain('<colgroup>')
    expect(html).toContain('width:120px')
    expect(html).toContain('zen-has-col-widths')
  })
  it('leaves a plain table (no marker) untouched', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).not.toContain('colgroup')
    expect(html).not.toContain('zen-has-col-widths')
  })
})

describe('math with raw pipes inside tables (#319)', () => {
  const cell = (formula: string): string =>
    renderMarkdown(`| Formula | Note |\n| --- | --- |\n| ${formula} | x |\n`)

  it('renders raw unescaped pipes in table math', () => {
    // conditional probability, set-builder, absolute value
    expect(cell('$P(A|B)$')).toContain('katex')
    expect(cell('$\\{x | x > 0\\}$')).toContain('katex')
    expect(cell('$|x|$')).toContain('katex')
  })

  it('still keeps simple and escaped-pipe table math working', () => {
    expect(cell('$\\sum_{i=1}^n i$')).toContain('katex')
    expect(cell('$P(A\\|B)$')).toContain('katex')
  })

  it('does not false-escape a currency row (leaves the cells split)', () => {
    const html = renderMarkdown('| Item | Price |\n| --- | --- |\n| Widget $5 | $10 |\n')
    expect(html).toMatch(/<td>\s*Widget \$5\s*<\/td>/)
    expect(html).toMatch(/<td>\s*\$10\s*<\/td>/)
    expect(html).not.toContain('katex')
  })

  it('does not touch math with a pipe OUTSIDE a table', () => {
    const html = renderMarkdown('Norm is $|x|$ inline.')
    expect(html).toContain('katex')
    expect(html).not.toContain('\\|')
  })
})
