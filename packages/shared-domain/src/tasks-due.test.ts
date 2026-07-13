import { describe, expect, it } from 'vitest'
import { parseTasksFromBody, type ParseTasksContext } from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }
const parse = (line: string) => parseTasksFromBody(line, ctx)[0]

describe('parseTasksFromBody — inline due dates (#343)', () => {
  it('parses a due date written without a space', () => {
    const task = parse('- [ ] pay rent due:2026-07-08')
    expect(task.due).toBe('2026-07-08')
    expect(task.content).not.toContain('due')
  })

  it('parses a due date written with a space (as the @-date completion inserts it)', () => {
    const task = parse('- [ ] pay rent due: 2026-07-08')
    expect(task.due).toBe('2026-07-08')
    expect(task.content).not.toContain('due')
    expect(task.content).not.toContain('2026')
  })

  it('leaves the due unset for a non-ISO candidate', () => {
    expect(parse('- [ ] task due:@tomorrow').due).toBeUndefined()
    expect(parse('- [ ] task due: someday').due).toBeUndefined()
  })
})
