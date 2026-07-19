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
import { useStore } from '../store'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// `light` is the untouched page. `dark` uses PDF.js's render-time
// `pageColors`, which recolours the default page background and default
// (black) text during rasterisation while leaving embedded raster images
// intact. `invert` is the coarse CSS-filter fallback (also negates images),
// for documents whose colour cannot be themed by `pageColors` alone.
// `sepia` is the same mechanism as `dark` — a warm paper/ink pair handed to
// `pageColors` — so it likewise leaves embedded images untouched, unlike the
// `invert` filter. Its warmth is user-tunable (`pdfSepiaTone`).
export type PdfReadingMode = 'light' | 'sepia' | 'dark' | 'invert'
// Standard viewer page-layout modes, each a scrollMode + spreadMode pair.
type PdfViewMode = 'single' | 'continuous' | 'two-page'

const DARK_PAGE_COLORS = { background: '#1f1f22', foreground: '#d6d3cc' } as const

// Sepia paper, interpolated by the `pdfSepiaTone` preference: 0 is barely
// off-white, 100 is a deep aged-paper tone. The ink stays a fixed warm brown —
// varying it too would trade away contrast just as the paper darkens, which is
// the opposite of what a warmth control should do.
const SEPIA_INK = '#5b4636'
const SEPIA_PAPER_MIN = [253, 248, 239] as const
const SEPIA_PAPER_MAX = [232, 217, 181] as const
// The desk sits a little darker than the page so the sheet still reads as a
// sheet rather than blending into the background.
const SEPIA_DESK_SHADE = 0.88

// The getter returns the current mode number (`this.#s`), but pdfjs-dist types
// the property with the *setter's* object shape, so reading needs a widen.
function readEditorMode(viewer: PDFViewer): number {
  return viewer.annotationEditorMode as unknown as number
}

function mixChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t)
}

