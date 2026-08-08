// Suppress the Linux primary-selection paste that rides on a middle click.
//
// On Linux, middle click is two things at once: our "close this tab" gesture
// and the desktop's "paste the PRIMARY selection" gesture. The textbook
// defense (preventDefault on the tab's mousedown and auxclick) is already in
// place and is not enough everywhere: under Wayland, Chromium can deliver the
// paste to the FOCUSED editable rather than to the element under the pointer,
// so cancelling events on the tab never touches it and the selection lands in
// the editor that takes over after the close (#498).
//
// The one chokepoint every delivery path shares is the `paste` clipboard event
// itself: Blink dispatches it, cancelable, to the target before inserting
// anything. So the close gesture arms a capture-phase listener at the window
// for a few tens of milliseconds, and whatever paste arrives inside that
// window is cancelled before CodeMirror can see it. A real paste the user asks
// for cannot land inside the window: hands are on the mouse mid-click, and the
// guard disarms itself immediately after one event or the deadline, whichever
// comes first.

import { isLinuxPlatform } from './keymaps'

/** Long enough for the click's paste to arrive, far too short to eat a real one. */
const GUARD_WINDOW_MS = 150

let disarm: (() => void) | null = null

/**
 * Arm the guard for one paste or `windowMs`, whichever comes first.
 *
 * Call it from the middle-click handler BEFORE closing the tab, so the guard
 * exists no matter how quickly the paste follows. Re-arming while armed just
 * extends the deadline; two guards would eat two pastes.
 *
 * A no-op off Linux: primary-selection paste is a Linux desktop convention, so
 * anywhere else the guard could only ever cancel a paste the user meant.
 */
export function armMiddleClickPasteGuard(windowMs: number = GUARD_WINDOW_MS): void {
  if (!isLinuxPlatform()) return
  disarm?.()

  const onPaste = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    disarm?.()
  }
  const timer = window.setTimeout(() => disarm?.(), windowMs)

  disarm = () => {
    window.clearTimeout(timer)
    window.removeEventListener('paste', onPaste, true)
    disarm = null
  }
  window.addEventListener('paste', onPaste, true)
}
