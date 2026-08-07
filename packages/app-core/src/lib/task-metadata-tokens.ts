/**
 * The task-metadata tokens both renderers highlight: priority (`!high`), due
 * date (`due:YYYY-MM-DD`) and `@fields` (`@waiting`, `@key:value`).
 *
 * One scanner, two renderers — the CodeMirror decorations in
 * `cm-task-metadata.ts` and the remark plugin behind the reading preview — so
 * a token can never be a chip in the editor and plain text in preview (#479).
 * Token shapes mirror the parser in `@shared/tasks`.
 */

export type TaskMetaKind = 'priority' | 'due' | 'field'

export interface TaskMetaToken {
  kind: TaskMetaKind
  /** Offset of the token within the scanned text. */
  start: number
  end: number
  /** The matched token text, e.g. `!high` or `due:2026-07-20`. */
  text: string
  /** Only for `priority`. */
  level?: 'high' | 'med' | 'low'
  /** Only for `due` — the ISO date, without the `due:` prefix. */
  date?: string
}

// Anchored on `(^|\s)` so `!`, `due:` or `@` glued to a preceding word don't match.
const PRIORITY_RE = /(^|\s)(!(?:high|medium|med|low|h|m|l))\b/gi
// Only a valid ISO date is treated as a due date (matching `isValidIsoDate`).
const DUE_RE = /(^|\s)(due:\s*(\d{4}-\d{2}-\d{2}))\b/gi
const FIELD_RE = /(^|\s)(@waiting\b|@[a-z][a-z0-9_-]*:[\p{L}\d][\p{L}\d/_-]*)/giu

export function priorityLevel(token: string): 'high' | 'med' | 'low' {
  const word = token.slice(1).toLowerCase() // drop the leading `!`
  if (word === 'high' || word === 'h') return 'high'
  if (word === 'low' || word === 'l') return 'low'
  return 'med'
}

/** Every metadata token in `text`, ordered by position. The token types never
 *  overlap on a line, so sorting by start is enough to keep them in sequence. */
export function scanTaskMetadata(text: string): TaskMetaToken[] {
  const tokens: TaskMetaToken[] = []
  let m: RegExpExecArray | null

  PRIORITY_RE.lastIndex = 0
  while ((m = PRIORITY_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    tokens.push({
      kind: 'priority',
      start,
      end: start + m[2].length,
      text: m[2],
      level: priorityLevel(m[2])
    })
  }
  DUE_RE.lastIndex = 0
  while ((m = DUE_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    tokens.push({ kind: 'due', start, end: start + m[2].length, text: m[2], date: m[3] })
  }
  FIELD_RE.lastIndex = 0
  while ((m = FIELD_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    tokens.push({ kind: 'field', start, end: start + m[2].length, text: m[2] })
  }

  tokens.sort((a, b) => a.start - b.start)
  return tokens
}

/** Local `YYYY-MM-DD` for today, matching how the parser compares due dates. */
export function todayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
