import { describe, expect, it } from 'vitest'
import { validateWorkflow } from './validate'
import type { ArgValue, Diagnostic, Workflow, WorkflowStatement, WorkflowStep } from './types'

// Fixtures are built as literals rather than parsed from source: the validator
// is the unit under test, and a literal states exactly which shape reaches it
// (including shapes a parser would never emit, which still must not crash it).
// Every fixture below carries the source line it stands for in a comment.

const step = (line: number, kind: string, args: Record<string, ArgValue> = {}): WorkflowStep => ({
  kind,
  args,
  line
})

const stmt = (
  line: number,
  name: string | null,
  input: string | null,
  steps: WorkflowStep[]
): WorkflowStatement => ({ name, input, steps, line })

const workflow = (
  statements: WorkflowStatement[],
  overrides: Partial<Workflow> = {}
): Workflow => ({
  id: 'reading-log',
  name: 'Reading log',
  description: 'Keep the reading log in sync',
  trigger: { type: 'manual' },
  status: 'active',
  statements,
  meta: {},
  ...overrides
})

const messages = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.message)

const errorsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'error')

describe('validateWorkflow: clean workflows', () => {
  it('accepts the reading-log example with no diagnostics', () => {
    // books   = tag #book
    // good    = books | where rating >= 4 | sort finished desc
    // someday = books | where rating < 4
    //
    // good    | render table title, rating | write-section "Reading Log.md" "Finished"
    // someday | add-tag #someday
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, 'good', 'books', [
        step(2, 'where', { field: 'rating', op: '>=', value: '4' }),
        step(2, 'sort', { field: 'finished', direction: 'desc' })
      ]),
      stmt(3, 'someday', 'books', [step(3, 'where', { field: 'rating', op: '<', value: '4' })]),
      stmt(5, null, 'good', [
        step(5, 'render', { style: 'table', columns: 'title, rating' }),
        step(5, 'write-section', { path: 'Reading Log.md', heading: 'Finished' })
      ]),
      stmt(6, null, 'someday', [step(6, 'add-tag', { tag: 'someday' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('accepts a workflow with no statements at all', () => {
    expect(validateWorkflow(workflow([]))).toEqual([])
  })

  it('accepts union and subtract that name defined wires', () => {
    // books = tag #book
    // done  = tag #done
    // books | subtract done | union books | archive
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, 'done', null, [step(2, 'tag', { tag: 'done' })]),
      stmt(3, null, 'books', [
        step(3, 'subtract', { wire: 'done' }),
        step(3, 'union', { wire: 'books' }),
        step(3, 'archive')
      ])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('accepts a wire referenced before the line that defines it', () => {
    // later | archive
    // later = tag #book
    const wf = workflow([
      stmt(1, null, 'later', [step(1, 'archive')]),
      stmt(2, 'later', null, [step(2, 'tag', { tag: 'book' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('rule 1: unknown node kind', () => {
  it('names the step it does not recognize', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'frobnicate')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual(['`frobnicate` is not a known step'])
  })

  it('does not also claim the pipeline computes nothing', () => {
    // An unknown step could be a mutation, so guessing on top of the real error
    // would just add noise.
    const wf = workflow([stmt(1, null, null, [step(1, 'all'), step(1, 'frobnicate')])])
    const diagnostics = validateWorkflow(wf)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].severity).toBe('error')
  })

  it('keeps checking other lines after an unknown step', () => {
    const wf = workflow([
      stmt(1, null, null, [step(1, 'frobnicate')]),
      stmt(2, null, 'nope', [step(2, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`frobnicate` is not a known step',
      '`nope` is not a wire defined in this workflow'
    ])
  })
})

describe('rule 2: unknown wire reference', () => {
  it('flags a statement reading a wire nothing defines', () => {
    const wf = workflow([stmt(1, null, 'books', [step(1, 'archive')])])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`books` is not a wire defined in this workflow'
    ])
  })

  it('flags an unknown wire in a union argument', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'union', { wire: 'later' }), step(2, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`union` refers to `later`, which is not a wire defined in this workflow'
    ])
  })

  it('flags an unknown wire in a subtract argument', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'subtract', { wire: 'gone' }), step(2, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`subtract` refers to `gone`, which is not a wire defined in this workflow'
    ])
  })
})

describe('rule 3: duplicate wire name', () => {
  it('points at the line that defined the name first', () => {
    const wf = workflow([
      stmt(3, 'good', null, [step(3, 'all')]),
      stmt(5, 'good', null, [step(5, 'all')]),
      stmt(7, null, 'good', [step(7, 'archive')])
    ])
    expect(validateWorkflow(wf)).toEqual([
      {
        severity: 'error',
        message: 'duplicate wire `good`, already defined on line 3',
        line: 5
      }
    ])
  })

  it('reports every redefinition against the first one', () => {
    const wf = workflow([
      stmt(3, 'good', null, [step(3, 'all')]),
      stmt(5, 'good', null, [step(5, 'all')]),
      stmt(6, 'good', null, [step(6, 'all')]),
      stmt(7, null, 'good', [step(7, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      'duplicate wire `good`, already defined on line 3',
      'duplicate wire `good`, already defined on line 3'
    ])
  })
})

describe('rule 4: cycles in the wire graph', () => {
  it('names the full cycle for two wires feeding each other', () => {
    const wf = workflow([
      stmt(1, 'a', 'b', [step(1, 'dedupe')]),
      stmt(2, 'b', 'a', [step(2, 'dedupe')])
    ])
    expect(validateWorkflow(wf)).toEqual([
      { severity: 'error', message: 'circular wires: a -> b -> a', line: 1 }
    ])
  })

  it('names a wire that reads itself', () => {
    const wf = workflow([stmt(1, 'a', 'a', [step(1, 'dedupe')])])
    expect(messages(validateWorkflow(wf))).toEqual([
      'circular wires: a -> a',
      'wire `a` is never read and its pipeline changes nothing'
    ])
  })

  it('names every hop of a three-wire cycle', () => {
    const wf = workflow([
      stmt(1, 'a', 'b', []),
      stmt(2, 'b', 'c', []),
      stmt(3, 'c', 'a', [])
    ])
    expect(messages(validateWorkflow(wf))).toEqual(['circular wires: a -> b -> c -> a'])
  })

  it('follows union arguments, not just the pipeline input', () => {
    const wf = workflow([
      stmt(1, 'a', null, [step(1, 'all'), step(1, 'union', { wire: 'b' })]),
      stmt(2, 'b', null, [step(2, 'all'), step(2, 'union', { wire: 'a' })])
    ])
    expect(messages(validateWorkflow(wf))).toEqual(['circular wires: a -> b -> a'])
  })

  it('reports one cycle once, whichever wire is read first', () => {
    // The same loop written from `b` first must still be reported once, anchored
    // on the earliest line.
    const wf = workflow([
      stmt(1, 'b', 'a', [step(1, 'dedupe')]),
      stmt(2, 'a', 'b', [step(2, 'dedupe')])
    ])
    const diagnostics = validateWorkflow(wf)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toEqual({
      severity: 'error',
      message: 'circular wires: b -> a -> b',
      line: 1
    })
  })

  it('leaves a diamond alone: shared inputs are not a cycle', () => {
    // books = tag #book
    // good  = books | where rating >= 4
    // bad   = books | where rating < 4
    // good | union bad | archive
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, 'good', 'books', [step(2, 'where', { field: 'rating', op: '>=', value: '4' })]),
      stmt(3, 'bad', 'books', [step(3, 'where', { field: 'rating', op: '<', value: '4' })]),
      stmt(4, null, 'good', [step(4, 'union', { wire: 'bad' }), step(4, 'archive')])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('rule 5: cycles in the workflow call graph', () => {
  const caller = (target: string): Workflow =>
    workflow([stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: target })])])

  it('flags a workflow that calls itself', () => {
    expect(validateWorkflow(caller('reading-log'), new Map())).toEqual([
      { severity: 'error', message: 'circular workflow calls: reading-log -> reading-log', line: 1 }
    ])
  })

  it('flags a two-workflow loop and names both hops', () => {
    const other = workflow(
      [stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: 'reading-log' })])],
      { id: 'archiver', name: 'Archiver' }
    )
    expect(messages(validateWorkflow(caller('archiver'), new Map([['archiver', other]])))).toEqual([
      'circular workflow calls: reading-log -> archiver -> reading-log'
    ])
  })

  it('flags a loop that lives entirely downstream of this workflow', () => {
    // reading-log calls archiver, archiver calls sweeper, sweeper calls archiver.
    // Running reading-log still hangs, so it is reported here.
    const archiver = workflow(
      [stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: 'sweeper' })])],
      { id: 'archiver' }
    )
    const sweeper = workflow(
      [stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: 'archiver' })])],
      { id: 'sweeper' }
    )
    const others = new Map([
      ['archiver', archiver],
      ['sweeper', sweeper]
    ])
    expect(messages(validateWorkflow(caller('archiver'), others))).toEqual([
      'circular workflow calls: archiver -> sweeper -> archiver'
    ])
  })

  it('accepts a call chain that terminates', () => {
    const leaf = workflow([stmt(1, null, null, [step(1, 'all'), step(1, 'archive')])], {
      id: 'archiver'
    })
    expect(validateWorkflow(caller('archiver'), new Map([['archiver', leaf]]))).toEqual([])
  })

  it('reports one cycle once when two call steps enter it on the same line', () => {
    const other = workflow(
      [stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: 'reading-log' })])],
      { id: 'archiver' }
    )
    const wf = workflow([
      stmt(1, null, null, [
        step(1, 'all'),
        step(1, 'call', { workflow: 'archiver' }),
        step(1, 'call', { workflow: 'archiver' })
      ])
    ])
    expect(validateWorkflow(wf, new Map([['archiver', other]]))).toHaveLength(1)
  })

  it('skips the call graph entirely when others is not supplied', () => {
    expect(validateWorkflow(caller('reading-log'))).toEqual([])
    expect(validateWorkflow(caller('archiver'))).toEqual([])
  })
})

