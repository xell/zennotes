import { describe, it, expect } from 'vitest'
import { parseWorkflow } from './parse'
import { serializeWorkflow } from './serialize'
import { NODE_DEFS } from './nodes'
import { parseFrontmatter } from '../template-files'
import type { Workflow } from './types'
import {
  addStatement,
  addStep,
  freshWireName,
  moveStep,
  removeStatement,
  removeStep,
  renameWire,
  setStatementInput,
  setStatementName,
  setStepArg
} from './edit'

/**
 * The contract this file exists to defend, stated at the top of `./edit`:
 *
 *   parseWorkflow(serializeWorkflow(op(w))).workflow  deep-equals  op(w)
 *
 * A canvas edit that does not survive a save is a corrupted file, so nearly
 * every test here ends in `expectSurvivesSave`. The rest check that the edit
 * actually happened, because an implementation that refused everything would
 * satisfy the round-trip perfectly and be useless.
 *
 * Fixtures are built with `parseWorkflow` rather than by hand: the operations
 * consume what the app consumes, and a hand-built literal is exactly where an
 * impossible shape (an empty `leading`, a stale `line`) would sneak in and make
 * the suite prove something about a workflow that cannot exist.
 */

function load(body: string): Workflow {
  return parseWorkflow(`---\nname: Test\ntrigger: manual\n---\n\n${body}\n`, 'test').workflow
}

/** What a save would actually write, minus the frontmatter. */
function body(workflow: Workflow): string {
  return parseFrontmatter(serializeWorkflow(workflow)).body.trim()
}

/** THE GUARANTEE. */
function expectSurvivesSave(workflow: Workflow): Workflow {
  const text = serializeWorkflow(workflow)
  const back = parseWorkflow(text, workflow.id).workflow
  expect(back, `serialized as:\n${text}`).toEqual(workflow)
  return workflow
}

const SIMPLE = `books = tag #book
good = books | where rating >= 4 | sort rating desc
good | render table title, rating | write "Reading Log.md"`

const COMMENTED = `# the books
books = tag #book

# only the good ones
good = books | where rating >= 4 | sort rating desc
good | render table title, rating | write "Reading Log.md"`

const BRANCHED = `everything = all
recent = everything | since 7d
stale = everything | subtract recent
stale | add-tag #dusty`

/* -------------------------------------------------------------------------- */
/*  addStep                                                                   */
/* -------------------------------------------------------------------------- */

describe('addStep', () => {
  it('appends a step to the end of a pipeline', () => {
    const next = addStep(load(SIMPLE), { statement: 1, index: 2, kind: 'limit' })
    expect(body(next).split('\n')[1]).toBe('good = books | where rating >= 4 | sort rating desc | limit 0')
    expectSurvivesSave(next)
  })

  it('inserts a step in the middle of a pipeline', () => {
    const next = addStep(load(SIMPLE), { statement: 1, index: 1, kind: 'limit' })
    expect(body(next).split('\n')[1]).toBe('good = books | where rating >= 4 | limit 0 | sort rating desc')
    expectSurvivesSave(next)
  })

  it('inserts a step in front of the source', () => {
    const next = addStep(load(SIMPLE), { statement: 0, index: 0, kind: 'limit' })
    expect(body(next).split('\n')[0]).toBe('books = limit 0 | tag #book')
    expectSurvivesSave(next)
  })

  it('adds the first step to a pass-through statement', () => {
    const next = addStep(load('old = tag #a\nnew = old'), { statement: 1, index: 0, kind: 'dedupe' })
    expect(body(next)).toBe('old = tag #a\nnew = old | dedupe')
    expectSurvivesSave(next)
  })

  it('seeds every required param so the new node is inspectable', () => {
    const next = addStep(load(SIMPLE), { statement: 1, index: 2, kind: 'where' })
    expect(next.statements[1].steps[2].args).toEqual({ field: 'field', op: '=', value: 'value' })
    expectSurvivesSave(next)
  })

  it('seeds an optional param with its declared default', () => {
    const next = addStep(load(SIMPLE), { statement: 1, index: 2, kind: 'sort' })
    // Not cosmetic: the serializer drops a value equal to its default and the
    // parser puts it back, so omitting it would not survive a save.
    expect(next.statements[1].steps[2].args).toEqual({ field: 'field', direction: 'asc' })
    expectSurvivesSave(next)
  })

  it('seeds a placeholder that is a real value rather than an empty one', () => {
    // `move ""` is not a blank form, it is an instruction to move every note to
    // the root of the vault.
    const next = addStep(load(SIMPLE), { statement: 1, index: 2, kind: 'move' })
    expect(next.statements[1].steps[2].args.folder).toBe('folder')
    expect(body(next)).toContain('| move folder')
  })

  it('gives the new step the line of the statement it joined', () => {
    const next = addStep(load(SIMPLE), { statement: 2, index: 0, kind: 'dedupe' })
    const statement = next.statements[2]
    expect(statement.steps.map((step) => step.line)).toEqual([
      statement.line,
      statement.line,
      statement.line
    ])
  })

  it('refuses a kind the registry does not know', () => {
    // Written alone an unknown verb reads back as a WIRE REFERENCE, not a step.
    const workflow = load(SIMPLE)
    expect(addStep(workflow, { statement: 0, index: 1, kind: 'frobnicate' })).toBe(workflow)
  })

  it('refuses an index past the end of the pipeline', () => {
    const workflow = load(SIMPLE)
    expect(addStep(workflow, { statement: 0, index: 2, kind: 'limit' })).toBe(workflow)
  })

  it('refuses a negative index', () => {
    const workflow = load(SIMPLE)
    expect(addStep(workflow, { statement: 0, index: -1, kind: 'limit' })).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(addStep(workflow, { statement: 9, index: 0, kind: 'limit' })).toBe(workflow)
  })

  it('leaves the statements it did not touch identical', () => {
    const workflow = load(SIMPLE)
    const next = addStep(workflow, { statement: 1, index: 2, kind: 'limit' })
    expect(next.statements[0]).toBe(workflow.statements[0])
    expect(next.statements[2]).toBe(workflow.statements[2])
  })
})

