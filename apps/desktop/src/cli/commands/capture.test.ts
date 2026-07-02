import { describe, expect, it, vi } from 'vitest'

vi.mock('../../mcp/vault-ops.js', () => ({ createNote: vi.fn() }))

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
