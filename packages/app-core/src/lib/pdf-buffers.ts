/**
 * A tiny registry that lets the store's tab-close / window-close flow reach
 * into an open PdfView to ask "do you have unsaved highlights?" and, if so,
 * "save them". PdfView owns the PDFDocument and the save logic, but the close
 * actions live in the store; this module is the bridge between them, keyed by
 * the PDF's tab path (the same `path` closeTabInPane receives).
 */
export interface PdfBufferHandle {
  /** True when the open PDF has highlight edits not yet written to disk. */
  isDirty: () => boolean
  /** Persist the current highlights to the file. Resolves true on success. */
  save: () => Promise<boolean>
  /** Discard the pending edits without writing them — the "Don't Save"
   *  choice. Must clear whatever this handle considers "dirty" synchronously,
   *  so a discard can never be undone by something re-noticing the same
   *  edits a moment later (see `pdf-pending-edits.ts`, whose capture-on-
   *  unmount would otherwise re-stash exactly what the user just discarded). */
  discard: () => void
}

const registry = new Map<string, PdfBufferHandle>()

export function registerPdfBuffer(tabPath: string, handle: PdfBufferHandle): () => void {
  registry.set(tabPath, handle)
  return () => {
    if (registry.get(tabPath) === handle) registry.delete(tabPath)
  }
}

export function getPdfBuffer(tabPath: string): PdfBufferHandle | undefined {
  return registry.get(tabPath)
}

export function anyPdfBufferDirty(): boolean {
  for (const handle of registry.values()) {
    if (handle.isDirty()) return true
  }
  return false
}

/** Save every dirty PDF buffer (used by the quit guard's "Save" path).
 *  Resolves false if any save failed. */
export async function saveAllDirtyPdfBuffers(): Promise<boolean> {
  let allOk = true
  for (const handle of registry.values()) {
    if (handle.isDirty()) {
      const ok = await handle.save()
      if (!ok) allOk = false
    }
  }
  return allOk
}

/** Discard every dirty PDF buffer (the quit guard's "Don't Save" path). */
export function discardAllDirtyPdfBuffers(): void {
  for (const handle of registry.values()) {
    if (handle.isDirty()) handle.discard()
  }
}
