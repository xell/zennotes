// The one badge that says whether a workflow may ACT, and the one control that
// changes its mind.
//
// Shared by the list row and the canvas header on purpose. Draft and active are
// the two states of every workflow in the vault, so they have to look the same
// wherever they are shown: a row that reads "draft" in grey and a header that
// reads it in orange are two vocabularies for one fact, and the second one
// somebody learns is the one they mistrust.
//
// It is a BADGE that happens to be pressable, not a switch with a label. The
// label is what someone scanning the column reads; the press is what someone
// who has decided reaches for. The asymmetry between the two directions lives
// in the caller: deactivating is instant, and activating a workflow that writes
// asks first (see `activateConfirmDescription`).

import type { WorkflowStatus } from '@shared/workflows/types'

const LABEL: Record<WorkflowStatus, string> = { draft: 'draft', active: 'active' }

/**
 * Active reads as live, draft reads as inert.
 *
 * Deliberately a filled badge in both states rather than a dimmed version of one
 * look: "this cannot run" is a fact about the workflow, and a fact that is only
 * visible as a lower opacity is a fact nobody sees on a busy screen.
 */
const LOOK: Record<WorkflowStatus, string> = {
  active: 'border-success/40 bg-success/10 text-success',
  draft: 'border-paper-300 bg-paper-200 text-ink-500'
}

/** What the badge means, and what pressing it would do. */
function titleFor(status: WorkflowStatus, pressable: boolean): string {
  const what =
    status === 'active'
      ? 'Active: this workflow can be run.'
      : 'Draft: saved, but it cannot run.'
  if (!pressable) return what
  return status === 'active'
    ? `${what} Deactivate it to make it a draft again.`
    : `${what} Activate it to make it runnable.`
}

export interface WorkflowStatusToggleProps {
  status: WorkflowStatus
  /** Null where the workspace cannot write, which leaves a plain badge. */
  onToggle: (() => void) | null
  /** A write is in flight, so the badge stops answering until it lands. */
  busy?: boolean
  /** Extra classes for the surface it sits on (margins only, never colour). */
  className?: string
}

export function WorkflowStatusToggle({
  status,
  onToggle,
  busy = false,
  className = ''
}: WorkflowStatusToggleProps): JSX.Element {
  const shape =
    'shrink-0 rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide'
  const look = LOOK[status]
  if (onToggle === null) {
    return (
      <span title={titleFor(status, false)} className={`${shape} ${look} ${className}`}>
        {LABEL[status]}
      </span>
    )
  }
  return (
    <button
      type="button"
      // `aria-pressed` rather than a switch role: it is a badge that toggles, and
      // its label is the state itself rather than the name of a setting.
      aria-pressed={status === 'active'}
      aria-label={
        status === 'active' ? 'Deactivate this workflow' : 'Activate this workflow'
      }
      title={titleFor(status, true)}
      disabled={busy}
      onClick={(event) => {
        // The row underneath is a click target of its own, and pressing the
        // badge is not a request to open the workflow.
        event.stopPropagation()
        onToggle()
      }}
      className={`${shape} ${look} ${className} transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {LABEL[status]}
    </button>
  )
}
