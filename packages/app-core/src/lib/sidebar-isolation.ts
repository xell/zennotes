// Shared resolver for "which folder is currently selected in the sidebar" used
// by both the isolate shortcut (App.tsx) and the toolbar button (Sidebar.tsx).
//
// Clicking a folder row and stopping on one with vim j/k both converge on a
// single piece of state, `sidebarCursorIndex`: the sidebar container's
// onMouseDownCapture syncs the cursor from the clicked row, and VimNav drives
// the same index on cursor moves. So "the folder I clicked, or the folder I
// stopped on" is exactly "the row at that index". Isolation is restricted to
// the notes/inbox tree, so only inbox folder rows with a non-empty subpath
// qualify (the inbox root, files, and system rows return null).

export interface IsolationTarget {
  folder: 'inbox'
  subpath: string
}

export function selectedInboxFolderForIsolation(
  cursorIndex: number,
): IsolationTarget | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector<HTMLElement>(
    `[data-sidebar-idx="${cursorIndex}"]`,
  )
  if (!el) return null
  if (el.dataset.sidebarType !== 'folder') return null
  if (el.dataset.sidebarFolder !== 'inbox') return null
  const subpath = el.dataset.sidebarSubpath ?? ''
  return subpath ? { folder: 'inbox', subpath } : null
}

/** Parent of a folder subpath, or '' when it is a single top-level segment (its
 *  parent is the vault root, which cannot be isolated). "a/b/c" → "a/b". */
export function parentSubpath(subpath: string): string {
  const i = subpath.lastIndexOf('/')
  return i < 0 ? '' : subpath.slice(0, i)
}

/** Go up one level in isolated mode. Moves to the parent folder (revealing the
 *  folder you left), or — when the parent is the vault root — confirms, then
 *  exits isolation. Shared by the `-` key, the global shortcut, the dropdown,
 *  and the command so the confirm/exit behaviour lives in one place. */
export async function goUpIsolationWithConfirm(): Promise<void> {
  const { useStore } = await import('../store')
  const { confirmApp } = await import('./confirm-requests')
  const outcome = useStore.getState().goUpIsolation()
  if (outcome !== 'would-exit') return
  const ok = await confirmApp({
    title: 'Exit isolated mode?',
    description: 'Going up from here leaves the isolated folder. Show the full note tree again?',
    confirmLabel: 'Exit',
  })
  if (ok) useStore.getState().exitIsolation()
}
