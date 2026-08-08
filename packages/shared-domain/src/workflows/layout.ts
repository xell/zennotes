// Deterministic graph layout for workflows.
//
// Positions are COMPUTED here and never stored in the file. That is the whole
// reason the canvas has no dragging: there is nowhere to persist a hand-placed
// node, so the `.md` text and the graph stay lossless projections of each other
// and a round-trip through either one cannot lose information.
//
// The algorithm is deliberately boring: a node's column is the longest path
// from a source (so a node always sits to the right of everything feeding it)
// and its row is arrival order within that column (so a statement written first
// stays on top). `layoutWorkflow` is a pure function of the parsed `Workflow`,
// which is what lets a renderer swap in dagre or elkjs later without any caller
// moving.
//
// Two invariants keep it total, i.e. it never throws and never drops a node:
//
//   1. An unresolved wire reference produces no edge rather than an error, so a
//      half-written workflow still lays out and the canvas can mark the step
//      red in place. `validate` is what reports the problem, not layout.
//   2. A wire cycle (`a = b | ...` next to `b = a | ...`) is rejected by
//      `validate`, but the editor lays out every keystroke, including the
//      keystroke that momentarily creates one. The longest-path walk therefore
//      ignores back edges instead of chasing them, so it terminates on any
//      input at all.

import { nodeDef } from './nodes'
import type { Workflow, WorkflowStep } from './types'

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

export interface LayoutNode {
  /** `${statement}:${step}`, the id shared with the engine and the canvas. */
  id: string
  statement: number
  step: number
  /** Registry key of the step, so the canvas can pick an icon without a lookup. */
  kind: string
  /** Longest path from a source. Grid position, not pixels. */
  column: number
  /** Position within the column, top to bottom. */
  row: number
}

export interface LayoutEdge {
  from: string
  to: string
  /**
   * Wire name for a cross-statement edge, null for two steps inside one
   * pipeline. Null is what tells the canvas to draw a plain connector rather
   * than a labelled wire with a note count on it.
   */
  wire: string | null
}

export interface WorkflowLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
}

/** Canonical node id. Kept as a function so the format has exactly one author. */
export function stepId(statementIndex: number, stepIndex: number): string {
  return `${statementIndex}:${stepIndex}`
}

/* -------------------------------------------------------------------------- */
/*  Wire references                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wires a step reads on top of the one flowing into its pipeline, e.g. the
 * `other` in `union other`.
 *
 * Read off the registry (any param declared `type: 'wire'`) instead of
 * hardcoding `union` and `subtract`, so a future combining node wires itself up
 * on the canvas the moment it is added to `NODE_DEFS`, same as the parser.
 */
