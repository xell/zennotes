import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { mathRenderExtension } from './cm-math-render'
import {
  zenMoveByDisplayLine,
  zenMoveToDisplayLineBoundary,
  zenMoveToViewportEdge
} from './cm-vim-display-line'

type Cm = Parameters<typeof zenMoveByDisplayLine>[0]
type MotionArgs = Parameters<typeof zenMoveByDisplayLine>[2]
type VimState = Parameters<typeof zenMoveByDisplayLine>[3]

// Drive the motion with a mock CodeMirror-Vim adapter. `findPosV` is the
// display-line move — spying on it tells us whether the display path (bare j/k)
// or the logical fallback (count / operator / visual) was taken.
function run(
  args: MotionArgs,
  vim: VimState = {},
  head: { line: number; ch: number } = { line: 10, ch: 3 }
): { res: { line: number; ch: number }; findPosV: ReturnType<typeof vi.fn> } {
  const findPosV = vi.fn(() => ({ line: 99, ch: 7 }))
  const cm = {
    firstLine: () => 0,
    lastLine: () => 100,
    findPosV,
    charCoords: () => ({ left: 42 })
  } as unknown as Cm
  const res = zenMoveByDisplayLine(cm, head, args, vim)
  return { res, findPosV }
}

describe('zenMoveByDisplayLine (#290 display-line j/k, #314 count fallback)', () => {
  it('a bare j (no count) moves by display line via findPosV', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1, repeatIsExplicit: false })
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(99) // the display-move sentinel
  })

  it('an explicit count (3j) moves by LOGICAL lines, not display rows (#314)', () => {
    const { res, findPosV } = run({ forward: true, repeat: 3, repeatIsExplicit: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(13) // 10 + 3 logical lines — matches the relativenumber gutter
    expect(res.ch).toBe(3) // keeps the column
  })

  it('an explicit count upward (4k) moves logical lines up (#314)', () => {
    const { res, findPosV } = run({ forward: false, repeat: 4, repeatIsExplicit: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(6) // 10 - 4
  })

  it('an operator-pending motion (dj) stays logical', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1 }, { inputState: { operator: {} } })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(11)
  })

  it('a visual-line selection (Vj) stays logical', () => {
    const { res, findPosV } = run({ forward: true, repeat: 1 }, { visualLine: true })
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(11)
  })

  it('a logical count clamps to the document bounds', () => {
    const { res } = run(
      { forward: false, repeat: 10, repeatIsExplicit: true },
      {},
      { line: 2, ch: 0 }
    )
    expect(res.line).toBe(0) // clamped to firstLine
  })
})

describe('zenMoveByDisplayLine around rendered block math', () => {
  // 0-based lines: 0 `alpha`, 1 ``, 2 `$$`, 3 `x+1`, 4 `$$`, 5 ``, 6 `omega`.
  const MATH_DOC = 'alpha\n\n$$\nx+1\n$$\n\nomega'

  function runWithDoc(
    doc: string,
    head: { line: number; ch: number },
    args: MotionArgs,
    findPosVResult: { line: number; ch: number }
  ): { res: { line: number; ch: number }; findPosV: ReturnType<typeof vi.fn> } {
    const state = EditorState.create({ doc, extensions: [mathRenderExtension('katex')] })
    const findPosV = vi.fn(() => findPosVResult)
    const cm = {
      firstLine: () => 0,
      lastLine: () => state.doc.lines - 1,
      findPosV,
      charCoords: () => ({ left: 42 }),
      cm6: { state } as unknown as EditorView
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, head, args, {})
    return { res, findPosV }
  }

  it('bare j steps logically into the block from the line above', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 1, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 5, ch: 0 } // what the pixel skip would have produced
    )
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(2) // the opening $$
  })

  it('bare k steps logically into the block from the line below', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 5, ch: 0 },
      { forward: false, repeat: 1 },
      { line: 1, ch: 0 }
    )
    expect(findPosV).not.toHaveBeenCalled()
    expect(res.line).toBe(4) // the closing $$
  })

  it('inside the (revealed) block the display path still applies', () => {
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 2, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 3, ch: 0 } // a sane one-row move within visible source
    )
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(3)
  })

  it('snaps an overshooting pixel move back to one logical step when it skipped a block', () => {
    // e.g. launched off a heading with large CSS margins: findPosV leaps from
    // line 0 clean past the widget to line 6.
    const { res, findPosV } = runWithDoc(
      MATH_DOC,
      { line: 0, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 6, ch: 0 }
    )
    expect(findPosV).toHaveBeenCalledTimes(1)
    expect(res.line).toBe(1) // the blank line above the block, not past it
  })

  it('leaves overshoots alone when no math block was skipped', () => {
    const { res } = runWithDoc(
      'plain\ntext\nonly\nhere\nnow',
      { line: 0, ch: 0 },
      { forward: true, repeat: 1 },
      { line: 3, ch: 0 }
    )
    expect(res.line).toBe(3) // non-math skips (tables, folds) keep today's behavior
  })
})

