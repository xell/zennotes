// @vitest-environment jsdom
// #405: fenced code inside a bullet list must indent on Enter instead of
// escaping to column 0. Exercises the real dispatch chain both editors use:
// vim + markdown keymap (with our fence-indent Enter) + the block snippet.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'
import { markdownSnippetExtension } from './cm-markdown-snippets'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

function mount(doc: string, withSnippets = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        vim(),
        markdown({ base: markdownLanguage, addKeymap: false }),
        vimAwareMarkdownKeymap,
        ...(withSnippets ? [markdownSnippetExtension()] : []),
        keymap.of([...vimAwareDefaultKeymap(true)])
      ]
    }),
    parent: document.body
  })
  views.push(view)
  view.focus()
  return view
}

const press = (view: EditorView, key: string, keyCode: number): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })
  )
}

// Insert text as a user input event so the block snippet registers a pending
// opener, exactly as typing would.
function typeInput(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type'
  })
}

describe('fenced code Enter indentation in lists (#405)', () => {
  it('auto-closes a fence typed in a bullet item, indented to the fence column', () => {
    const view = mount('- ')
    press(view, 'A', 65) // append → insert mode at end of line
    typeInput(view, '```bash')
    press(view, 'Enter', 13)
    // The snippet owns this (pending): content line + closing fence, both at col 2.
    expect(view.state.doc.toString()).toBe('- ```bash\n  \n  ```')
  })

  it('indents an existing fence opener when the snippet is not pending (fallback)', () => {
    const view = mount('- ```bash') // nothing typed → no pending snippet
    press(view, 'A', 65) // insert mode at end of the fence line
    press(view, 'Enter', 13)
    // Our Enter command indents the new line into the list item (no auto-close).
    expect(view.state.doc.toString()).toBe('- ```bash\n  ')
  })

  it('continues indented content lines inside the block', () => {
    const view = mount('- ```bash\n  echo hi')
    view.dispatch({ selection: { anchor: 19 } }) // end of "  echo hi"
    press(view, 'i', 73) // insert mode
    press(view, 'Enter', 13)
    expect(view.state.doc.toString()).toBe('- ```bash\n  echo hi\n  ')
  })

  it('leaves a top-level fence at column 0', () => {
    const view = mount('')
    press(view, 'A', 65)
    typeInput(view, '```bash')
    press(view, 'Enter', 13)
    expect(view.state.doc.toString()).toBe('```bash\n\n```')
  })

  it('does not edit on Enter in Vim normal mode (it is the <CR> motion)', () => {
    const view = mount('- ```bash')
    view.dispatch({ selection: { anchor: 9 } }) // stay in normal mode
    press(view, 'Enter', 13)
    expect(view.state.doc.toString()).toBe('- ```bash')
  })
})
