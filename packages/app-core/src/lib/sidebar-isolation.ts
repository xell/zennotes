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
