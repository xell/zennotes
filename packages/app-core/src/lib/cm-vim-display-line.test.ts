import { describe, it, expect, vi } from 'vitest'
import { zenMoveByDisplayLine } from './cm-vim-display-line'

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
