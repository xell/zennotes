import { describe, expect, it } from 'vitest'
import { resolveDropTarget, type FlatRow } from './sidebar-drop-resolver'

/**
 * A small inbox-at-root tree (sectionRootDir = ''):
 *
 *   0  a.md            depth 0
 *   1  F/              depth 0  (expanded)
 *   2    F/x.md        depth 1
 *   3    F/G/          depth 1  (expanded)
 *   4      F/G/y.md    depth 2
 *   5  b.md            depth 0
 *   6  H/              depth 0  (collapsed, has children)
 */
const note = (path: string, depth: number): FlatRow => ({
  path,
  parentDir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  depth,
  isFolder: false,
  isExpanded: false,
  hasChildren: false,
})
const folder = (
  path: string,
  depth: number,
  opts: { expanded?: boolean; hasChildren?: boolean } = {},
): FlatRow => ({
  path,
  parentDir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  depth,
  isFolder: true,
  isExpanded: opts.expanded ?? false,
  hasChildren: opts.hasChildren ?? true,
})

const rows: FlatRow[] = [
  note('a.md', 0),
  folder('F', 0, { expanded: true }),
  note('F/x.md', 1),
  folder('F/G', 1, { expanded: true }),
  note('F/G/y.md', 2),
  note('b.md', 0),
  folder('H', 0, { expanded: false }),
]

const resolve = (
  gapIndex: number,
  pointerDepth: number,
  dragged = { path: 'drag.md', isFolder: false },
) =>
  resolveDropTarget({
    rows,
    gapIndex,
    pointerDepth,
    sectionRootDir: '',
    draggedPath: dragged.path,
    draggedIsFolder: dragged.isFolder,
  })

describe('resolveDropTarget — sibling positioning', () => {
  it('inserts between two root items at depth 0', () => {
    // gap after a.md (0), before F (1)
    const r = resolve(1, 0)
    expect(r).toMatchObject({ parentDir: '', beforePath: 'F', depth: 0, valid: true })
  })

  it('inserts before the very first row', () => {
    const r = resolve(0, 0)
    expect(r).toMatchObject({ parentDir: '', beforePath: 'a.md', depth: 0 })
  })

  it('appends at the end of the list (no row below)', () => {
    const r = resolve(rows.length, 0)
    expect(r).toMatchObject({ parentDir: '', beforePath: null })
  })
})

describe('resolveDropTarget — into a folder', () => {
  it('drops into an expanded folder as its first child', () => {
    // gap after F (1), before F/x.md (2); indent to depth 1
    const r = resolve(2, 1)
    expect(r).toMatchObject({ parentDir: 'F', beforePath: 'F/x.md', depth: 1 })
  })

  it('cannot insert at root depth between a folder and its first child', () => {
    // The band is clamped to the child level (below is depth 1), so a shallow
    // pointer still resolves into the folder, never as a root sibling here.
    const r = resolve(2, 0)
    expect(r.depth).toBe(1)
    expect(r.parentDir).toBe('F')
  })

  it('drops into a collapsed folder (append) when indented past it', () => {
    // gap after H (6), nothing below; indent to depth 1 → into H
    const r = resolve(7, 1)
    expect(r).toMatchObject({ parentDir: 'H', beforePath: null, depth: 1 })
  })
})

describe('resolveDropTarget — the ambiguous deep gap', () => {
  // gap after F/G/y.md (4, depth 2), before b.md (5, depth 0).
  it('depth 0 pops all the way out to root', () => {
    expect(resolve(5, 0)).toMatchObject({ parentDir: '', beforePath: 'b.md', depth: 0 })
  })
  it('depth 1 appends to F', () => {
    expect(resolve(5, 1)).toMatchObject({ parentDir: 'F', beforePath: null, depth: 1 })
  })
  it('depth 2 appends to F/G', () => {
    expect(resolve(5, 2)).toMatchObject({ parentDir: 'F/G', beforePath: null, depth: 2 })
  })
  it('clamps an over-deep pointer to the deepest legal level', () => {
    expect(resolve(5, 9).depth).toBe(2)
  })
  it('clamps a negative pointer to root', () => {
    expect(resolve(5, -3).depth).toBe(0)
  })
})

describe('resolveDropTarget — notes are never parents', () => {
  it('caps the depth so you cannot nest into a note', () => {
    // gap after a.md (0, a note); even indented, max depth is the note's level
    const r = resolve(1, 5)
    expect(r.depth).toBe(0)
    expect(r.parentDir).toBe('')
  })
})

describe('resolveDropTarget — folder descendant-guard', () => {
  it('rejects dropping a folder into itself', () => {
    // into F as first child, but the dragged item IS F
    const r = resolve(2, 1, { path: 'F', isFolder: true })
    expect(r.parentDir).toBe('F')
    expect(r.valid).toBe(false)
  })

  it('rejects dropping a folder into its own descendant', () => {
    // into F/G, dragging F
    const r = resolve(5, 2, { path: 'F', isFolder: true })
    expect(r.parentDir).toBe('F/G')
    expect(r.valid).toBe(false)
  })

  it('allows dropping a folder beside itself at the root', () => {
    const r = resolve(1, 0, { path: 'F', isFolder: true })
    expect(r.parentDir).toBe('')
    expect(r.valid).toBe(true)
  })

  it('is not fooled by a sibling whose name shares a prefix', () => {
    const tricky: FlatRow[] = [folder('Foo', 0), folder('Foobar', 0)]
    const r = resolveDropTarget({
      rows: tricky,
      gapIndex: 2,
      pointerDepth: 0,
      sectionRootDir: '',
      draggedPath: 'Foo',
      draggedIsFolder: true,
    })
    // target parent is root, not "inside Foo" — Foobar must not match Foo/
    expect(r.valid).toBe(true)
    expect(r.parentDir).toBe('')
  })
})
