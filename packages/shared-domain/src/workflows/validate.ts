// Static analysis over a parsed Workflow: everything knowable about a workflow
// without reading a single note.
//
// The split with the parser is deliberate. `parse` reports what it could not
// read on one line (a stray token, a missing argument, a bad duration); this
// file reports what does not hold together *across* lines (a wire nobody
// defines, two statements that feed each other forever, a `render` with nothing
// downstream to receive its text). The canvas shows the concatenation of both,
// so neither side has to know about the other.
//
// Three invariants worth stating out loud:
//
//   1. Nothing here throws and nothing here stops at the first problem. A
//      workflow with one broken step must still surface every other problem,
//      otherwise fixing a file turns into whack-a-mole: repair one line, run
//      again, discover the next.
//   2. The call-graph check is the entire reason `call` is safe to allow at
//      all. A workflow that reaches itself, directly or through a chain, is
//      caught here before anything runs. `PlanContext.maxDepth` is the dynamic
//      half of the same guard, for the case where the set of workflows on disk
//      changes between validating and running.
//   3. Checks read the node registry rather than hard-coding kinds. Which steps
//      are sources, which end a pipeline, which consume rendered text: all of
//      it comes from `NODE_DEFS`, so a new node is validated correctly the day
//      it is added and the hint messages stay true.
//
// Diagnostics come back sorted by line, then errors before warnings, so callers
// can render them in file order without sorting again.

import type { ParamType } from './nodes'
import { NODE_DEFS, nodeDef } from './nodes'
import type { Diagnostic, Workflow, WorkflowStatement, WorkflowStep } from './types'

/* -------------------------------------------------------------------------- */
/*  Internals                                                                  */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1 }

/**
 * Kinds that can receive the text a `render` produces. Derived from the
 * registry so the hint in the diagnostic never drifts from what actually works.
 */
const TEXT_SINK_KINDS = NODE_DEFS.filter((def) => def.consumesText).map((def) => def.kind)

interface WireDefinition {
  statementIndex: number
  line: number
}

/**
 * What one statement does, computed while walking its steps and reused by the
 * dead-wire check so the steps are only classified once.
 */
interface StatementFacts {
  mutates: boolean
  terminates: boolean
  /**
   * True when a step kind was not in the registry. An unrecognized step could
   * do anything, so it silences the "this computes nothing" warnings rather
   * than stacking a guess on top of a real error.
   */
  unknown: boolean
}

const error = (line: number, message: string): Diagnostic => ({ severity: 'error', message, line })

const warning = (line: number, message: string): Diagnostic => ({
  severity: 'warning',
  message,
  line
})

/**
 * Every argument of `step` declared with the given param type.
 *
 * Wire and workflow references are found this way instead of by matching on
 * `union`/`subtract`/`call`, so a future node taking a wire is checked without
 * anyone remembering to come back here.
 */
