// The Workflows list pane: the narrow column between the app sidebar and the
// canvas, and the only place on this screen that shows every workflow at once.
//
// It renders rows and owns the MENU MECHANICS (where a right-click landed, which
// row it landed on, when the menu closes). It owns none of the actions: what a
// menu offers is `rowMenuItems`, handed down by the view that can actually run,
// duplicate and delete a workflow. That seam is why this file knows nothing
// about the workflow format at all, only about rows.
//
// Creating lives here as well as in the view header, because the header button
// is a screen's width away from the list it creates into. Two affordances for
// one action is the cheap kind of redundancy: the plus is beside the column you
// are already looking at, exactly as the sidebar puts one beside Quick Notes.

import { useCallback, useMemo, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject
} from 'react'

import type { WorkflowStatus } from '@shared/workflows/types'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import { Button, IconButton } from '../ui/Button'
import { PlusIcon } from '../icons'
import { WorkflowStatusToggle } from './WorkflowStatusToggle'

/**
 * One workflow, as this column shows it.
 *
 * Everything arrives pre-rendered: the trigger is already a phrase, the errors
 * are already counted. The pane is then readable top to bottom without knowing
 * what a wire or a statement is, and the view keeps the one copy of that
 * knowledge it already had.
 */
export interface WorkflowListRow {
  /** The workflow id: this row's React key, and what the menu is asked about. */
  id: string
  name: string
  description: string
  /** `manual`, `on save`, `schedule …`, already worded by the caller. */
  trigger: string
  /**
   * May it act? Draft rows group apart and carry a badge.
   *
   * The workflow being edited reports the status of the TEXT on screen rather
   * than of the file, so the badge answers for what you are looking at, exactly
   * as the `editing` marker beside it does.
   */
  status: WorkflowStatus
  /** The workflow's own keybinding, when it declares one. */
  binding: string | null
  /** Parse errors in the file. Zero hides the badge. */
  errors: number
  /** Open in the editor, and whether that editor holds unsaved text. */
  editing: 'clean' | 'dirty' | null
  selected: boolean
}

export interface WorkflowListPaneProps {
  rows: readonly WorkflowListRow[]
  /** Where the keyboard is, which is not the same question as what is selected. */
  cursor: number
  /**
   * Focus and keys stay with the view: this list is one of several surfaces its
   * shortcuts serve, and only the view knows what `R` or `e` mean right now.
   */
  listRef: RefObject<HTMLDivElement>
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  /** A click. May ask before it moves, because a click is a request to leave. */
  onSelect: (index: number) => void | Promise<void>
  /**
   * A right-click, which aims rather than navigates.
   *
   * Separate from `onSelect`, and synchronous, because a menu may not be held
   * behind a question: the view moves what it can move for free and leaves the
   * rest alone, so this always returns in the same tick as the click.
   */
  onAim: (index: number) => void
  /** A double-click: straight into the text editor. */
  onOpen: (index: number) => void
  /**
   * Flip one row between draft and active.
   *
   * The whole point of the badge being a control: seeing which workflows are
   * armed and disarming one are the same glance. Null where the workspace
   * cannot write, which leaves the badges as plain labels. The confirmation
   * that guards activating a workflow that writes belongs to the caller, so
   * this pane stays a list with a menu on it.
   */
  onToggleStatus: ((index: number) => void) | null
  /** null where the workspace cannot write, which hides every create affordance. */
  onCreate: (() => void) | null
  /** Tooltip for the create affordances, so the key is offered where it fires. */
  createTitle: string
  /**
   * The menu for one row, resolved on every render rather than captured when the
   * menu opened. A Run still waiting on its dry run becomes available under the
   * open menu, instead of lying until the menu is closed and opened again.
   */
  rowMenuItems: (id: string) => ContextMenuItem[]
  /** The menu for the empty space around the rows. */
  paneMenuItems: ContextMenuItem[]
}

