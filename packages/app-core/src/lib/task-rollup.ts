/**
 * Derived subtask progress for parent task lines (#512).
 *
 * A parent task with subtasks shows how far along its children are, as a
 * `2/5` chip next to the line. The count is computed from the document every
 * time it renders and is never written back: ZenNotes is not the only writer
 * of a vault, and a marker written into the parent goes stale the moment
 * Obsidian, vim or the phone checks a child off. Derived display is always
 * right no matter who edited the file.
 *
 * One counting rule, two renderers: the CodeMirror widget in
 * `cm-task-rollup.ts` and the remark plugin in `markdown.ts` both count with
 * the helpers here, so a parent can never say 2/5 in the editor and 3/5 in
 * the reading view.
 *
 * What counts: direct child tasks only, one nesting level down, matching the
 * list structure the reading view sees. Grandchildren roll into their own
 * parent. Cancelled (`[-]`) and forwarded (`[>]`) children leave the flow
 * entirely, so they are out of the denominator; an in-progress (`[/]`) child
 * counts as not yet done. A non-task bullet between parent and a deeper task
 * blocks the rollup the same way the mdast tree does: that task belongs to
 * the bullet, not to the task above it.
 */
import { TASK_LINE_RE } from '@shared/tasklists'

export interface TaskRollup {
  done: number
  total: number
}

export type ChildTaskState = 'open' | 'done' | 'in-progress' | 'cancelled' | 'forwarded'

function childTaskStateForChar(ch: string): ChildTaskState {
  if (ch === 'x' || ch === 'X') return 'done'
  if (ch === '/') return 'in-progress'
  if (ch === '-') return 'cancelled'
  if (ch === '>') return 'forwarded'
  return 'open'
}

export interface RollupTaskLine {
  state: ChildTaskState
  /** Offset of the checkbox's `[` in the line, for syntax-tree resolution. */
  bracket: number
}

/**
 * The rollup's notion of a task line: {@link TASK_LINE_RE} plus the GFM rule
 * that the checkbox is followed by whitespace or ends the line. The reading
 * view will not draw `- [x]glued` as a task, so the chip must not count it
 * either; the broader line grammar stays the vault-wide task model.
 */
export function rollupTaskLine(text: string): RollupTaskLine | null {
  const task = TASK_LINE_RE.exec(text)
  if (!task) return null
  if (!/^\](?:[ \t]|$)/.test(task[3])) return null
  return { state: childTaskStateForChar(task[2]), bracket: task[1].length - 1 }
}

/** One phrase for both renderers' tooltips, so hover and screen readers say
 *  the same thing in the editor and the preview. */
export function rollupLabel(rollup: TaskRollup): string {
  return `${rollup.done} of ${rollup.total} subtask${rollup.total === 1 ? '' : 's'} done`
}

/** Cancelled and forwarded children are no longer this list's work, so they
 *  do not dilute the parent's progress. */
export function rollupCountsChild(state: ChildTaskState): boolean {
  return state === 'open' || state === 'done' || state === 'in-progress'
}

export function rollupChildDone(state: ChildTaskState): boolean {
  return state === 'done'
}
