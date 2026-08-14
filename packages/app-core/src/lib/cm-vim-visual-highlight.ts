/**
 * Vim-shaped visual-mode selection (#581). codemirror-vim mirrors the visual
 * range into the editor selection, and CM6's selection layer draws multi-row
 * ranges browser-style: every row but the last fills to the content column's
 * right edge, so a short line inside a wide column highlights far past its
 * text, and a wrapped row paints past its last glyph. Vim highlights the text
 * itself. While Vim is in visual mode the native selection layer is hidden
 * (styles in index.css under `.zen-vim-visual-active`) and the ranges are
 * painted with mark decorations instead, which hug the glyphs of every
 * wrapped row by construction. Inert with Vim off or outside visual mode.
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'

const visualMark = Decoration.mark({ class: 'cm-vim-visual-selection' })

function vimInVisualMode(view: EditorView): boolean {
  const vim = getCM(view)?.state.vim as { visualMode?: boolean } | undefined
  return !!vim?.visualMode
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue
    builder.add(range.from, range.to, visualMark)
  }
  return builder.finish()
}

const visualSelectionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = vimInVisualMode(view) ? buildDecorations(view) : Decoration.none
    }

    update(update: ViewUpdate): void {
      // Mode flips arrive inside the same dispatch that moves the selection
      // (codemirror-vim toggles its state before it re-syncs the selection),
      // so reading the mode here stays in step with what is on screen.
      this.decorations = vimInVisualMode(update.view)
        ? buildDecorations(update.view)
        : Decoration.none
    }
  },
  { decorations: (v) => v.decorations }
)

/** The CSS that hides the native selection layer keys off this class, so the
 *  swap follows the exact same mode read as the decorations. */
const visualClassAttribute = EditorView.editorAttributes.of((view) =>
  vimInVisualMode(view) ? { class: 'zen-vim-visual-active' } : null
)

export const vimVisualHighlightExtension = [visualSelectionPlugin, visualClassAttribute]
