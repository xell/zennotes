// Run a workflow from anywhere that is not the workflows view: today the
// command palette, later the event and schedule triggers' manual cousins.
//
// The flow is the SAME trust ladder the view walks, built from the same pure
// pieces (`workflow-run`, `workflow-op-summary`): plan fresh, name the notes
// with unsaved edits and ask, resolve template names to bodies, confirm the
// exact op list, apply, perform the two renderer-side effects, and leave a
// receipt the user can act on. The one honest difference is where the receipt
// lives: the view has a card, this flow has a toast carrying the Undo action,
// because the user who ran from the palette never left whatever they were
// doing and a toast is the only surface that follows them there.

import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { mergeTemplates } from '@shared/template-files'
import { parseWorkflow } from '@shared/workflows/parse'
import { planWorkflow } from '@shared/workflows/engine'
import { validateWorkflow } from '@shared/workflows/validate'
import { isRunnable } from '@shared/workflows/types'
import type { Diagnostic, Workflow, WorkflowOp } from '@shared/workflows/types'
import type { WorkflowRunReceipt, WorkflowRunSummary } from '@bridge-contract/workflows'
import { useStore } from '../store'
import { useToastStore } from './toast'
import { confirmApp } from './confirm-requests'
import { createVaultReader } from './workflow-vault-reader'
import { IRREVERSIBLE_KINDS, summarizeOps } from './workflow-op-summary'
import {
  collectRunSideEffects,
  driftedPathsNote,
  interruptedRunHeadline,
  interruptedRunToOffer,
  opsExcludingPaths,
  planWritePaths,
  receiptHeadline,
  resolveTemplateOps,
  runConfirmDescription,
  runConfirmLabel,
  runConfirmTitle,
  supersededUndoMessage,
  undoCollisionDescription,
  undoCollisionTitle,
  undoLabel,
  undoOfferFor,
  undoneHeadline,
  unknownTemplateDiagnostics,
  unsavedCollisionDescription,
  unsavedCollisionTitle,
  unsavedCollisions,
  unsavedSkipDescription,
  unsavedSkipTitle
} from './workflow-run'
import type { UnsavedResolution } from './workflow-run'

/** Long enough to read the headline AND decide about the Undo it carries. */
const RECEIPT_TOAST_MS = 12_000

/**
 * One run at a time, across every surface that calls this. A palette entry
 * picked twice while the first confirm is still open must not stack a second
 * confirm behind it.
 */
let inFlight = false

function toast(
  message: string,
  type: 'success' | 'error' | 'info' = 'info',
  action?: { label: string; onClick: () => void },
  durationMs?: number
): void {
  useToastStore.getState().addToast(message, type, action, durationMs)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Distinct error diagnostics, the number the confirmation admits to. */
function countErrors(groups: readonly Diagnostic[][]): number {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const diagnostic of group) {
      if (diagnostic.severity !== 'error') continue
      seen.add(`${diagnostic.line}\x00${diagnostic.message}`)
    }
  }
  return seen.size
}

/**
 * Undo one receipt's run, from the toast it rode in on.
 *
 * The same collision honesty as the view's undo: undo writes bytes to disk,
 * so a note open with unsaved edits would have the restored file overwritten
 * by its next save, and that is worth a question rather than a surprise.
 *
 * It also answers to the same store record the view's card does, which is what
 * stops a toast left over from an older run rolling back the newer one that
 * replaced it. Both checks are made HERE rather than when the toast was built:
 * the run that supersedes this one lands while the offer is on screen.
 */
async function undoFromToast(receipt: WorkflowRunReceipt): Promise<void> {
  const state = useStore.getState()
  if (typeof window.zen.undoWorkflowRun !== 'function') return
  const offer = undoOfferFor(state.workflowRunRecord, receipt)
  if (offer === 'already-undone') return
  if (offer === 'superseded') {
    toast(supersededUndoMessage(), 'error')
    return
  }
  const dirty = unsavedCollisions(receipt.paths, state.noteDirty)
  if (dirty.length > 0) {
    const ok = await confirmApp({
      title: undoCollisionTitle(dirty),
      description: undoCollisionDescription(dirty),
      confirmLabel: 'Undo anyway',
      cancelLabel: 'Keep the run',
      danger: true
    })
    if (!ok) return
  }
  try {
    const result = await window.zen.undoWorkflowRun(receipt.runId)
    // The record follows the undo wherever it was pressed, so the view's card
    // stops offering an Undo this toast already spent.
    useStore
      .getState()
      .setWorkflowRunRecord((latest) =>
        latest && latest.receipt.runId === receipt.runId
          ? { ...latest, undone: result, undoError: null }
          : latest
      )
    toast(undoneHeadline(result), 'success')
    // Its own toast, not a clause on the success line: this is the one thing an
    // undo takes away rather than gives back, and it stays until dismissed.
    const drifted = driftedPathsNote(result)
    if (drifted) toast(drifted, 'error')
    await state.refreshNotes()
  } catch (err) {
    const message = errorText(err)
    useStore
      .getState()
      .setWorkflowRunRecord((latest) =>
        latest && latest.receipt.runId === receipt.runId
          ? { ...latest, undoError: message }
          : latest
      )
    toast(message, 'error')
  }
}

