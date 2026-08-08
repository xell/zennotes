// Context-aware completion for the workflow editor.
//
// The feature shipped as a blank textarea over a language nobody had seen, and
// the question that came back was "how do I know what to write here?". A
// reference page answers that once; completion answers it on every keystroke,
// at the exact position where the answer is needed. That is what this module is
// for.
//
// Two properties make it worth keeping pure:
//
//   1. Everything is derived from `NODE_DEFS`. Which verbs exist, which may open
//      a pipeline, which end one, what each parameter is called and what kind of
//      value it wants: all of it is read from the registry, so a node added
//      tomorrow is completable the day it lands and nobody has to remember this
//      file exists. The one thing not derivable is the vault's own vocabulary
//      (its tags, fields, paths), which the caller passes in.
//   2. No DOM and no store, so every position in the grammar is a unit test
//      rather than a thing you have to click to check.
//
// The result carries the range it replaces (`from`/`to`) rather than a bare list
// of strings, because the caller has to splice it into the document and only
// this module knows where the token under the caret started.
//
// Two rules make this behave like completion in an editor rather than a panel
// that happens to be attached to a caret:
//
//   * Input drives it. With nothing typed, the answer is nothing, unless the
//     caller says the user ASKED (`explicit`, i.e. Ctrl+Space). A list of every
//     source verb appearing the moment the caret lands on a blank line is noise
//     with a keyboard trap in it, which is exactly how this shipped and exactly
//     what was reported.
//   * With something typed, this module filters and ranks it, and says so by
//     returning the matched range on each item. Filtering here rather than in
//     the view is what makes the ranking testable, and what keeps every caller
//     (a textarea today, an editor extension tomorrow) showing the same list in
//     the same order.

import { COMPARE_OPS, NODE_DEFS, RENDER_STYLES, nodeDef } from './nodes'
import type { CompareOp, NodeDef, ParamType, RenderStyle } from './nodes'
import { WORKFLOW_EVENTS, WORKFLOW_STATUSES } from './parse'
import type { WorkflowEvent, WorkflowStatus } from './types'

/* -------------------------------------------------------------------------- */
/*  Shape                                                                     */
/* -------------------------------------------------------------------------- */

export type SuggestionKind = 'verb' | 'wire' | 'tag' | 'field' | 'path' | 'value' | 'frontmatter'

/** Where `label` matched what the user typed, as indices into `label`. */
export interface MatchRange {
  start: number
  end: number
}

export interface Suggestion {
  /** Text to splice into the document over `from`..`to`. */
  insert: string
  /** Shown in the list. Usually `insert` without its quoting. */
  label: string
  /** Right-hand hint: a parameter signature, or a short description. */
  detail: string
  kind: SuggestionKind
  /**
   * The part of `label` the typed prefix matched, for the view to mark.
   *
   * Absent when nothing was typed (an explicit request over an empty prefix),
   * because there is no match to point at and a highlight covering the whole
   * label would say the opposite of what it means.
   */
  match?: MatchRange
  /**
   * `field op value`: how this verb is written, for the docs pane.
   *
   * Verbs only, and absent for a verb that takes no arguments: an empty
   * signature line under a title is a row of nothing.
   */
  signature?: string
  /** What the verb does, straight from `NodeDef`. Verbs only. */
  description?: string
  /** A line that would parse, straight from `NodeDef`. Verbs only. */
  example?: string
}

export interface SuggestContext {
  text: string
  offset: number
  /**
   * The user asked for completions (Ctrl+Space), rather than the caller looking
   * again because something changed.
   *
   * This is the whole difference between a popup that helps and one that gets in
   * the way. Without it, an empty prefix returns nothing: the caret arriving
   * somewhere is not a question. With it, an empty prefix returns everything
   * that could go there, which is what "what can I write here?" deserves.
   */
  explicit?: boolean
  /** Wire names already defined in this workflow. */
  wires?: string[]
  /** Tags in the vault, with or without a leading `#`. */
  tags?: string[]
  /** Frontmatter field names seen in the vault. */
  fields?: string[]
  /** Note paths, vault-relative. Folders are derived from these. */
  paths?: string[]
}

export interface SuggestResult {
  /** Start of the range the completion replaces. */
  from: number
  /** End of that range. Equal to `from` when the caret is not inside a token. */
  to: number
  items: Suggestion[]
}

