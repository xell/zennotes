import { EditorView } from '@codemirror/view'
import { TASK_LINE_RE } from '@shared/tasklists'
import { forwardTaskWithPicker, taskAtEditorCursor } from './forward-task'

/**
 * Typing `>` into a task's checkbox (turning `- [ ]` into `- [>]`) opens the
 * forward picker (#316). Detected as a single inserted `>` that lands exactly on
 * the checkbox state char — so the programmatic forward rewrite (which replaces
 * the whole line and appends a wikilink) can never re-trigger it, and a `>`
 * typed anywhere else (blockquotes, text) is left alone.
 */
export const forwardOnCheckboxArrow = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return
  let hit = false
  update.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    if (hit || inserted.toString() !== '>') return
    const line = update.state.doc.lineAt(fromB)
    const match = line.text.match(TASK_LINE_RE)
    if (match && match[2] === '>' && fromB === line.from + match[1].length) hit = true
  })
  if (!hit) return
  const view = update.view
  // Defer out of the update cycle before mutating / opening a modal.
  queueMicrotask(() => {
    const task = taskAtEditorCursor(view)
    if (task?.forwarded) void forwardTaskWithPicker(task)
  })
})
