import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  textReplacementInputTransaction,
  normalizeTextReplacements
} from './cm-text-replacements'

function state(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({ doc, selection: { anchor } })
}

describe('text replacements', () => {
  it('replaces a completed trigger while preserving surrounding text', () => {
    const transaction = textReplacementInputTransaction(
      state('move -'),
      6,
      6,
      '>',
      { '->': '→' }
    )

    const next = state('move -').update(transaction!).state
    expect(next.doc.toString()).toBe('move →')
    expect(next.selection.main.head).toBe(6)
  })

  it('uses the longest matching trigger', () => {
    const transaction = textReplacementInputTransaction(
      state('wait --'),
      7,
      7,
      '>',
      { '->': '→', '-->': '⟶' }
    )

    expect(state('wait --').update(transaction!).state.doc.toString()).toBe('wait ⟶')
  })

  it('does not replace while a range is selected', () => {
    const selected = EditorState.create({
      doc: 'move -',
      selection: { anchor: 5, head: 6 }
    })

    expect(
      textReplacementInputTransaction(selected, 5, 6, '>', { '->': '→' })
    ).toBeNull()
  })

  it('normalizes invalid, duplicate, and oversized replacement rules', () => {
    expect(
      normalizeTextReplacements({
        '': 'ignored',
        ' -> ': '→',
        ok: 'yes',
        [String.raw`a`.repeat(100)]: 'too long',
        bad: 42
      })
    ).toEqual({ '->': '→', ok: 'yes' })
  })
})
