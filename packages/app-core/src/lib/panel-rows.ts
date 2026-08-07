/**
 * Row-list panels — the sidebar, note list, connections, comments and outline —
 * all navigate the same way: each row carries a `data-<name>-idx`, the cursor
 * lives in the store, and moving it means finding the rows in visual order,
 * clamping, then scrolling the landing row into view.
 *
 * That mechanism used to exist three times over (VimNav's closures, pane-nav's
 * own copy, and nothing at all for non-Vim mode), which is how the two pane
 * navigations drifted apart in the first place (#477). It lives here once now,
 * so the Vim handlers, pane navigation, and the always-on key handling all
 * agree about where a cursor is and where it goes next.
 */
import { useStore } from '../store'

export type IndexedDatasetKey =
  | 'sidebarIdx'
  | 'notelistIdx'
  | 'connectionsIdx'
  | 'commentsIdx'
  | 'outlineIdx'

/** Panels whose rows are addressed by a numeric cursor held in the store. The
 *  comments panel is deliberately absent: it tracks the active comment by id,
 *  not by row index, so it gets its own pair of helpers below. */
export type RowPanel = 'sidebar' | 'notelist' | 'connections' | 'outline'

export const ROW_PANEL_DEFS: Record<
  RowPanel,
  { selector: string; datasetKey: IndexedDatasetKey }
> = {
  sidebar: { selector: '[data-sidebar-idx]', datasetKey: 'sidebarIdx' },
  notelist: { selector: '[data-notelist-idx]', datasetKey: 'notelistIdx' },
  connections: { selector: '[data-connections-idx]', datasetKey: 'connectionsIdx' },
  outline: { selector: '[data-outline-idx]', datasetKey: 'outlineIdx' }
}

export function isRowPanel(panel: string | null | undefined): panel is RowPanel {
  return !!panel && panel in ROW_PANEL_DEFS
}

/** Rows currently on screen, in the order they are rendered (top to bottom,
 *  then left to right), falling back to the assigned index within a row. */
export function getIndexedElements(
  selector: string,
  datasetKey: IndexedDatasetKey
): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((el) => el.getClientRects().length > 0)
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect()
      const bRect = b.getBoundingClientRect()
      const rowDelta = aRect.top - bRect.top

      // Follow the actual rendered row order first, then fall back
      // to the assigned index for stable ordering within the same row.
      if (Math.abs(rowDelta) > 2) return rowDelta

      const colDelta = aRect.left - bRect.left
      if (Math.abs(colDelta) > 2) return colDelta

      return getIndexedValue(a, datasetKey) - getIndexedValue(b, datasetKey)
    })
}

export function getIndexedValue(
  el: HTMLElement | null,
  datasetKey: IndexedDatasetKey
): number {
  const value = Number(el?.dataset[datasetKey] ?? -1)
  return Number.isFinite(value) ? value : -1
}

export function getIndexedElementByIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  index: number
): HTMLElement | undefined {
  return items.find((item) => getIndexedValue(item, datasetKey) === index)
}

/** Position in the sorted rows for a stored cursor index (no DOM focus needed).
 *  Clamps when the index is gone — a collapsed parent, an edited-away heading. */
export function findPositionByIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  cursorIndex: number
): number {
  const exact = items.findIndex((item) => getIndexedValue(item, datasetKey) === cursorIndex)
  if (exact >= 0) return exact
  return items.length === 0 ? 0 : Math.max(0, Math.min(cursorIndex, items.length - 1))
}

/** Update the cursor index and scroll the element into view. */
export function scrollToIndexedElement(
  el: HTMLElement | undefined,
  datasetKey: IndexedDatasetKey,
  setIndex: (idx: number) => void
): void {
  if (!el) return
  const idx = getIndexedValue(el, datasetKey)
  if (idx < 0) return
  setIndex(idx)
  el.scrollIntoView({ block: 'nearest' })
}

export function scrollToIndexedIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  index: number,
  setIndex: (idx: number) => void
): void {
  const target = getIndexedElementByIndex(items, datasetKey, index)
  setIndex(index)
  target?.scrollIntoView({ block: 'nearest' })
}

/** The store cursor behind a row panel, read and write. */
export function rowCursor(
  panel: RowPanel,
  state: ReturnType<typeof useStore.getState>
): { index: number; setIndex: (idx: number) => void } {
  switch (panel) {
    case 'sidebar':
      return { index: state.sidebarCursorIndex, setIndex: state.setSidebarCursorIndex }
    case 'notelist':
      return { index: state.noteListCursorIndex, setIndex: state.setNoteListCursorIndex }
    case 'connections':
      return { index: state.connectionsCursorIndex, setIndex: state.setConnectionsCursorIndex }
    case 'outline':
      return { index: state.outlineCursorIndex, setIndex: state.setOutlineCursorIndex }
  }
}

export type CursorMove = 'up' | 'down' | 'first' | 'last'

/**
 * Move a row panel's cursor and scroll the landing row into view. Returns false
 * when the panel has no rows, so callers can leave the key unhandled rather than
 * swallowing it.
 */
export function movePanelCursor(panel: RowPanel, move: CursorMove): boolean {
  const state = useStore.getState()
  const { selector, datasetKey } = ROW_PANEL_DEFS[panel]
  const items = getIndexedElements(selector, datasetKey)
  if (items.length === 0) return false
  const { index, setIndex } = rowCursor(panel, state)
  const current = findPositionByIndex(items, datasetKey, index)
  const next =
    move === 'up'
      ? Math.max(current - 1, 0)
      : move === 'down'
        ? Math.min(current + 1, items.length - 1)
        : move === 'first'
          ? 0
          : items.length - 1
  scrollToIndexedElement(items[next], datasetKey, setIndex)
  return true
}

/** Activate the row under the cursor by clicking it — the row itself owns what
 *  "open" means (jump to a heading, open a note, reveal a comment). */
export function activatePanelRow(panel: RowPanel): boolean {
  const state = useStore.getState()
  const { selector, datasetKey } = ROW_PANEL_DEFS[panel]
  const items = getIndexedElements(selector, datasetKey)
  if (items.length === 0) return false
  const { index } = rowCursor(panel, state)
  const row = items[findPositionByIndex(items, datasetKey, index)]
  if (!row) return false
  row.click()
  return true
}

// ---------------------------------------------------------------------------
// Comments — same rows, but the cursor is the active comment's id
// ---------------------------------------------------------------------------

const COMMENT_ROW_SELECTOR = '[data-comments-idx]'

function getCommentRows(): HTMLElement[] {
  return getIndexedElements(COMMENT_ROW_SELECTOR, 'commentsIdx')
}

function commentPosition(items: HTMLElement[], activeCommentId: string | null): number {
  if (items.length === 0 || !activeCommentId) return 0
  const exact = items.findIndex((item) => item.dataset.commentId === activeCommentId)
  return exact >= 0 ? exact : 0
}

/** Move the comments panel's selection, mirroring `movePanelCursor`. */
export function moveCommentCursor(move: CursorMove): boolean {
  const state = useStore.getState()
  const items = getCommentRows()
  if (items.length === 0) return false
  const current = commentPosition(items, state.activeCommentId)
  const next =
    move === 'up'
      ? Math.max(current - 1, 0)
      : move === 'down'
        ? Math.min(current + 1, items.length - 1)
        : move === 'first'
          ? 0
          : items.length - 1
  const el = items[next]
  if (!el) return false
  const commentId = el.dataset.commentId
  if (commentId) state.setActiveCommentId(commentId)
  el.scrollIntoView({ block: 'nearest' })
  return true
}
