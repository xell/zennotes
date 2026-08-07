// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => ({
  state: {
    outlineCursorIndex: 0,
    connectionsCursorIndex: 0,
    sidebarCursorIndex: 0,
    noteListCursorIndex: 0,
    activeCommentId: null as string | null,
    setOutlineCursorIndex: (idx: number) => {
      storeMock.state.outlineCursorIndex = idx
    },
    setConnectionsCursorIndex: (idx: number) => {
      storeMock.state.connectionsCursorIndex = idx
    },
    setSidebarCursorIndex: (idx: number) => {
      storeMock.state.sidebarCursorIndex = idx
    },
    setNoteListCursorIndex: (idx: number) => {
      storeMock.state.noteListCursorIndex = idx
    },
    setActiveCommentId: (id: string | null) => {
      storeMock.state.activeCommentId = id
    }
  }
}))

vi.mock('../store', () => ({
  useStore: { getState: () => storeMock.state }
}))

import {
  activatePanelRow,
  findPositionByIndex,
  getIndexedElements,
  isRowPanel,
  moveCommentCursor,
  movePanelCursor
} from './panel-rows'

/** jsdom has no layout: every element reports no client rects (which the row
 *  scan reads as "not on screen") and a zero bounding box. Stack the rows
 *  vertically by hand so they sort the way real rows do. */
function layOutRows(): void {
  document.querySelectorAll<HTMLElement>('[data-outline-idx],[data-connections-idx],[data-comments-idx]')
    .forEach((el, i) => {
      el.getClientRects = (() => [{ width: 200, height: 24 }] as unknown as DOMRectList) as never
      el.getBoundingClientRect = (() =>
        ({ top: i * 24, bottom: i * 24 + 24, left: 0, right: 200, width: 200, height: 24 }) as DOMRect) as never
      el.scrollIntoView = (() => {}) as never
    })
}

function renderRows(attr: string, count: number, extra = ''): void {
  document.body.innerHTML = Array.from(
    { length: count },
    (_, i) => `<button ${attr}="${i}" ${extra ? extra.replace('%i', String(i)) : ''}>row ${i}</button>`
  ).join('')
  layOutRows()
}

beforeEach(() => {
  document.body.innerHTML = ''
  storeMock.state.outlineCursorIndex = 0
  storeMock.state.connectionsCursorIndex = 0
  storeMock.state.activeCommentId = null
})

describe('panel row cursors (#477 follow-up)', () => {
  it('knows which panels are row lists', () => {
    expect(isRowPanel('outline')).toBe(true)
    expect(isRowPanel('connections')).toBe(true)
    // Comments track the active comment by id, calendar owns its own keys.
    expect(isRowPanel('comments')).toBe(false)
    expect(isRowPanel('calendar')).toBe(false)
    expect(isRowPanel(null)).toBe(false)
  })

  it('moves the cursor down and up, stopping at both ends', () => {
    renderRows('data-outline-idx', 3)
    expect(movePanelCursor('outline', 'down')).toBe(true)
    expect(storeMock.state.outlineCursorIndex).toBe(1)
    movePanelCursor('outline', 'down')
    movePanelCursor('outline', 'down')
    expect(storeMock.state.outlineCursorIndex).toBe(2) // clamped at the last row
    movePanelCursor('outline', 'up')
    expect(storeMock.state.outlineCursorIndex).toBe(1)
    movePanelCursor('outline', 'up')
    movePanelCursor('outline', 'up')
    expect(storeMock.state.outlineCursorIndex).toBe(0) // clamped at the first row
  })

  it('jumps to the first and last rows', () => {
    renderRows('data-outline-idx', 5)
    movePanelCursor('outline', 'last')
    expect(storeMock.state.outlineCursorIndex).toBe(4)
    movePanelCursor('outline', 'first')
    expect(storeMock.state.outlineCursorIndex).toBe(0)
  })

  it('reports no move when the panel has no rows, so the key stays unhandled', () => {
    expect(movePanelCursor('outline', 'down')).toBe(false)
    expect(activatePanelRow('outline')).toBe(false)
  })

  it('re-seats a cursor left past the end of a shrunken list', () => {
    renderRows('data-outline-idx', 2)
    storeMock.state.outlineCursorIndex = 7 // headings were edited away while we were gone
    const items = getIndexedElements('[data-outline-idx]', 'outlineIdx')
    expect(findPositionByIndex(items, 'outlineIdx', 7)).toBe(1)
    movePanelCursor('outline', 'up')
    expect(storeMock.state.outlineCursorIndex).toBe(0)
  })

  it('activates the row under the cursor by clicking it', () => {
    renderRows('data-outline-idx', 3)
    const clicked: number[] = []
    document.querySelectorAll<HTMLElement>('[data-outline-idx]').forEach((el) => {
      el.addEventListener('click', () => clicked.push(Number(el.dataset.outlineIdx)))
    })
    storeMock.state.outlineCursorIndex = 2
    expect(activatePanelRow('outline')).toBe(true)
    expect(clicked).toEqual([2])
  })

  it('keeps each panel on its own cursor', () => {
    document.body.innerHTML = `
      <button data-outline-idx="0">h1</button>
      <button data-outline-idx="1">h2</button>
      <button data-connections-idx="0">note a</button>
      <button data-connections-idx="1">note b</button>
    `
    layOutRows()
    movePanelCursor('outline', 'down')
    expect(storeMock.state.outlineCursorIndex).toBe(1)
    expect(storeMock.state.connectionsCursorIndex).toBe(0)
    movePanelCursor('connections', 'down')
    expect(storeMock.state.connectionsCursorIndex).toBe(1)
    expect(storeMock.state.outlineCursorIndex).toBe(1)
  })

  it('moves the comments selection by comment id', () => {
    renderRows('data-comments-idx', 3, 'data-comment-id="c%i"')
    expect(moveCommentCursor('down')).toBe(true)
    expect(storeMock.state.activeCommentId).toBe('c1')
    moveCommentCursor('down')
    moveCommentCursor('down')
    expect(storeMock.state.activeCommentId).toBe('c2')
    moveCommentCursor('first')
    expect(storeMock.state.activeCommentId).toBe('c0')
  })
})
