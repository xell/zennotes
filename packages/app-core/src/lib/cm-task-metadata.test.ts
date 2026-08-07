// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { taskMetadataExtension } from './cm-task-metadata'

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), taskMetadataExtension]
    })
  })
  forceParsing(view, doc.length, 5000)
  // nudge the doc so the plugin rebuilds against a fully-parsed tree
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}
const classesOn = (view: EditorView, sel: string) =>
  Array.from(view.dom.querySelectorAll(sel)).map((e) => e.textContent)

describe('cm-task-metadata (#454)', () => {
  it('colors the three priority levels and their aliases', () => {
    const view = mount('- [ ] Ship it !high\n- [ ] Later !med\n- [ ] Someday !low\n- [ ] Quick !h')
    expect(classesOn(view, '.cm-task-prio-high')).toEqual(['!high', '!h'])
    expect(classesOn(view, '.cm-task-prio-med')).toEqual(['!med'])
    expect(classesOn(view, '.cm-task-prio-low')).toEqual(['!low'])
    view.destroy()
  })

  it('chips an upcoming due date and reds an overdue one (open task)', () => {
    const view = mount('- [ ] Renew domain due:2999-12-31\n- [ ] Pay invoice due:2000-01-01')
    expect(classesOn(view, '.cm-task-due')).toEqual(['due:2999-12-31'])
    expect(classesOn(view, '.cm-task-due-overdue')).toEqual(['due:2000-01-01'])
    view.destroy()
  })

  it('does not mark a past due date as overdue on a done/cancelled task', () => {
    const view = mount('- [x] Filed taxes due:2000-01-01\n- [-] Dropped due:2000-01-01')
    expect(view.dom.querySelectorAll('.cm-task-due-overdue').length).toBe(0)
    expect(classesOn(view, '.cm-task-due')).toEqual(['due:2000-01-01', 'due:2000-01-01'])
    view.destroy()
  })

  it('marks @waiting and @key:value fields', () => {
    const view = mount('- [ ] Blocked task @waiting @status:blocked')
    expect(classesOn(view, '.cm-task-field')).toEqual(['@waiting', '@status:blocked'])
    view.destroy()
  })

  it('ignores metadata-looking tokens outside task lines', () => {
    const view = mount('Just a note with !high and due:2000-01-01 and @waiting')
    expect(view.dom.querySelectorAll('.cm-task-prio, .cm-task-meta').length).toBe(0)
    view.destroy()
  })

  it('does not treat an invalid due value as a due date', () => {
    const view = mount('- [ ] Bad date due:soon and due:2026-13')
    expect(view.dom.querySelectorAll('.cm-task-due, .cm-task-due-overdue').length).toBe(0)
    view.destroy()
  })

  it('skips a task-looking line inside a fenced code block', () => {
    const view = mount('```md\n- [ ] Example !high due:2000-01-01\n```\n\n- [ ] Real !low')
    expect(classesOn(view, '.cm-task-prio-high')).toEqual([])
    expect(classesOn(view, '.cm-task-prio-low')).toEqual(['!low'])
    view.destroy()
  })
})
