import { EditorState, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'

export const DEFAULT_EDITOR_TAB_SIZE = 4
export const MIN_EDITOR_TAB_SIZE = 1
export const MAX_EDITOR_TAB_SIZE = 8

export function normalizeEditorTabSize(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_EDITOR_TAB_SIZE
  return Math.min(MAX_EDITOR_TAB_SIZE, Math.max(MIN_EDITOR_TAB_SIZE, Math.round(parsed)))
}

export function editorTabSize(value: unknown): Extension {
  const size = normalizeEditorTabSize(value)
  return [EditorState.tabSize.of(size), indentUnit.of(' '.repeat(size))]
}
