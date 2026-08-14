import { EditorState, type Extension } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'

/**
 * Vim blockwise visual mode (`<C-v>` / `<C-q>`) needs multiple selections.
 *
 * A block selection is not one range: codemirror-vim represents it as one
 * CodeMirror range per covered line, pushed through the adapter's
 * `setSelections`. But `EditorState.allowMultipleSelections` defaults to
 * **false**, and while it is false CodeMirror runs `selection.asSingle()` on
 * every `EditorState.create` *and* every transaction, silently keeping only the
 * main range. No error, no warning.
 *
 * So `<C-v>` did reach Vim and did set `vim.visualBlock = true` — the block's
 * extra ranges were simply dropped on the way to the view. With no Vim mode
 * indicator in the UI, all that was left was a caret-wide highlight sliding
 * around, which read as "the key does nothing". Block operators were broken
 * too, not just the drawing: they read the ranges back via `listSelections()`.
 *
 * Enabling the facet alongside `vim()` (rather than globally) keeps the change
 * scoped to Vim mode, so it goes away with Vim like the rest of the plugin.
 * Note it also lets `searchKeymap`'s `Mod-d` (`selectNextOccurrence`) build real
 * multiple cursors in Vim mode, where it previously collapsed to one range.
 */
export function vimWithBlockSelection(): Extension {
  return [vim(), EditorState.allowMultipleSelections.of(true)]
}
