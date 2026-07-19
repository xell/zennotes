/**
 * Table-of-contents panel for a PDF tab — the counterpart to `OutlinePanel`,
 * which reads markdown headings from a note body. Both sit in the same slot in
 * EditorPane and share the panel chrome (width, resize handle), so `Cmd+3`
 * means "show me this document's structure" whichever kind of tab is open.
 *
 * The tree comes from `pdfDocument.getOutline()` (published by the open PdfView
 * via the pdf-outline registry) rather than from any PDF.js UI: its
 * `PDFOutlineViewer` lives in the full viewer application, which `pdfjs-dist`
 * does not ship.
 */
import { useMemo, useState } from 'react'
import { usePdfOutline, type PdfOutlineItem } from '../lib/pdf-outline'
import { useStore } from '../store'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'

interface Props {
  /** Tab path of the PDF whose outline to show. */
  tabPath: string
}

interface FlatRow {
  item: PdfOutlineItem
  depth: number
  key: string
}

/** Depth-first flatten, keeping only branches whose subtree is expanded. */
function flatten(
  items: PdfOutlineItem[],
  collapsed: Set<string>,
  depth = 0,
  prefix = ''
): FlatRow[] {
  const rows: FlatRow[] = []
  items.forEach((item, index) => {
    const key = `${prefix}${index}`
    rows.push({ item, depth, key })
    if (item.items.length > 0 && !collapsed.has(key)) {
      rows.push(...flatten(item.items, collapsed, depth + 1, `${key}.`))
    }
  })
  return rows
}

/** Every entry, ignoring collapse state — used while filtering, where hiding
 *  matches inside a collapsed parent would look like the search was broken. */
function flattenAll(items: PdfOutlineItem[], depth = 0, prefix = ''): FlatRow[] {
  const rows: FlatRow[] = []
  items.forEach((item, index) => {
    const key = `${prefix}${index}`
    rows.push({ item, depth, key })
    rows.push(...flattenAll(item.items, depth + 1, `${key}.`))
  })
  return rows
}

export function PdfOutlinePanel({ tabPath }: Props): JSX.Element {
  const outline = usePdfOutline(tabPath)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const width = useStore((s) => s.panelWidths.outline)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('outline', px))

  const items = outline?.items ?? []
  const trimmed = query.trim().toLowerCase()

  const rows = useMemo(() => {
    if (!trimmed) return flatten(items, collapsed)
    return flattenAll(items).filter((row) => row.item.title.toLowerCase().includes(trimmed))
  }, [items, collapsed, trimmed])

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section
      aria-label="PDF outline"
      style={{ width }}
      className="zen-pdf-outline relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
    >
      <PanelResizeHandle onStart={startResize} />
      <div className="shrink-0 border-b border-paper-300/70 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter contents…"
          className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-ink-400">
            {outline ? 'This PDF has no table of contents.' : 'Loading…'}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-ink-400">No matching entries.</div>
        ) : (
          <ul>
            {rows.map((row) => {
              const hasChildren = row.item.items.length > 0
              const isCollapsed = collapsed.has(row.key)
              return (
                <li key={row.key}>
                  <div
                    className="group flex items-center gap-1 pr-2 text-left"
                    style={{ paddingLeft: `${6 + row.depth * 12}px` }}
                  >
                    {/* Filtering flattens the tree, so twisties would be
                        meaningless there — keep the row aligned instead. */}
                    {hasChildren && !trimmed ? (
                      <button
                        type="button"
                        aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                        onClick={() => toggle(row.key)}
                        className="shrink-0 rounded px-1 text-ink-400 hover:text-ink-700"
                      >
                        {isCollapsed ? '›' : '⌄'}
                      </button>
                    ) : (
                      <span className="shrink-0 px-1 text-transparent">·</span>
                    )}
                    <button
                      type="button"
                      onClick={() => outline?.goTo(row.item)}
                      title={row.item.title}
                      className="min-w-0 flex-1 truncate py-1 text-left text-sm text-ink-700 hover:text-ink-900"
                      style={{
                        fontWeight: row.item.bold ? 600 : undefined,
                        fontStyle: row.item.italic ? 'italic' : undefined
                      }}
                    >
                      {row.item.title || '(untitled)'}
                      {row.item.url && <span className="ml-1 text-ink-400">↗</span>}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
