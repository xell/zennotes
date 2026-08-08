import { describe, it, expect } from 'vitest'
import { parseWorkflow } from './parse'
import { serializeWorkflow, serializeTrigger } from './serialize'
import type { Workflow } from './types'

/**
 * The contract this file exists to defend, stated at the top of `./serialize`:
 *
 *   parseWorkflow(serializeWorkflow(w)).workflow  deep-equals  w
 *   serializeWorkflow(parseWorkflow(serializeWorkflow(w)).workflow) === serializeWorkflow(w)
 *
 * Saving a workflow must not change what it means, so most of these are
 * round-trips rather than assertions about exact output text.
 */

function wf(partial: Partial<Workflow>): Workflow {
  return {
    id: 'wf',
    name: 'W',
    description: '',
    trigger: { type: 'manual' },
    status: 'active',
    statements: [],
    meta: {},
    ...partial
  }
}

/** Parse, save, parse again: the workflow must be identical and still clean. */
function roundTrip(raw: string): void {
  const first = parseWorkflow(raw, 'wf')
  const once = serializeWorkflow(first.workflow)
  const second = parseWorkflow(once, 'wf')
  expect(second.workflow, `serialized as: ${JSON.stringify(once)}`).toEqual(first.workflow)
  expect(second.diagnostics).toEqual(first.diagnostics)
  expect(serializeWorkflow(second.workflow)).toBe(once)
}

const FILES: Array<[string, string]> = [
  ['a full pipeline', `---
name: Reading Log
description: collects the good ones
trigger: manual
---

books = tag #book
good = books | where rating >= 4
good | render table title, rating | write "Reading Log.md"
`],
  ['an event trigger with a where clause', `---
name: Star
trigger: on note-saved where rating > 4
key: <leader>wr
---

current | add-tag #starred
`],
  ['a schedule trigger', `---
name: Nightly
trigger: schedule 0 9 * * *
---

all | since 7d | render count | notify "{{count}} notes"
`],
  ['union and subtract', `---
name: Combine
trigger: manual
---

a = tag #x
b = tag #y
c = a | union b | subtract a
c | archive
`],
  ['a pass-through rename', `---
name: Rename
trigger: manual
---

old = tag #a
archived = old
archived | trash
`],
  ['a terminal statement with no name', `---
name: Term
trigger: manual
---

tag #a | write-section "N.md" "Section Head"
`],
  ['quoted arguments containing spaces', `---
name: Quoted
trigger: manual
---

all | append "hello there world" | write "A B.md"
`],
  ['a step this version does not understand', `---
name: Future
trigger: manual
---

all | frobnicate alpha beta | write "O.md"
`],
  ['unknown frontmatter keys', `---
name: Meta
trigger: manual
zzz: later
aaa: early
---

all | clipboard
`]
]

describe('serializeWorkflow: files round-trip', () => {
  for (const [label, raw] of FILES) {
    it(`preserves ${label}`, () => {
      roundTrip(raw)
    })
  }
})

describe('serializeWorkflow: unbindable arguments survive the save', () => {
  /**
   * A token that fails coercion is parked under RAW_ARG and written back
   * verbatim. Before that, the failed slot was dropped and every later value
   * slid one position left, so `where rating == 4` degraded to `where rating 4`
   * and then to `where rating` across two saves, destroying the author's text
   * while they were looking elsewhere in the file.
   */
  const PARKED: Array<[string, string]> = [
    ['a mistyped comparison', 'x = all | where rating == 4'],
    ['a bad duration', 'x = all | since 7x'],
    ['a digit-leading tag', 'x = tag #2024'],
    ['a bad sort direction with the field bound', 'x = all | sort title sideways'],
    ['a quoted token that failed to bind', 'x = all | since "7 x"']
  ]

  for (const [label, line] of PARKED) {
    it(`keeps ${label} verbatim`, () => {
      const raw = `---\nname: W\nstatus: active\ntrigger: manual\n---\n\n${line}\n`
      const parsed = parseWorkflow(raw, 'wf')
      expect(parsed.diagnostics.some((d) => d.severity === 'error')).toBe(true)
      expect(serializeWorkflow(parsed.workflow)).toBe(raw)
      roundTrip(raw)
    })
  }

  it('binds a unicode tag instead of parking it', () => {
    const raw = `---\nname: W\nstatus: active\ntrigger: manual\n---\n\nx = tag #café\n`
    const parsed = parseWorkflow(raw, 'wf')
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.workflow.statements[0]?.steps[0]?.args.tag).toBe('café')
    expect(serializeWorkflow(parsed.workflow)).toBe(raw)
    roundTrip(raw)
  })
})

