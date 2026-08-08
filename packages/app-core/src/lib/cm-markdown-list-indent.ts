import { syntaxTree } from '@codemirror/language'
import { type Extension, type Range, StateEffect } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { MANAGED_STYLES_CHANGED_EVENT } from './custom-themes'

// The checkbox part covers every task state (`[ ]`, `[x]`, `[>]`, `[-]`, `[/]`)
// so Tab/Shift-Tab indents a started or cancelled task like any other. (#512)
const LEADING_LIST_MARKER_RE =
  /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX>/-]\](?:[ \t]+|$))?/
const LIST_MARKER_FROM_OFFSET_RE =
  /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX>/-]\](?:[ \t]+|$))?/

function visualColumn(text: string): number {
  let col = 0
  for (const ch of text) col += ch === '\t' ? 4 : 1
  return col
}

function markerMatch(lineText: string, markerOffset: number): RegExpMatchArray | null {
  if (markerOffset < 0 || markerOffset > lineText.length) return null
  return markerOffset === 0
    ? lineText.match(LEADING_LIST_MARKER_RE)
    : lineText.slice(markerOffset).match(LIST_MARKER_FROM_OFFSET_RE)
}

export function markdownListHangingIndentCh(
  lineText: string,
  markerOffset = 0
): number | null {
  const match = markerMatch(lineText, markerOffset)
  if (!match) return null
  return Math.max(1, visualColumn(lineText.slice(0, markerOffset) + match[0]))
}

/**
 * Visual width (in chars) of just the marker + trailing space (+ task checkbox),
 * excluding the leading whitespace — the item's "own prefix", used as the ch
 * fallback for the hanging indent and the per-level step estimate.
 */
export function markdownListMarkerPrefixCh(lineText: string, markerOffset = 0): number | null {
  const match = markerMatch(lineText, markerOffset)
  if (!match) return null
  return Math.max(1, visualColumn(match[0]))
}

/**
 * Character offset (into the line) at which the list item's content begins,
 * i.e. just past the leading whitespace + marker (+ optional task checkbox).
 * Used to measure the rendered prefix width for the hanging indent.
 */
export function markdownListContentOffset(lineText: string, markerOffset = 0): number | null {
  const match = markerMatch(lineText, markerOffset)
  if (!match) return null
  return markerOffset + match[0].length
}

function listMarkerOffsetForLine(view: EditorView, lineFrom: number, lineTo: number): number | null {
  let offset: number | null = null
  syntaxTree(view.state).iterate({
    from: lineFrom,
    to: lineTo,
    enter: (node) => {
      if (offset != null) return false
      if (node.name !== 'ListMark') return
      offset = node.from - lineFrom
      return false
    }
  })
  return offset
}

/** Nesting depth (0 = top level) of the list item containing `pos`. */
function listDepthAt(view: EditorView, pos: number): number {
  let listItems = 0
  for (
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'ListItem') listItems++
  }
  return Math.max(0, listItems - 1)
}

interface ListIndent {
  /** Content column = depth * step + own prefix (px). Drives `padding-left`. */
  content: number
  /** Own prefix = marker + gap (px). Drives the negative `text-indent`. */
  marker: number
}

/**
 * Build the per-line list decorations:
 *  - a line style carrying the computed indent (`--z-list-hanging-indent` =
 *    content column, `--z-list-marker-indent` = own prefix), and
 *  - a replacement that hides the literal leading whitespace, so nesting depth
 *    is driven by the computed per-level step rather than the font-dependent
 *    width of the source's indent spaces.
 *
 * With this, a level-N bullet lands exactly on the level-(N−1) content column
 * (a tidy staircase). Values are px once measured; before that they fall back to
 * a `ch` estimate, exact only in a monospace font.
 */
function computeDecorations(
  view: EditorView,
  measured: Map<number, ListIndent>
): { decorations: DecorationSet; atomic: DecorationSet } {
  const ranges: Range<Decoration>[] = []
  // The hidden leading-whitespace runs, exposed as atomic ranges so the caret
  // treats each as one unit (no stepping through the collapsed zero-width
  // spaces).
  const atomicRanges: Range<Decoration>[] = []
  const decoratedLines = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number
    const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
      if (decoratedLines.has(lineNo)) continue
      const line = view.state.doc.line(lineNo)
      const markerOffset = listMarkerOffsetForLine(view, line.from, line.to)
      if (markerOffset == null) continue
      const prefixCh = markdownListMarkerPrefixCh(line.text, markerOffset)
      if (prefixCh == null) continue
      decoratedLines.add(lineNo)

      const depth = listDepthAt(view, line.from + markerOffset)
      const px = measured.get(line.from)
      // Fallback before measurement: a 2ch bullet step (exact in monospace).
      const content = px ? `${px.content}px` : `${depth * 2 + prefixCh}ch`
      const marker = px ? `${px.marker}px` : `${prefixCh}ch`

      ranges.push(
        Decoration.line({
          class: 'cm-markdown-list-line',
          attributes: {
            style: `--z-list-hanging-indent: ${content}; --z-list-marker-indent: ${marker}`
          }
        }).range(line.from)
      )
      if (markerOffset > 0) {
        const hidden = Decoration.replace({}).range(line.from, line.from + markerOffset)
        ranges.push(hidden)
        atomicRanges.push(hidden)
      }
    }
  }

  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomicRanges, true) }
}

