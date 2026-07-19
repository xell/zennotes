/**
 * The PDF highlight palette, in one place.
 *
 * It was previously written out three times: the option string handed to
 * PDF.js's viewer, the list the colour picker renders, and the validator that
 * guards the stored preference — so adding or changing a colour meant editing
 * all three, and missing one would silently normalise the new colour away as
 * invalid. Everything here derives from `PDF_HIGHLIGHT_COLORS_OPTION`.
 *
 * The value is PDF.js's own shipped default for `highlightEditorColors`,
 * verbatim. Passing *some* palette is not optional: without it the annotation
 * editor's `highlightColorNames` map is null and reopening a saved highlight
 * throws inside PDF.js. It is a plain `name=hex,...` string with no fixed
 * length, so extra colours can simply be added below.
 */

export const PDF_HIGHLIGHT_COLORS_OPTION =
  'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F'

export interface PdfHighlightColor {
  /** PDF.js's own key for the colour. */
  name: string
  /** Capitalised for display. */
  label: string
  /** Upper-case hex, the form stored in preferences. */
  hex: string
}

export const PDF_HIGHLIGHT_PALETTE: PdfHighlightColor[] = PDF_HIGHLIGHT_COLORS_OPTION.split(',')
  .map((entry) => {
    const [name, hex] = entry.split('=')
    return {
      name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      hex: (hex ?? '').toUpperCase()
    }
  })
  .filter((colour) => !!colour.name && !!colour.hex)

export const DEFAULT_PDF_HIGHLIGHT_COLOR = PDF_HIGHLIGHT_PALETTE[0].hex

/** Clamp a stored/hand-edited value to the palette, so the config cannot ask
 *  for a colour the picker has no way to show or undo. */
export function normalizePdfHighlightColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PDF_HIGHLIGHT_COLOR
  const upper = value.toUpperCase()
  return PDF_HIGHLIGHT_PALETTE.some((colour) => colour.hex === upper)
    ? upper
    : DEFAULT_PDF_HIGHLIGHT_COLOR
}
