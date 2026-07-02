// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { vimAwareDefaultKeymap } from './cm-vim-default-keymap'

// Regression guard for the macOS Vim `Ctrl-d` bug: defaultKeymap's emacs-style
// mac chords used to shadow Vim's <C-d> (half-page down) and delete a char.
describe('vimAwareDefaultKeymap', () => {
  it('strips the macOS emacs chords in Vim mode so Vim handles them', () => {
    const macs = new Set(
      vimAwareDefaultKeymap(true)
        .map((b) => b.mac)
        .filter(Boolean)
    )
    for (const chord of ['Ctrl-d', 'Ctrl-a', 'Ctrl-e', 'Ctrl-f', 'Ctrl-b', 'Ctrl-v', 'Ctrl-h']) {
      expect(macs.has(chord)).toBe(false)
    }
  })

  it('keeps the emacs chords when Vim is off (standard macOS editing keys)', () => {
    const macs = new Set(vimAwareDefaultKeymap(false).map((b) => b.mac))
    expect(macs.has('Ctrl-d')).toBe(true)
    expect(macs.has('Ctrl-e')).toBe(true)
  })

  it('never drops non-emacs bindings (Mod-a, arrows survive in Vim mode)', () => {
    const vim = vimAwareDefaultKeymap(true)
    expect(vim.some((b) => b.key === 'Mod-a')).toBe(true)
    expect(vim.some((b) => b.key === 'ArrowDown')).toBe(true)
    expect(vim.some((b) => b.key === 'Enter')).toBe(true)
  })

  it('removes exactly the 13 documented emacs chords, nothing more', () => {
    expect(vimAwareDefaultKeymap(false).length - vimAwareDefaultKeymap(true).length).toBe(13)
  })

  // Issue #287: in Vim mode the arrows must defer to the Vim plugin, which means
  // dropping the native `preventDefault: true` (otherwise the key is consumed
  // even when our command returns false, re-blocking Vim).
  it('drops preventDefault on the arrow bindings in Vim mode, keeps it when off', () => {
    const vimKm = vimAwareDefaultKeymap(true)
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const binding = vimKm.find((b) => b.key === key)
      expect(binding, key).toBeTruthy()
      expect(binding?.preventDefault, key).toBe(false)
    }
    // With Vim off the native bindings (preventDefault: true) are untouched.
    expect(vimAwareDefaultKeymap(false).find((b) => b.key === 'ArrowLeft')?.preventDefault).toBe(
      true
    )
  })
})

// Behavioral guard for #287, at the level the fix actually controls: the arrow
// command must *defer* (return false → the keypress falls through to the Vim
// plugin, which applies the h/j/k/l motion and extends the selection) whenever
// Vim is in a non-insert mode, and fall back to the native caret motion in
// insert mode (where Vim doesn't map the arrows). This is precedence- and
// layout-independent — unlike a full key-dispatch test, whose precedence in a
// minimal extension set doesn't match the real editor's.
describe('vim arrow bindings defer to the Vim plugin (issue #287)', () => {
  const views: EditorView[] = []
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy())
  })

  const mountVim = (doc: string): EditorView => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [vim(), keymap.of([...vimAwareDefaultKeymap(true)])]
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

  const arrowRun = (key: string): NonNullable<KeyBinding['run']> => {
    const binding = vimAwareDefaultKeymap(true).find((b) => b.key === key)
    if (!binding?.run) throw new Error(`no run for ${key}`)
    return binding.run
  }

  it('defers in normal mode (so the arrow becomes a Vim motion)', () => {
    const view = mountVim('hello world') // codemirror-vim starts in normal mode
    expect(arrowRun('ArrowLeft')(view)).toBe(false)
    expect(arrowRun('ArrowDown')(view)).toBe(false)
  })

  it('defers in visual mode (so the arrow extends the selection like hjkl)', () => {
    const view = mountVim('hello world')
    press(view, 'v', 86) // enter visual mode
    expect(arrowRun('ArrowRight')(view)).toBe(false)
    expect(arrowRun('ArrowUp')(view)).toBe(false)
  })

  it('moves natively in insert mode (Vim does not map insert-mode arrows)', () => {
    const view = mountVim('hello world')
    press(view, 'i', 73) // enter insert mode
    // Native cursorCharRight/etc. handle it (return true) so the caret still moves.
    expect(arrowRun('ArrowRight')(view)).toBe(true)
  })
})
