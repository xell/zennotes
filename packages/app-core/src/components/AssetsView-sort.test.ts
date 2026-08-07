// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AssetMeta } from '@shared/ipc'
import {
  assetSortOrderOf,
  parseAssetSortOrder,
  sortAssets,
  type AssetSort
} from './AssetsView'

// #460: the Assets list can be sorted by any column.
function asset(over: Partial<AssetMeta>): AssetMeta {
  return {
    path: over.path ?? over.name ?? 'x',
    name: over.name ?? 'x',
    kind: over.kind ?? 'file',
    size: over.size ?? 0,
    updatedAt: over.updatedAt ?? 0,
    siblingOrder: 0,
    ...over
  } as AssetMeta
}

const A = asset({ name: 'apple.png', kind: 'image', size: 300, updatedAt: 20 })
const B = asset({ name: 'banana.pdf', kind: 'pdf', size: 100, updatedAt: 30 })
const C = asset({ name: 'cherry.zip', kind: 'file', size: 200, updatedAt: 10 })
const LIST = [C, A, B]

// A embeds in 2 notes, B in 1, C in 0.
const usage = new Map<string, string[]>([
  ['apple.png', ['one.md', 'two.md']],
  ['banana.pdf', ['one.md']]
])

const names = (list: AssetMeta[]): string[] => list.map((a) => a.name)
const sort = (key: AssetSort['key'], dir: AssetSort['dir']): string[] =>
  names(sortAssets(LIST, usage, { key, dir }))

describe('#460 — sortAssets', () => {
  it('sorts by name (natural), both directions', () => {
    expect(sort('name', 'asc')).toEqual(['apple.png', 'banana.pdf', 'cherry.zip'])
    expect(sort('name', 'desc')).toEqual(['cherry.zip', 'banana.pdf', 'apple.png'])
  })

  it('sorts by size', () => {
    expect(sort('size', 'asc')).toEqual(['banana.pdf', 'cherry.zip', 'apple.png'])
    expect(sort('size', 'desc')).toEqual(['apple.png', 'cherry.zip', 'banana.pdf'])
  })

  it('sorts by modified date', () => {
    expect(sort('modified', 'asc')).toEqual(['cherry.zip', 'apple.png', 'banana.pdf'])
    expect(sort('modified', 'desc')).toEqual(['banana.pdf', 'apple.png', 'cherry.zip'])
  })

  it('sorts by usage count (unused sinks / rises)', () => {
    // apple(2) > banana(1) > cherry(0)
    expect(sort('used', 'desc')).toEqual(['apple.png', 'banana.pdf', 'cherry.zip'])
    expect(sort('used', 'asc')).toEqual(['cherry.zip', 'banana.pdf', 'apple.png'])
  })

  it('sorts by type, tie-broken by name', () => {
    // kinds: file(cherry) < image(apple) < pdf(banana)
    expect(sort('type', 'asc')).toEqual(['cherry.zip', 'apple.png', 'banana.pdf'])
  })

  it('breaks ties by name so equal rows keep a stable order', () => {
    const x = asset({ name: 'x.png', size: 50 })
    const y = asset({ name: 'y.png', size: 50 })
    const z = asset({ name: 'a.png', size: 50 })
    expect(names(sortAssets([x, y, z], new Map(), { key: 'size', dir: 'asc' }))).toEqual([
      'a.png',
      'x.png',
      'y.png'
    ])
  })

  it('does not mutate the input list', () => {
    const input = [C, A, B]
    sortAssets(input, usage, { key: 'name', dir: 'asc' })
    expect(input).toEqual([C, A, B])
  })
})

// #473: the chosen column is stored as one `<column>-<dir>` preference, so it
// survives leaving the view (and restarting the app).
describe('#473: asset sort order round-trip', () => {
  const ALL: AssetSort[] = (['name', 'used', 'type', 'size', 'modified'] as const).flatMap((key) =>
    (['asc', 'desc'] as const).map((dir) => ({ key, dir }))
  )

  it('round-trips every column and direction', () => {
    for (const sort of ALL) {
      expect(parseAssetSortOrder(assetSortOrderOf(sort))).toEqual(sort)
    }
  })

  it('formats to the values the store accepts', () => {
    expect(assetSortOrderOf({ key: 'modified', dir: 'desc' })).toBe('modified-desc')
    expect(assetSortOrderOf({ key: 'name', dir: 'asc' })).toBe('name-asc')
  })

  it('sorts the same whether given the parsed pref or a literal', () => {
    expect(names(sortAssets(LIST, usage, parseAssetSortOrder('size-desc')))).toEqual(
      names(sortAssets(LIST, usage, { key: 'size', dir: 'desc' }))
    )
  })
})