function argRefs(step: WorkflowStep, type: ParamType): string[] {
  const def = nodeDef(step.kind)
  if (!def) return []
  const refs: string[] = []
  for (const spec of def.params) {
    if (spec.type !== type) continue
    const value = step.args[spec.name]
    if (typeof value === 'string' && value !== '') refs.push(value)
  }
  return refs
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Check a parsed workflow and return every problem found, worst first per line.
 *
 * `others` is the rest of the vault's workflows keyed by id. Pass it to get the
 * cross-workflow checks (unknown `call` target, circular calls); omit it when
 * validating a file in isolation, where those questions cannot be answered and
 * guessing at them would flag a perfectly good workflow.
 */
export interface ValidateOptions {
  /**
   * Severity for a `call` naming a workflow this vault does not have.
   *
   * An error for a workflow you already own: it is broken and you want to
   * know. A warning when REVIEWING AN IMPORT, because "this vault does not
   * have it" is the normal state of a community workflow that ships as a set,
   * and refusing the whole file walls those off entirely. The imported file
   * lands as a draft, which cannot run, so the unresolved call is a thing to
   * fix rather than a hazard to block.
   */
  unknownCall?: Diagnostic['severity']
}

export function validateWorkflow(
  workflow: Workflow,
  others?: Map<string, Workflow>,
  options?: ValidateOptions
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  const wires = collectWires(workflow, diagnostics)
  const facts = workflow.statements.map((statement) =>
    checkStatement(statement, wires, diagnostics)
  )

  checkWireCycles(workflow, wires, diagnostics)
  if (others) checkCallGraph(workflow, others, diagnostics, options?.unknownCall ?? 'error')
  checkDeadWires(workflow, wires, facts, diagnostics)

  return finalize(diagnostics)
}

/* -------------------------------------------------------------------------- */
/*  Wire table                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Index the wires a workflow defines, reporting redefinitions (rule 3).
 *
 * The first definition wins so that later checks have one stable answer for
 * "where does `good` come from", which is also what a reader assumes.
 */
function collectWires(workflow: Workflow, out: Diagnostic[]): Map<string, WireDefinition> {
  const wires = new Map<string, WireDefinition>()
  workflow.statements.forEach((statement, statementIndex) => {
    const name = statement.name
    if (name === null) return
    const existing = wires.get(name)
    if (existing) {
      const message = `duplicate wire \`${name}\`, already defined on line ${existing.line}`
      out.push(error(statement.line, message))
      return
    }
    wires.set(name, { statementIndex, line: statement.line })
  })
  return wires
}

/* -------------------------------------------------------------------------- */
/*  Per-statement checks                                                      */
/* -------------------------------------------------------------------------- */

function checkStatement(
  statement: WorkflowStatement,
  wires: Map<string, WireDefinition>,
  out: Diagnostic[]
): StatementFacts {
  const facts: StatementFacts = { mutates: false, terminates: false, unknown: false }

  // Rule 2, the wire this pipeline reads from. A wire defined further down the
  // file is fine: order of definition is not order of execution, and a genuine
  // loop is caught by the cycle check rather than by pretending it is unknown.
  if (statement.input !== null && !wires.has(statement.input)) {
    out.push(
      error(statement.line, `\`${statement.input}\` is not a wire defined in this workflow`)
    )
  }

  const steps = statement.steps
  let firstTerminal = -1

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const def = nodeDef(step.kind)

    // Rule 1.
    if (!def) {
      facts.unknown = true
      out.push(error(step.line, `\`${step.kind}\` is not a known step`))
      continue
    }

    if (def.mutating) facts.mutates = true

    // Rule 2 again, this time for `union`/`subtract` style arguments.
    for (const ref of argRefs(step, 'wire')) {
      if (wires.has(ref)) continue
      out.push(
        error(
          step.line,
          `\`${def.kind}\` refers to \`${ref}\`, which is not a wire defined in this workflow`
        )
      )
    }

    // Rule 7. A source manufactures a NoteSet, so anything feeding it is input
    // that would be silently thrown away.
    if (def.source) {
      if (index > 0) {
        out.push(error(step.line, `\`${def.kind}\` is a source, so it can only start a pipeline`))
      } else if (statement.input !== null) {
        out.push(
          error(
            step.line,
            `\`${def.kind}\` is a source, so it cannot read from wire \`${statement.input}\``
          )
        )
      }
    }

    // Rule 8.
    if (def.terminal) {
      if (firstTerminal === -1) firstTerminal = index
      if (index !== steps.length - 1) {
        out.push(error(step.line, `\`${def.kind}\` ends a pipeline, so it must be the last step`))
      }
    }

    // Rule 10. `render` exists only to feed a sink; on its own it computes text
    // and drops it.
    if (def.producesText && !hasTextSinkAfter(steps, index)) {
      const sinks = TEXT_SINK_KINDS.join(', ')
      out.push(
        error(
          step.line,
          `\`${def.kind}\` produces text that nothing consumes: follow it with ${sinks}`
        )
      )
    }
  }

  facts.terminates = firstTerminal !== -1

  // Rule 9. Only the first orphaned step is named: once the pipeline is known
  // to be over, listing every straggler adds noise, not information.
  if (firstTerminal !== -1 && firstTerminal + 1 < steps.length) {
    const stranded = steps[firstTerminal + 1]
    const ender = steps[firstTerminal].kind
    out.push(
      error(
        stranded.line,
        `\`${stranded.kind}\` cannot run after \`${ender}\`, which ends the pipeline`
      )
    )
  }

  // Rule 11.
  if (statement.name === null && !facts.terminates && !facts.mutates && !facts.unknown) {
    const message = 'this pipeline has no name and no output, so nothing reads its result'
    out.push(warning(statement.line, message))
  }

  return facts
}