describe('addStep: every node in the registry', () => {
  for (const def of NODE_DEFS) {
    it(`seeds \`${def.kind}\` with arguments that survive a save`, () => {
      const workflow = load('notes = all\nnotes | archive')
      const next = addStep(workflow, { statement: 0, index: 1, kind: def.kind })
      expect(next, `\`${def.kind}\` was refused`).not.toBe(workflow)
      const step = next.statements[0].steps[1]
      expect(step.kind).toBe(def.kind)
      for (const spec of def.params) {
        if (!spec.required && spec.default === undefined) continue
        expect(step.args[spec.name], `\`${def.kind}\` left ${spec.name} unseeded`).toBeDefined()
      }
      expectSurvivesSave(next)
    })
  }
})

/* -------------------------------------------------------------------------- */
/*  removeStep                                                                */
/* -------------------------------------------------------------------------- */

describe('removeStep', () => {
  it('heals the pipeline by joining the neighbours of a middle step', () => {
    const next = removeStep(load(SIMPLE), { statement: 1, index: 0 })
    expect(body(next).split('\n')[1]).toBe('good = books | sort rating desc')
    expectSurvivesSave(next)
  })

  it('removes the last step of a pipeline', () => {
    const next = removeStep(load(SIMPLE), { statement: 2, index: 1 })
    expect(body(next).split('\n')[2]).toBe('good | render table title, rating')
    expectSurvivesSave(next)
  })

  it('removes the source and leaves the rest of the pipeline in place', () => {
    const next = removeStep(load(SIMPLE), { statement: 0, index: 0 })
    // `books` had one step, so the whole statement goes.
    expect(body(next).split('\n')).toHaveLength(2)
    expectSurvivesSave(next)
  })

  it('removes the statement when its only step goes', () => {
    const workflow = load('a = tag #x\na | archive')
    const next = removeStep(workflow, { statement: 1, index: 0 })
    expect(next.statements).toHaveLength(1)
    expect(body(next)).toBe('a = tag #x')
    expectSurvivesSave(next)
  })

  it('keeps the comment of a statement it removed entirely', () => {
    const workflow = load('# keep me\na = tag #x\na | archive')
    const next = removeStep(workflow, { statement: 0, index: 0 })
    expect(body(next)).toBe('# keep me\na | archive')
    expectSurvivesSave(next)
  })

  it('refuses an index past the end of the pipeline', () => {
    const workflow = load(SIMPLE)
    expect(removeStep(workflow, { statement: 0, index: 1 })).toBe(workflow)
  })

  it('refuses a negative index', () => {
    const workflow = load(SIMPLE)
    expect(removeStep(workflow, { statement: 0, index: -1 })).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(removeStep(workflow, { statement: 9, index: 0 })).toBe(workflow)
  })

  it('leaves the statements it did not touch identical', () => {
    const workflow = load(SIMPLE)
    const next = removeStep(workflow, { statement: 1, index: 1 })
    expect(next.statements[0]).toBe(workflow.statements[0])
    expect(next.statements[2]).toBe(workflow.statements[2])
  })
})

/* -------------------------------------------------------------------------- */
/*  moveStep                                                                  */
/* -------------------------------------------------------------------------- */

describe('moveStep', () => {
  it('moves a step later in the pipeline', () => {
    const next = moveStep(load(SIMPLE), { statement: 1, index: 0 }, 1)
    expect(body(next).split('\n')[1]).toBe('good = books | sort rating desc | where rating >= 4')
    expectSurvivesSave(next)
  })

  it('moves a step earlier in the pipeline', () => {
    const next = moveStep(load(SIMPLE), { statement: 2, index: 1 }, 0)
    expect(body(next).split('\n')[2]).toBe('good | write "Reading Log.md" | render table title, rating')
    expectSurvivesSave(next)
  })

  it('moves a source into the middle without losing it', () => {
    // Nonsense the validator will flag, but a drag in progress reaches it and
    // the file has to be able to say so.
    const next = moveStep(load('a = tag #x | archive'), { statement: 0, index: 0 }, 1)
    expect(body(next)).toBe('a = archive | tag #x')
    expectSurvivesSave(next)
  })

  it('refuses a move onto the position it already holds', () => {
    const workflow = load(SIMPLE)
    expect(moveStep(workflow, { statement: 1, index: 0 }, 0)).toBe(workflow)
  })

  it('refuses a destination past the end', () => {
    const workflow = load(SIMPLE)
    expect(moveStep(workflow, { statement: 1, index: 0 }, 2)).toBe(workflow)
  })

  it('refuses a negative destination', () => {
    const workflow = load(SIMPLE)
    expect(moveStep(workflow, { statement: 1, index: 0 }, -1)).toBe(workflow)
  })

  it('refuses a source index that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(moveStep(workflow, { statement: 1, index: 5 }, 0)).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(moveStep(workflow, { statement: 9, index: 0 }, 0)).toBe(workflow)
  })

  it('leaves the statements it did not touch identical', () => {
    const workflow = load(SIMPLE)
    const next = moveStep(workflow, { statement: 1, index: 0 }, 1)
    expect(next.statements[0]).toBe(workflow.statements[0])
    expect(next.statements[2]).toBe(workflow.statements[2])
  })
})

