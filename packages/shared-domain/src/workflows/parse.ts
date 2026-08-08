// Parse a workflow file (`.zennotes/workflows/<stem>.md`) into the `Workflow`
// contract in `./types`.
//
// The overriding obligation of this module is that it NEVER throws and never
// drops a statement. The text file and the canvas are two projections of the
// same graph, so a typo on line 4 must still yield a Workflow with lines 1-3
// intact and the breakage reported as a Diagnostic. If parsing were all or
// nothing, one bad character would blank the canvas and the user would lose the
// shape of what they were building.
//
// The grammar is deliberately thin: a body line is `[name =] step ( | step )*`,
// and what a step *means* lives entirely in the registry (`./nodes`). We split
// and tokenize, `bindParams` types the tokens. That is why adding a node never
// touches this file.
//
// Three invariants worth knowing before editing:
//
//   - `line` on every statement and step is 1-based within the BODY, i.e. after
//     the frontmatter fence, because that is the coordinate the canvas focus and
//     the editor gutter both speak.
//   - The first segment of a pipeline is special. A source opens the pipeline; a
//     bare identifier is a reference to a wire an earlier statement named and
//     contributes NO step. Fan-out is exactly "two statements read the same
//     wire", so a wire reference is load-bearing structure, not sugar.
//   - A wire named after a node kind (`sort = tag #book`) parses, but referring
//     to it later reads as that node kind and reports an error. The grammar
//     resolves the ambiguity in favour of the registry so that the meaning of a
//     line never depends on the lines above it.

import type { ArgValue, Diagnostic, Workflow, WorkflowEvent, WorkflowStatus } from './types'
import type { WorkflowStatement, WorkflowStep, WorkflowTrigger } from './types'
import { RAW_ARG } from './types'
import type { NodeDef } from './nodes'
import { bindParams, nodeDef } from './nodes'
import { parseFrontmatter } from '../template-files'

export interface ParseResult {
  workflow: Workflow
  diagnostics: Diagnostic[]
}

/**
 * Frontmatter keys the format owns. Anything else survives in `Workflow.meta`.
 *
 * A key listed here is read into a typed field AND written back from it, so
 * leaving one out would make the serializer emit it twice: once from the field
 * and once from the `meta` passthrough, and the second copy would win on the
 * next read.
 */
export const CONSUMED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'trigger',
  'status',
  'key'
])

/** Wire names and the identifiers the grammar accepts for them. */
const NAME_RE = /^[A-Za-z_][\w-]*$/

/**
 * The assignment `=`, anchored at the start of the statement.
 *
 * Anchoring is what keeps `=` unambiguous: a compare operator only ever appears
 * after a verb (`where rating >= 4`), so it can never be the first token, and
 * `>=`/`<=`/`!=` cannot match here because only name characters and spaces are
 * allowed in front of the `=`. `(?!=)` keeps a mistyped `==` out as well.
 */
const ASSIGN_RE = /^([A-Za-z_][\w-]*)\s*=(?!=)\s*([\s\S]*)$/

const FIRST_STEP_ERROR = 'pipeline must start with a source or a wire name'

/**
 * Where the raw tokens of an unrecognized verb are parked.
 *
 * `WorkflowStep.args` is keyed by the param names of a `NodeDef`, and an unknown
 * kind has no def, so its tokens have nowhere to live. Dropping them would mean
 * that opening and saving a workflow written by a future version silently
 * deletes the step's arguments. The `$` prefix cannot collide with a real param
 * name (they are all plain identifiers), and the serializer writes this value
 * back verbatim, which is the same "round-trip what we do not understand"
 * promise `Workflow.meta` makes for frontmatter.
 *
 * Lives in `./types` (it is part of the `args` contract, and `bindParams`
 * parks unbindable tokens under it too); re-exported here for the callers
 * that always imported it from the parser.
 */
export { RAW_ARG } from './types'

/** Runtime view of the `WorkflowEvent` union, which is types-only. */
export const WORKFLOW_EVENTS: readonly WorkflowEvent[] = [
  'note-created',
  'note-saved',
  'note-moved',
  'tag-added'
]

export function isWorkflowEvent(value: string): value is WorkflowEvent {
  return (WORKFLOW_EVENTS as readonly string[]).includes(value)
}

/** Runtime view of the `WorkflowStatus` union, which is types-only. */
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['draft', 'active']

