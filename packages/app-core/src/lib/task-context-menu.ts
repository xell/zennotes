import type { VaultTask } from '@shared/tasks'
import { toIsoDateLocal } from '@shared/tasks'
import type { ContextMenuItem } from '../components/ContextMenu'
import { useStore } from '../store'
import { forwardTaskWithPicker } from './forward-task'

/**
 * The right-click menu for a task, shared by the Tasks list, the Kanban board
 * and both calendars.
 *
 * It lives here rather than in a component because the three views used to
 * disagree about what a task could do: the calendar had a menu, the list and
 * the board had none, so the same task offered a page of actions on one tab and
 * nothing on the next. One builder means a state added to the model (in
 * progress, cancelled, forwarded) shows up in every view at once.
 *
 * Everything routes through the store actions the keyboard already uses, so a
 * menu click and its keystroke take the same path to disk.
 */

export interface TaskMenuOptions {
  /** Rename in place. Views with an inline edit field pass this; others omit it
   *  and the item is left out rather than shown broken. */
  onEdit?: () => void
  /** Move the task into its due date's daily note (the calendars offer this as
   *  the keyboard/drag gesture, so the menu mirrors it). */
  onMoveToDayNote?: (task: VaultTask, iso: string) => void
  /** Today, as the view reckons it. Passed in so the menu's date presets agree
   *  with the grid the user is looking at. */
  today?: Date
  /** Show the keyboard equivalent beside each action. Pass the view's Vim-mode
   *  flag: these are single-key shortcuts, which are disabled with Vim mode off,
   *  and a hint for a key that does nothing is worse than no hint (see the
   *  cursor row's old "Space check", which never fired because Space is the
   *  leader). */
  showKeyHints?: boolean
}

function addDaysIso(today: Date, n: number): string {
  return toIsoDateLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n))
}

export function buildTaskMenuItems(
  task: VaultTask,
  options: TaskMenuOptions = {}
): ContextMenuItem[] {
  const { onEdit, onMoveToDayNote, today = new Date(), showKeyHints = true } = options
  const key = (k: string): string | undefined => (showKeyHints ? k : undefined)
  const state = useStore.getState()
  const mutate = (m: Parameters<typeof state.applyTaskMutation>[1]): void =>
    void state.applyTaskMutation(task, m)
  const dueIn = (n: number): string => addDaysIso(today, n)

  const items: ContextMenuItem[] = [
    { label: 'Open note', hint: key('⏎'), onSelect: () => void state.openTaskAt(task) }
  ]
  if (onEdit) items.push({ label: 'Edit', onSelect: onEdit })

  items.push(
    { kind: 'separator' },
    {
      label: task.checked ? 'Mark not done' : 'Mark done',
      hint: key('x'),
      onSelect: () => void state.toggleTaskFromList(task)
    },
    {
      label: task.inProgress ? 'Set back to open' : 'Mark in progress',
      hint: key('i'),
      onSelect: () => void state.startTaskFromList(task)
    },
    {
      label: task.cancelled ? 'Un-cancel task' : 'Cancel task',
      hint: key('c'),
      onSelect: () => void state.cancelTaskFromList(task)
    },
    {
      label: task.waiting ? 'Clear @waiting' : 'Mark @waiting',
      onSelect: () => mutate({ kind: 'set-waiting', waiting: !task.waiting })
    },
    {
      label: 'Forward to note…',
      hint: key('>'),
      // Forwarding rewrites the checkbox on a task LINE. A whole-note task
      // keeps its state in frontmatter and has no line to rewrite.
      disabled: task.kind === 'file',
      onSelect: () => void forwardTaskWithPicker(task)
    },
    { kind: 'separator' },
    { label: 'Due today', hint: dueIn(0), onSelect: () => mutate({ kind: 'set-due', due: dueIn(0) }) },
    {
      label: 'Due tomorrow',
      hint: dueIn(1),
      onSelect: () => mutate({ kind: 'set-due', due: dueIn(1) })
    },
    {
      label: 'Due next week',
      hint: dueIn(7),
      onSelect: () => mutate({ kind: 'set-due', due: dueIn(7) })
    }
  )
  // An inferred due date comes from the daily note the task lives in, not from a
  // `due:` token, so there is nothing on the line to clear.
  if (task.due && !task.dueInferred) {
    items.push({ label: 'Clear due date', onSelect: () => mutate({ kind: 'set-due', due: null }) })
  }

  items.push(
    { kind: 'separator' },
    {
      label: 'Priority: high',
      disabled: task.priority === 'high',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'high' })
    },
    {
      label: 'Priority: medium',
      disabled: task.priority === 'med',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'med' })
    },
    {
      label: 'Priority: low',
      disabled: task.priority === 'low',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'low' })
    },
    {
      label: 'Clear priority',
      disabled: !task.priority,
      onSelect: () => mutate({ kind: 'set-priority', priority: null })
    }
  )

  if (onMoveToDayNote) {
    items.push(
      { kind: 'separator' },
      {
        label: 'Move to its day’s note',
        disabled: !task.due,
        onSelect: () => {
          if (task.due) onMoveToDayNote(task, task.due)
        }
      }
    )
  }

  items.push(
    { kind: 'separator' },
    {
      // A file task IS the note, so this trashes the whole note (the store
      // confirms first); an inline task just loses its line.
      label: task.kind === 'file' ? 'Delete note' : 'Delete task',
      danger: true,
      onSelect: () => void state.deleteTaskFromList(task)
    }
  )

  return items
}
