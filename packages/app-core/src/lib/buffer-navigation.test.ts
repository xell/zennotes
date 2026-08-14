import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import type { PaneLayout } from './pane-layout'
import { getBufferNavigationTarget, getBufferSelectTarget, getPaneTabAtIndex } from './buffer-navigation'

function note(path: string, updatedAt: number, folder: NoteMeta['folder'] = 'inbox'): Pick<NoteMeta, 'path' | 'folder' | 'updatedAt'> {
  return { path, folder, updatedAt }
}

function leaf(id: string, tabs: string[], activeTab: string | null = tabs[0] ?? null): PaneLayout {
  return { kind: 'leaf', id, tabs, pinnedTabs: [], activeTab }
}

describe('getBufferNavigationTarget', () => {
  it('moves to the next visible buffer in the active pane', () => {
    const layout = leaf('pane-a', ['one.md', 'two.md'], 'one.md')

    expect(getBufferNavigationTarget(layout, 'pane-a', [], 1)).toEqual({
      kind: 'focus',
      paneId: 'pane-a',
      path: 'two.md'
    })
  })

  it('never jumps to a neighboring pane, even with just one tab here and one there', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-a', ['one.md'], 'one.md'),
        leaf('pane-b', ['two.md'], 'two.md')
      ]
    }

    // pane-b has only one tab of its own, and there's no other note to fall
    // back to (one.md is "open elsewhere" so it's excluded) — this must NOT
    // resolve by reaching into pane-a's tabs.
    expect(getBufferNavigationTarget(layout, 'pane-b', [], -1)).toEqual({
      kind: 'create-quick'
    })
  })

  it('stays within the active pane when each side of a split has multiple buffers', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-a', ['a1.md', 'a2.md', 'a3.md'], 'a3.md'),
        leaf('pane-b', ['b1.md', 'b2.md'], 'b1.md')
      ]
    }

    // Wrapping past the right edge of pane-a's own tabs must land back on
    // pane-a's first tab, not spill into pane-b.
    expect(getBufferNavigationTarget(layout, 'pane-a', [], 1)).toEqual({
      kind: 'focus',
      paneId: 'pane-a',
      path: 'a1.md'
    })

    // Same for pane-b wrapping backward past its own left edge.
    expect(getBufferNavigationTarget(layout, 'pane-b', [], -1)).toEqual({
      kind: 'focus',
      paneId: 'pane-b',
      path: 'b2.md'
    })
  })

  it('falls back to a recent note in the current pane, not a sibling pane\'s existing tabs', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-a', ['one.md'], 'one.md'),
        leaf('pane-b', ['two.md', 'three.md'], 'two.md')
      ]
    }
    const notes = [note('fresh.md', 5), note('one.md', 1)]

    // pane-a only has one tab of its own, so it falls back to the most
    // recent note not already open anywhere — never to pane-b's tabs.
    expect(getBufferNavigationTarget(layout, 'pane-a', notes, 1)).toEqual({
      kind: 'open',
      paneId: 'pane-a',
      path: 'fresh.md'
    })
  })

  it('stays scoped to its own pane with three panes side by side', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [1 / 3, 1 / 3, 1 / 3],
      children: [
        leaf('pane-a', ['a1.md', 'a2.md'], 'a1.md'),
        leaf('pane-b', ['b1.md', 'b2.md', 'b3.md'], 'b2.md'),
        leaf('pane-c', ['c1.md', 'c2.md'], 'c1.md')
      ]
    }

    // The middle pane is flanked on both sides — must not drift into either.
    expect(getBufferNavigationTarget(layout, 'pane-b', [], 1)).toEqual({
      kind: 'focus',
      paneId: 'pane-b',
      path: 'b3.md'
    })
    expect(getBufferNavigationTarget(layout, 'pane-b', [], -1)).toEqual({
      kind: 'focus',
      paneId: 'pane-b',
      path: 'b1.md'
    })
  })

  it('stays scoped to its own pane when splits are nested', () => {
    // A row split whose second child is itself a column split — i.e. one
    // pane on the left, two stacked panes on the right.
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-left', ['l1.md', 'l2.md'], 'l1.md'),
        {
          kind: 'split',
          id: 'right-stack',
          direction: 'column',
          sizes: [0.5, 0.5],
          children: [
            leaf('pane-top', ['t1.md', 't2.md'], 't2.md'),
            leaf('pane-bottom', ['bo1.md'], 'bo1.md')
          ]
        }
      ]
    }

    // Wraps within the nested top pane, not into pane-left or pane-bottom.
    expect(getBufferNavigationTarget(layout, 'pane-top', [], 1)).toEqual({
      kind: 'focus',
      paneId: 'pane-top',
      path: 't1.md'
    })
  })

  it('falls back to recent live notes when only one tab is open', () => {
    const layout = leaf('pane-a', ['one.md'], 'one.md')
    const notes = [
      note('trashed.md', 4, 'trash'),
      note('three.md', 3),
      note('two.md', 2),
      note('one.md', 1)
    ]

    expect(getBufferNavigationTarget(layout, 'pane-a', notes, 1)).toEqual({
      kind: 'open',
      paneId: 'pane-a',
      path: 'three.md'
    })
  })

  it('creates a quick note when there is nothing else to visit', () => {
    const layout = leaf('pane-a', [], null)

    expect(getBufferNavigationTarget(layout, 'pane-a', [], 1)).toEqual({
      kind: 'create-quick'
    })
  })

  it('walks back multiple tabs for {count}gT, wrapping past the start', () => {
    const layout = leaf('pane-a', ['one.md', 'two.md', 'three.md'], 'two.md')

    // 4 back from index 1 in a 3-tab ring lands on index 0.
    expect(getBufferNavigationTarget(layout, 'pane-a', [], -4)).toEqual({
      kind: 'focus',
      paneId: 'pane-a',
      path: 'one.md'
    })
  })
})

