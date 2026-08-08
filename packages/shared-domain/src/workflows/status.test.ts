// Draft vs active: the state that decides whether a workflow may ACT.
//
// The feature exists to separate two questions that used to be one. "Is this
// written to disk" was tied to "may this run", so editing had to stage into a
// buffer that an explicit Save promoted, because a half-edited workflow must
// never fire over someone's vault. Split apart, a draft can be autosaved as
// often as we like precisely because a draft cannot do anything.
//
// Three promises are worth more than the feature itself, and this file is here
// to hold them:
//
//   1. Nobody gets deactivated. Every workflow in every vault predates the
//      field, so a file with no `status:` line reads as ACTIVE and keeps
//      working exactly as it does today. An unrecognized value takes the same
//      road, so a `status` a future version writes cannot disarm a workflow
//      when an older build opens the file.
//   2. The state is in the file. Frontmatter rather than a sidecar, so it syncs
//      with the vault, survives an export, and is visible when you read the
//      thing. Which means it has to survive a save, and has to settle: a file
//      that gains its `status:` line on the first save must be byte-identical
//      on every save after that.
//   3. One place decides. Every caller asks `isRunnable`, so the trigger paths
//      that do not exist yet cannot forget the rule.

import { describe, expect, it } from 'vitest'
import { CONSUMED_KEYS, WORKFLOW_STATUSES, isWorkflowStatus, parseWorkflow } from './parse'
import { serializeWorkflow } from './serialize'
import { isRunnable } from './types'
import type { Workflow, WorkflowStatus } from './types'

/** A complete workflow file whose frontmatter is exactly the given lines. */
function file(...frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', '', 'books = tag #book', 'books | add-tag #x', ''].join('\n')
}

const workflowOf = (raw: string): Workflow => parseWorkflow(raw, 'wf').workflow

/** The frontmatter block of a serialized workflow, fence lines included. */
function frontmatterLines(text: string): string[] {
  const lines = text.split('\n')
  const closing = lines.indexOf('---', 1)
  return lines.slice(0, closing + 1)
}

/* -------------------------------------------------------------------------- */
/*  Reading the file                                                          */
/* -------------------------------------------------------------------------- */

describe('parseWorkflow: status', () => {
  it('reads a workflow with no status line as active', () => {
    // The compatibility promise, stated as a test: this is every workflow that
    // exists today, and none of them may stop running because a field was added.
    const { workflow, diagnostics } = parseWorkflow(file('name: T', 'trigger: manual'), 'wf')
    expect(workflow.status).toBe('active')
    expect(diagnostics).toEqual([])
  })

  it('reads a file with no frontmatter at all as active', () => {
    expect(workflowOf('all | limit 3\n').status).toBe('active')
  })

  it('reads `status: draft`', () => {
    expect(workflowOf(file('name: T', 'status: draft', 'trigger: manual')).status).toBe('draft')
  })

  it('reads `status: active`', () => {
    expect(workflowOf(file('name: T', 'status: active', 'trigger: manual')).status).toBe('active')
  })

  it('reads a status written in any position in the frontmatter', () => {
    // Order is the serializer's business; the parser is fed a map.
    const raw = file('status: draft', 'name: T', 'key: <leader>wr', 'trigger: manual')
    expect(workflowOf(raw).status).toBe('draft')
  })

  it('falls back to active for a value it does not recognize', () => {
    // `paused` is the shape of the real risk: a state a later version adds. An
    // older build must not read it as "off" and quietly disarm the workflow.
    expect(workflowOf(file('name: T', 'status: paused', 'trigger: manual')).status).toBe('active')
  })

  it('warns about a value it does not recognize rather than ignoring it', () => {
    const { diagnostics } = parseWorkflow(file('name: T', 'status: paused', 'trigger: manual'), 'wf')
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'unknown status `paused`, treating the workflow as active',
        line: 0
      }
    ])
  })

  it('falls back to active for an empty value, with nothing to report', () => {
    // An empty `status:` says no more than a missing one, so it gets the same
    // answer and no diagnostic.
    const { workflow, diagnostics } = parseWorkflow(file('name: T', 'status:', 'trigger: manual'), 'wf')
    expect(workflow.status).toBe('active')
    expect(diagnostics).toEqual([])
  })

  it('ignores whitespace around the value', () => {
    expect(workflowOf(file('name: T', 'status:    draft   ', 'trigger: manual')).status).toBe('draft')
  })

  it('reads a quoted value, because frontmatter strips one layer of quotes', () => {
    expect(workflowOf(file('name: T', 'status: "draft"', 'trigger: manual')).status).toBe('draft')
  })

  it('matches case-insensitively, because people hand-edit this file', () => {
    // Putting the state in frontmatter is an invitation to edit it by hand, and
    // `status: Draft` means draft to everyone who types it.
    expect(workflowOf(file('name: T', 'status: Draft', 'trigger: manual')).status).toBe('draft')
    expect(workflowOf(file('name: T', 'status: ACTIVE', 'trigger: manual')).status).toBe('active')
  })

  it('keeps a draft trigger exactly as written', () => {
    // Draft does not rewrite the workflow, it gates it. The trigger stays on the
    // file so activating restores what the author asked for, and `isRunnable` is
    // what stops it firing meanwhile.
    const workflow = workflowOf(file('name: T', 'status: draft', 'trigger: on note-saved'))
    expect(workflow.status).toBe('draft')
    expect(workflow.trigger).toEqual({ type: 'event', event: 'note-saved' })
  })

  it('changes nothing else about the parse', () => {
    const active = workflowOf(file('name: T', 'trigger: manual', 'key: <leader>wr'))
    const draft = workflowOf(file('name: T', 'status: draft', 'trigger: manual', 'key: <leader>wr'))
    expect(draft).toEqual({ ...active, status: 'draft' })
  })
})

