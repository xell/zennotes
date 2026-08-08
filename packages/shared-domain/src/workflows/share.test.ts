import { describe, expect, it } from 'vitest'
import {
  mutatingKinds,
  reviewWorkflowImport,
  summarizeWorkflowWrites,
  workflowExportFilename,
  workflowIsReadOnly
} from './share'
import { parseWorkflow } from './parse'
import { NODE_DEFS } from './nodes'
import type { Workflow } from './types'

// An imported workflow is untrusted input that will later be allowed to move,
// retag and overwrite notes. Every assertion below is about the promise the
// import dialog makes: nothing is written before it is shown, nothing arrives
// armed, and what it says the file does comes from the registry rather than
// from a list someone has to remember to update.

const parse = (raw: string, id = 'imported'): Workflow => parseWorkflow(raw, id).workflow

const READ_ONLY = `---
name: Just looking
description: Reads and nothing else
trigger: manual
---

books = tag #book
books | render list | clipboard
`

const WRITER = `---
name: Tidy the inbox
description: Files what has been sitting there
trigger: manual
---

old = folder inbox | since 30d
old | add-tag #someday
old | archive
`

describe('workflowExportFilename', () => {
  it('names the file after the workflow id, which is its identity', () => {
    expect(workflowExportFilename('reading-log')).toBe('reading-log.md')
  })

  it('does not double the extension when the id already carries one', () => {
    expect(workflowExportFilename('reading-log.md')).toBe('reading-log.md')
  })

  it('cannot produce a path, whatever the id says', () => {
    expect(workflowExportFilename('../../etc/passwd')).toBe('..-..-etc-passwd.md')
    expect(workflowExportFilename('')).toBe('workflow.md')
  })
})

describe('summarizeWorkflowWrites', () => {
  it('reports nothing for a workflow that only reads', () => {
    const workflow = parse(`---
name: Nothing doing
trigger: manual
---

books = tag #book
books | where rating >= 4
`)
    expect(summarizeWorkflowWrites(workflow)).toEqual([])
    expect(workflowIsReadOnly(workflow)).toBe(true)
  })

  it('names every write in file order, with the arguments the file wrote', () => {
    const workflow = parse(WRITER)
    expect(summarizeWorkflowWrites(workflow)).toEqual([
      { kind: 'add-tag', title: 'Add tag', detail: '#someday', irreversible: false, count: 1 },
      { kind: 'archive', title: 'Archive', detail: '', irreversible: false, count: 1 }
    ])
    expect(workflowIsReadOnly(workflow)).toBe(false)
  })

  it('groups identical writes and counts them', () => {
    const workflow = parse(`---
name: Twice
trigger: manual
---

a = tag #one
b = tag #two
a | add-tag #done
b | add-tag #done
b | add-tag #other
`)
    expect(summarizeWorkflowWrites(workflow)).toEqual([
      { kind: 'add-tag', title: 'Add tag', detail: '#done', irreversible: false, count: 2 },
      { kind: 'add-tag', title: 'Add tag', detail: '#other', irreversible: false, count: 1 }
    ])
  })

  it('quotes the paths and headings a sink writes to, as the file does', () => {
    const workflow = parse(`---
name: Report
trigger: manual
---

notes = all
notes | render table title | write-section "inbox/Reading Log.md" "Finished"
`)
    expect(summarizeWorkflowWrites(workflow)).toEqual([
      {
        kind: 'write-section',
        title: 'Replace section in note',
        detail: '"inbox/Reading Log.md" "Finished"',
        irreversible: false,
        count: 1
      }
    ])
  })

  it('marks the writes that cannot be undone', () => {
    const workflow = parse(READ_ONLY)
    // `clipboard` is a mutating sink even though it touches no note, which is
    // exactly why the summary is derived from the registry and not from a guess
    // about which steps look dangerous.
    expect(summarizeWorkflowWrites(workflow)).toEqual([
      { kind: 'clipboard', title: 'Copy to clipboard', detail: '', irreversible: true, count: 1 }
    ])
  })

  it('describes every mutating node the registry declares', () => {
    // The guard against a hand-maintained second list: adding a mutating node
    // has to make it into the review with no further edits anywhere.
    const described = new Set<string>()
    for (const def of NODE_DEFS) {
      if (!def.mutating) continue
      const workflow: Workflow = {
        id: 'x',
        name: 'x',
        description: '',
        trigger: { type: 'manual' },
        status: 'active',
        statements: [{ name: null, input: null, steps: [{ kind: def.kind, args: {}, line: 1 }], line: 1 }],
        meta: {}
      }
      const writes = summarizeWorkflowWrites(workflow)
      expect(writes).toHaveLength(1)
      expect(writes[0].kind).toBe(def.kind)
      expect(writes[0].title).toBe(def.title)
      described.add(def.kind)
    }
    expect([...described].sort()).toEqual([...mutatingKinds()].sort())
  })

  it('surfaces a step it does not recognize rather than calling it harmless', () => {
    const workflow = parse(`---
name: From the future
trigger: manual
---

notes = all
notes | teleport somewhere
`)
    const writes = summarizeWorkflowWrites(workflow)
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe('teleport')
    expect(workflowIsReadOnly(workflow)).toBe(false)
  })
})