function hasTextSinkAfter(steps: WorkflowStep[], index: number): boolean {
  for (let i = index + 1; i < steps.length; i++) {
    if (nodeDef(steps[i].kind)?.consumesText) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/*  Rule 4: cycles in the wire graph                                          */
/* -------------------------------------------------------------------------- */

/**
 * Walk wire dependencies looking for a wire that reaches itself.
 *
 * Edges point from a wire to the wires it reads, so the reported path reads the
 * way the file does: `a -> b -> a` means "a is built from b, which is built
 * from a". One cycle is reported per group of mutually reachable wires. Listing
 * every distinct cycle is exponential and, for a human fixing a file, one
 * concrete loop is what they need to break the knot.
 */
function checkWireCycles(
  workflow: Workflow,
  wires: Map<string, WireDefinition>,
  out: Diagnostic[]
): void {
  const deps = new Map<string, string[]>()
  for (const [name, wire] of wires) {
    const statement = workflow.statements[wire.statementIndex]
    const list: string[] = []
    if (statement.input !== null && wires.has(statement.input)) list.push(statement.input)
    for (const step of statement.steps) {
      for (const ref of argRefs(step, 'wire')) {
        if (wires.has(ref)) list.push(ref)
      }
    }
    deps.set(name, list)
  }

  const settled = new Set<string>()
  const stack: string[] = []
  const reported = new Set<string>()

  const walk = (name: string): void => {
    const at = stack.indexOf(name)
    if (at !== -1) {
      const cycle = canonicalCycle(stack.slice(at), wires)
      const message = `circular wires: ${cycle.join(' -> ')}`
      if (!reported.has(message)) {
        reported.add(message)
        out.push(error(wires.get(cycle[0])?.line ?? 0, message))
      }
      return
    }
    if (settled.has(name)) return
    stack.push(name)
    for (const dep of deps.get(name) ?? []) walk(dep)
    stack.pop()
    settled.add(name)
  }

  for (const name of wires.keys()) walk(name)
}

/**
 * Rotate a cycle so it begins at its earliest-defined wire.
 *
 * `a -> b -> a` and `b -> a -> b` are the same defect, and which one a depth
 * first search happens to find depends on where it started. Anchoring on the
 * first line of the file makes the message stable and points the reader at the
 * line they would naturally read first.
 */
function canonicalCycle(ring: string[], wires: Map<string, WireDefinition>): string[] {
  let startAt = 0
  for (let i = 1; i < ring.length; i++) {
    if (compareWires(ring[i], ring[startAt], wires) < 0) startAt = i
  }
  const rotated = [...ring.slice(startAt), ...ring.slice(0, startAt)]
  return [...rotated, rotated[0]]
}

function compareWires(a: string, b: string, wires: Map<string, WireDefinition>): number {
  const lineA = wires.get(a)?.line ?? 0
  const lineB = wires.get(b)?.line ?? 0
  if (lineA !== lineB) return lineA - lineB
  if (a === b) return 0
  return a < b ? -1 : 1
}

/* -------------------------------------------------------------------------- */
/*  Rules 5 and 6: the call graph                                             */
/* -------------------------------------------------------------------------- */

/**
 * Check every `call` in this workflow against the rest of the vault.
 *
 * A workflow may legitimately call itself by id if the id is not in `others`
 * (the file being edited is usually excluded from the map it is validated
 * against), so the workflow under validation resolves first. That way a
 * self-call is reported as the cycle it is rather than as a missing workflow.
 */
function checkCallGraph(
  workflow: Workflow,
  others: Map<string, Workflow>,
  out: Diagnostic[],
  unknownCall: Diagnostic['severity']
): void {
  const resolve = (id: string): Workflow | null =>
    id === workflow.id ? workflow : (others.get(id) ?? null)

  for (const statement of workflow.statements) {
    for (const step of statement.steps) {
      for (const target of argRefs(step, 'workflow')) {
        // Rule 6.
        const resolved = resolve(target)
        if (!resolved) {
          out.push({
            severity: unknownCall,
            line: step.line,
            message: `\`${step.kind}\` refers to \`${target}\`, which is not a workflow in this vault`
          })
          continue
        }
        // A draft child is skipped at run time (the engine enforces it), so say
        // so while the author is looking at the line. A warning rather than an
        // error: the file is structurally fine, and the child being a draft is
        // a state someone flips, not a defect in this workflow. Self-calls are
        // exempt because rule 5 already reports them as the cycle they are.
        if (target !== workflow.id && resolved.status === 'draft') {
          out.push(
            warning(
              step.line,
              `\`${target}\` is a draft, so \`${step.kind}\` will skip it until it is activated`
            )
          )
        }
        // Rule 5.
        const cycle = findCallCycle(workflow, target, resolve)
        if (cycle) {
          out.push(error(step.line, `circular workflow calls: ${cycle.join(' -> ')}`))
        }
      }
    }
  }
}

/**
 * Depth first search from one `call` target, returning the loop it closes.
 *
 * The search starts with this workflow already on the path, so a chain that
 * comes back here is caught, and so is a loop that lives entirely downstream
 * (`a` calls `b`, `b` calls `c`, `c` calls `b`): reaching it from here would
 * still hang a run, so it is this workflow's problem too. Unresolvable ids stop
 * the walk quietly because rule 6 already reported the ones written here, and a
 * dangling call inside someone else's file belongs in that file's diagnostics.
 */
function findCallCycle(
  root: Workflow,
  target: string,
  resolve: (id: string) => Workflow | null
): string[] | null {
  const path: string[] = [root.id]
  const settled = new Set<string>()

  const walk = (id: string): string[] | null => {
    const at = path.indexOf(id)
    if (at !== -1) return [...path.slice(at), id]
    if (settled.has(id)) return null

    const workflow = resolve(id)
    if (!workflow) return null

    path.push(id)
    for (const statement of workflow.statements) {
      for (const step of statement.steps) {
        for (const next of argRefs(step, 'workflow')) {
          const cycle = walk(next)
          if (cycle) return cycle
        }
      }
    }
    path.pop()
    settled.add(id)
    return null
  }

  return walk(target)
}

/* -------------------------------------------------------------------------- */
/*  Rule 12: wires nobody reads                                               */
/* -------------------------------------------------------------------------- */

/**
 * Warn about a named wire that neither writes anything nor feeds another
 * statement. Naming a wire is how you say "something downstream wants this", so
 * a name with no reader is almost always an unfinished edit or a typo in the
 * reader's spelling.
 */
function checkDeadWires(
  workflow: Workflow,
  wires: Map<string, WireDefinition>,
  facts: StatementFacts[],
  out: Diagnostic[]
): void {
  for (const [name, wire] of wires) {
    const fact = facts[wire.statementIndex]
    if (!fact || fact.unknown || fact.mutates || fact.terminates) continue
    if (isReadElsewhere(workflow, name, wire.statementIndex)) continue
    out.push(warning(wire.line, `wire \`${name}\` is never read and its pipeline changes nothing`))
  }
}

/**
 * True when some *other* statement consumes `name`. A statement referring to
 * its own wire is a cycle, not a reader, and counting it would hide the
 * dead-wire warning behind the very defect that caused it.
 */
function isReadElsewhere(workflow: Workflow, name: string, definedAt: number): boolean {
  return workflow.statements.some((statement, index) => {
    if (index === definedAt) return false
    if (statement.input === name) return true
    return statement.steps.some((step) => argRefs(step, 'wire').includes(name))
  })
}

/* -------------------------------------------------------------------------- */
/*  Ordering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drop exact repeats and sort by line, errors first.
 *
 * Repeats are possible because two `call` steps on one line can lead into the
 * same cycle, and a duplicate says nothing new. Sort is stable in every engine
 * we target, so diagnostics that tie on line and severity keep the order they
 * were found in, which is the order they appear in the statement.
 */
function finalize(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const unique: Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.line}\x00${diagnostic.severity}\x00${diagnostic.message}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(diagnostic)
  }
  return unique.sort(
    (a, b) => a.line - b.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}
