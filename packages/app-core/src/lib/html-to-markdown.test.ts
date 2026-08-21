import { describe, expect, it } from 'vitest'
import {
  cleanClipboardHtml,
  htmlToMarkdown,
  htmlWorthConverting,
  rebuildWordLists
} from './html-to-markdown'

/**
 * One list paragraph exactly as Word (mac) puts it on the clipboard: the level
 * hidden in `mso-list`, and the bullet PAINTED as text inside a conditional
 * block rather than the markup saying "this is a list".
 */
const wordItem = (level: number, marker: string, text: string): string =>
  `<p class=MsoListParagraphCxSpMiddle style='text-indent:-.25in;mso-list:l0 level${level} lfo1'>` +
  `<!--[if !supportLists]--><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}` +
  `<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><!--[endif]-->` +
  `<span lang=EN-GB>${text}<o:p></o:p></span></p>`

// A trimmed but faithful sample of what Word (mac) actually puts on the
// clipboard: a conditional comment, a stylesheet, mso- styles, per-run spans,
// and an Office-namespaced empty paragraph.
const WORD_HTML = `
<!--[if gte mso 9]><xml><w:WordDocument/></xml><![endif]-->
<style><!-- p.MsoNormal { mso-style-parent:""; font-size:12.0pt } --></style>
<ul style='margin-top:0in' type=disc>
  <li class=MsoNormal style='mso-list:l0 level1'>
    <span style='font-family:"Times New Roman"'><i>National Top-Tier Online Course</i></span>,
    <span style='mso-bidi-font-weight:normal'>Ministry of Education, China, 2022.</span>
    <o:p></o:p>
  </li>
  <li class=MsoNormal><i>The Second Zijin Award</i>, PI, 2020 - 2021.</li>
</ul>`

describe('cleanClipboardHtml', () => {
  it('strips conditional comments, stylesheets and Office-namespaced tags', () => {
    const out = cleanClipboardHtml(WORD_HTML)
    expect(out).not.toMatch(/<!--/)
    expect(out).not.toMatch(/<style/i)
    expect(out).not.toMatch(/<o:p>/i)
    expect(out).not.toMatch(/mso-/)
  })

  it('drops style/class attributes but keeps structural ones', () => {
    const out = cleanClipboardHtml(
      '<td colspan="2" class="x" style="width:3in"><a href="https://a.test" id="k">go</a></td>'
    )
    expect(out).toContain('colspan="2"')
    expect(out).toContain('href="https://a.test"')
    expect(out).not.toContain('class=')
    expect(out).not.toContain('style=')
    expect(out).not.toContain('id=')
  })

  it('unwraps spans but leaves block tags alone', () => {
    const out = cleanClipboardHtml('<p><span style="x">a</span><br><span>b</span></p>')
    expect(out).not.toMatch(/<\/?span/i)
    expect(out).toContain('<p>')
    expect(out).toContain('<br>')
  })
})

describe('htmlWorthConverting', () => {
  it('is true for real rich text', () => {
    expect(htmlWorthConverting('<p><b>hi</b></p>')).toBe(true)
  })

  it('is false for a lone img — that is a browser image copy, let it paste as an image', () => {
    expect(htmlWorthConverting('<img src="https://example.com/cat.png">')).toBe(false)
  })

  it('is false for plain wrapped text and for empty input', () => {
    expect(htmlWorthConverting('<p>just words</p>')).toBe(false)
    expect(htmlWorthConverting('')).toBe(false)
  })
})

describe('htmlToMarkdown', () => {
  it('converts a Word bullet list, keeping the italics', async () => {
    const md = await htmlToMarkdown(WORD_HTML)
    expect(md).toContain('- *National Top-Tier Online Course*, Ministry of Education, China, 2022.')
    expect(md).toContain('- *The Second Zijin Award*, PI, 2020 - 2021.')
  })

  it('converts headings, links and GFM tables', async () => {
    const md = await htmlToMarkdown(
      '<h2>Title</h2><p><a href="https://a.test">link</a></p>' +
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    )
    expect(md).toContain('## Title')
    expect(md).toContain('[link](https://a.test)')
    expect(md).toContain('| A | B |')
    expect(md).toContain('| 1 | 2 |')
  })

  it('returns null when there is nothing worth converting', async () => {
    expect(await htmlToMarkdown('<p>just words</p>')).toBeNull()
    expect(await htmlToMarkdown('')).toBeNull()
  })

  // The failure that made the first attempt useless: Word does NOT emit
  // <ul><li>. It emits flat <p> paragraphs with the bullet drawn in as text,
  // so without this the whole list arrived as prose starting with a stray "·".
  describe('rebuildWordLists', () => {
    it('turns Word\'s flat list paragraphs into a real list, dropping the painted bullet', () => {
      const out = rebuildWordLists(wordItem(1, '&middot;', 'First') + wordItem(1, '&middot;', 'Second'))
      expect(out).toContain('<ul>')
      expect(out).toContain('</ul>')
      expect(out.match(/<li>/g)).toHaveLength(2)
      expect(out).not.toContain('&middot;')
    })

    it('nests by the level Word hides in mso-list', () => {
      const out = rebuildWordLists(
        wordItem(1, '&middot;', 'Top') + wordItem(2, 'o', 'Nested') + wordItem(1, '&middot;', 'Back')
      )
      // outer ul, one nested ul inside it
      expect(out.match(/<ul>/g)).toHaveLength(2)
      expect(out.match(/<\/ul>/g)).toHaveLength(2)
    })

    it('reads ordered vs bulleted from the painted marker', () => {
      expect(rebuildWordLists(wordItem(1, '1.', 'One'))).toContain('<ol>')
      expect(rebuildWordLists(wordItem(1, 'a)', 'Ay'))).toContain('<ol>')
      expect(rebuildWordLists(wordItem(1, '&middot;', 'Dot'))).toContain('<ul>')
    })

    it('ends the run at real content and leaves non-list paragraphs alone', () => {
      const out = rebuildWordLists(
        wordItem(1, '&middot;', 'A') + '<p class=MsoNormal>Prose</p>' + wordItem(1, '&middot;', 'B')
      )
      expect(out.match(/<ul>/g)).toHaveLength(2)
      expect(out).toContain('<p class=MsoNormal>Prose</p>')
    })
  })

  describe('end-to-end Word paste', () => {
    it('produces a real Markdown list, keeping inline emphasis', async () => {
      const md = await htmlToMarkdown(
        wordItem(1, '&middot;', 'Led product design for an international platform.') +
          wordItem(1, '&middot;', '<i>The Second Zijin Award</i>, PI, 2020 - 2021.')
      )
      expect(md).toBe(
        '- Led product design for an international platform.\n' +
          '- *The Second Zijin Award*, PI, 2020 - 2021.'
      )
    })

    it('leaves no Word scaffolding behind', async () => {
      const md = (await htmlToMarkdown(wordItem(1, '&middot;', 'Clean'))) ?? ''
      expect(md).not.toMatch(/supportLists|endif|mso-|&middot;|&nbsp;|o:p/)
    })
  })
})
