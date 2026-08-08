// Structured edits: what the canvas calls instead of asking someone to type.
//
// The canvas is the primary editor, so adding a step, rewiring a pipeline or
// renaming a wire has to be a gesture rather than a sentence. None of that
// invents a new storage format. The `.md` file stays the file, `parseWorkflow`
// reads it into a `Workflow`, and one edit is:
//
//   mutate the parsed Workflow -> serializeWorkflow -> save through the normal path
//
// so the file stays hand-editable and git-diffable and the text editor is simply
// the other way in. Everything in this module is therefore a pure function
// `Workflow -> Workflow`, with no knowledge of React, of files, or of when a save
// happens.
//
// THE INVARIANT, and it is the whole point:
//
//   parseWorkflow(serializeWorkflow(op(w))).workflow  deep-equals  op(w)
//
// An edit that does not survive a save is a corrupted file: the canvas would show
// one graph, the file on disk would say another, and the next open would silently
// disagree with what the user just did. `edit.test.ts` asserts that property on
// every operation, and `commit` below ALSO enforces it at runtime, because a
// guarantee that only exists in a test is a guarantee that holds until the day
// someone adds a node kind with a param shape nobody anticipated.
//
// Two conventions hold the module together:
//
//   - Nothing throws. An editing gesture that can throw is an editing gesture
//     that can lose the document mid-drag.
//   - Refusal is a RESULT, not an exception. An operation that cannot be carried
//     out (an index that does not exist, a wire name already taken, a value the
//     file cannot spell) returns the workflow it was given, unchanged and by
//     reference. The caller renders it and the user sees that nothing moved,
//     which is exactly what happened.

import type { ArgValue, Workflow, WorkflowStatement, WorkflowStep, WorkflowTrigger } from './types'
import type { NodeDef, ParamSpec } from './nodes'
import { RENDER_STYLES, isCompareOp, nodeDef } from './nodes'
import { parseWorkflow } from './parse'
import { serializeWorkflow } from './serialize'

/* -------------------------------------------------------------------------- */
/*  Addresses                                                                 */
/* -------------------------------------------------------------------------- */

/** Where a step lives: which statement, and where in that statement's pipeline. */
export interface StepAddress {
  statement: number
  index: number
}

/** A step address plus the registry kind to put there. See `NODE_DEFS`. */
export interface StepInsertion extends StepAddress {
  kind: string
}

/**
 * A statement to create: an optional wire name, an optional input wire, and the
 * one step it opens with. Everything else is added afterwards with `addStep`,
 * so there is one way to build a pipeline rather than two.
 */
export interface NewStatement {
  name?: string
  input?: string
  kind: string
}

/* -------------------------------------------------------------------------- */
/*  Grammar rules this module has to respect                                  */
/* -------------------------------------------------------------------------- */

/**
 * The identifier rule for a wire, copied from `./parse` (which keeps it private).
 *
 * Duplicated rather than exported across because the two are the same rule for
 * different reasons: the parser uses it to RECOGNIZE a wire reference, we use it
 * to refuse writing one that would not be recognized. `edit.test.ts` covers the
 * pairing by round-tripping through the real parser, so a drift between them
 * fails a test rather than shipping.
 */
const WIRE_NAME_RE = /^[A-Za-z_][\w-]*$/

/** The tag body, i.e. `./nodes`' TAG_RE with the optional `#` already stripped. */
const TAG_VALUE_RE = /^\p{L}[\p{L}\d_/-]*$/u

/** `7d`, `12h`, `2w`. Mirrors DURATION_RE in `./nodes`. */
const DURATION_RE = /^\d+[dhwm]$/

/**
 * True when `name` can be used as a wire.
 *
 * A wire reference is a bare first segment (`good | archive`), so a name that
 * collides with a registry verb reads back as that STEP and the connection
 * silently disappears. The parser documents the ambiguity and resolves it in
 * favour of the registry; here we simply refuse to create it.
 */
function isWireName(name: string): boolean {
  return WIRE_NAME_RE.test(name) && nodeDef(name) === null
}

/** A legal wire name that no statement has claimed yet. */
function isFreeWireName(workflow: Workflow, name: string): boolean {
  return isWireName(name) && !workflow.statements.some((statement) => statement.name === name)
}

