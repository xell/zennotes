import { describe, expect, it } from 'vitest'
import { recentNoteToggleTarget } from './recent-note-toggle'

describe('recent note toggle target', () => {
  it('returns the most recent different note', () => {
    expect(
      recentNoteToggleTarget('inbox/C.md', [
        { path: 'inbox/A.md' },
        { path: 'inbox/B.md' },
        { path: 'inbox/C.md' }
      ])
    ).toBe('inbox/B.md')
  })

  it('makes repeated switches alternate between the last two notes', () => {
    const history = [{ path: 'inbox/A.md' }, { path: 'inbox/B.md' }]
    expect(recentNoteToggleTarget('inbox/A.md', history)).toBe('inbox/B.md')
    expect(recentNoteToggleTarget('inbox/B.md', [...history, { path: 'inbox/A.md' }])).toBe(
      'inbox/A.md'
    )
  })

  it('skips virtual tabs and paths that are no longer available', () => {
    expect(
      recentNoteToggleTarget(
        'inbox/C.md',
        [
          { path: 'inbox/A.md' },
          { path: 'zen://tasks' },
          { path: 'inbox/Missing.md' }
        ],
        new Set(['inbox/A.md', 'inbox/C.md'])
      )
    ).toBe('inbox/A.md')
  })
})
