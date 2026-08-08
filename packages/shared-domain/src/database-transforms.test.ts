import { describe, it, expect } from 'vitest'
import { joinNoteLinks, splitNoteLinks } from './database-transforms'

describe('splitNoteLinks / joinNoteLinks (#500)', () => {
  it('round-trips targets, including titles with commas', () => {
    const targets = ['Project X', 'Smith, John', '/a/Dup']
    expect(splitNoteLinks(joinNoteLinks(targets))).toEqual(targets)
  })

  it('extracts targets and drops alias and surrounding text', () => {
    expect(splitNoteLinks('see [[A|alias]] and [[B]] maybe')).toEqual(['A', 'B'])
  })

  it('ignores empty and malformed brackets', () => {
    expect(splitNoteLinks('')).toEqual([])
    expect(splitNoteLinks('[[]] [[  ]] [[ok]]')).toEqual(['ok'])
    expect(splitNoteLinks('plain text, no links')).toEqual([])
  })
})