describe('zenMoveByDisplayLine no-progress fallback (#423)', () => {
  // Simulate the pixel motion failing to advance across a soft-wrap boundary
  // (sub-pixel-imprecise coords, e.g. under fractional display scaling):
  // findPosV returns the same head, which used to leave k/j stuck.
  function runStuck(head: { line: number; ch: number }, forward: boolean): { line: number; ch: number } {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => ({ line: head.line, ch: head.ch }),
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    return zenMoveByDisplayLine(cm, head, { forward, repeat: 1 }, {})
  }

  it('a k that fails to advance falls back to a logical step up', () => {
    const res = runStuck({ line: 50, ch: 10 }, false)
    expect(res.line).toBe(49)
    expect(res.ch).toBe(10)
  })

  it('a j that fails to advance falls back to a logical step down', () => {
    const res = runStuck({ line: 50, ch: 10 }, true)
    expect(res.line).toBe(51)
  })

  it('does not fabricate movement above the first line', () => {
    const res = runStuck({ line: 0, ch: 5 }, false)
    expect(res.line).toBe(0)
    expect(res.ch).toBe(5)
  })

  it('does not fabricate movement below the last line', () => {
    const res = runStuck({ line: 100, ch: 5 }, true)
    expect(res.line).toBe(100)
  })

  it('keeps the display-line result when it advances up a wrapped row', () => {
    // Same logical line, smaller ch → a real one-row move; no fallback.
    const cm = {
      firstLine: () => 0,
      lastLine: () => 100,
      findPosV: () => ({ line: 50, ch: 3 }),
      charCoords: () => ({ left: 42 })
    } as unknown as Cm
    const res = zenMoveByDisplayLine(cm, { line: 50, ch: 10 }, { forward: false, repeat: 1 }, {})
    expect(res.line).toBe(50)
    expect(res.ch).toBe(3)
  })
})

describe('wrapped display-row boundaries (#536)', () => {
  it('moves $ to the end of the current display row', () => {
    let cursor = { line: 4, ch: 7, sticky: 'before' }
    const cm = {
      execCommand: (command: string) => {
        expect(command).toBe('goLineRight')
        cursor = { line: 4, ch: 23, sticky: 'before' }
      },
      getCursor: () => cursor
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 4, ch: 22 })
  })

  it('moves I to the start of the current display row', () => {
    const cm = {
      execCommand: vi.fn(),
      getCursor: vi.fn(),
      charCoords: vi.fn(() => ({ left: 180, top: 40, bottom: 60 })),
      coordsChar: vi.fn(() => ({ line: 4, ch: 18 }))
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 30 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 4, ch: 18 })
    expect(cm.coordsChar).toHaveBeenCalledWith({ left: 0, top: 50 }, 'div')
    expect(cm.execCommand).not.toHaveBeenCalled()
  })

  it('keeps counted $ on logical lines', () => {
    const cm = {
      firstLine: () => 0,
      lastLine: () => 20,
      execCommand: vi.fn(),
      getCursor: vi.fn()
    }

    expect(
      zenMoveToDisplayLineBoundary(cm, { line: 4, ch: 7 }, { forward: true, repeat: 3 })
    ).toEqual({ line: 6, ch: Infinity })
    expect(cm.execCommand).not.toHaveBeenCalled()
  })
})

describe('repeatable viewport H/L (#513)', () => {
  function viewportCm() {
    return {
      firstLine: () => 0,
      lastLine: () => 99,
      getScrollInfo: () => ({ top: 100, clientHeight: 220 }),
      coordsChar: ({ top }: { top: number }) =>
        top < 200 ? { line: 10, ch: 0 } : { line: 20, ch: 0 },
      getLine: (line: number) => (line === 10 || line === 20 ? '  edge' : ' next'),
      findPosV: (
        start: { line: number; ch: number },
        amount: number
      ): { line: number; ch: number } => ({ line: start.line + amount, ch: start.ch })
    }
  }

  it('H first reaches the top visible line', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 15, ch: 4 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 10, ch: 2 })
  })

  it('a second H steps above the edge so the viewport keeps scrolling', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 10, ch: 2 }, { forward: false, repeat: 1 })
    ).toEqual({ line: 9, ch: 1 })
  })

  it('a second L steps below the edge so the viewport keeps scrolling', () => {
    expect(
      zenMoveToViewportEdge(viewportCm(), { line: 20, ch: 2 }, { forward: true, repeat: 1 })
    ).toEqual({ line: 21, ch: 1 })
  })
})
