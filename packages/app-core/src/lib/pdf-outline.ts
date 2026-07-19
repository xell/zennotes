/**
 * Bridge between an open PdfView (which owns the PDFDocument and the link
 * service that resolves destinations) and the outline panel rendered by
 * EditorPane alongside it. Keyed by the PDF's tab path, mirroring
 * `pdf-buffers.ts`.
 *
 * PDF.js ships no outline UI we can use: `PDFOutlineViewer` lives in the full
 * viewer application, which `pdfjs-dist` does not distribute (its `web/` holds
 * only `pdf_viewer.mjs` + css). What it does give us is the data —
 * `pdfDocument.getOutline()` — and `PDFLinkService.goToDestination()` to act on
 * it, which is the part that would actually be tedious to reimplement.
 */
import { useSyncExternalStore } from 'react'

export interface PdfOutlineItem {
  title: string
  bold: boolean
  italic: boolean
  /** Nested entries; PDF outlines are arbitrarily deep. */
  items: PdfOutlineItem[]
  /** Opaque PDF.js destination, handed straight back to the link service. */
  dest: unknown
  /** External link, used by entries that point outside the document instead
   *  of at a page. Mutually exclusive with a useful `dest` in practice. */
  url: string | null
}

export interface PdfOutlineHandle {
  /** Empty when the document has no embedded outline (most scanned PDFs). */
  items: PdfOutlineItem[]
  /** Navigate the owning viewer to this entry. */
  goTo: (item: PdfOutlineItem) => void
}

const registry = new Map<string, PdfOutlineHandle>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerPdfOutline(tabPath: string, handle: PdfOutlineHandle): () => void {
  registry.set(tabPath, handle)
  notify()
  return () => {
    if (registry.get(tabPath) === handle) {
      registry.delete(tabPath)
      notify()
    }
  }
}

export function getPdfOutline(tabPath: string | null | undefined): PdfOutlineHandle | undefined {
  return tabPath ? registry.get(tabPath) : undefined
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The outline for `tabPath`, re-rendering when the PDF finishes loading and
 * registers one (the document is parsed asynchronously, so the panel is
 * mounted before the outline exists).
 */
export function usePdfOutline(tabPath: string | null | undefined): PdfOutlineHandle | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (tabPath ? registry.get(tabPath) : undefined),
    () => undefined
  )
}