/** True when `index` is the only statement producing `name`. */
function isSoleProducer(workflow: Workflow, name: string, index: number): boolean {
  return !workflow.statements.some((other, i) => i !== index && other.name === name)
}

/**
 * Wires a step reads through its arguments, e.g. the `other` in `union other`.
 *
 * Found from the registry (any param declared `type: 'wire'`), never by naming
 * `union` and `subtract`. A rename that missed a node added later would leave a
 * dangling reference that the user never typed and cannot see, so the one place
 * that knows which arguments are connections is the place that declares them.
 */
function wireParams(step: WorkflowStep): ParamSpec[] {
  const def = nodeDef(step.kind)
  if (!def) return []
  return def.params.filter((spec) => spec.type === 'wire')
}

/** True when any statement other than `except` reads `wire`. */
function isWireRead(workflow: Workflow, wire: string, except: number): boolean {
  return workflow.statements.some((statement, index) => {
    // A statement referring to its own wire is a cycle, not a reader. Counting it
    // would make a name impossible to drop for the very reason it is broken.
    if (index === except) return false
    if (statement.input === wire) return true
    return statement.steps.some((step) =>
      wireParams(step).some((spec) => step.args[spec.name] === wire)
    )
  })
}

/* -------------------------------------------------------------------------- */
/*  Steps                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert a step of `kind` into a pipeline.
 *
 * `index` is where the step lands, so `0` puts it in front of the source and
 * `steps.length` appends. Its arguments are seeded (see `seedArgs`) so the node
 * arrives inspectable: the inspector shows a filled form to correct rather than a
 * half-parsed step, and the file it saves to is a line someone could have typed.
 */
export function addStep(workflow: Workflow, at: StepInsertion): Workflow {
  const statement = statementAt(workflow, at.statement)
  if (!statement) return workflow
  const def = nodeDef(at.kind)
  // An unknown verb cannot be seeded (no params to read) and does not even
  // survive a save: written alone it reads back as a WIRE REFERENCE, not a step.
  if (!def) return workflow
  if (!isStepSlot(statement, at.index)) return workflow

  const steps = [...statement.steps]
  steps.splice(at.index, 0, { kind: def.kind, args: seedArgs(def), line: statement.line })
  return commit(workflow, withStatement(workflow, at.statement, { ...statement, steps }))
}

/**
 * Remove one step, joining what was on either side of it.
 *
 * The pipeline is a list, so healing IS the splice: the step before and the step
 * after become neighbours and the wire flows through. Removing the only step
 * removes the whole statement, because a row with no steps left is not a
 * half-built pipeline, it is the row the user just deleted.
 */
export function removeStep(workflow: Workflow, at: StepAddress): Workflow {
  const statement = statementAt(workflow, at.statement)
  if (!statement) return workflow
  if (!stepAt(statement, at.index)) return workflow
  if (statement.steps.length === 1) return removeStatement(workflow, at.statement)

  const steps = statement.steps.filter((_step, index) => index !== at.index)
  return commit(workflow, withStatement(workflow, at.statement, { ...statement, steps }))
}

/**
 * Move a step to another position in the same pipeline.
 *
 * `toIndex` is the position it ends up at once it has been lifted out, which is
 * what a drag reads as: drop it on slot 2 and it is slot 2. Moving between
 * statements is deliberately not expressible here; that is a remove plus an add,
 * and the two statements have different inputs.
 */
export function moveStep(workflow: Workflow, from: StepAddress, toIndex: number): Workflow {
  const statement = statementAt(workflow, from.statement)
  if (!statement) return workflow
  const steps = statement.steps
  // The destination is checked as a step that exists rather than as a slot: the
  // step is reinserted into a list of the same length, so the last position it
  // can hold is the one the last step holds now.
  if (!stepAt(statement, from.index) || !stepAt(statement, toIndex)) return workflow
  if (toIndex === from.index) return workflow

  const next = [...steps]
  const [moved] = next.splice(from.index, 1)
  next.splice(toIndex, 0, moved)
  return commit(workflow, withStatement(workflow, from.statement, { ...statement, steps: next }))
}

