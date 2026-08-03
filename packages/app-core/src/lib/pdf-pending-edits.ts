/**
 * Carries a PDF's unsaved highlights across a tab switch, keyed by `tabPath`.
 *
 * An asset tab renders only while it is the active tab, so switching away
 * unmounts `PdfView`, and the document it held has to be destroyed with it —
 * `annotationStorage`, and every pending highlight editor PDF.js paints from
 * it, belong to that one `PDFViewer` instance and cannot survive a rebuild.
 * (A first attempt at this fix tried keeping the `PDFDocumentProxy` itself
 * alive across the unmount instead. The data survived — Save and Revert kept
 * working — but the highlight still vanished visually, because painting an
 * *unsaved* highlight is done by live editor objects owned by the old
 * `AnnotationEditorLayer`/`AnnotationEditorUIManager`, not by the document,
 * and a fresh viewer never rehydrates those from `annotationStorage` outside
 * of explicitly re-arming the highlight tool. Keeping the document alive
 * fixed the dirty flag and hid the actual loss.)
 *
 * So instead of preserving the live objects, this preserves what `Save`
 * already produces: on unmount, if the document is dirty, `saveDocument()`
 * is called to flatten the pending edits into real, ordinary page
 * annotations — the same bytes Save would otherwise write to disk — and
 * those bytes are kept here instead. Reopening a tab checks this cache
 * before fetching: if present, PDF.js parses those bytes instead of the
 * file on disk, and the highlight comes back through the *ordinary*
 * annotation layer (the one that renders any PDF's pre-existing highlights),
 * which needs no editor rehydration and works on a brand-new viewer exactly
 * as well as it does on the original one. The document still opens dirty —
 * the real file on disk does not have this content yet — so Save and Revert
 * keep meaning what they say.
 *
 * Every entry here is, by construction, unsaved work: there is no LRU cap.
 * Capping it would mean silently discarding a highlight because too many
 * *other* PDFs also happen to have one pending, which is the exact failure
 * this module exists to prevent. The cost is bounded naturally instead, by
 * how many PDFs a person can realistically be mid-editing at once.
 *
 * Registers a `PdfBufferHandle` for as long as an entry exists, so the
 * close-tab guard (`store.ts`) and the quit guard (`App.tsx`) can save or
 * discard a dirty PDF sitting in a background tab without it ever having
 * been remounted.
 */

import { registerPdfBuffer, type PdfBufferHandle } from './pdf-buffers'

interface PendingPdfEdit {
  assetUrl: string
  assetPath: string
  bytes: Uint8Array
  unregister: () => void
}

const pending = new Map<string, PendingPdfEdit>()

async function saveEntry(tabPath: string): Promise<boolean> {
  const entry = pending.get(tabPath)
  if (!entry) return false
  try {
    const ok = await window.zen.savePdf(entry.assetPath, entry.bytes)
    if (ok) clearPendingPdfEdit(tabPath)
    return ok
  } catch (err) {
    console.error('pdf-pending-edits: save failed', err)
    return false
  }
}

function makeHandle(tabPath: string): PdfBufferHandle {
  return {
    isDirty: () => pending.has(tabPath),
    save: () => saveEntry(tabPath),
    discard: () => clearPendingPdfEdit(tabPath)
  }
}

/** Returns the pending bytes for this tab, if any and if they are still for
 *  the same asset. Does not consume them — the caller clears the entry only
 *  once it has actually opened them successfully. */
export function getPendingPdfBytes(tabPath: string, assetUrl: string): Uint8Array | undefined {
  const entry = pending.get(tabPath)
  return entry && entry.assetUrl === assetUrl ? entry.bytes : undefined
}

/** Stash a document's flattened edits, captured at unmount. Replaces
 *  whatever was pending for this tab before. */
export function setPendingPdfEdit(
  tabPath: string,
  assetUrl: string,
  assetPath: string,
  bytes: Uint8Array
): void {
  pending.get(tabPath)?.unregister()
  pending.set(tabPath, { assetUrl, assetPath, bytes, unregister: registerPdfBuffer(tabPath, makeHandle(tabPath)) })
}

/** Drop a tab's pending edit without writing it — used once the bytes have
 *  been consumed back into a live document, by Revert to discard them, by a
 *  successful save, and by a deliberate "Don't Save" close. */
export function clearPendingPdfEdit(tabPath: string): void {
  pending.get(tabPath)?.unregister()
  pending.delete(tabPath)
}