describe('rule 6: call to a workflow that does not exist', () => {
  const callsNope = (): Workflow =>
    workflow([stmt(2, null, null, [step(2, 'all'), step(2, 'call', { workflow: 'nope' })])])

  it('names the missing workflow', () => {
    const wf = callsNope()
    const others = new Map([['archiver', workflow([], { id: 'archiver' })]])
    expect(validateWorkflow(wf, others)).toEqual([
      {
        severity: 'error',
        message: '`call` refers to `nope`, which is not a workflow in this vault',
        line: 2
      }
    ])
  })

  it('stays quiet about missing workflows when others is not supplied', () => {
    expect(validateWorkflow(callsNope())).toEqual([])
  })

  it('leaves a call with no argument to the parser', () => {
    // `bindParams` already reported the missing argument; repeating it here as
    // an unknown workflow would be a second error for one typo.
    const wf = workflow([stmt(1, null, null, [step(1, 'all'), step(1, 'call')])])
    expect(validateWorkflow(wf, new Map())).toEqual([])
  })
})

describe('calling a draft workflow', () => {
  const caller = (): Workflow =>
    workflow([stmt(2, null, null, [step(2, 'all'), step(2, 'call', { workflow: 'archiver' })])])

  it('warns that the engine will skip a draft child', () => {
    const others = new Map([['archiver', workflow([], { id: 'archiver', status: 'draft' })]])
    expect(validateWorkflow(caller(), others)).toEqual([
      {
        severity: 'warning',
        message: '`archiver` is a draft, so `call` will skip it until it is activated',
        line: 2
      }
    ])
  })

  it('stays quiet when the child is active', () => {
    const others = new Map([['archiver', workflow([], { id: 'archiver' })]])
    expect(validateWorkflow(caller(), others)).toEqual([])
  })

  it('does not stack the warning onto a self-call cycle', () => {
    // A draft calling itself is already reported as the cycle it is; the
    // draft warning would be a second message for the same line.
    const self = workflow(
      [stmt(1, null, null, [step(1, 'all'), step(1, 'call', { workflow: 'reading-log' })])],
      { status: 'draft' }
    )
    expect(messages(validateWorkflow(self, new Map()))).toEqual([
      'circular workflow calls: reading-log -> reading-log'
    ])
  })
})

