// Reading and minimal editing of a note's leading `---` frontmatter block.
//
// Reading: `parseFrontmatterFields` is the one "just enough YAML" parser this
// app has — scalars, inline arrays and block lists — and `frontmatterTags`
// applies it to the `tags` field. Both the sidebar's live extraction and the
// main process's indexing go through them, so a note's tags can't depend on
// which one looked. (The MCP server and the Go server keep hand-synced copies;
// they cannot import this package.)
//
// Editing: minimal frontmatter editing for whole-note "file tasks" (TaskNotes-style).
// Adds/updates/removes flat `key: value` scalars in a leading `---` block,
// creating the block if absent, and leaves every other line — including block
// lists like `tags:\n  - task` — byte-identical. This is deliberately not a
// full YAML writer; it only touches the exact keys it is asked to.
import type { TaskPriority } from './tasks'

/** A leading `---` block, tolerant of CRLF line endings. */
export const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Strip one layer of matching quotes, and surrounding whitespace. */
export function unquote(v: string): string {
  const trimmed = v.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Parse a leading frontmatter block into flat fields, handling scalars, inline
 *  arrays (`tags: [a, b]`) and block lists (`tags:` then `  - a`). Keys are
 *  lower-cased; values are a string, or string[] for a list. Best-effort and
 *  never throws — just enough YAML for note frontmatter, not a full parser. */
export function parseFrontmatterFields(block: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const item = rawLine.match(/^\s*-\s+(.*)$/)
    if (listKey && /^\s/.test(rawLine) && item) {
      const arr = data[listKey]
      if (Array.isArray(arr)) arr.push(unquote(item[1]))
      continue
    }
    const kv = rawLine.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      listKey = null
      continue
    }
    const key = kv[1].toLowerCase()
    const rest = kv[2].trim()
    if (rest === '') {
      // Bare key: a block list may follow on indented `- item` lines.
      listKey = key
      data[key] = []
      continue
    }
    listKey = null
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s.length > 0)
    } else {
      data[key] = unquote(rest)
    }
  }
  return data
}

/**
 * The note's frontmatter `tags`, normalized to the shape an inline `#tag`
 * would have: no leading `#`, no quotes, one tag per entry. A bare scalar is
 * split on commas and whitespace — `tags: daily, work` is two tags in every
 * other editor that reads this field, and a tag can contain neither character,
 * so there is nothing to lose by splitting. (#444)
 */
