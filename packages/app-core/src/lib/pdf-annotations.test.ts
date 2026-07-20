import { describe, expect, it } from 'vitest'
import {
  annotationLabel,
  clipItemText,
  isListedSubtype,
  isTextMarkupSubtype,
  normalizeQuadPoints,
  pdfColorToCss,
  pdfColorToRgbTriple,
  quadsBounds,
  textInQuads,
  type TextBox
} from './pdf-annotations'

describe('normalizeQuadPoints', () => {
  it('groups a flat numeric array into 8-number quads', () => {
    const flat = [0, 0, 10, 0, 0, 5, 10, 5, 0, 10, 10, 10, 0, 15, 10, 15]
    expect(normalizeQuadPoints(flat)).toHaveLength(2)
  })

  it('accepts a Float32Array, which is what PDF.js hands back', () => {
    const quads = normalizeQuadPoints(new Float32Array([0, 0, 10, 0, 0, 5, 10, 5]))
    expect(quads).toEqual([[0, 0, 10, 0, 0, 5, 10, 5]])
  })

  it('accepts the older array-of-points shape', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 }
    ]
    expect(normalizeQuadPoints(points)).toEqual([[0, 0, 10, 0, 0, 5, 10, 5]])
  })

  it('drops a trailing partial quad rather than emitting a short one', () => {
    expect(normalizeQuadPoints([0, 0, 10, 0, 0, 5])).toEqual([])
  })

  it('is safe on null/garbage', () => {
    expect(normalizeQuadPoints(null)).toEqual([])
    expect(normalizeQuadPoints('nope')).toEqual([])
  })
})

describe('quadsBounds', () => {
  it('spans every quad', () => {
    expect(
      quadsBounds([
        [0, 0, 10, 0, 0, 5, 10, 5],
        [2, 10, 20, 10, 2, 15, 20, 15]
      ])
    ).toEqual([0, 0, 20, 15])
  })

  it('returns zeros for no quads instead of Infinity', () => {
    expect(quadsBounds([])).toEqual([0, 0, 0, 0])
  })
})

describe('textInQuads', () => {
  // One line of text at y 100..110, running x 0..100.
  const line = (str: string, x: number, width: number, y = 100): TextBox => ({
    str,
    x,
    y,
    width,
    height: 10
  })

  it('collects items covered by a quad, in reading order', () => {
    const items = [line('world', 50, 50), line('hello ', 0, 50)]
    const quad = [0, 100, 100, 100, 0, 110, 100, 110]
    expect(textInQuads(items, [quad])).toBe('hello world')
  })

  it('ignores items on other lines', () => {
    const items = [line('keep', 0, 50), line('drop', 0, 50, 200)]
    const quad = [0, 100, 100, 100, 0, 110, 100, 110]
    expect(textInQuads(items, [quad])).toBe('keep')
  })

  it('matches on the vertical midpoint, so ascenders do not exclude an item', () => {
    // Item pokes above the quad, as real glyph boxes do.
    const items = [{ str: 'tall', x: 0, y: 98, width: 40, height: 16 }]
    const quad = [0, 100, 100, 100, 0, 110, 100, 110]
    expect(textInQuads(items, [quad])).toBe('tall')
  })

  it('returns only the highlighted part when one item spans the whole line', () => {
    // The real-world shape: PDF text items are often a whole line, not words.
    // "the quick brown fox" over x 0..190 is 10 units per character.
    const items = [{ str: 'the quick brown fox', x: 0, y: 100, width: 190, height: 10 }]
    const quad = [40, 100, 90, 100, 40, 110, 90, 110]
    expect(textInQuads(items, [quad])).toBe('quick')
  })

  it('clips both ends of a line-spanning item', () => {
    const items = [{ str: 'alpha beta gamma delta', x: 0, y: 100, width: 220, height: 10 }]
    // Cover "beta gamma": characters 6..16 => x 60..160.
    const quad = [60, 100, 160, 100, 60, 110, 160, 110]
    expect(textInQuads(items, [quad])).toBe('beta gamma')
  })

  it('excludes an item that merely abuts the selection on the same line', () => {
    const items = [line('inside', 0, 40), line('outside', 60, 40)]
    // Quad covers only the first half of the line.
    const quad = [0, 100, 45, 100, 0, 110, 45, 110]
    expect(textInQuads(items, [quad])).toBe('inside')
  })

  it('joins multi-line selections into one string', () => {
    const items = [line('first', 0, 50), line('second', 0, 50, 80)]
    const quads = [
      [0, 100, 100, 100, 0, 110, 100, 110],
      [0, 80, 100, 80, 0, 90, 100, 90]
    ]
    expect(textInQuads(items, quads)).toBe('first second')
  })

  it('returns empty for a highlight over a figure (no text under it)', () => {
    const quad = [0, 500, 100, 500, 0, 510, 100, 510]
    expect(textInQuads([line('elsewhere', 0, 50)], [quad])).toBe('')
  })
})

