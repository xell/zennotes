// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  clipboardHasPastableText,
  isClipboardImageFile,
  pastedImageInputFromFile
} from './editor-paste-images'

/** Minimal DataTransfer stand-in: only `getData` matters to the predicate. */
function clipboard(data: Record<string, string>): DataTransfer {
  return { getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer
}

describe('editor paste images', () => {
  it('recognizes clipboard image files by MIME type or image extension', () => {
    expect(isClipboardImageFile(new File(['x'], 'clip', { type: 'image/png' }))).toBe(true)
    expect(isClipboardImageFile(new File(['x'], 'Screenshot.webp', { type: '' }))).toBe(true)
    expect(isClipboardImageFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBe(false)
  })

  it('converts a pasted image file into a bridge payload', async () => {
    const file = new File([Uint8Array.from([1, 2, 3])], 'clip.png', { type: 'image/png' })

    const input = await pastedImageInputFromFile(file)

    expect(input.mimeType).toBe('image/png')
    expect(input.suggestedName).toBe('clip.png')
    expect([...new Uint8Array(input.data)]).toEqual([1, 2, 3])
  })

  // Word/Pages/Excel attach a bitmap of the selection next to the text, so an
  // image-first paste handler pasted a picture of the text instead (see
  // clipboardHasPastableText). These three cases are the whole contract.
  describe('clipboardHasPastableText', () => {
    it('prefers text for a Word copy, which carries text AND a bitmap', () => {
      expect(
        clipboardHasPastableText(
          clipboard({
            'text/plain': 'National Top-Tier Online Course (MOOC) Finalist',
            'text/html': '<p class=MsoNormal><i>National Top-Tier Online Course</i></p>'
          })
        )
      ).toBe(true)
    })

    it('leaves a screenshot alone — no text flavour at all', () => {
      expect(clipboardHasPastableText(clipboard({}))).toBe(false)
    })

    it('leaves a browser image copy alone — HTML img tag, but empty plain text', () => {
      // Keying on text/html instead would break this case, which is the one
      // where pasting as an image is actually what the user wants.
      expect(
        clipboardHasPastableText(
          clipboard({ 'text/html': '<img src="https://example.com/cat.png">', 'text/plain': '' })
        )
      ).toBe(false)
    })

    it('treats whitespace-only text as no text', () => {
      expect(clipboardHasPastableText(clipboard({ 'text/plain': '   \n  ' }))).toBe(false)
    })

    it('handles a null clipboard', () => {
      expect(clipboardHasPastableText(null)).toBe(false)
    })
  })
})
