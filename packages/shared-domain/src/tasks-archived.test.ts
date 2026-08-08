import { describe, expect, it } from 'vitest'
import { filterTasksForDisplay, parseTasksFromBody, type ParseTasksContext } from './tasks'

const inboxCtx: ParseTasksContext = { path: 'inbox/live.md', title: 'live', folder: 'inbox' }
const archiveCtx: ParseTasksContext = { path: 'archive/old.md', title: 'old', folder: 'archive' }

const tasks = [
  ...parseTasksFromBody('- [ ] open here\n- [x] done here', inboxCtx),
  ...parseTasksFromBody('- [ ] open but retired\n- [x] done long ago', archiveCtx)
]

describe('filterTasksForDisplay (#540)', () => {
  it('drops tasks from archived notes by default', () => {
    const visible = filterTasksForDisplay(tasks, false)
    expect(visible).toHaveLength(2)
    expect(visible.every((t) => t.noteFolder === 'inbox')).toBe(true)
  })

  it('drops open and done archived tasks alike (the note retired, not a state)', () => {
    const visible = filterTasksForDisplay(tasks, false)
    expect(visible.some((t) => t.content.includes('retired'))).toBe(false)
    expect(visible.some((t) => t.content.includes('long ago'))).toBe(false)
  })

  it('keeps everything when the toggle shows archived tasks', () => {
    expect(filterTasksForDisplay(tasks, true)).toHaveLength(4)
  })

  it('returns the same array untouched when showing, so memoization holds', () => {
    expect(filterTasksForDisplay(tasks, true)).toBe(tasks)
  })
})