describe('serializeWorkflow: quoting', () => {
  /**
   * A pipe inside an argument is the dangerous case: written bare it does not
   * just split the value in two, it splits the STEP, so `append | a | b |`
   * reads back as `append` followed by unknown steps `a` and `b`. `parse`
   * already tokenizes quote-aware for exactly this reason (a markdown table
   * row is a normal thing to append), so the serializer has to quote it.
   */
  it('quotes a markdown table row so it survives a save', () => {
    roundTrip(`---
name: Table
trigger: manual
---

all | append "| a | b |" | write "O.md"
`)
  })

  const VALUES: Array<[string, string]> = [
    ['plain text', 'hello'],
    ['spaces', 'hello there'],
    ['a pipe', 'a | b'],
    ['a pipe with no spaces', 'a|b'],
    ['a double quote', 'say "hi"'],
    ['a single quote', "it's fine"],
    ['both quote characters', `mix "a" and 'b'`],
    ['a leading space', ' lead'],
    ['a trailing space', 'trail '],
    ['a double space', 'a  b'],
    ['a tab', 'a\tb'],
    ['an empty string', ''],
    ['a hash', '#tagish'],
    ['an equals sign', 'a = b']
  ]

  for (const [label, value] of VALUES) {
    it(`round-trips a rest argument containing ${label}`, () => {
      const source = wf({
        statements: [
          {
            name: null,
            input: null,
            line: 1,
            steps: [
              { kind: 'all', args: {}, line: 1 },
              { kind: 'append', args: { text: value }, line: 1 }
            ]
          }
        ]
      })
      const text = serializeWorkflow(source)
      const steps = parseWorkflow(text, 'wf').workflow.statements[0]?.steps
      const note = `serialized as: ${JSON.stringify(text)}`
      // The value must not leak out and become extra steps.
      expect(steps?.map((s) => s.kind), note).toEqual(['all', 'append'])
      expect(steps?.[1].args.text, note).toBe(value)
    })

    it(`round-trips a path argument containing ${label}`, () => {
      const source = wf({
        statements: [
          {
            name: null,
            input: null,
            line: 1,
            steps: [
              { kind: 'all', args: {}, line: 1 },
              { kind: 'write', args: { path: value }, line: 1 }
            ]
          }
        ]
      })
      const text = serializeWorkflow(source)
      const steps = parseWorkflow(text, 'wf').workflow.statements[0]?.steps
      const note = `serialized as: ${JSON.stringify(text)}`
      expect(steps?.map((s) => s.kind), note).toEqual(['all', 'write'])
      expect(steps?.[1].args.path, note).toBe(value)
    })
  }
})

