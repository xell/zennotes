import { defaultKeymap } from '@codemirror/commands'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'

/**
 * macOS-only Vim keymap conflict (`Ctrl-d` deletes instead of half-page-down).
 *
 * `@codemirror/commands`' `defaultKeymap` folds in the emacs-style control
 * chords as **mac-only** bindings (each entry's `mac` field). On macOS that
 * makes the editor bind, among others:
 *
 *   Ctrl-d → deleteCharForward     Ctrl-a → cursorLineStart
 *   Ctrl-e → cursorLineEnd         Ctrl-f → cursorCharRight
 *   Ctrl-b → cursorCharLeft        Ctrl-v → cursorPageDown   …
 *
 * These collide with Vim's own normal/visual-mode chords (`<C-d>` half-page
 * down, `<C-a>` increment, `<C-v>` visual-block, `<C-f>`/`<C-b>` page, …).
 * Because the keymap's key handler runs at higher precedence than the Vim
 * plugin's, the emacs action wins — so in Vim mode on macOS `Ctrl-d` deletes a
 * character instead of scrolling. (Linux/Windows are unaffected: these bindings
 * are mac-only. `Ctrl-u`, which has no emacs binding, already worked — hence the
 * up/down asymmetry users notice.)
 *
 * The fix is to drop these chords from the editor keymap while Vim mode is on,
 * so Vim receives them and handles them natively. When Vim is off we keep them —
 * they're standard macOS text-editing keys.
 */
const MAC_EMACS_CHORDS = new Set([
  'Ctrl-b',
  'Ctrl-f',
  'Ctrl-p',
  'Ctrl-n',
  'Ctrl-a',
  'Ctrl-e',
  'Ctrl-d',
  'Ctrl-h',
  'Ctrl-k',
  'Ctrl-Alt-h',
  'Ctrl-o',
  'Ctrl-t',
  'Ctrl-v'
])

const isMacEmacsChord = (binding: KeyBinding): boolean =>
  typeof binding.mac === 'string' && MAC_EMACS_CHORDS.has(binding.mac)

/** `defaultKeymap` with the macOS emacs-style control chords removed. */
const defaultKeymapWithoutMacEmacs: readonly KeyBinding[] = defaultKeymap.filter(
  (binding) => !isMacEmacsChord(binding)
)

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/**
 * Vim arrow-key conflict (arrows don't extend the selection in visual mode).
 *
 * `defaultKeymap` binds the arrows to caret motions (`cursorCharLeft`/…) with
 * `preventDefault: true`, and (like the mac emacs chords above) the keymap's
 * handler runs at higher precedence than the Vim plugin's. So in Vim mode the
 * arrows just move the caret — which in *visual* mode collapses the selection
 * instead of extending it the way `h`/`j`/`k`/`l` do (issue #287). `hjkl` have
 * no competing keymap binding, so they were never affected — hence the
 * arrows-vs-hjkl asymmetry users hit.
 *
 * Unlike the emacs chords we can't simply drop the arrows: Vim only maps them
 * to motions in normal/visual mode (`<Left>`→`h`, …), not in *insert* mode, so
 * insert-mode caret movement still relies on these bindings. Instead, in Vim
 * mode each plain-arrow binding defers to the Vim plugin while Vim is in a
 * non-insert mode — returning `false` with no `preventDefault` lets the
 * keypress fall through to the (lower-precedence) Vim plugin, which then
 * applies the motion. Insert mode (and Vim-off) keep the native caret motion.
 * The Shift-arrow selection handlers are left untouched.
 */
function deferArrowsToVim(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.map((binding) => {
    if (!binding.key || !ARROW_KEYS.has(binding.key) || !binding.run) return binding
    const native = binding.run
    return {
      ...binding,
      // Must be false: with preventDefault the event is consumed even when the
      // command returns false, which would re-block the Vim plugin.
      preventDefault: false,
      run: (view: EditorView): boolean => {
        const vim = (getCM(view) as { state?: { vim?: { insertMode?: boolean } } } | null)?.state
          ?.vim
        if (vim && !vim.insertMode) return false
        return native(view)
      }
    }
  })
}

/** Vim-mode keymap: emacs chords stripped, arrows made Vim-aware (see above). */
const vimModeKeymap: readonly KeyBinding[] = deferArrowsToVim(defaultKeymapWithoutMacEmacs)

/**
 * CodeMirror's `defaultKeymap`, made Vim-aware: in Vim mode the macOS
 * emacs-style control chords are stripped so Vim's `<C-d>`/`<C-a>`/`<C-v>`/…
 * bindings work, and the arrow keys defer to Vim in normal/visual mode so they
 * move/extend like `hjkl`; with Vim off the full keymap is used unchanged.
 */
export function vimAwareDefaultKeymap(vimMode: boolean): readonly KeyBinding[] {
  return vimMode ? vimModeKeymap : defaultKeymap
}
