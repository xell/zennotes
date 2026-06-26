import { describe, expect, it } from 'vitest'
import {
  applyManualMove,
  applyManualPlace,
  manualItemCompare,
  manualOrderCompare,
  parentDirOf,
  remapManualOrderForMove,
  sameFolder,
  type ManualOrderItem
} from './manual-order'

const fItem = (path: string, name: string, s = 0): ManualOrderItem => ({
  path,
  kind: 'folder',
  name,
  siblingOrder: s
})
const nItem = (path: string, s = 0): ManualOrderItem => ({
  path,
  kind: 'note',
  name: '',
  siblingOrder: s
})

describe('parentDirOf / sameFolder', () => {
  it('returns the directory, or "" at the root', () => {
    expect(parentDirOf('inbox/Sub/Note.md')).toBe('inbox/Sub')
    expect(parentDirOf('inbox/Note.md')).toBe('inbox')
    expect(parentDirOf('Note.md')).toBe('')
  })
  it('detects siblings by parent dir', () => {
    expect(sameFolder('inbox/a.md', 'inbox/b.md')).toBe(true)
    expect(sameFolder('inbox/a.md', 'inbox/Sub/b.md')).toBe(false)
  })
})

describe('applyManualMove', () => {
  const order = ['a', 'b', 'c', 'd']
  it('moves before a target', () => {
    expect(applyManualMove(order, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  })
  it('moves after a target', () => {
    expect(applyManualMove(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })
  it('is a no-op when the target is absent', () => {
    expect(applyManualMove(order, 'a', 'zzz', 'before')).toEqual(order)
  })
  it('does not mutate the input', () => {
    const copy = [...order]
    applyManualMove(order, 'a', 'c', 'after')
    expect(order).toEqual(copy)
  })
})

describe('applyManualPlace', () => {
  const order = ['a', 'b', 'c', 'd']

  it('places before a target', () => {
    expect(applyManualPlace(order, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('appends when beforePath is null', () => {
    expect(applyManualPlace(order, 'b', null)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('appends when beforePath is not present', () => {
    expect(applyManualPlace(order, 'a', 'zzz')).toEqual(['b', 'c', 'd', 'a'])
  })

  it('keeps position when dropping an item before itself (the self-boundary bug)', () => {
    expect(applyManualPlace(order, 'b', 'b')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is idempotent when placed before its current successor', () => {
    expect(applyManualPlace(order, 'b', 'c')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('inserts an item that is not yet in the list (a cross-folder arrival)', () => {
    expect(applyManualPlace(['a', 'b'], 'c', 'b')).toEqual(['a', 'c', 'b'])
  })

  it('does not mutate the input', () => {
    const copy = [...order]
    applyManualPlace(order, 'a', 'c')
    expect(order).toEqual(copy)
  })
})

describe('manualOrderCompare', () => {
  const order = ['c.md', 'a.md', 'b.md'] // user-chosen order

  it('orders listed notes by their index', () => {
    expect(Math.sign(manualOrderCompare(order, 'c.md', 0, 'a.md', 1))).toBe(-1)
    expect(Math.sign(manualOrderCompare(order, 'b.md', 0, 'c.md', 1))).toBe(1)
  })

  it('puts listed notes before unlisted ones, which keep file order', () => {
    // 'a.md' is listed, 'new.md' is not → listed first
    expect(manualOrderCompare(order, 'a.md', 9, 'new.md', 0)).toBe(-1)
    // both unlisted → fall back to siblingOrder
    expect(manualOrderCompare(order, 'x.md', 2, 'y.md', 5)).toBe(-3)
  })

  it('falls back to siblingOrder with no stored order', () => {
    expect(manualOrderCompare(undefined, 'x.md', 1, 'y.md', 4)).toBe(-3)
  })

  it('is a total order (sort is stable and deterministic)', () => {
    const notes = [
      { path: 'new.md', s: 5 },
      { path: 'b.md', s: 1 },
      { path: 'c.md', s: 0 },
      { path: 'a.md', s: 2 }
    ]
    const sorted = [...notes].sort((x, y) =>
      manualOrderCompare(order, x.path, x.s, y.path, y.s)
    )
    expect(sorted.map((n) => n.path)).toEqual(['c.md', 'a.md', 'b.md', 'new.md'])
  })
})

describe('manualItemCompare (notes + folders)', () => {
  it('orders listed items by index regardless of kind', () => {
    const order = ['n.md', 'Folder', 'm.md']
    expect(Math.sign(manualItemCompare(order, nItem('n.md'), fItem('Folder', 'Folder')))).toBe(-1)
    expect(Math.sign(manualItemCompare(order, nItem('m.md'), fItem('Folder', 'Folder')))).toBe(1)
  })

  it('puts listed items before unlisted ones', () => {
    const order = ['Folder']
    expect(manualItemCompare(order, fItem('Folder', 'Folder'), nItem('new.md'))).toBe(-1)
    expect(manualItemCompare(order, nItem('new.md'), fItem('Folder', 'Folder'))).toBe(1)
  })

  it('defaults unlisted folders before unlisted notes', () => {
    expect(manualItemCompare(undefined, fItem('F', 'F'), nItem('a.md'))).toBe(-1)
    expect(manualItemCompare(undefined, nItem('a.md'), fItem('F', 'F'))).toBe(1)
  })

  it('orders unlisted folders by natural name (numeric-aware)', () => {
    expect(
      Math.sign(manualItemCompare(undefined, fItem('a/2 Foo', '2 Foo'), fItem('a/10 Foo', '10 Foo')))
    ).toBe(-1)
  })

  it('orders unlisted notes by file order', () => {
    expect(manualItemCompare(undefined, nItem('a.md', 1), nItem('b.md', 4))).toBe(-3)
  })

  it('produces the pre-manual look (folders first) with no stored order', () => {
    const items = [
      nItem('z.md', 0),
      fItem('B', 'B', 1),
      nItem('a.md', 2),
      fItem('A', 'A', 0)
    ]
    const sorted = [...items].sort((a, b) => manualItemCompare(undefined, a, b))
    expect(sorted.map((i) => i.path)).toEqual(['A', 'B', 'z.md', 'a.md'])
  })

  it('interleaves once a manual order lists both kinds', () => {
    const order = ['z.md', 'A', 'a.md']
    const items = [fItem('A', 'A', 0), nItem('z.md', 0), nItem('a.md', 1), fItem('B', 'B', 1)]
    const sorted = [...items].sort((a, b) => manualItemCompare(order, a, b))
    // listed in order, then the unlisted folder B (folders-before-notes default)
    expect(sorted.map((i) => i.path)).toEqual(['z.md', 'A', 'a.md', 'B'])
  })
})

describe('remapManualOrderForMove', () => {
  it('rewrites a note rename in place (same parent)', () => {
    const map = { inbox: ['inbox/a.md', 'inbox/c.md'] }
    expect(remapManualOrderForMove(map, 'inbox/a.md', 'inbox/b.md', false)).toEqual({
      inbox: ['inbox/b.md', 'inbox/c.md']
    })
  })

  it('drops a moved note from its old parent (different parent)', () => {
    const map = {
      inbox: ['inbox/a.md', 'inbox/c.md'],
      'inbox/Sub': ['inbox/Sub/x.md']
    }
    expect(remapManualOrderForMove(map, 'inbox/a.md', 'inbox/Sub/a.md', false)).toEqual({
      inbox: ['inbox/c.md'],
      'inbox/Sub': ['inbox/Sub/x.md']
    })
  })

  it('leaves the map untouched when moving an unordered note', () => {
    const map = { inbox: ['inbox/c.md'] }
    expect(remapManualOrderForMove(map, 'inbox/a.md', 'inbox/Sub/a.md', false)).toEqual(map)
  })

  it('re-keys and rewrites a folder subtree on rename (same parent)', () => {
    const map = {
      inbox: ['inbox/Old', 'inbox/z.md'],
      'inbox/Old': ['inbox/Old/1.md', 'inbox/Old/2.md'],
      'inbox/Old/Sub': ['inbox/Old/Sub/x.md']
    }
    expect(remapManualOrderForMove(map, 'inbox/Old', 'inbox/New', true)).toEqual({
      inbox: ['inbox/New', 'inbox/z.md'],
      'inbox/New': ['inbox/New/1.md', 'inbox/New/2.md'],
      'inbox/New/Sub': ['inbox/New/Sub/x.md']
    })
  })

  it('re-keys a folder subtree and drops it from the old parent on reparent', () => {
    const map = {
      inbox: ['inbox/A', 'inbox/z.md'],
      'inbox/A': ['inbox/A/1.md'],
      'inbox/B': ['inbox/B/y.md']
    }
    expect(remapManualOrderForMove(map, 'inbox/A', 'inbox/B/A', true)).toEqual({
      inbox: ['inbox/z.md'],
      'inbox/B/A': ['inbox/B/A/1.md'],
      'inbox/B': ['inbox/B/y.md']
    })
  })

  it('does not touch a sibling whose name shares the folder prefix', () => {
    const map = {
      inbox: ['inbox/Foo', 'inbox/Foobar.md'],
      'inbox/Foo': ['inbox/Foo/1.md'],
      'inbox/Foobar.md': [] // not a real key, but proves prefix safety on keys too
    }
    const out = remapManualOrderForMove(map, 'inbox/Foo', 'inbox/Renamed', true)
    expect(out.inbox).toEqual(['inbox/Renamed', 'inbox/Foobar.md'])
    expect(out['inbox/Renamed']).toEqual(['inbox/Renamed/1.md'])
    expect(out['inbox/Foobar.md']).toEqual([])
  })

  it('is a no-op when oldPath === newPath', () => {
    const map = { inbox: ['inbox/a.md'], 'inbox/A': ['inbox/A/x.md'] }
    expect(remapManualOrderForMove(map, 'inbox/A', 'inbox/A', true)).toEqual(map)
  })

  it('does not mutate the input map', () => {
    const map = { inbox: ['inbox/Old'], 'inbox/Old': ['inbox/Old/1.md'] }
    const snapshot = structuredClone(map)
    remapManualOrderForMove(map, 'inbox/Old', 'inbox/New', true)
    expect(map).toEqual(snapshot)
  })
})