function referencedWires(step: WorkflowStep): string[] {
  const def = nodeDef(step.kind)
  if (!def) return []
  const wires: string[] = []
  for (const param of def.params) {
    if (param.type !== 'wire') continue
    const value = step.args[param.name]
    if (typeof value === 'string' && value !== '') wires.push(value)
  }
  return wires
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

const WHITE = 0
const GRAY = 1
const BLACK = 2

export function layoutWorkflow(workflow: Workflow): WorkflowLayout {
  const statements = workflow.statements

  // One node per step, built in source order. Everything downstream (rows, edge
  // order, the returned arrays) inherits that order, which is what makes the
  // whole function byte-stable for a given workflow.
  const nodes: LayoutNode[] = []
  const indexById = new Map<string, number>()
  for (let s = 0; s < statements.length; s++) {
    const steps = statements[s].steps
    for (let p = 0; p < steps.length; p++) {
      const id = stepId(s, p)
      indexById.set(id, nodes.length)
      nodes.push({ id, statement: s, step: p, kind: steps[p].kind, column: 0, row: 0 })
    }
  }

  const edges: LayoutEdge[] = []
  const seenEdges = new Set<string>()
  const addEdge = (from: string, to: string, wire: string | null): void => {
    // `m = a | union a` names the same wire twice; the canvas wants one line.
    const key = `${from}\x00${to}\x00${wire ?? ''}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    edges.push({ from, to, wire })
  }

  // Steps inside one pipeline: unlabelled, because the value between them never
  // had a name the user could have written down.
  for (let s = 0; s < statements.length; s++) {
    const steps = statements[s].steps
    for (let p = 1; p < steps.length; p++) {
      addEdge(stepId(s, p - 1), stepId(s, p), null)
    }
  }

  // Every statement that names a wire, in source order.
  const definitions = new Map<string, number[]>()
  for (let s = 0; s < statements.length; s++) {
    const name = statements[s].name
    if (name === null || name === '') continue
    const existing = definitions.get(name)
    if (existing) existing.push(s)
    else definitions.set(name, [s])
  }

  /**
   * Which statement a reference to `wire` from statement `from` reads.
   *
   * Nearest definition ABOVE wins, matching how the file reads top to bottom
   * when a name is reused. A reference with nothing above it falls back to the
   * nearest definition below so the canvas still draws the edge the author
   * clearly meant; `validate` is the thing that complains about the forward
   * reference. A statement never resolves to itself, so `a = a | limit 1` draws
   * no self-loop.
   */
  const producerOf = (wire: string, from: number): number | null => {
    const indices = definitions.get(wire)
    if (!indices) return null
    let above: number | null = null
    for (const index of indices) {
      if (index < from) above = index
    }
    if (above !== null) return above
    for (const index of indices) {
      if (index > from) return index
    }
    return null
  }

  /**
   * The node an edge out of statement `index` leaves from: its last step.
   *
   * A pass-through statement (`archived = old`, which renames a wire without
   * performing an operation) has no steps at all, so the edge is forwarded to
   * whatever actually produced the set. Without that, renaming a wire would
   * silently cut the graph in two. The `seen` guard is for the pathological
   * case where those renames form a ring.
   */
  const outputAnchor = (index: number): string | null => {
    const seen = new Set<number>()
    let at = index
    while (!seen.has(at)) {
      seen.add(at)
      const statement = statements[at]
      if (statement.steps.length > 0) return stepId(at, statement.steps.length - 1)
      if (statement.input === null || statement.input === '') return null
      const next = producerOf(statement.input, at)
      if (next === null) return null
      at = next
    }
    return null
  }

  // Cross-statement edges: producer's last step to the consumer's FIRST step,
  // including for `union`/`subtract` args. Pointing at the first step rather
  // than at the combining step is what keeps the consumer's whole pipeline to
  // the right of every wire it reads.
  for (let s = 0; s < statements.length; s++) {
    const statement = statements[s]
    if (statement.steps.length === 0) continue
    const to = stepId(s, 0)
    const wires: string[] = []
    if (statement.input !== null && statement.input !== '') wires.push(statement.input)
    for (const step of statement.steps) wires.push(...referencedWires(step))
    for (const wire of wires) {
      const producer = producerOf(wire, s)
      if (producer === null) continue
      const from = outputAnchor(producer)
      // `from === to` means a ring of pass-through renames walked back to this
      // very statement. Drawing that self-loop would help nobody.
      if (from === null || from === to) continue
      addEdge(from, to, wire)
    }
  }

  assignColumns(nodes, edges, indexById)

  // Rows: arrival order inside a column. Because `nodes` is in statement order,
  // an early statement keeps the top row, so editing line 9 cannot make line 1
  // jump around on the canvas.
  const nextRow = new Map<number, number>()
  for (const node of nodes) {
    const row = nextRow.get(node.column) ?? 0
    node.row = row
    nextRow.set(node.column, row + 1)
  }

  return { nodes, edges }
}

/**
 * Column = longest path from any source, computed by DFS over predecessors.
 *
 * Iterative rather than recursive because a workflow is user input and a
 * thousand-step chain should lay out, not blow the stack. A predecessor still
 * on the DFS path (GRAY) is a back edge, i.e. part of a cycle `validate`
 * rejects; it contributes nothing, which both terminates the walk and leaves
 * every node with a defined column.
 */
function assignColumns(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  indexById: Map<string, number>
): void {
  const predecessors: number[][] = nodes.map(() => [])
  for (const edge of edges) {
    const from = indexById.get(edge.from)
    const to = indexById.get(edge.to)
    if (from === undefined || to === undefined) continue
    predecessors[to].push(from)
  }

  const state = new Uint8Array(nodes.length)
  const columns = new Int32Array(nodes.length)

  for (let start = 0; start < nodes.length; start++) {
    if (state[start] !== WHITE) continue
    const stack: number[] = [start]
    while (stack.length > 0) {
      const current = stack[stack.length - 1]
      if (state[current] === WHITE) {
        state[current] = GRAY
        for (const predecessor of predecessors[current]) {
          if (state[predecessor] === WHITE) stack.push(predecessor)
        }
        continue
      }
      stack.pop()
      // Already finished via another branch of the walk.
      if (state[current] === BLACK) continue
      let column = 0
      for (const predecessor of predecessors[current]) {
        if (state[predecessor] !== BLACK) continue
        const candidate = columns[predecessor] + 1
        if (candidate > column) column = candidate
      }
      columns[current] = column
      state[current] = BLACK
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    nodes[i].column = columns[i]
  }
}
