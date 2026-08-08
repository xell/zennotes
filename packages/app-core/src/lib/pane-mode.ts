export type PaneMode = 'edit' | 'preview' | 'split' | 'diff'

export const ZEN_SET_PANE_MODE_EVENT = 'zen:set-pane-mode'
export const DEFAULT_PANE_MODE: PaneMode = 'edit'

export type PaneModesByPath = Record<string, PaneMode>

export function isPaneMode(value: unknown): value is PaneMode {
  return value === 'edit' || value === 'preview' || value === 'split'
}

export function paneModeForPath(
  modesByPath: PaneModesByPath,
  path: string | null,
  // A note the user has not put in a mode yet opens in this; the "Default
  // view mode" preference feeds it so readers can land in Preview. (#543)
  fallback: PaneMode = DEFAULT_PANE_MODE
): PaneMode {
  return path ? modesByPath[path] ?? fallback : fallback
}

export function paneModesWithPathMode(
  modesByPath: PaneModesByPath,
  path: string | null,
  mode: PaneMode
): PaneModesByPath {
  if (!path || modesByPath[path] === mode) return modesByPath
  return { ...modesByPath, [path]: mode }
}

export function requestPaneMode(mode: PaneMode): void {
  window.dispatchEvent(
    new CustomEvent<{ mode: PaneMode }>(ZEN_SET_PANE_MODE_EVENT, {
      detail: { mode }
    })
  )
}
