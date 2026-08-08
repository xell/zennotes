import { describe, it, expect } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'
import { FRONTMATTER_BLOCK_RE, parseFrontmatterFields } from '@shared/frontmatter'
import { parseFrontmatter } from '@shared/template-files'
import {
  composePageBody,
  moveColumn,
  moveColumnToField,
  setFieldOptionsSource
} from './database-cells'

// Minimal doc with four fields; the reorder helpers only read `fields` + `views`.
function makeDoc(columnOrder?: string[], hiddenFieldIds?: string[]): DatabaseDoc {
  return {
    path: 'db.base/data.csv',
    title: 'db',
    version: 1,
    idFieldId: 'f_id',
    activeViewId: 'v1',
    fields: [
      { id: 'f_id', name: 'id', type: 'text' },
      { id: 'f_a', name: 'A', type: 'text' },
      { id: 'f_b', name: 'B', type: 'text' },
      { id: 'f_c', name: 'C', type: 'text' }
    ],
    views: [
      { id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [], columnOrder, hiddenFieldIds }
    ],
    rows: []
  } as unknown as DatabaseDoc
}

const orderOf = (doc: DatabaseDoc): string[] | undefined =>
  doc.views.find((v) => v.id === 'v1')?.columnOrder

describe('moveColumn (#317)', () => {
  it('moves a column one step left / right', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_b', 'left'))).toEqual(['f_id', 'f_b', 'f_a', 'f_c'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_b', 'right'))).toEqual(['f_id', 'f_a', 'f_c', 'f_b'])
  })

  it('is a no-op at the edges', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(moveColumn(doc, 'v1', 'f_id', 'left')).toBe(doc)
    expect(moveColumn(doc, 'v1', 'f_c', 'right')).toBe(doc)
  })

  it('skips hidden columns so the move is always visible', () => {
    // Visible order is f_id, f_c (f_a + f_b hidden); moving f_c left lands it
    // before f_id, past the hidden pair.
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'], ['f_a', 'f_b'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_c', 'left'))).toEqual(['f_c', 'f_a', 'f_b', 'f_id'])
  })

  it('normalizes a missing columnOrder against the fields', () => {
    const doc = makeDoc(undefined)
    expect(orderOf(moveColumn(doc, 'v1', 'f_a', 'right'))).toEqual(['f_id', 'f_b', 'f_a', 'f_c'])
  })
})

describe('moveColumnToField — drag reorder (#317)', () => {
  it('inserts the dragged column immediately before the target', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(orderOf(moveColumnToField(doc, 'v1', 'f_c', 'f_a'))).toEqual(['f_id', 'f_c', 'f_a', 'f_b'])
    expect(orderOf(moveColumnToField(doc, 'v1', 'f_id', 'f_c'))).toEqual(['f_a', 'f_b', 'f_id', 'f_c'])
  })

  it('is a no-op for a self-drop', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(moveColumnToField(doc, 'v1', 'f_a', 'f_a')).toBe(doc)
  })
})

describe('composePageBody — YAML-unsafe cell values (#500 groundwork)', () => {
  it('quotes wikilink and bracket values so frontmatter reads back as the cell string', () => {
    const doc = makeDoc()
    const row = {
      id: 'r1',
      cells: { f_id: 'r1', f_a: 'Meeting 1', f_b: '[[Project X]]', f_c: '- agenda item' }
    } as unknown as Parameters<typeof composePageBody>[1]
    const page = composePageBody(doc, row, 'Body\n')
    expect(page).toContain('B: "[[Project X]]"')
    expect(page).toContain('C: "- agenda item"')
    const m = FRONTMATTER_BLOCK_RE.exec(page)
    const parsed = parseFrontmatterFields(m?.[1] ?? '')
    expect(parsed.b).toBe('[[Project X]]')
    expect(parsed.c).toBe('- agenda item')
    // The record-page round-trip itself reads through template-files
    // parseFrontmatter (first-colon split + quote strip); it must agree.
    const page2 = parseFrontmatter(page)
    expect(page2.data.B).toBe('[[Project X]]')
    expect(page2.data.C).toBe('- agenda item')
    expect(page2.body).toBe('Body\n')
  })
})

describe('setFieldOptionsSource (#500)', () => {
  it('sets, replaces, and clears a select field options source', () => {
    const doc = makeDoc()
    const withSource = setFieldOptionsSource(doc, 'f_b', { kind: 'folder', path: 'inbox/projects' })
    expect(withSource.fields.find((f) => f.id === 'f_b')?.optionsSource).toEqual({
      kind: 'folder',
      path: 'inbox/projects'
    })
    const swapped = setFieldOptionsSource(withSource, 'f_b', { kind: 'tag', tag: 'project' })
    expect(swapped.fields.find((f) => f.id === 'f_b')?.optionsSource).toEqual({
      kind: 'tag',
      tag: 'project'
    })
    const cleared = setFieldOptionsSource(swapped, 'f_b', null)
    expect('optionsSource' in (cleared.fields.find((f) => f.id === 'f_b') ?? {})).toBe(false)
  })
})