/**
 * Set one argument of one step, or clear it with `null`.
 *
 * Clearing an OPTIONAL param means "back to its default", because a param with a
 * default is never absent after a read: the parser fills it in, so deleting it
 * would reappear on the next open and the clear would look like it never
 * happened.
 *
 * Clearing a REQUIRED param is allowed, because a half-filled form is a normal
 * editing state and the validator already says which argument is missing. It
 * clears every param AFTER it as well, and that is not tidiness: arguments are
 * positional and the grammar has no way to spell a hole, so `where` with its
 * field blanked and `= 4` still set would write `where = 4` and read back with
 * `=` as the FIELD. Clearing the tail is the only version of "blank this box"
 * that means the same thing after a save.
 */
export function setStepArg(
  workflow: Workflow,
  at: StepAddress,
  param: string,
  value: ArgValue | null
): Workflow {
  const statement = statementAt(workflow, at.statement)
  if (!statement) return workflow
  const step = stepAt(statement, at.index)
  if (!step) return workflow

  const def = nodeDef(step.kind)
  // An unknown verb's arguments are parked verbatim under one opaque key; there
  // is no param list to edit against, so there is nothing honest to offer here.
  if (!def) return workflow
  const position = def.params.findIndex((spec) => spec.name === param)
  if (position === -1) return workflow

  const args = { ...step.args }
  if (value === null) {
    for (let i = position; i < def.params.length; i += 1) clearArg(args, def.params[i])
  } else {
    const canonical = canonicalArg(def.params[position], value)
    // A value the file cannot spell is refused rather than written and lost on
    // the next read. See `canonicalArg`.
    if (canonical === null) return workflow
    args[param] = canonical
  }
  if (sameArgs(args, step.args)) return workflow

  const steps = [...statement.steps]
  steps[at.index] = { ...step, args }
  return commit(workflow, withStatement(workflow, at.statement, { ...statement, steps }))
}

/* -------------------------------------------------------------------------- */
/*  Statements                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Add a statement, opening with one step.
 *
 * It is placed directly after the statement producing its input so the file
 * still reads top to bottom, which is the property that lets someone open the
 * text editor and follow the graph by reading downwards. Nothing else moves: the
 * rest of the file keeps the order its author gave it.
 */
export function addStatement(workflow: Workflow, opts: NewStatement): Workflow {
  const def = nodeDef(opts.kind)
  if (!def) return workflow

  const name = opts.name ?? null
  // Refused rather than uniquified: two statements sharing a name is a redefined
  // wire, and silently answering "add a wire called good" with "here is good2"
  // is worse than answering "no". `freshWireName` exists for callers that want
  // the next free one.
  if (name !== null && !isFreeWireName(workflow, name)) return workflow
  const input = opts.input ?? null
  if (input !== null && !isWireName(input)) return workflow

  const statement: WorkflowStatement = {
    name,
    input,
    steps: [{ kind: def.kind, args: seedArgs(def), line: 0 }],
    line: 0
  }
  const producer =
    input === null ? -1 : workflow.statements.findIndex((other) => other.name === input)
  const at = producer === -1 ? workflow.statements.length : producer + 1

  const statements = [...workflow.statements]
  statements.splice(at, 0, statement)
  return commit(workflow, { ...workflow, statements })
}

/**
 * Remove a statement and everything on it.
 *
 * Statements reading its wire are left dangling on purpose. Deleting upstream
 * first is how people actually edit a graph, the diagnostics name the broken
 * reference precisely, and refusing would force a delete order nobody thinks in.
 * That is the opposite call from `setStatementName(index, null)`, where breaking
 * the readers is a side effect of an edit that was not asking to break anything.
 *
 * The comment lines above the statement move down onto whatever takes its place,
 * or into the file's trailing trivia when it was the last. Prose the user wrote
 * is never deleted by a gesture that was aimed at a node.
 */
export function removeStatement(workflow: Workflow, index: number): Workflow {
  const removed = statementAt(workflow, index)
  if (!removed) return workflow

  const statements = [...workflow.statements]
  statements.splice(index, 1)
  const orphaned = removed.leading ?? []

  if (orphaned.length === 0) return commit(workflow, { ...workflow, statements })
  if (index < statements.length) {
    const heir = statements[index]
    statements[index] = { ...heir, leading: [...orphaned, ...(heir.leading ?? [])] }
    return commit(workflow, { ...workflow, statements })
  }
  return commit(
    workflow,
    withTrailing({ ...workflow, statements }, [...orphaned, ...(workflow.trailing ?? [])])
  )
}

