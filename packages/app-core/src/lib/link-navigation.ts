import type { EditorView } from '@codemirror/view'

/**
 * Jump the cursor to the next / previous link in the document.
 *
 * "Link" here means the same three things `gx` (goToDefinition) can follow, so
 * the two features stay consistent:
 *
 *   1. `[[wikilink]]` (with optional `|alias`)
 *   2. `[text](url)` Markdown links, including angle-bracketed `(<url>)`
 *   3. bare `http(s)://` URLs
 *
 * The alternatives are ordered longest-context first and scanned left to right
 * with a single global regex, so a Markdown link consumes its own inner URL in
 * one match rather than reporting the URL a second time.
 */
const LINK_RE =
  /\[\[[^\]|]+?(?:\|[^\]]+)?\]\]|\[[^\]]*\]\(<[^>]+>\)|\[[^\]]*\]\([^)]+\)|https?:\/\/[^\s)>\]]+/g

/** Start offsets of every link in the document, in document order. */
export function linkStarts(doc: string): number[] {
  const out: number[] = []
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(doc)) !== null) {
    out.push(m.index)
    // Defensive guard against a zero-width match stalling the loop.
    if (m.index === LINK_RE.lastIndex) LINK_RE.lastIndex++
  }
  return out
}

/**
 * Move the caret to the start of the next (or previous, when `backward`) link,
 * wrapping around the ends of the document like a default vim search. No-op when
 * the document has no links.
 */
export function moveCursorToLink(view: EditorView, backward: boolean): void {
  const doc = view.state.doc.toString()
  const starts = linkStarts(doc)
  if (starts.length === 0) return
  const pos = view.state.selection.main.head
  const target = backward
    ? (starts.filter((s) => s < pos).pop() ?? starts[starts.length - 1])
    : (starts.find((s) => s > pos) ?? starts[0])
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
}
