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
})

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
