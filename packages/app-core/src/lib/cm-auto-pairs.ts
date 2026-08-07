import { EditorSelection, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'

const STRUCTURAL_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}'
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'"
}

const ALL_PAIRS: Readonly<Record<string, string>> = { ...STRUCTURAL_PAIRS, ...QUOTE_PAIRS }

export interface AutoPairExtensionConfig {
  shouldHandle?: (view: EditorView) => boolean
  /** Whether quotes should pair at this position. Structural delimiters always pair. */
  shouldPairQuotes?: (view: EditorView, from: number, to: number) => boolean
}

/** True when a position is inside a Markdown code span or fenced code block. */
export function isInMarkdownCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'InlineCode') return true
    if (!node.parent) break
    node = node.parent
  }
  return false
}

function pairsForQuotes(includeQuotes: boolean): Readonly<Record<string, string>> {
  return includeQuotes ? ALL_PAIRS : STRUCTURAL_PAIRS
}

/**
 * Builds the editor transaction for paired delimiters. Kept separate from the
 * DOM extension so the edge cases can be tested without a mounted editor.
 */
export function autoPairInputTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  includeQuotes = false
): TransactionSpec | null {
  if (text.length !== 1) return null

  const pairs = pairsForQuotes(includeQuotes)
  const closers = new Set(Object.values(pairs))
  if (from === to && closers.has(text) && state.sliceDoc(from, from + 1) === text) {
    return { selection: EditorSelection.cursor(from + 1) }
  }

  // Apostrophes in contractions (don't, we're) are ordinary Markdown prose,
  // not opening quotes. Leave the browser's normal text input untouched.
  if (text === "'" && /[\p{L}\p{N}_]/u.test(state.sliceDoc(Math.max(0, from - 1), from))) {
    return null
  }

  const close = pairs[text]
  if (close) {
    const selected = state.sliceDoc(from, to)
    return {
      changes: { from, to, insert: text + selected + close },
      selection: EditorSelection.range(from + 1, to + 1)
    }
  }

  return null
}

export function autoPairBackspaceTransaction(
  state: EditorState,
  includeQuotes = false
): TransactionSpec | null {
  const selection = state.selection.main
  if (!selection.empty || selection.head === 0) return null

  const from = selection.head - 1
  const open = state.sliceDoc(from, selection.head)
  const close = pairsForQuotes(includeQuotes)[open]
  if (!close || state.sliceDoc(selection.head, selection.head + 1) !== close) return null

  return {
    changes: { from, to: selection.head + 1, insert: '' },
    selection: EditorSelection.cursor(from)
  }
}

/**
 * Standard paired-delimiter editing, optionally restricted by the caller
 * (ZenNotes uses that to allow it only outside Vim normal/visual modes, and
 * keeps quote pairing inside Markdown code unless the user opts into prose).
 */
export function autoPairExtension(config: AutoPairExtensionConfig = {}): Extension {
  const shouldHandle = (view: EditorView): boolean => !config.shouldHandle || config.shouldHandle(view)

  return [
    EditorView.inputHandler.of((view, from, to, text) => {
      if (!shouldHandle(view)) return false
      const includeQuotes = config.shouldPairQuotes?.(view, from, to) ?? false
      const transaction = autoPairInputTransaction(view.state, from, to, text, includeQuotes)
      if (!transaction) return false
      view.dispatch(transaction)
      return true
    }),
    keymap.of([
      {
        key: 'Backspace',
        run: (view): boolean => {
          if (!shouldHandle(view)) return false
          const includeQuotes = config.shouldPairQuotes?.(
            view,
            view.state.selection.main.from,
            view.state.selection.main.to
          ) ?? false
          const transaction = autoPairBackspaceTransaction(view.state, includeQuotes)
          if (!transaction) return false
          view.dispatch(transaction)
          return true
        }
      }
    ])
  ]
}
