import { describe, it, expect } from 'vitest'
import { DEFAULT_FOLDER_PATHS, buildReverseFolderMap, describeSystemFolderPathIssue, normalizeSystemFolderPaths, resolveFolderPath } from './system-folder-paths'

describe('normalizeSystemFolderPaths', () => {
  it('returns empty object for non-object input', () => {
    expect(normalizeSystemFolderPaths(null)).toEqual({})
    expect(normalizeSystemFolderPaths(undefined)).toEqual({})
    expect(normalizeSystemFolderPaths('string')).toEqual({})
    expect(normalizeSystemFolderPaths(42)).toEqual({})
  })

  it('returns empty object for empty object', () => {
    expect(normalizeSystemFolderPaths({})).toEqual({})
  })

  it('returns empty object when all paths are defaults', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox', trash: 'trash' })).toEqual({})
  })

  it('normalizes valid custom paths', () => {
    expect(normalizeSystemFolderPaths({ inbox: '01 - Entry' })).toEqual({ inbox: '01 - Entry' })
    expect(normalizeSystemFolderPaths({ archive: 'Archive', trash: 'deleted' })).toEqual({
      archive: 'Archive',
      trash: 'deleted'
    })
  })

  it('rejects backslashes in paths', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Notes\\Inbox' })).toEqual({})
  })

  it('rejects paths with .. segments', () => {
    expect(normalizeSystemFolderPaths({ inbox: '../inbox' })).toEqual({})
  })

  it('rejects paths with leading /', () => {
    expect(normalizeSystemFolderPaths({ inbox: '/inbox' })).toEqual({})
  })

  it('rejects paths with empty segments', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox//sub' })).toEqual({})
  })

  it('rejects paths starting with dot', () => {
    expect(normalizeSystemFolderPaths({ trash: '.trash' })).toEqual({})
  })

  it('rejects paths with invalid characters', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox:name' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: 'inbox?' })).toEqual({})
  })

  it('rejects paths exceeding max length', () => {
    const long = 'a'.repeat(129)
    expect(normalizeSystemFolderPaths({ inbox: long })).toEqual({})
  })

  it('rejects empty string values', () => {
    expect(normalizeSystemFolderPaths({ inbox: '' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: '  ' })).toEqual({})
  })

  it('rejects non-string values', () => {
    expect(normalizeSystemFolderPaths({ inbox: 42 })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: true })).toEqual({})
  })

  it('rejects paths colliding with reserved root names', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'assets' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: '.zennotes' })).toEqual({})
    expect(normalizeSystemFolderPaths({ trash: 'comments' })).toEqual({})
  })

  it('keeps one of duplicate custom paths, drops the other', () => {
    const result = normalizeSystemFolderPaths({ inbox: 'Notes', archive: 'Notes' })
    // One will be kept, the other dropped due to collision
    expect(result).toEqual({ archive: 'Notes' })
  })

  it('rejects custom path colliding with another folder default', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'archive' })).toEqual({})
    expect(normalizeSystemFolderPaths({ trash: 'inbox' })).toEqual({})
  })

  it('keeps valid overrides when some are conflicting with each other', () => {
    const result = normalizeSystemFolderPaths({ inbox: 'my-inbox', trash: 'dup', archive: 'dup' })
    // 'dup' collides between trash and archive; one is removed, the other kept
    expect(result).toEqual({ inbox: 'my-inbox', trash: 'dup' })
  })

  it('removes override that collides with a default', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'my-inbox', trash: 'archive' })).toEqual({
      inbox: 'my-inbox'
    })
  })

  // A swap resolves without any collision, so the collision loop let it
  // through. It still reads backwards everywhere a path is classified by its
  // top segment, in this app and in every other one pointed at the vault.
  it('rejects a full swap of two folders', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'archive', archive: 'inbox' })).toEqual({})
    expect(normalizeSystemFolderPaths({ quick: 'trash', trash: 'quick' })).toEqual({})
  })

  it('rejects a three-way rotation', () => {
    expect(
      normalizeSystemFolderPaths({ inbox: 'quick', quick: 'archive', archive: 'inbox' })
    ).toEqual({})
  })

  it('keeps a valid override alongside a rejected swap partner', () => {
    expect(
      normalizeSystemFolderPaths({ inbox: 'archive', archive: 'inbox', trash: 'deleted' })
    ).toEqual({ trash: 'deleted' })
  })

  it('rejects another folder default regardless of case', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Archive' })).toEqual({})
  })

  it('rejects multi-segment paths', () => {
    expect(normalizeSystemFolderPaths({ trash: 'sys/trash' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: 'Notes/Inbox' })).toEqual({})
  })

  it('ignores unknown keys', () => {
    expect(normalizeSystemFolderPaths({ inbox: '01 - Entry', other: 'value' })).toEqual({
      inbox: '01 - Entry'
    })
  })

  it('allows setting all four folders', () => {
    const result = normalizeSystemFolderPaths({
      inbox: '01 - Entry',
      quick: 'Quick Notes',
      archive: 'Archive',
      trash: 'deleted'
    })
    expect(result).toEqual({
      inbox: '01 - Entry',
      quick: 'Quick Notes',
      archive: 'Archive',
      trash: 'deleted'
    })
  })
})

