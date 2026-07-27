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
import {
  DocumentIcon,
  FileDownIcon,
  FitPageIcon,
  RevertIcon,
  FitWidthIcon,
  HighlighterIcon,
  ListTreeIcon,
  MoreIcon,
  SearchIcon
} from './icons'
import { PdfBarMenu, PdfMenuItem, PdfMenuRow } from './PdfBarMenu'
import { confirmApp } from '../lib/confirm-requests'
import { registerPdfBuffer } from '../lib/pdf-buffers'
import { registerPdfOutline, type PdfOutlineItem } from '../lib/pdf-outline'
import {
  recallPdfView,
  rememberPdfView,
  type PdfReadingMode,
  type PdfViewMode,
  type PdfViewPosition
} from '../lib/pdf-view-memory'
import {
  isListedSubtype,
  isTextMarkupSubtype,
  normalizeQuadPoints,
  pdfColorToCss,
  pdfColorToRgbTriple,
  quadsBounds,
  registerPdfAnnotations,
  textInQuads,
  type PdfAnnotationEntry,
  type TextBox
} from '../lib/pdf-annotations'
import { useStore } from '../store'
import { getCurrentDragPayload } from '../lib/dnd'
import { PDF_HIGHLIGHT_COLORS_OPTION, PDF_HIGHLIGHT_PALETTE } from '@shared/pdf'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// PDF.js's AnnotationEditorUIManager attaches document-level `dragover`/`drop`
// listeners (to import an image dropped onto a PDF into a stamp annotation).
// Its handler iterates an internal set that stays null until an editing mode is
// entered, so it throws `this.#o is not iterable` on ANY drag anywhere in the
// app while a PDF is open — flooding the console and, when the pointer is over
// a region that lets the event bubble to `document`, breaking that drag.
//
// We never support dropping onto the PDF, and our own drag-and-drop is handled
// by React component listeners (delegated at the React root, a descendant of
// `document`), never by `document` listeners. So for an in-app drag we swallow
// the event at `document` before PDF.js's listener runs. Registered once at
// module load — before any PDFViewer is constructed — so it is earliest in the
// listener list; `stopImmediatePropagation` then prevents PDF.js's handler from
// firing. Our own handlers already ran (deeper in the tree, earlier in bubble),
// so this does not affect them. External file drags (no in-app payload) are
// left alone.
function suppressPdfjsDocumentDrag(event: DragEvent): void {
  if (getCurrentDragPayload()) event.stopImmediatePropagation()
}
document.addEventListener('dragover', suppressPdfjsDocumentDrag)
document.addEventListener('drop', suppressPdfjsDocumentDrag)

// The reading-mode and page-layout unions are declared in pdf-view-memory —
// which has to name them in order to store them — so the viewer and its memory
// cannot drift apart. Documented there; re-exported here as the viewer's own
// vocabulary.
export type { PdfReadingMode, PdfViewMode }

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

// The palette lives in @shared/pdf so the viewer option, the picker and the
// preference validator cannot drift apart. Passing it is mandatory: without it
// the UI manager's `highlightColorNames` map is null and rebuilding a saved
// highlight on reopen throws in the telemetry getter.

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

/** An asset-level action contributed by the host tab (reference, locate,
 *  reveal). Passed as data rather than rendered nodes so the PDF bar can lay
 *  them out inside its own menu. */
export interface PdfAssetAction {
  id: string
  label: string
  icon: JSX.Element
  onClick: () => void
}

