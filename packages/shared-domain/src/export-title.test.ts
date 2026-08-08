import { describe, expect, it } from 'vitest'
import { hasLeadingH1, withExportTitle } from './export-title'

describe('withExportTitle', () => {
  it('uses frontmatter title over the filename, inserted after the frontmatter', () => {
    const body = '---\ntitle: Quarterly Report\n---\n\nThe body.\n'
    const out = withExportTitle(body, 'quarterly-report-draft')
    expect(out.title).toBe('Quarterly Report')
    expect(out.markdown).toBe('---\ntitle: Quarterly Report\n---\n# Quarterly Report\n\n\nThe body.\n')
  })

  it('falls back to the note title when frontmatter has none', () => {
    const out = withExportTitle('Just prose.\n', 'Meeting notes')
    expect(out.title).toBe('Meeting notes')
    expect(out.markdown.startsWith('# Meeting notes\n\n')).toBe(true)
  })

  it('a body that states its own H1 gets nothing added, whatever frontmatter says', () => {
    const body = '---\ntitle: Metadata Title\n---\n# The Real Title\n\nBody.\n'
    const out = withExportTitle(body, 'file-name')
    expect(out.markdown).toBe(body)
    // The document title still prefers the frontmatter statement.
    expect(out.title).toBe('Metadata Title')
  })

  it('escapes markdown specials in the title', () => {
    const out = withExportTitle('Body.\n', 'Costs *before* [rework]')
    expect(out.markdown.startsWith('# Costs \\*before\\* \\[rework\\]\n')).toBe(true)
    expect(out.title).toBe('Costs *before* [rework]')
  })

  it('survives CRLF frontmatter and quoted titles', () => {
    const body = '---\r\ntitle: "Signed: the team"\r\n---\r\nBody.\r\n'
    const out = withExportTitle(body, 'fallback')
    expect(out.title).toBe('Signed: the team')
    expect(out.markdown).toContain('# Signed\\: the team'.replace('\\:', ':'))
  })
})

describe('hasLeadingH1', () => {
  it('sees an H1 through frontmatter and blank lines', () => {
    expect(hasLeadingH1('---\na: b\n---\n\n\n# Title\n')).toBe(true)
  })

  it('does not mistake deeper headings, prose, or #tags for a title', () => {
    expect(hasLeadingH1('## Section\n')).toBe(false)
    expect(hasLeadingH1('plain text\n# later\n')).toBe(false)
    expect(hasLeadingH1('#tag on its own\n')).toBe(false)
  })
})
