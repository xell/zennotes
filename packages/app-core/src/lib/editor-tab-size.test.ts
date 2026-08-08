import { EditorState } from '@codemirror/state'
import { getIndentUnit } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { editorTabSize, normalizeEditorTabSize } from './editor-tab-size'

describe('editor tab size', () => {
  it('sets both rendered tab width and indentation width', () => {
    const state = EditorState.create({ extensions: [editorTabSize(3)] })

    expect(state.tabSize).toBe(3)
    expect(getIndentUnit(state)).toBe(3)
  })

  it('normalizes persisted values to a safe range', () => {
    expect(normalizeEditorTabSize(0)).toBe(1)
    expect(normalizeEditorTabSize(4.6)).toBe(5)
    expect(normalizeEditorTabSize(99)).toBe(8)
    expect(normalizeEditorTabSize('4')).toBe(4)
    expect(normalizeEditorTabSize('invalid')).toBe(4)
  })
})