/* -------------------------------------------------------------------------- */
/*  setStepArg                                                                */
/* -------------------------------------------------------------------------- */

describe('setStepArg', () => {
  const AT = { statement: 1, index: 0 }

  it('sets a rest argument', () => {
    const next = setStepArg(load(SIMPLE), AT, 'value', '5')
    expect(next.statements[1].steps[0].args.value).toBe('5')
    expect(body(next)).toContain('where rating >= 5')
    expectSurvivesSave(next)
  })

  it('quotes a value that would otherwise tokenize into two arguments', () => {
    const workflow = load('a = all | in inbox')
    const next = setStepArg(workflow, { statement: 0, index: 1 }, 'folder', 'my projects')
    expect(body(next)).toBe('a = all | in "my projects"')
    expectSurvivesSave(next)
  })

  it('leaves the spaces in a rest argument alone, since it is rejoined from them', () => {
    const next = setStepArg(load(SIMPLE), AT, 'value', 'four or more')
    expect(body(next)).toContain('where rating >= four or more')
    expectSurvivesSave(next)
  })

  it('keeps a pipe inside the argument instead of splitting the step', () => {
    const workflow = load('a = all | append x | write "O.md"')
    const next = setStepArg(workflow, { statement: 0, index: 1 }, 'text', '| a | b |')
    expect(next.statements[0].steps).toHaveLength(3)
    expectSurvivesSave(next)
  })

  it('sets a compare operator', () => {
    const next = setStepArg(load(SIMPLE), AT, 'op', 'contains')
    expect(body(next)).toContain('where rating contains 4')
    expectSurvivesSave(next)
  })

  it('refuses a comparison the grammar does not have', () => {
    const workflow = load(SIMPLE)
    expect(setStepArg(workflow, AT, 'op', '=~')).toBe(workflow)
  })

  it('stores a tag without its hash, whichever way it was given', () => {
    const workflow = load('a = all | add-tag #triage')
    const hashed = setStepArg(workflow, { statement: 0, index: 1 }, 'tag', '#urgent')
    const bare = setStepArg(workflow, { statement: 0, index: 1 }, 'tag', 'urgent')
    expect(hashed.statements[0].steps[1].args.tag).toBe('urgent')
    expect(bare.statements[0].steps[1].args.tag).toBe('urgent')
    expect(body(hashed)).toContain('add-tag #urgent')
    expectSurvivesSave(hashed)
  })

  it('refuses a tag the grammar would reject', () => {
    const workflow = load('a = all | add-tag #triage')
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'tag', 'two words')).toBe(workflow)
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'tag', '')).toBe(workflow)
  })

  it('accepts a numeric string for a number param', () => {
    const workflow = load('a = all | limit 5')
    const next = setStepArg(workflow, { statement: 0, index: 1 }, 'count', '25')
    expect(next.statements[0].steps[1].args.count).toBe(25)
    expect(body(next)).toContain('limit 25')
    expectSurvivesSave(next)
  })

  it('refuses a number param that is not a number', () => {
    const workflow = load('a = all | limit 5')
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'count', 'lots')).toBe(workflow)
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'count', '')).toBe(workflow)
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'count', Number.NaN)).toBe(workflow)
  })

  it('accepts a number for a text param', () => {
    const workflow = load('a = all | append x | write "O.md"')
    const next = setStepArg(workflow, { statement: 0, index: 1 }, 'text', 2026)
    expect(next.statements[0].steps[1].args.text).toBe('2026')
    expectSurvivesSave(next)
  })

  it('lower-cases a sort direction', () => {
    const next = setStepArg(load(SIMPLE), { statement: 1, index: 1 }, 'direction', 'DESC')
    expect(next.statements[1].steps[1].args.direction).toBe('desc')
    expectSurvivesSave(next)
  })

  it('refuses a value containing a line break', () => {
    // A statement is one line; the second half would come back as garbage.
    const workflow = load('a = all | append x | write "O.md"')
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'text', 'a\nb')).toBe(workflow)
  })

  it('refuses a boolean, which the file has no way to spell', () => {
    const workflow = load('a = all | append x | write "O.md"')
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'text', true)).toBe(workflow)
  })

  it('refuses a param the node does not declare', () => {
    const workflow = load(SIMPLE)
    expect(setStepArg(workflow, AT, 'nonsense', 'x')).toBe(workflow)
  })

  it('refuses to edit a step this version does not understand', () => {
    const workflow = load('a = all | frobnicate alpha | write "O.md"')
    expect(setStepArg(workflow, { statement: 0, index: 1 }, 'text', 'x')).toBe(workflow)
  })

  it('refuses a step index that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(setStepArg(workflow, { statement: 1, index: 9 }, 'value', '5')).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(setStepArg(workflow, { statement: 9, index: 0 }, 'value', '5')).toBe(workflow)
  })

  it('refuses a write that would re-read as a different statement', () => {
    // `where = >= 4` parses as an ASSIGNMENT to a wire called `where`. Nothing
    // about the value itself is illegal, which is exactly why the round-trip
    // check and not the type check is what catches it.
    const workflow = load('where rating >= 4')
    expect(setStepArg(workflow, { statement: 0, index: 0 }, 'field', '=')).toBe(workflow)
  })

  it('returns the same workflow when the value did not change', () => {
    const workflow = load(SIMPLE)
    expect(setStepArg(workflow, AT, 'value', '4')).toBe(workflow)
  })

  it('leaves the statements it did not touch identical', () => {
    const workflow = load(SIMPLE)
    const next = setStepArg(workflow, AT, 'value', '5')
    expect(next.statements[0]).toBe(workflow.statements[0])
    expect(next.statements[2]).toBe(workflow.statements[2])
  })
})

