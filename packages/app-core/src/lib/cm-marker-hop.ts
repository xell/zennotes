/**
 * Step the cursor across inline markers without leaving the keyboard (#490).
 *
 * The formatting shortcuts drop the cursor *between* a pair — `**|**` — which
 * is right for typing but leaves you stranded once the word is done: getting
 * out means arrow keys, a mouse, or a Vim motion. These two commands hop the
 * cursor to the far side of the next (or previous) run of marker characters on
 * the line, so `**bold|**` → `**bold**|` is one keystroke, and a second hop
 * carries on to the next pair.
 *
 * A "run" is consecutive *identical* marker characters, so `**` is one hop and
 * the `](` between a link's text and its target is two — each landing spot is
 * somewhere you might actually want to type. The scan is line-scoped: inline
 * markers don't span lines, and a motion that could fling the cursor into
 * another paragraph would be worse than no motion at all.
 *
 * Deliberately not a fallback motion: with no marker to cross, the commands
 * return false and the key does whatever else it is bound to, rather than
 * inventing a jump to the end of the line.
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Characters treated as inline markers: the six the formatting shortcuts write
 * (`**` bold, `*` italic, `~~` strike, `==` highlight, `` ` `` code, `$` math)
 * plus the bracket pairs, which is what makes the motion useful for links and
 * for anything the auto-pairs setting closes for you.
 *
 * `_` is left out on purpose — it is a valid emphasis marker, but snake_case
 * words are common enough in notes that including it would stop the cursor in
 * the middle of ordinary text.
 */
const MARKER_CHARS = new Set(['*', '~', '=', '`', '$', '(', ')', '[', ']', '{', '}'])

export function isMarkerChar(ch: string): boolean {
  return MARKER_CHARS.has(ch)
}

/**
 * Column just past the next marker run to the right of `col` (`dir` 1), or just
 * before the previous run to its left (`dir` -1). Null when the line holds no
 * marker in that direction — the caller leaves the cursor alone.
 *
 * Both directions land *outside* the run they cross, which is what makes the
 * motion reversible: hopping right then left returns the cursor to where it
 * started only when it started outside a run, and otherwise walks pair by pair
 * exactly as the issue describes.
 */
export function markerHopTarget(text: string, col: number, dir: 1 | -1): number | null {
  if (dir === 1) {
    let i = col
    while (i < text.length && !isMarkerChar(text[i])) i++
    if (i >= text.length) return null
    const ch = text[i]
    while (i < text.length && text[i] === ch) i++
    return i
  }
  let i = col - 1
  while (i >= 0 && !isMarkerChar(text[i])) i--
  if (i < 0) return null
  const ch = text[i]
  while (i >= 0 && text[i] === ch) i--
  return i + 1
}

/** Move every cursor across the next/previous marker run on its own line. */
function hopMarker(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  let moved = false
  const selection = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head)
    const target = markerHopTarget(line.text, range.head - line.from, dir)
    if (target == null) return EditorSelection.cursor(range.head)
    moved = true
    return EditorSelection.cursor(line.from + target)
  })
  if (!moved) return false
  view.dispatch({
    selection: EditorSelection.create(selection, state.selection.mainIndex),
    scrollIntoView: true
  })
  return true
}

/** `**bold|**` → `**bold**|`, then on to the next pair on the line. */
export function hopMarkerForward(view: EditorView): boolean {
  return hopMarker(view, 1)
}

/** `**bold**|` → `**bold|**`, then out to `|**bold**`. */
export function hopMarkerBackward(view: EditorView): boolean {
  return hopMarker(view, -1)
}