/**
 * Point a statement at another wire, or detach it with `null`.
 *
 * This is what dropping an edge onto a pipeline does. The wire does not have to
 * exist yet and may be defined further down the file: definition order is not
 * execution order, the validator reports a wire that is genuinely absent, and the
 * cycle check catches a loop. Refusing here would mean an edge can only be drawn
 * in one direction.
 */
export function setStatementInput(workflow: Workflow, index: number, wire: string | null): Workflow {
  const statement = statementAt(workflow, index)
  if (!statement) return workflow
  if (wire !== null && !isWireName(wire)) return workflow
  if (statement.input === wire) return workflow
  return commit(workflow, withStatement(workflow, index, { ...statement, input: wire }))
}

/**
 * Name the wire a statement produces, or drop the name with `null`.
 *
 * Naming is the only difference between a terminal statement and one other
 * statements can read, so this is how a dead end becomes a branch point and back
 * again. Renaming an already-named statement goes through `renameWire`, so the
 * readers follow: editing the label on a wire and renaming the wire are the same
 * act and must not be two different outcomes.
 *
 * Dropping a name that another statement reads is refused. The gesture says
 * "this wire has no name", not "break the two statements downstream", and a
 * reference left pointing at nothing is a graph the user cannot see the shape of.
 *
 * Both of those only apply while this statement is the SOLE producer of the name.
 * Two statements sharing one is a validator error, and the gesture that clears it
 * is renaming one of them; taking the readers along, or refusing outright, would
 * make the app argue with the person fixing the thing it complained about.
 */
export function setStatementName(workflow: Workflow, index: number, name: string | null): Workflow {
  const statement = statementAt(workflow, index)
  if (!statement) return workflow
  const current = statement.name
  if (current === name) return workflow
  /** The name this statement is the sole producer of, if any. */
  const owned = current !== null && isSoleProducer(workflow, current, index) ? current : null

  if (name === null) {
    if (owned !== null && isWireRead(workflow, owned, index)) return workflow
    return commit(workflow, withStatement(workflow, index, { ...statement, name: null }))
  }
  if (!isFreeWireName(workflow, name)) return workflow
  if (owned !== null) return renameWire(workflow, owned, name)
  return commit(workflow, withStatement(workflow, index, { ...statement, name }))
}

/* -------------------------------------------------------------------------- */
/*  Wires                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rename a wire everywhere it appears.
 *
 * Connections ARE wire names: there is no edge list to update alongside, so a
 * rename that misses one reference does not leave a stale label, it CUTS the
 * edge. Every site is therefore rewritten in one operation: the statement that
 * produces the wire, every `statement.input` that reads it, and every argument
 * the registry declares as `type: 'wire'`.
 *
 * Reading the argument sites off the registry rather than off `union` and
 * `subtract` is the load-bearing part. Naming those two verbs would work today
 * and quietly break the day a third combining node lands, in a way that looks
 * like the canvas losing an edge on its own.
 *
 * Renaming onto a name another statement already produces is refused. Those are
 * two different sets of notes, and merging them because they now spell the same
 * would change what the workflow DOES on the next run.
 */
export function renameWire(workflow: Workflow, from: string, to: string): Workflow {
  if (from === to) return workflow
  if (!isFreeWireName(workflow, to)) return workflow

  let touched = false
  const statements = workflow.statements.map((statement) => {
    const name = statement.name === from ? to : statement.name
    const input = statement.input === from ? to : statement.input
    let rewired = false
    const steps = statement.steps.map((step) => {
      const params = wireParams(step).filter((spec) => step.args[spec.name] === from)
      if (params.length === 0) return step
      const args = { ...step.args }
      for (const spec of params) args[spec.name] = to
      rewired = true
      return { ...step, args }
    })
    if (name === statement.name && input === statement.input && !rewired) return statement
    touched = true
    return { ...statement, name, input, steps }
  })

  // Nothing anywhere spells `from`, so there is no rename to perform. Reported as
  // "nothing happened" rather than as a change, so an undo stack does not grow an
  // entry for a rename of a wire that does not exist.
  if (!touched) return workflow
  return commit(workflow, { ...workflow, statements })
}