describe('setStepArg: clearing', () => {
  it('puts an optional param back to its default', () => {
    const next = setStepArg(load(SIMPLE), { statement: 1, index: 1 }, 'direction', null)
    // Deleting it outright would come back as `asc` on the next read, so the
    // clear would look like it never happened.
    expect(next.statements[1].steps[1].args).toEqual({ field: 'rating', direction: 'asc' })
    expect(body(next)).toContain('sort rating')
    expect(body(next)).not.toContain('sort rating desc')
    expectSurvivesSave(next)
  })

  it('clears a required param, which is a normal half-filled form', () => {
    const next = setStepArg(load('a = all | limit 5'), { statement: 0, index: 1 }, 'count', null)
    expect(next.statements[0].steps[1].args).toEqual({})
    expect(body(next)).toBe('a = all | limit')
    expectSurvivesSave(next)
  })

  it('clears the params after a cleared one, because arguments are positional', () => {
    // Keeping `>= 4` would write `where >= 4` and read `>=` back as the FIELD.
    const next = setStepArg(load(SIMPLE), { statement: 1, index: 0 }, 'field', null)
    expect(next.statements[1].steps[0].args).toEqual({})
    expect(body(next)).toContain('| where |')
    expectSurvivesSave(next)
  })

  it('leaves the params before a cleared one alone', () => {
    const next = setStepArg(load(SIMPLE), { statement: 1, index: 0 }, 'value', null)
    expect(next.statements[1].steps[0].args).toEqual({ field: 'rating', op: '>=' })
    expectSurvivesSave(next)
  })

  it('resets a defaulted param that follows a cleared one', () => {
    const next = setStepArg(load(SIMPLE), { statement: 1, index: 1 }, 'field', null)
    expect(next.statements[1].steps[1].args).toEqual({ direction: 'asc' })
    expect(body(next)).toContain('| sort')
    expectSurvivesSave(next)
  })

  it('returns the same workflow when there was nothing to clear', () => {
    const workflow = load('a = all | limit 5')
    const cleared = setStepArg(workflow, { statement: 0, index: 1 }, 'count', null)
    expect(setStepArg(cleared, { statement: 0, index: 1 }, 'count', null)).toBe(cleared)
  })
})

/* -------------------------------------------------------------------------- */
/*  addStatement                                                              */
/* -------------------------------------------------------------------------- */

describe('addStatement', () => {
  it('appends a source statement at the end', () => {
    const next = addStatement(load(SIMPLE), { name: 'fresh', kind: 'tag' })
    expect(body(next).split('\n')[3]).toBe('fresh = tag #tag')
    expectSurvivesSave(next)
  })

  it('adds an unnamed terminal statement', () => {
    const next = addStatement(load(SIMPLE), { input: 'good', kind: 'archive' })
    expect(next.statements[2].name).toBeNull()
    expect(body(next).split('\n')[2]).toBe('good | archive')
    expectSurvivesSave(next)
  })

  it('places a statement directly after the one producing its input', () => {
    const next = addStatement(load(SIMPLE), { name: 'few', input: 'books', kind: 'limit' })
    expect(body(next).split('\n')[1]).toBe('few = books | limit 0')
    expectSurvivesSave(next)
  })

  it('never reorders the statements that were already there', () => {
    const workflow = load(SIMPLE)
    const next = addStatement(workflow, { name: 'few', input: 'books', kind: 'limit' })
    expect(next.statements.map((statement) => statement.name)).toEqual([
      'books',
      'few',
      'good',
      null
    ])
    expect(next.statements[2].steps.map((step) => step.kind)).toEqual(['where', 'sort'])
  })

  it('appends when the input wire has no producer yet', () => {
    const next = addStatement(load(SIMPLE), { name: 'later', input: 'nowhere', kind: 'dedupe' })
    expect(body(next).split('\n')[3]).toBe('later = nowhere | dedupe')
    expectSurvivesSave(next)
  })

  it('adds the first statement of an empty workflow', () => {
    const workflow = load('')
    const next = addStatement(workflow, { name: 'notes', kind: 'all' })
    expect(body(next)).toBe('notes = all')
    expectSurvivesSave(next)
  })

  it('refuses a kind the registry does not know', () => {
    const workflow = load(SIMPLE)
    expect(addStatement(workflow, { name: 'x', kind: 'frobnicate' })).toBe(workflow)
  })

  it('refuses a name another statement already produces', () => {
    const workflow = load(SIMPLE)
    expect(addStatement(workflow, { name: 'books', kind: 'all' })).toBe(workflow)
  })

  it('refuses a name that is a registry verb', () => {
    // `sort = tag #x` parses, but `sort | archive` reads `sort` as a STEP, so the
    // wire would be unreadable the moment anything tried to use it.
    const workflow = load(SIMPLE)
    expect(addStatement(workflow, { name: 'sort', kind: 'all' })).toBe(workflow)
  })

  it('refuses a name the grammar does not accept', () => {
    const workflow = load(SIMPLE)
    expect(addStatement(workflow, { name: '2fast', kind: 'all' })).toBe(workflow)
    expect(addStatement(workflow, { name: 'has space', kind: 'all' })).toBe(workflow)
    expect(addStatement(workflow, { name: '', kind: 'all' })).toBe(workflow)
  })

  it('refuses an input that is not a legal wire name', () => {
    const workflow = load(SIMPLE)
    expect(addStatement(workflow, { name: 'x', input: 'sort', kind: 'dedupe' })).toBe(workflow)
    expect(addStatement(workflow, { name: 'x', input: '2fast', kind: 'dedupe' })).toBe(workflow)
  })
})