/**
 * Offer to undo a run the app died in the middle of, once per vault open.
 *
 * An interrupted run is the one case where a receipt never reached anyone: the
 * process went away between the first write and the toast, so the vault carries
 * changes nobody was told about. The journal outlived the process, so the offer
 * can be made on the way back in. Silent whenever there is nothing to say,
 * which is almost always.
 */
export async function announceInterruptedWorkflowRun(): Promise<void> {
  const state = useStore.getState()
  if (!state.workflowsEnabled) return
  if (typeof window.zen.listWorkflowRuns !== 'function') return
  if (typeof window.zen.undoWorkflowRun !== 'function') return
  let runs: WorkflowRunSummary[]
  try {
    runs = await window.zen.listWorkflowRuns()
  } catch {
    // A run history that cannot be read is not worth a message of its own; the
    // vault opened fine and nothing here is something the user asked for.
    return
  }
  const interrupted = interruptedRunToOffer(runs, Date.now())
  if (interrupted === null) return
  // Shaped as a receipt so this offer walks the same undo path every other one
  // in this file does. `irreversible` is 0 rather than unknown: the summary
  // does not carry it, and nothing on the undo path reads it, so the honest
  // value is the one that claims nothing.
  const receipt: WorkflowRunReceipt = {
    runId: interrupted.runId,
    workflowId: interrupted.workflowId,
    startedAt: interrupted.startedAt,
    applied: interrupted.applied,
    paths: interrupted.paths,
    irreversible: 0
  }
  // `error`, so it stays until it is dismissed (see `addToast`): this is the
  // one receipt whose owner was never shown it, and a timer would take the
  // offer away from someone who has not finished reading what happened.
  toast(interruptedRunHeadline(interrupted), 'error', {
    label: undoLabel(receipt),
    onClick: () => void undoFromToast(receipt)
  })
}

/**
 * Run a workflow by id, end to end. Safe to call with anything: every failure
 * is a toast, never a throw, because the caller is a palette row.
 */
export async function runWorkflowById(id: string): Promise<void> {
  // The single funnel for every headless entry point, so the master switch
  // holds even for a caller that captured a command object (or an ex name)
  // before the toggle flipped. Same defensive posture as `openWorkflowsView`.
  if (!useStore.getState().workflowsEnabled) {
    toast('Workflows are turned off. Enable them under Settings → Workflows.', 'error')
    return
  }
  if (inFlight) return
  inFlight = true
  try {
    await runWorkflow(id)
  } finally {
    inFlight = false
  }
}

