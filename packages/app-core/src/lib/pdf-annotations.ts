/**
 * Annotation list for an open PDF: the data behind the annotations tab of the
 * outline panel, plus the geometry needed to recover each highlight's text.
 *
 * Two sources, deliberately kept separate because they never overlap:
 *
 *  - **Embedded** highlights, read once at load via `page.getAnnotations()`.
 *    These are whatever the file already contained, including highlights made
 *    in Preview or Acrobat.
 *  - **In-session** highlights, read from `pdfDocument.annotationStorage`.
 *    Saving writes bytes to disk without reloading the document, so a saved
 *    highlight stays in the storage and never appears in `getAnnotations()` —
 *    which is exactly why merging the two cannot double-count.
 *
 * PDF.js stores no text with a highlight (its serialized form is
 * annotationType/color/opacity/quadPoints/outlines/pageIndex/rect/rotation),
 * so the highlighted words are recovered here by intersecting the quad points
 * with the page's text items. That has the happy side effect of working
 * identically for highlights we did not create.
 */
import { useSyncExternalStore } from 'react'

/**
 * Subtypes worth listing: everything a person deliberately put on the page.
 * `Link` and `Widget` (form fields) are document structure rather than
 * annotation, and `Popup` is the floating note attached to another annotation,
 * so listing it would double every sticky note.
 */
const HIDDEN_SUBTYPES = new Set(['Link', 'Popup', 'Widget'])

/** Text markup, i.e. subtypes that carry quadPoints over words. */
const TEXT_MARKUP_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut'])

export function isListedSubtype(subtype: unknown): subtype is string {
  return typeof subtype === 'string' && subtype.length > 0 && !HIDDEN_SUBTYPES.has(subtype)
}

export function isTextMarkupSubtype(subtype: string): boolean {
  return TEXT_MARKUP_SUBTYPES.has(subtype)
}

/** Short human label for the row's type chip. */
export function annotationLabel(subtype: string): string {
  switch (subtype) {
    case 'Highlight':
      return 'Highlight'
    case 'Underline':
      return 'Underline'
    case 'StrikeOut':
      return 'Strikeout'
    case 'Squiggly':
      return 'Squiggly'
    case 'Text':
      return 'Note'
    case 'FreeText':
      return 'Text'
    case 'Square':
      return 'Rectangle'
    case 'Circle':
      return 'Ellipse'
    case 'PolyLine':
      return 'Polyline'
    case 'Ink':
      return 'Drawing'
    case 'FileAttachment':
      return 'Attachment'
    default:
      return subtype
  }
}

export interface PdfAnnotationEntry {
  /** Stable within one assembly pass; used as a React key only. */
  key: string
  /** 1-based, matching what the viewer and the user see. */
  pageNumber: number
  /** CSS colour for the swatch. */
  color: string
  /** PDF subtype, e.g. Highlight / Underline / Square. */
  subtype: string
  /** Text under a text-markup annotation, recovered from the page, or the
   *  author's note for a sticky/FreeText. Empty for shapes and for markup over
   *  a figure or a scanned page with no text layer. */
  text: string
  /** PDF-space bounding box [x1, y1, x2, y2], used to scroll to it. */
  rect: [number, number, number, number]
}

export interface PdfAnnotationsHandle {
  entries: PdfAnnotationEntry[]
  /** Scroll the owning viewer to this annotation. */
  goTo: (entry: PdfAnnotationEntry) => void
}

// --- geometry -------------------------------------------------------------

/** One quad as [x1,y1,x2,y2,x3,y3,x4,y4] corners, in PDF user space. */
export type Quad = number[]

/**
 * Normalise the several shapes PDF.js has used for quadPoints over the years:
 * a flat numeric array/Float32Array of 8-number groups, or an array of
 * `{x, y}` point objects. Returns one entry per quad (usually one per line of
 * highlighted text).
 */
export function normalizeQuadPoints(raw: unknown): Quad[] {
  if (!raw) return []
  const flat: number[] = []
  if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    flat.push(...Array.from(raw as unknown as ArrayLike<number>))
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'number') {
        flat.push(entry)
      } else if (entry && typeof entry === 'object') {
        const p = entry as { x?: unknown; y?: unknown }
        if (typeof p.x === 'number' && typeof p.y === 'number') flat.push(p.x, p.y)
      }
    }
  } else {
    return []
  }
  const quads: Quad[] = []
  for (let i = 0; i + 7 < flat.length; i += 8) quads.push(flat.slice(i, i + 8))
  return quads
}

