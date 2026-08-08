import { describe, expect, it } from 'vitest'
import { RAW_ARG, parseWorkflow, tokenizeStep } from './parse'
import { serializeWorkflow } from './serialize'

/** The worked example from the format spec, alignment padding and all. */
const WORKED = [
  '---',
  'name: Reading log',
  'description: Keep the reading log in sync',
  'trigger: manual',
  'key: <leader>wr',
  '---',
  '',
  '# comment lines start with hash at column 0',
  'books   = tag #book',
  'good    = books | where rating >= 4 | sort finished desc',
  'someday = books | where rating < 4',
  '',
  'good    | render table title, rating, finished | write-section "Reading Log.md" "Finished"',
  'someday | add-tag #someday',
  ''
].join('\n')

/**
 * Same workflow after a save: alignment padding normalized away, but comments
 * and the author's own blank line kept exactly where they were. A save must not
 * delete what someone wrote to explain their own workflow, so trivia survives
 * and the statement line numbers come back unchanged.
 *
 * The `status: active` line is the one thing a save ADDS, because `WORKED`
 * predates the field and a file without it reads as active. See `status.test.ts`
 * for that rule and for the fixpoint it has to settle into afterwards.
 */
const WORKED_CANONICAL = [
  '---',
  'name: Reading log',
  'description: Keep the reading log in sync',
  'status: active',
  'trigger: manual',
  'key: <leader>wr',
  '---',
  '',
  '# comment lines start with hash at column 0',
  'books = tag #book',
  'good = books | where rating >= 4 | sort finished desc',
  'someday = books | where rating < 4',
  '',
  'good | render table title, rating, finished | write-section "Reading Log.md" "Finished"',
  'someday | add-tag #someday',
  ''
].join('\n')

/** A minimal file whose body starts on line 1, to keep expectations readable. */
function file(...body: string[]): string {
  return ['---', 'name: T', 'trigger: manual', '---', ...body, ''].join('\n')
}

/**
 * Parse, serialize, parse again. The second parse is the canonical form: the
 * first one may carry comments and blank lines that the text form owns and the
 * `Workflow` type has nowhere to keep, so line numbers only settle once the file
 * has been through a save.
 */
function normalize(raw: string, id = 'wf'): { text: string; again: string } {
  const first = parseWorkflow(raw, id).workflow
  const text = serializeWorkflow(first)
  const second = parseWorkflow(text, id).workflow
  expect(second).toEqual(parseWorkflow(serializeWorkflow(second), id).workflow)
  return { text, again: serializeWorkflow(second) }
}

/* -------------------------------------------------------------------------- */

describe('tokenizeStep', () => {
  it('splits on whitespace', () => {
    expect(tokenizeStep('where rating >= 4')).toEqual(['where', 'rating', '>=', '4'])
  })

  it('keeps quotes in the token and never splits inside them', () => {
    expect(tokenizeStep('write-section "Reading Log.md" "Finished"')).toEqual([
      'write-section',
      '"Reading Log.md"',
      '"Finished"'
    ])
  })

  it('treats single quotes the same way', () => {
    expect(tokenizeStep("append 'two words'")).toEqual(['append', "'two words'"])
  })

  it('collapses runs of whitespace and ignores empty input', () => {
    expect(tokenizeStep('  limit\t\t5  ')).toEqual(['limit', '5'])
    expect(tokenizeStep('')).toEqual([])
    expect(tokenizeStep('   ')).toEqual([])
  })

  it('closes an unterminated quote at the end of the line', () => {
    expect(tokenizeStep('append "half a thought')).toEqual(['append', '"half a thought'])
  })

  it('leaves tags and pipes inside quotes alone', () => {
    expect(tokenizeStep('append "| a | b |" #tag')).toEqual(['append', '"| a | b |"', '#tag'])
  })
})

/* -------------------------------------------------------------------------- */

