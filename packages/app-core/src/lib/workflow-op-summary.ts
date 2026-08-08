// Readable summaries of planned WorkflowOps: what the dry-run footer, the run
// confirmation, and the palette trigger all show. One home, because two
// summarizers is how the dialog the user confirms drifts from the panel they
// were reading when they pressed Run.

import type { WorkflowOp } from '@shared/workflows/types'

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One readable line per *kind of change*, not per note.
 *
 * `add-tag #someday` over eleven notes is one decision the author made, so it
 * reads as one line with a count; the eleven paths go in the tooltip. Grouping
 * on the label keeps ops that differ in their argument (two different tags)
 * apart without a second key to maintain.
 */
export interface OpSummary {
  label: string
  count: number
  paths: string[]
  irreversible: boolean
}

export function opLabel(op: WorkflowOp): string {
  switch (op.kind) {
    case 'set-frontmatter':
      return `set ${op.field} to ${truncate(op.value, 40)}`
    case 'add-tag':
      return `add-tag #${op.tag}`
    case 'remove-tag':
      return `remove-tag #${op.tag}`
    case 'move':
      return `move to ${op.to === '' ? 'the vault root' : op.to}`
    case 'rename':
      return `rename to ${op.to}`
    case 'append':
      return 'append text'
    case 'prepend':
      return 'prepend text'
    case 'write-section':
      return `write-section ${op.path} · ${op.heading}`
    case 'write-note':
      return `write ${op.path}`
    case 'create-note':
      return 'create-note'
    case 'apply-template':
      return `apply-template ${op.template}`
    case 'archive':
      return 'archive'
    case 'trash':
      return 'trash'
    case 'notify':
      return `notify ${truncate(op.message, 60)}`
    case 'clipboard':
      return 'copy to clipboard'
  }
}

export function opPath(op: WorkflowOp): string | null {
  return 'path' in op ? op.path : null
}

export const IRREVERSIBLE_KINDS: ReadonlySet<WorkflowOp['kind']> = new Set([
  'notify',
  'clipboard'
])

/** Enough paths to recognize what a line covers, not a whole vault in a tooltip. */
const TOOLTIP_PATHS = 20

export function pathsTooltip(summary: OpSummary): string | undefined {
  if (summary.paths.length === 0) return undefined
  const shown = summary.paths.slice(0, TOOLTIP_PATHS)
  const rest = summary.paths.length - shown.length
  return rest > 0 ? `${shown.join('\n')}\nand ${rest} more` : shown.join('\n')
}

export function summarizeOps(ops: readonly WorkflowOp[]): OpSummary[] {
  const byLabel = new Map<string, OpSummary>()
  const order: OpSummary[] = []
  for (const op of ops) {
    const label = opLabel(op)
    let summary = byLabel.get(label)
    if (!summary) {
      summary = { label, count: 0, paths: [], irreversible: IRREVERSIBLE_KINDS.has(op.kind) }
      byLabel.set(label, summary)
      order.push(summary)
    }
    summary.count += 1
    const path = opPath(op)
    if (path && !summary.paths.includes(path)) summary.paths.push(path)
  }
  return order
}
