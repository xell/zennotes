function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export const ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT = 'zen:open-editor-context-menu'

/**
 * Where a keyboard-opened menu anchors on an element: just inside its left
 * edge, vertically centred, clamped to the viewport so a row at the screen's
 * edge cannot push the menu off it.
 */
export function keyboardMenuPosition(rect: DOMRect): { x: number; y: number } {
  const x = Math.min(
    window.innerWidth - 12,
    Math.max(12, rect.left + Math.min(28, Math.max(12, rect.width * 0.25)))
  )
  const y = Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2))
  return { x, y }
}

export function dispatchKeyboardContextMenu(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const { x, y } = keyboardMenuPosition(el.getBoundingClientRect())
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y
    })
  )
}

export function findTabContextMenuTarget(
  paneId: string,
  path: string
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    [
      '[data-tab-menu-target="true"]',
      `[data-tab-pane-id="${cssEscape(paneId)}"]`,
      `[data-tab-path="${cssEscape(path)}"]`
    ].join('')
  )
}