/* -------------------------------------------------------------------------- */
/*  Status is consumed, so it can never be written twice                      */
/* -------------------------------------------------------------------------- */

describe('status is a key the format owns', () => {
  it('is listed in CONSUMED_KEYS', () => {
    // The list is what keeps a key out of `meta`. A consumed key that is not on
    // it would be written from its field AND from the passthrough, and the
    // second copy would win on the next read.
    expect(CONSUMED_KEYS.has('status')).toBe(true)
  })

  it('does not fall through into meta', () => {
    expect(workflowOf(file('name: T', 'status: draft', 'trigger: manual')).meta).toEqual({})
  })

  it('does not fall through into meta even when the value was unrecognized', () => {
    // The value was rejected, but the KEY is still ours: parking it in `meta`
    // would write `status: paused` back beside the `status: active` the field
    // produces, and the file would then read as whatever came second.
    expect(workflowOf(file('name: T', 'status: paused', 'trigger: manual')).meta).toEqual({})
  })

  it('coexists with unknown frontmatter keys, which stay in meta', () => {
    const raw = file('name: T', 'status: draft', 'trigger: manual', 'author: someone', 'zeta: 1')
    const workflow = workflowOf(raw)
    expect(workflow.status).toBe('draft')
    expect(workflow.meta).toEqual({ author: 'someone', zeta: '1' })
  })

  it('never writes the line twice, even if meta carries a stale one', () => {
    const workflow = workflowOf(file('name: T', 'status: draft', 'trigger: manual'))
    const text = serializeWorkflow({ ...workflow, meta: { status: 'active', extra: 'kept' } })
    expect(text.match(/^status:/gm)).toHaveLength(1)
    expect(workflowOf(text).status).toBe('draft')
    expect(text).toContain('extra: kept\n')
  })
})

/* -------------------------------------------------------------------------- */
/*  Writing the file                                                          */
/* -------------------------------------------------------------------------- */

describe('serializeWorkflow: status', () => {
  const full = (status: WorkflowStatus): Workflow => ({
    ...workflowOf(file('name: T', 'description: D', 'trigger: manual', 'key: <leader>wr')),
    status
  })

  it('writes draft', () => {
    expect(serializeWorkflow(full('draft'))).toContain('status: draft\n')
  })

  it('writes active rather than leaving the default implied', () => {
    // An absent line would put the state back into the absence of something,
    // which is the invisibility that choosing frontmatter was meant to avoid.
    expect(serializeWorkflow(full('active'))).toContain('status: active\n')
  })

  it('writes it in a stable position, between the description and the trigger', () => {
    // Before the trigger on purpose: the line saying whether the file may act
    // should be read before the line saying when it would, so nobody reads
    // `trigger: on note-saved` and believes it is live.
    expect(frontmatterLines(serializeWorkflow(full('draft')))).toEqual([
      '---',
      'name: T',
      'description: D',
      'status: draft',
      'trigger: manual',
      'key: <leader>wr',
      '---'
    ])
  })

  it('keeps that position for a workflow with no description and no key', () => {
    const workflow = { ...workflowOf(file('name: T', 'trigger: manual')), status: 'draft' as const }
    expect(frontmatterLines(serializeWorkflow(workflow))).toEqual([
      '---',
      'name: T',
      'status: draft',
      'trigger: manual',
      '---'
    ])
  })

  it('writes anything that is not draft as active', () => {
    // Defensive, and deliberately mirrors the parser: a workflow assembled in
    // memory (or handed over a bridge) must not be able to emit a value that
    // reads back as something other than what it was.
    const workflow = { ...full('active'), status: 'paused' as unknown as WorkflowStatus }
    expect(serializeWorkflow(workflow)).toContain('status: active\n')
  })
})

/* -------------------------------------------------------------------------- */
/*  Round-trip                                                                */
/* -------------------------------------------------------------------------- */

