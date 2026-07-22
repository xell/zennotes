import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'

/**
 * Open the native macOS dictionary "Look Up" panel (the force-click /
 * Ctrl+Cmd+D popover) for the text under the cursor in the given editor.
 *
 * When there is a real multi-character selection (e.g. a phrase highlighted in
 * vim visual mode) it is looked up as-is. Otherwise we look up the single word
 * under the caret, which means briefly selecting it, firing the lookup, then
 * restoring the caret so vim normal-mode state is left untouched.
 *
 * The ">1 char" test sidesteps how codemirror-vim represents the normal-mode
 * cursor (empty caret vs one-char block): either way a normal-mode cursor never
 * trips the selection branch, so `gd` still means "word under cursor" there.
 *
 * No-op off macOS — the desktop main handler and the web bridge both guard the
 * underlying `showDefinitionForSelection` call as well.
 */
export function lookUpDefinitionInView(view: EditorView): void {
  if (window.zen.platformSync() !== 'darwin') return
  const { state } = view
  const sel = state.selection.main

  // A real selection (visual-mode phrase, or a mouse selection): look it up
  // as-is, leaving the selection in place so vim visual state is undisturbed.
  if (sel.to - sel.from > 1) {
    void window.zen.showDefinitionForSelection()
    return
  }

  const word = state.wordAt(sel.head)
  // Off a word (e.g. on punctuation), fall back to the single char under the caret.
  const range =
    word ?? (sel.head < state.doc.length ? { from: sel.head, to: sel.head + 1 } : null)
  if (!range || range.from === range.to) return
  view.dispatch({ selection: { anchor: range.from, head: range.to } })
  void window.zen.showDefinitionForSelection()
  // The panel reads the selection asynchronously inside Chromium, after the IPC
  // call has already resolved, so we restore the caret on a short timer rather
  // than immediately. The brief word highlight also mirrors native Look Up.
  window.setTimeout(() => {
    useStore.getState().editorViewRef?.dispatch({
      selection: { anchor: sel.anchor, head: sel.head }
    })
  }, 400)
}
