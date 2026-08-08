// Hand-placed node positions for the workflow canvas.
//
// Layout is COMPUTED (`layoutWorkflow`), and that is load-bearing: it is why the
// `.md` text and the canvas are lossless projections of each other, why a
// workflow file has no coordinates to diff, and why the two surfaces can never
// disagree about the shape of a graph. Dragging a node would normally end that,
// so what is stored here is not a layout but a set of OVERRIDES. Auto-layout
// stays the default and only the nodes someone actually moved get a coordinate,
// so a workflow nobody drags keeps a coordinate-free file and clearing the
// overrides returns a dragged one to exactly that state.
//
// Everything lives in one frontmatter key, which `Workflow.meta` already
// round-trips verbatim, so neither the parser nor the serializer has to learn
// this feature exists:
//
//     layout: 0:0=140,40 1:1=420,90
//
// Keys are node ids (`stepId(statement, step)` in `@shared/workflows/layout`)
// and values are integer pixels in flow coordinates. Integers on purpose: a
// pointer reports fractional positions, and a pixel of drift that rewrote the
// file would turn "I looked at my workflow" into "my workflow has uncommitted
// changes".
//
// Two total-function promises, because this text is user-editable and a canvas
// that can be broken by a typo in a file is worse than no canvas:
//
//   1. Reading NEVER throws and never rejects the whole line. A malformed entry
//      is skipped and its neighbours still apply.
//   2. An id naming a node that no longer exists (the text above it was edited)
//      is simply never looked up, so the node it used to describe falls back to
//      its computed position instead of appearing somewhere wrong. Writing
//      prunes those keys, so the file heals itself on the next drag.

import { parseFrontmatter } from '@shared/template-files'

/** The single frontmatter key every override is packed into. */
export const LAYOUT_META_KEY = 'layout'

export interface NodePosition {
  x: number
  y: number
}

/** Node id (`statement:step`) to its hand-placed position. */
export type LayoutOverrides = Map<string, NodePosition>

/**
 * One entry: `<id>=<x>,<y>`.
 *
 * The id is anything that survives the round-trip, i.e. no whitespace (the
 * entry separator) and no `=` (the field separator). Deliberately NOT
 * `\d+:\d+`: the id format belongs to `stepId`, and hardcoding its shape here
 * would mean a change there silently emptied everyone's saved positions.
 *
 * Coordinates accept a fraction so a hand-edited file still reads; they are
 * rounded on the way in, which is also what makes a parsed map comparable to a
 * freshly dragged one.
 */
const ENTRY_RE = /^([^\s=]+)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Overrides recorded in a workflow's frontmatter. Never throws, for any input.
 *
 * A repeated id takes its last value, matching `parseFrontmatter`'s own
 * last-one-wins rule for a repeated key, so the two halves of a hand-edited file
 * cannot disagree about which value counts.
 */
