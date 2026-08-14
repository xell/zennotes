import { describe, expect, it } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import {
  applyColumnOrder,
  arrangeColumns,
  cursorAfterCardMove,
  kanbanGroupByKeyPlan,
  kanbanPendingGroupByPlan,
  NO_VALUE_COLUMN_ID,
  taskIdentityKey,
  type Column
} from './TasksKanban'

function col(id: string): Column {
  return { id, label: id, tasks: [] }
}

const ids = (columns: Column[]): string[] => columns.map((c) => c.id)

describe('arrangeColumns', () => {
  it('returns columns unchanged when no order is saved', () => {
    const built = [col('backlog'), col('review'), col('done')]
    expect(ids(arrangeColumns(built, []))).toEqual(['backlog', 'review', 'done'])
  })

  it('reorders columns to match a full saved order', () => {
    const built = [col('backlog'), col('review'), col('done')]
    expect(ids(arrangeColumns(built, ['done', 'backlog', 'review']))).toEqual([
      'done',
      'backlog',
      'review'
    ])
  })

  it('keeps unlisted (newly discovered) columns after the ordered ones, in built order', () => {
    const built = [col('backlog'), col('review'), col('done'), col('blocked')]
    // Only backlog + done are in the saved order; review + blocked are new.
    expect(ids(arrangeColumns(built, ['done', 'backlog']))).toEqual([
      'done',
      'backlog',
      'review',
      'blocked'
    ])
  })

  it('always pins the No-value bucket last, even if the order lists it first', () => {
    const built = [col('backlog'), col(NO_VALUE_COLUMN_ID), col('done')]
    expect(ids(arrangeColumns(built, [NO_VALUE_COLUMN_ID, 'done', 'backlog']))).toEqual([
      'done',
      'backlog',
      NO_VALUE_COLUMN_ID
    ])
  })

  it('ignores saved ids that no longer exist among the built columns', () => {
    const built = [col('backlog'), col('done')]
    // 'review' was deleted from the vault but lingers in the saved order.
    expect(ids(arrangeColumns(built, ['review', 'done', 'backlog']))).toEqual(['done', 'backlog'])
  })
})

function task(sourcePath: string, taskIndex: number, content = 'task'): VaultTask {
  return { content, checked: false, sourcePath, taskIndex } as unknown as VaultTask
}

function colWith(id: string, tasks: VaultTask[]): Column {
  return { id, label: id, tasks }
}

describe('cursorAfterCardMove (#492)', () => {
  const mover = task('inbox/board.md', 2, 'Mover')
  const anchor = task('inbox/board.md', 0, 'Anchor')

  it('lands on the moved card, not on the top of its new column', () => {
    // Columns sort by priority and due date, so a moved card usually arrives
    // below the cards already there.
    const columns = [colWith('backlog', []), colWith('doing', [anchor, mover])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 1
    })
  })

  it('finds the target column by id after an emptied column disappears', () => {
    // `backlog` held only the moved card, so the rebuilt board drops it and
    // every column to its right shifts down one index.
    const columns = [colWith('doing', [anchor, mover]), colWith('review', [])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 0,
      cardIdx: 1
    })
  })

  it('keeps the cursor in the target column when the card is not found there', () => {
    const columns = [colWith('backlog', []), colWith('doing', [anchor])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 0
    })
  })

  it('clamps to the last column when the target is gone entirely', () => {
    const columns = [colWith('backlog', []), colWith('doing', [anchor])]
    expect(cursorAfterCardMove(columns, 'vanished', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 0
    })
  })

  it('distinguishes two tasks from the same note', () => {
    const columns = [colWith('doing', [anchor, mover])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(anchor)).cardIdx).toBe(0)
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover)).cardIdx).toBe(1)
  })
})