export function isWorkflowStatus(value: string): value is WorkflowStatus {
  return (WORKFLOW_STATUSES as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a raw workflow file. Never throws, for any input.
 *
 * `id` comes from the filename stem: it is the workflow's identity, so it also
 * stands in as the display name when the file omits one.
 */
export function parseWorkflow(raw: string, id: string): ParseResult {
  const diagnostics: Diagnostic[] = []
  const { data, body } = parseFrontmatter(raw)

  const meta: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!CONSUMED_KEYS.has(key)) meta[key] = value
  }

  const key = data.key?.trim() ?? ''
  const { statements, trailing } = parseBody(body, diagnostics)
  const workflow: Workflow = {
    id,
    name: data.name?.trim() || id,
    description: data.description?.trim() ?? '',
    trigger: parseTrigger(data.trigger?.trim() ?? '', diagnostics),
    status: parseStatus(data.status, diagnostics),
    // Omitted rather than set to undefined so a keyless workflow compares equal
    // to one parsed from its own serialization.
    ...(key ? { key } : {}),
    statements,
    meta,
    // Same omit-when-empty rule as `key`, for the same round-trip reason.
    ...(trailing.length > 0 ? { trailing } : {})
  }

  return { workflow, diagnostics }
}

/* -------------------------------------------------------------------------- */
/*  Trigger                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `manual` | `on <event> [where <expr>]` | `schedule <cron>`.
 *
 * Anything unrecognized degrades to manual with a warning rather than an error:
 * a workflow with a trigger this version does not know about should still be
 * runnable by hand instead of being locked out of the app entirely.
 */
function parseTrigger(value: string, diagnostics: Diagnostic[]): WorkflowTrigger {
  const warn = (message: string): void => {
    diagnostics.push({ severity: 'warning', message, line: 0 })
  }

  if (!value || value === 'manual') return { type: 'manual' }

  const onRest = /^on\b([\s\S]*)$/.exec(value)
  if (onRest) {
    const parts = /^(\S+)(?:\s+where\b([\s\S]*))?$/.exec(onRest[1].trim())
    const event = parts ? parts[1] : ''
    if (!isWorkflowEvent(event)) {
      warn(`unknown trigger event \`${event}\`, treating the workflow as manual`)
      return { type: 'manual' }
    }
    // The optional group is absent for a bare `on <event>`, which the array type
    // does not express.
    const rawWhere: string | undefined = parts ? parts[2] : undefined
    const where = rawWhere?.trim() ?? ''
    return where ? { type: 'event', event, where } : { type: 'event', event }
  }

  const schedule = /^schedule\b([\s\S]*)$/.exec(value)
  if (schedule) {
    const cron = schedule[1].trim()
    if (!cron) {
      warn('`schedule` trigger needs a cron expression, treating the workflow as manual')
      return { type: 'manual' }
    }
    return { type: 'schedule', cron }
  }

  warn(`unknown trigger \`${value}\`, treating the workflow as manual`)
  return { type: 'manual' }
}

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `draft` | `active`, defaulting to ACTIVE.
 *
 * The default is the whole compatibility story. Every workflow in every vault
 * predates this field, and they all work today, so a missing `status:` has to
 * mean "carries on working". Defaulting to draft would silently switch off
 * automation people already rely on, which is the one outcome this feature is
 * not allowed to produce.
 *
 * An unrecognized value takes the same road for the same reason: a `status` a
 * future version writes (say `paused`) must not disarm the workflow when an
 * older build opens the file. It warns instead, because a value we ignored is
 * worth saying out loud, and the warning is the same shape `parseTrigger` uses
 * for a trigger it does not know.
 *
 * Matching is case-insensitive: the point of keeping this in frontmatter is
 * that people read and hand-edit it, and `status: Draft` clearly means draft.
 * The serializer always writes the lowercase form, so the file settles on one
 * spelling after the first save.
 */
function parseStatus(raw: string | undefined, diagnostics: Diagnostic[]): WorkflowStatus {
  const written = raw?.trim() ?? ''
  // An empty `status:` says no more than a missing one, so it gets the same
  // answer and no complaint.
  if (!written) return 'active'
  const value = written.toLowerCase()
  if (isWorkflowStatus(value)) return value
  diagnostics.push({
    severity: 'warning',
    // Quoted as written rather than lowercased, so the warning points at the
    // text that is actually in the file.
    message: `unknown status \`${written}\`, treating the workflow as active`,
    line: 0
  })
  return 'active'
}

/* -------------------------------------------------------------------------- */
/*  Body                                                                      */
/* -------------------------------------------------------------------------- */

