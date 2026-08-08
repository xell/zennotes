// Starting and finishing the guided Workflows tutorial.
//
// Thin glue between the content module (which owns WHAT is seeded and removed,
// and stays store-free so it tests under node) and the store (which owns the
// chapter pointer). Only lazy surfaces import this (Settings, the Workflows
// view), so none of the tutorial's text ever rides the boot path.
import { useStore } from '../store'
import { useToastStore } from './toast'
import { vaultRelativeFolderPath } from './vault-layout'
import {
  TUTORIAL_FOLDER_SUBPATH,
  TUTORIAL_WORKFLOW_SLUG,
  cleanupWorkflowTutorial,
  seedWorkflowTutorial
} from './workflow-tutorial'

/**
 * Seed the practice material and open the view on chapter one.
 *
 * Starting IS the workflows opt-in when the feature is off: the user clicked
 * "Start tutorial", and a tutorial that opens onto a feature that then hides
 * itself again would be a riddle, not a lesson. Seeding leads with a cleanup,
 * so a tutorial abandoned by a crash (or an earlier session) never doubles up.
 */
export async function startWorkflowTutorial(): Promise<void> {
  const state = useStore.getState()
  try {
    if (!state.workflowsEnabled) state.setWorkflowsEnabled(true)
    // Resolved, not `inbox/...`: this vault may keep its notes at the root or
    // have its Inbox remapped, and cleanup deletes through the folder API,
    // which honors both. See vaultRelativeFolderPath.
    await seedWorkflowTutorial(
      window.zen,
      vaultRelativeFolderPath('inbox', TUTORIAL_FOLDER_SUBPATH, state.vaultSettings)
    )
    // Feedback first: card up, settings away, view open. The index refreshes
    // trail as best-effort because nothing the card needs depends on them
    // (the view loads its own list on mount), and a hiccup in either must not
    // read as "the button does nothing".
    useStore.getState().setWorkflowTutorialStep(0)
    useStore.getState().setSettingsOpen(false)
    await useStore.getState().openWorkflowsView()
    void state.refreshNotes().catch(() => {})
    void state.loadWorkflowIndex().catch(() => {})
  } catch (err) {
    useStore.getState().setWorkflowTutorialStep(null)
    // The toast layer sits under the settings modal, so a failure toast shown
    // behind it is indistinguishable from nothing happening. Close settings
    // first: the error must be the next thing the user sees.
    useStore.getState().setSettingsOpen(false)
    useToastStore
      .getState()
      .addToast(
        `Could not set the tutorial up: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
  }
}

/**
 * End the tutorial (finished or abandoned, same promise): remove the practice
 * folder, the tutorial workflow, and its run ledgers, then refresh what the
 * user sees. The vault ends exactly as it started.
 */
export async function finishWorkflowTutorial(): Promise<void> {
  useStore.getState().setWorkflowTutorialStep(null)
  // The practice run's ledger is about to be deleted, so an offer to undo it
  // would be a promise nothing on disk can keep.
  useStore
    .getState()
    .setWorkflowRunRecord((prev) => (prev?.workflowId === TUTORIAL_WORKFLOW_SLUG ? null : prev))
  try {
    await cleanupWorkflowTutorial(window.zen)
  } finally {
    const state = useStore.getState()
    await state.refreshNotes().catch(() => {})
    await state.loadWorkflowIndex().catch(() => {})
  }
}