/* -------------------------------------------------------------------------- */
/*  Vocabulary that is not in the registry                                    */
/* -------------------------------------------------------------------------- */

export interface NamedHint {
  name: string
  detail: string
}

/**
 * The fields every note has whether or not its author wrote any frontmatter.
 *
 * This mirrors `fieldValue` in `./engine`, which is private to that module.
 * Keep the two in step: a name here that the engine does not know completes to
 * an expression that silently matches nothing. `suggest.test.ts` pins them
 * together through `renderNotes`, which reads the same vocabulary.
 */
export const ENGINE_FIELDS: readonly NamedHint[] = [
  { name: 'title', detail: 'the note title' },
  { name: 'path', detail: 'the vault-relative path' },
  { name: 'folder', detail: 'the folder the note is in' },
  { name: 'created', detail: 'when the note was created' },
  { name: 'updated', detail: 'when the note last changed' }
]

/**
 * Exhaustive by type, so adding a comparison operator to the registry fails to
 * compile until someone writes down what it means. Same for render styles below.
 */
export const COMPARE_OP_HINTS: Record<CompareOp, string> = {
  '=': 'equal to',
  '!=': 'not equal to',
  '>': 'greater than',
  '>=': 'greater than or equal to',
  '<': 'less than',
  '<=': 'less than or equal to',
  contains: 'contains this text',
  matches: 'matches this pattern'
}

export const RENDER_STYLE_HINTS: Record<RenderStyle, string> = {
  table: 'a table, one row per note',
  list: 'a bullet list of titles',
  count: 'just the number of notes',
  links: 'a bullet list of wikilinks'
}

const DIRECTION_HINTS: readonly NamedHint[] = [
  { name: 'asc', detail: 'smallest first' },
  { name: 'desc', detail: 'largest first' }
]

/** Round numbers people actually reach for. The grammar accepts any `<n><dhwm>`. */
const DURATION_HINTS: readonly NamedHint[] = [
  { name: '24h', detail: 'the last day' },
  { name: '7d', detail: 'the last week' },
  { name: '2w', detail: 'the last fortnight' },
  { name: '30d', detail: 'the last month' }
]

/**
 * The frontmatter keys the format owns, in the order they read best.
 *
 * `CONSUMED_KEYS` in `./parse` is the source of truth for WHICH keys exist; this
 * adds the order and the explanation. `suggest.test.ts` asserts the two agree,
 * so a key added to the parser cannot ship without a hint here. Exported because
 * a reference panel wants the same list with the same words.
 */
export const FRONTMATTER_KEYS: readonly NamedHint[] = [
  { name: 'name', detail: 'what this workflow is called' },
  { name: 'description', detail: 'one line about what it does' },
  { name: 'status', detail: 'draft (saved but inert) or active' },
  { name: 'trigger', detail: 'when it runs' },
  { name: 'key', detail: 'keybinding, e.g. <leader>wr' }
]

/** Keyed by the event union, so a new event fails to compile until it is
 *  explained. The list below is built from `WORKFLOW_EVENTS`, so it also cannot
 *  drift out of order. */
const EVENT_HINTS: Record<WorkflowEvent, string> = {
  'note-created': 'when a note is created',
  'note-saved': 'when a note is saved',
  'note-moved': 'when a note changes folder',
  'tag-added': 'when a tag is added to a note'
}

/** `manual`, one entry per known event, and a cron line to edit. */
const TRIGGER_VALUES: readonly NamedHint[] = [
  { name: 'manual', detail: 'only when you run it' },
  ...WORKFLOW_EVENTS.map((event) => ({ name: `on ${event}`, detail: EVENT_HINTS[event] })),
  { name: 'schedule 0 9 * * *', detail: 'on a cron schedule' }
]

/** Keyed by the status union, so a third state cannot ship unexplained. */
const STATUS_HINTS: Record<WorkflowStatus, string> = {
  draft: 'saved, but cannot run or be triggered',
  active: 'runnable, and fires on its trigger'
}

const STATUS_VALUES: readonly NamedHint[] = WORKFLOW_STATUSES.map((status) => ({
  name: status,
  detail: STATUS_HINTS[status]
}))

/** The frontmatter keys whose values are a closed set worth offering. */
const VALUE_VOCABULARIES: Record<string, readonly NamedHint[]> = {
  trigger: TRIGGER_VALUES,
  status: STATUS_VALUES
}