describe('reviewWorkflowImport: refusing what cannot be read', () => {
  it('refuses a file that does not parse, with the diagnostics that explain it', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Broken
trigger: manual
---

notes = all
notes | teleport somewhere
`,
      id: 'broken'
    })
    expect(review.ok).toBe(false)
    expect(review.text).toBeNull()
    expect(review.errors).toBeGreaterThan(0)
    expect(review.diagnostics.some((d) => d.message.includes('teleport'))).toBe(true)
  })

  it('refuses a pipeline referring to a wire nobody defines', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Dangling
trigger: manual
---

missing | archive
`,
      id: 'dangling'
    })
    expect(review.ok).toBe(false)
    expect(review.text).toBeNull()
  })

  it('refuses text that is not a workflow at all', () => {
    const review = reviewWorkflowImport({ raw: 'just some notes I copied', id: 'junk' })
    expect(review.ok).toBe(false)
    expect(review.text).toBeNull()
    expect(review.errors).toBeGreaterThan(0)
  })

  it('allows warnings through, and says how many there are', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Sloppy
trigger: manual
---

spare = tag #book
kept  = tag #article
kept | add-tag #reading
`,
      id: 'sloppy'
    })
    // `spare` is never read and changes nothing: a warning, not a refusal.
    expect(review.errors).toBe(0)
    expect(review.warnings).toBeGreaterThan(0)
    expect(review.ok).toBe(true)
    expect(review.text).not.toBeNull()
  })
})

describe('reviewWorkflowImport: what it would do', () => {
  it('reports a read-only workflow as one, which is a smaller decision', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Just looking
trigger: manual
---

books = tag #book
books | where rating >= 4 | render list | write "inbox/Books.md"
`,
      id: 'looking'
    })
    expect(review.ok).toBe(true)
    expect(review.readOnly).toBe(false)
    expect(review.writes.map((w) => w.kind)).toEqual(['write'])
  })

  it('lists what a writing workflow would change before it is accepted', () => {
    const review = reviewWorkflowImport({ raw: WRITER, id: 'tidy' })
    expect(review.ok).toBe(true)
    expect(review.readOnly).toBe(false)
    expect(review.writes.map((w) => `${w.title} ${w.detail}`.trim())).toEqual([
      'Add tag #someday',
      'Archive'
    ])
  })

  it('carries the name and description the dialog introduces it with', () => {
    const review = reviewWorkflowImport({ raw: WRITER, id: 'tidy' })
    expect(review.name).toBe('Tidy the inbox')
    expect(review.description).toBe('Files what has been sitting there')
  })

  it('takes the name the caller resolved when a collision forced a suffix', () => {
    const review = reviewWorkflowImport({
      raw: WRITER,
      id: 'tidy-the-inbox-2',
      name: 'Tidy the inbox 2'
    })
    expect(review.name).toBe('Tidy the inbox 2')
    expect(review.text).toContain('name: Tidy the inbox 2')
    expect(review.workflow.id).toBe('tidy-the-inbox-2')
  })
})

