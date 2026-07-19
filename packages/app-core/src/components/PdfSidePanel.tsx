/**
 * The PDF side of the outline panel: a tabbed container sharing the note
 * outline's slot, width and Cmd+3, so that shortcut always means "show me this
 * document's structure". Contents (the embedded table of contents) and
 * Annotations (every markup annotation in the file) today; thumbnails will join them.
 *
 * Tab state is deliberately split. The *live* selection is per panel, so two
 * split panes showing different PDFs never yank each other's tab around; the
 * `pdfSidePanelTab` preference only seeds a freshly opened panel and records
 * what you last chose. On open the seed is overridden when that tab has
 * nothing in it — a scanned paper has no table of contents, and greeting the
 * user with an empty panel every time would be poor.
 */
import { useEffect, useMemo, useState } from 'react'
import { usePdfOutline } from '../lib/pdf-outline'
import { usePdfAnnotations } from '../lib/pdf-annotations'
import { useStore } from '../store'
import type { PdfSidePanelTab } from '../store'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'
import { PdfOutlineTree } from './PdfOutlineTree'
import { PdfAnnotationList } from './PdfAnnotationList'

interface Props {
  tabPath: string
}

const TAB_LABELS: Record<PdfSidePanelTab, string> = {
  contents: 'Contents',
  annotations: 'Annotations'
}

export function PdfSidePanel({ tabPath }: Props): JSX.Element {
  const outline = usePdfOutline(tabPath)
  const annotations = usePdfAnnotations(tabPath)
  const preferredTab = useStore((s) => s.pdfSidePanelTab)
  const setPreferredTab = useStore((s) => s.setPdfSidePanelTab)
  const width = useStore((s) => s.panelWidths.outline)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('outline', px))

  const [tab, setTab] = useState<PdfSidePanelTab>(preferredTab)
  // Both sources load asynchronously, so "is this tab empty?" is only knowable
  // a beat after mount. Fall back once, when the preferred tab turns out to be
  // empty and the other has something — never afterwards, or it would fight
  // the user's own tab choice.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled || !outline || !annotations) return
    setSettled(true)
    const counts: Record<PdfSidePanelTab, number> = {
      contents: outline.items.length,
      annotations: annotations.entries.length
    }
    if (counts[preferredTab] > 0) return
    const fallback = (Object.keys(counts) as PdfSidePanelTab[]).find((key) => counts[key] > 0)
    if (fallback) setTab(fallback)
  }, [settled, outline, annotations, preferredTab])

  const select = (next: PdfSidePanelTab): void => {
    setTab(next)
    setPreferredTab(next)
  }

  const tabs = useMemo(() => Object.keys(TAB_LABELS) as PdfSidePanelTab[], [])

  return (
    <section
      aria-label="PDF outline"
      style={{ width }}
      className="zen-pdf-side-panel relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
    >
      <PanelResizeHandle onStart={startResize} />
      <div
        role="tablist"
        aria-label="PDF panel sections"
        className="flex shrink-0 items-center gap-1 border-b border-paper-300/70 px-2 py-1"
      >
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => select(key)}
            className={[
              'zen-pdf-side-tab rounded-md px-2 py-1 text-xs',
              tab === key
                ? 'bg-paper-300/70 font-medium text-ink-900'
                : 'text-ink-500 hover:bg-paper-200/70 hover:text-ink-700'
            ].join(' ')}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>
      {tab === 'contents' ? (
        <PdfOutlineTree outline={outline} />
      ) : (
        <PdfAnnotationList annotations={annotations} />
      )}
    </section>
  )
}
