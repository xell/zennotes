import { describe, expect, it } from 'vitest'
import {
  computeTreeVisibility,
  filterModeForQuery,
  matchesQuery,
  type FilterTreeNode
} from './sidebar-filter'

/** Compact tree builder for tests. */
function node(
  name: string,
  subpath: string,
  opts: {
    notes?: [path: string, title: string][]
    assets?: string[]
    children?: FilterTreeNode[]
  } = {}
): FilterTreeNode {
  return {
    name,
    subpath,
    notes: (opts.notes ?? []).map(([path, title]) => ({ path, title })),
    assets: (opts.assets ?? []).map((path) => ({ path })),
    children: opts.children ?? []
  }
}

describe('filterModeForQuery', () => {
  it('treats a leading space as the fuzzy opt-in', () => {
    expect(filterModeForQuery(' ae')).toBe('fuzzy')
    expect(filterModeForQuery('  ae')).toBe('fuzzy')
  })

  it('defaults to substring for a normal query', () => {
    expect(filterModeForQuery('ae')).toBe('substring')
    expect(filterModeForQuery('ae ')).toBe('substring') // trailing space doesn't count
  })
})

describe('matchesQuery', () => {
  it('substring mode (default): contiguous only, no subsequences', () => {
    expect(matchesQuery('team', 'Monthly Team Grouping')).toBe(true)
    expect(matchesQuery('mtg', 'Monthly Team Grouping')).toBe(false)
    expect(matchesQuery('ae', 'Alpha')).toBe(false) // a…e is not contiguous
  })

  it('fuzzy mode: accepts subsequences, rejects non-subsequences', () => {
    expect(matchesQuery('mtg', 'Monthly Team Grouping', 'fuzzy')).toBe(true)
    expect(matchesQuery('ae', 'Apple', 'fuzzy')).toBe(true)
    expect(matchesQuery('the', 'Save Note', 'fuzzy')).toBe(false)
  })

  it('is case-insensitive in both modes', () => {
    expect(matchesQuery('README', 'readme.md')).toBe(true)
    expect(matchesQuery('RDM', 'readme.md', 'fuzzy')).toBe(true)
  })
})

describe('computeTreeVisibility', () => {
  it('returns empty sets for an empty/whitespace query', () => {
    const root = node('inbox', '', { notes: [['inbox/a.md', 'Alpha']] })
    const { leaves, folderSubpaths } = computeTreeVisibility(root, '   ')
    expect(leaves.size).toBe(0)
    expect(folderSubpaths.size).toBe(0)
  })

  it('matches note titles and asset filenames at the root', () => {
    const root = node('inbox', '', {
      notes: [
        ['inbox/alpha.md', 'Alpha'],
        ['inbox/beta.md', 'Beta']
      ],
      assets: ['inbox/alpha-diagram.png', 'inbox/notes.pdf']
    })
    const { leaves } = computeTreeVisibility(root, 'alpha')
    expect(leaves.has('inbox/alpha.md')).toBe(true)
    expect(leaves.has('inbox/alpha-diagram.png')).toBe(true)
    expect(leaves.has('inbox/beta.md')).toBe(false)
    expect(leaves.has('inbox/notes.pdf')).toBe(false)
  })

  it('respects the match mode: substring is strict, fuzzy is loose', () => {
    const root = node('inbox', '', {
      notes: [['inbox/apple.md', 'Apple Pie']]
    })
    // 'ale' is a subsequence of 'Apple Pie' but not a contiguous substring.
    expect(computeTreeVisibility(root, 'ale', 'substring').leaves.size).toBe(0)
    expect(computeTreeVisibility(root, 'ale', 'fuzzy').leaves.has('inbox/apple.md')).toBe(
      true
    )
    // A contiguous part matches in both modes.
    expect(computeTreeVisibility(root, 'pie', 'substring').leaves.has('inbox/apple.md')).toBe(
      true
    )
  })

  it('reveals every ancestor folder of a matching leaf', () => {
    const b = node('b', 'a/b', { notes: [['inbox/a/b/hit.md', 'Target Hit']] })
    const a = node('a', 'a', { children: [b] })
    const root = node('inbox', '', { children: [a] })
    const { leaves, folderSubpaths } = computeTreeVisibility(root, 'target')
    expect(leaves.has('inbox/a/b/hit.md')).toBe(true)
    expect(folderSubpaths.has('a')).toBe(true)
    expect(folderSubpaths.has('a/b')).toBe(true)
  })

  it('shows a folder that matches by name as a bare row (no children revealed)', () => {
    const projects = node('Projects', 'Projects', {
      notes: [['inbox/Projects/unrelated.md', 'Unrelated']],
      children: [node('Sub', 'Projects/Sub')]
    })
    const root = node('inbox', '', { children: [projects] })
    const { leaves, folderSubpaths } = computeTreeVisibility(root, 'projects')
    // The folder itself is visible…
    expect(folderSubpaths.has('Projects')).toBe(true)
    // …but its non-matching children stay pruned (bare row).
    expect(leaves.has('inbox/Projects/unrelated.md')).toBe(false)
    expect(folderSubpaths.has('Projects/Sub')).toBe(false)
  })

  it('keeps a folder visible when a descendant matches even if the folder name does not', () => {
    const root = node('inbox', '', {
      children: [
        node('Random', 'Random', {
          notes: [['inbox/Random/needle.md', 'Needle In Haystack']]
        })
      ]
    })
    const { folderSubpaths } = computeTreeVisibility(root, 'needle')
    expect(folderSubpaths.has('Random')).toBe(true)
  })

  it('drops folders with no match anywhere', () => {
    const root = node('inbox', '', {
      children: [node('Nope', 'Nope', { notes: [['inbox/Nope/x.md', 'Xylophone']] })]
    })
    const { leaves, folderSubpaths } = computeTreeVisibility(root, 'zzz')
    expect(leaves.size).toBe(0)
    expect(folderSubpaths.size).toBe(0)
  })

  it('collects all matches across sibling branches (no short-circuit)', () => {
    const root = node('inbox', '', {
      children: [
        node('One', 'One', { notes: [['inbox/One/m1.md', 'Match One']] }),
        node('Two', 'Two', { notes: [['inbox/Two/m2.md', 'Match Two']] })
      ]
    })
    const { leaves, folderSubpaths } = computeTreeVisibility(root, 'match')
    expect(leaves.has('inbox/One/m1.md')).toBe(true)
    expect(leaves.has('inbox/Two/m2.md')).toBe(true)
    expect(folderSubpaths.has('One')).toBe(true)
    expect(folderSubpaths.has('Two')).toBe(true)
  })

  it('never includes the root subpath', () => {
    const root = node('inbox', '', { notes: [['inbox/a.md', 'Alpha']] })
    const { folderSubpaths } = computeTreeVisibility(root, 'alpha')
    expect(folderSubpaths.has('')).toBe(false)
  })
})
