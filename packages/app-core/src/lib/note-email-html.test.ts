import { describe, expect, it } from 'vitest'
import { renderNoteEmailHtml } from './note-email-html'

describe('renderNoteEmailHtml', () => {
  it('states the title and styles headings inline', () => {
    const { html, title } = renderNoteEmailHtml('---\ntitle: Weekly Update\n---\n\nHello.\n', 'file')
    expect(title).toBe('Weekly Update')
    expect(html).toContain('<h1 style="')
    expect(html).toContain('Weekly Update')
  })

  it('styles tables cell by cell, since mail clients drop classes', () => {
    const { html } = renderNoteEmailHtml('| a | b |\n| - | - |\n| 1 | 2 |\n', 'T')
    expect(html).toContain('<table style="border-collapse:collapse')
    expect(html).toContain('<th style="border:1px solid')
    expect(html).toContain('<td style="border:1px solid')
  })

  it('keeps inline code and code fences readable without app CSS', () => {
    const { html } = renderNoteEmailHtml('Use `zn open` here.\n\n```sh\necho hi\n```\n', 'T')
    expect(html).toMatch(/<code style="[^"]*ui-monospace/)
    expect(html).toContain('<pre style="')
  })

  it('degrades images to their alt text and checkboxes to glyphs', () => {
    const { html } = renderNoteEmailHtml('![the chart](a.png)\n\n- [x] done\n- [ ] open\n', 'T')
    expect(html).toContain('<em>[the chart]</em>')
    expect(html).not.toContain('<img')
    expect(html).toContain('☒')
    expect(html).toContain('☐')
    expect(html).not.toContain('<input')
  })

  it('a body with its own H1 is not doubled', () => {
    const { html } = renderNoteEmailHtml('# Already Titled\n\nBody.\n', 'file-name')
    expect(html.match(/<h1/g)).toHaveLength(1)
  })
})