describe('applyColumnOrder (persisted card arrangement replay)', () => {
  const a = task('inbox/a.md', 0, 'A')
  const b = task('inbox/b.md', 0, 'B')
  const c = task('inbox/c.md', 0, 'C')

  const saved = (key: string, keys: string[]): Map<string, string[]> => new Map([[key, keys]])
  const texts = (columns: Column[], i: number): string[] =>
    columns[i].tasks.map((t) => t.content)

  it('replays a saved arrangement over the built sort', () => {
    const columns = [colWith('today', [a, b, c])]
    const order = saved('status:today', [
      taskIdentityKey(c),
      taskIdentityKey(a),
      taskIdentityKey(b)
    ])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['C', 'A', 'B'])
  })

  it('keeps unlisted (new) cards after the arranged ones, in built order', () => {
    const columns = [colWith('today', [a, b, c])]
    const order = saved('status:today', [taskIdentityKey(c)])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['C', 'A', 'B'])
  })

  it('ignores saved keys whose task is no longer in the column', () => {
    // C was completed or rescheduled since the arrangement was saved.
    const columns = [colWith('today', [a, b])]
    const order = saved('status:today', [
      taskIdentityKey(c),
      taskIdentityKey(b),
      taskIdentityKey(a)
    ])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['B', 'A'])
  })

  it('leaves columns without a saved arrangement untouched', () => {
    const columns = [colWith('today', [a, b]), colWith('upcoming', [c])]
    const order = saved('status:today', [taskIdentityKey(b), taskIdentityKey(a)])
    const out = applyColumnOrder('status', columns, order)
    expect(texts(out, 0)).toEqual(['B', 'A'])
    expect(out[1]).toBe(columns[1])
  })

  it('scopes the arrangement to its board, so group-bys do not bleed', () => {
    // A same-named column on a different board must not pick up this order.
    const columns = [colWith('today', [a, b])]
    const order = saved('status:today', [taskIdentityKey(b), taskIdentityKey(a)])
    expect(texts(applyColumnOrder('priority', columns, order), 0)).toEqual(['A', 'B'])
  })
})

describe('group-by vs gt/gT tab keymaps (#573)', () => {
  const gKey = { key: 'g', code: 'KeyG' }
  const event = (init: {
    key: string
    code: string
    shiftKey?: boolean
    metaKey?: boolean
  }): KeyboardEvent =>
    ({
      key: init.key,
      code: init.code,
      ctrlKey: false,
      metaKey: !!init.metaKey,
      altKey: false,
      shiftKey: !!init.shiftKey
    }) as KeyboardEvent

  it('defers the cycle in vim mode, where g opens the gt/gT sequences', () => {
    expect(kanbanGroupByKeyPlan(true, null, event(gKey))).toBe('defer')
  })

  it('cycles immediately with vim off (no tab sequences exist)', () => {
    expect(kanbanGroupByKeyPlan(false, null, event(gKey))).toBe('cycle-now')
  })

  it('cycles immediately when the tab keymaps were rebound off the g prefix', () => {
    const overrides = { 'vim.tabNext': '] t', 'vim.tabPrevious': '[ t' }
    expect(kanbanGroupByKeyPlan(true, overrides, event(gKey))).toBe('cycle-now')
  })

  it('yields to the tab switch on the completing t and T', () => {
    expect(kanbanPendingGroupByPlan(null, event({ key: 't', code: 'KeyT' }))).toBe(
      'yield-to-tabs'
    )
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'T', code: 'KeyT', shiftKey: true }))
    ).toBe('yield-to-tabs')
  })

  it('keeps the prefix alive across the bare Shift that precedes gT', () => {
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))
    ).toBe('keep-pending')
  })

  it('treats a second g as a repeated prefix', () => {
    expect(kanbanPendingGroupByPlan(null, event(gKey))).toBe('repeat-prefix')
  })

  it('drops the prefix on any other key, vim-style', () => {
    expect(kanbanPendingGroupByPlan(null, event({ key: 'j', code: 'KeyJ' }))).toBe('interrupt')
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'p', code: 'KeyP', metaKey: true }))
    ).toBe('interrupt')
  })

  it('follows a rebound completion token', () => {
    const overrides = { 'vim.tabNext': 'g n' }
    expect(kanbanPendingGroupByPlan(overrides, event({ key: 'n', code: 'KeyN' }))).toBe(
      'yield-to-tabs'
    )
    // The old completion no longer completes anything: plain t interrupts,
    // while the untouched gT still finishes through its Shifted T.
    expect(kanbanPendingGroupByPlan(overrides, event({ key: 't', code: 'KeyT' }))).toBe(
      'interrupt'
    )
    expect(
      kanbanPendingGroupByPlan(overrides, event({ key: 'T', code: 'KeyT', shiftKey: true }))
    ).toBe('yield-to-tabs')
  })
})
