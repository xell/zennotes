import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * Whether `scrollOff` should react to this update at all. Exported (rather
 * than inlined in the listener) so the mouse-exclusion rule can be tested
 * directly against a plain fake update, without mounting a real EditorView —
 * the actual scroll math needs real DOM measurement (`coordsAtPos`,
 * `getBoundingClientRect`), which jsdom can't provide, but this decision
 * doesn't.
 */
export function shouldEnforceScrollOff(
  update: Pick<ViewUpdate, 'selectionSet' | 'docChanged' | 'transactions'>
): boolean {
  if (!update.selectionSet && !update.docChanged) return false
  // select.pointer is CodeMirror's own tag for a mouse-driven selection
  // change — present on a plain click and on every extend a drag produces.
  // See the exclusion's rationale below.
  if (update.transactions.some((tr) => tr.isUserEvent('select.pointer'))) return false
  return true
}

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
 * Deliberately skipped for a mouse-driven selection (`select.pointer`, the tag
 * CodeMirror's own drag/click handling puts on every transaction it makes —
 * present on the click itself and on each subsequent extend during a drag).
 * Keyboard motion is the only thing `scrolloff` constrains in Vim; the mouse
 * places the cursor exactly where you point it, unconstrained. Without this
 * exclusion, clicking anywhere in the margin yanked the view (correcting a
 * position the user deliberately chose), and starting a drag selection from
 * the margin was worse: `write` fires again on every pointermove the drag
 * generates, each one re-finding the (still cursor-following) endpoint inside
 * the margin and scrolling further, a runaway loop that ran the view to the
 * start or end of the note and made selecting from the margin impossible.
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
    if (!shouldEnforceScrollOff(update)) return
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