/* -------------------------------------------------------------------------- */
/*  Signatures                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `where` -> `field op value`, `sort` -> `field [direction]`.
 *
 * Optional params are bracketed because that is the one thing a user cannot
 * guess from an example: `sort finished` is legal and `where rating` is not.
 */
export function paramSignature(def: NodeDef): string {
  return def.params.map((spec) => (spec.required ? spec.name : `[${spec.name}]`)).join(' ')
}

/**
 * The one-line hint beside a verb in the list: what the step IS.
 *
 * This used to be the signature, falling back to the title for a verb that takes
 * no arguments, and that mixture is what made the column unreadable: `all` said
 * "All notes" while `folder` said "folder", so the same column answered a
 * different question on every row and one of those answers was the parameter
 * name read back. The signature has a home of its own now (`Suggestion.signature`,
 * shown in the docs beside the list), which frees this column to mean one thing.
 */
export function verbDetail(def: NodeDef): string {
  return def.title
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What could go at `ctx.offset`, and which range it replaces.
 *
 * Never throws and never guesses: a position with nothing sensible to offer
 * returns an empty list at an empty range, which the caller can pass straight to
 * an editor without special-casing. An empty list is also the signal to CLOSE a
 * popup rather than to draw an empty box, which is why nothing here ever falls
 * back to "everything" when the prefix matches nothing.
 */
export function suggestAt(ctx: SuggestContext): SuggestResult {
  const text = ctx.text
  const offset = clamp(ctx.offset, 0, text.length)
  const line = lineAt(text, offset)

  // On a fence there is nothing to complete, and offering a key would insert it
  // outside the frontmatter.
  if (line.text.trim() === '---') return empty(offset)

  const front = frontmatterInterior(text)
  const raw =
    front && offset >= front.start && offset <= front.end
      ? suggestInFrontmatter(line, offset)
      : suggestInBody(ctx, line, offset)

  // Every position decides WHAT could go there; one place decides how much of it
  // the user has earned the right to see. Keeping that in a single pass is what
  // makes "no prefix, no popup" true everywhere rather than in the branches
  // somebody remembered.
  return refine(raw, text, offset, ctx.explicit === true)
}

/* -------------------------------------------------------------------------- */
/*  Filtering and ranking                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the user has typed for this completion: the part of the replaced range
 * that is BEHIND the caret.
 *
 * Text ahead of the caret is not a prefix. Typing `fol` in front of an existing
 * `der inbox` is a request for things starting `fol`, and matching against
 * `folder` (the whole range) would rank the word already on screen against
 * itself.
 */
function typedPrefix(text: string, from: number, offset: number): string {
  // A path completes to `"inbox/a.md"` but is typed as `"inb`, so the opening
  // quote is punctuation here, not the first letter of anything.
  return text.slice(Math.min(from, offset), offset).replace(/^["']/, '')
}

function refine(
  result: SuggestResult,
  text: string,
  offset: number,
  explicit: boolean
): SuggestResult {
  if (result.items.length === 0) return result
  const needle = typedPrefix(text, result.from, offset)
  if (needle === '') {
    // The curated order (wires before verbs, engine fields before frontmatter
    // ones) is the answer to "what can I write here", so it is handed back
    // untouched rather than sorted into an alphabet nobody asked for.
    return explicit ? result : { from: result.from, to: result.to, items: [] }
  }
  return { from: result.from, to: result.to, items: rank(result.items, needle) }
}

/** A scored candidate. `start` is where the needle sits in the label. */
interface Ranked {
  item: Suggestion
  start: number
}

/**
 * Case-insensitive substring match, ranked the way editors rank: what you are
 * typing the START of comes before what merely contains it.
 *
 * Substring rather than fuzzy on purpose. The vocabulary is small and every word
 * in it is short, so fuzzy matching buys almost nothing and costs the one thing
 * that matters here: being able to look at a list and know why each row is in
 * it. The comparator is total (position, then length, then the label itself), so
 * two runs over the same input can never disagree about the order.
 */
function rank(items: readonly Suggestion[], needle: string): Suggestion[] {
  const lowered = needle.toLowerCase()
  const matched: Ranked[] = []
  for (const item of items) {
    const start = item.label.toLowerCase().indexOf(lowered)
    if (start === -1) continue
    matched.push({ item, start })
  }
  matched.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    if (left.item.label.length !== right.item.label.length) {
      return left.item.label.length - right.item.label.length
    }
    // Not `localeCompare`: the order has to be the same on every machine, and
    // these are ASCII identifiers.
    if (left.item.label === right.item.label) return 0
    return left.item.label < right.item.label ? -1 : 1
  })
  return matched.map(({ item, start }) => ({
    ...item,
    match: { start, end: start + needle.length }
  }))
}

/* -------------------------------------------------------------------------- */
/*  Frontmatter                                                               */
/* -------------------------------------------------------------------------- */

function suggestInFrontmatter(line: Span, offset: number): SuggestResult {
  const colon = line.text.indexOf(':')
  const keyStart = line.start + indent(line.text)

  // No colon yet, or the caret is still inside the key: complete the key itself.
  if (colon === -1 || offset <= line.start + colon) {
    const items = FRONTMATTER_KEYS.map((hint) => ({
      // With a colon already on the line the user is retyping the key, so
      // inserting another one would produce `name: : manual`.
      insert: colon === -1 ? `${hint.name}: ` : hint.name,
      label: hint.name,
      detail: hint.detail,
      kind: 'frontmatter' as const
    }))
    return { from: keyStart, to: colon === -1 ? line.end : line.start + colon, items }
  }

  // Only `trigger` and `status` have a closed vocabulary. A name or a
  // description is prose and a keybinding is personal, so guessing at those
  // would be noise.
  const values = VALUE_VOCABULARIES[line.text.slice(0, colon).trim()]
  if (values === undefined) return empty(offset)

  const after = line.text.slice(colon + 1)
  const valueStart = line.start + colon + 1 + (after.length - after.trimStart().length)
  const items = values.map((hint) => ({
    insert: hint.name,
    label: hint.name,
    detail: hint.detail,
    kind: 'value' as const
  }))
  // The whole value is replaced rather than the token under the caret, because
  // `on note-saved` and `schedule 0 9 * * *` are several tokens long.
  return { from: Math.min(valueStart, offset), to: line.end, items }
}

/* -------------------------------------------------------------------------- */
/*  Statements                                                                */
/* -------------------------------------------------------------------------- */

/** A wire name and its `=`, anchored the same way `ASSIGN_RE` is in `./parse`. */
const ASSIGN_HEAD_RE = /^\s*[A-Za-z_][\w-]*\s*=(?!=)/

function suggestInBody(ctx: SuggestContext, line: Span, offset: number): SuggestResult {
  // `#` at the first non-space column is a comment, which is prose.
  if (line.text.trim().startsWith('#')) return empty(offset)

  const segments = splitSegments(line.text, line.start)
  let index = segments.findIndex((segment) => offset <= segment.end)
  if (index === -1) index = segments.length - 1
  const segment = segments[index]
  const isHead = index === 0
  const isLast = index === segments.length - 1

  let pipelineStart = segment.start
  if (isHead) {
    const assign = ASSIGN_HEAD_RE.exec(segment.text)
    if (assign) {
      const equals = segment.start + assign[0].length - 1
      // Left of the `=` the user is naming a wire, not calling a verb. Anything
      // offered there would be wrong by construction.
      if (offset <= equals) return empty(offset)
      pipelineStart = equals + 1
    }
  }

  const spans = scanSpans(ctx.text.slice(pipelineStart, segment.end), pipelineStart)
  const active = spans.find((span) => offset >= span.start && offset <= span.end) ?? null
  const position = active ? spans.indexOf(active) : spans.filter((s) => s.end < offset).length
  const from = active ? active.start : offset
  const to = active ? active.end : offset

  if (position === 0) {
    return { from, to, items: isHead ? headItems(ctx) : stepVerbItems(isLast) }
  }

  const def = spans.length > 0 ? nodeDef(spans[0].text) : null
  if (!def) return { from, to, items: [] }
  const spec = def.params[position - 1]
  // Past the last declared param, or on a `rest` param that already swallowed
  // the tokens before it. Either way the registry says nothing about this
  // position, and inventing something would be worse than staying quiet.
  if (!spec) return { from, to, items: [] }
  return { from, to, items: paramItems(spec.type, ctx) }
}

/**
 * The head of a pipeline: a wire this workflow already defines, or a source.
 *
 * Wires come first because they are the user's own words and there are few of
 * them, so a short list of names reads as "pick up where you left off" before
 * the longer list of verbs.
 */
function headItems(ctx: SuggestContext): Suggestion[] {
  return [...wireItems(ctx.wires), ...verbItems(NODE_DEFS.filter((def) => def.source))]
}

/**
 * After a `|`: never a source (it would throw away everything upstream), and
 * never a terminal verb unless this is the last step (nothing may follow one).
 */
function stepVerbItems(isLast: boolean): Suggestion[] {
  return verbItems(NODE_DEFS.filter((def) => !def.source && (isLast || !def.terminal)))
}

/**
 * A verb, with everything the registry knows about it attached.
 *
 * The docs travel WITH the suggestion rather than being looked up again by the
 * view, because the view has a selected index, not a `NodeDef`, and a second
 * lookup keyed on a label is a second chance to show the wrong step's help.
 */
function verbItems(defs: readonly NodeDef[]): Suggestion[] {
  return defs.map((def) => {
    const signature = paramSignature(def)
    return {
      insert: def.kind,
      label: def.kind,
      detail: verbDetail(def),
      kind: 'verb' as const,
      // Omitted rather than empty for a verb that takes nothing: the docs pane
      // draws a row per field it is given, and `archive` has no signature to
      // give a row to.
      ...(signature === '' ? {} : { signature }),
      description: def.description,
      example: def.example
    }
  })
}

/* -------------------------------------------------------------------------- */
/*  Parameters                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Complete by declared param type. No `default` on purpose: a new `ParamType`
 * must fail to compile here until someone decides what it completes to.
 */
function paramItems(type: ParamType, ctx: SuggestContext): Suggestion[] {
  switch (type) {
    case 'tag':
      return tagItems(ctx.tags)
    case 'field':
      return fieldItems(ctx.fields)
    case 'wire':
      return wireItems(ctx.wires)
    case 'path':
      return pathItems(ctx.paths)
    case 'folder':
      return folderItems(ctx.paths)
    case 'compare-op':
      return COMPARE_OPS.map((op) => value(op, COMPARE_OP_HINTS[op]))
    case 'direction':
      return DIRECTION_HINTS.map((hint) => value(hint.name, hint.detail))
    case 'render-style':
      return RENDER_STYLES.map((style) => value(style, RENDER_STYLE_HINTS[style]))
    case 'duration':
      return DURATION_HINTS.map((hint) => value(hint.name, hint.detail))
    // Free text, a number, a glob, a heading, a template name, another
    // workflow's id: no closed vocabulary the registry can hand us. `rest` in
    // particular is where `render table <columns>` lives, which would be worth
    // completing; the fix is a param type for it in the registry rather than a
    // name-based special case here.
    case 'string':
    case 'number':
    case 'glob':
    case 'heading':
    case 'template':
    case 'workflow':
    case 'rest':
      return []
  }
}

function value(text: string, detail: string): Suggestion {
  return { insert: text, label: text, detail, kind: 'value' }
}

function wireItems(wires: string[] | undefined): Suggestion[] {
  return unique(wires).map((wire) => ({
    insert: wire,
    label: wire,
    detail: 'wire',
    kind: 'wire' as const
  }))
}

/** Tags are written with a `#` in the grammar, so they are offered that way
 *  whether the caller stores them with one or without. */
function tagItems(tags: string[] | undefined): Suggestion[] {
  const names = unique(unique(tags).map((tag) => tag.replace(/^#+/, ''))).filter(Boolean)
  return names.map((name) => ({
    insert: `#${name}`,
    label: `#${name}`,
    detail: 'tag',
    kind: 'tag' as const
  }))
}

/** The engine's own fields first: they work on every note, where a frontmatter
 *  field only works on the notes that happen to carry it. */
function fieldItems(fields: string[] | undefined): Suggestion[] {
  const builtin = new Set(ENGINE_FIELDS.map((field) => field.name))
  const items: Suggestion[] = ENGINE_FIELDS.map((field) => ({
    insert: field.name,
    label: field.name,
    detail: field.detail,
    kind: 'field' as const
  }))
  for (const field of unique(fields)) {
    if (builtin.has(field)) continue
    items.push({ insert: field, label: field, detail: 'frontmatter field', kind: 'field' })
  }
  return items
}

function pathItems(paths: string[] | undefined): Suggestion[] {
  return unique(paths).map((path) => ({
    // Always quoted, matching what the serializer writes for a path param, so a
    // completed line survives a canvas save without churning.
    insert: quote(path),
    label: path,
    detail: 'note',
    kind: 'path' as const
  }))
}

/**
 * Folders are derived from the note paths rather than passed in: the caller
 * already knows every path, and asking it for a second list is one more thing
 * to keep in sync. Ancestors are included, so `inbox/projects/a.md` also offers
 * `inbox`.
 */
function folderItems(paths: string[] | undefined): Suggestion[] {
  const folders = new Set<string>()
  for (const path of unique(paths)) {
    const cut = path.lastIndexOf('/')
    if (cut <= 0) continue
    const parts = path.slice(0, cut).split('/')
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders].sort().map((folder) => ({
    insert: quoteIfNeeded(folder),
    label: folder,
    detail: 'folder',
    kind: 'path' as const
  }))
}

/* -------------------------------------------------------------------------- */
/*  Text helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A slice of the document with the offsets it came from. */
interface Span {
  text: string
  start: number
  end: number
}

function empty(offset: number): SuggestResult {
  return { from: offset, to: offset, items: [] }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.max(low, Math.min(value, high))
}

function unique(values: string[] | undefined): string[] {
  if (!values) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function indent(text: string): number {
  const match = /^\s*/.exec(text)
  return match ? match[0].length : 0
}

/** Quote choice mirrors `./serialize`: the grammar has no escape character, so
 *  the quote picked is the one the value does not already contain. */
function quote(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`
}

function quoteIfNeeded(value: string): string {
  return /[\s"']/.test(value) ? quote(value) : value
}

function lineAt(text: string, offset: number): Span {
  const start = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const newline = text.indexOf('\n', offset)
  let end = newline === -1 ? text.length : newline
  // Drop a CRLF's carriage return, unless the caret is sitting on it: the range
  // we return must always contain the caret.
  if (end > start && end - 1 >= offset && text[end - 1] === '\r') end -= 1
  return { text: text.slice(start, end), start, end }
}

/**
 * The frontmatter's interior, or null when the file has none.
 *
 * A missing closing fence means the user is still typing the header, so the
 * rest of the file counts as frontmatter: completing keys while the block is
 * half-written is exactly when the help is needed.
 */
function frontmatterInterior(text: string): { start: number; end: number } | null {
  const open = /^---\r?\n/.exec(text)
  if (!open) return null
  const start = open[0].length
  // Built per call: a module-level /g regex carries `lastIndex` between calls,
  // and this runs on every keystroke.
  const close = /^---\r?$/gm
  close.lastIndex = start
  const found = close.exec(text)
  return { start, end: found ? found.index : text.length }
}

/**
 * Split a line on `|`, ignoring pipes inside quotes, keeping offsets.
 *
 * Quote awareness matters for the same reason it does in the parser: a markdown
 * table row is a reasonable thing to `append "| a | b |"`.
 */
function splitSegments(line: string, base: number): Span[] {
  const segments: Span[] = []
  let start = 0
  let quoteChar: string | null = null

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoteChar) {
      if (char === quoteChar) quoteChar = null
      continue
    }
    if (char === '"' || char === "'") {
      quoteChar = char
      continue
    }
    if (char !== '|') continue
    segments.push({ text: line.slice(start, i), start: base + start, end: base + i })
    start = i + 1
  }

  segments.push({ text: line.slice(start), start: base + start, end: base + line.length })
  return segments
}

/**
 * Tokenize one pipeline segment, keeping offsets.
 *
 * The rules match `scanTokens` in `./parse` (whitespace splits, quotes are kept
 * in the token) because a completion has to agree with the parser about where a
 * token begins. That scanner is private and discards offsets, which a completer
 * cannot work without, hence the second implementation rather than an import.
 */
function scanSpans(text: string, base: number): Span[] {
  const spans: Span[] = []
  let current = ''
  let start = 0
  let quoteChar: string | null = null

  const push = (end: number): void => {
    if (!current) return
    spans.push({ text: current, start: base + start, end: base + end })
    current = ''
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoteChar) {
      current += char
      if (char === quoteChar) quoteChar = null
      continue
    }
    if (/\s/.test(char)) {
      push(i)
      continue
    }
    if (!current) start = i
    if (char === '"' || char === "'") quoteChar = char
    current += char
  }

  push(text.length)
  return spans
}
