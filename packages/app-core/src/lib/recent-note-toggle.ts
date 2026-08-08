export interface RecentNoteEntry {
  path: string
}

export function recentNoteToggleTarget(
  currentPath: string | null,
  history: readonly RecentNoteEntry[],
  availablePaths?: ReadonlySet<string>
): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const path = history[index]?.path
    if (!path || path === currentPath || path.startsWith('zen://')) continue
    if (availablePaths && !availablePaths.has(path)) continue
    return path
  }
  return null
}
