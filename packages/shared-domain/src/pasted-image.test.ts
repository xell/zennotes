import { describe, expect, it } from 'vitest'
import { pastedImageFilename } from './pasted-image'

const at = new Date(2026, 7, 6, 9, 5, 3)

describe('pastedImageFilename', () => {
  it('falls back to the timestamped name when nothing is suggested', () => {
    expect(pastedImageFilename({ mimeType: 'image/png' }, at)).toBe(
      'Pasted Image 2026-08-06 090503.png'
    )
  })

  it('keeps a clean suggested name and its image extension', () => {
    expect(
      pastedImageFilename({ mimeType: 'image/png', suggestedName: 'diagram.webp' }, at)
    ).toBe('diagram.webp')
  })

  it('scrubs the characters that break a wikilink embed', () => {
    // [ ] and # survive the server's own filename cleaning, and a raw
    // "![[assets/diagram [v2] #3.png]]" renders as a broken embed.
    expect(
      pastedImageFilename({ mimeType: 'image/png', suggestedName: 'diagram [v2] #3.png' }, at)
    ).toBe('diagram -v2- -3.png')
  })

  it('derives the extension from the mime type when the name has none', () => {
    expect(
      pastedImageFilename({ mimeType: 'image/webp', suggestedName: 'shot' }, at)
    ).toBe('shot.webp')
  })

  it('drops path components from the suggested name', () => {
    expect(
      pastedImageFilename({ mimeType: 'image/png', suggestedName: '../secrets/pic.png' }, at)
    ).toBe('pic.png')
  })

  it('rejects non-image clipboard items', () => {
    expect(() => pastedImageFilename({ mimeType: 'application/pdf' }, at)).toThrow()
  })
})
