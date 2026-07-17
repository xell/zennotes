import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// The prebuilt viewer components wire canvas + text layer + annotation
// editor layer together through an EventBus and UI manager. They also
// implement the standard viewer engine (zoom/fit, page navigation, scroll +
// spread modes, and full-text search via PDFFindController) — the toolbar
// below is just thin controls over these built-in capabilities. See
// data/pdf.md.
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode
} from 'pdfjs-dist/web/pdf_viewer.mjs'
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
// Standard viewer page-layout modes, each a scrollMode + spreadMode pair.
type PdfViewMode = 'single' | 'continuous' | 'two-page'

const DARK_PAGE_COLORS = { background: '#1f1f22', foreground: '#d6d3cc' } as const
const MIN_SCALE = 0.25
const MAX_SCALE = 5
// Fit presets accepted by `currentScaleValue`; anything else is a numeric zoom.
const FIT_PRESETS = new Set(['auto', 'page-actual', 'page-fit', 'page-width'])

// The highlight editor's colour palette. This MUST be provided: without it the
// UI manager's `highlightColorNames` map is null, and rebuilding a saved
// highlight on reopen throws in the telemetry getter (highlightColorNames.get).
// These are PDF.js's own default highlight colours.
const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F'

function applyViewMode(viewer: PDFViewer, viewMode: PdfViewMode): void {
  if (viewMode === 'single') {
    viewer.scrollMode = ScrollMode.PAGE
    viewer.spreadMode = SpreadMode.NONE
  } else if (viewMode === 'continuous') {
    viewer.scrollMode = ScrollMode.VERTICAL
    viewer.spreadMode = SpreadMode.NONE
  } else {
    viewer.scrollMode = ScrollMode.VERTICAL
    viewer.spreadMode = SpreadMode.ODD
  }
}

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
  const eventBusRef = useRef<EventBus | null>(null)

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [mode, setMode] = useState<PdfReadingMode>('light')
  const [highlightOn, setHighlightOn] = useState(false)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [scalePct, setScalePct] = useState(100)
  const [scaleSelect, setScaleSelect] = useState<string>('page-width')
  const [customScale, setCustomScale] = useState(false)
  const [viewMode, setViewMode] = useState<PdfViewMode>('continuous')
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatch, setFindMatch] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0
  })
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
  // Latest view mode, read inside the (rebuild-on-dark-toggle) viewer effect
  // without making it a dependency.
  const viewModeRef = useRef<PdfViewMode>('continuous')
  viewModeRef.current = viewMode

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

    // Preserve position across a dark-toggle rebuild.
    const prevTop = container.scrollTop
    const prevLeft = container.scrollLeft

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ eventBus, linkService })
    let viewer: PDFViewer
    try {
      viewer = new PDFViewer({
        container,
        viewer: viewerEl,
        eventBus,
        linkService,
        findController,
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
    eventBusRef.current = eventBus

    const onPagesInit = (): void => {
      applyViewMode(viewer, viewModeRef.current)
      viewer.currentScaleValue = 'page-width'
      container.scrollTop = prevTop
      container.scrollLeft = prevLeft
      setStatus('ready')
    }
    const onScaleChanging = (evt: { scale?: number; presetValue?: string }): void => {
      setScalePct(Math.round((viewer.currentScale || 1) * 100))
      if (evt.presetValue && FIT_PRESETS.has(evt.presetValue)) {
        setScaleSelect(evt.presetValue)
        setCustomScale(false)
      } else {
        setCustomScale(true)
        setScaleSelect('custom')
      }
    }
    const onPageChanging = (evt: { pageNumber: number }): void => {
      setCurrentPage(evt.pageNumber)
      setPageInput(String(evt.pageNumber))
    }
    // Highlights add/remove entries in the document's annotationStorage. Any
    // editor-state change recomputes dirtiness against the last-saved size.
    const onEditorStateChanged = (): void => {
      const size = pdfDoc.annotationStorage.size
      markDirty(size !== savedSizeRef.current)
    }
    const onFindMatches = (evt: { matchesCount?: { current: number; total: number } }): void => {
      setFindMatch({ current: evt.matchesCount?.current ?? 0, total: evt.matchesCount?.total ?? 0 })
    }
    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('scalechanging', onScaleChanging)
    eventBus.on('pagechanging', onPageChanging)
    eventBus.on('annotationeditorstateschanged', onEditorStateChanged)
    eventBus.on('updatefindmatchescount', onFindMatches)
    eventBus.on('updatefindcontrolstate', onFindMatches)

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
      eventBus.off('pagechanging', onPageChanging)
      eventBus.off('annotationeditorstateschanged', onEditorStateChanged)
      eventBus.off('updatefindmatchescount', onFindMatches)
      eventBus.off('updatefindcontrolstate', onFindMatches)
      try {
        viewer.setDocument(null as unknown as PDFDocumentProxy)
      } catch {
        /* viewer already torn down */
      }
      viewerRef.current = null
      eventBusRef.current = null
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

  // --- Page navigation -----------------------------------------------------
  const goToPage = useCallback(
    (page: number) => {
      const v = viewerRef.current
      if (!v) return
      v.currentPageNumber = Math.min(Math.max(1, page), numPages || 1)
    },
    [numPages]
  )
  const prevPage = useCallback(() => goToPage(currentPage - 1), [goToPage, currentPage])
  const nextPage = useCallback(() => goToPage(currentPage + 1), [goToPage, currentPage])
  const commitPageInput = useCallback(() => {
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n)) goToPage(n)
    else setPageInput(String(currentPage))
  }, [pageInput, goToPage, currentPage])

  // --- Zoom ----------------------------------------------------------------
  const zoomIn = useCallback(() => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.min(MAX_SCALE, v.currentScale * 1.15)
  }, [])
  const zoomOut = useCallback(() => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.max(MIN_SCALE, v.currentScale / 1.15)
  }, [])
  const setScaleValue = useCallback((value: string) => {
    const v = viewerRef.current
    if (!v || value === 'custom') return
    v.currentScaleValue = value
  }, [])

  // --- View mode -----------------------------------------------------------
  const changeViewMode = useCallback((value: PdfViewMode) => {
    setViewMode(value)
    const v = viewerRef.current
    if (v) applyViewMode(v, value)
  }, [])

  // --- Find ----------------------------------------------------------------
  const dispatchFind = useCallback(
    (query: string, opts?: { again?: boolean; previous?: boolean }) => {
      const bus = eventBusRef.current
      if (!bus) return
      bus.dispatch('find', {
        source: null,
        type: opts?.again ? 'again' : '',
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: opts?.previous ?? false,
        matchDiacritics: false
      })
    },
    []
  )
  const onFindInput = useCallback(
    (value: string) => {
      setFindQuery(value)
      dispatchFind(value)
    },
    [dispatchFind]
  )
  const findNext = useCallback(
    () => dispatchFind(findQuery, { again: true }),
    [dispatchFind, findQuery]
  )
  const findPrev = useCallback(
    () => dispatchFind(findQuery, { again: true, previous: true }),
    [dispatchFind, findQuery]
  )
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindMatch({ current: 0, total: 0 })
    dispatchFind('') // clear match highlights
  }, [dispatchFind])

  // --- Save ----------------------------------------------------------------
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

  const findNotFound = findQuery.length > 0 && findMatch.total === 0

  return (
    <div className="zen-pdf flex min-h-0 min-w-0 flex-1 flex-col bg-paper-100/40">
      <div className="zen-pdf-toolbar flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-paper-300/70 px-3 py-1 text-xs text-ink-700">
        {/* Page navigation */}
        <div className="zen-pdf-group flex items-center gap-1">
          <button
            type="button"
            className="zen-pdf-btn"
            onClick={prevPage}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            ‹
          </button>
          <input
            className="zen-pdf-input tabular-nums"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitPageInput()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            aria-label="Page number"
          />
          <span className="zen-pdf-pagecount tabular-nums text-ink-500">/ {numPages || '–'}</span>
          <button
            type="button"
            className="zen-pdf-btn"
            onClick={nextPage}
            disabled={numPages > 0 && currentPage >= numPages}
            title="Next page"
          >
            ›
          </button>
        </div>

        <span className="zen-pdf-divider" />

        {/* Zoom */}
        <div className="zen-pdf-group flex items-center gap-1">
          <button type="button" className="zen-pdf-btn" onClick={zoomOut} title="Zoom out">
            −
          </button>
          <select
            className="zen-pdf-select tabular-nums"
            value={scaleSelect}
            onChange={(e) => setScaleValue(e.target.value)}
            title="Zoom"
          >
            <option value="auto">Automatic</option>
            <option value="page-actual">Actual Size</option>
            <option value="page-fit">Fit Page</option>
            <option value="page-width">Fit Width</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
            <option value="3">300%</option>
            <option value="4">400%</option>
            {customScale && <option value="custom">{scalePct}%</option>}
          </select>
          <button type="button" className="zen-pdf-btn" onClick={zoomIn} title="Zoom in">
            +
          </button>
        </div>

        <span className="zen-pdf-divider" />

        {/* View mode */}
        <select
          className="zen-pdf-select"
          value={viewMode}
          onChange={(e) => changeViewMode(e.target.value as PdfViewMode)}
          title="Page layout"
        >
          <option value="single">Single Page</option>
          <option value="continuous">Continuous</option>
          <option value="two-page">Two Pages</option>
        </select>

        <span className="zen-pdf-divider" />

        {/* Find */}
        <button
          type="button"
          className={`zen-pdf-btn ${findOpen ? 'zen-pdf-btn-active' : ''}`}
          aria-pressed={findOpen}
          onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
          title="Find in document"
        >
          Find
        </button>

        {/* Reading modes + annotate (right-aligned) */}
        <div className="zen-pdf-group ml-auto flex items-center gap-1">
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
          <span className="zen-pdf-divider" />
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
        </div>
      </div>

      {findOpen && (
        <div className="zen-pdf-findbar flex shrink-0 items-center gap-2 border-b border-paper-300/70 px-3 py-1.5 text-xs">
          <input
            className="zen-pdf-input zen-pdf-find-input"
            value={findQuery}
            autoFocus
            placeholder="Find in document…"
            onChange={(e) => onFindInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) findPrev()
                else findNext()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
            aria-label="Find in document"
          />
          <span className={`zen-pdf-find-count tabular-nums ${findNotFound ? 'text-red-500' : 'text-ink-500'}`}>
            {findQuery.length === 0
              ? ''
              : findNotFound
                ? 'No results'
                : `${findMatch.current} / ${findMatch.total}`}
          </span>
          <button type="button" className="zen-pdf-btn" onClick={findPrev} title="Previous match">
            ‹
          </button>
          <button type="button" className="zen-pdf-btn" onClick={findNext} title="Next match">
            ›
          </button>
          <button type="button" className="zen-pdf-btn ml-auto" onClick={closeFind} title="Close find">
            ✕
          </button>
        </div>
      )}

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
