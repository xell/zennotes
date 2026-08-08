import { describe, expect, it } from 'vitest'
import {
  noteTasksMode,
  parseTaskFile,
  parseTasksFromBody,
  type ParseTasksContext
} from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }

const fm = (lines: string[], body: string[] = []) =>
  ['---', ...lines, '---', ...body].join('\n')

describe('noteTasksMode (#458)', () => {
  it('maps false/off (any case, quoted or not) to none', () => {
    expect(noteTasksMode('false')).toBe('none')
    expect(noteTasksMode('off')).toBe('none')
    expect(noteTasksMode('False')).toBe('none')
    expect(noteTasksMode('OFF')).toBe('none')
    expect(noteTasksMode('  off  ')).toBe('none')
  })

  it('maps note to note-only', () => {
    expect(noteTasksMode('note')).toBe('note-only')
    expect(noteTasksMode('Note')).toBe('note-only')
  })

  it('falls back to all for absent, empty, and unrecognized values', () => {
    expect(noteTasksMode(undefined)).toBe('all')
    expect(noteTasksMode('')).toBe('all')
    expect(noteTasksMode('true')).toBe('all')
    expect(noteTasksMode('yes')).toBe('all')
    expect(noteTasksMode('nope')).toBe('all')
    // A bare `tasks:` key parses as an empty block list.
    expect(noteTasksMode([])).toBe('all')
  })
})

describe('frontmatter tasks: false, the note is a pure checklist (#458)', () => {
  const checklist = ['- [ ] Dune', '- [x] Hyperion', '- [ ] Blindsight due:2026-09-01']

  it('suppresses every inline checkbox', () => {
    expect(parseTasksFromBody(fm(['tasks: false'], checklist), ctx)).toEqual([])
    expect(parseTasksFromBody(fm(['tasks: off'], checklist), ctx)).toEqual([])
  })

  it('suppresses the file task even when tags include task', () => {
    const body = fm(['tags: [task]', 'tasks: false'], ['notes'])
    expect(parseTaskFile(body, ctx)).toBeNull()
  })

  it('quoted values behave like bare ones', () => {
    expect(parseTasksFromBody(fm(['tasks: "false"'], checklist), ctx)).toEqual([])
  })

  it('leaves other notes untouched: unrecognized values mean all', () => {
    expect(parseTasksFromBody(fm(['tasks: everything'], checklist), ctx)).toHaveLength(3)
    expect(parseTasksFromBody(checklist.join('\n'), ctx)).toHaveLength(3)
  })
})

describe('frontmatter tasks: note, file task stays, checkboxes stop (#458)', () => {
  const body = fm(
    ['tags: [task]', 'tasks: note', 'status: in-progress', 'due: 2026-09-01'],
    ['- [ ] research', '- [x] outline']
  )

  it('keeps the file task with its frontmatter metadata', () => {
    const task = parseTaskFile(body, ctx)
    expect(task).not.toBeNull()
    expect(task?.kind).toBe('file')
    expect(task?.inProgress).toBe(true)
    expect(task?.due).toBe('2026-09-01')
  })

  it('suppresses the inline checkboxes', () => {
    expect(parseTasksFromBody(body, ctx)).toEqual([])
  })

  it('on a note without the task tag it simply silences checkboxes', () => {
    const plain = fm(['tasks: note'], ['- [ ] a', '- [ ] b'])
    expect(parseTaskFile(plain, ctx)).toBeNull()
    expect(parseTasksFromBody(plain, ctx)).toEqual([])
  })
})

describe('includeExcluded escape hatch (#458)', () => {
  const body = fm(['tags: [task]', 'tasks: false'], ['- [ ] hidden', '- [ ] also hidden'])

  it('reveals inline tasks with stable ids and indexes', () => {
    const tasks = parseTasksFromBody(body, ctx, { includeExcluded: true })
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe('inbox/t.md#0')
    expect(tasks[1].id).toBe('inbox/t.md#1')
  })

  it('reveals the file task', () => {
    const task = parseTaskFile(body, ctx, { includeExcluded: true })
    expect(task?.kind).toBe('file')
    expect(task?.id).toBe('inbox/t.md#task')
  })
})
