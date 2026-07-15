import type { NoteMeta } from '@shared/ipc'
import { allLeaves, findLeaf, type PaneLayout } from './pane-layout'

export type BufferNavigationTarget =
  | { kind: 'focus'; paneId: string; path: string }
  | { kind: 'open'; paneId: string; path: string }
  | { kind: 'create-quick' }
  | { kind: 'none' }

type BufferNote = Pick<NoteMeta, 'path' | 'folder' | 'updatedAt'>

export interface BufferNavigationRuntime {
  paneLayout: PaneLayout
  activePaneId: string
  notes: BufferNote[]
  focusTabInPane: (paneId: string, path: string) => Promise<void>
  openNoteInPane: (paneId: string, path: string) => Promise<void>
  createAndOpen: (
    folder: 'quick',
    subpath: string,
    options: { focusTitle: boolean }
  ) => Promise<unknown>
}

export function getBufferNavigationTarget(
  paneLayout: PaneLayout,
  activePaneId: string,
  notes: BufferNote[],
  delta: 1 | -1
): BufferNavigationTarget {
  const leaf = findLeaf(paneLayout, activePaneId)
  if (!leaf) return { kind: 'none' }

  // Scoped to this pane's own tabs only — with a split, cycling must never
  // "jump" into a neighboring pane's tabs, no matter how many panes there are.
  const seen = new Set<string>()
  const order: string[] = []
  for (const path of leaf.tabs) {
    if (seen.has(path)) continue
    seen.add(path)
    order.push(path)
  }

  if (order.length < 2) {
    // Too few tabs in THIS pane to cycle. Fall back to opening a recent note
    // here — excluding anything already open in any pane (not just this one),
    // so the fallback never offers a note that's already visible elsewhere.
    const openElsewhere = new Set<string>()
    for (const candidate of allLeaves(paneLayout)) {
      for (const path of candidate.tabs) openElsewhere.add(path)
    }
    const fallback = notes
      .filter((note) => note.folder !== 'trash')
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const note of fallback) {
      if (openElsewhere.has(note.path)) continue
      if (seen.has(note.path)) continue
      seen.add(note.path)
      order.push(note.path)
    }
  }

  if (order.length < 2) return { kind: 'create-quick' }

  const baseIndex = leaf.activeTab ? order.indexOf(leaf.activeTab) : -1
  const startIndex = baseIndex >= 0 ? baseIndex : 0
  const nextIndex = (startIndex + delta + order.length) % order.length
  const nextPath = order[nextIndex]

  if (leaf.tabs.includes(nextPath)) {
    return { kind: 'focus', paneId: leaf.id, path: nextPath }
  }
  return { kind: 'open', paneId: leaf.id, path: nextPath }
}

export function navigateActiveBuffer(
  runtime: BufferNavigationRuntime,
  delta: 1 | -1
): void {
  const target = getBufferNavigationTarget(
    runtime.paneLayout,
    runtime.activePaneId,
    runtime.notes,
    delta
  )

  if (target.kind === 'focus') {
    void runtime.focusTabInPane(target.paneId, target.path)
    return
  }
  if (target.kind === 'open') {
    void runtime.openNoteInPane(target.paneId, target.path)
    return
  }
  if (target.kind === 'create-quick') {
    void runtime.createAndOpen('quick', '', { focusTitle: true })
  }
}

/**
 * Resolve the Nth tab (0-indexed, left to right) in the active pane — the
 * Ctrl+1..9 direct-jump shortcuts. Unlike `getBufferNavigationTarget`, this
 * never falls back to a recent note or a new quick note: with no tab at that
 * position, there's simply nothing to jump to.
 */
export function getPaneTabAtIndex(
  paneLayout: PaneLayout,
  activePaneId: string,
  index: number
): BufferNavigationTarget {
  const leaf = findLeaf(paneLayout, activePaneId)
  if (!leaf) return { kind: 'none' }
  const path = leaf.tabs[index]
  if (!path || path === leaf.activeTab) return { kind: 'none' }
  return { kind: 'focus', paneId: leaf.id, path }
}

export function focusPaneTabByIndex(
  runtime: Pick<BufferNavigationRuntime, 'paneLayout' | 'activePaneId' | 'focusTabInPane'>,
  index: number
): void {
  const target = getPaneTabAtIndex(runtime.paneLayout, runtime.activePaneId, index)
  if (target.kind === 'focus') {
    void runtime.focusTabInPane(target.paneId, target.path)
  }
}
