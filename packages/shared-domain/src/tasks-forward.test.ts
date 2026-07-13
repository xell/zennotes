import { describe, expect, it } from 'vitest'
import { setTaskForwardedAtIndex, TASK_LINE_RE } from './tasklists'
import { parseTasksFromBody, groupTasks, type ParseTasksContext } from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }

describe('task forwarding primitives (#316)', () => {
  it('recognizes [>] as a task state', () => {
    expect(TASK_LINE_RE.test('- [>] forwarded')).toBe(true)
    expect(TASK_LINE_RE.exec('- [>] x')?.[2]).toBe('>')
  })

  it('setTaskForwardedAtIndex flips the state to [>] and appends the link once', () => {
    expect(setTaskForwardedAtIndex('- [ ] Task 1', 0, '[[Target]]')).toBe('- [>] Task 1 [[Target]]')
    expect(setTaskForwardedAtIndex('- [>] Task 1 [[Target]]', 0, '[[Target]]')).toBe(
      '- [>] Task 1 [[Target]]'
    )
    expect(setTaskForwardedAtIndex('- [x] Task 1', 0, '[[T]]')).toBe('- [>] Task 1 [[T]]')
    expect(setTaskForwardedAtIndex('- [ ] Task 1', 0, '')).toBe('- [>] Task 1')
  })

  it('parses [>] as forwarded (not checked)', () => {
    const t = parseTasksFromBody('- [>] Task 1 [[Target]]', ctx)[0]
    expect(t.forwarded).toBe(true)
    expect(t.checked).toBe(false)
  })

  it('groups forwarded tasks into the forwarded bucket, out of today/done', () => {
    const tasks = parseTasksFromBody('- [ ] open\n- [x] done\n- [>] gone [[X]]', ctx)
    const g = groupTasks(tasks, new Date(2026, 0, 1))
    expect(g.forwarded.map((t) => t.content)).toEqual(['gone [[X]]'])
    expect(g.today.map((t) => t.content)).toEqual(['open'])
    expect(g.done.map((t) => t.content)).toEqual(['done'])
  })
})
