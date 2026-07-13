import type { EditorView } from '@codemirror/view'
import { parseTasksFromBody, type VaultTask } from '@shared/tasks'
import { promptApp } from './prompt-requests'
import { useStore } from '../store'

/**
 * Task forwarding (#316). `forwardTaskWithPicker` prompts for a destination note
 * and moves the task there: the original stays as a `- [>]` record linking to
 * the target, and a fresh `- [ ]` copy (backlinked to the source) is appended to
 * the target note.
 */
export async function forwardTaskWithPicker(task: VaultTask): Promise<void> {
  const notes = useStore
    .getState()
    .notes.filter((n) => n.folder !== 'trash' && n.path !== task.sourcePath && n.path.endsWith('.md'))
  if (notes.length === 0) {
    window.alert('There are no other notes to forward this task to.')
    return
  }
  // Resolve the picker result (a suggestion value = path, or a typed title/path).
  const byKey = new Map<string, string>()
  const suggestions = notes.map((n) => {
    byKey.set(n.path, n.path)
    if (!byKey.has(n.title)) byKey.set(n.title, n.path)
    return { value: n.path, label: n.title, detail: n.path }
  })

  const chosen = await promptApp({
    title: `Forward "${task.content || 'task'}" to…`,
    description: 'The original stays as a forwarded record; a copy is added to the note you pick.',
    placeholder: 'Note title or path',
    okLabel: 'Forward',
    suggestions,
    suggestionsHint: 'Pick a note',
    validate: (input) => (byKey.has(input.trim()) ? null : 'Pick an existing note')
  })
  if (!chosen) return
  const targetPath = byKey.get(chosen.trim())
  if (targetPath) await useStore.getState().forwardTask(task, targetPath)
}

/** The task on the editor's current cursor line, or null. Parses the live buffer
 *  so the `taskIndex` matches what `forwardTask` rewrites. */
export function taskAtEditorCursor(view: EditorView): VaultTask | null {
  const active = useStore.getState().activeNote
  if (!active) return null
  const lineNumber = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const tasks = parseTasksFromBody(view.state.doc.toString(), {
    path: active.path,
    title: active.title,
    folder: active.folder
  })
  return tasks.find((t) => t.lineNumber === lineNumber) ?? null
}
