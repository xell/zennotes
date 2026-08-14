// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim, getCM } from '@replit/codemirror-vim'
import { vimWithBlockSelection } from './cm-vim-block-selection'
import { vimAwareDefaultKeymap } from './cm-vim-default-keymap'

// Blockwise visual mode (`<C-v>` / `<C-q>`) is one CodeMirror range per covered
// line. Without `EditorState.allowMultipleSelections` CodeMirror silently drops
// all but the main range (`selection.asSingle()` on create and on every
// transaction), so Vim entered block mode but the block never reached the view.
describe('vimWithBlockSelection', () => {
  const views: EditorView[] = []
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy())
  })

  const mount = (doc: string, vimExt = vimWithBlockSelection()): EditorView => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [vimExt, keymap.of([...vimAwareDefaultKeymap(true)])]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  const press = (view: EditorView, key: string, keyCode: number, mods = {}): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true, ...mods })
    )
  }

  const isVisualBlock = (view: EditorView): boolean =>
    Boolean(
      (getCM(view) as { state?: { vim?: { visualBlock?: boolean } } } | null)?.state?.vim
        ?.visualBlock
    )

  it('keeps every range of a block selection', () => {
    const view = mount('aaaa\nbbbb\ncccc')
    press(view, 'v', 86, { ctrlKey: true })
    press(view, 'l', 76)
    // `G` (last line) is a line-number motion, so unlike `j` it needs no layout.
    press(view, 'G', 71, { shiftKey: true })
    expect(isVisualBlock(view)).toBe(true)
    expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 1],
      [5, 6],
      [10, 11]
    ])
  })

  it('treats <C-q> as the same alias Vim does', () => {
    const view = mount('aaaa\nbbbb\ncccc')
    press(view, 'q', 81, { ctrlKey: true })
    press(view, 'l', 76)
    press(view, 'G', 71, { shiftKey: true })
    expect(view.state.selection.ranges).toHaveLength(3)
  })

  // The bug this guards against: bare `vim()` collapses the block to one range.
  it('collapses to a single range with the bare vim() extension', () => {
    const view = mount('aaaa\nbbbb\ncccc', vim())
    press(view, 'v', 86, { ctrlKey: true })
    press(view, 'l', 76)
    press(view, 'G', 71, { shiftKey: true })
    expect(isVisualBlock(view)).toBe(true) // Vim was never the problem
    expect(view.state.selection.ranges).toHaveLength(1)
  })

  it('allows multiple ranges generally, not just via Vim', () => {
    const view = mount('aaaa\nbbbb\ncccc')
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(5, 7)
      ])
    })
    expect(view.state.selection.ranges).toHaveLength(2)
  })
})