/**
 * The first free wire name based on `base`, e.g. `books`, `books2`, `books3`.
 *
 * Exported because the canvas needs a name BEFORE it can call `addStatement`,
 * and every caller inventing its own suffix scheme is how two of them end up
 * disagreeing about what "already taken" means.
 *
 * A base that collides with a registry verb is suffixed rather than thrown away,
 * because naming a wire after the node that produces it is the obvious default
 * and most sources ARE verbs: `tag`, `all`, `folder`, `search`, `selection`.
 * Discarding those would name every wire on the canvas `wire`, `wire2`, `wire3`.
 */
export function freshWireName(workflow: Workflow, base: string): string {
  const seed = WIRE_NAME_RE.test(base) ? base : 'wire'
  // A candidate is only taken by a statement name or (for the unsuffixed one) by
  // a registry verb, so one attempt per statement plus two always finds a gap.
  const attempts = workflow.statements.length + 2
  for (let n = 1; n <= attempts; n += 1) {
    const candidate = n === 1 ? seed : `${seed}${n}`
    if (isFreeWireName(workflow, candidate)) return candidate
  }
  return `${seed}${attempts + 1}`
}

/* -------------------------------------------------------------------------- */
/*  Seeding a new step's arguments                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fill in a new step's arguments from its `ParamSpec`s.
 *
 * A param with a default gets it, which is not a nicety but a round-trip
 * requirement: the serializer drops a value equal to its default and the parser
 * puts it back, so a step that omits it in memory is not equal to the same step
 * read back from disk.
 *
 * A required param gets a placeholder, and the placeholder is THE PARAM'S OWN
 * NAME (`move folder`, `where field = value`, `add-tag #tag`). That is exactly
 * what an empty form field would say, it reads in the file as the blank it is,
 * and it keeps this module free of per-kind knowledge, which belongs in the
 * registry. Types whose grammar rejects a bare word get the smallest legal value
 * of that type instead.
 *
 * An empty string was the obvious alternative and is the dangerous one: `move ""`
 * is not an unfilled form, it is a valid instruction to move every note on the
 * wire to the root of the vault, and nothing in the file would look wrong.
 */
function seedArgs(def: NodeDef): Record<string, ArgValue> {
  const args: Record<string, ArgValue> = {}
  for (const spec of def.params) {
    if (spec.default !== undefined) {
      args[spec.name] = spec.default
      continue
    }
    if (!spec.required) continue
    args[spec.name] = placeholderArg(spec)
  }
  return args
}

function placeholderArg(spec: ParamSpec): ArgValue {
  switch (spec.type) {
    case 'number':
      return 0
    case 'compare-op':
      return '='
    case 'direction':
      return 'asc'
    case 'duration':
      return '7d'
    case 'render-style':
      return RENDER_STYLES[0]
    default:
      return spec.name
  }
}

/* -------------------------------------------------------------------------- */
/*  Argument values                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The value as the parser would store it, or `null` when the file cannot hold it.
 *
 * This mirrors `coerce` in `./nodes`, deliberately and exactly: the args of a
 * step edited in the canvas have to be indistinguishable from the args of the
 * same step read from disk, so anything the parser would reject is refused here
 * and anything the parser would normalize (`#book` to `book`, `DESC` to `desc`)
 * is normalized here.
 *
 * On top of the parser's own rules, two things cannot be written at all:
 *
 *   - a line break, because a statement IS one line and the value would come
 *     back as two statements, one of them garbage;
 *   - a boolean, because no param type spells one and `true` reads back as the
 *     four-letter string.
 *
 * Being forgiving in the other direction is free: a form control that hands back
 * `"25"` for a number, or a number for a text param, means what it says, and the
 * value is converted rather than dropped on the floor.
 */
function canonicalArg(spec: ParamSpec, value: ArgValue): ArgValue | null {
  if (typeof value === 'boolean') return null

  if (spec.type === 'number') {
    // Checked before converting because `Number('')` is 0, so an emptied number
    // box would otherwise read as a deliberate zero.
    if (typeof value === 'string' && value.trim() === '') return null
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return null
    // `-0` writes as `0` and reads back as `+0`, so it is stored as `+0` up front
    // rather than becoming a value that is equal to itself but not identical.
    return parsed === 0 ? 0 : parsed
  }

  const text = typeof value === 'string' ? value : String(value)
  if (/[\r\n]/.test(text)) return null

  switch (spec.type) {
    case 'tag': {
      // The file writes the `#` and `bindParams` strips it, so args hold the bare
      // name. Accepting either spelling means a paste from the tag sidebar works.
      const bare = text.startsWith('#') ? text.slice(1) : text
      return TAG_VALUE_RE.test(bare) ? bare : null
    }
    case 'compare-op':
      return isCompareOp(text) ? text : null
    case 'direction': {
      const direction = text.toLowerCase()
      return direction === 'asc' || direction === 'desc' ? direction : null
    }
    case 'duration':
      return DURATION_RE.test(text) ? text : null
    case 'render-style':
      return (RENDER_STYLES as readonly string[]).includes(text) ? text : null
    default:
      return text
  }
}