async function runWorkflow(id: string): Promise<void> {
  const state = useStore.getState()
  if (typeof window.zen.listWorkflows !== 'function' || typeof window.zen.applyWorkflow !== 'function') {
    toast('Running workflows is not available in this workspace.', 'error')
    return
  }

  // Read fresh from disk rather than trusting the index the palette showed:
  // the file may have changed since, and what runs must be what is on disk.
  let byId: Map<string, Workflow>
  let parseDiagnostics: Diagnostic[] = []
  try {
    const files = await window.zen.listWorkflows()
    byId = new Map()
    for (const file of files) {
      const parsed = parseWorkflow(file.raw, file.id)
      byId.set(parsed.workflow.id, parsed.workflow)
      if (file.id === id) parseDiagnostics = parsed.diagnostics
    }
  } catch (err) {
    toast(`Could not read the vault's workflows: ${errorText(err)}`, 'error')
    return
  }

  const workflow = byId.get(id)
  if (!workflow) {
    toast(`There is no workflow named "${id}" in this vault.`, 'error')
    return
  }
  if (!isRunnable(workflow)) {
    toast(`"${workflow.name}" is a draft, so it cannot run. Activate it first.`, 'error')
    return
  }

  const notes = state.notes
  const activeNote = state.selectedPath
    ? (notes.find((note) => note.path === state.selectedPath) ?? null)
    : null
  const reader = createVaultReader({
    notes,
    readBody: async (path) => (await window.zen.readNote(path)).body,
    current: () => activeNote
  })

  const templates = mergeTemplates(BUILTIN_TEMPLATES, state.customTemplates)
  const plan = await planWorkflow(workflow, {
    reader,
    now: Date.now(),
    resolve: (other) => byId.get(other) ?? null,
    systemFolderDirs: state.vaultSettings.systemFolderPaths
  })

  if (plan.ops.length === 0) {
    toast(`"${workflow.name}" only reads. There is nothing to apply.`)
    return
  }

  // The same three questions the view asks, in the same order.
  const dirtyPaths = unsavedCollisions(planWritePaths(plan.ops), state.noteDirty)
  let ops: WorkflowOp[] = plan.ops
  let unsaved: { paths: string[]; resolution: UnsavedResolution } | null = null
  if (dirtyPaths.length > 0) {
    const saveFirst = await confirmApp({
      title: unsavedCollisionTitle(dirtyPaths),
      description: unsavedCollisionDescription(dirtyPaths),
      confirmLabel: 'Save and continue',
      cancelLabel: 'Do not save'
    })
    if (saveFirst) {
      unsaved = { paths: dirtyPaths, resolution: 'save' }
    } else {
      const skip = await confirmApp({
        title: unsavedSkipTitle(dirtyPaths),
        description: unsavedSkipDescription(dirtyPaths),
        confirmLabel: 'Skip them',
        cancelLabel: 'Cancel the run'
      })
      if (!skip) return
      unsaved = { paths: dirtyPaths, resolution: 'skip' }
      ops = opsExcludingPaths(plan.ops, dirtyPaths)
    }
  }
  if (ops.length === 0) {
    toast(
      'Every planned change touched a note with unsaved edits, so skipping them left nothing to run.',
      'error'
    )
    return
  }

  const titleByPath = new Map(notes.map((note) => [note.path, note.title]))
  const titleForPath = (path: string): string => {
    const known = titleByPath.get(path)
    if (known !== undefined) return known
    const file = path.split('/').pop() ?? path
    return file.replace(/\.md$/i, '')
  }
  const withTemplates = resolveTemplateOps(ops, templates, titleForPath, new Date())
  if (withTemplates.missing.length > 0) {
    const names = withTemplates.missing.map((name) => `"${name}"`).join(', ')
    toast(
      withTemplates.missing.length === 1
        ? `${names} is not a template in this vault, so "${workflow.name}" cannot run.`
        : `${names} are not templates in this vault, so "${workflow.name}" cannot run.`,
      'error'
    )
    return
  }

  const lines = summarizeOps(ops)
  const irreversibleCount = ops.filter((op) => IRREVERSIBLE_KINDS.has(op.kind)).length
  const ok = await confirmApp({
    title: runConfirmTitle(workflow.name),
    description: runConfirmDescription({
      workflowName: workflow.name,
      lines,
      fileCount: planWritePaths(ops).length,
      irreversibleCount,
      errorCount: countErrors([
        parseDiagnostics,
        validateWorkflow(workflow, byId),
        plan.diagnostics,
        unknownTemplateDiagnostics(workflow, templates)
      ]),
      unsaved
    }),
    confirmLabel: runConfirmLabel(lines),
    danger: irreversibleCount > 0
  })
  if (!ok) return

  try {
    if (unsaved?.resolution === 'save') {
      await Promise.all(unsaved.paths.map((path) => state.persistNote(path)))
    }
    const receipt = await window.zen.applyWorkflow({
      workflowId: workflow.id,
      ops: withTemplates.ops
    })
    // The same store record the view's Undo card reads, written from here too.
    // A palette run and a canvas run are one event with two doorways, and two
    // records for one workflow is exactly how an older Undo ends up reverting a
    // newer run: the newest write wins, on every surface at once.
    useStore.getState().setWorkflowRunRecord({
      workflowId: workflow.id,
      receipt,
      undone: null,
      undoError: null
    })
    if (receipt.rolledBack === undefined) {
      const effects = collectRunSideEffects(withTemplates.ops)
      for (const message of effects.notifications) toast(message)
      if (effects.clipboard !== null) {
        try {
          await navigator.clipboard.writeText(effects.clipboard)
        } catch {
          toast('The run finished, but the clipboard write failed.', 'error')
        }
      }
      const undoable =
        receipt.paths.length > 0 && typeof window.zen.undoWorkflowRun === 'function'
      toast(
        receiptHeadline(receipt),
        'success',
        undoable
          ? { label: undoLabel(receipt), onClick: () => void undoFromToast(receipt) }
          : undefined,
        undoable ? RECEIPT_TOAST_MS : undefined
      )
    } else {
      toast(receipt.rolledBack.reason, 'error')
    }
    await state.refreshNotes()
  } catch (err) {
    toast(errorText(err), 'error')
  }
}
