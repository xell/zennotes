import { describe, expect, it } from 'vitest'
import { parseWorkflow } from '@shared/workflows/parse'
import { validateWorkflow } from '@shared/workflows/validate'
import {
  STARTER_WORKFLOW_NAME,
  bodyLineOffset,
  isWorkflowDraftDirty,
  lineRange,
  newWorkflowDraft,
  slugifyWorkflowName,
  starterWorkflowText,
  uniqueWorkflowSlug,
  workflowFileText,
  workflowNameRange
} from './workflow-authoring'

describe('starterWorkflowText', () => {
  // The promise the starter makes is that a new workflow is runnable, not just
  // syntactically parseable. A template that reported errors on creation would
  // teach the format wrong.
  it('parses and validates with no diagnostics', () => {
    const { workflow, diagnostics } = parseWorkflow(starterWorkflowText(), 'new-workflow')
    expect(diagnostics).toEqual([])
    expect(validateWorkflow(workflow)).toEqual([])
  })

  it('describes a two-statement pipeline the canvas can draw', () => {
    const { workflow } = parseWorkflow(starterWorkflowText(), 'new-workflow')
    expect(workflow.name).toBe(STARTER_WORKFLOW_NAME)
    expect(workflow.trigger).toEqual({ type: 'manual' })
    expect(workflow.statements.map((s) => s.name)).toEqual(['notes', null])
    expect(workflow.statements[1].input).toBe('notes')
  })

  it('takes the name it is given', () => {
    const { workflow } = parseWorkflow(starterWorkflowText('Weekly review'), 'weekly-review')
    expect(workflow.name).toBe('Weekly review')
  })
})

describe('slugifyWorkflowName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyWorkflowName('Reading Log!')).toBe('reading-log')
  })

  it('trims leading and trailing separators', () => {
    expect(slugifyWorkflowName('  --Weekly review--  ')).toBe('weekly-review')
  })

  it('falls back to `workflow` when nothing survives', () => {
    expect(slugifyWorkflowName('   ')).toBe('workflow')
    expect(slugifyWorkflowName('!!!')).toBe('workflow')
  })
})

describe('uniqueWorkflowSlug', () => {
  it('keeps a free slug', () => {
    expect(uniqueWorkflowSlug('reading-log', ['weekly-review'])).toBe('reading-log')
  })

  it('takes the next free suffix', () => {
    expect(uniqueWorkflowSlug('new-workflow', ['new-workflow'])).toBe('new-workflow-2')
    expect(uniqueWorkflowSlug('new-workflow', ['new-workflow', 'new-workflow-2'])).toBe(
      'new-workflow-3'
    )
  })

  it('skips gaps rather than reusing a taken slug', () => {
    expect(uniqueWorkflowSlug('new-workflow', ['new-workflow', 'new-workflow-3'])).toBe(
      'new-workflow-2'
    )
  })
})

describe('newWorkflowDraft', () => {
  it('names the first one plainly', () => {
    const draft = newWorkflowDraft([])
    expect(draft).toMatchObject({ name: 'New workflow', slug: 'new-workflow' })
    expect(draft.text).toContain('name: New workflow\n')
  })

  it('keeps the name and the slug saying the same thing', () => {
    const draft = newWorkflowDraft(['new-workflow'])
    expect(draft.slug).toBe('new-workflow-2')
    expect(draft.name).toBe('New workflow 2')
    // The slug is re-derived from the name on save; these must round-trip or
    // the file would be renamed the first time it is written.
    expect(slugifyWorkflowName(draft.name)).toBe(draft.slug)
  })

  it('still produces a valid workflow when it has been renumbered', () => {
    const draft = newWorkflowDraft(['new-workflow', 'new-workflow-2'])
    const { workflow, diagnostics } = parseWorkflow(draft.text, draft.slug)
    expect(diagnostics).toEqual([])
    expect(workflow.name).toBe('New workflow 3')
  })
})

describe('workflowNameRange', () => {
  it('covers the name value only', () => {
    const raw = starterWorkflowText()
    const range = workflowNameRange(raw)
    expect(range).not.toBeNull()
    expect(raw.slice(range!.start, range!.end)).toBe('New workflow')
  })

  it('ignores a name line below the closing fence', () => {
    expect(workflowNameRange('---\ntrigger: manual\n---\n\nname: not frontmatter\n')).toBeNull()
  })

  it('returns null without frontmatter', () => {
    expect(workflowNameRange('notes = tag #inbox\n')).toBeNull()
  })

  it('leaves a CRLF terminator out of the selection', () => {
    const raw = '---\r\nname: Reading log\r\ntrigger: manual\r\n---\r\n'
    const range = workflowNameRange(raw)
    expect(raw.slice(range!.start, range!.end)).toBe('Reading log')
  })

  it('collapses to a caret when the name is empty', () => {
    const range = workflowNameRange('---\nname: \ntrigger: manual\n---\n')
    expect(range).toEqual({ start: 10, end: 10 })
  })
})

describe('isWorkflowDraftDirty', () => {
  it('sees a real edit', () => {
    expect(isWorkflowDraftDirty('notes = tag #inbox\n', 'notes = tag #book\n')).toBe(true)
  })

  it('ignores the line endings a textarea normalizes away', () => {
    expect(isWorkflowDraftDirty('a\r\nb\r\n', 'a\nb\n')).toBe(false)
  })

  it('ignores the final newline a save adds', () => {
    expect(isWorkflowDraftDirty('a\nb\n', 'a\nb')).toBe(false)
  })
})

describe('workflowFileText', () => {
  it('adds the missing final newline', () => {
    expect(workflowFileText('notes = tag #inbox')).toBe('notes = tag #inbox\n')
  })

  it('leaves an existing one alone', () => {
    expect(workflowFileText('notes = tag #inbox\n')).toBe('notes = tag #inbox\n')
  })
})

describe('bodyLineOffset', () => {
  it('counts the frontmatter block', () => {
    // `---`, `name:`, `---` = 3 lines, so body line 1 is file line 4.
    expect(bodyLineOffset('---\nname: X\n---\nnotes = tag #inbox\n')).toBe(3)
  })

  it('agrees with where the parser puts a statement', () => {
    const raw = starterWorkflowText()
    const { workflow } = parseWorkflow(raw, 'new-workflow')
    const fileLine = workflow.statements[0].line + bodyLineOffset(raw)
    // Derived from the template rather than pinned to its text, so changing the
    // starter is not a test edit. What is being asserted is the OFFSET maths,
    // not which pipeline the blank workflow happens to ship with.
    const firstStatement = raw.split('\n').find((line) => line.includes('='))
    expect(raw.split('\n')[fileLine - 1]).toBe(firstStatement)
  })

  it('is zero without frontmatter', () => {
    expect(bodyLineOffset('notes = tag #inbox\n')).toBe(0)
  })
})

describe('lineRange', () => {
  const text = 'one\ntwo\nthree'

  it('covers a whole line', () => {
    expect(lineRange(text, 2)).toEqual({ start: 4, end: 7 })
  })

  it('covers the first and last lines', () => {
    expect(lineRange(text, 1)).toEqual({ start: 0, end: 3 })
    expect(lineRange(text, 3)).toEqual({ start: 8, end: 13 })
  })

  it('clamps past the end', () => {
    expect(lineRange(text, 99)).toEqual({ start: 13, end: 13 })
  })
})