/** Clearing means "back to the default" when there is one. See `setStepArg`. */
function clearArg(args: Record<string, ArgValue>, spec: ParamSpec): void {
  if (spec.default === undefined) delete args[spec.name]
  else args[spec.name] = spec.default
}

/* -------------------------------------------------------------------------- */
/*  Rebuilding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The three lookups every operation opens with.
 *
 * All of them answer "is there one of those there?" with `null` rather than a
 * thrown error or an `undefined` that flows on, which is what makes an
 * out-of-range address a no-op instead of a crash halfway through a drag. The
 * integer check matters as much as the bounds: a fractional index would pass
 * `< length` and then splice at a position that does not exist.
 */
function statementAt(workflow: Workflow, index: number): WorkflowStatement | null {
  if (!Number.isInteger(index) || index < 0 || index >= workflow.statements.length) return null
  return workflow.statements[index]
}

function stepAt(statement: WorkflowStatement, index: number): WorkflowStep | null {
  if (!Number.isInteger(index) || index < 0 || index >= statement.steps.length) return null
  return statement.steps[index]
}

/** A position a step can be inserted at, which includes the end of the pipeline. */
function isStepSlot(statement: WorkflowStatement, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= statement.steps.length
}

function withStatement(workflow: Workflow, index: number, statement: WorkflowStatement): Workflow {
  const statements = [...workflow.statements]
  statements[index] = statement
  return { ...workflow, statements }
}

/** `trailing` is absent when empty, never `[]`. See `normalize`. */
function withTrailing(workflow: Workflow, trailing: string[]): Workflow {
  if (trailing.length === 0) return omitTrailing(workflow)
  return { ...workflow, trailing }
}

/**
 * Both omitters delete the key off a copy rather than rebuilding the object from
 * a field list, so a field added to `Workflow` later cannot be silently dropped
 * by a helper that predates it.
 */
function omitTrailing(workflow: Workflow): Workflow {
  if (workflow.trailing === undefined) return workflow
  const next = { ...workflow }
  delete next.trailing
  return next
}

function omitLeading(statement: WorkflowStatement): WorkflowStatement {
  if (statement.leading === undefined) return statement
  const next = { ...statement }
  delete next.leading
  return next
}

/* -------------------------------------------------------------------------- */
/*  Normalizing an edited workflow                                            */
/* -------------------------------------------------------------------------- */

/**
 * Put an edited workflow into the exact shape `parseWorkflow` would produce for
 * it. Two things drift the moment statements move, and neither is something an
 * edit can reasonably be asked to compute for itself:
 *
 *   - `line`, which is a body coordinate the SERIALIZER decides. Every step
 *     shares its statement's line because a statement is written as one line.
 *   - trivia at the very top of the body. The serializer's own blank line after
 *     the closing frontmatter fence is indistinguishable from one the user wrote,
 *     so the parser drops blanks that open the body. A statement carrying a
 *     leading blank line round-trips only while it is not the first one, and
 *     deleting the statement above it is exactly how it becomes the first one.
 *
 * Also the reason `leading` and `trailing` are absent rather than `[]` when
 * empty: the parser omits them, and an empty array is not equal to an absent key.
 */
function normalize(workflow: Workflow): Workflow {
  const statements: WorkflowStatement[] = []
  // Body line 1 is the blank line the serializer always writes after the closing
  // fence, which the parser counts, so the first statement lands on line 2.
  let cursor = 1
  for (let index = 0; index < workflow.statements.length; index += 1) {
    const trimmed = withTrivia(workflow.statements[index], index === 0)
    const line = cursor + (trimmed.leading?.length ?? 0) + 1
    cursor = line
    statements.push(withLine(trimmed, line))
  }

  const trailing = normalizeTrailing(workflow.trailing, statements.length === 0)
  const next: Workflow = { ...workflow, statements }
  return trailing === undefined ? omitTrailing(next) : { ...next, trailing }
}

