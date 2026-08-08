import { useStore } from '../store'

/**
 * Hand the keyboard to the sidebar for real: set the focused panel AND move
 * DOM focus into the sidebar container. Mirrors focusEditorNormalMode's
 * retry: a closing modal (command palette) restores focus to whatever held
 * it before opening on unmount, which can be a self-keyed surface like the
 * database grid. That restore both re-steals the keys and re-claims the
 * focused panel, so a single unretried focus() loses the race and "Focus
 * Sidebar" silently does nothing.
 */
export function focusSidebarPanel(
  options: { attempts?: number; delayMs?: number } = {}
): void {
  const attempts = Math.max(1, options.attempts ?? 4)
  const delayMs = Math.max(0, options.delayMs ?? 16)

  // The store write happens NOW, not inside the rAF: the palette's run
  // epilogue reads focusedPanel right after the command returns to decide
  // whether to hand focus to the editor, and a deferred write makes it see
  // the old 'editor' value and start a competing focus-retry loop that the
  // sidebar then loses.
  useStore.getState().setFocusedPanel('sidebar')

  const run = (remaining: number): void => {
    useStore.getState().setFocusedPanel('sidebar')
    const aside = document.querySelector<HTMLElement>('[data-zen-sidebar]')
    aside?.focus()
    const settled =
      !!aside && !!document.activeElement && aside.contains(document.activeElement)
    if (!settled && remaining > 1) {
      window.setTimeout(() => run(remaining - 1), delayMs)
    }
  }

  requestAnimationFrame(() => run(attempts))
}
