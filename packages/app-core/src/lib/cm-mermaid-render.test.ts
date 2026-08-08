// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { Compartment, EditorState, type EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mermaidBlockLineRanges, mermaidRenderExtension } from './cm-mermaid-render'

// mermaid itself is never loaded here: the widget paints asynchronously and
// these tests are about WHICH blocks become widgets and where their lines are,
// which is decided before any rendering happens. Stubbing keeps the heaviest
// chunk in the app out of the test run entirely.
const mermaidMocks = vi.hoisted(() => ({
  peekMermaidSvg: vi.fn(),
  renderMermaidSvg: vi.fn()
}))

vi.mock('./mermaid-render', () => mermaidMocks)

function mount(
  doc: string,
  selection?: EditorSelection | { anchor: number },
  extension: Extension = mermaidRenderExtension('light', 'theme-a')
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: selection ?? { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), extension]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Nudge a rebuild so decorations reflect the fully parsed tree.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

const DIAGRAM = 'start\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nend'

describe('mermaidRenderExtension', () => {
  beforeEach(() => {
    mermaidMocks.peekMermaidSvg.mockReset().mockReturnValue(null)
    mermaidMocks.renderMermaidSvg.mockReset().mockImplementation(() => new Promise(() => {}))
  })

  it('draws a mermaid fence while the cursor is elsewhere', () => {
    const view = mount(DIAGRAM)
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(1)
    view.destroy()
  })

  it('reveals the source while the cursor is inside the block', () => {
    // Anchor on the `flowchart LR` line, i.e. inside the fence.
    const view = mount(DIAGRAM, { anchor: DIAGRAM.indexOf('flowchart') + 2 })
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  it('leaves other languages alone', () => {
    const view = mount('start\n\n```ts\nconst a = 1\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  it('accepts an info string with extra words after the language', () => {
    const view = mount('start\n\n```mermaid title="Flow"\nflowchart LR\n  A --> B\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(1)
    view.destroy()
  })

  it('leaves an empty fence as source, since there is nothing to draw', () => {
    const view = mount('start\n\n```mermaid\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  it('redraws when the theme identity changes without changing light/dark mode', async () => {
    mermaidMocks.renderMermaidSvg.mockResolvedValue({ ok: true, svg: '<svg data-theme="a" />' })
    const theme = new Compartment()
    const view = mount(DIAGRAM, undefined, theme.of(mermaidRenderExtension('light', 'theme-a')))

    await vi.waitFor(() => expect(mermaidMocks.renderMermaidSvg).toHaveBeenCalledTimes(1))
    view.dispatch({
      effects: theme.reconfigure(mermaidRenderExtension('light', 'theme-b'))
    })

    await vi.waitFor(() =>
      expect(mermaidMocks.renderMermaidSvg).toHaveBeenCalledWith(
        expect.stringContaining('flowchart LR'),
        'light',
        'theme-b'
      )
    )
    view.destroy()
  })

  it('keeps the last good drawing for a block while its edited source is invalid', async () => {
    mermaidMocks.renderMermaidSvg.mockImplementation((source: string) =>
      Promise.resolve(
        source.includes('INVALID')
          ? { ok: false, error: 'parse failed' }
          : { ok: true, svg: '<svg data-last-good="true" />' }
      )
    )
    const view = mount(DIAGRAM)

    await vi.waitFor(() =>
      expect(view.dom.querySelector('[data-last-good="true"]')).not.toBeNull()
    )
    const from = view.state.doc.toString().indexOf('flowchart LR')
    view.dispatch({ changes: { from, to: from + 'flowchart LR'.length, insert: 'INVALID' } })

    await vi.waitFor(() => {
      expect(view.dom.querySelector('[data-last-good="true"]')).not.toBeNull()
      expect(view.dom.querySelector('.cm-mermaid-error')).toBeNull()
    })
    view.destroy()
  })

  // A rendered block is one widget with no cursor coordinates inside it, so
  // vertical motion sails over it unless the nav helpers know the block is
  // there. Without these ranges a keyboard-only user can never open the source.
  describe('mermaidBlockLineRanges', () => {
    it('reports the fence line span, fences included', () => {
      const view = mount(DIAGRAM)
      expect(mermaidBlockLineRanges(view.state)).toEqual([{ fromLine: 3, toLine: 6 }])
      view.destroy()
    })

    it('still reports the block while its source is revealed', () => {
      const view = mount(DIAGRAM, { anchor: DIAGRAM.indexOf('flowchart') + 2 })
      expect(mermaidBlockLineRanges(view.state)).toEqual([{ fromLine: 3, toLine: 6 }])
      view.destroy()
    })

    it('is empty when the extension is not installed', () => {
      const parent = document.createElement('div')
      document.body.append(parent)
      const plain = new EditorView({
        parent,
        state: EditorState.create({
          doc: DIAGRAM,
          extensions: [markdown({ base: markdownLanguage })]
        })
      })
      expect(mermaidBlockLineRanges(plain.state)).toEqual([])
      plain.destroy()
    })
  })
})