/** Statement and steps renumbered, reusing the objects that already agree. */
function withLine(statement: WorkflowStatement, line: number): WorkflowStatement {
  if (statement.line === line && statement.steps.every((step) => step.line === line)) {
    return statement
  }
  return {
    ...statement,
    line,
    steps: statement.steps.map((step) => (step.line === line ? step : { ...step, line }))
  }
}

function withTrivia(statement: WorkflowStatement, first: boolean): WorkflowStatement {
  const leading = statement.leading
  if (leading === undefined) return statement
  const kept = first ? dropLeadingBlanks(leading) : leading
  if (kept.length === 0) return omitLeading(statement)
  if (kept.length === leading.length) return statement
  return { ...statement, leading: kept }
}

function normalizeTrailing(
  trailing: readonly string[] | undefined,
  bodyStart: boolean
): string[] | undefined {
  if (trailing === undefined) return undefined
  const lines = bodyStart ? dropLeadingBlanks(trailing) : [...trailing]
  // Trailing blanks are an artifact of the file's final newline, not authorship;
  // the parser pops them, so keeping one would grow a blank line per save.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length === 0 ? undefined : lines
}

function dropLeadingBlanks(lines: readonly string[]): string[] {
  let start = 0
  while (start < lines.length && lines[start] === '') start += 1
  return lines.slice(start)
}

/* -------------------------------------------------------------------------- */
/*  The guarantee                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an edit and hand it back only if it survives a save.
 *
 * Every exported operation ends here, so the module's invariant is enforced
 * rather than merely intended. The check is a real save and a real read: the
 * result is serialized, parsed, and compared to itself. If the two disagree, the
 * edit is dropped and the workflow the caller passed in comes back unchanged.
 *
 * That is the right failure. The alternatives are to write a file that says
 * something other than what the canvas shows, or to hand back whatever the file
 * happened to mean, which turns one bad character in a text box into a statement
 * the user never wrote. Refusing costs a gesture; the other two cost the
 * document.
 *
 * The parse it costs is a parse of one small file, on a keystroke a human made.
 */
function commit(before: Workflow, draft: Workflow): Workflow {
  const next = normalize(draft)
  const reparsed = parseWorkflow(serializeWorkflow(next), next.id).workflow
  if (!sameWorkflow(reparsed, next)) return before
  // An edit that changed nothing returns the original reference, so a caller
  // memoizing on identity does not re-render a canvas that did not move.
  return sameWorkflow(before, next) ? before : next
}

/* -------------------------------------------------------------------------- */
/*  Structural equality                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deep equality over the `Workflow` contract, matching what the tests assert.
 *
 * Written out rather than reached for from a library because it has to be at
 * least as strict as the test's `toEqual` on exactly the distinctions that
 * matter here: an absent `leading` is NOT an empty one, and key order in `args`
 * is not a difference.
 */
function sameWorkflow(a: Workflow, b: Workflow): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.key === b.key &&
    sameTrigger(a.trigger, b.trigger) &&
    sameStrings(a.meta, b.meta) &&
    sameLines(a.trailing, b.trailing) &&
    a.statements.length === b.statements.length &&
    a.statements.every((statement, index) => sameStatement(statement, b.statements[index]))
  )
}

function sameTrigger(a: WorkflowTrigger, b: WorkflowTrigger): boolean {
  if (a.type === 'event') return b.type === 'event' && a.event === b.event && a.where === b.where
  if (a.type === 'schedule') return b.type === 'schedule' && a.cron === b.cron
  return b.type === 'manual'
}

function sameStatement(a: WorkflowStatement, b: WorkflowStatement): boolean {
  return (
    a.name === b.name &&
    a.input === b.input &&
    a.line === b.line &&
    sameLines(a.leading, b.leading) &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => sameStep(step, b.steps[index]))
  )
}

function sameStep(a: WorkflowStep, b: WorkflowStep): boolean {
  return a.kind === b.kind && a.line === b.line && sameArgs(a.args, b.args)
}

function sameArgs(a: Record<string, ArgValue>, b: Record<string, ArgValue>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

function sameStrings(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

function sameLines(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((line, index) => line === b[index])
}