function sepiaPalette(tone: number): {
  pageColors: { background: string; foreground: string }
  desk: string
} {
  const t = Math.min(100, Math.max(0, tone)) / 100
  const rgb = SEPIA_PAPER_MIN.map((from, i) => mixChannel(from, SEPIA_PAPER_MAX[i], t))
  const hex = (channels: number[]): string =>
    `#${channels.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`
  return {
    pageColors: { background: hex(rgb), foreground: SEPIA_INK },
    desk: hex(rgb.map((c) => Math.round(c * SEPIA_DESK_SHADE)))
  }
}
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
  // Read by the mode-restore listener, which must not re-subscribe per toggle.
  const highlightOnRef = useRef(false)
  highlightOnRef.current = highlightOn
  // Last non-collapsed selection made inside this viewer. Opening the Command
  // Palette moves focus and drops the live selection, so the palette entry
  // would otherwise always find nothing to highlight; this lets it (and a
  // shortcut pressed after focus moved) act on what was last selected.
  const lastSelectionRef = useRef<Range | null>(null)
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
  // Synced ref so the resize observer can read the active zoom preset without
  // re-binding.
  const scaleSelectRef = useRef(scaleSelect)
  scaleSelectRef.current = scaleSelect
  // Cached numeric scales for the fit presets, so pinch-zoom can snap onto
  // them as detents. Seeded at init and kept fresh from scalechanging.
  const fitScalesRef = useRef<{ 'page-width': number | null; 'page-fit': number | null }>({
    'page-width': null,
    'page-fit': null
  })
  // Which fit the zoom is currently locked onto (null when freely zoomed).
  // Kept in sync synchronously by onScaleChanging so the wheel handler never
  // races React state.
  const lockedFitRef = useRef<'page-width' | 'page-fit' | null>(null)
  // Accumulated zoom factor within the current pinch gesture while locked, and
  // the last wheel timestamp used to reset it between gestures.
  const pinchAccumRef = useRef(1)
  const lastWheelRef = useRef(0)

  // The configured default zoom, read into a ref so a viewer rebuild (dark
  // toggle) doesn't re-subscribe. A new document opens at this; on rebuild we
  // restore the zoom the user had, tracked in restoreScaleRef.
  const pdfDefaultZoom = useStore((s) => s.pdfDefaultZoom)
  const defaultZoomRef = useRef(pdfDefaultZoom)
  defaultZoomRef.current = pdfDefaultZoom
  const restoreScaleRef = useRef<string | null>(null)
  // User-tunable pinch break-out feel, read via ref so the wheel handler
  // (bound once) always sees the latest values.
  const pinchTuning = useStore((s) => s.pdfPinchTuning)
  const pinchTuningRef = useRef(pinchTuning)
  pinchTuningRef.current = pinchTuning

  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value
    setDirty(value)
  }, [])

  const sepiaTone = useStore((s) => s.pdfSepiaTone)
  // Memoised: this object is a dependency of the viewer-build effect, so a
  // fresh literal every render would rebuild the viewer on every render.
  const sepia = useMemo(() => sepiaPalette(sepiaTone), [sepiaTone])
  const pageColors =
    mode === 'dark' ? DARK_PAGE_COLORS : mode === 'sepia' ? sepia.pageColors : undefined
  // `dark` and `sepia` render differently (pageColors), so the viewer is
  // rebuilt when toggling into/out of them — and, for sepia, when the tone
  // itself changes, since the colours are baked in at rasterisation time.
  // `invert` is pure CSS, so it shares the light build — this key drives the
  // rebuild effect below.
  const buildKey = mode === 'dark' ? 'dark' : mode === 'sepia' ? `sepia:${sepiaTone}` : 'light'

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
        restoreScaleRef.current = null // a new document opens at the default zoom
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
        // Pops a small highlight button beside any text selection (the same
        // affordance Preview and PDF Expert have), so highlighting no longer
        // requires arming the drag-to-highlight tool first. The tool toggle
        // stays for consecutive marking and for scanned pages, where there is
        // no text layer to select and free-form highlighting is the only way.
        enableHighlightFloatingButton: true,
        // Fit Width sizes a page to `container.clientWidth - 40`, that 40 being
        // a hardcoded allowance for a classic overlay scrollbar, which left a
        // 20px dead strip down each side. This option is the only lever on it
        // and it goes straight to 0, so the breathing room is taken from the
        // container's transparent border instead (see .zen-pdf-container).
        removePageBorders: true,
        ...(pageColors ? { pageColors } : {})
        // `enableHighlightFloatingButton` is missing from pdfjs-dist's
        // PDFViewerOptions typings even though the shipped viewer reads it
        // (verified in the bundle), so the literal needs widening.
      } as ConstructorParameters<typeof PDFViewer>[0])
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
      // Pre-seed both fit scales (the intermediate set updates currentScale
      // synchronously without an extra paint) so pinch detents work from the
      // first gesture, then land on Fit Width as the default.
      viewer.currentScaleValue = 'page-fit'
      fitScalesRef.current['page-fit'] = viewer.currentScale
      viewer.currentScaleValue = 'page-width'
      fitScalesRef.current['page-width'] = viewer.currentScale
      // First open uses the configured default zoom; a rebuild (dark toggle)
      // restores whatever zoom the user was at.
      viewer.currentScaleValue = restoreScaleRef.current ?? defaultZoomRef.current
      container.scrollTop = prevTop
      container.scrollLeft = prevLeft
      setStatus('ready')
    }
    const onScaleChanging = (evt: { scale?: number; presetValue?: string }): void => {
      const scale = viewer.currentScale || 1
      setScalePct(Math.round(scale * 100))
      const preset = evt.presetValue
      if (preset && FIT_PRESETS.has(preset)) {
        setScaleSelect(preset)
        setCustomScale(false)
        if (preset === 'page-width' || preset === 'page-fit') {
          fitScalesRef.current[preset] = scale
          lockedFitRef.current = preset
        } else {
          lockedFitRef.current = null
        }
      } else {
        setCustomScale(true)
        setScaleSelect('custom')
        lockedFitRef.current = null
      }
      // Remember the current zoom so a viewer rebuild can restore it.
      restoreScaleRef.current = preset && FIT_PRESETS.has(preset) ? preset : String(scale)
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

  // Highlight the current selection without leaving normal reading mode.
  //
  // Order matters here, and it is the whole trick. PDF.js's `highlightSelection`
  // resolves the editor layer it will draw into *before* it asks for a mode
  // change:
  //
  //     const layer = this.#getLayerForTextLayer(textLayerDiv)   // captured now
  //     if (isNoneMode) { this.switchToMode(HIGHLIGHT, m); return }
  //     // ...m() eventually calls  layer?.createAndAddNewEditor(...)
  //
  // Those layers only exist while an editing mode is active: returning to NONE
  // runs `toggleEditingMode(false)` on every page and tears them down. So an
  // "highlight, then restore NONE" sequence works exactly once — on a freshly
  // opened document the layers still exist from the initial render, and after
  // the first restore `layer` is null forever after, `layer?.` silently
  // swallows the call, and highlighting appears dead until the tab is reopened
  // (while the mode still dutifully cycles NONE→HIGHLIGHT→NONE, which is what
  // made this look like a mode bug rather than a lifetime bug).
  //
  // Therefore: arm HIGHLIGHT first, wait for the mode to actually land so the
  // layers exist, only then highlight, and restore afterwards.
  useEffect(() => {
    const onSelectionChange = (): void => {
      const container = containerRef.current
      const selection = document.getSelection()
      if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) return
      lastSelectionRef.current = range.cloneRange()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const highlightCurrentSelection = useCallback((): void => {
    const viewer = viewerRef.current
    const bus = eventBusRef.current
    const container = containerRef.current
    if (!viewer || !bus || !container) return
    let selection = document.getSelection()
    // Focus may have moved (Command Palette) and taken the selection with it.
    // Put the remembered one back so PDF.js, which reads the live DOM
    // selection, sees what the user actually meant.
    if (!selection || selection.isCollapsed) {
      const saved = lastSelectionRef.current
      if (!saved || !saved.commonAncestorContainer.isConnected) return
      if (!container.contains(saved.commonAncestorContainer)) return
      try {
        selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(saved)
      } catch {
        return
      }
    }
    if (!selection || selection.isCollapsed) return
    // Consumed: without this, pressing the shortcut again would re-highlight
    // the same text (the live selection is cleared by PDF.js as it works).
    lastSelectionRef.current = null

    const restoreTo = highlightOnRef.current
      ? pdfjs.AnnotationEditorType.HIGHLIGHT
      : pdfjs.AnnotationEditorType.NONE

    const createHighlight = (): void => {
      try {
        bus.dispatch('editingaction', { source: bus, name: 'highlightSelection' })
      } catch (err) {
        console.error('PdfView: failed to highlight selection', err)
      }
      if (restoreTo === pdfjs.AnnotationEditorType.HIGHLIGHT) return
      // Restore immediately (deferred one tick so the editor commits to
      // annotationStorage first). This is why normal mode shows no colour
      // picker: PDF.js only renders an editor's toolbar for a *selected* editor
      // inside a *live* editing layer, and returning to NONE tears that layer
      // down. Keeping the layer alive to show the picker was tried and
      // abandoned — it means sitting in HIGHLIGHT mode with its cursor and
      // drag-to-highlight behaviour, and no reliable signal exists for when to
      // hand the mode back (see git history). Colour is chosen up front
      // instead, via the toolbar's highlight tool.
      setTimeout(() => {
        const v = viewerRef.current
        if (!v) return
        try {
          v.annotationEditorMode = { mode: restoreTo }
        } catch {
          /* viewer torn down mid-restore */
        }
      }, 0)
    }

    if (readEditorMode(viewer) === pdfjs.AnnotationEditorType.HIGHLIGHT) {
      createHighlight()
      return
    }

    const onceArmed = ({ mode }: { mode: number }): void => {
      if (mode !== pdfjs.AnnotationEditorType.HIGHLIGHT) return
      bus.off('annotationeditormodechanged', onceArmed)
      createHighlight()
    }
    bus.on('annotationeditormodechanged', onceArmed)
    try {
      viewer.annotationEditorMode = { mode: pdfjs.AnnotationEditorType.HIGHLIGHT }
    } catch (err) {
      bus.off('annotationeditormodechanged', onceArmed)
      console.error('PdfView: failed to arm the highlight editor', err)
    }
  }, [])

  // Command Palette / keyboard shortcut path.
  useEffect(() => {
    if (status !== 'ready') return
    const onRequest = (): void => highlightCurrentSelection()
    window.addEventListener('zen:pdf-highlight-selection', onRequest)
    return () => window.removeEventListener('zen:pdf-highlight-selection', onRequest)
  }, [status, highlightCurrentSelection])

  // PDF.js's own floating button beside a selection calls `highlightSelection`
  // directly, which hits the stale-layer trap above and cannot be pre-armed
  // from outside. Intercept its click during capture — which stops the event
  // before it reaches PDF.js's own handler on the button — and run the armed
  // path instead. The button (and its positioning/styling/l10n) stays PDF.js's.
  useEffect(() => {
    const container = containerRef.current
    if (!container || status !== 'ready') return
    const onCaptureClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.highlightButton')) return
      event.preventDefault()
      event.stopPropagation()
      highlightCurrentSelection()
    }
    container.addEventListener('click', onCaptureClick, true)
    return () => container.removeEventListener('click', onCaptureClick, true)
  }, [status, highlightCurrentSelection])


  // Answer PDF.js's request to change editor mode. Nothing listens for this in
  // the viewer-components layer (Mozilla's full viewer answers it in app.js),
  // so without this any internal `switchToMode` would stall forever.
  useEffect(() => {
    const bus = eventBusRef.current
    if (!bus || status !== 'ready') return
    const onShowEditorUi = ({ mode }: { mode: number }): void => {
      const viewer = viewerRef.current
      if (!viewer) return
      try {
        viewer.annotationEditorMode = { mode }
      } catch (err) {
        console.error('PdfView: failed to apply requested editor mode', err)
      }
    }
    bus.on('showannotationeditorui', onShowEditorUi)
    return () => bus.off('showannotationeditorui', onShowEditorUi)
  }, [status])
  // Fit modes (Fit Width / Fit Page / Automatic) depend on the pane size, so
  // recompute them whenever the container resizes (window resize AND split-
  // pane drags, which a window listener would miss).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const v = viewerRef.current
        const sel = scaleSelectRef.current
        if (v && FIT_PRESETS.has(sel)) {
          try {
            v.currentScaleValue = sel
          } catch {
            /* viewer not ready */
          }
        }
      })
    })
    observer.observe(container)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  // Trackpad pinch-zoom arrives as ctrl+wheel. PDF.js's component layer does
  // not handle it (that lives in the full viewer app), so wire it here: smooth
  // continuous zoom, with soft detents that snap onto the Fit Width / Fit Page
  // scales as you pass through them (and stay resize-responsive once snapped).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return // plain wheel = scroll; ctrl/pinch = zoom
      e.preventDefault()
      const v = viewerRef.current
      if (!v) return
      const now = performance.now()
      const gap = now - lastWheelRef.current
      lastWheelRef.current = now
      const factor = Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * 0.01)))

      // Locked on a fit: hold it against small pinches. Only when the zoom
      // accumulated within one continuous gesture (no >160ms pause) grows past
      // ~15% does it break free — so a firm pinch escapes, a gentle one sticks.
      if (lockedFitRef.current) {
        const tuning = pinchTuningRef.current
        if (gap > tuning.resetMs) pinchAccumRef.current = 1 // new gesture — reset
        pinchAccumRef.current *= factor
        const acc = pinchAccumRef.current
        const band = tuning.stickiness / 100 // e.g. 15% → hold within [0.85, 1.15]
        if (acc > 1 - band && acc < 1 + band) return // stuck to the fit
        pinchAccumRef.current = 1
        lockedFitRef.current = null
        v.currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.currentScale * acc))
        return
      }

      // Free zoom, snapping onto a fit when we pass within ~2.5% of it.
      pinchAccumRef.current = 1
      const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.currentScale * factor))
      for (const preset of ['page-width', 'page-fit'] as const) {
        const s = fitScalesRef.current[preset]
        if (s != null && Math.abs(target - s) / s < 0.025) {
          try {
            v.currentScaleValue = preset
          } catch {
            /* ignore */
          }
          return
        }
      }
      v.currentScale = target
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

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
    () => ({ light: 'Light', sepia: 'Sepia', dark: 'Dark', invert: 'Invert' }),
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
          {(['light', 'sepia', 'dark', 'invert'] as const).map((m) => (
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
            mode === 'dark' || mode === 'invert' ? 'zen-pdf-scroll-dark' : ''
          }`}
          // Sepia's desk is derived from the chosen tone rather than a fixed
          // class, so it stays in step as the warmth is adjusted.
          style={mode === 'sepia' ? { backgroundColor: sepia.desk } : undefined}
        >
          <div ref={viewerElRef} className={`pdfViewer ${mode === 'invert' ? 'zen-pdf-invert' : ''}`} />
        </div>
      </div>
    </div>
  )
}