describe('resolveFolderPath', () => {
  it('returns default when no overrides', () => {
    expect(resolveFolderPath('inbox')).toBe('inbox')
    expect(resolveFolderPath('trash')).toBe('trash')
  })

  it('returns default when override is null/undefined', () => {
    expect(resolveFolderPath('inbox', null)).toBe('inbox')
    expect(resolveFolderPath('inbox', undefined)).toBe('inbox')
  })

  it('returns custom path when set', () => {
    expect(resolveFolderPath('inbox', { inbox: '01 - Entry' })).toBe('01 - Entry')
  })

  it('falls back to default for unset folders', () => {
    const overrides = { inbox: '01 - Entry' }
    expect(resolveFolderPath('archive', overrides)).toBe('archive')
  })
})

describe('buildReverseFolderMap', () => {
  it('returns empty map when no overrides', () => {
    expect(buildReverseFolderMap(null)).toEqual(new Map())
    expect(buildReverseFolderMap({})).toEqual(new Map())
  })

  it('maps custom single-segment paths to folder IDs', () => {
    const map = buildReverseFolderMap({ inbox: '01 - Entry', trash: 'deleted' })
    expect(map.get('01 - entry')).toBe('inbox')
    expect(map.get('deleted')).toBe('trash')
    expect(map.size).toBe(2)
  })
})

describe('DEFAULT_FOLDER_PATHS', () => {
  it('maps each folder ID to itself', () => {
    for (const key of ['inbox', 'quick', 'archive', 'trash'] as const) {
      expect(DEFAULT_FOLDER_PATHS[key]).toBe(key)
    }
  })
})

describe('describeSystemFolderPathIssue — saying why, instead of dropping it (#533)', () => {
  // The normalizer discards what it cannot use, which is right for reading a
  // file someone edited by hand and silent for a person typing into a box.
  // These two have to agree: anything the normalizer would drop must have a
  // reason here, or the field goes quiet again.
  it('accepts a plain top-level name, and an empty value meaning the default', () => {
    expect(describeSystemFolderPathIssue('inbox', '01 - Entry')).toBeNull()
    expect(describeSystemFolderPathIssue('inbox', '')).toBeNull()
    expect(describeSystemFolderPathIssue('inbox', '   ')).toBeNull()
  })

  it('explains a nested path, which is the case that started this', () => {
    const issue = describeSystemFolderPathIssue('quick', 'docs/zennotes/quick')
    expect(issue).toContain('single folder name')
    expect(describeSystemFolderPathIssue('quick', 'docs\\zennotes')).not.toBeNull()
  })

  it('explains a dot-leading name, invalid characters, and an over-long one', () => {
    expect(describeSystemFolderPathIssue('inbox', '.hidden')).toContain('dot')
    expect(describeSystemFolderPathIssue('inbox', 'bad:name')).toContain('characters')
    expect(describeSystemFolderPathIssue('inbox', 'x'.repeat(129))).toContain('Too long')
  })

  it("explains claiming another folder's default name", () => {
    const issue = describeSystemFolderPathIssue('inbox', 'archive')
    expect(issue).toContain('archive')
    // ...but its OWN default is fine: that is just "use the default".
    expect(describeSystemFolderPathIssue('inbox', 'inbox')).toBeNull()
  })

  it('explains a reserved name and a collision with an already-moved folder', () => {
    expect(describeSystemFolderPathIssue('inbox', 'assets')).toContain('reserved')
    expect(
      describeSystemFolderPathIssue('inbox', 'Notes', { quick: 'Notes' })
    ).toContain('already used')
  })

  it('agrees with the normalizer: everything it accepts survives normalization', () => {
    for (const value of ['01 - Entry', 'Journal', 'work_notes', 'a']) {
      expect(describeSystemFolderPathIssue('inbox', value)).toBeNull()
      expect(normalizeSystemFolderPaths({ inbox: value })).toEqual({ inbox: value })
    }
  })

  it('agrees with the normalizer: everything it refuses is dropped by normalization', () => {
    for (const value of ['docs/zennotes/quick', '.hidden', 'bad:name', 'assets', 'archive']) {
      expect(describeSystemFolderPathIssue('inbox', value)).not.toBeNull()
      expect(normalizeSystemFolderPaths({ inbox: value }).inbox).toBeUndefined()
    }
  })
})