/* -------------------------------------------------------------------------- */
/*  removeStatement                                                           */
/* -------------------------------------------------------------------------- */

describe('removeStatement', () => {
  it('removes the statement and nothing else', () => {
    const next = removeStatement(load(SIMPLE), 2)
    expect(body(next)).toBe(`books = tag #book\ngood = books | where rating >= 4 | sort rating desc`)
    expectSurvivesSave(next)
  })

  it('leaves a dangling reader for the validator rather than refusing', () => {
    // Deleting upstream first is how people edit a graph; the diagnostics name
    // the broken reference precisely.
    const next = removeStatement(load(SIMPLE), 0)
    expect(next.statements[0].input).toBe('books')
    expectSurvivesSave(next)
  })

  it('moves the comment of a removed statement onto the one that takes its place', () => {
    const next = removeStatement(load(COMMENTED), 0)
    expect(body(next)).toBe(`# the books

# only the good ones
good = books | where rating >= 4 | sort rating desc
good | render table title, rating | write "Reading Log.md"`)
    expectSurvivesSave(next)
  })

  it('moves the comment of the last statement into the trailing trivia', () => {
    const next = removeStatement(load('a = tag #x\n\n# the end\na | archive'), 1)
    expect(body(next)).toBe('a = tag #x\n\n# the end')
    expect(next.trailing).toEqual(['', '# the end'])
    expectSurvivesSave(next)
  })

  it('drops a blank line that a hoisted comment would open the body with', () => {
    // The serializer's own blank after the frontmatter fence is indistinguishable
    // from an authored one, so the parser drops blanks that open the body.
    const next = removeStatement(load('a = tag #x\n\n# second\nb = tag #y'), 0)
    expect(next.statements[0].leading).toEqual(['# second'])
    expect(body(next)).toBe('# second\nb = tag #y')
    expectSurvivesSave(next)
  })

  it('renumbers the statements that moved up', () => {
    const workflow = load(SIMPLE)
    const next = removeStatement(workflow, 0)
    expect(next.statements.map((statement) => statement.line)).toEqual([2, 3])
    expect(next.statements[0].steps.every((step) => step.line === 2)).toBe(true)
  })

  it('keeps the comment of the only statement in the file', () => {
    const next = removeStatement(load('# all that is left\na = tag #x'), 0)
    expect(next.statements).toEqual([])
    expect(body(next)).toBe('# all that is left')
    expectSurvivesSave(next)
  })

  it('empties a workflow down to its frontmatter', () => {
    const next = removeStatement(removeStatement(load('a = tag #x\na | archive'), 1), 0)
    expect(next.statements).toEqual([])
    expect(body(next)).toBe('')
    expectSurvivesSave(next)
  })

  it('refuses an index that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(removeStatement(workflow, 9)).toBe(workflow)
    expect(removeStatement(workflow, -1)).toBe(workflow)
  })
})

/* -------------------------------------------------------------------------- */
/*  setStatementInput                                                         */
/* -------------------------------------------------------------------------- */

describe('setStatementInput', () => {
  it('rewires a statement to another wire', () => {
    const next = setStatementInput(load(SIMPLE), 2, 'books')
    expect(body(next).split('\n')[2]).toBe('books | render table title, rating | write "Reading Log.md"')
    expectSurvivesSave(next)
  })

  it('attaches an input to a statement that had none', () => {
    const next = setStatementInput(load('a = tag #x\nb = tag #y'), 1, 'a')
    expect(body(next)).toBe('a = tag #x\nb = a | tag #y')
    expectSurvivesSave(next)
  })

  it('detaches an input', () => {
    const next = setStatementInput(load(SIMPLE), 1, null)
    expect(body(next).split('\n')[1]).toBe('good = where rating >= 4 | sort rating desc')
    expectSurvivesSave(next)
  })

  it('accepts a wire defined further down the file', () => {
    // Definition order is not execution order; a genuine loop is the cycle
    // check's job, and refusing here would make an edge drawable one way only.
    const next = setStatementInput(load('a = tag #x\nb = tag #y'), 0, 'b')
    expect(next.statements[0].input).toBe('b')
    expectSurvivesSave(next)
  })

  it('refuses a wire name that is a registry verb', () => {
    // `sort | archive` reads `sort` as a step, so the edge would vanish on save.
    const workflow = load(SIMPLE)
    expect(setStatementInput(workflow, 2, 'sort')).toBe(workflow)
  })

  it('refuses a wire name the grammar does not accept', () => {
    const workflow = load(SIMPLE)
    expect(setStatementInput(workflow, 2, '2fast')).toBe(workflow)
    expect(setStatementInput(workflow, 2, 'has space')).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(setStatementInput(workflow, 9, 'books')).toBe(workflow)
  })

  it('returns the same workflow when the input did not change', () => {
    const workflow = load(SIMPLE)
    expect(setStatementInput(workflow, 1, 'books')).toBe(workflow)
  })
})

