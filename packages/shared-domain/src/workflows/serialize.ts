// Serialize a `Workflow` back to the file form `./parse` reads.
//
// This is the other half of the "the file and the canvas are the same graph"
// claim: everything the canvas can express has to survive a save, and saving
// must not churn the file. So the output is canonical rather than faithful to
// the original spacing (single space around `=`, ` | ` between steps, no
// alignment padding), and the pair is expected to satisfy:
//
//   parseWorkflow(serializeWorkflow(w)).workflow  deep-equals  w
//   serializeWorkflow(parseWorkflow(serializeWorkflow(w)).workflow) === serializeWorkflow(w)
//
// The one subtle job here is quoting. `bindParams` hands us values with their
// quotes already stripped, so a value that contains whitespace has to be quoted
// again on the way out or it would tokenize into two arguments on the next read.
// The token grammar has no escape character, so the quote character is chosen to
// avoid the ones inside the value.

import type { ArgValue, Workflow, WorkflowStatement, WorkflowStep, WorkflowTrigger } from './types'
import type { ParamSpec, ParamType } from './nodes'
import { nodeDef, unquote } from './nodes'
import { CONSUMED_KEYS, RAW_ARG } from './parse'

/**
 * Params always written with quotes.
 *
 * These carry human text (a note path, a heading, a template name) that gains
 * and loses words during normal editing, so quoting them up front means adding a
 * word to a heading in the text file never silently splits it into two
 * arguments. Everything else is quoted only when it has to be.
 */
const ALWAYS_QUOTED: ReadonlySet<ParamType> = new Set<ParamType>(['path', 'heading', 'template'])

export function serializeWorkflow(workflow: Workflow): string {
  const head = serializeFrontmatter(workflow)
  // Trivia is replayed exactly where it was found: a statement's `leading`
  // lines go back above it, the file's `trailing` lines go back at the end.
  // This is what stops a canvas save from deleting the comments someone wrote
  // to explain their own workflow.
  const body: string[] = []
  for (const statement of workflow.statements) {
    if (statement.leading) body.push(...statement.leading)
    body.push(serializeStatement(statement))
  }
  if (workflow.trailing) body.push(...workflow.trailing)
  // A blank line after the fence mirrors what the parser skips, so the body's
  // 1-based line numbers stay stable across a save.
  return body.length === 0 ? `${head}\n` : `${head}\n\n${body.join('\n')}\n`
}

/* -------------------------------------------------------------------------- */
/*  Frontmatter                                                               */
/* -------------------------------------------------------------------------- */

function serializeFrontmatter(workflow: Workflow): string {
  const lines = ['---', `name: ${frontmatterValue(workflow.name)}`]
  if (workflow.description) {
    lines.push(`description: ${frontmatterValue(workflow.description)}`)
  }
  // Written before the trigger, and written even when it is `active`: the line
  // that says whether the file may act should be read BEFORE the line that says
  // when it would act, so nobody reads `trigger: on note-saved` and believes it
  // is live. Omitting the default would put that state back in the absence of a
  // line, which is exactly the invisible thing frontmatter was chosen to avoid.
  // Anything that is not `draft` writes as `active`, mirroring the parser, so a
  // workflow assembled in memory cannot emit a value that reads back different.
  lines.push(`status: ${workflow.status === 'draft' ? 'draft' : 'active'}`)
  lines.push(`trigger: ${serializeTrigger(workflow.trigger)}`)
  if (workflow.key) lines.push(`key: ${frontmatterValue(workflow.key)}`)
  // Sorted so an unknown key written by a future version lands in a stable spot
  // instead of reshuffling the file on every save. A key the format owns is
  // skipped: the parser never puts one here, but a workflow assembled in memory
  // could, and writing it twice would let the copy win on the next read.
  for (const key of Object.keys(workflow.meta).sort()) {
    if (CONSUMED_KEYS.has(key)) continue
    lines.push(`${key}: ${frontmatterValue(workflow.meta[key])}`)
  }
  lines.push('---')
  return lines.join('\n')
}

export function serializeTrigger(trigger: WorkflowTrigger): string {
  switch (trigger.type) {
    case 'event':
      return trigger.where ? `on ${trigger.event} where ${trigger.where}` : `on ${trigger.event}`
    case 'schedule':
      return `schedule ${trigger.cron}`
    default:
      return 'manual'
  }
}

/**
 * `parseFrontmatter` trims a value and then strips one layer of matching quotes,
 * so those two transforms are exactly what has to be defended against. A newline
 * cannot be represented at all in a flat scalar, so it collapses to a space
 * rather than corrupting the fence.
 */
function frontmatterValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ')
  if (flat !== '' && flat.trim() === flat && unquote(flat) === flat) return flat
  return quote(flat)
}

/* -------------------------------------------------------------------------- */
/*  Statements                                                                */
/* -------------------------------------------------------------------------- */

function serializeStatement(statement: WorkflowStatement): string {
  const segments: string[] = []
  // The input wire is a segment of the pipeline, not a step: it is how the text
  // form spells "read what that statement produced".
  if (statement.input) segments.push(statement.input)
  for (const step of statement.steps) segments.push(serializeStep(step))
  const pipeline = segments.join(' | ')
  if (!statement.name) return pipeline
  // A named statement with nothing on its right only happens after a parse
  // error; keep the name visible without leaving a trailing space behind.
  return pipeline ? `${statement.name} = ${pipeline}` : `${statement.name} =`
}

function serializeStep(step: WorkflowStep): string {
  const def = nodeDef(step.kind)
  if (!def) {
    // An unrecognized verb keeps whatever the parser parked for it, so a step a
    // future version understands survives being opened and saved by this one.
    const raw: ArgValue | undefined = step.args[RAW_ARG]
    return raw === undefined || raw === '' ? step.kind : `${step.kind} ${String(raw)}`
  }

  // Params are positional, so a value is only droppable while every param after
  // it is droppable too. In practice that is exactly the trailing optionals
  // (`sort` direction, `render` columns), which is why omitting them is safe.
  const slots: (string | null)[] = def.params.map((spec) => {
    const value: ArgValue | undefined = step.args[spec.name]
    if (value === undefined) return null
    if (spec.default !== undefined && value === spec.default) return null
    return serializeArg(spec, value)
  })
  while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop()

  // An INTERIOR gap must not close up: dropping a middle slot would slide the
  // next value into the wrong position on the next parse, which destroys the
  // file as a fixpoint. A default fills the gap explicitly instead.
  const parts: string[] = []
  slots.forEach((slot, i) => {
    if (slot !== null) {
      parts.push(slot)
      return
    }
    const spec = def.params[i]
    if (spec && spec.default !== undefined) {
      const filled = serializeArg(spec, spec.default)
      if (filled) parts.push(filled)
    }
  })
  // Tokens `bindParams` could not bind are replayed verbatim, exactly like an
  // unknown step's arguments: red on the canvas, intact in the file.
  const parked: ArgValue | undefined = step.args[RAW_ARG]
  if (parked !== undefined && parked !== '') parts.push(String(parked))
  return [step.kind, ...parts].join(' ')
}

function serializeArg(spec: ParamSpec, value: ArgValue): string {
  if (typeof value !== 'string') return String(value)
  // `bindParams` stores tags without the `#`; the file always writes it.
  if (spec.type === 'tag') return `#${value}`
  if (ALWAYS_QUOTED.has(spec.type)) return quote(value)
  return isBareSafe(value, spec.type === 'rest') ? value : quote(value)
}

/* -------------------------------------------------------------------------- */
/*  Quoting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * True when the value survives a tokenize/`unquote` round-trip unquoted.
 *
 * A `rest` param is rejoined from every remaining token, so it may carry single
 * spaces; any other param is one token and may carry no whitespace at all.
 */
function isBareSafe(value: string, rest: boolean): boolean {
  if (value === '') return false
  // A quote character forces quoting even with no whitespace in sight: written
  // bare, an odd one opens a region that runs past the next ` | ` and swallows
  // the following step into this argument. Wrapping keeps the count even.
  if (value.includes('"') || value.includes("'")) return false
  // A pipe is the step separator, so writing one bare does not merely split the
  // value into two arguments, it splits the STEP: `append | a | b |` reads back
  // as `append` followed by steps `a` and `b`. Quoting is what makes the
  // quote-aware `splitPipeline` keep it inside this argument, which is what lets
  // a markdown table row survive a save.
  if (value.includes('|')) return false
  if (!rest) return !/\s/.test(value)
  // Tokenizing collapses runs of whitespace into the single space used to rejoin
  // them, so only single plain spaces survive intact.
  return !/^\s|\s$|\s\s/.test(value) && !/[^\S ]/.test(value)
}

/**
 * Wrap in whichever quote the value does not already contain.
 *
 * The token grammar has no escape character, so a value holding BOTH quote
 * characters around whitespace cannot be written exactly. Preferring the absent
 * quote makes that the only losing case, and it needs a note in the file format
 * before anyone relies on it.
 */
function quote(value: string): string {
  const char = value.includes('"') && !value.includes("'") ? "'" : '"'
  return `${char}${value}${char}`
}