describe('rule 7: a source anywhere but first', () => {
  it('flags a source after a pipe', () => {
    const wf = workflow([
      stmt(1, null, null, [step(1, 'all'), step(1, 'tag', { tag: 'book' }), step(1, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`tag` is a source, so it can only start a pipeline'
    ])
  })

  it('flags a source that a wire feeds into', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'all')]),
      stmt(2, null, 'books', [step(2, 'tag', { tag: 'book' }), step(2, 'archive')])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`tag` is a source, so it cannot read from wire `books`'
    ])
  })
})

describe('rules 8 and 9: terminal steps', () => {
  it('flags a terminal step that is not last', () => {
    const wf = workflow([
      stmt(1, null, null, [
        step(1, 'all'),
        step(1, 'write', { path: 'Out.md' }),
        step(1, 'add-tag', { tag: 'done' })
      ])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`write` ends a pipeline, so it must be the last step',
      '`add-tag` cannot run after `write`, which ends the pipeline'
    ])
  })

  it('names only the first step stranded after a terminal', () => {
    const wf = workflow([
      stmt(4, null, null, [
        step(4, 'all'),
        step(4, 'write', { path: 'Out.md' }),
        step(4, 'add-tag', { tag: 'done' }),
        step(4, 'archive')
      ])
    ])
    const diagnostics = validateWorkflow(wf)
    expect(messages(diagnostics)).toEqual([
      '`write` ends a pipeline, so it must be the last step',
      '`add-tag` cannot run after `write`, which ends the pipeline'
    ])
    expect(diagnostics.every((d) => d.line === 4)).toBe(true)
  })

  it('accepts a terminal step in last position', () => {
    const wf = workflow([
      stmt(1, null, null, [step(1, 'all'), step(1, 'write', { path: 'Out.md' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('rule 10: render with nothing to consume its text', () => {
  it('flags a render that ends the statement', () => {
    const wf = workflow([
      stmt(1, 'good', null, [step(1, 'all')]),
      stmt(2, null, 'good', [step(2, 'render', { style: 'table', columns: 'title' })])
    ])
    const hint = 'follow it with write, write-section, notify, clipboard'
    expect(errorsOf(validateWorkflow(wf)).map((d) => d.message)).toEqual([
      `\`render\` produces text that nothing consumes: ${hint}`
    ])
  })

  it('does not accept a sink in a different statement', () => {
    // Rendered text rides the pipeline, so a sink on another line never sees it.
    const wf = workflow([
      stmt(1, 'good', null, [step(1, 'all')]),
      stmt(2, null, 'good', [step(2, 'render', { style: 'list', columns: '' })]),
      stmt(3, null, 'good', [step(3, 'write', { path: 'Out.md' })])
    ])
    expect(errorsOf(validateWorkflow(wf))).toHaveLength(1)
  })

  it('accepts render followed by a sink further down the same statement', () => {
    const wf = workflow([
      stmt(1, null, null, [
        step(1, 'all'),
        step(1, 'render', { style: 'count', columns: '' }),
        step(1, 'notify', { message: 'done' })
      ])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('rule 11: a statement nobody can read', () => {
  it('warns about an unnamed pipeline that neither writes nor ends in a sink', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'where', { field: 'rating', op: '>=', value: '4' })])
    ])
    expect(validateWorkflow(wf)).toEqual([
      {
        severity: 'warning',
        message: 'this pipeline has no name and no output, so nothing reads its result',
        line: 2
      }
    ])
  })

  it('stays quiet when the pipeline mutates', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'add-tag', { tag: 'read' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('stays quiet when the pipeline ends in a sink', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'write', { path: 'Out.md' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('rule 12: dead wires', () => {
  it('warns about a named wire nobody reads', () => {
    const wf = workflow([stmt(1, 'orphan', null, [step(1, 'tag', { tag: 'book' })])])
    expect(validateWorkflow(wf)).toEqual([
      {
        severity: 'warning',
        message: 'wire `orphan` is never read and its pipeline changes nothing',
        line: 1
      }
    ])
  })

  it('stays quiet when another statement reads the wire', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, 'books', [step(2, 'archive')])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('counts a union argument as a reader', () => {
    const wf = workflow([
      stmt(1, 'books', null, [step(1, 'tag', { tag: 'book' })]),
      stmt(2, null, null, [
        step(2, 'all'),
        step(2, 'union', { wire: 'books' }),
        step(2, 'archive')
      ])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('stays quiet when the wire pipeline mutates', () => {
    const wf = workflow([
      stmt(1, 'archived', null, [step(1, 'tag', { tag: 'book' }), step(1, 'archive')])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('stays quiet when the wire pipeline ends in a sink', () => {
    const wf = workflow([
      stmt(1, 'out', null, [step(1, 'all'), step(1, 'write', { path: 'Out.md' })])
    ])
    expect(validateWorkflow(wf)).toEqual([])
  })
})

describe('ordering', () => {
  it('sorts by line, then errors before warnings', () => {
    const wf = workflow([
      stmt(1, 'orphan', null, [step(1, 'all')]),
      stmt(2, null, 'good', [step(2, 'render', { style: 'table', columns: '' })])
    ])
    expect(validateWorkflow(wf).map((d) => [d.severity, d.line])).toEqual([
      ['warning', 1],
      ['error', 2],
      ['error', 2],
      ['warning', 2]
    ])
  })

  it('keeps diagnostics that tie on line and severity in statement order', () => {
    const wf = workflow([
      stmt(9, null, 'missing', [
        step(9, 'union', { wire: 'also-missing' }),
        step(9, 'archive')
      ])
    ])
    expect(messages(validateWorkflow(wf))).toEqual([
      '`missing` is not a wire defined in this workflow',
      '`union` refers to `also-missing`, which is not a wire defined in this workflow'
    ])
  })
})
