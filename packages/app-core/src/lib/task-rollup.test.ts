// @vitest-environment jsdom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { computeTaskRollups } from './cm-task-rollup'
import type { TaskRollup } from './task-rollup'
import { renderMarkdown } from './markdown'

/** Parse the same Markdown tree the editor uses, then compute visible rollups. */
function rollups(lines: string[], first = 1, last = lines.length): Map<number, TaskRollup> {
  const source = lines.join('\n')
  const state = EditorState.create({ doc: source, extensions: [markdown()] })
  ensureSyntaxTree(state, source.length, 5_000)
  return computeTaskRollups(state, first, last)
}

describe('computeTaskRollups (#512)', () => {
  it('counts direct children, done over total', () => {
    const r = rollups(['- [ ] parent', '  - [x] a', '  - [ ] b', '  - [ ] c'])
    expect(r.get(1)).toEqual({ done: 1, total: 3 })
  })

  it('a parent without subtasks gets no entry', () => {
    const r = rollups(['- [ ] alone', '- [ ] neighbour'])
    expect(r.size).toBe(0)
  })

  it('an in-progress child counts toward total but not done', () => {
    const r = rollups(['- [ ] parent', '  - [/] started', '  - [x] finished'])
    expect(r.get(1)).toEqual({ done: 1, total: 2 })
  })

  it('cancelled and forwarded children are out of the denominator', () => {
    const r = rollups(['- [ ] parent', '  - [-] dropped', '  - [>] moved', '  - [x] kept'])
    expect(r.get(1)).toEqual({ done: 1, total: 1 })
  })

  it('a parent whose only children are cancelled has nothing to show', () => {
    const r = rollups(['- [ ] parent', '  - [-] dropped'])
    expect(r.size).toBe(0)
  })

  it('grandchildren roll into their own parent, not the grandparent', () => {
    const r = rollups([
      '- [ ] top',
      '  - [ ] middle',
      '    - [x] leaf a',
      '    - [ ] leaf b',
      '  - [x] sibling'
    ])
    expect(r.get(1)).toEqual({ done: 1, total: 2 })
    expect(r.get(2)).toEqual({ done: 1, total: 2 })
  })

  it('a non-task bullet blocks the rollup like the mdast tree does', () => {
    const r = rollups(['- [ ] parent', '  - just a note', '    - [x] belongs to the note'])
    expect(r.size).toBe(0)
  })

  it('a glued checkbox is prose on both surfaces, not a countable task', () => {
    // GFM only recognizes `[x]` followed by whitespace; the reading view will
    // not draw `- [x]glued` as a task, so the chip must not count it.
    const child = '- [ ] parent\n  - [x]glued\n  - [ ] real'
    expect(rollups(child.split('\n')).get(1)).toEqual({ done: 0, total: 1 })
    expect(renderMarkdown(child)).toContain('0/1')

    const parent = '- [ ]parent\n  - [x] a'
    expect(rollups(parent.split('\n')).size).toBe(0)
    expect(renderMarkdown(parent)).not.toContain('zen-task-rollup')
  })

  it('does not turn a one-space sibling into a child', () => {
    const source = '- [ ] parent\n - [x] sibling'
    expect(rollups(source.split('\n')).size).toBe(0)
    expect(renderMarkdown(source)).not.toContain('zen-task-rollup')
  })

  it('honors the wider content indent of an ordered-list marker', () => {
    const source = '10. [ ] parent\n  - [x] separate list'
    expect(rollups(source.split('\n')).size).toBe(0)
    expect(renderMarkdown(source)).not.toContain('zen-task-rollup')
  })

  it('does not count a task inside a nested blockquote as a direct child', () => {
    const source = '- [ ] parent\n  > - [x] quoted task'
    expect(rollups(source.split('\n')).size).toBe(0)
    expect(renderMarkdown(source)).not.toContain('zen-task-rollup')
  })

  it('a checked parent still reports its children', () => {
    const r = rollups(['- [x] parent', '  - [ ] leftover'])
    expect(r.get(1)).toEqual({ done: 0, total: 1 })
  })

  it('blank lines inside the list do not end the subtree; a heading does', () => {
    const r = rollups(['- [ ] parent', '', '  - [x] a', '# heading', '  - [x] not a child'])
    expect(r.get(1)).toEqual({ done: 1, total: 1 })
  })

  it('numbered and starred bullets nest the same way', () => {
    const r = rollups(['1. [ ] parent', '   * [x] a', '   2) [ ] b'])
    expect(r.get(1)).toEqual({ done: 1, total: 2 })
  })

  it('blockquoted tasks nest among themselves', () => {
    const r = rollups(['> - [ ] quoted parent', '>   - [x] quoted child'])
    expect(r.get(1)).toEqual({ done: 1, total: 1 })
  })

  it('task-shaped lines in a code fence neither count nor hide real children', () => {
    const lines = [
      '- [ ] parent',
      '  - [x] a',
      '',
      '  ~~~',
      '  - [x] example',
      '  ~~~',
      '',
      '  - [ ] b'
    ]
    const r = rollups(lines)
    expect(r.get(1)).toEqual({ done: 1, total: 2 })
  })

  it('a parent inside the range counts a subtree that continues past it', () => {
    const lines = ['- [ ] parent', '  - [x] a', '  - [ ] b', '  - [ ] c']
    const r = rollups(lines, 1, 1)
    expect(r.get(1)).toEqual({ done: 1, total: 3 })
  })

  it('a parent above the range is not reported', () => {
    const lines = ['- [ ] parent', '  - [x] a', '- [ ] second', '  - [ ] b']
    const r = rollups(lines, 3, 4)
    expect(r.get(1)).toBeUndefined()
    expect(r.get(3)).toEqual({ done: 0, total: 1 })
  })
})

describe('task rollup chips in the reading preview (#512)', () => {
  it('shows done over total on the parent line', () => {
    const html = renderMarkdown('- [ ] parent\n  - [x] a\n  - [ ] b')
    expect(html).toContain('zen-task-rollup')
    expect(html).toContain('1/2')
  })

  it('marks a fully-done parent as complete', () => {
    const html = renderMarkdown('- [ ] parent\n  - [x] a\n  - [x] b')
    expect(html).toContain('zen-task-rollup-complete')
    expect(html).toContain('2/2')
  })

  it('applies the shared state semantics: cancelled and forwarded out, in-progress not done', () => {
    const html = renderMarkdown('- [ ] parent\n  - [-] gone\n  - [>] moved\n  - [/] going\n  - [x] done')
    expect(html).toContain('1/2')
  })

  it('puts nothing on a plain bullet or a childless task', () => {
    const html = renderMarkdown('- plain parent\n  - [x] a\n- [ ] childless')
    expect(html).not.toContain('zen-task-rollup')
  })

  it('labels the chip for hover and screen readers, singular and plural', () => {
    const html = renderMarkdown('- [ ] parent\n  - [x] a\n  - [ ] b')
    expect(html).toContain('title="1 of 2 subtasks done"')
    expect(html).toContain('aria-label="1 of 2 subtasks done"')
    const one = renderMarkdown('- [ ] parent\n  - [ ] only')
    expect(one).toContain('title="0 of 1 subtask done"')
  })
})