/* -------------------------------------------------------------------------- */
/*  setStatementName                                                          */
/* -------------------------------------------------------------------------- */

describe('setStatementName', () => {
  it('names a terminal statement, which is how it becomes a wire', () => {
    const next = setStatementName(load(SIMPLE), 2, 'report')
    expect(body(next).split('\n')[2]).toBe(
      'report = good | render table title, rating | write "Reading Log.md"'
    )
    expectSurvivesSave(next)
  })

  it('drops a name nobody reads, which is how a wire becomes terminal', () => {
    const next = setStatementName(load('a = tag #x\nb = tag #y'), 1, null)
    expect(body(next)).toBe('a = tag #x\ntag #y')
    expectSurvivesSave(next)
  })

  it('renames every reader along with the wire', () => {
    const next = setStatementName(load(SIMPLE), 0, 'library')
    expect(body(next)).toBe(`library = tag #book
good = library | where rating >= 4 | sort rating desc
good | render table title, rating | write "Reading Log.md"`)
    expectSurvivesSave(next)
  })

  it('refuses to drop a name another statement reads as its input', () => {
    // The gesture says "this wire has no name", not "break the statements below".
    const workflow = load(SIMPLE)
    expect(setStatementName(workflow, 0, null)).toBe(workflow)
  })

  it('refuses to drop a name a step argument reads', () => {
    const workflow = load(BRANCHED)
    expect(setStatementName(workflow, 1, null)).toBe(workflow)
  })

  it('drops a name that only the statement itself refers to', () => {
    const workflow = load('a = tag #x\nb = tag #y | union b')
    const next = setStatementName(workflow, 1, null)
    expect(next.statements[1].name).toBeNull()
    expectSurvivesSave(next)
  })

  it('renames only the clashing statement when two produce the same wire', () => {
    // The duplicate is a validator error and renaming one of them is the gesture
    // that clears it. Taking the reader along would rename the error, not fix it.
    const workflow = load('dup = tag #x\ndup = tag #y\ndup | archive')
    const next = setStatementName(workflow, 1, 'other')
    expect(body(next)).toBe('dup = tag #x\nother = tag #y\ndup | archive')
    expectSurvivesSave(next)
  })

  it('drops a duplicated name even though the wire is read', () => {
    // The other producer still supplies it, so nothing is left dangling.
    const workflow = load('dup = tag #x\ndup = tag #y\ndup | archive')
    const next = setStatementName(workflow, 1, null)
    expect(body(next)).toBe('dup = tag #x\ntag #y\ndup | archive')
    expectSurvivesSave(next)
  })

  it('refuses a name another statement already produces', () => {
    const workflow = load(SIMPLE)
    expect(setStatementName(workflow, 2, 'books')).toBe(workflow)
  })

  it('refuses a name that is a registry verb', () => {
    const workflow = load(SIMPLE)
    expect(setStatementName(workflow, 2, 'limit')).toBe(workflow)
  })

  it('refuses a statement that does not exist', () => {
    const workflow = load(SIMPLE)
    expect(setStatementName(workflow, 9, 'x')).toBe(workflow)
  })

  it('returns the same workflow when the name did not change', () => {
    const workflow = load(SIMPLE)
    expect(setStatementName(workflow, 0, 'books')).toBe(workflow)
    expect(setStatementName(workflow, 2, null)).toBe(workflow)
  })
})

/* -------------------------------------------------------------------------- */
/*  renameWire                                                                */
/* -------------------------------------------------------------------------- */

