import { describe, it, expect } from 'vitest'
import { parseEmbedSizeHint, resolveExcalidrawEmbedPath } from './excalidraw-preview'

describe('parseEmbedSizeHint', () => {
  it('parses a bare width', () => {
    expect(parseEmbedSizeHint('600')).toEqual({ width: 600, height: undefined })
  })

  it('parses width x height', () => {
    expect(parseEmbedSizeHint('600x400')).toEqual({ width: 600, height: 400 })
  })

  it('returns null for empty or undefined input', () => {
    expect(parseEmbedSizeHint(null)).toBeNull()
    expect(parseEmbedSizeHint(undefined)).toBeNull()
    expect(parseEmbedSizeHint('')).toBeNull()
  })

  it('returns null for non-numeric input', () => {
    expect(parseEmbedSizeHint('wide')).toBeNull()
    expect(parseEmbedSizeHint('abcx123')).toBeNull()
  })

  it('trims whitespace before matching', () => {
    expect(parseEmbedSizeHint('  800  ')).toEqual({ width: 800, height: undefined })
  })

  it('rejects zero dimensions instead of half-applying them', () => {
    // `|0x300` used to eat the caption, skip the falsy width downstream, and
    // set only the height, distorting the image.
    expect(parseEmbedSizeHint('0')).toBeNull()
    expect(parseEmbedSizeHint('0x300')).toBeNull()
    expect(parseEmbedSizeHint('300x0')).toBeNull()
  })
})

// splitEmbedLabel (#570) is not carried here — parseImageEmbedLabel in
// embed-size.ts is this fork's equivalent (see excalidraw-preview.ts), with
// its own coverage in embed-size.test.ts.

describe('resolveExcalidrawEmbedPath', () => {
  const notes = [
    'inbox/My Drawing.excalidraw',
    'Drawings/Architecture.excalidraw',
    'refs/Obsidian Drawing.excalidraw.md',
    'inbox/notes.md'
  ]

  it('finds an exact path match', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'inbox/My Drawing.excalidraw')).toBe(
      'inbox/My Drawing.excalidraw'
    )
  })

  it('resolves by suffix when the full path is given', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'Drawings/Architecture.excalidraw')).toBe(
      'Drawings/Architecture.excalidraw'
    )
  })

  it('resolves a bare filename to its full path', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'My Drawing.excalidraw')).toBe(
      'inbox/My Drawing.excalidraw'
    )
  })

  it('resolves by title without extension', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'Architecture')).toBe(
      'Drawings/Architecture.excalidraw'
    )
  })

  it('resolves Obsidian .excalidraw.md files', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'Obsidian Drawing.excalidraw.md')).toBe(
      'refs/Obsidian Drawing.excalidraw.md'
    )
  })

  it('returns null for an empty target', () => {
    expect(resolveExcalidrawEmbedPath(notes, '')).toBeNull()
    expect(resolveExcalidrawEmbedPath(notes, '  ')).toBeNull()
  })

  it('returns null when no match exists', () => {
    expect(resolveExcalidrawEmbedPath(notes, 'nonexistent.excalidraw')).toBeNull()
  })
})
