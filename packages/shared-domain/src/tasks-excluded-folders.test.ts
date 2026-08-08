import { describe, expect, it } from 'vitest'
import {
  isPathExcludedFromTasks,
  normalizeTasksExcludedFolder,
  normalizeTasksExcludedFolders
} from './tasks-excluded-folders'

describe('normalizeTasksExcludedFolder (#458)', () => {
  it('cleans slashes and whitespace', () => {
    expect(normalizeTasksExcludedFolder('inbox/Books')).toBe('inbox/Books')
    expect(normalizeTasksExcludedFolder('/inbox/Books/')).toBe('inbox/Books')
    expect(normalizeTasksExcludedFolder('inbox//Books')).toBe('inbox/Books')
    expect(normalizeTasksExcludedFolder('inbox\\Books')).toBe('inbox/Books')
    expect(normalizeTasksExcludedFolder('  inbox / Books ')).toBe('inbox/Books')
  })

  it('rejects traversal, dot segments, empties, and non-strings', () => {
    expect(normalizeTasksExcludedFolder('../outside')).toBeNull()
    expect(normalizeTasksExcludedFolder('inbox/../trash')).toBeNull()
    expect(normalizeTasksExcludedFolder('./inbox')).toBeNull()
    expect(normalizeTasksExcludedFolder('')).toBeNull()
    expect(normalizeTasksExcludedFolder('   ')).toBeNull()
    expect(normalizeTasksExcludedFolder(42)).toBeNull()
    expect(normalizeTasksExcludedFolder(null)).toBeNull()
  })
})

describe('normalizeTasksExcludedFolders (#458)', () => {
  it('drops invalid entries and duplicates, preserving order', () => {
    expect(
      normalizeTasksExcludedFolders(['inbox/Books', '../x', 'inbox/Books/', 'archive/Old'])
    ).toEqual(['inbox/Books', 'archive/Old'])
  })

  it('yields [] for malformed vault.json values', () => {
    expect(normalizeTasksExcludedFolders(undefined)).toEqual([])
    expect(normalizeTasksExcludedFolders('inbox/Books')).toEqual([])
    expect(normalizeTasksExcludedFolders({ excludedFolders: [] })).toEqual([])
  })
})

describe('isPathExcludedFromTasks (#458)', () => {
  const excluded = ['inbox/Books', 'archive/Old Projects']

  it('matches notes inside an excluded folder, any depth', () => {
    expect(isPathExcludedFromTasks('inbox/Books/dune.md', excluded)).toBe(true)
    expect(isPathExcludedFromTasks('inbox/Books/scifi/blindsight.md', excluded)).toBe(true)
    expect(isPathExcludedFromTasks('archive/Old Projects/site.md', excluded)).toBe(true)
  })

  it('is a segment match, not a substring match', () => {
    expect(isPathExcludedFromTasks('inbox/Bookshelf.md', excluded)).toBe(false)
    expect(isPathExcludedFromTasks('inbox/Books.md', excluded)).toBe(false)
  })

  it('is case-sensitive like the rest of the vault layer', () => {
    expect(isPathExcludedFromTasks('inbox/books/dune.md', excluded)).toBe(false)
  })

  it('never matches with an empty list', () => {
    expect(isPathExcludedFromTasks('inbox/Books/dune.md', [])).toBe(false)
  })
})
