import { CodeMirror, Vim } from '@replit/codemirror-vim'

// Minimal shape of the CodeMirror-Vim adapter + state the display-line motion
// touches (the package's own types don't surface these helpers).
type VimMotionCm = {
  firstLine: () => number
  lastLine: () => number
  findPosV: (
    start: { line: number; ch: number },
    amount: number,
    unit: string,
    goalColumn?: number
  ) => { line: number; ch: number }
  charCoords: (pos: { line: number; ch: number }, mode: string) => { left: number }
}
type VimMotionState = {
  visualLine?: boolean
  visualBlock?: boolean
  lastMotion?: unknown
  lastHSPos?: number
  lastHPos?: number
  inputState?: { operator?: unknown }
}

/**
 * `j`/`k` motion that moves by *visual* (display) line through soft-wrapped
 * content instead of skipping to the next logical line (#290). With wrapping on
 * by default, this matches the arrow keys and most GUI editors. Line-wise
 * behavior is preserved where it matters:
 *  - operators (`dj`/`yj`/`cj`) resolve in Vim's `operatorPending` context, so
 *    our normal/visual `j`/`k` mappings never reach them — they keep the default
 *    logical motion;
 *  - line/block visual selections (`Vj`, `<C-v>j`) fall back to whole-logical-
 *    line movement here so the selection grows a logical line at a time;
 *  - an explicit count (`3j`, `5k`) falls back to logical movement so the jump
 *    lands on the line the relativenumber gutter shows — those numbers count
 *    logical lines, so `{count}j` must too, not display rows (#314). This is the
 *    classic `v:count == 0 ? gj : j` idiom; a bare `j`/`k` still moves by display
 *    line.
 * `gj`/`gk` are untouched. Mirrors codemirror-vim's own `moveByDisplayLines`,
 * including maintaining the horizontal goal column across consecutive presses.
 */
export function zenMoveByDisplayLine(
  cm: VimMotionCm,
  head: { line: number; ch: number },
  motionArgs: { forward?: boolean; repeat?: number; repeatIsExplicit?: boolean },
  vim: VimMotionState
): { line: number; ch: number } {
  const forward = !!motionArgs.forward
  const repeat = motionArgs.repeat || 1
  if (
    vim.visualLine ||
    vim.visualBlock ||
    vim.inputState?.operator ||
    motionArgs.repeatIsExplicit
  ) {
    const target = Math.max(
      cm.firstLine(),
      Math.min(cm.lastLine(), forward ? head.line + repeat : head.line - repeat)
    )
    return new CodeMirror.Pos(target, head.ch)
  }
  // Keep the horizontal goal column stable across consecutive j/k, like gj/gk.
  if (vim.lastMotion !== zenMoveByDisplayLine) {
    vim.lastHSPos = cm.charCoords(head, 'div').left
  }
  const res = cm.findPosV(head, forward ? repeat : -repeat, 'line', vim.lastHSPos)
  vim.lastHPos = res.ch
  return res
}

let displayLineMotionRegistered = false

/**
 * Register the #290 display-line `j`/`k` motion on the (per-window) global Vim.
 * The main editor (Editor.tsx) and the Quick Note window (QuickCaptureApp) live
 * in separate Electron renderers, each with its own Vim singleton, so both must
 * call this for `j`/`k` to move by visual line in either (#312). Mapped only in
 * normal + visual contexts, so operator-pending motions (dj/yj/cj) keep Vim's
 * default logical movement. Idempotent — safe to call once per renderer / on HMR.
 */
export function registerDisplayLineMotion(): void {
  if (displayLineMotionRegistered) return
  displayLineMotionRegistered = true
  // The package's MotionFn type is looser/different than our precise params; the
  // runtime contract (cm, head, motionArgs, vim) → position is correct.
  Vim.defineMotion(
    'zenMoveByDisplayLine',
    zenMoveByDisplayLine as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  for (const context of ['normal', 'visual'] as const) {
    Vim.mapCommand(
      'j',
      'motion',
      'zenMoveByDisplayLine',
      { forward: true, linewise: true },
      { context }
    )
    Vim.mapCommand(
      'k',
      'motion',
      'zenMoveByDisplayLine',
      { forward: false, linewise: true },
      { context }
    )
  }
}
