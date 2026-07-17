import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// Vite `?url` import — the worker ships as a separate ESM file that PDF.js
// runs off the main thread. Without it PDF.js falls back to a slow,
// deprecated fake-worker on the main thread. `vite/client` (in app-core's
// tsconfig `types`) provides the `*?url` module declaration.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// The three reading modes. `light` is the untouched page. `dark` uses
// PDF.js's render-time `pageColors`, which recolours the default page
// background and default (black) text during rasterisation while leaving
// embedded raster images intact — the images-preserved dark mode that
// motivated choosing PDF.js. `invert` is the coarse fallback: a CSS filter
// over the whole page layer, which also negates images, offered for
// documents whose colour cannot be themed by `pageColors` alone.
export type PdfReadingMode = 'light' | 'dark' | 'invert'

// Sourced to feel close to the app's own dark chrome. A later pass can read
// these from live CSS variables so the PDF background tracks the theme.
const DARK_PAGE_COLORS = { background: '#1f1f22', foreground: '#d6d3cc' } as const

const MIN_SCALE = 0.4
const MAX_SCALE = 4
const SCALE_STEP = 0.2
const DEFAULT_SCALE = 1.2

interface RenderedPage {
  pageNumber: number
  wrapper: HTMLDivElement
  canvas: HTMLCanvasElement
  textLayerDiv: HTMLDivElement
}

/**
 * A PDF.js backed viewer that replaces the plain Chromium iframe for `.pdf`
 * asset tabs. This first iteration delivers reading: page rendering, a
 * selectable text layer, zoom, and the three reading modes. Highlight
 * authoring (AnnotationEditorLayer) and sidecar persistence land in a
 * follow-up — see data/pdf.md.
 */
export function PdfView({ assetUrl, title }: { assetUrl: string; title: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  // Guards against overlapping render passes (mode/zoom changed mid-render)
  // and against a render landing after the component unmounts.
  const renderTokenRef = useRef(0)

  const [mode, setMode] = useState<PdfReadingMode>('light')
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [numPages, setNumPages] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const pageColors = mode === 'dark' ? DARK_PAGE_COLORS : undefined

  // Load (or reload) the document whenever the source URL changes.
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMessage(null)

    // The custom `zen-asset://` protocol may not honour HTTP range
    // requests, so fetch the whole file and hand PDF.js the bytes rather
    // than a URL it would try to range-stream.
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(assetUrl)
        if (!response.ok) throw new Error(`Failed to load PDF (${response.status})`)
        const data = new Uint8Array(await response.arrayBuffer())
        if (cancelled) return
        const doc = await pdfjs.getDocument({ data }).promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        docRef.current = doc
        setNumPages(doc.numPages)
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        console.error('PdfView: failed to load document', err)
        setErrorMessage(err instanceof Error ? err.message : 'Could not open this PDF.')
        setStatus('error')
      }
    }
    void load()

    return () => {
      cancelled = true
      const doc = docRef.current
      docRef.current = null
      if (doc) void doc.destroy()
    }
  }, [assetUrl])

  // Render every page into the pages container. Re-runs on document load and
  // whenever scale or reading mode changes (dark mode is a render-time
  // property, so it needs a re-raster, not just a CSS toggle).
  const renderAllPages = useCallback(async (): Promise<void> => {
    const doc = docRef.current
    const container = pagesRef.current
    if (!doc || !container) return

    const token = ++renderTokenRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    // Clear any previously rendered pages.
    container.replaceChildren()

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (token !== renderTokenRef.current) return
      let page
      try {
        page = await doc.getPage(pageNumber)
      } catch (err) {
        console.error(`PdfView: getPage(${pageNumber}) failed`, err)
        continue
      }
      if (token !== renderTokenRef.current) return

      const viewport = page.getViewport({ scale })
      const rendered = buildPageShell(pageNumber, viewport.width, viewport.height, scale)
      container.append(rendered.wrapper)

      const canvas = rendered.canvas
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue

      try {
        await page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          ...(pageColors ? { pageColors } : {})
        }).promise
      } catch (err) {
        console.error(`PdfView: render page ${pageNumber} failed`, err)
        continue
      }
      if (token !== renderTokenRef.current) return

      // Selectable text layer. Wrapped defensively: a text-layer failure
      // must not blank the (already painted) page canvas.
      try {
        const textContent = await page.getTextContent()
        if (token !== renderTokenRef.current) return
        const textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: rendered.textLayerDiv,
          viewport
        })
        await textLayer.render()
      } catch (err) {
        console.error(`PdfView: text layer page ${pageNumber} failed`, err)
      }
    }
  }, [scale, pageColors])

  useEffect(() => {
    if (status !== 'ready') return
    void renderAllPages()
  }, [status, renderAllPages])

  const zoomIn = useCallback(() => setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2))), [])
  const zoomOut = useCallback(() => setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2))), [])
  const zoomReset = useCallback(() => setScale(DEFAULT_SCALE), [])

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
        <div className="zen-pdf-zoom ml-auto flex items-center gap-1">
          <button type="button" className="zen-pdf-btn" onClick={zoomOut} title="Zoom out">
            −
          </button>
          <button
            type="button"
            className="zen-pdf-btn zen-pdf-zoom-level tabular-nums"
            onClick={zoomReset}
            title="Reset zoom"
          >
            {Math.round(scale * 100)}%
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

      <div
        ref={scrollRef}
        className={`zen-pdf-scroll min-h-0 min-w-0 flex-1 overflow-auto ${
          mode === 'light' ? '' : 'zen-pdf-scroll-dark'
        }`}
      >
        {status === 'loading' && (
          <div className="flex h-full items-center justify-center text-sm text-ink-400">
            Loading {title}…
          </div>
        )}
        {status === 'error' && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-400">
            {errorMessage ?? 'Could not open this PDF.'}
          </div>
        )}
        <div
          ref={pagesRef}
          className={`zen-pdf-pages ${mode === 'invert' ? 'zen-pdf-pages-invert' : ''}`}
          style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
      </div>
    </div>
  )
}

/**
 * Build the per-page DOM: a positioned wrapper holding the canvas and, above
 * it, the transparent text layer. The `--scale-factor` CSS variable is
 * required by PDF.js's TextLayer to place text spans correctly.
 */
function buildPageShell(
  pageNumber: number,
  cssWidth: number,
  cssHeight: number,
  scale: number
): RenderedPage {
  const wrapper = document.createElement('div')
  wrapper.className = 'zen-pdf-page'
  wrapper.dataset.pageNumber = String(pageNumber)
  wrapper.style.width = `${Math.floor(cssWidth)}px`
  wrapper.style.height = `${Math.floor(cssHeight)}px`
  wrapper.style.setProperty('--scale-factor', String(scale))

  const canvas = document.createElement('canvas')
  canvas.className = 'zen-pdf-canvas'
  canvas.style.width = `${Math.floor(cssWidth)}px`
  canvas.style.height = `${Math.floor(cssHeight)}px`

  const textLayerDiv = document.createElement('div')
  textLayerDiv.className = 'zen-pdf-textlayer textLayer'

  wrapper.append(canvas, textLayerDiv)
  return { pageNumber, wrapper, canvas, textLayerDiv }
}
