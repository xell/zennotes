import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * A Vim-style `scrolloff`: keep at least `lines` rows visible above and below
 * the cursor, so it never sits against the top or bottom edge of the editor
 * (issue #305). When the cursor moves within `lines` of an edge, the view
 * scrolls just enough to restore the margin; manual scrolling is untouched
 * until the next cursor move.
 *
 * The repositioning runs inside CodeMirror's own measure cycle (via
 * `requestMeasure`) and adjusts `scrollTop` directly, rather than dispatching a
 * separate, microtask-deferred `scrollIntoView` transaction. The old approach
 * landed its scroll a frame after the keystroke that caused it, and issued an
 * extra transaction on every cursor move, which made the viewport visibly
 * jitter while typing (#420). Doing the adjustment in the same measure pass
 * keeps the scroll in the same frame and touches nothing when no scroll is
 * needed.
 *
 * The effective margin is capped at (just under) half the visible height: in a
 * short editor (e.g. a split pane) a margin taller than half the viewport can't
 * be satisfied above and below at once, so the two constraints used to fight
 * each other. Capping keeps the cursor comfortably centred instead, matching
 * how Vim clamps a large `scrolloff` to the window.
 *
 * Returns an empty extension when disabled (`lines <= 0`), so it costs nothing
 * unless the user opts in.
 */
export function scrollOff(lines: number): Extension {
  if (!Number.isFinite(lines) || lines <= 0) return []
  // A stable key so repeated requests within one measure cycle coalesce to the
  // latest cursor position instead of stacking up.
  const measureKey = {}
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return
    const view = update.view
    view.requestMeasure({
      key: measureKey,
      read: (v): { topGap: number; bottomGap: number; viewHeight: number; lineHeight: number } | null => {
        const head = v.state.selection.main.head
        // Viewport-relative rect of the cursor's exact row (correct for
        // soft-wrapped lines, unlike the whole-line block extent).
        const coords = v.coordsAtPos(head)
        if (!coords) return null
        const rect = v.scrollDOM.getBoundingClientRect()
        return {
          topGap: coords.top - rect.top,
          bottomGap: rect.bottom - coords.bottom,
          viewHeight: v.scrollDOM.clientHeight,
          lineHeight: v.defaultLineHeight
        }
      },
      write: (m, v): void => {
        if (!m) return
        // Cap the margin at just under half the viewport so the top and bottom
        // margins can't overlap (short editors, e.g. split mode).
        const maxMargin = Math.max(0, (m.viewHeight - m.lineHeight) / 2)
        const margin = Math.min(lines * m.lineHeight, maxMargin)
        let delta = 0
        if (m.topGap < margin) delta = m.topGap - margin
        else if (m.bottomGap < margin) delta = margin - m.bottomGap
        // The browser clamps to the scrollable range; only write when it moves.
        if (delta !== 0) v.scrollDOM.scrollTop += delta
      }
    })
  })
}
