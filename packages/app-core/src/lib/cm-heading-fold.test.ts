import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldService } from '@codemirror/language'
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
})
