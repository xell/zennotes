import { describe, expect, it } from 'vitest'
import { extractTags, matchesSelectedTags } from './tags'

describe('extractTags — code fences are never scanned for tags (#293)', () => {
  it('ignores #tags inside a top-level fenced code block', () => {
    expect(extractTags('#real\n\n```c\n#include <stdio.h>\n```\n')).toEqual(['real'])
  })

  it('ignores #tags inside a fence INDENTED under a list item (the #293 repro)', () => {
    const body = '- bullet\n\n  ```c\n  #include <stdio.h>\n  ```\n\n#kept'
    expect(extractTags(body)).toEqual(['kept'])
  })

  it('handles tilde fences and longer (4-backtick) fences', () => {
    expect(extractTags('~~~\n#nope\n~~~\n#yes')).toEqual(['yes'])
    expect(extractTags('````\n```\n#nope\n```\n````\n#yes')).toEqual(['yes'])
  })

  it('ignores #tags in inline code but keeps real tags', () => {
    expect(extractTags('use `#notatag` but #tagme')).toEqual(['tagme'])
  })

  it('extracts a real tag sitting right after a closed indented fence', () => {
    expect(extractTags('- item\n  ```\n  #include\n  ```\n  #after')).toEqual(['after'])
  })
})

describe('matchesSelectedTags', () => {
  const note = ['project', 'urgent', 'design']

  it('all (AND): requires every selected tag — the #221 fix', () => {
    expect(matchesSelectedTags(note, ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(note, ['project', 'missing'], 'all')).toBe(false)
    expect(matchesSelectedTags(note, ['project'], 'all')).toBe(true)
  })

  it('any (OR): requires at least one selected tag', () => {
    expect(matchesSelectedTags(note, ['project', 'missing'], 'any')).toBe(true)
    expect(matchesSelectedTags(note, ['nope', 'missing'], 'any')).toBe(false)
  })

  it('is case-insensitive on both sides', () => {
    expect(matchesSelectedTags(['Project', 'URGENT'], ['project', 'urgent'], 'all')).toBe(true)
    expect(matchesSelectedTags(['Project'], ['PROJECT'], 'any')).toBe(true)
  })

  it('no selection never matches', () => {
    expect(matchesSelectedTags(note, [], 'all')).toBe(false)
    expect(matchesSelectedTags(note, [], 'any')).toBe(false)
  })

  it('a note with no tags never matches a non-empty selection', () => {
    expect(matchesSelectedTags([], ['project'], 'all')).toBe(false)
    expect(matchesSelectedTags([], ['project'], 'any')).toBe(false)
  })
})