/**
 * Measure each visible list line's own prefix (marker + gap, excluding leading
 * whitespace) in px, derive the per-level step from the narrowest one (a plain
 * bullet), and compute each line's content column = depth * step + own prefix.
 */
function measureListIndents(view: EditorView): Map<number, ListIndent> {
  const lines: { from: number; depth: number; marker: number }[] = []
  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number
    const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
      const line = view.state.doc.line(lineNo)
      const markerOffset = listMarkerOffsetForLine(view, line.from, line.to)
      if (markerOffset == null) continue
      const contentOffset = markdownListContentOffset(line.text, markerOffset)
      if (contentOffset == null) continue
      const markerStart = view.coordsAtPos(line.from + markerOffset)
      const contentStart = view.coordsAtPos(line.from + contentOffset)
      if (!markerStart || !contentStart) continue
      // Delta between marker start and content start on the first visual line —
      // invariant to the indent already applied, so it's the true prefix width.
      const marker = Math.max(0, Math.round(contentStart.left - markerStart.left))
      lines.push({ from: line.from, depth: listDepthAt(view, line.from + markerOffset), marker })
    }
  }

  // Per-level step = the narrowest own prefix (a plain bullet), so each level
  // indents by one bullet width and a child's bullet lands on its parent's
  // content column.
  let step = Infinity
  for (const l of lines) if (l.marker > 0 && l.marker < step) step = l.marker
  const stepPx = Number.isFinite(step) ? step : 0

  const out = new Map<number, ListIndent>()
  for (const l of lines) {
    out.set(l.from, { content: l.depth * stepPx + l.marker, marker: l.marker })
  }
  return out
}

function sameIndents(a: Map<number, ListIndent>, b: Map<number, ListIndent>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (!w || w.content !== v.content || w.marker !== v.marker) return false
  }
  return true
}

// Dispatched (deferred) after a measurement so CodeMirror re-reads the plugin's
// decorations with the freshly measured px indents.
const listIndentPing = StateEffect.define<null>()

const listIndentViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    private measured = new Map<number, ListIndent>()
    private pendingFrame = 0
    private readonly onStylesChanged: () => void

    constructor(view: EditorView) {
      const built = computeDecorations(view, this.measured)
      this.decorations = built.decorations
      this.atomic = built.atomic
      // A theme/override CSS change (e.g. a bullet margin) can shift the prefix
      // width without changing line heights, so CodeMirror won't re-measure on
      // its own — re-measure when the managed styles change.
      this.onStylesChanged = () => this.scheduleMeasure(view)
      if (typeof window !== 'undefined') {
        window.addEventListener(MANAGED_STYLES_CHANGED_EVENT, this.onStylesChanged)
      }
      this.scheduleMeasure(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        // Keep measured widths attached to their lines as the doc shifts, so a
        // measured line keeps its px indent (no flash) until it's re-measured.
        const remapped = new Map<number, ListIndent>()
        for (const [pos, indent] of this.measured) {
          remapped.set(update.changes.mapPos(pos, 1), indent)
        }
        this.measured = remapped
      }
      if (update.docChanged || update.viewportChanged) {
        const built = computeDecorations(update.view, this.measured)
        this.decorations = built.decorations
        this.atomic = built.atomic
      }
      // Re-measure on content, viewport, geometry (font swap / resize / font
      // load) and selection changes — the last because clicking a line reveals
      // its raw markers, which changes the prefix width.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.selectionSet
      ) {
        this.scheduleMeasure(update.view)
      }
    }

    private scheduleMeasure(view: EditorView): void {
      view.requestMeasure({
        key: 'zen-markdown-list-indent',
        read: () => measureListIndents(view),
        write: (map) => {
          if (sameIndents(map, this.measured)) return
          this.measured = map
          const built = computeDecorations(view, map)
          this.decorations = built.decorations
          this.atomic = built.atomic
          // Can't dispatch during the measure phase; defer a no-op transaction
          // so CodeMirror re-reads these updated decorations next frame.
          if (this.pendingFrame) return
          this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = 0
            if (!view.dom.isConnected) return
            view.dispatch({ effects: listIndentPing.of(null) })
          })
        }
      })
    }

    destroy(): void {
      if (typeof window !== 'undefined') {
        window.removeEventListener(MANAGED_STYLES_CHANGED_EVENT, this.onStylesChanged)
      }
      if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame)
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
)

export const markdownListIndentPlugin: Extension = [
  listIndentViewPlugin,
  // Treat each hidden leading-indent run as one unit for the caret, so
  // arrowing / Home / backspace skip the collapsed zero-width spaces cleanly
  // instead of stepping through invisible positions.
  EditorView.atomicRanges.of(
    (view) => view.plugin(listIndentViewPlugin)?.atomic ?? Decoration.none
  )
]
