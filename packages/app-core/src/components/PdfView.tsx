import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// The prebuilt viewer components wire canvas + text layer + annotation
// editor layer together through an EventBus and UI manager. We use them
// (rather than rendering pages by hand) specifically because the highlight
// tool lives in the AnnotationEditorLayer, which the manager owns. See
// data/pdf.md.
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
// Vite `?url` import — the worker ships as a separate ESM file PDF.js runs
// off the main thread. `vite/client` (app-core tsconfig `types`) provides
// the `*?url` module declaration.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { registerPdfBuffer } from '../lib/pdf-buffers'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// `light` is the untouched page. `dark` uses PDF.js's render-time
// `pageColors`, which recolours the default page background and default
// (black) text during rasterisation while leaving embedded raster images
// intact. `invert` is the coarse CSS-filter fallback (also negates images),
// for documents whose colour cannot be themed by `pageColors` alone.
export type PdfReadingMode = 'light' | 'dark' | 'invert'

const DARK_PAGE_COLORS = { background: '#1f1f22', foreground: '#d6d3cc' } as const
const MIN_SCALE = 0.4
const MAX_SCALE = 4

// The highlight editor's colour palette. This MUST be provided: without it the
// UI manager's `highlightColorNames` map is null, and rebuilding a saved
// highlight on reopen throws in the telemetry getter (highlightColorNames.get).
// These are PDF.js's own default highlight colours.
const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F'

