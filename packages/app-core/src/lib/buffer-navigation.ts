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

// gt/gT and Ctrl+1..9 stay scoped to the active pane's own tabs (see below);
// {count}gt and Alt+digits (#497) are pane-tree-wide by design, so cycling and
// direct-jump intentionally disagree about which tab is "number 3" across a
// split — direct-jump is meant to reach any open tab, cycling never "jumps"
// into a neighboring pane. `openTabOrder`/`targetFor` back only the
// pane-tree-wide functions further down; `getBufferNavigationTarget` builds
// its own pane-scoped order and does not use them.
function openTabOrder(paneLayout: PaneLayout): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const leaf of allLeaves(paneLayout)) {
    for (const path of leaf.tabs) {
      if (seen.has(path)) continue
      seen.add(path)
      order.push(path)
    }
  }
  return order
}

function targetFor(
  paneLayout: PaneLayout,
  leafId: string,
  leafTabs: string[],
  path: string
): BufferNavigationTarget {
  const owningLeaf = allLeaves(paneLayout).find((candidate) =>
    candidate.tabs.includes(path)
  )
  if (owningLeaf && owningLeaf.id !== leafId) {
    return { kind: 'focus', paneId: owningLeaf.id, path }
  }
  if (leafTabs.includes(path)) {
    return { kind: 'focus', paneId: leafId, path }
  }
  return { kind: 'open', paneId: leafId, path }
}

export function getBufferNavigationTarget(
  paneLayout: PaneLayout,
  activePaneId: string,
  notes: BufferNote[],
  // number, not 1 | -1: real vim's {count}gT walks back `count` tabs (#497),
  // relative like a repeated gT rather than an absolute jump like {count}gt
  // (that's getBufferSelectTarget below). Editor.tsx passes -repeat here.
  delta: number
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
  // Double modulo: a {count}gT can pass -order.length, which a single
  // "+ order.length" isn't enough to bring back non-negative.
  const nextIndex = (((startIndex + delta) % order.length) + order.length) % order.length
  const nextPath = order[nextIndex]

  if (leaf.tabs.includes(nextPath)) {
    return { kind: 'focus', paneId: leaf.id, path: nextPath }
  }
  return { kind: 'open', paneId: leaf.id, path: nextPath }
}

/** Direct selection for {count}gt and the Alt+digit shortcuts: 1-based index
 *  into the open-tab order. An index past the end lands on the last tab, the
 *  same forgiving read vim gives a too-large {count}gt. Never falls back to
 *  recent notes: "tab 3" means an open tab or nothing. */
export function getBufferSelectTarget(
  paneLayout: PaneLayout,
  activePaneId: string,
  index: number
): BufferNavigationTarget {
  const leaf = findLeaf(paneLayout, activePaneId)
  if (!leaf) return { kind: 'none' }

  const order = openTabOrder(paneLayout)
  if (order.length === 0) return { kind: 'none' }

  const clamped = Math.min(Math.max(Math.trunc(index), 1), order.length)
  return targetFor(paneLayout, leaf.id, leaf.tabs, order[clamped - 1])
}

function applyTarget(runtime: BufferNavigationRuntime, target: BufferNavigationTarget): void {
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
 * position, there's simply nothing to jump to. Deliberately pane-scoped, like
 * `getBufferNavigationTarget` above — see that function's comment. Kept
 * alongside `getBufferSelectTarget`/`selectActiveBuffer` below (#497's
 * pane-tree-wide {count}gt-absolute and Alt+digit shortcuts) rather than
 * merged into it: same "jump to tab N" shape, different scope, both bound.
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

export function navigateActiveBuffer(runtime: BufferNavigationRuntime, delta: number): void {
  applyTarget(
    runtime,
    getBufferNavigationTarget(runtime.paneLayout, runtime.activePaneId, runtime.notes, delta)
  )
}

export function selectActiveBuffer(runtime: BufferNavigationRuntime, index: number): void {
  applyTarget(runtime, getBufferSelectTarget(runtime.paneLayout, runtime.activePaneId, index))
}