describe('renameWire', () => {
  it('renames the statement that produces the wire', () => {
    const next = renameWire(load(SIMPLE), 'books', 'library')
    expect(next.statements[0].name).toBe('library')
    expectSurvivesSave(next)
  })

  it('renames every statement that reads it as an input', () => {
    const next = renameWire(load(SIMPLE), 'good', 'best')
    expect(next.statements[1].name).toBe('best')
    expect(next.statements[2].input).toBe('best')
    expectSurvivesSave(next)
  })

  it('renames a wire-typed step argument', () => {
    const next = renameWire(load(BRANCHED), 'recent', 'fresh')
    expect(body(next)).toBe(`everything = all
fresh = everything | since 7d
stale = everything | subtract fresh
stale | add-tag #dusty`)
    expectSurvivesSave(next)
  })

  it('renames a union argument as well as a subtract one', () => {
    const workflow = load('a = tag #x\nb = tag #y\nc = a | union b\nd = a | subtract b')
    const next = renameWire(workflow, 'b', 'other')
    expect(body(next)).toBe(`a = tag #x
other = tag #y
c = a | union other
d = a | subtract other`)
    expectSurvivesSave(next)
  })

  it('renames every reference in one pass', () => {
    const workflow = load(`hub = all
one = hub | since 7d
two = hub | union one
hub | archive`)
    const next = renameWire(workflow, 'hub', 'centre')
    expect(serializeWorkflow(next)).not.toContain('hub')
    expect(next.statements.map((statement) => statement.input)).toEqual([
      null,
      'centre',
      'centre',
      'centre'
    ])
    expectSurvivesSave(next)
  })

  it('never renames an argument that merely spells the same word', () => {
    // The rename walks params declared `type: 'wire'`, not the verbs `union` and
    // `subtract`, and certainly not every string that matches.
    const workflow = load(`books = tag #book
books | append books
books | set books yes`)
    const next = renameWire(workflow, 'books', 'library')
    expect(body(next)).toBe(`library = tag #book
library | append books
library | set books yes`)
    expectSurvivesSave(next)
  })

  it('refuses a name another statement already produces', () => {
    // Two wires carrying different sets of notes must not merge because they now
    // spell the same.
    const workflow = load(SIMPLE)
    expect(renameWire(workflow, 'books', 'good')).toBe(workflow)
  })

  it('refuses a name that is a registry verb', () => {
    const workflow = load(SIMPLE)
    expect(renameWire(workflow, 'books', 'sort')).toBe(workflow)
  })

  it('refuses a name the grammar does not accept', () => {
    const workflow = load(SIMPLE)
    expect(renameWire(workflow, 'books', '2fast')).toBe(workflow)
    expect(renameWire(workflow, 'books', 'has space')).toBe(workflow)
    expect(renameWire(workflow, 'books', '')).toBe(workflow)
  })

  it('does nothing when the wire does not appear anywhere', () => {
    const workflow = load(SIMPLE)
    expect(renameWire(workflow, 'nowhere', 'somewhere')).toBe(workflow)
  })

  it('does nothing when the name is unchanged', () => {
    const workflow = load(SIMPLE)
    expect(renameWire(workflow, 'books', 'books')).toBe(workflow)
  })

  it('leaves the statements that never mention it identical', () => {
    const workflow = load(SIMPLE)
    const next = renameWire(workflow, 'good', 'best')
    expect(next.statements[0]).toBe(workflow.statements[0])
  })
})

/* -------------------------------------------------------------------------- */
/*  freshWireName                                                             */
/* -------------------------------------------------------------------------- */

describe('freshWireName', () => {
  it('hands back the base when nothing has claimed it', () => {
    expect(freshWireName(load(SIMPLE), 'fresh')).toBe('fresh')
  })

  it('suffixes until it finds a free name', () => {
    const workflow = load('books = all\nbooks2 = all\nbooks3 = all')
    expect(freshWireName(workflow, 'books')).toBe('books4')
  })

  it('suffixes a base that collides with a registry verb rather than dropping it', () => {
    // Naming a wire after the node producing it is the obvious default, and most
    // sources are verbs; falling back would name every wire on the canvas `wire`.
    expect(freshWireName(load(SIMPLE), 'sort')).toBe('sort2')
    expect(freshWireName(load(SIMPLE), 'tag')).toBe('tag2')
  })

  it('falls back when the base is not a legal identifier', () => {
    expect(freshWireName(load(SIMPLE), '2 fast 2 furious')).toBe('wire')
  })

  it('hands back a name addStatement accepts', () => {
    const workflow = load(SIMPLE)
    const name = freshWireName(workflow, 'books')
    const next = addStatement(workflow, { name, kind: 'all' })
    expect(next).not.toBe(workflow)
    expectSurvivesSave(next)
  })
})

/* -------------------------------------------------------------------------- */
/*  Addresses that are not positions                                          */
/* -------------------------------------------------------------------------- */

describe('an index that is not a whole number', () => {
  const workflow = load(SIMPLE)

  // A fractional index passes `< length` and then splices at a position that
  // does not exist, which is the one out-of-range case a bounds check misses.
  const CASES: Array<[string, () => Workflow]> = [
    ['addStep', () => addStep(workflow, { statement: 0, index: 0.5, kind: 'limit' })],
    ['addStep (statement)', () => addStep(workflow, { statement: 1.5, index: 0, kind: 'limit' })],
    ['addStep (NaN)', () => addStep(workflow, { statement: 0, index: Number.NaN, kind: 'limit' })],
    ['removeStep', () => removeStep(workflow, { statement: 0, index: 0.5 })],
    ['moveStep (source)', () => moveStep(workflow, { statement: 1, index: 0.5 }, 1)],
    ['moveStep (destination)', () => moveStep(workflow, { statement: 1, index: 0 }, 0.5)],
    ['setStepArg', () => setStepArg(workflow, { statement: 1, index: 0.5 }, 'value', '5')],
    ['removeStatement', () => removeStatement(workflow, 1.5)],
    ['setStatementInput', () => setStatementInput(workflow, 0.5, 'books')],
    ['setStatementName', () => setStatementName(workflow, 0.5, 'x')]
  ]

  for (const [label, run] of CASES) {
    it(`is refused by ${label}`, () => {
      expect(run()).toBe(workflow)
    })
  }
})

/* -------------------------------------------------------------------------- */
/*  The guarantee, once per operation                                         */
/* -------------------------------------------------------------------------- */