describe('pdfColorToCss', () => {
  it('converts an RGB triple', () => {
    expect(pdfColorToCss([255, 212, 0])).toBe('rgb(255 212 0)')
  })

  it('accepts a Uint8ClampedArray', () => {
    expect(pdfColorToCss(new Uint8ClampedArray([0, 128, 255]))).toBe('rgb(0 128 255)')
  })

  it('clamps and rounds out-of-range values', () => {
    expect(pdfColorToCss([300, -5, 10.6])).toBe('rgb(255 0 11)')
  })

  it('falls back when the colour is missing or malformed', () => {
    expect(pdfColorToCss(null)).toBe('#ffd400')
    expect(pdfColorToCss([1, 2])).toBe('#ffd400')
  })
})

describe('isListedSubtype', () => {
  it('lists every markup type a person can leave on a page', () => {
    for (const subtype of [
      'Highlight',
      'Underline',
      'StrikeOut',
      'Squiggly',
      'Square',
      'Circle',
      'Ink',
      'Text',
      'FreeText',
      'Line',
      'Polygon'
    ]) {
      expect(isListedSubtype(subtype), subtype).toBe(true)
    }
  })

  it('hides document structure and duplicate popups', () => {
    // Link/Widget are structure, not annotation; Popup is the note attached to
    // another annotation and would double every sticky note.
    expect(isListedSubtype('Link')).toBe(false)
    expect(isListedSubtype('Widget')).toBe(false)
    expect(isListedSubtype('Popup')).toBe(false)
  })

  it('rejects missing or empty subtypes', () => {
    expect(isListedSubtype(undefined)).toBe(false)
    expect(isListedSubtype('')).toBe(false)
  })
})

describe('isTextMarkupSubtype', () => {
  it('is true only for the quadPoints-over-words types', () => {
    expect(isTextMarkupSubtype('Highlight')).toBe(true)
    expect(isTextMarkupSubtype('Underline')).toBe(true)
    expect(isTextMarkupSubtype('StrikeOut')).toBe(true)
    expect(isTextMarkupSubtype('Squiggly')).toBe(true)
    // Shapes and notes carry no text-covering quads.
    expect(isTextMarkupSubtype('Square')).toBe(false)
    expect(isTextMarkupSubtype('Text')).toBe(false)
  })
})

describe('annotationLabel', () => {
  it('uses names a reader recognises, not PDF spec names', () => {
    expect(annotationLabel('StrikeOut')).toBe('Strikeout')
    expect(annotationLabel('Square')).toBe('Rectangle')
    expect(annotationLabel('Circle')).toBe('Ellipse')
    expect(annotationLabel('Text')).toBe('Note')
    expect(annotationLabel('Ink')).toBe('Drawing')
  })

  it('falls back to the raw subtype for anything unmapped', () => {
    expect(annotationLabel('Redact')).toBe('Redact')
  })
})

describe('clipItemText', () => {
  const item = { str: 'the quick brown fox', x: 0, y: 0, width: 190, height: 10 }

  it('returns the whole string when fully covered', () => {
    expect(clipItemText(item, -10, 200)).toBe('the quick brown fox')
  })

  it('returns the whole string when covered within rounding tolerance', () => {
    // Quads sit a hair inside the glyph box in real files; that must not
    // shave off the first and last characters.
    expect(clipItemText(item, 1, 189)).toBe('the quick brown fox')
  })

  it('returns nothing when there is no overlap', () => {
    expect(clipItemText(item, 200, 300)).toBe('')
    expect(clipItemText(item, -50, -1)).toBe('')
  })

  it('clips a leading selection', () => {
    expect(clipItemText(item, 0, 30)).toBe('the')
  })

  it('clips a trailing selection', () => {
    expect(clipItemText(item, 160, 190)).toBe('fox')
  })

  it('treats a zero-width item as fully covered rather than dividing by zero', () => {
    expect(clipItemText({ str: 'x', x: 5, y: 0, width: 0, height: 10 }, 0, 10)).toBe('x')
  })

  it('is safe on an empty string', () => {
    expect(clipItemText({ str: '', x: 0, y: 0, width: 50, height: 10 }, 10, 20)).toBe('')
  })
})

describe('pdfColorToRgbTriple', () => {
  it('returns bare channels for CSS to add its own alpha to', () => {
    expect(pdfColorToRgbTriple([255, 212, 0])).toBe('255 212 0')
  })

  it('returns null (not a fallback colour) when unusable, so callers can tell', () => {
    expect(pdfColorToRgbTriple(null)).toBeNull()
    expect(pdfColorToRgbTriple([1, 2])).toBeNull()
  })
})
