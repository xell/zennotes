import { describe, expect, it } from 'vitest'
import { parseWorkflow } from '@shared/workflows/parse'
import { summarizeWorkflowWrites } from '@shared/workflows/share'
import {
  WORKFLOW_STATUS_KEY,
  activateConfirmDescription,
  activateConfirmTitle,
  withWorkflowStatusText
} from './workflow-status'

const FILE = `---
name: Reading log
description: Files what I finished
trigger: manual
---

# Everything I tagged as a book.
books   = tag #book
books   | add-tag #logged
`

/** The status a file parses as, which is the only thing the flip has to change. */
const statusOf = (raw: string): string => parseWorkflow(raw, 'wf').workflow.status

describe('withWorkflowStatusText', () => {
  it('adds the key to a file that never had one, and parses back as written', () => {
    const next = withWorkflowStatusText(FILE, 'draft')
    expect(statusOf(next)).toBe('draft')
    expect(next).toContain(`${WORKFLOW_STATUS_KEY}: draft`)
  })

  it('leaves the body and the other keys byte for byte alone', () => {
    const next = withWorkflowStatusText(FILE, 'draft')
    // The aligned `=` signs are the test: a serializer round-trip would have
    // collapsed them, and flipping a switch may not reformat someone's file.
    expect(next).toContain('books   = tag #book')
    expect(next).toContain('name: Reading log')
    expect(next).toContain('# Everything I tagged as a book.')
  })

  it('rewrites an existing key in place rather than adding a second one', () => {
    const drafted = withWorkflowStatusText(FILE, 'draft')
    const activated = withWorkflowStatusText(drafted, 'active')
    expect(statusOf(activated)).toBe('active')
    expect(activated.split('\n').filter((line) => line.startsWith('status:'))).toHaveLength(1)
  })

  it('settles: writing the same status twice changes nothing', () => {
    const once = withWorkflowStatusText(FILE, 'draft')
    expect(withWorkflowStatusText(once, 'draft')).toBe(once)
  })

  it('collapses a duplicated key onto the one that was in effect', () => {
    const raw = ['---', 'name: x', 'status: active', 'status: draft', '---', '', 'a = all', ''].join(
      '\n'
    )
    const next = withWorkflowStatusText(raw, 'active')
    expect(next.split('\n').filter((line) => line.startsWith('status:'))).toEqual([
      'status: active'
    ])
    expect(statusOf(next)).toBe('active')
  })

  it('grows a frontmatter block for a file that has none', () => {
    const raw = 'notes = all\n'
    const next = withWorkflowStatusText(raw, 'draft')
    // A missing `status:` reads as active, so a draft with nowhere to record
    // itself would come back runnable on the next load.
    expect(statusOf(next)).toBe('draft')
    expect(next).toContain('notes = all')
  })

  it('keeps CRLF line endings', () => {
    const raw = FILE.replace(/\n/g, '\r\n')
    const next = withWorkflowStatusText(raw, 'draft')
    expect(next).toContain('status: draft\r\n')
    expect(statusOf(next)).toBe('draft')
  })
})

describe('activateConfirmDescription', () => {
  it('names what the workflow writes, in the registry’s own words', () => {
    const { workflow } = parseWorkflow(FILE, 'wf')
    const text = activateConfirmDescription(summarizeWorkflowWrites(workflow))
    expect(text).toContain('Add tag')
    expect(text).toContain('#logged')
    // One step reads as one step: "1 step that change your notes" is the kind
    // of sentence that makes a safety dialog look automated.
    expect(text).toContain('has a step that changes your notes')
    // Permission, not a run: someone who reads this as "it is about to do that"
    // cancels a workflow they wanted.
    expect(text).toContain('Activating does not run it')
  })

  it('titles the question with the workflow name', () => {
    expect(activateConfirmTitle('Reading log')).toBe('Activate "Reading log"?')
  })
})
