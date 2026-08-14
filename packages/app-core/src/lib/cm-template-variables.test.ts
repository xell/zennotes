import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { templateVariableApplySpec, templateVariableSource } from './cm-template-variables'

function state(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.cursor(anchor) })
}

function applied(doc: string, from: number, to: number, insert: string): EditorState {
  const current = state(doc, to)
  return current.update(templateVariableApplySpec(current, from, to, insert)).state
}

describe('templateVariableApplySpec', () => {
  it('swallows the auto-paired closers left after the caret (#566)', () => {
    // Auto-pair turned `{{` into `{{}}` with the caret in the middle; the
    // completion's insert brings its own closers.
    const next = applied('{{}}', 0, 2, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{cursor}}')
    expect(next.selection.main.head).toBe('{{cursor}}'.length)
  })

  it('swallows closers when completing inside an existing pair', () => {
    // Editing `{{date}}` down to `{{ti|}}` and accepting {{time}} must not
    // leave the old pair's braces behind.
    const next = applied('{{ti}}', 0, 4, '{{time}}')

    expect(next.doc.toString()).toBe('{{time}}')
  })

  it('swallows a single stray closer', () => {
    const next = applied('{{cu}', 0, 4, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{cursor}}')
  })

  it('replaces only the typed token when nothing follows (auto-pair off)', () => {
    const next = applied('{{cu', 0, 4, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{cursor}}')
    expect(next.selection.main.head).toBe('{{cursor}}'.length)
  })

  it('leaves unrelated trailing text alone', () => {
    const next = applied('{{cu after', 0, 4, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{cursor}} after')
  })

  it('never consumes more than the two closers the insert provides', () => {
    const next = applied('{{cu}}}}', 0, 4, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{cursor}}}}')
  })

  it('leaves closers that belong to an earlier open construct alone', () => {
    // Prose documenting Handlebars/Jinja syntax: the `}}` after the caret
    // closes `{{var`, so accepting the completion must not delete it.
    const next = applied('{{var{{da}}', 5, 9, '{{date}}')

    expect(next.doc.toString()).toBe('{{var{{date}}}}')
  })

  it('still swallows closers when an earlier pair on the line is already closed', () => {
    const next = applied('{{a}} {{cu}}', 6, 10, '{{cursor}}')

    expect(next.doc.toString()).toBe('{{a}} {{cursor}}')
  })
})

describe('templateVariableSource', () => {
  it('offers variables once {{ is typed and anchors the result at the braces', () => {
    const doc = 'Line\n{{cu'
    const result = templateVariableSource(new CompletionContext(state(doc), doc.length, false))

    expect(result).not.toBeNull()
    expect(result!.from).toBe(doc.length - '{{cu'.length)
    expect(result!.options.map((option) => option.label)).toEqual(['{{cursor}}'])
  })

  it('stays quiet outside a {{ token', () => {
    const doc = 'plain text'
    expect(templateVariableSource(new CompletionContext(state(doc), doc.length, false))).toBeNull()
  })
})
