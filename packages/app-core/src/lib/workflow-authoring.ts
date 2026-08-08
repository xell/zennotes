// Pure rules behind authoring a workflow from inside the app: what a new
// workflow starts as, which filename it lands under, whether unsaved text may
// be thrown away, and how a diagnostic's line maps onto the text the author is
// looking at.
//
// They live outside `WorkflowsView` because every one of them decides something
// that reaches the vault (what gets written, under which name, and whether a
// draft can be discarded), and that is exactly the kind of rule worth testing
// without mounting React.

import { parseFrontmatter } from '@shared/template-files'

/** Name a brand-new workflow opens with, before the author renames it. */
export const STARTER_WORKFLOW_NAME = 'New workflow'

/**
 * The text a new workflow starts as.
 *
 * Deliberately a WORKING workflow rather than an empty frame: it parses, it
 * validates, and it plans, so the graph is already on screen the moment the
 * editor opens. The shape of the format (frontmatter, a named wire, a terminal
 * statement that reads it) is learned by editing something that runs, which is
 * the whole reason a starter beats a blank file.
 */
export function starterWorkflowText(name: string = STARTER_WORKFLOW_NAME): string {
  return `---
name: ${name}
description: What this workflow does
status: draft
trigger: manual
---

# Where the notes come from, and where the result goes.
notes = all

notes | write-section "inbox/Overview.md" "Notes"
`
}

/**
 * Filename stem for a workflow name: `Reading log` -> `reading-log`.
 *
 * Same rules as `slugifyTemplateName` (both write a flat `.zennotes/` .md file
 * whose stem becomes the id), with its own fallback so a workflow that lost its
 * name reads as `workflow` rather than `template`.
 */
export function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workflow'
}

/**
 * `base`, or the first free `base-2`, `base-3`, ... .
 *
 * The stem IS the workflow id, so two workflows may never share one: a colliding
 * save would overwrite a file the author never opened. Taking the next free
 * suffix instead is the one behaviour here that cannot lose data.
 */
export function uniqueWorkflowSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  let n = 2
  let candidate = `${base}-${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${base}-${n}`
  }
  return candidate
}

export interface NewWorkflowDraft {
  name: string
  /** Stem the file will be written under, unless the author renames it first. */
  slug: string
  text: string
}

/**
 * A new workflow, named and slugged so the two agree.
 *
 * The slug is derived from the name on save, so the second new workflow in a
 * vault has to be *called* "New workflow 2": naming it "New workflow" and
 * silently filing it as `new-workflow-2.md` would make the list and the
 * filesystem disagree from the first keystroke.
 */
export function newWorkflowDraft(existingIds: Iterable<string>): NewWorkflowDraft {
  const base = slugifyWorkflowName(STARTER_WORKFLOW_NAME)
  const slug = uniqueWorkflowSlug(base, existingIds)
  const suffix = slug === base ? '' : ` ${slug.slice(base.length + 1)}`
  const name = `${STARTER_WORKFLOW_NAME}${suffix}`
  return { name, slug, text: starterWorkflowText(name) }
}

export interface TextRange {
  start: number
  end: number
}

/**
 * Character range covering the value of the `name:` line in the frontmatter, so
 * a new workflow can open with its name selected and be renamed by typing.
 *
 * Null when there is no name to select (no frontmatter, or a fence without a
 * `name:` line), which the caller reads as "just put the caret at the top".
 */
export function workflowNameRange(raw: string): TextRange | null {
  const lines = raw.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return null
  let offset = lines[0].length + 1
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    // The closing fence ends the frontmatter; a `name:` below it is body text.
    if (line.trim() === '---') return null
    const match = /^name:[ \t]*/.exec(line)
    if (match) {
      const start = offset + match[0].length
      // Trailing whitespace (including a `\r` from a CRLF file) is not part of
      // the name, and selecting it would leave it behind after a retype.
      const value = line.slice(match[0].length).replace(/\s+$/, '')
      return { start, end: start + value.length }
    }
    offset += line.length + 1
  }
  return null
}

/** CRLF and CR collapse to LF; a `<textarea>` only ever reports LF. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Has the draft diverged from what is on disk?
 *
 * Two normalizations, both to stop the editor asking questions nobody would
 * thank it for: line endings, because a `<textarea>` reports LF whatever the
 * file used, so a CRLF workflow would read as dirty the instant it opened; and
 * trailing newlines, because saving guarantees a final one, so a file that ends
 * without it would stay dirty forever after a save.
 */
export function isWorkflowDraftDirty(saved: string, draft: string): boolean {
  const trimEndNewlines = (text: string): string => normalizeNewlines(text).replace(/\n+$/, '')
  return trimEndNewlines(saved) !== trimEndNewlines(draft)
}

/**
 * File text for a draft: whatever was typed, plus the final newline every other
 * file in `.zennotes/` ends with. A workflow whose last line is a statement
 * would otherwise come back from disk without its line terminator.
 */
export function workflowFileText(draft: string): string {
  return draft.endsWith('\n') ? draft : `${draft}\n`
}

/**
 * How many lines of the file sit above the parser's body.
 *
 * Diagnostics count from 1 within the BODY (see `@shared/workflows/parse`), but
 * the editor shows the whole file, frontmatter included. Reporting "line 4"
 * while the eye lands on line 9 is the kind of small lie that makes people stop
 * reading diagnostics at all, so every line number gets this added to it.
 *
 * Derived from `parseFrontmatter` itself rather than a second copy of its
 * regex: the two must agree exactly or the offset is wrong by a line.
 */
export function bodyLineOffset(raw: string): number {
  const { body } = parseFrontmatter(raw)
  const head = raw.slice(0, raw.length - body.length)
  return head.length === 0 ? 0 : head.split('\n').length - 1
}

/**
 * Character range of a 1-based line, clamped to the text, so clicking a
 * diagnostic can select the line it is about.
 */
export function lineRange(text: string, line: number): TextRange {
  let start = 0
  for (let n = 1; n < line; n += 1) {
    const next = text.indexOf('\n', start)
    if (next === -1) return { start: text.length, end: text.length }
    start = next + 1
  }
  const next = text.indexOf('\n', start)
  return { start, end: next === -1 ? text.length : next }
}