function parseBody(
  body: string,
  diagnostics: Diagnostic[]
): { statements: WorkflowStatement[]; trailing: string[] } {
  const statements: WorkflowStatement[] = []
  const lines = body.split(/\r?\n/)
  // Comments and blank lines seen since the last statement. They attach to the
  // NEXT statement, because that is how people write them: a comment explains
  // the line under it. Whatever is left at EOF becomes the file's trailing
  // trivia. See `WorkflowStatement.leading` for why we keep them at all.
  let pending: string[] = []
  // The serializer always emits exactly one blank line after the closing
  // frontmatter fence, so the blank lines opening the body are its separator
  // rather than anything a human wrote. Dropping them here is what keeps
  // serialize(parse(x)) a fixpoint instead of growing a blank line per save.
  // Blank lines anywhere else are authorship and are kept verbatim.
  let atBodyStart = true
  const takePending = (): string[] => {
    if (atBodyStart) {
      while (pending.length > 0 && pending[0] === '') pending.shift()
      atBodyStart = false
    }
    const taken = pending
    pending = []
    return taken
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const text = raw.trim()
    // A tag never opens a statement, so `#` at the first non-space column is an
    // unambiguous comment marker and needs no escaping rule.
    if (!text || text.startsWith('#')) {
      pending.push(raw.replace(/\s+$/, ''))
      continue
    }
    const statement = parseStatement(text, i + 1, diagnostics)
    // A line of nothing but pipes yields no name, no wire and no step, so there
    // is nothing for the canvas to draw and nothing for the serializer to write
    // back. Its diagnostics already carry the line. Keeping it would make the
    // file grow a blank line on every save.
    if (!statement.name && !statement.input && statement.steps.length === 0) continue
    const leading = takePending()
    if (leading.length > 0) statement.leading = leading
    statements.push(statement)
  }

  const trailing = takePending()
  // Trailing blank lines are an artifact of the final newline, not authorship.
  while (trailing.length > 0 && trailing[trailing.length - 1] === '') trailing.pop()
  return { statements, trailing }
}

function parseStatement(
  text: string,
  line: number,
  diagnostics: Diagnostic[]
): WorkflowStatement {
  let name: string | null = null
  let pipeline = text

  const assigned = ASSIGN_RE.exec(text)
  if (assigned) {
    name = assigned[1]
    pipeline = assigned[2].trim()
  }

  const segments = splitPipeline(pipeline)
  const steps: WorkflowStep[] = []
  let input: string | null = null

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index].trim()
    if (!segment) {
      diagnostics.push({
        severity: 'error',
        message: index === 0 ? FIRST_STEP_ERROR : 'empty step after `|`',
        line
      })
      continue
    }

    const scanned = scanTokens(segment)
    if (scanned.unterminated) {
      diagnostics.push({
        severity: 'warning',
        message: 'unterminated quote, treated the end of the line as the closing quote',
        line
      })
    }

    const tokens = scanned.tokens
    const verb = tokens[0]
    const def = nodeDef(verb)

    if (index > 0) {
      if (!def) {
        diagnostics.push({ severity: 'error', message: `unknown step \`${verb}\``, line })
        steps.push(unknownStep(verb, tokens.slice(1), line))
        continue
      }
      steps.push(boundStep(def, tokens.slice(1), line, diagnostics))
      continue
    }

    if (def?.source) {
      steps.push(boundStep(def, tokens.slice(1), line, diagnostics))
      continue
    }

    if (!def && tokens.length === 1 && NAME_RE.test(verb)) {
      input = verb
      continue
    }

    // Keep the step even though it cannot open a pipeline: the canvas shows it
    // marked red and the text survives an edit, which is friendlier than making
    // a mistyped source disappear on save.
    diagnostics.push({ severity: 'error', message: FIRST_STEP_ERROR, line })
    steps.push(
      def
        ? boundStep(def, tokens.slice(1), line, diagnostics)
        : unknownStep(verb, tokens.slice(1), line)
    )
  }

  return { name, input, steps, line }
}

function boundStep(
  def: NodeDef,
  tokens: string[],
  line: number,
  diagnostics: Diagnostic[]
): WorkflowStep {
  const bound = bindParams(def, tokens, line)
  for (const diagnostic of bound.diagnostics) diagnostics.push(diagnostic)
  return { kind: def.kind, args: bound.args, line }
}

function unknownStep(kind: string, tokens: string[], line: number): WorkflowStep {
  const args: Record<string, ArgValue> = {}
  if (tokens.length > 0) args[RAW_ARG] = tokens.join(' ')
  return { kind, args, line }
}

/* -------------------------------------------------------------------------- */
/*  Scanning                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split a pipeline on `|`, ignoring pipes inside quotes.
 *
 * Quote awareness matters because a markdown table row is a perfectly reasonable
 * thing to `append "| a | b |"`.
 */
function splitPipeline(text: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }

  segments.push(current)
  return segments
}

interface ScanResult {
  tokens: string[]
  /** A quote was still open at end of input; the caller reports it. */
  unterminated: boolean
}

/**
 * Split a step into tokens on whitespace, ignoring whitespace inside quotes.
 *
 * Quotes are KEPT in the token: `unquote`/`bindParams` in `./nodes` strip them,
 * so a param that wants the literal text (`rest`) and one that wants a value
 * both see the same input and one rule decides. An unterminated quote closes at
 * end of line, because refusing to tokenize a half-typed line would make the
 * canvas flicker empty while the user is still typing.
 */
export function tokenizeStep(text: string): string[] {
  return scanTokens(text).tokens
}

function scanTokens(text: string): ScanResult {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return { tokens, unterminated: quote !== null }
}
