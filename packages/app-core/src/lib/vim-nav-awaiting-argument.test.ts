// @vitest-environment jsdom
//
// Real-editor coverage for isVimAwaitingArgument: vim-nav.test.ts mocks
// @replit/codemirror-vim, so only this suite would catch the library
// renaming `expectLiteralNext` or `inputState.keyBuffer` out from under
// the predicate. The #147 leader guard and the #568 context-menu guards
// (VimNav, EditorPane) all lean on this one helper.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { isVimAwaitingArgument } from './vim-nav'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function mount(doc: string): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [vim()] }),
    parent: document.body
  })
  return view
}

function press(target: EditorView, key: string): void {
  target.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  )
}

describe('isVimAwaitingArgument (real codemirror-vim)', () => {
  it('is false in plain normal and visual mode', () => {
    const v = mount('meaning of m')
    expect(isVimAwaitingArgument(v)).toBe(false)

    press(v, 'v')
    expect(isVimAwaitingArgument(v)).toBe(false)
  })

  it('is true after f in visual mode, and false once the target arrives (#568)', () => {
    const v = mount('meaning of m')
    press(v, 'v')
    press(v, 'f')
    expect(isVimAwaitingArgument(v)).toBe(true)

    press(v, 'm')
    expect(isVimAwaitingArgument(v)).toBe(false)
    // The motion actually consumed the key: the selection grew toward "of m"
    // instead of the m being available for anything else.
    expect(v.state.selection.main.head).toBeGreaterThan(1)
  })

  it('is true while a count is buffered', () => {
    const v = mount('meaning of m')
    press(v, 'v')
    press(v, '2')
    expect(isVimAwaitingArgument(v)).toBe(true)
  })

  it('is true after r awaiting its replacement character', () => {
    const v = mount('meaning of m')
    press(v, 'r')
    expect(isVimAwaitingArgument(v)).toBe(true)
  })
})