describe('reviewWorkflowImport: it may never arrive armed', () => {
  it('changes a schedule trigger to manual and says that it did', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Nightly sweep
trigger: schedule 0 9 * * *
---

old = folder inbox | since 30d
old | archive
`,
      id: 'nightly'
    })
    expect(review.ok).toBe(true)
    expect(review.triggerChanged).toEqual({ declared: 'schedule 0 9 * * *' })
    expect(review.workflow.trigger).toEqual({ type: 'manual' })
    expect(review.text).toContain('trigger: manual')
    expect(review.text).not.toContain('schedule 0 9')
  })

  it('changes an event trigger to manual and says that it did', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: On save
trigger: on note-saved
---

here = current
here | add-tag #touched
`,
      id: 'on-save'
    })
    expect(review.triggerChanged).toEqual({ declared: 'on note-saved' })
    expect(review.workflow.trigger).toEqual({ type: 'manual' })
  })

  it('says nothing about the trigger when the file already asked for manual', () => {
    expect(reviewWorkflowImport({ raw: WRITER, id: 'tidy' }).triggerChanged).toBeNull()
  })
})

describe('reviewWorkflowImport: keybindings', () => {
  const WITH_KEY = `---
name: Reading log
trigger: manual
key: <leader>wr
---

books = tag #book
books | add-tag #read
`

  it('keeps a binding no other workflow uses', () => {
    const review = reviewWorkflowImport({ raw: WITH_KEY, id: 'reading-log' })
    expect(review.keyRemoved).toBeNull()
    expect(review.workflow.key).toBe('<leader>wr')
    expect(review.text).toContain('key: <leader>wr')
  })

  it('drops a binding another workflow already owns, and says so', () => {
    const review = reviewWorkflowImport({
      raw: WITH_KEY,
      id: 'reading-log',
      takenKeys: ['<leader>wa', '<leader>wr']
    })
    expect(review.keyRemoved).toBe('<leader>wr')
    expect(review.workflow.key).toBeUndefined()
    expect(review.text).not.toContain('key:')
  })
})

describe('reviewWorkflowImport: the bytes it would write', () => {
  it('writes a file that parses back to exactly the workflow that was reviewed', () => {
    const review = reviewWorkflowImport({
      raw: `---
name: Nightly sweep
trigger: schedule 0 9 * * *
key: <leader>wn
---

# Keep a comment, because the author wrote it.
old = folder inbox | since 30d
old | archive
`,
      id: 'nightly',
      takenKeys: ['<leader>wn']
    })
    expect(review.text).not.toBeNull()
    const round = parseWorkflow(review.text ?? '', 'nightly')
    expect(round.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(round.workflow).toEqual(review.workflow)
    // The author's own comment survives the trip, the same promise the canvas
    // makes when it saves over a file someone documented.
    expect(review.text).toContain('# Keep a comment, because the author wrote it.')
  })

  it('checks calls against the rest of the vault when it is given one', () => {
    const raw = `---
name: Chained
trigger: manual
---

notes = all
notes | call archive-done
`
    const alone = reviewWorkflowImport({ raw, id: 'chained' })
    expect(alone.ok).toBe(true)

    // Reported, but no longer fatal. A workflow the vault does not have yet is
    // the normal state of a community set, and the import lands as a draft that
    // cannot run, so this is a thing to fix rather than a reason to refuse.
    const others = new Map<string, Workflow>()
    const withVault = reviewWorkflowImport({ raw, id: 'chained', others })
    expect(withVault.ok).toBe(true)
    expect(withVault.errors).toBe(0)
    const call = withVault.diagnostics.find((d) => d.message.includes('archive-done'))
    expect(call?.severity).toBe('warning')
  })
})

describe('importing a workflow that calls another', () => {
  const chained = [
    '---',
    'name: Second half',
    'trigger: manual',
    '---',
    '',
    'notes = all',
    '',
    'notes | call first-half'
  ].join('\n')

  it('warns rather than blocks when the call names a workflow this vault does not have', () => {
    // Community workflows ship as sets, so the second half naming the first is
    // the normal case, not a broken file. It must still be importable.
    const review = reviewWorkflowImport({ raw: chained, id: 'second-half', others: new Map<string, Workflow>() })
    expect(review.ok).toBe(true)
    expect(review.text).not.toBeNull()
    expect(review.errors).toBe(0)
    expect(review.diagnostics.some((d) => d.severity === 'warning' && /first-half/.test(d.message))).toBe(true)
  })

  it('still lands as a draft, so the unresolved call cannot run', () => {
    const review = reviewWorkflowImport({ raw: chained, id: 'second-half', others: new Map<string, Workflow>() })
    expect(review.workflow.status).toBe('draft')
  })
})