export function frontmatterTags(body: string): string[] {
  const m = FRONTMATTER_BLOCK_RE.exec(body)
  if (!m) return []
  const value = parseFrontmatterFields(m[1] ?? '').tags
  if (value == null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const entry of raw) {
    for (const part of unquote(entry).split(/[,\s]+/)) {
      const tag = part.replace(/^#/, '').trim()
      if (tag) out.push(tag)
    }
  }
  return out
}

/**
 * Quote a scalar for a frontmatter `key: value` line whenever a YAML reader
 * could misread it bare. Beyond structure characters and edge whitespace, a
 * leading indicator turns a plain scalar into structure: `[[Note]]` reads as
 * a nested array (our own `parseFrontmatterFields` takes anything [bracketed]
 * as an inline list), `- x` as a sequence entry, `>` and `|` as block
 * scalars, `&` `*` `!` `%` as anchor, alias, tag, directive. Mid-value
 * brackets and commas stay bare on purpose: they are valid in block-context
 * plain scalars, and over-quoting would churn every existing record page on
 * its next mirror. JSON.stringify yields a valid double-quoted YAML scalar.
 */
export function yamlValue(value: string): string {
  if (
    /[:#"'\n]/.test(value) ||
    /^[[\]{},>|&*!%@`]/.test(value) ||
    /^[-?](\s|$)/.test(value) ||
    value.trim() !== value ||
    value === ''
  ) {
    return JSON.stringify(value)
  }
  return value
}

/**
 * Set (or, with a `null` value, remove) scalar frontmatter fields in `body`,
 * preserving key order and every other line. Creates a frontmatter block from
 * the non-null updates when the note has none. Keys match case-insensitively
 * but are written with the casing given in `updates`.
 */
export function updateFrontmatterFields(
  body: string,
  updates: Record<string, string | null>
): string {
  const entries = Object.entries(updates)
  if (entries.length === 0) return body

  const norm = body.replace(/\r\n/g, '\n')
  const m = norm.match(/^---\n([\s\S]*?)\n---\n?/)
  const remaining = new Map(entries.map(([k, v]) => [k.toLowerCase(), { key: k, value: v }]))

  if (!m) {
    const lines = ['---']
    for (const { key, value } of remaining.values()) {
      if (value != null) lines.push(`${key}: ${yamlValue(value)}`)
    }
    if (lines.length === 1) return body // nothing to add
    lines.push('---', '')
    return lines.join('\n') + norm
  }

  const out: string[] = []
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*([A-Za-z0-9_][\w-]*)\s*:/)
    if (km) {
      const lk = km[1].toLowerCase()
      const upd = remaining.get(lk)
      if (upd) {
        remaining.delete(lk)
        if (upd.value != null) out.push(`${upd.key}: ${yamlValue(upd.value)}`)
        continue // a null value drops the line
      }
    }
    out.push(line)
  }
  for (const { key, value } of remaining.values()) {
    if (value != null) out.push(`${key}: ${yamlValue(value)}`)
  }
  return `---\n${out.join('\n')}\n---\n` + norm.slice(m[0].length)
}

/** Flip a file-task's completion in its frontmatter: `status: done` +
 *  `completedDate` when checking, back to `open` (clearing `completedDate`)
 *  when unchecking. `todayIso` is the local YYYY-MM-DD to stamp. */
export function setTaskFileStatus(body: string, done: boolean, todayIso: string): string {
  return updateFrontmatterFields(body, {
    status: done ? 'done' : 'open',
    completedDate: done ? todayIso : null
  })
}

/** Flip a file-task's cancelled state in its frontmatter: `status: cancelled`
 *  when cancelling, back to `open` when un-cancelling. Cancelled is a terminal
 *  state distinct from done, so no `completedDate` is stamped. (#450) */
export function setTaskFileCancelled(body: string, cancelled: boolean): string {
  return updateFrontmatterFields(body, {
    status: cancelled ? 'cancelled' : 'open',
    completedDate: null
  })
}

/** Flip a file-task's in-progress state in its frontmatter: `status: in-progress`
 *  when starting, back to `open` when un-starting. `in-progress` is TaskNotes'
 *  spelling, so a vault shared with it round-trips. Still open work, so nothing
 *  is stamped as completed. (#512) */
export function setTaskFileInProgress(body: string, inProgress: boolean): string {
  return updateFrontmatterFields(body, {
    status: inProgress ? 'in-progress' : 'open',
    completedDate: null
  })
}

/** ZenNotes priority -> the value written to a task file's frontmatter, using
 *  TaskNotes' vocabulary (`high` / `normal` / `low`) for interop. `null` clears. */
export function taskFilePriorityValue(priority: TaskPriority | null | undefined): string | null {
  if (priority === 'high') return 'high'
  if (priority === 'med') return 'normal'
  if (priority === 'low') return 'low'
  return null
}

export interface ComposeTaskFileInput {
  title: string
  /** Defaults to `open`. */
  status?: string
  priority?: TaskPriority
  /** ISO YYYY-MM-DD. */
  due?: string
  /** ISO YYYY-MM-DD. */
  scheduled?: string
  /** Extra tags beyond the mandatory `task` tag. */
  tags?: string[]
  /** ISO timestamp for `dateCreated` (caller supplies the clock). */
  dateCreated?: string
  /** Free-form note body after the frontmatter. */
  body?: string
}

/** Build a new task-file `.md` (frontmatter + body) in the TaskNotes shape. The
 *  `task` tag is always present so the note is recognized as a task. */
export function composeTaskFile(input: ComposeTaskFileInput): string {
  const tags = [TASK_TAG, ...(input.tags ?? []).filter((t) => t && t !== TASK_TAG)]
  const lines = ['---', `title: ${yamlValue(input.title)}`, `status: ${input.status ?? 'open'}`]
  const priority = taskFilePriorityValue(input.priority)
  if (priority) lines.push(`priority: ${priority}`)
  if (input.due) lines.push(`due: ${input.due}`)
  if (input.scheduled) lines.push(`scheduled: ${input.scheduled}`)
  lines.push(`tags: [${tags.join(', ')}]`)
  if (input.dateCreated) lines.push(`dateCreated: ${input.dateCreated}`)
  lines.push('---', '')
  return `${lines.join('\n')}\n${(input.body ?? '').replace(/^\n+/, '')}`
}

// Kept local to avoid a cyclic import with tasks.ts; must equal TASK_FILE_TAG.
const TASK_TAG = 'task'
