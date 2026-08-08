import { describe, expect, it } from 'vitest'
import { layoutWorkflow, stepId } from './layout'
import type { LayoutNode } from './layout'
import type { ArgValue, Workflow, WorkflowStatement, WorkflowStep } from './types'

// Fixtures are built by hand rather than parsed, so a change in the parser can
// never quietly change what these tests are asserting about layout.

const step = (kind: string, args: Record<string, ArgValue> = {}, line = 1): WorkflowStep => ({
  kind,
  args,
  line
})

const statement = (
  name: string | null,
  input: string | null,
  steps: WorkflowStep[],
  line = 1
): WorkflowStatement => ({ name, input, steps, line })

const workflow = (statements: WorkflowStatement[]): Workflow => ({
  id: 'fixture',
  name: 'Fixture',
  description: '',
  trigger: { type: 'manual' },
  status: 'active',
  statements,
  meta: {}
})

const at = (nodes: LayoutNode[], id: string): LayoutNode => {
  const found = nodes.find((node) => node.id === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

const columnOf = (nodes: LayoutNode[], id: string): number => at(nodes, id).column

describe('stepId', () => {
  it('formats the id shared with the engine and the canvas', () => {
    expect(stepId(0, 0)).toBe('0:0')
    expect(stepId(3, 12)).toBe('3:12')
  })
})

describe('layoutWorkflow', () => {
  it('lays out an empty workflow', () => {
    const layout = layoutWorkflow(workflow([]))
    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
  })

  it('puts a lone step at the origin', () => {
    const layout = layoutWorkflow(
      workflow([statement('books', null, [step('tag', { tag: 'book' })])])
    )
    expect(layout.nodes).toEqual([
      { id: '0:0', statement: 0, step: 0, kind: 'tag', column: 0, row: 0 }
    ])
    expect(layout.edges).toEqual([])
  })

  it('walks a pipeline left to right on one row', () => {
    const layout = layoutWorkflow(
      workflow([
        statement(null, null, [
          step('tag', { tag: 'book' }),
          step('where', { field: 'rating', op: '>=', value: '4' }),
          step('sort', { field: 'finished', direction: 'desc' }),
          step('limit', { count: 5 })
        ])
      ])
    )
    expect(layout.nodes.map((node) => node.column)).toEqual([0, 1, 2, 3])
    expect(layout.nodes.map((node) => node.row)).toEqual([0, 0, 0, 0])
  })

  it('links consecutive steps with an unlabelled edge', () => {
    const layout = layoutWorkflow(
      workflow([statement(null, null, [step('all'), step('dedupe'), step('limit', { count: 1 })])])
    )
    expect(layout.edges).toEqual([
      { from: '0:0', to: '0:1', wire: null },
      { from: '0:1', to: '0:2', wire: null }
    ])
  })

  it('terminates on a long chain without blowing the stack', () => {
    const steps = [step('all')]
    for (let i = 0; i < 499; i++) steps.push(step('dedupe'))
    const layout = layoutWorkflow(workflow([statement(null, null, steps)]))
    expect(layout.nodes).toHaveLength(500)
    expect(columnOf(layout.nodes, '0:499')).toBe(499)
    expect(layout.edges).toHaveLength(499)
  })

  it('stacks independent statements into rows of the same column', () => {
    const layout = layoutWorkflow(
      workflow([
        statement(null, null, [step('tag', { tag: 'book' }), step('dedupe')], 1),
        statement(null, null, [step('tag', { tag: 'film' }), step('dedupe')], 2),
        statement(null, null, [step('all')], 3)
      ])
    )
    expect(at(layout.nodes, '0:0')).toMatchObject({ column: 0, row: 0 })
    expect(at(layout.nodes, '1:0')).toMatchObject({ column: 0, row: 1 })
    expect(at(layout.nodes, '2:0')).toMatchObject({ column: 0, row: 2 })
    expect(at(layout.nodes, '0:1')).toMatchObject({ column: 1, row: 0 })
    expect(at(layout.nodes, '1:1')).toMatchObject({ column: 1, row: 1 })
  })

  it('connects a named wire to the first step of its consumer', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('books', null, [step('tag', { tag: 'book' }), step('dedupe')], 1),
        statement(null, 'books', [step('add-tag', { tag: 'starred' })], 2)
      ])
    )
    expect(layout.edges).toContainEqual({ from: '0:1', to: '1:0', wire: 'books' })
    expect(columnOf(layout.nodes, '1:0')).toBe(2)
  })

  it('fans one wire out to three statements', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('books', null, [step('tag', { tag: 'book' })], 1),
        statement('good', 'books', [step('where', { field: 'rating', op: '>=', value: '4' })], 2),
        statement('bad', 'books', [step('where', { field: 'rating', op: '<', value: '2' })], 3),
        statement(null, 'books', [step('add-tag', { tag: 'seen' })], 4)
      ])
    )
    const wireEdges = layout.edges.filter((edge) => edge.wire === 'books')
    expect(wireEdges).toEqual([
      { from: '0:0', to: '1:0', wire: 'books' },
      { from: '0:0', to: '2:0', wire: 'books' },
      { from: '0:0', to: '3:0', wire: 'books' }
    ])
    expect(at(layout.nodes, '1:0')).toMatchObject({ column: 1, row: 0 })
    expect(at(layout.nodes, '2:0')).toMatchObject({ column: 1, row: 1 })
    expect(at(layout.nodes, '3:0')).toMatchObject({ column: 1, row: 2 })
  })

  it('fans two wires into a union', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('a', null, [step('tag', { tag: 'book' })], 1),
        statement('b', null, [step('tag', { tag: 'film' })], 2),
        statement('both', 'a', [step('union', { wire: 'b' }), step('dedupe')], 3)
      ])
    )
    expect(layout.edges).toContainEqual({ from: '0:0', to: '2:0', wire: 'a' })
    expect(layout.edges).toContainEqual({ from: '1:0', to: '2:0', wire: 'b' })
    expect(columnOf(layout.nodes, '2:0')).toBe(1)
    expect(columnOf(layout.nodes, '2:1')).toBe(2)
  })

  it('points a union edge at the statement it joins, not at the union step', () => {
    // The wire feeds the whole pipeline, so the edge lands on its first step.
    // That is what keeps every step of the consumer right of the wire it reads.
    const layout = layoutWorkflow(
      workflow([
        statement('extra', null, [step('tag', { tag: 'film' })], 1),
        statement(null, null, [step('all'), step('union', { wire: 'extra' })], 2)
      ])
    )
    expect(layout.edges).toContainEqual({ from: '0:0', to: '1:0', wire: 'extra' })
    expect(columnOf(layout.nodes, '1:0')).toBe(1)
    expect(columnOf(layout.nodes, '1:1')).toBe(2)
  })

  it('finds wire args through the registry, so subtract works too', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('done', null, [step('tag', { tag: 'done' })], 1),
        statement(null, null, [step('all'), step('subtract', { wire: 'done' })], 2)
      ])
    )
    expect(layout.edges).toContainEqual({ from: '0:0', to: '1:0', wire: 'done' })
  })

  it('lays out a statement whose input wire does not exist', () => {
    const layout = layoutWorkflow(
      workflow([statement(null, 'ghost', [step('add-tag', { tag: 'x' }), step('dedupe')])])
    )
    expect(layout.nodes).toHaveLength(2)
    expect(columnOf(layout.nodes, '0:0')).toBe(0)
    expect(layout.edges).toEqual([{ from: '0:0', to: '0:1', wire: null }])
  })

  it('keeps a node for an unknown step kind and reads no wires off it', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('a', null, [step('tag', { tag: 'book' })], 1),
        statement(null, null, [step('teleport', { wire: 'a' })], 2)
      ])
    )
    expect(layout.nodes).toHaveLength(2)
    expect(at(layout.nodes, '1:0').kind).toBe('teleport')
    expect(layout.edges).toEqual([])
  })

  it('terminates on a wire cycle and keeps every node', () => {
    // `validate` rejects this, but the editor lays out the keystroke that makes it.
    const layout = layoutWorkflow(
      workflow([
        statement('a', 'b', [step('limit', { count: 1 })], 1),
        statement('b', 'a', [step('limit', { count: 2 })], 2)
      ])
    )
    expect(layout.nodes.map((node) => node.id)).toEqual(['0:0', '1:0'])
    expect(layout.edges).toEqual([
      { from: '1:0', to: '0:0', wire: 'b' },
      { from: '0:0', to: '1:0', wire: 'a' }
    ])
    for (const node of layout.nodes) expect(Number.isInteger(node.column)).toBe(true)
  })

  it('draws no self loop for a statement that reads its own wire', () => {
    const layout = layoutWorkflow(
      workflow([statement('a', 'a', [step('limit', { count: 1 }), step('dedupe')])])
    )
    expect(layout.edges).toEqual([{ from: '0:0', to: '0:1', wire: null }])
    expect(columnOf(layout.nodes, '0:0')).toBe(0)
  })

  it('resolves a reused wire name to the nearest definition above', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('list', null, [step('tag', { tag: 'book' })], 1),
        statement('list', null, [step('tag', { tag: 'film' })], 2),
        statement(null, 'list', [step('add-tag', { tag: 'seen' })], 3)
      ])
    )
    expect(layout.edges).toEqual([{ from: '1:0', to: '2:0', wire: 'list' }])
  })

  it('resolves a forward reference to the definition below it', () => {
    const layout = layoutWorkflow(
      workflow([
        statement(null, 'later', [step('add-tag', { tag: 'seen' })], 1),
        statement('later', null, [step('tag', { tag: 'book' }), step('dedupe')], 2)
      ])
    )
    expect(layout.edges).toContainEqual({ from: '1:1', to: '0:0', wire: 'later' })
    expect(columnOf(layout.nodes, '0:0')).toBe(2)
  })

  it('forwards an edge through a pass-through rename', () => {
    // `archived = old` produces a wire without producing a node, so the edge has
    // to land on whatever actually built the set.
    const layout = layoutWorkflow(
      workflow([
        statement('old', null, [step('tag', { tag: 'book' }), step('dedupe')], 1),
        statement('archived', 'old', [], 2),
        statement(null, 'archived', [step('archive')], 3)
      ])
    )
    expect(layout.nodes.map((node) => node.id)).toEqual(['0:0', '0:1', '2:0'])
    expect(layout.edges).toContainEqual({ from: '0:1', to: '2:0', wire: 'archived' })
    expect(columnOf(layout.nodes, '2:0')).toBe(2)
  })

  it('survives a ring of pass-through renames', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('a', 'b', [], 1),
        statement('b', 'a', [], 2),
        statement(null, 'a', [step('archive')], 3)
      ])
    )
    expect(layout.nodes).toHaveLength(1)
    expect(layout.edges).toEqual([])
    expect(columnOf(layout.nodes, '2:0')).toBe(0)
  })

  it('collapses a wire named twice by one statement into a single edge', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('a', null, [step('tag', { tag: 'book' })], 1),
        statement(null, 'a', [step('union', { wire: 'a' })], 2)
      ])
    )
    expect(layout.edges).toEqual([{ from: '0:0', to: '1:0', wire: 'a' }])
  })

  it('takes the longest path when a node is fed from two depths', () => {
    const layout = layoutWorkflow(
      workflow([
        statement(
          'deep',
          null,
          [step('tag', { tag: 'book' }), step('dedupe'), step('limit', { count: 3 })],
          1
        ),
        statement('shallow', null, [step('tag', { tag: 'film' })], 2),
        statement(null, 'shallow', [step('union', { wire: 'deep' }), step('dedupe')], 3)
      ])
    )
    // Fed by `shallow` at column 0 and by `deep` at column 2, so column 3 wins.
    expect(columnOf(layout.nodes, '2:0')).toBe(3)
    expect(columnOf(layout.nodes, '2:1')).toBe(4)
  })

  it('never places a node left of anything feeding it', () => {
    const layout = layoutWorkflow(
      workflow([
        statement(
          'books',
          null,
          [step('tag', { tag: 'book' }), step('sort', { field: 'title' })],
          1
        ),
        statement('good', 'books', [step('where', { field: 'rating', op: '>=', value: '4' })], 2),
        statement('rest', 'books', [step('subtract', { wire: 'good' })], 3),
        statement(
          null,
          'rest',
          [step('render', { style: 'table' }), step('write', { path: 'R.md' })],
          4
        )
      ])
    )
    for (const edge of layout.edges) {
      expect(columnOf(layout.nodes, edge.to)).toBeGreaterThan(columnOf(layout.nodes, edge.from))
    }
  })

  it('emits exactly one node per step, with unique ids', () => {
    const source = workflow([
      statement('a', null, [step('all'), step('dedupe')], 1),
      statement('b', 'a', [step('limit', { count: 2 })], 2),
      statement(null, 'b', [step('render', { style: 'list' }), step('clipboard')], 3)
    ])
    const layout = layoutWorkflow(source)
    const expected = source.statements.reduce((total, item) => total + item.steps.length, 0)
    expect(layout.nodes).toHaveLength(expected)
    expect(new Set(layout.nodes.map((node) => node.id)).size).toBe(expected)
    for (const node of layout.nodes) {
      expect(node.id).toBe(stepId(node.statement, node.step))
    }
  })

  it('numbers rows contiguously from zero within every column', () => {
    const layout = layoutWorkflow(
      workflow([
        statement('books', null, [step('tag', { tag: 'book' })], 1),
        statement(null, 'books', [step('add-tag', { tag: 'x' })], 2),
        statement(null, 'books', [step('add-tag', { tag: 'y' })], 3),
        statement(null, null, [step('all')], 4)
      ])
    )
    const byColumn = new Map<number, number[]>()
    for (const node of layout.nodes) {
      const rows = byColumn.get(node.column) ?? []
      rows.push(node.row)
      byColumn.set(node.column, rows)
    }
    for (const rows of byColumn.values()) {
      expect(rows).toEqual(rows.map((_, index) => index))
    }
  })

  it('is byte-identical across runs', () => {
    const source = workflow([
      statement('books', null, [step('tag', { tag: 'book' })], 1),
      statement('good', 'books', [step('where', { field: 'rating', op: '>=', value: '4' })], 2),
      statement('rest', 'books', [step('subtract', { wire: 'good' })], 3),
      statement('loop', 'missing', [step('union', { wire: 'loop' })], 4),
      statement(null, 'rest', [step('render', { style: 'table' }), step('notify')], 5)
    ])
    const first = layoutWorkflow(source)
    const second = layoutWorkflow(source)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('does not mutate the workflow it is given', () => {
    const source = workflow([
      statement('books', null, [step('tag', { tag: 'book' })], 1),
      statement(null, 'books', [step('archive')], 2)
    ])
    const before = JSON.stringify(source)
    layoutWorkflow(source)
    expect(JSON.stringify(source)).toBe(before)
  })
})