describe('round-trip', () => {
  /** Save, read, save: the meaning must be identical and the bytes must settle. */
  const roundTrip = (raw: string): { text: string; again: string } => {
    const first = workflowOf(raw)
    const text = serializeWorkflow(first)
    const second = workflowOf(text)
    expect(second, `serialized as: ${JSON.stringify(text)}`).toEqual(first)
    return { text, again: serializeWorkflow(second) }
  }

  for (const status of WORKFLOW_STATUSES) {
    it(`keeps its meaning through a save: ${status}`, () => {
      const { text } = roundTrip(file('name: T', `status: ${status}`, 'trigger: manual'))
      expect(text).toContain(`status: ${status}\n`)
    })

    it(`is a textual fixpoint: ${status}`, () => {
      const { text, again } = roundTrip(file('name: T', `status: ${status}`, 'trigger: manual'))
      expect(again).toBe(text)
    })
  }

  it('gains the line on the first save of a file that never had one', () => {
    const raw = file('name: T', 'trigger: manual')
    expect(raw).not.toContain('status:')
    const { text } = roundTrip(raw)
    expect(text).toContain('status: active\n')
  })

  it('is a fixpoint from the second save onwards for a file that never had one', () => {
    // Gaining a line once is fine. Gaining one per save would churn the file on
    // every autosave, which is the behaviour autosave cannot afford.
    const { text, again } = roundTrip(file('name: T', 'trigger: manual'))
    expect(again).toBe(text)
  })

  it('does not change what a legacy file means by adding the line', () => {
    const before = workflowOf(file('name: T', 'trigger: manual'))
    const after = workflowOf(serializeWorkflow(before))
    expect(after).toEqual(before)
  })

  it('settles an unrecognized value onto active, warning only once', () => {
    const raw = file('name: T', 'status: paused', 'trigger: manual')
    const saved = serializeWorkflow(workflowOf(raw))
    const reread = parseWorkflow(saved, 'wf')
    expect(reread.workflow.status).toBe('active')
    // The value it complained about is gone from the file, so the complaint is
    // gone too: the warning is about this text, not a permanent property.
    expect(reread.diagnostics).toEqual([])
    expect(serializeWorkflow(reread.workflow)).toBe(saved)
  })

  it('carries a draft through a save with its meta, key and trivia intact', () => {
    const raw = [
      '---',
      'name: T',
      'description: D',
      'status: draft',
      'trigger: on note-saved where rating > 4',
      'key: <leader>wr',
      'author: someone',
      '---',
      '',
      '# why this exists',
      'books = tag #book',
      'books | add-tag #x',
      '# tail note',
      ''
    ].join('\n')
    const { text, again } = roundTrip(raw)
    expect(text).toBe(raw)
    expect(again).toBe(raw)
  })

  it('is a fixpoint for every pairing of status and trigger', () => {
    const triggers = ['manual', 'on note-saved', 'schedule 0 9 * * 1', 'nonsense']
    for (const status of ['draft', 'active', 'paused', '']) {
      for (const trigger of triggers) {
        const raw = file('name: T', `status: ${status}`, `trigger: ${trigger}`)
        const once = serializeWorkflow(workflowOf(raw))
        expect(serializeWorkflow(workflowOf(once)), raw).toBe(once)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  The rule itself                                                           */
/* -------------------------------------------------------------------------- */

describe('isRunnable', () => {
  it('lets an active workflow run', () => {
    expect(isRunnable({ status: 'active' })).toBe(true)
  })

  it('refuses a draft', () => {
    expect(isRunnable({ status: 'draft' })).toBe(false)
  })

  it('lets a workflow with no status line in its file run', () => {
    // The compatibility promise as the engine sees it, not merely as the parser
    // reports it.
    expect(isRunnable(workflowOf(file('name: T', 'trigger: manual')))).toBe(true)
  })

  it('lets a workflow whose file carried an unrecognized status run', () => {
    expect(isRunnable(workflowOf(file('name: T', 'status: paused', 'trigger: manual')))).toBe(true)
  })

  it('refuses a draft whatever its trigger says', () => {
    // The whole point: the trigger is still on the file, and this is what will
    // stop it firing when event and schedule triggers land.
    const workflow = workflowOf(file('name: T', 'status: draft', 'trigger: on note-saved'))
    expect(isRunnable(workflow)).toBe(false)
  })

  it('says exactly one of the known statuses may act', () => {
    // A tripwire for a third state. Adding one without deciding what it means
    // here would otherwise inherit "not active, so not runnable" or, worse,
    // slip through some other comparison that forgot to ask.
    expect(WORKFLOW_STATUSES.filter((status) => isRunnable({ status }))).toEqual(['active'])
  })
})

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

describe('WORKFLOW_STATUSES', () => {
  it('lists both states, drafts first', () => {
    expect([...WORKFLOW_STATUSES]).toEqual(['draft', 'active'])
  })

  it('recognizes exactly those two', () => {
    for (const status of WORKFLOW_STATUSES) expect(isWorkflowStatus(status)).toBe(true)
    expect(isWorkflowStatus('paused')).toBe(false)
    expect(isWorkflowStatus('')).toBe(false)
    expect(isWorkflowStatus('Draft')).toBe(false)
  })

  it('round-trips every state through the file form', () => {
    // The runtime list and the file format have to agree, or a state would be
    // reachable in memory and unwritable on disk.
    for (const status of WORKFLOW_STATUSES) {
      const workflow = { ...workflowOf(file('name: T', 'trigger: manual')), status }
      expect(workflowOf(serializeWorkflow(workflow)).status).toBe(status)
    }
  })
})
