// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { registerNoteMoveExCommands } from './vim-ex-commands'

describe('registerNoteMoveExCommands (#513)', () => {
  let view: EditorView | null = null

  afterEach(() => {
    view?.destroy()
    view = null
  })

  it('keeps bare :13 as a line jump while :move still moves the note', () => {
    const moveNote = vi.fn()
    registerNoteMoveExCommands(moveNote)
    view = new EditorView({
      state: EditorState.create({
        doc: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'),
        extensions: [vim()]
      }),
      parent: document.body
    })
    const cm = getCM(view)
    if (!cm) throw new Error('Vim adapter did not mount')
    const vimCm = cm as Parameters<typeof Vim.handleEx>[0]

    Vim.handleEx(vimCm, '13')
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(13)
    expect(moveNote).not.toHaveBeenCalled()

    Vim.handleEx(vimCm, 'move archive/Reference')
    expect(moveNote).toHaveBeenCalledTimes(1)
    expect(moveNote.mock.calls[0]?.[1]).toMatchObject({ argString: ' archive/Reference' })
  })
})