/** Every exported operation, applied to a workflow with comments in it. */
const OPERATIONS: Array<[string, (workflow: Workflow) => Workflow]> = [
  ['addStep', (w) => addStep(w, { statement: 1, index: 1, kind: 'limit' })],
  ['removeStep', (w) => removeStep(w, { statement: 1, index: 1 })],
  ['moveStep', (w) => moveStep(w, { statement: 1, index: 0 }, 1)],
  ['setStepArg', (w) => setStepArg(w, { statement: 1, index: 0 }, 'value', '5')],
  ['setStepArg (clearing)', (w) => setStepArg(w, { statement: 1, index: 0 }, 'field', null)],
  ['addStatement', (w) => addStatement(w, { name: 'extra', input: 'books', kind: 'dedupe' })],
  ['removeStatement', (w) => removeStatement(w, 1)],
  ['setStatementInput', (w) => setStatementInput(w, 2, 'books')],
  ['setStatementName', (w) => setStatementName(w, 2, 'report')],
  ['renameWire', (w) => renameWire(w, 'books', 'library')]
]

describe('every operation survives a save', () => {
  for (const [label, operation] of OPERATIONS) {
    it(`${label} round-trips through the file`, () => {
      const workflow = load(COMMENTED)
      const next = operation(workflow)
      expect(next, `${label} refused the edit`).not.toBe(workflow)
      expectSurvivesSave(next)
    })
  }
})

describe('every operation keeps the comments', () => {
  for (const [label, operation] of OPERATIONS) {
    it(`${label} leaves the prose in the file`, () => {
      const text = serializeWorkflow(operation(load(COMMENTED)))
      expect(text, `${label} deleted a comment`).toContain('# the books')
      expect(text, `${label} deleted a comment`).toContain('# only the good ones')
    })
  }
})

describe('every operation renumbers what it moved', () => {
  for (const [label, operation] of OPERATIONS) {
    it(`${label} leaves every line where the file will put it`, () => {
      const next = operation(load(COMMENTED))
      const reparsed = parseWorkflow(serializeWorkflow(next), next.id).workflow
      expect(next.statements.map((statement) => statement.line), label).toEqual(
        reparsed.statements.map((statement) => statement.line)
      )
      for (const statement of next.statements) {
        // A statement is written as one line, so its steps share it.
        expect(statement.steps.map((step) => step.line), label).toEqual(
          statement.steps.map(() => statement.line)
        )
      }
    })
  }
})

describe('every operation is total', () => {
  const HOSTILE: Array<[string, Workflow]> = [
    ['an empty workflow', load('')],
    ['a workflow of one broken line', load('|||')],
    ['a workflow this version does not understand', load('a = frobnicate x\na | wibble')],
    ['a workflow with a step missing its arguments', load('a = all | where\na | archive')]
  ]

  for (const [label, workflow] of HOSTILE) {
    for (const [name, operation] of OPERATIONS) {
      it(`${name} neither throws nor corrupts ${label}`, () => {
        const next = operation(workflow)
        expectSurvivesSave(next)
      })
    }
  }
})

/* -------------------------------------------------------------------------- */
/*  Composition                                                               */
/* -------------------------------------------------------------------------- */

describe('edits compose', () => {
  it('builds a whole workflow from an empty one, UI gesture by UI gesture', () => {
    let workflow = load('')
    workflow = addStatement(workflow, { name: 'books', kind: 'tag' })
    workflow = setStepArg(workflow, { statement: 0, index: 0 }, 'tag', '#book')
    workflow = addStatement(workflow, { name: 'good', input: 'books', kind: 'where' })
    workflow = setStepArg(workflow, { statement: 1, index: 0 }, 'field', 'rating')
    workflow = setStepArg(workflow, { statement: 1, index: 0 }, 'op', '>=')
    workflow = setStepArg(workflow, { statement: 1, index: 0 }, 'value', '4')
    workflow = addStep(workflow, { statement: 1, index: 1, kind: 'sort' })
    workflow = setStepArg(workflow, { statement: 1, index: 1 }, 'field', 'finished')
    workflow = setStepArg(workflow, { statement: 1, index: 1 }, 'direction', 'desc')
    workflow = addStatement(workflow, { input: 'good', kind: 'render' })
    workflow = setStepArg(workflow, { statement: 2, index: 0 }, 'columns', 'title, rating')
    workflow = addStep(workflow, { statement: 2, index: 1, kind: 'write' })
    workflow = setStepArg(workflow, { statement: 2, index: 1 }, 'path', 'Reading Log.md')

    expect(body(workflow)).toBe(`books = tag #book
good = books | where rating >= 4 | sort finished desc
good | render table title, rating | write "Reading Log.md"`)
    expectSurvivesSave(workflow)
  })

  it('takes the same workflow back apart again', () => {
    let workflow = load(SIMPLE)
    workflow = removeStep(workflow, { statement: 2, index: 1 })
    workflow = removeStep(workflow, { statement: 2, index: 0 })
    workflow = removeStep(workflow, { statement: 1, index: 1 })
    workflow = removeStep(workflow, { statement: 1, index: 0 })
    workflow = removeStep(workflow, { statement: 0, index: 0 })
    expect(workflow.statements).toEqual([])
    expectSurvivesSave(workflow)
  })

  it('leaves an untouched workflow byte-identical after a no-op edit', () => {
    const workflow = load(COMMENTED)
    const text = serializeWorkflow(workflow)
    expect(serializeWorkflow(setStepArg(workflow, { statement: 1, index: 0 }, 'value', '4'))).toBe(
      text
    )
  })
})
