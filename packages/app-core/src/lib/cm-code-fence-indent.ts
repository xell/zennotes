import { syntaxTree } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { hasPendingMarkdownBlockSnippet } from './cm-markdown-snippets'

/**
 * #405: pressing Enter on a fenced-code opener that shares its line with a list
 * marker (`` - ```bash ``) must indent the new line to the fence column, so the
 * code content stays inside the list item instead of escaping to column 0 and
 * breaking the block.
 *
 * CodeMirror's `insertNewlineContinueMarkup` (the markdown Enter command)
 * continues a fenced block by copying the current line's leading *whitespace*.
 * On `` - ```bash `` that leading part is a list *marker*, not indentation, so
 * it copies nothing and the caret lands at column 0, dropping out of the block.
 *
 * This command takes over only that one case: the caret is a plain cursor on
 * the fence *opener* line, and there is non-whitespace (a list/quote marker)
 * before the fence. Every other fenced-code line (an already-indented opener,
 * the content lines, and top-level fences) is left to
 * `insertNewlineContinueMarkup`, which indents them correctly. Returning
 * `false` falls through to it.
 */
export function insertNewlineContinueFencedCodeIndent(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  // When the block snippet is about to auto-close the fence (it inserts the
  // closing fence, already indented), let it handle Enter instead. This is only
  // the fallback for an opener the snippet didn't register (e.g. Enter on an
  // existing fence that was not just typed).
  if (hasPendingMarkdownBlockSnippet(state)) return false

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, -1)
  while (node && node.name !== 'FencedCode') node = node.parent
  if (!node) return false

  const fenceLine = state.doc.lineAt(node.from)
  const caretLine = state.doc.lineAt(range.head)
  // Only the opener line needs help; content lines already copy their own
  // leading whitespace correctly.
  if (fenceLine.number !== caretLine.number) return false

  const prefix = fenceLine.text.slice(0, node.from - fenceLine.from)
  // Whitespace-only (or empty) indent is already handled by the default
  // command; only a list/quote marker before the fence trips it up.
  if (!/\S/.test(prefix)) return false

  // Align continued lines to the fence column, turning the marker into spaces
  // so the content sits inside the list item.
  const insert = state.lineBreak + prefix.replace(/\S/g, ' ')
  view.dispatch(
    state.changeByRange((r) => ({
      changes: { from: r.from, to: r.to, insert },
      range: EditorSelection.cursor(r.from + insert.length)
    })),
    { scrollIntoView: true, userEvent: 'input' }
  )
  return true
}
