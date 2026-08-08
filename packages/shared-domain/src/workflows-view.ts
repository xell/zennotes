// The pseudo-path that opens the Workflows canvas as a tab, matching the
// convention used by Tasks, Tags, Assets, Archive, Trash and Help. Lives in
// shared-domain so the renderer, the command palette and the pane router all
// agree on one string.
export const WORKFLOWS_TAB_PATH = 'zen://workflows'

export function isWorkflowsTabPath(path: string | null | undefined): boolean {
  return path === WORKFLOWS_TAB_PATH
}

/** Where user-authored workflow files live inside a vault. */
export const WORKFLOWS_REL_DIR = '.zennotes/workflows'