export function parseLayoutOverrides(meta: Record<string, string>): LayoutOverrides {
  const overrides: LayoutOverrides = new Map()
  // Annotated rather than inferred: `Record<string, string>` claims every key is
  // present, and the one key we care about is exactly the one that usually is not.
  const raw: string | undefined = meta[LAYOUT_META_KEY]
  if (raw === undefined) return overrides
  for (const entry of raw.split(/\s+/)) {
    if (entry === '') continue
    const match = ENTRY_RE.exec(entry)
    if (!match) continue
    const x = Number(match[2])
    const y = Number(match[3])
    // The regex already rules out `NaN` and `Infinity`; this is the belt to its
    // braces, so a future loosening of the pattern cannot put a non-number on
    // the canvas where it would render a node at `translate(NaN, NaN)`.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    overrides.set(match[1], { x: Math.round(x), y: Math.round(y) })
  }
  return overrides
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

/** `statement:step` split out for ordering. Null when the id is some other shape. */
function nodeIdOrder(id: string): [number, number] | null {
  const match = /^(\d+):(\d+)$/.exec(id)
  return match ? [Number(match[1]), Number(match[2])] : null
}

/**
 * Reading order of the file, so re-dragging one node rewrites one value instead
 * of reshuffling the whole line. Insertion order would be drag order, which
 * would churn the file for no reason at all; a plain string sort would put
 * `10:0` above `2:0` and make a long workflow's line unreadable.
 */
function compareNodeIds(a: string, b: string): number {
  const left = nodeIdOrder(a)
  const right = nodeIdOrder(b)
  if (left && right) return left[0] - right[0] || left[1] - right[1]
  // An id of some other shape (hand-written, or from a future id format) sorts
  // after the ones we understand, alphabetically among themselves.
  if (left) return -1
  if (right) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The frontmatter value for a set of overrides, or null when there is nothing
 * to record.
 *
 * Null rather than `''` because the caller's job is then unambiguous: omit the
 * key. An empty `layout:` line would be a coordinate-free file that still says
 * the word "layout", which is exactly the diff noise this design exists to
 * avoid.
 */
export function serializeLayoutOverrides(overrides: ReadonlyMap<string, NodePosition>): string | null {
  const entries: { id: string; text: string }[] = []
  for (const [id, position] of overrides) {
    // An id that cannot be read back would be silently dropped on the next load
    // and leave the node jumping home; better never to write it.
    if (id === '' || /[\s=]/.test(id)) continue
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue
    // `Math.round` is what makes a sub-pixel drag stop equal to what is already
    // in the file, which is what lets the caller skip the write entirely.
    entries.push({ id, text: `${id}=${Math.round(position.x)},${Math.round(position.y)}` })
  }
  if (entries.length === 0) return null
  entries.sort((a, b) => compareNodeIds(a.id, b.id))
  return entries.map((entry) => entry.text).join(' ')
}

/**
 * `meta` with the layout key set, or removed when there is nothing to record.
 *
 * Pure: the input record is never mutated, so a caller holding the parsed
 * workflow's own `meta` cannot have it changed underneath it.
 */
export function withLayoutOverrides(
  meta: Record<string, string>,
  overrides: ReadonlyMap<string, NodePosition>
): Record<string, string> {
  const next = { ...meta }
  const value = serializeLayoutOverrides(overrides)
  if (value === null) delete next[LAYOUT_META_KEY]
  else next[LAYOUT_META_KEY] = value
  return next
}

/**
 * Drop overrides for nodes that no longer exist.
 *
 * Editing the text above a dragged node renumbers or deletes its id. Those keys
 * are already inert on read (nothing looks them up), so this is purely about not
 * accumulating them: pruning at write time means a workflow that was rewritten
 * from scratch ends up with a clean file rather than a growing tail of
 * coordinates for statements nobody can see.
 */
export function pruneLayoutOverrides(
  overrides: ReadonlyMap<string, NodePosition>,
  liveIds: Iterable<string>
): LayoutOverrides {
  const live = new Set(liveIds)
  const next: LayoutOverrides = new Map()
  for (const [id, position] of overrides) {
    if (live.has(id)) next.set(id, position)
  }
  return next
}

/* -------------------------------------------------------------------------- */
/*  Raw file text                                                             */
/* -------------------------------------------------------------------------- */

/** Does this frontmatter line declare the layout key? Mirrors `parseFrontmatter`. */
function isLayoutLine(line: string): boolean {
  const colon = line.indexOf(':')
  return colon !== -1 && line.slice(0, colon).trim() === LAYOUT_META_KEY
}

/**
 * A workflow file with its layout key rewritten, and everything else byte for
 * byte as it was.
 *
 * Surgery on the raw text rather than `serializeWorkflow(withLayoutOverrides(…))`
 * on purpose. The serializer is canonical by design (it collapses the aligned
 * `books   = tag #book` a person typed into `books = tag #book`), which is
 * correct for a save the author asked for and completely wrong for a drag:
 * nudging a box must not reformat the file. Only the frontmatter line moves.
 *
 * A file with no frontmatter at all grows one, because the alternative is
 * accepting a drag and then losing it. Clearing overrides on such a file is a
 * no-op: there is no fence to write into and nothing to record in it.
 */
export function withLayoutOverridesText(
  raw: string,
  overrides: ReadonlyMap<string, NodePosition>
): string {
  const value = serializeLayoutOverrides(overrides)

  // The head is derived from `parseFrontmatter` rather than from a second copy
  // of its regex: if the two ever disagreed about where the fence ends, this
  // would write the key into the body.
  const { body } = parseFrontmatter(raw)
  const headLength = raw.length - body.length
  if (headLength === 0) {
    if (value === null) return raw
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    return `---${eol}${LAYOUT_META_KEY}: ${value}${eol}---${eol}${eol}${raw}`
  }

  const head = raw.slice(0, headLength)
  const rest = raw.slice(headLength)
  const lines = head.split('\n')

  // The fence closing the head. The frontmatter pattern is lazy, so the head
  // holds exactly two `---` lines; scanning from the end finds the closing one
  // without assuming whether the head ends in a newline.
  let closeIndex = -1
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (lines[i].trim() === '---') {
      closeIndex = i
      break
    }
  }
  // Unreachable for a head `parseFrontmatter` matched, and a bail-out rather
  // than a throw if it ever is reached: this runs on every drag.
  if (closeIndex === -1) return raw

  const existing = new Set<number>()
  let replaceAt = -1
  for (let i = 1; i < closeIndex; i += 1) {
    if (!isLayoutLine(lines[i])) continue
    existing.add(i)
    // Last one wins, matching `parseFrontmatter`, so the line being rewritten is
    // the line that was actually in effect.
    replaceAt = i
  }

  // CRLF is preserved by keeping the `\r` the split left on each line and giving
  // the new line the same ending as the fence it sits above.
  const eol = lines[closeIndex].endsWith('\r') ? '\r' : ''
  const written = value === null ? null : `${LAYOUT_META_KEY}: ${value}${eol}`

  const next: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (i === replaceAt) {
      // Rewritten where it already sat, so the key keeps its place in the file.
      if (written !== null) next.push(written)
      continue
    }
    if (existing.has(i)) continue // a duplicate key that was never in effect
    if (i === closeIndex && replaceAt === -1 && written !== null) next.push(written)
    next.push(lines[i])
  }
  return next.join('\n') + rest
}
