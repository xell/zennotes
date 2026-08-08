/**
 * Pure record-level operations on a DatabaseDoc, shared by every surface
 * that edits rows: the app's grid, and the `zn base` CLI commands (#556).
 * Doc-in, doc-out, no IO. These moved here from app-core's database-cells
 * (which re-exports them unchanged) so the CLI and future MCP tools import
 * the one implementation instead of growing copies.
 */
import { defaultGenId } from './database-csv'
import { yamlValue } from './frontmatter'
import type { DatabaseDoc, DbField, DbRow, SelectOption } from './databases'

export function fieldsById(doc: DatabaseDoc): Map<string, DbField> {
  return new Map(doc.fields.map((f) => [f.id, f]))
}

/** A record's display title: the first non-id field's value (fallback "Untitled"). */
export function recordTitle(doc: DatabaseDoc, row: DbRow): string {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const v = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
  return v || 'Untitled'
}

/**
 * Compose a record "page" note: the record's properties as flat YAML
 * frontmatter followed by `body` (the freeform page). The id field and the
 * title field are omitted — the title is the page's `# heading`, so repeating
 * it as a `Name:` property would be redundant. Empty values render as a blank
 * `key:` rather than `key: ""`.
 */
export function composePageBody(doc: DatabaseDoc, row: DbRow, body: string): string {
  const titleFieldId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id
  const lines = ['---']
  for (const f of doc.fields) {
    if (f.id === doc.idFieldId || f.id === titleFieldId) continue
    const v = row.cells[f.id] ?? ''
    lines.push(v ? `${f.name}: ${yamlValue(v)}` : `${f.name}:`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`
}

export function setCell(doc: DatabaseDoc, rowId: string, fieldId: string, value: string): DatabaseDoc {
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r))
  }
}

export function addRow(doc: DatabaseDoc): DatabaseDoc {
  const id = defaultGenId()
  const cells: Record<string, string> = {}
  for (const f of doc.fields) cells[f.id] = ''
  cells[doc.idFieldId] = id
  const row: DbRow = { id, cells }
  return { ...doc, rows: [...doc.rows, row] }
}

export function deleteRow(doc: DatabaseDoc, rowId: string): DatabaseDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) }
}

export function ensureSelectOption(doc: DatabaseDoc, fieldId: string, rawValue: string): DatabaseDoc {
  const value = rawValue.trim().replace(/,/g, ' ') // option values may not contain commas
  if (!value) return doc
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      if (f.id !== fieldId) return f
      const options = f.options ?? []
      if (options.some((o) => o.value === value)) return f
      const opt: SelectOption = { id: defaultGenId(), value }
      return { ...f, options: [...options, opt] }
    })
  }
}