describe('serializeWorkflow: frontmatter', () => {
  const NAMES = [
    'Plain',
    'With: colon',
    'With "quotes"',
    "With 'single'",
    '  padded  ',
    'multi\nline',
    '"fully quoted"',
    '#hash'
  ]

  for (const name of NAMES) {
    it(`round-trips the name ${JSON.stringify(name)}`, () => {
      const text = serializeWorkflow(wf({ name }))
      // A newline cannot live in a flat scalar, so it collapses to a space.
      const expected = name.replace(/[\r\n]+/g, ' ').trim()
      expect(parseWorkflow(text, 'wf').workflow.name, `serialized as: ${JSON.stringify(text)}`).toBe(
        expected
      )
    })
  }

  it('falls back to the id when the name is empty', () => {
    expect(parseWorkflow(serializeWorkflow(wf({ name: '' })), 'wf').workflow.name).toBe('wf')
  })

  it('keeps unknown keys and writes them in a stable order', () => {
    const text = serializeWorkflow(wf({ meta: { zzz: 'later', aaa: 'early' } }))
    expect(parseWorkflow(text, 'wf').workflow.meta).toEqual({ zzz: 'later', aaa: 'early' })
    expect(text.indexOf('aaa:')).toBeLessThan(text.indexOf('zzz:'))
  })

  it('never writes a key the format owns twice', () => {
    const text = serializeWorkflow(wf({ name: 'Real', meta: { name: 'Impostor' } }))
    expect(text.match(/^name:/gm)).toHaveLength(1)
    expect(parseWorkflow(text, 'wf').workflow.name).toBe('Real')
  })

  it('omits an absent key rather than writing an empty one', () => {
    expect(serializeWorkflow(wf({}))).not.toContain('key:')
  })
})

describe('serializeTrigger', () => {
  it('writes manual', () => {
    expect(serializeTrigger({ type: 'manual' })).toBe('manual')
  })

  it('writes a bare event', () => {
    expect(serializeTrigger({ type: 'event', event: 'note-created' })).toBe('on note-created')
  })

  it('writes an event with a where clause', () => {
    expect(serializeTrigger({ type: 'event', event: 'note-saved', where: 'rating > 4' })).toBe(
      'on note-saved where rating > 4'
    )
  })

  it('writes a schedule', () => {
    expect(serializeTrigger({ type: 'schedule', cron: '0 9 * * *' })).toBe('schedule 0 9 * * *')
  })
})

describe('serializeWorkflow: shape', () => {
  it('writes a body-less workflow as frontmatter alone', () => {
    expect(serializeWorkflow(wf({ name: 'Empty' }))).toBe(
      '---\nname: Empty\nstatus: active\ntrigger: manual\n---\n'
    )
  })

  it('keeps body line numbers stable across a save', () => {
    const raw = `---
name: Lines
trigger: manual
---

a = tag #x
a | archive
`
    const first = parseWorkflow(raw, 'wf').workflow
    const second = parseWorkflow(serializeWorkflow(first), 'wf').workflow
    expect(second.statements.map((s) => s.line)).toEqual(first.statements.map((s) => s.line))
  })

  it('drops a trailing argument that equals its default', () => {
    const text = serializeWorkflow(
      wf({
        statements: [
          {
            name: null,
            input: null,
            line: 1,
            steps: [
              { kind: 'all', args: {}, line: 1 },
              { kind: 'sort', args: { field: 'title', direction: 'asc' }, line: 1 }
            ]
          }
        ]
      })
    )
    expect(text).toContain('sort title\n')
    // Dropping it must not change meaning: the default comes back on read.
    const back = parseWorkflow(text, 'wf').workflow.statements[0].steps[1]
    expect(back.args.direction).toBe('asc')
  })

  it('keeps a non-default trailing argument', () => {
    const text = serializeWorkflow(
      wf({
        statements: [
          {
            name: null,
            input: null,
            line: 1,
            steps: [
              { kind: 'all', args: {}, line: 1 },
              { kind: 'sort', args: { field: 'title', direction: 'desc' }, line: 1 }
            ]
          }
        ]
      })
    )
    expect(text).toContain('sort title desc')
  })

  it('preserves the arguments of a step it does not understand', () => {
    const text = serializeWorkflow(
      wf({
        statements: [
          {
            name: null,
            input: null,
            line: 1,
            steps: [{ kind: 'frobnicate', args: { $raw: 'alpha beta' }, line: 1 }]
          }
        ]
      })
    )
    expect(text).toContain('frobnicate alpha beta')
  })
})