export function PdfView({
  assetUrl,
  assetPath,
  tabPath,
  title
}: {
  assetUrl: string
  /** Vault-relative path of the PDF, used to save bytes back to the file. */
  assetPath: string
  /** The tab's path — the key the close guard looks this buffer up under. */
  tabPath: string
  title: string
}): JSX.Element {
  // The scrollable, absolutely-positioned host PDFViewer requires.
  const containerRef = useRef<HTMLDivElement>(null)
  // The inner `.pdfViewer` element the pages mount into.
  const viewerElRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [mode, setMode] = useState<PdfReadingMode>('light')
  const [highlightOn, setHighlightOn] = useState(false)
  const [numPages, setNumPages] = useState(0)
  const [scalePct, setScalePct] = useState(100)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Read synchronously by the close guard, so it stays a ref (not just state).
  const dirtyRef = useRef(false)
  // Annotation-storage size at the last save (or load) — the clean baseline
  // the current size is compared against to derive dirtiness.
  const savedSizeRef = useRef(0)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)

  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value
    setDirty(value)
  }, [])

  const pageColors = mode === 'dark' ? DARK_PAGE_COLORS : undefined
  // `dark` renders differently (pageColors), so the viewer is rebuilt when
  // toggling into/out of dark. `invert` is pure CSS, so it shares the light
  // build — this key drives the rebuild effect below.
  const buildKey = mode === 'dark' ? 'dark' : 'light'

  // Fetch bytes and open the document. The custom `zen-asset://` protocol
  // may not honour range requests, so we hand PDF.js the whole buffer.
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMessage(null)
    setPdfDoc(null)

    void (async () => {
      try {
        const response = await fetch(assetUrl)
        if (!response.ok) throw new Error(`Failed to load PDF (${response.status})`)
        const data = new Uint8Array(await response.arrayBuffer())
        if (cancelled) return
        // ERRORS-only verbosity silences benign per-font worker warnings
        // ("TT: undefined function", unsupported hinting ops, etc.) that don't
        // affect rendering, while still surfacing real errors.
        const doc = await pdfjs.getDocument({ data, verbosity: pdfjs.VerbosityLevel.ERRORS })
          .promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        pdfDocRef.current = doc
        savedSizeRef.current = doc.annotationStorage.size
        markDirty(false)
        setNumPages(doc.numPages)
        setPdfDoc(doc)
      } catch (err) {
        if (cancelled) return
        console.error('PdfView: failed to load document', err)
        setErrorMessage(err instanceof Error ? err.message : 'Could not open this PDF.')
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [assetUrl])

  // Destroy the document when it is replaced or the view unmounts.
  useEffect(() => {
    return () => {
      if (pdfDoc) void pdfDoc.destroy()
    }
  }, [pdfDoc])

  // Build (or rebuild) the PDFViewer for the current document and dark-ness.
  useEffect(() => {
    const container = containerRef.current
    const viewerEl = viewerElRef.current
    if (!pdfDoc || !container || !viewerEl) return

    // Preserve scroll across a dark-toggle rebuild.
    const prevTop = container.scrollTop
    const prevLeft = container.scrollLeft

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    let viewer: PDFViewer
    try {
      viewer = new PDFViewer({
        container,
        viewer: viewerEl,
        eventBus,
        linkService,
        // NONE (not DISABLE) initialises the annotation editor infrastructure
        // so the highlight tool can be switched on later.
        annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
        annotationEditorHighlightColors: HIGHLIGHT_COLORS,
        ...(pageColors ? { pageColors } : {})
      })
    } catch (err) {
      console.error('PdfView: PDFViewer construction failed', err)
      setErrorMessage('Viewer failed to initialise.')
      setStatus('error')
      return
    }
    linkService.setViewer(viewer)
    viewerRef.current = viewer

    const onPagesInit = (): void => {
      viewer.currentScaleValue = 'page-width'
      container.scrollTop = prevTop
      container.scrollLeft = prevLeft
      setStatus('ready')
      console.log('PdfView: pages initialised', { numPages: pdfDoc.numPages })
    }
    const onScaleChanging = (): void => {
      setScalePct(Math.round((viewer.currentScale || 1) * 100))
    }
    // Highlights add/remove entries in the document's annotationStorage. Any
    // editor-state change recomputes dirtiness against the last-saved size.
    const onEditorStateChanged = (): void => {
      const size = pdfDoc.annotationStorage.size
      markDirty(size !== savedSizeRef.current)
    }
    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('scalechanging', onScaleChanging)
    eventBus.on('annotationeditorstateschanged', onEditorStateChanged)

    try {
      viewer.setDocument(pdfDoc)
      linkService.setDocument(pdfDoc, null)
    } catch (err) {
      console.error('PdfView: setDocument failed', err)
      setErrorMessage('Failed to display this PDF.')
      setStatus('error')
    }

    return () => {
      eventBus.off('pagesinit', onPagesInit)
      eventBus.off('scalechanging', onScaleChanging)
      eventBus.off('annotationeditorstateschanged', onEditorStateChanged)
      try {
        viewer.setDocument(null as unknown as PDFDocumentProxy)
      } catch {
        /* viewer already torn down */
      }
      viewerRef.current = null
    }
  }, [pdfDoc, buildKey, pageColors, markDirty])

  // Toggle the highlight authoring tool on the live viewer.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || status !== 'ready') return
    try {
      viewer.annotationEditorMode = {
        mode: highlightOn ? pdfjs.AnnotationEditorType.HIGHLIGHT : pdfjs.AnnotationEditorType.NONE
      }
    } catch (err) {
      console.error('PdfView: failed to set annotation editor mode', err)
    }
  }, [highlightOn, status])

  const zoomIn = useCallback(() => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.min(MAX_SCALE, v.currentScale * 1.15)
  }, [])
  const zoomOut = useCallback(() => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.max(MIN_SCALE, v.currentScale / 1.15)
  }, [])
  const zoomReset = useCallback(() => {
    const v = viewerRef.current
    if (v) v.currentScaleValue = 'page-width'
  }, [])

  // Save highlights straight back into the .pdf file. saveDocument() writes
  // them as standard /Highlight annotation objects, and the main process
  // overwrites the file atomically. On reopen PDF.js loads them natively —
  // no sidecar, no re-injection. Resolves true on success.
  const saveNow = useCallback(async (): Promise<boolean> => {
    const doc = pdfDocRef.current
    if (!doc) return false
    setSaving(true)
    try {
      const bytes = await doc.saveDocument()
      const ok = await window.zen.savePdf(assetPath, bytes)
      if (ok) {
        savedSizeRef.current = doc.annotationStorage.size
        markDirty(false)
      }
      return ok
    } catch (err) {
      console.error('PdfView: save failed', err)
      return false
    } finally {
      setSaving(false)
    }
  }, [assetPath, markDirty])

  // Expose dirty state + save to the store's close guard, keyed by tab path.
  useEffect(() => {
    return registerPdfBuffer(tabPath, {
      isDirty: () => dirtyRef.current,
      save: saveNow
    })
  }, [tabPath, saveNow])

  const modeLabel = useMemo<Record<PdfReadingMode, string>>(
    () => ({ light: 'Light', dark: 'Dark', invert: 'Invert' }),
    []
  )

  return (
    <div className="zen-pdf flex min-h-0 min-w-0 flex-1 flex-col bg-paper-100/40">
      <div className="zen-pdf-toolbar flex h-9 shrink-0 items-center gap-2 border-b border-paper-300/70 px-3 text-xs text-ink-700">
        <span className="zen-pdf-pagecount tabular-nums text-ink-500">
          {numPages > 0 ? `${numPages} page${numPages === 1 ? '' : 's'}` : ''}
        </span>

        <button
          type="button"
          className={`zen-pdf-btn ${highlightOn ? 'zen-pdf-btn-active' : ''}`}
          aria-pressed={highlightOn}
          onClick={() => setHighlightOn((v) => !v)}
          title="Highlight text (select to highlight)"
        >
          Highlight
        </button>
        <button
          type="button"
          className={`zen-pdf-btn ${dirty ? 'zen-pdf-btn-active' : ''}`}
          onClick={() => void saveNow()}
          disabled={!dirty || saving}
          title={dirty ? 'Save highlights to the PDF' : 'No unsaved changes'}
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>

        <div className="zen-pdf-zoom ml-auto flex items-center gap-1">
          <button type="button" className="zen-pdf-btn" onClick={zoomOut} title="Zoom out">
            −
          </button>
          <button
            type="button"
            className="zen-pdf-btn zen-pdf-zoom-level tabular-nums"
            onClick={zoomReset}
            title="Fit width"
          >
            {scalePct}%
          </button>
          <button type="button" className="zen-pdf-btn" onClick={zoomIn} title="Zoom in">
            +
          </button>
        </div>

        <div className="zen-pdf-modes flex items-center gap-1">
          {(['light', 'dark', 'invert'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`zen-pdf-btn ${mode === m ? 'zen-pdf-btn-active' : ''}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              title={`${modeLabel[m]} reading mode`}
            >
              {modeLabel[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="zen-pdf-viewport relative min-h-0 min-w-0 flex-1">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-ink-400">
            Loading {title}…
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-6 text-center text-sm text-ink-400">
            {errorMessage ?? 'Could not open this PDF.'}
          </div>
        )}
        {/* PDFViewer requires an absolutely-positioned, scrollable container
            wrapping a `.pdfViewer` element. */}
        <div
          ref={containerRef}
          className={`zen-pdf-container absolute inset-0 overflow-auto ${
            mode === 'light' ? '' : 'zen-pdf-scroll-dark'
          }`}
        >
          <div ref={viewerElRef} className={`pdfViewer ${mode === 'invert' ? 'zen-pdf-invert' : ''}`} />
        </div>
      </div>
    </div>
  )
}
