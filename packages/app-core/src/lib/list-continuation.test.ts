import { describe, expect, it } from 'vitest'
import { listContinuationPrefix } from './list-continuation'

describe('listContinuationPrefix', () => {
  it('repeats bullet markers', () => {
    expect(listContinuationPrefix('- foo')).toBe('- ')
    expect(listContinuationPrefix('* bar')).toBe('* ')
    expect(listContinuationPrefix('+ baz')).toBe('+ ')
  })

  it('advances ordered markers (renumber pass corrects the exact value)', () => {
    expect(listContinuationPrefix('1. foo')).toBe('2. ')
    expect(listContinuationPrefix('9. foo')).toBe('10. ')
    expect(listContinuationPrefix('3) foo')).toBe('4) ')
  })

  it('preserves leading indentation', () => {
    expect(listContinuationPrefix('  - nested')).toBe('  - ')
    expect(listContinuationPrefix('\t- tabbed')).toBe('\t- ')
    expect(listContinuationPrefix('   2. deep')).toBe('   3. ')
  })

  it('continues task checkboxes as unchecked', () => {
    expect(listContinuationPrefix('- [ ] todo')).toBe('- [ ] ')
    expect(listContinuationPrefix('- [x] done')).toBe('- [ ] ')
    expect(listContinuationPrefix('  - [X] nested done')).toBe('  - [ ] ')
    expect(listContinuationPrefix('1. [ ] numbered task')).toBe('2. [ ] ')
  })

  it('returns null for non-list lines', () => {
    expect(listContinuationPrefix('plain text')).toBeNull()
    expect(listContinuationPrefix('# heading')).toBeNull()
    expect(listContinuationPrefix('')).toBeNull()
    expect(listContinuationPrefix('   ')).toBeNull()
    expect(listContinuationPrefix('-no space after marker')).toBeNull()
    expect(listContinuationPrefix('> quoted')).toBeNull()
  })

  it('handles an empty list item (marker with no content)', () => {
    expect(listContinuationPrefix('- ')).toBe('- ')
    expect(listContinuationPrefix('  1. ')).toBe('  2. ')
  })
})
