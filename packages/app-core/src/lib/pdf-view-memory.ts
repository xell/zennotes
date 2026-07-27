/**
 * Per-tab view memory for the PDF viewer.
 *
 * An asset tab renders only while it is the active tab, so switching to a note
 * and back unmounts `PdfView` entirely: the `PDFDocument` is destroyed and every
 * piece of viewer state (page, scroll offset, page layout, zoom, reading mode)
 * is local React state that resets to its default. A long document therefore
 * snapped back to page 1, single-column, Fit Width, light — the reader lost
 * their place and their layout on every glance at a note.
 *
 * This is the same treatment note tabs get from `tab-scroll-memory` and the
 * media player gets from `media-playback-memory`: a small imperative cache,
 * read on mount and written on unmount, that never triggers a React update.
 * Entries are capped with simple LRU eviction so long sessions don't grow it
 * without bound. Session-only, like both siblings — it doesn't survive an app
 * restart, and it deliberately doesn't touch the vault or the config file.
 *
 * Keyed by the host's `tabPath`, not the asset path, because the pinned
 * reference pane already keys its own registries as `pinned:<path>` so a PDF
 * that is both pinned and open in a tab stays two independent views. Using the
 * same key here gives each of them its own remembered position for free, rather
 * than having the two fight over one entry.
 *
 * A rename or move of the underlying PDF strands that tab's entry (nothing
 * remaps these session caches — neither sibling is remapped either). The cost
 * is one lost scroll position, since a missing entry simply means "open at the
 * defaults", so it self-heals; see the path-remap drift table in
 * `data/full-manual-reorder.md` for the projections where staleness matters.
 */

/** Standard viewer page-layout modes, each a scrollMode + spreadMode pair. */
export type PdfViewMode = 'single' | 'continuous' | 'two-page'

/**
 * `light` is the untouched page. `dark` uses PDF.js's render-time `pageColors`,
 * which recolours the default page background and default (black) text during
 * rasterisation while leaving embedded raster images intact. `sepia` is the same
 * mechanism — a warm paper/ink pair handed to `pageColors` — so it likewise
 * leaves embedded images untouched; its warmth is user-tunable (`pdfSepiaTone`).
 * `invert` is the coarse CSS-filter fallback (it negates images too), for
 * documents whose colour `pageColors` alone cannot theme.
 */
export type PdfReadingMode = 'light' | 'sepia' | 'dark' | 'invert'

export interface PdfViewPosition {
  /** 1-based page number the viewer was showing. */
  page: number
  scrollTop: number
  scrollLeft: number
  viewMode: PdfViewMode
  /** A `currentScaleValue`: a fit preset ('page-width') or a numeric string. */
  scaleValue: string
  readingMode: PdfReadingMode
}

const PDF_VIEW_MEMORY_LIMIT = 20
const memory = new Map<string, PdfViewPosition>()

export function rememberPdfView(tabPath: string, position: PdfViewPosition): void {
  if (!tabPath) return
  // Re-insert so the most recently touched entry is last (LRU ordering).
  memory.delete(tabPath)
  memory.set(tabPath, position)
  while (memory.size > PDF_VIEW_MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function recallPdfView(tabPath: string): PdfViewPosition | undefined {
  return memory.get(tabPath)
}

export function forgetPdfView(tabPath: string): void {
  memory.delete(tabPath)
}

/** Test-only: drop all remembered positions. */
export function clearPdfViewMemory(): void {
  memory.clear()
}