export function PdfView({
  assetUrl,
  assetPath,
  tabPath,
  title,
  assetActions = [],
  chrome = 'full',
  readOnly = false
}: {
  assetUrl: string
  /** Vault-relative path of the PDF, used to save bytes back to the file. */
  assetPath: string
  /** The tab's path — the key the close guard looks this buffer up under. */
  tabPath: string
  title: string
  /** Host-provided actions (reference / locate / reveal) folded into this
   *  view's own menu, so a PDF shows one bar rather than two. */
  assetActions?: PdfAssetAction[]
  /** `compact` drops the filename and shrinks the bar, for hosts that already
   *  show the document's name (the pinned reference pane). */
  chrome?: 'full' | 'compact'
  /** Hide every annotation-authoring control. Used by the pinned reference
   *  pane: the same PDF can be pinned and open in a tab at once, and each
   *  view holds its own document, so both could hold unsaved highlights and
   *  the second save would silently clobber the first. A reference is for
   *  reading alongside, so it reads. */
  readOnly?: boolean
}): JSX.Element {
  // The scrollable, absolutely-positioned host PDFViewer requires.
  const containerRef = useRef<HTMLDivElement>(null)
  // The inner `.pdfViewer` element the pages mount into.
  const viewerElRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  // Resolves outline destinations; owned by the viewer-build effect.
  const linkServiceRef = useRef<PDFLinkService | null>(null)

  // Where this tab was last time it was mounted, if it has been. Read once, at
  // first render, so the layout/reading mode below open at the remembered
  // values and the very first viewer build is already correct — a later
  // correction would rebuild the viewer and flash the default first. Consumed
  // by `onPagesInit` for the page/scroll/zoom half, which can only be applied
  // once the pages exist.
  const restoreRef = useRef<PdfViewPosition | null | undefined>(undefined)
  if (restoreRef.current === undefined) restoreRef.current = recallPdfView(tabPath) ?? null
  const restored = restoreRef.current

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  // Bumped to force a re-fetch of the bytes on disk (Revert).
  const [reloadKey, setReloadKey] = useState(0)
  const [mode, setMode] = useState<PdfReadingMode>(restored?.readingMode ?? 'light')
  const [highlightOn, setHighlightOn] = useState(false)
  // Read by the mode-restore listener, which must not re-subscribe per toggle.
  const highlightOnRef = useRef(false)
  highlightOnRef.current = highlightOn
  // Read inside the highlight-creation callback without re-creating it.
  const highlightColorRef = useRef('')
  // Embedded highlight id -> "r g b", used to tint each one correctly in Dark
  // mode. Filled by the annotation scan below, which already reads these.
  const embeddedHighlightColorsRef = useRef(new Map<string, string>())
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
  const [viewMode, setViewMode] = useState<PdfViewMode>(restored?.viewMode ?? 'continuous')
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
  // True while a clean document is entering an editing mode, so the deferred
  // re-baseline knows the dirtiness it is clearing is mode bookkeeping.
  const enteringModeCleanRef = useRef(false)
  // Page to return to after a Revert reload (null = leave at page 1).
  const restorePageRef = useRef<number | null>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  // Latest view mode, read inside the (rebuild-on-dark-toggle) viewer effect
  // without making it a dependency.
  const viewModeRef = useRef<PdfViewMode>(viewMode)
  viewModeRef.current = viewMode
  // Synced mirrors of the state the view memory saves, so the unmount capture
  // never has to read back from React state or from `containerRef.current` —
  // which React may already have detached by the time an effect cleanup runs
  // (the same constraint MediaPlayer's playback memory works around).
  const modeRef = useRef<PdfReadingMode>(mode)
  modeRef.current = mode
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const statusRef = useRef(status)
  statusRef.current = status
  const scrollPosRef = useRef({ top: 0, left: 0 })
  const tabPathRef = useRef(tabPath)
  tabPathRef.current = tabPath
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
        doc.annotationStorage.resetModified()
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
  }, [assetUrl, reloadKey])

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
        annotationEditorHighlightColors: PDF_HIGHLIGHT_COLORS_OPTION,
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
    linkServiceRef.current = linkService
    viewerRef.current = viewer
    eventBusRef.current = eventBus

    const onPagesInit = (): void => {
      // Where this tab was when it was last unmounted, if anywhere. Taken once:
      // later rebuilds (a reading-mode toggle) preserve position through
      // prevTop/restoreScaleRef instead, and must not be dragged back to it.
      const remembered = restoreRef.current
      restoreRef.current = null

      applyViewMode(viewer, viewModeRef.current)
      // Pre-seed both fit scales (the intermediate set updates currentScale
      // synchronously without an extra paint) so pinch detents work from the
      // first gesture, then land on Fit Width as the default.
      viewer.currentScaleValue = 'page-fit'
      fitScalesRef.current['page-fit'] = viewer.currentScale
      viewer.currentScaleValue = 'page-width'
      fitScalesRef.current['page-width'] = viewer.currentScale
      // A tab returning to view reopens at its remembered zoom; otherwise a
      // first open uses the configured default, and a rebuild (dark toggle)
      // restores whatever zoom the user was at.
      viewer.currentScaleValue =
        remembered?.scaleValue ?? restoreScaleRef.current ?? defaultZoomRef.current
      // Revert reloads the document; put the reader back where they were.
      if (remembered) {
        viewer.currentPageNumber = Math.min(Math.max(1, remembered.page), pdfDoc.numPages)
      } else if (restorePageRef.current != null) {
        viewer.currentPageNumber = restorePageRef.current
        restorePageRef.current = null
      }
      // Set after the page: in continuous scrolling the offset is the exact
      // position and supersedes the page it lands on, while in single-page mode
      // the page is what matters and this is the offset within it.
      container.scrollTop = remembered ? remembered.scrollTop : prevTop
      container.scrollLeft = remembered ? remembered.scrollLeft : prevLeft
      // Seed the tracked offset with what we just applied, so switching away
      // again before scrolling once still remembers this position rather than 0.
      scrollPosRef.current = { top: container.scrollTop, left: container.scrollLeft }
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
    // Dirtiness comes from the storage's own modified flag, not from counting
    // its entries. Entry counts lie: entering highlight mode registers the
    // document's existing annotations as editor objects, so `size` grows
    // without the user having changed anything, and Save would light up on a
    // document that needs no saving.
    const storage = pdfDoc.annotationStorage
    storage.onSetModified = () => markDirty(true)
    storage.onResetModified = () => markDirty(false)
    const onFindMatches = (evt: { matchesCount?: { current: number; total: number } }): void => {
      setFindMatch({ current: evt.matchesCount?.current ?? 0, total: evt.matchesCount?.total ?? 0 })
    }
    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('scalechanging', onScaleChanging)
    eventBus.on('pagechanging', onPageChanging)

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

  // Track the scroll offset continuously rather than reading it at unmount:
  // the container element is a DOM ref, and React may have detached it by the
  // time the capture below runs. Bound once — the container node itself is
  // stable across viewer rebuilds; only its contents are replaced.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = (): void => {
      scrollPosRef.current = { top: container.scrollTop, left: container.scrollLeft }
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  // Save where the reader was when this tab stops rendering, so returning to it
  // reopens here instead of at page 1 in the default layout. Unmount only —
  // an asset tab renders only while active, so this cleanup IS the tab switch.
  useEffect(() => {
    return () => {
      // A document that never opened has nothing worth saving, and writing its
      // placeholder state would clobber a good entry from an earlier visit.
      if (statusRef.current !== 'ready') return
      rememberPdfView(tabPathRef.current, {
        page: currentPageRef.current,
        scrollTop: scrollPosRef.current.top,
        scrollLeft: scrollPosRef.current.left,
        viewMode: viewModeRef.current,
        scaleValue: restoreScaleRef.current ?? defaultZoomRef.current,
        readingMode: modeRef.current
      })
    }
  }, [])

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

  // Entering an editing mode is not an edit.
  //
  // Switching into HIGHLIGHT makes PDF.js register the document's existing
  // annotations as editor objects, which writes them into annotationStorage
  // and trips its modified flag — so arming the tool and doing nothing would
  // offer to "save" a document nobody changed. Re-baseline once the mode has
  // settled, but ONLY when the document was clean beforehand: doing it
  // unconditionally would silently discard the dirty state of edits made
  // before the tool was armed.
  useEffect(() => {
    const bus = eventBusRef.current
    if (!bus || status !== 'ready') return
    const onModeChanged = ({ mode: nextMode }: { mode: number }): void => {
      if (nextMode === pdfjs.AnnotationEditorType.NONE) return
      if (dirtyRef.current) return
      // Deferred: the registration happens as the layers build, after this
      // event fires.
      setTimeout(() => {
        if (dirtyRef.current && !enteringModeCleanRef.current) return
        pdfDocRef.current?.annotationStorage.resetModified()
        markDirty(false)
        enteringModeCleanRef.current = false
      }, 0)
      enteringModeCleanRef.current = true
    }
    bus.on('annotationeditormodechanged', onModeChanged)
    return () => bus.off('annotationeditormodechanged', onModeChanged)
  }, [status, markDirty])

  // Colour used for new highlights.
  //
  // `HIGHLIGHT_DEFAULT_COLOR` is applied to the editor *classes*
  // (updateDefaultParams), not to a selected editor, so it settles the colour
  // of every highlight made afterwards — floating button, shortcut or tool —
  // without needing anything selected or any mode borrowing. Chosen up front
  // rather than recoloured afterwards for exactly that reason: the post-hoc
  // picker needs a live editing layer, which is the trap documented in
  // data/pdf.md.
  const highlightColor = useStore((s) => s.pdfHighlightColor)
  highlightColorRef.current = highlightColor
  const setHighlightColor = useStore((s) => s.setPdfHighlightColor)
  const applyHighlightColor = useCallback((hex: string): void => {
    const bus = eventBusRef.current
    if (!bus) return
    try {
      bus.dispatch('switchannotationeditorparams', {
        source: bus,
        type: pdfjs.AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR,
        value: hex
      })
    } catch (err) {
      console.error('PdfView: failed to set the highlight colour', err)
    }
  }, [])

  // Re-applied on every viewer build as well as on change: a rebuild (dark or
  // sepia toggle) constructs a fresh UI manager that knows nothing of the
  // colour chosen earlier.
  useEffect(() => {
    if (status !== 'ready') return
    applyHighlightColor(highlightColor)
  }, [status, highlightColor, applyHighlightColor, buildKey])

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
      applyHighlightColor(highlightColorRef.current)
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

  // Publish the document's table of contents for the outline panel.
  //
  // PDF outlines are an arbitrarily deep tree whose entries point at either a
  // destination inside the document or an external URL; both are normalised
  // here so the panel never has to know PDF.js's shapes. `goToDestination`
  // handles named destinations and explicit dest arrays alike, which is the
  // genuinely awkward part and the main reason not to hand-roll navigation.
  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    let unregister: (() => void) | null = null

    const normalise = (raw: unknown[]): PdfOutlineItem[] =>
      raw.map((entry) => {
        const e = entry as {
          title?: unknown
          bold?: unknown
          italic?: unknown
          dest?: unknown
          url?: unknown
          items?: unknown
        }
        return {
          title: typeof e.title === 'string' ? e.title : '',
          bold: e.bold === true,
          italic: e.italic === true,
          dest: e.dest ?? null,
          url: typeof e.url === 'string' ? e.url : null,
          items: Array.isArray(e.items) ? normalise(e.items) : []
        }
      })

    void (async () => {
      let items: PdfOutlineItem[] = []
      try {
        const raw = await pdfDoc.getOutline()
        items = Array.isArray(raw) ? normalise(raw) : []
      } catch (err) {
        console.error('PdfView: failed to read the document outline', err)
      }
      if (cancelled) return
      unregister = registerPdfOutline(tabPath, {
        items,
        goTo: (item) => {
          if (item.url) {
            window.open(item.url, '_blank', 'noopener,noreferrer')
            return
          }
          if (item.dest == null) return
          try {
            linkServiceRef.current?.goToDestination(item.dest as string | unknown[])
          } catch (err) {
            console.error('PdfView: failed to navigate to outline destination', err)
          }
        }
      })
    })()

    return () => {
      cancelled = true
      unregister?.()
    }
  }, [pdfDoc, tabPath])

  // Give each embedded highlight its real colour in Dark mode.
  //
  // An embedded highlight is painted into the page canvas by its appearance
  // stream, and `pageColors` renders that near-black on a dark page, so it
  // disappears. The fix is to tint the annotation layer's own element, which is
  // transparent but clipped to the exact text quads — previously with one
  // hardcoded yellow, because the real colour "lives in the canvas and is
  // unreachable from CSS". Unreachable from CSS, yes; reachable from JS via
  // getAnnotations(), which the annotation list already calls. Each element is
  // matched by `data-annotation-id` and given its colour as a custom property
  // that the stylesheet applies its own alpha to.
  //
  // Our own highlights are unaffected: they live in the annotation *editor*
  // layer, which this rule does not target, so they are not double-tinted.
  const applyEmbeddedHighlightColors = useCallback((): void => {
    const root = viewerElRef.current
    const colors = embeddedHighlightColorsRef.current
    if (!root || colors.size === 0) return
    for (const el of root.querySelectorAll<HTMLElement>('.annotationLayer [data-annotation-id]')) {
      const id = el.dataset.annotationId
      const triple = id ? colors.get(id) : undefined
      if (triple) el.style.setProperty('--zen-pdf-hl-rgb', triple)
    }
  }, [])

  // Pages render lazily, so re-apply whenever a layer appears; the map itself
  // is built once per document by the scan below.
  useEffect(() => {
    const bus = eventBusRef.current
    if (!bus || status !== 'ready') return
    const onLayerRendered = (): void => applyEmbeddedHighlightColors()
    bus.on('annotationlayerrendered', onLayerRendered)
    return () => bus.off('annotationlayerrendered', onLayerRendered)
  }, [status, applyEmbeddedHighlightColors])

  // Assemble the annotation list for the annotations tab.
  //
  // Rebuilt whenever the editor reports a change (`dirty` flips as highlights
  // are added or removed) as well as on load. Page text is fetched lazily and
  // cached, since only pages carrying a highlight need it — scanning every page
  // of a long PDF up front would be wasted work for a document with three
  // highlights in it.
  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    let unregister: (() => void) | null = null
    const textCache = new Map<number, TextBox[]>()

    const pageText = async (pageNumber: number): Promise<TextBox[]> => {
      const cached = textCache.get(pageNumber)
      if (cached) return cached
      const page = await pdfDoc.getPage(pageNumber)
      const content = await page.getTextContent()
      const boxes: TextBox[] = []
      for (const item of content.items) {
        const it = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown }
        if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
        boxes.push({
          str: it.str,
          x: Number(it.transform[4]) || 0,
          y: Number(it.transform[5]) || 0,
          width: Number(it.width) || 0,
          height: Number(it.height) || 0
        })
      }
      textCache.set(pageNumber, boxes)
      return boxes
    }

    void (async () => {
      const entries: PdfAnnotationEntry[] = []
      // Declared out here so a mid-scan failure still publishes the colours
      // gathered so far rather than losing them with the exception.
      const colors = new Map<string, string>()
      try {
        // Deleting an embedded annotation leaves a tombstone in the storage
        // rather than removing it from the parsed document, so collect those
        // ids first and skip them below.
        const storage = pdfDoc.annotationStorage.getAll() ?? {}
        const deletedIds = new Set<string>()
        for (const value of Object.values(storage)) {
          const v = value as { deleted?: unknown; id?: unknown }
          if (v?.deleted === true && typeof v.id === 'string') deletedIds.add(v.id)
        }

        for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
          if (cancelled) return
          const page = await pdfDoc.getPage(pageNumber)
          const annotations = await page.getAnnotations({ intent: 'display' })
          for (const raw of annotations) {
            const a = raw as {
              subtype?: unknown
              id?: unknown
              quadPoints?: unknown
              color?: unknown
              rect?: unknown
              contents?: unknown
            }
            // Every markup type a person can leave on a page, not just
            // highlights: Preview and Acrobat also produce Underline,
            // StrikeOut, Square, Ink, sticky notes and so on. PDF.js parses
            // all of them (it simply cannot author them).
            if (!isListedSubtype(a.subtype)) continue
            if (typeof a.id === 'string' && deletedIds.has(a.id)) continue
            const subtype = a.subtype
            const quads = normalizeQuadPoints(a.quadPoints)
            const bounds = quads.length
              ? quadsBounds(quads)
              : ((Array.isArray(a.rect) ? a.rect : [0, 0, 0, 0]) as [
                  number,
                  number,
                  number,
                  number
                ])
            // Text markup gets the words it covers; a sticky note or FreeText
            // carries the author's own text in `contents`; shapes have neither.
            if (subtype === 'Highlight' && typeof a.id === 'string') {
              const triple = pdfColorToRgbTriple(a.color)
              if (triple) colors.set(a.id, triple)
            }
            const contents = typeof a.contents === 'string' ? a.contents.trim() : ''
            const text =
              isTextMarkupSubtype(subtype) && quads.length
                ? textInQuads(await pageText(pageNumber), quads)
                : contents
            entries.push({
              key: typeof a.id === 'string' ? `embedded:${a.id}` : `embedded:${pageNumber}:${entries.length}`,
              pageNumber,
              subtype,
              color: pdfColorToCss(a.color),
              text,
              rect: bounds
            })
          }
        }

        // Highlights made this session. Saving writes bytes without reloading,
        // so these never appear in getAnnotations() above and cannot duplicate.
        for (const [id, value] of Object.entries(storage)) {
          if (cancelled) return
          const v = value as {
            annotationType?: unknown
            deleted?: unknown
            pageIndex?: unknown
            color?: unknown
            quadPoints?: unknown
            rect?: unknown
          }
          if (v?.annotationType !== pdfjs.AnnotationEditorType.HIGHLIGHT) continue
          if (v.deleted === true) continue
          const pageNumber = typeof v.pageIndex === 'number' ? v.pageIndex + 1 : 1
          const quads = normalizeQuadPoints(v.quadPoints)
          const bounds = quads.length
            ? quadsBounds(quads)
            : ((Array.isArray(v.rect) ? v.rect : [0, 0, 0, 0]) as [number, number, number, number])
          entries.push({
            key: `session:${id}`,
            pageNumber,
            subtype: 'Highlight',
            color: pdfColorToCss(v.color),
            text: quads.length ? textInQuads(await pageText(pageNumber), quads) : '',
            rect: bounds
          })
        }
      } catch (err) {
        console.error('PdfView: failed to collect annotations', err)
      }
      if (cancelled) return
      embeddedHighlightColorsRef.current = colors
      applyEmbeddedHighlightColors()
      entries.sort((a, b) => a.pageNumber - b.pageNumber || b.rect[3] - a.rect[3])
      unregister = registerPdfAnnotations(tabPath, {
        entries,
        goTo: (highlight) => {
          const viewer = viewerRef.current
          if (!viewer) return
          try {
            // XYZ destination: left/top of the highlight, null zoom to keep the
            // user's current scale rather than yanking it.
            viewer.scrollPageIntoView({
              pageNumber: highlight.pageNumber,
              destArray: [null, { name: 'XYZ' }, highlight.rect[0], highlight.rect[3], null]
            })
          } catch (err) {
            console.error('PdfView: failed to scroll to highlight', err)
          }
        }
      })
    })()

    return () => {
      cancelled = true
      unregister?.()
    }
  }, [pdfDoc, tabPath, dirty, applyEmbeddedHighlightColors])

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
        doc.annotationStorage.resetModified()
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

  // Throw away every unsaved edit by reloading the file from disk.
  //
  // A reload rather than unwinding the editor's undo stack: the file is the
  // definition of "the previous state", so re-reading it cannot drift, whereas
  // replaying undos depends on PDF.js's stack being complete and symmetric.
  // Page and zoom are restored afterwards so reverting does not also lose the
  // reader's place.
  const revertNow = useCallback(async (): Promise<void> => {
    const ok = await confirmApp({
      title: 'Discard unsaved highlights?',
      description:
        'The PDF will be reloaded from disk. Highlights you have not saved will be lost. This cannot be undone.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true
    })
    if (!ok) return
    const viewer = viewerRef.current
    if (viewer) {
      restoreScaleRef.current = viewer.currentScaleValue
      restorePageRef.current = viewer.currentPageNumber
    }
    setHighlightOn(false)
    markDirty(false)
    setReloadKey((n) => n + 1)
  }, [markDirty])

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
      {/* One bar, not two: the host tab's title row and the viewer's controls
          are merged here, so a PDF no longer stacks a ZenNotes header above a
          PDF.js toolbar. What is used constantly (page, highlight, save) stays
          visible; everything else collapses into two menus. */}
      <header
        className={`zen-pdf-bar glass-header flex shrink-0 items-center gap-2 border-b border-paper-300/70 px-3 text-xs text-ink-700 ${
          chrome === 'compact' ? 'h-9' : 'h-12'
        }`}
      >
        {chrome === 'full' && (
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink-900">
            <DocumentIcon width={15} height={15} className="shrink-0 text-accent" />
            <span className="truncate">{title}</span>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="zen-pdf-group flex items-center gap-1">
            <button
              type="button"
              className="zen-pdf-btn zen-pdf-btn-icon"
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
                }
              }}
              aria-label="Page number"
            />
            <span className="zen-pdf-pagecount tabular-nums text-ink-500">/ {numPages || '–'}</span>
            <button
              type="button"
              className="zen-pdf-btn zen-pdf-btn-icon"
              onClick={nextPage}
              disabled={numPages > 0 && currentPage >= numPages}
              title="Next page"
            >
              ›
            </button>
          </div>

          <span className="zen-pdf-divider" />

          {/* Colour for new highlights, sitting left of the tool it applies
              to. The button is the swatch, so the current choice is readable
              without opening anything. */}
          {!readOnly && (
          <PdfBarMenu
            title={`Highlight colour: ${
              PDF_HIGHLIGHT_PALETTE.find((c) => c.hex === highlightColor)?.label ?? 'custom'
            }`}
            label={
              <span
                aria-hidden
                className="h-3.5 w-3.5 rounded-[3px] ring-1 ring-inset ring-black/20"
                style={{ backgroundColor: highlightColor }}
              />
            }
          >
            {(close) => (
              <>
                {PDF_HIGHLIGHT_PALETTE.map((colour) => (
                  <PdfMenuItem
                    key={colour.hex}
                    active={colour.hex === highlightColor}
                    icon={
                      <span
                        aria-hidden
                        className="h-3.5 w-3.5 rounded-[3px] ring-1 ring-inset ring-black/20"
                        style={{ backgroundColor: colour.hex }}
                      />
                    }
                    label={colour.label}
                    onClick={() => {
                      close()
                      setHighlightColor(colour.hex)
                    }}
                  />
                ))}
              </>
            )}
          </PdfBarMenu>
          )}

          {!readOnly && (
          <button
            type="button"
            className={`zen-pdf-btn zen-pdf-btn-icon ${highlightOn ? 'zen-pdf-btn-active' : ''}`}
            aria-pressed={highlightOn}
            onClick={() => setHighlightOn((v) => !v)}
            title="Highlight tool — drag to highlight (works on scanned pages too)"
          >
            <HighlighterIcon width={14} height={14} />
          </button>
          )}

          {/* Save and Discard appear only when there is something to act on.
              A permanently visible, greyed-out Save is noise, and worse, it
              implies the document might need saving when it does not. */}
          {!readOnly && dirty && (
            <>
              <button
                type="button"
                className="zen-pdf-btn zen-pdf-btn-icon zen-pdf-btn-active"
                onClick={() => void saveNow()}
                disabled={saving}
                title={saving ? 'Saving…' : 'Save highlights into the PDF'}
                aria-label="Save highlights into the PDF"
              >
                <FileDownIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className="zen-pdf-btn zen-pdf-btn-icon"
                onClick={() => void revertNow()}
                disabled={saving}
                title="Discard unsaved highlights and reload from disk"
                aria-label="Discard unsaved highlights"
              >
                <RevertIcon width={14} height={14} />
              </button>
            </>
          )}

          {/* Actions: the host tab's own actions, plus find and the outline
              panel, which otherwise had no home once the toolbar merged. */}
          <PdfBarMenu label={<MoreIcon width={15} height={15} />} title="Actions">
            {(close) => (
              <>
                {assetActions.map((action) => (
                  <PdfMenuItem
                    key={action.id}
                    icon={action.icon}
                    label={action.label}
                    onClick={() => {
                      close()
                      action.onClick()
                    }}
                  />
                ))}
                <PdfMenuItem
                  icon={<SearchIcon width={14} height={14} />}
                  label="Find in document"
                  active={findOpen}
                  onClick={() => {
                    close()
                    if (findOpen) closeFind()
                    else setFindOpen(true)
                  }}
                />
                {chrome === 'full' && (
                <PdfMenuItem
                  icon={<ListTreeIcon width={14} height={14} />}
                  label="Contents & annotations"
                  onClick={() => {
                    close()
                    window.dispatchEvent(new Event('zen:toggle-outline'))
                  }}
                />
                )}
              </>
            )}
          </PdfBarMenu>

          {/* Appearance: zoom, page layout, reading mode. `Aa` is the
              convention Apple Books uses for exactly this grouping. */}
          <PdfBarMenu
            label={<span className="font-medium">Aa</span>}
            title="Zoom, layout & reading mode"
            wide
          >
            {() => (
              <>
                <PdfMenuRow label="Zoom">
                  {/* Presets first, then the stepless controls (− select +)
                      grouped together. Symbols keep the row compact; the labels
                      move into tooltips and aria-labels rather than vanishing. */}
                  <button
                    type="button"
                    className={`zen-pdf-btn ${!customScale && scaleSelect === 'page-fit' ? 'zen-pdf-btn-active' : ''}`}
                    onClick={() => setScaleValue('page-fit')}
                    title="Fit Page"
                    aria-label="Fit Page"
                    aria-pressed={!customScale && scaleSelect === 'page-fit'}
                  >
                    <FitPageIcon width={14} height={14} />
                  </button>
                  <button
                    type="button"
                    className={`zen-pdf-btn ${!customScale && scaleSelect === 'page-width' ? 'zen-pdf-btn-active' : ''}`}
                    onClick={() => setScaleValue('page-width')}
                    title="Fit Width"
                    aria-label="Fit Width"
                    aria-pressed={!customScale && scaleSelect === 'page-width'}
                  >
                    <FitWidthIcon width={14} height={14} />
                  </button>
                  <button
                    type="button"
                    className={`zen-pdf-btn ${!customScale && scaleSelect === 'page-actual' ? 'zen-pdf-btn-active' : ''}`}
                    onClick={() => setScaleValue('page-actual')}
                    title="Actual size (100%)"
                    aria-label="Actual size (100%)"
                    aria-pressed={!customScale && scaleSelect === 'page-actual'}
                  >
                    <span className="font-medium tabular-nums">1:1</span>
                  </button>
                  <button type="button" className="zen-pdf-btn" onClick={zoomOut} title="Zoom out">
                    −
                  </button>
                  <select
                    className="zen-pdf-select tabular-nums"
                    value={customScale ? 'custom' : scaleSelect}
                    onChange={(e) => setScaleValue(e.target.value)}
                    aria-label="Zoom level"
                  >
                    {customScale && <option value="custom">{scalePct}%</option>}
                    <option value="auto">Automatic</option>
                    <option value="0.5">50%</option>
                    <option value="0.75">75%</option>
                    <option value="1.25">125%</option>
                    <option value="1.5">150%</option>
                    <option value="2">200%</option>
                    <option value="3">300%</option>
                  </select>
                  <button type="button" className="zen-pdf-btn" onClick={zoomIn} title="Zoom in">
                    +
                  </button>
                </PdfMenuRow>

                <PdfMenuRow label="Layout">
                  {(
                    [
                      ['single', 'Single'],
                      ['continuous', 'Continuous'],
                      ['two-page', 'Two page']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`zen-pdf-btn ${viewMode === value ? 'zen-pdf-btn-active' : ''}`}
                      aria-pressed={viewMode === value}
                      onClick={() => changeViewMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </PdfMenuRow>

                <PdfMenuRow label="Reading">
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
                </PdfMenuRow>
              </>
            )}
          </PdfBarMenu>
        </div>
      </header>

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
            mode === 'dark' || mode === 'invert'
              ? 'zen-pdf-scroll-dark'
              : mode === 'sepia'
                ? 'zen-pdf-scroll-sepia'
                : ''
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
