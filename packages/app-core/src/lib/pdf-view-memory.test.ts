import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPdfViewMemory,
  forgetPdfView,
  recallPdfView,
  rememberPdfView,
  type PdfViewPosition
} from './pdf-view-memory'

afterEach(() => clearPdfViewMemory())

const position = (overrides: Partial<PdfViewPosition> = {}): PdfViewPosition => ({
  page: 7,
  scrollTop: 3200,
  scrollLeft: 0,
  viewMode: 'two-page',
  scaleValue: 'page-width',
  readingMode: 'sepia',
  ...overrides
})

describe('pdf view memory', () => {
  it('remembers and recalls a position by tab path', () => {
    rememberPdfView('zen://asset/papers%2Fthesis.pdf', position())
    expect(recallPdfView('zen://asset/papers%2Fthesis.pdf')).toEqual(position())
  })

  it('returns undefined for an unseen tab', () => {
    expect(recallPdfView('zen://asset/never.pdf')).toBeUndefined()
  })

  it('overwrites the position on the same tab', () => {
    rememberPdfView('a.pdf', position({ page: 1, scrollTop: 0 }))
    rememberPdfView('a.pdf', position({ page: 42, scrollTop: 9000 }))
    expect(recallPdfView('a.pdf')).toEqual(position({ page: 42, scrollTop: 9000 }))
  })

  it('forgets a single tab', () => {
    rememberPdfView('a.pdf', position())
    forgetPdfView('a.pdf')
    expect(recallPdfView('a.pdf')).toBeUndefined()
  })

  it('ignores an empty tab path', () => {
    rememberPdfView('', position())
    expect(recallPdfView('')).toBeUndefined()
  })

  // The pinned reference pane keys its PdfView as `pinned:<path>` precisely so a
  // PDF that is both pinned and open in a tab stays two independent views. That
  // must hold here too, or the two would fight over one remembered position.
  it('keeps a pinned view and a tab view of the same PDF apart', () => {
    rememberPdfView('zen://asset/a.pdf', position({ page: 3 }))
    rememberPdfView('pinned:a.pdf', position({ page: 88 }))
    expect(recallPdfView('zen://asset/a.pdf')?.page).toBe(3)
    expect(recallPdfView('pinned:a.pdf')?.page).toBe(88)
  })

  it('evicts the least-recently-used entry past the cap', () => {
    // Cap is 20. Insert 21 distinct tabs; the first inserted should be gone.
    for (let i = 0; i < 21; i++) rememberPdfView(`a-${i}.pdf`, position({ page: i }))
    expect(recallPdfView('a-0.pdf')).toBeUndefined()
    expect(recallPdfView('a-20.pdf')?.page).toBe(20)
  })

  it('refreshes LRU order on re-remember so the document being read is not evicted', () => {
    for (let i = 0; i < 20; i++) rememberPdfView(`a-${i}.pdf`, position({ page: i }))
    rememberPdfView('a-0.pdf', position({ page: 999 }))
    rememberPdfView('a-20.pdf', position({ page: 20 }))
    expect(recallPdfView('a-1.pdf')).toBeUndefined()
    expect(recallPdfView('a-0.pdf')?.page).toBe(999)
  })
})