/** Axis-aligned bounds of a set of quads, as [x1, y1, x2, y2]. */
export function quadsBounds(quads: Quad[]): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const quad of quads) {
    for (let i = 0; i + 1 < quad.length; i += 2) {
      minX = Math.min(minX, quad[i])
      maxX = Math.max(maxX, quad[i])
      minY = Math.min(minY, quad[i + 1])
      maxY = Math.max(maxY, quad[i + 1])
    }
  }
  if (minX === Infinity) return [0, 0, 0, 0]
  return [minX, minY, maxX, maxY]
}

/** A page text item reduced to what the overlap test needs. */
export interface TextBox {
  str: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * The covered part of one text item, clipped to the horizontal span
 * [`x1`, `x2`].
 *
 * A PDF text item is frequently a whole line rather than a word, so taking an
 * item wholesale whenever it overlaps returns the entire line for a selection
 * of three words in the middle of it. There are no per-glyph positions in
 * `getTextContent()`, so the covered characters are estimated by advancing
 * uniformly across the item's width. That is exact for monospace and close
 * enough for proportional text to land within a character or so; the
 * alternative (measuring glyphs in the DOM) would tie extraction to a rendered
 * text layer that may not exist for the page in question.
 */
export function clipItemText(item: TextBox, x1: number, x2: number): string {
  const itemRight = item.x + item.width
  // Zero-width items carry no advance to interpolate over, and would fail the
  // overlap test below on their own zero span; include them when they sit
  // inside the range at all.
  if (item.width <= 0) return item.x >= x1 && item.x <= x2 ? item.str : ''
  const start = Math.max(item.x, x1)
  const end = Math.min(itemRight, x2)
  if (end <= start) return ''
  // Fully covered: return it verbatim rather than risk a rounding artefact
  // trimming the first or last character.
  const epsilon = item.width * 0.02
  if (start <= item.x + epsilon && end >= itemRight - epsilon) return item.str
  const chars = item.str.length
  if (chars === 0) return ''
  const from = Math.round(((start - item.x) / item.width) * chars)
  const to = Math.round(((end - item.x) / item.width) * chars)
  return item.str.slice(Math.max(0, from), Math.min(chars, Math.max(from, to)))
}

/**
 * Text covered by `quads`, in reading order.
 *
 * Each quad is one highlighted line. An item is considered when its vertical
 * midpoint falls inside the quad — midpoint rather than full containment,
 * because quads track the text's em box, not its glyph extents, so ascenders
 * and descenders routinely poke outside — and is then clipped horizontally to
 * the quad, so a partial selection yields partial text.
 */
export function textInQuads(items: TextBox[], quads: Quad[]): string {
  const lines: string[] = []
  for (const quad of quads) {
    const [x1, y1, x2, y2] = quadsBounds([quad])
    const covered = items
      .filter((item) => {
        const midY = item.y + item.height / 2
        return midY >= y1 && midY <= y2
      })
      .sort((a, b) => a.x - b.x)
      .map((item) => clipItemText(item, x1, x2))
      .join('')
      .trim()
    if (covered) lines.push(covered)
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * PDF colour (0-255 triple, or an array-like) as a bare `r g b` triple, or null
 * when there is nothing usable. Separate from the CSS form because callers that
 * need to vary the alpha in CSS want the channels without a wrapper.
 */
export function pdfColorToRgbTriple(raw: unknown): string | null {
  if (!raw) return null
  const values = ArrayBuffer.isView(raw)
    ? Array.from(raw as unknown as ArrayLike<number>)
    : Array.isArray(raw)
      ? raw.filter((v): v is number => typeof v === 'number')
      : []
  if (values.length < 3) return null
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
  return `${clamp(values[0])} ${clamp(values[1])} ${clamp(values[2])}`
}

/** PDF colour (0-255 triple, or an array-like) to a CSS colour. */
export function pdfColorToCss(raw: unknown, fallback = '#ffd400'): string {
  const triple = pdfColorToRgbTriple(raw)
  return triple ? `rgb(${triple})` : fallback
}

// --- registry -------------------------------------------------------------

const registry = new Map<string, PdfAnnotationsHandle>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerPdfAnnotations(
  tabPath: string,
  handle: PdfAnnotationsHandle
): () => void {
  registry.set(tabPath, handle)
  notify()
  return () => {
    if (registry.get(tabPath) === handle) {
      registry.delete(tabPath)
      notify()
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePdfAnnotations(
  tabPath: string | null | undefined
): PdfAnnotationsHandle | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (tabPath ? registry.get(tabPath) : undefined),
    () => undefined
  )
}