describe('getBufferSelectTarget (#497)', () => {
  it('selects the Nth tab, counted across panes in cycle order', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-a', ['one.md', 'two.md'], 'one.md'),
        leaf('pane-b', ['three.md'], 'three.md')
      ]
    }

    expect(getBufferSelectTarget(layout, 'pane-a', 3)).toEqual({
      kind: 'focus',
      paneId: 'pane-b',
      path: 'three.md'
    })
  })

  it('clamps a too-large index to the last tab, like a big {count}gt in vim', () => {
    const layout = leaf('pane-a', ['one.md', 'two.md'], 'one.md')

    expect(getBufferSelectTarget(layout, 'pane-a', 9)).toEqual({
      kind: 'focus',
      paneId: 'pane-a',
      path: 'two.md'
    })
  })

  it('targets open tabs only, never the recent-notes fallback', () => {
    const layout = leaf('pane-a', [], null)

    expect(getBufferSelectTarget(layout, 'pane-a', 1)).toEqual({ kind: 'none' })
  })
})

describe('getPaneTabAtIndex', () => {
  it('jumps to the Nth tab (0-indexed) in the active pane', () => {
    const layout = leaf('pane-a', ['a1.md', 'a2.md', 'a3.md'], 'a1.md')

    expect(getPaneTabAtIndex(layout, 'pane-a', 2)).toEqual({
      kind: 'focus',
      paneId: 'pane-a',
      path: 'a3.md'
    })
  })

  it('is a no-op when there is no tab at that position', () => {
    const layout = leaf('pane-a', ['a1.md', 'a2.md'], 'a1.md')

    expect(getPaneTabAtIndex(layout, 'pane-a', 5)).toEqual({ kind: 'none' })
  })

  it('is a no-op when that index is already the active tab', () => {
    const layout = leaf('pane-a', ['a1.md', 'a2.md'], 'a2.md')

    expect(getPaneTabAtIndex(layout, 'pane-a', 1)).toEqual({ kind: 'none' })
  })

  it('never reaches into a sibling pane, even when it has a tab at that index', () => {
    const layout: PaneLayout = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('pane-a', ['a1.md'], 'a1.md'),
        leaf('pane-b', ['b1.md', 'b2.md'], 'b1.md')
      ]
    }

    // pane-a has no second tab of its own — must not resolve to pane-b's b2.md.
    expect(getPaneTabAtIndex(layout, 'pane-a', 1)).toEqual({ kind: 'none' })
  })
})
