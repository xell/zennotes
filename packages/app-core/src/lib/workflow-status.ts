// Flipping a workflow between draft and active, from the surfaces that show it.
//
// The state itself belongs to the file (`status:` in the frontmatter, parsed by
// `@shared/workflows/parse`, decided by `isRunnable`). What lives here is the
// two things the UI needs on top of it and nothing else needs at all:
//
//   1. A way to WRITE the key without rewriting the file around it.
//   2. The words shown before activating something that changes notes.
//
// Both are pure, so the rules that decide what a vault ends up holding can be
// tested without mounting React.

import { parseFrontmatter } from '@shared/template-files'
import type { WorkflowWrite } from '@shared/workflows/share'
import type { WorkflowStatus } from '@shared/workflows/types'

/** The frontmatter key. Mirrors `CONSUMED_KEYS` in `@shared/workflows/parse`. */
export const WORKFLOW_STATUS_KEY = 'status'

/* -------------------------------------------------------------------------- */
/*  Writing the key                                                           */
/* -------------------------------------------------------------------------- */

/** Does this frontmatter line declare the status key? Mirrors `parseFrontmatter`. */
function isStatusLine(line: string): boolean {
  const colon = line.indexOf(':')
  return colon !== -1 && line.slice(0, colon).trim() === WORKFLOW_STATUS_KEY
}

/**
 * A workflow file with its `status:` line rewritten, and everything else byte
 * for byte as it was.
 *
 * Surgery on the raw text rather than `serializeWorkflow({ ...workflow, status })`,
 * for the same reason a node drag does it (see `withLayoutOverridesText`): the
 * serializer is canonical by design, so it would collapse the aligned `=` signs
 * someone typed and reflow their file. Reformatting is a fair price for a save
 * the author asked for; it is not a fair price for flipping a switch, and a
 * toggle that silently rewrites the file underneath it is a toggle people stop
 * pressing.
 *
 * A file with no frontmatter at all grows one, because the alternative is
 * accepting the flip and then losing it: a missing `status:` reads as ACTIVE, so
 * a draft with nowhere to record itself would be runnable on the next load.
 *
 * A duplicate key is collapsed onto the one that was actually in effect (the
 * last, matching `parseFrontmatter`), so a hand-edited file cannot end up
 * claiming both states at once.
 */
export function withWorkflowStatusText(raw: string, status: WorkflowStatus): string {
  // The head is derived from `parseFrontmatter` rather than from a second copy
  // of its regex: if the two ever disagreed about where the fence ends, this
  // would write the key into the body, where it would mean nothing.
  const { body } = parseFrontmatter(raw)
  const headLength = raw.length - body.length
  if (headLength === 0) {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    return `---${eol}${WORKFLOW_STATUS_KEY}: ${status}${eol}---${eol}${eol}${raw}`
  }

  const head = raw.slice(0, headLength)
  const rest = raw.slice(headLength)
  const lines = head.split('\n')

  // The fence closing the head. The frontmatter pattern is lazy, so the head
  // holds exactly two `---` lines; scanning from the end finds the closing one
  // without assuming whether the head ends in a newline.
  let closeIndex = -1
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (lines[i].trim() === '---') {
      closeIndex = i
      break
    }
  }
  // Unreachable for a head `parseFrontmatter` matched, and a bail-out rather
  // than a throw if it ever is reached.
  if (closeIndex === -1) return raw

  const existing = new Set<number>()
  let replaceAt = -1
  for (let i = 1; i < closeIndex; i += 1) {
    if (!isStatusLine(lines[i])) continue
    existing.add(i)
    replaceAt = i
  }

  // CRLF is preserved by keeping the `\r` the split left on each line and giving
  // the new line the same ending as the fence it sits above.
  const eol = lines[closeIndex].endsWith('\r') ? '\r' : ''
  const written = `${WORKFLOW_STATUS_KEY}: ${status}${eol}`

  const next: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (i === replaceAt) {
      // Rewritten where it already sat, so the key keeps its place in the file.
      next.push(written)
      continue
    }
    if (existing.has(i)) continue // a duplicate key that was never in effect
    if (i === closeIndex && replaceAt === -1) next.push(written)
    next.push(lines[i])
  }
  return next.join('\n') + rest
}

/* -------------------------------------------------------------------------- */
/*  Words                                                                     */
/* -------------------------------------------------------------------------- */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Enough to recognize what a workflow does, never a wall of it. */
const MAX_LISTED_WRITES = 6

export function activateConfirmTitle(workflowName: string): string {
  return `Activate "${workflowName}"?`
}

/**
 * What activating a workflow signs you up for, in the registry's own words.
 *
 * Only shown for a workflow that WRITES, and that asymmetry is the design:
 * deactivating is free and instant, activating is the direction that can cost
 * you something. The lines come from `summarizeWorkflowWrites`, i.e. from
 * `NODE_DEFS.mutating` plus the step's arguments, so a node added next month is
 * described correctly the day it is added and this dialog cannot go stale
 * quietly.
 *
 * The last line matters as much as the list: activating is permission, not a
 * run, and someone who reads this as "it is about to do that" would press
 * Cancel on a workflow they actually wanted.
 */
export function activateConfirmDescription(writes: readonly WorkflowWrite[]): string {
  const blocks: string[] = []
  const total = writes.reduce((sum, write) => sum + write.count, 0)

  blocks.push(
    total === 1
      ? 'An active workflow can be run. This one has a step that changes your notes:'
      : `An active workflow can be run. This one has ${total} steps that change your notes:`
  )

  const shown = writes.slice(0, MAX_LISTED_WRITES)
  const listed = shown.map((write) => {
    const detail = write.detail === '' ? '' : ` ${write.detail}`
    const count = write.count > 1 ? ` ×${write.count}` : ''
    const mark = write.irreversible ? '  (no undo)' : ''
    return `  ${write.title}${detail}${count}${mark}`
  })
  const hidden = writes.length - shown.length
  if (hidden > 0) listed.push(`  and ${plural(hidden, 'other kind of change', 'other kinds of change')}`)
  blocks.push(listed.join('\n'))

  blocks.push(
    'Activating does not run it. You still press Run, and you still confirm the changes first.'
  )

  return blocks.join('\n\n')
}
