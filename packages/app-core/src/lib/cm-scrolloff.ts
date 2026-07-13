import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * A Vim-style `scrolloff`: keep at least `lines` rows visible above and below
 * the cursor, so it never sits against the top or bottom edge of the editor
 * (issue #305). When the cursor moves within `lines` of an edge, the view
 * scrolls just enough to restore the margin; manual scrolling is untouched
 * until the next cursor move.
 *
 * Returns an empty extension when disabled (`lines <= 0`), so it costs nothing
 * unless the user opts in.
 */
export function scrollOff(lines: number): Extension {
  if (!Number.isFinite(lines) || lines <= 0) return []
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return
    const view = update.view
    const head = update.state.selection.main.head
    // Defer past the current update so we never dispatch re-entrantly, and so we
    // measure after the DOM has settled.
    Promise.resolve().then(() => {
      if (!view.dom.isConnected) return
      // Re-read the head in case the selection changed again in the meantime.
      const pos = view.state.selection.main.head
      if (pos !== head) return
      const margin = Math.round(lines * view.defaultLineHeight)
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: margin }) })
    })
  })
}