describe('parseWorkflow frontmatter', () => {
  it('reads the consumed keys', () => {
    const { workflow, diagnostics } = parseWorkflow(WORKED, 'reading-log')
    expect(diagnostics).toEqual([])
    expect(workflow.id).toBe('reading-log')
    expect(workflow.name).toBe('Reading log')
    expect(workflow.description).toBe('Keep the reading log in sync')
    expect(workflow.key).toBe('<leader>wr')
    expect(workflow.meta).toEqual({})
  })

  it('falls back to the id when the file names no workflow', () => {
    const { workflow } = parseWorkflow('---\ntrigger: manual\n---\n', 'reading-log')
    expect(workflow.name).toBe('reading-log')
    expect(workflow.description).toBe('')
    expect('key' in workflow).toBe(false)
  })

  it('keeps unconsumed keys in meta verbatim', () => {
    const raw = ['---', 'name: T', 'trigger: manual', 'zeta: 1', 'alpha: two words', '---'].join(
      '\n'
    )
    const { workflow } = parseWorkflow(raw, 'wf')
    expect(workflow.meta).toEqual({ zeta: '1', alpha: 'two words' })
  })

  it('parses a file with no frontmatter at all', () => {
    const { workflow, diagnostics } = parseWorkflow('all | limit 3\n', 'wf')
    expect(diagnostics).toEqual([])
    expect(workflow.name).toBe('wf')
    expect(workflow.statements).toHaveLength(1)
    expect(workflow.statements[0].line).toBe(1)
  })

  it('parses an empty file', () => {
    const { workflow, diagnostics } = parseWorkflow('', 'wf')
    expect(diagnostics).toEqual([])
    expect(workflow.statements).toEqual([])
    expect(workflow.trigger).toEqual({ type: 'manual' })
  })

  it('parses a frontmatter-only file', () => {
    const { workflow, diagnostics } = parseWorkflow('---\nname: T\ntrigger: manual\n---\n', 'wf')
    expect(diagnostics).toEqual([])
    expect(workflow.statements).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

describe('parseWorkflow triggers', () => {
  const triggerOf = (value: string): ReturnType<typeof parseWorkflow> =>
    parseWorkflow(`---\nname: T\ntrigger: ${value}\n---\n`, 'wf')

  it('reads manual, explicitly and by omission', () => {
    expect(triggerOf('manual').workflow.trigger).toEqual({ type: 'manual' })
    expect(parseWorkflow('---\nname: T\n---\n', 'wf').workflow.trigger).toEqual({ type: 'manual' })
    expect(parseWorkflow('---\nname: T\n---\n', 'wf').diagnostics).toEqual([])
  })

  it('reads every event trigger', () => {
    for (const event of ['note-created', 'note-saved', 'note-moved', 'tag-added']) {
      const parsed = triggerOf(`on ${event}`)
      expect(parsed.diagnostics).toEqual([])
      expect(parsed.workflow.trigger).toEqual({ type: 'event', event })
    }
  })

  it('reads an event trigger with a where clause', () => {
    expect(triggerOf('on note-saved where tag = #book').workflow.trigger).toEqual({
      type: 'event',
      event: 'note-saved',
      where: 'tag = #book'
    })
  })

  it('drops an empty where clause instead of storing a blank expression', () => {
    expect(triggerOf('on note-saved where').workflow.trigger).toEqual({
      type: 'event',
      event: 'note-saved'
    })
  })

  it('reads a schedule trigger, cron spaces and all', () => {
    expect(triggerOf('schedule 0 9 * * 1').workflow.trigger).toEqual({
      type: 'schedule',
      cron: '0 9 * * 1'
    })
  })

  it('falls back to manual with a warning on an unknown trigger', () => {
    const parsed = triggerOf('whenever I feel like it')
    expect(parsed.workflow.trigger).toEqual({ type: 'manual' })
    expect(parsed.diagnostics).toHaveLength(1)
    expect(parsed.diagnostics[0].severity).toBe('warning')
    expect(parsed.diagnostics[0].line).toBe(0)
  })

  it('falls back to manual with a warning on an unknown event', () => {
    const parsed = triggerOf('on note-exploded')
    expect(parsed.workflow.trigger).toEqual({ type: 'manual' })
    expect(parsed.diagnostics[0].message).toContain('note-exploded')
  })

  it('falls back to manual when schedule has no cron', () => {
    const parsed = triggerOf('schedule')
    expect(parsed.workflow.trigger).toEqual({ type: 'manual' })
    expect(parsed.diagnostics[0].severity).toBe('warning')
  })
})

/* -------------------------------------------------------------------------- */

describe('parseWorkflow statements', () => {
  it('parses the worked example', () => {
    const { workflow, diagnostics } = parseWorkflow(WORKED, 'reading-log')
    expect(diagnostics).toEqual([])
    expect(workflow.statements).toEqual([
      {
        name: 'books',
        input: null,
        line: 3,
        leading: ['# comment lines start with hash at column 0'],
        steps: [{ kind: 'tag', args: { tag: 'book' }, line: 3 }]
      },
      {
        name: 'good',
        input: 'books',
        line: 4,
        steps: [
          { kind: 'where', args: { field: 'rating', op: '>=', value: '4' }, line: 4 },
          { kind: 'sort', args: { field: 'finished', direction: 'desc' }, line: 4 }
        ]
      },
      {
        name: 'someday',
        input: 'books',
        line: 5,
        steps: [{ kind: 'where', args: { field: 'rating', op: '<', value: '4' }, line: 5 }]
      },
      {
        name: null,
        input: 'good',
        line: 7,
        // The author's own blank line, kept so a save does not close the gap.
        leading: [''],
        steps: [
          {
            kind: 'render',
            args: { style: 'table', columns: 'title, rating, finished' },
            line: 7
          },
          {
            kind: 'write-section',
            args: { path: 'Reading Log.md', heading: 'Finished' },
            line: 7
          }
        ]
      },
      {
        name: null,
        input: 'someday',
        line: 8,
        steps: [{ kind: 'add-tag', args: { tag: 'someday' }, line: 8 }]
      }
    ])
  })

  it('skips comments and blank lines but keeps line numbers', () => {
    const { workflow } = parseWorkflow(file('# a comment', '', '   ', 'all | limit 1'), 'wf')
    expect(workflow.statements).toHaveLength(1)
    expect(workflow.statements[0].line).toBe(4)
  })

  it('treats an indented hash as a comment too', () => {
    const { workflow, diagnostics } = parseWorkflow(file('    # indented'), 'wf')
    expect(workflow.statements).toEqual([])
    expect(diagnostics).toEqual([])
  })

  it('does not read the `=` of `>=` as an assignment', () => {
    const { workflow, diagnostics } = parseWorkflow(file('all | where rating >= 4'), 'wf')
    expect(diagnostics).toEqual([])
    const [statement] = workflow.statements
    expect(statement.name).toBeNull()
    expect(statement.steps.map((s) => s.kind)).toEqual(['all', 'where'])
    expect(statement.steps[1].args).toEqual({ field: 'rating', op: '>=', value: '4' })
  })

  it('does not read the `=` of a compare step as an assignment', () => {
    const { workflow } = parseWorkflow(file('kept = all | where status = done'), 'wf')
    expect(workflow.statements[0].name).toBe('kept')
    expect(workflow.statements[0].steps[1].args).toEqual({
      field: 'status',
      op: '=',
      value: 'done'
    })
  })

  it('accepts an assignment with no spaces around the equals sign', () => {
    const { workflow } = parseWorkflow(file('books=tag #book'), 'wf')
    expect(workflow.statements[0].name).toBe('books')
    expect(workflow.statements[0].input).toBeNull()
    expect(workflow.statements[0].steps[0].kind).toBe('tag')
  })

  it('reads a bare identifier as a wire reference, contributing no step', () => {
    const { workflow, diagnostics } = parseWorkflow(
      file('books = tag #book', 'books | add-tag #x'),
      'wf'
    )
    expect(diagnostics).toEqual([])
    expect(workflow.statements[1].input).toBe('books')
    expect(workflow.statements[1].steps.map((s) => s.kind)).toEqual(['add-tag'])
  })

  it('rejects a non-source node kind as the first step, but keeps it', () => {
    const { workflow, diagnostics } = parseWorkflow(file('limit 5 | add-tag #x'), 'wf')
    expect(diagnostics[0]).toEqual({
      severity: 'error',
      message: 'pipeline must start with a source or a wire name',
      line: 1
    })
    expect(workflow.statements[0].input).toBeNull()
    expect(workflow.statements[0].steps.map((s) => s.kind)).toEqual(['limit', 'add-tag'])
  })

  it('rejects an unknown verb with arguments as the first step', () => {
    const { workflow, diagnostics } = parseWorkflow(file('frobnicate 3 | limit 1'), 'wf')
    expect(diagnostics[0].message).toBe('pipeline must start with a source or a wire name')
    expect(workflow.statements[0].steps[0]).toEqual({
      kind: 'frobnicate',
      args: { [RAW_ARG]: '3' },
      line: 1
    })
  })

  it('reports an unknown verb mid-pipeline but still parses the statement', () => {
    const { workflow, diagnostics } = parseWorkflow(file('all | frobnicate "a b" 3 | limit 1'), 'wf')
    expect(diagnostics).toEqual([
      { severity: 'error', message: 'unknown step `frobnicate`', line: 1 }
    ])
    expect(workflow.statements[0].steps.map((s) => s.kind)).toEqual(['all', 'frobnicate', 'limit'])
    expect(workflow.statements[0].steps[1].args).toEqual({ [RAW_ARG]: '"a b" 3' })
  })

  it('binds quoted arguments that contain spaces', () => {
    const { workflow, diagnostics } = parseWorkflow(
      file('all | write-section "Reading Log.md" "To read"'),
      'wf'
    )
    expect(diagnostics).toEqual([])
    expect(workflow.statements[0].steps[1].args).toEqual({
      path: 'Reading Log.md',
      heading: 'To read'
    })
  })

  it('makes a wire named after a node kind unreferenceable, deliberately', () => {
    const { workflow, diagnostics } = parseWorkflow(file('sort = tag #book', 'sort | limit 1'), 'wf')
    expect(workflow.statements[0].name).toBe('sort')
    expect(workflow.statements[1].input).toBeNull()
    expect(diagnostics[0]).toEqual({
      severity: 'error',
      message: 'pipeline must start with a source or a wire name',
      line: 2
    })
  })

  it('handles CRLF line endings', () => {
    const raw = WORKED.replace(/\n/g, '\r\n')
    const { workflow, diagnostics } = parseWorkflow(raw, 'reading-log')
    expect(diagnostics).toEqual([])
    expect(workflow.name).toBe('Reading log')
    expect(workflow.statements.map((s) => s.line)).toEqual([3, 4, 5, 7, 8])
    expect(serializeWorkflow(workflow)).toBe(WORKED_CANONICAL)
  })

  it('reports a missing required argument without losing the step', () => {
    const { workflow, diagnostics } = parseWorkflow(file('all | limit'), 'wf')
    expect(diagnostics).toEqual([{ severity: 'error', message: '`limit` needs count', line: 1 }])
    expect(workflow.statements[0].steps[1]).toEqual({ kind: 'limit', args: {}, line: 1 })
  })

  it('warns about extra input rather than failing the step', () => {
    const { workflow, diagnostics } = parseWorkflow(file('all | limit 5 nonsense'), 'wf')
    expect(diagnostics[0].severity).toBe('warning')
    expect(workflow.statements[0].steps[1].args).toEqual({ count: 5 })
  })

  it('warns about an unterminated quote and closes it at the line end', () => {
    const { workflow, diagnostics } = parseWorkflow(file('all | append "half a thought'), 'wf')
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'unterminated quote, treated the end of the line as the closing quote',
        line: 1
      }
    ])
    expect(workflow.statements[0].steps[1].args).toEqual({ text: '"half a thought' })
  })

  it('reports an empty step after a pipe', () => {
    const { diagnostics } = parseWorkflow(file('all | | limit 1'), 'wf')
    expect(diagnostics).toEqual([{ severity: 'error', message: 'empty step after `|`', line: 1 }])
  })

  it('reports a pipeline that opens with a pipe', () => {
    const { diagnostics } = parseWorkflow(file('| limit 1'), 'wf')
    expect(diagnostics[0].message).toBe('pipeline must start with a source or a wire name')
  })

  it('keeps no statement for a line of nothing but pipes', () => {
    const { workflow, diagnostics } = parseWorkflow(file('|', 'all | limit 1'), 'wf')
    expect(workflow.statements).toHaveLength(1)
    expect(workflow.statements[0].line).toBe(2)
    expect(diagnostics.every((d) => d.line === 1)).toBe(true)
  })

  it('reports an assignment with nothing on the right', () => {
    const { workflow, diagnostics } = parseWorkflow(file('books ='), 'wf')
    expect(workflow.statements[0].name).toBe('books')
    expect(workflow.statements[0].steps).toEqual([])
    expect(diagnostics[0].message).toBe('pipeline must start with a source or a wire name')
  })

  it('applies declared defaults so the engine never sees a hole', () => {
    const { workflow } = parseWorkflow(file('all | sort title | render list'), 'wf')
    expect(workflow.statements[0].steps[1].args).toEqual({ field: 'title', direction: 'asc' })
    expect(workflow.statements[0].steps[2].args).toEqual({ style: 'list', columns: '' })
  })
})

/* -------------------------------------------------------------------------- */

describe('serializeWorkflow', () => {
  it('emits the canonical form of the worked example', () => {
    const { workflow } = parseWorkflow(WORKED, 'reading-log')
    expect(serializeWorkflow(workflow)).toBe(WORKED_CANONICAL)
  })

  it('omits description and key when empty, and sorts meta keys', () => {
    const raw = ['---', 'name: T', 'trigger: manual', 'zeta: 1', 'alpha: 2', '---'].join('\n')
    const { workflow } = parseWorkflow(raw, 'wf')
    expect(serializeWorkflow(workflow)).toBe(
      ['---', 'name: T', 'status: active', 'trigger: manual', 'alpha: 2', 'zeta: 1', '---', ''].join(
        '\n'
      )
    )
  })

  it('emits every trigger form', () => {
    const forms = ['manual', 'on note-saved', 'on note-saved where tag = #book', 'schedule 0 9 * * 1']
    for (const form of forms) {
      const { workflow } = parseWorkflow(`---\nname: T\ntrigger: ${form}\n---\n`, 'wf')
      expect(serializeWorkflow(workflow)).toContain(`trigger: ${form}\n`)
    }
  })

  it('drops trailing arguments that match the declared default', () => {
    const { workflow } = parseWorkflow(file('all | sort title asc | render table'), 'wf')
    expect(serializeWorkflow(workflow)).toContain('all | sort title | render table\n')
  })

  it('writes tags back with their hash', () => {
    const { workflow } = parseWorkflow(file('tag book | add-tag #starred'), 'wf')
    expect(serializeWorkflow(workflow)).toContain('tag #book | add-tag #starred\n')
  })

  it('re-quotes a value that would otherwise tokenize into two arguments', () => {
    const { workflow } = parseWorkflow(file('all | move "My Folder"'), 'wf')
    expect(serializeWorkflow(workflow)).toContain('all | move "My Folder"\n')
  })

  it('quotes a rest argument only when whitespace would not survive', () => {
    const { workflow } = parseWorkflow(file('all | append "in progress"', 'all | append "a  b"'), 'wf')
    const text = serializeWorkflow(workflow)
    expect(text).toContain('all | append in progress\n')
    expect(text).toContain('all | append "a  b"\n')
  })

  it('picks a quote character the value does not already contain', () => {
    const { workflow } = parseWorkflow(file(`all | move "it's here"`), 'wf')
    expect(serializeWorkflow(workflow)).toContain(`all | move "it's here"\n`)
    const other = parseWorkflow(file(`all | move 'say "hi"'`), 'wf')
    expect(serializeWorkflow(other.workflow)).toContain(`all | move 'say "hi"'\n`)
  })

  it('quotes an apostrophe so it cannot swallow the rest of the pipeline', () => {
    // Emitted bare, the apostrophe in `it's` would open a quote that runs past
    // the next `|`, and `limit 1` would be eaten by the append text.
    const { workflow } = parseWorkflow(file(`all | append "it's" | limit 1`), 'wf')
    const text = serializeWorkflow(workflow)
    expect(text).toContain(`all | append "it's" | limit 1\n`)
    const reparsed = parseWorkflow(text, 'wf').workflow
    expect(reparsed.statements[0].steps.map((s) => s.kind)).toEqual(['all', 'append', 'limit'])
    expect(reparsed.statements[0].steps[1].args).toEqual({ text: "it's" })
  })

  it('writes an unknown verb back with its arguments untouched', () => {
    const { workflow } = parseWorkflow(file('all | frobnicate "a b" 3'), 'wf')
    expect(serializeWorkflow(workflow)).toContain('all | frobnicate "a b" 3\n')
  })

  it('never writes an owned key twice, even if meta carries one', () => {
    const { workflow } = parseWorkflow('---\nname: Real\ntrigger: manual\n---\n', 'wf')
    const text = serializeWorkflow({ ...workflow, meta: { name: 'Impostor', extra: 'kept' } })
    expect(text).toContain('name: Real\n')
    expect(text).not.toContain('Impostor')
    expect(text).toContain('extra: kept\n')
  })

  it('emits no body for a workflow with no statements', () => {
    const { workflow } = parseWorkflow('---\nname: T\ntrigger: manual\n---\n', 'wf')
    expect(serializeWorkflow(workflow)).toBe(
      ['---', 'name: T', 'status: active', 'trigger: manual', '---', ''].join('\n')
    )
  })

  it('protects a frontmatter value that would be trimmed or unquoted on the way back', () => {
    // `name` and `description` are trimmed like every other display string in
    // the app; a meta value is verbatim, so padding there has to survive a save.
    const raw = [
      '---',
      'name: T',
      `description: "quoted"`,
      'trigger: manual',
      'padded: "  space  "',
      `weird: '"double"'`,
      '---'
    ].join('\n')
    const { workflow } = parseWorkflow(raw, 'wf')
    expect(workflow.description).toBe('quoted')
    expect(workflow.meta).toEqual({ padded: '  space  ', weird: '"double"' })
    const round = parseWorkflow(serializeWorkflow(workflow), 'wf').workflow
    expect(round.description).toBe('quoted')
    expect(round.meta).toEqual({ padded: '  space  ', weird: '"double"' })
  })
})

/* -------------------------------------------------------------------------- */

describe('round-trip', () => {
  const fixtures: Record<string, string> = {
    'worked example': WORKED,
    'no frontmatter': 'all | limit 3\n',
    'frontmatter only': '---\nname: T\ntrigger: on note-saved where tag = #book\n---\n',
    'meta passthrough': ['---', 'name: T', 'trigger: manual', 'author: someone', '---'].join('\n'),
    'quoted arguments': file('all | write-section "Reading Log.md" "Finished"'),
    'fan-out': file(
      'books = tag #book',
      'good = books | where rating >= 4 | sort finished desc',
      'good | render table title, rating | write-section "Log.md" "Finished"',
      'books | subtract good | add-tag #someday'
    ),
    'defaults and durations': file('all | since 7d | sort updated | render list | clipboard'),
    'unknown verb': file('all | frobnicate "a b" 3'),
    'awkward text': file('all | append "  leading and trailing  "', `all | rename "it's {{date}}"`),
    'every mutating sink': file(
      'current | set status done',
      'selection | move Archive | trash',
      'search project notes | notify "found some"'
    )
  }

  for (const [label, raw] of Object.entries(fixtures)) {
    it(`is a fixpoint: ${label}`, () => {
      const { text, again } = normalize(raw)
      expect(again).toBe(text)
    })
  }

  it('round-trips a canonical file exactly, line numbers included', () => {
    // Canonical shape: one blank line after the fence, so the body's line
    // numbers survive the save that produced it.
    const raw = [
      '---',
      'name: T',
      'status: active',
      'trigger: manual',
      '---',
      '',
      'books = tag #book',
      'books | add-tag #x',
      ''
    ].join('\n')
    const { workflow, diagnostics } = parseWorkflow(raw, 'wf')
    expect(diagnostics).toEqual([])
    const text = serializeWorkflow(workflow)
    expect(text).toBe(raw)
    expect(parseWorkflow(text, 'wf').workflow).toEqual(workflow)
  })

  it('is a fixpoint for every pairing of a deterministic corpus', () => {
    const triggers = [
      'manual',
      'on note-saved',
      'on note-saved where tag = #book',
      'schedule 0 9 * * 1',
      'nonsense'
    ]
    const fragments = [
      'books = tag #book',
      'good = books | where rating >= 4 | sort finished desc',
      'good | render table title, rating | write-section "Log.md" "Finished"',
      'all | since 7d | limit 10 | notify "done"',
      '# a comment',
      '',
      'oops =',
      'frobnicate 3 | limit 1',
      `all | append it's fine`,
      'all | append "a  b" | limit 1',
      'all | move "My Folder" | trash',
      '   indented = all | dedupe',
      'all | where title contains "two words"',
      'weird | | limit',
      '"unclosed | all',
      '|'
    ]

    for (const trigger of triggers) {
      for (const first of fragments) {
        for (const second of fragments) {
          const raw = ['---', 'name: T', `trigger: ${trigger}`, '---', first, second, ''].join('\n')
          const once = parseWorkflow(raw, 'wf').workflow
          const text = serializeWorkflow(once)
          const twice = parseWorkflow(text, 'wf').workflow
          expect(serializeWorkflow(twice), raw).toBe(text)
          expect(twice, raw).toEqual(parseWorkflow(serializeWorkflow(twice), 'wf').workflow)
        }
      }
    }
  })

  it('keeps comments and blank lines across a save, so line numbers are stable', () => {
    // A canvas save rewrites the whole file. Before trivia was preserved this
    // silently deleted every comment the user had written and shifted every
    // statement up, which is exactly the quiet loss that stops people trusting
    // the text file and the canvas to be the same artifact.
    const first = parseWorkflow(WORKED, 'reading-log').workflow
    const saved = serializeWorkflow(first)
    const second = parseWorkflow(saved, 'reading-log').workflow

    expect(saved).toContain('# comment lines start with hash at column 0')
    expect(first.statements.map((s) => s.line)).toEqual([3, 4, 5, 7, 8])
    expect(second.statements.map((s) => s.line)).toEqual([3, 4, 5, 7, 8])
    // A save normalizes alignment padding and nothing else, so the second parse
    // equals the first outright rather than only after ignoring position.
    expect(second).toEqual(first)
    expect(serializeWorkflow(second)).toBe(saved)
  })

  it('preserves an author blank line between statements but not the frontmatter separator', () => {
    // The blank line the serializer emits after the closing fence is its own
    // separator, so re-reading it must not add another one on every save. A
    // blank line the author put between two statements is theirs and stays.
    const raw = [
      '---',
      'name: T',
      'status: active',
      'trigger: manual',
      '---',
      '',
      'all',
      '',
      'all | limit 1',
      ''
    ].join('\n')
    const workflow = parseWorkflow(raw, 'wf').workflow
    expect(workflow.statements[0].leading).toBeUndefined()
    expect(workflow.statements[1].leading).toEqual([''])
    expect(serializeWorkflow(workflow)).toBe(raw)
  })

  it('keeps trailing comments after the last statement', () => {
    const raw = [
      '---',
      'name: T',
      'status: active',
      'trigger: manual',
      '---',
      '',
      'all',
      '# tail note',
      ''
    ].join('\n')
    const workflow = parseWorkflow(raw, 'wf').workflow
    expect(workflow.trailing).toEqual(['# tail note'])
    expect(serializeWorkflow(workflow)).toBe(raw)
  })
})

/* -------------------------------------------------------------------------- */

describe('parseWorkflow never throws', () => {
  const garbage = [
    '',
    '\n\n\n',
    '---',
    '---\n',
    '---\nname: T',
    '---\n---\n',
    '\x00� binary looking bytes',
    '|||',
    '= = =',
    'books =',
    '= tag #book',
    '"unclosed | all',
    'all | | | limit',
    '#',
    '# only a comment\n',
    'tag',
    'a'.repeat(5000)
  ]

  for (const raw of garbage) {
    it(`survives ${JSON.stringify(raw.slice(0, 24))}`, () => {
      const parsed = parseWorkflow(raw, 'wf')
      expect(parsed.workflow.id).toBe('wf')
      expect(Array.isArray(parsed.workflow.statements)).toBe(true)
      // And whatever came out can be written back and read again.
      expect(() => parseWorkflow(serializeWorkflow(parsed.workflow), 'wf')).not.toThrow()
    })
  }
})
