// @vitest-environment jsdom
//
// Regression for #485, round 3: a table-menu action must land even when the
// widget that opened the menu was rebuilt (and its DOM detached) while the
// menu was up. In real use that rebuild is the widget's own dirty-cell
// commit, triggered by the focusout of opening the menu: the reporter had
// just typed into the cell, so the first alignment pick vanished silently
// and the second (no longer dirty, no rebuild) worked.
//
// This lives in its own file on purpose: cm-table.test.ts mounts many
// editors over identical docs and never destroys them, and under jsdom that
// crowd interferes with menu-driven flows. A fresh module registry and an
// empty body make this deterministic.

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { history } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { tablePlugin } from './cm-table'
import { closeTableContextMenu } from './cm-table-menu'

const TABLE_DOC = `Intro text.

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

Outro text.`

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), history(), tablePlugin]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: 0, insert: ' ' } })
  view.dispatch({ changes: { from: 0, to: 1 } })
  return view
}

/** The menu attaches its window listeners on a deferred task. */
async function flushMenuListeners(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('menu actions after a mid-menu rebuild (#485, round 3)', () => {
  afterEach(() => {
    closeTableContextMenu()
    document.body.innerHTML = ''
  })

  it('an action still lands when the widget was rebuilt while the menu was open', async () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )
    expect(cell).toBeTruthy()

    // Open the table menu from the cell (Vim NORMAL `m`).
    cell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }))
    expect(document.querySelector('.cm-table-menu')).toBeTruthy()
    await flushMenuListeners()

    // While the menu is open the document changes. In real use this is the
    // widget's own dirty-cell commit firing on the focusout that opening the
    // menu causes; the decoration rebuild detaches the widget instance the
    // menu's actions are bound to.
    const alicePos = view.state.doc.toString().indexOf('Alice')
    view.dispatch({ changes: { from: alicePos, insert: 'x' } })

    // Filter to "Align center" and choose it: the exact sequence from the
    // report's recording (m, "cen", Enter). Before the anchor fix this commit
    // died in posAtDOM on the detached DOM and the edit vanished silently.
    for (const ch of 'cen') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ch }))
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    // The action lands in the CURRENT document. The menu applies the model it
    // captured at open, so the simulated mid-menu edit is superseded; in the
    // real flow that edit IS the widget's own commit of the same model, so
    // nothing the user typed is lost.
    const doc = view.state.doc.toString()
    expect(doc).toMatch(/\| :-+: \|/)
    expect(doc.match(/\| :-+: \|/g)).toHaveLength(1)
    expect(doc).toContain('Intro text.')
    expect(doc).toContain('Outro text.')
    view.destroy()
  })

  it('still commits the normal way when nothing rebuilt meanwhile', async () => {
    const view = mount(TABLE_DOC)
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]'
    )
    cell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }))
    await flushMenuListeners()
    for (const ch of 'cen') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ch }))
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(view.state.doc.toString()).toMatch(/\| :-+: \|/)
    view.destroy()
  })
})