export function WorkflowListPane({
  rows,
  cursor,
  listRef,
  onKeyDown,
  onSelect,
  onAim,
  onOpen,
  onToggleStatus,
  onCreate,
  createTitle,
  rowMenuItems,
  paneMenuItems
}: WorkflowListPaneProps): JSX.Element {
  // `id: null` is the empty-space menu. Keyed by id rather than by index so a
  // reload underneath an open menu can never re-point it at another workflow.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null)

  const openRowMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, index: number, id: string): void => {
      event.preventDefault()
      // Or the pane answers as well and the row menu is replaced by the
      // empty-space one on the way up.
      event.stopPropagation()
      // Aiming at a row is selecting it. A menu that acted on whatever happened
      // to be selected beforehand is a menu that deletes the wrong workflow.
      //
      // Both in this tick, and this order. The menu used to WAIT on the
      // selection, and a selection has a question to ask whenever there is
      // unsaved text: the confirm dialog opened, the menu stayed pending
      // behind it, and a right-click on a row looked like it did nothing at
      // all. Nothing a right-click does may be worth a dialog, so the menu
      // opens unconditionally and `onAim` moves only what it can move for
      // free.
      onAim(index)
      setMenu({ x: event.clientX, y: event.clientY, id })
    },
    [onAim]
  )

  const openPaneMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, id: null })
  }, [])

  const closeMenu = useCallback((): void => setMenu(null), [])

  /**
   * The rows, split into what can run and what cannot.
   *
   * Every row keeps its index in the FLAT list, because that index is where the
   * keyboard is: `cursor`, `data-workflow-row` and the view's own j/k all count
   * rows, not groups. The caller hands them over already sorted so the two
   * orders agree; grouping here is a rendering of that order rather than a
   * second one, which is what stops the cursor from appearing to jump.
   */
  const groups = useMemo(() => {
    const order: WorkflowStatus[] = ['active', 'draft']
    return order
      .map((status) => ({
        status,
        title: status === 'active' ? 'Active' : 'Draft',
        entries: rows
          .map((row, index) => ({ row, index }))
          .filter((entry) => entry.row.status === status)
      }))
      .filter((group) => group.entries.length > 0)
  }, [rows])

  // No items means there is nothing to offer here, which is not the same as a
  // menu with nothing in it: a read-only workspace can neither create nor
  // delete, and a row deleted under its own open menu has no actions left.
  const items = menu === null ? [] : menu.id === null ? paneMenuItems : rowMenuItems(menu.id)

  return (
    <div
      // The keyboard's fallback target: `m` with no row under the cursor still
      // has to reach a menu, and on an empty column this is the menu there is.
      data-workflow-list-pane="true"
      onContextMenu={openPaneMenu}
      className="flex w-72 shrink-0 flex-col border-r border-paper-300/50"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-paper-300/50 px-3 py-1.5">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Workflows</h3>
        <span className="text-2xs text-ink-400">{rows.length}</span>
        {onCreate !== null && (
          <IconButton
            size="sm"
            className="ml-auto"
            title={createTitle}
            aria-label="New workflow"
            onClick={onCreate}
          >
            <PlusIcon className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="Workflows"
        // Pointed at a row only while there is one; an activedescendant naming
        // an element that does not exist is worse than none for a screen reader.
        aria-activedescendant={rows.length > 0 ? `workflow-option-${cursor}` : undefined}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        {groups.map((group) => (
          // `group` rather than a bare div: a listbox may hold groups, and a
          // screen reader then announces "Draft, 2 items" instead of dropping
          // the split this pane is built around.
          <div
            key={group.status}
            role="group"
            aria-label={`${group.title} workflows`}
            className="mb-1 last:mb-0"
          >
            {/* The count is the reason the heading is worth its line: "how many
                of my workflows are armed" is the question this pane exists to
                answer at a glance, and it is one number. */}
            <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5">
              <span className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
                {group.title}
              </span>
              <span className="text-2xs text-ink-400">{group.entries.length}</span>
            </div>
            {group.entries.map(({ row, index }) => (
              <div
                key={row.id}
                id={`workflow-option-${index}`}
                data-workflow-row={index}
                role="option"
                aria-selected={row.selected}
                onClick={() => void onSelect(index)}
                onDoubleClick={() => onOpen(index)}
                onContextMenu={(event) => openRowMenu(event, index, row.id)}
                className={[
                  'cursor-pointer border-l-2 px-3 py-2 transition-colors',
                  row.selected
                    ? 'border-accent bg-accent/10'
                    : 'border-transparent hover:bg-paper-200/50',
                  index === cursor && !row.selected ? 'bg-paper-200/40' : ''
                ].join(' ')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                    {row.name}
                  </span>
                  {row.editing !== null && (
                    <span
                      title={
                        row.editing === 'dirty'
                          ? 'Open in the editor with unsaved changes'
                          : 'Open in the editor'
                      }
                      className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-2xs font-semibold text-accent"
                    >
                      {row.editing === 'dirty' ? 'editing •' : 'editing'}
                    </span>
                  )}
                  {row.errors > 0 && (
                    <span
                      title={`${row.errors} ${row.errors === 1 ? 'error' : 'errors'} in this file`}
                      className="shrink-0 rounded bg-danger/15 px-1 py-0.5 text-2xs font-semibold text-danger"
                    >
                      {row.errors}
                    </span>
                  )}
                </div>
                {row.description !== '' && (
                  <div className="mt-0.5 truncate text-xs text-ink-500">{row.description}</div>
                )}
                <div className="mt-1 flex items-center gap-1.5">
                  {/* First on the line, because it is the one thing on this row
                      that changes what the workflow can DO. */}
                  <WorkflowStatusToggle
                    status={row.status}
                    onToggle={onToggleStatus === null ? null : () => onToggleStatus(index)}
                  />
                  <span className="rounded bg-paper-300/60 px-1.5 py-0.5 text-2xs text-ink-600">
                    {row.trigger}
                  </span>
                  {row.binding !== null && (
                    <span className="rounded bg-paper-300/60 px-1.5 py-0.5 font-mono text-2xs text-ink-600">
                      {row.binding}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {rows.length === 0 && (
          // A column with nothing in it is exactly where someone reaches for the
          // way to put something in it, so it offers one rather than sitting
          // blank. `presentation`, because it is not an option in the listbox.
          //
          // The view answers an empty VAULT with a screen of its own, so this is
          // the narrower case: a column left empty while something is still open
          // beside it. Cheap enough to keep standing either way, and the column
          // must never be the one part of this screen with no way forward.
          <div role="presentation" className="px-3 py-6 text-center">
            <p className="text-xs text-ink-500">No workflows yet.</p>
            {onCreate !== null && (
              <Button
                variant="secondary"
                className="mt-3"
                title={createTitle}
                onClick={onCreate}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                New workflow
              </Button>
            )}
          </div>
        )}
      </div>

      {menu !== null && items.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />
      )}
    </div>
  )
}
