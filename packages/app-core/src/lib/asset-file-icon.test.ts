import { describe, expect, it } from 'vitest'
import { assetFileIcon, parseExtSet } from './local-assets'

describe('assetFileIcon', () => {
  it('maps documents (pages, sheets, slides, prose) to the document glyph', () => {
    for (const name of [
      'a.pdf', 'a.doc', 'a.docx', 'a.xls', 'a.xlsx',
      'a.ppt', 'a.pptx', 'deck.key', 'notes.txt', 'readme.text'
    ]) {
      expect(assetFileIcon(name), name).toBe('document')
    }
  })

  it('maps mainstream images plus Photoshop/Affinity to the image glyph', () => {
    for (const name of [
      'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg',
      'a.bmp', 'a.tiff', 'a.heic', 'a.avif', 'design.psd', 'poster.af'
    ]) {
      expect(assetFileIcon(name), name).toBe('image')
    }
  })

  it('falls back to attachment for anything else', () => {
    for (const name of ['a.zip', 'a.mp4', 'a.mp3', 'data.csv', 'noext', 'archive.tar.gz']) {
      expect(assetFileIcon(name), name).toBe('attachment')
    }
  })

  it('is case-insensitive and works on full paths', () => {
    expect(assetFileIcon('inbox/Reports/Q3.PDF')).toBe('document')
    expect(assetFileIcon('/abs/path/PHOTO.JPG')).toBe('image')
  })

  it('treats a leading-dot dotfile as having no extension', () => {
    expect(assetFileIcon('.gitignore')).toBe('attachment')
  })
})

describe('parseExtSet', () => {
  it('splits on commas and whitespace, lowercases, strips dots', () => {
    expect([...parseExtSet('PDF, .Doc  docx')].sort()).toEqual(['doc', 'docx', 'pdf'])
  })

  it('ignores empties and returns a cached instance for the same string', () => {
    const a = parseExtSet('png, , jpg')
    expect([...a].sort()).toEqual(['jpg', 'png'])
    expect(parseExtSet('png, , jpg')).toBe(a)
  })
})

describe('assetFileIcon with custom sets', () => {
  it('honours user-provided extension sets over the built-ins', () => {
    const docs = parseExtSet('md, org')
    const imgs = parseExtSet('raw')
    expect(assetFileIcon('note.md', docs, imgs)).toBe('document')
    expect(assetFileIcon('shot.raw', docs, imgs)).toBe('image')
    // pdf is a built-in document, but not in this custom doc set → attachment
    expect(assetFileIcon('paper.pdf', docs, imgs)).toBe('attachment')
  })
})
