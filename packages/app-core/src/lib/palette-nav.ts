import type { KeyboardEvent } from 'react'
import { isMacPlatform } from './keymaps'

// Palettes accept three flavours of "move selection": the arrow keys,
// the Emacs-style Ctrl+N/Ctrl+P, and the vim-style Ctrl+J/Ctrl+K. The
// vim pair matters because ZenNotes is keyboard-first and j/k is
// "down/up" everywhere else in the app.
export function isPaletteNextKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowDown' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && (key === 'n' || key === 'j'))
  )
}

export function isPalettePreviousKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase()
  return (
    event.key === 'ArrowUp' ||
    (event.ctrlKey && !event.metaKey && !event.altKey && (key === 'p' || key === 'k'))
  )
}

/**
 * Mod+1..9 (Cmd on Mac, Ctrl elsewhere — matching the app's `Mod` shortcut
 * convention in keymaps.ts) — "jump straight to result N," 0-indexed. Returns
 * null for anything else, including Mod+0 (no result 10 to jump to) or when
 * another modifier (Shift/Alt) is also held, so it doesn't shadow e.g.
 * Cmd+Shift+1.
 */
export function paletteJumpIndexFromEvent(event: KeyboardEvent<HTMLElement>): number | null {
  const mac = isMacPlatform()
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.shiftKey || event.altKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}
