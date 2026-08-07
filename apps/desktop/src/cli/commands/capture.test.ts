import { describe, expect, it } from 'vitest'

// capture.ts used to import vault-ops for createNote, which pulled the whole
// filesystem module into this test; it now takes a backend (#493), so there
// is nothing left to stub out.
import { deriveTitle } from './capture'

describe('cli capture deriveTitle — clean titles from list/task lines', () => {
  it('strips a task checkbox marker', () => {
    expect(deriveTitle('- [ ] buy milk')).toBe('buy milk')
    expect(deriveTitle('- [x] done thing')).toBe('done thing')
  })

  it('strips list bullets and ordered markers', () => {
    expect(deriveTitle('* a star item')).toBe('a star item')
    expect(deriveTitle('1. first thing')).toBe('first thing')
  })

  it('strips heading markers and leaves plain text alone', () => {
    expect(deriveTitle('# My Note')).toBe('My Note')
    expect(deriveTitle('just some text')).toBe('just some text')
  })

  it('uses the first non-empty line', () => {
    expect(deriveTitle('\n\n- [ ] second line task')).toBe('second line task')
  })
})
