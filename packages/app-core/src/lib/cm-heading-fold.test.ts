import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldService, foldable } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { headingFolding, headingFoldRanges } from './cm-heading-fold'

/** Run the heading fold service over a given line; returns its fold range. */
function foldRangeAtLine(doc: string, lineNumber: number): { from: number; to: number } | null {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), headingFolding()]
  })
  const line = state.doc.line(lineNumber)
  for (const svc of state.facet(foldService)) {
    const range = svc(state, line.from, line.to)
    if (range) return range
  }
  return null
}

describe('heading folding', () => {
  it('treats a real heading line as foldable', () => {
    const doc = '# Real heading\n\nbody text\nmore\n'
    expect(foldRangeAtLine(doc, 1)).not.toBeNull()
  })

  it('does NOT treat a `#` comment inside a fenced code block as a heading (#83)', () => {
    // `# This is a comment` is line 3 inside the ```bash fence.
    const doc = '```bash\n#!/bin/bash\n# This is a comment\necho "Hello"\n```\n'
    expect(foldRangeAtLine(doc, 3)).toBeNull()
  })

  it('does NOT fold a `#` line inside a plain (unlabelled) fence', () => {
    const doc = '```\n# not a heading\nplain\n```\n'
    expect(foldRangeAtLine(doc, 2)).toBeNull()
  })

  it('still folds a real heading that follows a code block', () => {
    const doc = '```\n# in code\n```\n\n# Real\n\nbody\n'
    expect(foldRangeAtLine(doc, 5)).not.toBeNull()
  })

  it('fold-all yields one fold per heading at every level (not just the top)', () => {
    // Regression: stock CM foldAll folds only the outermost heading (whose
    // range spans the whole subtree) and skips the nested ones, so unfolding
    // the parent reveals everything at once. headingFoldRanges folds each
    // heading so per-level `zo` unfolding works.
    const doc = '# heading 1\ntext 1\n## heading 2 A\ntext 2.A\n## heading 2 B\ntext 2.B\n'
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), headingFolding()]
    })
    const ranges = headingFoldRanges(state)
    // One fold each for `# heading 1`, `## heading 2 A`, `## heading 2 B`.
    expect(ranges).toHaveLength(3)
    // The level-1 heading's fold spans the rest of the document (through the
    // nested sections), while the nested folds are contained within it — the
    // nesting `zo` needs to peel back one level at a time.
    const h1 = ranges[0]!
    expect(h1.from).toBe(state.doc.line(1).to)
    expect(h1.to).toBe(state.doc.length)
    const h2a = ranges[1]!
    expect(h2a.from).toBeGreaterThan(h1.from)
    expect(h2a.to).toBeLessThan(h1.to)
  })

  it('foldCode uses our heading range (incl. trailing blank), not the markdown one', () => {
    // Regression: the markdown language registers its own heading foldService
    // whose range stops at the last non-blank line, dropping a trailing blank
    // out of the fold. `foldable()` (used by `zc`/foldCode) returns the first
    // service's result, so ours must win via Prec.highest — otherwise `zc`
    // leaves the section's final empty line visible.
    const doc = '# H\n## S\ntext\n\n# H2\n'
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), headingFolding()]
    })
    const line = state.doc.line(1)
    const chosen = foldable(state, line.from, line.to)
    // foldable() picks our range (the `# H` entry from headingFoldRanges).
    expect(chosen).toEqual(headingFoldRanges(state)[0])
    // Our fold reaches the section's final blank line (line 4, right before the
    // next same-level heading on line 5). The markdown range would stop one
    // line earlier at the end of "text", leaving that blank line visible.
    expect(state.doc.line(4).text).toBe('')
    expect(state.doc.line(5).text).toBe('# H2')
    expect(chosen!.to).toBe(state.doc.line(4).to)
  })
})
